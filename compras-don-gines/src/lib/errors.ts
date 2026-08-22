/**
 * Errores de la aplicación.
 *
 * Regla del proyecto: al usuario nunca le llega un mensaje técnico en inglés
 * como "The string did not match the expected pattern". Todo lo que sale a la
 * pantalla está en castellano y dice qué pasó y qué se puede hacer.
 */

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, opts: { status?: number; code?: string; details?: unknown } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = opts.status ?? 400;
    this.code = opts.code ?? 'ERROR';
    this.details = opts.details;
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Necesitás iniciar sesión para continuar.') {
    super(message, { status: 401, code: 'NO_AUTENTICADO' });
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Tu usuario no tiene permiso para hacer esto.') {
    super(message, { status: 403, code: 'SIN_PERMISO' });
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'No encontramos lo que estabas buscando.') {
    super(message, { status: 404, code: 'NO_ENCONTRADO' });
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, { status: 422, code: 'DATOS_INVALIDOS', details });
    this.name = 'ValidationError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, { status: 409, code: 'CONFLICTO', details });
    this.name = 'ConflictError';
  }
}

/**
 * Traduce los errores que sí o sí van a aparecer (Safari, Prisma, red) a algo
 * que una persona pueda entender y accionar.
 */
const TRANSLATIONS: { match: RegExp; message: string }[] = [
  {
    // El clásico de Safari en iPhone cuando el `accept` del input no matchea.
    match: /string did not match the expected pattern/i,
    message:
      'El teléfono no pudo procesar ese archivo. Probá sacar la foto de nuevo o elegir otra imagen de la galería.',
  },
  {
    match: /the operation (was aborted|couldn.t be completed)/i,
    message: 'Se interrumpió la operación. Revisá la conexión y volvé a intentar.',
  },
  {
    match: /network\s?error|failed to fetch|load failed/i,
    message: 'No pudimos conectarnos con el servidor. Revisá la conexión y volvé a intentar.',
  },
  {
    match: /aborted|timeout|timed out|ETIMEDOUT/i,
    message: 'La operación tardó demasiado y se cortó. Volvé a intentar en un momento.',
  },
  {
    match: /unique constraint|P2002/i,
    message: 'Ya existe un registro con esos datos.',
  },
  {
    match: /foreign key constraint|P2003/i,
    message: 'No se puede completar porque hay datos relacionados que dependen de este registro.',
  },
  {
    match: /P2025|record to update not found/i,
    message: 'El registro que querías modificar ya no existe.',
  },
  {
    match: /ECONNREFUSED|Can't reach database server|P1001/i,
    message: 'No hay conexión con la base de datos. Avisale al administrador del sistema.',
  },
  {
    match: /413|payload too large|request entity too large/i,
    message:
      'La imagen pesa demasiado incluso después de optimizarla. Probá sacar la foto de nuevo con menos resolución.',
  },
  {
    match: /heic|heif/i,
    message: 'No pudimos convertir la foto HEIC del iPhone. Probá sacarla de nuevo.',
  },
  {
    // El navegador no pudo decodificar el archivo: no era una imagen, o vino
    // cortado. Pasa con un .zip renombrado y con descargas interrumpidas.
    match: /could not be decoded|source image|decoding|not a valid image|createImageBitmap/i,
    message:
      'No pudimos abrir ese archivo como imagen. Aceptamos fotos JPG, PNG, WEBP o HEIC, y PDF.',
  },
  {
    match: /out of memory|allocation failed|maximum call stack/i,
    message:
      'La foto es demasiado grande para procesarla en el teléfono. Probá sacarla de nuevo con menos resolución.',
  },
];

export function toUserMessage(error: unknown): string {
  if (error instanceof AppError) return error.message;

  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Ocurrió un error inesperado.';

  for (const { match, message } of TRANSLATIONS) {
    if (match.test(raw)) return message;
  }

  /*
   * Todo lo demás se reemplaza por un mensaje genérico, sin mirar cómo está
   * escrito.
   *
   * Antes se intentaba detectar si el texto "parecía técnico" —inglés, sin
   * acentos, con palabras como error o invalid—. La heurística falló de la peor
   * manera: un error de Prisma llegó a la pantalla porque en el volcado de la
   * consulta venían embebidos nuestros propios mensajes de control, con sus
   * acentos, y eso alcanzó para que pasara por castellano.
   *
   * La regla ahora es al revés y no depende de adivinar: se muestra lo que la
   * aplicación escribió a propósito (AppError y sus derivados) y las
   * traducciones de arriba. Cualquier otra cosa es un problema nuestro, va al
   * log y al usuario le llega algo que pueda entender.
   */
  return 'Ocurrió un error inesperado. Volvé a intentar; si sigue pasando, avisale al administrador.';
}

export function errorStatus(error: unknown): number {
  return error instanceof AppError ? error.status : 500;
}

export function errorCode(error: unknown): string {
  return error instanceof AppError ? error.code : 'ERROR_INTERNO';
}
