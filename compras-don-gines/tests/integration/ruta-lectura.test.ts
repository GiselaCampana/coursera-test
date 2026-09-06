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
