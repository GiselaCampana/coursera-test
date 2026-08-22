import { Decimal, money, toDecimal, type MoneyInput } from '@/lib/money';
import { addDays, arToday, toDateOnly } from '@/lib/datetime';

export type TermType = 'SAME_DAY' | 'DAYS' | 'MANUAL';
export type PaymentStatus = 'AGENDADO' | 'VENCE_HOY' | 'VENCIDO' | 'PAGADO' | 'CANCELADO';

export interface PaymentTerm {
  termType: TermType;
  days?: number | null;
  paymentMethod?: string | null;
}

/**
 * Fecha prevista de pago según las condiciones del proveedor.
 *
 * SAME_DAY es el caso de Los Calvos: se paga el mismo día de la factura, así
 * que el vencimiento es la fecha de emisión. Vencer no es lo mismo que pagar:
 * el comprobante queda "vence hoy" hasta que alguien confirme el pago.
 *
 * MANUAL devuelve null a propósito: la fecha la elige el usuario.
 */
export function computeDueDate(issueDate: Date, term: PaymentTerm): Date | null {
  switch (term.termType) {
    case 'SAME_DAY':
      return toDateOnly(issueDate);
    case 'DAYS':
      return addDays(issueDate, term.days ?? 0);
    case 'MANUAL':
      return null;
  }
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
};

export function describeTerm(term: PaymentTerm): string {
  switch (term.termType) {
    case 'SAME_DAY':
      return 'En el día';
    case 'DAYS':
      return term.days === 1 ? 'A 1 día' : `A ${term.days ?? 0} días`;
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
