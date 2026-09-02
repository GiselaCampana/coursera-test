import { test, expect } from '@playwright/test';
import { ingresar, sinScrollHorizontal, soloEnIphone } from './ayudas';
import { cargarEntornoE2E } from './entorno';

/**
 * Sincronizar el catálogo con Control de Stock, desde la pantalla.
 *
 * Lo que se controla acá es el recorrido completo tal como lo hace una persona:
 * mirar qué cambiaría, confirmar, y volver a sincronizar para ver que la
 * segunda vez no propone nada. Esa última parte es la que dice que lo que se
 * aplicó es lo que se miró.
 *
 * Del otro lado contesta un Control de Stock de mentira que levanta Playwright
 * (scripts/stock-falso.mjs). La descarga pasa del lado del servidor —en el
 * navegador Safari la bloquea—, así que sin algo que conteste no habría forma
 * de probar esto desde el navegador.
 */

const STOCK_FALSO = 'http://127.0.0.1:3111';

/** Le pide al Control de Stock de mentira que sirva otra variante. */
async function servirVariante(n: number) {
  const respuesta = await fetch(`${STOCK_FALSO}/variante?n=${n}`, { method: 'POST' });
  if (!respuesta.ok) throw new Error(`El stock de prueba no cambió de variante: ${respuesta.status}`);
}

async function conPrisma<T>(fn: (prisma: import('@prisma/client').PrismaClient) => Promise<T>) {
  cargarEntornoE2E();
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    return await fn(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

/** Lo que es de Compras y la sincronización no puede tocar. */
async function loQueEsDeCompras() {
  return await conPrisma(async (prisma) => {
    const [productos, movimientos, costos, alias] = await Promise.all([
      prisma.product.findMany({
        orderBy: { internalCode: 'asc' },
        select: {
          internalCode: true,
          targetMarginPct: true,
          feteadoQuarterMarginPct: true,
          saleMode: true,
          avgPieceWeightKg: true,
        },
      }),
      prisma.purchaseMovement.count(),
      prisma.costHistory.count(),
      prisma.productAlias.count(),
    ]);
    return { productos: productos.map((p) => JSON.stringify(p)), movimientos, costos, alias };
  });
}

/**
 * Los artículos del sembrado, tal como estaban antes de sincronizar.
 *
 * Esta prueba mueve el catálogo a propósito: para eso está. Pero el sembrado es
 * uno solo para toda la suite, y las specs que corren después esperan
 * encontrarlo como lo dejó `sembrar.ts` —el 1211 en la familia Quesos, el 1001
 * comprado a Los Calvos—. Sin devolverlo, esta prueba pasaría y rompería otras
 * dos, que es la peor manera de fallar: lejos de la causa.
 */
type FotoDeArticulo = {
  internalCode: string;
  normalizedName: string;
  category: string | null;
  subtype: string | null;
  familyId: string | null;
  defaultSupplierId: string | null;
  purchaseUnit: 'KG' | 'UNIT';
  imageUrl: string | null;
  active: boolean;
};

let comoEstaban: FotoDeArticulo[] = [];

const SELECCION = {
  internalCode: true,
  normalizedName: true,
  category: true,
  subtype: true,
  familyId: true,
  defaultSupplierId: true,
  purchaseUnit: true,
  imageUrl: true,
  active: true,
} as const;

test.describe('sincronización con Control de Stock', () => {
  test.beforeAll(async () => {
    await servirVariante(1);
    await conPrisma(async (prisma) => {
      // El artículo que la prueba da de alta, por si quedó de una corrida previa.
      await prisma.product.deleteMany({ where: { internalCode: '4001' } });
      comoEstaban = (await prisma.product.findMany({
        select: SELECCION,
      })) as FotoDeArticulo[];
    });
  });

  test.afterAll(async () => {
    await servirVariante(1);
    await conPrisma(async (prisma) => {
      await prisma.product.deleteMany({ where: { internalCode: '4001' } });
      for (const foto of comoEstaban) {
        const { internalCode, ...datos } = foto;
        await prisma.product.updateMany({ where: { internalCode }, data: datos });
      }
      /*
       * Y las familias que la sincronización creó, si no quedó nadie en ellas.
       * Una familia suelta no rompe nada, pero ensucia el desplegable de la
       * pantalla de catálogo para las pruebas que vienen después.
       */
      await prisma.productFamily.deleteMany({ where: { products: { none: {} } } });
    });
  });

  test('la vista previa separa los cuatro grupos y no escribe nada', async ({ page }) => {
    const antes = await loQueEsDeCompras();

    await ingresar(page, 'admin');
    await page.goto('/configuracion/catalogo');

    const tarjeta = page.locator('.card').filter({
      has: page.getByRole('heading', { name: 'Sincronizar con Control de Stock' }),
    });
    await expect(tarjeta).toBeVisible();

    await tarjeta.getByRole('button', { name: 'Consultar a Control de Stock' }).click();

    /*
     * Los cuatro montones que hay que mirar antes de decidir.
     *
     * Se busca en el resumen de arriba y no en la página entera: los mismos
     * nombres se repiten como título de cada grupo plegado, y afirmar sobre
     * "el texto en algún lado" no distingue el resumen de la lista.
     */
    const resumen = tarjeta.locator('.resumen-mes');
    for (const grupo of ['Entrarían nuevos', 'Cambiarían', 'Sin cambios', 'Quedarían inactivos']) {
      await expect(resumen.locator('.dato', { hasText: grupo })).toHaveCount(1);
    }
    await expect(resumen.locator('.dato', { hasText: 'Entrarían nuevos' })).toContainText('1');

    // El artículo nuevo aparece al desplegar el grupo, y todavía no está en la base.
    await tarjeta.locator('summary').filter({ hasText: 'Nuevos' }).click();
    await expect(tarjeta.getByText('Provolone de prueba')).toBeVisible();

    expect(await loQueEsDeCompras()).toEqual(antes);
    await conPrisma(async (prisma) => {
      expect(await prisma.product.findUnique({ where: { internalCode: '4001' } })).toBeNull();
    });
  });

  test('confirmar aplica, y la segunda sincronización no propone nada', async ({ page }) => {
    const antes = await loQueEsDeCompras();

    await ingresar(page, 'admin');
    await page.goto('/configuracion/catalogo');
    const tarjeta = page.locator('.card').filter({
      has: page.getByRole('heading', { name: 'Sincronizar con Control de Stock' }),
    });

    await tarjeta.getByRole('button', { name: 'Consultar a Control de Stock' }).click();
    await expect(tarjeta.getByRole('button', { name: 'Confirmar y aplicar' })).toBeVisible();
    await tarjeta.getByRole('button', { name: 'Confirmar y aplicar' }).click();
    await expect(tarjeta.getByText(/Catálogo sincronizado/)).toBeVisible();

    // El artículo nuevo quedó, con su clasificación.
    await conPrisma(async (prisma) => {
      const nuevo = await prisma.product.findUniqueOrThrow({
        where: { internalCode: '4001' },
        include: { family: true, defaultSupplier: true },
      });
      expect(nuevo.normalizedName).toBe('Provolone de prueba');
      expect(nuevo.family?.name).toBe('Duros');
      expect(nuevo.defaultSupplier?.tradeName).toBe('Distribución Errecalde');
      expect(nuevo.active).toBe(true);
    });

    /*
     * Y nada de lo que es de Compras se movió: ni un marcaje, ni una compra, ni
     * un costo, ni una asociación de código de proveedor.
     */
    const despues = await loQueEsDeCompras();
    expect(despues.movimientos).toBe(antes.movimientos);
    expect(despues.costos).toBe(antes.costos);
    expect(despues.alias).toBe(antes.alias);
    for (const anterior of antes.productos) {
      expect(despues.productos).toContain(anterior);
    }

    /*
     * La segunda sincronización, con el mismo catálogo del otro lado, no
     * propone ni un cambio. Es lo que dice que lo aplicado es lo que se miró:
     * si siguiera proponiendo, cada corrida estaría reescribiendo las mismas
     * filas para siempre.
     */
    await page.reload();
    const segunda = page.locator('.card').filter({
      has: page.getByRole('heading', { name: 'Sincronizar con Control de Stock' }),
    });
    await segunda.getByRole('button', { name: 'Consultar a Control de Stock' }).click();
    await expect(
      segunda.getByText('El catálogo de Compras ya coincide con el de Control de Stock'),
    ).toBeVisible();
    await expect(segunda.getByRole('button', { name: 'Confirmar y aplicar' })).toHaveCount(0);
  });

  test('un cambio del maestro se ve con el antes y el después', async ({ page }) => {
    // El artículo tiene que existir para que el cambio sea una modificación.
    await conPrisma(async (prisma) => {
      const existe = await prisma.product.findUnique({ where: { internalCode: '4001' } });
      if (!existe) {
        await prisma.product.create({
          data: { internalCode: '4001', normalizedName: 'Provolone de prueba', purchaseUnit: 'KG' },
        });
      }
    });
    await servirVariante(2);

    await ingresar(page, 'admin');
    await page.goto('/configuracion/catalogo');
    const tarjeta = page.locator('.card').filter({
      has: page.getByRole('heading', { name: 'Sincronizar con Control de Stock' }),
    });
    await tarjeta.getByRole('button', { name: 'Consultar a Control de Stock' }).click();

    await tarjeta.locator('summary').filter({ hasText: 'Modificados' }).click();

    /*
     * De qué a qué, campo por campo.
     *
     * Que diga "cambia" no alcanza para decidir: obligaría a abrir el artículo
     * para saber qué se está por pisar, que es justo lo que la vista previa
     * viene a evitar.
     */
    const cambios = tarjeta.locator('.lista-simple li');
    await expect(cambios.filter({ hasText: 'Nombre:' })).toContainText(
      'Provolone de prueba → Provolone de prueba renombrado',
    );
    await expect(cambios.filter({ hasText: 'Unidad de compra:' })).toContainText('KG → UNIT');

    await servirVariante(1);
  });

  test('un operador no sincroniza el catálogo', async ({ page }) => {
    await ingresar(page, 'operador');
    await page.goto('/configuracion/catalogo');
    await expect(
      page.getByRole('heading', { name: 'Sincronizar con Control de Stock' }),
    ).toHaveCount(0);
  });

  test('entra en la pantalla del teléfono sin desbordarse', async ({ page }, testInfo) => {
    soloEnIphone(test, testInfo.project.name);
    await ingresar(page, 'admin');
    await page.goto('/configuracion/catalogo');
    const tarjeta = page.locator('.card').filter({
      has: page.getByRole('heading', { name: 'Sincronizar con Control de Stock' }),
    });
    await tarjeta.getByRole('button', { name: /Consultar a Control de Stock|Volver a consultar/ }).click();
    await expect(tarjeta.locator('.resumen-mes .dato', { hasText: 'Sin cambios' })).toBeVisible();
    await sinScrollHorizontal(page);
  });
});
