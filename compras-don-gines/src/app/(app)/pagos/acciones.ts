'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/session';
import { toUserMessage } from '@/lib/errors';
import { confirmPayment, reschedulePayment } from '@/lib/services/payments';

export interface ResultadoPago {
  ok?: boolean;
  error?: string;
  scheduleId?: string;
}

/**
 * Confirma que el pago se hizo. Pide fecha efectiva, forma de pago y
 * referencia: el vencimiento previsto no se toca, queda el historial completo.
 */
export async function confirmarPago(
  _prev: ResultadoPago,
  formData: FormData,
): Promise<ResultadoPago> {
  const scheduleId = String(formData.get('scheduleId') ?? '');
  try {
    const user = await requireUser();
    await confirmPayment(user, {
      scheduleId,
      effectiveDate: String(formData.get('fechaEfectiva') ?? ''),
      paymentMethod: String(formData.get('formaDePago') ?? ''),
      reference: String(formData.get('referencia') ?? '') || null,
      notes: String(formData.get('observacion') ?? '') || null,
      amount: String(formData.get('importe') ?? '') || null,
    });
    revalidatePath('/pagos');
    revalidatePath('/');
    return { ok: true, scheduleId };
  } catch (error) {
    return { error: toUserMessage(error), scheduleId };
  }
}

export async function reprogramarPago(
  _prev: ResultadoPago,
  formData: FormData,
): Promise<ResultadoPago> {
  const scheduleId = String(formData.get('scheduleId') ?? '');
  try {
    const user = await requireUser();
    await reschedulePayment(
      user,
      scheduleId,
      String(formData.get('nuevaFecha') ?? ''),
      String(formData.get('motivo') ?? ''),
    );
    revalidatePath('/pagos');
    return { ok: true, scheduleId };
  } catch (error) {
    return { error: toUserMessage(error), scheduleId };
  }
}
