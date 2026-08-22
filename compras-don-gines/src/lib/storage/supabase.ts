import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';
import { AppError, NotFoundError } from '@/lib/errors';
import { assertSafeKey, type ObjectStorage } from '@/lib/storage';

/**
 * Almacenamiento en Supabase Storage.
 *
 * El bucket es **privado**: no tiene lectura pública y nunca se sirve un
 * archivo por URL directa. Cada vez que alguien abre un comprobante se pide una
 * URL firmada con vencimiento corto, y quién puede pedirla lo decide la
 * aplicación según el rol y la sucursal del usuario.
 *
 * Se usa la clave de servicio, que sólo vive en el servidor. Nunca llega al
 * navegador: si llegara, cualquiera podría leer todos los comprobantes de todas
 * las sucursales.
 */
export class SupabaseStorage implements ObjectStorage {
  private readonly cliente: SupabaseClient;
  private readonly bucket: string;

  constructor() {
    const cfg = env.supabase;
    this.bucket = cfg.bucket;
    this.cliente = createClient(cfg.url, cfg.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  private get almacen() {
    return this.cliente.storage.from(this.bucket);
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    assertSafeKey(key);
    const { error } = await this.almacen.upload(key, body, {
      contentType,
      upsert: true,
    });
    if (error) {
      throw new AppError('No pudimos guardar la imagen del comprobante. Volvé a intentar.', {
        status: 502,
        code: 'STORAGE_ESCRITURA',
        details: error.message,
      });
    }
  }

  async get(key: string): Promise<Buffer> {
    assertSafeKey(key);
    const { data, error } = await this.almacen.download(key);
    if (error || !data) {
      throw new NotFoundError('Esa imagen ya no está guardada.');
    }
    return Buffer.from(await data.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    const { error } = await this.almacen.remove([key]);
    // Borrar algo que ya no está no es un error: el resultado es el mismo.
    if (error && !/not found/i.test(error.message)) {
      throw new AppError('No pudimos borrar la imagen.', {
        status: 502,
        code: 'STORAGE_BORRADO',
        details: error.message,
      });
    }
  }

  async exists(key: string): Promise<boolean> {
    assertSafeKey(key);
    const barra = key.lastIndexOf('/');
    const carpeta = barra >= 0 ? key.slice(0, barra) : '';
    const nombre = barra >= 0 ? key.slice(barra + 1) : key;
    const { data, error } = await this.almacen.list(carpeta, { search: nombre, limit: 100 });
    if (error) return false;
    return (data ?? []).some((archivo) => archivo.name === nombre);
  }

  async signedUrl(key: string, ttlSeconds = env.signedUrlTtlSeconds): Promise<string> {
    assertSafeKey(key);
    const { data, error } = await this.almacen.createSignedUrl(key, ttlSeconds);
    if (error || !data?.signedUrl) {
      throw new NotFoundError('No pudimos generar el enlace a esa imagen.');
    }
    return data.signedUrl;
  }
}
