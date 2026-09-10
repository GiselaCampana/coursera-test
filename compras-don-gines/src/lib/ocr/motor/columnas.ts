/**
 * Qué significa cada columna de la tabla de un comprobante.
 *
 * Éste es el vocabulario del motor general: en vez de un analizador por
 * proveedor que sabe de memoria que «la tercera columna son kilos», se
 * reconoce **qué es** cada columna por su encabezado, y el orden deja de
 * importar.
 *
 * Las cinco facturas que motivaron esto imprimen la misma información en
 * cinco órdenes distintos:
 *
 *   Errecalde  cód · desc · unid · cant · precio · dto · iva · subtotal
 *   Mabelherdi cód · desc · desc% · cant · sugerido · pr.unit · importe
 *   Los Calvos cód · desc · kg · precio · bonif · importe
 *   Ezra       cód · CANT · desc · marca · p.unit · desc% · p.u.desc · importe
 *   Barraza    cód · KILOS · PIEZAS · desc · pr.unit · bonif · importe
 *
 * Un analizador posicional necesita cinco implementaciones. Uno semántico
 * necesita una, más una tabla de sinónimos.
 */

/**
 * Los campos que un renglón puede traer.
 *
 * Es deliberadamente más fino que `OcrItem`: distingue `cantidad` de `kilos` y
 * de `piezas`, y distingue los tres precios que un comprobante puede imprimir.
 * Colapsarlos antes de tiempo es lo que hacía que un formato con dos columnas
 * de precio se leyera con el de lista como costo.
 */
export type CampoDeColumna =
  | 'codigo'
  /** La cantidad, cuando el comprobante no dice de qué. */
  | 'cantidad'
  /** Kilos, cuando la columna lo dice. */
  | 'kilos'
  /** Piezas o unidades, cuando hay una columna aparte. */
  | 'piezas'
  | 'descripcion'
  | 'marca'
  /** Precio de lista, antes del descuento. */
  | 'precioUnitario'
  /** El porcentaje de descuento o bonificación. */
  | 'descuentoPct'
  /** Precio ya con el descuento aplicado. */
  | 'precioConDescuento'
  /** El importe del renglón, sea bruto o neto: lo decide el perfil. */
  | 'importe'
  /** La tasa de IVA por renglón, cuando el formato la imprime. */
  | 'ivaPct'
  /** Una columna que se reconoce y se descarta a propósito. */
  | 'ignorada';

/** ¿El campo lleva un número o un texto? */
export const CAMPOS_NUMERICOS: ReadonlySet<CampoDeColumna> = new Set([
  'cantidad',
  'kilos',
  'piezas',
  'precioUnitario',
  'descuentoPct',
  'precioConDescuento',
  'importe',
  'ivaPct',
]);

/**
 * Cómo escribe cada proveedor el encabezado de cada columna.
 *
 * Salen de las cinco facturas reales del banco de fotos, no de imaginar
 * sinónimos. Se comparan normalizados —sin acentos, sin puntuación, en
 * minúsculas— porque el OCR pierde tildes y puntos con frecuencia.
 *
 * El orden importa: se prueba de más específico a más general. «pr unit desc»
 * tiene que ganarle a «pr unit», o el precio con descuento se leería como
 * precio de lista, que es exactamente el error que tuvo la factura de Ezra.
 */
interface Alias {
  campo: CampoDeColumna;
  /** Se compara contra el encabezado normalizado. */
  patron: RegExp;
  /**
   * Cuán específico es, de 0 a 1.
   *
   * Con dos alias que coinciden gana el más específico. No es un puntaje de
   * confianza: es desempate entre sinónimos que se solapan.
   */
  especificidad: number;
}

const ALIAS: Alias[] = [
  // --- Los que se solapan, primero y con especificidad alta ---------------
  { campo: 'precioConDescuento', patron: /^p\s*u\s*desc/, especificidad: 1 },
  { campo: 'precioConDescuento', patron: /^(precio|pr)\s*(unit\w*)?\s*(c\/?|con)\s*desc/, especificidad: 1 },
  { campo: 'precioConDescuento', patron: /^precio\s*neto/, especificidad: 0.9 },
  { campo: 'descuentoPct', patron: /^desc\w*\s*%|^%\s*desc/, especificidad: 1 },
  { campo: 'descuentoPct', patron: /^(bonif\w*|dto|dcto|descuento)\b/, especificidad: 0.9 },

  // --- Cantidades, que son las que más se confunden entre sí -------------
  { campo: 'kilos', patron: /^(kilos?|kgs?|peso)\b/, especificidad: 1 },
  { campo: 'piezas', patron: /^(piezas?|unidades?|unid|uds?|bultos?|cajas?)\b/, especificidad: 1 },
  { campo: 'cantidad', patron: /^(cantidad|cant|ctd)\b/, especificidad: 0.8 },

  // --- Identificación y texto --------------------------------------------
  { campo: 'codigo', patron: /^(codigo|cod|art\w*|sku|referencia|ref)\b/, especificidad: 0.9 },
  { campo: 'descripcion', patron: /^(descripcion|descrip|detalle|articulo|producto|concepto)\b/, especificidad: 0.9 },
  { campo: 'marca', patron: /^marca\b/, especificidad: 1 },

  // --- Precios e importes -------------------------------------------------
  { campo: 'precioUnitario', patron: /^(precio|pr)\s*(unit\w*|u)?\b/, especificidad: 0.7 },
  { campo: 'precioUnitario', patron: /^p\s*unit/, especificidad: 0.8 },
  { campo: 'importe', patron: /^(importe|subtotal|total\s*linea|monto)\b/, especificidad: 0.9 },
  { campo: 'ivaPct', patron: /^i\s*v\s*a\b/, especificidad: 0.9 },

  /*
   * Y los que se reconocen para poder DESCARTARLOS.
   *
   * «Sugerido», en Mabelherdi, es el precio de venta que el proveedor sugiere:
   * no es ni el costo ni el importe, y tomarlo por precio unitario carga el
   * comprobante con el número equivocado. Reconocerlo explícitamente es mejor
   * que ignorarlo por omisión: una columna que no se entiende baja la
   * confianza, y ésta sí se entiende —lo que pasa es que no se usa—.
   */
  { campo: 'ignorada', patron: /^sugerido\b/, especificidad: 1 },
  { campo: 'ignorada', patron: /^(iibb|percep\w*)\b/, especificidad: 0.8 },
];

/** Sin acentos, sin puntuación, en minúsculas y con los espacios colapsados. */
export function normalizarEncabezado(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9%\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ColumnaReconocida {
  campo: CampoDeColumna;
  /** El encabezado tal como estaba impreso. */
  encabezado: string;
  /** Cuán seguro es el reconocimiento, de 0 a 1. */
  confianza: number;
}

/**
 * Qué campo es una columna, a partir de su encabezado.
 *
 * Devuelve null cuando no lo reconoce, y eso es información: una tabla con
 * columnas sin reconocer no se interpreta automáticamente, se manda a revisión.
 * Adivinar por posición es lo que este motor viene a eliminar.
 */
export function reconocerColumna(encabezado: string): ColumnaReconocida | null {
  const normalizado = normalizarEncabezado(encabezado);
  if (normalizado === '') return null;

  let mejor: Alias | null = null;
  for (const alias of ALIAS) {
    if (!alias.patron.test(normalizado)) continue;
    if (!mejor || alias.especificidad > mejor.especificidad) mejor = alias;
  }
  if (!mejor) return null;

  return {
    campo: mejor.campo,
    encabezado: encabezado.trim(),
    confianza: mejor.especificidad,
  };
}

/**
 * Reconoce toda una fila de encabezados.
 *
 * Devuelve una entrada por columna, en orden, con null donde no se reconoció
 * nada. Se conserva la posición porque es lo que después ata cada celda de cada
 * renglón a su campo.
 */
export function reconocerColumnas(encabezados: string[]): (ColumnaReconocida | null)[] {
  const reconocidas = encabezados.map(reconocerColumna);

  /*
   * Un campo no puede estar dos veces.
   *
   * Pasa con «Cantidad» y «Unidades» en Barraza si los alias se aflojan, y con
   * «Pr Unit» y «P.U.Desc.» en Ezra. Cuando dos columnas reclaman el mismo
   * campo se queda la de mayor confianza y la otra queda sin reconocer, que es
   * lo que baja la confianza de la tabla y la manda a revisión. Elegir en
   * silencio sería peor: dos columnas distintas cargadas en el mismo lugar.
   */
  const porCampo = new Map<CampoDeColumna, number>();
  reconocidas.forEach((columna, i) => {
    if (!columna || columna.campo === 'ignorada') return;
    const anterior = porCampo.get(columna.campo);
    if (anterior === undefined) {
      porCampo.set(columna.campo, i);
      return;
    }
    const ganador = reconocidas[anterior]!.confianza >= columna.confianza ? anterior : i;
    const perdedor = ganador === anterior ? i : anterior;
    porCampo.set(columna.campo, ganador);
    reconocidas[perdedor] = null;
  });

  return reconocidas;
}

/**
 * ¿Esta línea es la fila de títulos de la tabla?
 *
 * Se pide que reconozca al menos tres campos distintos. Con dos, una línea de
 * datos cuya descripción mencione «precio» o «cantidad» se haría pasar por
 * encabezado y la tabla empezaría en el lugar equivocado.
 */
export function esFilaDeEncabezados(columnas: string[]): boolean {
  const campos = new Set(
    reconocerColumnas(columnas)
      .filter((c): c is ColumnaReconocida => c !== null && c.campo !== 'ignorada')
      .map((c) => c.campo),
  );
  return campos.size >= 3;
}

/**
 * Los campos mínimos para poder interpretar un renglón sin adivinar.
 *
 * Sin descripción no hay con qué asociar el artículo a su producto. Sin alguna
 * cantidad y sin importe no hay compra. El precio se puede deducir del importe
 * y la cantidad, así que no está en la lista.
 */
export function faltanCamposEsenciales(
  columnas: (ColumnaReconocida | null)[],
): CampoDeColumna[] {
  const presentes = new Set(columnas.filter((c) => c).map((c) => c!.campo));
  const faltan: CampoDeColumna[] = [];

  if (!presentes.has('descripcion')) faltan.push('descripcion');
  if (!presentes.has('cantidad') && !presentes.has('kilos') && !presentes.has('piezas')) {
    faltan.push('cantidad');
  }
  if (!presentes.has('importe')) faltan.push('importe');

  return faltan;
}
