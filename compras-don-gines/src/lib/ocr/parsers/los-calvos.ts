import { Decimal, parseArNumber, parseRate } from '@/lib/money';
import { parseArDate, toISODate } from '@/lib/datetime';
import { esNotaDeCredito, splitColumns } from '@/lib/ocr/text-parser';
import type { OcrHeader, OcrItem, OcrSummary, OcrTaxLine } from '@/lib/ocr/types';
import {
  CLASE_DIGITOS_OCR,
  repararDigitos,
  type AnalisisComprobante,
  type AnalizadorComprobante,
  type TextosComprobante,
} from '@/lib/ocr/parsers/tipos';

/**
 * Analizador de las facturas de Los Calvos.
 *
 * Formato:
 *
 *   Cod   Descripción              Kg      Precio    Bonif %     Importe
 *   1001  LONGANIZA CORTA       16,10   16.037,00      14,00  258.195,70
 *
 * y un pie con Subtotal, Descuento, Neto Gravado, IVA 21 %, Percepción IIBB
 * 1,5 % y TOTAL.
 *
 * Lo que aporta sobre el analizador genérico:
 *
 *  - sabe que la columna "Importe" es el bruto del renglón (cantidad × precio)
 *    y que la bonificación se descuenta después, no renglón por renglón;
 *  - sabe que las cuatro columnas de la derecha son numéricas, así que puede
 *    corregir en ellas las confusiones de forma del OCR (O por 0, l por 1) sin
 *    tocar las descripciones;
 *  - sabe que la unidad es kilos y que el IVA es del 21 %;
 *  - controla renglón por renglón que cantidad × precio dé el importe impreso y
 *    avisa cuál no cierra, en vez de dejar que la diferencia aparezca recién en
 *    el total.
 *
 * Lo que no hace: corregir un importe para que la cuenta cierre. Si un renglón
 * no cierra, lo dice y deja que el control lo bloquee.
 */

/** Columnas numéricas de la tabla, de izquierda a derecha. */
const COLUMNAS = ['kg', 'precio', 'bonificacion', 'importe'] as const;

const ETIQUETAS_PIE: { campo: keyof OcrSummary; patron: RegExp }[] = [
  { campo: 'grossSubtotal', patron: /^sub\s?-?\s?total\b/i },
  { campo: 'discountTotal', patron: /^(descuento|bonificaci[oó]n)\b/i },
  { campo: 'netTotal', patron: /^neto\s+gravado\b|^neto\b|^gravado\b/i },
  { campo: 'total', patron: /^total\b/i },
];

export const analizadorLosCalvos: AnalizadorComprobante = {
  codigo: 'los-calvos',
  nombre: 'Los Calvos',

  reconoce(textos: TextosComprobante): number {
    const texto = `${textos.encabezado ?? ''}\n${textos.completo}`;
    const normalizado = texto
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase();

    /*
     * Primero el proveedor, y sin él no hay analizador.
     *
     * "Bonif" e "Importe" son cabeceras de columna que imprime cualquier
     * sistema de facturación, y sólo con ellas este analizador se quedaba con
     * comprobantes de proveedores que no son Los Calvos. Como después escribe
     * el nombre a mano en el encabezado —lo sabe, porque es su formato— la
     * factura terminaba atribuida al proveedor equivocado: con el plazo de pago
     * de Los Calvos, con sus tasas, y sin que la pantalla llegara nunca a decir
     * que el proveedor era nuevo.
     *
     * Un formato ajeno interpretado con las reglas de otro proveedor es peor
     * que uno interpretado con reglas generales.
     */
    const porNombre = /L[O0]S\s+C[A4]LV[O0]S/.test(normalizado);
    const porCuit = /30-?61234567-?9/.test(normalizado.replace(/\s/g, ''));
    if (!porNombre && !porCuit) return 0;

    let puntaje = 0;
    // El nombre, tolerando que el OCR se coma o cambie alguna letra.
    if (porNombre) puntaje += 0.6;
    if (porCuit) puntaje += 0.3;
    // Y después la cabecera de columnas de este formato, que confirma.
    if (/BONIF/.test(normalizado) && /IMPORTE/.test(normalizado)) puntaje += 0.2;
    if (/PESO\s+NETO/.test(normalizado) && /RENGL/.test(normalizado)) puntaje += 0.1;

    return Math.min(1, puntaje);
  },

  analizar(textos: TextosComprobante): AnalisisComprobante {
    const observaciones: string[] = [];
    const header = analizarEncabezado(textos.encabezado || textos.completo);
    const { items, avisos } = analizarArticulos(textos.articulos || textos.completo);
    observaciones.push(...avisos);

    const summary = analizarPie(textos.resumen || textos.completo);

    if (items.length === 0) {
      observaciones.push('No se reconoció ningún renglón en la tabla de artículos.');
    }
    if (summary.lineCount !== null && items.length !== summary.lineCount) {
      observaciones.push(
        `El comprobante declara ${summary.lineCount} renglones y se reconocieron ${items.length}.`,
      );
    }

    return { header, items, summary, observaciones };
  },
};

function analizarEncabezado(texto: string): OcrHeader {
  const header: OcrHeader = {
    docType: esNotaDeCredito(texto)
      ? 'NOTA_CREDITO'
      : /\bremito\b/i.test(texto) && !/\bfactura\b/i.test(texto)
        ? 'REMITO'
        : 'FACTURA',
    letter: null,
    pointOfSale: null,
    number: null,
    fullNumber: null,
    issueDate: null,
    supplierName: 'Los Calvos',
    legalName: 'Los Calvos S.A.',
    cuit: null,
    currency: 'ARS',
  };

  const letra = texto.match(/\bfactura\s+([ABCEM])\b/i);
  header.letter = letra ? letra[1].toUpperCase() : 'A';

  // "Punto de Venta: 0010   Comp. Nro: 00212356"
  const pv = texto.match(/punto\s+de\s+venta\s*[:.]?\s*([\dOoQlI|]{1,5})/i);
  if (pv) header.pointOfSale = repararDigitos(pv[1]).padStart(4, '0');

  const nro = texto.match(
    /(?:comp\.?\s*(?:nro|n[°º]|numero|número)|nro|n[°º])\s*[:.]?\s*([\dOoQlI|]{4,12})/i,
  );
  if (nro) header.number = repararDigitos(nro[1]).padStart(8, '0');

  const completo = texto.match(/\b([\dOoQlI|]{4,5})\s*-\s*([\dOoQlI|]{7,9})\b/);
  if (completo) {
    header.pointOfSale ??= repararDigitos(completo[1]).padStart(4, '0');
    header.number ??= repararDigitos(completo[2]).padStart(8, '0');
  }
  if (header.pointOfSale && header.number) {
    header.fullNumber = `${header.pointOfSale}-${header.number}`;
  }

  const fecha = texto.match(
    /fecha\s*(?:de\s*)?(?:emisi[oó]n)?\s*[:.]?\s*([\dOoQlI|]{1,2}[/\-.][\dOoQlI|]{1,2}[/\-.][\dOoQlI|]{2,4})/i,
  );
  const analizada = fecha ? parseArDate(repararDigitos(fecha[1])) : null;
  if (analizada) header.issueDate = toISODate(analizada);

  const cuit = texto.match(/cuit\s*[:.]?\s*([\dOoQlI|]{2}-?[\dOoQlI|]{8}-?[\dOoQlI|])/i);
  if (cuit) header.cuit = repararDigitos(cuit[1]);

  return header;
}

/** Líneas que nunca son un renglón de artículo en este formato. */
const NO_ES_ARTICULO =
  /^(cod|c[oó]d|descripci|detalle|cantidad|precio|importe|bonif|sub\s?-?\s?total|total|i\.?\s?v\.?\s?a|percepci|iibb|neto|gravado|descuento|peso|bultos|cuit|fecha|punto|comp)/i;

function analizarArticulos(texto: string): { items: OcrItem[]; avisos: string[] } {
  const items: OcrItem[] = [];
  const avisos: string[] = [];
  let numero = 0;

  for (const cruda of texto.split('\n')) {
    const linea = cruda.trim();
    if (linea === '' || NO_ES_ARTICULO.test(linea)) continue;

    const columnas = splitColumns(linea);
    if (columnas.length < 4) continue;

    // Las últimas cuatro columnas son las numéricas de este formato.
    const cola = columnas.slice(-4);
    const valores = cola.map((c) => parseArNumber(repararDigitos(c)));
    if (valores.some((v) => v === null)) continue;

    const cabeza = columnas.slice(0, columnas.length - 4);
    if (cabeza.length === 0) continue;

    // El código del proveedor es la primera columna, de 3 a 8 dígitos.
    let codigo: string | null = null;
    let partesDescripcion = cabeza;
    if (/^[\dOoQlI|]{3,8}$/.test(cabeza[0]) && cabeza.length > 1) {
      codigo = repararDigitos(cabeza[0]);
      partesDescripcion = cabeza.slice(1);
    }

    const descripcion = partesDescripcion.join(' ').replace(/\s{2,}/g, ' ').trim();
    if (descripcion.length < 3 || !/[A-Za-zÁÉÍÓÚÑáéíóúñ]{3}/.test(descripcion)) continue;

    const [kg, precio, bonificacion, importe] = valores as [Decimal, Decimal, Decimal, Decimal];
    const tasa = parseRate(repararDigitos(cola[COLUMNAS.indexOf('bonificacion')]));

    numero += 1;

    // Control del renglón: la columna Importe de Los Calvos es el bruto, o sea
    // cantidad × precio, antes de la bonificación.
    const esperado = kg.times(precio);
    const diferencia = esperado.minus(importe).abs();
    const tolerancia = esperado.abs().times(0.005).plus(1);
    if (diferencia.gt(tolerancia)) {
      avisos.push(
        `Renglón ${numero} (${descripcion}): ${kg.toFixed(2)} × ${precio.toFixed(2)} da ` +
          `${esperado.toFixed(2)} y el importe leído es ${importe.toFixed(2)}. Hay que releerlo.`,
      );
    }

    items.push({
      lineNumber: numero,
      supplierCode: codigo,
      description: descripcion,
      quantity: kg.toString(),
      // En Los Calvos toda la mercadería va por kilo.
      unit: 'KG',
      pieceCount: null,
      totalWeightKg: kg.toString(),
      unitNetPrice: precio.toString(),
      grossSubtotal: importe.toString(),
      discountPct: tasa ? tasa.toString() : null,
      discountAmount: null,
      netAmount: null,
      // El IVA de este proveedor es del 21 %.
      ivaRate: '0.21',
    });
  }

  return { items, avisos };
}

function analizarPie(texto: string): OcrSummary {
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

  for (const cruda of texto.split('\n')) {
    const linea = cruda.trim();
    if (linea === '') continue;

    const renglones = linea.match(
      new RegExp(`cantidad\\s+de\\s+rengl[oó]n(?:es)?\\s*[:.]?\\s*([${CLASE_DIGITOS_OCR}]+)`, 'i'),
    );
    if (renglones) {
      const valor = parseArNumber(repararDigitos(renglones[1]));
      if (valor) summary.lineCount = valor.toNumber();
    }

    const peso = linea.match(
      new RegExp(
        `peso\\s+neto\\s*[:.]?\\s*([${CLASE_DIGITOS_OCR}.,]+)\\s*(?:kg|kilos?)?`,
        'i',
      ),
    );
    if (peso) {
      const valor = parseArNumber(repararDigitos(peso[1]));
      if (valor) summary.netWeightKg = valor.toString();
    }

    // "IVA 21%: 376.477,81"
    if (/^i\.?\s?v\.?\s?a\b/i.test(linea)) {
      const importe = ultimoNumero(linea);
      const tasa = linea.match(/([\d.,]+)\s*%/);
      if (importe) {
        summary.ivaLines!.push(lineaImpuesto('IVA', tasa ? tasa[1] : '21', importe.toString()));
        continue;
      }
    }

    // "Percepción IIBB 1,5%: 26.891,27"
    if (/^(percepci[oó]n|i\.?i\.?b\.?b\.?|ret(?:enci[oó]n)?)\b/i.test(linea)) {
      const importe = ultimoNumero(linea);
      const tasa = linea.match(/([\d.,]+)\s*%/);
      if (importe) {
        const etiqueta = linea.split(/[:0-9]/)[0].trim() || 'Percepción IIBB';
        summary.perceptionLines!.push(
          lineaImpuesto(etiqueta, tasa ? tasa[1] : '1,5', importe.toString()),
        );
        continue;
      }
    }

    for (const { campo, patron } of ETIQUETAS_PIE) {
      if (summary[campo] != null) continue;
      if (!patron.test(linea)) continue;
      const importe = ultimoNumero(linea);
      if (importe) (summary[campo] as string | null) = importe.toString();
      break;
    }
  }

  summary.ivaTotal = sumar(summary.ivaLines);
  summary.perceptionsTotal = sumar(summary.perceptionLines);
  return summary;
}

/** Último valor numérico de la línea, ignorando la etiqueta y el porcentaje. */
function ultimoNumero(linea: string): Decimal | null {
  // Se descarta la parte del porcentaje: en "IVA 21%: 376.477,81" el importe es
  // el segundo número, no el primero.
  const sinPorcentaje = linea.replace(/[\d.,]+\s*%/g, ' ');
  const columnas = splitColumns(sinPorcentaje);
  for (let i = columnas.length - 1; i >= 0; i--) {
    const valor = parseArNumber(repararDigitos(columnas[i]));
    if (valor !== null && /\d/.test(columnas[i])) return valor;
  }
  const cola = sinPorcentaje.match(/([\d.,][\d.,\s]*\d|\d)\s*$/);
  return cola ? parseArNumber(repararDigitos(cola[1])) : null;
}

function lineaImpuesto(etiqueta: string, tasa: string | null, importe: string): OcrTaxLine {
  const analizada = tasa ? parseRate(tasa) : null;
  return { label: etiqueta, rate: analizada ? analizada.toString() : null, amount: importe };
}

function sumar(lineas: OcrTaxLine[] | undefined): string | null {
  if (!lineas || lineas.length === 0) return null;
  let total = new Decimal(0);
  for (const linea of lineas) {
    const valor = parseArNumber(linea.amount);
    if (valor) total = total.plus(valor);
  }
  return total.toString();
}
