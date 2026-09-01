import 'server-only';
import { prisma, type Prisma } from '@/lib/db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { assertBranchAccess, hasPermission, type AuthUser } from '@/lib/auth/session';
import { Decimal, toDecimal } from '@/lib/money';
import { parseArDate } from '@/lib/datetime';
import { costItems, consistentPerceptionLines, type CostedItem } from '@/lib/domain/costing';
import { validateDocument, type PrintedSummary, type ValidationReport } from '@/lib/domain/validation';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/services/audit';
import { getSupplierConditions } from '@/lib/services/suppliers';
import {
  createTaxLines,
  itemToColumns,
  learnProductAlias,
  matchItemsToProducts,
  printedToColumns,
  verificarDerivados,
  type ConfirmItemInput,
} from '@/lib/services/documents';

/**
 * Notas de crédito de proveedor.
 *
 * Una nota de crédito hace **dos** cosas que no son la misma y que hay que
 * poder decidir por separado:
 *
 *  1. **Efecto financiero.** Siempre. Resta en la cuenta corriente del
 *     proveedor: se le debe menos. Vale para todas, sin excepción.
 *  2. **Efecto sobre la mercadería.** Sólo cuando volvió mercadería de verdad,
 *     y sólo en los renglones en que volvió.
 *
 * Confundirlas es el error caro. Una bonificación por volumen, una diferencia
 * de precio o la devolución de una percepción mal aplicada bajan lo que hay que
 * pagar y **no** sacan un solo kilo del negocio: descontarlos como si hubieran
 * salido deja el stock corto para siempre. Por eso la devolución física se
 * declara renglón por renglón y nunca se deduce del hecho de que exista una
 * nota de crédito.
 *
 * Los importes se leen y se controlan igual que los de una factura, en
 * positivo, porque así están impresos en el papel. El signo lo pone esta capa
 * al escribir los movimientos: es una decisión del negocio, no del comprobante.
 */

/** Los motivos que admiten que además haya vuelto mercadería. */
const MOTIVOS_CON_DEVOLUCION = ['DEVOLUCION_MERCADERIA', 'OTRO'] as const;

export const MOTIVOS_DE_CREDITO = [
  'BONIFICACION',
  'DIFERENCIA_PRECIO',
  'DESCUENTO_COMERCIAL',
  'CORRECCION_FISCAL',
  'DEVOLUCION_PERCEPCION',
  'DEVOLUCION_MERCADERIA',
  'OTRO',
] as const;

export type MotivoDeCredito = (typeof MOTIVOS_DE_CREDITO)[number];

export const MOTIVO_DE_CREDITO_LABEL: Record<MotivoDeCredito, string> = {
  BONIFICACION: 'Bonificación',
  DIFERENCIA_PRECIO: 'Diferencia de precio',
  DESCUENTO_COMERCIAL: 'Descuento comercial',
  CORRECCION_FISCAL: 'Corrección fiscal',
  DEVOLUCION_PERCEPCION: 'Devolución de percepción',
  DEVOLUCION_MERCADERIA: 'Devolución de mercadería',
  OTRO: 'Otro',
};

export interface CreditNoteItemInput extends ConfirmItemInput {
  /**
   * ¿Volvió mercadería al proveedor por este renglón?
   *
   * Lo contesta una persona mirando el comprobante. No se infiere del motivo ni
   * del tipo: hay notas de crédito por devolución que corrigen además el precio
   * de otro artículo que nunca se movió del mostrador.
   */
  stockReturn?: boolean;
}

export interface ConfirmCreditNoteInput {
  documentId: string;
  supplierId: string;
  letter?: string | null;
  pointOfSale: string;
  number: string;
  issueDate: string;
  motivo: MotivoDeCredito;
  /** La factura que corrige, cuando se sabe cuál es. */
  relatedDocumentId?: string | null;
  printed: PrintedSummary;
  items: CreditNoteItemInput[];
  notes?: string | null;
  /** Anulación del bloqueo por parte de un administrador. Exige motivo. */
  override?: { reason: string };
}

export interface ConfirmCreditNoteResult {
  documentId: string;
  report: ValidationReport;
  /** Cuánto resta en la cuenta corriente del proveedor, en positivo. */
  credito: string;
  /** Renglones que además movieron mercadería. */
  renglonesConDevolucion: number;
  forced: boolean;
}

export async function confirmarNotaDeCredito(
  user: AuthUser,
  input: ConfirmCreditNoteInput,
): Promise<ConfirmCreditNoteResult> {
  if (!hasPermission(user, PERMISSIONS.COMPROBANTES_VALIDAR)) {
    throw new ForbiddenError('Tu usuario no puede confirmar comprobantes.');
  }

  const document = await prisma.document.findUnique({ where: { id: input.documentId } });
  if (!document) throw new NotFoundError('No encontramos ese comprobante.');
  assertBranchAccess(user, document.branchId);
  if (document.status === 'VALIDADO') throw new ConflictError('Este comprobante ya fue confirmado.');
  if (document.status === 'ANULADO') throw new ConflictError('Este comprobante está anulado.');

  const supplier = await prisma.supplier.findUnique({ where: { id: input.supplierId } });
  if (!supplier) throw new ValidationError('Elegí un proveedor válido.');

  if (input.items.length === 0) {
    throw new ValidationError('La nota de crédito no tiene ningún renglón cargado.');
  }
  if (!MOTIVOS_DE_CREDITO.includes(input.motivo)) {
    throw new ValidationError('Elegí por qué el proveedor emitió esta nota de crédito.');
  }

  const issueDate = parseArDate(input.issueDate);
  if (!issueDate) throw new ValidationError('La fecha de emisión no es válida.');

  const pointOfSale = input.pointOfSale.trim();
  const number = input.number.trim();
  if (pointOfSale === '' || number === '') {
    throw new ValidationError('Cargá el punto de venta y el número de la nota de crédito.');
  }

  // --- Efecto financiero y efecto sobre la mercadería, por separado ---------
  const conDevolucion = input.items.filter((i) => i.stockReturn === true);
  const admiteDevolucion = (MOTIVOS_CON_DEVOLUCION as readonly string[]).includes(input.motivo);
  if (input.motivo === 'DEVOLUCION_MERCADERIA' && conDevolucion.length === 0) {
    throw new ValidationError(
      'Si la nota de crédito es por devolución de mercadería, marcá en qué renglones volvió. ' +
        'Si no volvió nada, elegí el motivo que corresponda: la nota resta plata igual.',
    );
  }
  if (conDevolucion.length > 0 && !admiteDevolucion) {
    throw new ValidationError(
      `Marcaste ${conDevolucion.length} renglón/es como devolución física, pero el motivo ` +
        `«${MOTIVO_DE_CREDITO_LABEL[input.motivo]}» es sólo financiero. ` +
        'Una bonificación o una diferencia de precio no sacan mercadería del negocio.',
    );
  }

  // --- La factura que corrige, si se indicó una ----------------------------
  const original = input.relatedDocumentId
    ? await prisma.document.findUnique({ where: { id: input.relatedDocumentId } })
    : null;
  if (input.relatedDocumentId && !original) {
    throw new NotFoundError('No encontramos el comprobante que la nota de crédito corrige.');
  }
  if (original) {
    if (original.supplierId !== supplier.id) {
      throw new ValidationError(
        'La nota de crédito y la factura que corrige tienen que ser del mismo proveedor.',
      );
    }
    if (original.docType === 'NOTA_CREDITO') {
      throw new ValidationError('Una nota de crédito no corrige a otra nota de crédito.');
    }
    if (original.status !== 'VALIDADO') {
      throw new ValidationError(
        'La factura que la nota de crédito corrige todavía no está confirmada.',
      );
    }
  }

  // --- Los números, controlados igual que los de una factura ---------------
  const conditions = await getSupplierConditions(supplier.id, issueDate);
  const percepcionesGuardadas = await prisma.documentTaxLine.findMany({
    where: { documentId: input.documentId, kind: 'PERCEPCION' },
    orderBy: { id: 'asc' },
  });
  const percepcionesDiscriminadas = consistentPerceptionLines(
    percepcionesGuardadas.map((l) => ({ label: l.label, amount: l.amount.toString() })),
    input.printed.perceptionsTotal ?? '0',
  );

  const costed = costItems(input.items, {
    netTotal: input.printed.netTotal ?? '0',
    ivaTotal: input.printed.ivaTotal ?? '0',
    perceptionsTotal: input.printed.perceptionsTotal ?? '0',
    perceptionLines: percepcionesDiscriminadas,
  });
  const report = validateDocument({
    items: costed,
    printed: input.printed,
    supplierRules: conditions.tax
      ? { ivaRate: conditions.tax.ivaRate, iibbRate: conditions.tax.iibbRate }
      : undefined,
    attempts: 1,
  });

  let forced = false;
  if (!report.canSave) {
    if (!input.override) {
      throw new ValidationError(
        'La nota de crédito no se puede guardar porque el detalle no coincide con los totales impresos.',
        { checks: report.checks.filter((c) => c.severity === 'ERROR') },
      );
    }
    if (!hasPermission(user, PERMISSIONS.COMPROBANTES_ANULAR)) {
      throw new ForbiddenError(
        'Sólo un administrador puede guardar un comprobante que no cierra, y tiene que dejar el motivo.',
      );
    }
    if ((input.override.reason?.trim() ?? '').length < 10) {
      throw new ValidationError(
        'Para guardar un comprobante que no cierra hay que explicar el motivo (al menos 10 caracteres).',
      );
    }
    forced = true;
  }

  const total = toDecimal(input.printed.total ?? report.computed.totalCost);

  // --- Duplicados ----------------------------------------------------------
  const duplicada = await prisma.document.findFirst({
    where: {
      supplierId: supplier.id,
      docType: 'NOTA_CREDITO',
      pointOfSale,
      number,
      dedupeKey: 'ACTIVE',
      id: { not: document.id },
    },
    include: { branch: true },
  });
  if (duplicada) {
    throw new ConflictError(
      `Ya está cargada la nota de crédito ${pointOfSale}-${number} de ${supplier.tradeName} ` +
        `en la sucursal ${duplicada.branch.name}.`,
    );
  }

  /*
   * Una nota de crédito no puede acreditar más de lo que dice la factura.
   *
   * No es una regla contable inventada acá: si se acreditara de más, el saldo
   * del proveedor daría a favor de Don Ginés por una plata que nadie acordó, y
   * el error viajaría a la agenda de pagos como un crédito para usar. El caso
   * normal en que aparece es un número mal tipeado.
   */
  if (original) {
    const yaAcreditado = await prisma.document.aggregate({
      where: {
        relatedDocumentId: original.id,
        docType: 'NOTA_CREDITO',
        status: 'VALIDADO',
        id: { not: document.id },
      },
      _sum: { total: true },
    });
    const acumulado = toDecimal(yaAcreditado._sum.total?.toString() ?? '0').plus(total);
    const totalOriginal = toDecimal(original.total?.toString() ?? '0');
    if (totalOriginal.gt(0) && acumulado.gt(totalOriginal.plus('0.01'))) {
      throw new ValidationError(
        `Las notas de crédito de la factura ${original.fullNumber} sumarían ` +
          `$${acumulado.toFixed(2)} sobre un total de $${totalOriginal.toFixed(2)}. ` +
          'Revisá el importe o el comprobante que estás relacionando.',
      );
    }
  }

  // --- Asociación al catálogo ----------------------------------------------
  const reconocidos = await matchItemsToProducts(costed, supplier.id);
  const productoDeCadaRenglon = input.items.map((source, i) =>
    source.productId ? source.productId : (reconocidos[i]?.productId ?? null),
  );
  const metodoDeCadaRenglon = input.items.map((source, i) => {
    if (source.productId) return source.learnAlias ? 'MANUAL' : source.matchMethod || 'ALIAS';
    return reconocidos[i]?.productId ? (reconocidos[i].method ?? 'NONE') : 'NONE';
  });

  // --- Escritura transaccional ---------------------------------------------
  let ajustesDeCosto = 0;
  await prisma.$transaction(async (tx) => {
    await tx.purchaseMovement.deleteMany({ where: { documentId: document.id } });
    await tx.documentItem.deleteMany({ where: { documentId: document.id } });
    await tx.documentTaxLine.deleteMany({ where: { documentId: document.id } });

    await tx.document.update({
      where: { id: document.id },
      data: {
        supplierId: supplier.id,
        docType: 'NOTA_CREDITO',
        creditReason: input.motivo,
        relatedDocumentId: original?.id ?? null,
        letter: input.letter ?? null,
        pointOfSale,
        number,
        fullNumber: `${pointOfSale}-${number}`,
        issueDate,
        ...printedToColumns(input.printed),
        status: 'VALIDADO',
        dedupeKey: 'ACTIVE',
        checkState: forced ? 'DIFERENCIA' : report.state,
        checkReport: report as unknown as Prisma.InputJsonValue,
        appliedIvaRate: conditions.tax?.ivaRate ?? null,
        appliedIibbRate: conditions.tax?.iibbRate ?? null,
        /*
         * Sin fecha prevista de pago y sin agenda: una nota de crédito no se
         * paga. Se descuenta de lo que hay que pagar, y de eso se ocupa la
         * cuenta corriente.
         */
        appliedDueDate: null,
        validatedById: user.id,
        validatedAt: new Date(),
        notes: input.notes ?? null,
        voidReason: forced ? input.override!.reason.trim() : null,
      },
    });

    const renglonesCreados = [];
    for (let i = 0; i < costed.length; i++) {
      renglonesCreados.push(
        await tx.documentItem.create({
          data: {
            documentId: document.id,
            ...itemToColumns(costed[i]),
            productId: productoDeCadaRenglon[i],
            matchMethod: metodoDeCadaRenglon[i],
            stockReturn: input.items[i].stockReturn === true,
          },
        }),
      );
    }

    await createTaxLines(tx, document.id, {
      ivaLines:
        input.printed.ivaTotal === null || input.printed.ivaTotal === undefined
          ? []
          : [
              {
                label: conditions.tax
                  ? `IVA ${toDecimal(conditions.tax.ivaRate).times(100).toString()} %`
                  : 'IVA',
                rate: conditions.tax?.ivaRate ?? '0',
                base: input.printed.netTotal != null ? String(input.printed.netTotal) : null,
                amount: String(input.printed.ivaTotal),
              },
            ],
      perceptionLines: percepcionesGuardadas.map((l) => ({
        label: l.label,
        rate: l.rate?.toString() ?? null,
        base: l.base?.toString() ?? null,
        amount: l.amount.toString(),
      })),
    });

    for (let i = 0; i < costed.length; i++) {
      const item = costed[i];
      const devolvio = input.items[i].stockReturn === true;
      const productId = productoDeCadaRenglon[i];

      await tx.purchaseMovement.create({
        data: {
          documentId: document.id,
          documentItemId: renglonesCreados[i].id,
          productId,
          supplierId: supplier.id,
          branchId: document.branchId,
          date: issueDate,
          description: item.description,
          /*
           * Acá está la distinción entera, en una línea.
           *
           * La cantidad se mueve en contra sólo si volvió mercadería. Si la
           * nota es financiera, la cantidad es cero: no salió nada del
           * negocio. Los importes, en cambio, siempre van en negativo, porque
           * lo que la nota corrige siempre es plata.
           */
          quantity: devolvio ? item.quantity.negated().toString() : '0',
          unit: item.unit,
          pieceCount: devolvio ? item.pieceCount : null,
          weightKg: devolvio ? (item.totalWeightKg?.negated().toString() ?? null) : null,
          avgPieceWeightKg: item.avgPieceWeightKg?.toString() ?? null,
          unitNetPrice: item.unitNetPrice.toString(),
          discountAmount: item.discountAmount.negated().toString(),
          netAmount: item.netAmount.negated().toString(),
          ivaAmount: item.ivaAmount.negated().toString(),
          perceptionAmount: item.perceptionAmount.negated().toString(),
          totalCost: item.totalCost.negated().toString(),
          unitCost: item.unitCost.toString(),
        },
      });

      /*
       * El ajuste de costo, sólo donde corresponde.
       *
       * Una devolución no cambia cuánto costó el kilo: cambia cuántos kilos
       * hay. Una bonificación o una diferencia de precio sí: el mismo kilo
       * terminó costando menos. Por eso el ajuste se escribe para los
       * renglones financieros y no para los devueltos.
       *
       * Y se escribe como un renglón **nuevo** del historial. El costo que
       * originó la factura queda donde estaba, intacto: quien mire va a ver de
       * dónde salió el costo, qué se lo ajustó y con qué comprobante.
       */
      if (productId && !devolvio) {
        const escrito = await ajustarCostoPorNotaDeCredito(tx, {
          productId,
          supplierId: supplier.id,
          branchId: document.branchId,
          documentId: document.id,
          date: issueDate,
          unitNetPriceAcreditado: item.unitNetPrice,
          unitCostAcreditado: item.unitCost,
        });
        if (escrito) ajustesDeCosto++;
      }

      if (productId && input.items[i].learnAlias) {
        await learnProductAlias(tx, {
          productId,
          supplierId: supplier.id,
          supplierCode: item.supplierCode,
          description: item.description,
        });
      }
    }

    await verificarDerivados(tx, document.id, costed.length, total.negated(), {
      agendasEsperadas: 0,
      costosEsperados: ajustesDeCosto,
    });
  });

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.CREDIT_NOTE_CONFIRMED,
    entity: 'Document',
    entityId: document.id,
    reason: forced ? input.override!.reason.trim() : null,
    after: {
      proveedor: supplier.tradeName,
      comprobante: `${pointOfSale}-${number}`,
      motivo: input.motivo,
      credito: total.toFixed(2),
      renglones: costed.length,
      renglonesConDevolucion: conDevolucion.length,
      ajustesDeCosto,
      facturaRelacionada: original?.fullNumber ?? null,
      /*
       * Que la nota no movió mercadería queda escrito, no sólo implícito.
       *
       * Es la afirmación que alguien va a querer poder verificar dentro de seis
       * meses cuando el stock no cierre: la nota existió, restó plata, y no
       * sacó nada del negocio porque así se cargó.
       */
      efectoSobreMercaderia:
        conDevolucion.length === 0 ? 'ninguno' : `${conDevolucion.length} renglón/es devueltos`,
    },
  });

  return {
    documentId: document.id,
    report,
    credito: total.toFixed(2),
    renglonesConDevolucion: conDevolucion.length,
    forced,
  };
}

/**
 * Deja anotado que una nota de crédito abarató lo que se había comprado.
 *
 * El costo anterior no se toca. Se agrega un renglón nuevo al historial, con el
 * costo que regía antes, cuánto se acreditó y el costo que queda: los tres
 * datos que hacen falta para explicar el costo vigente sin adivinar.
 *
 * Si el producto todavía no tiene ningún costo cargado no se escribe nada:
 * "cero menos el crédito" no es un costo, es un número inventado, y quedaría
 * como el costo vigente del artículo. Devuelve si escribió o no.
 */
async function ajustarCostoPorNotaDeCredito(
  tx: Prisma.TransactionClient,
  input: {
    productId: string;
    supplierId: string;
    branchId: string;
    documentId: string;
    date: Date;
    unitNetPriceAcreditado: Decimal;
    unitCostAcreditado: Decimal;
  },
): Promise<boolean> {
  const previo = await tx.costHistory.findFirst({
    where: { productId: input.productId, date: { lte: input.date } },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
  });
  if (!previo) return false;

  const costoPrevio = toDecimal(previo.unitCost.toString());
  const netoPrevio = toDecimal(previo.unitNetPrice.toString());

  /*
   * El costo no puede quedar por debajo de cero.
   *
   * Un crédito unitario mayor que el costo previo significa que los dos
   * comprobantes no hablan de la misma unidad —la factura vino por kilo y la
   * nota por bulto, típicamente—. Recortar en cero es lo prudente: deja el
   * artículo en un costo posible en vez de en uno negativo, que se propagaría
   * a los precios de venta.
   */
  const costoEfectivo = Decimal.max(costoPrevio.minus(input.unitCostAcreditado), new Decimal(0));
  const netoEfectivo = Decimal.max(netoPrevio.minus(input.unitNetPriceAcreditado), new Decimal(0));
  const delta = costoEfectivo.minus(costoPrevio);

  await tx.costHistory.create({
    data: {
      productId: input.productId,
      supplierId: input.supplierId,
      branchId: input.branchId,
      documentId: input.documentId,
      date: input.date,
      kind: 'AJUSTE_NC',
      unitNetPrice: netoEfectivo.toString(),
      unitCost: costoEfectivo.toString(),
      previousUnitCost: costoPrevio.toString(),
      deltaAmount: delta.toString(),
      deltaPct: costoPrevio.gt(0) ? delta.div(costoPrevio).toDecimalPlaces(6).toString() : null,
    },
  });
  return true;
}

// ---------------------------------------------------------------------------
// Cuenta corriente
// ---------------------------------------------------------------------------

export interface SaldoDeProveedor {
  supplierId: string;
  /** Suma de las facturas y remitos confirmados. */
  facturas: string;
  /** Suma de las notas de crédito confirmadas. */
  notasDeCredito: string;
  /** Suma de lo efectivamente pagado. */
  pagos: string;
  /** Facturas − notas de crédito − pagos. Positivo: se le debe al proveedor. */
  saldo: string;
}

/**
 * Lo que se le debe a un proveedor: facturas − notas de crédito − pagos.
 *
 * Las tres cosas cuentan y ninguna se puede omitir. Sin las notas de crédito el
 * saldo queda inflado y se le termina pagando de más; sin los pagos, al revés.
 *
 * Cuentan **todas** las notas de crédito del proveedor, tengan o no una factura
 * relacionada: una bonificación trimestral no corresponde a un comprobante en
 * particular y baja el saldo igual.
 */
export async function saldoDeProveedor(supplierId: string): Promise<SaldoDeProveedor> {
  const [comprobantes, pagados] = await Promise.all([
    prisma.document.findMany({
      where: { supplierId, status: 'VALIDADO' },
      select: { docType: true, total: true },
    }),
    prisma.paymentSchedule.aggregate({
      where: { document: { supplierId, status: 'VALIDADO' } },
      _sum: { paidAmount: true },
    }),
  ]);

  let facturas = new Decimal(0);
  let notas = new Decimal(0);
  for (const c of comprobantes) {
    const importe = toDecimal(c.total?.toString() ?? '0');
    if (c.docType === 'NOTA_CREDITO') notas = notas.plus(importe);
    else facturas = facturas.plus(importe);
  }
  const pagos = toDecimal(pagados._sum.paidAmount?.toString() ?? '0');

  return {
    supplierId,
    facturas: facturas.toFixed(2),
    notasDeCredito: notas.toFixed(2),
    pagos: pagos.toFixed(2),
    saldo: facturas.minus(notas).minus(pagos).toFixed(2),
  };
}

/**
 * Cuánto crédito tiene aplicado una factura y cuánto queda por pagar de ella.
 *
 * Es lo que hace falta para no pagar de más: la factura dice $100.000 y la
 * agenda la muestra por $100.000, pero si llegó una nota de crédito de $12.000
 * lo que hay que transferir son $88.000. Mostrar el importe de la factura a
 * secas, con la nota de crédito guardada en otra pantalla, es exactamente la
 * forma de que alguien pague el número equivocado.
 */
export async function creditoAplicadoA(documentIds: string[]): Promise<Map<string, Decimal>> {
  if (documentIds.length === 0) return new Map();
  const notas = await prisma.document.groupBy({
    by: ['relatedDocumentId'],
    where: {
      relatedDocumentId: { in: documentIds },
      docType: 'NOTA_CREDITO',
      status: 'VALIDADO',
    },
    _sum: { total: true },
  });
  return new Map(
    notas
      .filter((n): n is typeof n & { relatedDocumentId: string } => n.relatedDocumentId !== null)
      .map((n) => [n.relatedDocumentId, toDecimal(n._sum.total?.toString() ?? '0')]),
  );
}

/** Las notas de crédito que corrigen un comprobante, para mostrarlas con él. */
export async function notasDeCreditoDe(documentId: string) {
  return prisma.document.findMany({
    where: { relatedDocumentId: documentId, docType: 'NOTA_CREDITO' },
    orderBy: { issueDate: 'asc' },
    select: {
      id: true,
      fullNumber: true,
      issueDate: true,
      total: true,
      creditReason: true,
      status: true,
      items: { select: { stockReturn: true } },
    },
  });
}

/** Los renglones costeados de una nota de crédito, para revisarlos. */
export type RenglonDeNota = CostedItem;
