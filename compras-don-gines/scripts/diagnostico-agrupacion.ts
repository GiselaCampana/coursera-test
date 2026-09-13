/**
 * Qué leyó cada pasada en una zona de la página, y en qué quedó agrupado.
 *
 * Es la herramienta con la que se diagnostican los defectos de reconstrucción
 * sin adivinar: primero los fragmentos crudos con su pasada, su caja y su
 * confianza; después las observaciones que salieron de agruparlos; después los
 * renglones visuales. Mirar el resultado final no alcanza —dos causas muy
 * distintas dan la misma celda mal— y mirar el JSON de la evidencia entero es
 * inmanejable.
 *
 * La zona va en fracción de la página, igual que todo lo demás.
 *
 *   npx tsx scripts/diagnostico-agrupacion.ts errecalde 0.05 0.45 0.294 0.301
 *   EVIDENCIA=validacion/evidencia npx tsx scripts/diagnostico-agrupacion.ts nueva-03 0.18 0.30 0.268 0.282
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  alturaDeRenglon,
  enderezar,
  medirInclinacion,
  valeLaPenaEnderezar,
} from '@/lib/ocr/reconstruccion/inclinacion';
import { agruparPorLugar, armarRenglones, unirPartidas } from '@/lib/ocr/reconstruccion/agrupar';
import type { Caja, EvidenciaDeLectura } from '@/lib/ocr/reconstruccion/evidencia';

const DIRECTORIO = process.env.EVIDENCIA ?? 'tests/fixtures/evidencia';

const [nombre, x0, x1, y0, y1] = process.argv.slice(2);
if (!nombre) {
  process.stderr.write(
    'Uso: npx tsx scripts/diagnostico-agrupacion.ts <nombre> [x0 x1 y0 y1]\n' +
      `Lee de ${DIRECTORIO}/ (se cambia con EVIDENCIA=...).\n`,
  );
  process.exit(1);
}

const zona: Caja = {
  x0: x0 === undefined ? 0 : Number(x0),
  x1: x1 === undefined ? 1 : Number(x1),
  y0: y0 === undefined ? 0 : Number(y0),
  y1: y1 === undefined ? 1 : Number(y1),
};

const evidencia: EvidenciaDeLectura = JSON.parse(
  readFileSync(path.join(process.cwd(), DIRECTORIO, `${nombre}.json`), 'utf8'),
);

const conContenido = evidencia.fragmentos.filter((f) => /[\p{L}\p{N}]/u.test(f.texto));
const alturaCruda = alturaDeRenglon(conContenido);
const inclinacion = medirInclinacion(conContenido);
const corregir = valeLaPenaEnderezar(inclinacion, alturaCruda);
const enderezados = enderezar(conContenido, corregir ? inclinacion : { pendiente: 0, apoyos: 0 });
const alturaTipica = alturaDeRenglon(enderezados) || alturaCruda;

const toca = (c: Caja) => c.x1 > zona.x0 && c.x0 < zona.x1 && c.y1 > zona.y0 && c.y0 < zona.y1;
const n = (v: number) => v.toFixed(4);

process.stdout.write(
  `altura típica ${n(alturaTipica)}  enderezado ${corregir}\n\n--- fragmentos crudos\n`,
);
for (const f of enderezados.filter((f) => toca(f.caja))) {
  process.stdout.write(
    `${f.pasada.padEnd(26)} ${JSON.stringify(f.texto).padEnd(24)} ` +
      `x ${n(f.caja.x0)}–${n(f.caja.x1)} y ${n(f.caja.y0)}–${n(f.caja.y1)} ` +
      `conf ${f.confianza.toFixed(2)}\n`,
  );
}

const observaciones = agruparPorLugar(enderezados);
process.stdout.write('\n--- observaciones\n');
for (const o of observaciones.filter((o) => toca(o.caja))) {
  process.stdout.write(
    `x ${n(o.caja.x0)}–${n(o.caja.x1)} y ${n(o.caja.y0)}–${n(o.caja.y1)}: ` +
      o.lecturas.map((l) => `${l.pasada}=${JSON.stringify(l.texto)}`).join('  ') +
      '\n',
  );
}

process.stdout.write('\n--- renglones visuales que tocan la zona, después de unir partidas\n');
for (const renglon of armarRenglones(observaciones, alturaTipica)) {
  if (renglon.caja.y1 <= zona.y0 || renglon.caja.y0 >= zona.y1) continue;
  process.stdout.write(`y ${n(renglon.y)}:\n`);
  for (const o of unirPartidas(renglon, alturaTipica)) {
    process.stdout.write(
      `   x ${n(o.caja.x0)}–${n(o.caja.x1)} ${JSON.stringify(o.lecturas.map((l) => l.texto))}\n`,
    );
  }
}
