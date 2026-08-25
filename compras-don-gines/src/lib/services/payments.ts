import 'server-only';
import { prisma } from '@/lib/db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { branchScopeFilter, hasPermission, type AuthUser } from '@/lib/auth/session';
import { money, toDecimal } from '@/lib/money';
import { arToday, parseArDate, toISODate } from '@/lib/datetime';
import {
  computePaymentStatus,
  describeTerm,
  remainingAmount,
  type PaymentStatus,
  type TermType,
} from '@/lib/domain/payments';
import { Decimal } from '@/lib/money';

/** Cero, para ir sumando importes del calendario. */
const ZERO_PAGOS = new Decimal(0);
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

/**
 * Confirma la fecha de un pago "factura contra factura" contra la factura real.
 *
 * Mientras la siguiente factura no llega, el pago está agendado para el día en
 * que se la espera: una estimación. Cuando llega de verdad, esa fecha deja de
 * ser una suposición y hay que llevarla al día que corresponde.
 *
 * No lo hace solo, y es a propósito. Que haya entrado otra factura del proveedor
 * no significa que el pago se haga ese día —puede haber pasado el camión sin
 * cobrar, o haberse acordado otra cosa—, así que esto se ofrece y lo decide una
 * persona. Lo que sí hace es traer la fecha correcta para no tener que buscarla.
 *
 * Reutiliza `reschedulePayment`, así que queda el evento de reprogramación y el
 * asiento de auditoría con la fecha anterior y la nueva, igual que cualquier
 * otro cambio de fecha.
 */
export async function confirmarFechaContraFactura(user: AuthUser, scheduleId: string) {
  const schedule = await prisma.paymentSchedule.findUnique({
    where: { id: scheduleId },
    include: { document: { select: { supplierId: true, issueDate: true, id: true } } },
  });
  if (!schedule) throw new NotFoundError('No encontramos ese pago en la agenda.');
  if (!schedule.dueDateProvisional) {
    throw new ConflictError('Ese pago no tiene una fecha provisoria que confirmar.');
  }
  if (!schedule.document.supplierId || !schedule.document.issueDate) {
    throw new ConflictError('El comprobante no tiene proveedor o fecha de emisión.');
  }

  const siguiente = await siguienteFacturaDe(
    schedule.document.supplierId,
    schedule.document.issueDate,
    schedule.document.id,
  );
  if (!siguiente) {
    throw new ConflictError(
      'Todavía no hay una factura posterior de este proveedor: la fecha sigue siendo provisoria.',
    );
  }

  const actualizado = await reschedulePayment(
    user,
    scheduleId,
    toISODate(siguiente.issueDate!),
    `Llegó la factura ${siguiente.fullNumber ?? 'siguiente'} del proveedor.`,
  );

  // Ya no es una estimación: la factura que la definía existe.
  await prisma.paymentSchedule.update({
    where: { id: scheduleId },
    data: { dueDateProvisional: false },
  });

  return actualizado;
}

/**
 * La primera factura validada del proveedor posterior a una fecha dada.
 *
 * Se piden sólo las validadas: un borrador o algo que quedó a revisar todavía
 * puede cambiar de fecha o no llegar a existir, y no puede mover un pago.
 */
export async function siguienteFacturaDe(
  supplierId: string,
  despuesDe: Date,
  excepto: string,
): Promise<{ id: string; fullNumber: string | null; issueDate: Date | null } | null> {
  return prisma.document.findFirst({
    where: {
      supplierId,
      status: 'VALIDADO',
      id: { not: excepto },
      issueDate: { gt: despuesDe },
    },
    orderBy: { issueDate: 'asc' },
    select: { id: true, fullNumber: true, issueDate: true },
  });
}

// ---------------------------------------------------------------------------
// Agenda vista como calendario
// ---------------------------------------------------------------------------

export interface FiltrosDeAgenda {
  supplierId?: string;
  branchId?: string;
  status?: string;
  paymentMethod?: string;
}

export interface PagoDelCalendario {
  scheduleId: string;
  documentId: string;
  documentNumber: string;
  supplierName: string | null;
  branchName: string;
  /** Lo que falta pagar. Un pago parcial sigue en la agenda por el saldo. */
  saldo: string;
  plannedAmount: string;
  paidAmount: string;
  status: PaymentStatus;
  paymentMethod: string;
  condicion: string;
  /** ¿La fecha es todavía una estimación? Sólo con "factura contra factura". */
  provisoria: boolean;
}

export interface DiaDelCalendario {
  /** "YYYY-MM-DD". */
  fecha: string;
  /** Suma de los saldos pendientes de ese día. */
  aPagar: string;
  /** Suma de lo ya pagado de los comprobantes que vencen ese día. */
  pagado: string;
  cantidad: number;
  /** El estado más urgente del día, para poder marcarlo de un vistazo. */
  estado: PaymentStatus | null;
  hayProvisorias: boolean;
  pagos: PagoDelCalendario[];
}

export interface CalendarioDePagos {
  /** Mes que se está mirando, "YYYY-MM". */
  mes: string;
  dias: DiaDelCalendario[];
  totales: {
    previsto: string;
    pagado: string;
    pendiente: string;
    vencido: string;
    comprobantes: number;
  };
}

/**
 * La agenda de pagos de un mes, agrupada por día.
 *
 * Es la misma información que la lista, mirada de otra forma: los mismos
 * comprobantes, los mismos importes y los mismos estados. Que salgan de una
 * sola consulta y de las mismas funciones del dominio es lo que hace que las
 * dos vistas no puedan discrepar; si el calendario tuviera su propia cuenta de
 * lo pendiente, tarde o temprano diría algo distinto que la lista y no habría
 * forma de saber cuál de las dos tiene razón.
 *
 * Los importes son **saldos**: un pago parcial sigue en la agenda por lo que
 * falta, no por lo que se facturó.
 */
export async function getPaymentCalendar(
  user: AuthUser,
  mes: string,
  filtros: FiltrosDeAgenda = {},
): Promise<CalendarioDePagos> {
  if (!hasPermission(user, PERMISSIONS.PAGOS_VER)) {
    throw new ForbiddenError('Tu usuario no puede ver la agenda de pagos.');
  }
  await refreshPaymentStatuses();

  const [anio, mesNumero] = mes.split('-').map(Number);
  if (!anio || !mesNumero || mesNumero < 1 || mesNumero > 12) {
    throw new ValidationError('El mes tiene que venir como "AAAA-MM".');
  }
  const desde = new Date(Date.UTC(anio, mesNumero - 1, 1));
  const hasta = new Date(Date.UTC(anio, mesNumero, 1));

  const schedules = await prisma.paymentSchedule.findMany({
    where: {
      dueDate: { gte: desde, lt: hasta },
      ...(filtros.status ? { status: filtros.status as PaymentStatus } : {}),
      ...(filtros.paymentMethod ? { plannedPaymentMethod: filtros.paymentMethod } : {}),
      document: {
        ...branchScopeFilter(user),
        status: 'VALIDADO',
        ...(filtros.supplierId ? { supplierId: filtros.supplierId } : {}),
        ...(filtros.branchId ? { branchId: filtros.branchId } : {}),
      },
    },
    include: {
      document: {
        select: {
          id: true,
          fullNumber: true,
          appliedTermType: true,
          appliedTermDays: true,
          supplier: { select: { tradeName: true } },
          branch: { select: { name: true } },
        },
      },
    },
    orderBy: [{ dueDate: 'asc' }],
  });

  const porDia = new Map<string, DiaDelCalendario>();
  let previsto = ZERO_PAGOS;
  let pagado = ZERO_PAGOS;
  let vencido = ZERO_PAGOS;

  for (const s of schedules) {
    const fecha = toISODate(s.dueDate);
    const saldo = remainingAmount({
      plannedAmount: s.plannedAmount.toString(),
      paidAmount: s.paidAmount.toString(),
    });

    const condicion = s.document.appliedTermType
      ? describeTerm({
          termType: s.document.appliedTermType as TermType,
          days: s.document.appliedTermDays,
        })
      : 'Sin condición';

    const pago: PagoDelCalendario = {
      scheduleId: s.id,
      documentId: s.document.id,
      documentNumber: s.document.fullNumber ?? 'sin número',
      supplierName: s.document.supplier?.tradeName ?? null,
      branchName: s.document.branch.name,
      saldo: saldo.toFixed(2),
      plannedAmount: s.plannedAmount.toFixed(2),
      paidAmount: s.paidAmount.toFixed(2),
      status: s.status as PaymentStatus,
      paymentMethod: s.plannedPaymentMethod,
      condicion,
      provisoria: s.dueDateProvisional,
    };

    const dia = porDia.get(fecha) ?? {
      fecha,
      aPagar: '0.00',
      pagado: '0.00',
      cantidad: 0,
      estado: null,
      hayProvisorias: false,
      pagos: [],
    };
    dia.pagos.push(pago);
    dia.cantidad += 1;
    dia.aPagar = toDecimal(dia.aPagar).plus(saldo).toFixed(2);
    dia.pagado = toDecimal(dia.pagado).plus(s.paidAmount.toString()).toFixed(2);
    dia.hayProvisorias = dia.hayProvisorias || s.dueDateProvisional;
    dia.estado = masUrgente(dia.estado, s.status as PaymentStatus);
    porDia.set(fecha, dia);

    previsto = previsto.plus(s.plannedAmount.toString());
    pagado = pagado.plus(s.paidAmount.toString());
    if (s.status === 'VENCIDO') vencido = vencido.plus(saldo);
  }

  return {
    mes,
    dias: [...porDia.values()].sort((a, b) => a.fecha.localeCompare(b.fecha)),
    totales: {
      previsto: previsto.toFixed(2),
      pagado: pagado.toFixed(2),
      // Lo pendiente es lo previsto menos lo pagado, no una suma aparte: así no
      // puede quedar una tercera cuenta que no cierre con las otras dos.
      pendiente: previsto.minus(pagado).toFixed(2),
      vencido: vencido.toFixed(2),
      comprobantes: schedules.length,
    },
  };
}

/**
 * Los pagos de los próximos días, para la operación del día a día.
 *
 * Es la misma consulta del calendario mirada como agenda corta: quien abre la
 * aplicación a la mañana quiere saber qué hay que pagar esta semana, no navegar
 * un mes. Se incluye lo vencido porque sigue habiendo que pagarlo.
 */
export async function getProximosPagos(
  user: AuthUser,
  dias = 7,
  filtros: FiltrosDeAgenda = {},
): Promise<DiaDelCalendario[]> {
  if (!hasPermission(user, PERMISSIONS.PAGOS_VER)) {
    throw new ForbiddenError('Tu usuario no puede ver la agenda de pagos.');
  }
  const hoy = arToday();
  const hasta = new Date(hoy.getTime() + dias * 86_400_000);

  /*
   * Se piden los dos meses que puede tocar la ventana y se filtra después.
   *
   * Una semana que empieza el 28 termina en el mes siguiente, y pedir "el mes
   * actual" perdería la mitad. Reutilizar el calendario mensual —en vez de
   * escribir otra consulta— es lo que garantiza que las dos vistas cuenten lo
   * mismo.
   */
  const meses = new Set([mesDe(hoy), mesDe(hasta)]);
  const dias_: DiaDelCalendario[] = [];
  for (const mes of meses) {
    const calendario = await getPaymentCalendar(user, mes, filtros);
    dias_.push(...calendario.dias);
  }

  const desdeISO = toISODate(hoy);
  const hastaISO = toISODate(hasta);
  return dias_
    .filter((d) => d.fecha <= hastaISO && (d.fecha >= desdeISO || tieneDeuda(d)))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
}

/** Un día pasado sigue importando si quedó algo sin pagar. */
function tieneDeuda(dia: DiaDelCalendario): boolean {
  return toDecimal(dia.aPagar).gt(0);
}

function mesDe(fecha: Date): string {
  return toISODate(fecha).slice(0, 7);
}

/**
 * Cuál de dos estados manda para pintar el día.
 *
 * Un día con un pago vencido y tres agendados es un día vencido: lo urgente no
 * se diluye porque haya compañía.
 */
function masUrgente(a: PaymentStatus | null, b: PaymentStatus): PaymentStatus {
  const orden: PaymentStatus[] = ['VENCIDO', 'VENCE_HOY', 'AGENDADO', 'PAGADO', 'CANCELADO'];
  if (!a) return b;
  return orden.indexOf(a) <= orden.indexOf(b) ? a : b;
}
