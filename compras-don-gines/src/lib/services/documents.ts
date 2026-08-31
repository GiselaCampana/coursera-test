import 'server-only';
import { prisma, type Prisma } from '@/lib/db';
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { assertBranchAccess, hasPermission, type AuthUser } from '@/lib/auth/session';
import { Decimal, money, parseArNumber, toDecimal } from '@/lib/money';
import { arToday, dateOnlyFromISO, parseArDate, toDateOnly, toISODate } from '@/lib/datetime';
import {
  consistentPerceptionLines,
  costItems,
  type CostedItem,
  type RawItem,
} from '@/lib/domain/costing';
import { validateDocument, type PrintedSummary, type ValidationReport } from '@/lib/domain/validation';
import { computeDueDate, computePaymentStatus, esFechaProvisoria } from '@/lib/domain/payments';
import { matchProduct, normalizeText, type ProductCandidate } from '@/lib/domain/matching';
import { buildDocumentKey, getStorage } from '@/lib/storage';
import { normalizeUpload } from '@/lib/images';
import { env } from '@/lib/env';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/services/audit';
import { findSupplierByReading, getSupplierConditions } from '@/lib/services/suppliers';
import { asegurarEspacio } from '@/lib/services/almacenamiento';

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

    // Se comprueba el espacio con la imagen ya optimizada, que es la que se va
    // a guardar: preguntar antes de comprimir daría un número que no es el real.
    try {
      await asegurarEspacio(normalized.work.length);
    } catch (error) {
      result.rejected.push({
        filename: label,
        reason: error instanceof AppError ? error.message : 'No hay espacio para guardar la imagen.',
      });
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

    // Se guarda una sola versión, la optimizada. El original no se sube: en un
    // plan gratuito de 1 GB, guardar dos copias de cada foto es gastar el
    // espacio al doble de velocidad sin ganar nada, porque el OCR ya corrió en
    // el teléfono sobre la foto original y lo que queda es el respaldo.
    await storage.put(workKey, normalized.work, normalized.workMime);

    const created = await prisma.documentFile.create({
      data: {
        documentId,
        pageOrder,
        storageKey: workKey,
        mimeType: normalized.workMime,
        originalMimeType: normalized.originalMime,
        sizeBytes: normalized.work.length,
        originalSizeBytes: normalized.originalSizeBytes,
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

/**
 * Pasa el resumen impreso a columnas de la base.
 *
 * Los valores pueden venir escritos a mano en la pantalla de revisión, y ahí se
 * escriben como en el papel: "2.084.594,70". La base espera un decimal
 * canónico, así que hay que normalizar acá. Guardar el string tal cual hacía
 * fallar el guardado con un error de Prisma en inglés.
 *
 * Lo que no se puede interpretar queda en null, nunca en cero: un total que no
 * se pudo leer no es un total de cero.
 */
export function printedToColumns(printed: PrintedSummary) {
  const opt = (v: unknown) => {
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return null;
    const numero = parseArNumber(v);
    return numero === null ? null : numero.toString();
  };
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
    grossFromPrint: item.grossFromPrint,
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

  // Igual que en el resumen: los importes pueden venir escritos como en el
  // papel y la base espera decimales canónicos.
  const decimal = (v: unknown, siFalta: string | null): string | null => {
    const numero = parseArNumber(v);
    return numero === null ? siFalta : numero.toString();
  };

  const rows: Prisma.DocumentTaxLineCreateManyInput[] = [];
  for (const [kind, lineas] of [
    ['IVA', summary.ivaLines],
    ['PERCEPCION', summary.perceptionLines],
  ] as const) {
    for (const line of lineas ?? []) {
      rows.push({
        documentId,
        kind,
        label: line.label,
        rate: decimal(line.rate, '0') ?? '0',
        base: decimal(line.base, null),
        amount: decimal(line.amount, '0') ?? '0',
      });
    }
  }
  if (rows.length > 0) await tx.documentTaxLine.createMany({ data: rows });
}

// ---------------------------------------------------------------------------
// Confirmación
// ---------------------------------------------------------------------------

export interface ConfirmItemInput extends RawItem {
  productId?: string | null;
  /**
   * Cómo se llegó a esa asociación, cuando ya viene resuelta.
   *
   * Importa conservarlo: un renglón que se asoció por el código del proveedor o
   * a mano no es lo mismo que uno que coincidió por parecido de descripción, y
   * esa distinción es la que después permite revisar de dónde salió cada
   * clasificación.
   */
  matchMethod?: string | null;
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

  /*
   * Las percepciones discriminadas salen de lo que quedó guardado al leer el
   * comprobante, no de lo que manda el navegador.
   *
   * El cliente sólo edita el total de percepciones; el desglose lo leyó el
   * servidor y está en las líneas de impuestos del comprobante. Usarlo acá hace
   * que el guardado reparta exactamente igual que la lectura y que la pantalla:
   * repartir cada percepción por separado o repartir el bulto da los mismos
   * totales pero puede mover un centavo de un artículo a otro, y un comprobante
   * tiene que costar lo mismo mirado desde donde se lo mire.
   */
  const percepcionesGuardadas = await prisma.documentTaxLine.findMany({
    where: { documentId: input.documentId, kind: 'PERCEPCION' },
    orderBy: { id: 'asc' },
  });

  /*
   * El desglose de percepciones que dejó la lectura, si sigue cuadrando.
   *
   * Se calcula una vez y se usa para las dos cosas: repartir el costo entre los
   * artículos y volver a escribir las líneas de impuestos del comprobante.
   */
  const percepcionesDiscriminadas = consistentPerceptionLines(
    percepcionesGuardadas.map((l) => ({ label: l.label, amount: l.amount.toString() })),
    input.printed.perceptionsTotal ?? '0',
  );

  // Las mismas líneas, con la tasa y la base que traen guardadas, para volver a
  // escribirlas tal cual si el desglose cuadra.
  const percepcionesParaGuardar = percepcionesDiscriminadas
    ? percepcionesGuardadas.map((l) => ({
        label: l.label,
        rate: l.rate?.toString() ?? null,
        base: l.base?.toString() ?? null,
        amount: l.amount.toString(),
      }))
    : null;

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

  /*
   * --- Asociación al catálogo, resuelta acá y no en el navegador -----------
   *
   * Cada renglón que se pueda reconocer con seguridad tiene que quedar
   * **asociado y persistido**, no sólo reconocido de paso durante la lectura.
   *
   * Antes se guardaba lo que mandara la pantalla, y la pantalla manda null en
   * cuanto el operador no eligió el producto a mano. El resultado era una
   * compra perfectamente validada que después no existía para el reporte por
   * producto: la factura de Errecalde traía dos quesos Sardo y el reporte de
   * "Queso Sardo" devolvía cero kilos y cero pesos, porque los movimientos
   * habían quedado con productId nulo.
   *
   * La alternativa —que el reporte adivine cada vez que se lo abre— sería peor:
   * la misma compra podría clasificarse distinto según cuándo se mire, y el
   * catálogo cambia. La compra se clasifica una vez, al confirmarse, y queda.
   *
   * Sólo se completa lo que el operador dejó vacío: una elección humana nunca
   * se pisa. Y sólo cuando el reconocimiento es inequívoco; si hay empate, el
   * renglón queda sin asociar para que lo resuelva una persona.
   */
  const reconocidos = await matchItemsToProducts(costed, supplier.id);
  const productoDeCadaRenglon = input.items.map((source, i) => {
    if (source.productId) return source.productId;
    const reconocido = reconocidos[i];
    return reconocido && reconocido.productId ? reconocido.productId : null;
  });
  const metodoDeCadaRenglon = input.items.map((source, i) => {
    if (source.productId) {
      if (source.learnAlias) return 'MANUAL';
      // El método con el que ya venía, si lo trae: no se degrada a "ALIAS" por
      // haber pasado otra vez por acá.
      return source.matchMethod || 'ALIAS';
    }
    return reconocidos[i]?.productId ? (reconocidos[i].method ?? 'NONE') : 'NONE';
  });

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
      createdItems.push(
        await tx.documentItem.create({
          data: {
            documentId: document.id,
            ...itemToColumns(item),
            productId: productoDeCadaRenglon[i],
            matchMethod: metodoDeCadaRenglon[i],
          },
        }),
      );
    }

    /*
     * Las percepciones se reescriben con el desglose que trajo la lectura.
     *
     * Antes se rearmaban siempre desde el total impreso, así que un comprobante
     * de Errecalde —que discrimina "Percepción IVA RG 5329 $114.914,02" y
     * "Percepción IIBB Buenos Aires $67.033,18"— quedaba guardado con un solo
     * renglón de $181.947,20 al confirmarlo. El desglose se usaba para repartir
     * el costo entre los artículos y después se tiraba.
     *
     * Eso es plata que el papel discrimina y el comprobante guardado ya no: dos
     * percepciones distintas se declaran y se compensan distinto, y a fin de mes
     * hay que poder decir cuánto fue de cada una sin volver a abrir la foto. Se
     * conserva el desglose cuando suma el total impreso; si no cuadra, se cae al
     * renglón único, que es lo único que se puede afirmar.
     */
    await createTaxLines(tx, document.id, {
      ivaLines: buildIvaLines(input.printed, conditions.tax?.ivaRate),
      perceptionLines:
        percepcionesParaGuardar ?? buildPerceptionLines(input.printed, conditions.tax?.iibbRate),
    });

    // Movimientos de compra e historial de costos.
    for (let i = 0; i < costed.length; i++) {
      const item = costed[i];
      const documentItem = createdItems[i];
      // El mismo producto que quedó en el renglón: el movimiento y el renglón
      // no pueden discrepar, porque el reporte mira el movimiento y la pantalla
      // del comprobante mira el renglón.
      const productId = productoDeCadaRenglon[i];

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
    /*
     * Con "factura contra factura" la fecha queda marcada como provisoria.
     *
     * No es un detalle cosmético: mientras la próxima factura no llegue, esa
     * fecha es una estimación de cuándo pasa el camión, y en la agenda tiene que
     * poder distinguirse de las que salen de un plazo acordado. Cuando llega la
     * factura siguiente se confirma contra su fecha real y deja de ser
     * provisoria.
     */
    const provisoria = conditions.term ? esFechaProvisoria(conditions.term) : false;

    const schedule = await tx.paymentSchedule.upsert({
      where: { documentId: document.id },
      update: {
        dueDate,
        dueDateProvisional: provisoria,
        plannedAmount: total.toString(),
        plannedPaymentMethod: paymentMethod,
        status,
        notes: input.payment.notes ?? null,
      },
      create: {
        documentId: document.id,
        dueDate,
        dueDateProvisional: provisoria,
        plannedAmount: total.toString(),
        plannedPaymentMethod: paymentMethod,
        paidAmount: '0',
        status,
        notes: input.payment.notes ?? null,
      },
    });

    /*
     * Antes de cerrar: que lo derivado haya quedado completo.
     *
     * Un comprobante VALIDADO cuyas estructuras derivadas quedaron a medias es
     * lo peor de los dos mundos: existe, se puede pagar, aparece en los
     * listados, y para Compras, Precios o la agenda no existe. Nadie lo nota
     * hasta que alguien busca un artículo y le dan cero kilos sobre una compra
     * que sí hizo.
     *
     * Se comprueba acá adentro, con la transacción abierta, para que fallar
     * signifique no guardar nada. Guardar y avisar después dejaría exactamente
     * el estado que esto viene a impedir.
     */
    await verificarDerivados(tx, document.id, costed.length, toDecimal(report.computed.totalCost));

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
      /*
       * Las advertencias quedan escritas en el asiento, no sólo en el informe.
       *
       * Un comprobante se puede validar con advertencias —un renglón cuyo
       * importe no entró en el recorte, centavos conciliados, una relectura que
       * hizo falta—, y eso está bien: son cosas que no impiden pagar. Pero
       * tienen que poder buscarse después sin abrir el comprobante uno por uno,
       * porque son justamente las que uno quiere revisar cuando algo no cuadra
       * a fin de mes.
       */
      advertencias: report.checks.filter((c) => c.severity === 'WARN').map((c) => c.label),
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

/**
 * Que lo que la confirmación deriva del comprobante haya quedado entero.
 *
 * Son las cinco cosas de las que dependen las otras pantallas. Ninguna es una
 * comprobación teórica: cada una corresponde a una forma concreta en que la
 * factura quedaría invisible para una parte de la aplicación.
 */
export async function verificarDerivados(
  tx: Prisma.TransactionClient,
  documentId: string,
  renglonesEsperados: number,
  totalDelComprobante: Decimal,
): Promise<void> {
  const falla = (motivo: string): never => {
    throw new AppError(
      `El comprobante no se guardó: ${motivo}. No se registró nada, para no dejarlo ` +
        'validado a medias.',
      { status: 500, code: 'DERIVADOS_INCOMPLETOS' },
    );
  };

  const renglones = await tx.documentItem.findMany({
    where: { documentId },
    select: { id: true, productId: true },
  });
  if (renglones.length !== renglonesEsperados) {
    falla(`se esperaban ${renglonesEsperados} renglones y quedaron ${renglones.length}`);
  }

  // 1. Un movimiento de compra por renglón: es lo que lee Compras.
  const movimientos = await tx.purchaseMovement.findMany({
    where: { documentId },
    select: { documentItemId: true, productId: true, totalCost: true },
  });
  if (movimientos.length !== renglones.length) {
    falla(
      `hay ${renglones.length} renglones y ${movimientos.length} movimientos de compra`,
    );
  }

  // 2. Y el producto de cada movimiento es el de su renglón: el reporte mira el
  //    movimiento y la pantalla del comprobante mira el renglón, y no pueden
  //    decir cosas distintas.
  const productoDelRenglon = new Map(renglones.map((r) => [r.id, r.productId]));
  for (const movimiento of movimientos) {
    const esperado = productoDelRenglon.get(movimiento.documentItemId ?? '');
    if (esperado !== movimiento.productId) {
      falla('un movimiento de compra quedó con un producto distinto al de su renglón');
    }
  }

  // 3. Historial de costos para todo lo que quedó asociado: es lo que lee
  //    Precios. Sin esto el artículo existe y no tiene costo.
  const asociados = renglones.filter((r) => r.productId).length;
  const costos = await tx.costHistory.count({ where: { documentId } });
  if (costos !== asociados) {
    falla(`hay ${asociados} renglones con producto y ${costos} entradas de costo`);
  }

  // 4. Exactamente una agenda de pago: es lo que lee Pagos.
  const agendas = await tx.paymentSchedule.count({ where: { documentId } });
  if (agendas !== 1) {
    falla(`quedaron ${agendas} agendas de pago y tiene que haber una`);
  }

  /*
   * 5. Y la suma de los movimientos es el total del comprobante.
   *
   * Se compara contra el total **calculado** y no contra el impreso. Cuando el
   * comprobante cierra son el mismo número; cuando un administrador lo fuerza
   * son distintos a propósito —de eso se trata forzar— y comparar contra el
   * impreso haría fallar justamente el caso que la anulación administrativa
   * existe para permitir. Lo que se quiere detectar acá es un movimiento que
   * falta o que se duplicó, y para eso el calculado es la referencia correcta.
   *
   * El reparto de impuestos entre artículos deja un residuo de centavos que se
   * asigna de forma determinística, así que la tolerancia es de un peso.
   */
  const suma = movimientos.reduce(
    (acc, m) => acc.plus(toDecimal(m.totalCost.toString())),
    new Decimal(0),
  );
  if (suma.minus(totalDelComprobante).abs().gt(1)) {
    falla(
      `los movimientos suman ${suma.toFixed(2)} y el comprobante es de ` +
        `${totalDelComprobante.toFixed(2)}`,
    );
  }
}

/**
 * Aprende que este proveedor llama así —y con este código— a este producto.
 *
 * Son dos cosas distintas y se guardan como tales. La **descripción** es una
 * grafía del nombre, y de esas puede haber varias: "JAMON COCIDO MONT-BLANC" y
 * "JAMON COCIDO MONTBLANC" son el mismo fiambre escrito de dos maneras. El
 * **código** es una identificación, y de ésa hay una sola por proveedor: el
 * ART-00228 de Errecalde es el PLU 1211 y no puede ser otra cosa.
 *
 * De ahí la convención que sostiene el índice único: el código vive en una sola
 * fila de alias del producto, y las demás grafías lo dejan en nulo. Sin eso, un
 * producto con tres formas de escribirse tendría tres filas con el mismo código
 * y el índice no se podría crear.
 */
export async function learnProductAlias(
  tx: Prisma.TransactionClient,
  input: {
    productId: string;
    supplierId: string;
    supplierCode: string | null;
    description: string;
  },
) {
  const normalized = normalizeText(input.description);
  const codigo = input.supplierCode?.trim() || null;

  /*
   * El código primero, porque es lo que hace que la próxima factura se asocie
   * sola sin depender de cómo venga escrita la descripción.
   *
   * Si ese código ya está tomado por **otro** producto, no se toca nada: es el
   * conflicto que el índice impide, y resolverlo pisando lo que había sería
   * decidir por el operador a espaldas suyas. Se deja que lo arregle desde la
   * ficha del producto.
   */
  if (codigo) {
    const tomado = await tx.productAlias.findFirst({
      where: { supplierId: input.supplierId, supplierCode: codigo },
    });
    if (!tomado) {
      /*
       * La fila con esta misma grafía sirve para colgarle el código, pero sólo
       * si todavía no tiene uno.
       *
       * Un proveedor puede facturar el mismo artículo con dos códigos —la
       * muzzarella Barraza en plancha viene como ART-01611 de 10 kg y como
       * ART-82444 de 5 kg, y para Don Ginés las dos son el PLU 1317—. Si el
       * segundo código se escribiera encima del primero, el primero dejaría de
       * reconocerse y esa factura volvería a quedar sin asociar.
       *
       * Un código apunta a un artículo y a uno solo; al revés no: un artículo
       * puede tener varios códigos del mismo proveedor. La asimetría es la que
       * sostiene el índice único, y hay que respetarla en las dos direcciones.
       */
      const mismaGrafia = await tx.productAlias.findFirst({
        where: {
          productId: input.productId,
          supplierId: input.supplierId,
          normalized,
          supplierCode: null,
        },
      });
      if (mismaGrafia) {
        await tx.productAlias.update({
          where: { id: mismaGrafia.id },
          data: { supplierCode: codigo, origin: 'MANUAL' },
        });
        return;
      }

      /*
       * Si la grafía ya está usada por otro código del mismo artículo, la fila
       * nueva se identifica por el código.
       *
       * `normalized` es único por producto y proveedor, así que no puede
       * repetirse el texto. Al segundo código se le pone el propio código
       * normalizado: no va a coincidir nunca con una descripción de factura
       * —que es lo que busca el paso por grafía— y deja intacta la búsqueda por
       * código, que es para lo que existe esta fila.
       */
      const grafiaLibre = await tx.productAlias.findFirst({
        where: { productId: input.productId, supplierId: input.supplierId, normalized },
      });
      await tx.productAlias.create({
        data: {
          productId: input.productId,
          supplierId: input.supplierId,
          supplierCode: codigo,
          alias: input.description,
          normalized:
            grafiaLibre || normalized.length < 3 ? normalizeText(codigo) : normalized,
          origin: 'MANUAL',
        },
      });
      return;
    }
    if (tomado.productId !== input.productId) return;
  }

  // Sin código, o con el código ya guardado en otra fila del mismo producto:
  // queda la grafía, que es lo único que agrega.
  if (normalized.length < 3) return;
  const exists = await tx.productAlias.findFirst({
    where: { productId: input.productId, supplierId: input.supplierId, normalized },
  });
  if (exists) return;
  await tx.productAlias.create({
    data: {
      productId: input.productId,
      supplierId: input.supplierId,
      supplierCode: null,
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
    dueDate:
      computeDueDate(issueDate, conditions.term, {
        proximaFactura: conditions.proximaFactura,
      }) ?? toDateOnly(issueDate),
    term: conditions.term,
    conditions,
  };
}

/**
 * Acepta un comprobante ya leído, con los datos que están guardados.
 *
 * Es la salida del callejón sin salida: un comprobante que se leyó bien queda en
 * REQUIERE_REVISION hasta que alguien lo confirma, y hasta ahora la única forma
 * de confirmarlo era terminar el asistente de carga. Si esa pantalla se cerraba
 * —se cambió de pantalla, se cortó la conexión, se dejó para después— el
 * comprobante quedaba en el detalle con dos botones: rechazar y volver. Un
 * comprobante correcto no puede tener como única salida tirarlo y sacar la foto
 * de nuevo.
 *
 * No cambia el estado a mano: **vuelve a correr todos los controles** con lo que
 * está en la base y confirma sólo si cierran. Por eso reconstruye la entrada
 * desde los renglones y los importes guardados y llama al mismo
 * `confirmDocument` que usa el asistente: si tuviera su propio camino, dentro de
 * seis meses habría dos criterios distintos para decidir si una factura cierra,
 * y el que se aplicaría dependería de por qué pantalla entró el operador.
 *
 * Las advertencias no frenan nada y no se pierden: quedan en el informe que se
 * guarda con el comprobante y en la auditoría. Lo que frena es un error.
 */
export async function acceptReadDocument(
  user: AuthUser,
  documentId: string,
): Promise<ConfirmResult> {
  /*
   * El permiso primero, antes de mirar el comprobante.
   *
   * `confirmDocument` lo vuelve a comprobar —es su responsabilidad y no se le
   * saca—, pero acá tiene que ir adelante de todo: si no, alguien sin permiso
   * recibe "falta el proveedor" o "falta la fecha" en vez de "no podés validar
   * comprobantes", y así se entera de cómo está el comprobante por dentro.
   */
  if (!hasPermission(user, PERMISSIONS.COMPROBANTES_VALIDAR)) {
    throw new ForbiddenError('Tu usuario no puede validar comprobantes.');
  }

  const document = await prisma.document.findUnique({
    where: { id: documentId },
    include: { items: { orderBy: { lineNumber: 'asc' } } },
  });
  if (!document) throw new NotFoundError('No encontramos ese comprobante.');
  assertBranchAccess(user, document.branchId);

  if (document.status === 'VALIDADO') {
    throw new ConflictError('Este comprobante ya está validado.');
  }
  if (document.status === 'ANULADO') {
    throw new ConflictError('Este comprobante está anulado.');
  }

  /*
   * Lo que falta para poder aceptarlo se dice por su nombre.
   *
   * Son datos del encabezado que la lectura puede no haber conseguido. Sin
   * ellos el comprobante no se puede guardar, pero el operador los puede
   * completar desde el asistente: conviene decirle cuál falta y no un genérico.
   */
  if (!document.supplierId) {
    throw new ValidationError(
      'El comprobante no tiene proveedor asignado. Abrilo desde la carga para elegirlo.',
    );
  }
  if (!document.issueDate) {
    throw new ValidationError(
      'El comprobante no tiene fecha de emisión. Abrilo desde la carga para completarla.',
    );
  }
  if (document.pointOfSale.trim() === '' || document.number.trim() === '') {
    throw new ValidationError(
      'El comprobante no tiene punto de venta o número. Abrilo desde la carga para completarlos.',
    );
  }
  if (document.items.length === 0) {
    throw new ValidationError('El comprobante no tiene ningún artículo cargado.');
  }

  const conditions = await getSupplierConditions(document.supplierId, document.issueDate);
  const dueDate =
    document.appliedDueDate ??
    (conditions.term
      ? computeDueDate(document.issueDate, conditions.term, {
          proximaFactura: conditions.proximaFactura,
        })
      : null) ??
    toDateOnly(document.issueDate);

  return confirmDocument(user, {
    documentId,
    supplierId: document.supplierId,
    docType: document.docType,
    letter: document.letter,
    pointOfSale: document.pointOfSale,
    number: document.number,
    issueDate: toISODate(document.issueDate),
    printed: {
      grossSubtotal: document.grossSubtotal?.toString() ?? null,
      discountTotal: document.discountTotal?.toString() ?? null,
      netTotal: document.netTotal?.toString() ?? null,
      ivaTotal: document.ivaTotal?.toString() ?? null,
      perceptionsTotal: document.perceptionsTotal?.toString() ?? null,
      total: document.total?.toString() ?? null,
      lineCount: document.printedLineCount,
      netWeightKg: document.printedNetWeightKg?.toString() ?? null,
      totalUnits: document.printedTotalUnits?.toString() ?? null,
    },
    /*
     * Los renglones se reconstruyen tal como se guardaron, con una salvedad:
     * `grossSubtotal` sólo se manda cuando salió impreso del papel.
     *
     * Un importe que se calculó como cantidad × precio no es un dato del
     * comprobante, y mandarlo como si lo fuera lo convertiría en verificado sin
     * que nadie lo haya verificado. El control tiene que volver a verlo por lo
     * que es: un renglón que no se pudo contrastar.
     */
    items: document.items.map((item) => ({
      lineNumber: item.lineNumber,
      supplierCode: item.supplierCode,
      description: item.description,
      quantity: item.quantity.toString(),
      unit: item.unit,
      pieceCount: item.pieceCount,
      totalWeightKg: item.totalWeightKg?.toString() ?? undefined,
      unitNetPrice: item.unitNetPrice.toString(),
      grossSubtotal: item.grossFromPrint ? item.grossSubtotal.toString() : undefined,
      discountPct: item.discountPct.toString(),
      ivaRate: item.ivaRate.toString(),
      /*
       * El producto ya asociado viaja de vuelta, y con él cómo se llegó a serlo.
       *
       * Sin esto, aceptar desde el detalle deshacía la clasificación: el
       * renglón volvía sin producto, el reconocimiento automático corría de
       * nuevo, y lo que una persona había asociado a mano quedaba en nulo. Con
       * ello se iban el movimiento de compra y el historial de costos, así que
       * el comprobante quedaba VALIDADO y no existía para Compras ni para
       * Precios.
       *
       * Revalidar importes es una cosa y clasificar artículos es otra. La
       * segunda no puede deshacerse por hacer la primera.
       */
      productId: item.productId,
      matchMethod: item.matchMethod,
    })),
    payment: {
      dueDate: toISODate(dueDate),
      paymentMethod:
        document.appliedPaymentMethod ?? conditions.term?.paymentMethod ?? 'TRANSFERENCIA',
      notes: null,
    },
  });
}
