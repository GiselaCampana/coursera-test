import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { limpiarBase, sembrarEscenario, type Escenario } from './ayudas';
import { sembrarLaCompraDeEzra } from '../fixtures/compra-de-ezra';
import { EZRA_ENCABEZADO } from '../fixtures/ezra';
import { EZRA_FOTO } from '../fixtures/ezra-foto';
import { analizadorEzra } from '@/lib/ocr/parsers';
import { vistaPreviaDeCompra, aplicarCompra } from '@/lib/services/vista-previa-compra';
import { toISODate, toDateOnly, formatDateAr, addDays } from '@/lib/datetime';

/**
 * **La fecha de emisión de Ezra, desde la foto hasta la pantalla.**
 *
 * La emisión no es un dato cualquiera: es contra ella que se mide el
 * vencimiento, así que si se mueve un día se mueve todo lo que cuelga. Esta
 * prueba recorre la cadena entera —lo que el analizador congelado saca de la
 * foto, lo que se guarda, lo que se relee, lo que muestra la vista previa y lo
 * que se agenda— y exige el mismo día en cada eslabón.
 *
 * Que la cadena esté escrita como una sola prueba es a propósito. Cada eslabón
 * por separado ya estaba cubierto; lo que faltaba era la afirmación de que
 * ninguno de los empalmes corre la fecha, que es justamente donde se corren.
 */

let escenario: Escenario;
let completa: string;

/** El día impreso en el papel, según el analizador congelado. */
const EMISION = EZRA_ENCABEZADO.issueDate;

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();
  const sembrada = await sembrarLaCompraDeEzra(prisma, {
    sucursalId: escenario.sucursales.devoto,
    autorId: escenario.admin.id,
  });
  completa = sembrada.completa;
});

describe('la emisión es la misma en toda la cadena', () => {
  it('el analizador congelado la saca de la foto y coincide con el encabezado', () => {
    /*
     * El primer eslabón, y el que manda: `EZRA_ENCABEZADO.issueDate` no es un
     * valor elegido, es lo que el analizador lee del texto real de la foto. Si
     * alguna vez hay que cambiar la fecha de esta demostración, hay que
     * empezar por acá, y esto no se toca sin tocar el motor congelado.
     */
    expect(analizadorEzra.analizar(EZRA_FOTO).header?.issueDate).toBe(EMISION);
  });

  it('lo guardado y releído de la base es el mismo día', () => {
    // Se relee de la base, no de la variable que se acaba de escribir.
    return prisma.document.findUniqueOrThrow({ where: { id: completa } }).then((documento) => {
      expect(documento.issueDate).not.toBeNull();
      expect(toISODate(toDateOnly(documento.issueDate!))).toBe(EMISION);
    });
  });

  it('la vista previa muestra ese mismo día en el encabezado', async () => {
    const previa = await vistaPreviaDeCompra(escenario.admin, completa);
    const campo = previa.encabezado.find((c) => c.etiqueta === 'Fecha de emisión');
    const [anio, mes, dia] = EMISION.split('-');
    expect(campo?.valor).toBe(`${dia}/${mes}/${anio}`);
    expect(campo?.procedencia).toBe('LEIDO');
  });

  it('y la manda al navegador en ISO, sin correrla', async () => {
    /*
     * Es lo que usa el formulario para calcular la fecha que va a mostrar
     * antes de aplicar. Viaja como texto: si acá se corriera un día, la
     * pantalla prometería un vencimiento y el servidor guardaría otro.
     */
    const previa = await vistaPreviaDeCompra(escenario.admin, completa);
    expect(previa.egreso.emisionISO).toBe(EMISION);

    const viajada = JSON.parse(JSON.stringify(previa.egreso)) as { emisionISO: string };
    expect(viajada.emisionISO).toBe(EMISION);
  });
});

describe('el vencimiento se mide contra esa emisión, y se relee igual', () => {
  const PAGO = { forma: 'EFECTIVO', condicion: { tipo: 'CONTADO' as const } };

  it('al contado vence el día de emisión, y así queda guardado', async () => {
    await aplicarCompra(escenario.admin, completa, PAGO);

    const agendado = await prisma.paymentSchedule.findFirstOrThrow({
      where: { documentId: completa },
    });
    expect(toISODate(toDateOnly(agendado.dueDate))).toBe(EMISION);
    // Y escrito como lo lee una persona, sin corrimiento.
    const [anio, mes, dia] = EMISION.split('-');
    expect(formatDateAr(agendado.dueDate)).toBe(`${dia}/${mes}/${anio}`);
  });

  it('a 30 días vence a 30 días de la emisión', async () => {
    await aplicarCompra(escenario.admin, completa, {
      forma: 'TRANSFERENCIA',
      condicion: { tipo: 'DIAS', dias: 30 },
    });

    const agendado = await prisma.paymentSchedule.findFirstOrThrow({
      where: { documentId: completa },
    });
    const esperado = toISODate(addDays(toDateOnly(new Date(`${EMISION}T12:00:00Z`)), 30));
    expect(toISODate(toDateOnly(agendado.dueDate))).toBe(esperado);
  });

  it('el día anterior a la emisión se rechaza, y no escribe nada', async () => {
    const anterior = toISODate(addDays(toDateOnly(new Date(`${EMISION}T12:00:00Z`)), -1));

    await expect(
      aplicarCompra(escenario.admin, completa, {
        forma: 'EFECTIVO',
        condicion: { tipo: 'FECHA', fecha: anterior },
      }),
    ).rejects.toThrow(/anterior a la emisión/i);

    expect(await prisma.paymentSchedule.count({ where: { documentId: completa } })).toBe(0);
    expect(await prisma.purchaseMovement.count()).toBe(0);
  });

  it('el mismo día de emisión, elegido a mano, se acepta', async () => {
    await aplicarCompra(escenario.admin, completa, {
      forma: 'CHEQUE',
      condicion: { tipo: 'FECHA', fecha: EMISION },
    });

    const agendado = await prisma.paymentSchedule.findFirstOrThrow({
      where: { documentId: completa },
    });
    expect(toISODate(toDateOnly(agendado.dueDate))).toBe(EMISION);
  });
});
