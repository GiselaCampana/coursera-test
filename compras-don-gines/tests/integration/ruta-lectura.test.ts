import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { limpiarBase, sembrarEscenario, type Escenario } from './ayudas';
import {
  LOS_CALVOS_TEXT,
  LOS_CALVOS_ENCABEZADO_OCR,
  LOS_CALVOS_ARTICULOS_OCR,
  LOS_CALVOS_RESUMEN_OCR,
} from '../fixtures/los-calvos';
import { SAFARI2_TEXTOS } from '../fixtures/errecalde-safari-2';
import { MABELHERDI_COMPLETO } from '../fixtures/mabelherdi';

/**
 * El recorrido real, por las rutas HTTP que usa el teléfono.
 *
 * Esto es lo que faltaba, y explica por qué el proyecto podía tener todos los
 * analizadores en verde y una sola factura cargada en producción: había pruebas
 * de los analizadores y pruebas de los servicios, pero **ninguna recorría las
 * rutas**. Un analizador que interpreta bien un texto guardado no dice nada
 * sobre si lo que vuelve por HTTP alcanza para revisar, asociar y validar.
 *
 * El OCR corre en el teléfono, así que el texto se inyecta ya reconocido: es el
 * mismo cuerpo JSON que postea el navegador. Lo que se ejercita es todo lo que
 * pasa después, que es lo que vive en el servidor. La calidad del
 * reconocimiento es otro problema y se prueba en otro lado —no se puede correr
 * Tesseract sobre una foto de forma determinística en CI—, pero **que el
 * servidor se plante ante una lectura incompleta sí se puede probar acá**, y es
 * la mitad que evita el daño.
 *
 * Las rutas se importan y se invocan con un `Request` de verdad. Si un
 * `route.ts` deja de pasar un campo o cambia la forma de la respuesta, esto
 * falla; llamar al servicio por dentro no lo detectaría.
 */

let escenario: Escenario;
let usuarioActual: Escenario['admin'];

vi.mock('@/lib/auth/session', async (original) => {
  const real = await original<typeof import('@/lib/auth/session')>();
  return {
    ...real,
    // Lo único sustituido es de dónde sale el usuario: la sesión por cookie
    // tiene sus propias pruebas y acá estorbaría sin aportar nada.
    requireUser: vi.fn(async () => usuarioActual),
  };
});

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();
  usuarioActual = escenario.admin;
});

async function abrirComprobante(branchId: string): Promise<string> {
  const { POST } = await import('@/app/api/comprobantes/route');
  const respuesta = await POST(
    new Request('http://localhost/api/comprobantes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branchId }),
    }),
  );
  const datos = await respuesta.json();
  expect(respuesta.status, `alta: ${JSON.stringify(datos)}`).toBeLessThan(300);
  return datos.id as string;
}

async function mandarLectura(documentId: string, paginas: unknown[], intento = 1) {
  const { POST } = await import('@/app/api/comprobantes/[id]/lectura/route');
  const respuesta = await POST(
    new Request(`http://localhost/api/comprobantes/${documentId}/lectura`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        intento,
        estrategia: 'completo',
        proveedor: 'tesseract',
        modelo: 'spa',
        duracionMs: 1000,
        paginas,
      }),
    }),
    { params: Promise.resolve({ id: documentId }) },
  );
  return { estado: respuesta.status, cuerpo: await respuesta.json() };
}

async function traerComprobante(documentId: string) {
  const { GET } = await import('@/app/api/comprobantes/[id]/route');
  const respuesta = await GET(new Request(`http://localhost/api/comprobantes/${documentId}`), {
    params: Promise.resolve({ id: documentId }),
  });
  return { estado: respuesta.status, cuerpo: await respuesta.json() };
}

/** Una página tal como la manda el navegador. */
function pagina(textos: {
  completo: string;
  encabezado?: string;
  articulos?: string;
  resumen?: string;
}) {
  return {
    numero: 1,
    textoCompleto: textos.completo,
    textoEncabezado: textos.encabezado ?? null,
    textoArticulos: textos.articulos ?? null,
    textoResumen: textos.resumen ?? null,
    confianza: 0.85,
  };
}

describe('Los Calvos: entra entera por la ruta', () => {
  /*
   * Los valores son los del fixture que ya estaba en el proyecto —factura A
   * 0010-00212356 del 14/08/2026, 9 renglones, total 2.196.120,52—, no valores
   * nuevos: el fixture es la fuente y acá se controla contra él.
   */
  const paginas = [
    pagina({
      completo: LOS_CALVOS_TEXT,
      encabezado: LOS_CALVOS_ENCABEZADO_OCR,
      articulos: LOS_CALVOS_ARTICULOS_OCR,
      resumen: LOS_CALVOS_RESUMEN_OCR,
    }),
  ];

  it('encabezado, renglones y pie llegan a la revisión, y se puede guardar', async () => {
    const documentId = await abrirComprobante(escenario.sucursales.devoto);
    const lectura = await mandarLectura(documentId, paginas);

    expect(lectura.estado).toBe(200);
    expect(lectura.cuerpo.analizador).toBe('los-calvos');
    expect(lectura.cuerpo.estado).toBe('OK');
    expect(lectura.cuerpo.puedeGuardar).toBe(true);

    const { cuerpo } = await traerComprobante(documentId);
    expect(`${cuerpo.puntoDeVenta}-${cuerpo.numero}`).toBe('0010-00212356');
    expect(cuerpo.fecha).toBe('2026-08-14');
    expect(cuerpo.articulos).toHaveLength(9);
    expect(cuerpo.resumen.total).toBe('2196120.52');
    expect(cuerpo.resumen.netTotal).toBe('1792751.44');
    expect(cuerpo.proveedor?.nombre).toBe('Los Calvos');
  });

  it('la suma de los artículos y los impuestos cierra contra el pie', async () => {
    const documentId = await abrirComprobante(escenario.sucursales.devoto);
    const lectura = await mandarLectura(documentId, paginas);

    /*
     * Ningún control en error. Es lo que separa «se leyó algo» de «se leyó
     * bien»: el papel trae sus propios totales, y son la única forma de saber
     * que lo interpretado es lo que está impreso.
     */
    const enError = (lectura.cuerpo.controles as { severity: string; code: string }[]).filter(
      (c) => c.severity === 'ERROR',
    );
    expect(enError.map((c) => c.code)).toEqual([]);
  });
});

describe('Mabelherdi: entra entera, y el proveedor que no existe se conserva', () => {
  const paginas = [pagina({ completo: MABELHERDI_COMPLETO })];

  it('lee el comprobante y los nueve renglones', async () => {
    const documentId = await abrirComprobante(escenario.sucursales.devoto);
    const lectura = await mandarLectura(documentId, paginas);

    expect(lectura.cuerpo.analizador).toBe('mabelherdi');
    expect(lectura.cuerpo.estado).toBe('OK');

    const { cuerpo } = await traerComprobante(documentId);
    expect(`${cuerpo.puntoDeVenta}-${cuerpo.numero}`).toBe('0007-00348491');
    expect(cuerpo.fecha).toBe('2026-08-20');
    expect(cuerpo.articulos).toHaveLength(9);
    expect(cuerpo.resumen.netTotal).toBe('32998.85');
    expect(cuerpo.resumen.ivaTotal).toBe('6929.76');
    expect(cuerpo.resumen.total).toBe('40506.09');
  });

  it('reconoce el papel sin tener el proveedor, y conserva razón social y CUIT', async () => {
    /*
     * Mabelherdi no está dada de alta en el escenario, igual que no lo estaba
     * en producción la primera vez. Lo que no puede pasar es que el comprobante
     * quede sin nada o atribuido a otro: la pantalla ofrece «Crear proveedor y
     * continuar» con estos dos datos, y sin ellos habría que volver a mirar la
     * foto.
     */
    const documentId = await abrirComprobante(escenario.sucursales.devoto);
    await mandarLectura(documentId, paginas);

    const { cuerpo } = await traerComprobante(documentId);
    expect(cuerpo.proveedor).toBeNull();
    expect(cuerpo.proveedorLeido).toEqual({
      nombre: 'MABELHERDI S.A.',
      cuit: '30-67804306-7',
    });
  });

  it('no se lo atribuye a ningún proveedor de la base', async () => {
    const documentId = await abrirComprobante(escenario.sucursales.devoto);
    await mandarLectura(documentId, paginas);

    const guardado = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(guardado.supplierId).toBeNull();
  });
});

describe('Errecalde: una lectura incompleta se rechaza, no se guarda a medias', () => {
  /*
   * Este fixture es una captura real de Safari en el iPhone, y está incompleta:
   * de las 23 filas de la tabla el OCR entendió 15, y varios importes salieron
   * rotos —«TRE CAVIWA X 3,3K6», «$ 52.209.041,00»—. Es exactamente lo que pasa
   * en producción.
   *
   * Lo que se fija acá no es que la lectura salga bien —no sale, y el problema
   * es la calidad del reconocimiento en el teléfono, no el analizador— sino que
   * **el servidor se plante**: una factura leída a medias no se puede guardar,
   * porque un neto incompleto se convierte en un costo incompleto y de ahí en
   * un precio de venta mal calculado.
   */
  const paginas = [
    pagina({
      completo: SAFARI2_TEXTOS.completo,
      articulos: SAFARI2_TEXTOS.articulos,
    }),
  ];

  it('no deja guardar, y dice cuántos renglones faltan', async () => {
    const documentId = await abrirComprobante(escenario.sucursales.devoto);
    const lectura = await mandarLectura(documentId, paginas);

    expect(lectura.cuerpo.puedeGuardar).toBe(false);
    expect(lectura.cuerpo.estado).not.toBe('OK');

    const control = (lectura.cuerpo.controles as { code: string; message: string }[]).find(
      (c) => c.code === 'ART_RENGLONES_COMPLETOS',
    );
    // Cuenta las filas sobre la imagen y las contrasta contra las entendidas:
    // son dos medidas independientes, y la diferencia delata la lectura corta.
    expect(control?.message).toContain('23');
    expect(control?.message).toContain('15');
  });

  it('pide releer, y dice qué zona', async () => {
    const documentId = await abrirComprobante(escenario.sucursales.devoto);
    const lectura = await mandarLectura(documentId, paginas);

    expect(lectura.cuerpo.releer).not.toBeNull();
    expect(lectura.cuerpo.releer.zona).toBe('BORDE_INFERIOR_TABLA');
    // El motivo va en castellano y dice qué falta, no un código.
    expect(lectura.cuerpo.releer.motivo).toContain('faltan 8 artículos');
  });

  it('igual identifica al proveedor por CUIT, y no se lo atribuye a otro', async () => {
    /*
     * Que la tabla no se lea no puede arrastrar la identificación: el CUIT está
     * en el encabezado y se lee aunque el cuerpo salga roto. Atribuirla a otro
     * proveedor sería peor que no leerla.
     */
    const documentId = await abrirComprobante(escenario.sucursales.devoto);
    await mandarLectura(documentId, paginas);

    const { cuerpo } = await traerComprobante(documentId);
    expect(cuerpo.proveedorLeido?.cuit).toBe('30-71780890-4');
    expect(cuerpo.proveedor?.nombre).toBe('Distribución Errecalde');
  });

  it('no escribió ninguna compra ni ningún costo', async () => {
    const documentId = await abrirComprobante(escenario.sucursales.devoto);
    await mandarLectura(documentId, paginas);

    /*
     * La garantía que hace que todo lo demás sea recuperable: leer mal no
     * ensucia nada. Mientras no se valide no hay movimiento, ni costo, ni
     * deuda, ni agenda.
     */
    expect(await prisma.purchaseMovement.count()).toBe(0);
    expect(await prisma.costHistory.count()).toBe(0);
  });
});

describe('una foto que no se leyó no llega a la revisión', () => {
  /*
   * El caso que faltaba, y que aparece con las dos fotos de Los Calvos.
   *
   * Hasta acá el servidor sabía plantarse ante una factura leída a medias: la
   * marcaba en rojo y la mandaba igual a la pantalla de revisión, que es lo
   * correcto cuando falta un renglón y se completa a mano. Pero cuando de once
   * renglones salen dos, revisar no arregla nada: lo que hay en pantalla no es
   * una factura incompleta, es una factura que no se leyó, y confirmarla
   * crearía una compra por una fracción de lo que dice el papel.
   *
   * Las dos fotos reales están en tests/fotos y no corren en CI porque
   * necesitan Tesseract. Lo que sí corre siempre es esto: las mismas señales
   * que produjeron esas lecturas, entrando por la misma ruta HTTP.
   */

  /** El texto de la tabla, cortado en los primeros N renglones. */
  function primerosRenglones(cuantos: number): string {
    const lineas = LOS_CALVOS_ARTICULOS_OCR.split('\n');
    // La primera línea es el encabezado de columnas; los renglones van después.
    return [lineas[0], ...lineas.slice(1, 1 + cuantos)].join('\n');
  }

  it('dos renglones de los que se ven diez: se rechaza y se pide otra foto', async () => {
    /*
     * La tabla sale cortada en las dos lecturas, la de la franja y la de la
     * página entera. Tiene que ser en las dos: si el texto de la página
     * completa trajera los nueve renglones, el candidato que gana sería ése y
     * la lectura estaría **bien**, no incompleta. Es lo que pasa de verdad
     * cuando la foto no da: no se rompe un recorte, se lee mal todo.
     */
    const recortado = [
      LOS_CALVOS_ENCABEZADO_OCR,
      primerosRenglones(2),
      LOS_CALVOS_RESUMEN_OCR,
    ].join('\n');

    const documentId = await abrirComprobante(escenario.sucursales.devoto);
    const lectura = await mandarLectura(documentId, [
      {
        ...pagina({
          completo: recortado,
          encabezado: LOS_CALVOS_ENCABEZADO_OCR,
          articulos: primerosRenglones(2),
          resumen: LOS_CALVOS_RESUMEN_OCR,
        }),
        // Lo que el detector contó sobre la imagen, que es la medida
        // independiente de cuántas filas hay en el papel.
        regiones: { filasDetectadas: 10 },
      },
    ]);

    expect(lectura.estado).toBe(200);
    expect(lectura.cuerpo.puedeGuardar).toBe(false);

    const control = (lectura.cuerpo.controles as { code: string; message: string }[]).find(
      (c) => c.code === 'LECTURA_UTILIZABLE',
    );
    expect(control).toBeDefined();
    // El mensaje es el que ve la usuaria, y dice qué hacer con el papel.
    expect(control?.message).toContain('volvé a sacarla');
    expect(control?.message).toContain('foto original');
  });

  it('la misma factura leída entera no dispara el control', async () => {
    /*
     * La otra mitad, y la que evita que este control se vuelva una molestia:
     * con los nueve renglones leídos y nueve filas vistas, no tiene nada que
     * decir. Un control que se dispara siempre no protege de nada; enseña a
     * ignorarlo.
     */
    const documentId = await abrirComprobante(escenario.sucursales.devoto);
    const lectura = await mandarLectura(documentId, [
      {
        ...pagina({
          completo: LOS_CALVOS_TEXT,
          encabezado: LOS_CALVOS_ENCABEZADO_OCR,
          articulos: LOS_CALVOS_ARTICULOS_OCR,
          resumen: LOS_CALVOS_RESUMEN_OCR,
        }),
        regiones: { filasDetectadas: 9 },
      },
    ]);

    const control = (lectura.cuerpo.controles as { code: string; severity: string }[]).find(
      (c) => c.code === 'LECTURA_UTILIZABLE',
    );
    expect(control?.severity).toBe('OK');
    expect(lectura.cuerpo.puedeGuardar).toBe(true);
  });

  it('con la tabla caída sobre el membrete, la ruta contesta con el mensaje y no guarda nada', async () => {
    /*
     * Los Calvos 0010-00212356: de la página entera salieron mil quinientos
     * caracteres, ninguna línea con forma de fila, y el recorte de artículos
     * terminó sobre la dirección del proveedor. Ningún analizador reconoce un
     * comprobante ahí, y la ruta tiene que decirlo en castellano en vez de
     * dejar un comprobante vacío dando vueltas.
     */
    const documentId = await abrirComprobante(escenario.sucursales.devoto);
    const lectura = await mandarLectura(documentId, [
      {
        ...pagina({
          completo: 'LOS CALVOS S.A.\nAv. San Martín 2345\nSan Martín, Buenos Aires\nTel 4755-0000',
          articulos: 'LOS CALVOS S.A.\nAv. San Martín 2345',
        }),
        // Sin una sola fila reconocida, las zonas se reparten por proporciones.
        regiones: { filasDetectadas: 0 },
      },
    ]);

    expect(lectura.estado).toBeGreaterThanOrEqual(400);
    expect(lectura.cuerpo.error).toContain('No pudimos leer correctamente los renglones');

    // Y nada quedó escrito: ni renglones, ni impuestos, ni compra.
    expect(await prisma.documentItem.count({ where: { documentId } })).toBe(0);
    expect(await prisma.purchaseMovement.count()).toBe(0);
    expect(await prisma.costHistory.count()).toBe(0);
  });
});
