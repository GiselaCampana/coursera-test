/**
 * Ubicación del encabezado, la tabla de artículos y el pie dentro del
 * comprobante.
 *
 * Trabaja sobre los renglones que devuelve el OCR, no sobre los píxeles: un
 * renglón de la tabla se reconoce porque termina en varias columnas numéricas,
 * y el pie porque son etiquetas cortas con un solo importe a la derecha. Eso es
 * mucho más estable que suponer que la tabla está "más o menos en el medio".
 *
 * Son funciones puras: se prueban sin navegador.
 */
import { parseArNumber } from '@/lib/money';

export interface CajaOcr {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface LineaOcr {
  texto: string;
  confianza: number;
  caja: CajaOcr;
}

export interface Region {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface RegionesDetectadas {
  encabezado: Region | null;
  articulos: Region | null;
  resumen: Region | null;
  /** Cuántos renglones se reconocieron como filas de la tabla. */
  filasDetectadas: number;
}

/** Palabras que en un comprobante sólo aparecen en el pie. */
const ETIQUETAS_DE_PIE =
  /\b(sub\s?-?\s?total|neto|gravado|base\s+imponible|i\.?\s?v\.?\s?a|percepci|iibb|ret(?:enci[oó]n)?|descuento|bonific|total|peso\s+neto|cantidad\s+de\s+rengl|bultos)\b/i;

/** Encabezados de la tabla de artículos. */
const ENCABEZADO_DE_TABLA =
  /\b(c[oó]d(?:igo)?|descripci[oó]n|detalle|art[ií]culo|cantidad|kg|precio|unitario|bonif|importe|subtotal)\b/i;

/**
 * Cuántos valores numéricos tiene el renglón.
 *
 * Se cuenta sobre las palabras, no sobre las columnas separadas por espacios
 * anchos. Parece un detalle y no lo es: en una foto de verdad las columnas de
 * la derecha llegan pegadas por un solo espacio y con basura en el medio
 * —"6 $965963 0% 21% — $57957,76"—, así que partir por espacios anchos deja
 * todo eso en una sola columna que no es un número, y el renglón entero pasa
 * por no numérico.
 *
 * Eso fue exactamente lo que rompió una factura real: de veintitrés filas se
 * reconocieron cinco, y con cinco la banda de la tabla salió corta y la del pie
 * arrancó adentro de la tabla. Acá conviene pecar de generoso: esta cuenta sólo
 * sirve para ubicar las zonas del recorte, y una fila de más no hace daño
 * mientras que una de menos corre el corte.
 */
export function columnasNumericas(texto: string): number {
  let total = 0;
  for (const palabra of texto.trim().split(/\s+/)) {
    // Se limpia la basura que el OCR pega a los importes: el guión largo que
    // sale de las líneas de la tabla, la barra vertical del borde.
    const limpia = palabra.replace(/^[$|—–-]+/, '').replace(/[|—–]+$/, '');
    if (limpia === '') continue;
    if (!/^-?[\d.,]+%?$/.test(limpia)) continue;
    if (!/\d/.test(limpia)) continue;
    if (parseArNumber(limpia) !== null) total++;
  }
  return total;
}

/** ¿Es una fila de la tabla de artículos? */
export function pareceFilaDeArticulo(linea: LineaOcr): boolean {
  const texto = linea.texto.trim();
  if (texto.length < 8) return false;
  if (ETIQUETAS_DE_PIE.test(texto)) return false;
  // Descripción a la izquierda y al menos tres números a la derecha.
  if (columnasNumericas(texto) < 3) return false;
  return /[A-Za-zÁÉÍÓÚÑáéíóúñ]{3,}/.test(texto);
}

/**
 * ¿Es un renglón del recuadro de totales?
 *
 * Una etiqueta del pie con **un** importe al lado. El tope de arriba es tan
 * necesario como el de abajo: una fila de la tabla que traiga la palabra "total"
 * en la descripción, o que el OCR ensucie, tiene cuatro o cinco números, y
 * tomarla por pie hace que la banda del resumen arranque en medio de la tabla.
 * Un renglón de totales nunca tiene tres importes.
 */
export function pareceRenglonDePie(linea: LineaOcr): boolean {
  const texto = linea.texto.trim();
  if (!ETIQUETAS_DE_PIE.test(texto)) return false;
  const numeros = columnasNumericas(texto);
  return numeros >= 1 && numeros < 3;
}

/**
 * Reparte la página en las tres zonas.
 *
 * Se toma la banda que va de la primera a la última fila de la tabla, con un
 * margen: la primera fila suele venir pegada al encabezado de columnas y la
 * última al subtotal, y cortar justo encima de un renglón es peor que llevarse
 * de más.
 */
export function detectarRegiones(
  lineas: LineaOcr[],
  ancho: number,
  alto: number,
): RegionesDetectadas {
  if (lineas.length === 0 || ancho <= 0 || alto <= 0) {
    return { encabezado: null, articulos: null, resumen: null, filasDetectadas: 0 };
  }

  const filas = lineas.filter(pareceFilaDeArticulo);
  const pie = lineas.filter(pareceRenglonDePie);

  if (filas.length === 0) {
    // Sin tabla reconocible se cae a bandas por proporción, que es mejor que
    // no ofrecer ningún recorte para la segunda lectura.
    return {
      encabezado: { left: 0, top: 0, width: 1, height: 0.3 },
      articulos: { left: 0, top: 0.2, width: 1, height: 0.55 },
      resumen: { left: 0, top: 0.65, width: 1, height: 0.35 },
      filasDetectadas: 0,
    };
  }

  const arribaTabla = Math.min(...filas.map((f) => f.caja.y0));
  const abajoTabla = Math.max(...filas.map((f) => f.caja.y1));
  const altoFila = (abajoTabla - arribaTabla) / Math.max(1, filas.length);
  const margen = Math.max(altoFila * 0.8, alto * 0.01);

  const limitar = (v: number) => Math.min(1, Math.max(0, v));

  // El encabezado de columnas es parte de la tabla: ayuda a Tesseract a
  // mantener las columnas alineadas en la relectura.
  const encabezadoTabla = lineas
    .filter((l) => l.caja.y1 <= arribaTabla + margen && ENCABEZADO_DE_TABLA.test(l.texto))
    .map((l) => l.caja.y0);
  const inicioArticulos = limitar(
    ((encabezadoTabla.length > 0 ? Math.min(...encabezadoTabla) : arribaTabla) - margen) / alto,
  );

  // El pie empieza donde termina la última fila; si se reconocieron renglones
  // de totales, se usa el primero de ellos que esté por debajo de la tabla.
  //
  // "Por debajo" es estricto a propósito, sin restarle el margen. Con el margen,
  // un renglón que empieza apenas antes de terminar la última fila califica como
  // pie, y entonces la banda del resumen arranca adentro de la tabla: los
  // últimos artículos quedan del lado del pie y no los lee nadie.
  const pieDebajo = pie.filter((l) => l.caja.y0 >= abajoTabla);

  /*
   * Dónde termina la tabla.
   *
   * Con el pie a la vista es fácil: la tabla llega hasta ahí. El caso difícil es
   * cuando el pie no se reconoció, que es lo habitual en una foto: el recuadro
   * de totales tiene las etiquetas de un lado y los importes del otro, y en la
   * pasada de página completa suele salir sin etiquetas.
   *
   * Ahí no se puede cortar en la última fila *reconocida*. Las filas que el OCR
   * no alcanzó a leer en la página completa son casi siempre las de abajo —la
   * descripción se corta, el renglón queda sin letras y deja de parecer una
   * fila—, así que cortar ahí garantiza perderlas justo en el recorte que
   * existe para recuperarlas. Se estira la banda unas cuantas alturas de fila:
   * llevarse de más sólo agrega texto que el analizador descarta, mientras que
   * llevarse de menos borra artículos del comprobante.
   */
  const estiradoSinPie = Math.min(alto * 0.1, altoFila * 4);
  const finTabla = pieDebajo.length > 0 ? Math.min(...pieDebajo.map((l) => l.caja.y0)) : abajoTabla + estiradoSinPie;

  const inicioResumen = limitar((finTabla - margen) / alto);
  // Las dos bandas son contiguas: entre la primera fila y el pie no hay otra
  // cosa que tabla.
  const finArticulos = limitar((finTabla + margen) / alto);

  return {
    encabezado:
      inicioArticulos > 0.02
        ? { left: 0, top: 0, width: 1, height: inicioArticulos }
        : { left: 0, top: 0, width: 1, height: 0.25 },
    articulos: {
      left: 0,
      top: inicioArticulos,
      width: 1,
      height: Math.max(0.05, finArticulos - inicioArticulos),
    },
    resumen: {
      left: 0,
      top: inicioResumen,
      width: 1,
      height: Math.max(0.05, 1 - inicioResumen),
    },
    filasDetectadas: filas.length,
  };
}

/**
 * Ensancha una región para la segunda lectura.
 *
 * Cuando el detalle no cierra, lo más común es que se haya perdido el primer o
 * el último renglón justo en el borde del recorte. Estirar la banda un poco
 * para arriba y para abajo suele recuperarlos.
 */
export function ensanchar(region: Region, proporcion = 0.06): Region {
  const top = Math.max(0, region.top - proporcion);
  const height = Math.min(1 - top, region.height + proporcion * 2);
  return { ...region, top, height };
}
