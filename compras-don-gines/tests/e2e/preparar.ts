/**
 * globalSetup de Playwright: siembra la base antes de cada corrida.
 *
 * Sin esto las pruebas quedarían acopladas entre sí, porque una que confirma un
 * pago cambia lo que ven las siguientes. Con la siembra en cada corrida, cada
 * `playwright test` arranca de un estado conocido.
 *
 * Carga `.env.e2e` antes de que se construya el cliente de Prisma (que sembrar()
 * crea recién al ejecutarse), y se niega a seguir si la
 * base no parece de pruebas: la siembra empieza por un TRUNCATE, y ese comando
 * apuntado a la base equivocada borra el trabajo de la fiambrería.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sembrar } from './sembrar';

const raiz = path.resolve(__dirname, '../..');
const ruta = path.join(raiz, '.env.e2e');

export default async function globalSetup() {
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
      `La siembra de las pruebas end to end borra todas las tablas y sólo corre contra una base ` +
        `cuyo nombre contenga "e2e" o "test". DATABASE_URL apunta a "${nombreBase}".`,
    );
  }

  await sembrar();
}
