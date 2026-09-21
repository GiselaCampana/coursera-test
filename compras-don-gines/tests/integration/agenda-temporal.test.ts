import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '@/lib/db';
import { limpiarBase, sembrarEscenario, type Escenario } from './ayudas';
import { listPayments } from '@/lib/services/payments';
import { addDays, arToday, DIA_FIJADO, toISODate } from '@/lib/datetime';

/**
 * **Los tres grupos de la agenda, contra un día que no se mueve.**
 *
 * La prueba pura fija la frontera en `computePaymentStatus`. Ésta la fija donde
 * la ve quien usa la aplicación: los tres grupos que arma `listPayments` y que
 * la pantalla de Pagos muestra como «Próximos», «Vence hoy» y «Vencidos».
 *
 * Las dos hacen falta. La pura puede seguir pasando mientras la pantalla mete
 * todo en el grupo equivocado —basta con que alguien cambie el filtro— y la de
 * la pantalla puede seguir pasando con la frontera corrida un día si los datos
 * no caen justo encima. Acá los datos caen justo encima, a propósito: el
 * vencimiento de cada comprobante es ayer, hoy y mañana respecto del día fijado.
 *
 * Y el día se fija: si dependiera del almanaque, esta prueba sería exactamente
 * la que se está arreglando.
 */

let escenario: Escenario;

/** El día que la aplicación va a creer que es mientras corre esto. */
const HOY = '2026-09-10';

const original = { ...process.env };

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();
  process.env[DIA_FIJADO] = HOY;
});

afterEach(() => {
  process.env = { ...original };
});

/**
 * Un comprobante validado con su pago agendado para el día que se le diga.
 *
 * El estado se escribe a propósito como AGENDADO, que es el que tiene recién
 * creado: lo que se está probando es que la consulta lo reclasifique sola al
 * mirarlo, porque un pago no cambia de estado por una acción de nadie.
 */
async function comprobanteQueVence(dueDate: Date, numero: string) {
  const documento = await prisma.document.create({
    data: {
      branchId: escenario.sucursales.devoto,
      supplierId: escenario.proveedorId,
      createdById: escenario.admin.id,
      validatedById: escenario.admin.id,
      status: 'VALIDADO',
      pointOfSale: '00001',
      number: numero,
      fullNumber: `00001-${numero}`,
      issueDate: addDays(dueDate, -30),
      total: '1000.00',
    },
  });

  await prisma.paymentSchedule.create({
    data: {
      documentId: documento.id,
      dueDate,
      plannedAmount: '1000.00',
      plannedPaymentMethod: 'TRANSFERENCIA',
      status: 'AGENDADO',
    },
  });

  return documento.id;
}

describe('los tres límites, en los grupos que se ven en pantalla', () => {
  it('mañana es próximo, hoy vence hoy, y ayer está vencido', async () => {
    const hoy = arToday();
    expect(toISODate(hoy)).toBe(HOY);

    const manana = await comprobanteQueVence(addDays(hoy, 1), '00000001');
    const hoyMismo = await comprobanteQueVence(hoy, '00000002');
    const ayer = await comprobanteQueVence(addDays(hoy, -1), '00000003');

    const agenda = await listPayments(escenario.admin);

    expect(agenda.proximos.map((p) => p.documentId)).toEqual([manana]);
    expect(agenda.venceHoy.map((p) => p.documentId)).toEqual([hoyMismo]);
    expect(agenda.vencidos.map((p) => p.documentId)).toEqual([ayer]);
  });

  it('el que vence hoy no está entre los próximos', async () => {
    /*
     * La regresión del defecto concreto, escrita al revés de la de arriba.
     *
     * Es la forma que tenía la falla: «Próximos» parece el lugar natural de un
     * pago que todavía se puede pagar, y ahí deja de haber ninguna pantalla que
     * diga que hoy hay algo que hacer. Se entera al día siguiente, cuando ya
     * figura vencido.
     *
     * Se afirma la ausencia y no sólo la presencia en el otro grupo: un pago
     * que apareciera en los dos también sería un defecto, y contarlo una sola
     * vez es parte de lo que hace que el total de la semana signifique algo.
     */
    const hoyMismo = await comprobanteQueVence(arToday(), '00000004');

    const agenda = await listPayments(escenario.admin);

    expect(agenda.proximos.map((p) => p.documentId)).not.toContain(hoyMismo);
    expect(agenda.venceHoy.map((p) => p.documentId)).toContain(hoyMismo);
  });

  it('la reclasificación queda escrita, no es sólo de la vista', async () => {
    /*
     * El estado vive en la base porque lo miran otras pantallas —el tablero,
     * los informes— y no todas pasan por acá. Si la agenda lo corrigiera sólo
     * para mostrarlo, el tablero seguiría contando mal.
     */
    const ayer = await comprobanteQueVence(addDays(arToday(), -1), '00000005');

    await listPayments(escenario.admin);

    const guardado = await prisma.paymentSchedule.findUniqueOrThrow({
      where: { documentId: ayer },
    });
    expect(guardado.status).toBe('VENCIDO');
  });
});
