import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import { handle, readJson } from '@/lib/api';
import { crearProductoRapido } from '@/lib/services/admin';

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

    const product = await crearProductoRapido(user, {
      nombre: input.nombre,
      plu: input.plu ?? null,
      usaPlu: input.usaPlu,
      codigoBarras: input.codigoBarras ?? null,
      unidadCompra: input.unidadCompra,
    });

    return NextResponse.json({
      id: product.id,
      codigo: product.usesPlu ? product.internalCode : product.barcode ?? product.internalCode,
      nombre: product.normalizedName,
      codigosDeProveedor: [],
    });
  });
}
