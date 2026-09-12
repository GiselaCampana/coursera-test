/**
 * Captura la evidencia real de las fotos del banco, con coordenadas.
 *
 * Corre Tesseract sobre cada foto con varias pasadas —la página entera y las
 * zonas ampliadas, con y sin limpieza fuerte— y guarda **cada palabra con su
 * caja normalizada**, la pasada de la que salió, su confianza y las lecturas
 * alternativas que el propio OCR consideró.
 *
 * Se ejecuta a mano y su salida se commitea como fixture. No corre en CI: son
 * varias pasadas por factura y tarda minutos. Lo que se gana es que las pruebas
 * de reconstrucción trabajen sobre **evidencia real y determinística**, en vez
 * de sobre texto ya aplanado o sobre cajas inventadas.
 *
 * El procedimiento en sí vive en `scripts/lib/capturar-pasadas.mjs`, compartido
 * con la validación de facturas nuevas: si las dos capturaran distinto,
 * cualquier diferencia de resultado sería inatribuible.
 *
 *   node scripts/capturar-evidencia.mjs [nombre-de-la-foto ...]
 */
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { abrirWorker, capturarEvidencia } from './lib/capturar-pasadas.mjs';

const RAIZ = process.cwd();
const FOTOS = path.join(RAIZ, 'tests/fixtures/imagenes');
const SALIDA = path.join(RAIZ, 'tests/fixtures/evidencia');

const COMPROBANTES = [
  { archivo: 'errecalde-00008-00002647.jpg', nombre: 'errecalde' },
  { archivo: 'mabelherdi-0007-00348491.jpg', nombre: 'mabelherdi' },
  { archivo: 'ezra-00002-00000185.jpg', nombre: 'ezra' },
  { archivo: 'barraza-0041-00196670.png', nombre: 'barraza' },
  { archivo: 'los-calvos-0010-00212356.jpg', nombre: 'los-calvos-212356' },
  { archivo: 'los-calvos-0010-00213103.jpg', nombre: 'los-calvos-213103' },
];

async function main() {
  const pedidos = process.argv.slice(2);
  const aCapturar = pedidos.length
    ? COMPROBANTES.filter((c) => pedidos.includes(c.nombre))
    : COMPROBANTES;

  mkdirSync(SALIDA, { recursive: true });
  const worker = await abrirWorker();

  for (const comprobante of aCapturar) {
    const { evidencia, ms } = await capturarEvidencia(
      worker,
      path.join(FOTOS, comprobante.archivo),
    );
    const destino = path.join(SALIDA, `${comprobante.nombre}.json`);
    writeFileSync(destino, JSON.stringify(evidencia));
    process.stderr.write(
      `→ ${destino}: ${evidencia.fragmentos.length} fragmentos, ` +
        `${evidencia.pasadas.length} pasadas, ${Math.round(ms / 1000)} s\n`,
    );
  }

  await worker.terminate();
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
