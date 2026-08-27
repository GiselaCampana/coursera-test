import { Decimal, ONE, ZERO, money, toDecimal, type MoneyInput } from '@/lib/money';

export type MarginBasis = 'SOBRE_COSTO' | 'SOBRE_VENTA';
export type SaleMode = 'FETEABLE' | 'AL_CORTE';
export type RoundingRule =
  | 'NONE'
  | 'NEAREST_10'
  | 'NEAREST_50'
  | 'NEAREST_100'
  | 'UP_10'
  | 'UP_50'
  | 'UP_100';

export const ROUNDING_RULES: RoundingRule[] = [
  'NONE',
  'NEAREST_10',
  'NEAREST_50',
  'NEAREST_100',
  'UP_10',
  'UP_50',
  'UP_100',
];

export const ROUNDING_RULE_LABEL: Record<RoundingRule, string> = {
  NONE: 'Sin redondeo',
  NEAREST_10: 'Al $10 más cercano',
  NEAREST_50: 'Al $50 más cercano',
  NEAREST_100: 'Al $100 más cercano',
  UP_10: 'Hacia arriba al $10',
  UP_50: 'Hacia arriba al $50',
  UP_100: 'Hacia arriba al $100',
};

export const MARGIN_BASIS_LABEL: Record<MarginBasis, string> = {
  SOBRE_COSTO: 'Margen sobre el costo',
  SOBRE_VENTA: 'Margen sobre el precio de venta',
};

export const SALE_MODE_LABEL: Record<SaleMode, string> = {
  FETEABLE: 'Feteable',
  AL_CORTE: 'Al corte',
};

export function applyRounding(value: MoneyInput, rule: RoundingRule): Decimal {
  const v = toDecimal(value);
  const step = (r: RoundingRule): number =>
    r.endsWith('10') ? 10 : r.endsWith('50') ? 50 : 100;
  switch (rule) {
    case 'NONE':
      return money(v);
    case 'NEAREST_10':
    case 'NEAREST_50':
    case 'NEAREST_100': {
      const s = new Decimal(step(rule));
      return money(v.div(s).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).times(s));
    }
    case 'UP_10':
    case 'UP_50':
    case 'UP_100': {
      const s = new Decimal(step(rule));
      return money(v.div(s).toDecimalPlaces(0, Decimal.ROUND_CEIL).times(s));
    }
  }
}

export interface PricingConfig {
  marginBasis: MarginBasis;
  /** Fracción: 0,45 = 45 %. */
  targetMarginPct: MoneyInput;
  /** Fracción: 0,10 = 10 % de descuento por pago en efectivo. */
  cashDiscountPct?: MoneyInput;
  roundingRule?: RoundingRule;
  saleMode?: SaleMode;
  /** Peso de la pieza (feteable) o de la horma (al corte), en kg. */
  pieceWeightKg?: MoneyInput | null;
}

export interface SalePrices {
  /** Costo unitario final que se usó de base (incluye IVA y percepciones). */
  costBasis: Decimal;
  /** Precio por kilo antes de redondear. */
  suggestedPricePerKg: Decimal;
  /** Precio por kilo ya redondeado: es el que se muestra y se aprueba. */
  pricePerKg: Decimal;
  /** Precio por kilo abonando en efectivo, después del descuento configurado. */
  pricePerKgCash: Decimal;
  pricePer100g: Decimal;
  pricePerQuarter: Decimal;
  pricePerPieceDigital: Decimal | null;
  pricePerPieceCash: Decimal | null;
  pieceWeightKg: Decimal | null;
  marginBasis: MarginBasis;
  marginPct: Decimal;
  cashDiscountPct: Decimal;
  roundingRule: RoundingRule;
  saleMode: SaleMode;
}

/**
 * Precio de venta a partir del costo unitario **final**, es decir el que ya
 * tiene el IVA y las percepciones distribuidos. Partir del precio de lista del
 * proveedor daría un margen menor al buscado.
 *
 *  - Margen sobre el costo:  precio = costo × (1 + margen)
 *  - Margen sobre la venta:  precio = costo / (1 − margen)
 *
 * Los precios derivados (100 g, 1/4 kg, pieza) salen del precio por kilo ya
 * redondeado, para que la góndola y la balanza no muestren números que no
 * cierran entre sí.
 */
export function computeSalePrices(unitCost: MoneyInput, config: PricingConfig): SalePrices {
  const costBasis = money(unitCost);
  const marginPct = toDecimal(config.targetMarginPct);
  const cashDiscountPct = toDecimal(config.cashDiscountPct ?? 0);
  const roundingRule = config.roundingRule ?? 'NEAREST_100';
  const saleMode = config.saleMode ?? 'FETEABLE';

  let raw: Decimal;
  if (config.marginBasis === 'SOBRE_VENTA') {
    if (marginPct.gte(1)) {
      throw new Error(
        'El margen sobre el precio de venta tiene que ser menor al 100 %: con 100 % o más el precio se vuelve infinito.',
      );
    }
    raw = costBasis.div(ONE.minus(marginPct));
  } else {
    raw = costBasis.times(ONE.plus(marginPct));
  }

  const suggestedPricePerKg = money(raw);
  const pricePerKg = applyRounding(suggestedPricePerKg, roundingRule);

  const pieceWeightKg =
    config.pieceWeightKg === null || config.pieceWeightKg === undefined
      ? null
      : toDecimal(config.pieceWeightKg);

  const pricePerKgCash = applyRounding(
    pricePerKg.times(ONE.minus(cashDiscountPct)),
    roundingRule,
  );

  const perPieceDigital =
    pieceWeightKg && pieceWeightKg.gt(0)
      ? applyRounding(pricePerKg.times(pieceWeightKg), roundingRule)
      : null;
  const perPieceCash = perPieceDigital
    ? applyRounding(perPieceDigital.times(ONE.minus(cashDiscountPct)), roundingRule)
    : null;

  return {
    costBasis,
    suggestedPricePerKg,
    pricePerKg,
    pricePerKgCash,
    pricePer100g: money(pricePerKg.div(10)),
    pricePerQuarter: money(pricePerKg.div(4)),
    pricePerPieceDigital: perPieceDigital,
    pricePerPieceCash: perPieceCash,
    pieceWeightKg,
    marginBasis: config.marginBasis,
    marginPct,
    cashDiscountPct,
    roundingRule,
    saleMode,
  };
}

/** Margen realmente obtenido con un precio dado, en las dos bases. */
export function effectiveMargin(unitCost: MoneyInput, price: MoneyInput) {
  const cost = toDecimal(unitCost);
  const p = toDecimal(price);
  if (cost.lte(0) || p.lte(0)) {
    return { sobreCosto: ZERO, sobreVenta: ZERO };
  }
  return {
    sobreCosto: p.minus(cost).div(cost),
    sobreVenta: p.minus(cost).div(p),
  };
}
