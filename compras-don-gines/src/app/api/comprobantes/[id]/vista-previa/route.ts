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

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser();
    const { id } = await params;

    /*
     * La decisión de pago viaja en el cuerpo, y el servicio la vuelve a
     * validar entera.
     *
     * Acá no se completa nada: si el cuerpo viene vacío y el proveedor no
     * tiene condición acordada, la llamada se rechaza. Es el mismo camino que
     * usa la pantalla, así que llamar directo a este POST no saltea ningún
     * control.
     */
    const cuerpo = await request.json().catch(() => ({}));
    const decision = (cuerpo as { pago?: unknown })?.pago ?? null;

    const resultado = await aplicarCompra(user, id, decision as never);
    return NextResponse.json({
      documentId: resultado.documentId,
      estado: resultado.report.state,
      aplicada: true,
    });
  });
}
