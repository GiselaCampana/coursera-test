import 'server-only';
import { prisma } from '@/lib/db';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { branchScopeFilter, hasPermission, type AuthUser } from '@/lib/auth/session';
import { Decimal, money, toDecimal } from '@/lib/money';
import { arToday, parseArDate } from '@/lib/datetime';
import {
  computeSalePrices,
  priceFromMargin,
  type MarginBasis,
  type RoundingRule,
  type SaleMode,
  type SalePrices,
} from '@/lib/domain/pricing';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/services/audit';
import {
  marcajesEfectivos,
  type FuenteDeMarcajes,
  type MarcajesEfectivos,
} from '@/lib/domain/marcajes';

/** Pasa un artículo o una familia al formato que entiende el resolvedor. */
function comoFuente(fila: {
  targetMarginPct?: { toString(): string } | null;
  marginBasis?: string | null;
  alCorteHormaDigitalMarginPct?: { toString(): string } | null;
  alCorteHormaCashMarginPct?: { toString(): string } | null;
  alCorteCajaCashMarginPct?: { toString(): string } | null;
  feteado100gMarginPct?: { toString(): string } | null;
  feteadoQuarterMarginPct?: { toString(): string } | null;
  feteadoPieceDigitalMarginPct?: { toString(): string } | null;
  feteadoPieceCashMarginPct?: { toString(): string } | null;
  wholeUnitMarginPct?: { toString(): string } | null;
}): FuenteDeMarcajes {
  return {
    targetMarginPct: fila.targetMarginPct?.toString() ?? null,
    marginBasis: (fila.marginBasis as MarginBasis | null) ?? null,
    alCorteHormaDigitalMarginPct: fila.alCorteHormaDigitalMarginPct?.toString() ?? null,
    alCorteHormaCashMarginPct: fila.alCorteHormaCashMarginPct?.toString() ?? null,
    alCorteCajaCashMarginPct: fila.alCorteCajaCashMarginPct?.toString() ?? null,
    feteado100gMarginPct: fila.feteado100gMarginPct?.toString() ?? null,
    feteadoQuarterMarginPct: fila.feteadoQuarterMarginPct?.toString() ?? null,
    feteadoPieceDigitalMarginPct: fila.feteadoPieceDigitalMarginPct?.toString() ?? null,
    feteadoPieceCashMarginPct: fila.feteadoPieceCashMarginPct?.toString() ?? null,
    wholeUnitMarginPct: fila.wholeUnitMarginPct?.toString() ?? null,
  };
}

export { comoFuente };

/**
 * Regla de precios aplicable a un producto: la propia del producto si existe y
 * está vigente, si no la global, y en última instancia lo configurado en la
 * ficha del producto.
 */
export async function resolvePricingRule(productId: string, at: Date = arToday()) {
  /*
   * El artículo viene con su familia: sin ella no se puede saber qué marcaje
   * rige, porque el que el artículo deja vacío lo pone la familia.
   */
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { family: true },
  });
  if (!product) throw new NotFoundError('No encontramos ese producto.');

  const marcajes = marcajesEfectivos(
    comoFuente(product),
    product.family ? comoFuente(product.family) : null,
  );

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

  /*
   * Los marcajes salen ya resueltos contra la familia.
   *
   * Los ocho específicos vienen con un número siempre: donde antes había un
   * null que cada consumidor interpretaba por su cuenta, ahora está el valor
   * que de verdad se va a aplicar. `marcajes` lleva además de dónde salió cada
   * uno, para que la pantalla lo pueda decir.
   */
  const especificos = marcajes.especificos;
  return {
    product,
    familia: product.family ? { id: product.family.id, nombre: product.family.name } : null,
    ruleId: effective?.id ?? null,
    ruleName: effective?.name ?? 'Configuración del producto',
    marginBasis: marcajes.marginBasis.valor,
    targetMarginPct: marcajes.base.valor,
    cashDiscountPct: product.cashDiscountPct.toString(),
    roundingRule: product.roundingRule as RoundingRule,
    saleMode: product.saleMode as SaleMode,
    pieceWeightKg: product.avgPieceWeightKg?.toString() ?? null,
    marcajes,
    alCorteHormaDigitalMarginPct: especificos.alCorteHormaDigital.valor,
    alCorteHormaCashMarginPct: especificos.alCorteHormaCash.valor,
    alCorteCajaCashMarginPct: especificos.alCorteCajaCash.valor,
    feteado100gMarginPct: especificos.feteado100g.valor,
    feteadoQuarterMarginPct: especificos.feteadoQuarter.valor,
    feteadoPieceDigitalMarginPct: especificos.feteadoPieceDigital.valor,
    feteadoPieceCashMarginPct: especificos.feteadoPieceCash.valor,
    wholeUnitMarginPct: especificos.wholeUnit.valor,
  };
}

export type { MarcajesEfectivos };

export interface ProductCostSnapshot {
  unitCost: Decimal | null;
  previousUnitCost: Decimal | null;
  deltaAmount: Decimal | null;
  deltaPct: Decimal | null;
  date: Date | null;
  supplierName: string | null;
  branchName: string | null;
  /**
   * De dónde sale el costo vigente: de una compra o del ajuste que le hizo una
   * nota de crédito.
   *
   * Sin esto, un costo bajado por una bonificación se ve igual que una baja de
   * precio del proveedor, y son dos cosas distintas: la primera no se va a
   * repetir el mes que viene.
   */
  origin: 'COMPRA' | 'AJUSTE_NC' | null;
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
      origin: null,
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
    origin: latest.kind as 'COMPRA' | 'AJUSTE_NC',
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

  // Reglas comerciales:
  // - al corte: sólo "por kilo" se redondea al $100;
  // - feteables: 100 g y 1/4 (ambos expresados por kg) se redondean al $100;
  // - horma, caja y pieza quedan exactamente como da su marcaje, sin redondeo.
  const tierExacto = (specific: string | null): Decimal | null =>
    costPerKg
      ? priceFromMargin(costPerKg, rule.marginBasis, marginFor(specific), 'NONE')
      : null;
  const tierRedondeado100 = (specific: string | null): Decimal | null =>
    costPerKg
      ? priceFromMargin(costPerKg, rule.marginBasis, marginFor(specific), 'NEAREST_100')
      : null;

  const baseKg =
    rule.saleMode === 'AL_CORTE'
      ? tierRedondeado100(null)
      : tierExacto(null);
  const wholeUnitTotal = soldByUnit && cost.unitCost
    ? priceFromMargin(
        cost.unitCost,
        rule.marginBasis,
        marginFor(rule.wholeUnitMarginPct),
        'NONE',
      )
    : costPerKg && pesoUnidad && pesoUnidad.gt(0)
      ? priceFromMargin(
          costPerKg.times(pesoUnidad),
          rule.marginBasis,
          marginFor(rule.wholeUnitMarginPct),
          'NONE',
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
      alCorteHormaDigitalKg: tierExacto(rule.alCorteHormaDigitalMarginPct),
      alCorteHormaCashKg: tierExacto(rule.alCorteHormaCashMarginPct),
      alCorteCajaCashKg: tierExacto(rule.alCorteCajaCashMarginPct),
      feteado100gKg: tierRedondeado100(rule.feteado100gMarginPct),
      feteadoQuarterKg: tierRedondeado100(rule.feteadoQuarterMarginPct),
      feteadoPieceDigitalKg: tierExacto(rule.feteadoPieceDigitalMarginPct),
      feteadoPieceCashKg: tierExacto(rule.feteadoPieceCashMarginPct),
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
  /**
   * Los marcajes **del artículo**, tal como están guardados: null donde no
   * define nada y hereda.
   *
   * Van aparte de los efectivos porque el formulario tiene que editar éstos.
   * Si editara los efectivos, dejar el campo como venía guardaría el valor
   * heredado dentro del artículo y la herencia se perdería sin que nadie lo
   * haya pedido: el artículo dejaría de seguir a su familia por el solo hecho
   * de que alguien abrió la pantalla y apretó guardar.
   */
  marcajesPropios: FuenteDeMarcajes;
  /** De dónde sale cada marcaje efectivo, para poder decirlo en pantalla. */
  marcajes: MarcajesEfectivos;
  familia: { id: string; nombre: string } | null;
  productId: string;
  internalCode: string;
  name: string;
  category: string | null;
  subtype: string | null;
  saleMode: SaleMode;
  purchaseUnit: 'KG' | 'UNIT';
  purchaseUnitWeightKg: string | null;
  soldByUnit: boolean;
  purchaseUnitCost: string | null;
  lastUnitCost: string | null;
  previousUnitCost: string | null;
  deltaAmount: string | null;
  deltaPct: string | null;
  /** 'AJUSTE_NC' cuando el costo vigente lo dejó una nota de crédito. */
  costOrigin: 'COMPRA' | 'AJUSTE_NC' | null;
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
      subtype: product.subtype,
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
      costOrigin: cost.origin,
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
      marcajesPropios: comoFuente(product),
      marcajes: suggestion.rule.marcajes,
      familia: suggestion.rule.familia,
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

  /*
   * El marcaje base también puede quedar vacío, y vacío quiere decir heredar.
   *
   * Antes era obligatorio, y por eso el formulario venía con el valor ya
   * escrito: dejarlo como estaba grababa ese número en el artículo. Ahora
   * vacío se guarda como vacío, y el artículo sigue lo que diga su familia.
   */
  const baseCargado = (input.targetMarginPct ?? '').trim();
  let marginFraction: Decimal | null = null;
  if (baseCargado !== '') {
    const margin = toDecimal(baseCargado);
    marginFraction = margin.gt(1) ? margin.div(100) : margin;
    if (marginFraction.isNegative() || marginFraction.gte(1)) {
      throw new ValidationError('El marcaje tiene que ser un porcentaje entre 0 y 100.');
    }
  }

  if (input.marginBasis && !['SOBRE_COSTO', 'SOBRE_VENTA'].includes(input.marginBasis)) {
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
      targetMarginPct: marginFraction ? marginFraction.toString() : null,
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
      roundingRule: 'NEAREST_100',
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
      // Null quiere decir "hereda de la familia", y en la auditoría se dice
      // así: un guion no distinguiría entre heredado y sin cargar.
      marcaje: product.targetMarginPct?.toString() ?? 'heredado de la familia',
      base: product.marginBasis ?? 'heredado de la familia',
      modoVenta: product.saleMode,
      unidadCompra: product.purchaseUnit,
      kgUnidadCompra: product.purchaseUnitWeightKg?.toString() ?? null,
    },
    after: {
      marcaje: saved.targetMarginPct?.toString() ?? 'heredado de la familia',
      base: saved.marginBasis ?? 'heredado de la familia',
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
