import { test, expect } from '@playwright/test';
import { ingresar } from './ayudas';

/**
 * La vista previa de la compra, abierta como la abre una persona.
 *
 * Lo que se comprueba acá no es el cálculo —de eso se ocupan las pruebas de
 * integración— sino que la pantalla exista, se llegue desde el comprobante y
 * muestre separadas las dos cosas que se van a escribir: el egreso que se paga
 * y la mercadería que entra.
 */
const MINUTOS = 60_000;
test.describe.configure({ timeout: 4 * MINUTOS });

test.describe('la vista previa de la compra', () => {
  test('se abre desde el comprobante y separa el egreso del stock', async ({ page }) => {
    await ingresar(page, 'admin');

    // Se llega como se llega: el listado de comprobantes y uno de ellos.
    await page.goto('/comprobantes');
    await page.locator('a.fila-dato').first().click();
    await expect(page).toHaveURL(/\/comprobantes\/[^/]+$/);

    const id = page.url().split('/').pop();
    await page.goto(`/comprobantes/${id}/vista-previa`);

    await expect(page.getByRole('heading', { name: 'Vista previa de la compra' })).toBeVisible();
    await expect(page.getByText('Nada de lo que se ve acá está guardado')).toBeVisible();

    // Las dos escrituras, cada una en su recuadro.
    await expect(page.getByRole('heading', { name: 'Egreso' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Movimiento de stock' })).toBeVisible();

    // Y el emisor, los renglones y el pie.
    await expect(page.getByRole('heading', { name: 'Emisor' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Renglones' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Pie fiscal' })).toBeVisible();
  });

  test('un comprobante ya validado no se puede volver a aplicar', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/comprobantes');
    await page.locator('a.fila-dato').first().click();
    // Hay que esperar a que la navegación termine: si no, el id que se lee es el
    // de la pantalla anterior y la vista previa se pide de un comprobante que no
    // existe.
    await expect(page).toHaveURL(/\/comprobantes\/[^/]+$/);
    const id = page.url().split('/').pop();

    await page.goto(`/comprobantes/${id}/vista-previa`);
    await expect(page.getByRole('button', { name: 'Aplicar la compra' })).toBeDisabled();
  });
});
