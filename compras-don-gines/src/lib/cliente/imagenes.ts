/**
 * Preparación de las fotos en el teléfono, antes de subirlas.
 *
 * El servidor igual endereza, convierte y comprime todo lo que llega, así que
 * esto es una optimización: bajarle el peso a una foto de 12 MB antes de
 * mandarla por la red de datos del local. Si el navegador no puede decodificar
 * el archivo (por ejemplo un HEIC en un Android), se sube tal cual y lo
 * resuelve el servidor. En ningún caso se le pide al usuario que vuelva a
 * elegir la foto.
 */

/** Lado mayor al que se lleva la foto: alcanza para leer los números chicos. */
const LADO_MAXIMO = 2600;
/** Por debajo de este peso no vale la pena recomprimir. */
const PESO_MINIMO_PARA_COMPRIMIR = 1_400_000;
const CALIDAD = 0.86;

export interface ArchivoPreparado {
  archivo: File;
  nombre: string;
  /** Vista previa para la miniatura. Hay que revocarla al descartar el archivo. */
  vistaPrevia: string | null;
  esPdf: boolean;
  pesoOriginal: number;
  pesoFinal: number;
  comprimido: boolean;
  /** Huella del contenido, para no subir dos veces la misma foto. */
  huella: string;
  /** Tipo del archivo tal como llegó del teléfono. Para el diagnóstico. */
  tipoOriginal: string;
  /** Resolución con la que queda la imagen, en píxeles. */
  ancho: number | null;
  alto: number | null;
}

async function huellaDe(archivo: File): Promise<string> {
  const datos = await archivo.arrayBuffer();
  if (globalThis.crypto?.subtle) {
    const hash = await crypto.subtle.digest('SHA-256', datos);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Safari sólo expone crypto.subtle en contextos seguros. En HTTP local se cae
  // a una huella por tamaño y nombre: el servidor igual verifica el SHA-256.
  return `${archivo.name}:${archivo.size}:${archivo.lastModified}`;
}

async function decodificar(archivo: File): Promise<ImageBitmap | HTMLImageElement | null> {
  try {
    if ('createImageBitmap' in globalThis) {
      // imageOrientation 'from-image' aplica la orientación EXIF: sin esto las
      // fotos verticales del iPhone quedan acostadas.
      return await createImageBitmap(archivo, { imageOrientation: 'from-image' });
    }
  } catch {
    // Sigue por el camino del <img>.
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(archivo);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

export async function prepararArchivo(archivo: File): Promise<ArchivoPreparado> {
  const huella = await huellaDe(archivo);
  const esPdf =
    archivo.type === 'application/pdf' || archivo.name.toLowerCase().endsWith('.pdf');

  if (esPdf) {
    return {
      archivo,
      nombre: archivo.name || 'comprobante.pdf',
      vistaPrevia: null,
      esPdf: true,
      pesoOriginal: archivo.size,
      pesoFinal: archivo.size,
      comprimido: false,
      huella,
      tipoOriginal: archivo.type || 'application/pdf',
      ancho: null,
      alto: null,
    };
  }

  const sinCambios = (medidas?: { ancho: number; alto: number }): ArchivoPreparado => ({
    archivo,
    nombre: archivo.name || 'foto.jpg',
    vistaPrevia: URL.createObjectURL(archivo),
    esPdf: false,
    pesoOriginal: archivo.size,
    pesoFinal: archivo.size,
    comprimido: false,
    huella,
    tipoOriginal: archivo.type || 'image/jpeg',
    ancho: medidas?.ancho ?? null,
    alto: medidas?.alto ?? null,
  });

  const imagen = await decodificar(archivo);
  if (!imagen) return sinCambios();

  const ancho = 'width' in imagen ? imagen.width : 0;
  const alto = 'height' in imagen ? imagen.height : 0;
  if (ancho === 0 || alto === 0) return sinCambios();

  const mayor = Math.max(ancho, alto);
  const necesitaEscalar = mayor > LADO_MAXIMO;
  if (!necesitaEscalar && archivo.size <= PESO_MINIMO_PARA_COMPRIMIR) {
    if ('close' in imagen) imagen.close();
    return sinCambios({ ancho, alto });
  }

  const escala = necesitaEscalar ? LADO_MAXIMO / mayor : 1;
  const destino = document.createElement('canvas');
  destino.width = Math.round(ancho * escala);
  destino.height = Math.round(alto * escala);
  const ctx = destino.getContext('2d');
  if (!ctx) {
    if ('close' in imagen) imagen.close();
    return sinCambios();
  }
  ctx.drawImage(imagen as CanvasImageSource, 0, 0, destino.width, destino.height);
  if ('close' in imagen) imagen.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    destino.toBlob(resolve, 'image/jpeg', CALIDAD),
  );
  if (!blob || blob.size >= archivo.size) return sinCambios({ ancho, alto });

  const nombre = (archivo.name || 'foto').replace(/\.[^.]+$/, '') + '.jpg';
  const optimizado = new File([blob], nombre, { type: 'image/jpeg', lastModified: Date.now() });

  return {
    archivo: optimizado,
    nombre,
    vistaPrevia: URL.createObjectURL(optimizado),
    esPdf: false,
    pesoOriginal: archivo.size,
    pesoFinal: optimizado.size,
    comprimido: true,
    huella,
    tipoOriginal: archivo.type || 'image/jpeg',
    ancho: destino.width,
    alto: destino.height,
  };
}

export function formatearPeso(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}
