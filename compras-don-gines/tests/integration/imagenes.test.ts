import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import { AppError } from '@/lib/errors';
import {
  WORK_MAX_DIMENSION,
  WORK_MIN_DIMENSION,
  WORK_TARGET_BYTES,
  cropAndEnhance,
  detectMimeType,
  normalizeUpload,
  sha256,
} from '@/lib/images';

/** Foto grande y "ruidosa", parecida en peso a la de un iPhone. */
async function fotoGrande(ancho = 4032, alto = 3024): Promise<Buffer> {
  const ruido = Buffer.alloc(ancho * alto * 3);
  for (let i = 0; i < ruido.length; i++) ruido[i] = (i * 2654435761) % 256;
  return sharp(ruido, { raw: { width: ancho, height: alto, channels: 3 } })
    .jpeg({ quality: 96 })
    .toBuffer();
}

describe('detección del tipo de archivo', () => {
  it('reconoce JPEG, PNG, WEBP y PDF por sus primeros bytes', async () => {
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
      .jpeg()
      .toBuffer();
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
      .png()
      .toBuffer();
    const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
      .webp()
      .toBuffer();
    const pdf = Buffer.from('%PDF-1.7\n...');

    expect(detectMimeType(jpeg)).toBe('image/jpeg');
    expect(detectMimeType(png)).toBe('image/png');
    expect(detectMimeType(webp)).toBe('image/webp');
    expect(detectMimeType(pdf)).toBe('application/pdf');
  });

  it('reconoce un HEIC de iPhone por su marca ftyp', () => {
    // Caja ftyp con marca "heic": es lo que manda el iPhone.
    const heic = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftyp'),
      Buffer.from('heic'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('mif1heic'),
    ]);
    expect(detectMimeType(heic)).toBe('image/heic');
    expect(detectMimeType(heic, 'application/octet-stream', 'IMG_4821.HEIC')).toBe('image/heic');
  });

  it('usa el nombre del archivo cuando Safari no manda el tipo', () => {
    const desconocido = Buffer.from('contenido cualquiera que no tiene firma');
    expect(detectMimeType(desconocido, '', 'factura.heic')).toBe('image/heic');
    expect(detectMimeType(desconocido, '', 'factura.pdf')).toBe('application/pdf');
  });
});

describe('preparación de las fotos', () => {
  let grande: Buffer;

  beforeAll(async () => {
    grande = await fotoGrande();
  });

  it('la foto de prueba pesa más de 4 MB, como una del iPhone', () => {
    expect(grande.length).toBeGreaterThan(4 * 1024 * 1024);
  });

  it('comprime sola una foto de más de 4 MB en vez de rechazarla', async () => {
    const resultado = await normalizeUpload(grande, 'image/jpeg', 'IMG_0001.JPG');
    expect(resultado.compressed).toBe(true);
    expect(resultado.work.length).toBeLessThan(grande.length);
    expect(resultado.work.length).toBeLessThanOrEqual(WORK_TARGET_BYTES);
    expect(resultado.overTarget).toBe(false);
    // Del original se recuerda el dato, no el archivo: en un plan de 1 GB
    // guardar dos copias de cada foto es gastar el espacio al doble.
    expect(resultado.originalSizeBytes).toBe(grande.length);
    expect(resultado.originalMime).toBe('image/jpeg');
    expect(resultado).not.toHaveProperty('original');
  });

  it('deja los 500 kB por comprobante que hacen que el plan gratuito alcance', async () => {
    const resultado = await normalizeUpload(grande, 'image/jpeg');
    expect(resultado.work.length).toBeLessThanOrEqual(500_000);
  });

  it('conserva resolución suficiente para leer los números chicos', async () => {
    const resultado = await normalizeUpload(grande, 'image/jpeg');
    const mayor = Math.max(resultado.width ?? 0, resultado.height ?? 0);
    // Se admite bajar hasta el mínimo, pero nunca por debajo: sin esos píxeles
    // el respaldo no sirve para cotejar un importe contra el papel.
    expect(mayor).toBeGreaterThanOrEqual(WORK_MIN_DIMENSION);
    expect(mayor).toBeLessThanOrEqual(WORK_MAX_DIMENSION);
  });

  it('endereza la foto según la orientación EXIF', async () => {
    // Orientación 6: el iPhone guarda la foto acostada y marca que va rotada.
    const acostada = await sharp({
      create: { width: 400, height: 200, channels: 3, background: '#ddd' },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const resultado = await normalizeUpload(acostada, 'image/jpeg');
    // Ya enderezada, la imagen queda vertical.
    expect(resultado.width).toBe(200);
    expect(resultado.height).toBe(400);
  });

  it('deja el PDF tal cual, sin tocarlo', async () => {
    const pdf = Buffer.from('%PDF-1.7\nfactura de prueba\n%%EOF');
    const resultado = await normalizeUpload(pdf, 'application/pdf', 'factura.pdf');
    expect(resultado.isPdf).toBe(true);
    expect(resultado.workMime).toBe('application/pdf');
    expect(resultado.work).toEqual(pdf);
  });

  it('rechaza en castellano un formato que no sirve', async () => {
    const zip = Buffer.from('PKalgo comprimido');
    await expect(normalizeUpload(zip, 'application/zip', 'facturas.zip')).rejects.toThrowError(
      /Aceptamos fotos JPG, PNG, WEBP o HEIC/,
    );
  });

  it('avisa en castellano si no puede convertir un HEIC', async () => {
    // Tiene la marca de HEIC pero el contenido está roto: es el caso real de
    // una foto que se cortó al subirse.
    const heicRoto = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftyp'),
      Buffer.from('heic'),
      Buffer.alloc(64),
    ]);
    const error = await normalizeUpload(heicRoto, 'image/heic', 'IMG_9.HEIC').catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error.message).toMatch(/HEIC/);
    expect(error.message).toMatch(/Probá sacarla de nuevo/);
    // Nada de mensajes técnicos en inglés.
    expect(error.message).not.toMatch(/error|failed|undefined/i);
  });

  it('la misma foto da siempre la misma huella, y una distinta no', async () => {
    const a = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#123456' } })
      .jpeg()
      .toBuffer();
    const b = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#654321' } })
      .jpeg()
      .toBuffer();
    expect(sha256(a)).toBe(sha256(Buffer.from(a)));
    expect(sha256(a)).not.toBe(sha256(b));
  });
});

describe('recorte para la relectura focalizada', () => {
  it('recorta la zona pedida y la amplía', async () => {
    const original = await sharp({
      create: { width: 1000, height: 800, channels: 3, background: '#eeeeee' },
    })
      .jpeg()
      .toBuffer();

    const recorte = await cropAndEnhance(
      original,
      { left: 0, top: 0.25, width: 1, height: 0.5 },
      { upscale: 2 },
    );
    const meta = await sharp(recorte).metadata();
    // 1000 × 1 de ancho, ampliado ×2.
    expect(meta.width).toBe(2000);
    expect(meta.height).toBe(800);
  });

  it('no se pasa de los bordes aunque le pidan una zona imposible', async () => {
    const original = await sharp({
      create: { width: 300, height: 300, channels: 3, background: '#ffffff' },
    })
      .jpeg()
      .toBuffer();

    const recorte = await cropAndEnhance(
      original,
      { left: 0.9, top: 0.9, width: 5, height: 5 },
      { upscale: 1 },
    );
    const meta = await sharp(recorte).metadata();
    expect(meta.width).toBeLessThanOrEqual(300);
    expect(meta.height).toBeLessThanOrEqual(300);
  });
});
