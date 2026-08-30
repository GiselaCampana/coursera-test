'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/session';
import { AppError, toUserMessage } from '@/lib/errors';
import https from 'node:https';
import {
  importarCatalogo,
  type InformeDeCatalogo,
  type OrigenDeFamilia,
} from '@/lib/services/catalogo';

export interface ResultadoImportacion {
  informe?: InformeDeCatalogo;
  /** El archivo leído, para poder aplicarlo después sin volver a subirlo. */
  texto?: string;
  /** De qué columna se propuso la familia, para aplicar lo mismo que se miró. */
  familiaDesde?: OrigenDeFamilia;
  error?: string;
}

const ORIGENES: OrigenDeFamilia[] = ['auto', 'tipo', 'subtipo', 'ninguna'];

const STOCK_CATALOG_HOST =
  'control-stock-don-gines.gisela-campana.chatgpt.site';
const STOCK_CATALOG_PATH = '/api/integrations/catalog';
const STOCK_CATALOG_URL = `https://${STOCK_CATALOG_HOST}${STOCK_CATALOG_PATH}`;

type DnsGoogleResponse = {
  Answer?: Array<{ type?: number; data?: string }>;
};

async function resolverStockPorDoh(): Promise<string[]> {
  const respuesta = await fetch(
    `https://dns.google/resolve?name=${encodeURIComponent(STOCK_CATALOG_HOST)}&type=A`,
    {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    },
  );
  if (!respuesta.ok) {
    throw new Error(`DNS-over-HTTPS respondió ${respuesta.status}`);
  }

  const datos = (await respuesta.json()) as DnsGoogleResponse;
  return (datos.Answer ?? [])
    .filter((a) => a.type === 1 && typeof a.data === 'string')
    .map((a) => a.data as string);
}

async function descargarStockPorIp(ip: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const pedido = https.request(
      {
        hostname: ip,
        port: 443,
        path: STOCK_CATALOG_PATH,
        method: 'GET',
        servername: STOCK_CATALOG_HOST,
        headers: {
          host: STOCK_CATALOG_HOST,
          accept: 'application/json',
          'user-agent': 'Compras-Don-Gines/1.0',
        },
        timeout: 12_000,
        rejectUnauthorized: true,
      },
      (respuesta) => {
        const estado = respuesta.statusCode ?? 0;
        if (estado < 200 || estado >= 300) {
          respuesta.resume();
          reject(new Error(`Control de Stock respondió ${estado}`));
          return;
        }

        let total = 0;
        const partes: Buffer[] = [];
        respuesta.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > 5_000_000) {
            pedido.destroy(new Error('El catálogo de Control de Stock supera 5 MB.'));
            return;
          }
          partes.push(chunk);
        });
        respuesta.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
      },
    );

    pedido.on('timeout', () => pedido.destroy(new Error('Timeout leyendo Control de Stock')));
    pedido.on('error', reject);
    pedido.end();
  });
}

async function leerCatalogoDeStock(): Promise<string> {
  let ultimoError: unknown;

  // Camino normal. Es el más rápido cuando el DNS del host funciona en Render.
  try {
    const respuesta = await fetch(STOCK_CATALOG_URL, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!respuesta.ok) {
      throw new Error(`Control de Stock respondió ${respuesta.status}`);
    }
    const texto = await respuesta.text();
    if (!texto.trim()) throw new Error('catálogo vacío');
    return texto;
  } catch (error) {
    ultimoError = error;
  }

  /*
   * chatgpt.site puede resolver en Safari y, sin embargo, fallar en el DNS del
   * servidor de Render. En ese caso resolvemos el A mediante DNS-over-HTTPS y
   * abrimos TLS contra la IP usando el hostname original como SNI/Host.
   * Seguimos validando el certificado: no se desactiva TLS.
   */
  try {
    const ips = await resolverStockPorDoh();
    for (const ip of ips) {
      try {
        const texto = await descargarStockPorIp(ip);
        if (texto.trim()) return texto;
      } catch (error) {
        ultimoError = error;
      }
    }
  } catch (error) {
    ultimoError = error;
  }

  console.error('No se pudo leer catálogo de Control de Stock', ultimoError);
  throw new AppError(
    'No pude conectarme con Control de Stock automáticamente. No se modificó ningún dato. Probá nuevamente en unos segundos.',
    { status: 502, code: 'STOCK_NO_DISPONIBLE' },
  );
}

function leerOrigen(valor: FormDataEntryValue | null): OrigenDeFamilia {
  const v = String(valor ?? 'auto') as OrigenDeFamilia;
  return ORIGENES.includes(v) ? v : 'auto';
}

/**
 * Paso 1: mirar el archivo sin escribir nada.
 *
 * Lo que devuelve es exactamente lo que el paso 2 va a hacer, calculado con el
 * mismo recorrido. Una vista previa que estima por su cuenta es una vista
 * previa que puede mentir.
 */
export async function analizarCatalogo(
  _prev: ResultadoImportacion,
  formData: FormData,
): Promise<ResultadoImportacion> {
  let texto = String(formData.get('texto') ?? '');
  const familiaDesde = leerOrigen(formData.get('familiaDesde'));
  const origen = String(formData.get('origen') ?? 'archivo');

  try {
    if (origen === 'stock') {
      texto = await leerCatalogoDeStock();
    } else if (texto.trim() === '') {
      return { error: 'Elegí el archivo del catálogo, pegá su contenido o traelo desde Control de Stock.' };
    }

    const user = await requireUser();
    const informe = await importarCatalogo(user, texto, { familiaDesde });
    return { informe, texto, familiaDesde };
  } catch (error) {
    return { error: toUserMessage(error) };
  }
}

/** Paso 2: aplicarlo, con la confirmación ya dada. */
export async function aplicarCatalogo(
  _prev: ResultadoImportacion,
  formData: FormData,
): Promise<ResultadoImportacion> {
  const texto = String(formData.get('texto') ?? '');
  /*
   * Se aplica con el mismo origen de familia con el que se hizo la vista
   * previa. Si acá se recalculara con otro, lo que se escribe no sería lo que
   * la persona miró y confirmó.
   */
  const familiaDesde = leerOrigen(formData.get('familiaDesde'));
  let informe: InformeDeCatalogo;
  try {
    const user = await requireUser();
    informe = await importarCatalogo(user, texto, { aplicar: true, familiaDesde });
    revalidatePath('/configuracion/catalogo');
    revalidatePath('/configuracion/productos');
    // El catálogo cambia lo que se puede filtrar en Compras y lo que Precios
    // tiene para mostrar.
    revalidatePath('/compras');
    revalidatePath('/precios');
  } catch (error) {
    return { error: toUserMessage(error) };
  }

  // Fuera del try: `redirect` funciona lanzando.
  const params = new URLSearchParams({
    importado: '1',
    nuevos: String(informe.nuevos.length),
    act: String(informe.actualizables.length),
    cod: String(informe.codigosPorAprender.length),
    conf: String(informe.conflictos.length),
    fam: String(informe.familiasNuevas.length),
  });
  redirect(`/configuracion/catalogo?${params.toString()}`);
}
