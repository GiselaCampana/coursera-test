'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/session';
import { toUserMessage } from '@/lib/errors';
import {
  asociarRenglonHistorico,
  backfillProductLinks,
} from '@/lib/services/backfill-productos';

export interface ResultadoAsociacion {
  ok?: boolean;
  error?: string;
}

/** Paso 2: escribe las asociaciones que el análisis dio por seguras. */
export async function aplicarAsociaciones(
  _prev: ResultadoAsociacion,
  formData: FormData,
): Promise<ResultadoAsociacion> {
  const proveedor = String(formData.get('proveedor') ?? '');
  let aplicadas = 0;

  try {
    const user = await requireUser();
    const informe = await backfillProductLinks(user, {
      aplicar: true,
      supplierId: proveedor || undefined,
    });
    aplicadas = informe.aplicadas;
    revalidatePath('/configuracion/productos/asociaciones');
    revalidatePath('/compras');
    revalidatePath('/precios');
  } catch (error) {
    return { error: toUserMessage(error) };
  }

  /*
   * El aviso va en la página, no acá.
   *
   * Al aplicar cambia lo que la pantalla muestra —los renglones que se
   * asociaron ya no están en la lista— así que se vuelve a entrar con el
   * resultado en la dirección. `redirect` funciona lanzando, por eso va fuera
   * del try: adentro lo atraparía el catch y lo mostraría como un error.
   */
  redirect(
    `/configuracion/productos/asociaciones?aplicado=${aplicadas}` +
      (proveedor ? `&proveedor=${encodeURIComponent(proveedor)}` : ''),
  );
}

/** Resuelve a mano un renglón dudoso, y aprende el código si se pidió. */
export async function resolverAsociacion(
  _prev: ResultadoAsociacion,
  formData: FormData,
): Promise<ResultadoAsociacion> {
  try {
    const user = await requireUser();
    await asociarRenglonHistorico(
      user,
      String(formData.get('documentItemId') ?? ''),
      String(formData.get('productId') ?? ''),
      { aprenderCodigo: formData.get('aprenderCodigo') !== null },
    );
    revalidatePath('/configuracion/productos/asociaciones');
    revalidatePath('/compras');
    revalidatePath('/precios');
    return { ok: true };
  } catch (error) {
    return { error: toUserMessage(error) };
  }
}
