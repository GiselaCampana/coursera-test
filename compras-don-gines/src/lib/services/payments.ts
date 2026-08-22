import 'server-only';
import { prisma } from '@/lib/db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { branchScopeFilter, hasPermission, type AuthUser } from '@/lib/auth/session';
import { money, toDecimal } from '@/lib/money';
import { arToday, parseArDate } from '@/lib/datetime';
import { computePaymentStatus, remainingAmount } from '@/lib/domain/payments';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/services/audit';

/**
 * Pone al día los estados de la agenda.
 *
 * Un pago pasa a "vence hoy" o "vencido" por el paso del tiempo, no por una
 * acción de nadie, así que hace falta recalcularlo al consultar. Los pagados y
 * los cancelados no se tocan: ya son estados finales.
 */
export async function refreshPaymentStatuses(now: Date = new Date()): Promise<number> {
  const today = arToday(now);
  const open = await prisma.paymentSchedule.findMany({
    where: { status: { in: ['AGENDADO', 'VENCE_HOY', 'VENCIDO'] } },
    select: { id: true, dueDate: true, plannedAmount: true, paidAmount: true, status: true },
  });

  const updates = open
    .map((schedule) => ({
      id: schedule.id,
      current: schedule.status,
      next: computePaymentStatus(
        {
          dueDate: schedule.dueDate,
          plannedAmount: schedule.plannedAmount.toString(),
          paidAmount: schedule.paidAmount.toString(),
        },
        now,
      ),
    }))
    .filter((u) => u.current !== u.next);

  if (updates.length === 0) return 0;
  await prisma.$transaction(
    updates.map((u) =>
      prisma.paymentSchedule.update({ where: { id: u.id }, data: { status: u.next } }),
    ),
  );
  void today;
  return updates.length;
}

export interface ConfirmPaymentInput {
  scheduleId: string;
  effectiveDate: string;
  paymentMethod: string;
  reference?: string | null;
  notes?: string | null;
  /** Importe pagado. Si no viene, se toma el saldo pendiente completo. */
  amount?: string | null;
}

/**
 * Registra un pago efectivamente realizado.
 *
 * La fecha prevista NO se pisa con la efectiva: son dos datos distintos y los
 * dos quedan. Cada confirmación genera un evento, así que el historial completo
 * se conserva y el modelo admite pagos parciales.
 */
export async function confirmPayment(user: AuthUser, input: ConfirmPaymentInput) {
  if (!hasPermission(user, PERMISSIONS.PAGOS_CONFIRMAR)) {
    throw new ForbiddenError('Tu usuario no puede confirmar pagos.');
  }

  const schedule = await prisma.paymentSchedule.findUnique({
    where: { id: input.scheduleId },
    include: { document: { include: { supplier: true, branch: true } } },
  });
  if (!schedule) throw new NotFoundError('No encontramos ese pago en la agenda.');
  if (schedule.status === 'PAGADO') throw new ConflictError('Ese pago ya estaba confirmado.');
  if (schedule.status === 'CANCELADO') throw new ConflictError('Ese pago está cancelado.');

  const effectiveDate = parseArDate(input.effectiveDate);
  if (!effectiveDate) throw new ValidationError('La fecha efectiva del pago no es válida.');
  if (effectiveDate.getTime() > arToday().getTime()) {
    throw new ValidationError('La fecha efectiva del pago no puede ser futura.');
  }
  if (!input.paymentMethod?.trim()) {
    throw new ValidationError('Indicá con qué forma de pago se abonó.');
  }

  const pending = remainingAmount({
    plannedAmount: schedule.plannedAmount.toString(),
    paidAmount: schedule.paidAmount.toString(),
  });
  const amount = input.amount ? money(input.amount) : pending;
  if (amount.lte(0)) throw new ValidationError('El importe del pago tiene que ser mayor a cero.');
  if (amount.gt(pending)) {
    throw new ValidationError(
      'El importe informado supera el saldo pendiente del comprobante.',
    );
  }

  const newPaid = money(toDecimal(schedule.paidAmount.toString()).plus(amount));
  const status = computePaymentStatus({
    dueDate: schedule.dueDate,
    plannedAmount: schedule.plannedAmount.toString(),
    paidAmount: newPaid,
  });

  const updated = await prisma.$transaction(async (tx) => {
    await tx.paymentEvent.create({
      data: {
        scheduleId: schedule.id,
        kind: 'CONFIRMACION',
        amount: amount.toString(),
        effectiveDate,
        paymentMethod: input.paymentMethod.trim(),
        reference: input.reference?.trim() || null,
        notes: input.notes?.trim() || null,
        userId: user.id,
      },
    });
    return tx.paymentSchedule.update({
      where: { id: schedule.id },
      data: { paidAmount: newPaid.toString(), status },
    });
  });

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.PAYMENT_CONFIRMED,
    entity: 'PaymentSchedule',
    entityId: schedule.id,
    after: {
      comprobante: schedule.document.fullNumber,
      proveedor: schedule.document.supplier?.tradeName ?? null,
      importe: amount.toString(),
      fechaEfectiva: effectiveDate.toISOString().slice(0, 10),
      fechaPrevista: schedule.dueDate.toISOString().slice(0, 10),
      formaDePago: input.paymentMethod.trim(),
      referencia: input.reference?.trim() || null,
    },
  });

  return updated;
}

export async function reschedulePayment(
  user: AuthUser,
  scheduleId: string,
  newDueDateISO: string,
  reason?: string,
) {
  if (!hasPermission(user, PERMISSIONS.PAGOS_REPROGRAMAR)) {
    throw new ForbiddenError('Tu usuario no puede reprogramar pagos.');
  }
  const schedule = await prisma.paymentSchedule.findUnique({ where: { id: scheduleId } });
  if (!schedule) throw new NotFoundError('No encontramos ese pago en la agenda.');
  if (schedule.status === 'PAGADO') throw new ConflictError('Ese pago ya está confirmado.');

  const dueDate = parseArDate(newDueDateISO);
  if (!dueDate) throw new ValidationError('La nueva fecha de pago no es válida.');

  const status = computePaymentStatus({
    dueDate,
    plannedAmount: schedule.plannedAmount.toString(),
    paidAmount: schedule.paidAmount.toString(),
  });

  const updated = await prisma.$transaction(async (tx) => {
    await tx.paymentEvent.create({
      data: {
        scheduleId,
        kind: 'REPROGRAMACION',
        effectiveDate: dueDate,
        notes: reason?.trim() || null,
        userId: user.id,
      },
    });
    return tx.paymentSchedule.update({ where: { id: scheduleId }, data: { dueDate, status } });
  });

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.PAYMENT_RESCHEDULED,
    entity: 'PaymentSchedule',
    entityId: scheduleId,
    reason: reason?.trim() || null,
    before: { vencimiento: schedule.dueDate.toISOString().slice(0, 10) },
    after: { vencimiento: dueDate.toISOString().slice(0, 10) },
  });
  return updated;
}

export async function cancelPayment(user: AuthUser, scheduleId: string, reason: string) {
  if (!hasPermission(user, PERMISSIONS.PAGOS_REPROGRAMAR)) {
    throw new ForbiddenError('Tu usuario no puede cancelar pagos.');
  }
  const clean = reason?.trim() ?? '';
  if (clean.length < 5) throw new ValidationError('Explicá el motivo de la cancelación.');

  const schedule = await prisma.paymentSchedule.findUnique({ where: { id: scheduleId } });
  if (!schedule) throw new NotFoundError('No encontramos ese pago en la agenda.');
  if (schedule.status === 'PAGADO') throw new ConflictError('Ese pago ya está confirmado.');

  const updated = await prisma.$transaction(async (tx) => {
    await tx.paymentEvent.create({
      data: { scheduleId, kind: 'CANCELACION', notes: clean, userId: user.id },
    });
    return tx.paymentSchedule.update({ where: { id: scheduleId }, data: { status: 'CANCELADO' } });
  });

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.PAYMENT_CANCELLED,
    entity: 'PaymentSchedule',
    entityId: scheduleId,
    reason: clean,
  });
  return updated;
}

/** Agenda agrupada por estado, respetando el alcance por sucursal del usuario. */
export async function listPayments(user: AuthUser) {
  await refreshPaymentStatuses();
  const scope = branchScopeFilter(user);

  const schedules = await prisma.paymentSchedule.findMany({
    where: {
      document: {
        ...scope,
        status: { in: ['VALIDADO'] },
      },
    },
    include: {
      document: { include: { supplier: true, branch: true } },
      events: { orderBy: { createdAt: 'desc' }, include: { user: { select: { name: true } } } },
    },
    orderBy: [{ dueDate: 'asc' }],
  });

  return {
    venceHoy: schedules.filter((s) => s.status === 'VENCE_HOY'),
    vencidos: schedules.filter((s) => s.status === 'VENCIDO'),
    proximos: schedules.filter((s) => s.status === 'AGENDADO'),
    pagados: schedules.filter((s) => s.status === 'PAGADO').reverse(),
    cancelados: schedules.filter((s) => s.status === 'CANCELADO'),
  };
}
