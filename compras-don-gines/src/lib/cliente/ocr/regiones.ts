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

/** Cuántas columnas numéricas tiene el renglón. */
export function columnasNumericas(texto: string): number {
  const columnas = texto.trim().split(/\s{2,}/);
  const candidatas = columnas.length >= 3 ? columnas : texto.trim().split(/\s+/);
  let total = 0;
  for (const columna of candidatas) {
    if (!/^[$\s]*-?[\d.,\s]+%?$/.test(columna)) continue;
    if (parseArNumber(columna) !== null) total++;
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

/** ¿Es un renglón del recuadro de totales? */
export function pareceRenglonDePie(linea: LineaOcr): boolean {
  const texto = linea.texto.trim();
  if (!ETIQUETAS_DE_PIE.test(texto)) return false;
  return columnasNumericas(texto) >= 1;
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
  const pieDebajo = pie.filter((l) => l.caja.y0 >= abajoTabla - margen);
  const inicioResumen = limitar(
    ((pieDebajo.length > 0 ? Math.min(...pieDebajo.map((l) => l.caja.y0)) : abajoTabla) - margen) /
      alto,
  );
  const finArticulos = limitar((abajoTabla + margen) / alto);

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
