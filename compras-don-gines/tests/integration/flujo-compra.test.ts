import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { getStorage, buildDocumentKey } from '@/lib/storage';
import { ForbiddenError } from '@/lib/errors';
import {
  acceptReadDocument,
  confirmDocument,
  createDocument,
  matchItemsToProducts,
  rejectDocument,
  verificarDerivados,
  voidDocument,
  type ConfirmDocumentInput,
} from '@/lib/services/documents';
import { diagnosticarDerivados, repararDerivados } from '@/lib/services/reparar-derivados';
import { toDecimal } from '@/lib/money';
import { analizarSinGuardar, registrarLectura } from '@/lib/services/lectura';
import { versionEnEjecucion } from '@/lib/version';
import {
  confirmPayment,
  getPaymentCalendar,
  getProximosPagos,
  listPayments,
  reschedulePayment,
} from '@/lib/services/payments';
import { suggestPricesFor, approveSalePrice, getLatestCost } from '@/lib/services/pricing';
import { getPurchaseReport, purchaseReportToCsv } from '@/lib/services/reports';
import {
  asociarRenglonHistorico,
  backfillProductLinks,
  importarMapeoCodigosProveedor,
  segurasDe,
} from '@/lib/services/backfill-productos';
import { saveSupplierCode, saveSupplierTerm } from '@/lib/services/admin';
import { importarCatalogo, buscarEnCatalogo } from '@/lib/services/catalogo';
import { costItems } from '@/lib/domain/costing';
import { getSupplierConditions } from '@/lib/services/suppliers';
import { computeDueDate, computePaymentStatus } from '@/lib/domain/payments';
import { arToday, toISODate, dateOnlyFromISO } from '@/lib/datetime';
import { limpiarBase, sembrarEscenario, type Escenario } from './ayudas';
import {
  SAFARI_ARTICULOS,
  SAFARI_COMPLETO,
  SAFARI_RESUMEN,
} from '../fixtures/errecalde-safari';
import {
  LOS_CALVOS_TEXT,
  LOS_CALVOS_ITEMS,
  LOS_CALVOS_PRINTED,
  LOS_CALVOS_ENCABEZADO_OCR,
  LOS_CALVOS_ARTICULOS_OCR,
  LOS_CALVOS_RESUMEN_OCR,
} from '../fixtures/los-calvos';

let escenario: Escenario;

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();
});

/**
 * Adjunta una página al comprobante.
 *
 * En las pruebas la página es la transcripción del comprobante, que es lo que
 * devolvería un OCR documental. Así el circuito completo —almacenamiento,
 * lectura, cálculo, control y guardado— se ejercita de punta a punta sin
 * depender de un servicio externo.
 */
async function adjuntarPagina(documentId: string, texto: string, orden = 1) {
  const storage = await getStorage();
  const buffer = Buffer.from(texto, 'utf8');
  const key = buildDocumentKey({ documentId, pageOrder: orden, variant: 'work', extension: 'txt' });
  await storage.put(key, buffer, 'text/plain');
  await prisma.documentFile.create({
    data: {
      documentId,
      pageOrder: orden,
      storageKey: key,
      mimeType: 'text/plain',
      originalMimeType: 'text/plain',
      sizeBytes: buffer.length,
      originalSizeBytes: buffer.length,
      sha256: `prueba-${documentId}-${orden}`,
    },
  });
}

/**
 * Entrega al servidor una lectura como la que produce el navegador.
 *
 * Se usa el texto con el ruido típico de Tesseract, así el circuito completo
 * —analizador del proveedor, cálculo, control y guardado— se ejercita sobre lo
 * que de verdad sale del OCR, no sobre un texto ideal.
 */
async function leerComprobante(
  usuario: Parameters<typeof registrarLectura>[0],
  documentId: string,
  opciones: {
    intento?: number;
    encabezado?: string;
    articulos?: string;
    resumen?: string;
    /**
     * El texto de la página entera, cuando no es la suma de las tres zonas.
     *
     * Por omisión se arman pegando encabezado, artículos y resumen, que alcanza
     * para los comprobantes dibujados. Pero sobre una foto real la página
     * completa es **una** lectura propia, con su propio orden y su propia
     * basura, y hay cosas que sólo se pueden probar así: un jirón de fila se
     * reconoce como "el final de la tabla" por dónde cae respecto de los
     * renglones que sí se leyeron, y pegar bloques de otra fuente detrás lo
     * correría de lugar.
     */
    completo?: string;
    /**
     * Cuántas filas dice el detector de disposición que vio en la imagen.
     *
     * Importa poder fijarlo: el caso que más caro sale es justamente cuando el
     * detector y el analizador se pierden **la misma** fila y los dos números
     * coinciden. Sin poder ponerlo a mano, la prueba lo deja en nulo y el
     * conteo se apoya sólo en lo interpretado, que es el caso fácil.
     */
    filasDetectadas?: number;
  } = {},
) {
  return registrarLectura(usuario, documentId, {
    intento: opciones.intento ?? 1,
    estrategia: 'Lectura completa de la página, más recortes de la tabla y del pie',
    proveedor: 'tesseract-local',
    modelo: 'tesseract 5 · spa',
    duracionMs: 1234,
    confianza: 0.88,
    observaciones: [],
    paginas: [
      {
        numero: 1,
        textoCompleto:
          opciones.completo ??
          [
            opciones.encabezado ?? LOS_CALVOS_ENCABEZADO_OCR,
            opciones.articulos ?? LOS_CALVOS_ARTICULOS_OCR,
            opciones.resumen ?? LOS_CALVOS_RESUMEN_OCR,
          ].join('\n'),
        textoEncabezado: opciones.encabezado ?? LOS_CALVOS_ENCABEZADO_OCR,
        textoArticulos: opciones.articulos ?? LOS_CALVOS_ARTICULOS_OCR,
        textoResumen: opciones.resumen ?? LOS_CALVOS_RESUMEN_OCR,
        confianza: 0.88,
        inclinacion: -0.5,
        perspectivaCorregida: true,
        regiones:
          opciones.filasDetectadas === undefined
            ? null
            : { filasDetectadas: opciones.filasDetectadas },
      },
    ],
  });
}

function datosConfirmacion(overrides: Partial<ConfirmDocumentInput> = {}): Omit<
  ConfirmDocumentInput,
  'documentId'
> {
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

/**
 * La factura real de Errecalde, leída y validada. Devuelve su identificador.
 *
 * Es el punto de partida de todo lo que se prueba sobre un comprobante que ya
 * está: reparaciones, importaciones de catálogo y reportes por familia tienen
 * que poder correr sobre una factura ya cerrada sin volver a leer la foto.
 */
async function comprobanteErrecaldeValidado(): Promise<string> {
  const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
  await adjuntarPagina(documento.id, SAFARI_COMPLETO);
  await leerComprobante(escenario.operadorDevoto, documento.id, {
    completo: SAFARI_COMPLETO,
    articulos: SAFARI_ARTICULOS,
    resumen: SAFARI_RESUMEN,
  });
  await acceptReadDocument(escenario.admin, documento.id);
  return documento.id;
}

describe('caso de aceptación: factura Los Calvos de punta a punta', () => {
  it('lee el comprobante, lo controla y lo deja listo para confirmar', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);

    const resultado = await leerComprobante(escenario.operadorDevoto, documento.id);

    expect(resultado.report.canSave).toBe(true);
    expect(resultado.report.computed.itemCount).toBe(9);
    expect(resultado.report.computed.netAmount).toBe('1792751.44');
    expect(resultado.report.computed.totalQuantityKg).toBe('153.700');
    expect(resultado.supplierId).toBe(escenario.proveedorId);
    // Los nueve renglones quedaron asociados a productos del catálogo.
    expect(resultado.renglonesAsociados).toBe(9);
    expect(resultado.renglonesSinAsociar).toBe(0);
    // Y usó el analizador específico del proveedor.
    expect(resultado.analizador).toBe('los-calvos');

    const guardado = await prisma.document.findUniqueOrThrow({
      where: { id: documento.id },
      include: { items: true, ocrAttempts: true },
    });
    expect(guardado.status).toBe('REQUIERE_REVISION');
    expect(guardado.items).toHaveLength(9);
    expect(guardado.fullNumber).toBe('0010-00212356');
    expect(toISODate(guardado.issueDate!)).toBe('2026-08-14');
    // Guardó las condiciones vigentes del proveedor.
    expect(guardado.appliedTermType).toBe('SAME_DAY');
    expect(guardado.appliedIvaRate?.toString()).toBe('0.21');
    expect(guardado.appliedIibbRate?.toString()).toBe('0.015');
    expect(toISODate(guardado.appliedDueDate!)).toBe('2026-08-14');
    // Y dejó el rastro de las lecturas.
    expect(guardado.ocrAttempts.length).toBeGreaterThan(0);
    expect(guardado.ocrAttempts[0].provider).toBe('tesseract-local');
    expect(guardado.ocrAttempts[0].recognizedText).toContain('LONGANIZA');
    // Y quedó registrado que cada importe salió impreso del comprobante, que es
    // lo que permite verificar la cantidad contra el papel.
    expect(guardado.items.every((i) => i.grossFromPrint)).toBe(true);
  });

  it('al confirmar guarda artículos, movimientos, costos y agenda de pago', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);
    await leerComprobante(escenario.operadorDevoto, documento.id);

    const resultado = await confirmDocument(escenario.admin, {
      ...datosConfirmacion(),
      documentId: documento.id,
    });

    expect(resultado.report.canSave).toBe(true);
    expect(resultado.forced).toBe(false);

    const guardado = await prisma.document.findUniqueOrThrow({
      where: { id: documento.id },
      include: {
        items: { orderBy: { lineNumber: 'asc' } },
        taxLines: true,
        purchaseMovements: true,
        paymentSchedule: true,
      },
    });

    expect(guardado.status).toBe('VALIDADO');
    expect(guardado.checkState).toBe('OK');
    expect(guardado.items).toHaveLength(9);
    expect(guardado.purchaseMovements).toHaveLength(9);

    // Los importes cierran exactamente con la factura.
    const sumar = (valores: { toString(): string }[]): number =>
      valores.reduce<number>((acc, v) => acc + Number(v.toString()), 0);
    expect(sumar(guardado.items.map((i) => i.netAmount)).toFixed(2)).toBe('1792751.44');
    expect(sumar(guardado.items.map((i) => i.ivaAmount)).toFixed(2)).toBe('376477.81');
    expect(sumar(guardado.items.map((i) => i.perceptionAmount)).toFixed(2)).toBe('26891.27');
    expect(sumar(guardado.items.map((i) => i.totalCost)).toFixed(2)).toBe('2196120.52');
    expect(sumar(guardado.items.map((i) => i.quantity)).toFixed(2)).toBe('153.70');

    // El pago quedó agendado para la fecha de la factura, y NO pagado.
    expect(guardado.paymentSchedule).not.toBeNull();
    expect(toISODate(guardado.paymentSchedule!.dueDate)).toBe('2026-08-14');
    expect(guardado.paymentSchedule!.plannedAmount.toString()).toBe('2196120.52');
    expect(guardado.paymentSchedule!.paidAmount.toString()).toBe('0');
    expect(guardado.paymentSchedule!.status).not.toBe('PAGADO');

    // Historial de costos con el costo unitario final de cada producto.
    const costos = await prisma.costHistory.findMany();
    expect(costos).toHaveLength(9);

    // El IVA y la percepción quedaron discriminados.
    expect(guardado.taxLines.filter((t) => t.kind === 'IVA')).toHaveLength(1);
    expect(guardado.taxLines.filter((t) => t.kind === 'PERCEPCION')).toHaveLength(1);
  });

  it('una factura del día queda como "vence hoy" hasta que alguien confirme el pago', async () => {
    // El plazo de Los Calvos es "en el día": la fecha prevista es la de la
    // factura, pero eso no la marca pagada.
    const estado = computePaymentStatus(
      {
        dueDate: dateOnlyFromISO('2026-08-14'),
        plannedAmount: '2196120.52',
        paidAmount: '0',
      },
      new Date('2026-08-14T15:00:00Z'),
    );
    expect(estado).toBe('VENCE_HOY');
  });
});

/**
 * Renglones con un importe mal reconocido: al primero le falta un dígito. Es el
 * caso típico de una foto movida, y es el que dispara la relectura enfocada.
 */
const ARTICULOS_MAL_LEIDOS = LOS_CALVOS_ARTICULOS_OCR.replace(
  '258.195,7O',
  '25.195,7O',
);

describe('relectura automática', () => {
  it('no acepta una lectura que no cierra y pide releer, diciendo qué falló', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);

    const primera = await leerComprobante(escenario.operadorDevoto, documento.id, {
      articulos: ARTICULOS_MAL_LEIDOS,
    });

    expect(primera.report.canSave).toBe(false);
    expect(primera.report.state).toBe('DIFERENCIA');
    expect(primera.releer).not.toBeNull();
    expect(primera.releer!.motivo).not.toBe('');

    const guardado = await prisma.document.findUniqueOrThrow({
      where: { id: documento.id },
    });
    expect(guardado.checkState).toBe('DIFERENCIA');
  });

  it('la segunda lectura enfocada cierra la cuenta y el comprobante queda en verde', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);

    await leerComprobante(escenario.operadorDevoto, documento.id, {
      articulos: ARTICULOS_MAL_LEIDOS,
    });
    const segunda = await leerComprobante(escenario.operadorDevoto, documento.id, {
      intento: 2,
    });

    expect(segunda.intentos).toBe(2);
    expect(segunda.report.canSave).toBe(true);
    expect(segunda.report.computed.netAmount).toBe('1792751.44');
    expect(segunda.releer).toBeNull();
  });

  it('gana el conjunto más consistente aunque no sea el último leído', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);

    // Primero la lectura buena, después una peor: la buena tiene que sobrevivir.
    await leerComprobante(escenario.operadorDevoto, documento.id);
    const segunda = await leerComprobante(escenario.operadorDevoto, documento.id, {
      intento: 2,
      articulos: ARTICULOS_MAL_LEIDOS,
    });

    expect(segunda.report.canSave).toBe(true);
    expect(segunda.report.computed.itemCount).toBe(9);
    expect(segunda.report.computed.netAmount).toBe('1792751.44');
  });

  it('agotados los intentos queda en rojo, bloquea el guardado y no inventa nada', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);

    let ultima = await leerComprobante(escenario.operadorDevoto, documento.id, {
      articulos: ARTICULOS_MAL_LEIDOS,
    });
    for (let intento = 2; ultima.releer; intento++) {
      ultima = await leerComprobante(escenario.operadorDevoto, documento.id, {
        intento,
        articulos: ARTICULOS_MAL_LEIDOS,
      });
    }

    expect(ultima.report.canSave).toBe(false);
    expect(ultima.report.state).toBe('DIFERENCIA');
    expect(ultima.report.errorCount).toBeGreaterThan(0);
    // No se tocó ningún importe para hacer cerrar la cuenta: el renglón mal
    // leído sigue mal leído, y por eso el control está en rojo.
    const guardado = await prisma.document.findUniqueOrThrow({
      where: { id: documento.id },
      include: { items: { orderBy: { lineNumber: 'asc' } } },
    });
    expect(Number(guardado.items[0].grossSubtotal.toString())).toBeCloseTo(25195.7, 2);
    expect(guardado.checkState).toBe('DIFERENCIA');
  });

  it('volver a leer empieza de cero: no compite contra los intentos de la vez anterior', async () => {
    /*
     * El caso que esto ataja, que costó caro: alguien lee un comprobante, no
     * cierra, se releen las zonas y quedan guardados los intentos 1 y 2. Más
     * tarde —al día siguiente, o después de un despliegue con el analizador
     * corregido— vuelve a leer el mismo comprobante desde la imagen guardada.
     *
     * Antes sólo se pisaba el intento con el mismo número, así que el intento 2
     * de la vez anterior sobrevivía y seguía compitiendo. Si le ganaba al nuevo,
     * la pantalla mostraba el resultado viejo y no había nada que lo delatara:
     * parecía que la corrección no había servido de nada.
     *
     * Una lectura nueva —intento 1— tiene que borrar todo lo anterior.
     */
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);

    // Una lectura vieja de dos vueltas, la segunda con la tabla bien leída.
    await leerComprobante(escenario.operadorDevoto, documento.id, {
      articulos: ARTICULOS_MAL_LEIDOS,
    });
    await leerComprobante(escenario.operadorDevoto, documento.id, { intento: 2 });
    expect(await prisma.ocrAttempt.count({ where: { documentId: documento.id } })).toBe(2);

    // Ahora se vuelve a leer desde la imagen, y esta vez la tabla sale mal.
    const nueva = await leerComprobante(escenario.operadorDevoto, documento.id, {
      articulos: ARTICULOS_MAL_LEIDOS,
    });

    // Queda un solo intento: el de recién.
    const intentos = await prisma.ocrAttempt.findMany({ where: { documentId: documento.id } });
    expect(intentos).toHaveLength(1);
    expect(intentos[0].attemptNumber).toBe(1);
    expect(nueva.intentos).toBe(1);

    // Y el resultado es el de esta lectura, no el bueno de la anterior: si el
    // texto que se acaba de leer no cierra, el comprobante no cierra.
    expect(nueva.report.canSave).toBe(false);
    expect(nueva.report.state).toBe('DIFERENCIA');
  });

  it('anota con qué versión del código se interpretó cada intento', async () => {
    // Es lo que permite decir, mirando un comprobante ya leído, si sus números
    // los calculó la versión que está corriendo o una anterior al despliegue.
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);
    await leerComprobante(escenario.operadorDevoto, documento.id);

    const intento = await prisma.ocrAttempt.findFirstOrThrow({
      where: { documentId: documento.id },
    });
    expect(intento.buildSha).toBe(versionEnEjecucion().commit);
  });

  it('guarda el rastro de cada intento: estrategia, lector y texto reconocido', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);

    await leerComprobante(escenario.operadorDevoto, documento.id, {
      articulos: ARTICULOS_MAL_LEIDOS,
    });
    await leerComprobante(escenario.operadorDevoto, documento.id, { intento: 2 });

    const intentos = await prisma.ocrAttempt.findMany({
      where: { documentId: documento.id },
      orderBy: { attemptNumber: 'asc' },
    });
    expect(intentos).toHaveLength(2);
    expect(intentos.map((i) => i.attemptNumber)).toEqual([1, 2]);
    for (const intento of intentos) {
      expect(intento.provider).toBe('tesseract-local');
      expect(intento.durationMs).toBeGreaterThan(0);
      expect(intento.recognizedText).toContain('LONGANIZA');
    }
  });
});

describe('conciliación automática de centavos por OCR', () => {
  /**
   * El primer renglón con los centavos del importe comidos: el papel dice
   * 258.195,70 y el OCR lee 258.195,00. Setenta centavos sobre dos millones.
   */
  const CENTAVOS_COMIDOS = LOS_CALVOS_ARTICULOS_OCR.replace('258.195,7O', '258.195,OO');

  it('la concilia, guarda el comprobante en verde y deja el rastro completo', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);

    const lectura = await leerComprobante(escenario.operadorDevoto, documento.id, {
      articulos: CENTAVOS_COMIDOS,
    });

    // Verde y guardable: los centavos no frenan el comprobante.
    expect(lectura.report.errorCount).toBe(0);
    expect(lectura.report.canSave).toBe(true);

    // Y el rastro: importe leído, importe conciliado, diferencia y renglón.
    const conciliacion = lectura.report.reconciliation;
    expect(conciliacion).not.toBeNull();
    expect(conciliacion!.totalAbsoluto).toBe('0.70');
    expect(conciliacion!.renglones).toHaveLength(1);
    expect(conciliacion!.renglones[0]).toMatchObject({
      lineNumber: 1,
      supplierCode: '1001',
      leido: '258195.00',
      conciliado: '258195.70',
      diferencia: '0.70',
    });

    // El renglón quedó guardado con el importe conciliado.
    const items = await prisma.documentItem.findMany({
      where: { documentId: documento.id },
      orderBy: { lineNumber: 'asc' },
    });
    expect(items[0].grossSubtotal.toFixed(2)).toBe('258195.70');

    // El informe se persiste con el comprobante, así que la conciliación se
    // puede consultar después junto a la imagen.
    const guardado = await prisma.document.findUniqueOrThrow({ where: { id: documento.id } });
    const informe = guardado.checkReport as unknown as { reconciliation?: { totalAbsoluto: string } };
    expect(informe.reconciliation?.totalAbsoluto).toBe('0.70');
    expect(await prisma.documentFile.count({ where: { documentId: documento.id } })).toBe(1);

    // Y su propio asiento de auditoría, buscable por acción.
    const auditoria = await prisma.auditLog.findFirst({
      where: { entityId: documento.id, action: 'comprobante.centavos_conciliados' },
    });
    expect(auditoria).not.toBeNull();
    expect(auditoria!.reason).toMatch(/Se conciliaron autom/);
    const detalle = auditoria!.after as unknown as {
      totalConciliado: string;
      renglones: { leido: string; conciliado: string; diferencia: string }[];
    };
    expect(detalle.totalConciliado).toBe('0.70');
    expect(detalle.renglones[0].leido).toBe('258195.00');
    expect(detalle.renglones[0].conciliado).toBe('258195.70');
  });

  it('una diferencia de un peso sigue frenando el comprobante', async () => {
    // 258.195,70 leído como 258.194,70: un peso justo. El tope es duro, y
    // además cambia la parte entera, que es la señal de que no son centavos.
    const unPeso = LOS_CALVOS_ARTICULOS_OCR.replace('258.195,7O', '258.194,7O');
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);

    const lectura = await leerComprobante(escenario.operadorDevoto, documento.id, {
      articulos: unPeso,
    });

    expect(lectura.report.reconciliation ?? null).toBeNull();
    expect(lectura.report.canSave).toBe(false);
    expect(lectura.report.state).toBe('DIFERENCIA');

    const guardado = await prisma.document.findUniqueOrThrow({ where: { id: documento.id } });
    expect(guardado.status).toBe('REQUIERE_REVISION');
    expect(
      await prisma.auditLog.count({
        where: { entityId: documento.id, action: 'comprobante.centavos_conciliados' },
      }),
    ).toBe(0);
  });

  it('una cantidad mal leída no se disfraza de diferencia de centavos', async () => {
    // 16,10 kg leído como 16,00: el importe impreso deja de cerrar por más de
    // un peso, así que no hay nada que conciliar y el comprobante frena.
    const cantidadMal = LOS_CALVOS_ARTICULOS_OCR.replace('l6,1O   16.O37,OO', 'l6,OO   16.O37,OO');
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);

    const lectura = await leerComprobante(escenario.operadorDevoto, documento.id, {
      articulos: cantidadMal,
    });

    expect(lectura.report.reconciliation ?? null).toBeNull();
    expect(lectura.report.canSave).toBe(false);
  });

  it('no se concilia nada cuando el comprobante ya cierra', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);

    const lectura = await leerComprobante(escenario.operadorDevoto, documento.id);
    expect(lectura.report.canSave).toBe(true);
    expect(lectura.report.reconciliation ?? null).toBeNull();
  });
});

describe('los números escritos como en el papel', () => {
  it('guarda un comprobante cuyo resumen viene en formato argentino', async () => {
    // Es lo que manda la pantalla de revisión: los campos se muestran y se
    // escriben como en el comprobante, con punto de miles y coma decimal.
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);
    await leerComprobante(escenario.operadorDevoto, documento.id);

    await confirmDocument(escenario.admin, {
      ...datosConfirmacion({
        printed: {
          grossSubtotal: '2.084.594,70',
          discountTotal: '291.843,26',
          netTotal: '1.792.751,44',
          ivaTotal: '376.477,81',
          perceptionsTotal: '26.891,27',
          total: '2.196.120,52',
          lineCount: 9,
          netWeightKg: '153,70',
        },
      }),
      documentId: documento.id,
    });

    const guardado = await prisma.document.findUniqueOrThrow({ where: { id: documento.id } });
    expect(guardado.status).toBe('VALIDADO');
    expect(guardado.total?.toString()).toBe('2196120.52');
    expect(guardado.netTotal?.toString()).toBe('1792751.44');
    expect(guardado.printedNetWeightKg?.toString()).toBe('153.7');
  });
});

describe('el backend revalida antes de guardar', () => {
  it('no guarda un comprobante cuyo detalle no cierra, aunque el pedido diga que sí', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);
    await leerComprobante(escenario.operadorDevoto, documento.id);

    // Falta un renglón: el neto ya no llega al impreso.
    const datos = datosConfirmacion();
    const error = await confirmDocument(escenario.admin, {
      ...datos,
      items: datos.items.slice(0, 8),
      documentId: documento.id,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/no se puede guardar como controlado/i);

    const guardado = await prisma.document.findUniqueOrThrow({ where: { id: documento.id } });
    expect(guardado.status).toBe('REQUIERE_REVISION');
    expect(await prisma.purchaseMovement.count()).toBe(0);
    expect(await prisma.paymentSchedule.count()).toBe(0);
  });

  it('un administrador puede forzarlo, pero sólo con un motivo y queda en auditoría', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);
    await leerComprobante(escenario.operadorDevoto, documento.id);

    const datos = datosConfirmacion();
    const incompleto = { ...datos, items: datos.items.slice(0, 8), documentId: documento.id };

    // Sin motivo suficiente, no.
    await expect(
      confirmDocument(escenario.admin, { ...incompleto, override: { reason: 'porque sí' } }),
    ).rejects.toThrow(/motivo/i);

    // Un operador no puede forzar aunque ponga el motivo.
    await expect(
      confirmDocument(escenario.operadorDevoto, {
        ...incompleto,
        override: { reason: 'El proveedor confirmó por teléfono que el subtotal está mal impreso.' },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // El administrador sí, y queda registrado.
    const resultado = await confirmDocument(escenario.admin, {
      ...incompleto,
      override: { reason: 'El proveedor confirmó por teléfono que el subtotal está mal impreso.' },
    });
    expect(resultado.forced).toBe(true);

    const guardado = await prisma.document.findUniqueOrThrow({ where: { id: documento.id } });
    expect(guardado.status).toBe('VALIDADO');
    // Forzado no es lo mismo que controlado: el semáforo queda en rojo.
    expect(guardado.checkState).toBe('DIFERENCIA');
    expect(guardado.voidReason).toContain('teléfono');

    const auditoria = await prisma.auditLog.findFirst({
      where: { action: 'comprobante.forzado', entityId: documento.id },
    });
    expect(auditoria).not.toBeNull();
    expect(auditoria!.reason).toContain('teléfono');
  });
});

describe('duplicados', () => {
  it('no deja cargar dos veces la misma factura del mismo proveedor', async () => {
    const primero = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(primero.id, LOS_CALVOS_TEXT);
    await leerComprobante(escenario.operadorDevoto, primero.id);
    await confirmDocument(escenario.admin, { ...datosConfirmacion(), documentId: primero.id });

    // Otra sucursal intenta cargar la misma factura.
    const segundo = await createDocument(
      escenario.operadorPueyrredon,
      escenario.sucursales.pueyrredon,
    );
    await adjuntarPagina(segundo.id, LOS_CALVOS_TEXT);
    await leerComprobante(escenario.operadorPueyrredon, segundo.id);

    const error = await confirmDocument(escenario.admin, {
      ...datosConfirmacion(),
      documentId: segundo.id,
    }).catch((e) => e);

    expect(error.message).toMatch(/Ya está cargada/);
    expect(error.message).toContain('0010-00212356');
    expect(error.message).toContain('Devoto');
  });

  it('rechazar la primera carga libera el número para volver a cargarla', async () => {
    const primero = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(primero.id, LOS_CALVOS_TEXT);
    await leerComprobante(escenario.operadorDevoto, primero.id);
    await rejectDocument(escenario.operadorDevoto, primero.id, 'Se cargó en la sucursal equivocada');

    const segundo = await createDocument(
      escenario.operadorPueyrredon,
      escenario.sucursales.pueyrredon,
    );
    await adjuntarPagina(segundo.id, LOS_CALVOS_TEXT);
    await leerComprobante(escenario.operadorPueyrredon, segundo.id);

    const resultado = await confirmDocument(escenario.admin, {
      ...datosConfirmacion(),
      documentId: segundo.id,
    });
    expect(resultado.report.canSave).toBe(true);
  });

  it('la misma foto no se agrega dos veces al comprobante', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT, 1);
    // La restricción de unicidad por SHA-256 impide la segunda copia.
    await expect(adjuntarPagina(documento.id, LOS_CALVOS_TEXT, 1)).rejects.toThrow();
    expect(await prisma.documentFile.count({ where: { documentId: documento.id } })).toBe(1);
  });
});

describe('restricciones por sucursal', () => {
  it('un operador no puede cargar en otra sucursal', async () => {
    await expect(
      createDocument(escenario.operadorDevoto, escenario.sucursales.pueyrredon),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('un operador no puede confirmar el comprobante de otra sucursal', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);
    await leerComprobante(escenario.operadorDevoto, documento.id);

    await expect(
      confirmDocument(escenario.operadorPueyrredon, {
        ...datosConfirmacion(),
        documentId: documento.id,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('el administrador ve y confirma las tres sucursales', async () => {
    const documento = await createDocument(escenario.admin, escenario.sucursales.sanMartin);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);
    await leerComprobante(escenario.admin, documento.id);
    const resultado = await confirmDocument(escenario.admin, {
      ...datosConfirmacion(),
      documentId: documento.id,
    });
    expect(resultado.report.canSave).toBe(true);
  });

  it('un operador sólo ve las compras de su sucursal en los reportes', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);
    await leerComprobante(escenario.operadorDevoto, documento.id);
    await confirmDocument(escenario.admin, { ...datosConfirmacion(), documentId: documento.id });

    const enDevoto = await getPurchaseReport(escenario.operadorDevoto, {});
    expect(enDevoto.rows).toHaveLength(9);

    const enPueyrredon = await getPurchaseReport(escenario.operadorPueyrredon, {});
    expect(enPueyrredon.rows).toHaveLength(0);

    // Y no puede espiar la otra sucursal pidiéndola explícitamente.
    const espiando = await getPurchaseReport(escenario.operadorPueyrredon, {
      branchId: escenario.sucursales.devoto,
    });
    expect(espiando.rows).toHaveLength(0);

    const elAdmin = await getPurchaseReport(escenario.admin, {});
    expect(elAdmin.rows).toHaveLength(9);
  });
});

describe('permisos administrativos', () => {
  it('un operador no puede anular un comprobante', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);
    await leerComprobante(escenario.operadorDevoto, documento.id);
    await confirmDocument(escenario.admin, { ...datosConfirmacion(), documentId: documento.id });

    await expect(
      voidDocument(escenario.operadorDevoto, documento.id, 'Me equivoqué al cargarla'),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('un supervisor no puede cargar comprobantes', async () => {
    await expect(
      createDocument(escenario.supervisor, escenario.sucursales.devoto),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('anular exige motivo, cancela el pago y borra los movimientos de compra', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);
    await leerComprobante(escenario.operadorDevoto, documento.id);
    await confirmDocument(escenario.admin, { ...datosConfirmacion(), documentId: documento.id });

    await expect(voidDocument(escenario.admin, documento.id, 'error')).rejects.toThrow(/motivo/i);

    await voidDocument(escenario.admin, documento.id, 'El proveedor emitió una nota de crédito.');

    const guardado = await prisma.document.findUniqueOrThrow({
      where: { id: documento.id },
      include: { paymentSchedule: true },
    });
    expect(guardado.status).toBe('ANULADO');
    expect(guardado.voidReason).toContain('nota de crédito');
    expect(guardado.paymentSchedule!.status).toBe('CANCELADO');
    expect(await prisma.purchaseMovement.count()).toBe(0);

    const auditoria = await prisma.auditLog.findFirst({
      where: { action: 'comprobante.anulado', entityId: documento.id },
    });
    expect(auditoria!.reason).toContain('nota de crédito');
  });
});

describe('transacciones', () => {
  it('si algo falla al guardar, no queda nada a medio escribir', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);
    await leerComprobante(escenario.operadorDevoto, documento.id);

    const datos = datosConfirmacion();
    // El último renglón apunta a un producto inexistente: la escritura del
    // movimiento de compra viola la clave foránea a mitad de la transacción.
    const conProductoRoto = {
      ...datos,
      items: datos.items.map((item, i) =>
        i === datos.items.length - 1 ? { ...item, productId: 'producto-que-no-existe' } : item,
      ),
      documentId: documento.id,
    };

    await expect(confirmDocument(escenario.admin, conProductoRoto)).rejects.toThrow();

    // El comprobante sigue sin confirmar y no quedó ningún rastro parcial.
    const guardado = await prisma.document.findUniqueOrThrow({ where: { id: documento.id } });
    expect(guardado.status).toBe('REQUIERE_REVISION');
    expect(await prisma.purchaseMovement.count()).toBe(0);
    expect(await prisma.paymentSchedule.count()).toBe(0);
    expect(await prisma.costHistory.count()).toBe(0);
  });
});

describe('pagos', () => {
  async function comprobanteConfirmado() {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);
    await leerComprobante(escenario.operadorDevoto, documento.id);
    const resultado = await confirmDocument(escenario.admin, {
      ...datosConfirmacion(),
      documentId: documento.id,
    });
    return resultado.paymentScheduleId;
  }

  it('confirmar el pago no pisa la fecha prevista y deja el evento', async () => {
    const scheduleId = await comprobanteConfirmado();

    await confirmPayment(escenario.admin, {
      scheduleId,
      effectiveDate: '2026-08-18',
      paymentMethod: 'TRANSFERENCIA',
      reference: 'OP-99881',
      notes: 'Pagado con cheque diferido cambiado',
    });

    const agenda = await prisma.paymentSchedule.findUniqueOrThrow({
      where: { id: scheduleId },
      include: { events: true },
    });

    expect(agenda.status).toBe('PAGADO');
    expect(agenda.paidAmount.toString()).toBe('2196120.52');
    // La fecha prevista sigue siendo la de la factura.
    expect(toISODate(agenda.dueDate)).toBe('2026-08-14');
    // Y la efectiva quedó en el evento, junto con quién y cuándo lo confirmó.
    expect(agenda.events).toHaveLength(1);
    expect(toISODate(agenda.events[0].effectiveDate!)).toBe('2026-08-18');
    expect(agenda.events[0].reference).toBe('OP-99881');
    expect(agenda.events[0].userId).toBe(escenario.admin.id);
  });

  it('un operador no puede confirmar pagos', async () => {
    const scheduleId = await comprobanteConfirmado();
    await expect(
      confirmPayment(escenario.operadorDevoto, {
        scheduleId,
        effectiveDate: '2026-08-18',
        paymentMethod: 'TRANSFERENCIA',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('no acepta un pago mayor al saldo ni una fecha futura', async () => {
    const scheduleId = await comprobanteConfirmado();

    await expect(
      confirmPayment(escenario.admin, {
        scheduleId,
        effectiveDate: '2026-08-18',
        paymentMethod: 'EFECTIVO',
        amount: '9999999',
      }),
    ).rejects.toThrow(/supera el saldo/i);

    await expect(
      confirmPayment(escenario.admin, {
        scheduleId,
        effectiveDate: '2099-01-01',
        paymentMethod: 'EFECTIVO',
      }),
    ).rejects.toThrow(/futura/i);
  });

  it('admite un pago parcial y deja el comprobante abierto', async () => {
    const scheduleId = await comprobanteConfirmado();

    await confirmPayment(escenario.admin, {
      scheduleId,
      effectiveDate: '2026-08-18',
      paymentMethod: 'EFECTIVO',
      amount: '1000000',
    });

    const agenda = await prisma.paymentSchedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(agenda.paidAmount.toString()).toBe('1000000');
    expect(agenda.status).not.toBe('PAGADO');
  });
});

describe('historial de precios y precios de venta', () => {
  it('guarda el costo, calcula la variación y sugiere el precio de venta', async () => {
    // Primera compra.
    const primero = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(primero.id, LOS_CALVOS_TEXT);
    await leerComprobante(escenario.operadorDevoto, primero.id);
    await confirmDocument(escenario.admin, { ...datosConfirmacion(), documentId: primero.id });

    const longanizaId = escenario.productos['1001'];
    const costoInicial = await getLatestCost(longanizaId);
    expect(costoInicial.unitCost).not.toBeNull();
    expect(costoInicial.previousUnitCost).toBeNull();

    // Segunda compra del mismo producto, más cara.
    const segundo = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    const datos = datosConfirmacion({
      number: '00212400',
      issueDate: '2026-08-20',
      payment: { dueDate: '2026-08-20', paymentMethod: 'TRANSFERENCIA', notes: null },
    });
    const aumentado = {
      ...datos,
      // Sólo el primer renglón, con un precio 20 % más alto.
      items: [
        {
          ...datos.items[0],
          unitNetPrice: '19244.40',
          // 16,10 × 19.244,40: el importe impreso acompaña al precio nuevo.
          grossSubtotal: '309834.84',
        },
      ],
      printed: {
        grossSubtotal: '309834.84',
        discountTotal: '43376.88',
        netTotal: '266457.96',
        ivaTotal: '55956.17',
        perceptionsTotal: '3996.87',
        total: '326411.00',
        lineCount: 1,
        netWeightKg: '16.10',
      },
      documentId: segundo.id,
    };
    await confirmDocument(escenario.admin, aumentado);

    const costo = await getLatestCost(longanizaId);
    expect(costo.previousUnitCost).not.toBeNull();
    expect(costo.deltaAmount!.gt(0)).toBe(true);
    // Aumento del 20 %.
    expect(Number(costo.deltaPct!.toString())).toBeGreaterThan(0.19);
    expect(Number(costo.deltaPct!.toString())).toBeLessThan(0.21);

    // Precio de venta sugerido a partir del costo unitario final.
    const sugerencia = await suggestPricesFor(longanizaId);
    expect(sugerencia.prices).not.toBeNull();
    // 45 % sobre el costo, redondeado al $100 más cercano.
    const esperado = costo.unitCost!.times(1.45);
    expect(Number(sugerencia.prices!.pricePerKg.toString())).toBeCloseTo(
      Math.round(Number(esperado.toString()) / 100) * 100,
      2,
    );
    // Los derivados salen del precio por kilo ya redondeado.
    expect(sugerencia.prices!.pricePer100g.toFixed(2)).toBe(
      sugerencia.prices!.pricePerKg.div(10).toFixed(2),
    );
    expect(sugerencia.prices!.pricePerQuarter.toFixed(2)).toBe(
      sugerencia.prices!.pricePerKg.div(4).toFixed(2),
    );

    // Aprobar el precio lo deja en el historial.
    await approveSalePrice(escenario.admin, {
      productId: longanizaId,
      approvedPricePerKg: sugerencia.prices!.pricePerKg.toString(),
    });
    const historial = await prisma.salePriceHistory.findMany({ where: { productId: longanizaId } });
    expect(historial).toHaveLength(1);
    expect(historial[0].approvedById).toBe(escenario.admin.id);
    expect(historial[0].costBasis.toString()).toBe(costo.unitCost!.toFixed(2));

    // Un operador no puede aprobar precios.
    await expect(
      approveSalePrice(escenario.operadorDevoto, {
        productId: longanizaId,
        approvedPricePerKg: '1000',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('reporte de compras', () => {
  it('responde cuántos kilos se compraron de cada artículo y lo exporta a CSV', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, LOS_CALVOS_TEXT);
    await leerComprobante(escenario.operadorDevoto, documento.id);
    await confirmDocument(escenario.admin, { ...datosConfirmacion(), documentId: documento.id });

    const reporte = await getPurchaseReport(escenario.admin, {});
    expect(reporte.totals.kilos).toBe('153.70');
    expect(reporte.totals.costoTotal).toBe('2196120.52');
    expect(reporte.totals.comprobantes).toBe(1);

    // Filtrado por un producto.
    const soloJamon = await getPurchaseReport(escenario.admin, {
      productId: escenario.productos['1006'],
    });
    expect(soloJamon.rows).toHaveLength(1);
    expect(soloJamon.totals.kilos).toBe('37.60');

    const csv = purchaseReportToCsv(reporte);
    expect(csv).toContain('Costo unitario final');
    expect(csv).toContain('Longaniza corta');
    // Separador de punto y coma y decimales con coma, como espera Excel en español.
    expect(csv).toContain('";"');
    expect(csv).toContain('153,70');
  });
});

describe('la fila que se pierden el detector y el analizador a la vez', () => {
  beforeEach(async () => {
    await limpiarBase();
    escenario = await sembrarEscenario();
  });

  /**
   * El recorte de la tabla, cortado antes de terminar.
   *
   * Es lo que pasó en el teléfono: la última fila —TOMATE EN BOTELLA— no salió
   * del recorte de la tabla, y de la página completa quedó sólo un jirón sin
   * código ni descripción. El detector de filas tampoco la contó, así que las
   * dos medidas que el control compara se equivocaron **en el mismo sentido** y
   * el comprobante quedaba en "22 interpretados / 22 filas vistas", en verde,
   * con un artículo de menos y $32.683,24 sin cargar.
   *
   * Se construye sacándole esa fila al recorte del fixture real y dejando la
   * página completa intacta, que es exactamente la forma de la falla.
   */
  const RECORTE_CORTADO = SAFARI_ARTICULOS.split('\n')
    .filter((linea) => !linea.includes('TOMATE'))
    .join('\n');

  it('no da por completa una tabla a la que le falta una fila', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, SAFARI_COMPLETO);

    const lectura = await leerComprobante(escenario.operadorDevoto, documento.id, {
      completo: SAFARI_COMPLETO,
      articulos: RECORTE_CORTADO,
      resumen: SAFARI_RESUMEN,
    });

    const control = lectura.report.checks.find((c) => c.code === 'ART_RENGLONES_COMPLETOS');
    expect(control).toBeDefined();
    // Veintidós entendidos contra veintitrés vistos: el jirón cuenta como fila.
    expect(control!.actual).toBe('22');
    expect(control!.expected).toBe('23');
    expect(control!.severity).toBe('ERROR');

    // Y por lo tanto no se puede guardar como controlado.
    expect(lectura.report.canSave).toBe(false);
    expect(lectura.report.state).toBe('DIFERENCIA');
  });

  it('dice cuál es el tramo que no pudo leer, con su texto crudo', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, SAFARI_COMPLETO);

    const lectura = await leerComprobante(escenario.operadorDevoto, documento.id, {
      completo: SAFARI_COMPLETO,
      articulos: RECORTE_CORTADO,
      resumen: SAFARI_RESUMEN,
    });

    /*
     * No alcanza con frenar el comprobante: hay que poder ir a la foto y mirar
     * qué fila es. Por eso la observación lleva el texto tal cual salió del OCR
     * y el importe que tendría.
     */
    const aviso = lectura.observaciones.find((o) => o.includes('forma de renglón'));
    expect(aviso).toBeDefined();
    expect(aviso).toContain('$3268324');
    expect(aviso).toContain('32683.24');
  });

  it('con la fila entera en el recorte, el mismo comprobante cierra en 23', async () => {
    /*
     * El contraejemplo, y la razón por la que este control se puede confiar: con
     * el recorte completo no aparece ningún jirón, el control da 23 de 23 y el
     * comprobante se puede guardar.
     *
     * Sin esta prueba, un detector de jirones demasiado entusiasta —que contara
     * como fila cada pedazo suelto de la página completa— dejaría todos los
     * comprobantes en rojo para siempre y nadie lo notaría.
     */
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, SAFARI_COMPLETO);

    const lectura = await leerComprobante(escenario.operadorDevoto, documento.id, {
      completo: SAFARI_COMPLETO,
      articulos: SAFARI_ARTICULOS,
      resumen: SAFARI_RESUMEN,
    });

    const control = lectura.report.checks.find((c) => c.code === 'ART_RENGLONES_COMPLETOS');
    expect(control!.actual).toBe('23');
    expect(control!.expected).toBe('23');
    expect(control!.severity).toBe('OK');
    expect(lectura.report.canSave).toBe(true);
  });
});

describe('relectura focalizada del borde inferior de la tabla', () => {
  beforeEach(async () => {
    await limpiarBase();
    escenario = await sembrarEscenario();
  });

  /** El recorte de la tabla cortado antes de la última fila. */
  const RECORTE_CORTADO = SAFARI_ARTICULOS.split('\n')
    .filter((linea) => !linea.includes('TOMATE'))
    .join('\n');

  /** La fila que aparece cuando se relee sólo la franja de abajo. */
  const FILA_DEL_BORDE = SAFARI_ARTICULOS.split('\n')
    .filter((linea) => linea.includes('TOMATE'))
    .join('\n');

  it('pide releer el borde inferior, y no la página entera', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, SAFARI_COMPLETO);

    const lectura = await leerComprobante(escenario.operadorDevoto, documento.id, {
      completo: SAFARI_COMPLETO,
      articulos: RECORTE_CORTADO,
      resumen: SAFARI_RESUMEN,
    });

    /*
     * Las tres condiciones se dieron juntas: hay un jirón con forma de fila, está
     * después del último artículo identificado, y se vieron más filas de las que
     * se entendieron. Con eso el servidor puede decir *dónde* buscar, en vez de
     * pedir otra vuelta completa.
     */
    expect(lectura.releer).not.toBeNull();
    expect(lectura.releer!.zona).toBe('BORDE_INFERIOR_TABLA');
  });

  it('recupera TOMATE EN BOTELLA y el comprobante cierra en 23 de 23', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, SAFARI_COMPLETO);

    // Primera vuelta: la tabla llega cortada.
    const primera = await leerComprobante(escenario.operadorDevoto, documento.id, {
      completo: SAFARI_COMPLETO,
      articulos: RECORTE_CORTADO,
      resumen: SAFARI_RESUMEN,
    });
    expect(primera.report.canSave).toBe(false);

    /*
     * Segunda vuelta: lo que devuelve el lector después de releer la franja es el
     * texto que ya tenía **más** el de la franja. No se reemplaza: si se
     * reemplazara, el intento 2 traería dos o tres renglones y perdería contra el
     * intento 1, y la relectura no serviría de nada.
     */
    const segunda = await leerComprobante(escenario.operadorDevoto, documento.id, {
      intento: 2,
      completo: SAFARI_COMPLETO,
      articulos: `${RECORTE_CORTADO}\n${FILA_DEL_BORDE}`,
      resumen: SAFARI_RESUMEN,
    });

    const control = segunda.report.checks.find((c) => c.code === 'ART_RENGLONES_COMPLETOS');
    expect(control!.actual).toBe('23');
    expect(control!.expected).toBe('23');
    expect(control!.severity).toBe('OK');

    // Y ya no queda ningún jirón sin resolver: no hay a dónde volver.
    expect(segunda.releer).toBeNull();
    expect(segunda.report.canSave).toBe(true);

    // La fila recuperada, con sus números del papel.
    const items = await prisma.documentItem.findMany({
      where: { documentId: documento.id },
      orderBy: { lineNumber: 'asc' },
    });
    expect(items).toHaveLength(23);
    const tomate = items.find((i) => i.description.includes('TOMATE'));
    expect(tomate).toBeDefined();
    expect(tomate!.supplierCode).toBe('ART-01477');
    expect(tomate!.quantity.toFixed(2)).toBe('32.00');
    expect(tomate!.unitNetPrice.toFixed(2)).toBe('1021.35');
    expect(tomate!.grossSubtotal.toFixed(2)).toBe('32683.24');

    // Y el comprobante entero, contra el papel.
    expect(segunda.report.computed.itemCount).toBe(23);
    expect(segunda.report.computed.totalQuantityKg).toBe('480.340');
    expect(segunda.report.computed.totalCost).toBe('4816812.73');
  });

  it('si la franja no trae nada nuevo, queda en rojo y no inventa el renglón', async () => {
    /*
     * El límite. Si la segunda pasada sobre la franja devuelve lo mismo que ya se
     * tenía —porque en esa parte de la foto no se lee—, el comprobante tiene que
     * quedar en rojo para que lo mire una persona.
     *
     * Lo que **no** puede hacer es completar el renglón que falta restando el
     * detalle contra el neto impreso: daría un importe que cierra y un precio que
     * nadie leyó, y ese precio terminaría en el costo del artículo y de ahí en el
     * precio de venta al público.
     */
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, SAFARI_COMPLETO);

    await leerComprobante(escenario.operadorDevoto, documento.id, {
      completo: SAFARI_COMPLETO,
      articulos: RECORTE_CORTADO,
      resumen: SAFARI_RESUMEN,
    });
    const segunda = await leerComprobante(escenario.operadorDevoto, documento.id, {
      intento: 2,
      completo: SAFARI_COMPLETO,
      articulos: RECORTE_CORTADO,
      resumen: SAFARI_RESUMEN,
    });

    expect(segunda.report.canSave).toBe(false);

    const items = await prisma.documentItem.findMany({ where: { documentId: documento.id } });
    expect(items).toHaveLength(22);
    // Ningún renglón inventado con el importe que falta.
    expect(items.some((i) => i.grossSubtotal.toFixed(2) === '32683.24')).toBe(false);
  });
});

describe('cuándo NO corresponde releer el borde', () => {
  beforeEach(async () => {
    await limpiarBase();
    escenario = await sembrarEscenario();
  });

  it('un jirón en el medio de la tabla no manda a releer el borde', async () => {
    /*
     * La condición que distingue "la franja se cortó y falta el final" de "una
     * fila quedó partida en el medio".
     *
     * Se construye moviendo el mismo jirón —el de TOMATE— al principio del
     * cuerpo de la tabla en la página completa. Todo lo demás queda igual: sigue
     * habiendo un tramo con forma de fila sin identificar, y se siguen viendo más
     * filas de las que se entienden. Lo único que cambia es que ahora tiene
     * renglones identificados **después**, así que no dice nada sobre el borde de
     * abajo.
     *
     * Sin esta prueba, la condición de la cola podría desaparecer sin que nada se
     * pusiera rojo: las otras dos alcanzan para el caso feliz. Lo que se rompería
     * en silencio es lo caro —una pasada de OCR sobre la franja equivocada, y el
     * comprobante igual de rojo—.
     */
    const lineas = SAFARI_COMPLETO.split('\n');
    const jiron = lineas.findIndex((l) => l.includes('$3268324'));
    expect(jiron).toBeGreaterThan(0);
    const primerArticulo = lineas.findIndex((l) => l.includes('ART-00873'));
    const movido = [
      ...lineas.slice(0, primerArticulo),
      lineas[jiron],
      ...lineas.slice(primerArticulo, jiron),
      ...lineas.slice(jiron + 1),
    ].join('\n');

    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, movido);

    const lectura = await leerComprobante(escenario.operadorDevoto, documento.id, {
      completo: movido,
      articulos: SAFARI_ARTICULOS.split('\n')
        .filter((l) => !l.includes('TOMATE'))
        .join('\n'),
      resumen: SAFARI_RESUMEN,
    });

    // Sigue en rojo, que es lo correcto: falta un artículo.
    expect(lectura.report.canSave).toBe(false);
    // Pero no se manda a releer una franja que no es la que tiene el problema.
    expect(lectura.releer?.zona ?? null).toBeNull();
  });
});

describe('cuando el detector y el analizador se pierden la misma fila', () => {
  beforeEach(async () => {
    await limpiarBase();
    escenario = await sembrarEscenario();
  });

  /*
   * El caso real, medido en un iPhone sobre la foto de Errecalde.
   *
   * El detector de disposición cuenta 22 filas sobre la imagen. El analizador
   * interpreta 22 renglones. Los dos números coinciden, así que el control de
   * completitud da "22 de 22" y el comprobante se guardaría en verde con un
   * artículo de menos.
   *
   * Y sin embargo falta uno: en la página completa quedó
   * "2             0% — 21% $3268324", que es el renglón de TOMATE EN BOTELLA
   * sin código ni descripción, después del último artículo identificado.
   *
   * Ese jirón tiene que valer por sí solo como evidencia de una fila más. Es la
   * única señal que no depende de ninguno de los dos mecanismos que fallaron.
   */
  const RECORTE_SIN_TOMATE = SAFARI_ARTICULOS.split('\n')
    .filter((linea) => !linea.includes('TOMATE'))
    .join('\n');

  it('el jirón del final vale por una fila aunque el detector no la haya contado', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, SAFARI_COMPLETO);

    const lectura = await leerComprobante(escenario.operadorDevoto, documento.id, {
      completo: SAFARI_COMPLETO,
      articulos: RECORTE_SIN_TOMATE,
      resumen: SAFARI_RESUMEN,
      // El detector vio 22, igual que los renglones interpretados.
      filasDetectadas: 22,
    });

    const control = lectura.report.checks.find((c) => c.code === 'ART_RENGLONES_COMPLETOS');
    expect(control!.actual).toBe('22');
    // 22 del detector, pero 22 interpretados + 1 jirón: manda el más alto.
    expect(control!.expected).toBe('23');
    expect(control!.severity).toBe('ERROR');

    // Y por lo tanto se pide la relectura del borde, que es lo que no pasaba.
    expect(lectura.releer?.zona).toBe('BORDE_INFERIOR_TABLA');
    expect(lectura.report.canSave).toBe(false);
  });

  it('con la tabla entera, el mismo detector de 22 no inventa una fila de más', async () => {
    /*
     * El contraejemplo. Si el jirón se contara siempre, o si se contaran los
     * pedazos de filas que ya están leídas, este comprobante —que está completo—
     * quedaría pidiendo una fila que no existe y no se podría guardar nunca.
     */
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, SAFARI_COMPLETO);

    const lectura = await leerComprobante(escenario.operadorDevoto, documento.id, {
      completo: SAFARI_COMPLETO,
      articulos: SAFARI_ARTICULOS,
      resumen: SAFARI_RESUMEN,
      filasDetectadas: 22,
    });

    const control = lectura.report.checks.find((c) => c.code === 'ART_RENGLONES_COMPLETOS');
    expect(control!.actual).toBe('23');
    expect(control!.expected).toBe('23');
    expect(control!.severity).toBe('OK');
    expect(lectura.releer?.zona ?? null).toBeNull();
    expect(lectura.report.canSave).toBe(true);
  });

  it('el diagnóstico informa los tres números, no sólo el del detector', async () => {
    /*
     * Mirar sólo el conteo del detector desde el teléfono lleva a la conclusión
     * equivocada: dice "22 filas / 22 renglones" y parece que el control no se
     * está disparando, cuando el número que decide es 23 y sí se dispara.
     *
     * Así que el diagnóstico tiene que informar los tres por separado, y decir
     * si al leer el comprobante de verdad pediría releer una franja.
     */
    const resultado = analizarSinGuardar([
      {
        numero: 1,
        textoCompleto: SAFARI_COMPLETO,
        textoArticulos: RECORTE_SIN_TOMATE,
        textoResumen: SAFARI_RESUMEN,
        regiones: { filasDetectadas: 22 },
      },
    ]);

    expect(resultado.filasDelDetector).toBe(22);
    expect(resultado.articulos).toBe(22);
    expect(resultado.filasSinResolver).toBe(1);
    expect(resultado.filasEsperadas).toBe(23);
    expect(resultado.zonaSugerida).toBe('BORDE_INFERIOR_TABLA');
  });
});

describe('aceptar un comprobante que ya se leyó bien', () => {
  beforeEach(async () => {
    await limpiarBase();
    escenario = await sembrarEscenario();
  });

  /*
   * El callejón sin salida.
   *
   * Un comprobante leído queda en REQUIERE_REVISION esperando confirmación. Si
   * la pantalla de carga se cierra —se cambió de pantalla, se cortó la
   * conexión, se dejó para después— la única forma de volver a él era el
   * detalle, y ahí sólo había "rechazar" y "volver". Un comprobante correcto no
   * puede tener como única salida tirarlo y sacar la foto de nuevo.
   */

  it('la factura real de Errecalde termina en VALIDADO sin rechazarla ni releerla', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, SAFARI_COMPLETO);

    const lectura = await leerComprobante(escenario.operadorDevoto, documento.id, {
      completo: SAFARI_COMPLETO,
      articulos: SAFARI_ARTICULOS,
      resumen: SAFARI_RESUMEN,
    });

    // Se leyó entera y sin errores, pero queda esperando que alguien la acepte.
    expect(lectura.report.errorCount).toBe(0);
    expect(lectura.report.canSave).toBe(true);
    const antes = await prisma.document.findUniqueOrThrow({ where: { id: documento.id } });
    expect(antes.status).toBe('REQUIERE_REVISION');

    // Y ahora se acepta, con lo que está guardado. Sin volver a leer la imagen.
    const resultado = await acceptReadDocument(escenario.admin, documento.id);

    const despues = await prisma.document.findUniqueOrThrow({
      where: { id: documento.id },
      include: { items: true, paymentSchedule: true },
    });
    expect(despues.status).toBe('VALIDADO');
    expect(despues.validatedById).toBe(escenario.admin.id);
    expect(despues.validatedAt).not.toBeNull();

    // Los números del papel, intactos.
    expect(despues.items).toHaveLength(23);
    expect(despues.netTotal!.toFixed(2)).toBe('3830467.37');
    expect(despues.ivaTotal!.toFixed(2)).toBe('804398.16');
    expect(despues.perceptionsTotal!.toFixed(2)).toBe('181947.20');
    expect(despues.total!.toFixed(2)).toBe('4816812.73');

    // Y las dos percepciones siguen discriminadas.
    const percepciones = await prisma.documentTaxLine.findMany({
      where: { documentId: documento.id, kind: 'PERCEPCION' },
      orderBy: { amount: 'desc' },
    });
    expect(percepciones.map((p) => p.amount.toFixed(2))).toEqual(['114914.02', '67033.18']);

    // El pago quedó agendado.
    expect(despues.paymentSchedule).not.toBeNull();
    expect(resultado.paymentScheduleId).toBe(despues.paymentSchedule!.id);
    expect(resultado.forced).toBe(false);
  });

  it('vuelve a correr los controles: no cambia el estado a mano', async () => {
    /*
     * La diferencia entre aceptar y "marcar como aceptado".
     *
     * Si alguien toca los renglones en la base entre la lectura y la
     * aceptación, el comprobante ya no cierra y no se puede validar. Aceptar
     * tiene que volver a hacer la cuenta, no confiar en el informe viejo.
     */
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, SAFARI_COMPLETO);
    await leerComprobante(escenario.operadorDevoto, documento.id, {
      completo: SAFARI_COMPLETO,
      articulos: SAFARI_ARTICULOS,
      resumen: SAFARI_RESUMEN,
    });

    // Se le borra un renglón por debajo: el detalle deja de dar el neto.
    const primero = await prisma.documentItem.findFirstOrThrow({
      where: { documentId: documento.id },
      orderBy: { lineNumber: 'asc' },
    });
    await prisma.documentItem.delete({ where: { id: primero.id } });

    await expect(acceptReadDocument(escenario.admin, documento.id)).rejects.toThrow(
      /no coincide|no cierra|no se puede guardar/i,
    );

    const despues = await prisma.document.findUniqueOrThrow({ where: { id: documento.id } });
    expect(despues.status).toBe('REQUIERE_REVISION');
  });

  it('dice exactamente qué control no cierra', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, SAFARI_COMPLETO);
    await leerComprobante(escenario.operadorDevoto, documento.id, {
      completo: SAFARI_COMPLETO,
      articulos: SAFARI_ARTICULOS,
      resumen: SAFARI_RESUMEN,
    });
    const primero = await prisma.documentItem.findFirstOrThrow({
      where: { documentId: documento.id },
      orderBy: { lineNumber: 'asc' },
    });
    await prisma.documentItem.delete({ where: { id: primero.id } });

    /*
     * "El comprobante no cierra" no le sirve a nadie parado frente al
     * proveedor. Los controles en error viajan adentro del error para que la
     * pantalla pueda decir cuál y con qué diferencia.
     */
    const error = await acceptReadDocument(escenario.admin, documento.id).catch((e) => e);
    const detalles = (error.details as { checks?: { label: string }[] }).checks;
    expect(detalles).toBeDefined();
    expect(detalles!.length).toBeGreaterThan(0);
    expect(detalles!.some((c) => /neto|renglones/i.test(c.label))).toBe(true);
  });

  it('un usuario sin permiso de validar no puede aceptar', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, SAFARI_COMPLETO);
    await leerComprobante(escenario.operadorDevoto, documento.id, {
      completo: SAFARI_COMPLETO,
      articulos: SAFARI_ARTICULOS,
      resumen: SAFARI_RESUMEN,
    });

    // El supervisor mira todo y no toca nada: es el rol que no puede validar.
    await expect(acceptReadDocument(escenario.supervisor, documento.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('no se puede aceptar dos veces', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, SAFARI_COMPLETO);
    await leerComprobante(escenario.operadorDevoto, documento.id, {
      completo: SAFARI_COMPLETO,
      articulos: SAFARI_ARTICULOS,
      resumen: SAFARI_RESUMEN,
    });

    await acceptReadDocument(escenario.admin, documento.id);
    await expect(acceptReadDocument(escenario.admin, documento.id)).rejects.toThrow(
      /ya está validado/i,
    );
  });

  it('las advertencias sobreviven en el informe y en la auditoría', async () => {
    /*
     * Una advertencia no impide validar, pero tampoco se borra al validar: es
     * justo lo que uno quiere poder revisar cuando algo no cuadra a fin de mes.
     *
     * Se provoca una de verdad: el recorte de la tabla sin el importe de un
     * renglón, que se calcula como cantidad × precio y queda sin verificar
     * contra el papel.
     */
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, SAFARI_COMPLETO);
    const lectura = await leerComprobante(escenario.operadorDevoto, documento.id, {
      completo: SAFARI_COMPLETO,
      articulos: SAFARI_ARTICULOS,
      resumen: SAFARI_RESUMEN,
    });

    expect(lectura.report.warningCount).toBeGreaterThan(0);
    expect(lectura.report.errorCount).toBe(0);
    const advertencias = lectura.report.checks
      .filter((c) => c.severity === 'WARN')
      .map((c) => c.label);

    await acceptReadDocument(escenario.admin, documento.id);

    // En el informe guardado con el comprobante.
    const guardado = await prisma.document.findUniqueOrThrow({ where: { id: documento.id } });
    const informe = guardado.checkReport as unknown as { checks: { severity: string; label: string }[] };
    const guardadas = informe.checks.filter((c) => c.severity === 'WARN').map((c) => c.label);
    expect(guardadas).toEqual(expect.arrayContaining(advertencias));

    // Y en el asiento de auditoría, para poder buscarlas sin abrir cada uno.
    const asiento = await prisma.auditLog.findFirst({
      where: { entityId: documento.id, action: 'comprobante.confirmado' },
      orderBy: { createdAt: 'desc' },
    });
    expect(asiento).not.toBeNull();
    const detalle = asiento!.after as unknown as { advertencias?: string[] };
    expect(detalle.advertencias).toEqual(expect.arrayContaining(advertencias));
  });
});

describe('factura contra factura', () => {
  beforeEach(async () => {
    await limpiarBase();
    escenario = await sembrarEscenario();
  });

  /*
   * Errecalde reparte y cobra factura contra factura: lo de hoy se paga cuando
   * pasa el camión la próxima vez. No es un plazo en días, y ponerle "a 30 días"
   * agenda la factura del 22/08 para el 21/09 cuando en realidad se paga el
   * 28/08. El reparto no tiene periodicidad fija, así que ningún número de días
   * es el correcto.
   */

  async function condicionContraFactura(proximaFactura: Date | null) {
    await prisma.supplierPaymentTerm.deleteMany({
      where: { supplierId: escenario.proveedorErrecaldeId },
    });
    await prisma.supplierPaymentTerm.create({
      data: {
        supplierId: escenario.proveedorErrecaldeId,
        termType: 'NEXT_INVOICE',
        days: 0,
        paymentMethod: 'TRANSFERENCIA',
        validFrom: new Date(Date.UTC(2020, 0, 1)),
      },
    });
    await prisma.supplier.update({
      where: { id: escenario.proveedorErrecaldeId },
      data: { nextInvoiceDate: proximaFactura },
    });
  }

  async function leerYAceptar() {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, SAFARI_COMPLETO);
    await leerComprobante(escenario.operadorDevoto, documento.id, {
      completo: SAFARI_COMPLETO,
      articulos: SAFARI_ARTICULOS,
      resumen: SAFARI_RESUMEN,
    });
    await acceptReadDocument(escenario.admin, documento.id);
    return documento.id;
  }

  it('la factura del 22/08 se agenda para el 28/08, no a 30 días', async () => {
    await condicionContraFactura(new Date(Date.UTC(2026, 7, 28)));
    const documentId = await leerYAceptar();

    const agenda = await prisma.paymentSchedule.findUniqueOrThrow({ where: { documentId } });
    expect(agenda.dueDate.toISOString().slice(0, 10)).toBe('2026-08-28');
    // Y queda marcada como provisoria: la próxima factura todavía no llegó.
    expect(agenda.dueDateProvisional).toBe(true);
  });

  it('sin fecha de próxima factura no inventa un plazo', async () => {
    /*
     * Es la diferencia entre esta condición y "a x días". Si no se sabe cuándo
     * vuelve el camión, la fecha no se puede calcular y hay que pedírsela a
     * alguien: poner la fecha de emisión, o sumarle una cantidad de días
     * inventada, sería agendar plata en un día que no acordó nadie.
     */
    await condicionContraFactura(null);
    const emision = new Date(Date.UTC(2026, 7, 22));
    const term = { termType: 'NEXT_INVOICE' as const, days: 0, paymentMethod: 'TRANSFERENCIA' };

    expect(computeDueDate(emision, term, { proximaFactura: null })).toBeNull();
    expect(computeDueDate(emision, term, { proximaFactura: new Date(Date.UTC(2026, 7, 28)) })
      ?.toISOString()
      .slice(0, 10)).toBe('2026-08-28');
  });

  it('los otros plazos siguen funcionando igual', async () => {
    const emision = new Date(Date.UTC(2026, 7, 22));
    expect(
      computeDueDate(emision, { termType: 'SAME_DAY', days: 0 })?.toISOString().slice(0, 10),
    ).toBe('2026-08-22');
    expect(
      computeDueDate(emision, { termType: 'DAYS', days: 30 })?.toISOString().slice(0, 10),
    ).toBe('2026-09-21');
    expect(computeDueDate(emision, { termType: 'MANUAL', days: 0 })).toBeNull();
  });

  it('la fecha de una factura ya validada se corrige sin anularla, con auditoría', async () => {
    /*
     * El caso concreto: la factura ya está validada y agendada para el 21/09
     * porque la condición estaba mal configurada. Hay que llevarla al 28/08 sin
     * anularla ni volver a cargar la imagen.
     */
    await condicionContraFactura(null);
    const documentId = await leerYAceptar();
    const agenda = await prisma.paymentSchedule.findUniqueOrThrow({ where: { documentId } });

    await reschedulePayment(
      escenario.admin,
      agenda.id,
      '2026-08-28',
      'Errecalde cobra factura contra factura: la próxima visita es el 28/08.',
    );

    const despues = await prisma.paymentSchedule.findUniqueOrThrow({ where: { documentId } });
    expect(despues.dueDate.toISOString().slice(0, 10)).toBe('2026-08-28');

    // El comprobante sigue validado: no se tocó nada más que la agenda.
    const documento = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(documento.status).toBe('VALIDADO');
    expect(documento.total!.toFixed(2)).toBe('4816812.73');

    // Y queda el rastro, con la fecha anterior y la nueva.
    const asiento = await prisma.auditLog.findFirst({
      where: { entityId: agenda.id, action: 'pago.reprogramado' },
    });
    expect(asiento).not.toBeNull();
    expect(asiento!.reason).toContain('factura contra factura');
    const antes = asiento!.before as unknown as { vencimiento: string };
    const luego = asiento!.after as unknown as { vencimiento: string };
    expect(antes.vencimiento).not.toBe('2026-08-28');
    expect(luego.vencimiento).toBe('2026-08-28');
  });
});

describe('el reporte por producto encuentra lo que se compró', () => {
  beforeEach(async () => {
    await limpiarBase();
    escenario = await sembrarEscenario();
  });

  /*
   * La factura de Errecalde trae dos quesos Sardo. Estaban en el catálogo, la
   * factura se validó, y el reporte de "Queso Sardo" devolvía cero kilos y cero
   * pesos: los movimientos habían quedado con productId nulo porque la pantalla
   * no había asociado los renglones a mano, y el reporte filtra por producto.
   */

  async function facturaDeErrecaldeValidada() {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, SAFARI_COMPLETO);
    await leerComprobante(escenario.operadorDevoto, documento.id, {
      completo: SAFARI_COMPLETO,
      articulos: SAFARI_ARTICULOS,
      resumen: SAFARI_RESUMEN,
    });
    await acceptReadDocument(escenario.admin, documento.id);
    return documento.id;
  }

  it('ningún movimiento de un renglón reconocible queda sin producto', async () => {
    /*
     * La prueba que tiene que fallar si esto vuelve a pasar. No mira la
     * pantalla: mira los movimientos, que son de donde sale el reporte.
     */
    await facturaDeErrecaldeValidada();

    const sardos = await prisma.purchaseMovement.findMany({
      where: { description: { contains: 'SARDO' } },
    });
    expect(sardos.length).toBeGreaterThanOrEqual(2);
    for (const movimiento of sardos) {
      expect(
        movimiento.productId,
        `"${movimiento.description}" quedó sin producto asociado`,
      ).not.toBeNull();
    }

    // Y el renglón del comprobante dice lo mismo que el movimiento.
    for (const movimiento of sardos) {
      const renglon = await prisma.documentItem.findUniqueOrThrow({
        where: { id: movimiento.documentItemId! },
      });
      expect(renglon.productId).toBe(movimiento.productId);
    }
  });

  it('filtrando por Queso Sardo aparecen los dos renglones y suman bien', async () => {
    await facturaDeErrecaldeValidada();

    /*
     * Son dos artículos distintos del catálogo —el bloque Melincué y el Don
     * Alfonso—, así que se los busca por separado y se comprueban los dos: lo
     * que no puede pasar es que alguno dé cero.
     */
    const bloque = await getPurchaseReport(escenario.admin, {
      productId: escenario.productos['2001'],
    });
    const donAlfonso = await getPurchaseReport(escenario.admin, {
      productId: escenario.productos['2002'],
    });

    for (const [nombre, reporte] of [
      ['SARDO BLOQUE MELINCUE', bloque],
      ['SARDO DON ALFONSO', donAlfonso],
    ] as const) {
      expect(reporte.rows.length, `${nombre} no apareció en el reporte`).toBeGreaterThanOrEqual(1);
      expect(reporte.totals.kilos).not.toBe('0.00');
      expect(reporte.totals.costoTotal).not.toBe('0.00');
      // Los números salen de los renglones, no de un total inventado.
      const suma = reporte.rows.reduce((t, r) => t + Number(r.totalCost), 0);
      expect(Number(reporte.totals.costoTotal)).toBeCloseTo(suma, 2);
    }

    // Los kilos del papel: 4,75 del bloque y 28,9 del Don Alfonso.
    expect(bloque.totals.kilos).toBe('4.75');
    expect(donAlfonso.totals.kilos).toBe('28.90');

    // Y el IVA y las percepciones también llegan, no sólo el neto.
    expect(Number(bloque.totals.iva)).toBeGreaterThan(0);
    expect(Number(bloque.totals.percepciones)).toBeGreaterThan(0);
    expect(Number(donAlfonso.totals.iva)).toBeGreaterThan(0);
    expect(Number(donAlfonso.totals.percepciones)).toBeGreaterThan(0);
  });

  it('"todos los productos" sigue dando el total completo', async () => {
    await facturaDeErrecaldeValidada();

    const todos = await getPurchaseReport(escenario.admin, {});
    const bloque = await getPurchaseReport(escenario.admin, {
      productId: escenario.productos['2001'],
    });

    expect(todos.rows).toHaveLength(23);
    expect(Number(todos.totals.costoTotal)).toBeGreaterThan(Number(bloque.totals.costoTotal));
    // El costo final de la factura entera es el del papel.
    expect(todos.totals.costoTotal).toBe('4816812.73');
  });

  it('el filtro de producto se combina con proveedor, sucursal y fechas', async () => {
    await facturaDeErrecaldeValidada();
    const bloque = escenario.productos['2001'];

    const conTodo = await getPurchaseReport(escenario.admin, {
      productId: bloque,
      supplierId: escenario.proveedorErrecaldeId,
      branchId: escenario.sucursales.devoto,
      from: '2026-08-01',
      to: '2026-08-31',
    });
    expect(conTodo.rows.length).toBeGreaterThanOrEqual(1);

    // Con el proveedor equivocado no tiene que aparecer nada.
    const otroProveedor = await getPurchaseReport(escenario.admin, {
      productId: bloque,
      supplierId: escenario.proveedorId,
    });
    expect(otroProveedor.rows).toHaveLength(0);

    // Y fuera de la ventana de fechas, tampoco.
    const fueraDeFecha = await getPurchaseReport(escenario.admin, {
      productId: bloque,
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(fueraDeFecha.rows).toHaveLength(0);
  });

  it('el CSV dice lo mismo que la pantalla', async () => {
    await facturaDeErrecaldeValidada();
    const reporte = await getPurchaseReport(escenario.admin, {
      productId: escenario.productos['2001'],
    });
    const csv = purchaseReportToCsv(reporte);

    /*
     * Se compara el contenido, no la cantidad de líneas: el CSV lleva además
     * una línea de totales, y contar líneas haría que la prueba se rompa por un
     * cambio de formato que no cambia ningún número.
     */
    for (const fila of reporte.rows) {
      expect(csv).toContain(fila.description);
      // Los importes van con coma decimal, como los espera Excel en español.
      expect(csv).toContain(fila.totalCost.replace('.', ','));
    }

    // Y la línea de totales dice lo mismo que el resumen de la pantalla.
    const totales = csv.split('\n').find((l) => l.startsWith('"TOTALES"'))!;
    expect(totales).toContain(reporte.totals.costoTotal.replace('.', ','));
    expect(totales).toContain(reporte.totals.kilos.replace('.', ','));
  });

  it('el backfill informa antes de tocar nada, y no duplica movimientos', async () => {
    /*
     * Las facturas históricas se arreglan sin volver a cargarlas. El informe va
     * primero: lo dudoso no se asocia solo.
     */
    const documentId = await facturaDeErrecaldeValidada();

    // Se simula el estado viejo: los renglones sin producto.
    await prisma.documentItem.updateMany({
      where: { documentId },
      data: { productId: null, matchMethod: 'NONE' },
    });
    await prisma.purchaseMovement.updateMany({ where: { documentId }, data: { productId: null } });

    const antes = await prisma.purchaseMovement.count({ where: { documentId } });

    // Primero, sólo el informe. No escribe nada.
    const informe = await backfillProductLinks(escenario.admin, {});
    expect(informe.aplicadas).toBe(0);
    expect(segurasDe(informe).length).toBeGreaterThanOrEqual(2);
    expect(
      segurasDe(informe).some((f) => f.description.includes('SARDO')),
      'el informe tendría que reconocer los Sardo',
    ).toBe(true);

    const sinAplicar = await prisma.purchaseMovement.findFirst({
      where: { documentId, description: { contains: 'SARDO' } },
    });
    expect(sinAplicar!.productId).toBeNull();

    // Y recién ahora se aplica.
    const aplicado = await backfillProductLinks(escenario.admin, { aplicar: true });
    expect(aplicado.aplicadas).toBe(segurasDe(aplicado).length);

    const despues = await prisma.purchaseMovement.count({ where: { documentId } });
    expect(despues, 'el backfill no puede crear movimientos nuevos').toBe(antes);

    const reporte = await getPurchaseReport(escenario.admin, {
      productId: escenario.productos['2001'],
    });
    expect(reporte.rows.length).toBeGreaterThanOrEqual(1);
  });

  it('el backfill no toca ni un importe', async () => {
    const documentId = await facturaDeErrecaldeValidada();
    const antes = await prisma.purchaseMovement.findMany({
      where: { documentId },
      orderBy: { id: 'asc' },
    });

    await prisma.documentItem.updateMany({ where: { documentId }, data: { productId: null } });
    await prisma.purchaseMovement.updateMany({ where: { documentId }, data: { productId: null } });
    await backfillProductLinks(escenario.admin, { aplicar: true });

    const despues = await prisma.purchaseMovement.findMany({
      where: { documentId },
      orderBy: { id: 'asc' },
    });
    expect(despues).toHaveLength(antes.length);
    for (let i = 0; i < antes.length; i++) {
      expect(despues[i].quantity.toFixed(4)).toBe(antes[i].quantity.toFixed(4));
      expect(despues[i].netAmount.toFixed(4)).toBe(antes[i].netAmount.toFixed(4));
      expect(despues[i].ivaAmount.toFixed(4)).toBe(antes[i].ivaAmount.toFixed(4));
      expect(despues[i].perceptionAmount.toFixed(4)).toBe(antes[i].perceptionAmount.toFixed(4));
      expect(despues[i].totalCost.toFixed(4)).toBe(antes[i].totalCost.toFixed(4));
      expect(despues[i].unitCost.toFixed(4)).toBe(antes[i].unitCost.toFixed(4));
    }
  });
});

describe('la agenda de pagos vista como calendario', () => {
  beforeEach(async () => {
    await limpiarBase();
    escenario = await sembrarEscenario();
  });

  /*
   * El calendario y la lista son la misma agenda mirada de dos formas. Salen de
   * la misma consulta a propósito: si el calendario tuviera su propia cuenta de
   * lo pendiente, tarde o temprano diría algo distinto que la lista y no habría
   * forma de saber cuál de las dos tiene razón.
   */

  /** Un comprobante validado con su pago agendado para una fecha concreta. */
  async function comprobanteQueVence(
    numero: string,
    vencimiento: string,
    total = '100000.00',
  ): Promise<string> {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await prisma.document.update({
      where: { id: documento.id },
      data: {
        supplierId: escenario.proveedorId,
        docType: 'FACTURA',
        letter: 'A',
        pointOfSale: '0010',
        number: numero,
        fullNumber: `0010-${numero}`,
        issueDate: dateOnlyFromISO('2026-08-14'),
        netTotal: total,
        total,
        status: 'VALIDADO',
        dedupeKey: 'ACTIVE',
        appliedTermType: 'DAYS',
        appliedTermDays: 30,
        validatedById: escenario.admin.id,
        validatedAt: new Date(),
      },
    });
    await prisma.paymentSchedule.create({
      data: {
        documentId: documento.id,
        dueDate: dateOnlyFromISO(vencimiento),
        plannedAmount: total,
        plannedPaymentMethod: 'TRANSFERENCIA',
        paidAmount: '0',
        status: 'AGENDADO',
      },
    });
    return documento.id;
  }

  it('agrupa varios pagos del mismo día y suma sus importes', async () => {
    await comprobanteQueVence('00300001', '2026-11-10', '100000.00');
    await comprobanteQueVence('00300002', '2026-11-10', '250000.00');
    await comprobanteQueVence('00300003', '2026-11-25', '50000.00');

    const calendario = await getPaymentCalendar(escenario.admin, '2026-11');

    const diez = calendario.dias.find((d) => d.fecha === '2026-11-10')!;
    expect(diez.cantidad).toBe(2);
    expect(diez.aPagar).toBe('350000.00');
    expect(diez.pagos).toHaveLength(2);

    // Y los días sin pagos sencillamente no están: la grilla los dibuja vacíos.
    expect(calendario.dias.map((d) => d.fecha)).toEqual(['2026-11-10', '2026-11-25']);
  });

  it('los totales del mes cierran entre sí', async () => {
    await comprobanteQueVence('00300004', '2026-11-10', '100000.00');
    await comprobanteQueVence('00300005', '2026-11-20', '300000.00');

    const calendario = await getPaymentCalendar(escenario.admin, '2026-11');
    expect(calendario.totales.previsto).toBe('400000.00');
    expect(calendario.totales.pagado).toBe('0.00');
    expect(calendario.totales.pendiente).toBe('400000.00');
    expect(calendario.totales.comprobantes).toBe(2);
  });

  it('un pago parcial sigue en la agenda por el saldo, no por el total', async () => {
    /*
     * Es la diferencia entre "cuánto se facturó" y "cuánto falta". El calendario
     * sirve para saber cuánta plata hay que tener ese día, así que muestra el
     * saldo.
     */
    // En un mes ya pasado: un pago no se puede confirmar con fecha futura.
    const documentId = await comprobanteQueVence('00300006', '2026-07-12', '100000.00');
    const agenda = await prisma.paymentSchedule.findUniqueOrThrow({ where: { documentId } });
    await confirmPayment(escenario.admin, {
      scheduleId: agenda.id,
      effectiveDate: '2026-07-12',
      paymentMethod: 'TRANSFERENCIA',
      amount: '40000.00',
    });

    const calendario = await getPaymentCalendar(escenario.admin, '2026-07');
    const dia = calendario.dias.find((d) => d.fecha === '2026-07-12')!;

    expect(dia.aPagar).toBe('60000.00');
    expect(dia.pagos[0].plannedAmount).toBe('100000.00');
    expect(dia.pagos[0].paidAmount).toBe('40000.00');
    expect(dia.pagos[0].status).not.toBe('PAGADO');

    // Y en los totales del mes, esos $40.000 ya están del lado de lo pagado.
    expect(calendario.totales.pagado).toBe('40000.00');
    expect(calendario.totales.pendiente).toBe('60000.00');
  });

  it('al pagar del todo, el importe pasa de pendiente a pagado sin duplicarse', async () => {
    const documentId = await comprobanteQueVence('00300007', '2026-07-15', '80000.00');
    const agenda = await prisma.paymentSchedule.findUniqueOrThrow({ where: { documentId } });

    const antes = await getPaymentCalendar(escenario.admin, '2026-07');
    expect(antes.totales.pendiente).toBe('80000.00');
    expect(antes.totales.pagado).toBe('0.00');

    await confirmPayment(escenario.admin, {
      scheduleId: agenda.id,
      effectiveDate: '2026-07-15',
      paymentMethod: 'TRANSFERENCIA',
    });

    const despues = await getPaymentCalendar(escenario.admin, '2026-07');
    expect(despues.totales.pagado).toBe('80000.00');
    expect(despues.totales.pendiente).toBe('0.00');
    // El previsto no cambió: pagar no agrega plata, la mueve de columna.
    expect(despues.totales.previsto).toBe(antes.totales.previsto);
    expect(despues.totales.comprobantes).toBe(1);
    expect(despues.dias.find((d) => d.fecha === '2026-07-15')!.pagos).toHaveLength(1);
  });

  it('cambiar la fecha mueve el pago de mes y deja auditoría', async () => {
    const documentId = await comprobanteQueVence('00300008', '2026-11-05', '90000.00');
    const agenda = await prisma.paymentSchedule.findUniqueOrThrow({ where: { documentId } });

    await reschedulePayment(escenario.admin, agenda.id, '2026-12-03', 'Lo pasamos a diciembre.');

    const noviembre = await getPaymentCalendar(escenario.admin, '2026-11');
    const diciembre = await getPaymentCalendar(escenario.admin, '2026-12');
    expect(noviembre.dias).toHaveLength(0);
    expect(diciembre.dias.find((d) => d.fecha === '2026-12-03')!.aPagar).toBe('90000.00');

    const asiento = await prisma.auditLog.findFirst({
      where: { entityId: agenda.id, action: 'pago.reprogramado' },
    });
    expect(asiento).not.toBeNull();
  });

  it('marca como provisorias las fechas de factura contra factura', async () => {
    const documentId = await comprobanteQueVence('00300009', '2026-11-08', '70000.00');
    await prisma.paymentSchedule.update({
      where: { documentId },
      data: { dueDateProvisional: true },
    });
    await prisma.document.update({
      where: { id: documentId },
      data: { appliedTermType: 'NEXT_INVOICE', appliedTermDays: 0 },
    });

    const calendario = await getPaymentCalendar(escenario.admin, '2026-11');
    const dia = calendario.dias.find((d) => d.fecha === '2026-11-08')!;

    expect(dia.hayProvisorias).toBe(true);
    expect(dia.pagos[0].provisoria).toBe(true);
    // Y la condición se nombra, para que se entienda por qué es provisoria.
    expect(dia.pagos[0].condicion).toBe('Factura contra factura');
  });

  it('los filtros acotan igual que en la lista', async () => {
    await comprobanteQueVence('00300010', '2026-11-10', '100000.00');

    const conProveedor = await getPaymentCalendar(escenario.admin, '2026-11', {
      supplierId: escenario.proveedorId,
    });
    expect(conProveedor.dias).toHaveLength(1);

    const otroProveedor = await getPaymentCalendar(escenario.admin, '2026-11', {
      supplierId: escenario.proveedorErrecaldeId,
    });
    expect(otroProveedor.dias).toHaveLength(0);

    const otraSucursal = await getPaymentCalendar(escenario.admin, '2026-11', {
      branchId: escenario.sucursales.pueyrredon,
    });
    expect(otraSucursal.dias).toHaveLength(0);

    const otraForma = await getPaymentCalendar(escenario.admin, '2026-11', {
      paymentMethod: 'CHEQUE',
    });
    expect(otraForma.dias).toHaveLength(0);
  });

  it('un operador sólo ve el calendario de su sucursal', async () => {
    /*
     * El mismo alcance por sucursal que en la lista: no es una vista nueva de
     * datos nuevos, es la misma agenda.
     */
    await comprobanteQueVence('00300011', '2026-11-10', '100000.00');

    const delAdmin = await getPaymentCalendar(escenario.admin, '2026-11');
    const delOperadorDeDevoto = await getPaymentCalendar(escenario.operadorDevoto, '2026-11');
    const delOperadorDeOtra = await getPaymentCalendar(escenario.operadorPueyrredon, '2026-11');

    expect(delAdmin.dias).toHaveLength(1);
    expect(delOperadorDeDevoto.dias).toHaveLength(1);
    expect(delOperadorDeOtra.dias).toHaveLength(0);
  });

  it('sin permiso de ver pagos, no hay calendario', async () => {
    const sinPermiso = { ...escenario.admin, permissions: [] as string[] };
    await expect(
      getPaymentCalendar(sinPermiso as typeof escenario.admin, '2026-11'),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('el calendario y la lista dicen lo mismo', async () => {
    /*
     * La prueba que las ata. Los mismos comprobantes, los mismos importes: si
     * alguna de las dos empieza a contar distinto, esto falla.
     */
    await comprobanteQueVence('00300012', '2026-11-10', '100000.00');
    await comprobanteQueVence('00300013', '2026-11-20', '250000.00');

    const calendario = await getPaymentCalendar(escenario.admin, '2026-11');
    const lista = await listPayments(escenario.admin);

    const deNoviembre = [...lista.proximos, ...lista.venceHoy, ...lista.vencidos].filter(
      (s) => toISODate(s.dueDate).startsWith('2026-11'),
    );
    expect(calendario.totales.comprobantes).toBe(deNoviembre.length);

    const sumaDeLaLista = deNoviembre.reduce(
      (t, s) => t + Number(s.plannedAmount.toString()),
      0,
    );
    expect(Number(calendario.totales.previsto)).toBeCloseTo(sumaDeLaLista, 2);
  });

  it('los próximos siete días incluyen lo vencido', async () => {
    /*
     * Una deuda no deja de existir porque la fecha haya pasado: esconderla sería
     * perder de vista justamente lo que más importa.
     */
    const hoy = arToday();
    const ayer = toISODate(new Date(hoy.getTime() - 86_400_000));
    const enTresDias = toISODate(new Date(hoy.getTime() + 3 * 86_400_000));
    const enVeinteDias = toISODate(new Date(hoy.getTime() + 20 * 86_400_000));

    await comprobanteQueVence('00300014', ayer, '10000.00');
    await comprobanteQueVence('00300015', enTresDias, '20000.00');
    await comprobanteQueVence('00300016', enVeinteDias, '30000.00');

    const proximos = await getProximosPagos(escenario.admin, 7);
    const fechas = proximos.map((d) => d.fecha);

    expect(fechas).toContain(ayer);
    expect(fechas).toContain(enTresDias);
    // Lo de dentro de veinte días es del mes que viene: no es "de esta semana".
    expect(fechas).not.toContain(enVeinteDias);
  });
});

describe('el código del proveedor y el PLU interno son dos cosas distintas', () => {
  beforeEach(async () => {
    await limpiarBase();
    escenario = await sembrarEscenario();
  });

  /*
   * En Don Ginés el cremoso es el PLU 1211. Errecalde lo factura como
   * ART-00228. El código de la factura no reemplaza al PLU: queda colgado de
   * él, y el mismo PLU puede tener un código distinto en cada proveedor.
   *
   * El escenario siembra el producto **sin** el código a propósito: lo que se
   * prueba es que la aplicación lo aprenda con la primera factura y lo use sola
   * en la segunda.
   */
  const CREMOSO = 'ART-00228';

  async function facturaConElCremoso(numero: string, aprender: boolean) {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await confirmDocument(escenario.admin, {
      documentId: documento.id,
      supplierId: escenario.proveedorErrecaldeId,
      docType: 'FACTURA',
      letter: 'A',
      pointOfSale: '00008',
      number: numero,
      issueDate: '2026-08-22',
      printed: {
        grossSubtotal: null,
        discountTotal: null,
        netTotal: '100000.00',
        ivaTotal: '21000.00',
        perceptionsTotal: '0',
        total: '121000.00',
        lineCount: null,
        netWeightKg: null,
        totalUnits: null,
      },
      items: [
        {
          lineNumber: 1,
          supplierCode: CREMOSO,
          description: 'CREMOSO PUNTA DEL AGUA',
          quantity: '10',
          unit: 'KG',
          unitNetPrice: '10000.00',
          grossSubtotal: '100000.00',
          discountPct: '0',
          ivaRate: '0.21',
          // La primera vez lo asocia una persona; la segunda no manda nada.
          productId: aprender ? escenario.productos['1211'] : null,
          learnAlias: aprender,
        },
      ],
      payment: { dueDate: '2026-08-28', paymentMethod: 'TRANSFERENCIA', notes: null },
    });
    return documento.id;
  }

  it('la primera factura aprende que ART-00228 es el PLU 1211', async () => {
    await facturaConElCremoso('00009001', true);

    const aprendido = await prisma.productAlias.findFirst({
      where: { supplierId: escenario.proveedorErrecaldeId, supplierCode: CREMOSO },
      include: { product: { select: { internalCode: true } } },
    });
    expect(aprendido).not.toBeNull();
    expect(aprendido!.product.internalCode).toBe('1211');
    expect(aprendido!.productId).toBe(escenario.productos['1211']);
  });

  it('la segunda factura lo asocia sola, sin que nadie elija nada', async () => {
    await facturaConElCremoso('00009002', true);
    const segunda = await facturaConElCremoso('00009003', false);

    const renglon = await prisma.documentItem.findFirstOrThrow({
      where: { documentId: segunda },
    });
    expect(renglon.productId).toBe(escenario.productos['1211']);
    // Y por el código, no por parecido de descripción.
    expect(renglon.matchMethod).toBe('SUPPLIER_CODE');

    // El movimiento dice lo mismo: es de donde sale el reporte.
    const movimiento = await prisma.purchaseMovement.findFirstOrThrow({
      where: { documentId: segunda },
    });
    expect(movimiento.productId).toBe(escenario.productos['1211']);
  });

  it('el reporte por PLU 1211 encuentra la compra', async () => {
    await facturaConElCremoso('00009004', true);
    await facturaConElCremoso('00009005', false);

    const reporte = await getPurchaseReport(escenario.admin, {
      productId: escenario.productos['1211'],
    });
    expect(reporte.rows).toHaveLength(2);
    expect(reporte.totals.kilos).toBe('20.00');
    // Y el nombre que muestra es el interno, no el del proveedor.
    expect(reporte.rows[0].productName).toBe('Cremoso Punta del Agua');
  });

  it('buscar ART-00228 encuentra el producto 1211', async () => {
    await facturaConElCremoso('00009006', true);

    /*
     * La búsqueda del catálogo tiene que entrar por los tres lados: el PLU con
     * el que se vende, el nombre con el que se lo llama, y el código que está
     * impreso en la factura que uno tiene en la mano.
     */
    const porCodigo = await prisma.product.findMany({
      where: { aliases: { some: { supplierCode: { contains: CREMOSO, mode: 'insensitive' } } } },
      select: { internalCode: true },
    });
    expect(porCodigo.map((p) => p.internalCode)).toContain('1211');

    const porPlu = await prisma.product.findMany({
      where: { internalCode: { contains: '1211' } },
      select: { internalCode: true },
    });
    expect(porPlu.map((p) => p.internalCode)).toContain('1211');
  });

  it('otro proveedor puede tener otro código para el mismo PLU', async () => {
    await facturaConElCremoso('00009007', true);

    // Los Calvos factura el mismo cremoso como "4587".
    await prisma.productAlias.create({
      data: {
        productId: escenario.productos['1211'],
        supplierId: escenario.proveedorId,
        supplierCode: '4587',
        alias: 'CREMOSO P. DEL AGUA',
        normalized: 'cremoso p del agua',
        origin: 'MANUAL',
      },
    });

    const codigos = await prisma.productAlias.findMany({
      where: { productId: escenario.productos['1211'], supplierCode: { not: null } },
      select: { supplierCode: true, supplierId: true },
    });
    expect(codigos).toHaveLength(2);
    expect(codigos.map((c) => c.supplierCode).sort()).toEqual(['4587', CREMOSO]);

    // Y cada uno reconoce el mismo PLU desde su proveedor.
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    void documento;
    const desdeLosCalvos = await matchItemsToProducts(
      [
        {
          lineNumber: 1,
          supplierCode: '4587',
          description: 'CUALQUIER COSA QUE NO SE PAREZCA',
        } as unknown as Parameters<typeof matchItemsToProducts>[0][number],
      ],
      escenario.proveedorId,
    );
    expect(desdeLosCalvos[0].productId).toBe(escenario.productos['1211']);
    expect(desdeLosCalvos[0].method).toBe('SUPPLIER_CODE');
  });

  it('el mismo código del mismo proveedor no puede apuntar a dos PLU', async () => {
    await facturaConElCremoso('00009008', true);

    /*
     * La restricción de base. Al revés sí se puede —el mismo PLU con un código
     * por proveedor— pero esto no: si ART-00228 de Errecalde significara dos
     * artículos, no habría forma de saber a cuál cargarle la compra.
     */
    await expect(
      prisma.productAlias.create({
        data: {
          productId: escenario.productos['2001'],
          supplierId: escenario.proveedorErrecaldeId,
          supplierCode: CREMOSO,
          alias: 'OTRA COSA',
          normalized: 'otra cosa',
          origin: 'MANUAL',
        },
      }),
    ).rejects.toThrow();
  });

  it('el aviso es entendible cuando se intenta desde la pantalla', async () => {
    await facturaConElCremoso('00009009', true);

    const form = new FormData();
    form.set('productId', escenario.productos['2001']);
    form.set('supplierId', escenario.proveedorErrecaldeId);
    form.set('supplierCode', CREMOSO);

    /*
     * Un error de Postgres no le sirve a nadie: hay que decir con qué artículo
     * choca el código y qué hay que hacer.
     */
    await expect(saveSupplierCode(escenario.admin, form)).rejects.toThrow(
      /ya está asignado al PLU 1211/,
    );
  });

  it('un código sin proveedor no vincula nada', async () => {
    /*
     * La coincidencia se exige exacta en los dos campos, y esta prueba cubre el
     * caso que lo hace necesario: un alias con código pero **sin proveedor**.
     *
     * El mismo "4587" puede ser el cremoso en un proveedor y una lata de tomate
     * en otro. Un código suelto, que no dice de quién es, no identifica nada:
     * aceptarlo desde cualquier factura es exactamente cómo se carga una compra
     * al artículo equivocado. Antes se aceptaba.
     */
    await prisma.productAlias.create({
      data: {
        productId: escenario.productos['2001'],
        supplierId: null,
        supplierCode: '4587',
        alias: 'CODIGO SIN DUENO',
        normalized: 'codigo sin dueno',
        origin: 'MANUAL',
      },
    });

    const desdeErrecalde = await matchItemsToProducts(
      [
        {
          lineNumber: 1,
          supplierCode: '4587',
          description: 'ALGO QUE NO SE PARECE A NADA DEL CATALOGO',
        } as unknown as Parameters<typeof matchItemsToProducts>[0][number],
      ],
      escenario.proveedorErrecaldeId,
    );
    expect(desdeErrecalde[0].productId).toBeNull();
  });

  it('el código se compara sin importar cómo lo escriban', async () => {
    /*
     * "ART-00228", "art 00228" y "ART00228" son el mismo código: cada sistema lo
     * imprime distinto y el OCR agrega lo suyo. Lo que **no** se toca son los
     * dígitos: ART-00228 y ART-00229 son artículos distintos.
     */
    await facturaConElCremoso('00009012', true);

    const conEspacios = await matchItemsToProducts(
      [
        {
          lineNumber: 1,
          supplierCode: 'art 00228',
          description: 'NADA QUE SE PAREZCA',
        } as unknown as Parameters<typeof matchItemsToProducts>[0][number],
      ],
      escenario.proveedorErrecaldeId,
    );
    expect(conEspacios[0].productId).toBe(escenario.productos['1211']);

    const otroArticulo = await matchItemsToProducts(
      [
        {
          lineNumber: 1,
          supplierCode: 'ART-00229',
          description: 'NADA QUE SE PAREZCA',
        } as unknown as Parameters<typeof matchItemsToProducts>[0][number],
      ],
      escenario.proveedorErrecaldeId,
    );
    expect(otroArticulo[0].productId).toBeNull();
  });

  it('el backfill histórico resuelve por código antes que por descripción', async () => {
    /*
     * Es lo que rescata los renglones cuya descripción salió del OCR hecha
     * pedazos: el código es una identificación y la descripción, un parecido.
     */
    await facturaConElCremoso('00009010', true);
    const historica = await facturaConElCremoso('00009011', false);

    // Se simula el estado viejo, y encima con la descripción rota.
    await prisma.documentItem.updateMany({
      where: { documentId: historica },
      data: { productId: null, matchMethod: 'NONE', description: 'CREM0S0 PVNTA DEL A6UA' },
    });
    await prisma.purchaseMovement.updateMany({
      where: { documentId: historica },
      data: { productId: null },
    });

    const informe = await backfillProductLinks(escenario.admin, { aplicar: true });

    expect(informe.porCodigo.length).toBeGreaterThanOrEqual(1);
    const movimiento = await prisma.purchaseMovement.findFirstOrThrow({
      where: { documentId: historica },
    });
    expect(movimiento.productId).toBe(escenario.productos['1211']);

    const reporte = await getPurchaseReport(escenario.admin, {
      productId: escenario.productos['1211'],
    });
    expect(reporte.rows).toHaveLength(2);
  });
});

describe('el mantenimiento de asociaciones históricas', () => {
  beforeEach(async () => {
    await limpiarBase();
    escenario = await sembrarEscenario();
  });

  /**
   * La factura real de Errecalde, validada y con los renglones sin producto.
   *
   * Es el estado en que quedaron las compras confirmadas antes de que la
   * asociación se resolviera del lado del servidor: la factura está bien, los
   * importes están bien, y el reporte por artículo da cero.
   */
  async function facturaHistoricaSinAsociar(): Promise<string> {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, SAFARI_COMPLETO);
    await leerComprobante(escenario.operadorDevoto, documento.id, {
      completo: SAFARI_COMPLETO,
      articulos: SAFARI_ARTICULOS,
      resumen: SAFARI_RESUMEN,
    });
    await acceptReadDocument(escenario.admin, documento.id);

    await prisma.documentItem.updateMany({
      where: { documentId: documento.id },
      data: { productId: null, matchMethod: 'NONE' },
    });
    await prisma.purchaseMovement.updateMany({
      where: { documentId: documento.id },
      data: { productId: null },
    });
    // El estado roto real tampoco tenía historial de costos. Si se deja el
    // CostHistory de la confirmación original, la prueba no reproduce el
    // problema de producción y Precios puede dar un falso verde.
    await prisma.costHistory.deleteMany({ where: { documentId: documento.id } });
    return documento.id;
  }

  it('la factura histórica deja de mostrar Sardo = 0, sin volver a cargarla', async () => {
    /*
     * La prueba de aceptación de todo esto. Antes del backfill el reporte de
     * "Queso Sardo" da cero kilos y cero pesos sobre una compra que existe,
     * está validada y está paga. Después, sin tocar la factura ni volver a
     * leer la foto, aparece con sus kilos y su costo.
     */
    const documentId = await facturaHistoricaSinAsociar();
    const bloque = escenario.productos['2001'];
    const donAlfonso = escenario.productos['2002'];

    const antesBloque = await getPurchaseReport(escenario.admin, { productId: bloque });
    const antesDonAlfonso = await getPurchaseReport(escenario.admin, { productId: donAlfonso });
    expect(antesBloque.rows).toHaveLength(0);
    expect(antesBloque.totals.kilos).toBe('0.00');
    expect(antesBloque.totals.costoTotal).toBe('0.00');
    expect(antesDonAlfonso.rows).toHaveLength(0);

    // Paso 1: analizar. No escribe nada.
    const informe = await backfillProductLinks(escenario.admin, {});
    expect(informe.aplicadas).toBe(0);
    const sardosDelInforme = segurasDe(informe).filter((f) => f.description.includes('SARDO'));
    expect(sardosDelInforme.length).toBeGreaterThanOrEqual(2);
    // El informe dice a qué PLU iría cada uno, antes de aplicar nada.
    expect(sardosDelInforme.map((f) => f.productCode).sort()).toEqual(['2001', '2002']);

    const sinAplicar = await getPurchaseReport(escenario.admin, { productId: bloque });
    expect(sinAplicar.rows).toHaveLength(0);

    // Paso 2: aplicar.
    await backfillProductLinks(escenario.admin, { aplicar: true });

    const despuesBloque = await getPurchaseReport(escenario.admin, { productId: bloque });
    const despuesDonAlfonso = await getPurchaseReport(escenario.admin, { productId: donAlfonso });

    expect(despuesBloque.rows).toHaveLength(1);
    expect(despuesBloque.totals.kilos).toBe('4.75');
    expect(Number(despuesBloque.totals.costoTotal)).toBeGreaterThan(0);
    expect(despuesDonAlfonso.rows).toHaveLength(1);
    expect(despuesDonAlfonso.totals.kilos).toBe('28.90');
    expect(Number(despuesDonAlfonso.totals.costoTotal)).toBeGreaterThan(0);

    // El mismo backfill deja lista la pantalla Precios.
    const asociados = await prisma.documentItem.count({
      where: { documentId, productId: { not: null } },
    });
    expect(await prisma.costHistory.count({ where: { documentId } })).toBe(asociados);
    const costoSardo = await getLatestCost(bloque);
    expect(costoSardo.unitCost).not.toBeNull();

    // Y la factura quedó intacta: los mismos 23 renglones y el mismo total.
    const documento = await prisma.document.findUniqueOrThrow({
      where: { id: documentId },
      include: { items: true },
    });
    expect(documento.status).toBe('VALIDADO');
    expect(documento.items).toHaveLength(23);
    expect(documento.total!.toFixed(2)).toBe('4816812.73');

    // El total general no se movió: reasignar no crea ni borra compras.
    const todos = await getPurchaseReport(escenario.admin, {});
    expect(todos.totals.costoTotal).toBe('4816812.73');
    expect(todos.rows).toHaveLength(23);
  });

  it('el informe se puede acotar a un proveedor', async () => {
    await facturaHistoricaSinAsociar();

    const deErrecalde = await backfillProductLinks(escenario.admin, {
      supplierId: escenario.proveedorErrecaldeId,
    });
    expect(segurasDe(deErrecalde).length).toBeGreaterThanOrEqual(2);

    const deLosCalvos = await backfillProductLinks(escenario.admin, {
      supplierId: escenario.proveedorId,
    });
    expect(segurasDe(deLosCalvos)).toHaveLength(0);
    expect(deLosCalvos.ambiguas).toHaveLength(0);
  });

  it('una ambigua se resuelve a mano y queda aprendido el código', async () => {
    /*
     * El caso que el análisis no puede cerrar solo: una descripción que no se
     * parece a nada. La persona elige el PLU y, al confirmar, queda escrito que
     * ese código de ese proveedor es ese artículo — así la próxima factura se
     * vincula sola y este trabajo se hace una sola vez.
     */
    const documentId = await facturaHistoricaSinAsociar();
    const renglon = await prisma.documentItem.findFirstOrThrow({
      where: { documentId, description: { contains: 'SARDO BLOQUE' } },
    });
    // Se le rompe la descripción para que ninguna comparación la salve.
    await prisma.documentItem.update({
      where: { id: renglon.id },
      data: { description: 'XQZ 8871 ILEGIBLE' },
    });

    const informe = await backfillProductLinks(escenario.admin, {});
    const dudosa = [...informe.ambiguas, ...informe.sinCoincidencia].find(
      (f) => f.documentItemId === renglon.id,
    );
    expect(dudosa, 'el renglón ilegible tendría que quedar sin resolver').toBeDefined();

    await asociarRenglonHistorico(escenario.admin, renglon.id, escenario.productos['2001'], {
      aprenderCodigo: true,
    });

    // Quedó asociado, en el renglón y en el movimiento.
    const despues = await prisma.documentItem.findUniqueOrThrow({ where: { id: renglon.id } });
    expect(despues.productId).toBe(escenario.productos['2001']);
    expect(despues.matchMethod).toBe('MANUAL');
    const movimiento = await prisma.purchaseMovement.findFirstOrThrow({
      where: { documentItemId: renglon.id },
    });
    expect(movimiento.productId).toBe(escenario.productos['2001']);

    // Resolver a mano también deja el costo listo para Precios.
    const costo = await getLatestCost(escenario.productos['2001']);
    expect(costo.unitCost).not.toBeNull();

    // Y el código quedó aprendido para las próximas facturas.
    const aprendido = await prisma.productAlias.findFirst({
      where: {
        supplierId: escenario.proveedorErrecaldeId,
        supplierCode: renglon.supplierCode,
      },
    });
    expect(aprendido?.productId).toBe(escenario.productos['2001']);
  });

  it('resolver a mano no pisa un código que ya es de otro producto', async () => {
    /*
     * El renglón se asocia igual —quien mira la factura sabe qué compró— pero
     * el código no se toca: dárselo a este producto se lo sacaría al otro, y eso
     * cambiaría en silencio la clasificación de todas las compras que dependen
     * de él. Ese conflicto se resuelve en la ficha del producto, a la vista.
     */
    const documentId = await facturaHistoricaSinAsociar();
    const renglon = await prisma.documentItem.findFirstOrThrow({
      where: { documentId, description: { contains: 'SARDO BLOQUE' } },
    });

    // El código ya pertenece a otro artículo.
    await prisma.productAlias.create({
      data: {
        productId: escenario.productos['2002'],
        supplierId: escenario.proveedorErrecaldeId,
        supplierCode: renglon.supplierCode,
        alias: 'YA ESTABA TOMADO',
        normalized: 'ya estaba tomado',
        origin: 'MANUAL',
      },
    });

    await asociarRenglonHistorico(escenario.admin, renglon.id, escenario.productos['2001'], {
      aprenderCodigo: true,
    });

    const despues = await prisma.documentItem.findUniqueOrThrow({ where: { id: renglon.id } });
    expect(despues.productId).toBe(escenario.productos['2001']);

    // Pero el código sigue donde estaba.
    const codigo = await prisma.productAlias.findFirstOrThrow({
      where: {
        supplierId: escenario.proveedorErrecaldeId,
        supplierCode: renglon.supplierCode,
      },
    });
    expect(codigo.productId).toBe(escenario.productos['2002']);
  });

  it('un renglón ya asociado no se puede reasignar por esta vía', async () => {
    // Este mantenimiento completa lo que está vacío. Cambiar una asociación que
    // ya existe es otra cosa y no se hace de refilón.
    const documentId = await facturaHistoricaSinAsociar();
    await backfillProductLinks(escenario.admin, { aplicar: true });

    const asociado = await prisma.documentItem.findFirstOrThrow({
      where: { documentId, productId: { not: null } },
    });
    await expect(
      asociarRenglonHistorico(escenario.admin, asociado.id, escenario.productos['1211'], {}),
    ).rejects.toThrow(/ya está asociado/i);
  });

  it('la auditoría dice quién, cuándo, cuántas y qué producto en cada renglón', async () => {
    await facturaHistoricaSinAsociar();
    const informe = await backfillProductLinks(escenario.admin, { aplicar: true });

    const asiento = await prisma.auditLog.findFirst({
      where: { action: 'productos.reasignados', entity: 'Product' },
      orderBy: { createdAt: 'desc' },
    });
    expect(asiento).not.toBeNull();
    expect(asiento!.userId).toBe(escenario.admin.id);
    expect(asiento!.createdAt).toBeInstanceOf(Date);

    const detalle = asiento!.after as unknown as {
      aplicadas: number;
      porCodigo: number;
      porDescripcion: number;
      ambiguas: number;
      renglones: { renglon: string; plu: string; metodo: string }[];
      pendientes: { renglon: string }[];
    };
    expect(detalle.aplicadas).toBe(informe.aplicadas);
    expect(detalle.renglones).toHaveLength(informe.aplicadas);
    // Cada renglón, con el PLU que se le puso: sin esto no se podría revisar
    // ni revertir una asignación concreta.
    for (const r of detalle.renglones) {
      expect(r.plu).toBeTruthy();
      expect(r.metodo).toBeTruthy();
    }
    expect(detalle.ambiguas).toBe(informe.ambiguas.length);
    expect(detalle.pendientes).toHaveLength(informe.ambiguas.length);
  });

  it('sin permiso de gestionar productos no se puede analizar ni aplicar', async () => {
    await expect(
      backfillProductLinks(escenario.operadorDevoto, {}),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      asociarRenglonHistorico(escenario.operadorDevoto, 'x', 'y', {}),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('lo que la confirmación deja listo para el resto de la aplicación', () => {
  beforeEach(async () => {
    await limpiarBase();
    escenario = await sembrarEscenario();
  });

  /*
   * Un comprobante VALIDADO no sirve de nada si Compras, Precios y Pagos no lo
   * ven. Las tres pantallas leen estructuras distintas —movimientos, historial
   * de costos y agenda— pero las tres salen del mismo momento: la confirmación.
   * Si esa escritura queda a medias, el comprobante existe y la aplicación se
   * comporta como si no.
   */

  it('revalidar los importes no puede desclasificar productos', async () => {
    /*
     * El defecto, en su forma mínima.
     *
     * `acceptReadDocument` reconstruye los renglones desde la base para volver a
     * pasarlos por los controles, y en esa reconstrucción se perdía el producto.
     * Al aceptar desde el detalle, una asociación que ya estaba hecha —por una
     * persona o por el reconocimiento— volvía a quedar en nulo, y con ella se
     * iban el movimiento de compra y el historial de costos.
     *
     * Revalidar importes es una cosa y clasificar artículos es otra: la segunda
     * no puede deshacerse por hacer la primera.
     */
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, SAFARI_COMPLETO);
    await leerComprobante(escenario.operadorDevoto, documento.id, {
      completo: SAFARI_COMPLETO,
      articulos: SAFARI_ARTICULOS,
      resumen: SAFARI_RESUMEN,
    });

    // Una persona asocia a mano un renglón que el reconocimiento no resolvió.
    const pernil = await prisma.documentItem.findFirstOrThrow({
      where: { documentId: documento.id, description: { contains: 'PERNIL' } },
    });
    await prisma.documentItem.update({
      where: { id: pernil.id },
      data: { productId: escenario.productos['1211'], matchMethod: 'MANUAL' },
    });

    // Se abandona el asistente y se acepta desde el detalle.
    await acceptReadDocument(escenario.admin, documento.id);

    const despues = await prisma.documentItem.findFirstOrThrow({
      where: { documentId: documento.id, description: { contains: 'PERNIL' } },
    });
    expect(
      despues.productId,
      'la asociación hecha a mano se perdió al aceptar desde el detalle',
    ).toBe(escenario.productos['1211']);

    const movimiento = await prisma.purchaseMovement.findFirstOrThrow({
      where: { documentItemId: despues.id },
    });
    expect(movimiento.productId).toBe(escenario.productos['1211']);
  });

  it('aceptar desde el detalle deja movimientos, costos y agenda', async () => {
    /*
     * La prueba que faltaba. Hasta ahora se verificaba que el comprobante
     * quedara VALIDADO, no que el resto de la aplicación pudiera usarlo.
     */
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, SAFARI_COMPLETO);
    await leerComprobante(escenario.operadorDevoto, documento.id, {
      completo: SAFARI_COMPLETO,
      articulos: SAFARI_ARTICULOS,
      resumen: SAFARI_RESUMEN,
    });
    await acceptReadDocument(escenario.admin, documento.id);

    // Un movimiento por renglón, ni uno más.
    const renglones = await prisma.documentItem.count({ where: { documentId: documento.id } });
    const movimientos = await prisma.purchaseMovement.count({ where: { documentId: documento.id } });
    expect(renglones).toBe(23);
    expect(movimientos).toBe(23);

    // Compras ve la factura entera.
    const compras = await getPurchaseReport(escenario.admin, {});
    expect(compras.rows).toHaveLength(23);
    expect(compras.totals.costoTotal).toBe('4816812.73');

    // Y por producto: los dos Sardo, con sus kilos.
    const bloque = await getPurchaseReport(escenario.admin, {
      productId: escenario.productos['2001'],
    });
    expect(bloque.totals.kilos).toBe('4.75');

    // Precios tiene costo para lo que quedó asociado.
    const asociados = await prisma.documentItem.count({
      where: { documentId: documento.id, productId: { not: null } },
    });
    expect(asociados).toBeGreaterThan(0);
    const costos = await prisma.costHistory.count({ where: { documentId: documento.id } });
    expect(costos).toBe(asociados);

    // Y la agenda, exactamente un pago.
    const agenda = await prisma.paymentSchedule.count({ where: { documentId: documento.id } });
    expect(agenda).toBe(1);
  });
});

describe('reparar los derivados de un comprobante validado', () => {
  beforeEach(async () => {
    await limpiarBase();
    escenario = await sembrarEscenario();
  });

  /*
   * La reparación existe por los comprobantes que ya están rotos.
   *
   * La invariante que corre dentro de la transacción impide que uno nuevo quede
   * así, pero no puede arreglar los que se validaron antes: esos ya están
   * guardados, ya se pagaron, y volver a cargarlos significaría sacarle la foto
   * otra vez a una factura de hace un mes. Así que hay que poder reconstruir lo
   * derivado desde lo que quedó guardado, sin tocar un solo importe.
   */

  /** Deja la factura de Errecalde validada: el punto de partida de todo esto. */
  async function errecaldeValidado(): Promise<string> {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, SAFARI_COMPLETO);
    await leerComprobante(escenario.operadorDevoto, documento.id, {
      completo: SAFARI_COMPLETO,
      articulos: SAFARI_ARTICULOS,
      resumen: SAFARI_RESUMEN,
    });
    await acceptReadDocument(escenario.admin, documento.id);
    return documento.id;
  }

  /**
   * El daño, tal como se vio en producción.
   *
   * El comprobante quedó VALIDADO con sus renglones y sus importes completos, y
   * sin nada de lo que derivaba de él: para Compras, Precios y Pagos no existe.
   */
  async function romperDerivados(documentId: string) {
    await prisma.purchaseMovement.deleteMany({ where: { documentId } });
    await prisma.costHistory.deleteMany({ where: { documentId } });
    await prisma.paymentSchedule.deleteMany({ where: { documentId } });
  }

  it('reconstruye compras, precios y pagos sin volver a cargar la factura', async () => {
    const documentId = await errecaldeValidado();
    await romperDerivados(documentId);

    // Así se veía el problema: la factura está y la aplicación da cero.
    const antes = await getPurchaseReport(escenario.admin, {});
    expect(antes.rows).toHaveLength(0);
    const diagnostico = await diagnosticarDerivados(documentId);
    expect(diagnostico.length).toBeGreaterThan(0);

    const reparacion = await repararDerivados(escenario.admin, documentId);
    expect(reparacion.movimientosCreados).toBe(23);
    expect(reparacion.agendaCreada).toBe(true);
    expect(reparacion.costosCreados).toBeGreaterThan(0);
    expect(reparacion.hallazgos.length).toBeGreaterThan(0);

    // Compras ve la factura entera, con el total impreso.
    const compras = await getPurchaseReport(escenario.admin, {});
    expect(compras.rows).toHaveLength(23);
    expect(compras.totals.costoTotal).toBe('4816812.73');

    // Y el artículo que daba cero kilos ahora tiene los suyos.
    const sardo = await getPurchaseReport(escenario.admin, {
      productId: escenario.productos['2001'],
    });
    expect(sardo.totals.kilos).toBe('4.75');

    // Precios tiene costo para todo lo que quedó asociado.
    const asociados = await prisma.documentItem.count({
      where: { documentId, productId: { not: null } },
    });
    const costos = await prisma.costHistory.count({ where: { documentId } });
    expect(costos).toBe(asociados);
    expect(await getLatestCost(escenario.productos['2001'])).not.toBeNull();

    // Y la agenda, exactamente un pago por el total del comprobante.
    const agenda = await prisma.paymentSchedule.findMany({ where: { documentId } });
    expect(agenda).toHaveLength(1);
    expect(agenda[0].plannedAmount.toString()).toBe('4816812.73');

    // Después de reparar no queda nada que reparar.
    expect(await diagnosticarDerivados(documentId)).toEqual([]);
  });

  it('correrla dos veces deja exactamente lo mismo que correrla una', async () => {
    /*
     * La idempotencia no es una comodidad: es lo que hace que se pueda apretar
     * el botón sin miedo. Un movimiento duplicado contaría la compra dos veces
     * en todos los reportes, que es peor que el problema que se vino a arreglar.
     */
    const documentId = await errecaldeValidado();
    await romperDerivados(documentId);

    await repararDerivados(escenario.admin, documentId);
    const primera = await prisma.purchaseMovement.findMany({
      where: { documentId },
      orderBy: { id: 'asc' },
      select: { id: true, documentItemId: true, productId: true, totalCost: true },
    });

    const segunda = await repararDerivados(escenario.admin, documentId);
    expect(segunda.movimientosCreados).toBe(0);
    expect(segunda.costosCreados).toBe(0);
    expect(segunda.agendaCreada).toBe(false);
    expect(segunda.hallazgos).toEqual([]);

    const despues = await prisma.purchaseMovement.findMany({
      where: { documentId },
      orderBy: { id: 'asc' },
      select: { id: true, documentItemId: true, productId: true, totalCost: true },
    });
    // Los mismos movimientos, no otros iguales: mismos identificadores.
    expect(despues.map((m) => m.id)).toEqual(primera.map((m) => m.id));
    expect(despues.map((m) => m.totalCost.toString())).toEqual(
      primera.map((m) => m.totalCost.toString()),
    );
    expect(await prisma.costHistory.count({ where: { documentId } })).toBe(
      await prisma.documentItem.count({ where: { documentId, productId: { not: null } } }),
    );
    expect(await prisma.paymentSchedule.count({ where: { documentId } })).toBe(1);
  });

  it('no modifica ningún importe del comprobante', async () => {
    /*
     * Reparar es reconstruir lo derivado, no recalcular la factura. Los números
     * los revisó una persona contra el papel y los aceptó: si la reparación los
     * volviera a computar, un cambio en el cálculo reescribiría en silencio una
     * factura ya validada.
     */
    const documentId = await errecaldeValidado();

    const foto = async () =>
      JSON.stringify(
        await prisma.documentItem.findMany({
          where: { documentId },
          orderBy: { lineNumber: 'asc' },
          select: {
            lineNumber: true,
            quantity: true,
            totalWeightKg: true,
            unitNetPrice: true,
            discountAmount: true,
            netAmount: true,
            ivaAmount: true,
            perceptionAmount: true,
            unitCost: true,
            totalCost: true,
          },
        }),
      );

    const antes = await foto();
    await romperDerivados(documentId);
    await repararDerivados(escenario.admin, documentId);
    expect(await foto()).toBe(antes);

    const documento = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(documento.total?.toString()).toBe('4816812.73');
    expect(documento.status).toBe('VALIDADO');
  });

  it('completa las asociaciones que falten y deja las dudosas como están', async () => {
    const documentId = await errecaldeValidado();

    // Un renglón que sí se sabe qué artículo es, y que quedó sin asociar.
    const sardo = await prisma.documentItem.findFirstOrThrow({
      where: { documentId, productId: escenario.productos['2001'] },
    });
    await prisma.documentItem.update({
      where: { id: sardo.id },
      data: { productId: null, matchMethod: 'NONE' },
    });

    // Y uno que no se parece a nada del catálogo: ése no se puede adivinar.
    const desconocido = await prisma.documentItem.findFirstOrThrow({
      where: { documentId, productId: null },
    });

    await repararDerivados(escenario.admin, documentId);

    const reasociado = await prisma.documentItem.findUniqueOrThrow({ where: { id: sardo.id } });
    expect(reasociado.productId).toBe(escenario.productos['2001']);
    // Y el movimiento acompaña: es lo que lee el reporte por artículo.
    const movimiento = await prisma.purchaseMovement.findFirstOrThrow({
      where: { documentItemId: sardo.id },
    });
    expect(movimiento.productId).toBe(escenario.productos['2001']);

    const sigueSinProducto = await prisma.documentItem.findUniqueOrThrow({
      where: { id: desconocido.id },
    });
    expect(sigueSinProducto.productId).toBeNull();
  });

  it('limpia los movimientos que quedaron colgando de renglones que ya no existen', async () => {
    /*
     * Al reconfirmar, los renglones se rehacen y cambian de identificador. Un
     * movimiento que sobreviviera apuntando al renglón viejo sumaría de nuevo la
     * misma compra.
     */
    const documentId = await errecaldeValidado();
    const modelo = await prisma.purchaseMovement.findFirstOrThrow({ where: { documentId } });
    await prisma.purchaseMovement.create({
      data: {
        documentId,
        /*
         * El huérfano: apunta a un renglón que ya no existe.
         *
         * Es lo que queda cuando el comprobante se vuelve a confirmar: los
         * renglones se borran y se rehacen con identificadores nuevos, y un
         * movimiento que sobreviva al viejo suma otra vez la misma compra.
         */
        documentItemId: 'renglon-que-ya-no-existe',
        productId: modelo.productId,
        supplierId: modelo.supplierId,
        branchId: modelo.branchId,
        date: modelo.date,
        description: modelo.description,
        quantity: modelo.quantity.toString(),
        unit: modelo.unit,
        unitNetPrice: modelo.unitNetPrice.toString(),
        discountAmount: modelo.discountAmount.toString(),
        netAmount: modelo.netAmount.toString(),
        ivaAmount: modelo.ivaAmount.toString(),
        perceptionAmount: modelo.perceptionAmount.toString(),
        totalCost: modelo.totalCost.toString(),
        unitCost: modelo.unitCost.toString(),
      },
    });
    expect(await prisma.purchaseMovement.count({ where: { documentId } })).toBe(24);

    const reparacion = await repararDerivados(escenario.admin, documentId);
    expect(await prisma.purchaseMovement.count({ where: { documentId } })).toBe(23);
    expect(reparacion.hallazgos.join(' ')).toContain('ya no existen');

    const compras = await getPurchaseReport(escenario.admin, {});
    expect(compras.totals.costoTotal).toBe('4816812.73');
  });

  it('sólo se repara lo que está validado', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, SAFARI_COMPLETO);
    await leerComprobante(escenario.operadorDevoto, documento.id, {
      completo: SAFARI_COMPLETO,
      articulos: SAFARI_ARTICULOS,
      resumen: SAFARI_RESUMEN,
    });
    // Todavía en REQUIERE_REVISION: se termina de cargar por el camino normal.
    await expect(repararDerivados(escenario.admin, documento.id)).rejects.toThrow(
      /validados/,
    );
    expect(await diagnosticarDerivados(documento.id)).toEqual([]);
  });

  it('no la puede correr quien no puede validar comprobantes', async () => {
    const documentId = await errecaldeValidado();
    await romperDerivados(documentId);
    await expect(repararDerivados(escenario.supervisor, documentId)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    // Y no escribió nada por el camino.
    expect(await prisma.purchaseMovement.count({ where: { documentId } })).toBe(0);
  });

  it('queda auditada, con qué se reconstruyó y quién lo hizo', async () => {
    const documentId = await errecaldeValidado();
    await romperDerivados(documentId);
    await repararDerivados(escenario.admin, documentId);

    const auditoria = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: documentId, action: 'comprobante.derivados_reparados' },
    });
    expect(auditoria.userId).toBe(escenario.admin.id);
    const despues = auditoria.after as Record<string, unknown>;
    expect(despues.movimientosCreados).toBe(23);
    expect(despues.agendaCreada).toBe(true);
    expect(Array.isArray(despues.hallazgos)).toBe(true);
  });
});

describe('la invariante que impide validar a medias', () => {
  beforeEach(async () => {
    await limpiarBase();
    escenario = await sembrarEscenario();
  });

  /*
   * `verificarDerivados` corre dentro de la transacción de la confirmación, y
   * por eso acá se la llama directamente sobre un comprobante ya guardado: es
   * la única manera de romper cada estructura por separado y comprobar que la
   * que falla es la que se rompió. Si no discriminara, la confirmación seguiría
   * pudiendo guardar un comprobante que ninguna otra pantalla puede usar.
   */
  async function errecaldeValidado(): Promise<string> {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, SAFARI_COMPLETO);
    await leerComprobante(escenario.operadorDevoto, documento.id, {
      completo: SAFARI_COMPLETO,
      articulos: SAFARI_ARTICULOS,
      resumen: SAFARI_RESUMEN,
    });
    await acceptReadDocument(escenario.admin, documento.id);
    return documento.id;
  }

  const TOTAL = toDecimal('4816812.73');

  it('un comprobante entero la pasa', async () => {
    const documentId = await errecaldeValidado();
    await expect(verificarDerivados(prisma, documentId, 23, TOTAL)).resolves.toBeUndefined();
  });

  it('falla si falta un movimiento de compra', async () => {
    const documentId = await errecaldeValidado();
    const uno = await prisma.purchaseMovement.findFirstOrThrow({ where: { documentId } });
    await prisma.purchaseMovement.delete({ where: { id: uno.id } });
    await expect(verificarDerivados(prisma, documentId, 23, TOTAL)).rejects.toThrow(
      /23 renglones y 22 movimientos/,
    );
  });

  it('falla si un movimiento quedó con otro producto que su renglón', async () => {
    const documentId = await errecaldeValidado();
    const movimiento = await prisma.purchaseMovement.findFirstOrThrow({
      where: { documentId, productId: { not: null } },
    });
    await prisma.purchaseMovement.update({
      where: { id: movimiento.id },
      data: { productId: escenario.productos['1005'] },
    });
    await expect(verificarDerivados(prisma, documentId, 23, TOTAL)).rejects.toThrow(
      /producto distinto al de su renglón/,
    );
  });

  it('falla si falta el costo de un producto asociado', async () => {
    const documentId = await errecaldeValidado();
    const costo = await prisma.costHistory.findFirstOrThrow({ where: { documentId } });
    await prisma.costHistory.delete({ where: { id: costo.id } });
    await expect(verificarDerivados(prisma, documentId, 23, TOTAL)).rejects.toThrow(
      /entradas de costo/,
    );
  });

  it('falla si no quedó la agenda de pago', async () => {
    const documentId = await errecaldeValidado();
    await prisma.paymentSchedule.deleteMany({ where: { documentId } });
    await expect(verificarDerivados(prisma, documentId, 23, TOTAL)).rejects.toThrow(
      /agendas de pago/,
    );
  });

  it('falla si los movimientos no suman el total del comprobante', async () => {
    const documentId = await errecaldeValidado();
    const uno = await prisma.purchaseMovement.findFirstOrThrow({ where: { documentId } });
    await prisma.purchaseMovement.update({
      where: { id: uno.id },
      data: { totalCost: '0' },
    });
    await expect(verificarDerivados(prisma, documentId, 23, TOTAL)).rejects.toThrow(
      /y el comprobante es de/,
    );
  });
});

describe('corregir la condición de pago de un proveedor', () => {
  beforeEach(async () => {
    await limpiarBase();
    escenario = await sembrarEscenario();
  });

  /*
   * El caso real: Errecalde quedó cargado a 30 días y en realidad cobra factura
   * contra factura. Son dos correcciones distintas y hay que poder hacer las
   * dos: la condición del proveedor, para las próximas facturas, y el
   * vencimiento de la factura que ya está cargada, para ésta.
   *
   * Lo que **no** puede pasar es que corregir la condición reescriba hacia
   * atrás lo que ya se validó: cada comprobante guarda el plazo que se le
   * aplicó, y una factura ya conciliada no puede cambiar de vencimiento sola.
   */

  function formularioDePlazo(campos: Record<string, string>): FormData {
    const form = new FormData();
    for (const [clave, valor] of Object.entries(campos)) form.append(clave, valor);
    return form;
  }

  it('cambiar la condición el mismo día reemplaza, no acumula', async () => {
    const supplierId = escenario.proveedorErrecaldeId;
    const hoy = toISODate(arToday());

    await saveSupplierTerm(
      escenario.admin,
      formularioDePlazo({
        supplierId,
        termType: 'DAYS',
        days: '30',
        paymentMethod: 'TRANSFERENCIA',
        validFrom: hoy,
      }),
    );
    // Y se corrige: era factura contra factura.
    await saveSupplierTerm(
      escenario.admin,
      formularioDePlazo({
        supplierId,
        termType: 'NEXT_INVOICE',
        days: '0',
        paymentMethod: 'TRANSFERENCIA',
        validFrom: hoy,
        nextInvoiceDate: '2026-08-28',
      }),
    );

    /*
     * Una sola condición vigente. Con dos abiertas desde el mismo día, cuál de
     * las dos rige lo decidiría el orden en que la base devuelva las filas.
     */
    const vigentes = await prisma.supplierPaymentTerm.findMany({
      where: { supplierId, validTo: null },
    });
    expect(vigentes).toHaveLength(1);
    expect(vigentes[0].termType).toBe('NEXT_INVOICE');

    const condiciones = await getSupplierConditions(supplierId, arToday());
    expect(condiciones.term?.termType).toBe('NEXT_INVOICE');
    expect(condiciones.proximaFactura && toISODate(condiciones.proximaFactura)).toBe('2026-08-28');
  });

  it('la condición nueva no cambia el vencimiento de lo ya validado', async () => {
    const supplierId = escenario.proveedorErrecaldeId;

    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, SAFARI_COMPLETO);
    await leerComprobante(escenario.operadorDevoto, documento.id, {
      completo: SAFARI_COMPLETO,
      articulos: SAFARI_ARTICULOS,
      resumen: SAFARI_RESUMEN,
    });
    await acceptReadDocument(escenario.admin, documento.id);

    const antes = await prisma.paymentSchedule.findUniqueOrThrow({
      where: { documentId: documento.id },
    });

    await saveSupplierTerm(
      escenario.admin,
      formularioDePlazo({
        supplierId,
        termType: 'NEXT_INVOICE',
        days: '0',
        paymentMethod: 'TRANSFERENCIA',
        validFrom: toISODate(arToday()),
        nextInvoiceDate: '2026-08-28',
      }),
    );

    // La factura ya cargada no se mueve sola: su plazo es el que se le aplicó.
    const despues = await prisma.paymentSchedule.findUniqueOrThrow({
      where: { documentId: documento.id },
    });
    expect(toISODate(despues.dueDate)).toBe(toISODate(antes.dueDate));
  });

  it('el vencimiento de una factura ya validada se corrige sin tocar la compra', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, SAFARI_COMPLETO);
    await leerComprobante(escenario.operadorDevoto, documento.id, {
      completo: SAFARI_COMPLETO,
      articulos: SAFARI_ARTICULOS,
      resumen: SAFARI_RESUMEN,
    });
    await acceptReadDocument(escenario.admin, documento.id);

    const agenda = await prisma.paymentSchedule.findUniqueOrThrow({
      where: { documentId: documento.id },
    });
    const comprasAntes = await getPurchaseReport(escenario.admin, {});

    await reschedulePayment(
      escenario.admin,
      agenda.id,
      '2026-08-28',
      'La condición es factura contra factura, no a 30 días.',
    );

    const despues = await prisma.paymentSchedule.findUniqueOrThrow({
      where: { documentId: documento.id },
    });
    expect(toISODate(despues.dueDate)).toBe('2026-08-28');
    // El importe agendado es el mismo: se movió la fecha, no la deuda.
    expect(despues.plannedAmount.toString()).toBe(agenda.plannedAmount.toString());

    // Y la compra quedó intacta.
    const comprasDespues = await getPurchaseReport(escenario.admin, {});
    expect(comprasDespues.totals.costoTotal).toBe(comprasAntes.totals.costoTotal);
    expect(comprasDespues.rows).toHaveLength(comprasAntes.rows.length);
    const comprobante = await prisma.document.findUniqueOrThrow({ where: { id: documento.id } });
    expect(comprobante.status).toBe('VALIDADO');
    expect(comprobante.total?.toString()).toBe('4816812.73');

    // El cambio queda en el historial del pago, con su motivo.
    const evento = await prisma.paymentEvent.findFirstOrThrow({
      where: { scheduleId: agenda.id, kind: 'REPROGRAMACION' },
    });
    expect(evento.notes).toContain('factura contra factura');
    expect(evento.userId).toBe(escenario.admin.id);
  });

  it('no reprograma quien no tiene el permiso', async () => {
    const documento = await createDocument(escenario.operadorDevoto, escenario.sucursales.devoto);
    await adjuntarPagina(documento.id, SAFARI_COMPLETO);
    await leerComprobante(escenario.operadorDevoto, documento.id, {
      completo: SAFARI_COMPLETO,
      articulos: SAFARI_ARTICULOS,
      resumen: SAFARI_RESUMEN,
    });
    await acceptReadDocument(escenario.admin, documento.id);
    const agenda = await prisma.paymentSchedule.findUniqueOrThrow({
      where: { documentId: documento.id },
    });

    await expect(
      reschedulePayment(escenario.operadorDevoto, agenda.id, '2026-08-28', 'probando'),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('importar el catálogo interno de Don Ginés', () => {
  beforeEach(async () => {
    await limpiarBase();
    escenario = await sembrarEscenario();
  });

  /*
   * Compras no inventa PLU: los toma de Control de Stock.
   *
   * El catálogo con los números internos ya existe y es de otro sistema. Lo que
   * se prueba acá es que copiarlo no lo estropee: que el PLU se conserve exacto,
   * que nada se renumere por parecido de nombre, que nada se borre y que las
   * compras que ya están cargadas no se muevan un centímetro.
   */

  const CATALOGO = [
    'PLU;Nombre;Familia;Proveedor;Codigo Proveedor;Activo',
    '1211;Cremoso Punta del Agua;Quesos;Distribución Errecalde;ART-00228;si',
    '2001;Queso Sardo bloque Melincué;Queso Sardo;Distribución Errecalde;ART-00758;si',
    '2002;Queso Sardo Don Alfonso;Queso Sardo;Distribución Errecalde;ART-00722;si',
    '3050;Provoleta entera;Quesos;;;si',
  ].join('\n');

  it('el informe no escribe nada', async () => {
    const antes = await prisma.product.count();
    const informe = await importarCatalogo(escenario.admin, CATALOGO);

    expect(informe.aplicados).toBe(0);
    expect(informe.nuevos.map((n) => n.plu)).toContain('3050');
    expect(await prisma.product.count()).toBe(antes);
    expect(await prisma.productFamily.count()).toBe(0);
  });

  it('hace upsert por PLU: actualiza el que está y crea el que falta', async () => {
    const informe = await importarCatalogo(escenario.admin, CATALOGO, { aplicar: true });

    // El 3050 no estaba: se crea con su PLU tal cual.
    const nuevo = await prisma.product.findUniqueOrThrow({ where: { internalCode: '3050' } });
    expect(nuevo.normalizedName).toBe('Provoleta entera');

    // El 1211 ya estaba: se actualiza, no se duplica.
    expect(await prisma.product.count({ where: { internalCode: '1211' } })).toBe(1);
    const cremoso = await prisma.product.findUniqueOrThrow({ where: { internalCode: '1211' } });
    expect(cremoso.id).toBe(escenario.productos['1211']);
    expect(cremoso.catalogSyncedAt).not.toBeNull();

    expect(informe.nuevos).toHaveLength(1);
    expect(informe.conflictos).toEqual([]);

    // Correrlo de nuevo no crea nada: la segunda vez ya están todos.
    const segunda = await importarCatalogo(escenario.admin, CATALOGO, { aplicar: true });
    expect(segunda.nuevos).toHaveLength(0);
    expect(await prisma.product.count({ where: { internalCode: '3050' } })).toBe(1);
  });

  it('no renumera un artículo porque el nombre coincida', async () => {
    /*
     * El caso peligroso: el archivo trae con otro PLU un artículo que acá ya
     * existe. Cambiarle el número le movería encima todo su historial de
     * compras y de precios, y eso no lo decide una coincidencia de texto.
     */
    const archivo = ['PLU,Nombre', '9999,Cremoso Punta del Agua'].join('\n');
    const informe = await importarCatalogo(escenario.admin, archivo, { aplicar: true });

    expect(informe.conflictos).toHaveLength(1);
    expect(informe.conflictos[0].motivo).toContain('1211');
    // Ni se renumeró el viejo ni se creó el nuevo.
    const cremoso = await prisma.product.findUniqueOrThrow({
      where: { id: escenario.productos['1211'] },
    });
    expect(cremoso.internalCode).toBe('1211');
    expect(await prisma.product.findUnique({ where: { internalCode: '9999' } })).toBeNull();
  });

  it('un PLU repetido en el archivo con dos nombres no entra', async () => {
    const archivo = ['PLU,Nombre', '4000,Una cosa', '4000,Otra cosa distinta'].join('\n');
    const informe = await importarCatalogo(escenario.admin, archivo, { aplicar: true });

    expect(informe.conflictos[0].motivo).toContain('dos veces');
    expect(await prisma.product.findUnique({ where: { internalCode: '4000' } })).toBeNull();
  });

  it('no borra lo que no viene en el archivo, y avisa si tiene compras', async () => {
    const documento = await comprobanteErrecaldeValidado();
    void documento;

    const archivo = ['PLU,Nombre', '1211,Cremoso Punta del Agua'].join('\n');
    const antes = await prisma.product.count();
    const informe = await importarCatalogo(escenario.admin, archivo, { aplicar: true });

    expect(await prisma.product.count()).toBe(antes);
    const sardo = informe.soloEnCompras.find((p) => p.plu === '2001');
    expect(sardo, 'el Sardo quedó fuera del informe de sobrantes').toBeDefined();
    // Y se dice cuáles tienen compras cargadas: borrar ésos no tendría vuelta.
    expect(sardo!.conMovimientos).toBe(true);
  });

  it('aprende el código del proveedor, y con eso la próxima factura entra sola', async () => {
    /*
     * Errecalde · ART-00228 → Don Ginés · PLU 1211.
     *
     * Es la relación que se busca. Una vez cargada, el reconocimiento no
     * depende de cómo salga la descripción del OCR: entra por identificación.
     */
    await importarCatalogo(escenario.admin, CATALOGO, { aplicar: true });

    const alias = await prisma.productAlias.findFirstOrThrow({
      where: { supplierId: escenario.proveedorErrecaldeId, supplierCode: 'ART-00228' },
    });
    expect(alias.productId).toBe(escenario.productos['1211']);

    const [resultado] = await matchItemsToProducts(
      costItems(
        [
          {
            lineNumber: 1,
            supplierCode: 'ART-00228',
            // Una descripción que no se parece: lo que manda es el código.
            description: 'CREM PDA X HORMA',
            quantity: '1',
            unit: 'KG',
            unitNetPrice: '100',
            discountPct: '0',
            ivaRate: '0.21',
          },
        ],
        { netTotal: '100', ivaTotal: '21', perceptionsTotal: '0' },
      ),
      escenario.proveedorErrecaldeId,
    );
    expect(resultado.method).toBe('SUPPLIER_CODE');
    expect(resultado.productId).toBe(escenario.productos['1211']);
  });

  it('no le roba a otro PLU un código de proveedor ya asignado', async () => {
    // ART-00228 ya es del 1211; el archivo quiere dárselo al 3050.
    await importarCatalogo(escenario.admin, CATALOGO, { aplicar: true });

    const archivo = [
      'PLU;Nombre;Proveedor;Codigo Proveedor',
      '3050;Provoleta entera;Distribución Errecalde;ART-00228',
    ].join('\n');
    const informe = await importarCatalogo(escenario.admin, archivo, { aplicar: true });

    expect(informe.conflictos[0].motivo).toContain('1211');
    const alias = await prisma.productAlias.findFirstOrThrow({
      where: { supplierId: escenario.proveedorErrecaldeId, supplierCode: 'ART-00228' },
    });
    expect(alias.productId, 'el código cambió de artículo solo').toBe(escenario.productos['1211']);
  });

  it('no toca las compras, los impuestos ni los pagos ya cargados', async () => {
    const documentId = await comprobanteErrecaldeValidado();

    const foto = async () =>
      JSON.stringify({
        comprobante: await prisma.document.findUnique({
          where: { id: documentId },
          select: { total: true, netTotal: true, ivaTotal: true, status: true },
        }),
        renglones: await prisma.documentItem.findMany({
          where: { documentId },
          orderBy: { lineNumber: 'asc' },
          select: { quantity: true, netAmount: true, ivaAmount: true, totalCost: true },
        }),
        movimientos: await prisma.purchaseMovement.count({ where: { documentId } }),
        agenda: await prisma.paymentSchedule.findUnique({
          where: { documentId },
          select: { dueDate: true, plannedAmount: true },
        }),
      });

    const antes = await foto();
    await importarCatalogo(escenario.admin, CATALOGO, { aplicar: true });
    expect(await foto()).toBe(antes);
  });

  it('no pisa el margen ni el redondeo, que son de Compras y no de Stock', async () => {
    await prisma.product.update({
      where: { id: escenario.productos['1211'] },
      data: { targetMarginPct: '0.62', roundingRule: 'NEAREST_50' },
    });
    await importarCatalogo(escenario.admin, CATALOGO, { aplicar: true });

    const cremoso = await prisma.product.findUniqueOrThrow({
      where: { id: escenario.productos['1211'] },
    });
    expect(cremoso.targetMarginPct.toString()).toBe('0.62');
    expect(cremoso.roundingRule).toBe('NEAREST_50');
  });

  it('no la corre quien no administra productos', async () => {
    await expect(importarCatalogo(escenario.operadorDevoto, CATALOGO, { aplicar: true }))
      .rejects.toBeInstanceOf(ForbiddenError);
    expect(await prisma.product.findUnique({ where: { internalCode: '3050' } })).toBeNull();
  });

  it('queda auditada', async () => {
    await importarCatalogo(escenario.admin, CATALOGO, { aplicar: true });
    const auditoria = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'catalogo.importado' },
    });
    expect(auditoria.userId).toBe(escenario.admin.id);
    expect((auditoria.after as Record<string, unknown>).creados).toBe(1);
  });
});

describe('mapeo masivo de códigos de proveedor', () => {
  beforeEach(async () => {
    await limpiarBase();
    escenario = await sembrarEscenario();
  });

  it('muestra una vista previa y recién después aprende código -> PLU', async () => {
    const texto = [
      'Código proveedor;PLU',
      'ART-00228;1211',
      'ART-00758;2001',
    ].join('\n');

    const previa = await importarMapeoCodigosProveedor(
      escenario.admin,
      escenario.proveedorErrecaldeId,
      texto,
    );

    expect(previa.aplicadas).toBe(0);
    expect(previa.aplicables.map((f) => f.plu).sort()).toEqual(['1211', '2001']);

    expect(
      await prisma.productAlias.findFirst({
        where: {
          supplierId: escenario.proveedorErrecaldeId,
          supplierCode: 'ART-00758',
        },
      }),
    ).toBeNull();

    const aplicado = await importarMapeoCodigosProveedor(
      escenario.admin,
      escenario.proveedorErrecaldeId,
      texto,
      { aplicar: true },
    );
    expect(aplicado.aplicadas).toBe(2);

    const alias = await prisma.productAlias.findFirstOrThrow({
      where: {
        supplierId: escenario.proveedorErrecaldeId,
        supplierCode: 'ART-00228',
      },
    });
    expect(alias.productId).toBe(escenario.productos['1211']);
  });

  it('no acepta un PLU inexistente ni roba un código que ya tiene dueño', async () => {
    const primero = [
      'Código proveedor;PLU',
      'ART-00228;1211',
    ].join('\n');
    await importarMapeoCodigosProveedor(
      escenario.admin,
      escenario.proveedorErrecaldeId,
      primero,
      { aplicar: true },
    );

    const conflictivo = [
      'Código proveedor;PLU',
      'ART-00228;2001',
      'ART-99999;NO-EXISTE',
    ].join('\n');
    const informe = await importarMapeoCodigosProveedor(
      escenario.admin,
      escenario.proveedorErrecaldeId,
      conflictivo,
      { aplicar: true },
    );

    expect(informe.aplicadas).toBe(0);
    expect(informe.conflictos).toHaveLength(2);

    const alias = await prisma.productAlias.findFirstOrThrow({
      where: {
        supplierId: escenario.proveedorErrecaldeId,
        supplierCode: 'ART-00228',
      },
    });
    expect(alias.productId).toBe(escenario.productos['1211']);
  });

  it('los códigos aprendidos levantan la factura histórica y crean costos para Precios', async () => {
    const documentId = await comprobanteErrecaldeValidado();

    await prisma.documentItem.updateMany({
      where: { documentId },
      data: { productId: null, matchMethod: 'NONE' },
    });
    await prisma.purchaseMovement.updateMany({
      where: { documentId },
      data: { productId: null },
    });
    await prisma.costHistory.deleteMany({ where: { documentId } });

    await importarMapeoCodigosProveedor(
      escenario.admin,
      escenario.proveedorErrecaldeId,
      ['Código proveedor;PLU', 'ART-00228;1211', 'ART-00758;2001'].join('\n'),
      { aplicar: true },
    );

    const backfill = await backfillProductLinks(escenario.admin, {
      aplicar: true,
      supplierId: escenario.proveedorErrecaldeId,
    });
    expect(backfill.porCodigo.some((f) => f.supplierCode === 'ART-00228')).toBe(true);
    expect(backfill.porCodigo.some((f) => f.supplierCode === 'ART-00758')).toBe(true);

    const cremoso = await getLatestCost(escenario.productos['1211']);
    const sardo = await getLatestCost(escenario.productos['2001']);
    expect(cremoso.unitCost).not.toBeNull();
    expect(sardo.unitCost).not.toBeNull();
  });
});

describe('familias de artículos', () => {
  beforeEach(async () => {
    await limpiarBase();
    escenario = await sembrarEscenario();
  });

  /*
   * "Cuánto Sardo compramos" no es una pregunta sobre un producto.
   *
   * El Sardo Bloque Melincué y el Sardo Don Alfonso son dos artículos
   * distintos, con dos PLU, dos costos y dos precios. La familia existe para
   * poder sumarlos sin fundirlos en uno solo: el reporte por familia da el
   * total, y el reporte por PLU sigue hablando de uno.
   */

  it('la familia suma los PLU que la componen, y el PLU sigue siendo uno', async () => {
    const documentId = await comprobanteErrecaldeValidado();
    void documentId;

    await importarCatalogo(
      escenario.admin,
      [
        'PLU;Nombre;Familia',
        '2001;Queso Sardo bloque Melincué;Queso Sardo',
        '2002;Queso Sardo Don Alfonso;Queso Sardo',
      ].join('\n'),
      { aplicar: true },
    );

    const familia = await prisma.productFamily.findFirstOrThrow({ where: { name: 'Queso Sardo' } });

    // Los dos Sardo de la factura de Errecalde: 4,75 kg + 28,90 kg.
    const total = await getPurchaseReport(escenario.admin, { familyId: familia.id });
    expect(total.totals.kilos).toBe('33.65');
    expect(total.rows).toHaveLength(2);

    // Y cada uno por separado sigue siendo el suyo.
    const bloque = await getPurchaseReport(escenario.admin, {
      productId: escenario.productos['2001'],
    });
    expect(bloque.totals.kilos).toBe('4.75');
    const alfonso = await getPurchaseReport(escenario.admin, {
      productId: escenario.productos['2002'],
    });
    expect(alfonso.totals.kilos).toBe('28.90');
  });

  it('si se piden familia y PLU a la vez, manda el PLU', async () => {
    /*
     * El caso que lo prueba de verdad es un PLU que **no** pertenece a la
     * familia elegida: si los dos filtros se aplicaran juntos no quedaría nada,
     * y quien acaba de elegir un artículo concreto vería la pantalla vacía sin
     * entender que le quedó puesto un filtro de más.
     */
    await comprobanteErrecaldeValidado();
    await importarCatalogo(
      escenario.admin,
      [
        'PLU;Nombre;Familia',
        '2001;Queso Sardo bloque Melincué;Queso Sardo',
        '2002;Queso Sardo Don Alfonso;Queso Sardo',
      ].join('\n'),
      { aplicar: true },
    );
    const familia = await prisma.productFamily.findFirstOrThrow({ where: { name: 'Queso Sardo' } });

    // El cremoso no está en la familia Queso Sardo.
    const uno = await getPurchaseReport(escenario.admin, {
      familyId: familia.id,
      productId: escenario.productos['1211'],
    });
    expect(uno.rows.length).toBeGreaterThan(0);
    expect(uno.rows.every((r) => r.productName?.includes('Cremoso'))).toBe(true);
  });

  it('un artículo sin familia no se cuela en ninguna', async () => {
    await comprobanteErrecaldeValidado();
    await importarCatalogo(
      escenario.admin,
      ['PLU;Nombre;Familia', '2001;Queso Sardo bloque Melincué;Queso Sardo'].join('\n'),
      { aplicar: true },
    );
    const familia = await prisma.productFamily.findFirstOrThrow({ where: { name: 'Queso Sardo' } });

    const reporte = await getPurchaseReport(escenario.admin, { familyId: familia.id });
    expect(reporte.totals.kilos).toBe('4.75');
  });
});

describe('la factura de Errecalde contra el catálogo interno', () => {
  beforeEach(async () => {
    await limpiarBase();
    escenario = await sembrarEscenario();
  });

  /*
   * El caso completo, en el orden en que pasó de verdad.
   *
   * La factura se cargó y se validó cuando Compras todavía no tenía el catálogo
   * de Don Ginés: sus renglones quedaron sin PLU, y para el reporte por artículo
   * esa compra no existía. Después llega el catálogo desde Control de Stock, y a
   * partir de ahí hay que poder recuperar la factura **sin OCR y sin volver a
   * cargarla**: asociar sus renglones y sus movimientos a los PLU internos y
   * completar el historial de costos.
   *
   * Lo que no puede cambiar en todo el recorrido es un solo importe.
   */

  it('se recupera entera después de importar el catálogo, sin volver a leer la foto', async () => {
    // 1. El catálogo todavía no existe.
    await prisma.product.deleteMany({});
    const documentId = await comprobanteErrecaldeValidado();

    const antes = await prisma.documentItem.findMany({
      where: { documentId },
      orderBy: { lineNumber: 'asc' },
      select: { quantity: true, netAmount: true, ivaAmount: true, totalCost: true },
    });
    expect(await prisma.documentItem.count({ where: { documentId, productId: null } })).toBe(23);
    expect(await prisma.costHistory.count({ where: { documentId } })).toBe(0);

    // El total general está —la compra se hizo— pero no hay nada por artículo.
    const general = await getPurchaseReport(escenario.admin, {});
    expect(general.totals.costoTotal).toBe('4816812.73');

    // 2. Llega el catálogo, con los códigos que usa Errecalde.
    await importarCatalogo(
      escenario.admin,
      [
        'PLU;Nombre;Familia;Proveedor;Codigo Proveedor',
        '2001;Queso Sardo bloque Melincué;Queso Sardo;Distribución Errecalde;ART-00758',
        '2002;Queso Sardo Don Alfonso;Queso Sardo;Distribución Errecalde;ART-00722',
        '1211;Cremoso Punta del Agua;Quesos;Distribución Errecalde;ART-00228',
      ].join('\n'),
      { aplicar: true },
    );

    // 3. Backfill sobre lo que ya está cargado, sin tocar la factura.
    const informe = await backfillProductLinks(escenario.admin, { aplicar: true });
    expect(informe.aplicadas).toBeGreaterThan(0);

    // 4. Y se completa lo derivado que faltaba: el historial de costos.
    const reparacion = await repararDerivados(escenario.admin, documentId);
    expect(reparacion.costosCreados).toBeGreaterThan(0);

    // --- Compras muestra cantidades por artículo --------------------------
    const sardoBloque = await prisma.product.findUniqueOrThrow({
      where: { internalCode: '2001' },
    });
    const sardoAlfonso = await prisma.product.findUniqueOrThrow({
      where: { internalCode: '2002' },
    });
    expect((await getPurchaseReport(escenario.admin, { productId: sardoBloque.id })).totals.kilos)
      .toBe('4.75');
    expect((await getPurchaseReport(escenario.admin, { productId: sardoAlfonso.id })).totals.kilos)
      .toBe('28.90');

    // --- Y la familia los suma -------------------------------------------
    const familia = await prisma.productFamily.findFirstOrThrow({ where: { name: 'Queso Sardo' } });
    const porFamilia = await getPurchaseReport(escenario.admin, { familyId: familia.id });
    expect(porFamilia.totals.kilos).toBe('33.65');

    // --- Precios tiene costo para lo asociado ----------------------------
    expect(await getLatestCost(sardoBloque.id)).not.toBeNull();
    expect(await getLatestCost(sardoAlfonso.id)).not.toBeNull();

    // --- Y ningún importe se movió ---------------------------------------
    const despues = await prisma.documentItem.findMany({
      where: { documentId },
      orderBy: { lineNumber: 'asc' },
      select: { quantity: true, netAmount: true, ivaAmount: true, totalCost: true },
    });
    expect(JSON.stringify(despues)).toBe(JSON.stringify(antes));
    expect((await getPurchaseReport(escenario.admin, {})).totals.costoTotal).toBe('4816812.73');
    // Ni se duplicó ningún movimiento, ni se tocó el pago.
    expect(await prisma.purchaseMovement.count({ where: { documentId } })).toBe(23);
    expect(await prisma.paymentSchedule.count({ where: { documentId } })).toBe(1);
  });

  it('el catálogo se encuentra por PLU, por nombre y por código de proveedor', async () => {
    await importarCatalogo(
      escenario.admin,
      [
        'PLU;Nombre;Familia;Proveedor;Codigo Proveedor',
        '1211;Cremoso Punta del Agua;Quesos;Distribución Errecalde;ART-00228',
      ].join('\n'),
      { aplicar: true },
    );

    /*
     * Las tres maneras tienen que llegar al mismo artículo: depende de dónde
     * esté parado quien busca. Frente a la balanza se sabe el PLU; frente a la
     * factura, el código del proveedor; hablando con alguien, el nombre.
     */
    for (const termino of ['1211', 'cremoso', 'ART-00228']) {
      const encontrados = await buscarEnCatalogo(escenario.admin, termino);
      expect(encontrados.map((a) => a.plu), `no se encontró por «${termino}»`).toContain('1211');
    }

    const [cremoso] = await buscarEnCatalogo(escenario.admin, '1211');
    expect(cremoso.familia).toBe('Quesos');
    expect(cremoso.codigos).toEqual([
      { proveedor: 'Distribución Errecalde', codigo: 'ART-00228' },
    ]);
  });
});

describe('el catálogo tal como lo exporta la Hoja 1', () => {
  beforeEach(async () => {
    await limpiarBase();
    escenario = await sembrarEscenario();
  });

  /*
   * La Hoja 1 de Control de Stock trae dos niveles de clasificación, «Tipo de
   * Artículo» y «Subtipo de Artículo», y ninguno de los dos es la familia por
   * decreto: depende de cómo estén cargados. Si el Tipo es "Quesos" y el
   * Subtipo "Queso Sardo", la familia que agrupa a los dos Sardo sin arrastrar
   * al cremoso es el Subtipo. Por eso se elige y se ve el resultado antes.
   */

  const HOJA1 = [
    'PLU,Artículo,Proveedor,Tipo de Artículo,Subtipo de Artículo,URL Imagen',
    '1211,Cremoso Punta del Agua,Distribución Errecalde,Quesos,Queso Cremoso,https://x/1.jpg',
    '2001,Queso Sardo bloque Melincué,Distribución Errecalde,Quesos,Queso Sardo,https://x/2.jpg',
    '2002,Queso Sardo Don Alfonso,Distribución Errecalde,Quesos,Queso Sardo,https://x/3.jpg',
  ].join('\n');

  it('el Subtipo agrupa los dos Sardo sin arrastrar el cremoso', async () => {
    await comprobanteErrecaldeValidado();
    await importarCatalogo(escenario.admin, HOJA1, { aplicar: true, familiaDesde: 'subtipo' });

    const sardo = await prisma.productFamily.findFirstOrThrow({ where: { name: 'Queso Sardo' } });
    const reporte = await getPurchaseReport(escenario.admin, { familyId: sardo.id });
    expect(reporte.totals.kilos).toBe('33.65');

    // Y el cremoso quedó en la suya, no en la del Sardo.
    const cremoso = await prisma.product.findUniqueOrThrow({ where: { internalCode: '1211' } });
    expect(cremoso.familyId).not.toBe(sardo.id);
  });

  it('el Tipo agrupa más grueso, y se elige antes de aplicar', async () => {
    await comprobanteErrecaldeValidado();
    await importarCatalogo(escenario.admin, HOJA1, { aplicar: true, familiaDesde: 'tipo' });

    // Con el nivel grueso hay una sola familia y entran los tres.
    expect(await prisma.productFamily.count()).toBe(1);
    const quesos = await prisma.productFamily.findFirstOrThrow({ where: { name: 'Quesos' } });
    expect(await prisma.product.count({ where: { familyId: quesos.id } })).toBe(3);
  });

  it('el informe dice qué familias saldrían, sin escribir ninguna', async () => {
    const informe = await importarCatalogo(escenario.admin, HOJA1, { familiaDesde: 'subtipo' });
    expect(informe.familiasNuevas).toEqual(['Queso Cremoso', 'Queso Sardo']);
    expect(await prisma.productFamily.count()).toBe(0);
  });

  it('los dos niveles se guardan aunque sólo uno arme la familia', async () => {
    await importarCatalogo(escenario.admin, HOJA1, { aplicar: true, familiaDesde: 'subtipo' });
    const sardo = await prisma.product.findUniqueOrThrow({ where: { internalCode: '2001' } });
    expect(sardo.category).toBe('Quesos');
    expect(sardo.subtype).toBe('Queso Sardo');
  });

  it('el Proveedor de la planilla queda como proveedor habitual', async () => {
    await importarCatalogo(escenario.admin, HOJA1, { aplicar: true });
    const cremoso = await prisma.product.findUniqueOrThrow({ where: { internalCode: '1211' } });
    expect(cremoso.defaultSupplierId).toBe(escenario.proveedorErrecaldeId);
  });

  it('un proveedor que no está en Compras se avisa una vez, no una por fila', async () => {
    /*
     * El Proveedor de la Hoja 1 es informativo. Un catálogo entero de un
     * proveedor que todavía no se dio de alta llenaría el informe de
     * conflictos repetidos y taparía lo que sí hay que mirar.
     */
    const archivo = [
      'PLU,Artículo,Proveedor',
      '5001,Uno,Lácteos del Sur',
      '5002,Dos,Lácteos del Sur',
      '5003,Tres,Lácteos del Sur',
    ].join('\n');
    const informe = await importarCatalogo(escenario.admin, archivo, { aplicar: true });

    expect(informe.proveedoresDesconocidos).toEqual(['Lácteos del Sur']);
    expect(informe.conflictos).toEqual([]);
    // Y los artículos entraron igual: el proveedor no es condición para existir.
    expect(await prisma.product.count({ where: { internalCode: { startsWith: '500' } } })).toBe(3);
  });

  it('avisa aparte cuando un PLU con compras cambiaría de nombre', async () => {
    /*
     * El caso que motiva el aviso: un PLU ocupado por un artículo de
     * demostración que en Control de Stock es otra cosa. Cambiarle el nombre
     * reetiqueta hacia atrás las compras ya validadas.
     */
    await comprobanteErrecaldeValidado();

    const archivo = ['PLU,Artículo', '2001,Manteca La Serenísima'].join('\n');
    const informe = await importarCatalogo(escenario.admin, archivo);

    expect(informe.renombresConCompras).toHaveLength(1);
    expect(informe.renombresConCompras[0].plu).toBe('2001');
    // No se mezcla con los cambios inofensivos.
    expect(informe.actualizables).toHaveLength(0);
    // Y como es sólo el informe, nada se escribió.
    const sardo = await prisma.product.findUniqueOrThrow({ where: { internalCode: '2001' } });
    expect(sardo.normalizedName).toBe('Queso Sardo bloque Melincué');
  });

  it('un PLU sin compras que cambia de nombre es un cambio común', async () => {
    // Sin historial detrás, renombrar no reetiqueta nada.
    const archivo = ['PLU,Artículo', '2001,Sardo Melincué'].join('\n');
    const informe = await importarCatalogo(escenario.admin, archivo);
    expect(informe.renombresConCompras).toHaveLength(0);
    expect(informe.actualizables).toHaveLength(1);
  });

  it('una factura con artículos desconocidos no da de alta ningún PLU', async () => {
    /*
     * La regla de fondo: Compras no numera artículos. Si la factura trae algo
     * que el catálogo no tiene, el renglón queda sin asociar y se resuelve a
     * mano contra el catálogo real; nunca se inventa un PLU nuevo.
     */
    await prisma.product.deleteMany({});
    await comprobanteErrecaldeValidado();

    expect(await prisma.product.count()).toBe(0);
    expect(await prisma.productAlias.count()).toBe(0);
  });
});
