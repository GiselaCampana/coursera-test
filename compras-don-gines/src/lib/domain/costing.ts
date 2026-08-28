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
  /** Suma de todas las percepciones que le tocaron al artículo. */
  perceptionAmount: Decimal;
  /**
   * Esa misma suma, abierta por percepción impresa.
   *
   * Es lo que permite explicar el costo de un artículo renglón por renglón:
   * neto + IVA + percepción de IVA + percepción de IIBB. Cuando el comprobante
   * no discrimina las percepciones queda una sola entrada con el total.
   */
  perceptionBreakdown: PerceptionShare[];
  /**
   * El neto con el que se armó el costo final del renglón.
   *
   * Casi siempre es el mismo `netAmount`. Se separa porque el pie impreso manda:
   * cuando la suma de los renglones queda a unos centavos del neto impreso —el
   * proveedor redondea cada renglón por su cuenta, y el OCR puede perder un
   * centavo suelto— el costo final se arma repartiendo el neto **impreso**, para
   * que la suma de los costos de los 23 renglones caiga exactamente en el total
   * del papel y no un centavo más abajo.
   *
   * `netAmount` no se toca: sigue siendo lo que dice el renglón, que es contra
   * lo que se controla. La diferencia entre los dos queda a la vista en el
   * resumen en vez de esconderse dentro de los importes.
   */
  netCostBase: Decimal;
  totalCost: Decimal;
  unitCost: Decimal;
}

/**
 * Hasta cuánto puede apartarse la suma de los renglones del neto impreso para
 * seguir tratándose como redondeo.
 *
 * Es el mismo peso que usa la conciliación de centavos. Más que eso ya no es
 * redondeo: es un renglón mal leído o faltante, los autocontroles lo marcan y
 * el costo se arma con lo que efectivamente dicen los renglones, sin estirarlo
 * hasta un total que no le corresponde.
 */
const MARGEN_DE_REDONDEO = new Decimal('1');

/** Una percepción tal como la imprime el comprobante. */
export interface PerceptionLine {
  label: string;
  amount: MoneyInput;
}

export interface DocumentTotals {
  /** Neto después de descuentos (base imponible impresa). */
  netTotal: MoneyInput;
  ivaTotal: MoneyInput;
  perceptionsTotal: MoneyInput;
  /**
   * Las percepciones discriminadas, cuando el comprobante las imprime por
   * separado —"Percepción IVA RG 5329" y "Percepción IIBB Buenos Aires"—.
   *
   * Cada una se prorratea por su cuenta contra su propio importe impreso, así
   * que la suma de lo repartido da exactamente lo que dice el papel para cada
   * una, y no sólo para el conjunto. Sin esto no se puede decir cuánta
   * percepción de IVA le tocó a un artículo, que es lo que hace falta para
   * explicar su costo.
   */
  perceptionLines?: PerceptionLine[] | null;
}

/** Lo que le tocó a un artículo de cada percepción impresa. */
export interface PerceptionShare {
  label: string;
  amount: Decimal;
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
 * Las percepciones discriminadas, pero sólo si siguen cuadrando con el total.
 *
 * El detalle de las percepciones se lee una vez y queda guardado, mientras que
 * el total de percepciones es un campo editable de la pantalla de revisión. Si
 * alguien lo corrige a mano, el detalle viejo deja de sumar ese total y usarlo
 * mostraría un desglose que contradice el número de arriba.
 *
 * Con esta comprobación, las tres partes del sistema que costean —la lectura,
 * la pantalla y el guardado— deciden lo mismo con la misma regla, y un
 * comprobante cuesta igual mirado desde donde se lo mire. Repartir por separado
 * o repartir el total junto da los mismos totales pero puede mover un centavo
 * de un artículo a otro, así que no da lo mismo quién lo haga.
 */
export function consistentPerceptionLines(
  lines: PerceptionLine[] | null | undefined,
  aggregate: MoneyInput,
): PerceptionLine[] | undefined {
  if (!lines || lines.length === 0) return undefined;
  const total = money(aggregate);
  const suma = lines.reduce<Decimal>((acc, l) => acc.plus(money(l.amount)), ZERO);
  return suma.minus(total).abs().lte('0.01') ? lines : undefined;
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

  /*
   * IVA por artículo.
   *
   * En comprobantes fotografiados el OCR puede perder el "21%" de algún
   * renglón y dejar tasa 0. Eso NO significa que el artículo sea exento. Si el
   * pie del comprobante demuestra una tasa uniforme —por ejemplo IVA total /
   * neto total = 21 %— y las tasas no nulas que sí se leyeron coinciden con
   * ese 21 %, se prorratea el IVA entre todos los renglones por neto.
   *
   * Antes, un renglón con tasa perdida hacía que los que sí tenían 21 %
   * absorbieran el IVA de los demás. Eso inflaba el IVA individual aunque el
   * total de la factura cerrara.
   */
  const rates = resolved.map((r) => toDecimal(r.raw.ivaRate));
  const distinctRates = new Set(rates.map((r) => r.toString()));
  const positiveRates = rates.filter((r) => r.gt(0));
  const distinctPositiveRates = new Set(positiveRates.map((r) => r.toString()));
  const netTotalForTax = money(totals.netTotal);
  const impliedFooterRate =
    netTotalForTax.gt(0) && ivaTotal.gt(0) ? ivaTotal.div(netTotalForTax) : ZERO;

  const oneKnownPositiveRate =
    distinctPositiveRates.size === 1 ? toDecimal([...distinctPositiveRates][0]!) : null;
  const footerMatchesKnownRate =
    oneKnownPositiveRate !== null &&
    impliedFooterRate.minus(oneKnownPositiveRate).abs().lte('0.001');

  const inferUniformRate =
    distinctRates.size <= 1 ||
    footerMatchesKnownRate ||
    (distinctPositiveRates.size === 0 && impliedFooterRate.gt(0));

  const effectiveRates =
    inferUniformRate && impliedFooterRate.gt(0)
      ? rates.map((r) => (r.gt(0) ? r : oneKnownPositiveRate ?? impliedFooterRate))
      : rates;

  let ivaParts: Decimal[];
  if (inferUniformRate) {
    ivaParts = prorate(nets, ivaTotal);
  } else {
    // Hay evidencia real de más de una tasa: ahí sí se reparte por grupos.
    ivaParts = prorateByRateGroups(nets, rates, ivaTotal);
  }

  /*
   * Las percepciones se reparten sobre el neto, cada una por separado.
   *
   * Prorratear el conjunto y después abrirlo por porcentaje volvería a
   * introducir el redondeo que se quiere evitar. Repartiendo cada percepción
   * contra su propio importe impreso, la suma de lo que se le asignó a cada
   * artículo da exactamente el número del papel para *esa* percepción, y la
   * suma de todas da el total. El residuo de redondeo lo absorbe el último
   * artículo, que es determinístico: dos corridas con los mismos datos reparten
   * igual.
   */
  const lineasDePercepcion =
    totals.perceptionLines && totals.perceptionLines.length > 0
      ? totals.perceptionLines
      : [{ label: 'Percepciones', amount: perceptionsTotal }];

  const repartoPorPercepcion = lineasDePercepcion.map((linea) => ({
    label: linea.label,
    partes: prorate(nets, linea.amount),
  }));

  const perceptionParts = resolved.map((_, i) =>
    money(repartoPorPercepcion.reduce((suma, p) => suma.plus(p.partes[i]), ZERO)),
  );

  /*
   * El neto con el que se arma el costo final.
   *
   * El pie impreso es la fuente de verdad: el IVA y las percepciones ya se
   * reparten contra sus importes del papel, así que el neto se reparte igual y
   * el costo total cae exactamente en el total impreso. Sólo se hace cuando la
   * diferencia contra la suma de los renglones es de redondeo (menos de un
   * peso); si es más, no se estira nada y el costo queda armado con lo que
   * dicen los renglones, para que la diferencia se vea.
   */
  const netTotal = money(totals.netTotal);
  const netoDelDetalle = nets.reduce<Decimal>((acc, n) => acc.plus(n), ZERO);
  const esRedondeo =
    !netTotal.isZero() && netTotal.minus(netoDelDetalle).abs().lt(MARGEN_DE_REDONDEO);
  const netBases = esRedondeo ? prorate(nets, netTotal) : nets;

  return resolved.map((r, i) => {
    const ivaAmount = ivaParts[i];
    const perceptionAmount = perceptionParts[i];
    const netCostBase = netBases[i];
    const totalCost = money(netCostBase.plus(ivaAmount).plus(perceptionAmount));
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
      ivaRate: effectiveRates[i],
      ivaAmount,
      perceptionAmount,
      perceptionBreakdown: repartoPorPercepcion.map((p) => ({
        label: p.label,
        amount: p.partes[i],
      })),
      netCostBase,
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

  /*
   * Las percepciones, sumadas por etiqueta y en el orden en que las imprime el
   * comprobante. Con esto el resumen puede mostrar "Percepción IVA RG 5329" y
   * "Percepción IIBB Buenos Aires" por separado, que es como están en el papel,
   * en vez de un único "Percepciones" que no se puede contrastar con nada.
   */
  const percepciones = new Map<string, Decimal>();
  for (const item of items) {
    for (const parte of item.perceptionBreakdown) {
      percepciones.set(parte.label, (percepciones.get(parte.label) ?? ZERO).plus(parte.amount));
    }
  }

  return {
    perceptionsByLabel: [...percepciones].map(([label, amount]) => ({
      label,
      amount: money(amount),
    })),
    /** Cuántos artículos se venden por kilo y cuántos por unidad. */
    kgItemCount: items.filter((i) => i.unit === 'KG').length,
    unitItemCount: items.filter((i) => i.unit === 'UNIT').length,
    count: items.length,
    grossSubtotal: money(add((i) => i.grossSubtotal)),
    discountAmount: money(add((i) => i.discountAmount)),
    netAmount: money(add((i) => i.netAmount)),
    ivaAmount: money(add((i) => i.ivaAmount)),
    perceptionAmount: money(add((i) => i.perceptionAmount)),
    /**
     * Los centavos que separan la suma de los renglones del neto impreso con el
     * que se armó el costo final. Casi siempre cero; cuando no lo es se muestra
     * como un renglón propio, así el resumen suma sin trampas.
     */
    netRounding: money(add((i) => i.netCostBase).minus(add((i) => i.netAmount))),
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
