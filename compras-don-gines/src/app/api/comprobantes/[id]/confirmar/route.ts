import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import { confirmDocument, type ConfirmDocumentInput } from '@/lib/services/documents';
import {
  confirmarNotaDeCredito,
  type ConfirmCreditNoteInput,
} from '@/lib/services/notas-credito';
import { handle, readJson } from '@/lib/api';
import { toISODate } from '@/lib/datetime';

export const maxDuration = 60;

type Entrada =
  | (Omit<ConfirmDocumentInput, 'documentId'> & { docType?: 'FACTURA' | 'REMITO' })
  | (Omit<ConfirmCreditNoteInput, 'documentId'> & { docType: 'NOTA_CREDITO' });

/**
 * Confirma el comprobante.
 *
 * El backend vuelve a calcular y a controlar todos los importes con los datos
 * que llegan: si no cierran, no guarda, diga lo que diga el frontend.
 *
 * Una nota de crédito va por otro camino porque hace otra cosa: no se agenda
 * para pagar, resta en la cuenta corriente, y mueve mercadería sólo en los
 * renglones donde se declaró que volvió.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser();
    const { id } = await params;
    const body = await readJson<Entrada>(request);

    if (body.docType === 'NOTA_CREDITO') {
      const nota = body as Omit<ConfirmCreditNoteInput, 'documentId'>;
      const result = await confirmarNotaDeCredito(user, { ...nota, documentId: id });
      return NextResponse.json({
        documentId: result.documentId,
        estado: result.report.state,
        forzado: result.forced,
        tipo: 'NOTA_CREDITO',
        credito: result.credito as string | null,
        renglonesConDevolucion: result.renglonesConDevolucion,
        // Una nota de crédito no genera agenda: no se paga, se descuenta.
        pago: null as { id: string; vencimiento: string } | null,
      });
    }

    const result = await confirmDocument(user, {
      ...(body as Omit<ConfirmDocumentInput, 'documentId'>),
      documentId: id,
    });

    return NextResponse.json({
      documentId: result.documentId,
      estado: result.report.state,
      forzado: result.forced,
      tipo: 'FACTURA',
      credito: null,
      renglonesConDevolucion: 0,
      pago: {
        id: result.paymentScheduleId,
        vencimiento: toISODate(result.dueDate),
      },
    });
  });
}
