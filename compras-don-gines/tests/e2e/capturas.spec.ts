import { test } from '@playwright/test';
import { ingresar } from './ayudas';

/**
 * Captura las pantallas principales para revisarlas a ojo.
 * No es una prueba de regresión: se corre a mano con
 *   npx playwright test capturas --project=iphone
 */
test.describe('capturas', () => {
  test.skip(!process.env.CAPTURAS, 'Se corre a mano con CAPTURAS=1.');

  test('pantallas principales', async ({ page }) => {
    await page.goto('/ingresar');
    await page.screenshot({ path: 'capturas/01-ingreso.png', fullPage: true });

    await ingresar(page, 'admin');
    await page.screenshot({ path: 'capturas/02-inicio.png', fullPage: true });

    await page.goto('/nueva-compra');
    await page.screenshot({ path: 'capturas/03-nueva-compra.png', fullPage: true });

    await page.goto('/comprobantes');
    await page.screenshot({ path: 'capturas/04-comprobantes.png', fullPage: true });

    await page.locator('a.fila-dato', { hasText: '0010-00212356' }).click();
    await page.screenshot({ path: 'capturas/05-detalle.png', fullPage: true });

    await page.goto('/pagos?grupo=proximos');
    await page.screenshot({ path: 'capturas/06-pagos.png', fullPage: true });

    await page.goto('/precios');
    await page.screenshot({ path: 'capturas/07-precios.png', fullPage: true });

    await page.goto('/configuracion');
    await page.screenshot({ path: 'capturas/08-configuracion.png', fullPage: true });
  });
});
