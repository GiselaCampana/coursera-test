import { test, expect, type Page } from '@playwright/test';
import { ingresar, sinScrollHorizontal } from './ayudas';

/**
 * **El despacho a Control de Stock, retirado de la pantalla.**
 *
 * Este archivo probaba el botón que mandaba mercadería a Control de Stock: quién
 * lo veía, qué mostraba antes de mandar, que un clic no alcanzara, que cancelar
 * no dejara rastro. Ese botón **ya no existe**: la integración de escritura
 * quedó cancelada y el módulo de stock propio todavía no está activado.
 *
 * El archivo se conserva y cambia de tema, que es lo honesto: lo que había que
 * comprobar desde el navegador ahora es la **ausencia**. Una tarjeta que informa
 * el estado de envío de una integración cancelada no es información incompleta,
 * es información falsa, y es exactamente la clase de cosa que vuelve sola en un
 * refactor distraído.
 *
 * Lo que salía por el cable —el contrato, la clave en el encabezado, cómo se lee
 * cada código de estado, la idempotencia— sigue probado, y con el mismo detalle,
 * en las pruebas de integración: `contrato-de-stock`, `despacho-manual` e
 * `ingreso-a-control-de-stock`. Nada de eso se perdió; dejó de tener una puerta
 * en la interfaz.
 *
 * Corre en los dos proyectos, escritorio e iPhone, porque la ausencia de un
 * control se comprueba en las dos pantallas: un botón puede quedar fuera de
 * vista en una y visible en la otra.
 */

const MINUTOS = 60_000;
test.describe.configure({ timeout: 4 * MINUTOS });

/** La factura de Ezra de la demo: seis renglones, cinco de mercadería. */
const COMPLETA = '00000185';

/** Lo que la tarjeta retirada mostraba, palabra por palabra. */
const RASTROS_DEL_DESPACHO = [
  'Enviar la mercadería a Control de Stock',
  'Sincronización',
  'pendiente de enviar',
  'enviada, sin confirmación',
  'confirmada por Control de Stock',
];

async function abrirElComprobante(page: Page, numero: string) {
  await page.goto('/comprobantes');
  await page.locator('a.fila-dato', { hasText: numero }).first().click();
  await expect(page).toHaveURL(/\/comprobantes\/[^/]+$/);
}

test.describe('el despacho a Control de Stock ya no está en la pantalla', () => {
  test('el comprobante no ofrece ningún botón de despacho, ni al administrador', async ({
    page,
  }) => {
    await ingresar(page, 'admin');
    await abrirElComprobante(page, COMPLETA);

    /*
     * Por el gancho de prueba, que es lo que identificaba a la tarjeta: si
     * alguien la vuelve a dibujar con otro texto, esto la encuentra igual.
     */
    await expect(page.locator('[data-prueba="despacho-de-stock"]')).toHaveCount(0);
    await expect(page.locator('[data-prueba="pedir-despacho"]')).toHaveCount(0);
    await expect(page.locator('[data-prueba="confirmar-despacho"]')).toHaveCount(0);
    await expect(page.locator('[data-prueba="reintentar-inciertos"]')).toHaveCount(0);
  });

  test('tampoco queda la tarjeta de sincronización ni ninguno de sus textos', async ({ page }) => {
    await ingresar(page, 'admin');
    await abrirElComprobante(page, COMPLETA);

    const cuerpo = page.locator('body');
    for (const rastro of RASTROS_DEL_DESPACHO) {
      await expect(cuerpo, `no puede quedar «${rastro}»`).not.toContainText(rastro);
    }
  });

  test('un operador ve exactamente lo mismo: nada', async ({ page }) => {
    await ingresar(page, 'operador');
    await abrirElComprobante(page, COMPLETA);

    await expect(page.locator('[data-prueba="despacho-de-stock"]')).toHaveCount(0);
    for (const rastro of RASTROS_DEL_DESPACHO) {
      await expect(page.locator('body')).not.toContainText(rastro);
    }
  });

  test('el comprobante sigue mostrando lo que la compra sí hace', async ({ page }) => {
    /*
     * La contracara, y hace falta: sin esto, «no aparece el despacho» sería
     * indistinguible de «la pantalla se rompió y no muestra nada».
     */
    await ingresar(page, 'admin');
    await abrirElComprobante(page, COMPLETA);

    await expect(page.getByRole('heading', { name: 'Datos del comprobante' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Artículos' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Totales' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Ver la vista previa de la compra/ })).toBeVisible();
    await sinScrollHorizontal(page);
  });
});

test.describe('lo que reemplazó al despacho: el impacto previsto', () => {
  test('la vista previa lo describe y dice que todavía no mueve existencias', async ({ page }) => {
    await ingresar(page, 'admin');
    await abrirElComprobante(page, COMPLETA);
    await page.getByRole('link', { name: /Ver la vista previa de la compra/ }).click();
    await expect(page).toHaveURL(/\/vista-previa$/);

    const tarjeta = page.locator('[data-prueba="impacto-en-stock-erp"]');
    await expect(tarjeta).toBeVisible();
    await expect(
      tarjeta.getByRole('heading', {
        name: 'Impacto previsto en Stock ERP — módulo todavía no activado',
      }),
    ).toBeVisible();

    /* El aviso, con todas las letras y arriba de la lista. */
    const aviso = tarjeta.locator('[data-prueba="stock-erp-no-activado"]');
    await expect(aviso).toBeVisible();
    await expect(aviso).toContainText('registra costos, deuda y pagos');
    await expect(aviso).toContainText('todavía no modifica ninguna existencia de Stock ERP');
  });

  test('los cinco de Ezra con PLU, cantidad y unidad, la sucursal, y la bolsa aparte', async ({
    page,
  }) => {
    await ingresar(page, 'admin');
    await abrirElComprobante(page, COMPLETA);
    await page.getByRole('link', { name: /Ver la vista previa de la compra/ }).click();

    const tarjeta = page.locator('[data-prueba="impacto-en-stock-erp"]');
    await expect(tarjeta.locator('[data-prueba="sucursal-del-impacto"]')).toBeVisible();

    const movimientos = tarjeta.locator('[data-prueba="movimiento-previsto"]');
    await expect(movimientos).toHaveCount(5);

    /* Las cinco cantidades del papel, con sus tres decimales. */
    for (const kilos of ['4,240', '3,985', '7,345', '4,040', '7,665']) {
      await expect(
        tarjeta.locator('[data-prueba="cantidad"]', { hasText: kilos }),
        `los ${kilos} kg del papel`,
      ).toHaveCount(1);
    }
    /* Todas en kilos: ninguna en unidades. */
    await expect(tarjeta.locator('[data-prueba="unidad"]', { hasText: 'kg' })).toHaveCount(5);
    /* Y cada una con su PLU a la vista. */
    const plus = await tarjeta.locator('[data-prueba="plu"]').allInnerTexts();
    expect(plus).toHaveLength(5);
    expect(plus.every((p) => p.trim() !== '' && p.trim() !== '—')).toBe(true);

    /* La bolsa: visible, como gasto, y fuera de los movimientos. */
    const gastos = tarjeta.locator('[data-prueba="gasto"]');
    await expect(gastos.filter({ hasText: 'BOLSA' })).toHaveCount(1);
    await expect(gastos.filter({ hasText: 'BOLSA' })).toContainText('3,000');
    await expect(gastos.filter({ hasText: 'BOLSA' })).toContainText('unidades');
    await expect(movimientos.filter({ hasText: 'BOLSA' })).toHaveCount(0);
  });

  test('se lee entera en el teléfono, sin desbordar a lo ancho', async ({ page }) => {
    await ingresar(page, 'admin');
    await abrirElComprobante(page, COMPLETA);
    await page.getByRole('link', { name: /Ver la vista previa de la compra/ }).click();

    await expect(page.locator('[data-prueba="impacto-en-stock-erp"]')).toBeVisible();
    await sinScrollHorizontal(page);
  });
});
