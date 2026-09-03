import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';

/**
 * La clave de integración con Control de Stock.
 *
 * El contrato quedó confirmado contra el endpoint real, probando con un valor
 * ficticio: sin encabezado contesta «INTEGRATION_KEY_REQUIRED», y con
 * `Authorization: Bearer <lo que sea>` contesta «INVALID_INTEGRATION_KEY».
 * Este servidor de prueba contesta igual, así que la clave cruda en el
 * encabezado correcto tampoco alcanza acá: si el código dejara de poner el
 * «Bearer », estas pruebas fallarían del mismo modo que falla producción.
 *
 * Lo que se comprueba no es que la autenticación "funcione" —eso lo dice
 * cualquier corrida contra el servicio real— sino las cinco cosas que hacen
 * que una clave compartida no se convierta en un problema:
 *
 *  - que sin configurar, la aplicación lo diga y no salga a la red;
 *  - que si la rechazan, lo diga con esas palabras y no con un error genérico;
 *  - que viaje en `Authorization` sin que nadie tenga que configurarlo;
 *  - que viaje como `Bearer <clave>`, con el esquema puesto por el código;
 *  - y que no aparezca en la respuesta, ni en el mensaje de error, ni en la
 *    consola. Un secreto en un log no está más protegido que uno en pantalla:
 *    lo lee cualquiera que entre al panel de Render.
 *
 * El módulo lee el origen al cargarse, así que cada caso lo vuelve a importar
 * con el entorno ya puesto.
 */

const PUERTO = 3122;
const ORIGEN = `http://127.0.0.1:${PUERTO}/api/integrations/catalog`;
const CLAVE = 'clave-secreta-de-prueba-9f3a71';
/** Lo único que este servidor acepta. La clave sola no. */
const ESPERADO = `Bearer ${CLAVE}`;

/** Un catálogo mínimo pero válido, para que el caso feliz llegue hasta el final. */
const CATALOGO = JSON.stringify({
  ok: true,
  schemaVersion: '1.0',
  usage: { stableKey: 'plu' },
  products: [{ plu: '1211', name: 'Cremoso Punta del Agua', internalUnit: 'kg', active: true }],
});

/** Lo que el servidor de prueba recibió, para poder mirar cómo viajó la clave. */
let recibido: { encabezados: Record<string, string | string[] | undefined>; url: string } | null =
  null;

let servidor: Server;

beforeAll(async () => {
  servidor = createServer((pedido, respuesta) => {
    recibido = { encabezados: pedido.headers, url: pedido.url ?? '' };
    const autorizacion = pedido.headers.authorization;

    if (autorizacion === undefined) {
      respuesta.writeHead(401, { 'content-type': 'application/json' });
      respuesta.end(JSON.stringify({ ok: false, code: 'INTEGRATION_KEY_REQUIRED' }));
      return;
    }
    if (autorizacion !== ESPERADO) {
      respuesta.writeHead(401, { 'content-type': 'application/json' });
      respuesta.end(JSON.stringify({ ok: false, code: 'INVALID_INTEGRATION_KEY' }));
      return;
    }
    respuesta.writeHead(200, { 'content-type': 'application/json' });
    respuesta.end(CATALOGO);
  });
  await new Promise<void>((listo) => servidor.listen(PUERTO, '127.0.0.1', listo));
});

afterAll(async () => {
  await new Promise<void>((listo) => servidor.close(() => listo()));
});

/** Importa el módulo con el entorno que le toque a cada caso. */
async function conEntorno(entorno: Record<string, string | undefined>) {
  vi.resetModules();
  process.env.STOCK_CATALOG_URL = ORIGEN;
  for (const [clave, valor] of Object.entries(entorno)) {
    if (valor === undefined) delete process.env[clave];
    else process.env[clave] = valor;
  }
  return await import('@/lib/services/stock-descarga');
}

/** Sólo la clave: el encabezado tiene que salir del código, no del entorno. */
const SOLO_LA_CLAVE = {
  STOCK_INTEGRATION_KEY: CLAVE,
  STOCK_INTEGRATION_HEADER: undefined,
};

const original = { ...process.env };

beforeEach(() => {
  recibido = null;
});

afterEach(() => {
  process.env = { ...original };
  vi.restoreAllMocks();
});

describe('sin configurar', () => {
  it('lo dice con esas palabras, y no sale a la red', async () => {
    const { descargarCatalogoDeStock } = await conEntorno({
      STOCK_INTEGRATION_KEY: undefined,
      STOCK_INTEGRATION_HEADER: undefined,
    });

    await expect(descargarCatalogoDeStock()).rejects.toThrow(
      'La integración con Control de Stock no está configurada',
    );
    /*
     * Y no se intentó ningún pedido. Mandar uno sin clave dejaría del otro lado
     * un intento fallido de autenticación por algo que ya sabíamos de antemano.
     */
    expect(recibido).toBeNull();
  });

  it('falta configuración es sólo la clave, no el encabezado', async () => {
    /*
     * El encabezado ya no es una incógnita: el contrato dice `Authorization`.
     * Pedirlo por variable obligaría a cargar dos secretos donde hay uno solo,
     * y dejaría la integración caída por olvidar el que no es secreto.
     */
    const { descargarCatalogoDeStock } = await conEntorno(SOLO_LA_CLAVE);
    await expect(descargarCatalogoDeStock()).resolves.toBeTruthy();
  });
});

describe('con la clave rechazada', () => {
  it('lo dice con esas palabras y no como un error genérico', async () => {
    const { descargarCatalogoDeStock } = await conEntorno({
      STOCK_INTEGRATION_KEY: 'una-clave-que-no-es',
      STOCK_INTEGRATION_HEADER: undefined,
    });

    await expect(descargarCatalogoDeStock()).rejects.toThrow(
      'La clave de integración fue rechazada',
    );
    // Llegó: el problema no es de red.
    expect(recibido).not.toBeNull();
  });

  it('el mensaje no repite la clave ni nada de lo enviado', async () => {
    const { descargarCatalogoDeStock } = await conEntorno({
      STOCK_INTEGRATION_KEY: CLAVE,
      STOCK_INTEGRATION_HEADER: 'x-encabezado-equivocado',
    });

    const error = await descargarCatalogoDeStock().catch((e) => e);
    expect(error.message).toBe('La clave de integración fue rechazada');
    /*
     * Ni en el mensaje ni en ninguna propiedad que el error arrastre: un error
     * termina serializado en algún lado —una respuesta, un log, un informe— y
     * ahí se lleva todo lo que tenga adentro.
     */
    const texto = `${error.message} ${JSON.stringify(error)} ${error.stack ?? ''}`;
    expect(texto).not.toContain(CLAVE);
  });
});

describe('con la clave correcta', () => {
  it('el catálogo llega, y viajó en Authorization sin configurar nada', async () => {
    const { descargarCatalogoDeStock } = await conEntorno(SOLO_LA_CLAVE);

    const texto = await descargarCatalogoDeStock();
    expect(JSON.parse(texto).products).toHaveLength(1);

    // Presencia exacta del encabezado, y de ese y no de otro.
    expect(Object.keys(recibido!.encabezados)).toContain('authorization');
  });

  it('el formato es «Bearer <clave>», no la clave cruda', async () => {
    /*
     * Lo que costó el 401 de producción. `Authorization` no lleva la credencial
     * sola: lleva un esquema y después la credencial. Y el esquema lo pone el
     * código, para que no dependa de que quien carga el secreto en Render se
     * acuerde de escribirlo.
     */
    const { descargarCatalogoDeStock } = await conEntorno(SOLO_LA_CLAVE);
    await descargarCatalogoDeStock();

    expect(recibido!.encabezados.authorization).toBe(`Bearer ${CLAVE}`);
    expect(recibido!.encabezados.authorization).not.toBe(CLAVE);
  });

  it('no duplica el prefijo si la clave ya viene con él', async () => {
    /*
     * Un error de carga fácil de cometer —pegar «Bearer abc…» en el panel— y
     * que del otro lado se vería igual que una clave equivocada: «Bearer Bearer
     * abc…» es un 401 que nadie sabría de dónde viene.
     */
    const { descargarCatalogoDeStock } = await conEntorno({
      STOCK_INTEGRATION_KEY: `Bearer ${CLAVE}`,
      STOCK_INTEGRATION_HEADER: undefined,
    });

    await expect(descargarCatalogoDeStock()).resolves.toBeTruthy();
    expect(recibido!.encabezados.authorization).toBe(`Bearer ${CLAVE}`);
  });

  it('la clave no viaja en la dirección ni en ningún otro encabezado', async () => {
    /*
     * En la URL quedaría escrita en los registros del servidor de destino, en
     * el historial de cualquier intermediario y en el «referer». El encabezado
     * es el único lugar donde no queda anotada sola.
     */
    const { descargarCatalogoDeStock } = await conEntorno(SOLO_LA_CLAVE);
    await descargarCatalogoDeStock();

    expect(recibido!.url).not.toContain(CLAVE);
    for (const [nombre, valor] of Object.entries(recibido!.encabezados)) {
      if (nombre === 'authorization') continue;
      expect(String(valor), `la clave apareció en «${nombre}»`).not.toContain(CLAVE);
    }
  });
});

describe('la clave no se filtra', () => {
  it('no aparece en la consola cuando la descarga falla', async () => {
    /*
     * El caso que más importa, porque es el que nadie mira hasta que ya pasó:
     * un fallo de red imprime el error, y si ese error arrastrara la clave
     * quedaría escrita en el panel de Render para siempre.
     */
    const consola = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.resetModules();
    process.env.STOCK_CATALOG_URL = `http://127.0.0.1:${PUERTO + 7}/api/integrations/catalog`;
    process.env.STOCK_INTEGRATION_KEY = CLAVE;
    delete process.env.STOCK_INTEGRATION_HEADER;
    const { descargarCatalogoDeStock } = await import('@/lib/services/stock-descarga');

    const error = await descargarCatalogoDeStock().catch((e) => e);

    const escrito = consola.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(escrito).not.toContain(CLAVE);
    expect(`${error.message}`).not.toContain(CLAVE);
  });

  it('el filtro tapa la clave si algún camino nuevo la arrastrara', async () => {
    /*
     * Defensa en profundidad: hoy la clave sólo viaja en un encabezado, así que
     * este filtro no tiene nada que tapar. Está para el día que alguien sume un
     * camino que la incluya sin darse cuenta.
     */
    const { sinLaClave } = await conEntorno(SOLO_LA_CLAVE);
    expect(sinLaClave(`falló con ${CLAVE} adentro`)).toBe('falló con «clave oculta» adentro');
    expect(sinLaClave('un mensaje cualquiera')).toBe('un mensaje cualquiera');
  });
});
