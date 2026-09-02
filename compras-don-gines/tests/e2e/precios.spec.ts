import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { ingresar, sinScrollHorizontal } from './ayudas';

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
