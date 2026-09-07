import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { limpiarBase, sembrarEscenario, type Escenario } from './ayudas';
import {
  LOS_CALVOS_TEXT,
  LOS_CALVOS_ITEMS,
  LOS_CALVOS_PRINTED,
} from '../fixtures/los-calvos';
import { SAFARI2_TEXTOS } from '../fixtures/errecalde-safari-2';
import { MABELHERDI_COMPLETO } from '../fixtures/mabelherdi';

/**
 * Abrir la revisión y validar el comprobante son dos permisos distintos.
 *
 * Hasta acá se trataban casi como uno solo, y son cosas diferentes:
 *
 *  - **Abrir la revisión** es dejar que una persona mire lo que se leyó y lo
 *    arregle. Alcanza con que haya renglones identificables. Que un importe
 *    esté mal no es motivo para cerrar la puerta: la pantalla de revisión
 *    existe justamente para eso, y sin ella el único camino sería volver a
 *    sacar la foto de algo que ya se leyó bien salvo un número.
 *
 *  - **Validar** es decir que el comprobante es correcto, y de ahí salen el
 *    movimiento de mercadería, el costo de cada artículo, la deuda con el
 *    proveedor y la fecha de pago. Eso no puede pasar mientras el detalle no
 *    cierre contra el pie impreso: un neto incompleto se convierte en un costo
 *    incompleto y de ahí en un precio de venta mal calculado.
 *
 * Lo que se fija acá es esa separación, por las mismas rutas HTTP que usa el
 * teléfono, y que el mensaje de la negativa diga **cuánto** falta: «requiere
 * revisión» no le sirve a quien tiene el papel en la mano.
 */

let escenario: Escenario;
let usuarioActual: Escenario['admin'];

vi.mock('@/lib/auth/session', async (original) => {
  const real = await original<typeof import('@/lib/auth/session')>();
  return { ...real, requireUser: vi.fn(async () => usuarioActual) };
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
  expect(respuesta.status, JSON.stringify(datos)).toBeLessThan(300);
  return datos.id as string;
}

async function leer(documentId: string, textos: { completo: string; articulos?: string }) {
  const { POST } = await import('@/app/api/comprobantes/[id]/lectura/route');
  const respuesta = await POST(
    new Request(`http://localhost/api/comprobantes/${documentId}/lectura`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        intento: 1,
        estrategia: 'completo',
        proveedor: 'tesseract',
        modelo: 'spa',
        duracionMs: 1000,
        paginas: [
          {
            numero: 1,
            textoCompleto: textos.completo,
            textoArticulos: textos.articulos ?? null,
            confianza: 0.85,
          },
        ],
      }),
    }),
    { params: Promise.resolve({ id: documentId }) },
  );
  return { estado: respuesta.status, cuerpo: await respuesta.json() };
}

async function confirmar(documentId: string, cuerpo: unknown) {
  const { POST } = await import('@/app/api/comprobantes/[id]/confirmar/route');
  const respuesta = await POST(
    new Request(`http://localhost/api/comprobantes/${documentId}/confirmar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cuerpo),
    }),
    { params: Promise.resolve({ id: documentId }) },
  );
  return { estado: respuesta.status, cuerpo: await respuesta.json() };
}

/** Los datos que manda la pantalla de revisión para Los Calvos. */
function confirmacionLosCalvos(overrides: Record<string, unknown> = {}) {
  return {
    supplierId: escenario.proveedorId,
    docType: 'FACTURA',
    letter: 'A',
    pointOfSale: '0010',
    number: '00212356',
    issueDate: '2026-08-14',
    printed: LOS_CALVOS_PRINTED,
    items: LOS_CALVOS_ITEMS.map((item, i) => ({
      ...item,
      productId: escenario.productos[String(1001 + i)] ?? null,
    })),
    payment: { dueDate: '2026-08-14', paymentMethod: 'TRANSFERENCIA', notes: null },
    ...overrides,
  };
}

describe('una lectura con importes mal sí llega a la revisión', () => {
  /*
   * El fixture es una captura real de Safari sobre la foto de Errecalde, y está
   * incompleta: de las 23 filas se entendieron 15. Eso no se puede validar,
   * pero **sí** se puede revisar: hay quince renglones identificables, con su
   * código y su descripción, y completar los ocho que faltan a mano es mucho
   * menos trabajo que volver a empezar.
   */
  const errecalde = { completo: SAFARI2_TEXTOS.completo, articulos: SAFARI2_TEXTOS.articulos };

  it('Errecalde incompleta: se abre la revisión con los renglones que sí se leyeron', async () => {
    const documentId = await abrirComprobante(escenario.sucursales.devoto);
    const lectura = await leer(documentId, errecalde);

    // La lectura entró: hay comprobante que mirar.
    expect(lectura.estado).toBe(200);
    expect(lectura.cuerpo.analizador).toBe('errecalde');

    // Y no se frenó por calidad de lectura: eso es para una foto ilegible, no
    // para una factura con renglones que faltan.
    const controles = lectura.cuerpo.controles as { code: string; severity: string }[];
    expect(controles.some((c) => c.code === 'LECTURA_UTILIZABLE' && c.severity === 'ERROR')).toBe(
      false,
    );

    const guardado = await prisma.document.findUniqueOrThrow({
      where: { id: documentId },
      include: { items: true },
    });
    expect(guardado.status).toBe('REQUIERE_REVISION');
    expect(guardado.items.length).toBeGreaterThanOrEqual(15);
    // Con su código y su descripción, que es lo que hace revisable un renglón.
    expect(guardado.items.every((i) => i.description.trim() !== '')).toBe(true);
  });

  it('pero no se puede validar, y la negativa dice cuánto falta', async () => {
    const documentId = await abrirComprobante(escenario.sucursales.devoto);
    await leer(documentId, errecalde);

    /*
     * Se confirma con lo que la pantalla mostraría: los renglones leídos y el
     * pie impreso. El servidor recalcula y tiene que negarse.
     */
    const leidos = await prisma.documentItem.findMany({
      where: { documentId },
      orderBy: { lineNumber: 'asc' },
    });
    const respuesta = await confirmar(documentId, {
      supplierId: escenario.proveedorErrecaldeId,
      docType: 'FACTURA',
      letter: 'A',
      pointOfSale: '00008',
      number: '00002647',
      issueDate: '2026-08-22',
      printed: { netTotal: '3830467.37', ivaTotal: '804398.16', total: '4816812.73' },
      items: leidos.map((i) => ({
        lineNumber: i.lineNumber,
        supplierCode: i.supplierCode,
        description: i.description,
        quantity: i.quantity.toString(),
        unit: i.unit,
        unitNetPrice: i.unitNetPrice.toString(),
        grossSubtotal: i.grossSubtotal.toString(),
        ivaRate: i.ivaRate.toString(),
        productId: null,
      })),
      payment: { dueDate: '2026-08-22', paymentMethod: 'TRANSFERENCIA', notes: null },
    });

    expect(respuesta.estado).toBeGreaterThanOrEqual(400);

    /*
     * El mensaje es lo que se está probando: tiene que nombrar el concepto y la
     * plata que falta, no decir «requiere revisión». Quien lo lee va a ir a
     * buscar esa diferencia al papel.
     */
    const mensaje: string = respuesta.cuerpo.error;
    expect(mensaje).toContain('no cierra contra el papel');
    expect(mensaje).toContain('Neto de los artículos');
    expect(mensaje).toMatch(/\$/);
    expect(mensaje).toContain('3.830.467,37');

    // Y no se escribió nada: ni compra, ni costo, ni deuda, ni agenda.
    expect(await prisma.purchaseMovement.count()).toBe(0);
    expect(await prisma.costHistory.count()).toBe(0);
    expect(await prisma.paymentSchedule.count()).toBe(0);
  });

  it('Mabelherdi cierra contra su pie y no tiene nada pendiente', async () => {
    /*
     * La otra mitad de la separación. Esta lectura sí cuadra: los nueve
     * importes suman el neto impreso, y el IVA y la percepción salen exactos.
     * No tiene que quedar ningún control en error, porque no hay nada que
     * corregir.
     */
    const documentId = await abrirComprobante(escenario.sucursales.devoto);
    const lectura = await leer(documentId, { completo: MABELHERDI_COMPLETO });

    expect(lectura.cuerpo.analizador).toBe('mabelherdi');
    expect(lectura.cuerpo.calculado.netAmount).toBe('32998.85');
    expect(lectura.cuerpo.calculado.ivaAmount).toBe('6929.76');
    expect(lectura.cuerpo.calculado.perceptionAmount).toBe('577.48');
    expect(lectura.cuerpo.calculado.totalCost).toBe('40506.09');

    const enError = (lectura.cuerpo.controles as { code: string; severity: string }[]).filter(
      (c) => c.severity === 'ERROR',
    );
    expect(enError.map((c) => c.code)).toEqual([]);
    expect(lectura.cuerpo.puedeGuardar).toBe(true);
  });
});

describe('validar escribe la compra una sola vez', () => {
  it('genera compra, costos, deuda y agenda, y ninguna cosa por duplicado', async () => {
    const documentId = await abrirComprobante(escenario.sucursales.devoto);
    await leer(documentId, { completo: LOS_CALVOS_TEXT });

    const respuesta = await confirmar(documentId, confirmacionLosCalvos());
    expect(respuesta.estado, JSON.stringify(respuesta.cuerpo)).toBeLessThan(300);

    const guardado = await prisma.document.findUniqueOrThrow({
      where: { id: documentId },
      include: { items: true, purchaseMovements: true, paymentSchedule: true, taxLines: true },
    });

    expect(guardado.status).toBe('VALIDADO');
    // Un renglón, un movimiento, un costo. Ni uno más.
    expect(guardado.items).toHaveLength(9);
    expect(guardado.purchaseMovements).toHaveLength(9);
    expect(await prisma.costHistory.count()).toBe(9);
    // Una sola agenda de pago, con la deuda entera y sin pagar.
    expect(await prisma.paymentSchedule.count()).toBe(1);
    expect(guardado.paymentSchedule!.plannedAmount.toString()).toBe('2196120.52');
    expect(guardado.paymentSchedule!.paidAmount.toString()).toBe('0');
  });

  it('confirmar dos veces no duplica la compra ni la deuda', async () => {
    /*
     * Pasa de verdad: se toca «Confirmar», la respuesta tarda, y se vuelve a
     * tocar. Si cada confirmación agregara sus movimientos, la mercadería
     * entraría dos veces al stock y la deuda con el proveedor se duplicaría.
     */
    const documentId = await abrirComprobante(escenario.sucursales.devoto);
    await leer(documentId, { completo: LOS_CALVOS_TEXT });

    const primera = await confirmar(documentId, confirmacionLosCalvos());
    expect(primera.estado).toBeLessThan(300);
    const segunda = await confirmar(documentId, confirmacionLosCalvos());

    /*
     * Da igual si la segunda vuelve a escribir o se niega —las dos son
     * respuestas defendibles—; lo que no puede pasar es que queden dos compras.
     */
    void segunda;
    expect(await prisma.purchaseMovement.count()).toBe(9);
    expect(await prisma.costHistory.count()).toBe(9);
    expect(await prisma.paymentSchedule.count()).toBe(1);
    expect(await prisma.documentItem.count({ where: { documentId } })).toBe(9);
  });

  it('no se puede validar si el detalle no cierra, ni aunque los renglones cierren entre sí', async () => {
    /*
     * El caso que hay que impedir: se borra un renglón en la pantalla de
     * revisión y los ocho que quedan cierran perfecto entre ellos. Contra el
     * pie impreso no cierran, y por eso no se guarda: si se guardara, la
     * mercadería de ese renglón se pagaría sin haber entrado.
     */
    const documentId = await abrirComprobante(escenario.sucursales.devoto);
    await leer(documentId, { completo: LOS_CALVOS_TEXT });

    const sinElUltimo = confirmacionLosCalvos({
      items: LOS_CALVOS_ITEMS.slice(0, 8).map((item, i) => ({
        ...item,
        productId: escenario.productos[String(1001 + i)] ?? null,
      })),
    });
    const respuesta = await confirmar(documentId, sinElUltimo);

    expect(respuesta.estado).toBeGreaterThanOrEqual(400);
    const mensaje: string = respuesta.cuerpo.error;
    expect(mensaje).toContain('no cierra contra el papel');
    // Y dice la plata que falta, que es la del renglón borrado.
    expect(mensaje).toContain('Neto de los artículos');

    expect(await prisma.purchaseMovement.count()).toBe(0);
    expect(await prisma.paymentSchedule.count()).toBe(0);
  });
});

describe('un código de proveedor con una errata del OCR', () => {
  /*
   * Sobre la foto de Errecalde, varios de los veintitrés códigos salen con un
   * dígito cambiado —«ART-82174» donde el papel dice «ART-02174», y lo mismo
   * con 6 y con 9 en lugar del cero—. El artículo se reconoce igual por la
   * descripción, así que la compra no se carga al producto equivocado; lo que
   * se rompe es el código que queda guardado, y con él la próxima factura de
   * ese proveedor, que ya no lo encuentra por código.
   *
   * Acá se comprueba el circuito entero: se corrige contra el catálogo, queda
   * guardado el bueno, y **se dice**. Corregir un código en silencio sería peor
   * que no corregirlo.
   */
  const errecalde = { completo: SAFARI2_TEXTOS.completo, articulos: SAFARI2_TEXTOS.articulos };

  async function conElPernilEnElCatalogo() {
    const { normalizeText } = await import('@/lib/domain/matching');
    await prisma.product.create({
      data: {
        internalCode: '3001',
        normalizedName: 'Pernil Termoli',
        category: 'Fiambres',
        purchaseUnit: 'KG',
        saleMode: 'FETEABLE',
        avgPieceWeightKg: '3.000',
        defaultSupplierId: escenario.proveedorErrecaldeId,
        targetMarginPct: '0.45',
        marginBasis: 'SOBRE_COSTO',
        cashDiscountPct: '0.10',
        roundingRule: 'NEAREST_100',
        aliases: {
          create: {
            supplierId: escenario.proveedorErrecaldeId,
            supplierCode: 'ART-02174',
            alias: 'PERNIL TERMOLI',
            normalized: normalizeText('PERNIL TERMOLI'),
            origin: 'MANUAL',
          },
        },
      },
    });
  }

  async function renglonDelPernil(documentId: string) {
    return prisma.documentItem.findFirst({
      where: { documentId, description: { contains: 'PERNIL' } },
    });
  }

  it('sin el artículo en el catálogo, el código se guarda tal como se leyó', async () => {
    /*
     * Va primero porque fija el punto de partida: el OCR lee «ART-82174». Sin
     * nada contra qué contrastar no se corrige nada, y está bien que así sea:
     * un código inventado sería peor que uno mal leído, porque el mal leído se
     * ve.
     */
    const documentId = await abrirComprobante(escenario.sucursales.devoto);
    await leer(documentId, errecalde);

    const renglon = await renglonDelPernil(documentId);
    expect(renglon).not.toBeNull();
    expect(renglon!.supplierCode).toBe('ART-82174');
  });

  it('con el artículo en el catálogo, guarda el código bueno', async () => {
    await conElPernilEnElCatalogo();

    const documentId = await abrirComprobante(escenario.sucursales.devoto);
    await leer(documentId, errecalde);

    const renglon = await renglonDelPernil(documentId);
    expect(renglon!.supplierCode).toBe('ART-02174');
  });

  it('y lo dice, con el que se leyó y el que quedó', async () => {
    await conElPernilEnElCatalogo();

    const documentId = await abrirComprobante(escenario.sucursales.devoto);
    const lectura = await leer(documentId, errecalde);

    const dicho = (lectura.cuerpo.observaciones as string[]).join(' ');
    expect(dicho).toContain('ART-82174');
    expect(dicho).toContain('ART-02174');
    expect(dicho).toContain('catálogo');
  });
});

describe('el detalle de una pasada con el pie de la otra', () => {
  /*
   * La foto real de Mabelherdi, con las cuatro zonas que devuelve el lector del
   * teléfono. Las dos pasadas fallan en lugares distintos y son complementarias:
   * el recorte de la tabla trae los nueve renglones exactos y no trae pie; la
   * página completa trae el pie entero y dos renglones rotos.
   *
   * Antes había que elegir una de las dos enteras, y ganaba la de página
   * completa porque era la única con neto contra el cual controlar. El
   * comprobante quedaba con $51.619,15 de mercadería donde el papel dice
   * $32.998,85: $18.620 de más, que es el importe de un renglón leído con un
   * dígito de más.
   *
   * Esto no mezcla nada adentro de un renglón ni adentro del pie: cada valor
   * conserva su procedencia, y lo que se cruza son las dos mitades enteras.
   */
  it('recupera los nueve renglones exactos y el pie completo', async () => {
    const {
      MABELHERDI_FOTO_COMPLETA,
      MABELHERDI_FOTO_ENCABEZADO,
      MABELHERDI_FOTO_ARTICULOS,
      MABELHERDI_FOTO_RESUMEN,
      MABELHERDI_FOTO_FILAS_DETECTADAS,
    } = await import('../fixtures/mabelherdi-foto');

    const documentId = await abrirComprobante(escenario.sucursales.devoto);
    const { POST } = await import('@/app/api/comprobantes/[id]/lectura/route');
    const respuesta = await POST(
      new Request(`http://localhost/api/comprobantes/${documentId}/lectura`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          intento: 1,
          estrategia: 'completo',
          proveedor: 'tesseract',
          modelo: 'spa',
          duracionMs: 1000,
          paginas: [
            {
              numero: 1,
              textoCompleto: MABELHERDI_FOTO_COMPLETA,
              textoEncabezado: MABELHERDI_FOTO_ENCABEZADO,
              textoArticulos: MABELHERDI_FOTO_ARTICULOS,
              textoResumen: MABELHERDI_FOTO_RESUMEN,
              confianza: 0.85,
              regiones: { filasDetectadas: MABELHERDI_FOTO_FILAS_DETECTADAS },
            },
          ],
        }),
      }),
      { params: Promise.resolve({ id: documentId }) },
    );
    const cuerpo = await respuesta.json();

    // El detalle sale del recorte de la tabla: nueve renglones exactos.
    expect(cuerpo.calculado.itemCount).toBe(9);
    expect(cuerpo.calculado.netAmount).toBe('32998.85');
    // Y el pie, de la página completa.
    expect(cuerpo.calculado.ivaAmount).toBe('6929.76');
    expect(cuerpo.calculado.perceptionAmount).toBe('577.48');
    expect(cuerpo.calculado.totalCost).toBe('40506.09');

    const enError = (cuerpo.controles as { code: string; severity: string }[]).filter(
      (c) => c.severity === 'ERROR',
    );
    expect(enError.map((c) => c.code)).toEqual([]);
    expect(cuerpo.puedeGuardar).toBe(true);
  });

  it('la fila de más que cuenta el detector no traba un comprobante que cierra', async () => {
    /*
     * El detector ve diez filas donde hay nueve —una línea del membrete o un
     * borde de la tabla—. Como la suma de los nueve renglones da exactamente el
     * neto impreso, no puede faltar ningún importe: la fila de más es del
     * detector. Queda como aviso, no como error.
     */
    const {
      MABELHERDI_FOTO_COMPLETA,
      MABELHERDI_FOTO_ENCABEZADO,
      MABELHERDI_FOTO_ARTICULOS,
      MABELHERDI_FOTO_RESUMEN,
    } = await import('../fixtures/mabelherdi-foto');

    const documentId = await abrirComprobante(escenario.sucursales.devoto);
    const { POST } = await import('@/app/api/comprobantes/[id]/lectura/route');
    const respuesta = await POST(
      new Request(`http://localhost/api/comprobantes/${documentId}/lectura`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          intento: 1,
          estrategia: 'completo',
          proveedor: 'tesseract',
          modelo: 'spa',
          duracionMs: 1000,
          paginas: [
            {
              numero: 1,
              textoCompleto: MABELHERDI_FOTO_COMPLETA,
              textoEncabezado: MABELHERDI_FOTO_ENCABEZADO,
              textoArticulos: MABELHERDI_FOTO_ARTICULOS,
              textoResumen: MABELHERDI_FOTO_RESUMEN,
              confianza: 0.85,
              regiones: { filasDetectadas: 10 },
            },
          ],
        }),
      }),
      { params: Promise.resolve({ id: documentId }) },
    );
    const cuerpo = await respuesta.json();

    const control = (cuerpo.controles as { code: string; severity: string; message: string }[]).find(
      (c) => c.code === 'ART_RENGLONES_COMPLETOS',
    );
    expect(control?.severity).toBe('WARN');
    expect(control?.message).toContain('del detector');
    expect(cuerpo.puedeGuardar).toBe(true);
  });
});
