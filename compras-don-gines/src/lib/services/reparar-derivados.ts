import 'server-only';
import { prisma, type Prisma } from '@/lib/db';
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/errors';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { hasPermission, type AuthUser } from '@/lib/auth/session';
import { Decimal, money, toDecimal } from '@/lib/money';
import { toDateOnly } from '@/lib/datetime';
import { computeDueDate, computePaymentStatus, esFechaProvisoria } from '@/lib/domain/payments';
import { matchProduct, normalizeText, type ProductCandidate } from '@/lib/domain/matching';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/services/audit';
import { getSupplierConditions } from '@/lib/services/suppliers';

/**
 * Reconstruye lo que la confirmación deriva de un comprobante ya validado.
 *
 * Existe por los comprobantes que se validaron cuando esa escritura podía
 * quedar a medias: la factura está bien, los importes están bien, y sin embargo
 * para Compras, Precios o la agenda no existe. La invariante que ahora corre
 * dentro de la transacción impide que vuelva a pasar; esto repara lo que ya
 * pasó, sin volver a cargar nada.
 *
 * Tres reglas lo definen:
 *
 *  - **No toca ningún importe.** Cantidades, kilos, precios, IVA, percepciones,
 *    costos y totales salen tal cual de los renglones que ya están guardados. Lo
 *    único que se recalcula es a qué producto pertenece cada compra, y sólo
 *    donde hoy está vacío.
 *  - **Es idempotente.** Correrlo dos veces deja lo mismo que correrlo una: los
 *    movimientos se buscan por renglón y se actualizan, nunca se agregan. Un
 *    movimiento duplicado contaría la compra dos veces en todos los reportes,
 *    que es peor que el problema que se vino a arreglar.
 *  - **No vuelve a leer la foto.** El OCR ya corrió y su resultado está en la
 *    base; repetirlo podría dar otra cosa y cambiar una factura que alguien ya
 *    revisó y aceptó.
 */

export interface ReparacionDeComprobante {
  documentId: string;
  documentNumber: string;
  movimientosCreados: number;
  movimientosActualizados: number;
  productosAsociados: number;
  costosCreados: number;
  agendaCreada: boolean;
  /** Qué estaba mal antes de reparar. Vacío cuando no había nada que hacer. */
  hallazgos: string[];
}

export async function repararDerivados(
  user: AuthUser,
  documentId: string,
): Promise<ReparacionDeComprobante> {
  if (!hasPermission(user, PERMISSIONS.COMPROBANTES_VALIDAR)) {
    throw new ForbiddenError('Tu usuario no puede reparar comprobantes.');
  }

  const document = await prisma.document.findUnique({
    where: { id: documentId },
    include: {
      items: { orderBy: { lineNumber: 'asc' } },
      paymentSchedule: true,
    },
  });
  if (!document) throw new NotFoundError('No encontramos ese comprobante.');
  if (document.status !== 'VALIDADO') {
    throw new ConflictError(
      'Sólo se reparan comprobantes validados: los demás se terminan de cargar por el camino normal.',
    );
  }
  if (!document.supplierId || !document.issueDate) {
    throw new ConflictError('El comprobante no tiene proveedor o fecha de emisión.');
  }

  const resultado: ReparacionDeComprobante = {
    documentId,
    documentNumber: document.fullNumber ?? 'sin número',
    movimientosCreados: 0,
    movimientosActualizados: 0,
    productosAsociados: 0,
    costosCreados: 0,
    agendaCreada: false,
    hallazgos: [],
  };

  // --- 1. Asociaciones que falten, sólo donde hoy hay nulo -----------------
  const sinProducto = document.items.filter((i) => !i.productId);
  if (sinProducto.length > 0) {
    const productos = await prisma.product.findMany({
      where: { active: true },
      select: {
        id: true,
        internalCode: true,
        normalizedName: true,
        aliases: { select: { normalized: true, supplierId: true, supplierCode: true } },
      },
    });
    const candidatos: ProductCandidate[] = productos.map((p) => ({
      id: p.id,
      internalCode: p.internalCode,
      normalizedName: normalizeText(p.normalizedName),
      aliases: p.aliases,
    }));

    for (const item of sinProducto) {
      const encontrado = matchProduct(
        {
          description: item.description,
          supplierCode: item.supplierCode,
          supplierId: document.supplierId,
        },
        candidatos,
      );
      // Sólo lo inequívoco: lo dudoso se resuelve en Asociaciones históricas.
      if (!encontrado.productId) continue;
      await prisma.documentItem.update({
        where: { id: item.id },
        data: { productId: encontrado.productId, matchMethod: encontrado.method },
      });
      item.productId = encontrado.productId;
      resultado.productosAsociados += 1;
    }
    if (resultado.productosAsociados > 0) {
      resultado.hallazgos.push(
        `${resultado.productosAsociados} renglón/es estaban sin producto y se pudieron reconocer.`,
      );
    }
  }

  const conditions = await getSupplierConditions(document.supplierId, document.issueDate);

  await prisma.$transaction(async (tx) => {
    // --- 2. Un movimiento de compra por renglón --------------------------
    const existentes = await tx.purchaseMovement.findMany({ where: { documentId } });
    const porRenglon = new Map(existentes.map((m) => [m.documentItemId ?? '', m]));

    /*
     * Los movimientos huérfanos se borran antes de nada.
     *
     * Son los que quedaron apuntando a un renglón que ya no existe —porque el
     * comprobante se volvió a confirmar y los renglones se rehicieron—. Si se
     * los dejara, la compra quedaría contada dos veces.
     */
    const idsDeRenglones = new Set(document.items.map((i) => i.id));
    const huerfanos = existentes.filter((m) => !m.documentItemId || !idsDeRenglones.has(m.documentItemId));
    if (huerfanos.length > 0) {
      await tx.purchaseMovement.deleteMany({ where: { id: { in: huerfanos.map((m) => m.id) } } });
      resultado.hallazgos.push(
        `${huerfanos.length} movimiento/s apuntaban a renglones que ya no existen y se quitaron.`,
      );
    }

    for (const item of document.items) {
      const datos = {
        documentId,
        documentItemId: item.id,
        productId: item.productId,
        supplierId: document.supplierId!,
        branchId: document.branchId,
        date: document.issueDate!,
        description: item.description,
        // Los importes salen del renglón guardado: acá no se recalcula plata.
        quantity: item.quantity.toString(),
        unit: item.unit,
        pieceCount: item.pieceCount,
        weightKg: item.totalWeightKg?.toString() ?? null,
        avgPieceWeightKg: item.avgPieceWeightKg?.toString() ?? null,
        unitNetPrice: item.unitNetPrice.toString(),
        discountAmount: item.discountAmount.toString(),
        netAmount: item.netAmount.toString(),
        ivaAmount: item.ivaAmount.toString(),
        perceptionAmount: item.perceptionAmount.toString(),
        totalCost: item.totalCost.toString(),
        unitCost: item.unitCost.toString(),
      };

      const existente = porRenglon.get(item.id);
      if (existente) {
        // Se actualiza el que ya está: crear otro duplicaría la compra.
        await tx.purchaseMovement.update({ where: { id: existente.id }, data: datos });
        resultado.movimientosActualizados += 1;
      } else {
        await tx.purchaseMovement.create({ data: datos });
        resultado.movimientosCreados += 1;
      }
    }
    if (resultado.movimientosCreados > 0) {
      resultado.hallazgos.push(
        `Faltaban ${resultado.movimientosCreados} movimiento/s de compra: sin ellos la factura no existía para Compras.`,
      );
    }

    // --- 3. Historial de costos para lo que quedó asociado ---------------
    for (const item of document.items) {
      if (!item.productId) continue;
      const yaEsta = await tx.costHistory.findFirst({
        where: { documentId, productId: item.productId },
      });
      if (yaEsta) continue;

      const previo = await tx.costHistory.findFirst({
        where: { productId: item.productId, date: { lte: document.issueDate! } },
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      });
      const anterior = previo ? toDecimal(previo.unitCost.toString()) : null;
      const actual = toDecimal(item.unitCost.toString());
      const delta = anterior ? actual.minus(anterior) : null;

      await tx.costHistory.create({
        data: {
          productId: item.productId,
          supplierId: document.supplierId!,
          branchId: document.branchId,
          documentId,
          date: document.issueDate!,
          unitNetPrice: item.unitNetPrice.toString(),
          unitCost: actual.toString(),
          previousUnitCost: anterior?.toString() ?? null,
          deltaAmount: delta?.toString() ?? null,
          deltaPct:
            anterior && !anterior.isZero()
              ? delta!.div(anterior).toDecimalPlaces(6).toString()
              : null,
        },
      });
      resultado.costosCreados += 1;
    }
    if (resultado.costosCreados > 0) {
      resultado.hallazgos.push(
        `Faltaban ${resultado.costosCreados} entrada/s de historial de costos: sin ellas el artículo no tiene costo en Precios.`,
      );
    }

    // --- 4. La agenda de pago, si falta ----------------------------------
    if (!document.paymentSchedule) {
      const total = money(document.total?.toString() ?? '0');
      const vencimiento =
        document.appliedDueDate ??
        (conditions.term
          ? computeDueDate(document.issueDate!, conditions.term, {
              proximaFactura: conditions.proximaFactura,
            })
          : null) ??
        toDateOnly(document.issueDate!);

      await tx.paymentSchedule.create({
        data: {
          documentId,
          dueDate: vencimiento,
          dueDateProvisional: conditions.term ? esFechaProvisoria(conditions.term) : false,
          plannedAmount: total.toString(),
          plannedPaymentMethod:
            document.appliedPaymentMethod ?? conditions.term?.paymentMethod ?? 'TRANSFERENCIA',
          paidAmount: '0',
          status: computePaymentStatus({
            dueDate: vencimiento,
            plannedAmount: total,
            paidAmount: 0,
          }),
        },
      });
      resultado.agendaCreada = true;
      resultado.hallazgos.push(
        'Faltaba la agenda de pago: sin ella la factura no aparecía en Pagos.',
      );
    }
  });

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.DOCUMENT_REPAIRED,
    entity: 'Document',
    entityId: documentId,
    after: {
      comprobante: resultado.documentNumber,
      movimientosCreados: resultado.movimientosCreados,
      movimientosActualizados: resultado.movimientosActualizados,
      productosAsociados: resultado.productosAsociados,
      costosCreados: resultado.costosCreados,
      agendaCreada: resultado.agendaCreada,
      hallazgos: resultado.hallazgos,
    },
  });

  return resultado;
}

/**
 * ¿Le falta algo a este comprobante validado?
 *
 * Sirve para ofrecer la reparación sólo cuando hace falta, y para poder decir
 * qué es lo que está incompleto antes de tocar nada.
 */
export async function diagnosticarDerivados(documentId: string): Promise<string[]> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    include: { items: true, paymentSchedule: true },
  });
  if (!document || document.status !== 'VALIDADO') return [];

  const problemas: string[] = [];

  const movimientos = await prisma.purchaseMovement.findMany({
    where: { documentId },
    select: { documentItemId: true, productId: true, totalCost: true },
  });
  if (movimientos.length !== document.items.length) {
    problemas.push(
      `Hay ${document.items.length} renglones y ${movimientos.length} movimientos de compra.`,
    );
  }

  const productoDelRenglon = new Map(document.items.map((i) => [i.id, i.productId]));
  const desalineados = movimientos.filter(
    (m) => productoDelRenglon.get(m.documentItemId ?? '') !== m.productId,
  );
  if (desalineados.length > 0) {
    problemas.push(
      `${desalineados.length} movimiento/s tienen un producto distinto al de su renglón.`,
    );
  }

  const asociados = document.items.filter((i) => i.productId).length;
  const costos = await prisma.costHistory.count({ where: { documentId } });
  if (costos !== asociados) {
    problemas.push(`Hay ${asociados} renglones con producto y ${costos} entradas de costo.`);
  }

  if (!document.paymentSchedule) problemas.push('No tiene agenda de pago.');

  const suma = movimientos.reduce(
    (acc, m) => acc.plus(toDecimal(m.totalCost.toString())),
    new Decimal(0),
  );
  const total = toDecimal(document.total?.toString() ?? '0');
  if (movimientos.length > 0 && suma.minus(total).abs().gt(1)) {
    problemas.push(
      `Los movimientos suman ${suma.toFixed(2)} y el comprobante es de ${total.toFixed(2)}.`,
    );
  }

  return problemas;
}
