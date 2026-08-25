'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { ValidationError, toUserMessage } from '@/lib/errors';
import { acceptReadDocument, rejectDocument, voidDocument } from '@/lib/services/documents';

export interface ResultadoAccion {
  ok?: boolean;
  error?: string;
  /** Qué controles no cierran, cuando es eso lo que impide aceptar. */
  controles?: string[];
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

/**
 * Acepta un comprobante que se leyó bien y quedó esperando confirmación.
 *
 * No cambia el estado a mano: el servicio vuelve a correr todos los controles
 * con lo que hay guardado y confirma sólo si cierran. Si queda algún error, se
 * devuelve para que la pantalla diga exactamente cuál.
 */
export async function aceptarComprobante(
  _prev: ResultadoAccion,
  formData: FormData,
): Promise<ResultadoAccion> {
  const documentId = String(formData.get('documentId') ?? '');
  try {
    const user = await requireUser();
    await acceptReadDocument(user, documentId);
    revalidatePath(`/comprobantes/${documentId}`);
    revalidatePath('/comprobantes');
  } catch (error) {
    /*
     * Cuando lo que falla son los controles, se dice cuáles.
     *
     * "El comprobante no cierra" no le sirve a nadie parado frente al
     * proveedor: hay que poder leer qué control falló y con qué diferencia,
     * que es lo que el informe ya sabe.
     */
    const detalles = detallesDeValidacion(error);
    return { error: toUserMessage(error), controles: detalles };
  }

  /*
   * El aviso de que salió bien va en la página, no en esta tarjeta.
   *
   * Al quedar validado, la tarjeta de aceptación desaparece —ya no hay nada que
   * aceptar— y se llevaría puesto cualquier mensaje que viviera adentro. Así que
   * se redirige al mismo aviso que usa el asistente al terminar de guardar: es
   * el mismo hecho y conviene que se vea igual, entre por donde entre.
   *
   * Va fuera del try: `redirect` funciona lanzando, y adentro lo atraparía el
   * catch y lo mostraría como si fuera un error.
   */
  redirect(`/comprobantes/${documentId}?guardado=1`);
}

/** Los controles en error que viajan adentro de una ValidationError. */
function detallesDeValidacion(error: unknown): string[] | undefined {
  if (!(error instanceof ValidationError)) return undefined;
  const checks = (error.details as { checks?: { label: string; message: string }[] } | undefined)
    ?.checks;
  if (!Array.isArray(checks) || checks.length === 0) return undefined;
  return checks.map((c) => `${c.label}: ${c.message}`);
}
