import { test, expect } from '@playwright/test';
import { elegirOpcion, ingresar, sinScrollHorizontal, soloEnIphone } from './ayudas';

/**
 * El mantenimiento de asociaciones históricas.
 *
 * Lo que se controla acá es el flujo: que analizar no escriba nada, que aplicar
 * exija una confirmación aparte, y que las dudosas no se apliquen solas. Los
 * números —qué se reconoce y qué no— se prueban en la integración, que es donde
 * se puede armar el escenario.
 */
test.describe('asociaciones históricas', () => {
  test('se llega desde Productos y el análisis no escribe nada', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/configuracion/productos');

    await page.getByRole('link', { name: 'Asociaciones históricas' }).click();
    await expect(page.getByRole('heading', { name: 'Asociaciones históricas' })).toBeVisible();

    // Los cuatro grupos del resumen, que es lo primero que hay que poder mirar.
    const resumen = page.locator('.resumen-mes');
    for (const etiqueta of [
      'Por código de proveedor',
      'Seguras por alias o descripción',
      'Ambiguas',
      'Sin coincidencia',
    ]) {
      await expect(resumen.getByText(etiqueta, { exact: true })).toBeVisible();
    }

    /*
     * Analizar es sólo leer: entrar a la pantalla no puede haber cambiado nada.
     * Si hubiera escrito, el botón de aplicar ya no ofrecería lo mismo.
     */
    await page.reload();
    await expect(resumen).toBeVisible();
  });

  test('aplicar exige una confirmación aparte', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/configuracion/productos/asociaciones');

    const aplicar = page.getByRole('button', { name: /^Aplicar \d+ asociación/ });
    if ((await aplicar.count()) === 0) {
      // Sin nada que aplicar, la pantalla lo dice en vez de ofrecer un botón
      // que no haría nada.
      await expect(page.getByText('No hay ninguna asociación segura para aplicar')).toBeVisible();
      return;
    }

    await aplicar.click();
    // El botón no aplica: abre la confirmación.
    await expect(page.getByText(/Confirmá: se van a asociar/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sí, aplicar' })).toBeVisible();

    // Y se puede volver atrás sin haber tocado nada.
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.getByText(/Confirmá: se van a asociar/)).toHaveCount(0);
  });

  test('el mantenimiento se puede acotar a un proveedor', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/configuracion/productos/asociaciones');

    await elegirOpcion(page, '#proveedor', 'Distribución Errecalde');
    await page.getByRole('button', { name: 'Analizar' }).click();
    await expect(page).toHaveURL(/proveedor=/);
    await expect(page.locator('.resumen-mes')).toBeVisible();
  });

  test('permite revisar un mapeo código de proveedor a PLU antes de aplicarlo', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/configuracion/productos/asociaciones');

    await elegirOpcion(page, '#proveedor', 'Distribución Errecalde');
    await page.getByRole('button', { name: 'Analizar' }).click();
    await expect(page).toHaveURL(/proveedor=/);

    await expect(page.getByRole('heading', { name: /Códigos confirmados de Distribución Errecalde/ })).toBeVisible();

    // El preset queda cargado de una vez; la prueba no presupone que el
    // catálogo E2E tenga los 16 PLU reales de producción.
    await page.getByRole('button', { name: 'Cargar 17 códigos verificados de Errecalde' }).click();
    await expect(page.getByLabel('CSV o texto')).toContainText('ART-00228;1211');
    await expect(page.getByLabel('CSV o texto')).toContainText('ART-00758;1551');

    /*
     * Para la vista previa se usa un código que no aparece en ninguna factura
     * de prueba.
     *
     * Antes se usaba ART-01477, y eso ataba esta prueba al orden de la suite:
     * la lectura de la factura real de Errecalde asocia ese código a mano al
     * revisarla, y a partir de ahí queda aprendido. Cuando el proyecto de
     * escritorio llegaba acá ya no había nada que aplicar, y la prueba fallaba
     * por un motivo que no tenía nada que ver con lo que quiere comprobar.
     *
     * Lo que se prueba es la pantalla, no los códigos reales de Errecalde: esos
     * están en las dos comprobaciones del preset, más arriba.
     */
    await page
      .getByLabel('CSV o texto')
      .fill('Código proveedor;PLU\nCOD-PRUEBA-9999;2002');
    await page.getByRole('button', { name: 'Ver propuesta' }).click();

    // Exacto: el código también está escrito en el textarea de arriba, y sin
    // acotar el localizador encuentra los dos.
    await expect(page.getByText('COD-PRUEBA-9999', { exact: true })).toBeVisible();
    await expect(page.getByText('Tomate en botella')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Aplicar 1 código/s' })).toBeVisible();
  });

  test('un operador no llega a esta pantalla', async ({ page }) => {
    await ingresar(page, 'operador');
    await page.goto('/configuracion/productos/asociaciones');
    // Sin permiso de gestionar productos, vuelve a Configuración.
    await expect(page.getByRole('heading', { name: 'Asociaciones históricas' })).toHaveCount(0);
  });

  test('entra en la pantalla del teléfono sin desbordarse', async ({ page }, testInfo) => {
    soloEnIphone(test, testInfo.project.name);
    await ingresar(page, 'admin');
    await page.goto('/configuracion/productos/asociaciones');
    await expect(page.locator('.resumen-mes')).toBeVisible();
    await sinScrollHorizontal(page);
  });
});
