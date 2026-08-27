'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/session';
import { toUserMessage } from '@/lib/errors';
import { approveSalePrice, updateProductPriceConfig } from '@/lib/services/pricing';

export interface ResultadoPrecio {
  ok?: boolean;
  error?: string;
  productId?: string;
}

export async function aprobarPrecio(
  _prev: ResultadoPrecio,
  formData: FormData,
): Promise<ResultadoPrecio> {
  const productId = String(formData.get('productId') ?? '');
  try {
    const user = await requireUser();
    await approveSalePrice(user, {
      productId,
      approvedPricePerKg: String(formData.get('precio') ?? ''),
      validFrom: String(formData.get('vigencia') ?? '') || null,
    });
    revalidatePath('/precios');
    return { ok: true, productId };
  } catch (error) {
    return { error: toUserMessage(error), productId };
  }
}


export interface ResultadoConfigPrecio {
  ok?: boolean;
  error?: string;
  productId?: string;
}

export async function guardarConfigPrecio(
  _prev: ResultadoConfigPrecio,
  formData: FormData,
): Promise<ResultadoConfigPrecio> {
  const productId = String(formData.get('productId') ?? '');
  try {
    const user = await requireUser();
    await updateProductPriceConfig(user, {
      productId,
      targetMarginPct: String(formData.get('targetMarginPct') ?? ''),
      marginBasis: String(formData.get('marginBasis') ?? 'SOBRE_COSTO') as 'SOBRE_COSTO' | 'SOBRE_VENTA',
      alCorteHormaDigitalMarginPct: String(formData.get('alCorteHormaDigitalMarginPct') ?? '') || null,
      alCorteHormaCashMarginPct: String(formData.get('alCorteHormaCashMarginPct') ?? '') || null,
      alCorteCajaCashMarginPct: String(formData.get('alCorteCajaCashMarginPct') ?? '') || null,
      feteado100gMarginPct: String(formData.get('feteado100gMarginPct') ?? '') || null,
      feteadoQuarterMarginPct: String(formData.get('feteadoQuarterMarginPct') ?? '') || null,
      feteadoPieceDigitalMarginPct: String(formData.get('feteadoPieceDigitalMarginPct') ?? '') || null,
      feteadoPieceCashMarginPct: String(formData.get('feteadoPieceCashMarginPct') ?? '') || null,
      wholeUnitMarginPct: String(formData.get('wholeUnitMarginPct') ?? '') || null,
      roundingRule: String(formData.get('roundingRule') ?? 'NEAREST_100') as
        | 'NONE'
        | 'NEAREST_10'
        | 'NEAREST_50'
        | 'NEAREST_100'
        | 'UP_10'
        | 'UP_50'
        | 'UP_100',
      saleMode: String(formData.get('saleMode') ?? 'FETEABLE') as 'FETEABLE' | 'AL_CORTE',
      purchaseUnit: String(formData.get('purchaseUnit') ?? 'KG') as 'KG' | 'UNIT',
      purchaseUnitWeightKg: String(formData.get('purchaseUnitWeightKg') ?? '') || null,
    });
    revalidatePath('/precios');
    revalidatePath('/configuracion/productos');
    return { ok: true, productId };
  } catch (error) {
    return { error: toUserMessage(error), productId };
  }
}
