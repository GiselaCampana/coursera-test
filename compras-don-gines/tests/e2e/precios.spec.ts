import { test, expect } from '@playwright/test';
import { ingresar, sinScrollHorizontal } from './ayudas';

test.describe('precios por kilo', () => {
  test('muestra costos y venta por kilo, permite configurar marcaje y exporta', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/precios');

    await expect(page.getByRole('heading', { level: 1, name: 'Precios' })).toBeVisible();
    await expect(page.getByText('Último costo por kilo').first()).toBeVisible();
    await expect(page.getByText('Precio por kilo sugerido · pago digital').first()).toBeVisible();
    await expect(page.getByText('Precio por kilo · efectivo').first()).toBeVisible();

    await expect(page.getByText('Por 100 g')).toHaveCount(0);
    await expect(page.getByText('Por 1/4 kg')).toHaveCount(0);
    await expect(page.getByText(/Por pieza \(/)).toHaveCount(0);
    await expect(page.getByText(/Por horma \(/)).toHaveCount(0);

    await page.getByRole('button', { name: 'Configurar marcaje y venta' }).first().click();
    await expect(page.getByLabel('Marcaje (%)').first()).toBeVisible();
    await expect(page.getByLabel('Modo de venta').first()).toBeVisible();
    await expect(page.getByLabel('Cómo lo compra Don Ginés').first()).toBeVisible();

    await expect(page.getByRole('link', { name: 'Exportar PDF' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Exportar Excel' })).toBeVisible();

    const pdf = await page.request.get('/api/precios/exportar?formato=pdf');
    if (!pdf.ok()) {
      throw new Error(`Exportar PDF respondió ${pdf.status()}: ${await pdf.text()}`);
    }
    expect(pdf.headers()['content-type']).toContain('application/pdf');
    expect((await pdf.body()).subarray(0, 4).toString()).toBe('%PDF');

    const xlsx = await page.request.get('/api/precios/exportar?formato=xlsx');
    if (!xlsx.ok()) {
      throw new Error(`Exportar Excel respondió ${xlsx.status()}: ${await xlsx.text()}`);
    }
    expect(xlsx.headers()['content-type']).toContain('spreadsheetml');
    expect((await xlsx.body()).subarray(0, 2).toString()).toBe('PK');

    await sinScrollHorizontal(page);
  });
});
