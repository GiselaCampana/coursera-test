import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

/**
 * Preparación de la base de pruebas.
 *
 * Las pruebas de integración corren contra un PostgreSQL de verdad y aplican
 * las migraciones desde cero, así que además de ejercitar los servicios
 * comprueban que las migraciones funcionan sobre una base vacía.
 */

const raiz = path.resolve(__dirname, '../..');

function cargarEnv(archivo: string) {
  const ruta = path.join(raiz, archivo);
  if (!existsSync(ruta)) return;
  for (const linea of readFileSync(ruta, 'utf8').split('\n')) {
    const limpia = linea.trim();
    if (limpia === '' || limpia.startsWith('#')) continue;
    const separador = limpia.indexOf('=');
    if (separador < 0) continue;
    const clave = limpia.slice(0, separador).trim();
    const valor = limpia.slice(separador + 1).trim().replace(/^["']|["']$/g, '');
    // Lo que ya viene del entorno manda sobre el archivo.
    if (process.env[clave] === undefined) process.env[clave] = valor;
  }
}

export async function setup() {
  cargarEnv('.env.test');

  if (!process.env.DATABASE_URL) {
    throw new Error(
      'Las pruebas de integración necesitan DATABASE_URL. Copiá .env.example a .env.test.',
    );
  }
  if (!/test/i.test(process.env.DATABASE_URL)) {
    throw new Error(
      `Por seguridad las pruebas sólo corren contra una base cuyo nombre contenga "test". ` +
        `DATABASE_URL apunta a otra cosa.`,
    );
  }

  // Storage limpio en cada corrida.
  const storage = path.join(raiz, process.env.STORAGE_LOCAL_DIR ?? './.storage-test');
  rmSync(storage, { recursive: true, force: true });

  // Aplica todas las migraciones. Sobre la base de pruebas, que arranca vacía,
  // esto comprueba que las migraciones corren desde cero. Es `deploy` y no
  // `reset` a propósito: no borra nada, y cada archivo de pruebas se encarga de
  // limpiar sus tablas con limpiarBase().
  execSync('npx prisma migrate deploy', {
    cwd: raiz,
    stdio: 'pipe',
    env: process.env,
  });
}

export async function teardown() {
  // Nada que hacer: la base de pruebas queda lista para la próxima corrida.
}
