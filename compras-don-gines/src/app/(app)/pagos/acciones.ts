'use server';

import { redirect } from 'next/navigation';
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
  } catch (error) {
    return { error: toUserMessage(error), scheduleId };
  }

  // Confirmado el pago, el comprobante sale de la pestaña donde estaba. Sin
  // esta navegación la fila desaparecería sin decir nada, así que se lleva al
  // usuario a "Pagados", donde lo ve en su nuevo lugar con el aviso.
  //
  // El redirect va acá y no en el componente porque toda acción de servidor
  // vuelve a dibujar la ruta actual: eso desmonta el formulario antes de que un
  // efecto del cliente llegue a navegar. Tampoco se revalida: estas pantallas
  // son dinámicas, y revalidar antes del redirect deja al usuario donde estaba.
  redirect('/pagos?grupo=pagados&confirmado=1');
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
