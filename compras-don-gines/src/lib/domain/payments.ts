import { Decimal, money, toDecimal, type MoneyInput } from '@/lib/money';
import { addDays, arToday, toDateOnly } from '@/lib/datetime';

export type TermType = 'SAME_DAY' | 'DAYS' | 'MANUAL' | 'NEXT_INVOICE';
export type PaymentStatus = 'AGENDADO' | 'VENCE_HOY' | 'VENCIDO' | 'PAGADO' | 'CANCELADO';

export interface PaymentTerm {
  termType: TermType;
  days?: number | null;
  paymentMethod?: string | null;
}

/** Lo que hace falta saber, además del plazo, para poner una fecha. */
export interface ContextoDeVencimiento {
  /**
   * Cuándo se espera la próxima factura o visita del proveedor.
   *
   * Sólo lo usa "factura contra factura". Si no se sabe, la fecha no se puede
   * calcular y hay que pedírsela a alguien.
   */
  proximaFactura?: Date | null;
}

/**
 * Fecha prevista de pago según las condiciones del proveedor.
 *
 * SAME_DAY es el caso de Los Calvos: se paga el mismo día de la factura, así
 * que el vencimiento es la fecha de emisión. Vencer no es lo mismo que pagar:
 * el comprobante queda "vence hoy" hasta que alguien confirme el pago.
 *
 * NEXT_INVOICE es el de Errecalde: se paga cuando llega la siguiente factura,
 * que no es un plazo en días. El reparto no tiene periodicidad fija —depende de
 * cuándo pasa el camión— así que ponerle "a 30 días" da una fecha que no es. Lo
 * único que se puede saber de antemano es cuándo se espera esa próxima visita,
 * y eso viene de afuera; sin ese dato la función devuelve null y la fecha la
 * pone una persona.
 *
 * MANUAL devuelve null por la misma razón: la fecha la elige el usuario.
 *
 * Lo que **nunca** es una fecha de pago es el vencimiento del CAE. Es cuándo
 * caduca la autorización fiscal del comprobante, no cuándo hay que pagarlo, y
 * confundirlos agenda plata en una fecha que no acordó nadie.
 */
export function computeDueDate(
  issueDate: Date,
  term: PaymentTerm,
  contexto: ContextoDeVencimiento = {},
): Date | null {
  switch (term.termType) {
    case 'SAME_DAY':
      return toDateOnly(issueDate);
    case 'DAYS':
      return addDays(issueDate, term.days ?? 0);
    case 'NEXT_INVOICE':
      return contexto.proximaFactura ? toDateOnly(contexto.proximaFactura) : null;
    case 'MANUAL':
      return null;
  }
}

/**
 * ¿La fecha que da este plazo es todavía una estimación?
 *
 * Con "factura contra factura" sí: hasta que llegue la próxima factura, lo que
 * hay es la fecha en que se la espera. Con los demás plazos la fecha sale del
 * acuerdo con el proveedor y es firme desde el momento en que se carga.
 */
export function esFechaProvisoria(term: PaymentTerm): boolean {
  return term.termType === 'NEXT_INVOICE';
}

export interface ScheduleState {
  dueDate: Date;
  plannedAmount: MoneyInput;
  paidAmount: MoneyInput;
  cancelled?: boolean;
}

/**
 * Estado del pago. Es una función del vencimiento y de lo efectivamente
 * pagado; nunca se marca pagado solo por haber llegado la fecha.
 */
export function computePaymentStatus(
  state: ScheduleState,
  now: Date = new Date(),
): PaymentStatus {
  if (state.cancelled) return 'CANCELADO';

  const planned = money(state.plannedAmount);
  const paid = money(state.paidAmount);
  // Pago total (o de más). El modelo admite parciales: mientras falte algo,
  // el comprobante sigue vivo en la agenda.
  if (planned.gt(0) && paid.gte(planned)) return 'PAGADO';

  const today = arToday(now);
  const due = toDateOnly(state.dueDate);
  const diff = due.getTime() - today.getTime();

  if (diff === 0) return 'VENCE_HOY';
  if (diff < 0) return 'VENCIDO';
  return 'AGENDADO';
}

export function remainingAmount(state: {
  plannedAmount: MoneyInput;
  paidAmount: MoneyInput;
}): Decimal {
  const rest = toDecimal(state.plannedAmount).minus(toDecimal(state.paidAmount));
  return rest.isNegative() ? new Decimal(0) : money(rest);
}

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  AGENDADO: 'Agendado',
  VENCE_HOY: 'Vence hoy',
  VENCIDO: 'Vencido',
  PAGADO: 'Pagado',
  CANCELADO: 'Cancelado',
};

export const TERM_TYPE_LABEL: Record<TermType, string> = {
  SAME_DAY: 'En el día',
  DAYS: 'A x días',
  MANUAL: 'Fecha manual',
  NEXT_INVOICE: 'Factura contra factura',
};

export function describeTerm(term: PaymentTerm): string {
  switch (term.termType) {
    case 'SAME_DAY':
      return 'En el día';
    case 'DAYS':
      return term.days === 1 ? 'A 1 día' : `A ${term.days ?? 0} días`;
    case 'NEXT_INVOICE':
      return 'Factura contra factura';
    case 'MANUAL':
      return 'Fecha manual';
  }
}

export const PAYMENT_METHODS = [
  'TRANSFERENCIA',
  'EFECTIVO',
  'CHEQUE',
  'ECHEQ',
  'DEBITO_AUTOMATICO',
  'OTRO',
] as const;

export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  TRANSFERENCIA: 'Transferencia',
  EFECTIVO: 'Efectivo',
  CHEQUE: 'Cheque',
  ECHEQ: 'Echeq',
  DEBITO_AUTOMATICO: 'Débito automático',
  OTRO: 'Otro',
};
