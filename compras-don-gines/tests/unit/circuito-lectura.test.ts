import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * El circuito del navegador ante una lectura que no sirve.
 *
 * Acá se prueba una sola decisión, y es la que evita el daño: cuando el
 * servidor dice que la foto no se leyó, el circuito tiene que avisarlo hacia
 * arriba para que la pantalla no entre a la revisión. Revisar dos renglones de
 * diez no es corregir una factura incompleta; es confirmar una compra que no
 * existe.
 *
 * La otra mitad de la decisión importa igual: **el veredicto se toma de la
 * última vuelta, no de la primera**. La relectura focalizada existe justamente
 * para recuperar los renglones que faltaron, así que cortar en la primera
 * vuelta tiraría la vuelta que arregla el problema.
 *
 * Tesseract y la red se sustituyen porque no viven en Node; el bucle, las
 * condiciones de corte y el veredicto son el código de producción.
 */

const leer = vi.fn();
const preparar = vi.fn(async () => undefined);

vi.mock('@/lib/cliente/ocr/lector', () => ({
  SesionLectura: class {
    preparar = preparar;
    leer = leer;
  },
}));

/** Las respuestas que va a dar la ruta de control, una por vuelta. */
let respuestas: unknown[] = [];

vi.mock('@/lib/cliente/red', () => ({
  pedir: vi.fn(async () => ({
    ok: true,
    json: async () => respuestas.shift() ?? {},
  })),
}));

const CONTROL_INSUFICIENTE = {
  code: 'LECTURA_UTILIZABLE',
  label: 'Calidad de la lectura',
  severity: 'ERROR',
  message:
    'No pudimos leer correctamente los renglones de esta factura. Usá la foto original o ' +
    'volvé a sacarla con el papel completo, buena luz y sin movimiento. En la imagen se ven ' +
    '10 filas y se entendieron 2: falta más de la mitad de la tabla.',
};

const CONTROL_BIEN = {
  code: 'LECTURA_UTILIZABLE',
  label: 'Calidad de la lectura',
  severity: 'OK',
  message: 'La foto se leyó lo suficiente como para revisar el comprobante.',
};

async function correr(maximoIntentos = 3) {
  const { leerYControlar } = await import('@/lib/cliente/ocr/circuito');
  return leerYControlar({
    documentId: 'doc-1',
    fuentes: [{ archivo: new Blob([]), nombre: 'factura.jpg' }],
    maximoIntentos,
    alAvanzar: () => {},
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  leer.mockResolvedValue({ paginas: [] });
  respuestas = [];
});

describe('el circuito de lectura del navegador', () => {
  it('avisa que la lectura no alcanza, con el mensaje que hay que mostrar', async () => {
    respuestas = [
      { puedeGuardar: false, controles: [CONTROL_INSUFICIENTE], observaciones: [], releer: null },
    ];

    const salida = await correr();

    expect(salida.lecturaInsuficiente).toBe(true);
    expect(salida.motivoInsuficiente).toContain('volvé a sacarla');
  });

  it('una lectura que cierra no dispara nada', async () => {
    respuestas = [
      { puedeGuardar: true, controles: [CONTROL_BIEN], observaciones: [], releer: null },
    ];

    const salida = await correr();

    expect(salida.lecturaInsuficiente).toBe(false);
    expect(salida.motivoInsuficiente).toBeNull();
  });

  it('si la relectura recupera los renglones, la lectura vale', async () => {
    /*
     * Primera vuelta: faltan renglones y el servidor pide releer el borde de
     * abajo de la tabla. Segunda vuelta: aparecen. Lo que se afirma es que el
     * veredicto que sale del circuito es el de la segunda, no el de la primera.
     */
    respuestas = [
      {
        puedeGuardar: false,
        controles: [CONTROL_INSUFICIENTE],
        observaciones: [],
        releer: { motivo: 'faltan 8 artículos', zona: 'BORDE_INFERIOR_TABLA' },
      },
      { puedeGuardar: true, controles: [CONTROL_BIEN], observaciones: [], releer: null },
    ];

    const salida = await correr();

    expect(salida.intentos).toBe(2);
    expect(salida.lecturaInsuficiente).toBe(false);
    // Y la segunda vuelta fue de verdad una relectura dirigida a esa zona.
    expect(leer).toHaveBeenNthCalledWith(2, 2, 'faltan 8 artículos', 'BORDE_INFERIOR_TABLA');
  });

  it('si la relectura tampoco alcanza, se corta y se pide otra foto', async () => {
    respuestas = [
      {
        puedeGuardar: false,
        controles: [CONTROL_INSUFICIENTE],
        observaciones: [],
        releer: { motivo: 'faltan 8 artículos', zona: 'BORDE_INFERIOR_TABLA' },
      },
      {
        puedeGuardar: false,
        controles: [CONTROL_INSUFICIENTE],
        observaciones: [],
        releer: { motivo: 'faltan 8 artículos', zona: 'BORDE_INFERIOR_TABLA' },
      },
    ];

    const salida = await correr(2);

    expect(salida.intentos).toBe(2);
    expect(salida.lecturaInsuficiente).toBe(true);
  });

  it('un comprobante que no cierra por otra cosa sí entra a la revisión', async () => {
    /*
     * La distinción que sostiene todo esto. Un neto que no cuadra por un
     * renglón mal sumado se arregla en la pantalla de revisión, y frenar ahí
     * sería sacarle a la usuaria la herramienta con la que resuelve el caso
     * más común.
     */
    respuestas = [
      {
        puedeGuardar: false,
        controles: [CONTROL_BIEN, { code: 'ART_NETO', severity: 'ERROR', message: 'no cuadra' }],
        observaciones: [],
        releer: null,
      },
    ];

    const salida = await correr();

    expect(salida.lecturaInsuficiente).toBe(false);
  });
});
