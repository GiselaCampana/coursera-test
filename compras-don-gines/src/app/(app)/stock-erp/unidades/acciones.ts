'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/session';
import {
  aprobarUnidadDeExistencia,
  guardarPresentacion,
  reconocerDiscrepancia,
  type UnidadDeStock,
} from '@/lib/services/stock-erp-unidades';
import { AppError } from '@/lib/errors';

/**
 * Las acciones de la pantalla de unidades.
 *
 * Son cáscaras finas a propósito: leen el formulario, llaman al servicio y
 * traducen el error a un texto. **Ninguna regla vive acá.** El permiso, la
 * doble confirmación, el motivo obligatorio y la barrera de los movimientos los
 * decide el servicio, que es lo que corre aunque alguien mande el pedido sin
 * pasar por esta pantalla.
 */

export interface Resultado {
  ok: boolean;
  mensaje: string;
}

function traducir(e: unknown): Resultado {
  if (e instanceof AppError) return { ok: false, mensaje: e.message };
  return { ok: false, mensaje: 'No se pudo completar la operación.' };
}

export async function aprobarUnidad(_previo: Resultado | null, formData: FormData): Promise<Resultado> {
  try {
    const user = await requireUser();
    const unidad = String(formData.get('unidad') ?? '') as UnidadDeStock;
    await aprobarUnidadDeExistencia(user, {
      productId: String(formData.get('productId') ?? ''),
      unidad,
      motivo: (formData.get('motivo') as string | null)?.trim() || null,
      notas: (formData.get('notas') as string | null)?.trim() || null,
      /* La doble confirmación viaja hasta el servidor y allá se exige. */
      confirmado: formData.get('confirmado') === 'si',
    });
    revalidatePath('/stock-erp/unidades');
    return { ok: true, mensaje: `Unidad de existencia fijada en ${unidad}.` };
  } catch (e) {
    return traducir(e);
  }
}

export async function guardarPresentacionDeCompra(
  _previo: Resultado | null,
  formData: FormData,
): Promise<Resultado> {
  try {
    const user = await requireUser();
    await guardarPresentacion(user, {
      productId: String(formData.get('productId') ?? ''),
      proveedorId: (formData.get('proveedorId') as string | null) || null,
      codigoDelProveedor: (formData.get('codigoDelProveedor') as string | null) || null,
      unidadDeCompra: String(formData.get('unidadDeCompra') ?? '') as UnidadDeStock,
      /* Como texto. Convertirlo a número acá perdería exactitud antes de llegar. */
      factor: String(formData.get('factor') ?? ''),
      descripcion: (formData.get('descripcion') as string | null)?.trim() || null,
      aprobar: formData.get('aprobar') === 'si',
      confirmado: formData.get('confirmado') === 'si',
    });
    revalidatePath('/stock-erp/unidades');
    return { ok: true, mensaje: 'Presentación de compra guardada.' };
  } catch (e) {
    return traducir(e);
  }
}

export async function reconocerLaDiscrepancia(
  _previo: Resultado | null,
  formData: FormData,
): Promise<Resultado> {
  try {
    const user = await requireUser();
    await reconocerDiscrepancia(user, {
      productId: String(formData.get('productId') ?? ''),
      motivo: String(formData.get('motivo') ?? ''),
    });
    revalidatePath('/stock-erp/unidades');
    return { ok: true, mensaje: 'Discrepancia reconocida y registrada.' };
  } catch (e) {
    return traducir(e);
  }
}
