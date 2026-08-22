import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import { ValidationError } from '@/lib/errors';
import { suggestDueDate } from '@/lib/services/documents';
import { describeTerm } from '@/lib/domain/payments';
import { handle } from '@/lib/api';
import { toISODate } from '@/lib/datetime';

/**
 * Fecha de pago sugerida para un proveedor y una fecha de emisión.
 * Se consulta cuando cambia el proveedor o la fecha en la pantalla de revisión.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    await requireUser();
    const { id } = await params;
    const fecha = new URL(request.url).searchParams.get('fecha');
    if (!fecha) throw new ValidationError('Falta la fecha de emisión del comprobante.');

    const { dueDate, term, conditions } = await suggestDueDate(id, fecha);
    return NextResponse.json({
      vencimiento: toISODate(dueDate),
      plazo: term ? describeTerm(term) : 'Sin condición configurada',
      formaDePago: term?.paymentMethod ?? 'TRANSFERENCIA',
      ivaTasa: conditions.tax?.ivaRate ?? null,
      iibbTasa: conditions.tax?.iibbRate ?? null,
    });
  });
}
