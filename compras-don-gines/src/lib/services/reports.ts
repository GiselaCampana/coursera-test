import 'server-only';
import { prisma, type Prisma } from '@/lib/db';
import { ForbiddenError } from '@/lib/errors';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { branchScopeFilter, hasPermission, type AuthUser } from '@/lib/auth/session';
import { Decimal, ZERO, formatARS, formatQty, toDecimal } from '@/lib/money';
import { addDays, arToday, formatDateAr, parseArDate, startOfMonthAr } from '@/lib/datetime';
import { countPriceIncreases } from '@/lib/services/pricing';
import { refreshPaymentStatuses } from '@/lib/services/payments';

export interface PurchaseFilters {
  productId?: string | null;
  supplierId?: string | null;
  branchId?: string | null;
  from?: string | null;
  to?: string | null;
  search?: string | null;
}

function buildWhere(user: AuthUser, filters: PurchaseFilters): Prisma.PurchaseMovementWhereInput {
  const scope = branchScopeFilter(user);
  const where: Prisma.PurchaseMovementWhereInput = { ...scope };

  // Un operador no puede mirar otra sucursal ni pidiéndolo explícitamente.
  if (filters.branchId && (user.scopeAllBranches || filters.branchId === user.branchId)) {
    where.branchId = filters.branchId;
  }
  if (filters.productId) where.productId = filters.productId;
  if (filters.supplierId) where.supplierId = filters.supplierId;

  const from = filters.from ? parseArDate(filters.from) : null;
  const to = filters.to ? parseArDate(filters.to) : null;
  if (from || to) {
    where.date = {};
    if (from) where.date.gte = from;
    if (to) where.date.lte = to;
  }
  if (filters.search?.trim()) {
    where.description = { contains: filters.search.trim(), mode: 'insensitive' };
  }
  return where;
}

export interface PurchaseRow {
  id: string;
  date: Date;
  description: string;
  productName: string | null;
  supplierName: string | null;
  branchName: string;
  documentNumber: string;
  documentId: string;
  quantity: string;
  unit: 'KG' | 'UNIT';
  pieceCount: number | null;
  avgPieceWeightKg: string | null;
  unitNetPrice: string;
  discountAmount: string;
  ivaAmount: string;
  perceptionAmount: string;
  unitCost: string;
  totalCost: string;
}

export interface PurchaseReport {
  rows: PurchaseRow[];
  totals: {
    kilos: string;
    unidades: string;
    piezas: number;
    neto: string;
    iva: string;
    percepciones: string;
    costoTotal: string;
    comprobantes: number;
  };
}

/**
 * Historial de compras: cuántos kilos y unidades se compraron, de qué producto,
 * a qué proveedor, en qué sucursal, en qué período y a qué costo.
 */
export async function getPurchaseReport(
  user: AuthUser,
  filters: PurchaseFilters,
  limit = 500,
): Promise<PurchaseReport> {
  if (!hasPermission(user, PERMISSIONS.REPORTES_VER)) {
    throw new ForbiddenError('Tu usuario no puede ver los reportes de compras.');
  }

  const where = buildWhere(user, filters);
  const movements = await prisma.purchaseMovement.findMany({
    where,
    include: {
      product: { select: { normalizedName: true } },
      supplier: { select: { tradeName: true } },
      branch: { select: { name: true } },
      document: { select: { fullNumber: true, id: true } },
    },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    take: limit,
  });

  let kilos = ZERO;
  let unidades = ZERO;
  let piezas = 0;
  let neto = ZERO;
  let iva = ZERO;
  let percepciones = ZERO;
  let costoTotal = ZERO;
  const documentIds = new Set<string>();

  const rows: PurchaseRow[] = movements.map((m) => {
    const quantity = toDecimal(m.quantity.toString());
    if (m.unit === 'KG') kilos = kilos.plus(quantity);
    else unidades = unidades.plus(quantity);
    piezas += m.pieceCount ?? 0;
    neto = neto.plus(toDecimal(m.netAmount.toString()));
    iva = iva.plus(toDecimal(m.ivaAmount.toString()));
    percepciones = percepciones.plus(toDecimal(m.perceptionAmount.toString()));
    costoTotal = costoTotal.plus(toDecimal(m.totalCost.toString()));
    documentIds.add(m.documentId);

    return {
      id: m.id,
      date: m.date,
      description: m.description,
      productName: m.product?.normalizedName ?? null,
      supplierName: m.supplier?.tradeName ?? null,
      branchName: m.branch.name,
      documentNumber: m.document.fullNumber,
      documentId: m.documentId,
      quantity: quantity.toFixed(m.unit === 'KG' ? 2 : 0),
      unit: m.unit as 'KG' | 'UNIT',
      pieceCount: m.pieceCount,
      avgPieceWeightKg: m.avgPieceWeightKg?.toString() ?? null,
      unitNetPrice: m.unitNetPrice.toFixed(2),
      discountAmount: m.discountAmount.toFixed(2),
      ivaAmount: m.ivaAmount.toFixed(2),
      perceptionAmount: m.perceptionAmount.toFixed(2),
      unitCost: m.unitCost.toFixed(2),
      totalCost: m.totalCost.toFixed(2),
    };
  });

  return {
    rows,
    totals: {
      kilos: kilos.toFixed(2),
      unidades: unidades.toFixed(2),
      piezas,
      neto: neto.toFixed(2),
      iva: iva.toFixed(2),
      percepciones: percepciones.toFixed(2),
      costoTotal: costoTotal.toFixed(2),
      comprobantes: documentIds.size,
    },
  };
}

/** Exporta el reporte a CSV con separador de punto y coma, que es lo que abre Excel en español. */
export function purchaseReportToCsv(report: PurchaseReport): string {
  const headers = [
    'Fecha',
    'Comprobante',
    'Proveedor',
    'Sucursal',
    'Producto',
    'Descripción en la factura',
    'Cantidad',
    'Unidad',
    'Piezas',
    'Peso promedio por pieza',
    'Precio unitario neto',
    'Descuento',
    'IVA',
    'Percepciones',
    'Costo unitario final',
    'Costo total',
  ];

  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const lines = [headers.map(escape).join(';')];

  for (const row of report.rows) {
    lines.push(
      [
        formatDateAr(row.date),
        row.documentNumber,
        row.supplierName ?? '',
        row.branchName,
        row.productName ?? 'Sin asociar',
        row.description,
        row.quantity.replace('.', ','),
        row.unit === 'KG' ? 'kg' : 'unidades',
        row.pieceCount?.toString() ?? '',
        row.avgPieceWeightKg?.replace('.', ',') ?? '',
        row.unitNetPrice.replace('.', ','),
        row.discountAmount.replace('.', ','),
        row.ivaAmount.replace('.', ','),
        row.perceptionAmount.replace('.', ','),
        row.unitCost.replace('.', ','),
        row.totalCost.replace('.', ','),
      ]
        .map(escape)
        .join(';'),
    );
  }

  lines.push('');
  lines.push(
    [
      'TOTALES',
      '',
      '',
      '',
      '',
      `${report.totals.comprobantes} comprobante(s)`,
      report.totals.kilos.replace('.', ','),
      'kg',
      report.totals.piezas.toString(),
      '',
      '',
      '',
      report.totals.iva.replace('.', ','),
      report.totals.percepciones.replace('.', ','),
      '',
      report.totals.costoTotal.replace('.', ','),
    ]
      .map(escape)
      .join(';'),
  );

  // BOM para que Excel reconozca el UTF-8 y no rompa los acentos.
  return `﻿${lines.join('\r\n')}`;
}

// ---------------------------------------------------------------------------
// Tablero de inicio
// ---------------------------------------------------------------------------

export interface DashboardData {
  pendientesDeRevision: number;
  venceHoy: { cantidad: number; importe: string };
  proximosSieteDias: { cantidad: number; importe: string };
  vencidos: { cantidad: number; importe: string };
  comprasDelMes: { importe: string; comprobantes: number; kilos: string };
  productosConAumento: number;
  ultimosComprobantes: {
    id: string;
    fullNumber: string;
    supplierName: string | null;
    branchName: string;
    issueDate: Date | null;
    total: string | null;
    status: string;
    checkState: string;
    itemCount: number;
  }[];
}

export async function getDashboard(user: AuthUser): Promise<DashboardData> {
  await refreshPaymentStatuses();
  const scope = branchScopeFilter(user);
  const today = arToday();
  const in7Days = addDays(today, 7);
  const monthStart = startOfMonthAr();

  const [pendientes, schedules, movements, ultimos, aumentos] = await Promise.all([
    prisma.document.count({
      where: { ...scope, status: 'REQUIERE_REVISION' },
    }),
    prisma.paymentSchedule.findMany({
      where: {
        document: { ...scope, status: 'VALIDADO' },
        status: { in: ['VENCE_HOY', 'VENCIDO', 'AGENDADO'] },
      },
      select: { status: true, dueDate: true, plannedAmount: true, paidAmount: true },
    }),
    prisma.purchaseMovement.findMany({
      where: { ...scope, date: { gte: monthStart } },
      select: { totalCost: true, quantity: true, unit: true, documentId: true },
    }),
    prisma.document.findMany({
      where: { ...scope, status: { in: ['VALIDADO', 'REQUIERE_REVISION'] } },
      include: {
        supplier: { select: { tradeName: true } },
        branch: { select: { name: true } },
        _count: { select: { items: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 8,
    }),
    countPriceIncreases(user, monthStart),
  ]);

  const sumPending = (list: typeof schedules) =>
    list.reduce<Decimal>(
      (acc, s) =>
        acc.plus(toDecimal(s.plannedAmount.toString()).minus(toDecimal(s.paidAmount.toString()))),
      ZERO,
    );

  const venceHoy = schedules.filter((s) => s.status === 'VENCE_HOY');
  const vencidos = schedules.filter((s) => s.status === 'VENCIDO');
  const proximos = schedules.filter(
    (s) => s.status === 'AGENDADO' && s.dueDate.getTime() <= in7Days.getTime(),
  );

  let comprasImporte = ZERO;
  let comprasKilos = ZERO;
  const comprobantesDelMes = new Set<string>();
  for (const m of movements) {
    comprasImporte = comprasImporte.plus(toDecimal(m.totalCost.toString()));
    if (m.unit === 'KG') comprasKilos = comprasKilos.plus(toDecimal(m.quantity.toString()));
    comprobantesDelMes.add(m.documentId);
  }

  return {
    pendientesDeRevision: pendientes,
    venceHoy: { cantidad: venceHoy.length, importe: sumPending(venceHoy).toFixed(2) },
    proximosSieteDias: { cantidad: proximos.length, importe: sumPending(proximos).toFixed(2) },
    vencidos: { cantidad: vencidos.length, importe: sumPending(vencidos).toFixed(2) },
    comprasDelMes: {
      importe: comprasImporte.toFixed(2),
      comprobantes: comprobantesDelMes.size,
      kilos: comprasKilos.toFixed(2),
    },
    productosConAumento: aumentos,
    ultimosComprobantes: ultimos.map((d) => ({
      id: d.id,
      fullNumber: d.fullNumber || 'Sin número',
      supplierName: d.supplier?.tradeName ?? null,
      branchName: d.branch.name,
      issueDate: d.issueDate,
      total: d.total?.toFixed(2) ?? null,
      status: d.status,
      checkState: d.checkState,
      itemCount: d._count.items,
    })),
  };
}

export { formatARS, formatQty };
