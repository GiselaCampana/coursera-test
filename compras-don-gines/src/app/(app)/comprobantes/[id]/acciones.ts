'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/session';
import { toUserMessage } from '@/lib/errors';
import { rejectDocument, voidDocument } from '@/lib/services/documents';

export interface ResultadoAccion {
  ok?: boolean;
  error?: string;
}

/** Anula un comprobante confirmado. Exige motivo y queda en auditoría. */
export async function anularComprobante(
  _prev: ResultadoAccion,
  formData: FormData,
): Promise<ResultadoAccion> {
  try {
    const user = await requireUser();
    const documentId = String(formData.get('documentId') ?? '');
    const motivo = String(formData.get('motivo') ?? '');
    await voidDocument(user, documentId, motivo);
    revalidatePath(`/comprobantes/${documentId}`);
    return { ok: true };
  } catch (error) {
    return { error: toUserMessage(error) };
  }
}

/** Rechaza una carga mal hecha y libera el número del comprobante. */
export async function rechazarComprobante(
  _prev: ResultadoAccion,
  formData: FormData,
): Promise<ResultadoAccion> {
  try {
    const user = await requireUser();
    const documentId = String(formData.get('documentId') ?? '');
    const motivo = String(formData.get('motivo') ?? '');
    await rejectDocument(user, documentId, motivo);
    revalidatePath(`/comprobantes/${documentId}`);
    return { ok: true };
  } catch (error) {
    return { error: toUserMessage(error) };
  }
}
