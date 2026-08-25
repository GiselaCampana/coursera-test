import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { getStorage, buildDocumentKey } from '@/lib/storage';
import { ForbiddenError } from '@/lib/errors';
import {
  acceptReadDocument,
  confirmDocument,
  createDocument,
  rejectDocument,
  voidDocument,
  type ConfirmDocumentInput,
} from '@/lib/services/documents';
import { analizarSinGuardar, registrarLectura } from '@/lib/services/lectura';
import { versionEnEjecucion } from '@/lib/version';
import { confirmPayment } from '@/lib/services/payments';
import { suggestPricesFor, approveSalePrice, getLatestCost } from '@/lib/services/pricing';
import { getPurchaseReport, purchaseReportToCsv } from '@/lib/services/reports';
import { computePaymentStatus } from '@/lib/domain/payments';
import { toISODate, dateOnlyFromISO } from '@/lib/datetime';
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
