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

/** La primera de estas variables que esté cargada. Para nombres que cambiaron. */
function cualquiera(names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim() !== '') return value;
  }
  throw new Error(
    `Falta la variable de entorno ${names[0]} (o ${names.slice(1).join(' o ')}). ` +
      'Copiá .env.example a .env y completala.',
  );
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value : fallback;
}

export type StorageDriver = 'local' | 's3' | 'supabase';
export type AuthProvider = 'local' | 'supabase';

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
    if (v === 's3') return 's3';
    if (v === 'supabase') return 'supabase';
    return 'local';
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

  /**
   * Supabase: base, almacenamiento y autenticación en un solo proyecto.
   *
   * `serviceRoleKey` no puede llegar nunca al navegador: saltea todas las
   * políticas de seguridad. Por eso vive sólo acá, del lado del servidor, y
   * nunca en una variable NEXT_PUBLIC_.
   */
  get supabase(): {
    url: string;
    anonKey: string;
    serviceRoleKey: string;
    bucket: string;
  } {
    /*
     * Supabase tiene dos generaciones de claves y los proyectos nuevos vienen
     * con la segunda:
     *
     *   antes            ahora
     *   anon (JWT)   ->  sb_publishable_...   (pública, puede ir al navegador)
     *   service_role ->  sb_secret_...        (saltea todo: sólo en el servidor)
     *
     * Se aceptan los dos nombres para que no importe cuál muestre el panel el
     * día que alguien copie las variables.
     */
    return {
      url: required('SUPABASE_URL'),
      anonKey: cualquiera(['SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY']),
      serviceRoleKey: cualquiera(['SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY']),
      bucket: optional('SUPABASE_BUCKET', 'comprobantes'),
    };
  },

  /**
   * Cuánto espacio se permite ocupar, en bytes.
   *
   * Es una decisión nuestra, no un dato del proveedor: por eso no vive junto a
   * las credenciales de Supabase y se puede leer sin tenerlas. Por defecto, el
   * gigabyte del plan gratuito.
   */
  /**
   * Quién guarda y verifica las contraseñas.
   *
   * Por defecto `local`, que es lo que usan las pruebas y el desarrollo. En
   * producción se pone `supabase` una vez que el proyecto existe y los usuarios
   * están dados de alta ahí.
   */
  get authProvider(): AuthProvider {
    return optional('AUTH_PROVIDER', 'local') === 'supabase' ? 'supabase' : 'local';
  },

  get storageLimitBytes(): number {
    return Number(optional('STORAGE_LIMIT_BYTES', String(1024 * 1024 * 1024)));
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
  if (env.storageDriver === 'supabase' || env.authProvider === 'supabase') {
    // Con leerlas alcanza: `cualquiera` falla si no está ninguna de las dos.
    env.supabase;
  }
}
