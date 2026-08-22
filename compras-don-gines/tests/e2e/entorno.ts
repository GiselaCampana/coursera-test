/**
 * Entorno de las pruebas end to end.
 *
 * `globalSetup` carga `.env.e2e` en el proceso principal de Playwright, pero
 * las pruebas corren en procesos aparte que no heredan eso. Cualquier spec que
 * necesite tocar la base tiene que volver a cargarlo, y sobre todo tiene que
 * volver a verificar contra qué base está apuntando.
 *
 * La verificación no es paranoia: estas pruebas borran filas, y la misma
 * variable mal cargada apuntaría a la base de desarrollo.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const raiz = path.resolve(__dirname, '../..');
const ruta = path.join(raiz, '.env.e2e');

/** Carga `.env.e2e` y se niega a seguir si la base no parece de pruebas. */
export function cargarEntornoE2E(): void {
  if (!existsSync(ruta)) {
    throw new Error(
      'Falta .env.e2e. Copiá .env.example y apuntá DATABASE_URL a una base de pruebas.',
    );
  }

  for (const linea of readFileSync(ruta, 'utf8').split('\n')) {
    const limpia = linea.trim();
    if (limpia === '' || limpia.startsWith('#')) continue;
    const corte = limpia.indexOf('=');
    if (corte < 0) continue;
    process.env[limpia.slice(0, corte).trim()] = limpia
      .slice(corte + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }

  const url = process.env.DATABASE_URL ?? '';
  const nombreBase = url.split('/').pop()?.split('?')[0] ?? '';
  if (!/e2e|test/i.test(nombreBase)) {
    throw new Error(
      'Las pruebas end to end escriben y borran filas, y sólo corren contra una base cuyo ' +
        `nombre contenga "e2e" o "test". DATABASE_URL apunta a "${nombreBase}".`,
    );
  }
}

/**
 * Borra los comprobantes que dejaron las pruebas de lectura.
 *
 * Se reconocen porque tienen intentos de OCR: la siembra no crea ninguno. Sin
 * esto, los comprobantes que quedan cambian las cuentas de las pruebas que
 * miran los listados y el historial, que esperan el escenario sembrado y nada
 * más.
 *
 * El historial de costos no se borra en cascada —queda con el comprobante en
 * null a propósito, para no perder el precio histórico— así que se borra acá.
 */
export async function limpiarComprobantesLeidos(): Promise<void> {
  cargarEntornoE2E();
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const leidos = await prisma.document.findMany({
      where: { ocrAttempts: { some: {} } },
      select: { id: true },
    });
    if (leidos.length === 0) return;
    const ids = leidos.map((d) => d.id);
    await prisma.costHistory.deleteMany({ where: { documentId: { in: ids } } });
    await prisma.document.deleteMany({ where: { id: { in: ids } } });
  } finally {
    await prisma.$disconnect();
  }
}
