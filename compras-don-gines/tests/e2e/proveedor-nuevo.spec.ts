import { test, expect } from '@playwright/test';
import { facturaLosCalvosJpeg, PROVEEDOR_DESCONOCIDO } from './factura-imagen';
import { ingresar, soloEnIphone } from './ayudas';
import { cargarEntornoE2E, limpiarComprobantesLeidos } from './entorno';

/**
 * La factura de un proveedor que todavía no está cargado.
 *
 * Lo que se prueba es que no haya que abandonar el comprobante: la foto ya
 * está subida y la lectura ya corrió, así que mandar a Configuración →
 * Proveedores en ese momento tira el trabajo hecho. El alta tiene que poder
 * salir desde la misma pantalla de revisión.
 */
const MINUTOS = 60_000;
test.describe.configure({ timeout: 6 * MINUTOS });

/** Borra el proveedor que deja esta prueba, para no ensuciar a las demás. */
async function borrarProveedorDePrueba() {
  cargarEntornoE2E();
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const creados = await prisma.supplier.findMany({
      where: { tradeName: { contains: 'Fiambres del Oeste' } },
      select: { id: true },
    });
    const ids = creados.map((s) => s.id);
    if (ids.length === 0) return;
    await prisma.supplierAlias.deleteMany({ where: { supplierId: { in: ids } } });
    await prisma.supplier.deleteMany({ where: { id: { in: ids } } });
  } finally {
    await prisma.$disconnect();
  }
}

/** Cuántos proveedores hay con ese nombre. Cero, uno, o el problema. */
async function contarProveedores(nombre: string): Promise<number> {
  cargarEntornoE2E();
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    return await prisma.supplier.count({ where: { tradeName: nombre } });
  } finally {
    await prisma.$disconnect();
  }
}

test.describe('proveedor nuevo durante la carga de una factura', () => {
  test.afterAll(async () => {
    await limpiarComprobantesLeidos();
    await borrarProveedorDePrueba();
  });

  test('se lo da de alta desde la revisión, sin perder la lectura', async ({ page }, testInfo) => {
    soloEnIphone(test, testInfo.project.name);

    await ingresar(page, 'admin');
    await page.goto('/nueva-compra');

    const imagen = await facturaLosCalvosJpeg({
      emisor: PROVEEDOR_DESCONOCIDO,
      // Un número que no choque con la factura ya sembrada.
      numero: '00990011',
    });
    await page.locator('input[type="file"]').nth(1).setInputFiles([
      { name: 'factura-desconocido.jpg', mimeType: 'image/jpeg', buffer: imagen },
    ]);
    await expect(page.locator('.miniatura')).toHaveCount(1);
    await page.getByRole('button', { name: 'Leer el comprobante' }).click();
    await expect(page.getByRole('heading', { name: 'Revisar los datos' })).toBeVisible({
      timeout: 5 * MINUTOS,
    });

    /*
     * La pantalla lo dice con todas las letras. Sin este aviso, el desplegable
     * de proveedor aparece vacío y no hay forma de distinguir "el OCR no lo
     * reconoció" de "este proveedor no existe todavía".
     */
    const aviso = page.locator('.card', { hasText: 'Proveedor nuevo' });
    await expect(aviso.getByRole('heading', { name: 'Proveedor nuevo' })).toBeVisible();
    await expect(aviso).toContainText(/FIAMBRES DEL OESTE/i);

    // Los renglones ya están leídos: es lo que se pierde si hay que salir.
    const renglones = page.locator('ul.lista > li.fila-dato');
    const leidos = await renglones.count();
    expect(leidos).toBeGreaterThan(0);

    await aviso.getByRole('button', { name: 'Crear proveedor y continuar' }).click();

    // El nombre viene cargado con lo que se leyó, y se puede corregir: el OCR
    // pega el "FACTURA" del margen derecho en la misma línea.
    const nombre = page.getByLabel('Nombre del proveedor');
    await expect(nombre).toBeEditable();
    await nombre.fill('Fiambres del Oeste S.R.L.');

    await page
      .locator('.card', { hasText: 'Proveedor nuevo' })
      .getByRole('button', { name: 'Crear proveedor y continuar' })
      .click();

    // Queda elegido en el comprobante, sin haber salido de la pantalla.
    const select = page.locator('#proveedor');
    await expect(select).toHaveValue(/.+/, { timeout: 30_000 });
    await expect(select.locator('option:checked')).toHaveText('Fiambres del Oeste S.R.L.');

    // Y el aviso desaparece: ya no hay un proveedor sin cargar.
    await expect(page.locator('.card', { hasText: 'Proveedor nuevo' })).toHaveCount(0);

    // La lectura sigue estando, renglón por renglón: el alta no rehízo nada.
    await expect(renglones).toHaveCount(leidos);

    // Una sola ficha, no dos.
    expect(await contarProveedores('Fiambres del Oeste S.R.L.')).toBe(1);
  });
});
