import 'server-only';
import { NextResponse } from 'next/server';
import { errorCode, errorStatus, toUserMessage, AppError } from '@/lib/errors';

/**
 * Respuesta de error de la API.
 *
 * El cuerpo siempre trae un mensaje en castellano listo para mostrar. El
 * detalle técnico queda en el log del servidor, nunca en la pantalla.
 */
export interface ApiError {
  error: string;
  code: string;
  details?: unknown;
}

export function jsonError(error: unknown): NextResponse<ApiError> {
  const status = errorStatus(error);
  if (status >= 500) {
    console.error('[api] error inesperado', error);
  }
  return NextResponse.json(
    {
      error: toUserMessage(error),
      code: errorCode(error),
      details: error instanceof AppError ? error.details : undefined,
    },
    { status },
  );
}

/** Envuelve un handler para que ningún error salga sin traducir. */
export function handle<T>(fn: () => Promise<NextResponse<T>>): Promise<NextResponse<T | ApiError>> {
  return fn().catch((error) => jsonError(error));
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new AppError('No pudimos leer los datos enviados. Volvé a intentar.', {
      code: 'CUERPO_INVALIDO',
    });
  }
}
