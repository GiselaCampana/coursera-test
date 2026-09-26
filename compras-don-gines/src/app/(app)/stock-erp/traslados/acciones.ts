'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/session';
import {
  crearBorrador,
  agregarRenglon,
  modificarRenglon,
  retirarRenglon,
  cancelarBorrador,
  despachar,
  recibir,
  cambiarInterruptorDeTraslados,
  type ResultadoDeTraslado,
} from '@/lib/services/stock-erp-traslados';
import { AppError, ConflictError } from '@/lib/errors';

/**
 * Las acciones de las pantallas de traslados.
 *
 * Cáscaras finas, igual que en la apertura y la recepción: leen el formulario,
 * llaman al servicio y traducen el error. **Ninguna regla vive acá.** El
 * permiso, la doble confirmación, el saldo, las unidades, el corte, el
 * interruptor y la huella los decide el servicio, que es lo que corre aunque el
 * pedido llegue sin pasar por esta pantalla.
 */

export interface Resultado {
  ok: boolean;
  mensaje: string;
  /**
   * Un conflicto se marca aparte del resto de los errores: no es lo mismo «no se
   * pudo» que «alguien ya decidió esto de otra manera».
   */
  conflicto?: boolean;
  detalle?: ResultadoDeTraslado;
  /** El traslado recién creado, para poder abrirlo. */
  trasladoId?: string;
}

function traducir(e: unknown): Resultado {
  if (e instanceof ConflictError) return { ok: false, mensaje: e.message, conflicto: true };
  if (e instanceof AppError) return { ok: false, mensaje: e.message };
  return { ok: false, mensaje: 'No se pudo completar la operación.' };
}

function refrescar(trasladoId?: string) {
  revalidatePath('/stock-erp/traslados');
  revalidatePath('/stock-erp/existencias');
  revalidatePath('/stock-erp/movimientos');
  if (trasladoId) revalidatePath(`/stock-erp/traslados/${trasladoId}`);
}

export async function crearElBorrador(_p: Resultado | null, f: FormData): Promise<Resultado> {
  try {
    const user = await requireUser();
    const { id } = await crearBorrador(user, {
      origenId: String(f.get('origenId') ?? ''),
      destinoId: String(f.get('destinoId') ?? ''),
    });
    refrescar(id);
    return { ok: true, mensaje: 'Borrador creado. Agregale los artículos.', trasladoId: id };
  } catch (e) {
    return traducir(e);
  }
}

export async function agregarElRenglon(_p: Resultado | null, f: FormData): Promise<Resultado> {
  const trasladoId = String(f.get('trasladoId') ?? '');
  try {
    const user = await requireUser();
    await agregarRenglon(user, {
      trasladoId,
      productId: String(f.get('productId') ?? ''),
      cantidad: String(f.get('cantidad') ?? ''),
      version: Number(f.get('version') ?? '0'),
    });
    refrescar(trasladoId);
    return { ok: true, mensaje: 'Artículo agregado al traslado.' };
  } catch (e) {
    return traducir(e);
  }
}

export async function modificarElRenglon(_p: Resultado | null, f: FormData): Promise<Resultado> {
  const trasladoId = String(f.get('trasladoId') ?? '');
  try {
    const user = await requireUser();
    await modificarRenglon(user, {
      lineaId: String(f.get('lineaId') ?? ''),
      cantidad: String(f.get('cantidad') ?? ''),
      version: Number(f.get('version') ?? '0'),
    });
    refrescar(trasladoId);
    return { ok: true, mensaje: 'Cantidad cambiada.' };
  } catch (e) {
    return traducir(e);
  }
}

export async function retirarElRenglon(_p: Resultado | null, f: FormData): Promise<Resultado> {
  const trasladoId = String(f.get('trasladoId') ?? '');
  try {
    const user = await requireUser();
    await retirarRenglon(user, {
      lineaId: String(f.get('lineaId') ?? ''),
      version: Number(f.get('version') ?? '0'),
    });
    refrescar(trasladoId);
    return { ok: true, mensaje: 'Artículo retirado del traslado.' };
  } catch (e) {
    return traducir(e);
  }
}

export async function cancelarElBorrador(_p: Resultado | null, f: FormData): Promise<Resultado> {
  const trasladoId = String(f.get('trasladoId') ?? '');
  try {
    const user = await requireUser();
    await cancelarBorrador(user, { trasladoId, motivo: String(f.get('motivo') ?? '') });
    refrescar(trasladoId);
    return { ok: true, mensaje: 'Borrador cancelado. No se escribió nada en el libro.' };
  } catch (e) {
    return traducir(e);
  }
}

export async function despacharElTraslado(_p: Resultado | null, f: FormData): Promise<Resultado> {
  const trasladoId = String(f.get('trasladoId') ?? '');
  try {
    const user = await requireUser();
    const r = await despachar(user, { trasladoId, confirmado: f.get('confirmado') === 'si' });
    refrescar(trasladoId);
    return {
      ok: true,
      detalle: r,
      mensaje: r.yaEstabaAplicado
        ? `Este traslado ya estaba despachado (${r.movimientos} movimientos). No se duplicó nada.`
        : `Despachado: ${r.movimientos} ${r.movimientos === 1 ? 'movimiento' : 'movimientos'} de salida. La mercadería queda EN TRÁNSITO hasta que el destino la reciba.`,
    };
  } catch (e) {
    return traducir(e);
  }
}

export async function recibirElTraslado(_p: Resultado | null, f: FormData): Promise<Resultado> {
  const trasladoId = String(f.get('trasladoId') ?? '');
  try {
    const user = await requireUser();
    /*
     * Lo contado al abrir el bulto, por renglón. Los campos viajan como
     * `contado:<lineaId>`: si están vacíos, el servicio recibe lo despachado;
     * si están y no coinciden, NO se confirma nada y el traslado sigue en
     * tránsito. Esa decisión es del servicio, no de esta cáscara.
     */
    const contado: Record<string, string> = {};
    for (const [clave, valor] of f.entries()) {
      if (clave.startsWith('contado:')) contado[clave.slice('contado:'.length)] = String(valor);
    }
    const r = await recibir(user, {
      trasladoId,
      confirmado: f.get('confirmado') === 'si',
      contado,
    });
    refrescar(trasladoId);
    return {
      ok: true,
      detalle: r,
      mensaje: r.yaEstabaAplicado
        ? `Este traslado ya estaba recibido (${r.movimientos} movimientos). No se duplicó nada.`
        : `Recibido: ${r.movimientos} ${r.movimientos === 1 ? 'movimiento' : 'movimientos'} de entrada. El traslado queda cerrado.`,
    };
  } catch (e) {
    return traducir(e);
  }
}

export async function cambiarElInterruptorDeTraslados(
  _p: Resultado | null,
  f: FormData,
): Promise<Resultado> {
  try {
    const user = await requireUser();
    await cambiarInterruptorDeTraslados(user, {
      encender: f.get('encender') === 'si',
      motivo: String(f.get('motivo') ?? ''),
    });
    refrescar();
    return { ok: true, mensaje: 'Interruptor de traslados reales cambiado.' };
  } catch (e) {
    return traducir(e);
  }
}
