import { test, expect } from '@playwright/test';
import { facturaLosCalvosJpeg } from './factura-imagen';
import { ingresar, soloEnIphone } from './ayudas';
import { cargarEntornoE2E, limpiarComprobantesLeidos } from './entorno';

/**
 * Cargar una nota de crédito desde el teléfono.
 *
 * Lo que se prueba de punta a punta es la diferencia que sostiene todo lo
 * demás: la aplicación reconoce sola que el comprobante no es una factura,
 * dice con todas las letras que va a restar del saldo, y **pregunta** si volvió
 * mercadería en vez de darlo por sentado.
 */
const MINUTOS = 60_000;
test.describe.configure({ timeout: 6 * MINUTOS });

/** Cómo quedó guardada la nota de crédito, mirando la base. */
async function comoQuedoGuardada(numero: string) {
  cargarEntornoE2E();
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const nota = await prisma.document.findFirst({
      where: { number: numero },
      include: { items: true, paymentSchedule: true, purchaseMovements: true },
    });
    if (!nota) return null;
    return {
      docType: nota.docType,
      creditReason: nota.creditReason,
      tieneAgenda: nota.paymentSchedule !== null,
      renglones: nota.items.length,
      renglonesDevueltos: nota.items.filter((i) => i.stockReturn).length,
      cantidadesDeLosMovimientos: nota.purchaseMovements.map((m) => Number(m.quantity)),
    };
  } finally {
    await prisma.$disconnect();
  }
}

test.describe('nota de crédito desde el teléfono', () => {
  test.afterAll(async () => {
    await limpiarComprobantesLeidos();
  });

  test('se reconoce sola, avisa que resta del saldo y pregunta por la devolución', async ({
    page,
  }, testInfo) => {
    soloEnIphone(test, testInfo.project.name);

    const NUMERO = '00880011';
    await ingresar(page, 'admin');
    await page.goto('/nueva-compra');

    const imagen = await facturaLosCalvosJpeg({
      tipoComprobante: 'NOTA_CREDITO',
      numero: NUMERO,
    });
    await page
      .locator('input[type="file"]')
      .nth(1)
      .setInputFiles([{ name: 'nota-credito.jpg', mimeType: 'image/jpeg', buffer: imagen }]);
    await expect(page.locator('.miniatura')).toHaveCount(1);
    await page.getByRole('button', { name: 'Leer el comprobante' }).click();
    await expect(page.getByRole('heading', { name: 'Revisar los datos' })).toBeVisible({
      timeout: 5 * MINUTOS,
    });

    /*
     * Reconocida sola. No confirma nada por su cuenta —el motivo y las
     * devoluciones las contesta una persona— pero no la presenta como factura,
     * que es como entraría sumando en la cuenta corriente en vez de restar.
     */
    await expect(page.locator('#tipo')).toHaveValue('NOTA_CREDITO');

    /*
     * Por el título de la tarjeta y no por el texto: el desplegable de tipo
     * tiene una opción que dice "Nota de crédito", así que buscar por texto
     * encuentra primero la tarjeta del comprobante.
     */
    const tarjeta = page
      .locator('.card')
      .filter({ has: page.getByRole('heading', { name: 'Nota de crédito', exact: true }) });
    await expect(tarjeta).toContainText('Este comprobante reduce el saldo con el proveedor');

    // Con un motivo financiero no se puede marcar ninguna devolución: una
    // bonificación no saca mercadería del negocio.
    await page.locator('#motivo-credito').selectOption('BONIFICACION');
    await expect(page.getByText('¿Hubo devolución física de mercadería?')).toHaveCount(0);

    // Con devolución de mercadería, la pregunta aparece en cada renglón.
    await page.locator('#motivo-credito').selectOption('DEVOLUCION_MERCADERIA');
    const preguntas = page.getByText('¿Hubo devolución física de mercadería?');
    const cuantos = await preguntas.count();
    expect(cuantos).toBeGreaterThan(1);

    // Y arranca contestada que **no**: lo que no toca el stock.
    const siPrimero = page.getByRole('radio', { name: 'Sí, volvió al proveedor' }).first();
    const noPrimero = page.getByRole('radio', { name: 'No, sólo corrige el importe' }).first();
    await expect(noPrimero).toBeChecked();
    await expect(siPrimero).not.toBeChecked();

    // Se contesta que sí en el primero y se deja el resto como estaba.
    await siPrimero.check();
    await expect(siPrimero).toBeChecked();

    await page.getByRole('button', { name: 'Continuar', exact: true }).click();

    /*
     * El último paso no es una agenda: una nota de crédito no se paga. Ofrecer
     * una fecha de pago sería agendar plata que nadie va a transferir.
     */
    await expect(page.getByRole('heading', { name: 'Guardar la nota de crédito' })).toBeVisible();
    await expect(page.getByText('Se descuenta del saldo con el proveedor')).toBeVisible();
    await expect(page.locator('#vencimiento')).toHaveCount(0);

    await page.getByRole('button', { name: 'Guardar la nota de crédito' }).click();
    await expect(
      page.getByText('ya está descontando del saldo con el proveedor'),
    ).toBeVisible({ timeout: 60_000 });

    // Y así quedó guardada.
    const guardada = await comoQuedoGuardada(NUMERO);
    expect(guardada).not.toBeNull();
    expect(guardada!.docType).toBe('NOTA_CREDITO');
    expect(guardada!.creditReason).toBe('DEVOLUCION_MERCADERIA');
    // No se paga: no hay agenda.
    expect(guardada!.tieneAgenda).toBe(false);
    // Un solo renglón devuelto, el que se marcó.
    expect(guardada!.renglonesDevueltos).toBe(1);
    /*
     * Y el control que resume todo: un solo movimiento con cantidad negativa
     * —el que volvió— y el resto en cero. Si acá hubiera más de uno, la nota
     * habría sacado del negocio mercadería que nunca salió.
     */
    const negativos = guardada!.cantidadesDeLosMovimientos.filter((c) => c < 0);
    expect(negativos).toHaveLength(1);
  });
});
