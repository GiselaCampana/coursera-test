import { test, expect } from '@playwright/test';
import { facturaLosCalvosJpeg } from './factura-imagen';
import { ingresar } from './ayudas';

/**
 * Diagnóstico de la lectura en el navegador.
 *
 * No comprueba resultados: registra todo lo que hace la página —consola,
 * errores, peticiones fallidas y en qué etapa se quedó— para poder ver dónde se
 * traba la lectura cuando se traba. Se corre a mano:
 *
 *   npx playwright test --project=iphone diagnostico.spec.ts
 */
test.describe.configure({ timeout: 240_000 });

test('registra qué hace el lector paso a paso', async ({ page }) => {
  page.on('console', (m) => console.log(`[consola:${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => console.log(`[error de página] ${e.message}`));
  page.on('requestfailed', (r) =>
    console.log(`[petición fallida] ${r.url()} — ${r.failure()?.errorText}`),
  );
  page.on('response', (r) => {
    if (r.url().includes('/ocr/') || r.url().includes('/api/')) {
      console.log(`[respuesta] ${r.status()} ${r.url()}`);
    }
  });

  await ingresar(page, 'admin');
  await page.goto('/nueva-compra');

  const galeria = page.locator('input[type="file"]').nth(1);
  await galeria.setInputFiles([
    { name: 'factura.jpg', mimeType: 'image/jpeg', buffer: await facturaLosCalvosJpeg() },
  ]);
  await expect(page.locator('.miniatura')).toHaveCount(1);

  await page.getByRole('button', { name: 'Leer el comprobante' }).click();

  // Se mira el progreso cada diez segundos durante tres minutos.
  for (let i = 0; i < 18; i++) {
    await page.waitForTimeout(10_000);
    const encabezado = await page.getByRole('heading', { level: 1 }).textContent();
    const activa = await page.locator('.progreso-paso.activo').allTextContents();
    const errores = await page.locator('.mensaje-error').allTextContents();
    console.log(
      `[${(i + 1) * 10}s] h1="${encabezado}" etapa=${JSON.stringify(activa)} errores=${JSON.stringify(errores)}`,
    );
    if (encabezado?.includes('Revisar')) break;
  }
});
