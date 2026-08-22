import { test, expect } from '@playwright/test';
import { ingresar, sinScrollHorizontal } from './ayudas';

/**
 * La barra de navegación inferior está fija sobre el contenido. El riesgo real
 * en el mostrador es que tape justamente el botón que hay que tocar, así que se
 * verifica pantalla por pantalla que, con la página abajo del todo, ningún
 * control quede debajo de la barra.
 */
const PANTALLAS = [
  { ruta: '/', nombre: 'Inicio' },
  { ruta: '/nueva-compra', nombre: 'Nueva compra' },
  { ruta: '/comprobantes', nombre: 'Comprobantes' },
  { ruta: '/pagos?grupo=proximos', nombre: 'Pagos' },
  { ruta: '/precios', nombre: 'Precios' },
  { ruta: '/compras', nombre: 'Compras' },
  { ruta: '/configuracion', nombre: 'Configuración' },
];

test.describe('uso desde el teléfono', () => {
  // En escritorio la navegación va arriba y estática: estas comprobaciones son
  // sobre la barra fija del teléfono.
  test.skip(({ isMobile }) => !isMobile, 'Sólo aplica al perfil móvil.');

  test.beforeEach(async ({ page }) => {
    await ingresar(page, 'admin');
  });

  for (const pantalla of PANTALLAS) {
    test(`${pantalla.nombre}: la barra inferior no tapa ningún control`, async ({ page }) => {
      await page.goto(pantalla.ruta);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(200);

      const barra = await page.locator('.nav-inferior').boundingBox();
      expect(barra, 'No se encontró la barra de navegación').not.toBeNull();

      const controles = page.locator(
        'main a.boton, main button:visible, main input:visible, main select:visible',
      );
      const total = await controles.count();

      for (let i = 0; i < total; i++) {
        const control = controles.nth(i);
        const caja = await control.boundingBox();
        if (!caja) continue;
        // Un control queda tapado si su mitad inferior cae detrás de la barra.
        const centro = caja.y + caja.height / 2;
        const etiqueta = (await control.getAttribute('id')) ?? (await control.innerText()) ?? '';
        expect(
          centro,
          `En ${pantalla.nombre} el control "${etiqueta.slice(0, 40)}" queda debajo de la barra`,
        ).toBeLessThan(barra!.y);
      }

      await sinScrollHorizontal(page);
    });
  }

  test('las pantallas entran sin desbordarse a lo ancho', async ({ page }) => {
    for (const pantalla of PANTALLAS) {
      await page.goto(pantalla.ruta);
      await sinScrollHorizontal(page);
    }
  });
});
