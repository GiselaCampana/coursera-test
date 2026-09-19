import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import { handle } from '@/lib/api';
import { aplicarCompra, vistaPreviaDeCompra } from '@/lib/services/vista-previa-compra';

/**
 * Lo que va a pasar si se confirma esta compra.
 *
 * `GET` no escribe nada: es la vista previa. `POST` es la confirmación
 * explícita, y no aplica nada si la vista previa trae frenos.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser();
    const { id } = await params;
    return NextResponse.json(await vistaPreviaDeCompra(user, id));
  });
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser();
    const { id } = await params;
    const resultado = await aplicarCompra(user, id);
    return NextResponse.json({
      documentId: resultado.documentId,
      estado: resultado.report.state,
      aplicada: true,
    });
  });
}
