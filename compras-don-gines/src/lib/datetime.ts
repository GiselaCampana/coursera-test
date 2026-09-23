/**
 * Todo el negocio ocurre en America/Argentina/Buenos_Aires.
 *
 * Las fechas "de calendario" (emisión de la factura, vencimiento del pago) se
 * guardan como medianoche UTC del día argentino que representan, y se leen y
 * escriben siempre en UTC. Así un vencimiento del 14/08 no se corre al 13/08
 * porque el servidor esté en otro huso.
 */

import { esUnaBaseDePruebas, nombreDeLaBase } from '@/lib/base-de-pruebas';

export const AR_TIMEZONE = 'America/Argentina/Buenos_Aires';

const arDateParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: AR_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * La variable que fija el día. **Sólo para pruebas**, y sólo contra una base de
 * pruebas: mirá `ahora()`.
 */
export const DIA_FIJADO = 'APP_FAKE_TODAY';

/**
 * El instante que la aplicación toma por «ahora».
 *
 * Existe por una sola razón: que una prueba pueda decir qué día es. El estado
 * de un pago —agendado, vence hoy, vencido— es una función del vencimiento y
 * del día de hoy, así que una prueba que afirme cualquiera de los tres sin
 * controlar «hoy» no afirma nada: pasa hasta que el calendario avanza y después
 * falla sola, un día cualquiera, sin que nadie haya tocado el código.
 *
 * **No hace falta para el huso horario.** Todo el negocio ocurre en
 * `America/Argentina/Buenos_Aires` y el día se saca de ahí con `Intl`, así que
 * el huso de la máquina que corre las pruebas ya era indiferente. Lo que esto
 * agrega es lo otro: el instante.
 *
 * Fijarlo contra una base de verdad sería mucho peor que cualquier prueba
 * frágil —toda la agenda de pagos clasificada contra un día que no existe— así
 * que no se ignora en silencio: se corta. Un reloj congelado en producción no
 * se ve en ninguna pantalla; se ve semanas después, en los pagos que nadie hizo
 * porque la agenda nunca los mostró vencidos. La condición es la misma que
 * usa el sembrador antes de borrar tablas, y por eso está escrita una sola vez.
 */
export function ahora(): Date {
  const fijado =
    typeof process === 'undefined' ? undefined : process.env[DIA_FIJADO]?.trim();
  if (!fijado) return new Date();

  if (!esUnaBaseDePruebas(process.env.DATABASE_URL)) {
    /* Se nombra la base y sólo la base: la URL entera lleva la contraseña. */
    throw new Error(
      `${DIA_FIJADO} fija el día de hoy y sólo puede usarse contra una base de pruebas: ` +
        'el nombre tiene que contener "e2e", "test" o "demo". ' +
        `Base vista: ${nombreDeLaBase(process.env.DATABASE_URL ?? '') ?? '(ninguna)'}`,
    );
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fijado)) {
    throw new Error(`${DIA_FIJADO} tiene que ser "YYYY-MM-DD"; se leyó «${fijado}».`);
  }

  /*
   * Mediodía argentino del día pedido: bien adentro del día, para que ningún
   * huso lo corra al anterior o al siguiente. Las tres horas son el desfase de
   * Argentina, que no tiene horario de verano desde 2009; si algún día lo
   * tuviera, la comprobación de abajo lo dice en vez de devolver otro día.
   */
  const instante = new Date(dateOnlyFromISO(fijado).getTime() + 15 * 60 * 60 * 1000);
  const dia = arDateParts.format(instante);
  if (dia !== fijado) {
    throw new Error(
      `${DIA_FIJADO}=${fijado} cae en ${dia} hora argentina. Cambió el desfase del huso.`,
    );
  }
  return instante;
}

/** Fecha argentina de hoy como "YYYY-MM-DD". */
export function arTodayISO(now: Date = ahora()): string {
  return arDateParts.format(now);
}

/** Medianoche UTC del día argentino de hoy. */
export function arToday(now: Date = ahora()): Date {
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

/**
 * Convierte una fecha y hora **argentinas** en el instante que representan.
 *
 * Existe para el corte de la apertura de Stock ERP, y la precisión importa: la
 * persona escribe «23/09/2026 20:30» mirando el reloj del local, y lo que hay
 * que guardar es el INSTANTE, no el texto. Sin esta conversión, un servidor en
 * otro huso entendería otra cosa y el corte dejaría dentro o fuera del conteo
 * lo que no corresponde.
 *
 * El desfase no se escribe a mano: se deriva preguntándole a `Intl` qué hora
 * argentina corresponde a un instante candidato y corrigiendo la diferencia.
 * Así sigue siendo correcto si Argentina volviera a tener horario de verano,
 * en vez de quedar clavado en −03:00 como una suposición que nadie revisa.
 */
export function instanteDesdeHoraArgentina(fecha: string, hora: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    throw new Error(`La fecha tiene que ser "YYYY-MM-DD"; se leyó «${fecha}».`);
  }
  if (!/^\d{2}:\d{2}$/.test(hora)) {
    throw new Error(`La hora tiene que ser "HH:MM"; se leyó «${hora}».`);
  }
  const [y, m, d] = fecha.split('-').map(Number);
  const [hh, mm] = hora.split(':').map(Number);
  if (hh > 23 || mm > 59) throw new Error(`«${hora}» no es una hora válida.`);

  /*
   * Primer intento: leer los números como si fueran UTC. Después se pregunta
   * qué hora argentina es ese instante y se corrige por la diferencia. Dos
   * pasadas alcanzan siempre, incluso en un cambio de huso: la segunda usa el
   * desfase vigente EN esa fecha, no el de hoy.
   */
  let instante = Date.UTC(y, m - 1, d, hh, mm, 0, 0);
  for (let i = 0; i < 2; i += 1) {
    const partes = new Intl.DateTimeFormat('en-CA', {
      timeZone: AR_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(instante));
    const leido = Object.fromEntries(partes.map((p) => [p.type, p.value]));
    const comoUtc = Date.UTC(
      Number(leido.year),
      Number(leido.month) - 1,
      Number(leido.day),
      Number(leido.hour) % 24,
      Number(leido.minute),
    );
    const deseado = Date.UTC(y, m - 1, d, hh, mm);
    if (comoUtc === deseado) break;
    instante += deseado - comoUtc;
  }
  return new Date(instante);
}

/** El corte, escrito como lo lee una persona: fecha, hora y zona. */
export function formatCorteAr(fecha: Date | string | null | undefined): string {
  if (!fecha) return '—';
  const d = typeof fecha === 'string' ? new Date(fecha) : fecha;
  if (Number.isNaN(d.getTime())) return '—';
  return `${formatDateTimeAr(d)} (hora de Argentina)`;
}
