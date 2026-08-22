import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import { handle, readJson } from '@/lib/api';
import { ValidationError } from '@/lib/errors';
import { archivarImagenes, exportarZip, resumenParaArchivar } from '@/lib/services/archivado';
import { formatearBytes } from '@/lib/services/almacenamiento';

// Armar el ZIP implica bajar cada imagen del storage: con cientos de
// comprobantes puede llevar un rato.
export const maxDuration = 300;

function fechaDeCorte(valor: string | null): Date {
  if (!valor || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
    throw new ValidationError('Elegí una fecha válida para archivar.');
  }
  const fecha = new Date(`${valor}T00:00:00`);
  if (Number.isNaN(fecha.getTime())) {
    throw new ValidationError('Elegí una fecha válida para archivar.');
  }
  return fecha;
}

/** Resumen de lo que se archivaría, o el ZIP con las imágenes. */
export async function GET(request: Request) {
  return handle(async () => {
    const user = await requireUser();
    const url = new URL(request.url);
    const anteriorA = fechaDeCorte(url.searchParams.get('anteriorA'));

    if (url.searchParams.get('formato') === 'zip') {
      const { zip, nombre } = await exportarZip(user, anteriorA);
      return new NextResponse(new Uint8Array(zip), {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${nombre}"`,
          'Content-Length': String(zip.length),
          'Cache-Control': 'no-store',
        },
      }) as unknown as NextResponse<never>;
    }

    return NextResponse.json(await resumenParaArchivar(user, anteriorA));
  });
}

/** Borra las imágenes ya exportadas y libera el espacio. */
export async function POST(request: Request) {
  return handle(async () => {
    const user = await requireUser();
    const cuerpo = await readJson<{ anteriorA?: string; confirmoDescarga?: boolean }>(request);
    const anteriorA = fechaDeCorte(cuerpo.anteriorA ?? null);

    const resultado = await archivarImagenes(user, {
      anteriorA,
      confirmoDescarga: cuerpo.confirmoDescarga === true,
    });

    return NextResponse.json({
      ...resultado,
      bytesLiberadosLegible: formatearBytes(resultado.bytesLiberados),
    });
  });
}
