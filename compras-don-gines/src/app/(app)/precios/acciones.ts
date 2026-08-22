'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/session';
import { toUserMessage } from '@/lib/errors';
import { approveSalePrice } from '@/lib/services/pricing';

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
