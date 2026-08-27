import 'server-only';
import { prisma } from '@/lib/db';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { branchScopeFilter, hasPermission, type AuthUser } from '@/lib/auth/session';
import { Decimal, money, toDecimal } from '@/lib/money';
import { arToday, parseArDate } from '@/lib/datetime';
import {
  applyRounding,
  computeSalePrices,
  priceFromMargin,
  type MarginBasis,
  type RoundingRule,
  type SaleMode,
  type SalePrices,
} from '@/lib/domain/pricing';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/services/audit';

/**
 * Regla de precios aplicable a un producto: la propia del producto si existe y
 * está vigente, si no la global, y en última instancia lo configurado en la
 * ficha del producto.
 */
export async function resolvePricingRule(productId: string, at: Date = arToday()) {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) throw new NotFoundError('No encontramos ese producto.');

  const rule = await prisma.pricingRule.findFirst({
    where: {
      active: true,
      productId,
      validFrom: { lte: at },
      OR: [{ validTo: null }, { validTo: { gte: at } }],
    },
    orderBy: { validFrom: 'desc' },
  });

  const globalRule = rule
    ? null
    : await prisma.pricingRule.findFirst({
        where: {
          active: true,
          productId: null,
          validFrom: { lte: at },
          OR: [{ validTo: null }, { validTo: { gte: at } }],
        },
        orderBy: { validFrom: 'desc' },
      });

  const effective = rule ?? globalRule;

  return {
    product,
    ruleId: effective?.id ?? null,
    ruleName: effective?.name ?? 'Configuración del producto',
    marginBasis: (effective?.marginBasis ?? product.marginBasis) as MarginBasis,
    targetMarginPct: (effective?.targetMarginPct ?? product.targetMarginPct).toString(),
    cashDiscountPct: (effective?.cashDiscountPct ?? product.cashDiscountPct).toString(),
    roundingRule: (effective?.roundingRule ?? product.roundingRule) as RoundingRule,
    saleMode: product.saleMode as SaleMode,
    pieceWeightKg: product.avgPieceWeightKg?.toString() ?? null,
    alCorteHormaDigitalMarginPct: product.alCorteHormaDigitalMarginPct?.toString() ?? null,
    alCorteHormaCashMarginPct: product.alCorteHormaCashMarginPct?.toString() ?? null,
    alCorteCajaCashMarginPct: product.alCorteCajaCashMarginPct?.toString() ?? null,
    feteado100gMarginPct: product.feteado100gMarginPct?.toString() ?? null,
    feteadoQuarterMarginPct: product.feteadoQuarterMarginPct?.toString() ?? null,
    feteadoPieceDigitalMarginPct: product.feteadoPieceDigitalMarginPct?.toString() ?? null,
    feteadoPieceCashMarginPct: product.feteadoPieceCashMarginPct?.toString() ?? null,
    wholeUnitMarginPct: product.wholeUnitMarginPct?.toString() ?? null,
  };
}

export interface ProductCostSnapshot {
  unitCost: Decimal | null;
  previousUnitCost: Decimal | null;
  deltaAmount: Decimal | null;
  deltaPct: Decimal | null;
  date: Date | null;
  supplierName: string | null;
  branchName: string | null;
}

export async function getLatestCost(productId: string): Promise<ProductCostSnapshot> {
  const latest = await prisma.costHistory.findFirst({
    where: { productId },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    include: { supplier: true, branch: true },
  });
  if (!latest) {
    return {
      unitCost: null,
      previousUnitCost: null,
      deltaAmount: null,
      deltaPct: null,
      date: null,
      supplierName: null,
      branchName: null,
    };
  }
  return {
    unitCost: toDecimal(latest.unitCost.toString()),
    previousUnitCost: latest.previousUnitCost ? toDecimal(latest.previousUnitCost.toString()) : null,
    deltaAmount: latest.deltaAmount ? toDecimal(latest.deltaAmount.toString()) : null,
    deltaPct: latest.deltaPct ? toDecimal(latest.deltaPct.toString()) : null,
    date: latest.date,
    supplierName: latest.supplier?.tradeName ?? null,
    branchName: latest.branch?.name ?? null,
  };
}

export interface PriceTierSet {
  baseKg: Decimal | null;
  alCorteHormaDigitalKg: Decimal | null;
  alCorteHormaCashKg: Decimal | null;
  alCorteCajaCashKg: Decimal | null;
  feteado100gKg: Decimal | null;
  feteadoQuarterKg: Decimal | null;
  feteadoPieceDigitalKg: Decimal | null;
  feteadoPieceCashKg: Decimal | null;
  wholeUnitTotal: Decimal | null;
}

export interface PriceSuggestion {
  productId: string;
  productName: string;
  saleMode: SaleMode;
  purchaseUnit: 'KG' | 'UNIT';
  purchaseUnitWeightKg: string | null;
  soldByUnit: boolean;
  cost: ProductCostSnapshot;
  /** Costo comparable para vender por kilo. */
  costPerKg: Decimal | null;
  previousCostPerKg: Decimal | null;
  /** Falta el peso neto para convertir una compra por unidad a costo por kilo. */
  needsPurchaseUnitWeight: boolean;
  prices: SalePrices | null;
  tiers: PriceTierSet;
  rule: Awaited<ReturnType<typeof resolvePricingRule>>;
  approved: {
    pricePerKg: string;
    validFrom: Date;
    approvedBy: string | null;
  } | null;
}

/**
 * Precio de venta sugerido a partir del último costo unitario final.
 * Si el producto todavía no tiene ninguna compra, no hay costo y no se sugiere
 * nada: no se inventa una base.
 */
export async function suggestPricesFor(productId: string): Promise<PriceSuggestion> {
  const rule = await resolvePricingRule(productId);
  const cost = await getLatestCost(productId);

  const lastApproved = await prisma.salePriceHistory.findFirst({
    where: { productId },
    orderBy: [{ validFrom: 'desc' }, { approvedAt: 'desc' }],
    include: { approvedBy: { select: { name: true } } },
  });

  const purchaseUnit = rule.product.purchaseUnit as 'KG' | 'UNIT';
  const purchaseUnitWeightKg = rule.product.purchaseUnitWeightKg?.toString() ?? null;
  const pesoUnidad = purchaseUnitWeightKg ? toDecimal(purchaseUnitWeightKg) : null;
  // Un artículo de código de barras que se compra y se vende por unidad (ej. botella
  // de tomate) no necesita inventar un peso para poder formar su precio.
  const soldByUnit =
    !rule.product.usesPlu &&
    purchaseUnit === 'UNIT' &&
    (!pesoUnidad || pesoUnidad.lte(0));
  const needsPurchaseUnitWeight =
    purchaseUnit === 'UNIT' &&
    !soldByUnit &&
    Boolean(cost.unitCost) &&
    (!pesoUnidad || pesoUnidad.lte(0));

  const convertirAKg = (valor: Decimal | null): Decimal | null => {
    if (!valor) return null;
    if (purchaseUnit === 'KG') return valor;
    if (!pesoUnidad || pesoUnidad.lte(0)) return null;
    return money(valor.div(pesoUnidad));
  };

  const costPerKg = convertirAKg(cost.unitCost);
  const previousCostPerKg = convertirAKg(cost.previousUnitCost);

  const marginFor = (specific: string | null): string =>
    specific ?? rule.targetMarginPct;
  const tier = (specific: string | null): Decimal | null =>
    costPerKg
      ? priceFromMargin(costPerKg, rule.marginBasis, marginFor(specific), rule.roundingRule)
      : null;
  const baseKg = tier(null);
  const wholeUnitTotal = soldByUnit && cost.unitCost
    ? priceFromMargin(
        cost.unitCost,
        rule.marginBasis,
        marginFor(rule.wholeUnitMarginPct),
        rule.roundingRule,
      )
    : costPerKg && pesoUnidad && pesoUnidad.gt(0)
      ? priceFromMargin(
          costPerKg.times(pesoUnidad),
          rule.marginBasis,
          marginFor(rule.wholeUnitMarginPct),
          rule.roundingRule,
        )
      : null;

  return {
    productId,
    productName: rule.product.normalizedName,
    saleMode: rule.saleMode,
    purchaseUnit,
    purchaseUnitWeightKg,
    soldByUnit,
    cost,
    costPerKg,
    previousCostPerKg,
    needsPurchaseUnitWeight,
    prices: costPerKg
      ? computeSalePrices(costPerKg, {
          marginBasis: rule.marginBasis,
          targetMarginPct: rule.targetMarginPct,
          cashDiscountPct: 0,
          roundingRule: rule.roundingRule,
          saleMode: rule.saleMode,
          pieceWeightKg: rule.pieceWeightKg,
        })
      : null,
    tiers: {
      baseKg,
      alCorteHormaDigitalKg: tier(rule.alCorteHormaDigitalMarginPct),
      alCorteHormaCashKg: tier(rule.alCorteHormaCashMarginPct),
      alCorteCajaCashKg: tier(rule.alCorteCajaCashMarginPct),
      feteado100gKg: tier(rule.feteado100gMarginPct),
      feteadoQuarterKg: tier(rule.feteadoQuarterMarginPct),
      feteadoPieceDigitalKg: tier(rule.feteadoPieceDigitalMarginPct),
      feteadoPieceCashKg: tier(rule.feteadoPieceCashMarginPct),
      wholeUnitTotal,
    },
    rule,
    approved: lastApproved
      ? {
          pricePerKg: lastApproved.approvedPricePerKg.toString(),
          validFrom: lastApproved.validFrom,
          approvedBy: lastApproved.approvedBy?.name ?? null,
        }
      : null,
  };
}

export interface ApprovePriceInput {
  productId: string;
  approvedPricePerKg: string;
  validFrom?: string | null;
}

/** Aprueba un precio de venta y lo guarda en el historial. */
export async function approveSalePrice(user: AuthUser, input: ApprovePriceInput) {
  if (!hasPermission(user, PERMISSIONS.PRECIOS_GESTIONAR)) {
    throw new ForbiddenError('Tu usuario no puede aprobar precios de venta.');
  }

  const suggestion = await suggestPricesFor(input.productId);
  if (!suggestion.cost.unitCost) {
    throw new ValidationError(
      'Todavía no hay ninguna compra de este producto, así que no hay costo sobre el cual fijar el precio.',
    );
  }
  if (!suggestion.costPerKg) {
    throw new ValidationError(
      'Este producto se compra por unidad y se vende por kilo. Indicá cuántos kilos trae cada unidad comprada antes de aprobar el precio.',
    );
  }

  const approved = money(input.approvedPricePerKg);
  if (approved.lte(0)) throw new ValidationError('El precio aprobado tiene que ser mayor a cero.');

  const validFrom = input.validFrom ? parseArDate(input.validFrom) : arToday();
  if (!validFrom) throw new ValidationError('La fecha de vigencia no es válida.');

  const rule = suggestion.rule;
  const pieceWeight = rule.pieceWeightKg ? toDecimal(rule.pieceWeightKg) : null;
  const cashDiscount = toDecimal(rule.cashDiscountPct);
  const perPieceDigital = pieceWeight ? money(approved.times(pieceWeight)) : null;

  const created = await prisma.salePriceHistory.create({
    data: {
      productId: input.productId,
      costBasis: suggestion.costPerKg.toString(),
      marginBasis: rule.marginBasis,
      marginPct: rule.targetMarginPct,
      suggestedPricePerKg: suggestion.prices!.pricePerKg.toString(),
      approvedPricePerKg: approved.toString(),
      pricePer100g: money(approved.div(10)).toString(),
      pricePerQuarter: money(approved.div(4)).toString(),
      pricePerPieceDigital: perPieceDigital?.toString() ?? null,
      pricePerPieceCash: perPieceDigital
        ? money(perPieceDigital.times(toDecimal(1).minus(cashDiscount))).toString()
        : null,
      pieceWeightKg: pieceWeight?.toString() ?? null,
      cashDiscountPct: cashDiscount.toString(),
      validFrom,
      approvedById: user.id,
    },
  });

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.PRICE_APPROVED,
    entity: 'Product',
    entityId: input.productId,
    after: {
      producto: suggestion.productName,
      costoPorKilo: suggestion.costPerKg.toString(),
      precioSugerido: suggestion.prices!.pricePerKg.toString(),
      precioAprobado: approved.toString(),
      vigenciaDesde: validFrom.toISOString().slice(0, 10),
    },
  });

  return created;
}

export interface PriceBoardRow {
  productId: string;
  internalCode: string;
  name: string;
  category: string | null;
  saleMode: SaleMode;
  purchaseUnit: 'KG' | 'UNIT';
  purchaseUnitWeightKg: string | null;
  soldByUnit: boolean;
  purchaseUnitCost: string | null;
  lastUnitCost: string | null;
  previousUnitCost: string | null;
  deltaAmount: string | null;
  deltaPct: string | null;
  lastCostDate: Date | null;
  supplierName: string | null;
  branchName: string | null;
  suggestedPricePerKg: string | null;
  pricePerKgCash: string | null;
  alCorteHormaDigitalKg: string | null;
  alCorteHormaCashKg: string | null;
  alCorteCajaCashKg: string | null;
  feteado100gKg: string | null;
  feteadoQuarterKg: string | null;
  feteadoPieceDigitalKg: string | null;
  feteadoPieceCashKg: string | null;
  wholeUnitTotal: string | null;
  approvedPricePerKg: string | null;
  targetMarginPct: string;
  marginBasis: MarginBasis;
  cashDiscountPct: string;
  alCorteHormaDigitalMarginPct: string | null;
  alCorteHormaCashMarginPct: string | null;
  alCorteCajaCashMarginPct: string | null;
  feteado100gMarginPct: string | null;
  feteadoQuarterMarginPct: string | null;
  feteadoPieceDigitalMarginPct: string | null;
  feteadoPieceCashMarginPct: string | null;
  wholeUnitMarginPct: string | null;
  usesPlu: boolean;
  barcode: string | null;
  roundingRule: RoundingRule;
  needsPurchaseUnitWeight: boolean;
  /** true si el último costo subió más que el umbral configurado. */
  alert: boolean;
}

/** Umbral de aumento a partir del cual se muestra una alerta. */
export const PRICE_ALERT_THRESHOLD = 0.1;

/**
 * Tablero de precios: último costo, costo anterior, variación y precios de
 * venta sugeridos para cada producto que ya tenga alguna compra.
 */
export async function getPriceBoard(user: AuthUser): Promise<PriceBoardRow[]> {
  if (!hasPermission(user, PERMISSIONS.PRECIOS_VER)) {
    throw new ForbiddenError('Tu usuario no puede consultar los precios.');
  }

  const products = await prisma.product.findMany({
    where: { active: true },
    orderBy: [{ category: 'asc' }, { normalizedName: 'asc' }],
  });

  const rows: PriceBoardRow[] = [];
  for (const product of products) {
    const suggestion = await suggestPricesFor(product.id);
    const { cost, prices } = suggestion;
    rows.push({
      productId: product.id,
      internalCode: product.internalCode,
      name: product.normalizedName,
      category: product.category,
      saleMode: product.saleMode as SaleMode,
      purchaseUnit: suggestion.purchaseUnit,
      purchaseUnitWeightKg: suggestion.purchaseUnitWeightKg,
      soldByUnit: suggestion.soldByUnit,
      purchaseUnitCost: cost.unitCost?.toFixed(2) ?? null,
      lastUnitCost: suggestion.costPerKg?.toFixed(2) ?? null,
      previousUnitCost: suggestion.previousCostPerKg?.toFixed(2) ?? null,
      deltaAmount:
        suggestion.costPerKg && suggestion.previousCostPerKg
          ? suggestion.costPerKg.minus(suggestion.previousCostPerKg).toFixed(2)
          : null,
      deltaPct: cost.deltaPct?.toString() ?? null,
      lastCostDate: cost.date,
      supplierName: cost.supplierName,
      branchName: cost.branchName,
      suggestedPricePerKg: suggestion.tiers.baseKg?.toFixed(2) ?? null,
      pricePerKgCash: null,
      alCorteHormaDigitalKg: suggestion.tiers.alCorteHormaDigitalKg?.toFixed(2) ?? null,
      alCorteHormaCashKg: suggestion.tiers.alCorteHormaCashKg?.toFixed(2) ?? null,
      alCorteCajaCashKg: suggestion.tiers.alCorteCajaCashKg?.toFixed(2) ?? null,
      feteado100gKg: suggestion.tiers.feteado100gKg?.toFixed(2) ?? null,
      feteadoQuarterKg: suggestion.tiers.feteadoQuarterKg?.toFixed(2) ?? null,
      feteadoPieceDigitalKg: suggestion.tiers.feteadoPieceDigitalKg?.toFixed(2) ?? null,
      feteadoPieceCashKg: suggestion.tiers.feteadoPieceCashKg?.toFixed(2) ?? null,
      wholeUnitTotal: suggestion.tiers.wholeUnitTotal?.toFixed(2) ?? null,
      approvedPricePerKg: suggestion.approved?.pricePerKg ?? null,
      targetMarginPct: suggestion.rule.targetMarginPct,
      marginBasis: suggestion.rule.marginBasis,
      cashDiscountPct: '0',
      alCorteHormaDigitalMarginPct: suggestion.rule.alCorteHormaDigitalMarginPct,
      alCorteHormaCashMarginPct: suggestion.rule.alCorteHormaCashMarginPct,
      alCorteCajaCashMarginPct: suggestion.rule.alCorteCajaCashMarginPct,
      feteado100gMarginPct: suggestion.rule.feteado100gMarginPct,
      feteadoQuarterMarginPct: suggestion.rule.feteadoQuarterMarginPct,
      feteadoPieceDigitalMarginPct: suggestion.rule.feteadoPieceDigitalMarginPct,
      feteadoPieceCashMarginPct: suggestion.rule.feteadoPieceCashMarginPct,
      wholeUnitMarginPct: suggestion.rule.wholeUnitMarginPct,
      usesPlu: product.usesPlu,
      barcode: product.barcode,
      roundingRule: suggestion.rule.roundingRule,
      needsPurchaseUnitWeight: suggestion.needsPurchaseUnitWeight,
      alert: cost.deltaPct ? cost.deltaPct.gte(PRICE_ALERT_THRESHOLD) : false,
    });
  }
  return rows;
}

export interface UpdatePriceConfigInput {
  productId: string;
  targetMarginPct: string;
  marginBasis: MarginBasis;
  cashDiscountPct?: string;
  alCorteHormaDigitalMarginPct?: string | null;
  alCorteHormaCashMarginPct?: string | null;
  alCorteCajaCashMarginPct?: string | null;
  feteado100gMarginPct?: string | null;
  feteadoQuarterMarginPct?: string | null;
  feteadoPieceDigitalMarginPct?: string | null;
  feteadoPieceCashMarginPct?: string | null;
  wholeUnitMarginPct?: string | null;
  roundingRule: RoundingRule;
  saleMode: SaleMode;
  purchaseUnit: 'KG' | 'UNIT';
  purchaseUnitWeightKg?: string | null;
}

/**
 * Ajustes operativos que la usuaria necesita tocar desde la propia pantalla de
 * Precios, sin ir a la ficha técnica del producto.
 */
export async function updateProductPriceConfig(user: AuthUser, input: UpdatePriceConfigInput) {
  if (!hasPermission(user, PERMISSIONS.PRECIOS_GESTIONAR)) {
    throw new ForbiddenError('Tu usuario no puede modificar la formación de precios.');
  }

  const product = await prisma.product.findUnique({ where: { id: input.productId } });
  if (!product) throw new NotFoundError('No encontramos ese producto.');

  const margin = toDecimal(input.targetMarginPct);
  const marginFraction = margin.gt(1) ? margin.div(100) : margin;
  if (marginFraction.isNegative() || marginFraction.gte(1)) {
    throw new ValidationError('El marcaje tiene que ser un porcentaje entre 0 y 100.');
  }

  if (!['SOBRE_COSTO', 'SOBRE_VENTA'].includes(input.marginBasis)) {
    throw new ValidationError('Elegí una base de marcaje válida.');
  }
  if (!['FETEABLE', 'AL_CORTE'].includes(input.saleMode)) {
    throw new ValidationError('Elegí si el producto es feteable o al corte.');
  }
  if (!['KG', 'UNIT'].includes(input.purchaseUnit)) {
    throw new ValidationError('Elegí una unidad de compra válida.');
  }
  if (!['NONE','NEAREST_10','NEAREST_50','NEAREST_100','UP_10','UP_50','UP_100'].includes(input.roundingRule)) {
    throw new ValidationError('Elegí una regla de redondeo válida.');
  }

  const normalizarMarcaje = (valor?: string | null): string | null => {
    const raw = (valor ?? '').trim();
    if (!raw) return null;
    const d = toDecimal(raw);
    const fraction = d.gt(1) ? d.div(100) : d;
    if (fraction.isNegative() || fraction.gte(1)) {
      throw new ValidationError('Cada marcaje tiene que estar entre 0 y menos de 100.');
    }
    return fraction.toString();
  };

  let purchaseUnitWeightKg: string | null = null;
  if (input.purchaseUnit === 'UNIT') {
    const raw = (input.purchaseUnitWeightKg ?? '').trim();
    if (raw) {
      const weight = toDecimal(raw);
      if (weight.lte(0)) {
        throw new ValidationError('Los kilos por unidad comprada tienen que ser mayores a cero.');
      }
      purchaseUnitWeightKg = weight.toString();
    }
  }

  const saved = await prisma.product.update({
    where: { id: input.productId },
    data: {
      targetMarginPct: marginFraction.toString(),
      marginBasis: input.marginBasis,
      cashDiscountPct: '0',
      alCorteHormaDigitalMarginPct: normalizarMarcaje(input.alCorteHormaDigitalMarginPct),
      alCorteHormaCashMarginPct: normalizarMarcaje(input.alCorteHormaCashMarginPct),
      alCorteCajaCashMarginPct: normalizarMarcaje(input.alCorteCajaCashMarginPct),
      feteado100gMarginPct: normalizarMarcaje(input.feteado100gMarginPct),
      feteadoQuarterMarginPct: normalizarMarcaje(input.feteadoQuarterMarginPct),
      feteadoPieceDigitalMarginPct: normalizarMarcaje(input.feteadoPieceDigitalMarginPct),
      feteadoPieceCashMarginPct: normalizarMarcaje(input.feteadoPieceCashMarginPct),
      wholeUnitMarginPct: normalizarMarcaje(input.wholeUnitMarginPct),
      roundingRule: input.roundingRule,
      saleMode: input.saleMode,
      purchaseUnit: input.purchaseUnit,
      purchaseUnitWeightKg,
    },
  });

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.PRODUCT_UPDATED,
    entity: 'Product',
    entityId: product.id,
    before: {
      marcaje: product.targetMarginPct.toString(),
      base: product.marginBasis,
      modoVenta: product.saleMode,
      unidadCompra: product.purchaseUnit,
      kgUnidadCompra: product.purchaseUnitWeightKg?.toString() ?? null,
    },
    after: {
      marcaje: saved.targetMarginPct.toString(),
      base: saved.marginBasis,
      modoVenta: saved.saleMode,
      unidadCompra: saved.purchaseUnit,
      kgUnidadCompra: saved.purchaseUnitWeightKg?.toString() ?? null,
    },
  });

  return saved;
}

/** Productos con aumento de precio en el período, para el tablero de inicio. */
export async function countPriceIncreases(user: AuthUser, since: Date): Promise<number> {
  const scope = branchScopeFilter(user);
  return prisma.costHistory.count({
    where: {
      date: { gte: since },
      deltaPct: { gte: PRICE_ALERT_THRESHOLD },
      ...(scope.branchId ? { branchId: scope.branchId } : {}),
    },
  });
}
