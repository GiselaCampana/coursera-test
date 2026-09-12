/**
 * Medición transversal de los seis comprobantes del banco de fotos.
 *
 * Corre el motor general sobre la evidencia capturada y muestra, por
 * comprobante, lo único que importa: cuántos renglones se reconstruyeron,
 * cuántos se interpretaron, cuántos se comprueban solos, si la suma cierra
 * contra el pie impreso, qué decisión salió y cuántos bloqueos quedan.
 *
 *   npx tsx scripts/medir-comprobantes.ts
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { interpretarReconstruccion } from '@/lib/ocr/motor/desde-reconstruccion';
import type { EvidenciaDeLectura } from '@/lib/ocr/reconstruccion/evidencia';
import { soloBloqueantes } from '@/lib/ocr/motor/pendientes';

const DIRECTORIO = path.resolve(process.cwd(), 'tests/fixtures/evidencia');
const CUIT_DEL_RECEPTOR = '27-33342291-9';

const NOMBRES = [
  'barraza',
  'errecalde',
  'ezra',
  'los-calvos-212356',
  'los-calvos-213103',
  'mabelherdi',
];

function leer(nombre: string): EvidenciaDeLectura {
  return JSON.parse(readFileSync(path.join(DIRECTORIO, `${nombre}.json`), 'utf8'));
}

for (const nombre of NOMBRES) {
  const conRelectura = process.argv.includes('--relectura');
  let relectura;
  if (conRelectura) {
    try {
      relectura = JSON.parse(
        readFileSync(path.join(DIRECTORIO, `${nombre}-relectura.json`), 'utf8'),
      );
    } catch {
      /* sin relectura capturada */
    }
  }

  const informe = interpretarReconstruccion(leer(nombre), {
    cuitDelReceptor: CUIT_DEL_RECEPTOR,
    relectura,
  });
  const g = informe.veredicto.ganadora;
  const ok = g?.renglones.filter((r) => r.controles.length > 0 && r.controles.every((c) => c.paso)).length ?? 0;
  const bloqueos = soloBloqueantes(informe.pendientes).length;

  console.log(
    [
      nombre.padEnd(18),
      `recon=${String(informe.tabla.renglones.length).padStart(2)}`,
      `interp=${String(g?.renglones.length ?? 0).padStart(2)}`,
      `ok=${String(ok).padStart(2)}`,
      `cierre=${String(g?.cierre?.compatible ?? false).padEnd(5)}`,
      `punt=${(g?.puntaje ?? 0).toFixed(2)}`,
      informe.veredicto.decision.padEnd(22),
      `bloq=${String(bloqueos).padStart(2)}`,
      `suma=${(g?.sumaDeRenglones ?? 0).toString().padEnd(14)}`,
      `neto=${g?.pie.netTotal?.toString() ?? '-'}`,
      `iva=${g?.pie.ivaTotal?.toString() ?? '-'}`,
      `perc=${g?.pie.percepciones?.toString() ?? '-'}`,
      `total=${g?.pie.total?.toString() ?? '-'}`,
      `${informe.ms}ms`,
      informe.reconstruccionElegida,
      informe.relectura
        ? `relectura: ${informe.relectura.bandas} bandas, ${informe.relectura.celdasPedidas} celdas, ` +
          `${informe.relectura.ms}ms, ${informe.relectura.gano ? 'ganó' : 'perdió'}, ` +
          `ok ${informe.relectura.comprobadosAntes}→${informe.relectura.comprobadosDespues}, ` +
          `bloq ${informe.relectura.bloqueosAntes}→${informe.relectura.bloqueosDespues}`
        : '',
    ].join('  '),
  );
}
