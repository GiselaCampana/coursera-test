import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import { handle, readJson } from '@/lib/api';
import { saveProduct } from '@/lib/services/admin';

interface AltaRapida {
  nombre: string;
  plu?: string | null;
  usaPlu: boolean;
  codigoBarras?: string | null;
  unidadCompra?: 'KG' | 'UNIT';
}

/**
 * Alta mínima desde la revisión de una factura.
 *
 * El objetivo es no obligar a salir del comprobante cuando aparece un artículo
 * realmente nuevo. La ficha completa (familia, marcajes específicos, etc.) se
 * puede completar después en Configuración > Productos.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const user = await requireUser();
    const input = await readJson<AltaRapida>(request);

    const form = new FormData();
    form.set('normalizedName', String(input.nombre ?? '').trim());
    form.set('internalCode', String(input.plu ?? '').trim());
    form.set('barcode', String(input.codigoBarras ?? '').trim());
    if (input.usaPlu) form.set('usesPlu', 'on');
    form.set('purchaseUnit', input.unidadCompra === 'UNIT' ? 'UNIT' : 'KG');
    form.set('saleMode', 'FETEABLE');
    form.set('targetMarginPct', '45');
    form.set('marginBasis', 'SOBRE_COSTO');
    form.set('roundingRule', 'NEAREST_100');
    form.set('active', 'on');

    const product = await saveProduct(user, form);
    return NextResponse.json({
      id: product.id,
      codigo: product.usesPlu ? product.internalCode : product.barcode ?? product.internalCode,
      nombre: product.normalizedName,
      codigosDeProveedor: [],
    });
  });
}
