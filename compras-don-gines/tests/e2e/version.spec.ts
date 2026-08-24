import { test, expect } from '@playwright/test';
import { facturaLosCalvosJpeg } from './factura-imagen';
import { ingresar, sinScrollHorizontal, soloEnIphone } from './ayudas';
import { limpiarComprobantesLeidos } from './entorno';

/**
 * Qué versión está corriendo, y qué versión produjo lo que se está mirando.
 *
 * Esto existe por un episodio concreto: una corrección desplegada, un
 * comprobante que seguía mostrando los números viejos, y ninguna forma de saber
 * desde el teléfono si el problema era que el despliegue no había llegado, que
 * la corrección no servía, o que lo que se veía era un resultado guardado antes.
 * Las tres cosas se ven igual en la pantalla. Estas pruebas cubren lo que hace
 * que dejen de verse igual.
 */
const MINUTOS = 60_000;
test.describe.configure({ timeout: 8 * MINUTOS });

test.describe('la versión en ejecución está a la vista', () => {
  test('el diagnóstico muestra el commit que está corriendo', async ({ page }) => {
    await ingresar(page, 'admin');

    // Se llega como llega el usuario: Más → Diagnóstico de lectura.
    await page.goto('/mas');
    await page.getByRole('link', { name: 'Diagnóstico de lectura' }).click();
    await expect(page.getByRole('heading', { name: 'Diagnóstico de lectura' })).toBeVisible();

    const tarjeta = page.locator('.card', { hasText: 'Versión en ejecución' });
    await expect(tarjeta).toBeVisible();

    // Un SHA corto de verdad, no un texto de relleno.
    const commit = tarjeta.locator('.dato', { hasText: 'Commit' }).locator('dd');
    await expect(commit).toHaveText(/^[0-9a-f]{7}$/);

    await sinScrollHorizontal(page);
  });

  test('la API dice lo mismo que la pantalla', async ({ page, request }) => {
    // Sirve para preguntarle a la aplicación qué versión es sin entrar: es la
    // única forma de averiguarlo cuando el alojamiento no da consola.
    const respuesta = await request.get('/api/version');
    expect(respuesta.ok()).toBe(true);
    const cuerpo = await respuesta.json();
    expect(cuerpo.commitCorto).toMatch(/^[0-9a-f]{7}$/);
    expect(cuerpo.commit).toMatch(/^[0-9a-f]{40}$/);

    await ingresar(page, 'admin');
    await page.goto('/diagnostico');
    const commit = page
      .locator('.card', { hasText: 'Versión en ejecución' })
      .locator('.dato', { hasText: 'Commit' })
      .locator('dd');
    await expect(commit).toHaveText(cuerpo.commitCorto);
  });
});

test.describe('volver a leer parte de la imagen guardada', () => {
  test.afterAll(async () => {
    await limpiarComprobantesLeidos();
  });

  test('reprocesa el comprobante sin pedir la foto de nuevo', async ({ page }, testInfo) => {
    soloEnIphone(test, testInfo.project.name);

    await ingresar(page, 'admin');
    await page.goto('/nueva-compra');

    // Una factura cuyo total impreso no coincide con el detalle: queda en rojo,
    // que es cuando aparece la opción de volver a leer.
    const galeria = page.locator('input[type="file"]').nth(1);
    await galeria.setInputFiles([
      {
        name: 'factura.jpg',
        mimeType: 'image/jpeg',
        buffer: await facturaLosCalvosJpeg({ totalAlterado: true }),
      },
    ]);
    await page.getByRole('button', { name: 'Leer el comprobante' }).click();
    await expect(page.getByRole('heading', { name: 'Revisar los datos' })).toBeVisible({
      timeout: 7 * MINUTOS,
    });
    await expect(page.locator('.semaforo-error')).toBeVisible();

    /*
     * Y ahora la parte que importa: volver a leer no vuelve a pedir la foto.
     *
     * Si el botón llevara al paso 1 con el selector de archivos vacío, "volver a
     * leer" sería en realidad "cargá todo de nuevo", y quien está en el mostrador
     * con el teléfono en la mano no lo haría. Tiene que arrancar solo, desde la
     * imagen que ya está guardada en el comprobante.
     */
    await page.getByRole('button', { name: 'Volver a leer esta imagen' }).click();

    // Arranca a trabajar sin pasar por el selector de archivos.
    await expect(page.getByText(/Preparando|Leyendo|Verificando/).first()).toBeVisible({
      timeout: 3 * MINUTOS,
    });

    // Y vuelve a la revisión con el resultado de esta lectura.
    await expect(page.getByRole('heading', { name: 'Revisar los datos' })).toBeVisible({
      timeout: 7 * MINUTOS,
    });
    await expect(page.locator('.lista > li').first()).toBeVisible();

    // Sigue en rojo, que es lo correcto: la imagen es la misma y el total
    // impreso sigue sin coincidir. Volver a leer no arregla un comprobante que
    // no cierra; sólo garantiza que se lo interpretó con las reglas de ahora.
    await expect(page.locator('.semaforo-error')).toBeVisible();
  });
});
