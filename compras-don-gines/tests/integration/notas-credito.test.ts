import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { ValidationError } from '@/lib/errors';
import { toDecimal } from '@/lib/money';
import { confirmDocument, createDocument } from '@/lib/services/documents';
import {
  confirmarNotaDeCredito,
  creditoAplicadoA,
  saldoDeProveedor,
  type CreditNoteItemInput,
  type MotivoDeCredito,
} from '@/lib/services/notas-credito';
import { confirmPayment, listPayments } from '@/lib/services/payments';
import { getLatestCost } from '@/lib/services/pricing';
import { getPurchaseReport } from '@/lib/services/reports';
import { admiteDevolucion } from '@/lib/domain/notas-credito';
import { limpiarBase, sembrarEscenario, type Escenario } from './ayudas';

/**
 * Notas de crédito de proveedor.
 *
 * Lo que se prueba acá es la distinción que da sentido a todo el resto: una
 * nota de crédito **siempre** resta plata y **sólo a veces** mueve mercadería.
 * Las tres formas que toma en la práctica —financiera, con devolución y
 * mixta— tienen que quedar registradas de manera distinta, y la diferencia
 * tiene que sobrevivir al saldo del proveedor, a la agenda de pagos, al
 * reporte de compras y al historial de costos.
 */

let escenario: Escenario;

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();
});

/*
 * Una factura chica y redonda, para poder seguir los números a mano.
 *
 * 10 kg a $10.000 = $100.000 de neto, IVA 21 % = $21.000, sin percepciones:
 * total $121.000. Que los números cierren de memoria es lo que permite mirar
 * un saldo y saber si está bien sin recalcular nada.
 */
const RENGLON_FACTURA = {
  lineNumber: 1,
  supplierCode: 'ART-00228',
  description: 'CREMOSO PUNTA DEL AGUA',
  quantity: '10',
  unit: 'KG' as const,
  unitNetPrice: '10000',
  grossSubtotal: '100000',
  discountPct: '0',
  ivaRate: '0.21',
};

const PIE_FACTURA = {
  netTotal: '100000',
  ivaTotal: '21000',
  perceptionsTotal: '0',
  total: '121000',
  lineCount: 1,
};

/** La factura de $121.000, confirmada y asociada al PLU 1001. */
async function facturaDe121000(numero = '00000001') {
  const doc = await createDocument(escenario.admin, escenario.sucursales.devoto);
  await confirmDocument(escenario.admin, {
    documentId: doc.id,
    supplierId: escenario.proveedorErrecaldeId,
    docType: 'FACTURA',
    letter: 'A',
    pointOfSale: '0003',
    number: numero,
    issueDate: '2026-08-10',
    printed: PIE_FACTURA,
    items: [{ ...RENGLON_FACTURA, productId: escenario.productos['1001'] }],
    payment: { dueDate: '2026-09-10', paymentMethod: 'TRANSFERENCIA', notes: null },
  });
  return doc.id;
}

/**
 * Una nota de crédito sobre esa factura.
 *
 * Por omisión es financiera: $10.000 de neto, $2.100 de IVA, $12.100 en total,
 * y ningún renglón devuelto.
 */
async function notaDeCredito(opciones: {
  numero?: string;
  motivo?: MotivoDeCredito;
  relacionadaA?: string | null;
  items?: CreditNoteItemInput[];
  printed?: typeof PIE_FACTURA;
} = {}) {
  const doc = await createDocument(escenario.admin, escenario.sucursales.devoto);
  return confirmarNotaDeCredito(escenario.admin, {
    documentId: doc.id,
    supplierId: escenario.proveedorErrecaldeId,
    letter: 'A',
    pointOfSale: '0003',
    number: opciones.numero ?? '00009001',
    issueDate: '2026-08-20',
    motivo: opciones.motivo ?? 'BONIFICACION',
    relatedDocumentId: opciones.relacionadaA ?? null,
    printed: opciones.printed ?? {
      netTotal: '10000',
      ivaTotal: '2100',
      perceptionsTotal: '0',
      total: '12100',
      lineCount: 1,
    },
    items: opciones.items ?? [
      {
        lineNumber: 1,
        supplierCode: 'ART-00228',
        description: 'BONIFICACION CREMOSO PUNTA DEL AGUA',
        quantity: '10',
        unit: 'KG',
        unitNetPrice: '1000',
        grossSubtotal: '10000',
        discountPct: '0',
        ivaRate: '0.21',
        productId: escenario.productos['1001'],
        stockReturn: false,
      },
    ],
  });
}

describe('la nota de crédito financiera: resta plata y no mueve un kilo', () => {
  it('queda guardada como nota de crédito, con su motivo', async () => {
    const facturaId = await facturaDe121000();
    const resultado = await notaDeCredito({ relacionadaA: facturaId });

    const nota = await prisma.document.findUniqueOrThrow({
      where: { id: resultado.documentId },
    });
    expect(nota.docType).toBe('NOTA_CREDITO');
    expect(nota.creditReason).toBe('BONIFICACION');
    expect(nota.relatedDocumentId).toBe(facturaId);
    expect(nota.status).toBe('VALIDADO');
    expect(resultado.credito).toBe('12100.00');
    expect(resultado.renglonesConDevolucion).toBe(0);
  });

  it('no genera agenda de pago: una nota de crédito no se paga', async () => {
    const resultado = await notaDeCredito();
    const agenda = await prisma.paymentSchedule.count({
      where: { documentId: resultado.documentId },
    });
    expect(agenda).toBe(0);
  });

  it('no saca mercadería del negocio', async () => {
    /*
     * El control central de todo esto. El movimiento existe —la plata se
     * movió— pero la cantidad es cero: no salió un kilo. Si acá apareciera
     * −10 kg, el stock quedaría corto por una bonificación.
     */
    const resultado = await notaDeCredito();
    const movimientos = await prisma.purchaseMovement.findMany({
      where: { documentId: resultado.documentId },
    });

    expect(movimientos).toHaveLength(1);
    expect(Number(movimientos[0].quantity)).toBe(0);
    expect(movimientos[0].weightKg).toBeNull();
    // Y la plata sí se movió, en contra.
    expect(Number(movimientos[0].netAmount)).toBe(-10000);
    expect(Number(movimientos[0].totalCost)).toBe(-12100);
  });

  it('el renglón queda marcado como sin devolución', async () => {
    const resultado = await notaDeCredito();
    const renglones = await prisma.documentItem.findMany({
      where: { documentId: resultado.documentId },
    });
    expect(renglones[0].stockReturn).toBe(false);
  });
});

describe('la nota de crédito con devolución física', () => {
  const RENGLON_DEVUELTO: CreditNoteItemInput = {
    lineNumber: 1,
    supplierCode: 'ART-00228',
    description: 'CREMOSO PUNTA DEL AGUA (devolución)',
    quantity: '2',
    unit: 'KG',
    unitNetPrice: '10000',
    grossSubtotal: '20000',
    discountPct: '0',
    ivaRate: '0.21',
    stockReturn: true,
  };

  const PIE_DEVOLUCION = {
    netTotal: '20000',
    ivaTotal: '4200',
    perceptionsTotal: '0',
    total: '24200',
    lineCount: 1,
  };

  it('registra el movimiento inverso: salen los kilos que volvieron', async () => {
    const facturaId = await facturaDe121000();
    const resultado = await notaDeCredito({
      motivo: 'DEVOLUCION_MERCADERIA',
      relacionadaA: facturaId,
      items: [{ ...RENGLON_DEVUELTO, productId: escenario.productos['1001'] }],
      printed: PIE_DEVOLUCION,
    });

    expect(resultado.renglonesConDevolucion).toBe(1);
    const movimiento = await prisma.purchaseMovement.findFirstOrThrow({
      where: { documentId: resultado.documentId },
    });
    expect(Number(movimiento.quantity)).toBe(-2);
    expect(Number(movimiento.totalCost)).toBe(-24200);

    const renglon = await prisma.documentItem.findFirstOrThrow({
      where: { documentId: resultado.documentId },
    });
    expect(renglon.stockReturn).toBe(true);
  });

  it('la devolución no toca el costo unitario del artículo', async () => {
    /*
     * Devolver 2 kg no cambia lo que costó el kilo: cambia cuántos kilos hay.
     * Si además se ajustara el costo, el mismo hecho se contaría dos veces y
     * el precio de venta saldría mal.
     */
    const facturaId = await facturaDe121000();
    const costoDespuesDeLaFactura = await getLatestCost(escenario.productos['1001']);

    await notaDeCredito({
      motivo: 'DEVOLUCION_MERCADERIA',
      relacionadaA: facturaId,
      items: [{ ...RENGLON_DEVUELTO, productId: escenario.productos['1001'] }],
      printed: PIE_DEVOLUCION,
    });

    const despues = await getLatestCost(escenario.productos['1001']);
    expect(despues.unitCost?.toFixed(4)).toBe(costoDespuesDeLaFactura.unitCost?.toFixed(4));
    expect(await prisma.costHistory.count({ where: { kind: 'AJUSTE_NC' } })).toBe(0);
  });

  it('el reporte de compras descuenta los kilos devueltos', async () => {
    const facturaId = await facturaDe121000();
    await notaDeCredito({
      motivo: 'DEVOLUCION_MERCADERIA',
      relacionadaA: facturaId,
      items: [{ ...RENGLON_DEVUELTO, productId: escenario.productos['1001'] }],
      printed: PIE_DEVOLUCION,
    });

    const reporte = await getPurchaseReport(escenario.admin, {
      productId: escenario.productos['1001'],
    });
    // Se compraron 10 kg y volvieron 2: quedan 8.
    expect(Number(reporte.totals.kilos)).toBe(8);
  });

  it('una nota financiera no descuenta kilos en el reporte', async () => {
    const facturaId = await facturaDe121000();
    await notaDeCredito({ relacionadaA: facturaId });

    const reporte = await getPurchaseReport(escenario.admin, {
      productId: escenario.productos['1001'],
    });
    expect(Number(reporte.totals.kilos)).toBe(10);
  });
});

describe('la nota de crédito mixta', () => {
  it('cada renglón hace lo suyo: uno vuelve y el otro sólo corrige el importe', async () => {
    const facturaId = await facturaDe121000();
    const resultado = await notaDeCredito({
      motivo: 'DEVOLUCION_MERCADERIA',
      relacionadaA: facturaId,
      printed: {
        netTotal: '25000',
        ivaTotal: '5250',
        perceptionsTotal: '0',
        total: '30250',
        lineCount: 2,
      },
      items: [
        {
          lineNumber: 1,
          supplierCode: 'ART-00228',
          description: 'CREMOSO PUNTA DEL AGUA (devolución)',
          quantity: '2',
          unit: 'KG',
          unitNetPrice: '10000',
          grossSubtotal: '20000',
          discountPct: '0',
          ivaRate: '0.21',
          productId: escenario.productos['1001'],
          stockReturn: true,
        },
        {
          lineNumber: 2,
          supplierCode: 'ART-00347',
          description: 'DIFERENCIA DE PRECIO SALAME CRESPON',
          quantity: '5',
          unit: 'KG',
          unitNetPrice: '1000',
          grossSubtotal: '5000',
          discountPct: '0',
          ivaRate: '0.21',
          productId: escenario.productos['1002'],
          stockReturn: false,
        },
      ],
    });

    expect(resultado.renglonesConDevolucion).toBe(1);

    const movimientos = await prisma.purchaseMovement.findMany({
      where: { documentId: resultado.documentId },
      orderBy: { description: 'asc' },
    });
    expect(movimientos).toHaveLength(2);

    const devuelto = movimientos.find((m) => m.description.includes('devolución'))!;
    const corregido = movimientos.find((m) => m.description.includes('DIFERENCIA'))!;

    // El que volvió mueve kilos; el que sólo corrige, no.
    expect(Number(devuelto.quantity)).toBe(-2);
    expect(Number(corregido.quantity)).toBe(0);

    // Los dos restan plata.
    expect(Number(devuelto.netAmount)).toBe(-20000);
    expect(Number(corregido.netAmount)).toBe(-5000);
  });
});

describe('la regla de qué motivo puede llevar mercadería, una sola vez', () => {
  /*
   * La pantalla y el servidor tienen que estar de acuerdo. Si la pantalla
   * creyera que una bonificación admite devolución, ofrecería una casilla que
   * el servidor rechaza, y el operador vería un error sobre algo que la
   * aplicación misma le ofreció marcar.
   */
  it('los motivos financieros no admiten devolución', () => {
    for (const motivo of [
      'BONIFICACION',
      'DIFERENCIA_PRECIO',
      'DESCUENTO_COMERCIAL',
      'CORRECCION_FISCAL',
      'DEVOLUCION_PERCEPCION',
    ]) {
      expect(admiteDevolucion(motivo), motivo).toBe(false);
    }
  });

  it('la devolución de mercadería, y el motivo abierto, sí', () => {
    expect(admiteDevolucion('DEVOLUCION_MERCADERIA')).toBe(true);
    expect(admiteDevolucion('OTRO')).toBe(true);
  });
});

describe('lo que la aplicación se niega a suponer', () => {
  it('no acepta «devolución de mercadería» sin decir qué renglón volvió', async () => {
    /*
     * El motivo dice que volvió mercadería y ningún renglón lo confirma. Antes
     * que elegir por el operador —y mover stock que quizá no se movió— se pide
     * que lo diga.
     */
    await expect(
      notaDeCredito({ motivo: 'DEVOLUCION_MERCADERIA' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('no acepta una devolución bajo un motivo que es sólo financiero', async () => {
    await expect(
      notaDeCredito({
        motivo: 'BONIFICACION',
        items: [
          {
            lineNumber: 1,
            supplierCode: 'ART-00228',
            description: 'CREMOSO',
            quantity: '10',
            unit: 'KG',
            unitNetPrice: '1000',
            grossSubtotal: '10000',
            discountPct: '0',
            ivaRate: '0.21',
            stockReturn: true,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('no relaciona una nota con la factura de otro proveedor', async () => {
    const doc = await createDocument(escenario.admin, escenario.sucursales.devoto);
    await confirmDocument(escenario.admin, {
      documentId: doc.id,
      supplierId: escenario.proveedorId,
      docType: 'FACTURA',
      letter: 'A',
      pointOfSale: '0010',
      number: '00777001',
      issueDate: '2026-08-10',
      printed: PIE_FACTURA,
      items: [{ ...RENGLON_FACTURA, productId: escenario.productos['1001'] }],
      payment: { dueDate: '2026-09-10', paymentMethod: 'TRANSFERENCIA', notes: null },
    });

    await expect(notaDeCredito({ relacionadaA: doc.id })).rejects.toBeInstanceOf(ValidationError);
  });

  it('no acredita más de lo que dice la factura', async () => {
    const facturaId = await facturaDe121000();
    await expect(
      notaDeCredito({
        relacionadaA: facturaId,
        printed: {
          netTotal: '200000',
          ivaTotal: '42000',
          perceptionsTotal: '0',
          total: '242000',
          lineCount: 1,
        },
        items: [
          {
            lineNumber: 1,
            supplierCode: 'ART-00228',
            description: 'BONIFICACION',
            quantity: '10',
            unit: 'KG',
            unitNetPrice: '20000',
            grossSubtotal: '200000',
            discountPct: '0',
            ivaRate: '0.21',
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('no guarda una nota de crédito cuyo detalle no cierra con su pie', async () => {
    await expect(
      notaDeCredito({
        printed: {
          netTotal: '10000',
          ivaTotal: '2100',
          perceptionsTotal: '0',
          // El total impreso no es neto + IVA.
          total: '99999',
          lineCount: 1,
        },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('la trazabilidad del costo', () => {
  it('el costo original queda intacto y el ajuste se agrega al lado', async () => {
    const facturaId = await facturaDe121000();
    const original = await prisma.costHistory.findFirstOrThrow({
      where: { productId: escenario.productos['1001'] },
    });
    const costoOriginal = original.unitCost.toString();

    await notaDeCredito({ motivo: 'DIFERENCIA_PRECIO', relacionadaA: facturaId });

    /*
     * Lo que no puede pasar es que el renglón de la factura cambie: es de
     * dónde salió el costo, y reescribirlo haría desaparecer el hecho.
     */
    const despuesDelAjuste = await prisma.costHistory.findUniqueOrThrow({
      where: { id: original.id },
    });
    expect(despuesDelAjuste.unitCost.toString()).toBe(costoOriginal);
    expect(despuesDelAjuste.kind).toBe('COMPRA');

    // Y el ajuste está, como un renglón aparte, con su comprobante.
    const ajustes = await prisma.costHistory.findMany({
      where: { productId: escenario.productos['1001'], kind: 'AJUSTE_NC' },
    });
    expect(ajustes).toHaveLength(1);
    expect(ajustes[0].previousUnitCost?.toString()).toBe(costoOriginal);
    expect(Number(ajustes[0].deltaAmount)).toBeLessThan(0);
  });

  it('la pantalla de precios puede decir que el costo lo dejó una nota de crédito', async () => {
    /*
     * Un costo bajado por una bonificación se ve igual que una baja de precio
     * del proveedor. No son lo mismo: el descuento fue por esta compra. Sin
     * poder distinguirlos, el margen del mes que viene se calcula sobre un
     * costo que ya no existe.
     */
    const facturaId = await facturaDe121000();
    expect((await getLatestCost(escenario.productos['1001'])).origin).toBe('COMPRA');

    await notaDeCredito({ motivo: 'DIFERENCIA_PRECIO', relacionadaA: facturaId });
    expect((await getLatestCost(escenario.productos['1001'])).origin).toBe('AJUSTE_NC');
  });

  it('el costo efectivo del artículo pasa a ser el ajustado', async () => {
    /*
     * La factura deja el kilo en $12.100 (con el IVA repartido). La nota de
     * crédito acredita $1.000 + IVA por kilo, o sea $1.210. El costo vigente
     * tiene que quedar en $10.890, que es lo que de verdad terminó costando.
     */
    const facturaId = await facturaDe121000();
    const antes = await getLatestCost(escenario.productos['1001']);
    expect(antes.unitCost?.toFixed(2)).toBe('12100.00');

    await notaDeCredito({ motivo: 'DIFERENCIA_PRECIO', relacionadaA: facturaId });

    const despues = await getLatestCost(escenario.productos['1001']);
    expect(despues.unitCost?.toFixed(2)).toBe('10890.00');
    expect(despues.previousUnitCost?.toFixed(2)).toBe('12100.00');
  });
});

describe('la cuenta corriente del proveedor', () => {
  it('el saldo es facturas − notas de crédito − pagos', async () => {
    const facturaId = await facturaDe121000();
    await notaDeCredito({ relacionadaA: facturaId });

    const saldo = await saldoDeProveedor(escenario.proveedorErrecaldeId);
    expect(saldo.facturas).toBe('121000.00');
    expect(saldo.notasDeCredito).toBe('12100.00');
    expect(saldo.pagos).toBe('0.00');
    expect(saldo.saldo).toBe('108900.00');
  });

  it('una nota de crédito general, sin factura relacionada, también baja el saldo', async () => {
    /*
     * Una bonificación trimestral no corresponde a un comprobante en
     * particular. Si sólo contaran las notas relacionadas, esa plata quedaría
     * afuera del saldo y se le terminaría pagando de más al proveedor.
     */
    await facturaDe121000();
    await notaDeCredito({ relacionadaA: null });

    const saldo = await saldoDeProveedor(escenario.proveedorErrecaldeId);
    expect(saldo.saldo).toBe('108900.00');
  });

  it('factura + nota de crédito + pago parcial dan el saldo correcto', async () => {
    const facturaId = await facturaDe121000();
    await notaDeCredito({ relacionadaA: facturaId });

    const schedule = await prisma.paymentSchedule.findFirstOrThrow({
      where: { documentId: facturaId },
    });
    await confirmPayment(escenario.admin, {
      scheduleId: schedule.id,
      effectiveDate: '2026-08-25',
      paymentMethod: 'TRANSFERENCIA',
      amount: '50000',
    });

    const saldo = await saldoDeProveedor(escenario.proveedorErrecaldeId);
    // 121.000 − 12.100 − 50.000
    expect(saldo.saldo).toBe('58900.00');
  });
});

describe('la agenda de pagos con notas de crédito', () => {
  it('la factura se muestra por lo que de verdad hay que transferir', async () => {
    const facturaId = await facturaDe121000();
    await notaDeCredito({ relacionadaA: facturaId });

    const agenda = await listPayments(escenario.admin);
    const todos = [...agenda.proximos, ...agenda.venceHoy, ...agenda.vencidos, ...agenda.pagados];
    const pago = todos.find((p) => p.documentId === facturaId)!;

    expect(pago.plannedAmount.toString()).toBe('121000');
    expect(pago.creditoAplicado).toBe('12100.00');
    expect(pago.importeAPagar).toBe('108900.00');
  });

  it('no deja pagar más que lo que queda después del crédito', async () => {
    const facturaId = await facturaDe121000();
    await notaDeCredito({ relacionadaA: facturaId });
    const schedule = await prisma.paymentSchedule.findFirstOrThrow({
      where: { documentId: facturaId },
    });

    await expect(
      confirmPayment(escenario.admin, {
        scheduleId: schedule.id,
        effectiveDate: '2026-08-25',
        paymentMethod: 'TRANSFERENCIA',
        // El importe entero de la factura, ignorando la nota de crédito.
        amount: '121000',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('pagando el neto la factura queda saldada', async () => {
    /*
     * Sin esto, el comprobante quedaría eternamente "pendiente por $12.100"
     * pese a estar cancelado: el proveedor lo da por cobrado y la aplicación
     * sigue reclamándolo.
     */
    const facturaId = await facturaDe121000();
    await notaDeCredito({ relacionadaA: facturaId });
    const schedule = await prisma.paymentSchedule.findFirstOrThrow({
      where: { documentId: facturaId },
    });

    const pagado = await confirmPayment(escenario.admin, {
      scheduleId: schedule.id,
      effectiveDate: '2026-08-25',
      paymentMethod: 'TRANSFERENCIA',
      amount: '108900',
    });
    expect(pagado.status).toBe('PAGADO');

    const saldo = await saldoDeProveedor(escenario.proveedorErrecaldeId);
    expect(saldo.saldo).toBe('0.00');
  });

  it('el crédito aplicado se puede consultar por comprobante', async () => {
    const facturaId = await facturaDe121000();
    await notaDeCredito({ relacionadaA: facturaId, numero: '00009001' });
    await notaDeCredito({ relacionadaA: facturaId, numero: '00009002' });

    const creditos = await creditoAplicadoA([facturaId]);
    // Dos notas de $12.100 sobre la misma factura.
    expect(toDecimal(creditos.get(facturaId)!.toString()).toFixed(2)).toBe('24200.00');
  });
});
