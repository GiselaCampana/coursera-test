import { Decimal, parseArNumber, parseRate } from '@/lib/money';
import { parseArDate, toISODate } from '@/lib/datetime';
import type { OcrHeader, OcrItem, OcrSummary, OcrTaxLine } from '@/lib/ocr/types';
import { CLASE_DIGITOS_OCR } from '@/lib/ocr/parsers/tipos';

/**
 * Lector de respaldo sobre texto plano.
 *
 * Sirve para dos cosas: interpretar la salida de un OCR clásico (Tesseract o un
 * proveedor documental) que devuelve texto conservando la disposición, y hacer
 * que las pruebas ejerciten todo el circuito sin depender de un servicio
 * externo.
 *
 * Trabaja por columnas, no por expresiones regulares sobre la línea entera: en
 * un comprobante las columnas se separan con varios espacios, mientras que un
 * solo espacio puede estar agrupando miles ("2 196 120,52"). Confundir las dos
 * cosas hace que dos importes contiguos se lean como uno solo.
 *
 * Es deliberadamente conservador: una línea que no se entiende no genera un
 * renglón. Lo que no se puede leer queda en null y lo levanta el validador.
 */

/** Un número completo: miles con punto o espacio y, si hay decimales, una sola coma al final. */
const NUMERO_COMPLETO = new RegExp(
  `^[$]?\\s*-?[${CLASE_DIGITOS_OCR}]{1,3}(?:[.\\s][${CLASE_DIGITOS_OCR}]{3})*(?:,[${CLASE_DIGITOS_OCR}]+)?\\s*%?$`,
);
/** Una tanda que sólo tiene dígitos, separadores y espacios: candidata a ser varios importes. */
const SOLO_NUMEROS = new RegExp(`^[$%\\s.,-]*[${CLASE_DIGITOS_OCR}][${CLASE_DIGITOS_OCR}$%\\s.,-]*$`);
/**
 * Pieza que continúa el número anterior: un grupo de miles de tres dígitos,
 * con o sin la parte decimal que cierra el número ("196", "120,52").
 */
const GRUPO_DE_MILES = new RegExp(`^[${CLASE_DIGITOS_OCR}]{3}(?:,[${CLASE_DIGITOS_OCR}]+)?$`);

/**
 * Separa importes que quedaron pegados por un solo espacio.
 *
 * Cuando la foto sale apretada, Tesseract devuelve "16,10 16.037,00 14,00" con
 * un espacio simple entre columnas, igual que separa los miles en
 * "2 196 120,52". La diferencia está en la forma: un grupo de miles son
 * exactamente tres dígitos y viene antes de la coma decimal; todo lo demás
 * empieza un número nuevo.
 */
function separarImportesPegados(texto: string): string[] {
  const piezas = texto.trim().split(/\s+/).filter((p) => p !== '');
  const salida: string[] = [];
  let actual = '';

  for (const pieza of piezas) {
    if (actual === '') {
      actual = pieza;
      continue;
    }
    // La pieza sigue al número anterior sólo si es un grupo de miles y el
    // número que viene arrastrando todavía no llegó a los decimales.
    const continuaMiles = GRUPO_DE_MILES.test(pieza) && !actual.includes(',') && NUMERO_COMPLETO.test(actual);
    if (continuaMiles) {
      actual = `${actual} ${pieza}`;
    } else {
      salida.push(actual);
      actual = pieza;
    }
  }
  if (actual !== '') salida.push(actual);
  return salida;
}

/**
 * Parte una línea en columnas. El separador natural es una tanda de dos o más
 * espacios; si así no aparecen columnas suficientes, se cae a un solo espacio.
 *
 * Después, cada columna que quedó siendo sólo números pero no *un* número se
 * vuelve a partir: son importes contiguos que la foto dejó pegados.
 */
export function splitColumns(line: string): string[] {
  const wide = line.trim().split(/\s{2,}/).filter((c) => c !== '');
  if (wide.length >= 3) {
    return wide.flatMap((columna) => {
      if (!columna.includes(' ')) return [columna];
      if (!SOLO_NUMEROS.test(columna) || NUMERO_COMPLETO.test(columna)) return [columna];
      return separarImportesPegados(columna);
    });
  }
  // Sin columnas anchas se cae al espacio simple, pero volviendo a unir los
  // grupos de miles: "2 196 120,52" es un solo importe, no tres.
  return separarImportesPegados(line);
}

/** Columnas que se interpretan como número, con su posición. */
function numericColumns(columns: string[]): { index: number; value: Decimal; text: string }[] {
  const out: { index: number; value: Decimal; text: string }[] = [];
  columns.forEach((text, index) => {
    // Una columna es numérica sólo si es *toda* número: "14,00" sí,
    // "Bonif 14,00" no.
    if (!/^[$\s]*-?[\d.,\s]+%?$/.test(text)) return;
    const value = parseArNumber(text);
    if (value !== null) out.push({ index, value, text });
  });
  return out;
}

/** Último número de una línea, ignorando la etiqueta que lo precede. */
function lastNumberOf(line: string): Decimal | null {
  const numbers = numericColumns(splitColumns(line));
  if (numbers.length > 0) return numbers[numbers.length - 1].value;
  // Etiqueta y número pegados en una sola columna ("TOTAL: 2.196.120,52").
  const tail = line.match(/([\d][\d.,\s]*\d|\d)\s*$/);
  return tail ? parseArNumber(tail[1]) : null;
}

const SUMMARY_PATTERNS: { key: 'grossSubtotal' | 'discountTotal' | 'netTotal' | 'total'; match: RegExp }[] = [
  { key: 'grossSubtotal', match: /^(sub\s?-?\s?total|importe bruto)\b/i },
  { key: 'discountTotal', match: /^(descuentos?|bonificaci[oó]n(?:es)?|dto\.?)\b/i },
  { key: 'netTotal', match: /^(neto\s+gravado|importe\s+neto|base\s+imponible|neto|gravado)\b/i },
  { key: 'total', match: /^total\b|^importe\s+total\b/i },
];

export function parseHeaderFromText(text: string): OcrHeader {
  const header: OcrHeader = {
    docType: null,
    letter: null,
    pointOfSale: null,
    number: null,
    fullNumber: null,
    issueDate: null,
    supplierName: null,
    legalName: null,
    cuit: null,
    currency: 'ARS',
  };

  if (/\bremito\b/i.test(text)) header.docType = 'REMITO';
  if (/\bfactura\b/i.test(text)) header.docType = 'FACTURA';

  const letter = text.match(/\bfactura\s+([ABCEM])\b/i);
  if (letter) header.letter = letter[1].toUpperCase();

  const pos = text.match(/punto\s+de\s+venta\s*[:.]?\s*(\d{1,5})/i);
  if (pos) header.pointOfSale = pos[1].padStart(4, '0');

  const nro = text.match(
    /(?:comp\.?\s*(?:nro|n[°º]|numero|número)|nro|n[°º])\s*[:.]?\s*(\d{4,12})/i,
  );
  if (nro) header.number = nro[1].padStart(8, '0');

  // "0010-00212356" escrito de una sola vez.
  const full = text.match(/\b(\d{4,5})\s*-\s*(\d{7,9})\b/);
  if (full) {
    header.pointOfSale ??= full[1].padStart(4, '0');
    header.number ??= full[2].padStart(8, '0');
  }
  if (header.pointOfSale && header.number) {
    header.fullNumber = `${header.pointOfSale}-${header.number}`;
  }

  const date = text.match(
    /fecha\s*(?:de\s*)?(?:emisi[oó]n)?\s*[:.]?\s*(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}|\d{4}-\d{2}-\d{2})/i,
  );
  const parsedDate = date ? parseArDate(date[1]) : null;
  if (parsedDate) header.issueDate = toISODate(parsedDate);

  const cuit = text.match(/cuit\s*[:.]?\s*(\d{2}-?\d{8}-?\d)/i);
  if (cuit) header.cuit = cuit[1];

  // La razón social suele ser la primera línea con contenido del comprobante.
  const firstLine = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 2 && !/^(factura|remito)\b/i.test(l));
  if (firstLine) {
    header.legalName = firstLine;
    header.supplierName = firstLine
      .replace(/\s+(s\.?a\.?|s\.?r\.?l\.?|s\.?a\.?s\.?)\.?$/i, '')
      .trim();
  }

  return header;
}

export function parseSummaryFromText(text: string): OcrSummary {
  const summary: OcrSummary = {
    grossSubtotal: null,
    discountTotal: null,
    netTotal: null,
    ivaLines: [],
    perceptionLines: [],
    ivaTotal: null,
    perceptionsTotal: null,
    total: null,
    lineCount: null,
    netWeightKg: null,
    totalUnits: null,
    packageCount: null,
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;

    const lineCount = line.match(/cantidad\s+de\s+rengl[oó]n(?:es)?\s*[:.]?\s*(\d+)/i);
    if (lineCount) summary.lineCount = Number(lineCount[1]);

    const weight = line.match(/peso\s+neto\s*[:.]?\s*([\d.,\s]+?)\s*(?:kg|kilos?)?(?:\s{2,}|$)/i);
    if (weight) {
      const value = parseArNumber(weight[1]);
      if (value) summary.netWeightKg = value.toString();
    }

    const packages = line.match(/(?:cantidad\s+de\s+)?bultos\s*[:.]?\s*(\d+)/i);
    if (packages) summary.packageCount = Number(packages[1]);

    // IVA discriminado por tasa: "IVA 21%: 376.477,81".
    const iva = line.match(/^i\.?\s?v\.?\s?a\.?\s*(?:inscripto)?\s*([\d.,]+)?\s*%?\s*[:.]?\s*(.*)$/i);
    if (iva) {
      const amount = lastNumberOf(line);
      if (amount) {
        summary.ivaLines!.push(buildTaxLine('IVA', iva[1] ?? null, amount.toString()));
        continue;
      }
    }

    // Percepciones: "Percepción IIBB 1,5%: 26.891,27".
    if (/^(percepci[oó]n|i\.?i\.?b\.?b\.?|ret(?:enci[oó]n)?)\b/i.test(line)) {
      const amount = lastNumberOf(line);
      const rateMatch = line.match(/([\d.,]+)\s*%/);
      if (amount) {
        const label = line.split(/[:0-9]/)[0].trim() || 'Percepción';
        summary.perceptionLines!.push(
          buildTaxLine(label, rateMatch ? rateMatch[1] : null, amount.toString()),
        );
        continue;
      }
    }

    for (const { key, match } of SUMMARY_PATTERNS) {
      if (summary[key] != null) continue;
      if (!match.test(line)) continue;
      const value = lastNumberOf(line);
      if (value) summary[key] = value.toString();
      break;
    }
  }

  summary.ivaTotal = sumTaxLines(summary.ivaLines);
  summary.perceptionsTotal = sumTaxLines(summary.perceptionLines);
  return summary;
}

function buildTaxLine(label: string, rate: string | null, amount: string): OcrTaxLine {
  const parsedRate = rate ? parseRate(rate) : null;
  return { label, rate: parsedRate ? parsedRate.toString() : null, amount };
}

function sumTaxLines(lines: OcrTaxLine[] | undefined): string | null {
  if (!lines || lines.length === 0) return null;
  let total = new Decimal(0);
  for (const line of lines) {
    const value = parseArNumber(line.amount);
    if (value) total = total.plus(value);
  }
  return total.toString();
}

/** Líneas que nunca son un artículo: encabezados de columna y renglones del pie. */
const NOT_AN_ITEM =
  /^(cod|c[oó]d|c[oó]digo|art|descripci[oó]n|detalle|cantidad|precio|importe|sub\s?-?\s?total|total|i\.?\s?v\.?\s?a|percepci|neto|gravado|descuento|bonific|peso|bultos|cantidad\s+de\s+rengl)/i;

/**
 * Reconstruye los renglones de la tabla.
 *
 * Un renglón es una línea con al menos tres columnas numéricas al final y texto
 * antes. Se apoya en el orden de columnas de los comprobantes argentinos de
 * mercadería: [código] descripción, cantidad, precio unitario, [bonif %],
 * importe. Una línea que no encaja se descarta: un renglón mal armado ensucia
 * el historial de precios y es más difícil de detectar que uno que falta.
 */
export function parseItemsFromText(text: string): OcrItem[] {
  const items: OcrItem[] = [];
  let lineNumber = 0;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || NOT_AN_ITEM.test(line)) continue;

    const columns = splitColumns(line);
    if (columns.length < 4) continue;

    const numbers = numericColumns(columns);
    if (numbers.length < 3) continue;

    // Los importes van al final: se toman las columnas numéricas finales que
    // sean contiguas.
    const trailing: typeof numbers = [];
    for (let i = numbers.length - 1; i >= 0; i--) {
      const expectedIndex = columns.length - 1 - (numbers.length - 1 - i);
      if (numbers[i].index !== expectedIndex) break;
      trailing.unshift(numbers[i]);
    }
    if (trailing.length < 3) continue;

    const firstNumericIndex = trailing[0].index;
    const headColumns = columns.slice(0, firstNumericIndex);
    if (headColumns.length === 0) continue;

    let supplierCode: string | null = null;
    let descriptionParts = headColumns;
    if (/^(\d{2,8}|[A-Z]{1,4}\d{2,8})$/.test(headColumns[0]) && headColumns.length > 1) {
      supplierCode = headColumns[0];
      descriptionParts = headColumns.slice(1);
    }
    const description = descriptionParts.join(' ').replace(/\s{2,}/g, ' ').trim();
    if (description.length < 3) continue;

    // Se usan las últimas cuatro columnas numéricas como máximo: cantidad,
    // precio, bonificación y importe.
    const tail = trailing.slice(-4);
    let quantity: string | null = null;
    let unitNetPrice: string | null = null;
    let discountPct: string | null = null;
    let grossSubtotal: string | null = null;

    if (tail.length >= 4) {
      quantity = tail[0].value.toString();
      unitNetPrice = tail[1].value.toString();
      const rate = parseRate(tail[2].text);
      discountPct = rate ? rate.toString() : null;
      grossSubtotal = tail[3].value.toString();
    } else {
      quantity = tail[0].value.toString();
      unitNetPrice = tail[1].value.toString();
      grossSubtotal = tail[2].value.toString();
    }

    lineNumber += 1;
    items.push({
      lineNumber,
      supplierCode,
      description,
      quantity,
      unit: /\b(un|uni|unid|unidades|bandejas?|latas?|cajas?)\b/i.test(description)
        ? 'UNIT'
        : 'KG',
      pieceCount: null,
      totalWeightKg: null,
      unitNetPrice,
      grossSubtotal,
      discountPct,
      discountAmount: null,
      netAmount: null,
      ivaRate: null,
    });
  }

  return items;
}

export function parseDocumentFromText(text: string) {
  return {
    header: parseHeaderFromText(text),
    items: parseItemsFromText(text),
    summary: parseSummaryFromText(text),
  };
}
