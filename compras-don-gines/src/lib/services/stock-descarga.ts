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

/**
 * La clave con la que Control de Stock nos reconoce.
 *
 * Vive sólo en el entorno del servidor. No es NEXT_PUBLIC_, no viaja al
 * navegador, no entra en ninguna respuesta y no se escribe en ningún registro:
 * el único lugar donde aparece es el encabezado del pedido saliente.
 *
 * El encabezado quedó confirmado contra el endpoint real, probando con un valor
 * ficticio: sin encabezado contesta «INTEGRATION_KEY_REQUIRED», y con
 * `Authorization: Bearer <lo que sea>` contesta «INVALID_INTEGRATION_KEY». Es
 * decir que lee ese encabezado y ese esquema. Por eso `Authorization` es el
 * valor canónico y no hay que configurarlo; STOCK_INTEGRATION_HEADER queda
 * solamente por si Control de Stock lo cambia, para poder seguirlo sin
 * desplegar.
 */
const NOMBRE_CLAVE = 'STOCK_INTEGRATION_KEY';
const NOMBRE_ENCABEZADO = 'STOCK_INTEGRATION_HEADER';
const ENCABEZADO_CANONICO = 'Authorization';

interface Credenciales {
  encabezado: string;
  /** Lo que se manda: ya con el esquema puesto, no la clave cruda. */
  valor: string;
}

/** Falta configuración. Se dice sin nombrar ningún valor. */
function noConfigurada(): AppError {
  return new AppError('La integración con Control de Stock no está configurada', {
    status: 503,
    code: 'STOCK_SIN_CONFIGURAR',
  });
}

/** Control de Stock nos rechazó. Tampoco acá se repite nada de lo enviado. */
function claveRechazada(): AppError {
  return new AppError('La clave de integración fue rechazada', {
    status: 502,
    code: 'STOCK_CLAVE_RECHAZADA',
  });
}

/**
 * Arma el valor del encabezado: el esquema lo pone el código, no la variable.
 *
 * `Authorization` no lleva la clave cruda: lleva un esquema y después la
 * credencial. Mandar la clave sola en ese encabezado es exactamente el error
 * que Control de Stock contesta con 401, así que el «Bearer » no puede quedar
 * librado a que quien carga el secreto se acuerde de escribirlo.
 *
 * Y si igual lo escribió, no se duplica: una clave que ya viene con el
 * prefijo se normaliza en vez de convertirse en «Bearer Bearer …». Es un error
 * de configuración fácil de cometer y que del otro lado se vería igual que una
 * clave equivocada.
 *
 * Un encabezado que no sea `Authorization` no lleva esquema: los encabezados
 * propios —un `x-api-key`, por ejemplo— llevan la credencial sola.
 */
function valorDelEncabezado(encabezado: string, clave: string): string {
  if (encabezado.toLowerCase() !== 'authorization') return clave;
  const yaTraePrefijo = /^bearer\s+/i.exec(clave);
  return `Bearer ${yaTraePrefijo ? clave.slice(yaTraePrefijo[0].length) : clave}`;
}

/**
 * Lee las credenciales del entorno, o falla antes de salir a la red.
 *
 * Antes de cualquier pedido: sin clave no hay nada que intentar, y fallar
 * temprano evita mandar un pedido incompleto que del otro lado quede
 * registrado como un intento fallido de autenticación.
 */
function credenciales(): Credenciales {
  const clave = process.env[NOMBRE_CLAVE]?.trim();
  if (!clave) throw noConfigurada();
  const encabezado = process.env[NOMBRE_ENCABEZADO]?.trim() || ENCABEZADO_CANONICO;
  return { encabezado, valor: valorDelEncabezado(encabezado, clave) };
}

/**
 * Saca la clave de un texto que va a mostrarse o registrarse.
 *
 * No debería hacer falta —la clave viaja en un encabezado y no en la URL ni en
 * el cuerpo— y justamente por eso está: es barato, y el día que alguien sume un
 * camino nuevo que la incluya sin darse cuenta, esto la tapa igual.
 */
export function sinLaClave(texto: string): string {
  const clave = process.env[NOMBRE_CLAVE]?.trim();
  if (!clave || clave.length < 4) return texto;
  return texto.split(clave).join('«clave oculta»');
}

/** Un error de descarga, ya redactado para mostrar en pantalla. */
function noSePudo(detalle: string): AppError {
  return new AppError(
    sinLaClave(
      `No pude traer el catálogo de Control de Stock: ${detalle} No se modificó ningún dato. ` +
        'Probá de nuevo en unos segundos.',
    ),
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

function descargarPorIp(ip: string, credencial: Credenciales): Promise<string> {
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
          [credencial.encabezado]: credencial.valor,
        },
        timeout: TIEMPO_LIMITE_MS,
        rejectUnauthorized: true,
      },
      (respuesta) => {
        const estado = respuesta.statusCode ?? 0;
        if (estado === 401 || estado === 403) {
          respuesta.resume();
          reject(claveRechazada());
          return;
        }
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
  /*
   * Las credenciales primero, antes de tocar la red.
   *
   * Si falta configuración no hay nada que intentar, y además así no se manda
   * un pedido sin clave que del otro lado quede anotado como un intento
   * fallido de autenticación.
   */
  const credencial = credenciales();
  let ultimoError: unknown;

  // Camino normal: el más rápido cuando el DNS del servidor funciona.
  try {
    const respuesta = await fetch(URL_CATALOGO, {
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        [credencial.encabezado]: credencial.valor,
      },
      signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
      // Una redirección sacaría el pedido del dominio autorizado —y se llevaría
      // la clave con él.
      redirect: 'error',
    });
    /*
     * Un rechazo de credenciales termina acá.
     *
     * No se prueba el camino de respaldo: 401 quiere decir que llegamos y que
     * no nos reconocieron, así que resolver el nombre por otra vía sólo
     * mandaría la misma clave otra vez para que la vuelvan a rechazar.
     */
    if (respuesta.status === 401 || respuesta.status === 403) throw claveRechazada();
    if (!respuesta.ok) throw new Error(`Control de Stock respondió ${respuesta.status}`);
    const texto = await leerConLimite(respuesta);
    if (texto.trim() === '') throw new Error('la respuesta vino vacía');
    return texto;
  } catch (error) {
    if (error instanceof AppError) throw error;
    ultimoError = error;
  }

  // Camino de respaldo, sólo si el primero falló por no poder llegar.
  try {
    const ips = await resolverPorDoh();
    for (const ip of ips) {
      try {
        const texto = await descargarPorIp(ip, credencial);
        if (texto.trim() !== '') return texto;
      } catch (error) {
        if (error instanceof AppError) throw error;
        ultimoError = error;
      }
    }
    if (ips.length === 0) {
      ultimoError = new Error('el DNS no devolvió ninguna dirección pública utilizable');
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    ultimoError = error;
  }

  /*
   * Lo que se registra pasa por el mismo filtro que lo que se muestra.
   * Un log no es un lugar más seguro que una pantalla: lo lee cualquiera que
   * tenga acceso al panel de Render.
   */
  const crudo = ultimoError instanceof Error ? ultimoError.message : String(ultimoError ?? '');
  console.error('No se pudo leer el catálogo de Control de Stock:', sinLaClave(crudo));
  throw noSePudo(`${crudo || 'no respondió'}.`);
}
