import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { getStorage, buildDocumentKey } from '@/lib/storage';
import { ForbiddenError } from '@/lib/errors';
import {
  confirmDocument,
  createDocument,
  processDocument,
  rejectDocument,
  voidDocument,
  type ConfirmDocumentInput,
} from '@/lib/services/documents';
import { confirmPayment } from '@/lib/services/payments';
import { suggestPricesFor, approveSalePrice, getLatestCost } from '@/lib/services/pricing';
import { getPurchaseReport, purchaseReportToCsv } from '@/lib/services/reports';
import { computePaymentStatus } from '@/lib/domain/payments';
import { toISODate, dateOnlyFromISO } from '@/lib/datetime';
import { limpiarBase, sembrarEscenario, type Escenario } from './ayudas';
import { LOS_CALVOS_TEXT, LOS_CALVOS_ITEMS, LOS_CALVOS_PRINTED } from '../fixtures/los-calvos';

let escenario: Escenario;

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();
});

/**
 * Adjunta una página al comprobante.
 *
 * En las pruebas la página es la transcripción del comprobante, que es lo que
 * devolvería un OCR documental. Así el circuito completo —almacenamiento,
 * lectura, cálculo, control y guardado— se ejercita de punta a punta sin
 * depender de un servicio externo.
 */
async function adjuntarPagina(documentId: string, texto: string, orden = 1) {
  const storage = await getStorage();
  const buffer = Buffer.from(texto, 'utf8');
  const key = buildDocumentKey({ documentId, pageOrder: orden, variant: 'work', extension: 'txt' });
  await storage.put(key, buffer, 'text/plain');
  await prisma.documentFile.create({
    data: {
      documentId,
      pageOrder: orden,
      storageKey: key,
      mimeType: 'text/plain',
      originalMimeType: 'text/plain',
      sizeBytes: buffer.length,
      originalSizeBytes: buffer.length,
      sha256: `prueba-${documentId}-${orden}`,
    },
  });
}

function datosConfirmacion(overrides: Partial<ConfirmDocumentInput> = {}): Omit<
  ConfirmDocumentInput,
  'documentId'
> {
  return {
    supplierId: escenario.proveedorId,
    docType: 'FACTURA',
    letter: 'A',
    pointOfSale: '0010',
    number: '00212356',
    issueDate: '2026-08-14',
    printed: LOS_CALVOS_PRINTED,
    items: LOS_CALVOS_ITEMS.map((item, i) => ({
      ...item,
      productId: escenario.productos[String(1001 + i)] ?? null,
    })),
    payment: { dueDate: '2026-08-14', paymentMethod: 'TRANSFERENCIA', notes: null },
    ...overrides,
  };
}

describe('caso de aceptación: factura Los Calvos de punta a punta', () => {
  it('lee el comprobante, lo controla y lo deja listo para confirmar', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);

    const resultado = await processDocument(escenario.operadorDevoto, documento.id);

    expect(resultado.report.canSave).toBe(true);
    expect(resultado.report.computed.itemCount).toBe(9);
    expect(resultado.report.computed.netAmount).toBe('1792751.44');
    expect(resultado.report.computed.totalQuantityKg).toBe('153.700');
    expect(resultado.supplierId).toBe(escenario.proveedorId);
    // Los nueve renglones quedaron asociados a productos del catálogo.
    expect(resultado.matchedItems).toBe(9);
    expect(resultado.unmatchedItems).toBe(0);

    const guardado = await prisma.document.findUniqueOrThrow({
      where: { id: documento.id },
      include: { items: true, ocrAttempts: true },
    });
    expect(guardado.status).toBe('REQUIERE_REVISION');
    expect(guardado.items).toHaveLength(9);
    expect(guardado.fullNumber).toBe('0010-00212356');
    expect(toISODate(guardado.issueDate!)).toBe('2026-08-14');
    // Guardó las condiciones vigentes del proveedor.
    expect(guardado.appliedTermType).toBe('SAME_DAY');
    expect(guardado.appliedIvaRate?.toString()).toBe('0.21');
    expect(guardado.appliedIibbRate?.toString()).toBe('0.015');
    expect(toISODate(guardado.appliedDueDate!)).toBe('2026-08-14');
    // Y dejó el rastro de las lecturas.
    expect(guardado.ocrAttempts.length).toBeGreaterThan(0);
    expect(guardado.ocrAttempts[0].provider).toBe('mock');
    expect(guardado.ocrAttempts[0].recognizedText).toContain('LONGANIZA');
  });

  it('al confirmar guarda artículos, movimientos, costos y agenda de pago', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);
    await processDocument(escenario.operadorDevoto, documento.id);

    const resultado = await confirmDocument(escenario.admin, {
      ...datosConfirmacion(),
      documentId: documento.id,
    });

    expect(resultado.report.canSave).toBe(true);
    expect(resultado.forced).toBe(false);

    const guardado = await prisma.document.findUniqueOrThrow({
      where: { id: documento.id },
      include: {
        items: { orderBy: { lineNumber: 'asc' } },
        taxLines: true,
        purchaseMovements: true,
        paymentSchedule: true,
      },
    });

    expect(guardado.status).toBe('VALIDADO');
    expect(guardado.checkState).toBe('OK');
    expect(guardado.items).toHaveLength(9);
    expect(guardado.purchaseMovements).toHaveLength(9);

    // Los importes cierran exactamente con la factura.
    const sumar = (valores: { toString(): string }[]) =>
      valores.reduce((acc, v) => acc + Number(v.toString()), 0);
    expect(sumar(guardado.items.map((i) => i.netAmount)).toFixed(2)).toBe('1792751.44');
    expect(sumar(guardado.items.map((i) => i.ivaAmount)).toFixed(2)).toBe('376477.81');
    expect(sumar(guardado.items.map((i) => i.perceptionAmount)).toFixed(2)).toBe('26891.27');
    expect(sumar(guardado.items.map((i) => i.totalCost)).toFixed(2)).toBe('2196120.52');
    expect(sumar(guardado.items.map((i) => i.quantity)).toFixed(2)).toBe('153.70');

    // El pago quedó agendado para la fecha de la factura, y NO pagado.
    expect(guardado.paymentSchedule).not.toBeNull();
    expect(toISODate(guardado.paymentSchedule!.dueDate)).toBe('2026-08-14');
    expect(guardado.paymentSchedule!.plannedAmount.toString()).toBe('2196120.52');
    expect(guardado.paymentSchedule!.paidAmount.toString()).toBe('0');
    expect(guardado.paymentSchedule!.status).not.toBe('PAGADO');

    // Historial de costos con el costo unitario final de cada producto.
    const costos = await prisma.costHistory.findMany();
    expect(costos).toHaveLength(9);

    // El IVA y la percepción quedaron discriminados.
    expect(guardado.taxLines.filter((t) => t.kind === 'IVA')).toHaveLength(1);
    expect(guardado.taxLines.filter((t) => t.kind === 'PERCEPCION')).toHaveLength(1);
  });

  it('una factura del día queda como "vence hoy" hasta que alguien confirme el pago', async () => {
    // El plazo de Los Calvos es "en el día": la fecha prevista es la de la
    // factura, pero eso no la marca pagada.
    const estado = computePaymentStatus(
      {
        dueDate: dateOnlyFromISO('2026-08-14'),
        plannedAmount: '2196120.52',
        paidAmount: '0',
      },
      new Date('2026-08-14T15:00:00Z'),
    );
    expect(estado).toBe('VENCE_HOY');
  });
});

describe('el backend revalida antes de guardar', () => {
  it('no guarda un comprobante cuyo detalle no cierra, aunque el pedido diga que sí', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);
    await processDocument(escenario.operadorDevoto, documento.id);

    // Falta un renglón: el neto ya no llega al impreso.
    const datos = datosConfirmacion();
    const error = await confirmDocument(escenario.admin, {
      ...datos,
      items: datos.items.slice(0, 8),
      documentId: documento.id,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/no se puede guardar como controlado/i);

    const guardado = await prisma.document.findUniqueOrThrow({ where: { id: documento.id } });
    expect(guardado.status).toBe('REQUIERE_REVISION');
    expect(await prisma.purchaseMovement.count()).toBe(0);
    expect(await prisma.paymentSchedule.count()).toBe(0);
  });

  it('un administrador puede forzarlo, pero sólo con un motivo y queda en auditoría', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);
    await processDocument(escenario.operadorDevoto, documento.id);

    const datos = datosConfirmacion();
    const incompleto = { ...datos, items: datos.items.slice(0, 8), documentId: documento.id };

    // Sin motivo suficiente, no.
    await expect(
      confirmDocument(escenario.admin, { ...incompleto, override: { reason: 'porque sí' } }),
    ).rejects.toThrow(/motivo/i);

    // Un operador no puede forzar aunque ponga el motivo.
    await expect(
      confirmDocument(escenario.operadorDevoto, {
        ...incompleto,
        override: { reason: 'El proveedor confirmó por teléfono que el subtotal está mal impreso.' },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // El administrador sí, y queda registrado.
    const resultado = await confirmDocument(escenario.admin, {
      ...incompleto,
      override: { reason: 'El proveedor confirmó por teléfono que el subtotal está mal impreso.' },
    });
    expect(resultado.forced).toBe(true);

    const guardado = await prisma.document.findUniqueOrThrow({ where: { id: documento.id } });
    expect(guardado.status).toBe('VALIDADO');
    // Forzado no es lo mismo que controlado: el semáforo queda en rojo.
    expect(guardado.checkState).toBe('DIFERENCIA');
    expect(guardado.voidReason).toContain('teléfono');

    const auditoria = await prisma.auditLog.findFirst({
      where: { action: 'comprobante.forzado', entityId: documento.id },
    });
    expect(auditoria).not.toBeNull();
    expect(auditoria!.reason).toContain('teléfono');
  });
});

describe('duplicados', () => {
  it('no deja cargar dos veces la misma factura del mismo proveedor', async () => {
    const primero = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(primero.id, LOS_CALVOS_TEXT);
    await processDocument(escenario.operadorDevoto, primero.id);
    await confirmDocument(escenario.admin, { ...datosConfirmacion(), documentId: primero.id });

    // Otra sucursal intenta cargar la misma factura.
    const segundo = await createDocument(
      escenario.operadorPueyrredon,
      escenario.sucursales.pueyrredon,
    );
    await adjuntarPagina(segundo.id, LOS_CALVOS_TEXT);
    await processDocument(escenario.operadorPueyrredon, segundo.id);

    const error = await confirmDocument(escenario.admin, {
      ...datosConfirmacion(),
      documentId: segundo.id,
    }).catch((e) => e);

    expect(error.message).toMatch(/Ya está cargada/);
    expect(error.message).toContain('0010-00212356');
    expect(error.message).toContain('Devoto');
  });

  it('rechazar la primera carga libera el número para volver a cargarla', async () => {
    const primero = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(primero.id, LOS_CALVOS_TEXT);
    await processDocument(escenario.operadorDevoto, primero.id);
    await rejectDocument(escenario.operadorDevoto, primero.id, 'Se cargó en la sucursal equivocada');

    const segundo = await createDocument(
      escenario.operadorPueyrredon,
      escenario.sucursales.pueyrredon,
    );
    await adjuntarPagina(segundo.id, LOS_CALVOS_TEXT);
    await processDocument(escenario.operadorPueyrredon, segundo.id);

    const resultado = await confirmDocument(escenario.admin, {
      ...datosConfirmacion(),
      documentId: segundo.id,
    });
    expect(resultado.report.canSave).toBe(true);
  });

  it('la misma foto no se agrega dos veces al comprobante', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT, 1);
    // La restricción de unicidad por SHA-256 impide la segunda copia.
    await expect(adjuntarPagina(documento.id, LOS_CALVOS_TEXT, 1)).rejects.toThrow();
    expect(await prisma.documentFile.count({ where: { documentId: documento.id } })).toBe(1);
  });
});

describe('restricciones por sucursal', () => {
  it('un operador no puede cargar en otra sucursal', async () => {
    await expect(
      createDocument(escenario.operadorDevoto, escenario.sucursales.pueyrredon),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('un operador no puede confirmar el comprobante de otra sucursal', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);
    await processDocument(escenario.operadorDevoto, documento.id);

    await expect(
      confirmDocument(escenario.operadorPueyrredon, {
        ...datosConfirmacion(),
        documentId: documento.id,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('el administrador ve y confirma las tres sucursales', async () => {
    const documento = await createDocument(escenario.admin, escenario.sucursales.sanMartin);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);
    await processDocument(escenario.admin, documento.id);
    const resultado = await confirmDocument(escenario.admin, {
      ...datosConfirmacion(),
      documentId: documento.id,
    });
    expect(resultado.report.canSave).toBe(true);
  });

  it('un operador sólo ve las compras de su sucursal en los reportes', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);
    await processDocument(escenario.operadorDevoto, documento.id);
    await confirmDocument(escenario.admin, { ...datosConfirmacion(), documentId: documento.id });

    const enDevoto = await getPurchaseReport(escenario.operadorDevoto, {});
    expect(enDevoto.rows).toHaveLength(9);

    const enPueyrredon = await getPurchaseReport(escenario.operadorPueyrredon, {});
    expect(enPueyrredon.rows).toHaveLength(0);

    // Y no puede espiar la otra sucursal pidiéndola explícitamente.
    const espiando = await getPurchaseReport(escenario.operadorPueyrredon, {
      branchId: escenario.sucursales.devoto,
    });
    expect(espiando.rows).toHaveLength(0);

    const elAdmin = await getPurchaseReport(escenario.admin, {});
    expect(elAdmin.rows).toHaveLength(9);
  });
});

describe('permisos administrativos', () => {
  it('un operador no puede anular un comprobante', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);
    await processDocument(escenario.operadorDevoto, documento.id);
    await confirmDocument(escenario.admin, { ...datosConfirmacion(), documentId: documento.id });

    await expect(
      voidDocument(escenario.operadorDevoto, documento.id, 'Me equivoqué al cargarla'),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('un supervisor no puede cargar comprobantes', async () => {
    await expect(
      createDocument(escenario.supervisor, escenario.sucursales.devoto),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('anular exige motivo, cancela el pago y borra los movimientos de compra', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);
    await processDocument(escenario.operadorDevoto, documento.id);
    await confirmDocument(escenario.admin, { ...datosConfirmacion(), documentId: documento.id });

    await expect(voidDocument(escenario.admin, documento.id, 'error')).rejects.toThrow(/motivo/i);

    await voidDocument(escenario.admin, documento.id, 'El proveedor emitió una nota de crédito.');

    const guardado = await prisma.document.findUniqueOrThrow({
      where: { id: documento.id },
      include: { paymentSchedule: true },
    });
    expect(guardado.status).toBe('ANULADO');
    expect(guardado.voidReason).toContain('nota de crédito');
    expect(guardado.paymentSchedule!.status).toBe('CANCELADO');
    expect(await prisma.purchaseMovement.count()).toBe(0);

    const auditoria = await prisma.auditLog.findFirst({
      where: { action: 'comprobante.anulado', entityId: documento.id },
    });
    expect(auditoria!.reason).toContain('nota de crédito');
  });
});

describe('transacciones', () => {
  it('si algo falla al guardar, no queda nada a medio escribir', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);
    await processDocument(escenario.operadorDevoto, documento.id);

    const datos = datosConfirmacion();
    // El último renglón apunta a un producto inexistente: la escritura del
    // movimiento de compra viola la clave foránea a mitad de la transacción.
    const conProductoRoto = {
      ...datos,
      items: datos.items.map((item, i) =>
        i === datos.items.length - 1 ? { ...item, productId: 'producto-que-no-existe' } : item,
      ),
      documentId: documento.id,
    };

    await expect(confirmDocument(escenario.admin, conProductoRoto)).rejects.toThrow();

    // El comprobante sigue sin confirmar y no quedó ningún rastro parcial.
    const guardado = await prisma.document.findUniqueOrThrow({ where: { id: documento.id } });
    expect(guardado.status).toBe('REQUIERE_REVISION');
    expect(await prisma.purchaseMovement.count()).toBe(0);
    expect(await prisma.paymentSchedule.count()).toBe(0);
    expect(await prisma.costHistory.count()).toBe(0);
  });
});

describe('pagos', () => {
  async function comprobanteConfirmado() {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);
    await processDocument(escenario.operadorDevoto, documento.id);
    const resultado = await confirmDocument(escenario.admin, {
      ...datosConfirmacion(),
      documentId: documento.id,
    });
    return resultado.paymentScheduleId;
  }

  it('confirmar el pago no pisa la fecha prevista y deja el evento', async () => {
    const scheduleId = await comprobanteConfirmado();

    await confirmPayment(escenario.admin, {
      scheduleId,
      effectiveDate: '2026-08-18',
      paymentMethod: 'TRANSFERENCIA',
      reference: 'OP-99881',
      notes: 'Pagado con cheque diferido cambiado',
    });

    const agenda = await prisma.paymentSchedule.findUniqueOrThrow({
      where: { id: scheduleId },
      include: { events: true },
    });

    expect(agenda.status).toBe('PAGADO');
    expect(agenda.paidAmount.toString()).toBe('2196120.52');
    // La fecha prevista sigue siendo la de la factura.
    expect(toISODate(agenda.dueDate)).toBe('2026-08-14');
    // Y la efectiva quedó en el evento, junto con quién y cuándo lo confirmó.
    expect(agenda.events).toHaveLength(1);
    expect(toISODate(agenda.events[0].effectiveDate!)).toBe('2026-08-18');
    expect(agenda.events[0].reference).toBe('OP-99881');
    expect(agenda.events[0].userId).toBe(escenario.admin.id);
  });

  it('un operador no puede confirmar pagos', async () => {
    const scheduleId = await comprobanteConfirmado();
    await expect(
      confirmPayment(escenario.operadorDevoto, {
        scheduleId,
        effectiveDate: '2026-08-18',
        paymentMethod: 'TRANSFERENCIA',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('no acepta un pago mayor al saldo ni una fecha futura', async () => {
    const scheduleId = await comprobanteConfirmado();

    await expect(
      confirmPayment(escenario.admin, {
        scheduleId,
        effectiveDate: '2026-08-18',
        paymentMethod: 'EFECTIVO',
        amount: '9999999',
      }),
    ).rejects.toThrow(/supera el saldo/i);

    await expect(
      confirmPayment(escenario.admin, {
        scheduleId,
        effectiveDate: '2099-01-01',
        paymentMethod: 'EFECTIVO',
      }),
    ).rejects.toThrow(/futura/i);
  });

  it('admite un pago parcial y deja el comprobante abierto', async () => {
    const scheduleId = await comprobanteConfirmado();

    await confirmPayment(escenario.admin, {
      scheduleId,
      effectiveDate: '2026-08-18',
      paymentMethod: 'EFECTIVO',
      amount: '1000000',
    });

    const agenda = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(agenda.paidAmount.toString()).toBe('1000000');
    expect(agenda.status).not.toBe('PAGADO');
  });
});

describe('historial de precios y precios de venta', () => {
  it('guarda el costo, calcula la variación y sugiere el precio de venta', async () => {
    // Primera compra.
    const primero = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(primero.id, LOS_CALVOS_TEXT);
    await processDocument(escenario.operadorDevoto, primero.id);
    await confirmDocument(escenario.admin, { ...datosConfirmacion(), documentId: primero.id });

    const longanizaId = escenario.productos['1001'];
    const costoInicial = await getLatestCost(longanizaId);
    expect(costoInicial.unitCost).not.toBeNull();
    expect(costoInicial.previousUnitCost).toBeNull();

    // Segunda compra del mismo producto, más cara.
    const segundo = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    const datos = datosConfirmacion({
      number: '00212400',
      issueDate: '2026-08-20',
      payment: { dueDate: '2026-08-20', paymentMethod: 'TRANSFERENCIA', notes: null },
    });
    const aumentado = {
      ...datos,
      // Sólo el primer renglón, con un precio 20 % más alto.
      items: [
        {
          ...datos.items[0],
          unitNetPrice: '19244.40',
        },
      ],
      printed: {
        grossSubtotal: '309834.84',
        discountTotal: '43376.88',
        netTotal: '266457.96',
        ivaTotal: '55956.17',
        perceptionsTotal: '3996.87',
        total: '326411.00',
        lineCount: 1,
        netWeightKg: '16.10',
      },
      documentId: segundo.id,
    };
    await confirmDocument(escenario.admin, aumentado);

    const costo = await getLatestCost(longanizaId);
    expect(costo.previousUnitCost).not.toBeNull();
    expect(costo.deltaAmount!.gt(0)).toBe(true);
    // Aumento del 20 %.
    expect(Number(costo.deltaPct!.toString())).toBeGreaterThan(0.19);
    expect(Number(costo.deltaPct!.toString())).toBeLessThan(0.21);

    // Precio de venta sugerido a partir del costo unitario final.
    const sugerencia = await suggestPricesFor(longanizaId);
    expect(sugerencia.prices).not.toBeNull();
    // 45 % sobre el costo, redondeado al $100 más cercano.
    const esperado = costo.unitCost!.times(1.45);
    expect(Number(sugerencia.prices!.pricePerKg.toString())).toBeCloseTo(
      Math.round(Number(esperado.toString()) / 100) * 100,
      2,
    );
    // Los derivados salen del precio por kilo ya redondeado.
    expect(sugerencia.prices!.pricePer100g.toFixed(2)).toBe(
      sugerencia.prices!.pricePerKg.div(10).toFixed(2),
    );
    expect(sugerencia.prices!.pricePerQuarter.toFixed(2)).toBe(
      sugerencia.prices!.pricePerKg.div(4).toFixed(2),
    );

    // Aprobar el precio lo deja en el historial.
    await approveSalePrice(escenario.admin, {
      productId: longanizaId,
      approvedPricePerKg: sugerencia.prices!.pricePerKg.toString(),
    });
    const historial = await prisma.salePriceHistory.findMany({ where: { productId: longanizaId } });
    expect(historial).toHaveLength(1);
    expect(historial[0].approvedById).toBe(escenario.admin.id);
    expect(historial[0].costBasis.toString()).toBe(costo.unitCost!.toFixed(2));

    // Un operador no puede aprobar precios.
    await expect(
      approveSalePrice(escenario.operadorDevoto, {
        productId: longanizaId,
        approvedPricePerKg: '1000',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('reporte de compras', () => {
  it('responde cuántos kilos se compraron de cada artículo y lo exporta a CSV', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);
    await processDocument(escenario.operadorDevoto, documento.id);
    await confirmDocument(escenario.admin, { ...datosConfirmacion(), documentId: documento.id });

    const reporte = await getPurchaseReport(escenario.admin, {});
    expect(reporte.totals.kilos).toBe('153.70');
    expect(reporte.totals.costoTotal).toBe('2196120.52');
    expect(reporte.totals.comprobantes).toBe(1);

    // Filtrado por un producto.
    const soloJamon = await getPurchaseReport(escenario.admin, {
      productId: escenario.productos['1006'],
    });
    expect(soloJamon.rows).toHaveLength(1);
    expect(soloJamon.totals.kilos).toBe('37.60');

    const csv = purchaseReportToCsv(reporte);
    expect(csv).toContain('Costo unitario final');
    expect(csv).toContain('Longaniza corta');
    // Separador de punto y coma y decimales con coma, como espera Excel en español.
    expect(csv).toContain('";"');
    expect(csv).toContain('153,70');
  });
});
