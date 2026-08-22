import 'server-only';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { env } from '@/lib/env';
import { NotFoundError } from '@/lib/errors';
import { assertSafeKey, signLocalUrl, type ObjectStorage } from '@/lib/storage';

/**
 * Guarda los comprobantes en disco, fuera de `public/`: el único camino para
 * leerlos es /api/archivos, que exige sesión y firma vigente.
 */
export class LocalStorage implements ObjectStorage {
  private readonly root: string;

  constructor(root: string = env.storageLocalDir) {
    this.root = path.resolve(root);
  }

  private resolve(key: string): string {
    assertSafeKey(key);
    const full = path.resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new NotFoundError('No encontramos el archivo.');
    }
    return full;
  }

  async put(key: string, body: Buffer, _contentType: string): Promise<void> {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body);
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await fs.readFile(this.resolve(key));
    } catch {
      throw new NotFoundError('No encontramos la imagen del comprobante.');
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.resolve(key));
    } catch {
      // Borrar algo que ya no está es un éxito.
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async signedUrl(key: string, ttlSeconds: number = env.signedUrlTtlSeconds): Promise<string> {
    assertSafeKey(key);
    return signLocalUrl(key, ttlSeconds);
  }
}
