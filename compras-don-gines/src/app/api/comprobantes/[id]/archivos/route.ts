import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import { AppError, ValidationError } from '@/lib/errors';
import { addFiles, removeFile, reorderFiles } from '@/lib/services/documents';
import { handle, readJson } from '@/lib/api';
import { env } from '@/lib/env';

export const maxDuration = 120;

/** Suma páginas al comprobante: fotos de cámara, de galería o PDF. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser();
    const { id } = await params;

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new AppError(
        'No pudimos recibir las imágenes. Puede ser un problema de conexión: volvé a intentar.',
        { code: 'FORMULARIO_INVALIDO' },
      );
    }

    const entries = form.getAll('archivos');
    if (entries.length === 0) {
      throw new ValidationError('No llegó ninguna imagen. Elegí una foto o un PDF.');
    }
    if (entries.length > env.maxFilesPerDocument) {
      throw new ValidationError(
        `Podés cargar hasta ${env.maxFilesPerDocument} imágenes por comprobante.`,
      );
    }

    const files = [];
    for (const entry of entries) {
      if (!(entry instanceof File)) continue;
      files.push({
        buffer: Buffer.from(await entry.arrayBuffer()),
        filename: entry.name,
        mimeType: entry.type,
      });
    }
    if (files.length === 0) {
      throw new ValidationError('No llegó ninguna imagen válida. Probá sacar la foto de nuevo.');
    }

    const result = await addFiles(user, id, files);
    return NextResponse.json(result);
  });
}

/** Reordena las páginas. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser();
    const { id } = await params;
    const body = await readJson<{ orden?: string[] }>(request);
    if (!Array.isArray(body.orden)) {
      throw new ValidationError('Faltó indicar el nuevo orden de las páginas.');
    }
    await reorderFiles(user, id, body.orden);
    return NextResponse.json({ ok: true });
  });
}

/** Quita una página. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser();
    const { id } = await params;
    const fileId = new URL(request.url).searchParams.get('archivo');
    if (!fileId) throw new ValidationError('Faltó indicar qué imagen querés quitar.');
    await removeFile(user, id, fileId);
    return NextResponse.json({ ok: true });
  });
}
