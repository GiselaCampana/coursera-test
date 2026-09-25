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

/*
 * La guarda mira el NOMBRE de la base, no la URL entera.
 *
 * HALLAZGO de la fase 5, el mismo que apareció en el arranque de las pruebas de
 * integración: acá decía `/e2e|test/i.test(DATABASE_URL)`, y eso aceptaba
 * `postgresql://tester@host/compras_don_gines` —producción— porque la palabra
 * estaba en el usuario. Lo que sigue aplica migraciones y corre un sembrado que
 * empieza con TRUNCATE; una guarda que se saltea con un nombre de usuario no es
 * una guarda.
 *
 * Se repite la expresión en vez de importar `src/lib/base-de-pruebas.ts` porque
 * esto es un `.mjs` que corre con node a secas, antes de que exista cualquier
 * compilación. El sembrado que viene después SÍ usa la guarda de verdad
 * (`exigirBaseDescartable`), así que esto es el aviso temprano, no la
 * protección última: por eso puede permitirse ser una copia.
 */
const nombreDeLaBase = (url) => {
  try {
    return new URL(url).pathname.replace(/^\//, '') || null;
  } catch {
    return null;
  }
};
const nombre = nombreDeLaBase(process.env.DATABASE_URL ?? '');
if (nombre === null || !/(^|[-_])(e2e|test)([-_]|$)/i.test(nombre)) {
  console.error(
    'Por seguridad las pruebas end to end sólo corren contra una base cuyo NOMBRE contenga\n' +
      '"e2e" o "test". No alcanza con que la palabra esté en el usuario o en el host, y la\n' +
      'demo no cuenta: está desplegada. No se aplicó ninguna migración.\n' +
      `Base vista: ${nombre ?? '(ninguna: DATABASE_URL no está definida)'}`,
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
