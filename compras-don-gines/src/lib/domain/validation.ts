import {
  Decimal,
  ZERO,
  formatARS,
  formatQty,
  money,
  roundingTolerance,
  toDecimal,
  type MoneyInput,
} from '@/lib/money';
import { summarizeItems, type CostedItem } from '@/lib/domain/costing';

export type CheckSeverity = 'OK' | 'WARN' | 'ERROR';
export type CheckState = 'OK' | 'RECONCILIADO' | 'DIFERENCIA' | 'PENDIENTE';

export interface CheckResult {
  code: string;
  label: string;
  severity: CheckSeverity;
  message: string;
  expected?: string;
  actual?: string;
  difference?: string;
  /** El comprobante no imprime el dato: el control no se pudo hacer. */
  skipped?: boolean;
}

export interface PrintedSummary {
  grossSubtotal?: MoneyInput;
  discountTotal?: MoneyInput;
  netTotal?: MoneyInput;
  ivaTotal?: MoneyInput;
  perceptionsTotal?: MoneyInput;
  total?: MoneyInput;
  lineCount?: number | null;
  netWeightKg?: MoneyInput;
  totalUnits?: MoneyInput;
}

export interface SupplierTaxExpectation {
  ivaRate?: MoneyInput;
  iibbRate?: MoneyInput;
}

export interface ValidationInput {
  items: CostedItem[];
  printed: PrintedSummary;
  supplierRules?: SupplierTaxExpectation;
  /** Cantidad de lecturas que hizo falta. >1 y sin errores => amarillo. */
  attempts?: number;
}

export interface ValidationReport {
  state: CheckState;
  /** Sólo se puede guardar como controlado si esto es true. */
  canSave: boolean;
  checks: CheckResult[];
  computed: {
    itemCount: number;
    grossSubtotal: string;
    discountAmount: string;
    netAmount: string;
    ivaAmount: string;
    perceptionAmount: string;
    totalCost: string;
    totalQuantityKg: string;
    totalUnits: string;
  };
  errorCount: number;
  warningCount: number;
}

const present = (v: MoneyInput): boolean =>
  v !== null && v !== undefined && !(typeof v === 'string' && v.trim() === '');

function compare(opts: {
  code: string;
  label: string;
  expected: Decimal;
  actual: Decimal;
  tolerance: Decimal;
  format: (d: Decimal) => string;
  okMessage: string;
  failMessage: (diff: Decimal) => string;
  severityOnFail?: CheckSeverity;
}): CheckResult {
  const diff = opts.actual.minus(opts.expected);
  const ok = diff.abs().lte(opts.tolerance);
  return {
    code: opts.code,
    label: opts.label,
    severity: ok ? 'OK' : (opts.severityOnFail ?? 'ERROR'),
    message: ok ? opts.okMessage : opts.failMessage(diff),
    expected: opts.format(opts.expected),
    actual: opts.format(opts.actual),
    difference: opts.format(diff),
  };
}

function skipped(code: string, label: string, message: string): CheckResult {
  return { code, label, severity: 'OK', message, skipped: true };
}

/**
 * Autocontroles contables del comprobante.
 *
 * El criterio central: las reglas impositivas del proveedor sirven para
 * controlar, nunca para tapar una base incompleta. Que el IVA sea exactamente
 * el 21 % del neto leído no alcanza si ese neto no coincide con el impreso.
 */
/**
 * Cuánto puede apartarse `cantidad × precio` del importe impreso.
 *
 * Acá **no** va la tolerancia contable de max($1, 0,5 %). Esa existe para los
 * totales, donde el redondeo renglón por renglón se acumula de verdad. Un
 * renglón es otra cosa: es una multiplicación impresa, y el único margen
 * legítimo es el redondeo. Si el precio unitario viene redondeado a dos
 * decimales, su error es de medio centavo y se multiplica por la cantidad; el
 * importe impreso agrega su propio medio centavo.
 *
 * La diferencia importa: con el 0,5 % un "10,90" leído como "10,909" —que es
 * el error típico del OCR, un dígito de más al final de la columna— pasa el
 * control sin que nadie se entere, y el comprobante cierra en verde con la
 * cantidad equivocada. Con el margen del redondeo, no pasa.
 */
function lineProductTolerance(item: { quantity: Decimal }): Decimal {
  return item.quantity.abs().times('0.005').plus('0.02');
}

export function validateDocument(input: ValidationInput): ValidationReport {
  const { items, printed, supplierRules } = input;
  const attempts = input.attempts ?? 1;
  const checks: CheckResult[] = [];
  const sums = summarizeItems(items);

  // --- 1. Aritmética de cada renglón ------------------------------------
  const badArithmetic: string[] = [];
  for (const item of items) {
    const expectedGross = money(item.quantity.times(item.unitNetPrice));
    if (item.grossSubtotal.minus(expectedGross).abs().gt(lineProductTolerance(item))) {
      badArithmetic.push(
        `renglón ${item.lineNumber} (${item.description}): ${formatQty(item.quantity, 2)} × ` +
          `${formatARS(item.unitNetPrice)} = ${formatARS(expectedGross)}, ` +
          `pero el importe leído es ${formatARS(item.grossSubtotal)}`,
      );
      continue;
    }
    const expectedNet = money(item.grossSubtotal.minus(item.discountAmount));
    if (item.netAmount.minus(expectedNet).abs().gt(roundingTolerance(expectedNet))) {
      badArithmetic.push(
        `renglón ${item.lineNumber} (${item.description}): bruto menos descuento da ` +
          `${formatARS(expectedNet)} y el neto leído es ${formatARS(item.netAmount)}`,
      );
    }
  }
  checks.push({
    code: 'ART_ARITMETICA',
    label: 'Aritmética de los renglones',
    severity: badArithmetic.length === 0 ? 'OK' : 'ERROR',
    message:
      badArithmetic.length === 0
        ? 'Cantidad × precio y neto después del descuento cierran en todos los renglones.'
        : `Hay ${badArithmetic.length} renglón/es con importes que no cierran: ${badArithmetic.join('; ')}.`,
  });

  // --- 2. Cantidad de renglones -----------------------------------------
  if (printed.lineCount === null || printed.lineCount === undefined) {
    checks.push(
      skipped(
        'ART_CANTIDAD',
        'Cantidad de renglones',
        'El comprobante no informa la cantidad de renglones: no se pudo controlar.',
      ),
    );
  } else {
    const diff = items.length - printed.lineCount;
    checks.push({
      code: 'ART_CANTIDAD',
      label: 'Cantidad de renglones',
      severity: diff === 0 ? 'OK' : 'ERROR',
      expected: String(printed.lineCount),
      actual: String(items.length),
      difference: String(diff),
      message:
        diff === 0
          ? `Se leyeron los ${items.length} renglones impresos.`
          : diff < 0
            ? `Faltan ${Math.abs(diff)} renglón/es: el comprobante declara ${printed.lineCount} y se leyeron ${items.length}.`
            : `Se leyeron ${diff} renglón/es de más: el comprobante declara ${printed.lineCount} y se leyeron ${items.length}.`,
    });
  }

  // --- 3. Neto de los artículos contra el neto impreso -------------------
  if (!present(printed.netTotal)) {
    checks.push({
      code: 'ART_NETO',
      label: 'Neto de los artículos',
      severity: 'ERROR',
      message:
        'No se pudo leer el neto impreso del comprobante, así que no hay contra qué controlar la suma de los artículos.',
    });
  } else {
    const expected = money(printed.netTotal);
    checks.push(
      compare({
        code: 'ART_NETO',
        label: 'Neto de los artículos',
        expected,
        actual: sums.netAmount,
        tolerance: roundingTolerance(expected),
        format: formatARS,
        okMessage: `La suma de los netos coincide con el neto impreso (${formatARS(expected)}).`,
        failMessage: (d) =>
          `La suma de los artículos da ${formatARS(sums.netAmount)} y el neto impreso es ` +
          `${formatARS(expected)}: hay una diferencia de ${formatARS(d.abs())}. ` +
          (d.isNegative()
            ? 'Faltan importes o renglones en el detalle.'
            : 'El detalle tiene importes de más.'),
      }),
    );
  }

  // --- 4. Bruto y descuento ---------------------------------------------
  if (present(printed.grossSubtotal)) {
    const expected = money(printed.grossSubtotal);
    checks.push(
      compare({
        code: 'ART_BRUTO',
        label: 'Subtotal bruto',
        expected,
        actual: sums.grossSubtotal,
        tolerance: roundingTolerance(expected),
        format: formatARS,
        okMessage: `El subtotal bruto de los artículos coincide con el impreso (${formatARS(expected)}).`,
        failMessage: (d) =>
          `El bruto de los artículos da ${formatARS(sums.grossSubtotal)} contra ` +
          `${formatARS(expected)} impreso: diferencia de ${formatARS(d.abs())}.`,
      }),
    );
  } else {
    checks.push(
      skipped('ART_BRUTO', 'Subtotal bruto', 'El comprobante no imprime el subtotal bruto.'),
    );
  }

  if (present(printed.discountTotal)) {
    const expected = money(printed.discountTotal);
    checks.push(
      compare({
        code: 'ART_DESCUENTO',
        label: 'Descuento total',
        expected,
        actual: sums.discountAmount,
        tolerance: roundingTolerance(expected),
        format: formatARS,
        okMessage: `Los descuentos por renglón suman el descuento impreso (${formatARS(expected)}).`,
        failMessage: (d) =>
          `Los descuentos de los renglones suman ${formatARS(sums.discountAmount)} contra ` +
          `${formatARS(expected)} impreso: diferencia de ${formatARS(d.abs())}.`,
      }),
    );
  } else {
    checks.push(
      skipped('ART_DESCUENTO', 'Descuento total', 'El comprobante no imprime un descuento total.'),
    );
  }

  // --- 5. Kilos y unidades ----------------------------------------------
  if (present(printed.netWeightKg)) {
    const expected = toDecimal(printed.netWeightKg);
    checks.push(
      compare({
        code: 'PESO_NETO',
        label: 'Peso neto',
        expected,
        actual: sums.totalQuantityKg,
        tolerance: roundingTolerance(expected, 0.05, 0.005),
        format: (d) => `${formatQty(d, 2)} kg`,
        okMessage: `Los kilos de los renglones suman el peso neto impreso (${formatQty(expected, 2)} kg).`,
        failMessage: (d) =>
          `Los renglones suman ${formatQty(sums.totalQuantityKg, 2)} kg y el peso neto impreso es ` +
          `${formatQty(expected, 2)} kg: ${d.isNegative() ? 'faltan' : 'sobran'} ` +
          `${formatQty(d.abs(), 2)} kg.`,
      }),
    );
  } else {
    checks.push(skipped('PESO_NETO', 'Peso neto', 'El comprobante no imprime un peso neto.'));
  }

  if (present(printed.totalUnits)) {
    const expected = toDecimal(printed.totalUnits);
    checks.push(
      compare({
        code: 'TOTAL_UNIDADES',
        label: 'Total de unidades',
        expected,
        actual: sums.totalUnits,
        tolerance: roundingTolerance(expected, 0.01, 0.005),
        format: (d) => formatQty(d, 2),
        okMessage: 'Las unidades de los renglones coinciden con el total impreso.',
        failMessage: (d) =>
          `Las unidades suman ${formatQty(sums.totalUnits, 2)} contra ${formatQty(expected, 2)} ` +
          `impresas: diferencia de ${formatQty(d.abs(), 2)}.`,
      }),
    );
  } else {
    checks.push(
      skipped(
        'TOTAL_UNIDADES',
        'Total de unidades',
        'El comprobante no imprime un total de unidades.',
      ),
    );
  }

  // --- 6. Impuestos según las reglas del proveedor ----------------------
  const netForTax = present(printed.netTotal) ? money(printed.netTotal) : sums.netAmount;

  if (supplierRules?.ivaRate !== undefined && present(printed.ivaTotal)) {
    const rate = toDecimal(supplierRules.ivaRate);
    const expected = money(netForTax.times(rate));
    const actual = money(printed.ivaTotal);
    checks.push(
      compare({
        code: 'IVA_TASA',
        label: 'IVA según la tasa del proveedor',
        expected,
        actual,
        // El IVA impreso suele venir de redondear renglón por renglón, así que
        // difiere unos centavos del cálculo sobre el neto total.
        tolerance: roundingTolerance(expected),
        format: formatARS,
        okMessage: `El IVA impreso (${formatARS(actual)}) coincide con la tasa configurada del proveedor.`,
        failMessage: (d) =>
          `El IVA impreso es ${formatARS(actual)} y aplicando la tasa del proveedor sobre el neto ` +
          `daría ${formatARS(expected)}: diferencia de ${formatARS(d.abs())}.`,
        severityOnFail: 'WARN',
      }),
    );
  } else {
    checks.push(
      skipped(
        'IVA_TASA',
        'IVA según la tasa del proveedor',
        'No hay tasa de IVA configurada para el proveedor o el comprobante no discrimina IVA.',
      ),
    );
  }

  if (supplierRules?.iibbRate !== undefined && present(printed.perceptionsTotal)) {
    const rate = toDecimal(supplierRules.iibbRate);
    const expected = money(netForTax.times(rate));
    const actual = money(printed.perceptionsTotal);
    checks.push(
      compare({
        code: 'PERCEPCION_TASA',
        label: 'Percepciones según la tasa del proveedor',
        expected,
        actual,
        tolerance: roundingTolerance(expected),
        format: formatARS,
        okMessage: `Las percepciones impresas (${formatARS(actual)}) coinciden con la tasa configurada.`,
        failMessage: (d) =>
          `Las percepciones impresas son ${formatARS(actual)} y con la tasa del proveedor darían ` +
          `${formatARS(expected)}: diferencia de ${formatARS(d.abs())}.`,
        severityOnFail: 'WARN',
      }),
    );
  } else {
    checks.push(
      skipped(
        'PERCEPCION_TASA',
        'Percepciones según la tasa del proveedor',
        'No hay tasa de percepción configurada o el comprobante no discrimina percepciones.',
      ),
    );
  }

  // --- 7. Total general --------------------------------------------------
  if (!present(printed.total)) {
    checks.push({
      code: 'TOTAL_GENERAL',
      label: 'Total del comprobante',
      severity: 'ERROR',
      message: 'No se pudo leer el total del comprobante.',
    });
  } else {
    const iva = present(printed.ivaTotal) ? money(printed.ivaTotal) : ZERO;
    const perc = present(printed.perceptionsTotal) ? money(printed.perceptionsTotal) : ZERO;
    const expected = money(netForTax.plus(iva).plus(perc));
    const actual = money(printed.total);
    checks.push(
      compare({
        code: 'TOTAL_GENERAL',
        label: 'Total del comprobante',
        expected,
        actual,
        tolerance: roundingTolerance(expected),
        format: formatARS,
        okMessage: `Neto más IVA más percepciones da el total impreso (${formatARS(actual)}).`,
        failMessage: (d) =>
          `Neto (${formatARS(netForTax)}) + IVA (${formatARS(iva)}) + percepciones ` +
          `(${formatARS(perc)}) da ${formatARS(expected)}, pero el total impreso es ` +
          `${formatARS(actual)}: diferencia de ${formatARS(d.abs())}.`,
      }),
    );
  }

  // --- 8. ¿Los "totales" son en realidad los de un renglón? --------------
  checks.push(detectLineTotalsMistakenForDocumentTotals(items, printed, sums.netAmount));

  // --- Estado final ------------------------------------------------------
  const errorCount = checks.filter((c) => c.severity === 'ERROR').length;
  const warningCount = checks.filter((c) => c.severity === 'WARN').length;

  let state: CheckState;
  if (errorCount > 0) state = 'DIFERENCIA';
  else if (warningCount > 0 || attempts > 1) state = 'RECONCILIADO';
  else state = 'OK';

  return {
    state,
    canSave: errorCount === 0,
    checks,
    errorCount,
    warningCount,
    computed: {
      itemCount: sums.count,
      grossSubtotal: sums.grossSubtotal.toFixed(2),
      discountAmount: sums.discountAmount.toFixed(2),
      netAmount: sums.netAmount.toFixed(2),
      ivaAmount: sums.ivaAmount.toFixed(2),
      perceptionAmount: sums.perceptionAmount.toFixed(2),
      totalCost: sums.totalCost.toFixed(2),
      totalQuantityKg: sums.totalQuantityKg.toFixed(3),
      totalUnits: sums.totalUnits.toFixed(3),
    },
  };
}

/**
 * El OCR a veces toma como totales generales los importes de la última línea
 * del detalle. El síntoma es siempre el mismo: el detalle suma un orden de
 * magnitud más que el "total". Antes de dar por buena una diferencia enorme,
 * conviene decir que lo más probable es que se hayan leído mal los totales.
 */
function detectLineTotalsMistakenForDocumentTotals(
  items: CostedItem[],
  printed: PrintedSummary,
  itemsNet: Decimal,
): CheckResult {
  const label = 'Coherencia de los totales leídos';
  const code = 'TOTALES_SOSPECHOSOS';

  if (items.length < 2 || !present(printed.total)) {
    return skipped(code, label, 'No hay datos suficientes para evaluar la coherencia.');
  }

  const declaredNet = present(printed.netTotal)
    ? money(printed.netTotal)
    : money(
        toDecimal(printed.total)
          .minus(present(printed.ivaTotal) ? toDecimal(printed.ivaTotal) : ZERO)
          .minus(present(printed.perceptionsTotal) ? toDecimal(printed.perceptionsTotal) : ZERO),
      );

  if (declaredNet.lte(0) || itemsNet.lte(0)) {
    return skipped(code, label, 'No hay datos suficientes para evaluar la coherencia.');
  }

  // Los artículos suman al menos el doble que el "total" leído.
  if (itemsNet.lt(declaredNet.times(2))) {
    return {
      code,
      label,
      severity: 'OK',
      message: 'Los totales leídos son del orden de magnitud del detalle.',
    };
  }

  // ¿Coincide con algún renglón? Refuerza el diagnóstico.
  const matching = items.find(
    (i) =>
      i.netAmount.minus(declaredNet).abs().lte(roundingTolerance(declaredNet)) ||
      i.totalCost.minus(money(printed.total)).abs().lte(roundingTolerance(printed.total)),
  );

  return {
    code,
    label,
    severity: 'ERROR',
    expected: formatARS(itemsNet),
    actual: formatARS(declaredNet),
    message:
      `Los importes leídos como totales (${formatARS(printed.total)} de total) son mucho más chicos ` +
      `que el detalle, que suma ${formatARS(itemsNet)} de neto. ` +
      (matching
        ? `Coinciden con el renglón ${matching.lineNumber} (${matching.description}), así que probablemente se leyó el importe de una línea en lugar del resumen del comprobante.`
        : 'Probablemente se leyeron los importes de un renglón en lugar del resumen del comprobante.') +
      ' Hay que releer el pie del comprobante.',
  };
}
