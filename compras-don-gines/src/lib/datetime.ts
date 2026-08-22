/**
 * Todo el negocio ocurre en America/Argentina/Buenos_Aires.
 *
 * Las fechas "de calendario" (emisión de la factura, vencimiento del pago) se
 * guardan como medianoche UTC del día argentino que representan, y se leen y
 * escriben siempre en UTC. Así un vencimiento del 14/08 no se corre al 13/08
 * porque el servidor esté en otro huso.
 */

export const AR_TIMEZONE = 'America/Argentina/Buenos_Aires';

const arDateParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: AR_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Fecha argentina de hoy como "YYYY-MM-DD". */
export function arTodayISO(now: Date = new Date()): string {
  return arDateParts.format(now);
}

/** Medianoche UTC del día argentino de hoy. */
export function arToday(now: Date = new Date()): Date {
  return dateOnlyFromISO(arTodayISO(now));
}

/** "2026-08-14" => Date en medianoche UTC del 14/08/2026. */
export function dateOnlyFromISO(iso: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) throw new Error(`Fecha inválida: ${iso}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/** Normaliza cualquier Date a la medianoche UTC de su día. */
export function toDateOnly(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: Date, days: number): Date {
  const d = toDateOnly(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

export function diffInDays(a: Date, b: Date): number {
  const ms = toDateOnly(a).getTime() - toDateOnly(b).getTime();
  return Math.round(ms / 86_400_000);
}

/**
 * Interpreta una fecha escrita como la escribe un comprobante argentino:
 * 14/08/2026, 14-08-2026, 14.08.26 o el ISO 2026-08-14.
 * Devuelve null si no se puede leer: nunca inventa una fecha.
 */
export function parseArDate(raw: unknown): Date | null {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : toDateOnly(raw);
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s === '') return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (iso) return safeUTC(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const dmy = /^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{2,4})$/.exec(s);
  if (dmy) {
    let year = Number(dmy[3]);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    return safeUTC(year, Number(dmy[2]), Number(dmy[1]));
  }
  return null;
}

function safeUTC(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return d;
}

/** 14/08/2026 */
export function formatDateAr(date: Date | string | null | undefined): string {
  if (!date) return '—';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return '—';
  const day = String(d.getUTCDate()).padStart(2, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${d.getUTCFullYear()}`;
}

/** 14/08/2026 15:42 — para sellos de tiempo reales, en hora argentina. */
export function formatDateTimeAr(date: Date | string | null | undefined): string {
  if (!date) return '—';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: AR_TIMEZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

/** Primer día del mes argentino en curso, como fecha UTC. */
export function startOfMonthAr(now: Date = new Date()): Date {
  const iso = arTodayISO(now);
  return dateOnlyFromISO(`${iso.slice(0, 7)}-01`);
}
