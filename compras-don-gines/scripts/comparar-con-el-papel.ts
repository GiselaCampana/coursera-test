/**
 * Compara el acta ciega contra la transcripción del comprobante.
 *
 * Se corre **después** de `scripts/lectura-ciega.ts` y después de transcribir
 * el papel a mano en `validacion/verdad/<nombre>.json`. Esa separación es la
 * que le da valor a la medición: el acta ya está guardada y firmada con el hash
 * del motor, así que la transcripción no puede influir en ella.
 *
 * Lo que imprime no es una nota, es un diagnóstico: dónde se rompió la cadena.
 *
 *   npx tsx scripts/comparar-con-el-papel.ts [nombre ...]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { comparar, VERSION_DEL_COMPARADOR } from '@/lib/ocr/validacion/comparar';
import type { VerdadDelPapel } from '@/lib/ocr/validacion/comparar';
import type { ActaDePrimeraLectura } from '@/lib/ocr/validacion/lectura-ciega';

const RAIZ = process.cwd();
const ACTAS = path.join(RAIZ, 'validacion/ciega');
const VERDAD = path.join(RAIZ, 'validacion/verdad');
const SALIDA = path.join(RAIZ, `validacion/comparacion-${VERSION_DEL_COMPARADOR}`);

/**
 * El hash del comparador, para que el resultado sea atribuible.
 *
 * La primera comparación de un lote le anotó un error al motor que era de la
 * herramienta. Sin este hash, una medición vieja y una nueva se ven iguales.
 */
const SHA_DEL_COMPARADOR = createHash('sha256')
  .update(readFileSync(path.join(RAIZ, 'src/lib/ocr/validacion/comparar.ts')))
  .digest('hex');

const pedidos = process.argv.slice(2);
const nombres = pedidos.length
  ? pedidos
  : existsSync(ACTAS)
    ? readdirSync(ACTAS).filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/, ''))
    : [];

if (nombres.length === 0) {
  process.stderr.write(
    `No hay actas en ${path.relative(RAIZ, ACTAS)}/. Corré primero scripts/lectura-ciega.ts.\n`,
  );
  process.exit(0);
}

mkdirSync(SALIDA, { recursive: true });

for (const nombre of nombres) {
  const rutaDelActa = path.join(ACTAS, `${nombre}.json`);
  const rutaDeLaVerdad = path.join(VERDAD, `${nombre}.json`);

  if (!existsSync(rutaDelActa)) {
    process.stderr.write(`${nombre}: no hay acta ciega todavía.\n`);
    continue;
  }
  if (!existsSync(rutaDeLaVerdad)) {
    process.stderr.write(
      `${nombre}: falta la transcripción en ${path.relative(RAIZ, rutaDeLaVerdad)}. ` +
        'Se transcribe **después** del acta, no antes.\n',
    );
    continue;
  }

  const acta: ActaDePrimeraLectura = JSON.parse(readFileSync(rutaDelActa, 'utf8'));
  const verdad: VerdadDelPapel = JSON.parse(readFileSync(rutaDeLaVerdad, 'utf8'));
  const resultado = comparar(acta, verdad, SHA_DEL_COMPARADOR);

  writeFileSync(
    path.join(SALIDA, `${nombre}.json`),
    `${JSON.stringify(resultado, null, 1)}\n`,
  );

  console.log(
    `\n=== ${nombre}  (motor ${resultado.motor.commit.slice(0, 8)}` +
      `${resultado.motor.arbolSucio ? ', árbol sucio' : ''}` +
      `, comparador ${VERSION_DEL_COMPARADOR} ${SHA_DEL_COMPARADOR.slice(0, 8)})`,
  );
  if (!resultado.coinciden) {
    console.log('  !! el acta y la transcripción no son de la misma foto');
    continue;
  }
  console.log(
    `  renglones: ${resultado.renglonesQueCoinciden}/${resultado.renglonesEnElPapel} exactos, ` +
      `${resultado.renglonesInterpretados} interpretados`,
  );
  console.log(
    `  campos: ${resultado.aciertos} aciertos, ${resultado.errores} errores, ` +
      `${resultado.pedidos} pedidos (no cuentan como error)`,
  );
  console.log(
    `  acciones humanas: ${resultado.accionesHumanas} ` +
      `(${resultado.columnasPorConfirmar} columnas, ${resultado.celdasPorCorregir} celdas, ` +
      `${resultado.productosPorAsociar} productos, ` +
      `${resultado.unidadesPorResolver} unidades)`,
  );
  if (Object.keys(resultado.porCausa).length > 0) {
    console.log('  causas:', JSON.stringify(resultado.porCausa));
  }
  console.log(`  → ${resultado.veredicto}`);
  for (const campo of resultado.campos.filter((c) => c.acierto === false)) {
    console.log(
      `      ${campo.renglon ? `r${campo.renglon}.` : ''}${campo.campo}: ` +
        `leyó ${JSON.stringify(campo.leido)}, el papel dice ${JSON.stringify(campo.papel)} ` +
        `[${campo.causa}]`,
    );
  }
}
