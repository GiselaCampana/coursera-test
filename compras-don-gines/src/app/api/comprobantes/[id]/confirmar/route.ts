import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import { confirmDocument, type ConfirmDocumentInput } from '@/lib/services/documents';
import { handle, readJson } from '@/lib/api';
import { toISODate } from '@/lib/datetime';

export const maxDuration = 60;

/**
 * Confirma el comprobante.
 *
 * El backend vuelve a calcular y a controlar todos los importes con los datos
 * que llegan: si no cierran, no guarda, diga lo que diga el frontend.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser();
    const { id } = await params;
    const body = await readJson<Omit<ConfirmDocumentInput, 'documentId'>>(request);

    const result = await confirmDocument(user, { ...body, documentId: id });

    return NextResponse.json({
      documentId: result.documentId,
      estado: result.report.state,
      forzado: result.forced,
      pago: {
        id: result.paymentScheduleId,
        vencimiento: toISODate(result.dueDate),
      },
    });
  });
}
