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
    await expect(page.getByText('Longaniza corta')).toBeVisible();
    await expect(page.getByText('Último costo')).toBeVisible();
    await expect(page.getByText('Por 100 g')).toBeVisible();
    await expect(page.getByText('Por 1/4 kg')).toBeVisible();
    await expect(page.getByText('Por pieza (efectivo)')).toBeVisible();

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
