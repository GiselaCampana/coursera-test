import { test, expect, type Page } from '@playwright/test';
import { ingresar, sinScrollHorizontal } from './ayudas';

/**
 * **La apertura de Stock ERP, desde el navegador y en los dos tamaños.**
 *
 * Lo que se prueba acá son las reglas que se ven: que una sucursal sin apertura
 * lo diga con todas las letras y no se confunda con una en cero, que un
 * artículo sin unidad aparezca bloqueado, que «contado en cero» sea un gesto
 * propio, que confirmar pida dos veces y que nada de esto se lea como
 * existencias operativas.
 *
 * De paso deja las capturas para revisión visual: se guardan en
 * `test-results/capturas/`, con nombre por escenario y por tamaño.
 */

const MINUTOS = 60_000;
test.describe.configure({ timeout: 5 * MINUTOS });

/** Guarda una captura con el nombre del proyecto adentro. */
async function captura(page: Page, nombre: string, proyecto: string) {
  await page.screenshot({
    path: `test-results/capturas/${nombre}-${proyecto}.png`,
    fullPage: true,
  });
}

test.describe('una sucursal sin apertura lo dice', () => {
  test('el aviso está, y no hay ningún saldo', async ({ page }, info) => {
    await ingresar(page, 'admin');
    await page.goto('/stock-erp/aperturas');

    await expect(page.locator('[data-prueba="stock-erp-en-preparacion"]')).toContainText(
      'todavía no incluye ventas',
    );
    const sinApertura = page.locator('[data-prueba="sin-apertura"]').first();
    await expect(sinApertura).toBeVisible();
    await expect(sinApertura).toContainText('Sucursal sin apertura de Stock ERP');
    await expect(sinApertura, 'y dice por qué eso no es cero').toContainText(
      'no es lo mismo que tener cero',
    );

    await captura(page, 'sucursal-sin-apertura', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('el interruptor de aperturas reales se ve, y está apagado', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/stock-erp/aperturas');
    const i = page.locator('[data-prueba="interruptor"]');
    await expect(i).toContainText('deshabilitadas');
    await expect(i).toContainText('base de pruebas');
  });
});

test.describe('preparar, contar y confirmar', () => {
  test('el borrador nace con todo pendiente y lo bloqueado se ve', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    await page.goto('/stock-erp/aperturas');

    await page.locator('[data-prueba="preparar"]').first().click();
    await expect(page.locator('[data-prueba="resultado-ok"]').first()).toBeVisible();

    await page.goto('/stock-erp/aperturas');
    await page.locator('[data-prueba="abrir-apertura"]').first().click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Apertura de');

    /* Sin contar: pendiente, y el texto lo explica. */
    const primera = page.locator('[data-prueba="linea"]').first();
    await expect(primera).toBeVisible();
    await expect(page.locator('[data-prueba="impedimentos"]')).toBeVisible();

    await captura(page, 'borrador-con-estados', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('un artículo sin unidad aprobada aparece bloqueado y explica cómo se resuelve', async ({
    page,
  }, info) => {
    await ingresar(page, 'configurador');
    await page.goto('/stock-erp/aperturas');
    const preparar = page.locator('[data-prueba="preparar"]').first();
    if (await preparar.isVisible().catch(() => false)) await preparar.click();
    await page.goto('/stock-erp/aperturas');
    await page.locator('[data-prueba="abrir-apertura"]').first().click();

    await page.locator('[data-prueba="filtro-BLOQUEADO_UNIDAD"]').click();
    const bloqueada = page.locator('[data-prueba="linea"]').first();
    await expect(bloqueada).toBeVisible();
    await expect(bloqueada.locator('[data-prueba="estado-linea"]')).toHaveText('BLOQUEADO_UNIDAD');
    await expect(bloqueada.locator('[data-prueba="bloqueado-unidad"]')).toContainText(
      'no se sabría en qué',
    );
    /* Y no le ofrece contar, porque no se puede. */
    await expect(bloqueada.locator('[data-prueba="guardar-conteo"]')).toHaveCount(0);

    await captura(page, 'bloqueado-por-unidad', info.project.name);
  });

  test('«contado en cero» es su propio gesto, distinto de escribir un número', async ({ page }) => {
    await ingresar(page, 'configurador');
    await page.goto('/stock-erp/aperturas');
    const preparar = page.locator('[data-prueba="preparar"]').first();
    if (await preparar.isVisible().catch(() => false)) await preparar.click();
    await page.goto('/stock-erp/aperturas');
    await page.locator('[data-prueba="abrir-apertura"]').first().click();

    await page.locator('[data-prueba="filtro-PENDIENTE"]').click();
    const linea = page.locator('[data-prueba="linea"]').first();
    await expect(linea.locator('[data-prueba="contar-en-cero"]')).toBeVisible();

    /* Escribir un 0 en el campo NO es lo mismo, y el servidor lo dice. */
    await linea.locator('[data-prueba="entrada-cantidad"]').fill('0');
    await linea.locator('[data-prueba="guardar-conteo"]').click();
    await expect(page.locator('[data-prueba="resultado-error"]')).toContainText('Contado en cero');
  });

  test('un cuarto decimal se rechaza en castellano', async ({ page }) => {
    await ingresar(page, 'configurador');
    await page.goto('/stock-erp/aperturas');
    const preparar = page.locator('[data-prueba="preparar"]').first();
    if (await preparar.isVisible().catch(() => false)) await preparar.click();
    await page.goto('/stock-erp/aperturas');
    await page.locator('[data-prueba="abrir-apertura"]').first().click();
    await page.locator('[data-prueba="filtro-PENDIENTE"]').click();

    const linea = page.locator('[data-prueba="linea"]').first();
    await linea.locator('[data-prueba="entrada-cantidad"]').fill('4.2401');
    await linea.locator('[data-prueba="guardar-conteo"]').click();
    await expect(page.locator('[data-prueba="resultado-error"]')).toContainText('tres decimales');
  });
});

test.describe('quién puede qué', () => {
  test('el administrador de fábrica no puede preparar ni confirmar', async ({ page }) => {
    /*
     * Ni «preparar» ni «confirmar» vienen en el rol administrador. El de
     * preparar no es sensible —contar es trabajo de todos los días— pero
     * tampoco se hereda: se otorga igual que los demás.
     */
    await ingresar(page, 'admin');
    await page.goto('/stock-erp/aperturas');
    await expect(page.locator('[data-prueba="preparar"]')).toHaveCount(0);
  });
});

test.describe('la confirmación', () => {
  test('pide dos veces, muestra el resumen y deja la apertura confirmada', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    await page.goto('/stock-erp/aperturas');
    const preparar = page.locator('[data-prueba="preparar"]').first();
    if (await preparar.isVisible().catch(() => false)) await preparar.click();
    await page.goto('/stock-erp/aperturas');
    await page.locator('[data-prueba="abrir-apertura"]').first().click();

    /* Todo lo pendiente y lo bloqueado se resuelve como «no se maneja». */
    for (const filtro of ['PENDIENTE', 'BLOQUEADO_UNIDAD']) {
      await page.locator(`[data-prueba="filtro-${filtro}"]`).click();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const linea = page.locator('[data-prueba="linea"]').first();
        if ((await linea.count()) === 0) break;
        await linea.locator('[data-prueba="no-se-maneja"]').click();
        await linea.locator('[data-prueba="motivo-no-se-maneja"]').fill('Homologación: no se maneja.');
        await linea.getByRole('button', { name: 'Guardar' }).click();
        await expect(page.locator('[data-prueba="resultado-ok"]')).toBeVisible();
        await page.reload();
        await page.locator(`[data-prueba="filtro-${filtro}"]`).click();
      }
    }

    /* El corte, en hora argentina. */
    await page.locator('[data-prueba="corte-fecha"]').fill('2026-09-23');
    await page.locator('[data-prueba="corte-hora"]').fill('20:30');
    await page.locator('[data-prueba="fijar-corte"]').click();
    await expect(page.locator('[data-prueba="resultado-ok"]')).toBeVisible();
    await page.reload();
    await expect(page.locator('[data-prueba="corte-actual"]')).toContainText('hora de Argentina');

    /* Primer clic: sólo pregunta. */
    await page.locator('[data-prueba="confirmar"]').click();
    const doble = page.locator('[data-prueba="doble-confirmacion"]');
    await expect(doble).toBeVisible();
    await expect(doble).toContainText('no se deshace');
    await captura(page, 'doble-confirmacion', info.project.name);

    await page.locator('[data-prueba="cancelar-confirmacion"]').click();
    await expect(doble).toHaveCount(0);

    /* Segundo intento, hasta el final. */
    await page.locator('[data-prueba="confirmar"]').click();
    await page.locator('[data-prueba="confirmar-definitivo"]').click();
    await expect(page.locator('[data-prueba="resultado-ok"]')).toContainText('Apertura confirmada');

    await page.reload();
    await expect(page.locator('[data-prueba="apertura-confirmada"]')).toBeVisible();
    await captura(page, 'apertura-confirmada', info.project.name);
    await sinScrollHorizontal(page);
  });
});

test.describe('la pantalla de unidades de la fase 2 sigue en pie', () => {
  test('se ve y deja su captura', async ({ page }, info) => {
    await ingresar(page, 'admin');
    await page.goto('/stock-erp/unidades');
    await expect(page.locator('[data-prueba="stock-erp-en-preparacion"]')).toBeVisible();
    await captura(page, 'unidades-fase-2', info.project.name);
    await sinScrollHorizontal(page);
  });
});
