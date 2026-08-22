/**
 * Lector Tesseract, en el navegador y sin servicios externos.
 *
 * Tesseract.js levanta su propio Web Worker, así que el reconocimiento no
 * bloquea la interfaz. Los tres archivos que necesita —el worker, el núcleo de
 * WebAssembly y el idioma español— se sirven desde `/ocr/`, del mismo dominio:
 * nada sale del teléfono y nada depende de una CDN.
 */
import { createWorker, PSM, type Worker } from 'tesseract.js';
import { mapaABlob } from '@/lib/cliente/ocr/lienzo';
import type { Mapa } from '@/lib/cliente/ocr/imagen';
import type { LineaOcr } from '@/lib/cliente/ocr/regiones';

export const RUTA_WORKER = '/ocr/tesseract/worker.min.js';
export const RUTA_NUCLEO = '/ocr/tesseract';
export const RUTA_IDIOMA = '/ocr/tessdata';
export const IDIOMA = 'spa';

export interface ProgresoLector {
  etapa: 'preparando' | 'reconociendo';
  /** 0 a 1. */
  avance: number;
}

export interface ResultadoLectura {
  texto: string;
  confianza: number;
  lineas: LineaOcr[];
}

export interface OpcionesLectura {
  /** Segmentación: AUTO para la página entera, SINGLE_BLOCK para un recorte. */
  psm?: PSM;
  /** Caracteres permitidos. Restringirlos mejora mucho las columnas de números. */
  soloEstosCaracteres?: string;
}

let lector: Promise<Worker> | null = null;

/**
 * Tope para preparar el lector.
 *
 * La primera vez hay que bajar unos 15 MB entre el WebAssembly y el idioma, así
 * que el margen es amplio. Pero tiene que existir: si un archivo del lector no
 * llega —una descarga cortada, un archivo que faltó al publicar—, el worker se
 * queda esperando para siempre y el usuario ve un cartel de "preparando" que no
 * avanza nunca. Es preferible avisarle y que pueda reintentar.
 */
const ESPERA_PREPARACION_MS = 180_000;

function conTope<T>(promesa: Promise<T>, ms: number, mensaje: string): Promise<T> {
  return new Promise<T>((resolver, rechazar) => {
    const reloj = setTimeout(() => rechazar(new Error(mensaje)), ms);
    promesa.then(
      (valor) => {
        clearTimeout(reloj);
        resolver(valor);
      },
      (error) => {
        clearTimeout(reloj);
        rechazar(error);
      },
    );
  });
}

/**
 * Worker compartido.
 *
 * Crearlo cuesta unos segundos —hay que bajar y compilar el WebAssembly y
 * cargar el idioma—, así que se hace una sola vez por sesión y se reutiliza
 * para todas las etapas y todas las páginas.
 */
export function obtenerLector(alProgresar?: (p: ProgresoLector) => void): Promise<Worker> {
  if (lector) return lector;

  lector = conTope(
    createWorker(IDIOMA, 1, {
      workerPath: RUTA_WORKER,
      corePath: RUTA_NUCLEO,
      langPath: RUTA_IDIOMA,
      gzip: true,
      logger: (mensaje) => {
        if (!alProgresar) return;
        if (mensaje.status === 'recognizing text') {
          alProgresar({ etapa: 'reconociendo', avance: mensaje.progress });
        } else {
          alProgresar({ etapa: 'preparando', avance: mensaje.progress });
        }
      },
    }),
    ESPERA_PREPARACION_MS,
    'No se pudo preparar el lector de comprobantes. Fijate que tengas conexión y volvé a intentar.',
  ).catch((error) => {
    // Si falla, la próxima llamada tiene que poder reintentar.
    lector = null;
    throw error;
  });

  return lector;
}

export async function liberarLector(): Promise<void> {
  if (!lector) return;
  const actual = lector;
  lector = null;
  try {
    (await actual).terminate();
  } catch {
    // Si ya estaba caído, no hay nada que liberar.
  }
}

/** ¿Está listo el lector? Sirve para mostrar "preparando" sólo la primera vez. */
export function lectorPreparado(): boolean {
  return lector !== null;
}

export async function leerMapa(
  mapa: Mapa,
  opciones: OpcionesLectura = {},
  alProgresar?: (p: ProgresoLector) => void,
): Promise<ResultadoLectura> {
  const worker = await obtenerLector(alProgresar);

  await worker.setParameters({
    tessedit_pageseg_mode: opciones.psm ?? PSM.AUTO,
    // Sin esto Tesseract colapsa los espacios y se pierde la separación entre
    // columnas, que es justamente de donde el parser saca los importes.
    preserve_interword_spaces: '1',
    // Declarar el DPI evita que Tesseract lo adivine mal en imágenes ampliadas.
    user_defined_dpi: '300',
    ...(opciones.soloEstosCaracteres
      ? { tessedit_char_whitelist: opciones.soloEstosCaracteres }
      : { tessedit_char_whitelist: '' }),
  });

  const imagen = await mapaABlob(mapa, 'image/png');
  const { data } = await worker.recognize(imagen, {}, { text: true, blocks: true });

  const lineas: LineaOcr[] = [];
  for (const bloque of data.blocks ?? []) {
    for (const parrafo of bloque.paragraphs ?? []) {
      for (const linea of parrafo.lines ?? []) {
        const texto = linea.text.replace(/\n+$/, '');
        if (texto.trim() === '') continue;
        lineas.push({
          texto,
          confianza: linea.confidence / 100,
          caja: {
            x0: linea.bbox.x0,
            y0: linea.bbox.y0,
            x1: linea.bbox.x1,
            y1: linea.bbox.y1,
          },
        });
      }
    }
  }

  return {
    texto: data.text ?? '',
    confianza: (data.confidence ?? 0) / 100,
    lineas,
  };
}

export { PSM };
