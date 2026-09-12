/**
 * Captura la relectura focalizada de las celdas que quedaron bloqueadas.
 *
 * Corre la primera reconstrucción sobre la evidencia ya capturada, le pregunta
 * al motor **qué celdas frenan el comprobante y dónde deberían estar**, y vuelve
 * a leer sólo esas bandas desde la foto original: ampliadas, con dos
 * preparaciones y —para las celdas numéricas— con el alfabeto restringido a
 * dígitos y separadores.
 *
 * La salida se guarda aparte, como `<nombre>-relectura.json`, y se commitea
 * como fixture igual que la primera captura. No reemplaza nada: son fragmentos
 * nuevos con su propia procedencia, que entran al mismo motor de candidatas y
 * compiten con la lectura original.
 *
 *   node scripts/capturar-relectura.mjs [nombre-de-la-foto ...]
 */
import { createWorker, PSM } from 'tesseract.js';
import sharp from 'sharp';
import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const RAIZ = process.cwd();
const FOTOS = path.join(RAIZ, 'tests/fixtures/imagenes');
const SALIDA = path.join(RAIZ, 'tests/fixtures/evidencia');

/** Lado mayor de una banda releída: bien grande, que es todo el punto. */
const LADO_BANDA = 2400;

const COMPROBANTES = [
  { archivo: 'errecalde-00008-00002647.jpg', nombre: 'errecalde' },
  { archivo: 'mabelherdi-0007-00348491.jpg', nombre: 'mabelherdi' },
  { archivo: 'ezra-00002-00000185.jpg', nombre: 'ezra' },
  { archivo: 'barraza-0041-00196670.png', nombre: 'barraza' },
  { archivo: 'los-calvos-0010-00212356.jpg', nombre: 'los-calvos-212356' },
  { archivo: 'los-calvos-0010-00213103.jpg', nombre: 'los-calvos-213103' },
];

const LIMPIEZA = {
  directo: (img) => img,
  'limpieza-fuerte': (img) => img.greyscale().median(3).normalize().sharpen({ sigma: 1.2 }),
};

function redondear(valor) {
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

async function main() {
  // El plan de relectura lo decide el motor, compilado por vitest: se lee de un
  // archivo que genera `npm run plan-de-relectura`, para no duplicar la lógica.
  const plan = JSON.parse(readFileSync(path.join(SALIDA, 'plan-de-relectura.json'), 'utf8'));

  const pedidos = process.argv.slice(2);
  const aReleer = Object.keys(plan).filter((n) => pedidos.length === 0 || pedidos.includes(n));

  mkdirSync(SALIDA, { recursive: true });

  const worker = await createWorker('spa', 1, {
    langPath: path.join(RAIZ, 'public/ocr/tessdata'),
    gzip: true,
  });

  for (const nombre of aReleer) {
    const comprobante = COMPROBANTES.find((c) => c.nombre === nombre);
    if (!comprobante) continue;
    const zonas = plan[nombre];
    if (!zonas || zonas.length === 0) {
      console.log(`${nombre}: nada que releer`);
      continue;
    }

    const comienzoFactura = Date.now();
    const { data: pixeles, info } = await sharp(path.join(FOTOS, comprobante.archivo))
      .rotate()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const anchoPx = info.width;
    const altoPx = info.height;
    const crudo = { raw: { width: anchoPx, height: altoPx, channels: info.channels } };

    const pasadas = [];
    const fragmentos = [];

    for (const zona of zonas) {
      for (const variante of zona.variantes) {
        const izquierda = Math.max(0, Math.min(anchoPx - 1, Math.round(zona.caja.x0 * anchoPx)));
        const arriba = Math.max(0, Math.min(altoPx - 1, Math.round(zona.caja.y0 * altoPx)));
        const ancho = Math.max(
          1,
          Math.min(anchoPx - izquierda, Math.round((zona.caja.x1 - zona.caja.x0) * anchoPx)),
        );
        const alto = Math.max(
          1,
          Math.min(altoPx - arriba, Math.round((zona.caja.y1 - zona.caja.y0) * altoPx)),
        );
        const regionReal = {
          x0: izquierda / anchoPx,
          y0: arriba / altoPx,
          x1: (izquierda + ancho) / anchoPx,
          y1: (arriba + alto) / altoPx,
        };

        // Se amplía sin deformar: la misma escala en los dos ejes.
        const escala = Math.min(6, LADO_BANDA / Math.max(ancho, alto));
        let img = sharp(pixeles, crudo).extract({ left: izquierda, top: arriba, width: ancho, height: alto });
        if (escala !== 1) {
          img = img.resize({
            width: Math.round(ancho * escala),
            height: Math.round(alto * escala),
            fit: 'fill',
          });
        }
        img = LIMPIEZA[variante.preparacion](img);

        const png = await img.png().toBuffer();
        const meta = await sharp(png).metadata();

        await worker.setParameters({
          tessedit_pageseg_mode: variante.segmentacion === 'linea' ? PSM.SINGLE_LINE : PSM.SINGLE_BLOCK,
          preserve_interword_spaces: '1',
          user_defined_dpi: '300',
          tessedit_char_whitelist: variante.alfabeto ?? '',
        });

        const id = `${zona.id}:${variante.nombre}`;
        const comienzo = Date.now();
        const { data } = await worker.recognize(png, {}, { text: true, blocks: true });
        const ms = Date.now() - comienzo;

        const recorte = { anchoPx: meta.width, altoPx: meta.height };
        let cuantas = 0;
        for (const palabra of palabrasDe(data.blocks)) {
          fragmentos.push({
            texto: palabra.texto,
            caja: aCoordenadasDePagina(palabra.bbox, recorte, regionReal),
            pasada: id,
            confianza: Math.round(palabra.confianza * 1000) / 1000,
            ...(palabra.alternativas.length ? { alternativas: palabra.alternativas } : {}),
          });
          cuantas += 1;
        }

        pasadas.push({
          id,
          zona: zona.id,
          variante: variante.nombre,
          psm: variante.segmentacion,
          alfabeto: variante.alfabeto,
          region: regionReal,
          celdasQueCubre: zona.celdas,
          columna: zona.columna,
          fragmentos: cuantas,
          ms,
        });
        console.log(`  ${id}: ${cuantas} fragmentos en ${ms} ms`);
      }
    }

    const salida = {
      anchoPx,
      altoPx,
      pasadas,
      fragmentos,
      msTotal: Date.now() - comienzoFactura,
    };
    const destino = path.join(SALIDA, `${nombre}-relectura.json`);
    writeFileSync(destino, `${JSON.stringify(salida, null, 1)}\n`);
    console.log(
      `${nombre}: ${fragmentos.length} fragmentos de ${pasadas.length} pasadas en ${salida.msTotal} ms → ${path.relative(RAIZ, destino)}`,
    );
  }

  await worker.terminate();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
