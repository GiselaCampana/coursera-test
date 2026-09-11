/**
 * La evidencia que deja el lector, antes de interpretar nada.
 *
 * Hasta acá la lectura entregaba **texto**: cada pasada del OCR producía un
 * string y las pasadas se pegaban con saltos de línea. Eso alcanza cuando la
 * impresión llega derecha, y es exactamente lo que se rompe sobre una foto de
 * teléfono: la geometría —que es lo único que dice qué celda va con qué
 * renglón— se tira antes de que nadie la mire, y lo que llega al motor
 * semántico es una tabla ya desarmada. Guardar un perfil no arregla eso: una
 * persona puede decir qué significa una columna, pero no puede recuperar veinte
 * renglones que se perdieron antes.
 *
 * Así que esta capa conserva **fragmentos con coordenadas**, y conserva de dónde
 * salió cada uno. Las reglas que la hacen servible:
 *
 *  - **todo normalizado a 0..1** respecto del ancho y el alto de la página.
 *    Una pasada sobre un recorte ampliado al triple tiene que poder compararse
 *    con una sobre la página entera, y una foto de 1080 px con una de 4032;
 *
 *  - **nada se pisa**. Dos pasadas que leen la misma palabra distinto son dos
 *    fragmentos, no uno que gana. Cuál vale se decide después, con la
 *    aritmética, y hasta entonces las dos alternativas tienen que existir;
 *
 *  - **nada se repara en silencio**. Si un número se corrige, queda el original
 *    y queda dicho qué transformación se le aplicó.
 */

/** Una caja, siempre en fracción del ancho y el alto de la página. */
export interface Caja {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Cómo se preparó la imagen antes de leerla. */
export type VarianteDePreproceso =
  /** La página tal como se preparó para el OCR, sin limpieza extra. */
  | 'directo'
  /** Filtro de mediana y realce: rescata filas con ruido alrededor. */
  | 'limpieza-fuerte'
  /** Recorte ampliado de una zona. */
  | 'ampliado';

/** Qué parte del comprobante estaba mirando la pasada. */
export type ZonaLeida = 'completo' | 'encabezado' | 'articulos' | 'resumen' | 'franja';

/**
 * Una pasada del OCR.
 *
 * `region` es el pedazo de página que cubrió, en coordenadas de página. Es lo
 * que permite devolver a su lugar las cajas de un recorte: Tesseract las da en
 * píxeles del recorte, y sin saber de dónde salió ese recorte no hay manera de
 * saber a qué renglón corresponden.
 */
export interface Pasada {
  id: string;
  zona: ZonaLeida;
  variante: VarianteDePreproceso;
  /** El modo de segmentación de Tesseract, como texto, para poder informarlo. */
  psm: string;
  /** Qué parte de la página cubrió, normalizada. */
  region: Caja;
  /** Confianza media que declaró el OCR para la pasada entera. */
  confianza: number;
  ms: number;
}

/**
 * Un pedazo de texto leído, con todo lo que hace falta para juzgarlo.
 *
 * Es la unidad mínima de la evidencia: una palabra, o lo que el OCR haya
 * decidido tratar como una. No se limpia ni se corrige acá.
 */
export interface Fragmento {
  texto: string;
  caja: Caja;
  /** De qué pasada salió. */
  pasada: string;
  /** 0 a 1, la que declaró el OCR para esta palabra. */
  confianza: number;
  /**
   * Otras lecturas que el propio OCR consideró para esta misma palabra.
   *
   * Tesseract las entrega y hasta ahora se tiraban. Sirven justo donde más
   * falta hacen: un importe que salió «57957,7B» tiene casi siempre la lectura
   * correcta entre las alternativas, y elegirla por aritmética es distinto de
   * inventarla.
   */
  alternativas?: string[];
}

export interface EvidenciaDeLectura {
  /** Ancho y alto en píxeles de la página de referencia, para poder informar. */
  anchoPx: number;
  altoPx: number;
  pasadas: Pasada[];
  fragmentos: Fragmento[];
}

// ---------------------------------------------------------------------------
// Normalizar
// ---------------------------------------------------------------------------

/**
 * Lleva una caja en píxeles de un recorte a coordenadas de página.
 *
 * Las dos conversiones van juntas a propósito —dividir por el tamaño del
 * recorte y después ubicarlo dentro de la página— porque hacerlas por separado
 * es la forma conocida de equivocarse: una caja normalizada contra el recorte y
 * no reubicada produce regiones diminutas contra el borde de la página, y eso
 * **no falla**, da un resultado que parece válido.
 */
export function aCoordenadasDePagina(
  cajaEnPx: Caja,
  recorte: { anchoPx: number; altoPx: number },
  region: Caja,
): Caja {
  const anchoRegion = region.x1 - region.x0;
  const altoRegion = region.y1 - region.y0;
  return {
    x0: region.x0 + (cajaEnPx.x0 / recorte.anchoPx) * anchoRegion,
    y0: region.y0 + (cajaEnPx.y0 / recorte.altoPx) * altoRegion,
    x1: region.x0 + (cajaEnPx.x1 / recorte.anchoPx) * anchoRegion,
    y1: region.y0 + (cajaEnPx.y1 / recorte.altoPx) * altoRegion,
  };
}

/** La caja entera: una pasada sobre la página completa. */
export const PAGINA_ENTERA: Caja = { x0: 0, y0: 0, x1: 1, y1: 1 };

export function centroX(caja: Caja): number {
  return (caja.x0 + caja.x1) / 2;
}

export function centroY(caja: Caja): number {
  return (caja.y0 + caja.y1) / 2;
}

export function alto(caja: Caja): number {
  return caja.y1 - caja.y0;
}

export function ancho(caja: Caja): number {
  return caja.x1 - caja.x0;
}

/** Cuánto se superponen dos intervalos horizontales, en fracción de página. */
export function solapeHorizontal(a: Caja, b: Caja): number {
  return Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
}

/** Cuánto se superponen dos intervalos verticales. */
export function solapeVertical(a: Caja, b: Caja): number {
  return Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
}

/** La caja que contiene a las dos. */
export function unir(a: Caja, b: Caja): Caja {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

/**
 * ¿Están las cajas normalizadas, como corresponde?
 *
 * El mismo control que ya existe en el lector, acá arriba de todo: unas
 * coordenadas en píxeles que se cuelen en la evidencia no producen un error,
 * producen una reconstrucción silenciosamente absurda donde todo cae en la
 * primera columna.
 */
export function evidenciaNormalizada(evidencia: EvidenciaDeLectura): boolean {
  return evidencia.fragmentos.every(
    (f) => f.caja.x0 >= -0.001 && f.caja.y0 >= -0.001 && f.caja.x1 <= 1.001 && f.caja.y1 <= 1.001,
  );
}
