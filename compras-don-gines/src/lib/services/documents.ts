import 'server-only';
import { prisma, type Prisma } from '@/lib/db';
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { assertBranchAccess, hasPermission, type AuthUser } from '@/lib/auth/session';
import { Decimal, money, toDecimal } from '@/lib/money';
import { arToday, dateOnlyFromISO, parseArDate, toDateOnly } from '@/lib/datetime';
import { costItems, type CostedItem, type RawItem } from '@/lib/domain/costing';
import { validateDocument, type PrintedSummary, type ValidationReport } from '@/lib/domain/validation';
import { computeDueDate, computePaymentStatus } from '@/lib/domain/payments';
import { matchProduct, normalizeText, type ProductCandidate } from '@/lib/domain/matching';
import { buildDocumentKey, getStorage } from '@/lib/storage';
import { normalizeUpload } from '@/lib/images';
import { env } from '@/lib/env';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/services/audit';
import { findSupplierByReading, getSupplierConditions } from '@/lib/services/suppliers';

// ---------------------------------------------------------------------------
// Alta y archivos
// ---------------------------------------------------------------------------

export async function createDocument(user: AuthUser, branchId: string) {
  if (!hasPermission(user, PERMISSIONS.COMPROBANTES_CARGAR)) {
    throw new ForbiddenError('Tu usuario no puede cargar comprobantes.');
  }
  assertBranchAccess(user, branchId);

  const branch = await prisma.branch.findUnique({ where: { id: branchId } });
  if (!branch || !branch.active) {
    throw new NotFoundError('Esa sucursal no existe o está dada de baja.');
  }

  const document = await prisma.document.create({
    data: { branchId, createdById: user.id, status: 'BORRADOR' },
  });
  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.DOCUMENT_CREATED,
    entity: 'Document',
    entityId: document.id,
    after: { branchId },
  });
  return document;
}

export interface UploadedFile {
  buffer: Buffer;
  filename?: string;
  mimeType?: string;
}

export interface AddFilesResult {
  added: { id: string; pageOrder: number; sizeBytes: number; converted: boolean; compressed: boolean }[];
  duplicates: string[];
  rejected: { filename: string; reason: string }[];
}

/**
 * Suma páginas al comprobante.
 *
 * Cada archivo se endereza, se convierte si hace falta y se comprime, y se
 * guardan las dos versiones: la original de archivo y la de trabajo. Una foto
 * repetida no se agrega dos veces: se reconoce por el SHA-256 del original.
 */
export async function addFiles(
  user: AuthUser,
  documentId: string,
  files: UploadedFile[],
): Promise<AddFilesResult> {
  const document = await loadEditableDocument(user, documentId);
  const storage = await getStorage();

  const existing = await prisma.documentFile.findMany({
    where: { documentId },
    select: { sha256: true, pageOrder: true },
  });
  const seen = new Set(existing.map((f) => f.sha256));
  let nextOrder = existing.reduce((max, f) => Math.max(max, f.pageOrder), 0) + 1;

  const result: AddFilesResult = { added: [], duplicates: [], rejected: [] };

  for (const file of files) {
    const label = file.filename ?? `página ${nextOrder}`;

    if (existing.length + result.added.length >= env.maxFilesPerDocument) {
      result.rejected.push({
        filename: label,
        reason: `Un comprobante admite hasta ${env.maxFilesPerDocument} imágenes.`,
      });
      continue;
    }
    if (file.buffer.length > env.maxUploadBytes) {
      result.rejected.push({
        filename: label,
        reason: 'El archivo es demasiado grande, incluso para optimizarlo.',
      });
      continue;
    }

    let normalized;
    try {
      normalized = await normalizeUpload(file.buffer, file.mimeType, file.filename);
    } catch (error) {
      result.rejected.push({
        filename: label,
        reason: error instanceof AppError ? error.message : 'No pudimos preparar ese archivo.',
      });
      continue;
    }

    if (seen.has(normalized.sha256)) {
      result.duplicates.push(label);
      continue;
    }
    seen.add(normalized.sha256);

    const pageOrder = nextOrder++;
    const workKey = buildDocumentKey({
      documentId,
      pageOrder,
      variant: 'work',
      extension: normalized.workExtension,
    });
    const originalKey = buildDocumentKey({
      documentId,
      pageOrder,
      variant: 'original',
      extension: normalized.originalExtension,
    });

    await storage.put(workKey, normalized.work, normalized.workMime);
    // El original sólo se guarda aparte si de verdad es otro archivo.
    if (originalKey !== workKey) {
      await storage.put(originalKey, normalized.original, normalized.originalMime);
    }

    const created = await prisma.documentFile.create({
      data: {
        documentId,
        pageOrder,
        storageKey: workKey,
        originalKey: originalKey === workKey ? null : originalKey,
        mimeType: normalized.workMime,
        originalMimeType: normalized.originalMime,
        sizeBytes: normalized.work.length,
        originalSizeBytes: normalized.original.length,
        sha256: normalized.sha256,
        width: normalized.width,
        height: normalized.height,
      },
    });

    result.added.push({
      id: created.id,
      pageOrder,
      sizeBytes: created.sizeBytes,
      converted: normalized.converted,
      compressed: normalized.compressed,
    });
  }

  if (result.added.length === 0 && result.duplicates.length === 0 && result.rejected.length > 0) {
    throw new ValidationError(result.rejected[0].reason);
  }
  void document;
  return result;
}

export async function removeFile(user: AuthUser, documentId: string, fileId: string) {
  await loadEditableDocument(user, documentId);
  const file = await prisma.documentFile.findFirst({ where: { id: fileId, documentId } });
  if (!file) throw new NotFoundError('Esa imagen ya no está en el comprobante.');

  const storage = await getStorage();
  await storage.delete(file.storageKey);
  if (file.originalKey) await storage.delete(file.originalKey);
  await prisma.documentFile.delete({ where: { id: file.id } });
  await renumberPages(documentId);
}

export async function reorderFiles(user: AuthUser, documentId: string, orderedIds: string[]) {
  await loadEditableDocument(user, documentId);
  const files = await prisma.documentFile.findMany({ where: { documentId } });
  const known = new Set(files.map((f) => f.id));
  if (orderedIds.length !== files.length || orderedIds.some((id) => !known.has(id))) {
    throw new ValidationError('El nuevo orden de las páginas no coincide con las imágenes cargadas.');
  }
  await prisma.$transaction(
    orderedIds.map((id, index) =>
      prisma.documentFile.update({ where: { id }, data: { pageOrder: index + 1 } }),
    ),
  );
}

async function renumberPages(documentId: string) {
  const files = await prisma.documentFile.findMany({
    where: { documentId },
    orderBy: { pageOrder: 'asc' },
  });
  await prisma.$transaction(
    files.map((file, index) =>
      prisma.documentFile.update({ where: { id: file.id }, data: { pageOrder: index + 1 } }),
    ),
  );
}

export async function loadEditableDocument(user: AuthUser, documentId: string) {
  const document = await prisma.document.findUnique({ where: { id: documentId } });
  if (!document) throw new NotFoundError('No encontramos ese comprobante.');
  assertBranchAccess(user, document.branchId);
  if (document.status === 'VALIDADO' || document.status === 'ANULADO') {
    throw new ConflictError('Este comprobante ya está cerrado y no se puede modificar.');
  }
  return document;
}

// ---------------------------------------------------------------------------
// Lectura automática
// ---------------------------------------------------------------------------

export async function matchItemsToProducts(items: CostedItem[], supplierId: string | null) {
  if (items.length === 0) return [];
  const products = await prisma.product.findMany({
    where: { active: true },
    select: {
      id: true,
      internalCode: true,
      normalizedName: true,
      aliases: { select: { normalized: true, supplierId: true, supplierCode: true } },
    },
  });
  const candidates: ProductCandidate[] = products.map((p) => ({
    id: p.id,
    internalCode: p.internalCode,
    normalizedName: normalizeText(p.normalizedName),
    aliases: p.aliases,
  }));

  return items.map((item) =>
    matchProduct(
      { description: item.description, supplierCode: item.supplierCode, supplierId },
      candidates,
    ),
  );
}

export function printedToColumns(printed: PrintedSummary) {
  const opt = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    grossSubtotal: opt(printed.grossSubtotal),
    discountTotal: opt(printed.discountTotal),
    netTotal: opt(printed.netTotal),
    ivaTotal: opt(printed.ivaTotal),
    perceptionsTotal: opt(printed.perceptionsTotal),
    total: opt(printed.total),
    printedLineCount: printed.lineCount ?? null,
    printedNetWeightKg: opt(printed.netWeightKg),
    printedTotalUnits: opt(printed.totalUnits),
  };
}

export function itemToColumns(item: CostedItem) {
  return {
    lineNumber: item.lineNumber,
    supplierCode: item.supplierCode,
    description: item.description,
    quantity: item.quantity.toString(),
    unit: item.unit,
    pieceCount: item.pieceCount,
    totalWeightKg: item.totalWeightKg?.toString() ?? null,
    avgPieceWeightKg: item.avgPieceWeightKg?.toString() ?? null,
    unitNetPrice: item.unitNetPrice.toString(),
    grossSubtotal: item.grossSubtotal.toString(),
    discountPct: item.discountPct.toString(),
    discountAmount: item.discountAmount.toString(),
    netAmount: item.netAmount.toString(),
    ivaRate: item.ivaRate.toString(),
    ivaAmount: item.ivaAmount.toString(),
    perceptionAmount: item.perceptionAmount.toString(),
    totalCost: item.totalCost.toString(),
    unitCost: item.unitCost.toString(),
  };
}

export async function createTaxLines(
  tx: Prisma.TransactionClient,
  documentId: string,
  summary: { ivaLines?: { label: string; rate?: string | null; base?: string | null; amount: string }[] | null; perceptionLines?: { label: string; rate?: string | null; base?: string | null; amount: string }[] | null } | null,
) {
  if (!summary) return;
  const rows: Prisma.DocumentTaxLineCreateManyInput[] = [];
  for (const line of summary.ivaLines ?? []) {
    rows.push({
      documentId,
      kind: 'IVA',
      label: line.label,
      rate: line.rate ?? '0',
      base: line.base ?? null,
      amount: line.amount,
    });
  }
  for (const line of summary.perceptionLines ?? []) {
    rows.push({
      documentId,
      kind: 'PERCEPCION',
      label: line.label,
      rate: line.rate ?? '0',
      base: line.base ?? null,
      amount: line.amount,
    });
  }
  if (rows.length > 0) await tx.documentTaxLine.createMany({ data: rows });
}

// ---------------------------------------------------------------------------
// Confirmación
// ---------------------------------------------------------------------------

export interface ConfirmItemInput extends RawItem {
  productId?: string | null;
  /** Si el usuario asoció la descripción a mano, se aprende como alias. */
  learnAlias?: boolean;
}

export interface ConfirmDocumentInput {
  documentId: string;
  supplierId: string;
  docType?: 'FACTURA' | 'REMITO';
  letter?: string | null;
  pointOfSale: string;
  number: string;
  issueDate: string;
  printed: PrintedSummary;
  items: ConfirmItemInput[];
  payment: {
    dueDate: string;
    paymentMethod: string;
    notes?: string | null;
  };
  /** Anulación del bloqueo por parte de un administrador. Exige motivo. */
  override?: { reason: string };
}

export interface ConfirmResult {
  documentId: string;
  report: ValidationReport;
  paymentScheduleId: string;
  dueDate: Date;
  forced: boolean;
}

/**
 * Guarda el comprobante como controlado.
 *
 * El backend **recalcula y revalida todos los importes** con los datos que le
 * llegan: lo que diga el frontend sobre si la factura cierra no cuenta. Si el
 * control no pasa, no se guarda, salvo anulación administrativa expresa con
 * motivo, que queda registrada en auditoría.
 *
 * La factura, sus renglones, los movimientos de compra, el historial de costos
 * y la agenda de pago se escriben en una única transacción: o queda todo o no
 * queda nada.
 */
export async function confirmDocument(
  user: AuthUser,
  input: ConfirmDocumentInput,
): Promise<ConfirmResult> {
  if (!hasPermission(user, PERMISSIONS.COMPROBANTES_VALIDAR)) {
    throw new ForbiddenError('Tu usuario no puede confirmar comprobantes.');
  }

  const document = await prisma.document.findUnique({
    where: { id: input.documentId },
    include: { paymentSchedule: true },
  });
  if (!document) throw new NotFoundError('No encontramos ese comprobante.');
  assertBranchAccess(user, document.branchId);
  if (document.status === 'VALIDADO') {
    throw new ConflictError('Este comprobante ya fue confirmado.');
  }
  if (document.status === 'ANULADO') {
    throw new ConflictError('Este comprobante está anulado.');
  }

  const supplier = await prisma.supplier.findUnique({ where: { id: input.supplierId } });
  if (!supplier) throw new ValidationError('Elegí un proveedor válido.');

  if (input.items.length === 0) {
    throw new ValidationError('El comprobante no tiene ningún artículo cargado.');
  }

  const issueDate = parseArDate(input.issueDate);
  if (!issueDate) throw new ValidationError('La fecha de emisión no es válida.');

  const dueDate = parseArDate(input.payment.dueDate);
  if (!dueDate) throw new ValidationError('La fecha prevista de pago no es válida.');

  const pointOfSale = input.pointOfSale.trim();
  const number = input.number.trim();
  if (pointOfSale === '' || number === '') {
    throw new ValidationError('Cargá el punto de venta y el número del comprobante.');
  }

  // --- Revalidación completa en el backend --------------------------------
  const conditions = await getSupplierConditions(supplier.id, issueDate);
  const costed = costItems(input.items, {
    netTotal: input.printed.netTotal ?? '0',
    ivaTotal: input.printed.ivaTotal ?? '0',
    perceptionsTotal: input.printed.perceptionsTotal ?? '0',
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
        'El comprobante no se puede guardar como controlado porque el detalle no coincide con los totales impresos.',
        { checks: report.checks.filter((c) => c.severity === 'ERROR') },
      );
    }
    if (!hasPermission(user, PERMISSIONS.COMPROBANTES_ANULAR)) {
      throw new ForbiddenError(
        'Sólo un administrador puede guardar un comprobante que no cierra, y tiene que dejar el motivo.',
      );
    }
    const reason = input.override.reason?.trim() ?? '';
    if (reason.length < 10) {
      throw new ValidationError(
        'Para guardar un comprobante que no cierra hay que explicar el motivo (al menos 10 caracteres).',
      );
    }
    forced = true;
  }

  // --- Duplicados ---------------------------------------------------------
  const duplicate = await prisma.document.findFirst({
    where: {
      supplierId: supplier.id,
      docType: input.docType ?? 'FACTURA',
      pointOfSale,
      number,
      dedupeKey: 'ACTIVE',
      id: { not: document.id },
    },
    include: { branch: true },
  });
  if (duplicate) {
    throw new ConflictError(
      `Ya está cargada la ${duplicate.docType === 'REMITO' ? 'remito' : 'factura'} ` +
        `${pointOfSale}-${number} de ${supplier.tradeName} en la sucursal ${duplicate.branch.name}. ` +
        'Si aquella carga estuvo mal, rechazala primero y volvé a cargar esta.',
    );
  }

  const total = money(input.printed.total ?? report.computed.totalCost);
  const paymentMethod = input.payment.paymentMethod || conditions.term?.paymentMethod || 'TRANSFERENCIA';

  // --- Escritura transaccional -------------------------------------------
  const result = await prisma.$transaction(async (tx) => {
    // Se rehacen renglones y movimientos: confirmar dos veces no duplica nada.
    await tx.purchaseMovement.deleteMany({ where: { documentId: document.id } });
    await tx.documentItem.deleteMany({ where: { documentId: document.id } });
    await tx.documentTaxLine.deleteMany({ where: { documentId: document.id } });

    await tx.document.update({
      where: { id: document.id },
      data: {
        supplierId: supplier.id,
        docType: input.docType ?? 'FACTURA',
        letter: input.letter ?? null,
        pointOfSale,
        number,
        fullNumber: `${pointOfSale}-${number}`,
        issueDate,
        ...printedToColumns(input.printed),
        status: 'VALIDADO',
        // Recién ahora el comprobante se queda con el número.
        dedupeKey: 'ACTIVE',
        checkState: forced ? 'DIFERENCIA' : report.state,
        checkReport: report as unknown as Prisma.InputJsonValue,
        // Copia de las condiciones vigentes al momento de la carga: si mañana
        // cambia el plazo del proveedor, esta factura conserva el suyo.
        appliedTermType: conditions.term?.termType ?? null,
        appliedTermDays: conditions.term?.days ?? null,
        appliedPaymentMethod: paymentMethod,
        appliedIvaRate: conditions.tax?.ivaRate ?? null,
        appliedIibbRate: conditions.tax?.iibbRate ?? null,
        appliedDueDate: dueDate,
        validatedById: user.id,
        validatedAt: new Date(),
        voidReason: forced ? input.override!.reason.trim() : null,
      },
    });

    const createdItems = [];
    for (let i = 0; i < costed.length; i++) {
      const item = costed[i];
      const source = input.items[i];
      createdItems.push(
        await tx.documentItem.create({
          data: {
            documentId: document.id,
            ...itemToColumns(item),
            productId: source.productId ?? null,
            matchMethod: source.productId ? (source.learnAlias ? 'MANUAL' : 'ALIAS') : 'NONE',
          },
        }),
      );
    }

    await createTaxLines(tx, document.id, {
      ivaLines: buildIvaLines(input.printed, conditions.tax?.ivaRate),
      perceptionLines: buildPerceptionLines(input.printed, conditions.tax?.iibbRate),
    });

    // Movimientos de compra e historial de costos.
    for (let i = 0; i < costed.length; i++) {
      const item = costed[i];
      const documentItem = createdItems[i];
      const productId = input.items[i].productId ?? null;

      await tx.purchaseMovement.create({
        data: {
          documentId: document.id,
          documentItemId: documentItem.id,
          productId,
          supplierId: supplier.id,
          branchId: document.branchId,
          date: issueDate,
          description: item.description,
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
        },
      });

      if (productId) {
        await writeCostHistory(tx, {
          productId,
          supplierId: supplier.id,
          branchId: document.branchId,
          documentId: document.id,
          date: issueDate,
          unitNetPrice: item.unitNetPrice,
          unitCost: item.unitCost,
        });

        if (input.items[i].learnAlias) {
          await learnProductAlias(tx, {
            productId,
            supplierId: supplier.id,
            supplierCode: item.supplierCode,
            description: item.description,
          });
        }
      }
    }

    // Agenda de pago. Vencer y pagar son eventos distintos: acá sólo se agenda.
    const status = computePaymentStatus({ dueDate, plannedAmount: total, paidAmount: 0 });
    const schedule = await tx.paymentSchedule.upsert({
      where: { documentId: document.id },
      update: {
        dueDate,
        plannedAmount: total.toString(),
        plannedPaymentMethod: paymentMethod,
        status,
        notes: input.payment.notes ?? null,
      },
      create: {
        documentId: document.id,
        dueDate,
        plannedAmount: total.toString(),
        plannedPaymentMethod: paymentMethod,
        paidAmount: '0',
        status,
        notes: input.payment.notes ?? null,
      },
    });

    return { scheduleId: schedule.id };
  });

  await recordAudit({
    userId: user.id,
    action: forced ? AUDIT_ACTIONS.DOCUMENT_OVERRIDDEN : AUDIT_ACTIONS.DOCUMENT_CONFIRMED,
    entity: 'Document',
    entityId: document.id,
    reason: forced ? input.override!.reason.trim() : null,
    after: {
      proveedor: supplier.tradeName,
      comprobante: `${pointOfSale}-${number}`,
      total: total.toString(),
      renglones: costed.length,
      estado: report.state,
      vencimiento: dueDate.toISOString().slice(0, 10),
    },
  });

  return {
    documentId: document.id,
    report,
    paymentScheduleId: result.scheduleId,
    dueDate,
    forced,
  };
}

function buildIvaLines(printed: PrintedSummary, rate?: string) {
  if (printed.ivaTotal === null || printed.ivaTotal === undefined) return [];
  return [
    {
      label: rate ? `IVA ${toDecimal(rate).times(100).toString()} %` : 'IVA',
      rate: rate ?? '0',
      base: printed.netTotal !== undefined && printed.netTotal !== null ? String(printed.netTotal) : null,
      amount: String(printed.ivaTotal),
    },
  ];
}

function buildPerceptionLines(printed: PrintedSummary, rate?: string) {
  if (printed.perceptionsTotal === null || printed.perceptionsTotal === undefined) return [];
  if (toDecimal(printed.perceptionsTotal).isZero()) return [];
  return [
    {
      label: rate ? `Percepción IIBB ${toDecimal(rate).times(100).toString()} %` : 'Percepciones',
      rate: rate ?? '0',
      base: printed.netTotal !== undefined && printed.netTotal !== null ? String(printed.netTotal) : null,
      amount: String(printed.perceptionsTotal),
    },
  ];
}

async function writeCostHistory(
  tx: Prisma.TransactionClient,
  input: {
    productId: string;
    supplierId: string;
    branchId: string;
    documentId: string;
    date: Date;
    unitNetPrice: Decimal;
    unitCost: Decimal;
  },
) {
  const previous = await tx.costHistory.findFirst({
    where: { productId: input.productId, date: { lte: input.date } },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
  });

  const previousUnitCost = previous ? toDecimal(previous.unitCost.toString()) : null;
  const delta = previousUnitCost ? input.unitCost.minus(previousUnitCost) : null;
  const deltaPct =
    previousUnitCost && previousUnitCost.gt(0) ? delta!.div(previousUnitCost) : null;

  await tx.costHistory.create({
    data: {
      productId: input.productId,
      supplierId: input.supplierId,
      branchId: input.branchId,
      documentId: input.documentId,
      date: input.date,
      unitNetPrice: input.unitNetPrice.toString(),
      unitCost: input.unitCost.toString(),
      previousUnitCost: previousUnitCost?.toString() ?? null,
      deltaAmount: delta?.toString() ?? null,
      deltaPct: deltaPct?.toDecimalPlaces(6).toString() ?? null,
    },
  });
}

async function learnProductAlias(
  tx: Prisma.TransactionClient,
  input: {
    productId: string;
    supplierId: string;
    supplierCode: string | null;
    description: string;
  },
) {
  const normalized = normalizeText(input.description);
  if (normalized.length < 3) return;
  const exists = await tx.productAlias.findFirst({
    where: { productId: input.productId, supplierId: input.supplierId, normalized },
  });
  if (exists) return;
  await tx.productAlias.create({
    data: {
      productId: input.productId,
      supplierId: input.supplierId,
      supplierCode: input.supplierCode,
      alias: input.description,
      normalized,
      origin: 'MANUAL',
    },
  });
}

// ---------------------------------------------------------------------------
// Anulación y rechazo
// ---------------------------------------------------------------------------

/**
 * Anula un comprobante ya confirmado. Exige motivo y queda en auditoría:
 * una factura nunca se invalida en silencio.
 */
export async function voidDocument(user: AuthUser, documentId: string, reason: string) {
  if (!hasPermission(user, PERMISSIONS.COMPROBANTES_ANULAR)) {
    throw new ForbiddenError('Sólo un administrador puede anular comprobantes.');
  }
  const clean = reason?.trim() ?? '';
  if (clean.length < 10) {
    throw new ValidationError('Explicá el motivo de la anulación (al menos 10 caracteres).');
  }

  const document = await prisma.document.findUnique({ where: { id: documentId } });
  if (!document) throw new NotFoundError('No encontramos ese comprobante.');
  if (document.status === 'ANULADO') throw new ConflictError('Ese comprobante ya está anulado.');

  await prisma.$transaction(async (tx) => {
    await tx.purchaseMovement.deleteMany({ where: { documentId } });
    await tx.paymentSchedule.updateMany({
      where: { documentId },
      data: { status: 'CANCELADO' },
    });
    await tx.document.update({
      where: { id: documentId },
      data: {
        status: 'ANULADO',
        voidReason: clean,
        voidedById: user.id,
        voidedAt: new Date(),
        // Libera el número para que se pueda volver a cargar bien.
        dedupeKey: documentId,
      },
    });
  });

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.DOCUMENT_VOIDED,
    entity: 'Document',
    entityId: documentId,
    reason: clean,
    before: { estado: document.status, numero: document.fullNumber },
  });
}

/** Rechaza una carga que estuvo mal, liberando el número del comprobante. */
export async function rejectDocument(user: AuthUser, documentId: string, reason: string) {
  const document = await prisma.document.findUnique({ where: { id: documentId } });
  if (!document) throw new NotFoundError('No encontramos ese comprobante.');
  assertBranchAccess(user, document.branchId);
  if (document.status === 'VALIDADO') {
    throw new ConflictError('Este comprobante ya fue confirmado: para darlo de baja hay que anularlo.');
  }

  await prisma.document.update({
    where: { id: documentId },
    data: { status: 'RECHAZADO', dedupeKey: documentId, voidReason: reason?.trim() || null },
  });

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.DOCUMENT_REJECTED,
    entity: 'Document',
    entityId: documentId,
    reason: reason?.trim() || null,
  });
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

export async function getDocumentForReview(user: AuthUser, documentId: string) {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    include: {
      branch: true,
      supplier: true,
      files: { orderBy: { pageOrder: 'asc' } },
      items: { orderBy: { lineNumber: 'asc' }, include: { product: true } },
      taxLines: true,
      paymentSchedule: { include: { events: { orderBy: { createdAt: 'desc' } } } },
      ocrAttempts: { orderBy: { attemptNumber: 'asc' } },
      createdBy: { select: { id: true, name: true } },
      validatedBy: { select: { id: true, name: true } },
    },
  });
  if (!document) throw new NotFoundError('No encontramos ese comprobante.');
  assertBranchAccess(user, document.branchId);
  return document;
}

/** Fecha prevista de pago sugerida para un proveedor y una fecha de emisión. */
export async function suggestDueDate(supplierId: string, issueDateISO: string) {
  const issueDate = dateOnlyFromISO(issueDateISO);
  const conditions = await getSupplierConditions(supplierId, issueDate);
  if (!conditions.term) return { dueDate: toDateOnly(issueDate), term: null, conditions };
  return {
    dueDate: computeDueDate(issueDate, conditions.term) ?? toDateOnly(issueDate),
    term: conditions.term,
    conditions,
  };
}
