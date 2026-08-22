import Decimal from 'decimal.js';

// Precisión amplia para los prorrateos intermedios; el redondeo a 2 decimales
// es explícito y siempre por HALF_UP (criterio contable argentino).
Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -30, toExpPos: 30 });

export { Decimal };

export const ZERO = new Decimal(0);
export const ONE = new Decimal(1);

/** Cantidad de decimales con la que se guardan y comparan los importes. */
export const MONEY_DP = 2;
/** Decimales para cantidades (kilos, unidades). */
export const QTY_DP = 3;

export type MoneyInput = Decimal | number | string | null | undefined;

const CURRENCY_NOISE = /[$ \s  ]|ARS|AR\$|USD|US\$|pesos?/gi;

/**
 * Interpreta un número escrito con las convenciones argentinas y con la basura
 * que suele agregar el OCR.
 *
 * Casos que tiene que resolver igual: "2.196.120,52", "2 196 120,52",
 * "$ 2.196.120,52", "2196120,52", "2.196.120.52" (OCR que perdió la coma).
 *
 * Reglas:
 *  - Se eliminan símbolos de moneda y espacios (el OCR parte números al medio).
 *  - Si aparecen punto y coma, manda el separador que esté más a la derecha.
 *  - Con un único separador, se considera decimal salvo que agrupe de a 3
 *    dígitos exactos, que es la forma argentina de los miles.
 *  - Varios separadores iguales siempre son miles.
 *
 * Devuelve null si no hay un número reconocible: nunca inventa un 0.
 */
export function parseArNumber(raw: unknown): Decimal | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Decimal) return raw;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? new Decimal(raw) : null;
  }
  if (typeof raw !== 'string') return null;

  let s = raw.trim();
  if (s === '') return null;

  // Paréntesis contables => negativo.
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }

  s = s.replace(CURRENCY_NOISE, '');
  s = s.replace(/%/g, '');

  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }

  // A esta altura sólo deberían quedar dígitos y separadores.
  if (!/^[\d.,]*$/.test(s) || !/\d/.test(s)) return null;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  const dots = (s.match(/\./g) ?? []).length;
  const commas = (s.match(/,/g) ?? []).length;

  let intPart: string;
  let decPart = '';

  if (lastDot >= 0 && lastComma >= 0) {
    // Conviven ambos: el de más a la derecha es el decimal.
    const decSep = lastDot > lastComma ? '.' : ',';
    const thouSep = decSep === '.' ? ',' : '.';
    const cut = decSep === '.' ? lastDot : lastComma;
    intPart = s.slice(0, cut).split(thouSep).join('').split(decSep).join('');
    decPart = s.slice(cut + 1);
  } else if (commas > 0) {
    if (commas > 1) {
      // Varias comas y ningún punto: pasa cuando el OCR lee los puntos de miles
      // como comas ("1,792,751,44" por "1.792.751,44"). El último grupo
      // desempata, porque un número no puede tener dos separadores decimales:
      // tres dígitos al final son miles ("1,234,567"), uno o dos son decimales.
      const ultimo = s.slice(lastComma + 1);
      if (/^\d{3}$/.test(ultimo)) {
        intPart = s.split(',').join('');
      } else {
        intPart = s.slice(0, lastComma).split(',').join('');
        decPart = ultimo;
      }
    } else {
      const after = s.slice(lastComma + 1);
      // En Argentina la coma es decimal aun con 3 dígitos ("153,700" = 153,7).
      intPart = s.slice(0, lastComma);
      decPart = after;
    }
  } else if (dots > 0) {
    if (dots > 1) {
      // Igual que arriba, del otro lado: "2.196.120" son miles, pero
      // "2.196.120.52" es el mismo importe con la coma decimal leída como
      // punto. Manda el largo del último grupo.
      const ultimo = s.slice(lastDot + 1);
      if (/^\d{3}$/.test(ultimo)) {
        intPart = s.split('.').join('');
      } else {
        intPart = s.slice(0, lastDot).split('.').join('');
        decPart = ultimo;
      }
    } else {
      const after = s.slice(lastDot + 1);
      const before = s.slice(0, lastDot);
      // "16.037" => 16037: forma argentina de agrupar miles. Para que sea un
      // grupo de miles válido, lo que está antes del punto tiene que ser un
      // primer grupo real: 1 a 3 dígitos y sin cero a la izquierda. Así
      // "0.015" sigue siendo una fracción y "1234.567" un decimal.
      const looksLikeThousands =
        /^\d{3}$/.test(after) && /^[1-9]\d{0,2}$/.test(before);
      if (looksLikeThousands) {
        intPart = s.split('.').join('');
      } else {
        intPart = before;
        decPart = after;
      }
    }
  } else {
    intPart = s;
  }

  if (intPart === '') intPart = '0';
  if (!/^\d+$/.test(intPart)) return null;
  if (decPart !== '' && !/^\d+$/.test(decPart)) return null;

  const normalized = decPart === '' ? intPart : `${intPart}.${decPart}`;
  let value: Decimal;
  try {
    value = new Decimal(normalized);
  } catch {
    return null;
  }
  return negative ? value.neg() : value;
}

/**
 * Interpreta un número en formato canónico de máquina: punto decimal y sin
 * separadores de miles. Es lo que se le exige al lector en su JSON, donde
 * "153.700" tiene que significar 153,7 y no ciento cincuenta y tres mil.
 *
 * Si el valor no viene en formato canónico se cae a parseArNumber, porque un
 * modelo puede desobedecer el formato pedido y es preferible interpretarlo con
 * las reglas argentinas antes que descartarlo.
 */
export function parseCanonicalNumber(raw: unknown): Decimal | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Decimal) return raw;
  if (typeof raw === 'number') return Number.isFinite(raw) ? new Decimal(raw) : null;
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return new Decimal(s);
  return parseArNumber(s);
}

/**
 * Interpreta una tasa. Distingue "1,5 %" (una tasa) de "$ 1,50" (un importe):
 * quien llama ya sabe que el campo es una tasa, y acá se resuelve la escala.
 *
 *  - "21 %", "21", 21   => 0,21
 *  - "1,5 %", "1,5"     => 0,015
 *  - "0,21", 0.21       => 0,21
 *
 * El corte es 1: nadie factura con una tasa del 150 %, y una tasa escrita como
 * fracción nunca supera 1.
 */
export function parseRate(raw: unknown): Decimal | null {
  const looksExplicitPercent = typeof raw === 'string' && raw.includes('%');
  const value = parseArNumber(raw);
  if (value === null) return null;
  if (value.isNegative()) return null;
  if (looksExplicitPercent) return value.div(100);
  return value.gt(1) ? value.div(100) : value;
}

export function toDecimal(value: MoneyInput, fallback: Decimal = ZERO): Decimal {
  if (value === null || value === undefined) return fallback;
  if (value instanceof Decimal) return value;
  if (typeof value === 'number') return new Decimal(value);
  const parsed = parseArNumber(value);
  return parsed ?? fallback;
}

/** Redondeo contable a 2 decimales (HALF_UP). */
export function money(value: MoneyInput): Decimal {
  return toDecimal(value).toDecimalPlaces(MONEY_DP, Decimal.ROUND_HALF_UP);
}

export function qty(value: MoneyInput): Decimal {
  return toDecimal(value).toDecimalPlaces(QTY_DP, Decimal.ROUND_HALF_UP);
}

export function sumMoney(values: MoneyInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(toDecimal(v)), ZERO);
}

export function isCloseEnough(a: MoneyInput, b: MoneyInput, tolerance: MoneyInput): boolean {
  return toDecimal(a).minus(toDecimal(b)).abs().lte(toDecimal(tolerance));
}

/**
 * Tolerancia admitida por el spec: el mayor entre $1 y el 0,5 % del importe de
 * referencia. Cualquier diferencia mayor bloquea la validación.
 */
export function roundingTolerance(reference: MoneyInput, minimum = 1, pct = 0.005): Decimal {
  const ref = toDecimal(reference).abs();
  const relative = ref.times(pct);
  const floor = new Decimal(minimum);
  return relative.gt(floor) ? relative : floor;
}

// ---------------------------------------------------------------------------
// Formato es-AR
// ---------------------------------------------------------------------------

const arNumber = new Intl.NumberFormat('es-AR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const arCurrency = new Intl.NumberFormat('es-AR', {
  style: 'currency',
  currency: 'ARS',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatARS(value: MoneyInput): string {
  return arCurrency.format(toDecimal(value).toDecimalPlaces(MONEY_DP).toNumber());
}

export function formatNumber(value: MoneyInput): string {
  return arNumber.format(toDecimal(value).toNumber());
}

export function formatQty(value: MoneyInput, decimals = 2): string {
  return new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(toDecimal(value).toNumber());
}

/** 0,015 => "1,5 %" */
export function formatRate(value: MoneyInput): string {
  const pct = toDecimal(value).times(100);
  const decimals = pct.decimalPlaces() > 0 ? Math.min(pct.decimalPlaces(), 2) : 0;
  return `${new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(pct.toNumber())} %`;
}

export function formatKg(value: MoneyInput): string {
  return `${formatQty(value, 2)} kg`;
}
