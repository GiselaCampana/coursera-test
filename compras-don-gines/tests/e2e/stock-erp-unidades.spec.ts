import { test, expect } from '@playwright/test';
import { ingresar, sinScrollHorizontal } from './ayudas';

/**
 * **La pantalla de unidades de Stock ERP, en los dos tamaños.**
 *
 * Lo que se prueba acá son las reglas que se ven, que son las que alguien puede
 * romper sin tocar una línea de código: que la pantalla avise que el módulo no
 * está activado, que no muestre ni un saldo, que distinga el dato externo de la
 * decisión interna, que aprobar pida confirmar dos veces y que quien no tiene
 * el permiso lo sepa.
 *
 * Corre en escritorio y en iPhone porque la configuración de unidades se hace
 * con el teléfono en la mano, frente a la góndola.
 */

const MINUTOS = 60_000;
test.describe.configure({ timeout: 5 * MINUTOS });

test.describe('la pantalla dice lo que es, y lo que todavía no es', () => {
  test('avisa que Stock ERP está en preparación y no muestra saldos', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/stock-erp/unidades');

    const aviso = page.locator('[data-prueba="stock-erp-en-preparacion"]');
    await expect(aviso).toBeVisible();
    await expect(aviso).toContainText('en preparación');
    await expect(aviso).toContainText('los saldos todavía no incluyen ventas');
    await expect(aviso).toContainText('no representan existencias operativas completas');

    /*
     * Ningún saldo en la pantalla.
     *
     * La comprobación descuenta el texto del propio aviso, que dice «No hay
     * saldos» y tiene que decirlo: lo que no puede haber es la palabra en
     * cualquier OTRO lugar, donde estaría nombrando una cifra y no negándola.
     * Sin este descuento la prueba se contradecía con la pantalla que exige.
     */
    const cuerpo = (await page.locator('body').innerText()).toLowerCase();
    const textoDelAviso = (await aviso.innerText()).toLowerCase();
    const resto = cuerpo.split(textoDelAviso).join(' ');
    expect(resto).not.toContain('saldo');
    expect(resto).not.toContain('existencias disponibles');
    await sinScrollHorizontal(page);
  });

  test('separa el dato externo de la decisión interna', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/stock-erp/unidades');

    const primera = page.locator('[data-prueba="articulo"]').first();
    await expect(primera).toBeVisible();
    /* El catálogo INFORMA… */
    await expect(primera.locator('[data-prueba="unidad-catalogo"]')).toContainText(
      /dato externo|no se sincronizó/,
    );
    /* …y el ERP DECIDE. Los dos rotulados, y nunca mezclados. */
    await expect(primera.locator('[data-prueba="unidad-existencia"]')).toBeVisible();
  });

  test('un artículo sin unidad aprobada aparece pendiente y bloqueado', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/stock-erp/unidades');
    await page.locator('[data-prueba="filtro-pendientes"]').click();

    const primera = page.locator('[data-prueba="articulo"]').first();
    await expect(primera.locator('[data-prueba="estado"]')).toContainText('PENDIENTE');
    await expect(primera.locator('[data-prueba="estado"]')).toContainText('bloqueado');
  });

  test('se busca por PLU y se filtra', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/stock-erp/unidades');

    const total = await page.locator('[data-prueba="articulo"]').count();
    expect(total).toBeGreaterThan(0);

    await page.locator('[data-prueba="buscar"]').fill('no-existe-este-plu-zzz');
    await expect(page.locator('[data-prueba="articulo"]')).toHaveCount(0);

    await page.locator('[data-prueba="buscar"]').fill('');
    await expect(page.locator('[data-prueba="articulo"]').first()).toBeVisible();
  });
});

test.describe('aprobar una unidad es una decisión, no un clic', () => {
  test('el administrador de fábrica NO puede aprobar, y la pantalla lo dice', async ({ page }) => {
    /*
     * La garantía más importante de la ronda, vista desde el navegador: el
     * permiso `stockerp.unidades.configurar` no viene en el rol administrador,
     * así que ni siquiera Ana puede fijar una unidad sin que alguien se lo dé.
     */
    await ingresar(page, 'admin');
    await page.goto('/stock-erp/unidades');
    await expect(page.locator('[data-prueba="sin-permiso-configurar"]')).toBeVisible();
    await expect(page.locator('[data-prueba="sin-permiso-configurar"]')).toContainText(
      'stockerp.unidades.configurar',
    );
  });

  test('quien tiene el permiso aprueba, y se le pide confirmar dos veces', async ({ page }) => {
    await ingresar(page, 'configurador');
    await page.goto('/stock-erp/unidades');
    await expect(page.locator('[data-prueba="sin-permiso-configurar"]')).toHaveCount(0);

    const tarjeta = page.locator('[data-prueba="articulo"]').first();
    await tarjeta.getByRole('button', { name: 'Configurar' }).click();
    await tarjeta.locator('[data-prueba="elegir-unidad"]').selectOption('KG');

    /* Primer clic: NO guarda. Sólo pregunta. */
    await tarjeta.locator('[data-prueba="aprobar-unidad"]').click();
    const confirmacion = tarjeta.locator('[data-prueba="doble-confirmacion"]');
    await expect(confirmacion).toBeVisible();
    await expect(confirmacion).toContainText('libro de existencias');

    /* Y se puede cancelar sin haber decidido nada. */
    await tarjeta.locator('[data-prueba="cancelar-unidad"]').click();
    await expect(confirmacion).toHaveCount(0);

    /* Segundo intento, hasta el final. */
    await tarjeta.locator('[data-prueba="aprobar-unidad"]').click();
    await tarjeta.locator('[data-prueba="confirmar-unidad"]').click();
    await expect(tarjeta.locator('[data-prueba="resultado-ok"]')).toBeVisible();
    await sinScrollHorizontal(page);
  });
});

test.describe('las presentaciones y la tabla en el teléfono', () => {
  test('una presentación cargada se ve, y la tabla no desborda', async ({ page }) => {
    await ingresar(page, 'configurador');
    await page.goto('/stock-erp/unidades');

    const tarjeta = page.locator('[data-prueba="articulo"]').first();
    await tarjeta.getByRole('button', { name: 'Configurar' }).click();

    await tarjeta.locator('[data-prueba="presentacion-unidad"]').selectOption('UNIT');
    await tarjeta.locator('[data-prueba="presentacion-factor"]').fill('4.250');
    await tarjeta.locator('[data-prueba="presentacion-codigo"]').fill('HORMA');
    await tarjeta.locator('[data-prueba="guardar-presentacion"]').click();

    await expect(tarjeta.locator('[data-prueba="resultado-ok"]')).toBeVisible();
    /* El factor se muestra exacto, con sus decimales. */
    await expect(tarjeta.locator('[data-prueba="factor"]').first()).toHaveText('4.25');
    /* La tabla vive dentro de .tabla-scroll, que es lo que la hace usable en 390px. */
    await expect(tarjeta.locator('.tabla-scroll')).toBeVisible();
    await sinScrollHorizontal(page);
  });

  test('un factor cero se rechaza y lo dice en castellano', async ({ page }) => {
    await ingresar(page, 'configurador');
    await page.goto('/stock-erp/unidades');

    const tarjeta = page.locator('[data-prueba="articulo"]').first();
    await tarjeta.getByRole('button', { name: 'Configurar' }).click();
    await tarjeta.locator('[data-prueba="presentacion-factor"]').fill('0');
    await tarjeta.locator('[data-prueba="guardar-presentacion"]').click();

    await expect(tarjeta.locator('[data-prueba="resultado-error"]')).toContainText('mayor que cero');
  });
});
