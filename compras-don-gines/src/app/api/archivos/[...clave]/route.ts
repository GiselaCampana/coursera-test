import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import { assertBranchAccess } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { NotFoundError } from '@/lib/errors';
import { getStorage, verifyLocalSignature } from '@/lib/storage';
import { env } from '@/lib/env';
import { handle, jsonError } from '@/lib/api';

/**
 * Entrega la imagen o el PDF de un comprobante.
 *
 * Tres cierres, no uno: hay que tener sesión, la firma de la URL tiene que
 * estar vigente y el archivo tiene que pertenecer a una sucursal a la que el
 * usuario tenga alcance. Los archivos viven fuera de `public/`, así que este es
 * el único camino para llegar a ellos.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ clave: string[] }> },
) {
  return handle(async () => {
    const { clave } = await params;
    const key = clave.map(decodeURIComponent).join('/');
    const url = new URL(request.url);

    if (!verifyLocalSignature(key, url.searchParams.get('exp'), url.searchParams.get('sig'))) {
      return jsonError(
        new NotFoundError('El enlace a este comprobante venció. Volvé a abrir el comprobante.'),
      ) as NextResponse<never>;
    }

    const user = await requireUser();
    const file = await prisma.documentFile.findFirst({
      where: { OR: [{ storageKey: key }, { originalKey: key }] },
      include: { document: { select: { branchId: true } } },
    });
    if (!file) throw new NotFoundError('No encontramos ese archivo.');
    assertBranchAccess(user, file.document.branchId);

    const storage = await getStorage();
    const body = await storage.get(key);
    const mime = key === file.originalKey ? (file.originalMimeType ?? file.mimeType) : file.mimeType;

    return new NextResponse(new Uint8Array(body), {
      headers: {
        'Content-Type': mime,
        'Content-Length': String(body.length),
        // Privado: nunca lo cachea un proxy compartido.
        'Cache-Control': `private, max-age=${env.signedUrlTtlSeconds}`,
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
      },
    }) as NextResponse<never>;
  });
}
