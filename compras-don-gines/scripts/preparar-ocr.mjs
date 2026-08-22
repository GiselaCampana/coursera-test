/**
 * Copia a `public/ocr/` los archivos que el lector necesita en el navegador.
 *
 * Todo se sirve desde el propio dominio: nada de CDN. Así la aplicación
 * funciona en un local sin internet estable, no depende de que un tercero siga
 * publicando los archivos, y no filtra a nadie qué comprobantes se leen.
 *
 * Se ejecuta antes de `dev` y de `build`. El directorio `public/ocr/` es
 * derivado de node_modules, así que no se versiona.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destino = path.join(raiz, 'public', 'ocr');
const modulos = path.join(raiz, 'node_modules');

/** Idioma del OCR. `4.0.0` es el modelo rápido; `4.0.0_best_int` es más preciso y más lento. */
const VARIANTE_IDIOMA = process.env.OCR_TESSDATA_VARIANTE ?? '4.0.0';

const copias = [
  {
    de: path.join(modulos, 'tesseract.js', 'dist', 'worker.min.js'),
    a: path.join(destino, 'tesseract', 'worker.min.js'),
  },
  {
    de: path.join(modulos, '@tesseract.js-data', 'spa', VARIANTE_IDIOMA, 'spa.traineddata.gz'),
    a: path.join(destino, 'tessdata', 'spa.traineddata.gz'),
  },
  {
    de: path.join(modulos, 'pdfjs-dist', 'build', 'pdf.worker.min.mjs'),
    a: path.join(destino, 'pdfjs', 'pdf.worker.min.mjs'),
  },
];

/**
 * Del núcleo de Tesseract se copian **todas** las variantes que traiga el
 * paquete, sin lista fija.
 *
 * El worker elige la variante según lo que el navegador soporte —SIMD, SIMD
 * relajado, o ninguna—, y esa elección la hace en tiempo de ejecución. Si falta
 * la variante que eligió, la petición devuelve 404 y **la lectura se cuelga sin
 * mensaje**: el worker se queda esperando un archivo que nunca llega. Copiar el
 * directorio entero evita que una actualización del paquete deje afuera una
 * variante nueva.
 */
const nucleo = path.join(modulos, 'tesseract.js-core');
if (!existsSync(nucleo)) {
  console.error('Falta tesseract.js-core. ¿Corriste `npm install`?');
  process.exit(1);
}

const variantes = readdirSync(nucleo).filter((n) => n.startsWith('tesseract-core'));
for (const archivo of variantes) {
  copias.push({
    de: path.join(nucleo, archivo),
    a: path.join(destino, 'tesseract', archivo),
  });
}

// Control de sanidad: el paquete siempre trae la variante base y la de SIMD.
// Si no están, algo se rompió en la instalación y es mejor fallar acá que
// dejar que la lectura se cuelgue en el teléfono de alguien.
for (const imprescindible of ['tesseract-core.wasm', 'tesseract-core-simd.wasm']) {
  if (!variantes.includes(imprescindible)) {
    console.error(`tesseract.js-core no trae ${imprescindible}. Revisá la instalación.`);
    process.exit(1);
  }
}

const faltantes = copias.filter((c) => !existsSync(c.de));
if (faltantes.length > 0) {
  console.error('Faltan archivos del lector. ¿Corriste `npm install`?\n');
  for (const f of faltantes) console.error(`  ${path.relative(raiz, f.de)}`);
  process.exit(1);
}

rmSync(destino, { recursive: true, force: true });
for (const copia of copias) {
  mkdirSync(path.dirname(copia.a), { recursive: true });
  cpSync(copia.de, copia.a);
}

const pesoTotal = (dir) =>
  readdirSync(dir, { withFileTypes: true }).reduce((total, entrada) => {
    const completo = path.join(dir, entrada.name);
    return total + (entrada.isDirectory() ? pesoTotal(completo) : statSync(completo).size);
  }, 0);

const mb = (pesoTotal(destino) / 1024 / 1024).toFixed(1).replace('.', ',');
console.log(`Lector local listo en public/ocr/ (${copias.length} archivos, ${mb} MB).`);
console.log(`Idioma: español, variante ${VARIANTE_IDIOMA}.`);
