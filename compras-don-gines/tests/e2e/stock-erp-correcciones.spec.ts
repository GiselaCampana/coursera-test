import { test, expect, type Page } from '@playwright/test';
import { ingresar, sinScrollHorizontal, elegirOpcion } from './ayudas';
import { prisma } from '../../src/lib/db';

/**
 * **Las correcciones operativas, en los dos tamaños.**
 *
 * Lo que se prueba acá son las reglas que se VEN:
 *
 *  * las tres familias están separadas y en ninguna pantalla existe un campo
 *    para sumar o restar existencias a mano;
 *  * una merma exige categoría, motivo escrito y una segunda confirmación, y
 *    baja el saldo exactamente por lo que se perdió;
 *  * un recuento se carga con la cantidad FÍSICA: la pantalla muestra la
 *    diferencia pero dice quién la calcula, y confirmar el ajuste sólo asienta
 *    esa diferencia;
 *  * un recuento que coincide deja constancia y NO escribe ningún movimiento;
 *  * una reversión agrega asientos inversos con el original a la vista, y
 *    después no se puede repetir;
 *  * mermar, ajustar y reversar exigen permisos que el administrador de fábrica
 *    no tiene, aunque sí pueda contar la góndola.
 *
 * CADA PROYECTO CORRIGE SU PROPIO ARTÍCULO EN SU PROPIA SUCURSAL. Acá no
 * alcanzaba con repartir el artículo, como en los traslados: un recuento
 * correctivo es de la sucursal y sólo puede haber uno abierto a la vez, así que
 * un recuento abierto en el teléfono le cerraría la puerta al escritorio.
 *
 * Deja capturas en `test-results/capturas/`.
 */

const MINUTOS = 60_000;
test.describe.configure({ mode: 'serial', timeout: 5 * MINUTOS });

/** El PLU que corrige cada proyecto. */
function pluDe(proyecto: string): string {
  return proyecto === 'iphone' ? '6001' : '6002';
}

/** La sucursal de cada proyecto. */
function codigoDeSucursal(proyecto: string): string {
  return proyecto === 'iphone' ? 'CORRECCIONES_A' : 'CORRECCIONES_B';
}

async function captura(page: Page, nombre: string, proyecto: string) {
  await page.screenshot({ path: `test-results/capturas/${nombre}-${proyecto}.png`, fullPage: true });
}

async function sucursalDe(proyecto: string) {
  return await prisma.branch.findFirstOrThrow({
    where: { code: codigoDeSucursal(proyecto) },
  });
}

/** El saldo que la base tiene hoy, para comparar contra lo que dice la pantalla. */
async function saldoDe(proyecto: string): Promise<string | null> {
  const fila = await prisma.stockBalance.findFirst({
    where: {
      product: { internalCode: pluDe(proyecto) },
      branch: { code: codigoDeSucursal(proyecto) },
    },
  });
  return fila ? fila.quantity.toString() : null;
}

/** Cuántos movimientos tiene el libro para este artículo en la sucursal de prueba. */
async function movimientosDe(proyecto: string): Promise<number> {
  return await prisma.stockLedger.count({
    where: {
      product: { internalCode: pluDe(proyecto) },
      branch: { code: codigoDeSucursal(proyecto) },
    },
  });
}

/* ========================================================================== */

test.describe('el tablero de correcciones', () => {
  test('separa las tres familias, avisa del interruptor y no ofrece ninguna entrada manual', async ({
    page,
  }, info) => {
    await ingresar(page, 'configurador');
    await page.goto('/stock-erp/correcciones');

    await expect(page.locator('[data-prueba="stock-erp-en-preparacion"]')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Correcciones');

    for (const grupo of ['grupo-recuentos', 'grupo-mermas', 'grupo-reversibles']) {
      await expect(page.locator(`[data-prueba="${grupo}"]`)).toBeVisible();
    }

    /* El interruptor nace apagado y lo dice sin rodeos. */
    await expect(page.locator('[data-prueba="interruptor-correcciones"]')).toContainText('apagado');

    /*
     * **Lo que NO tiene que existir.**
     *
     * Es la prueba más importante de esta pantalla: la instrucción prohíbe un
     * campo de «sumar/restar manualmente», y un campo así es exactamente lo que
     * un módulo de correcciones tiende a criar. Se busca por nombre y por texto.
     */
    for (const nombre of ['delta', 'diferencia', 'ajuste', 'sumar', 'restar', 'signo']) {
      await expect(page.locator(`input[name="${nombre}"]`)).toHaveCount(0);
    }
    await expect(page.getByText(/sumar\s*\/\s*restar/i)).toHaveCount(0);

    await captura(page, 'correcciones-tablero', info.project.name);
    await sinScrollHorizontal(page);
  });
});

test.describe('la merma', () => {
  test('la lista de artículos depende de la sucursal y sólo ofrece lo que maneja', async ({
    page,
  }, info) => {
    await ingresar(page, 'configurador');
    const plu = pluDe(info.project.name);
    const ajeno = plu === '6001' ? '6002' : '6001';
    const { id: branchId } = await sucursalDe(info.project.name);
    await page.goto('/stock-erp/correcciones/mermas');

    /* Sin sucursal no hay nada que ofrecer: el selector está bloqueado. */
    const articulo = page.locator('[data-prueba="articulo"]');
    await expect(articulo).toBeDisabled();
    await expect(articulo).toContainText('Primero elegí la sucursal');

    await page.locator('[data-prueba="sucursal"]').selectOption(branchId);
    await expect(articulo).toBeEnabled();

    /* Sólo el artículo propio, con su unidad. El de la otra sucursal no aparece. */
    await expect(articulo.locator('option', { hasText: plu })).toHaveCount(1);
    await expect(articulo.locator('option', { hasText: ajeno })).toHaveCount(0);
    await expect(articulo.locator('option', { hasText: plu })).toContainText('KG');
    await expect(page.locator('[data-prueba="explicacion-articulos"]')).toContainText(
      'esta sucursal maneja',
    );

    /* Y cambiar de sucursal olvida lo elegido: la lista es otra. */
    await elegirOpcion(page, '[data-prueba="articulo"]', plu);
    await expect(articulo).not.toHaveValue('');
    const otraSucursal = await prisma.branch.findFirstOrThrow({ where: { code: 'DEVOTO' } });
    await page.locator('[data-prueba="sucursal"]').selectOption(otraSucursal.id);
    await expect(articulo, 'no queda seleccionado un artículo de la sucursal anterior').toHaveValue(
      '',
    );

    await captura(page, 'correcciones-merma-lista-por-sucursal', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('exige detalle cuando la categoría es «Otro» y no deja revisar sin motivo', async ({
    page,
  }, info) => {
    await ingresar(page, 'configurador');
    const { id: branchId } = await sucursalDe(info.project.name);
    await page.goto('/stock-erp/correcciones/mermas');

    await page.locator('[data-prueba="sucursal"]').selectOption(branchId);
    await elegirOpcion(page, '[data-prueba="articulo"]', pluDe(info.project.name));
    await page.locator('[data-prueba="cantidad"]').fill('1');

    /* Sin motivo no se puede ni llegar a la revisión. */
    await page.locator('[data-prueba="categoria"]').selectOption('VENCIMIENTO');
    await expect(page.locator('[data-prueba="revisar"]')).toBeDisabled();

    /* Con «Otro», el detalle aparece y es obligatorio. */
    await page.locator('[data-prueba="categoria"]').selectOption('OTRO');
    await page.locator('[data-prueba="motivo"]').fill('No entra en ninguna categoría');
    await expect(page.locator('[data-prueba="pide-detalle"]')).toBeVisible();
    await expect(page.locator('[data-prueba="revisar"]')).toBeDisabled();

    await page.locator('[data-prueba="detalle"]').fill('Se mojó con la lluvia en la vereda');
    await expect(page.locator('[data-prueba="revisar"]')).toBeEnabled();

    await captura(page, 'correcciones-merma-otro-exige-detalle', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('baja el saldo exactamente por lo perdido, con doble confirmación', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    const plu = pluDe(info.project.name);
    const { id: branchId } = await sucursalDe(info.project.name);
    expect(await saldoDe(info.project.name)).toBe('20');

    await page.goto('/stock-erp/correcciones/mermas');
    await page.locator('[data-prueba="sucursal"]').selectOption(branchId);
    await elegirOpcion(page, '[data-prueba="articulo"]', plu);
    await page.locator('[data-prueba="cantidad"]').fill('3');
    await page.locator('[data-prueba="categoria"]').selectOption('VENCIMIENTO');
    await page.locator('[data-prueba="motivo"]').fill('Vencido en la heladera del fondo');

    /* Primer paso: la revisión, con el resumen a la vista. */
    await page.locator('[data-prueba="revisar"]').click();
    const doble = page.locator('[data-prueba="doble-confirmacion"]');
    await expect(doble).toBeVisible();
    await expect(doble.locator('[data-prueba="resumen-cantidad"]')).toHaveText('3');
    await expect(doble).toContainText('No se deshace');
    await captura(page, 'correcciones-merma-revision', info.project.name);

    /* Segundo paso: confirmar. */
    await page.locator('[data-prueba="confirmar-definitivo"]').click();
    const ok = page.locator('[data-prueba="resultado-ok"]');
    await expect(ok).toBeVisible();
    await expect(ok).toContainText('17');
    expect(await saldoDe(info.project.name)).toBe('17');

    await captura(page, 'correcciones-merma-confirmada', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('volver a confirmar la misma merma no la duplica', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    const plu = pluDe(info.project.name);
    const { id: branchId } = await sucursalDe(info.project.name);

    await page.goto('/stock-erp/correcciones/mermas');
    await page.locator('[data-prueba="sucursal"]').selectOption(branchId);
    await elegirOpcion(page, '[data-prueba="articulo"]', plu);
    await page.locator('[data-prueba="cantidad"]').fill('1');
    await page.locator('[data-prueba="categoria"]').selectOption('ROTURA');
    await page.locator('[data-prueba="motivo"]').fill('Se cayó de la balanza');

    await page.locator('[data-prueba="revisar"]').click();
    await page.locator('[data-prueba="confirmar-definitivo"]').click();
    await expect(page.locator('[data-prueba="resultado-ok"]')).toContainText('16');
    expect(await saldoDe(info.project.name)).toBe('16');

    /*
     * Y ahora el segundo clic, SIN recargar: el identificador de la merma lo
     * generó el servidor una sola vez para esta carga de la pantalla, así que la
     * clave idempotente es la misma.
     */
    await page.locator('[data-prueba="revisar"]').click();
    await page.locator('[data-prueba="confirmar-definitivo"]').click();
    await expect(page.locator('[data-prueba="ya-aplicada"]')).toBeVisible();
    expect(await saldoDe(info.project.name)).toBe('16');

    await captura(page, 'correcciones-merma-idempotente', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('la merma aparece en el tablero con su saldo de antes y de después', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    const { id: branchId } = await sucursalDe(info.project.name);
    await page.goto(`/stock-erp/correcciones?sucursal=${branchId}`);

    const fila = page
      .locator('[data-prueba="fila-merma"]')
      .filter({ hasText: 'Vencido en la heladera del fondo' })
      .first();
    await expect(fila).toBeVisible();
    await expect(fila.locator('[data-prueba="saldo-anterior"]')).toHaveText('20');
    await expect(fila.locator('[data-prueba="saldo-resultante"]')).toHaveText('17');
    await expect(fila.locator('[data-prueba="usuario"]')).not.toHaveText('—');
    await expect(fila.locator('[data-prueba="ver-en-el-libro"]')).toBeVisible();

    await sinScrollHorizontal(page);
  });
});

test.describe('el recuento correctivo', () => {
  /** Abre un recuento desde la pantalla y deja la página en su detalle. */
  async function abrirRecuento(page: Page, proyecto: string, nombre: string) {
    const { id: branchId } = await sucursalDe(proyecto);
    await page.goto('/stock-erp/correcciones');
    await page.locator('[data-prueba="sucursal-recuento"]').selectOption(branchId);
    await page.locator('[data-prueba="nombre-recuento"]').fill(nombre);
    await page.locator('[data-prueba="abrir"]').click();
    await page.waitForURL(/\/stock-erp\/correcciones\/recuentos\/.+/);
  }

  test('se carga la cantidad física y la diferencia la calcula el servidor', async ({
    page,
  }, info) => {
    await ingresar(page, 'configurador');
    const plu = pluDe(info.project.name);
    expect(await saldoDe(info.project.name)).toBe('16');

    await abrirRecuento(page, info.project.name, `Control de fiambres ${plu}`);

    /* La pantalla dice quién calcula la diferencia. Es el punto de toda la fase. */
    await expect(page.locator('[data-prueba="explicacion-delta"]')).toContainText('servidor');
    await expect(page.locator('[data-prueba="explicacion-delta"]')).toContainText(
      'no un ajuste',
    );

    /* Y el campo se llama por lo que es: lo contado, no un delta. */
    await expect(page.locator('[data-prueba="cantidad-fisica-nueva"]')).toHaveAttribute(
      'placeholder',
      /no la diferencia/i,
    );
    for (const nombre of ['delta', 'diferencia', 'ajuste', 'sumar', 'restar']) {
      await expect(page.locator(`input[name="${nombre}"]`)).toHaveCount(0);
    }

    await elegirOpcion(page, '[data-prueba="articulo-a-contar"]', plu);
    await page.locator('[data-prueba="cantidad-fisica-nueva"]').fill('14');
    await page.locator('[data-prueba="guardar-contado"]').click();

    const linea = page.locator('[data-prueba="linea"]').first();
    await expect(linea).toBeVisible();
    await expect(linea.locator('[data-prueba="saldo-anterior"]')).toHaveText('16');
    await expect(linea.locator('[data-prueba="cantidad-fisica"]')).toHaveText('14');
    await expect(linea.locator('[data-prueba="diferencia"]')).toHaveText('-2');

    /* Contar no escribe el libro: el saldo sigue igual hasta confirmar. */
    expect(await saldoDe(info.project.name)).toBe('16');

    await captura(page, 'correcciones-recuento-diferencia', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('confirmar el ajuste asienta sólo la diferencia', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    const plu = pluDe(info.project.name);
    const sesion = await prisma.stockCountSession.findFirstOrThrow({
      where: { kind: 'RECUENTO', name: `Control de fiambres ${plu}` },
    });
    await page.goto(`/stock-erp/correcciones/recuentos/${sesion.id}`);

    const antes = await movimientosDe(info.project.name);
    const linea = page.locator('[data-prueba="linea"]').first();
    await linea.locator('[data-prueba="confirmar"]').click();

    const doble = page.locator('[data-prueba="doble-confirmacion"]');
    await expect(doble).toBeVisible();
    await expect(doble).toContainText('asentando sólo la diferencia');
    await captura(page, 'correcciones-recuento-revision', info.project.name);

    await doble.locator('[data-prueba="motivo-ajuste"]').fill('Se contó con el encargado presente');
    await doble.locator('[data-prueba="confirmar-definitivo"]').click();

    await expect(page.locator('[data-prueba="resultado-ok"]')).toContainText('14');
    expect(await saldoDe(info.project.name)).toBe('14');
    /* Un movimiento: el de la diferencia. No dos, no uno por el total contado. */
    expect(await movimientosDe(info.project.name)).toBe(antes + 1);

    await page.reload();
    const resuelta = page.locator('[data-prueba="linea"]').first();
    await expect(resuelta).toHaveAttribute('data-resolucion', 'AJUSTADA');
    await expect(resuelta.locator('[data-prueba="motivo"]')).toContainText(
      'Se contó con el encargado presente',
    );
    await expect(resuelta.locator('[data-prueba="estado-reversion"]')).toHaveText('sin revertir');
    await expect(resuelta.locator('[data-prueba="ver-en-el-libro"]')).toBeVisible();

    /*
     * Y se cierra, que no es cosmética: un recuento correctivo es de la
     * SUCURSAL y sólo puede haber uno abierto a la vez —dos contarían la misma
     * góndola dos veces—. Dejarlo abierto le cerraría la puerta al recuento
     * siguiente, así que cerrarlo es parte del camino, no una limpieza.
     */
    await page.locator('[data-prueba="cerrar"]').click();
    await expect(page.locator('[data-prueba="resultado-ok"]')).toContainText('cerrado');
    await page.reload();
    await expect(page.locator('[data-prueba="estado"]').first()).toHaveText('CERRADA');

    await captura(page, 'correcciones-recuento-ajustado', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('un recuento que coincide deja constancia y no escribe ningún movimiento', async ({
    page,
  }, info) => {
    await ingresar(page, 'configurador');
    const plu = pluDe(info.project.name);
    expect(await saldoDe(info.project.name)).toBe('14');

    await abrirRecuento(page, info.project.name, `Segundo control ${plu}`);
    await elegirOpcion(page, '[data-prueba="articulo-a-contar"]', plu);
    await page.locator('[data-prueba="cantidad-fisica-nueva"]').fill('14');
    await page.locator('[data-prueba="guardar-contado"]').click();

    const linea = page.locator('[data-prueba="linea"]').first();
    await expect(linea.locator('[data-prueba="diferencia"]')).toHaveText('0');

    const antes = await movimientosDe(info.project.name);
    await linea.locator('[data-prueba="confirmar"]').click();
    const doble = page.locator('[data-prueba="doble-confirmacion"]');
    await expect(doble).toContainText('no se escribe ningún movimiento');
    await doble.locator('[data-prueba="motivo-ajuste"]').fill('Coincidía; queda la constancia');
    await doble.locator('[data-prueba="confirmar-definitivo"]').click();

    await expect(page.locator('[data-prueba="resultado-ok"]')).toContainText('Coincidía');
    expect(await movimientosDe(info.project.name)).toBe(antes);
    expect(await saldoDe(info.project.name)).toBe('14');

    await page.reload();
    await expect(page.locator('[data-prueba="linea"]').first()).toHaveAttribute(
      'data-resolucion',
      'SIN_DIFERENCIA',
    );

    /* Y se cierra, por lo mismo: uno abierto por sucursal. */
    await page.locator('[data-prueba="cerrar"]').click();
    await expect(page.locator('[data-prueba="resultado-ok"]')).toContainText('cerrado');

    await captura(page, 'correcciones-recuento-sin-diferencia', info.project.name);
    await sinScrollHorizontal(page);
  });
});

test.describe('la reversión', () => {
  test('agrega los asientos inversos con el original a la vista, y no se repite', async ({
    page,
  }, info) => {
    await ingresar(page, 'configurador');
    const plu = pluDe(info.project.name);
    expect(await saldoDe(info.project.name)).toBe('14');

    const merma = await prisma.stockWaste.findFirstOrThrow({
      where: {
        product: { internalCode: plu },
        branch: { code: codigoDeSucursal(info.project.name) },
        reason: 'Vencido en la heladera del fondo',
      },
    });
    await page.goto(`/stock-erp/correcciones/reversiones/${merma.operationId}`);

    /* El asiento original está a la vista, con lo que la reversión va a escribir. */
    await expect(page.locator('[data-prueba="estado-reversion"]')).toHaveText('sin revertir');
    const movimiento = page.locator('[data-prueba="movimiento"]').first();
    await expect(movimiento.locator('[data-prueba="cantidad"]')).toHaveText('3');
    await expect(movimiento.locator('[data-prueba="inverso"]')).toContainText('devolver');
    await expect(movimiento.locator('[data-prueba="inverso"]')).toContainText('queda donde está');
    await expect(page.locator('[data-prueba="motivo-original"]')).toContainText(
      'Vencido en la heladera del fondo',
    );
    await captura(page, 'correcciones-reversion', info.project.name);

    await page.locator('[data-prueba="revisar-reversion"]').click();
    const doble = page.locator('[data-prueba="doble-confirmacion"]');
    await expect(doble).toContainText('una sola vez');
    await doble.locator('[data-prueba="motivo-reversion"]').fill('La merma se cargó en el turno equivocado');
    await doble.locator('[data-prueba="confirmar-definitivo"]').click();

    await expect(page.locator('[data-prueba="resultado-ok"]')).toContainText('inverso');
    /* El saldo vuelve POR EL LIBRO: 14 + 3. */
    expect(await saldoDe(info.project.name)).toBe('17');

    /* Y el original sigue donde estaba: el libro tiene las dos cosas. */
    const asientos = await prisma.stockLedger.findMany({
      where: {
        product: { internalCode: plu },
        branch: { code: codigoDeSucursal(info.project.name) },
        type: 'WASTE_OUT',
      },
    });
    expect(asientos.filter((a) => a.reversesId === null)).toHaveLength(2);
    expect(asientos.filter((a) => a.reversesId !== null)).toHaveLength(1);

    await page.reload();
    await expect(page.locator('[data-prueba="ya-revertida"]')).toBeVisible();
    await expect(page.locator('[data-prueba="estado-reversion"]')).toHaveText('revertida');
    /* Ya no hay botón: una operación se revierte una sola vez. */
    await expect(page.locator('[data-prueba="revisar-reversion"]')).toHaveCount(0);

    await captura(page, 'correcciones-reversion-hecha', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('una apertura no figura como reversible y su pantalla lo explica', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    const { id: branchId } = await sucursalDe(info.project.name);

    const apertura = await prisma.stockOperation.findFirstOrThrow({
      where: { branchId, kind: 'ACTIVACION' },
    });
    await page.goto(`/stock-erp/correcciones/reversiones/${apertura.id}`);

    await expect(page.locator('[data-prueba="impedimentos"]')).toContainText('no es reversible');
    await expect(page.locator('[data-prueba="revisar-reversion"]')).toHaveCount(0);

    /*
     * Y la lista de lo que se puede revertir no ofrece otra cosa que las tres
     * clases de esta fase. Se comprueba sobre cada fila y no buscando la
     * apertura por su nombre: una aserción que busca algo que no está pasa
     * también cuando la lista está vacía o cuando el selector se rompió.
     */
    await page.goto(`/stock-erp/correcciones?sucursal=${branchId}`);
    const filas = page.locator('[data-prueba="fila-reversible"]');
    const cuantas = await filas.count();
    expect(cuantas).toBeGreaterThan(0);
    for (let i = 0; i < cuantas; i += 1) {
      await expect(filas.nth(i)).toHaveAttribute(
        'data-clase',
        /^(MERMA|AJUSTE_DE_RECUENTO|DESPACHO_DE_TRASLADO)$/,
      );
    }

    await captura(page, 'correcciones-reversion-no-elegible', info.project.name);
    await sinScrollHorizontal(page);
  });
});

test.describe('el libro y los permisos', () => {
  test('la merma y el ajuste aparecen en el historial del libro', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    const { id: branchId } = await sucursalDe(info.project.name);
    await page.goto(`/stock-erp/movimientos?sucursal=${branchId}`);

    for (const texto of ['Merma', 'Ajuste']) {
      await expect(
        page.locator('[data-prueba="movimiento"]', { hasText: texto }).first(),
      ).toBeVisible();
    }

    await captura(page, 'correcciones-movimientos', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('el administrador de fábrica puede contar la góndola pero no mermar, ajustar ni reversar', async ({
    page,
  }, info) => {
    /* El admin de fábrica NO tiene los permisos sensibles: se otorgan a mano. */
    await ingresar(page, 'admin');
    const plu = pluDe(info.project.name);
    const { id: branchId } = await sucursalDe(info.project.name);

    await page.goto('/stock-erp/correcciones');
    await expect(page.locator('[data-prueba="sin-permiso-merma"]')).toContainText('stockerp.merma');

    /* Contar sí: preparar un recuento no escribe el libro. */
    await page.locator('[data-prueba="sucursal-recuento"]').selectOption(branchId);
    await page.locator('[data-prueba="nombre-recuento"]').fill(`Recuento del admin ${plu}`);
    await page.locator('[data-prueba="abrir"]').click();
    await page.waitForURL(/\/stock-erp\/correcciones\/recuentos\/.+/);

    await elegirOpcion(page, '[data-prueba="articulo-a-contar"]', plu);
    await page.locator('[data-prueba="cantidad-fisica-nueva"]').fill('9');
    await page.locator('[data-prueba="guardar-contado"]').click();

    /* Confirmar el ajuste, no: ahí se escribe el libro. */
    const linea = page.locator('[data-prueba="linea"]').first();
    await expect(linea.locator('[data-prueba="diferencia"]')).toHaveText('-8');
    await expect(linea.locator('[data-prueba="sin-permiso-ajuste"]')).toContainText(
      'stockerp.ajuste',
    );
    await expect(linea.locator('[data-prueba="confirmar"]')).toHaveCount(0);
    expect(await saldoDe(info.project.name)).toBe('17');

    /* Y reversar tampoco. */
    const ajuste = await prisma.stockCountLine.findFirstOrThrow({
      where: { product: { internalCode: plu }, resolution: 'AJUSTADA', operationId: { not: null } },
    });
    await page.goto(`/stock-erp/correcciones/reversiones/${ajuste.operationId}`);
    await expect(page.locator('[data-prueba="sin-permiso-reversion"]')).toContainText(
      'stockerp.reversar',
    );
    await expect(page.locator('[data-prueba="revisar-reversion"]')).toHaveCount(0);

    await captura(page, 'correcciones-sin-permisos', info.project.name);
    await sinScrollHorizontal(page);
  });
});
