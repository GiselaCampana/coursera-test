'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/session';
import { toUserMessage } from '@/lib/errors';
import {
  asociarRenglonHistorico,
  backfillProductLinks,
  importarMapeoCodigosProveedor,
  crearProductoDesdeRenglon,
  type InformeMapeoCodigos,
} from '@/lib/services/backfill-productos';

export interface ResultadoAsociacion {
  ok?: boolean;
  error?: string;
}

export interface ResultadoMapeoCodigos {
  informe?: InformeMapeoCodigos;
  texto?: string;
  supplierId?: string;
  error?: string;
}

export async function analizarMapeoCodigos(
  _prev: ResultadoMapeoCodigos,
  formData: FormData,
): Promise<ResultadoMapeoCodigos> {
  try {
    const user = await requireUser();
    const supplierId = String(formData.get('supplierId') ?? '');
    const texto = String(formData.get('texto') ?? '');
    if (!supplierId) return { error: 'Elegí primero un proveedor.' };
    if (!texto.trim()) return { error: 'Pegá o cargá el mapeo Código proveedor + PLU.' };
    const informe = await importarMapeoCodigosProveedor(user, supplierId, texto);
    return { informe, texto, supplierId };
  } catch (error) {
    return { error: toUserMessage(error) };
  }
}

export async function aplicarMapeoCodigos(
  _prev: ResultadoMapeoCodigos,
  formData: FormData,
): Promise<ResultadoMapeoCodigos> {
  try {
    const user = await requireUser();
    const supplierId = String(formData.get('supplierId') ?? '');
    const texto = String(formData.get('texto') ?? '');
    await importarMapeoCodigosProveedor(user, supplierId, texto, { aplicar: true });
    revalidatePath('/configuracion/productos/asociaciones');
    revalidatePath('/configuracion/productos');
    return { informe: undefined, texto: '', supplierId, error: undefined };
  } catch (error) {
    return { error: toUserMessage(error) };
  }
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


export async function crearProductoYAsociar(
  _prev: ResultadoAsociacion,
  formData: FormData,
): Promise<ResultadoAsociacion> {
  try {
    const user = await requireUser();
    await crearProductoDesdeRenglon(user, {
      documentItemId: String(formData.get('documentItemId') ?? ''),
      internalCode: String(formData.get('internalCode') ?? '') || null,
      normalizedName: String(formData.get('normalizedName') ?? ''),
      usesPlu: formData.get('usesPlu') === 'on',
      barcode: String(formData.get('barcode') ?? '') || null,
      saleMode: String(formData.get('saleMode') ?? 'FETEABLE') === 'AL_CORTE' ? 'AL_CORTE' : 'FETEABLE',
      purchaseUnit: String(formData.get('purchaseUnit') ?? 'KG') === 'UNIT' ? 'UNIT' : 'KG',
      purchaseUnitWeightKg: String(formData.get('purchaseUnitWeightKg') ?? '') || null,
    });
    revalidatePath('/configuracion/productos/asociaciones');
    revalidatePath('/configuracion/productos');
    revalidatePath('/compras');
    revalidatePath('/precios');
    return { ok: true };
  } catch (error) {
    return { error: toUserMessage(error) };
  }
}
