import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import { ValidationError } from '@/lib/errors';
import { createDocument } from '@/lib/services/documents';
import { handle, readJson } from '@/lib/api';

/** Abre un comprobante en borrador para empezar a cargarle páginas. */
export async function POST(request: Request) {
  return handle(async () => {
    const user = await requireUser();
    const body = await readJson<{ branchId?: string }>(request);

    // Un operador siempre carga en su sucursal; el administrador elige.
    const branchId = user.scopeAllBranches ? body.branchId : (user.branchId ?? body.branchId);
    if (!branchId) {
      throw new ValidationError('Elegí la sucursal en la que estás cargando el comprobante.');
    }

    const document = await createDocument(user, branchId);
    return NextResponse.json({ id: document.id, branchId: document.branchId });
  });
}
