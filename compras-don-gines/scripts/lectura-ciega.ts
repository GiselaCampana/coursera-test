/**
 * La primera ejecución **ciega** sobre una factura que el motor nunca vio.
 *
 * Lee la foto, corre el motor y guarda el acta completa de lo que dijo, con el
 * hash del motor y de la imagen. Se corre **antes** de transcribir el papel:
 * ése es todo el punto. Si se mira el comprobante primero, cualquier ajuste
 * posterior queda contaminado por haber visto la respuesta, y un motor
 * sobreajustado no se distingue de uno bueno.
 *
 * No toca el corpus de diseño: las fotos nuevas van en `validacion/imagenes/` y
 * las actas en `validacion/ciega/`. Y no agrega ninguna regla: si una factura
 * falla, la causa se clasifica y se espera a tener el conjunto completo, porque
 * arreglar la primera sesga las siguientes.
 *
 *   npx tsx scripts/lectura-ciega.ts validacion/imagenes/*.jpg
 *   npx tsx scripts/lectura-ciega.ts --relectura validacion/imagenes/una.jpg
 *   npx tsx scripts/lectura-ciega.ts --sin-ocr        (reusa la evidencia guardada)
 *
 * `--sin-ocr` vuelve a correr **sólo el motor** sobre la evidencia que ya se
 * capturó. No sirve para una primera lectura ciega —para eso hay que leer la
 * foto— pero sí para medir un cambio del motor contra el mismo OCR, que es la
 * única manera de saber si una diferencia es del motor o de la lectura.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { abrirWorker, capturarEvidencia } from './lib/capturar-pasadas.mjs';
import {
  primeraLectura,
  type HuellaDelMotor,
} from '@/lib/ocr/validacion/lectura-ciega';
import { interpretarReconstruccion } from '@/lib/ocr/motor/desde-reconstruccion';
import { planDeRelectura } from '@/lib/ocr/reconstruccion/relectura';
import { renglonesQueNoCierran } from '@/lib/ocr/motor/desde-reconstruccion';

const RAIZ = process.cwd();
const CUIT_DEL_RECEPTOR = '27-33342291-9';

const IMAGENES = path.join(RAIZ, 'validacion/imagenes');
const EVIDENCIA = path.join(RAIZ, 'validacion/evidencia');
const ACTAS = path.join(RAIZ, 'validacion/ciega');
const PLANES = path.join(RAIZ, 'validacion/planes');

function sha256(datos: Buffer): string {
  return createHash('sha256').update(datos).digest('hex');
}

/**
 * La huella del motor: de qué commit salió y si el árbol estaba limpio.
 *
 * El `sha256` se calcula sobre los fuentes de `src/lib/ocr`, en orden de ruta.
 * Es lo que hace el acta reproducible: con el commit solo, una lectura hecha
 * sobre cambios sin guardar quedaría atribuida a una versión que no la produjo.
 */
function huellaDelMotor(): HuellaDelMotor {
  const base = path.join(RAIZ, 'src/lib/ocr');
  const archivos: string[] = [];
  const recorrer = (dir: string) => {
    for (const entrada of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const completo = path.join(dir, entrada.name);
      if (entrada.isDirectory()) recorrer(completo);
      else if (entrada.name.endsWith('.ts')) archivos.push(completo);
    }
  };
  recorrer(base);

  const hash = createHash('sha256');
  for (const archivo of archivos) {
    hash.update(path.relative(RAIZ, archivo));
    hash.update(readFileSync(archivo));
  }

  let commit = 'desconocido';
  let arbolSucio = true;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: RAIZ }).toString().trim();
    const sucio = execFileSync('git', ['status', '--porcelain', '--', 'src', 'scripts'], {
      cwd: RAIZ,
    })
      .toString()
      .trim();
    arbolSucio = sucio !== '';
  } catch {
    /* sin git: queda «desconocido» y árbol sucio, que es lo conservador */
  }

  return { commit, sha256: hash.digest('hex'), archivos: archivos.length, arbolSucio };
}

async function main() {
  const argumentos = process.argv.slice(2);
  const conRelectura = argumentos.includes('--relectura');
  const sinOcr = argumentos.includes('--sin-ocr');
  const rutas = argumentos.filter((a) => !a.startsWith('--'));

  const fotos = rutas.length
    ? rutas
    : readdirSync(IMAGENES)
        .filter((n) => /\.(jpe?g|png|heic|webp)$/i.test(n))
        .map((n) => path.join(IMAGENES, n));

  if (fotos.length === 0) {
    process.stderr.write(
      `No hay fotos para leer. Poné las nuevas en ${path.relative(RAIZ, IMAGENES)}/ ` +
        'y volvé a correr.\n',
    );
    return;
  }

  for (const dir of [EVIDENCIA, ACTAS, PLANES]) mkdirSync(dir, { recursive: true });

  const motor = huellaDelMotor();
  if (motor.arbolSucio) {
    process.stderr.write(
      '\n*** El árbol tiene cambios sin commitear. El acta lo va a decir, pero una\n' +
        '*** primera lectura ciega sobre un árbol sucio no es reproducible: conviene\n' +
        '*** congelar el motor en un commit antes de medir.\n\n',
    );
  }

  const worker = sinOcr ? null : await abrirWorker();

  for (const foto of fotos) {
    const nombre = path.basename(foto).replace(/\.[^.]+$/, '');
    const bytes = readFileSync(foto);
    process.stderr.write(`\n=== ${nombre}\n`);

    let evidencia;
    let ocrMs = 0;
    if (worker) {
      ({ evidencia, ms: ocrMs } = await capturarEvidencia(worker, foto));
      writeFileSync(path.join(EVIDENCIA, `${nombre}.json`), JSON.stringify(evidencia));
    } else {
      evidencia = JSON.parse(readFileSync(path.join(EVIDENCIA, `${nombre}.json`), 'utf8'));
    }

    /*
     * El plan de relectura se calcula y se guarda **siempre**, incluso cuando no
     * se ejecuta: es parte de lo que el motor dijo. Ejecutarla es otra pasada de
     * OCR y se pide aparte, para que el tiempo de la primera lectura quede
     * medido sin ella.
     */
    const primera = interpretarReconstruccion(evidencia, { cuitDelReceptor: CUIT_DEL_RECEPTOR });
    const plan = planDeRelectura(
      primera.tabla,
      primera.pendientes,
      renglonesQueNoCierran(primera),
    );
    writeFileSync(path.join(PLANES, `${nombre}.json`), `${JSON.stringify(plan, null, 1)}\n`);

    const acta = primeraLectura({
      motor,
      imagen: { nombre: path.basename(foto), sha256: sha256(bytes), bytes: statSync(foto).size },
      evidencia,
      ocrMs,
      cuitDelReceptor: CUIT_DEL_RECEPTOR,
    });

    const destino = path.join(ACTAS, `${nombre}.json`);
    writeFileSync(destino, `${JSON.stringify(acta, null, 1)}\n`);

    process.stderr.write(
      `${nombre}: ${acta.reconstruidos} renglones reconstruidos, ${acta.interpretados} ` +
        `interpretados, ${acta.cierranSolos} cierran solos, pie ${acta.pie.estado}, ` +
        `${acta.decision}, ${acta.bloqueosRaiz.length} acciones humanas ` +
        `(+${acta.consecuencias} consecuencias), ` +
        `OCR ${Math.round(ocrMs / 1000)} s + motor ${acta.tiempos.motorMs} ms\n` +
        `→ ${path.relative(RAIZ, destino)}\n`,
    );

    if (conRelectura && plan.length > 0) {
      process.stderr.write(
        `${nombre}: hay ${plan.length} banda(s) para releer. Corré ` +
          `scripts/capturar-relectura.mjs con el plan de ${path.relative(RAIZ, PLANES)} ` +
          'y volvé a correr esto para registrar la segunda acta.\n',
      );
    }
  }

  await worker?.terminate();
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
