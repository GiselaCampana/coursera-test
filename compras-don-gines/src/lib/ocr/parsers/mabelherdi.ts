import { Decimal, parseArNumber, parseRate } from '@/lib/money';
import { parseArDate, toISODate } from '@/lib/datetime';
import type { OcrHeader, OcrItem, OcrSummary, OcrTaxLine } from '@/lib/ocr/types';
import {
  CLASE_DIGITOS_OCR,
  repararDigitos,
  type AnalisisComprobante,
  type AnalizadorComprobante,
  type TextosComprobante,
} from '@/lib/ocr/parsers/tipos';

/**
 * Analizador de las facturas de MABELHERDI S.A.
 *
 * Formato:
 *
 *   Codigo Art.  Descripcion            Desc    Cantidad      Sugerido  Pr Unit  Importe
 *   300052821    PEP COMUN 120GRX21    0.00%  1.00 Unidad      $ 3500  $2066.12  $2066.12
 *
 * y un pie de una sola línea con Neto 21%, IVA 21%, Percepción IIBB y Total.
 *
 * Tres cosas lo separan de los otros formatos:
 *
 *  - **«Sugerido» no es el costo.** Es el precio de venta que el proveedor
 *    sugiere al comercio, y está impreso entre la cantidad y el precio real.
 *    No entra en ningún cálculo: si se lo confundiera con el unitario, esta
 *    factura de $40.506 pasaría a costar $101.000. Se lee para poder saltearlo
 *    y nada más.
 *  - **El decimal va con punto**, a la inglesa: `$ 32998.85`, no `$ 32.998,85`.
 *  - **Todo va por unidad.** Este proveedor vende paquetes cerrados; no hay
 *    kilos en ninguna columna.
 *
 * El precio unitario se calcula como importe ÷ cantidad en vez de leerse. No es
 * un atajo: sobre la foto real, la columna «Pr Unit» pierde el punto decimal en
 * cuatro de los nueve renglones y el signo pesos se le lee como un cinco en dos
 * más, mientras que la columna Importe sale entera en los nueve. Dividir dos
 * números bien leídos es más fiable que leer un tercero que se rompe la mitad
 * de las veces, y además queda contrastado: la suma de los importes tiene que
 * dar el neto impreso, y ese control sí cierra o no cierra.
 */

/** El CUIT del proveedor, que es la identificación que no admite parecidos. */
const CUIT = '30678043067';

/**
 * Todas las columnas numéricas de este formato traen dos decimales.
 *
 * Cantidad se imprime «1.00», el precio «2066.12» y el importe «4132.24». Sobre
 * la foto real el OCR pierde ese punto en varias celdas —«200» por 2,00 y
 * «206812» por 2.066,12— y sin reponerlo la cantidad sale cien veces más
 * grande y el costo del renglón, cien veces más chico.
 *
 * Reponerlo es transcripción, no invención: no se elige un valor para que una
 * cuenta cierre, se restituye un separador que el formato siempre imprime. Y
 * queda contrastado igual, porque la suma de los importes tiene que dar el neto
 * del pie.
 *
 * Sólo se aplica a un número sin separador y de al menos tres dígitos: «3» es
 * tres, no tres centésimos.
 */
function conDosDecimales(bruto: string): Decimal | null {
  const limpio = repararDigitos(bruto.replace(/^\$\s*/, '').trim());
  if (limpio === '') return null;
  if (!/[.,]/.test(limpio) && /^\d{3,}$/.test(limpio)) {
    return parseArNumber(`${limpio.slice(0, -2)}.${limpio.slice(-2)}`);
  }
  return parseArNumber(limpio);
}

export const analizadorMabelherdi: AnalizadorComprobante = {
  codigo: 'mabelherdi',
  nombre: 'Mabelherdi',

  reconoce(textos: TextosComprobante): number {
    const texto = `${textos.encabezado ?? ''}\n${textos.completo}\n${textos.articulos ?? ''}`;
    const normalizado = texto
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase();

    /*
     * Primero el proveedor, y con el CUIT por delante.
     *
     * El nombre puede salir mordido —«MABELHERDI» tiene tres letras que el OCR
     * confunde— pero el CUIT es once dígitos y o está o no está. Sin nombre ni
     * CUIT esto no es una factura de Mabelherdi y la toma el analizador
     * general: un formato ajeno interpretado con las reglas de otro proveedor
     * es peor que uno interpretado con reglas generales.
     */
    const porCuit = new RegExp(CUIT).test(normalizado.replace(/[\s-]/g, ''));
    const porNombre = /M[A4]BELHERD[I1]|M[A4]BELHERO[I1]/.test(normalizado);
    if (!porCuit && !porNombre) return 0;

    let puntaje = 0;
    if (porCuit) puntaje += 0.6;
    if (porNombre) puntaje += 0.3;
    // Y las señales del formato, que confirman.
    if (/SUGERIDO/.test(normalizado)) puntaje += 0.2;
    if (/C[O0]DIG[O0]\s*ART/.test(normalizado)) puntaje += 0.15;
    if (/PR\s*UNIT/.test(normalizado)) puntaje += 0.1;

    return Math.min(1, puntaje);
  },

  analizar(textos: TextosComprobante): AnalisisComprobante {
    const observaciones: string[] = [];
    const header = analizarEncabezado(`${textos.encabezado ?? ''}\n${textos.completo}`);
    const { items, avisos } = analizarArticulos(textos.articulos || textos.completo);
    observaciones.push(...avisos);

    const summary = analizarPie(textos.resumen || textos.completo);

    if (items.length === 0) {
      observaciones.push('No se reconoció ningún renglón en la tabla de artículos.');
    }

    /*
     * El control que de verdad decide: la suma de los renglones contra el neto
     * impreso. Si difieren en más de unos centavos, falta un renglón o sobra
     * uno, y eso no se arregla mirando cada fila por separado.
     */
    if (items.length > 0 && summary.netTotal) {
      const neto = parseArNumber(summary.netTotal);
      const suma = items.reduce(
        (acc, it) => acc.plus(parseArNumber(it.grossSubtotal ?? '0') ?? new Decimal(0)),
        new Decimal(0),
      );
      if (neto && suma.minus(neto).abs().gt(new Decimal('0.05'))) {
        observaciones.push(
          `Los ${items.length} renglones suman ${suma.toFixed(2)} y el neto impreso es ` +
            `${neto.toFixed(2)}. Falta o sobra algún renglón.`,
        );
      }
    }

    return { header, items, summary, observaciones };
  },
};

function analizarEncabezado(texto: string): OcrHeader {
  const header: OcrHeader = {
    docType: 'FACTURA',
    // La letra va en un recuadro aparte que el recorte casi nunca agarra. Este
    // proveedor factura A a responsables inscriptos; si el recuadro se lee, lo
    // leído manda.
    letter: 'A',
    pointOfSale: null,
    number: null,
    fullNumber: null,
    issueDate: null,
    supplierName: 'Mabelherdi',
    legalName: 'MABELHERDI S.A.',
    cuit: null,
    currency: 'ARS',
  };

  const letra = texto.match(/\bfactura\s+([ABCEM])\b/i);
  if (letra) header.letter = letra[1].toUpperCase();

  // "Comprobante: 0007-00348491"
  const comprobante = texto.match(
    new RegExp(
      `comprobante\\s*[:.]?\\s*([${CLASE_DIGITOS_OCR}]{4})\\s*-\\s*([${CLASE_DIGITOS_OCR}]{6,9})`,
      'i',
    ),
  );
  if (comprobante) {
    header.pointOfSale = repararDigitos(comprobante[1]).padStart(4, '0');
    header.number = repararDigitos(comprobante[2]).padStart(8, '0');
  }
  if (header.pointOfSale && header.number) {
    header.fullNumber = `${header.pointOfSale}-${header.number}`;
  }

  /*
   * La fecha de emisión, no la de entrega.
   *
   * El comprobante trae las dos, y la de entrega está más abajo y más cerca de
   * la tabla. Tomar la que caiga primero daría 22/08 en vez de 20/08, y con eso
   * se calcularía mal el vencimiento del pago.
   */
  const emision = texto.match(
    new RegExp(
      `fecha\\s*de\\s*emisi[oó]n\\s*[:.]?\\s*([${CLASE_DIGITOS_OCR}]{1,2}[/\\-.][${CLASE_DIGITOS_OCR}]{1,2}[/\\-.][${CLASE_DIGITOS_OCR}]{2,4})`,
      'i',
    ),
  );
  const fecha = emision ? parseArDate(repararDigitos(emision[1])) : null;
  if (fecha) header.issueDate = toISODate(fecha);

  // El CUIT del proveedor es el primero que aparece; el segundo es el del
  // cliente, que va en el bloque de abajo.
  const cuit = texto.match(
    new RegExp(
      `cuit\\s*[:.]?\\s*([${CLASE_DIGITOS_OCR}]{2}-?[${CLASE_DIGITOS_OCR}]{8}-?[${CLASE_DIGITOS_OCR}])`,
      'i',
    ),
  );
  if (cuit) header.cuit = repararDigitos(cuit[1]);

  return header;
}

/** Líneas que nunca son un renglón de artículo en este formato. */
const NO_ES_ARTICULO =
  /^(codigo|c[oó]digo|descripci|desc\b|cantidad|sugerido|pr\s*unit|importe|neto|iva|percepci|total|cae|comentario|comprobante|hoja|controle|esta\s+administracion)/i;

/**
 * Los números de una fila, ya reparados, en el orden en que aparecen.
 *
 * Se toman los tramos que tienen forma de importe y se descartan los que no se
 * pueden interpretar. El signo pesos se acepta pegado o separado, y también
 * cuando el OCR lo leyó como un cinco: lo que decide es que el resto sea un
 * número.
 */
function numerosDeLaCola(cola: string): Decimal[] {
  const encontrados: Decimal[] = [];
  for (const bruto of cola.match(/\$?\s*[\dOoQlI|SsBbZzgq][\dOoQlI|SsBbZzgq.,]*/g) ?? []) {
    const limpio = bruto.replace(/^\$\s*/, '').trim();
    if (limpio === '') continue;
    const valor = conDosDecimales(limpio);
    if (valor !== null) encontrados.push(valor);
  }
  return encontrados;
}

function analizarArticulos(texto: string): { items: OcrItem[]; avisos: string[] } {
  const items: OcrItem[] = [];
  const avisos: string[] = [];
  let numero = 0;

  /*
   * La fila se parte por el signo de porcentaje, no se lee de corrido.
   *
   * Es el único carácter que aparece exactamente una vez por renglón y siempre
   * en el mismo lugar: cierra la columna «Desc». A la izquierda quedan el
   * código y la descripción; a la derecha, la cantidad, la unidad y las tres
   * columnas de importes.
   *
   * Partir ahí evita depender de la basura que el OCR mete entre medio. Sobre
   * la foto real, un renglón salió como «120GRX21 ...DO0.00%»: una expresión
   * que intentara leer la fila entera de una vez se traba en esa «D», mientras
   * que partir por el «%» la deja del lado de la descripción, donde no molesta.
   */
  for (const cruda of texto.split('\n')) {
    const linea = cruda.trim();
    if (linea === '' || NO_ES_ARTICULO.test(linea)) continue;

    const corte = linea.indexOf('%');
    if (corte === -1) continue;
    const izquierda = linea.slice(0, corte);
    const derecha = linea.slice(corte + 1);

    // A la izquierda: el código de artículo y la descripción.
    const cabeza = izquierda.match(new RegExp(`^([${CLASE_DIGITOS_OCR}]{6,12})\\s+(.*)$`));
    if (!cabeza) continue;
    const codigo = repararDigitos(cabeza[1]);

    /*
     * El último tramo de la izquierda es el porcentaje de descuento, con la
     * basura que le haya quedado pegada adelante. La descripción es todo lo
     * anterior.
     */
    const trozos = cabeza[2].trim().split(/\s+/);
    const descuentoBruto = trozos.length > 1 ? trozos[trozos.length - 1] : '0';
    const descripcion = (trozos.length > 1 ? trozos.slice(0, -1) : trozos)
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (descripcion.length < 3 || !/[A-Za-zÁÉÍÓÚÑáéíóúñ]{3}/.test(descripcion)) continue;

    /*
     * A la derecha: la cantidad y, después de la palabra de la unidad, las tres
     * columnas numéricas. La unidad es el pivote; sin ella no se sabría cuál de
     * los números es la cantidad.
     */
    const conUnidad = derecha.match(/^\s*(\S+)\s+(?:unidad(?:es)?|unid|un|u)\b(.*)$/i);
    if (!conUnidad) continue;

    const cantidad = conDosDecimales(conUnidad[1]);
    if (cantidad === null || cantidad.lte(0)) continue;

    const numeros = numerosDeLaCola(conUnidad[2]);
    /*
     * Sugerido, Pr Unit e Importe. Hacen falta las tres para saber cuál es
     * cuál: con menos no se puede distinguir el importe del sugerido, y
     * confundirlos multiplicaría el costo de la factura.
     */
    if (numeros.length < 3) {
      avisos.push(`Renglón «${descripcion}»: no se leyeron las tres columnas de importes.`);
      continue;
    }
    const importe = numeros[2];

    numero += 1;

    /*
     * El precio unitario sale de la división, no de la lectura. Ver el
     * comentario de arriba: la columna Importe es la que se lee entera.
     */
    const unitario = importe.div(cantidad).toDecimalPlaces(4);

    /*
     * Y se contrasta contra lo impreso. No para corregirlo —el derivado manda—
     * sino para avisar si difieren de más de lo que explica el redondeo.
     *
     * Antes de dar la alarma se descuenta una confusión conocida: el signo
     * pesos leído como un cinco. Sobre esta foto, «$1.239,67» salió como
     * «5123967», que interpretado da $51.239,67 y dispararía un aviso sobre un
     * renglón que en realidad está perfecto. Si al sacarle ese primer dígito el
     * número coincide con el derivado, era el signo y no una diferencia.
     */
    const impreso = numeros[1];
    const sinElPeso = conDosDecimales(
      impreso.times(100).toFixed(0).replace(/^5/, ''),
    );
    const coincide = (valor: Decimal | null) =>
      valor !== null && valor.minus(unitario).abs().lte(unitario.times('0.02').plus('0.02'));

    if (impreso.gt(0) && !coincide(impreso) && !coincide(sinElPeso)) {
      avisos.push(
        `Renglón ${numero} (${descripcion}): el precio unitario impreso se leyó ` +
          `${impreso.toFixed(2)} y de importe ÷ cantidad da ${unitario.toFixed(2)}. ` +
          'Se usa el calculado; conviene mirar el papel.',
      );
    }

    const descuento = parseRate(repararDigitos(descuentoBruto.replace(/[^\d.,]/g, '')) || '0');

    items.push({
      lineNumber: numero,
      supplierCode: codigo,
      description: descripcion,
      quantity: cantidad.toString(),
      // Mabelherdi vende paquetes cerrados: acá no hay kilos.
      unit: 'UNIT',
      pieceCount: null,
      totalWeightKg: null,
      unitNetPrice: unitario.toString(),
      grossSubtotal: importe.toString(),
      discountPct: descuento ? descuento.toString() : '0',
      discountAmount: null,
      netAmount: null,
      ivaRate: '0.21',
    });
  }

  return { items, avisos };
}

/**
 * El pie, que en este formato viene en una sola línea.
 *
 * «Neto 21.00% $ 32998.85  IVA21 .00% $ 6929.76  Percepcion IIBB $ 577.48» sale
 * todo junto, y el Total en la línea siguiente. Por eso no se puede recorrer
 * línea por línea buscando etiquetas: hay que buscar cada etiqueta con su
 * importe dentro del texto, esté donde esté.
 */
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

  /*
   * El pie se busca desde donde empieza, no en todo el texto.
   *
   * «IVA» aparece tres veces antes del pie —«IVA Responsable Inscripto»,
   * «Condicion IVA»— y aplanar la página entera hace que la etiqueta enganche
   * la primera de esas y se traiga el importe que tenga más cerca, que es el
   * primer «$ 3500» de la tabla. Así que primero se ubica el renglón del neto,
   * que es donde el pie arranca, y recién ahí se aplana.
   */
  const lineas = texto.split('\n');
  const inicio = lineas.findIndex((l) => /\bneto\b/i.test(l) && /\$/.test(l));
  const plano = (inicio === -1 ? lineas : lineas.slice(inicio)).join(' ');
  const IMPORTE = `\\$\\s*([${CLASE_DIGITOS_OCR}][${CLASE_DIGITOS_OCR}.,]*)`;

  const leer = (patron: RegExp): Decimal | null => {
    const encontrado = plano.match(patron);
    return encontrado ? parseArNumber(repararDigitos(encontrado[1])) : null;
  };

  // "Neto 21.00% $ 32998.85" — el porcentaje va entre la etiqueta y el importe.
  const neto = leer(new RegExp(`neto[^$]*?${IMPORTE}`, 'i'));
  if (neto) summary.netTotal = neto.toString();

  /*
   * "IVA21 .00% $ 6929.76". La etiqueta y la tasa vienen pegadas y partidas al
   * mismo tiempo, así que la tasa no se lee de ahí: este proveedor factura todo
   * al 21 %, que es además lo que dice el rótulo del neto.
   */
  const iva = leer(new RegExp(`iva[^$]*?${IMPORTE}`, 'i'));
  if (iva) {
    summary.ivaLines!.push({ label: 'IVA', rate: '0.21', amount: iva.toString() });
  }

  const iibb = leer(new RegExp(`percepci[oó]n[^$]*?${IMPORTE}`, 'i'));
  if (iibb) {
    summary.perceptionLines!.push({
      label: 'Percepción IIBB',
      rate: null,
      amount: iibb.toString(),
    });
  }

  const total = leer(new RegExp(`total\\s*[:.]?\\s*${IMPORTE}`, 'i'));
  if (total) summary.total = total.toString();

  summary.ivaTotal = sumar(summary.ivaLines);
  summary.perceptionsTotal = sumar(summary.perceptionLines);
  return summary;
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
