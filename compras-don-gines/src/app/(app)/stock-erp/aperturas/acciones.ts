'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/session';
import {
  prepararApertura,
  actualizarSnapshot,
  guardarConteo,
  contarEnCero,
  marcarNoSeManeja,
  fijarCorte,
  confirmarApertura,
} from '@/lib/services/stock-erp-apertura';
import { AppError } from '@/lib/errors';

/**
 * Las acciones de las pantallas de apertura.
 *
 * Cáscaras finas: leen el formulario, llaman al servicio y traducen el error.
 * **Ninguna regla vive acá.** El permiso, la doble confirmación, los
 * impedimentos y el interruptor los decide el servicio, que es lo que corre
 * aunque alguien mande el pedido sin pasar por esta pantalla.
 */

export interface Resultado {
  ok: boolean;
  mensaje: string;
}

function traducir(e: unknown): Resultado {
  if (e instanceof AppError) return { ok: false, mensaje: e.message };
  return { ok: false, mensaje: 'No se pudo completar la operación.' };
}

function refrescar(sessionId?: string) {
  revalidatePath('/stock-erp/aperturas');
  if (sessionId) revalidatePath(`/stock-erp/aperturas/${sessionId}`);
}

export async function prepararLaApertura(_p: Resultado | null, f: FormData): Promise<Resultado> {
  try {
    const user = await requireUser();
    const ap = await prepararApertura(user, {
      branchId: String(f.get('branchId') ?? ''),
      /*
       * Ficticia por omisión, y a propósito.
       *
       * Una apertura real exige destildarlo Y el interruptor encendido. El
       * valor por omisión de una casilla decide lo que pasa cuando nadie mira,
       * así que por omisión pasa lo inofensivo.
       */
      ficticia: f.get('real') !== 'si',
    });
    refrescar(ap.sessionId);
    return { ok: true, mensaje: `Borrador preparado con ${ap.lineas.length} artículos.` };
  } catch (e) {
    return traducir(e);
  }
}

export async function actualizarElSnapshot(_p: Resultado | null, f: FormData): Promise<Resultado> {
  try {
    const user = await requireUser();
    const id = String(f.get('sessionId') ?? '');
    await actualizarSnapshot(user, id);
    refrescar(id);
    return { ok: true, mensaje: 'Borrador actualizado. Los conteos cargados se conservaron.' };
  } catch (e) {
    return traducir(e);
  }
}

export async function guardarElConteo(_p: Resultado | null, f: FormData): Promise<Resultado> {
  try {
    const user = await requireUser();
    await guardarConteo(user, {
      activationId: String(f.get('activationId') ?? ''),
      /* Texto. Convertirlo a número acá perdería exactitud antes de llegar. */
      cantidad: String(f.get('cantidad') ?? ''),
    });
    refrescar(String(f.get('sessionId') ?? ''));
    return { ok: true, mensaje: 'Conteo guardado.' };
  } catch (e) {
    return traducir(e);
  }
}

export async function contarloEnCero(_p: Resultado | null, f: FormData): Promise<Resultado> {
  try {
    const user = await requireUser();
    await contarEnCero(user, String(f.get('activationId') ?? ''));
    refrescar(String(f.get('sessionId') ?? ''));
    return { ok: true, mensaje: 'Contado en cero: se contó y no había.' };
  } catch (e) {
    return traducir(e);
  }
}

export async function noSeManejaAca(_p: Resultado | null, f: FormData): Promise<Resultado> {
  try {
    const user = await requireUser();
    await marcarNoSeManeja(user, {
      activationId: String(f.get('activationId') ?? ''),
      motivo: String(f.get('motivo') ?? ''),
    });
    refrescar(String(f.get('sessionId') ?? ''));
    return { ok: true, mensaje: 'Marcado como no manejado en esta sucursal.' };
  } catch (e) {
    return traducir(e);
  }
}

export async function fijarElCorte(_p: Resultado | null, f: FormData): Promise<Resultado> {
  try {
    const user = await requireUser();
    const id = String(f.get('sessionId') ?? '');
    await fijarCorte(user, {
      sessionId: id,
      fecha: String(f.get('fecha') ?? ''),
      hora: String(f.get('hora') ?? ''),
    });
    refrescar(id);
    return { ok: true, mensaje: 'Corte fijado.' };
  } catch (e) {
    return traducir(e);
  }
}

export async function confirmarLaApertura(_p: Resultado | null, f: FormData): Promise<Resultado> {
  try {
    const user = await requireUser();
    const id = String(f.get('sessionId') ?? '');
    const r = await confirmarApertura(user, {
      sessionId: id,
      confirmado: f.get('confirmado') === 'si',
      /* Lo que la persona VIO. Si cambió, el servidor no aplica. */
      esperado: {
        contados: Number(f.get('contados') ?? -1),
        ceros: Number(f.get('ceros') ?? -1),
        noSeManeja: Number(f.get('noSeManeja') ?? -1),
      },
    });
    refrescar(id);
    return {
      ok: true,
      mensaje: r.yaEstabaAplicada
        ? 'Esta apertura ya estaba aplicada. No se duplicó nada.'
        : `Apertura confirmada: ${r.movimientos} movimientos de apertura (${r.contados} contados, ${r.ceros} en cero, ${r.noSeManeja} no manejados).`,
    };
  } catch (e) {
    return traducir(e);
  }
}
