/**
 * Conversión de PDF a imágenes, con PDF.js servido localmente.
 *
 * Los remitos que llegan por correo vienen en PDF. Tesseract no los interpreta,
 * así que cada página se dibuja en un lienzo a una resolución cómoda para el
 * OCR y de ahí sale como cualquier otra foto.
 */
import type { Mapa } from '@/lib/cliente/ocr/imagen';

export const RUTA_WORKER_PDF = '/ocr/pdfjs/pdf.worker.min.mjs';

/** Alto al que se rasteriza cada página. A 2200 px una factura A4 se lee bien. */
const ALTO_OBJETIVO = 2200;
/** Tope de páginas: un remito largo no puede colgar el teléfono. */
export const MAXIMO_PAGINAS = 10;

type ModuloPdf = typeof import('pdfjs-dist');
let modulo: Promise<ModuloPdf> | null = null;

async function cargarPdfJs(): Promise<ModuloPdf> {
  if (!modulo) {
    modulo = import('pdfjs-dist').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = RUTA_WORKER_PDF;
      return pdfjs;
    });
  }
  return modulo;
}

/**
 * ¿Es un PDF?
 *
 * El nombre va aparte porque `File.name` es de sólo lectura: no se le puede
 * pegar encima al Blob que quedó después de comprimir la foto.
 */
export function esPdf(archivo: Blob, nombre?: string): boolean {
  return archivo.type === 'application/pdf' || Boolean(nombre?.toLowerCase().endsWith('.pdf'));
}

/**
 * Rasteriza el PDF, una página por elemento del arreglo.
 *
 * Se dibuja sobre blanco: los PDF con fondo transparente saldrían negros y
 * Tesseract no leería nada.
 */
export async function paginasDePdf(
  archivo: Blob,
  alProgresar?: (pagina: number, total: number) => void,
): Promise<Mapa[]> {
  const pdfjs = await cargarPdfJs();
  const datos = new Uint8Array(await archivo.arrayBuffer());
  const documento = await pdfjs.getDocument({ data: datos }).promise;

  try {
    const total = Math.min(documento.numPages, MAXIMO_PAGINAS);
    const paginas: Mapa[] = [];

    for (let numero = 1; numero <= total; numero++) {
      alProgresar?.(numero, total);
      const pagina = await documento.getPage(numero);

      const base = pagina.getViewport({ scale: 1 });
      const escala = Math.min(4, ALTO_OBJETIVO / base.height);
      const vista = pagina.getViewport({ scale: escala });

      const ancho = Math.ceil(vista.width);
      const alto = Math.ceil(vista.height);
      const lienzo =
        typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(ancho, alto)
          : Object.assign(document.createElement('canvas'), { width: ancho, height: alto });
      const ctx = (lienzo as HTMLCanvasElement).getContext('2d', {
        willReadFrequently: true,
      }) as CanvasRenderingContext2D;

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, ancho, alto);

      await pagina.render({
        canvas: lienzo as HTMLCanvasElement,
        canvasContext: ctx,
        viewport: vista,
      }).promise;
      pagina.cleanup();

      const datosImagen = ctx.getImageData(0, 0, ancho, alto);
      paginas.push({ data: datosImagen.data, width: ancho, height: alto });
    }

    return paginas;
  } finally {
    await documento.destroy();
  }
}
