import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';

/**
 * La clave de integración con Control de Stock.
 *
 * Lo que se comprueba acá no es que la autenticación "funcione" —eso lo dice
 * cualquier corrida contra el servicio real— sino las cuatro cosas que hacen
 * que una clave compartida no se convierta en un problema:
 *
 *  - que sin configurar, la aplicación lo diga y no salga a la red;
 *  - que si la rechazan, lo diga con esas palabras y no con un error genérico;
 *  - que cuando está bien, viaje **en el encabezado** y en ningún otro lado;
 *  - y que no aparezca en la respuesta, ni en el mensaje de error, ni en la
 *    consola. Un secreto en un log no está más protegido que uno en pantalla:
 *    lo lee cualquiera que entre al panel de Render.
 *
 * El módulo lee el origen al cargarse, así que cada caso lo vuelve a importar
 * con el entorno ya puesto.
 */

const PUERTO = 3122;
const ORIGEN = `http://127.0.0.1:${PUERTO}/api/integrations/catalog`;
const ENCABEZADO = 'x-clave-de-prueba';
const CLAVE = 'clave-secreta-de-prueba-9f3a71';

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
    const clave = pedido.headers[ENCABEZADO];

    if (clave === undefined) {
      respuesta.writeHead(401, { 'content-type': 'application/json' });
      respuesta.end(JSON.stringify({ ok: false, code: 'INTEGRATION_KEY_REQUIRED' }));
      return;
    }
    if (clave !== CLAVE) {
      respuesta.writeHead(401, { 'content-type': 'application/json' });
      respuesta.end(JSON.stringify({ ok: false, code: 'INTEGRATION_KEY_INVALID' }));
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
      STOCK_INTEGRATION_HEADER: ENCABEZADO,
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

  it('también cuando falta el nombre del encabezado', async () => {
    /*
     * El encabezado es parte del contrato y no se adivina. Sin él, mandar la
     * clave en el que a uno le parezca es fallar de nuevo con otro disfraz.
     */
    const { descargarCatalogoDeStock } = await conEntorno({
      STOCK_INTEGRATION_KEY: CLAVE,
      STOCK_INTEGRATION_HEADER: undefined,
    });

    await expect(descargarCatalogoDeStock()).rejects.toThrow(
      'La integración con Control de Stock no está configurada',
    );
    expect(recibido).toBeNull();
  });
});

describe('con la clave rechazada', () => {
  it('lo dice con esas palabras y no como un error genérico', async () => {
    const { descargarCatalogoDeStock } = await conEntorno({
      STOCK_INTEGRATION_KEY: 'una-clave-que-no-es',
      STOCK_INTEGRATION_HEADER: ENCABEZADO,
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
  it('el catálogo llega, y la clave viajó en el encabezado', async () => {
    const { descargarCatalogoDeStock } = await conEntorno({
      STOCK_INTEGRATION_KEY: CLAVE,
      STOCK_INTEGRATION_HEADER: ENCABEZADO,
    });

    const texto = await descargarCatalogoDeStock();
    expect(JSON.parse(texto).products).toHaveLength(1);

    expect(recibido!.encabezados[ENCABEZADO]).toBe(CLAVE);
  });

  it('la clave no viaja en la dirección ni en ningún otro encabezado', async () => {
    /*
     * En la URL quedaría escrita en los registros del servidor de destino, en
     * el historial de cualquier intermediario y en el «referer». El encabezado
     * es el único lugar donde no queda anotada sola.
     */
    const { descargarCatalogoDeStock } = await conEntorno({
      STOCK_INTEGRATION_KEY: CLAVE,
      STOCK_INTEGRATION_HEADER: ENCABEZADO,
    });
    await descargarCatalogoDeStock();

    expect(recibido!.url).not.toContain(CLAVE);
    for (const [nombre, valor] of Object.entries(recibido!.encabezados)) {
      if (nombre === ENCABEZADO) continue;
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
    process.env.STOCK_INTEGRATION_HEADER = ENCABEZADO;
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
    const { sinLaClave } = await conEntorno({
      STOCK_INTEGRATION_KEY: CLAVE,
      STOCK_INTEGRATION_HEADER: ENCABEZADO,
    });
    expect(sinLaClave(`falló con ${CLAVE} adentro`)).toBe('falló con «clave oculta» adentro');
    expect(sinLaClave('un mensaje cualquiera')).toBe('un mensaje cualquiera');
  });
});
