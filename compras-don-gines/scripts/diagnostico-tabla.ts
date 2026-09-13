/**
 * La tabla reconstruida de un comprobante, celda por celda y con alternativas.
 *
 * El paso siguiente a `diagnostico-agrupacion.ts`: qué columnas se detectaron,
 * qué renglones salieron, qué quedó en cada celda, qué otras lecturas había y
 * qué no entró en ninguna columna. Sirve para ver de un vistazo si un defecto
 * nace en la agrupación, en los límites de columna o en la interpretación.
 *
 *   npx tsx scripts/diagnostico-tabla.ts mabelherdi
 *   EVIDENCIA=validacion/evidencia npx tsx scripts/diagnostico-tabla.ts nueva-03
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { reconstruirTabla } from '@/lib/ocr/reconstruccion/reconstruccion';
import type { EvidenciaDeLectura } from '@/lib/ocr/reconstruccion/evidencia';

const DIRECTORIO = process.env.EVIDENCIA ?? 'tests/fixtures/evidencia';

const nombre = process.argv[2];
if (!nombre) {
  process.stderr.write(
    'Uso: npx tsx scripts/diagnostico-tabla.ts <nombre>\n' +
      `Lee de ${DIRECTORIO}/ (se cambia con EVIDENCIA=...).\n`,
  );
  process.exit(1);
}

const evidencia: EvidenciaDeLectura = JSON.parse(
  readFileSync(path.join(process.cwd(), DIRECTORIO, `${nombre}.json`), 'utf8'),
);

const tabla = reconstruirTabla(evidencia);
process.stdout.write(
  `columnas (${tabla.metodo}): ${tabla.columnas.map((c) => c.campo?.campo ?? '?').join(' | ')}\n` +
    `encabezados: ${tabla.encabezados.join(' | ')}\n` +
    `${tabla.renglones.length} renglones interpretables, ${tabla.filasVisibles} filas vistas\n\n`,
);

for (const renglon of tabla.renglones) {
  const sobrantes = renglon.sobrantes.map((s) => s.texto);
  process.stdout.write(
    `y ${renglon.y.toFixed(4)} [${renglon.estado}]` +
      (sobrantes.length ? ` fuera de toda columna: ${JSON.stringify(sobrantes)}` : '') +
      '\n',
  );
  for (const celda of renglon.celdas) {
    if (!celda) continue;
    const otras = celda.alternativas.slice(1).map((a) => a.texto);
    process.stdout.write(
      `   ${String(celda.columna).padStart(2)} ${JSON.stringify(celda.texto).padEnd(30)} ` +
        `${celda.estado}${otras.length ? `  ← ${JSON.stringify(otras)}` : ''}\n`,
    );
  }
}
