/**
 * Recetas de preprocesamiento.
 *
 * Cada etapa de la lectura necesita una preparación distinta. La página entera
 * se prepara suave, para no romper la estructura que Tesseract usa para
 * segmentar; los recortes de la tabla y del pie se preparan agresivo, porque
 * ahí lo único que importa es que los dígitos salgan nítidos.
 *
 * Son funciones puras sobre `Mapa`, así que se pueden probar sin navegador.
 */
import {
  ampliar,
  aEscalaDeGrises,
  binarizarSauvola,
  corregirPerspectiva,
  detectarEsquinas,
  enderezar,
  enfocar,
  escalar,
  normalizarContraste,
  reducirRuido,
  type Mapa,
} from '@/lib/cliente/ocr/imagen';

/** Lado mayor con el que trabaja el OCR de la página completa. */
export const LADO_PAGINA = 2200;
/**
 * Ancho mínimo de un recorte antes de pasarlo al OCR.
 *
 * Tesseract necesita unos 30 px de alto por renglón para leer bien. Ampliar el
 * recorte hasta este ancho es la diferencia entre leer "16.037" y leer "1E.O37".
 */
export const ANCHO_MINIMO_RECORTE = 2400;

export interface ResultadoPreproceso {
  mapa: Mapa;
  /** Grados que hubo que rotar para enderezar. */
  inclinacion: number;
  /** true si se corrigió la perspectiva del papel. */
  perspectivaCorregida: boolean;
}

/**
 * Preparación de la página completa: se busca el papel, se lo endereza y se le
 * levanta el contraste, sin binarizar. Tesseract segmenta mejor una imagen en
 * grises que una ya binarizada por nosotros.
 */
export function prepararPagina(original: Mapa): ResultadoPreproceso {
  let mapa = original;
  let perspectivaCorregida = false;

  const esquinas = detectarEsquinas(mapa);
  if (esquinas) {
    mapa = corregirPerspectiva(mapa, esquinas);
    perspectivaCorregida = true;
  }

  if (Math.max(mapa.width, mapa.height) > LADO_PAGINA) {
    const factor = LADO_PAGINA / Math.max(mapa.width, mapa.height);
    mapa = escalar(mapa, Math.round(mapa.width * factor), Math.round(mapa.height * factor));
  }

  aEscalaDeGrises(mapa);
  normalizarContraste(mapa);
  reducirRuido(mapa);
  enfocar(mapa, 0.6);

  const { mapa: derecho, angulo } = enderezar(mapa);
  return { mapa: derecho, inclinacion: angulo, perspectivaCorregida };
}

/**
 * Preparación de un recorte para leer números.
 *
 * Acá sí se binariza: en la tabla de artículos y en el pie lo que interesa es
 * el trazo de los dígitos, y un blanco y negro limpio da bastante mejor lectura
 * que el gris, sobre todo con la trama de una impresora matricial.
 */
export function prepararRecorte(recorte: Mapa, agresivo = false): Mapa {
  let mapa = recorte;

  if (mapa.width < ANCHO_MINIMO_RECORTE) {
    // Se amplía como mucho ×4: más que eso sólo agranda el ruido.
    const factor = Math.min(4, ANCHO_MINIMO_RECORTE / mapa.width);
    mapa = ampliar(mapa, factor);
  }

  aEscalaDeGrises(mapa);
  normalizarContraste(mapa, 0.005);
  if (agresivo) reducirRuido(mapa);
  enfocar(mapa, agresivo ? 1 : 0.8);
  // Ventana amplia: los renglones de una factura son largos y la iluminación
  // cambia de un lado al otro de la hoja.
  binarizarSauvola(mapa, agresivo ? 31 : 25, 0.2);

  return mapa;
}
