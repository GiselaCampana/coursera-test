import { test, expect } from '@playwright/test';
import { ingresar, sinScrollHorizontal, soloEnIphone } from './ayudas';
import { cargarEntornoE2E } from './entorno';

/**
 * Configurar el marcaje de una familia desde la pantalla.
 *
 * Lo que se controla acá es lo que hace que la función sirva: que guardar el
 * marcaje de la familia **no toque ningún artículo**. Escribirlo dentro de cada
 * PLU sería lo contrario de lo que la familia viene a resolver, y además
 * borraría para siempre cuáles lo tenían propio.
 */

/** Los marcajes que tiene guardado cada artículo, y los de la familia. */
async function comoEstan() {
  cargarEntornoE2E();
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const productos = await prisma.product.findMany({
      orderBy: { internalCode: 'asc' },
      select: { internalCode: true, targetMarginPct: true, familyId: true },
    });
    const familias = await prisma.productFamily.findMany({
      orderBy: { name: 'asc' },
      select: { name: true, targetMarginPct: true },
    });
    return {
      productos: productos.map((p) => `${p.internalCode}:${p.targetMarginPct ?? 'hereda'}`),
      familias: familias.map((f) => `${f.name}:${f.targetMarginPct ?? 'nada'}`),
    };
  } finally {
    await prisma.$disconnect();
  }
}

/** Deja la familia sin marcajes, para que la prueba pueda repetirse. */
async function limpiarMarcajesDeFamilias() {
  cargarEntornoE2E();
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    await prisma.productFamily.updateMany({ data: { targetMarginPct: null } });
  } finally {
    await prisma.$disconnect();
  }
}

test.describe('marcajes por familia', () => {
  test.afterAll(async () => {
    await limpiarMarcajesDeFamilias();
  });

  test('se llega desde el catálogo y dice cuántos artículos dependen', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/configuracion/catalogo');

    await expect(page.getByRole('heading', { name: 'Marcajes por familia' })).toBeVisible();
    const familia = page.locator('li', { hasText: 'Quesos' }).first();
    await expect(familia).toContainText('artículo');
    // El número que hace falta antes de tocar nada.
    await expect(familia).toContainText(/heredan el base|Ningún artículo hereda el base/);
  });

  test('guardar el marcaje de la familia no toca ningún artículo', async ({ page }) => {
    const antes = await comoEstan();

    await ingresar(page, 'admin');
    await page.goto('/configuracion/catalogo');

    const familia = page.locator('li', { hasText: 'Quesos' }).first();
    await familia.getByRole('button', { name: 'Configurar marcajes' }).click();

    // El formulario avisa a cuántos artículos va a afectar antes de guardar.
    await expect(page.getByText(/Lo que dejes vacío no se aplica/)).toBeVisible();

    await page.getByLabel('Marcaje base de la familia (%)').fill('52');
    await page.getByRole('button', { name: 'Guardar los marcajes de la familia' }).click();
    await expect(page.getByText('Marcajes de la familia actualizados.')).toBeVisible();

    const despues = await comoEstan();
    /*
     * Los artículos quedan exactamente como estaban: el que tenía su marcaje lo
     * conserva y el que heredaba sigue heredando. Lo único que cambió es la
     * familia.
     */
    expect(despues.productos).toEqual(antes.productos);
    expect(despues.familias).toContain('Quesos:0.52');
  });

  test('un operador no configura marcajes de familia', async ({ page }) => {
    await ingresar(page, 'operador');
    await page.goto('/configuracion/catalogo');
    await expect(page.getByRole('heading', { name: 'Marcajes por familia' })).toHaveCount(0);
  });

  test('entra en la pantalla del teléfono sin desbordarse', async ({ page }, testInfo) => {
    soloEnIphone(test, testInfo.project.name);
    await ingresar(page, 'admin');
    await page.goto('/configuracion/catalogo');
    await expect(page.getByRole('heading', { name: 'Marcajes por familia' })).toBeVisible();
    await sinScrollHorizontal(page);
  });
});
