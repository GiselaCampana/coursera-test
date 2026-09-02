/**
 * Prepara el entorno para las pruebas end to end:
 * carga .env.e2e, aplica las migraciones, compila y siembra los datos.
 *
 * Se corre antes de Playwright, que después levanta `next start` con el mismo
 * entorno. Así las pruebas end to end trabajan contra un build de producción
 * real, no contra el servidor de desarrollo.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ruta = path.join(raiz, '.env.e2e');
if (!existsSync(ruta)) {
  console.error('Falta .env.e2e. Copiá .env.example y apuntá DATABASE_URL a una base de pruebas.');
  process.exit(1);
}

for (const linea of readFileSync(ruta, 'utf8').split('\n')) {
  const limpia = linea.trim();
  if (limpia === '' || limpia.startsWith('#')) continue;
  const corte = limpia.indexOf('=');
  if (corte < 0) continue;
  const clave = limpia.slice(0, corte).trim();
  const valor = limpia.slice(corte + 1).trim().replace(/^["']|["']$/g, '');
  process.env[clave] = valor;
}

if (!/e2e|test/i.test(process.env.DATABASE_URL ?? '')) {
  console.error(
    'Por seguridad las pruebas end to end sólo corren contra una base cuyo nombre contenga "e2e" o "test".',
  );
  process.exit(1);
}

const correr = (comando) => {
  console.log(`> ${comando}`);
  execSync(comando, { cwd: raiz, stdio: 'inherit', env: process.env });
};

rmSync(path.join(raiz, process.env.STORAGE_LOCAL_DIR ?? './.storage-e2e'), {
  recursive: true,
  force: true,
});

correr('npx prisma migrate deploy');
/*
 * Los archivos del lector, antes de compilar.
 *
 * `public/ocr/` se deriva de node_modules y no se versiona, así que en un
 * checkout limpio —CI— no existe. Este script llamaba a `next build` directo y
 * se salteaba el paso que los copia, que sólo estaba colgado del script `build`
 * de npm. En una máquina de trabajo no se notaba, porque la carpeta ya estaba
 * de haber corrido `npm run dev` alguna vez; en CI el navegador se quedaba
 * esperando un worker que nunca llegaba y las pruebas que leen un comprobante
 * agotaban su tiempo sin decir por qué.
 */
correr('node scripts/preparar-ocr.mjs');
correr('npx next build');
correr('npx tsx tests/e2e/sembrar.ts');

console.log('Entorno de pruebas end to end listo.');
