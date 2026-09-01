import { test, expect } from '@playwright/test';
import { ingresar, sinScrollHorizontal, soloEnIphone } from './ayudas';
import { cargarEntornoE2E } from './entorno';

/**
 * La pantalla de auditoría de atribución.
 *
 * Lo que se controla acá es lo que la hace confiable: que **no escriba nada**.
 * Los veredictos y la evidencia se prueban en la integración, que es donde se
 * puede armar el escenario; acá importa que entrar, mirar y volver a mirar deje
 * la base exactamente como estaba.
 */

/** Cuántas filas hay de cada cosa que una corrección podría llegar a tocar. */
async function retrato() {
  cargarEntornoE2E();
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const [documentos, movimientos, costos, agendas, alias, proveedores] = await Promise.all([
      prisma.document.count(),
      prisma.purchaseMovement.count(),
      prisma.costHistory.count(),
      prisma.paymentSchedule.count(),
      prisma.productAlias.count(),
      prisma.supplier.count(),
    ]);
    const porProveedor = await prisma.document.groupBy({
      by: ['supplierId'],
      _count: { _all: true },
    });
    return JSON.stringify({
      documentos,
      movimientos,
      costos,
      agendas,
      alias,
      proveedores,
      porProveedor: porProveedor.map((p) => `${p.supplierId}:${p._count._all}`).sort(),
    });
  } finally {
    await prisma.$disconnect();
  }
}

test.describe('auditoría de atribución', () => {
  test('se llega desde Configuración y dice que no modifica nada', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/configuracion');

    await page.getByRole('link', { name: 'Auditoría de atribución' }).click();
    await expect(page.getByRole('heading', { name: 'Auditoría de atribución' })).toBeVisible();
    await expect(page.getByText('Esto no modifica nada')).toBeVisible();

    // Sin proveedor elegido no se revisa nada: la revisión es de a uno.
    await expect(page.getByText('Elegí un proveedor')).toBeVisible();
  });

  test('revisar un proveedor no escribe una sola fila', async ({ page }) => {
    const antes = await retrato();

    await ingresar(page, 'admin');
    await page.goto('/configuracion/proveedores/auditoria');
    await page.getByRole('link', { name: 'Los Calvos', exact: true }).click();

    // El informe salió: los cuatro grupos están, con su cuenta.
    await expect(page.getByRole('heading', { name: 'Los Calvos' })).toBeVisible();
    for (const grupo of [
      'Correctamente asignados',
      'Sospechosos',
      'Confirmadamente de otro proveedor',
      'Sin evidencia suficiente',
    ]) {
      await expect(page.getByText(grupo, { exact: true }).first()).toBeVisible();
    }

    // Y volver a mirarlo tampoco.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Los Calvos' })).toBeVisible();

    expect(await retrato()).toBe(antes);
  });

  test('un operador no llega a esta pantalla', async ({ page }) => {
    await ingresar(page, 'operador');
    await page.goto('/configuracion/proveedores/auditoria');
    await expect(page.getByRole('heading', { name: 'Auditoría de atribución' })).toHaveCount(0);
  });

  test('entra en la pantalla del teléfono sin desbordarse', async ({ page }, testInfo) => {
    soloEnIphone(test, testInfo.project.name);
    await ingresar(page, 'admin');
    await page.goto('/configuracion/proveedores/auditoria');
    await page.getByRole('link', { name: 'Los Calvos', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Los Calvos' })).toBeVisible();
    await sinScrollHorizontal(page);
  });
});
