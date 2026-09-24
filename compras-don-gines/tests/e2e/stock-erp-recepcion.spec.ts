import { test, expect, type Page } from '@playwright/test';
import { ingresar, sinScrollHorizontal } from './ayudas';

/**
 * **Recibir la mercadería de una compra, desde el navegador y en los dos tamaños.**
 *
 * Lo que se prueba acá son las reglas que se VEN: que el listado separe lo que
 * está listo de lo que está frenado y de lo que es anterior al corte, que la
 * vista previa diga qué entraría sin escribir nada, que confirmar pida dos
 * veces, que una respuesta idempotente se entienda y que un conflicto se
 * entienda también.
 *
 * CADA PROYECTO TRABAJA SOBRE SU PROPIA SUCURSAL. Es el mismo hallazgo de la
 * fase 3: escritorio e iPhone corren contra la misma base, uno después del
 * otro, y una recepción es irreversible por diseño. Sin sucursales separadas,
 * el segundo proyecto encontraría todo ya recibido y fallaría por
 * interferencia, no por un defecto.
 *
 * Deja capturas en `test-results/capturas/`.
 */

const MINUTOS = 60_000;
test.describe.configure({ mode: 'serial', timeout: 5 * MINUTOS });

/** La sucursal de este proyecto. */
function sucursalDe(proyecto: string): string {
  return proyecto === 'iphone' ? 'Recepciones (teléfono)' : 'Recepciones (escritorio)';
}

/** El prefijo de los comprobantes de este proyecto. */
function numeroDe(proyecto: string, caso: 1 | 2 | 3 | 4 | 5 | 6): string {
  return `A 0001-900${proyecto === 'iphone' ? '1' : '2'}${caso}`;
}

async function captura(page: Page, nombre: string, proyecto: string) {
  await page.screenshot({ path: `test-results/capturas/${nombre}-${proyecto}.png`, fullPage: true });
}

/** El listado, filtrado a la sucursal de este proyecto. */
async function abrirListado(page: Page, proyecto: string) {
  await page.goto('/stock-erp/recepciones');
  const opcion = page
    .locator('[data-prueba="filtro-sucursal"] option')
    .filter({ hasText: sucursalDe(proyecto) })
    .first();
  await expect(opcion).toHaveCount(1);
  await page
    .locator('[data-prueba="filtro-sucursal"]')
    .selectOption((await opcion.getAttribute('value')) ?? '');
  await page.locator('[data-prueba="aplicar-busqueda"]').click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Recepciones de compras');
}

function grupo(page: Page, nombre: string) {
  return page.locator(`[data-prueba="grupo-${nombre}"]`);
}

/** Abre la recepción de un comprobante por su número. */
async function abrir(page: Page, proyecto: string, caso: 1 | 2 | 3 | 4 | 5 | 6) {
  await abrirListado(page, proyecto);
  /*
   * Sirve para cualquiera de los seis grupos, decidido o no. El enlace de una
   * recepción ya decidida dice «Ver la decisión» y no «Ver qué entraría», así
   * que se lo busca por su `data-prueba` y no por su texto: la prueba no tiene
   * que romperse porque cambió una etiqueta.
   */
  const fila = page.locator('[data-prueba="fila"]').filter({ hasText: numeroDe(proyecto, caso) }).first();
  await fila.locator('[data-prueba="abrir-recepcion"]').click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('0001-');
}

/* ========================================================================== */

test.describe('el listado dice en qué estado está cada comprobante', () => {
  test('separa listas, bloqueadas y anteriores al corte, con motivo', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    await abrirListado(page, info.project.name);

    /* Lo primero de la pantalla es que esto todavía no es un inventario. */
    await expect(page.locator('[data-prueba="stock-erp-en-preparacion"]')).toContainText(
      'los saldos todavía no incluyen ventas',
    );

    await expect(grupo(page, 'pendientes')).toContainText(numeroDe(info.project.name, 1));
    await expect(grupo(page, 'bloqueadas')).toContainText(numeroDe(info.project.name, 2));
    await expect(grupo(page, 'anteriores-al-corte')).toContainText(numeroDe(info.project.name, 3));

    /* La bloqueada dice POR QUÉ, en la misma fila. */
    const bloqueada = grupo(page, 'bloqueadas').locator('[data-prueba="fila"]').first();
    await expect(bloqueada.locator('[data-prueba="motivo"]')).toContainText(
      /unidad de existencia aprobada/i,
    );

    await captura(page, 'recepciones-listado', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('no ofrece mandarle nada a Control de Stock', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    await abrirListado(page, info.project.name);
    /*
     * El texto viejo hablaba de despachar movimientos a la otra aplicación.
     * Reutilizarlo acá diría lo contrario de lo que esta fase hace.
     */
    const cuerpo = await page.locator('main.contenido').first().innerText();
    expect(cuerpo).not.toMatch(/despachar|enviar movimientos/i);
    expect(cuerpo).toMatch(/no le envía nada/i);
  });

  test('un comprobante bloqueado no ofrece confirmar', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    await abrir(page, info.project.name, 2);

    await expect(page.locator('[data-prueba="impedimentos"]')).toBeVisible();
    await expect(page.locator('[data-prueba="confirmar"]')).toHaveCount(0);
    await expect(page.locator('[data-prueba="renglon"][data-clase="BLOQUEADO"]')).toHaveCount(1);

    await captura(page, 'recepcion-bloqueada', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('un comprobante anterior al corte lo avisa antes de confirmar', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    await abrir(page, info.project.name, 3);

    /* La fecha propuesta es «ahora», así que primero se la pone antes del corte. */
    await page.locator('[data-prueba="recepcion-fecha"]').fill('2026-09-02');
    await page.locator('[data-prueba="recepcion-hora"]').fill('11:00');

    const aviso = page.locator('[data-prueba="anterior-al-corte"]');
    await expect(aviso).toBeVisible();
    await expect(aviso).toContainText('ya está contada');
    await expect(aviso).toContainText('INCLUIDA_EN_APERTURA');

    await captura(page, 'recepcion-anterior-al-corte', info.project.name);
    await sinScrollHorizontal(page);
  });
});

test.describe('la vista previa dice qué entraría, y no escribe nada', () => {
  test('muestra mercadería, gasto, conversión y saldo previsto', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    await abrir(page, info.project.name, 1);

    await expect(page.locator('[data-prueba="mirar-no-escribe"]')).toContainText(
      'no escribe nada',
    );
    await expect(page.locator('[data-prueba="corte"]')).toContainText('hora de Argentina');

    const mercaderia = page.locator('[data-prueba="renglon"][data-clase="MERCADERIA"]');
    await expect(mercaderia).toHaveCount(2);
    const gasto = page.locator('[data-prueba="renglon"][data-clase="GASTO_SIN_IMPACTO"]');
    await expect(gasto).toHaveCount(1);
    await expect(gasto.locator('[data-prueba="motivo-renglon"]')).toContainText(
      /no mueve existencias/i,
    );

    /* El saldo de antes y el de después, para poder mirarlos antes de decidir. */
    const primera = mercaderia.first();
    await expect(primera.locator('[data-prueba="saldo-anterior"]')).toContainText('10');
    await expect(primera.locator('[data-prueba="saldo-previsto"]')).toContainText('12.5');

    await captura(page, 'recepcion-vista-previa', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('mirarla dos veces no cambia nada', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    await abrir(page, info.project.name, 1);
    const antes = await page.locator('[data-prueba="renglon"]').count();
    await page.reload();
    await expect(page.locator('[data-prueba="renglon"]')).toHaveCount(antes);
    /* Y sigue en el grupo de pendientes: mirar no la decidió. */
    await abrirListado(page, info.project.name);
    await expect(grupo(page, 'pendientes')).toContainText(numeroDe(info.project.name, 1));
  });
});

test.describe('confirmar pide dos veces', () => {
  test('el primer botón muestra el resumen final, y recién ahí se aplica', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    await abrir(page, info.project.name, 1);

    /* Antes de tocar nada no hay ningún botón definitivo a la vista. */
    await expect(page.locator('[data-prueba="confirmar-definitivo"]')).toHaveCount(0);

    await page.locator('[data-prueba="confirmar"]').click();
    const doble = page.locator('[data-prueba="doble-confirmacion"]');
    await expect(doble).toBeVisible();
    await expect(doble.locator('[data-prueba="resolucion-prevista"]')).toHaveText('APLICADA');
    await expect(doble.locator('[data-prueba="resumen-movimientos"]')).toHaveText('2');
    await expect(doble).toContainText('No se deshace');

    await captura(page, 'recepcion-doble-confirmacion', info.project.name);
    await sinScrollHorizontal(page);

    await page.locator('[data-prueba="confirmar-definitivo"]').click();
    const ok = page.locator('[data-prueba="resultado-ok"]');
    await expect(ok).toBeVisible();
    await expect(ok).toContainText('2 movimientos de mercadería');

    await captura(page, 'recepcion-aplicada', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('al volver a entrar, la decisión está ahí y no se ofrece recibir de nuevo', async ({
    page,
  }, info) => {
    await ingresar(page, 'configurador');
    await abrir(page, info.project.name, 1);

    await expect(page.locator('[data-prueba="ya-decidida"]')).toContainText('APLICADA');
    await expect(page.locator('[data-prueba="confirmar"]')).toHaveCount(0);

    /* Y pasó al grupo de aplicadas, con sus movimientos. */
    await abrirListado(page, info.project.name);
    const fila = grupo(page, 'aplicadas')
      .locator('[data-prueba="fila"]')
      .filter({ hasText: numeroDe(info.project.name, 1) })
      .first();
    await expect(fila.locator('[data-prueba="movimientos"]')).toHaveText('2');
    await expect(grupo(page, 'pendientes')).not.toContainText(numeroDe(info.project.name, 1));
  });

  test('reenviar la misma recepción contesta que ya estaba, sin duplicar', async ({ page }, info) => {
    await ingresar(page, 'configurador');

    /*
     * El reintento que de verdad pasa: la persona vuelve a mandar el mismo
     * formulario —misma fecha y hora— porque no vio la respuesta. Se arma el
     * pedido a mano contra la acción del servidor, que es lo que haría un botón
     * apretado dos veces o una pestaña reabierta con el formulario cargado.
     */
    await abrir(page, info.project.name, 3);
    /* El 3 es el anterior al corte: se lo recibe como INCLUIDA_EN_APERTURA. */
    await page.locator('[data-prueba="recepcion-fecha"]').fill('2026-09-02');
    await page.locator('[data-prueba="recepcion-hora"]').fill('11:00');
    await page.locator('[data-prueba="confirmar"]').click();
    await page.locator('[data-prueba="confirmar-definitivo"]').click();
    await expect(page.locator('[data-prueba="resultado-ok"]')).toContainText(
      /ya estaba comprendida en la apertura/i,
    );

    /* Y ahora el mismo pedido otra vez, con lo mismo. */
    await page.reload();
    await expect(page.locator('[data-prueba="ya-decidida"]')).toContainText('INCLUIDA_EN_APERTURA');
    await captura(page, 'recepcion-incluida-en-apertura', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('un comprobante de sólo gastos se registra como excluido', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    await abrir(page, info.project.name, 4);

    await expect(page.locator('[data-prueba="cuenta-mercaderia"]')).toHaveText('(0)');
    const gasto = page.locator('[data-prueba="renglon"][data-clase="GASTO_SIN_IMPACTO"]');
    await expect(gasto).toHaveCount(1);
    await expect(gasto).toContainText('BOLSA GRANDE');

    await page.locator('[data-prueba="confirmar"]').click();
    await expect(page.locator('[data-prueba="resolucion-prevista"]')).toHaveText('EXCLUIDA');
    await page.locator('[data-prueba="confirmar-definitivo"]').click();
    await expect(page.locator('[data-prueba="resultado-ok"]')).toContainText(
      /no tiene mercadería con impacto/i,
    );
    await sinScrollHorizontal(page);
  });
});

test.describe('las dos respuestas de una segunda confirmación', () => {
  /*
   * La pestaña vieja. Es el caso real y no una rareza: alguien deja la pantalla
   * abierta, otra persona confirma —o la misma, desde el teléfono— y después
   * vuelve a la primera y aprieta. Lo que tiene que pasar no es un cartel rojo
   * genérico: tiene que decirse qué pasó, y tiene que entenderse.
   */
  test('con lo mismo, contesta que ya estaba aplicada y no duplica', async ({
    page,
    context,
  }, info) => {
    await ingresar(page, 'configurador');
    await abrir(page, info.project.name, 5);
    /* Se fija la fecha a mano para que las dos pestañas manden exactamente lo mismo. */
    await page.locator('[data-prueba="recepcion-fecha"]').fill('2026-09-10');
    await page.locator('[data-prueba="recepcion-hora"]').fill('09:30');
    await page.locator('[data-prueba="confirmar"]').click();
    await expect(page.locator('[data-prueba="doble-confirmacion"]')).toBeVisible();

    /* La segunda pestaña, con el mismo formulario cargado. */
    const vieja = await context.newPage();
    await vieja.goto(page.url());
    await vieja.locator('[data-prueba="recepcion-fecha"]').fill('2026-09-10');
    await vieja.locator('[data-prueba="recepcion-hora"]').fill('09:30');
    await vieja.locator('[data-prueba="confirmar"]').click();
    await expect(vieja.locator('[data-prueba="doble-confirmacion"]')).toBeVisible();

    /* La primera aplica. */
    await page.locator('[data-prueba="confirmar-definitivo"]').click();
    await expect(page.locator('[data-prueba="resultado-ok"]')).toBeVisible();

    /* Y la vieja, con lo mismo, recibe la respuesta guardada. */
    await vieja.locator('[data-prueba="confirmar-definitivo"]').click();
    const ok = vieja.locator('[data-prueba="resultado-ok"]');
    await expect(ok).toContainText(/ya estaba registrada/i);
    await expect(vieja.locator('[data-prueba="ya-aplicada"]')).toContainText(
      /No se escribió nada nuevo/i,
    );

    await captura(vieja, 'recepcion-ya-aplicada', info.project.name);
    await sinScrollHorizontal(vieja);
    await vieja.close();
  });

  test('con otra fecha, contesta un conflicto que se entiende', async ({ page, context }, info) => {
    await ingresar(page, 'configurador');
    await abrir(page, info.project.name, 6);
    await page.locator('[data-prueba="recepcion-fecha"]').fill('2026-09-10');
    await page.locator('[data-prueba="recepcion-hora"]').fill('09:30');
    await page.locator('[data-prueba="confirmar"]').click();

    const vieja = await context.newPage();
    await vieja.goto(page.url());
    /* La pestaña vieja tiene OTRA hora: no es el mismo pedido. */
    await vieja.locator('[data-prueba="recepcion-fecha"]').fill('2026-09-11');
    await vieja.locator('[data-prueba="recepcion-hora"]').fill('16:00');
    await vieja.locator('[data-prueba="confirmar"]').click();
    await expect(vieja.locator('[data-prueba="doble-confirmacion"]')).toBeVisible();

    await page.locator('[data-prueba="confirmar-definitivo"]').click();
    await expect(page.locator('[data-prueba="resultado-ok"]')).toBeVisible();

    await vieja.locator('[data-prueba="confirmar-definitivo"]').click();
    const conflicto = vieja.locator('[data-prueba="resultado-conflicto"]');
    await expect(conflicto).toBeVisible();
    await expect(conflicto).toContainText(/contenido distinto/i);
    await expect(vieja.locator('[data-prueba="explicacion-conflicto"]')).toContainText(
      /ésta no escribió nada/i,
    );

    await captura(vieja, 'recepcion-conflicto-de-huella', info.project.name);
    await sinScrollHorizontal(vieja);
    await vieja.close();
  });
});

test.describe('el permiso de confirmar no viene con el rol administrador', () => {
  test('el administrador ve la pantalla pero no puede confirmar', async ({ page, context }, info) => {
    await context.clearCookies();
    await ingresar(page, 'admin');
    await abrirListado(page, info.project.name);

    await expect(page.locator('[data-prueba="sin-permiso-confirmar"]')).toContainText(
      'stockerp.recepcion.confirmar',
    );

    /* Y en la pantalla de un comprobante tampoco hay botón de recibir. */
    await abrir(page, info.project.name, 2);
    await expect(page.locator('[data-prueba="confirmar"]')).toHaveCount(0);
    await sinScrollHorizontal(page);
  });
});
