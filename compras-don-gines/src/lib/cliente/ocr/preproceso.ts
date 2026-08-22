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
  clonarMapa,
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

/**
 * Lado mayor con el que trabaja el OCR de la página completa.
 *
 * Una foto de iPhone viene con 4032 px y conviene bajarla: a esa resolución
 * Tesseract tarda muchísimo y no lee mejor. Se reescala sólo cuando la
 * diferencia justifica la pérdida de nitidez —de ahí el margen del 15 %—,
 * porque un reescalado corto emborrona los dígitos chicos sin ganar nada.
 *
 * El valor está medido, no elegido a ojo: con la factura de Los Calvos, 2200 px
 * lee mejor que 2600, porque de ahí sale un recorte de la tabla que se amplía
 * más y termina con los dígitos más grandes.
 */
export const LADO_PAGINA = 2200;
const MARGEN_REESCALADO = 1.15;
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
 *
 * Se limpia con mano liviana a propósito. El filtro de mediana y el realce
 * fuerte salvan una foto movida, pero sobre un comprobante que ya salió nítido
 * hacen daño: redondean el trazo y convierten un "0" en un "9" o una coma en un
 * punto. La limpieza fuerte queda para la relectura, que es cuando ya sabemos
 * que la lectura suave no alcanzó.
 */
export function prepararPagina(original: Mapa): ResultadoPreproceso {
  let mapa = original;
  let perspectivaCorregida = false;

  const esquinas = detectarEsquinas(mapa);
  if (esquinas) {
    mapa = corregirPerspectiva(mapa, esquinas);
    perspectivaCorregida = true;
  }

  if (Math.max(mapa.width, mapa.height) > LADO_PAGINA * MARGEN_REESCALADO) {
    const factor = LADO_PAGINA / Math.max(mapa.width, mapa.height);
    mapa = escalar(mapa, Math.round(mapa.width * factor), Math.round(mapa.height * factor));
  }

  aEscalaDeGrises(mapa);
  normalizarContraste(mapa);

  const { mapa: derecho, angulo } = enderezar(mapa);
  return { mapa: derecho, inclinacion: angulo, perspectivaCorregida };
}

/**
 * Limpieza fuerte para la relectura.
 *
 * Se aplica sobre la página ya preparada, no sobre la original: así no hay que
 * guardar el mapa original de cada página, que en un comprobante de diez
 * páginas serían casi doscientos megabytes en el teléfono.
 */
export function limpiarFuerte(pagina: Mapa): Mapa {
  const mapa = clonarMapa(pagina);
  reducirRuido(mapa);
  enfocar(mapa, 0.8);
  return mapa;
}

/**
 * Preparación de un recorte para leer números.
 *
 * En la primera vuelta se amplía y se levanta el contraste, nada más. Binarizar
 * de entrada parecía buena idea —un blanco y negro limpio se lee mejor que el
 * gris— pero sobre un comprobante nítido pasa lo contrario: el umbral se come
 * la cola de la coma y la deja como un punto, o cierra el "0" y lo vuelve un
 * "9". Sobre una foto mala sí ayuda, y ahí es donde se usa: en la relectura,
 * junto con el filtro de mediana y el realce fuerte.
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

  if (agresivo) {
    reducirRuido(mapa);
    enfocar(mapa, 1);
    // Ventana amplia: los renglones de una factura son largos y la iluminación
    // cambia de un lado al otro de la hoja.
    binarizarSauvola(mapa, 31, 0.2);
  }

  return mapa;
}
