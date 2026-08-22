import 'server-only';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { AppError } from '@/lib/errors';
import { ACCEPTED_MIME } from '@/lib/formatos';

/**
 * Preparación de las fotos antes de leerlas.
 *
 * El caso real es una foto de iPhone: HEIC, 4 MB, rotada según EXIF. La
 * aplicación no le pide al usuario que la vuelva a sacar ni que la convierta:
 * la endereza, la convierte y la comprime sola, cuidando de no perder la
 * resolución que hace falta para leer los números chicos de la factura.
 */

/** Lado mayor de la imagen de trabajo. Alcanza para leer texto de 6 pt. */
export const WORK_MAX_DIMENSION = 2600;
/** Peso objetivo de la imagen de trabajo. */
export const WORK_TARGET_BYTES = 1_600_000;
const JPEG_QUALITY_STEPS = [88, 82, 76, 70, 62];

export { ACCEPTED_IMAGE_MIME, ACCEPTED_MIME, ACCEPT_ATTRIBUTE } from '@/lib/formatos';

export interface NormalizedUpload {
  /** Versión sobre la que se hace OCR y que se muestra en pantalla. */
  work: Buffer;
  workMime: string;
  workExtension: string;
  /** Archivo tal como llegó, que se guarda como copia de archivo. */
  original: Buffer;
  originalMime: string;
  originalExtension: string;
  sha256: string;
  width: number | null;
  height: number | null;
  isPdf: boolean;
  /** true si hubo que convertir de HEIC. */
  converted: boolean;
  /** true si hubo que bajar resolución o calidad. */
  compressed: boolean;
}

export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function extensionFor(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/heic':
      return 'heic';
    case 'image/heif':
      return 'heif';
    case 'application/pdf':
      return 'pdf';
    default:
      return 'bin';
  }
}

/**
 * Safari en iPhone a veces manda el archivo sin tipo o con uno genérico, así
 * que el tipo se decide mirando los primeros bytes y sólo se usa el nombre
 * como último recurso.
 */
export function detectMimeType(buffer: Buffer, declared?: string, filename?: string): string {
  if (buffer.length >= 4) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
      return 'image/png';
    if (buffer.subarray(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
    if (
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    )
      return 'image/webp';
    if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
      const brand = buffer.subarray(8, 12).toString('ascii');
      if (['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs'].includes(brand))
        return 'image/heic';
      if (['mif1', 'msf1'].includes(brand)) return 'image/heif';
    }
  }

  const declaredClean = declared?.split(';')[0]?.trim().toLowerCase();
  if (declaredClean && ACCEPTED_MIME.includes(declaredClean)) return declaredClean;

  const ext = filename?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'heic':
      return 'image/heic';
    case 'heif':
      return 'image/heif';
    case 'pdf':
      return 'application/pdf';
    default:
      return 'application/octet-stream';
  }
}

async function heicToJpeg(buffer: Buffer): Promise<Buffer> {
  // sharp casi nunca trae soporte HEIC compilado, así que se usa un decoder
  // en JavaScript puro y recién después se sigue con sharp.
  const convert = (await import('heic-convert')).default as unknown as (opts: {
    buffer: Buffer;
    format: 'JPEG' | 'PNG';
    quality?: number;
  }) => Promise<ArrayBuffer>;
  const out = await convert({ buffer, format: 'JPEG', quality: 0.94 });
  return Buffer.from(out);
}

/**
 * Endereza según EXIF, convierte lo que haga falta y comprime hasta el tamaño
 * objetivo sin bajar de la resolución mínima legible.
 */
export async function normalizeUpload(
  input: Buffer,
  declaredMime?: string,
  filename?: string,
): Promise<NormalizedUpload> {
  if (input.length === 0) {
    throw new AppError('El archivo llegó vacío. Probá cargarlo de nuevo.', {
      code: 'ARCHIVO_VACIO',
    });
  }

  const originalMime = detectMimeType(input, declaredMime, filename);
  if (!ACCEPTED_MIME.includes(originalMime)) {
    throw new AppError(
      'Ese tipo de archivo no se puede usar. Aceptamos fotos JPG, PNG, WEBP o HEIC, y archivos PDF.',
      { code: 'FORMATO_NO_SOPORTADO' },
    );
  }

  const hash = sha256(input);

  if (originalMime === 'application/pdf') {
    // El PDF se manda tal cual al lector, que lo interpreta nativamente.
    return {
      work: input,
      workMime: 'application/pdf',
      workExtension: 'pdf',
      original: input,
      originalMime,
      originalExtension: 'pdf',
      sha256: hash,
      width: null,
      height: null,
      isPdf: true,
      converted: false,
      compressed: false,
    };
  }

  let decoded = input;
  let converted = false;
  if (originalMime === 'image/heic' || originalMime === 'image/heif') {
    try {
      decoded = await heicToJpeg(input);
      converted = true;
    } catch {
      throw new AppError(
        'No pudimos convertir la foto HEIC del iPhone. Probá sacarla de nuevo o elegir otra imagen.',
        { code: 'HEIC_NO_CONVERTIBLE' },
      );
    }
  }

  let pipeline: sharp.Sharp;
  let metadata: sharp.Metadata;
  try {
    pipeline = sharp(decoded, { failOn: 'none' });
    metadata = await pipeline.metadata();
  } catch {
    throw new AppError('No pudimos leer esa imagen. Probá con otra foto del comprobante.', {
      code: 'IMAGEN_ILEGIBLE',
    });
  }

  const longest = Math.max(metadata.width ?? 0, metadata.height ?? 0);
  const needsResize = longest > WORK_MAX_DIMENSION;

  let work: Buffer | null = null;
  let usedQuality = JPEG_QUALITY_STEPS[0];
  for (const quality of JPEG_QUALITY_STEPS) {
    const candidate = await sharp(decoded, { failOn: 'none' })
      // .rotate() sin argumentos aplica la orientación EXIF: sin esto las
      // fotos verticales del iPhone se leen acostadas.
      .rotate()
      .resize(
        needsResize
          ? { width: WORK_MAX_DIMENSION, height: WORK_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true }
          : undefined,
      )
      .jpeg({ quality, mozjpeg: true, chromaSubsampling: '4:4:4' })
      .toBuffer();
    work = candidate;
    usedQuality = quality;
    if (candidate.length <= WORK_TARGET_BYTES) break;
  }

  if (!work) {
    throw new AppError('No pudimos preparar la imagen para leerla.', { code: 'IMAGEN_ILEGIBLE' });
  }

  const workMeta = await sharp(work).metadata();

  return {
    work,
    workMime: 'image/jpeg',
    workExtension: 'jpg',
    original: input,
    originalMime,
    originalExtension: extensionFor(originalMime),
    sha256: hash,
    width: workMeta.width ?? null,
    height: workMeta.height ?? null,
    isPdf: false,
    converted,
    compressed: needsResize || usedQuality !== JPEG_QUALITY_STEPS[0] || converted,
  };
}

export interface Region {
  /** Coordenadas relativas 0..1 sobre la imagen ya enderezada. */
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Recorta una zona de la imagen y la prepara para una relectura focalizada:
 * escala de grises, contraste normalizado, ampliación y enfoque. Es lo que
 * permite volver sobre la tabla de artículos o sobre el pie de la factura
 * cuando la primera lectura no cerró.
 */
export async function cropAndEnhance(
  image: Buffer,
  region: Region,
  opts: { upscale?: number; grayscale?: boolean; sharpen?: boolean } = {},
): Promise<Buffer> {
  const meta = await sharp(image).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width === 0 || height === 0) return image;

  const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
  const left = Math.round(clamp(region.left, 0, 0.99) * width);
  const top = Math.round(clamp(region.top, 0, 0.99) * height);
  const cropWidth = Math.max(16, Math.round(clamp(region.width, 0.01, 1) * width));
  const cropHeight = Math.max(16, Math.round(clamp(region.height, 0.01, 1) * height));

  let pipeline = sharp(image).extract({
    left,
    top,
    width: Math.min(cropWidth, width - left),
    height: Math.min(cropHeight, height - top),
  });

  const upscale = opts.upscale ?? 2;
  if (upscale > 1) {
    pipeline = pipeline.resize({
      width: Math.min(4000, Math.round(cropWidth * upscale)),
      withoutEnlargement: false,
      kernel: 'lanczos3',
    });
  }
  if (opts.grayscale !== false) pipeline = pipeline.grayscale();
  // normalize() estira el histograma: mejora mucho las fotos con sombra.
  pipeline = pipeline.normalize();
  if (opts.sharpen !== false) pipeline = pipeline.sharpen({ sigma: 1 });

  return pipeline.jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer();
}

/** Miniatura para la lista de páginas del comprobante. */
export async function makeThumbnail(image: Buffer, size = 320): Promise<Buffer> {
  return sharp(image)
    .rotate()
    .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 72, mozjpeg: true })
    .toBuffer();
}
