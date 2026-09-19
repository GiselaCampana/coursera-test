/**
 * **Una compra para mirar en el navegador, aislada de producción.**
 *
 * Siembra en la base de pruebas los dos comprobantes de Ezra —la completa y la
 * frenada— y escribe los enlaces para abrirlos. Lo que siembra está en
 * `tests/fixtures/compra-de-ezra.ts`, que es lo mismo que usan las pruebas end
 * to end: si la demostración y la prueba mirasen datos distintos, una de las
 * dos estaría mintiendo.
 *
 * **No toca producción, y no puede.** Se niega a correr si la base no se llama
 * como una base de pruebas, que es la misma guarda que usa el preparador de las
 * end to end. Los datos son inventados: el CUIT, los PLU y los importes salen
 * del papel transcripto, no del sistema real.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Las variables del entorno de pruebas, si están escritas en .env.e2e.
 *
 * Corre **antes** de que exista el cliente de Prisma, y esa precedencia es la
 * mitad de la guarda: al importarse, `@prisma/client` lee el `.env` del
 * proyecto, que en una máquina de trabajo apunta a la base de desarrollo. Si el
 * cliente se cargara primero, `DATABASE_URL` ya estaría tomada y este archivo
 * no podría corregirla; por eso el cliente se importa a mano más abajo.
 *
 * Lo que sí gana es una variable puesta a mano en la línea de comandos: quien
 * la escribe está diciendo contra qué base quiere correr.
 */
function cargarEntornoDePruebas(): void {
  const ruta = path.join(raiz, '.env.e2e');
  if (!existsSync(ruta)) return;
  for (const linea of readFileSync(ruta, 'utf8').split('\n')) {
    const limpia = linea.trim();
    if (limpia === '' || limpia.startsWith('#')) continue;
    const corte = limpia.indexOf('=');
    if (corte < 0) continue;
    const clave = limpia.slice(0, corte).trim();
    if (process.env[clave] !== undefined) continue;
    process.env[clave] = limpia
      .slice(corte + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
}

async function main() {
  cargarEntornoDePruebas();

  const url = process.env.DATABASE_URL ?? '';
  const { esUnaBaseDePruebas, nombreDeLaBase } = await import('../tests/fixtures/base-de-pruebas');
  if (!esUnaBaseDePruebas(url)) {
    /*
     * Se nombra la base que se vio, y sólo la base: decir «no es de pruebas»
     * sin decir cuál miró deja a quien lo corre adivinando, y la URL entera
     * lleva la contraseña.
     */
    console.error(
      'Esto sólo corre contra una base de pruebas: el nombre de la base tiene que ser\n' +
        '"e2e", "test" o "demo". No se escribió nada.\n' +
        `Base vista: ${nombreDeLaBase(url) ?? '(ninguna: DATABASE_URL no está definida)'}`,
    );
    process.exit(1);
  }

  // Recién ahora, con el entorno ya resuelto y verificado.
  const { PrismaClient } = await import('@prisma/client');
  const { sembrarLaCompraDeEzra } = await import('../tests/fixtures/compra-de-ezra');
  const prisma = new PrismaClient();

  try {
    const sucursal = await prisma.branch.findFirst({ orderBy: { code: 'asc' } });
    const autor = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!sucursal || !autor) {
      console.error('La base de pruebas está vacía. Corré antes: npm run e2e:seed');
      process.exit(1);
    }

    const sembrada = await sembrarLaCompraDeEzra(prisma, {
      sucursalId: sucursal.id,
      autorId: autor.id,
    });

    console.log('');
    console.log('Listo. Dos comprobantes para mirar en el navegador:');
    console.log('');
    console.log(`  Ezra completa   /comprobantes/${sembrada.completa}`);
    console.log(`                  /comprobantes/${sembrada.completa}/vista-previa`);
    console.log(`  Ezra frenada    /comprobantes/${sembrada.frenada}`);
    console.log(`                  /comprobantes/${sembrada.frenada}/vista-previa`);
    console.log('');
    console.log(`  Artículos de Ezra en el catálogo: ${sembrada.productos}`);
    console.log('');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
