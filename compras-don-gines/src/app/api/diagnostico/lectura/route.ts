import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import { handle, readJson } from '@/lib/api';
import { analizarSinGuardar, type PaginaLeida } from '@/lib/services/lectura';

export const maxDuration = 60;

/**
 * Interpreta una lectura sin guardar nada.
 *
 * Es la contraparte de la pantalla de diagnóstico: corre los mismos
 * analizadores y los mismos autocontroles que la carga real, pero no toca la
 * base ni el almacenamiento. Sirve para entender por qué un comprobante no se
 * lee bien, sin ensuciar los datos ni gastar espacio.
 */
export async function POST(request: Request) {
  return handle(async () => {
    await requireUser();
    const { paginas } = await readJson<{ paginas: PaginaLeida[] }>(request);
    return NextResponse.json(analizarSinGuardar(paginas ?? []));
  });
}
