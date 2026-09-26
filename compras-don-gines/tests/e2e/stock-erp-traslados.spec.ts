import { test, expect, type Page } from '@playwright/test';
import { ingresar, sinScrollHorizontal } from './ayudas';
import { prisma } from '../../src/lib/db';

/**
 * **Los traslados entre sucursales, en los dos tamaños.**
 *
 * Lo que se prueba acá son las reglas que se VEN:
 *
 *  * un borrador no mueve nada y lo dice;
 *  * la revisión previa muestra el impacto en las DOS sucursales antes de decidir;
 *  * el despacho baja el origen y deja la mercadería EN TRÁNSITO, que es un
 *    tercer lugar con nombre y no un saldo de nadie;
 *  * la recepción es exacta: una cantidad distinta no se confirma y el traslado
 *    se queda en tránsito, sin inventar una merma;
 *  * despachar y recibir exigen permisos que el administrador de fábrica no tiene.
 *
 * CADA PROYECTO MUEVE SU PROPIO ARTÍCULO, entre las mismas dos sucursales de
 * prueba. Los saldos son por artículo y sucursal, así que el teléfono y el
 * escritorio no se pisan aunque compartan el origen y el destino.
 *
 * Deja capturas en `test-results/capturas/`.
 */

const MINUTOS = 60_000;
test.describe.configure({ mode: 'serial', timeout: 5 * MINUTOS });

/** El PLU que mueve cada proyecto. */
function pluDe(proyecto: string): string {
  return proyecto === 'iphone' ? '5001' : '5002';
}

async function captura(page: Page, nombre: string, proyecto: string) {
  await page.screenshot({ path: `test-results/capturas/${nombre}-${proyecto}.png`, fullPage: true });
}

async function sucursales() {
  const [origen, destino] = await Promise.all([
    prisma.branch.findFirstOrThrow({ where: { code: 'TRASLADO_ORIGEN' } }),
    prisma.branch.findFirstOrThrow({ where: { code: 'TRASLADO_DESTINO' } }),
  ]);
  return { origen, destino };
}

/** Arma un borrador desde la pantalla y devuelve su URL. */
async function nuevoBorrador(page: Page) {
  const { origen, destino } = await sucursales();
  await page.goto('/stock-erp/traslados');
  await page.locator('[data-prueba="origen"]').selectOption(origen.id);
  await page.locator('[data-prueba="destino"]').selectOption(destino.id);
  await page.locator('[data-prueba="crear-borrador"]').click();
  await page.waitForURL(/\/stock-erp\/traslados\/.+/);
  return page.url();
}

/** Agrega el artículo del proyecto con la cantidad pedida. */
async function agregar(page: Page, proyecto: string, cantidad: string) {
  const plu = pluDe(proyecto);
  const opcion = page.locator('[data-prueba="articulo-nuevo"] option', { hasText: plu });
  const valor = await opcion.getAttribute('value');
  await page.locator('[data-prueba="articulo-nuevo"]').selectOption(valor!);
  await page.locator('[data-prueba="cantidad-nueva"]').fill(cantidad);
  await page.locator('[data-prueba="agregar"]').click();
  await expect(page.locator('[data-prueba="renglon"]').first()).toBeVisible();
}

/** El saldo que la base tiene hoy, para comparar contra lo que dice la pantalla. */
async function saldoDe(plu: string, codigoSucursal: string): Promise<string | null> {
  const fila = await prisma.stockBalance.findFirst({
    where: { product: { internalCode: plu }, branch: { code: codigoSucursal } },
  });
  return fila ? fila.quantity.toString() : null;
}

/* ========================================================================== */

test.describe('el listado y el borrador', () => {
  test('el listado separa los cuatro momentos y avisa que el módulo está en preparación', async ({
    page,
  }, info) => {
    await ingresar(page, 'configurador');
    await page.goto('/stock-erp/traslados');

    await expect(page.locator('[data-prueba="stock-erp-en-preparacion"]')).toContainText(
      'los saldos todavía no incluyen ventas',
    );
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Traslados');
    for (const grupo of ['en-transito', 'borradores', 'cerrados', 'cancelados']) {
      await expect(page.locator(`[data-prueba="grupo-${grupo}"]`)).toBeVisible();
    }

    /* El interruptor de traslados reales está APAGADO, y la pantalla lo dice. */
    await expect(page.locator('[data-prueba="interruptor-traslados"]')).toContainText('apagado');

    await captura(page, 'traslados-listado', info.project.name);
    await captura(page, 'traslados-interruptor-apagado', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('un borrador con artículos no mueve ningún saldo', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    const plu = pluDe(info.project.name);
    const antes = await saldoDe(plu, 'TRASLADO_ORIGEN');

    await nuevoBorrador(page);
    await expect(page.locator('[data-prueba="estado"]').first()).toHaveText('BORRADOR');
    await expect(page.locator('[data-prueba="explicacion-estado"]')).toContainText(
      'Todavía no escribió nada en el libro',
    );
    await agregar(page, info.project.name, '2.5');

    expect(await saldoDe(plu, 'TRASLADO_ORIGEN'), 'el borrador no descontó nada').toBe(antes);

    await captura(page, 'traslados-borrador', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('la revisión previa muestra el impacto en las dos sucursales', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    await nuevoBorrador(page);
    await agregar(page, info.project.name, '3');

    const renglon = page.locator('[data-prueba="renglon"]').first();
    await expect(renglon).toHaveAttribute('data-clase', 'LISTO');
    const impacto = renglon.locator('[data-prueba="impacto-previsto"]');
    await expect(impacto).toBeVisible();
    await expect(renglon.locator('[data-prueba="saldo-origen-antes"]')).toHaveText('20');
    await expect(renglon.locator('[data-prueba="saldo-origen-despues"]')).toHaveText('17');
    await expect(renglon.locator('[data-prueba="saldo-destino-antes"]')).toHaveText('0');
    await expect(renglon.locator('[data-prueba="saldo-destino-despues"]')).toHaveText('3');

    await captura(page, 'traslados-revision', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('cancelar un borrador no escribe en el libro, y lo dice', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    const plu = pluDe(info.project.name);
    const antes = await saldoDe(plu, 'TRASLADO_ORIGEN');
    await nuevoBorrador(page);
    await agregar(page, info.project.name, '1');

    await page.locator('[data-prueba="cancelar-borrador"]').click();
    await page.locator('[data-prueba="motivo-cancelacion"]').fill('Se pidió de más');
    await page.locator('[data-prueba="cancelar-definitivo"]').click();

    await expect(page.locator('[data-prueba="resultado-ok"]')).toContainText('No se escribió nada');
    await page.reload();
    await expect(page.locator('[data-prueba="estado"]').first()).toHaveText('CANCELADO');
    await expect(page.locator('[data-prueba="traslado-cancelado"]')).toBeVisible();
    expect(await saldoDe(plu, 'TRASLADO_ORIGEN')).toBe(antes);

    await captura(page, 'traslados-cancelado', info.project.name);
    await sinScrollHorizontal(page);
  });
});

test.describe('lo que la pantalla frena antes de despachar', () => {
  test('sin saldo suficiente, el renglón queda bloqueado y explica por qué', async ({
    page,
  }, info) => {
    await ingresar(page, 'configurador');
    await nuevoBorrador(page);
    /* Hay 20; se piden 999. */
    await agregar(page, info.project.name, '999');

    const renglon = page.locator('[data-prueba="renglon"]').first();
    await expect(renglon).toHaveAttribute('data-clase', 'BLOQUEADO');
    await expect(renglon.locator('[data-prueba="motivo-renglon"]')).toContainText(
      'se quieren despachar 999',
    );
    await expect(page.locator('[data-prueba="impedimentos"]')).toBeVisible();
    await expect(page.locator('[data-prueba="despacho-frenado"]')).toBeVisible();
    /* Y no hay botón de despachar a la vista. */
    await expect(page.locator('[data-prueba="confirmar"]')).toHaveCount(0);

    await captura(page, 'traslados-bloqueo-saldo', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('un artículo que el destino no maneja queda bloqueado', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    const borrador = await nuevoBorrador(page);

    /*
     * El artículo del OTRO proyecto sí está manejado en las dos sucursales, así
     * que para este caso hace falta uno que el destino no maneje: cualquiera del
     * catálogo general, que en estas dos sucursales quedó NO_SE_MANEJA.
     *
     * Se agrega por la base y no por la pantalla porque la pantalla sólo ofrece
     * los que tienen unidad aprobada, y este caso es justamente el de un artículo
     * con unidad aprobada que la sucursal no trabaja.
     */
    const ajeno = await prisma.product.findFirstOrThrow({
      where: {
        stockConfig: { status: 'APROBADA' },
        internalCode: { notIn: ['5001', '5002'] },
      },
      orderBy: { internalCode: 'asc' },
    });
    const id = borrador.split('/').pop()!;
    await prisma.stockTransferLine.create({
      data: { transferId: id, productId: ajeno.id, quantity: '1', unit: 'KG' },
    });

    await page.reload();
    const renglon = page.locator('[data-prueba="renglon"]').first();
    await expect(renglon).toHaveAttribute('data-clase', 'BLOQUEADO');
    await expect(renglon.locator('[data-prueba="motivo-renglon"]')).toContainText('no maneja');
    await expect(page.locator('[data-prueba="confirmar"]')).toHaveCount(0);

    await captura(page, 'traslados-bloqueo-unidad', info.project.name);
    await sinScrollHorizontal(page);
  });
});

test.describe('despachar, tránsito y recibir', () => {
  test('el despacho pide dos confirmaciones, baja el origen y deja la mercadería en tránsito', async ({
    page,
  }, info) => {
    await ingresar(page, 'configurador');
    const plu = pluDe(info.project.name);
    const antes = await saldoDe(plu, 'TRASLADO_ORIGEN');

    await nuevoBorrador(page);
    await agregar(page, info.project.name, '4');

    /* Antes de tocar nada no hay ningún botón definitivo a la vista. */
    await expect(page.locator('[data-prueba="confirmar-definitivo"]')).toHaveCount(0);
    await page.locator('[data-prueba="confirmar"]').click();
    const doble = page.locator('[data-prueba="doble-confirmacion"]');
    await expect(doble).toBeVisible();
    await expect(doble.locator('[data-prueba="resumen-movimientos"]')).toHaveText('1');
    await expect(doble).toContainText('No se deshace');

    await captura(page, 'traslados-despacho', info.project.name);
    await sinScrollHorizontal(page);

    await page.locator('[data-prueba="confirmar-definitivo"]').click();
    const ok = page.locator('[data-prueba="resultado-ok"]');
    await expect(ok).toBeVisible();
    await expect(ok).toContainText('EN TRÁNSITO');

    /* El origen bajó 4 y el destino sigue igual. */
    expect(await saldoDe(plu, 'TRASLADO_ORIGEN')).toBe(String(Number(antes) - 4));
    expect(await saldoDe(plu, 'TRASLADO_DESTINO'), 'el destino no recibió nada todavía').toBe('0');

    await page.reload();
    await expect(page.locator('[data-prueba="estado"]').first()).toHaveText('DESPACHADO');
    await expect(page.locator('[data-prueba="aviso-transito"]')).toContainText(
      'todavía no están en',
    );
    await captura(page, 'traslados-en-transito', info.project.name);
    await sinScrollHorizontal(page);

    /* Y el tablero del destino lo muestra APARTE del saldo. */
    const { destino } = await sucursales();
    await page.goto(`/stock-erp/existencias?sucursal=${destino.id}`);
    await expect(page.locator('[data-prueba="en-transito-hacia-aca"]')).toBeVisible();
    await expect(page.locator('[data-prueba="aviso-transito"]')).toContainText('no es saldo');
    await captura(page, 'traslados-transito-en-existencias', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('una recepción con cantidad distinta no se confirma: sigue en tránsito', async ({
    page,
  }, info) => {
    await ingresar(page, 'configurador');
    const plu = pluDe(info.project.name);

    /* El traslado despachado en la prueba anterior. */
    const enTransito = await prisma.stockTransfer.findFirstOrThrow({
      where: {
        status: 'DESPACHADO',
        lines: { some: { product: { internalCode: plu } } },
      },
      orderBy: { dispatchedAt: 'desc' },
    });
    await page.goto(`/stock-erp/traslados/${enTransito.id}`);

    await page.locator('[data-prueba="confirmar-recepcion"]').click();
    const doble = page.locator('[data-prueba="doble-confirmacion-recepcion"]');
    await expect(doble).toBeVisible();
    await captura(page, 'traslados-recepcion', info.project.name);

    /* Se cuenta MENOS de lo que salió. */
    await doble.locator('[data-prueba="contado"]').first().fill('1');
    await page.locator('[data-prueba="confirmar-recepcion-definitivo"]').click();

    const error = page.locator('[data-prueba="resultado-error"]');
    await expect(error).toBeVisible();
    await expect(error).toContainText('SIGUE EN TRÁNSITO');
    await expect(error).toContainText('no se registra una merma');

    /* Nada entró al destino y el traslado sigue despachado. */
    expect(await saldoDe(plu, 'TRASLADO_DESTINO')).toBe('0');
    await page.reload();
    await expect(page.locator('[data-prueba="estado"]').first()).toHaveText('DESPACHADO');

    await captura(page, 'traslados-diferencia-fisica', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('la recepción exacta cierra el traslado y suma al destino', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    const plu = pluDe(info.project.name);

    const enTransito = await prisma.stockTransfer.findFirstOrThrow({
      where: { status: 'DESPACHADO', lines: { some: { product: { internalCode: plu } } } },
      orderBy: { dispatchedAt: 'desc' },
    });
    await page.goto(`/stock-erp/traslados/${enTransito.id}`);

    await page.locator('[data-prueba="confirmar-recepcion"]').click();
    /* Los campos vienen con lo despachado: se confirma tal cual. */
    await page.locator('[data-prueba="confirmar-recepcion-definitivo"]').click();

    const ok = page.locator('[data-prueba="resultado-ok"]');
    await expect(ok).toBeVisible();
    await expect(ok).toContainText('cerrado');
    expect(await saldoDe(plu, 'TRASLADO_DESTINO')).toBe('4');

    await page.reload();
    await expect(page.locator('[data-prueba="estado"]').first()).toHaveText('RECIBIDO');
    await expect(page.locator('[data-prueba="traslado-cerrado"]')).toContainText('no se recibe de nuevo');
    /* Ya no hay botón de recibir: un traslado cerrado no se recibe dos veces. */
    await expect(page.locator('[data-prueba="confirmar-recepcion"]')).toHaveCount(0);
    /* Las dos operaciones están a la vista, y son distintas. */
    const despacho = await page.locator('[data-prueba="operacion-despacho"]').textContent();
    const recepcion = await page.locator('[data-prueba="operacion-recepcion"]').textContent();
    expect(despacho).not.toBe(recepcion);
    expect(despacho).not.toBe('—');
    expect(recepcion).not.toBe('—');

    await captura(page, 'traslados-cerrado', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('el movimiento del traslado aparece en el historial del libro', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    const { origen } = await sucursales();
    await page.goto(`/stock-erp/movimientos?sucursal=${origen.id}`);

    const salida = page.locator('[data-prueba="movimiento"]', { hasText: 'Traslado (salida)' }).first();
    await expect(salida).toBeVisible();
    await sinScrollHorizontal(page);
  });
});

test.describe('los permisos sensibles', () => {
  test('el administrador de fábrica ve el traslado pero no puede despachar ni recibir', async ({
    page,
  }, info) => {
    /* El admin de fábrica NO tiene los permisos sensibles: se otorgan a mano. */
    await ingresar(page, 'admin');
    await nuevoBorrador(page);
    await agregar(page, info.project.name, '1');

    await expect(page.locator('[data-prueba="sin-permiso-despachar"]')).toContainText(
      'stockerp.traslado.despachar',
    );
    await expect(page.locator('[data-prueba="confirmar"]')).toHaveCount(0);
    await expect(page.locator('[data-prueba="confirmar-definitivo"]')).toHaveCount(0);

    await sinScrollHorizontal(page);
  });
});
