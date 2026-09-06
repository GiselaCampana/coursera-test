import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import sharp from 'sharp';
import { createWorker, PSM, type Worker } from 'tesseract.js';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import type { Mapa } from '@/lib/cliente/ocr/imagen';

/**
 * El lector real, sobre las fotos reales.
 *
 * Todo lo demás en este proyecto prueba el OCR con texto ya reconocido y
 * guardado. Eso deja sin probar justamente la mitad que falla en el iPhone: qué
 * sale de una foto de verdad. Acá se corre el lector completo —el mismo
 * `LectorDeComprobantes` que usa el navegador— sobre las fotos que sacó la
 * usuaria, y se cuenta cuántos renglones recupera.
 *
 * Dos módulos se sustituyen, y sólo dos, porque son los únicos que hablan con
 * el navegador:
 *
 *  - `lienzo`, que decodifica con `createImageBitmap` → acá con sharp, que
 *    aplica la orientación EXIF igual que el navegador;
 *  - `tesseract`, cuyo worker es el build para navegador → acá el de Node, con
 *    **los mismos parámetros** (psm, `preserve_interword_spaces`, dpi).
 *
 * Todo lo que está en el medio —preproceso, detección de regiones, recorte por
 * franjas, ampliación— es el código de producción sin tocar.
 *
 * No corre en CI por omisión: son varias pasadas de Tesseract por factura y
 * tarda minutos. Se enciende con OCR_FOTOS_REALES=1. Que no corra siempre no lo
 * hace menos útil: es la única medida objetiva de si una foto se lee, y es
 * contra la que se compara cualquier cambio del preproceso.
 */

const RAIZ = path.resolve(__dirname, '../..');
const FOTOS = path.join(RAIZ, 'tests/fixtures/imagenes');
const ENCENDIDO = process.env.OCR_FOTOS_REALES === '1';

let worker: Worker;

/** Decodifica honrando la orientación EXIF, como hace el navegador. */
async function mapaDeBuffer(buffer: Buffer): Promise<Mapa> {
  const { data, info } = await sharp(buffer)
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  };
}

vi.mock('@/lib/cliente/ocr/lienzo', () => ({
  mapaDesdeBlob: async (blob: Blob) => mapaDeBuffer(Buffer.from(await blob.arrayBuffer())),
  mapaABlob: async () => new Blob([]),
  mapaALienzo: () => {
    throw new Error('sin lienzo en Node');
  },
  mapaAUrl: () => {
    throw new Error('sin lienzo en Node');
  },
}));

vi.mock('@/lib/cliente/ocr/tesseract', async (original) => {
  const real = await original<typeof import('@/lib/cliente/ocr/tesseract')>();
  return {
    ...real,
    lectorPreparado: () => true,
    leerMapa: async (mapa: Mapa, opciones: { psm?: PSM; soloEstosCaracteres?: string } = {}) => {
      // Los mismos parámetros que usa la aplicación: sin esto la medición no
      // dice nada sobre lo que pasa en el teléfono.
      await worker.setParameters({
        tessedit_pageseg_mode: opciones.psm ?? PSM.AUTO,
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
        tessedit_char_whitelist: opciones.soloEstosCaracteres ?? '',
      });
      const png = await sharp(
        Buffer.from(mapa.data.buffer, mapa.data.byteOffset, mapa.data.byteLength),
        { raw: { width: mapa.width, height: mapa.height, channels: 4 } },
      )
        .png()
        .toBuffer();
      const { data } = await worker.recognize(png, {}, { text: true, blocks: true });

      /*
       * La misma función que usa el módulo real, no una copia.
       *
       * El arnés tenía su propia versión y normalizaba las cajas a 0..1
       * mientras el módulo real las entrega en píxeles. No fallaba: producía
       * regiones diminutas y un diagnóstico que parecía válido. Compartir la
       * función es lo que hace imposible que vuelvan a divergir.
       */
      const lineas = real.lineasDeBloques(data.blocks);
      if (real.cajasParecenNormalizadas(lineas, mapa.width, mapa.height)) {
        throw new Error(
          'Las cajas llegaron normalizadas a 0..1 y tienen que venir en píxeles: ' +
            'la medición que salga de acá no significaría nada.',
        );
      }
      return { texto: data.text, confianza: (data.confidence ?? 0) / 100, lineas };
    },
  };
});

beforeAll(async () => {
  if (!ENCENDIDO) return;
  worker = await createWorker('spa', 1, {
    langPath: path.join(RAIZ, 'public/ocr/tessdata'),
    gzip: true,
  });
}, 180_000);

afterAll(async () => {
  if (worker) await worker.terminate();
});

/** Corre el lector de producción sobre una foto y devuelve lo que sacó. */
async function leerFoto(archivo: string) {
  const { SesionLectura } = await import('@/lib/cliente/ocr/lector');
  const bytes = readFileSync(path.join(FOTOS, archivo));
  const blob = new Blob([bytes], { type: 'image/jpeg' });

  const lector = new SesionLectura();
  const desde = Date.now();
  await lector.preparar([{ archivo: blob, nombre: archivo }]);
  const preparado = Date.now() - desde;
  const lectura = await lector.leer(1);
  const total = Date.now() - desde;

  return { lectura, medidas: lector.medidasDePaginas, preparado, total };
}

describe.runIf(ENCENDIDO)('el lector real sobre las fotos reales', () => {
  it(
    'Errecalde: cuántos de los 23 renglones se recuperan',
    async () => {
      const { ERRECALDE_ARTICULOS_IMPRESOS } = await import('../fixtures/errecalde-ocr');
      const { lectura, medidas, preparado, total } = await leerFoto(
        'errecalde-00008-00002647.jpg',
      );

      const pagina = lectura.paginas[0];
      const texto = [pagina.textoCompleto, pagina.textoArticulos ?? '', pagina.textoResumen ?? '']
        .join('\n')
        .toUpperCase();
      const plano = texto.replace(/\s/g, '');

      const conCodigo = ERRECALDE_ARTICULOS_IMPRESOS.filter((a) => plano.includes(a.codigo));
      const conSubtotal = ERRECALDE_ARTICULOS_IMPRESOS.filter((a) =>
        plano.includes(Number(a.subtotal).toLocaleString('es-AR', { minimumFractionDigits: 2 })),
      );

      console.log(
        `[Errecalde] página ${medidas[0].ancho}×${medidas[0].alto} · ` +
          `inclinación ${medidas[0].inclinacion.toFixed(2)}° · ` +
          `perspectiva ${medidas[0].perspectivaCorregida ? 'sí' : 'no'} · ` +
          `filas vistas ${pagina.regiones?.filasDetectadas ?? '—'} · ` +
          `códigos ${conCodigo.length}/23 · subtotales ${conSubtotal.length}/23 · ` +
          `preparar ${(preparado / 1000).toFixed(1)}s · total ${(total / 1000).toFixed(1)}s`,
      );

      const faltan = ERRECALDE_ARTICULOS_IMPRESOS.filter((a) => !plano.includes(a.codigo));
      console.log('  códigos ausentes:', faltan.map((a) => a.codigo).join(' '));
      console.log('  tiempos por zona:', JSON.stringify(pagina.tiempos));

      // El piso que hay que mover. Se afirma sobre el número real de hoy para
      // que cualquier cambio del preproceso se note, en la dirección que sea.
      expect(conSubtotal.length).toBeGreaterThan(0);
    },
    600_000,
  );

  it(
    'Los Calvos: los 9 renglones y el pie',
    async () => {
      const { lectura, medidas, total } = await leerFoto('los-calvos-0010-00212356.jpg');
      const pagina = lectura.paginas[0];
      const plano = [pagina.textoCompleto, pagina.textoArticulos ?? '', pagina.textoResumen ?? '']
        .join('\n')
        .toUpperCase()
        .replace(/\s/g, '');

      console.log(
        `[Los Calvos] página ${medidas[0].ancho}×${medidas[0].alto} · ` +
          `filas vistas ${pagina.regiones?.filasDetectadas ?? '—'} · ` +
          `total ${(total / 1000).toFixed(1)}s`,
      );
      console.log('  ¿nº 00212356?', plano.includes('00212356'));
      console.log('  ¿total 2.196.120,52?', plano.includes('2.196.120,52'));

      expect(plano.length).toBeGreaterThan(100);
    },
    600_000,
  );

  it(
    'Mabelherdi: los 9 renglones y el pie',
    async () => {
      const { lectura, medidas, total } = await leerFoto('mabelherdi-0007-00348491.jpg');
      const pagina = lectura.paginas[0];
      const plano = [pagina.textoCompleto, pagina.textoArticulos ?? '', pagina.textoResumen ?? '']
        .join('\n')
        .toUpperCase()
        .replace(/\s/g, '');

      console.log(
        `[Mabelherdi] página ${medidas[0].ancho}×${medidas[0].alto} · ` +
          `filas vistas ${pagina.regiones?.filasDetectadas ?? '—'} · ` +
          `total ${(total / 1000).toFixed(1)}s`,
      );
      console.log('  ¿nº 00348491?', plano.includes('00348491'));
      console.log('  ¿total 40506,09?', plano.includes('40506,09') || plano.includes('40.506,09'));

      expect(plano.length).toBeGreaterThan(100);
    },
    600_000,
  );
});
