/**
 * Qué escala eligió el motor para cada columna de cada comprobante.
 *
 * La escala de una columna es la decisión más cara que toma el motor: mueve el
 * costo de cada artículo un factor de cien y ninguna igualdad del comprobante lo
 * delata, porque si el precio y el importe se corren juntos la cuenta cierra
 * igual. Lo único que la puede auditar es ver, columna por columna, **con qué
 * evidencia** se decidió.
 *
 * De cada columna se informan las cinco cosas que hacen falta para revisarla:
 *
 *  - la escala elegida: dónde va el separador y cuántos decimales;
 *  - sus **anclas literales**: los valores de la columna que la muestran
 *    impresa. Sin anclas no hay evidencia directa de escala, y se dice;
 *  - las **reparaciones**: cuántos separadores hubo que suponer perdidos para
 *    leer la columna entera así;
 *  - la **segunda hipótesis**, la que quedó en pie, con su propio costo;
 *  - el **margen**: con cuánta ventaja ganó. Cero es un empate.
 *
 * Y se marca aparte lo indecidible: ninguna ancla y dos escalas posibles. Ahí no
 * se elige, se frena.
 *
 *   npx tsx scripts/escalas-por-comprobante.ts             (banco de diseño)
 *   npx tsx scripts/escalas-por-comprobante.ts --lote      (las fotos nuevas)
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { interpretarReconstruccion } from '@/lib/ocr/motor/desde-reconstruccion';
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

for (const nombre of nombres) {
  const relecturaEn = path.join(directorio, `${nombre}-relectura.json`);
  const informe = interpretarReconstruccion(leer(nombre), {
    cuitDelReceptor: CUIT_DEL_RECEPTOR,
    relectura: existsSync(relecturaEn) ? leer(nombre, '-relectura') : undefined,
  });

  console.log(`\n=== ${nombre}  (${informe.veredicto.decision})`);
  if (informe.escalas.length === 0) {
    console.log('   sin columnas numéricas con formato.');
    continue;
  }

  for (const e of informe.escalas) {
    const como = (separador: string, decimales: number) =>
      separador === 'ninguno' ? 'enteros' : `${separador} con ${decimales} decimal/es`;

    const anclas =
      e.anclas.length > 0
        ? `anclada en ${e.anclas.length} valor/es impreso/s: ${e.anclas.slice(0, 4).join(', ')}`
        : 'SIN ANCLAS (ningún valor muestra su separador impreso)';

    const segunda = e.segunda
      ? `2ª ${como(e.segunda.separador, e.segunda.decimales)} (${e.segunda.reparaciones} rep.)`
      : '2ª —';

    console.log(
      `   ${e.columna.padEnd(18)} ${como(e.separador, e.decimales).padEnd(24)} ` +
        `${e.reparaciones} rep.  ${segunda}  margen ${e.margen === -1 ? '∞' : e.margen}` +
        (e.indecidible ? '  ← INDECIDIBLE: no se elige, frena' : ''),
    );
    console.log(`      ${anclas}`);
  }
}
