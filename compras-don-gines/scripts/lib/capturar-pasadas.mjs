/**
 * La captura de evidencia con coordenadas, como función reutilizable.
 *
 * Es el mismo procedimiento que produjo los fixtures del banco —las mismas
 * cuatro zonas, las mismas dos preparaciones, los mismos lados de ampliación—
 * extraído para que una **foto nueva** se lea exactamente igual que las que ya
 * se usaron para diseñar el motor. Si la validación con facturas nuevas usara
 * una captura distinta, cualquier diferencia de resultado sería inatribuible.
 *
 * No decide nada sobre el comprobante: devuelve palabras con cajas.
 */
import { createWorker, PSM } from 'tesseract.js';
import sharp from 'sharp';
import path from 'node:path';

const RAIZ = process.cwd();

/** Lado mayor con el que se lee la página entera, igual que en producción. */
const LADO_PAGINA = 2200;
/** Lado mayor de un recorte ampliado. */
const LADO_RECORTE = 2600;


/**
 * Las zonas que se leen, como fracción de la página.
 *
 * Se usan bandas fijas y no la detección de regiones a propósito: lo que se
 * captura acá es **evidencia cruda**, y hacerla depender de un detector que
 * también está en discusión mezclaría las dos cosas. Las bandas se solapan para
 * que ningún renglón quede partido justo en el corte.
 */
const ZONAS = [
  { zona: 'completo', region: { x0: 0, y0: 0, x1: 1, y1: 1 } },
  { zona: 'encabezado', region: { x0: 0, y0: 0, x1: 1, y1: 0.34 } },
  { zona: 'articulos', region: { x0: 0, y0: 0.26, x1: 1, y1: 0.82 } },
  { zona: 'resumen', region: { x0: 0, y0: 0.74, x1: 1, y1: 1 } },
];

/** Las dos preparaciones: tal cual, y con realce fuerte. */
const VARIANTES = [
  { variante: 'directo', receta: (img) => img },
  {
    variante: 'limpieza-fuerte',
    receta: (img) => img.greyscale().median(3).normalize().sharpen({ sigma: 1.2 }),
  },
];

function redondear(valor) {
  // Cinco decimales sobre 0..1 son menos de un píxel en una foto de 4032:
  // suficiente para no perder nada y bastante para que el fixture no sea ilegible.
  return Math.round(valor * 1e5) / 1e5;
}

function aCoordenadasDePagina(caja, recorte, region) {
  const anchoRegion = region.x1 - region.x0;
  const altoRegion = region.y1 - region.y0;
  return {
    x0: redondear(region.x0 + (caja.x0 / recorte.anchoPx) * anchoRegion),
    y0: redondear(region.y0 + (caja.y0 / recorte.altoPx) * altoRegion),
    x1: redondear(region.x0 + (caja.x1 / recorte.anchoPx) * anchoRegion),
    y1: redondear(region.y0 + (caja.y1 / recorte.altoPx) * altoRegion),
  };
}

/** Las palabras de un resultado de Tesseract, con sus alternativas. */
function palabrasDe(bloques) {
  const salida = [];
  for (const bloque of bloques ?? []) {
    for (const parrafo of bloque.paragraphs ?? []) {
      for (const linea of parrafo.lines ?? []) {
        for (const palabra of linea.words ?? []) {
          const texto = (palabra.text ?? '').trim();
          if (texto === '') continue;
          const alternativas = (palabra.choices ?? [])
            .map((c) => (c.text ?? '').trim())
            .filter((t) => t !== '' && t !== texto);
          salida.push({
            texto,
            bbox: palabra.bbox,
            confianza: (palabra.confidence ?? 0) / 100,
            alternativas: [...new Set(alternativas)],
          });
        }
      }
    }
  }
  return salida;
}


/**
 * Lee una imagen con todas las pasadas y devuelve la evidencia normalizada.
 *
 * El worker se recibe de afuera: arrancarlo cuesta segundos y una validación
 * lee varias facturas seguidas.
 */
export async function capturarEvidencia(worker, rutaDeImagen, avisar = true) {
  const comienzoFactura = Date.now();
  /*
   * Se decodifica **una sola vez**, ya rotada según el EXIF, y de ahí salen
   * las medidas.
   *
   * `metadata()` informa el tamaño del archivo tal como está guardado, sin
   * aplicar la orientación: en una foto vertical de iPhone eso viene con el
   * ancho y el alto intercambiados. Recortar con esas medidas sobre la imagen
   * ya rotada pide un rectángulo que se sale de la página. Acá falló ruidoso,
   * pero con una banda apenas más chica habría recortado la parte equivocada
   * de la factura sin decir nada.
   */
  const { data: pixeles, info } = await sharp(rutaDeImagen)
    .rotate()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const anchoPx = info.width;
  const altoPx = info.height;
  const crudo = { raw: { width: anchoPx, height: altoPx, channels: info.channels } };

  const pasadas = [];
  const fragmentos = [];

  for (const { zona, region } of ZONAS) {
    for (const { variante, receta } of VARIANTES) {
      // La página entera con limpieza fuerte no aporta: la limpieza sirve
      // sobre un recorte ampliado, donde los trazos ya son grandes.
      if (zona === 'completo' && variante === 'limpieza-fuerte') continue;

      const id = `${zona}:${variante}`;
      /*
       * El rectángulo se recorta contra los bordes de la imagen y la región
       * se vuelve a calcular **desde los píxeles que salieron**, no desde los
       * que se pidieron. Redondear hacia afuera hace que la última banda se
       * pase del alto y sharp lo rechaza; y si se corrigiera el recorte sin
       * corregir la región, todas las cajas de esa pasada quedarían corridas
       * sin que nada falle.
       */
      const izquierda = Math.max(0, Math.min(anchoPx - 1, Math.round(region.x0 * anchoPx)));
      const arriba = Math.max(0, Math.min(altoPx - 1, Math.round(region.y0 * altoPx)));
      const anchoRecorte = Math.max(1, Math.min(anchoPx - izquierda, Math.round((region.x1 - region.x0) * anchoPx)));
      const altoRecorte = Math.max(1, Math.min(altoPx - arriba, Math.round((region.y1 - region.y0) * altoPx)));
      const regionReal = {
        x0: izquierda / anchoPx,
        y0: arriba / altoPx,
        x1: (izquierda + anchoRecorte) / anchoPx,
        y1: (arriba + altoRecorte) / altoPx,
      };

      const lado = zona === 'completo' ? LADO_PAGINA : LADO_RECORTE;
      const escala = Math.min(2.5, lado / Math.max(anchoRecorte, altoRecorte));

      let img = sharp(pixeles, crudo);
      if (zona !== 'completo') {
        img = img.extract({
          left: izquierda,
          top: arriba,
          width: anchoRecorte,
          height: altoRecorte,
        });
      }
      if (escala !== 1) {
        img = img.resize({
          width: Math.round(anchoRecorte * escala),
          height: Math.round(altoRecorte * escala),
          fit: 'fill',
        });
      }
      img = receta(img);

      const png = await img.png().toBuffer();
      const metaRecorte = await sharp(png).metadata();

      const psm = zona === 'completo' ? PSM.AUTO : PSM.SINGLE_BLOCK;
      await worker.setParameters({
        tessedit_pageseg_mode: psm,
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
        tessedit_char_whitelist: '',
      });

      const comienzo = Date.now();
      const { data } = await worker.recognize(png, {}, { text: true, blocks: true });
      const ms = Date.now() - comienzo;

      const recorte = { anchoPx: metaRecorte.width, altoPx: metaRecorte.height };
      for (const palabra of palabrasDe(data.blocks)) {
        fragmentos.push({
          texto: palabra.texto,
          caja: aCoordenadasDePagina(palabra.bbox, recorte, regionReal),
          pasada: id,
          confianza: Math.round(palabra.confianza * 1000) / 1000,
          ...(palabra.alternativas.length ? { alternativas: palabra.alternativas } : {}),
        });
      }

      pasadas.push({
        id,
        zona,
        variante,
        psm: String(psm),
        region: {
          x0: redondear(regionReal.x0),
          y0: redondear(regionReal.y0),
          x1: redondear(regionReal.x1),
          y1: redondear(regionReal.y1),
        },
        confianza: Math.round((data.confidence ?? 0) / 100 * 1000) / 1000,
        ms,
      });

      process.stderr.write(
        `${path.basename(rutaDeImagen)} ${id}: ${fragmentos.length} fragmentos acumulados (${ms} ms)\n`,
      );
    }
  }


  return {
    evidencia: { anchoPx, altoPx, pasadas, fragmentos },
    ms: Date.now() - comienzoFactura,
  };
}

export async function abrirWorker() {
  return createWorker('spa', 1, {
    langPath: path.join(RAIZ, 'public/ocr/tessdata'),
    gzip: true,
  });
}

export { ZONAS, VARIANTES, LADO_PAGINA, LADO_RECORTE };
