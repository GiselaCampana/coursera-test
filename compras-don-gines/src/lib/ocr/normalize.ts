import { parseCanonicalNumber, parseRate } from '@/lib/money';
import type { RawItem, Unit } from '@/lib/domain/costing';
import type { PrintedSummary } from '@/lib/domain/validation';
import type { OcrItem, OcrSummary } from '@/lib/ocr/types';

/**
 * Traducción de la salida del lector al vocabulario del dominio.
 *
 * Un campo que el lector no pudo leer llega como null y sale como undefined:
 * en ningún caso se convierte en cero. La diferencia importa, porque un cero
 * hace cerrar cuentas que en realidad no cierran.
 */

const num = (value: unknown): string | undefined => {
  const parsed = parseCanonicalNumber(value);
  return parsed === null ? undefined : parsed.toString();
};

const rate = (value: unknown): string | undefined => {
  const parsed = parseRate(value);
  return parsed === null ? undefined : parsed.toString();
};

export function toRawItems(items: OcrItem[] | null | undefined): RawItem[] {
  if (!items) return [];
  return items
    .filter((item) => item.description && item.description.trim() !== '')
    .map((item, index) => {
      const unit: Unit = item.unit === 'UNIT' ? 'UNIT' : 'KG';
      return {
        lineNumber: item.lineNumber ?? index + 1,
        supplierCode: item.supplierCode ?? null,
        description: item.description.trim(),
        quantity: num(item.quantity) ?? '0',
        unit,
        pieceCount: item.pieceCount ?? null,
        totalWeightKg: num(item.totalWeightKg),
        unitNetPrice: num(item.unitNetPrice) ?? '0',
        grossSubtotal: num(item.grossSubtotal),
        discountPct: rate(item.discountPct) ?? '0',
        discountAmount: num(item.discountAmount),
        netAmount: num(item.netAmount),
        ivaRate: rate(item.ivaRate) ?? '0',
      } satisfies RawItem;
    });
}

export function toPrintedSummary(summary: OcrSummary | null | undefined): PrintedSummary {
  if (!summary) return {};
  return {
    grossSubtotal: num(summary.grossSubtotal),
    discountTotal: num(summary.discountTotal),
    netTotal: num(summary.netTotal),
    ivaTotal: num(summary.ivaTotal) ?? sumLines(summary.ivaLines),
    perceptionsTotal: num(summary.perceptionsTotal) ?? sumLines(summary.perceptionLines),
    total: num(summary.total),
    lineCount: summary.lineCount ?? null,
    netWeightKg: num(summary.netWeightKg),
    totalUnits: num(summary.totalUnits),
  };
}

function sumLines(lines: { amount: string }[] | null | undefined): string | undefined {
  if (!lines || lines.length === 0) return undefined;
  let total = parseCanonicalNumber('0')!;
  let found = false;
  for (const line of lines) {
    const value = parseCanonicalNumber(line.amount);
    if (value) {
      total = total.plus(value);
      found = true;
    }
  }
  return found ? total.toString() : undefined;
}

/**
 * Completa los campos que faltan en `primary` con los de `fallback`.
 *
 * Sólo rellena huecos: nunca pisa un valor que el lector sí pudo leer, y nunca
 * agrega un valor que ninguna lectura vio.
 */
export function mergeSummaries(
  primary: OcrSummary | null | undefined,
  fallback: OcrSummary | null | undefined,
): OcrSummary | null {
  if (!primary) return fallback ?? null;
  if (!fallback) return primary;

  const pick = <K extends keyof OcrSummary>(key: K): OcrSummary[K] =>
    primary[key] === null || primary[key] === undefined ? fallback[key] : primary[key];

  return {
    grossSubtotal: pick('grossSubtotal'),
    discountTotal: pick('discountTotal'),
    netTotal: pick('netTotal'),
    ivaLines: primary.ivaLines?.length ? primary.ivaLines : fallback.ivaLines,
    perceptionLines: primary.perceptionLines?.length
      ? primary.perceptionLines
      : fallback.perceptionLines,
    ivaTotal: pick('ivaTotal'),
    perceptionsTotal: pick('perceptionsTotal'),
    total: pick('total'),
    lineCount: pick('lineCount'),
    netWeightKg: pick('netWeightKg'),
    totalUnits: pick('totalUnits'),
    packageCount: pick('packageCount'),
  };
}

export function mergeHeaders<T extends object>(
  primary: T | null | undefined,
  fallback: T | null | undefined,
): T | null {
  if (!primary) return fallback ?? null;
  if (!fallback) return primary;
  const merged = { ...primary } as Record<string, unknown>;
  for (const [key, value] of Object.entries(fallback as Record<string, unknown>)) {
    if (merged[key] === null || merged[key] === undefined) merged[key] = value;
  }
  return merged as T;
}
