import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';
import { AppError } from '@/lib/errors';

/**
 * Almacenamiento privado de comprobantes.
 *
 * La interfaz es la misma para el driver local (desarrollo, o una instalación
 * chica con disco montado) y para cualquier storage compatible con S3. Los
 * archivos nunca se sirven públicamente: siempre a través de una URL firmada y
 * con vencimiento.
 */
export interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** URL temporal para ver o descargar el archivo. */
  signedUrl(key: string, ttlSeconds?: number): Promise<string>;
}

/** Evita que una clave arme un path fuera del directorio de storage. */
export function assertSafeKey(key: string): void {
  if (
    !key ||
    key.startsWith('/') ||
    key.includes('..') ||
    key.includes('\\') ||
    key.includes('\0') ||
    !/^[A-Za-z0-9/._-]+$/.test(key)
  ) {
    throw new AppError('La referencia al archivo no es válida.', {
      status: 400,
      code: 'CLAVE_INVALIDA',
    });
  }
}

// ---------------------------------------------------------------------------
// Firma de las URLs locales
// ---------------------------------------------------------------------------

function signature(key: string, expiresAt: number): string {
  return createHmac('sha256', env.storageSigningSecret)
    .update(`${key}:${expiresAt}`)
    .digest('base64url');
}

export function signLocalUrl(key: string, ttlSeconds: number): string {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = signature(key, expiresAt);
  return `/api/archivos/${key.split('/').map(encodeURIComponent).join('/')}?exp=${expiresAt}&sig=${sig}`;
}

export function verifyLocalSignature(key: string, exp: string | null, sig: string | null): boolean {
  if (!exp || !sig) return false;
  const expiresAt = Number(exp);
  if (!Number.isFinite(expiresAt)) return false;
  if (expiresAt * 1000 < Date.now()) return false;

  const expected = Buffer.from(signature(key, expiresAt));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// ---------------------------------------------------------------------------
// Fábrica
// ---------------------------------------------------------------------------

let cached: ObjectStorage | null = null;

export async function getStorage(): Promise<ObjectStorage> {
  if (cached) return cached;
  if (env.storageDriver === 'supabase') {
    const { SupabaseStorage } = await import('@/lib/storage/supabase');
    cached = new SupabaseStorage();
  } else if (env.storageDriver === 's3') {
    const { S3Storage } = await import('@/lib/storage/s3');
    cached = new S3Storage();
  } else {
    const { LocalStorage } = await import('@/lib/storage/local');
    cached = new LocalStorage();
  }
  return cached;
}

/** Sólo para las pruebas: fuerza a releer la configuración. */
export function resetStorageCache(): void {
  cached = null;
}

/** Clave estable y no adivinable para el archivo de un comprobante. */
export function buildDocumentKey(opts: {
  documentId: string;
  pageOrder: number;
  variant: 'work';
  extension: string;
}): string {
  const ext = opts.extension.replace(/^\./, '').toLowerCase();
  return `comprobantes/${opts.documentId}/${String(opts.pageOrder).padStart(2, '0')}-${opts.variant}.${ext}`;
}
