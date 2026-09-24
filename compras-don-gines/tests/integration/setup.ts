import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { exigirBaseDescartable } from '../../src/lib/base-de-pruebas';

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
  /*
   * La guarda mira el NOMBRE de la base, no la URL entera.
   *
   * HALLAZGO. Decía comprobar «una base cuyo nombre contenga test» y en
   * realidad corría `/test/i` sobre la URL COMPLETA. Con eso,
   * `postgresql://tester:...@db.example.com/compras_produccion` pasaba: la
   * palabra está en el usuario. Lo mismo un host `test.example.com` o una
   * contraseña con «test» adentro. El mensaje prometía una cosa y el código
   * hacía otra, que es la peor clase de guarda: la que tranquiliza sin proteger.
   *
   * `base-de-pruebas.ts` ya miraba el nombre —para esto mismo— y este archivo
   * no lo usaba. `exigirBaseDescartable` además excluye la demo, que está
   * desplegada y no es descartable.
   */
  exigirBaseDescartable(process.env.DATABASE_URL);

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
