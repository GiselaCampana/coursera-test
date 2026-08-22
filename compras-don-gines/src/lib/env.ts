/**
 * Configuración por variables de entorno. Ninguna credencial vive en el código.
 *
 * Sólo DATABASE_URL es obligatoria para arrancar. El resto tiene valores por
 * defecto razonables para desarrollo, y `assertProductionEnv()` exige los que
 * no pueden faltar en producción.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Falta la variable de entorno ${name}. Copiá .env.example a .env y completala.`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value : fallback;
}

export type StorageDriver = 'local' | 's3';

export const env = {
  get databaseUrl(): string {
    return required('DATABASE_URL');
  },

  get nodeEnv(): string {
    return optional('NODE_ENV', 'development');
  },

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  },

  get appUrl(): string {
    return optional('APP_URL', 'http://localhost:3000');
  },

  // --- Storage ---
  get storageDriver(): StorageDriver {
    const v = optional('STORAGE_DRIVER', 'local');
    return v === 's3' ? 's3' : 'local';
  },

  get storageLocalDir(): string {
    return optional('STORAGE_LOCAL_DIR', './.storage');
  },

  /**
   * Secreto con el que se firman las URLs de los comprobantes. Sin él, el
   * enlace a una factura sería adivinable.
   */
  get storageSigningSecret(): string {
    const value = process.env.STORAGE_SIGNING_SECRET;
    if (!value || value.trim() === '') {
      if (this.isProduction) {
        throw new Error(
          'Falta STORAGE_SIGNING_SECRET. Generá uno con: openssl rand -base64 48',
        );
      }
      // Sólo para desarrollo: estable dentro del proceso, inútil fuera de él.
      return 'desarrollo-inseguro-cambiar-en-produccion';
    }
    return value;
  },

  get signedUrlTtlSeconds(): number {
    return Number(optional('SIGNED_URL_TTL_SECONDS', '900'));
  },

  get s3(): {
    bucket: string;
    region: string;
    endpoint?: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
  } {
    return {
      bucket: required('S3_BUCKET'),
      region: optional('S3_REGION', 'us-east-1'),
      endpoint: process.env.S3_ENDPOINT || undefined,
      accessKeyId: required('S3_ACCESS_KEY_ID'),
      secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
      forcePathStyle: optional('S3_FORCE_PATH_STYLE', 'false') === 'true',
    };
  },

  // --- Lectura automática ---
  /**
   * Reintentos de lectura enfocada antes de darse por vencido. La lectura corre
   * en el teléfono con Tesseract; no hay clave ni costo por comprobante.
   */
  get ocrMaxAttempts(): number {
    return Number(optional('OCR_MAX_ATTEMPTS', '3'));
  },

  // --- Carga de archivos ---
  get maxFilesPerDocument(): number {
    return Number(optional('MAX_FILES_PER_DOCUMENT', '10'));
  },

  get maxUploadBytes(): number {
    return Number(optional('MAX_UPLOAD_BYTES', String(25 * 1024 * 1024)));
  },
};

/** Se llama al arrancar en producción para fallar temprano y no a mitad de uso. */
export function assertProductionEnv(): void {
  required('DATABASE_URL');
  if (!process.env.STORAGE_SIGNING_SECRET) {
    throw new Error('Falta STORAGE_SIGNING_SECRET en producción.');
  }
  if (env.storageDriver === 's3') {
    required('S3_BUCKET');
    required('S3_ACCESS_KEY_ID');
    required('S3_SECRET_ACCESS_KEY');
  }
}
