'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/session';
import {
  registrarMerma,
  abrirRecuento,
  guardarCantidadFisica,
  confirmarLineaDeRecuento,
  cerrarRecuento,
  revertirOperacion,
  cambiarInterruptorDeCorrecciones,
  type ResultadoDeCorreccion,
} from '@/lib/services/stock-erp-correcciones';
import type { StockWasteCategory } from '@prisma/client';
import { AppError, ConflictError } from '@/lib/errors';

/**
 * Las acciones de las pantallas de correcciones.
 *
 * Cáscaras finas, como en las fases anteriores: leen el formulario, llaman al
 * servicio y traducen el error. **Ninguna regla vive acá**, y en esta fase eso
 * importa más que nunca: el delta del recuento lo calcula el servicio, y este
 * archivo no lo recibe, no lo lee y no lo manda.
 */

export interface Resultado {
  ok: boolean;
  mensaje: string;
  conflicto?: boolean;
  detalle?: ResultadoDeCorreccion;
  sessionId?: string;
}

function traducir(e: unknown): Resultado {
  if (e instanceof ConflictError) return { ok: false, mensaje: e.message, conflicto: true };
  if (e instanceof AppError) return { ok: false, mensaje: e.message };
  return { ok: false, mensaje: 'No se pudo completar la operación.' };
}

/**
 * Refresca lo que quedó viejo, y **nada más**.
 *
 * HALLAZGO que obligó a escribir este comentario: acá también se revalidaba
 * `/stock-erp/correcciones/mermas`, que es el formulario de la merma. Esa
 * pantalla genera su identificador idempotente en el servidor, una vez por
 * carga; revalidarla hacía que el navegador recibiera una carga nueva —con un
 * identificador NUEVO— inmediatamente después de cada registro. El efecto es
 * justo el contrario del buscado: si la respuesta se pierde en el camino y la
 * persona vuelve a confirmar, la segunda confirmación viaja con otra clave y la
 * pérdida se descuenta dos veces.
 *
 * Así que el formulario no se revalida: no muestra ninguna lista, no tiene nada
 * viejo que mostrar, y mantener su identificador estable mientras la pantalla
 * siga cargada es exactamente lo que hace seguro reintentar.
 */
function refrescar(extra?: string) {
  revalidatePath('/stock-erp/correcciones');
  revalidatePath('/stock-erp/correcciones/recuentos');
  revalidatePath('/stock-erp/existencias');
  revalidatePath('/stock-erp/movimientos');
  if (extra) revalidatePath(extra);
}

export async function registrarLaMerma(_p: Resultado | null, f: FormData): Promise<Resultado> {
  try {
    const user = await requireUser();
    const r = await registrarMerma(user, {
      /*
       * El identificador viene del formulario y es estable: lo genera la pantalla
       * una sola vez. Es lo que hace que dos clics manden la MISMA clave y la
       * segunda llamada encuentre la merma ya aplicada en vez de registrar dos.
       */
      mermaId: String(f.get('mermaId') ?? ''),
      branchId: String(f.get('branchId') ?? ''),
      productId: String(f.get('productId') ?? ''),
      cantidad: String(f.get('cantidad') ?? ''),
      categoria: String(f.get('categoria') ?? '') as StockWasteCategory,
      motivo: String(f.get('motivo') ?? ''),
      detalle: (String(f.get('detalle') ?? '').trim() || null) as string | null,
      confirmado: f.get('confirmado') === 'si',
    });
    refrescar();
    return {
      ok: true,
      detalle: r,
      mensaje: r.yaEstabaAplicada
        ? `Esta merma ya estaba registrada. No se duplicó nada: el saldo quedó en ${r.saldoResultante ?? '—'}.`
        : `Merma registrada. El saldo quedó en ${r.saldoResultante ?? '—'}.`,
    };
  } catch (e) {
    return traducir(e);
  }
}

export async function abrirElRecuento(_p: Resultado | null, f: FormData): Promise<Resultado> {
  try {
    const user = await requireUser();
    const { sessionId } = await abrirRecuento(user, {
      branchId: String(f.get('branchId') ?? ''),
      nombre: String(f.get('nombre') ?? ''),
    });
    refrescar(`/stock-erp/correcciones/recuentos/${sessionId}`);
    return { ok: true, mensaje: 'Recuento abierto. Cargá las cantidades contadas.', sessionId };
  } catch (e) {
    return traducir(e);
  }
}

export async function guardarLoContado(_p: Resultado | null, f: FormData): Promise<Resultado> {
  const sessionId = String(f.get('sessionId') ?? '');
  try {
    const user = await requireUser();
    const r = await guardarCantidadFisica(user, {
      sessionId,
      productId: String(f.get('productId') ?? ''),
      /* La cantidad FÍSICA. No existe ningún campo de diferencia. */
      cantidadFisica: String(f.get('cantidadFisica') ?? ''),
    });
    refrescar(`/stock-erp/correcciones/recuentos/${sessionId}`);
    return {
      ok: true,
      mensaje:
        r.diferencia === '0'
          ? 'Contado: coincide con el saldo del sistema.'
          : `Contado. El servidor calculó una diferencia de ${r.diferencia}.`,
    };
  } catch (e) {
    return traducir(e);
  }
}

export async function confirmarElAjuste(_p: Resultado | null, f: FormData): Promise<Resultado> {
  const sessionId = String(f.get('sessionId') ?? '');
  try {
    const user = await requireUser();
    const r = await confirmarLineaDeRecuento(user, {
      lineaId: String(f.get('lineaId') ?? ''),
      motivo: String(f.get('motivo') ?? ''),
      confirmado: f.get('confirmado') === 'si',
    });
    refrescar(`/stock-erp/correcciones/recuentos/${sessionId}`);
    return {
      ok: true,
      detalle: r,
      mensaje:
        r.movimientos === 0
          ? 'Coincidía: queda la constancia del recuento y no se escribió ningún movimiento.'
          : `Ajuste confirmado. El saldo quedó en ${r.saldoResultante ?? '—'}.`,
    };
  } catch (e) {
    return traducir(e);
  }
}

export async function cerrarElRecuento(_p: Resultado | null, f: FormData): Promise<Resultado> {
  const sessionId = String(f.get('sessionId') ?? '');
  try {
    const user = await requireUser();
    await cerrarRecuento(user, { sessionId });
    refrescar(`/stock-erp/correcciones/recuentos/${sessionId}`);
    return { ok: true, mensaje: 'Recuento cerrado.' };
  } catch (e) {
    return traducir(e);
  }
}

export async function revertirLaOperacion(_p: Resultado | null, f: FormData): Promise<Resultado> {
  const operationId = String(f.get('operationId') ?? '');
  try {
    const user = await requireUser();
    const r = await revertirOperacion(user, {
      operationId,
      motivo: String(f.get('motivo') ?? ''),
      confirmado: f.get('confirmado') === 'si',
    });
    refrescar(`/stock-erp/correcciones/reversiones/${operationId}`);
    return {
      ok: true,
      detalle: r,
      mensaje: r.yaEstabaAplicada
        ? 'Esta operación ya estaba revertida. No se duplicó nada.'
        : `Reversión confirmada: ${r.movimientos} ${r.movimientos === 1 ? 'movimiento inverso' : 'movimientos inversos'}. El libro conserva los asientos originales.`,
    };
  } catch (e) {
    return traducir(e);
  }
}

export async function cambiarElInterruptorDeCorrecciones(
  _p: Resultado | null,
  f: FormData,
): Promise<Resultado> {
  try {
    const user = await requireUser();
    await cambiarInterruptorDeCorrecciones(user, {
      encender: f.get('encender') === 'si',
      motivo: String(f.get('motivo') ?? ''),
    });
    refrescar();
    return { ok: true, mensaje: 'Interruptor de correcciones reales cambiado.' };
  } catch (e) {
    return traducir(e);
  }
}
