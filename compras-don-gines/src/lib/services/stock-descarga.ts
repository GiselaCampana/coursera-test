import 'server-only';
import https from 'node:https';
import { AppError } from '@/lib/errors';
import { esDireccionPrivada, pareceIpv4 } from '@/lib/domain/red';

/**
 * Traer el catálogo de Control de Stock, desde el servidor.
 *
 * Desde el servidor y no desde el navegador, por una razón concreta: Safari
 * bloquea el pedido entre dominios y en el iPhone la sincronización no
 * arrancaba. El servidor no tiene ese problema, y además así el origen queda
 * fijado acá y no lo elige quien abre la pantalla.
 *
 * Hay dos caminos, y el segundo existe porque hizo falta: chatgpt.site resuelve
 * bien en Safari y, sin embargo, el DNS del servidor de Render a veces no lo
 * encuentra. En ese caso se resuelve el nombre por DNS-over-HTTPS y se abre TLS
 * contra la IP, mandando el nombre original como SNI y como Host. El
 * certificado se sigue validando: no se desactiva TLS en ningún caso.
 *
 * Ese segundo camino tiene un costo que hay que pagar aparte. Resolver el
 * nombre a mano saltea la protección que da resolverlo normalmente, así que
 * antes de conectarse se comprueba que la IP no sea de una red privada. Sin
 * eso, una respuesta de DNS manipulada podría hacer que el servidor de Compras
 * abra una conexión hacia adentro de la red de Render y traiga lo que
 * encuentre.
 */

/**
 * El origen.
 *
 * Fijado del lado del servidor: no llega por parámetro, ni por formulario, ni
 * por nada que pueda tocar quien abre la pantalla. Se puede configurar con
 * STOCK_CATALOG_URL —para apuntar a un entorno de prueba— y esa variable la
 * pone quien administra el servidor, no la aplicación.
 *
 * La configuración tiene sus propios límites: sólo https, salvo contra la
 * máquina local, que es lo que hace falta para las pruebas en el navegador. Un
 * origen configurado en http contra cualquier otro destino sería mandar el
 * pedido en claro sin que nada lo advierta.
 */
const HOST_POR_OMISION = 'control-stock-don-gines.gisela-campana.chatgpt.site';
const RUTA_POR_OMISION = '/api/integrations/catalog';

function origenConfigurado(): URL {
  const crudo = process.env.STOCK_CATALOG_URL?.trim();
  if (!crudo) return new URL(`https://${HOST_POR_OMISION}${RUTA_POR_OMISION}`);
  const url = new URL(crudo);
  const esLocal = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && esLocal)) {
    throw new Error(
      'STOCK_CATALOG_URL tiene que ser https (o http contra la máquina local, para pruebas).',
    );
  }
  return url;
}

const ORIGEN = origenConfigurado();
const HOST = ORIGEN.hostname;
const RUTA = `${ORIGEN.pathname}${ORIGEN.search}`;
const URL_CATALOGO = ORIGEN.toString();

/** Cuánto se espera antes de darse por vencido. */
const TIEMPO_LIMITE_MS = 12_000;
/** Cuánto se acepta leer. Un catálogo de Don Ginés no llega ni cerca. */
const TAMANO_LIMITE_BYTES = 5_000_000;

type RespuestaDoh = { Answer?: Array<{ type?: number; data?: string }> };

export const ORIGEN_DEL_CATALOGO = URL_CATALOGO;

/** Un error de descarga, ya redactado para mostrar en pantalla. */
function noSePudo(detalle: string): AppError {
  return new AppError(
    `No pude traer el catálogo de Control de Stock: ${detalle} No se modificó ningún dato. ` +
      'Probá de nuevo en unos segundos.',
    { status: 502, code: 'STOCK_NO_DISPONIBLE' },
  );
}

/**
 * Lee el cuerpo cortando en el límite.
 *
 * Se corta mientras llega y no después: leer entero y medir al final es
 * quedarse igual sin memoria con una respuesta que no debía aceptarse.
 */
async function leerConLimite(respuesta: Response): Promise<string> {
  const cuerpo = respuesta.body;
  if (!cuerpo) return '';
  const lector = cuerpo.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > TAMANO_LIMITE_BYTES) {
        throw noSePudo(`la respuesta supera los ${TAMANO_LIMITE_BYTES / 1_000_000} MB.`);
      }
      partes.push(value);
    }
  } finally {
    await lector.cancel().catch(() => {});
  }
  return Buffer.concat(partes.map((p) => Buffer.from(p))).toString('utf8');
}

async function resolverPorDoh(): Promise<string[]> {
  const respuesta = await fetch(
    `https://dns.google/resolve?name=${encodeURIComponent(HOST)}&type=A`,
    {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    },
  );
  if (!respuesta.ok) throw new Error(`DNS-over-HTTPS respondió ${respuesta.status}`);

  const datos = (await respuesta.json()) as RespuestaDoh;
  const crudas = (datos.Answer ?? [])
    .filter((a) => a.type === 1 && typeof a.data === 'string')
    .map((a) => a.data as string);

  /*
   * Se descarta lo que no sea una IPv4 pública.
   *
   * Es la comprobación que repone lo que se perdió al resolver el nombre a
   * mano. Una IP privada acá no es un caso raro que convenga tolerar: es
   * exactamente la forma que tendría el problema.
   */
  return crudas.filter((ip) => pareceIpv4(ip) && !esDireccionPrivada(ip));
}

function descargarPorIp(ip: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const pedido = https.request(
      {
        hostname: ip,
        port: 443,
        path: RUTA,
        method: 'GET',
        // El nombre original viaja como SNI y como Host: el certificado que se
        // valida sigue siendo el del dominio autorizado, no el de la IP.
        servername: HOST,
        headers: {
          host: HOST,
          accept: 'application/json',
          'user-agent': 'Compras-Don-Gines/1.0',
        },
        timeout: TIEMPO_LIMITE_MS,
        rejectUnauthorized: true,
      },
      (respuesta) => {
        const estado = respuesta.statusCode ?? 0;
        if (estado < 200 || estado >= 300) {
          respuesta.resume();
          reject(new Error(`Control de Stock respondió ${estado}`));
          return;
        }
        /*
         * No se sigue ninguna redirección.
         *
         * Una redirección acá llevaría a un destino que no es el dominio
         * autorizado, que es justo lo que este camino tiene que impedir.
         */

        let total = 0;
        const partes: Buffer[] = [];
        respuesta.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > TAMANO_LIMITE_BYTES) {
            pedido.destroy(new Error('la respuesta supera el tamaño máximo'));
            return;
          }
          partes.push(chunk);
        });
        respuesta.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
      },
    );

    pedido.on('timeout', () => pedido.destroy(new Error('se agotó el tiempo de espera')));
    pedido.on('error', reject);
    pedido.end();
  });
}

/** El texto crudo del catálogo. Quien lo valida es otro. */
export async function descargarCatalogoDeStock(): Promise<string> {
  let ultimoError: unknown;

  // Camino normal: el más rápido cuando el DNS del servidor funciona.
  try {
    const respuesta = await fetch(URL_CATALOGO, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
      // Una redirección sacaría el pedido del dominio autorizado.
      redirect: 'error',
    });
    if (!respuesta.ok) throw new Error(`Control de Stock respondió ${respuesta.status}`);
    const texto = await leerConLimite(respuesta);
    if (texto.trim() === '') throw new Error('la respuesta vino vacía');
    return texto;
  } catch (error) {
    if (error instanceof AppError) throw error;
    ultimoError = error;
  }

  // Camino de respaldo, sólo si el primero falló.
  try {
    const ips = await resolverPorDoh();
    for (const ip of ips) {
      try {
        const texto = await descargarPorIp(ip);
        if (texto.trim() !== '') return texto;
      } catch (error) {
        ultimoError = error;
      }
    }
    if (ips.length === 0) {
      ultimoError = new Error('el DNS no devolvió ninguna dirección pública utilizable');
    }
  } catch (error) {
    ultimoError = error;
  }

  console.error('No se pudo leer el catálogo de Control de Stock', ultimoError);
  const detalle = ultimoError instanceof Error ? ultimoError.message : 'no respondió.';
  throw noSePudo(`${detalle}.`);
}
