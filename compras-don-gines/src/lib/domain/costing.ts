import { Decimal, ZERO, money, toDecimal, type MoneyInput } from '@/lib/money';

export type Unit = 'KG' | 'UNIT';

/** Artículo tal como lo entrega el lector, antes de calcular. */
export interface RawItem {
  lineNumber: number;
  supplierCode?: string | null;
  description: string;
  quantity: MoneyInput;
  unit?: Unit;
  pieceCount?: number | null;
  totalWeightKg?: MoneyInput;
  unitNetPrice: MoneyInput;
  /** Si el comprobante lo imprime se respeta; si no, se calcula. */
  grossSubtotal?: MoneyInput;
  /** Fracción (0,14 = 14 %). */
  discountPct?: MoneyInput;
  discountAmount?: MoneyInput;
  netAmount?: MoneyInput;
  ivaRate?: MoneyInput;
}

/** Artículo con todos los importes resueltos. */
export interface CostedItem {
  lineNumber: number;
  supplierCode: string | null;
  description: string;
  quantity: Decimal;
  unit: Unit;
  pieceCount: number | null;
  totalWeightKg: Decimal | null;
  avgPieceWeightKg: Decimal | null;
  unitNetPrice: Decimal;
  grossSubtotal: Decimal;
  /**
   * true cuando el importe del renglón salió impreso del comprobante, false
   * cuando hubo que calcularlo como cantidad × precio.
   *
   * Importa para el control: un importe calculado coincide con cantidad ×
   * precio por construcción, así que no sirve para verificar nada. Saber de
   * dónde vino evita dar por controlado un renglón que en realidad no se pudo
   * contrastar contra el papel.
   */
  grossFromPrint: boolean;
  discountPct: Decimal;
  discountAmount: Decimal;
  netAmount: Decimal;
  ivaRate: Decimal;
  ivaAmount: Decimal;
  perceptionAmount: Decimal;
  totalCost: Decimal;
  unitCost: Decimal;
}

export interface DocumentTotals {
  /** Neto después de descuentos (base imponible impresa). */
  netTotal: MoneyInput;
  ivaTotal: MoneyInput;
  perceptionsTotal: MoneyInput;
}

/**
 * Reparte `total` entre `weights` de forma proporcional, redondeando cada parte
 * a 2 decimales y volcando el residuo de redondeo en el último elemento, para
 * que la suma dé exactamente `total`.
 */
export function prorate(weights: Decimal[], total: MoneyInput): Decimal[] {
  const amount = money(total);
  const n = weights.length;
  if (n === 0) return [];
  if (amount.isZero()) return weights.map(() => ZERO);

  const sum = weights.reduce<Decimal>((acc, w) => acc.plus(w), ZERO);
  if (sum.isZero()) {
    // Sin base para prorratear: todo al último, así la suma sigue cerrando.
    const parts = weights.map(() => ZERO);
    parts[n - 1] = amount;
    return parts;
  }

  const parts: Decimal[] = [];
  let accumulated = ZERO;
  for (let i = 0; i < n - 1; i++) {
    const part = money(amount.times(weights[i]).div(sum));
    parts.push(part);
    accumulated = accumulated.plus(part);
  }
  // El último absorbe la diferencia de redondeo.
  parts.push(money(amount.minus(accumulated)));
  return parts;
}

/**
 * Resuelve los importes propios de un artículo:
 *   subtotal bruto = cantidad × precio unitario neto
 *   neto          = subtotal bruto − descuento
 * Respeta los valores impresos cuando existen y sólo completa lo que falta.
 */
export function resolveItemAmounts(raw: RawItem): {
  quantity: Decimal;
  unitNetPrice: Decimal;
  grossSubtotal: Decimal;
  grossFromPrint: boolean;
  discountPct: Decimal;
  discountAmount: Decimal;
  netAmount: Decimal;
} {
  const quantity = toDecimal(raw.quantity);
  const unitNetPrice = toDecimal(raw.unitNetPrice);

  const computedGross = money(quantity.times(unitNetPrice));
  const grossFromPrint = raw.grossSubtotal !== undefined && raw.grossSubtotal !== null;
  const grossSubtotal = grossFromPrint ? money(raw.grossSubtotal) : computedGross;

  let discountPct = toDecimal(raw.discountPct);
  let discountAmount: Decimal;

  if (raw.discountAmount !== undefined && raw.discountAmount !== null) {
    discountAmount = money(raw.discountAmount);
    if (discountPct.isZero() && grossSubtotal.gt(0)) {
      discountPct = discountAmount.div(grossSubtotal);
    }
  } else {
    discountAmount = money(grossSubtotal.times(discountPct));
  }

  const netAmount =
    raw.netAmount === undefined || raw.netAmount === null
      ? money(grossSubtotal.minus(discountAmount))
      : money(raw.netAmount);

  return { quantity, unitNetPrice, grossSubtotal, grossFromPrint, discountPct, discountAmount, netAmount };
}

/**
 * Calcula IVA y percepciones proporcionales por artículo y el costo unitario
 * final (neto + IVA + percepciones distribuidos).
 *
 * Cuando el comprobante tiene una sola tasa de IVA se aplica la fórmula del
 * spec tal cual: IVA del artículo = IVA total × neto del artículo / neto total.
 * Si hay varias tasas se prorratea dentro de cada grupo de tasa, que es lo
 * mismo cuando la tasa es única y lo correcto cuando no lo es.
 */
export function costItems(items: RawItem[], totals: DocumentTotals): CostedItem[] {
  const resolved = items.map((raw) => ({ raw, ...resolveItemAmounts(raw) }));
  const nets = resolved.map((r) => r.netAmount);

  const ivaTotal = money(totals.ivaTotal);
  const perceptionsTotal = money(totals.perceptionsTotal);

  // ¿Una sola tasa o varias?
  const rates = resolved.map((r) => toDecimal(r.raw.ivaRate));
  const distinctRates = new Set(rates.map((r) => r.toString()));
  const singleRate = distinctRates.size <= 1;

  let ivaParts: Decimal[];
  if (singleRate) {
    ivaParts = prorate(nets, ivaTotal);
  } else {
    // Prorrateo por grupo de tasa. El IVA de cada grupo se estima con su tasa
    // y luego se ajusta para que la suma total coincida exactamente.
    ivaParts = prorateByRateGroups(nets, rates, ivaTotal);
  }

  // Las percepciones (IIBB y otras) se calculan sobre el neto, sin distinguir
  // tasa de IVA.
  const perceptionParts = prorate(nets, perceptionsTotal);

  return resolved.map((r, i) => {
    const ivaAmount = ivaParts[i];
    const perceptionAmount = perceptionParts[i];
    const totalCost = money(r.netAmount.plus(ivaAmount).plus(perceptionAmount));
    const quantity = r.quantity;
    const unitCost = quantity.isZero() ? ZERO : money(totalCost.div(quantity));

    const unit: Unit = r.raw.unit ?? 'KG';
    const totalWeightKg =
      r.raw.totalWeightKg !== undefined && r.raw.totalWeightKg !== null
        ? toDecimal(r.raw.totalWeightKg)
        : unit === 'KG'
          ? quantity
          : null;
    const pieceCount = r.raw.pieceCount ?? null;
    const avgPieceWeightKg =
      totalWeightKg && pieceCount && pieceCount > 0
        ? totalWeightKg.div(pieceCount).toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
        : null;

    return {
      lineNumber: r.raw.lineNumber,
      supplierCode: r.raw.supplierCode ?? null,
      description: r.raw.description,
      quantity,
      unit,
      pieceCount,
      totalWeightKg,
      avgPieceWeightKg,
      unitNetPrice: r.unitNetPrice,
      grossSubtotal: r.grossSubtotal,
      grossFromPrint: r.grossFromPrint,
      discountPct: r.discountPct,
      discountAmount: r.discountAmount,
      netAmount: r.netAmount,
      ivaRate: rates[i],
      ivaAmount,
      perceptionAmount,
      totalCost,
      unitCost,
    };
  });
}

function prorateByRateGroups(nets: Decimal[], rates: Decimal[], ivaTotal: Decimal): Decimal[] {
  const groups = new Map<string, number[]>();
  rates.forEach((rate, i) => {
    const key = rate.toString();
    const bucket = groups.get(key);
    if (bucket) bucket.push(i);
    else groups.set(key, [i]);
  });

  // Peso de cada grupo = neto del grupo × su tasa.
  const groupKeys = [...groups.keys()];
  const groupWeights = groupKeys.map((key) => {
    const idx = groups.get(key)!;
    const net = idx.reduce<Decimal>((acc, i) => acc.plus(nets[i]), ZERO);
    return net.times(new Decimal(key));
  });
  const groupTotals = prorate(groupWeights, ivaTotal);

  const result: Decimal[] = new Array(nets.length).fill(ZERO);
  groupKeys.forEach((key, g) => {
    const idx = groups.get(key)!;
    const parts = prorate(
      idx.map((i) => nets[i]),
      groupTotals[g],
    );
    idx.forEach((i, k) => {
      result[i] = parts[k];
    });
  });
  return result;
}

/** Sumas de control de un conjunto de artículos calculados. */
export function summarizeItems(items: CostedItem[]) {
  const add = (pick: (i: CostedItem) => Decimal) =>
    items.reduce<Decimal>((acc, i) => acc.plus(pick(i)), ZERO);

  return {
    count: items.length,
    grossSubtotal: money(add((i) => i.grossSubtotal)),
    discountAmount: money(add((i) => i.discountAmount)),
    netAmount: money(add((i) => i.netAmount)),
    ivaAmount: money(add((i) => i.ivaAmount)),
    perceptionAmount: money(add((i) => i.perceptionAmount)),
    totalCost: money(add((i) => i.totalCost)),
    totalQuantityKg: items
      .filter((i) => i.unit === 'KG')
      .reduce<Decimal>((acc, i) => acc.plus(i.quantity), ZERO),
    totalUnits: items
      .filter((i) => i.unit === 'UNIT')
      .reduce<Decimal>((acc, i) => acc.plus(i.quantity), ZERO),
    totalPieces: items.reduce<number>((acc, i) => acc + (i.pieceCount ?? 0), 0),
  };
}
