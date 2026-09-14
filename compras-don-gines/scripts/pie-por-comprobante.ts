/**
 * Qué dice el pie fiscal de cada comprobante, y con qué evidencia.
 *
 * Es el informe que hace auditable la corrección del pie. Un pie es un sistema
 * de conceptos que se sostienen entre sí, y mirar sólo los cuatro totales no
 * permite distinguir un pie leído de uno deducido: hace falta ver, concepto por
 * concepto, **de dónde salió**.
 *
 * Y las cuentas van separadas a propósito. «Doce incidencias» mezcla cinco
 * cosas que piden trabajos distintos y de las que sólo una es un error:
 *
 *  - **asignaciones incorrectas**: un concepto pegado a un valor que el papel
 *    desmiente. Es el único error, y el objetivo es cero;
 *  - **importes sin asignar**: el número está leído y no se pudo probar qué
 *    concepto es. Es una pregunta contestable, no un error;
 *  - **conceptos omitidos**: el papel los imprime y el motor no los tiene;
 *  - **conceptos inferidos**: los ubicó una igualdad fiscal, no su etiqueta;
 *  - **sugerencias derivadas**: una cuenta ofrecida como ayuda, que no es dato.
 *
 *   npx tsx scripts/pie-por-comprobante.ts           (banco de diseño)
 *   npx tsx scripts/pie-por-comprobante.ts --lote    (las fotos nuevas)
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { interpretarReconstruccion } from '@/lib/ocr/motor/desde-reconstruccion';
import { soloRaices } from '@/lib/ocr/motor/pendientes';
import type { EvidenciaDeLectura } from '@/lib/ocr/reconstruccion/evidencia';
import type { EvidenciaDeRelectura } from '@/lib/ocr/reconstruccion/relectura';

const CUIT_DEL_RECEPTOR = '27-33342291-9';

const directorio = process.argv.includes('--lote')
  ? path.resolve(process.cwd(), 'validacion/evidencia')
  : path.resolve(process.cwd(), 'tests/fixtures/evidencia');

if (!existsSync(directorio)) {
  console.error(`No existe ${directorio}.`);
  process.exit(1);
}

const nombres = readdirSync(directorio)
  .filter((n) => n.endsWith('.json') && !n.endsWith('-relectura.json'))
  .map((n) => n.replace(/\.json$/, ''))
  .sort();

function leer(nombre: string, sufijo = ''): EvidenciaDeLectura & EvidenciaDeRelectura {
  return JSON.parse(readFileSync(path.join(directorio, `${nombre}${sufijo}.json`), 'utf8'));
}

let incorrectas = 0;
let sinAsignar = 0;
let omitidos = 0;
let inferidos = 0;
let sugerencias = 0;

for (const nombre of nombres) {
  const relecturaEn = path.join(directorio, `${nombre}-relectura.json`);
  const informe = interpretarReconstruccion(leer(nombre), {
    cuitDelReceptor: CUIT_DEL_RECEPTOR,
    relectura: existsSync(relecturaEn) ? leer(nombre, '-relectura') : undefined,
  });
  const pie = informe.pieFiscal;

  console.log(`\n=== ${nombre}   [${pie.estado.toUpperCase()}]`);
  console.log(
    `   región: ${pie.region ?? '—'}` +
      (pie.segundaRegion ? `   (segunda: ${pie.segundaRegion})` : ''),
  );

  if (pie.asignaciones.length === 0) console.log('   sin ningún concepto asignado.');
  for (const a of pie.asignaciones) {
    console.log(
      `   ${a.concepto.padEnd(12)} ${a.valor.toFixed(2).padStart(14)}  ${a.procedencia}`,
    );
    console.log(
      `      fragmento «${a.origen.texto}» (${a.origen.pasada}, ${a.origen.confianza.toFixed(2)})` +
        `   etiqueta «${(a.etiqueta?.texto ?? '—').slice(0, 40)}»`,
    );
    console.log(
      `      relación: ${a.igualdad ?? 'ninguna'}` +
        `   segunda: ${a.segunda ? `${a.segunda.concepto} ${a.segunda.valor.toFixed(2)}` : '—'}` +
        `   margen: ${a.margen.toFixed(2)}`,
    );
  }

  for (const u of pie.sinAsignar) {
    console.log(
      `   SIN ASIGNAR  «${u.texto}» = ${u.valor?.toString() ?? '?'}` +
        `   alternativas: ${u.alternativas.slice(0, 3).join(', ') || '—'}   (${u.region})`,
    );
  }

  const ausentes: string[] = [];
  if (pie.netoGravado === null) ausentes.push('neto gravado');
  if (pie.iva.length === 0) ausentes.push('IVA');
  if (pie.total === null) ausentes.push('total');
  if (ausentes.length > 0) console.log(`   conceptos ausentes: ${ausentes.join(', ')}`);

  if (pie.totalCalculado) {
    console.log(`   sugerencia derivada: el total sale de una cuenta, no del papel.`);
  }
  if (pie.residuo) console.log(`   residuo sin concepto: ${pie.residuo.toFixed(2)}`);

  const preguntas = soloRaices(informe.pendientes).filter(
    (p) => p.categoria === 'BLOCKING_UNASSIGNED_AMOUNT',
  );
  console.log(
    `   cuentas: incorrectas 0 (no medible sin el papel) · sin asignar ${pie.sinAsignar.length}` +
      ` · ausentes ${ausentes.length} · inferidos ` +
      `${pie.asignaciones.filter((a) => a.procedencia === 'INFERRED_FROM_DOCUMENT_RELATIONS').length}` +
      ` · sugerencias ${pie.totalCalculado ? 1 : 0} · preguntas humanas ${preguntas.length}`,
  );

  sinAsignar += pie.sinAsignar.length;
  omitidos += ausentes.length;
  inferidos += pie.asignaciones.filter(
    (a) => a.procedencia === 'INFERRED_FROM_DOCUMENT_RELATIONS',
  ).length;
  sugerencias += pie.totalCalculado ? 1 : 0;
}

console.log(
  `\n########## TOTALES  asignaciones incorrectas ${incorrectas} (contra el papel se mide con ` +
    `metricas-del-lote) · importes sin asignar ${sinAsignar} · conceptos ausentes ${omitidos} · ` +
    `inferidos ${inferidos} · sugerencias derivadas ${sugerencias}`,
);
