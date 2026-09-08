import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { ingresar, sinScrollHorizontal } from './ayudas';
import { limpiarPreciosAprobados } from './entorno';

test.describe('precios por kilo', () => {
  test('muestra costos y venta por kilo, permite configurar marcaje y exporta', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/precios');

    await expect(page.getByRole('heading', { level: 1, name: 'Precios' })).toBeVisible();
    await expect(page.getByText('Último costo por kilo').first()).toBeVisible();
    await expect(page.getByText('Por kilo').first()).toBeVisible();
    await expect(page.getByText(/precio expresado por kilo/i).first()).toBeVisible();

    await page.getByRole('button', { name: 'Configurar marcajes y venta' }).first().click();
    await expect(page.getByLabel('Por kilo · marcaje base (%)').first()).toBeVisible();
    await expect(page.getByLabel('Modo de venta').first()).toBeVisible();
    await expect(page.getByLabel('Cómo lo compra Don Ginés').first()).toBeVisible();

    await expect(page.getByRole('link', { name: 'PDF para empleados' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'PDF completo' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Excel completo' })).toBeVisible();

    // Se prueba como lo usa una persona: tocando el enlace desde la página.
    // Así el navegador manda la misma sesión que usa la interfaz.
    const [pdfDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: 'PDF para empleados' }).click(),
    ]);
    expect(pdfDownload.suggestedFilename()).toMatch(/\.pdf$/i);
    const pdfPath = await pdfDownload.path();
    expect(pdfPath).not.toBeNull();
    const pdf = await readFile(pdfPath!);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');

    const [xlsxDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: 'Excel completo' }).click(),
    ]);
    expect(xlsxDownload.suggestedFilename()).toMatch(/\.xlsx$/i);
    const xlsxPath = await xlsxDownload.path();
    expect(xlsxPath).not.toBeNull();
    const xlsx = await readFile(xlsxPath!);
    expect(xlsx.subarray(0, 2).toString()).toBe('PK');

    await sinScrollHorizontal(page);
  });
});

/**
 * Fijarle precio a un artículo que se vende entero, desde la pantalla.
 *
 * Es la mitad que ninguna prueba de integración cubre: que el formulario
 * aparezca, que diga «por unidad» y no «por kilo», y que el precio quede
 * aprobado con sus centavos. Antes ni siquiera se mostraba, así que un maple
 * podía tener costo y sugerencia y no había forma de confirmarle un precio.
 *
 * Corre en los dos proyectos, teléfono y escritorio: la aprobación se hace
 * desde el mostrador con el teléfono en la mano, así que si el formulario no
 * entra en esa pantalla no sirve.
 */
test.describe('precio por unidad', () => {
  /*
   * Los dos proyectos corren contra la misma base, uno después del otro. Sin
   * esto la prueba pasa en el teléfono y falla en el escritorio porque el
   * precio ya está aprobado: lo aprobó ella misma en la corrida anterior.
   */
  test.beforeEach(async () => {
    await limpiarPreciosAprobados('3001');
  });

  test.afterAll(async () => {
    await limpiarPreciosAprobados('3001');
  });

  test('muestra el precio por unidad y deja aprobarlo', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/precios');

    const fila = page.locator('li.fila-dato').filter({ hasText: 'Maple de huevos' });
    await expect(fila).toHaveCount(1);

    // Se muestra por unidad, no por kilo: $1.500 × 1,45 = $2.175.
    await expect(fila.getByText('Precio por unidad')).toBeVisible();
    await expect(fila.getByText('$ 2.175,00').first()).toBeVisible();

    // Y todavía no hay ninguno aprobado.
    await expect(fila.getByText('Precio aprobado por unidad')).toHaveCount(0);

    await fila.getByRole('button', { name: 'Aprobar el precio' }).click();
    // La etiqueta dice la unidad correcta: decir «por kilo» sobre un maple
    // sería decirle a quien aprueba que un maple pesa un kilo.
    const campo = fila.getByLabel(/Precio por unidad para Maple de huevos/);
    await expect(campo).toBeVisible();
    await expect(campo).toHaveValue('2175.00');

    // Se cambia por uno con centavos, para ver que no se redondea al $100.
    await campo.fill('2337.04');
    await fila.getByRole('button', { name: 'Aprobar' }).click();

    await expect(fila.getByText('Precio aprobado y guardado en el historial.')).toBeVisible();

    await page.reload();
    const despues = page.locator('li.fila-dato').filter({ hasText: 'Maple de huevos' });
    await expect(despues.getByText('Precio aprobado por unidad')).toBeVisible();
    await expect(despues.getByText('$ 2.337,04')).toBeVisible();

    await sinScrollHorizontal(page);
  });
});
