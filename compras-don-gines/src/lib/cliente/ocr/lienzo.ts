/**
 * Puente entre los mapas de píxeles y el navegador.
 *
 * Todo lo que toca `<canvas>`, `ImageBitmap` o `Blob` vive acá; el
 * procesamiento en sí está en `imagen.ts`, sin dependencias del DOM, para poder
 * probarlo en Node.
 */
import type { Mapa } from '@/lib/cliente/ocr/imagen';

/** OffscreenCanvas cuando existe (Web Worker), `<canvas>` cuando no. */
function crearLienzo(ancho: number, alto: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(ancho, alto);
  const lienzo = document.createElement('canvas');
  lienzo.width = ancho;
  lienzo.height = alto;
  return lienzo;
}

function contexto(lienzo: OffscreenCanvas | HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = (lienzo as HTMLCanvasElement).getContext('2d', {
    willReadFrequently: true,
  }) as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error('El navegador no permitió usar el lienzo de dibujo.');
  return ctx;
}

/**
 * Decodifica una imagen a mapa de píxeles.
 *
 * `imageOrientation: 'from-image'` aplica la orientación EXIF: sin esto las
 * fotos verticales del iPhone llegan acostadas y Tesseract no lee nada.
 */
export async function mapaDesdeBlob(blob: Blob, ladoMaximo?: number): Promise<Mapa> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    // Safari antiguo no acepta las opciones: se decodifica igual y la
    // orientación queda como venga.
    bitmap = await createImageBitmap(blob);
  }

  let ancho = bitmap.width;
  let alto = bitmap.height;
  if (ladoMaximo && Math.max(ancho, alto) > ladoMaximo) {
    const factor = ladoMaximo / Math.max(ancho, alto);
    ancho = Math.round(ancho * factor);
    alto = Math.round(alto * factor);
  }

  const lienzo = crearLienzo(ancho, alto);
  const ctx = contexto(lienzo);
  ctx.drawImage(bitmap, 0, 0, ancho, alto);
  bitmap.close();

  const datos = ctx.getImageData(0, 0, ancho, alto);
  return { data: datos.data, width: datos.width, height: datos.height };
}

export function mapaALienzo(mapa: Mapa): OffscreenCanvas | HTMLCanvasElement {
  const lienzo = crearLienzo(mapa.width, mapa.height);
  const ctx = contexto(lienzo);
  const datos = ctx.createImageData(mapa.width, mapa.height);
  datos.data.set(mapa.data);
  ctx.putImageData(datos, 0, 0);
  return lienzo;
}

/** Convierte a Blob, que es lo que acepta Tesseract y lo que se sube al servidor. */
export async function mapaABlob(mapa: Mapa, tipo = 'image/png', calidad?: number): Promise<Blob> {
  const lienzo = mapaALienzo(mapa);
  if ('convertToBlob' in lienzo) {
    return lienzo.convertToBlob({ type: tipo, quality: calidad });
  }
  return new Promise((resolver, rechazar) => {
    (lienzo as HTMLCanvasElement).toBlob(
      (blob) => (blob ? resolver(blob) : rechazar(new Error('No se pudo convertir la imagen.'))),
      tipo,
      calidad,
    );
  });
}

export function mapaAUrl(mapa: Mapa): string {
  const lienzo = mapaALienzo(mapa);
  if (lienzo instanceof HTMLCanvasElement) return lienzo.toDataURL('image/png');
  throw new Error('mapaAUrl sólo se puede usar en el hilo principal.');
}
