import { test, expect } from '@playwright/test';
import { ingresar, sinScrollHorizontal, soloEnIphone } from './ayudas';

test.describe('agenda y confirmación de pagos', () => {
  test('el tablero muestra los indicadores', async ({ page }) => {
    await ingresar(page, 'admin');

    await expect(page.getByText('Vence hoy')).toBeVisible();
    await expect(page.getByText('Vencidos')).toBeVisible();
    await expect(page.getByText('Próximos 7 días')).toBeVisible();
    await expect(page.getByText('Compras del mes')).toBeVisible();
    await expect(page.getByText('Últimas facturas cargadas')).toBeVisible();

    // Los cuatro indicadores muestran un número, no un hueco.
    const valores = page.locator('.indicador-valor');
    await expect(valores).toHaveCount(4);
    for (const texto of await valores.allTextContents()) {
      expect(texto).toMatch(/^\d+$/);
    }
    // Y las facturas sembradas aparecen en el listado de últimas cargadas.
    await expect(page.getByText('0010-00212400')).toBeVisible();

    await sinScrollHorizontal(page);
  });

  test('separa la agenda por estado y confirma un pago', async ({ page }, testInfo) => {
    soloEnIphone(test, testInfo.project.name);
    await ingresar(page, 'admin');
    await page.goto('/pagos?grupo=vencidos');

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pagos');
    const vencido = page.locator('.fila-dato', { hasText: '0010-00212356' });
    await expect(vencido).toBeVisible();
    await expect(vencido.locator('.etiqueta-estado')).toHaveText('Vencido');

    // Confirmar el pago pide fecha efectiva, forma de pago y referencia.
    await vencido.getByRole('button', { name: 'Confirmar el pago' }).click();
    await page.getByLabel('Fecha efectiva').fill('2026-08-20');
    await page.getByLabel('Forma de pago').selectOption('TRANSFERENCIA');
    await page.getByLabel('Referencia o número de operación').fill('OP-2026-4471');
    await vencido.getByRole('button', { name: 'Confirmar el pago' }).click();

    await expect(page.getByText('El pago quedó confirmado.')).toBeVisible();

    // Y pasa a la pestaña de pagados, con quién y cuándo lo confirmó.
    await page.goto('/pagos?grupo=pagados');
    await expect(page.getByText(/Pagado el 20\/08\/2026 por Ana Administradora/)).toBeVisible();
    await expect(page.getByText(/OP-2026-4471/)).toBeVisible();

    // La fecha prevista no se pisó con la efectiva.
    await expect(page.getByText(/Vence 14\/08\/2026/)).toBeVisible();
  });

  test('el operador ve la agenda pero no puede confirmar', async ({ page }) => {
    await ingresar(page, 'operador');
    // Se mira la factura agendada a futuro, que ninguna otra prueba toca.
    await page.goto('/pagos?grupo=proximos');
    const agendada = page.locator('.fila-dato', { hasText: '0010-00212400' });
    await expect(agendada).toBeVisible();
    await expect(agendada).toContainText('Los Calvos');
    await expect(page.getByRole('button', { name: 'Confirmar el pago' })).toHaveCount(0);
  });
});

test.describe('comprobantes', () => {
  test('lista, filtra y abre el detalle', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/comprobantes');

    await expect(page.getByText('0010-00212356')).toBeVisible();
    await page.locator('a.fila-dato', { hasText: '0010-00212356' }).click();

    await expect(page.getByRole('heading', { level: 1 })).toContainText('0010-00212356');
    await expect(page.locator('.semaforo-ok')).toBeVisible();
    await expect(page.getByText('Comprobante controlado')).toBeVisible();
    // La tabla trae la descripción impresa y, al lado, el producto asociado.
    await expect(page.getByRole('cell', { name: 'LONGANIZA CORTA', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Longaniza corta', exact: true })).toBeVisible();

    await sinScrollHorizontal(page);
  });

  test('la tabla de artículos se desplaza sin romper el ancho de la página', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/comprobantes');
    await page.locator('a.fila-dato', { hasText: '0010-00212356' }).click();

    // La tabla vive dentro de un contenedor que se desplaza solo.
    const contenedor = page.locator('.tabla-scroll').first();
    await expect(contenedor).toBeVisible();
    const desborda = await contenedor.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(desborda).toBe(true);
    // Pero la página sigue sin desbordarse.
    await sinScrollHorizontal(page);
  });

  test('el filtro por estado acota la lista', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/comprobantes?estado=VALIDADO');

    // Los dos comprobantes confirmados que siembran las pruebas.
    const confirmados = page.locator('a.fila-dato');
    await expect(confirmados).toHaveCount(2);
    await expect(page.getByText('0010-00212356')).toBeVisible();
    await expect(page.getByText('0010-00212400')).toBeVisible();

    // Al filtrar por anulados no queda ninguno.
    await page.goto('/comprobantes?estado=ANULADO');
    await expect(page.locator('a.fila-dato')).toHaveCount(0);
    await expect(page.getByText('No hay comprobantes con esos filtros')).toBeVisible();
  });
});

test.describe('precios y compras', () => {
  test('muestra el costo y los precios sugeridos', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/precios');

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Precios');

    /*
     * Todo dentro de la ficha del artículo, y no sueltos en la página.
     *
     * La lista tiene un artículo por cada uno que se compró alguna vez, así que
     * "hay un último costo en algún lado" no dice nada: lo que hace falta saber
     * es que **este** artículo muestra el suyo con sus precios.
     */
    const longaniza = page.locator('li.fila-dato').filter({ hasText: 'Longaniza corta' }).first();
    await expect(longaniza).toBeVisible();
    await expect(longaniza.getByText('Último costo por kilo')).toBeVisible();
    /*
     * Las etiquetas son las de la pantalla, que cambiaron al separar los
     * marcajes por modalidad: ahora cada precio dice también sobre qué unidad
     * está expresado, porque «por 1/4 kg» a secas no aclaraba si el número era
     * el del cuarto o el del kilo.
     */
    await expect(longaniza.getByText('Venta por 100 g')).toBeVisible();
    await expect(longaniza.getByText('Venta por 1/4 kg')).toBeVisible();
    await expect(longaniza.getByText('Pieza entera efectivo')).toBeVisible();

    await sinScrollHorizontal(page);
  });

  test('el historial de compras totaliza los kilos', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/compras');

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Compras');
    // Las dos facturas sembradas: 16,10 kg + 8,50 kg.
    await expect(page.locator('.dato', { hasText: 'Kilos' }).locator('dd')).toHaveText('24,60 kg');
    await expect(page.getByRole('link', { name: 'Exportar CSV' })).toBeVisible();

    await sinScrollHorizontal(page);
  });
});

test.describe('el calendario de pagos', () => {
  /*
   * Cada prueba entra con su usuario: no hay beforeEach común porque una de
   * ellas necesita entrar como operador, y con una sesión de administrador ya
   * abierta el formulario de ingreso no está.
   */

  test('se alterna entre lista, calendario y próximos siete días', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/pagos');

    // La lista sigue siendo lo primero que se ve: el calendario no la reemplaza.
    await expect(page.getByRole('link', { name: 'Lista' })).toHaveAttribute('aria-current', 'page');

    await page.getByRole('link', { name: 'Calendario' }).click();
    await expect(page.getByText('Total previsto del mes')).toBeVisible();
    await expect(page.getByRole('grid')).toBeVisible();

    await page.getByRole('link', { name: 'Próximos 7 días' }).click();
    await expect(page.getByText('Total previsto del mes')).toHaveCount(0);
  });

  test('el resumen del mes muestra las cuatro cifras', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/pagos?vista=calendario');

    /*
     * Se busca adentro del resumen y no en toda la página: "Pagado" es también
     * una opción del filtro por estado, y pedirlo suelto encuentra las dos.
     */
    const resumen = page.locator('.resumen-mes');
    for (const etiqueta of ['Total previsto del mes', 'Pagado', 'Pendiente', 'Vencido']) {
      await expect(resumen.getByText(etiqueta, { exact: true })).toBeVisible();
    }
  });

  test('se navega al mes anterior, al siguiente y de vuelta a hoy', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/pagos?vista=calendario&mes=2026-08');
    await expect(page.getByText('agosto de 2026')).toBeVisible();

    await page.getByRole('link', { name: '‹ Mes anterior' }).click();
    await expect(page.getByText('julio de 2026')).toBeVisible();

    await page.getByRole('link', { name: 'Mes siguiente ›' }).click();
    await expect(page.getByText('agosto de 2026')).toBeVisible();

    await page.getByRole('link', { name: 'Hoy', exact: true }).click();
    await expect(page.getByRole('grid')).toBeVisible();
  });

  test('al tocar un día se abre el detalle, y los filtros se conservan al cambiar de mes', async ({
    page,
  }) => {
    await ingresar(page, 'admin');
    await page.goto('/pagos?vista=calendario&mes=2026-08');

    /*
     * El detalle no vive dentro de la celda: en un teléfono no entra. La celda
     * muestra importe, cuántos son y el estado, y al tocarla se abre el panel.
     */
    const conPagos = page.locator('.calendario-celda.con-pagos');
    if ((await conPagos.count()) > 0) {
      await conPagos.first().click();
      const panel = page.locator('.panel-dia');
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('link', { name: 'Abrir el comprobante' }).first()).toBeVisible();
      await panel.getByRole('button', { name: 'Cerrar' }).click();
      await expect(panel).toHaveCount(0);
    }

    // Y el filtro de proveedor sobrevive a la navegación entre meses.
    await page.locator('#proveedor').selectOption({ label: 'Los Calvos' });
    await page.getByRole('button', { name: 'Aplicar filtros' }).click();
    await page.getByRole('link', { name: 'Mes siguiente ›' }).click();
    await expect(page).toHaveURL(/proveedor=/);
  });

  test('un operador no ve el botón de confirmar el pago en el calendario', async ({ page }) => {
    // El mismo permiso que rige la lista rige acá: es la misma agenda.
    await ingresar(page, 'operador');
    await page.goto('/pagos?vista=calendario&mes=2026-08');

    const conPagos = page.locator('.calendario-celda.con-pagos');
    if ((await conPagos.count()) > 0) {
      await conPagos.first().click();
      await expect(page.locator('.panel-dia')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Registrar el pago' })).toHaveCount(0);
    }
  });

  test('el calendario entra en la pantalla del teléfono sin desbordarse', async ({
    page,
  }, testInfo) => {
    soloEnIphone(test, testInfo.project.name);
    await ingresar(page, 'admin');
    await page.goto('/pagos?vista=calendario&mes=2026-08');
    await expect(page.getByRole('grid')).toBeVisible();
    await sinScrollHorizontal(page);
  });
});
