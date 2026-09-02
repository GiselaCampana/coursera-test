import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { ForbiddenError } from '@/lib/errors';
import { createDocument, confirmDocument } from '@/lib/services/documents';
import { auditarAtribucion } from '@/lib/services/auditoria-proveedor';
import { limpiarBase, sembrarEscenario, type Escenario } from './ayudas';

/**
 * La auditoría de a quién pertenece cada comprobante.
 *
 * Existe por un defecto ya corregido: el analizador de Los Calvos reconocía un
 * comprobante sólo por sus cabeceras de columna y después escribía "Los Calvos"
 * como razón social, así que la factura de un proveedor no cargado quedaba
 * atribuida a él. Lo que se prueba acá es que el informe distingue de verdad,
 * en vez de repartir los comprobantes en cuatro montones que suenan bien.
 *
 * Las dos cosas que tienen que salir bien son opuestas y las dos importan: que
 * **no acuse** a un comprobante que sí es del proveedor, y que **no absuelva**
 * a uno que no lo es. Un informe que se equivoca en cualquiera de las dos
 * direcciones hace perder más tiempo del que ahorra.
 */

let escenario: Escenario;

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();
});

const RENGLON = {
  lineNumber: 1,
  supplierCode: 'ART-00228',
  description: 'CREMOSO PUNTA DEL AGUA',
  quantity: '10',
  unit: 'KG' as const,
  unitNetPrice: '10000',
  grossSubtotal: '100000',
  discountPct: '0',
  ivaRate: '0.21',
};

const PIE = {
  netTotal: '100000',
  ivaTotal: '21000',
  perceptionsTotal: '0',
  total: '121000',
  lineCount: 1,
};

/**
 * Un comprobante cargado a nombre de un proveedor, con el texto de OCR que se
 * quiera. El texto es la evidencia: es lo que estaba en la foto.
 */
async function comprobante(opciones: {
  supplierId: string;
  numero: string;
  textoOcr?: string | null;
  codigo?: string;
  productId?: string | null;
}) {
  const doc = await createDocument(escenario.admin, escenario.sucursales.devoto);

  if (opciones.textoOcr !== null) {
    await prisma.ocrAttempt.create({
      data: {
        documentId: doc.id,
        attemptNumber: 1,
        stage: 'FULL',
        provider: 'tesseract-local',
        success: true,
        startedAt: new Date(),
        finishedAt: new Date(),
        recognizedText: opciones.textoOcr ?? 'texto sin nada reconocible',
      },
    });
  }

  await confirmDocument(escenario.admin, {
    documentId: doc.id,
    supplierId: opciones.supplierId,
    docType: 'FACTURA',
    letter: 'A',
    pointOfSale: '0010',
    number: opciones.numero,
    issueDate: '2026-08-14',
    printed: PIE,
    items: [
      {
        ...RENGLON,
        supplierCode: opciones.codigo ?? RENGLON.supplierCode,
        productId: opciones.productId === undefined ? escenario.productos['1001'] : opciones.productId,
      },
    ],
    payment: { dueDate: '2026-08-14', paymentMethod: 'TRANSFERENCIA', notes: null },
  });
  return doc.id;
}

/** El texto que dejó el OCR sobre una factura de Los Calvos de verdad. */
const PAPEL_DE_LOS_CALVOS = [
  'LOS CALVOS S.A.',
  'Fabrica de chacinados',
  'CUIT: 30-61234567-9',
  'FACTURA A   Punto de Venta: 0010',
  'Cod   Descripcion       Kg    Precio   Bonif %   Importe',
  '1001  LONGANIZA CORTA  16,10  16.037,00  14,00  258.195,70',
].join('\n');

/** El texto de una factura de un proveedor que no está cargado en el sistema. */
const PAPEL_DE_UN_DESCONOCIDO = [
  'FIAMBRES DEL OESTE S R L',
  'Distribuidora de fiambres',
  'CUIT: 30-59876543-2',
  'FACTURA A   Punto de Venta: 0010',
  'Cod   Descripcion       Kg    Precio   Bonif %   Importe',
  '77    PROVOLONE HILADO  10,00  10.000,00  0,00  100.000,00',
].join('\n');

/** El texto de una factura de Errecalde, que sí está cargado. */
const PAPEL_DE_ERRECALDE = [
  'DISTRIBUCION ERRECALDE S. A.',
  'CUIT 30-71780890-4',
  'FACTURA-REMITO A   Punto de Venta: 0003',
  'ART-00228 CREMOSO PUNTA DEL AGUA  10,00  10.000,00  100.000,00',
].join('\n');

const numerosDe = (lista: { numero: string }[]) => lista.map((c) => c.numero).sort();

describe('la auditoría no acusa a los comprobantes que sí son del proveedor', () => {
  it('con el CUIT del proveedor impreso, el comprobante es suyo', async () => {
    await comprobante({
      supplierId: escenario.proveedorId,
      numero: '00100001',
      textoOcr: PAPEL_DE_LOS_CALVOS,
    });

    const informe = await auditarAtribucion(escenario.admin, escenario.proveedorId);
    expect(numerosDe(informe.porVeredicto.CORRECTO)).toEqual(['0010-00100001']);
    expect(informe.porVeredicto.SOSPECHOSO).toHaveLength(0);
    expect(informe.porVeredicto.OTRO_PROVEEDOR).toHaveLength(0);
  });

  it('el papel manda por encima de los indicios indirectos', async () => {
    /*
     * Un comprobante de Los Calvos que además no cierra con nada más: sin
     * códigos aprendidos, sin renglones asociados. Si los indicios indirectos
     * pudieran ganarle al papel, este comprobante saldría acusado, y el papel
     * dice su CUIT.
     */
    await comprobante({
      supplierId: escenario.proveedorId,
      numero: '00100002',
      textoOcr: PAPEL_DE_LOS_CALVOS,
      codigo: 'COD-QUE-NADIE-CONOCE',
      productId: null,
    });

    const informe = await auditarAtribucion(escenario.admin, escenario.proveedorId);
    expect(numerosDe(informe.porVeredicto.CORRECTO)).toEqual(['0010-00100002']);
  });

  it('alcanza con el nombre cuando el OCR se comió el CUIT', async () => {
    await comprobante({
      supplierId: escenario.proveedorId,
      numero: '00100003',
      textoOcr: 'LOS CALVOS S.A.\nFabrica de chacinados\nFACTURA A',
    });

    const informe = await auditarAtribucion(escenario.admin, escenario.proveedorId);
    expect(numerosDe(informe.porVeredicto.CORRECTO)).toEqual(['0010-00100003']);
  });
});

describe('la auditoría encuentra los que no son del proveedor', () => {
  it('un comprobante cuyo papel nombra a otro proveedor cargado queda confirmado como ajeno', async () => {
    await comprobante({
      supplierId: escenario.proveedorId,
      numero: '00100004',
      textoOcr: PAPEL_DE_ERRECALDE,
    });

    const informe = await auditarAtribucion(escenario.admin, escenario.proveedorId);
    expect(numerosDe(informe.porVeredicto.OTRO_PROVEEDOR)).toEqual(['0010-00100004']);

    const acusado = informe.porVeredicto.OTRO_PROVEEDOR[0];
    expect(acusado.proveedorProbable?.id).toBe(escenario.proveedorErrecaldeId);
    expect(acusado.proveedorProbable?.porQue).toMatch(/CUIT/i);
  });

  it('el caso que originó todo esto: la factura de un proveedor no cargado', async () => {
    /*
     * Es el defecto exacto. El proveedor no existe en el sistema, así que el
     * informe no puede decir de quién es —sería inventar— pero tiene que
     * decir que de Los Calvos no es.
     */
    await comprobante({
      supplierId: escenario.proveedorId,
      numero: '00100005',
      textoOcr: PAPEL_DE_UN_DESCONOCIDO,
      codigo: '77',
      productId: null,
    });

    const informe = await auditarAtribucion(escenario.admin, escenario.proveedorId);
    expect(numerosDe(informe.porVeredicto.SOSPECHOSO)).toEqual(['0010-00100005']);

    const sospechoso = informe.porVeredicto.SOSPECHOSO[0];
    expect(sospechoso.proveedorProbable).toBeNull();
    const razonSocial = sospechoso.indicios.find((i) => i.fuente === 'OCR_RAZON_SOCIAL')!;
    expect(razonSocial.aFavor).toBe(false);
    expect(razonSocial.detalle).toMatch(/FIAMBRES DEL OESTE/i);
  });

  it('los códigos de artículo delatan al comprobante por su cuenta', async () => {
    /*
     * Una fuente que no depende del OCR: el código del renglón está aprendido
     * para Errecalde. Vale como indicio aunque el texto no diga nada.
     */
    await prisma.productAlias.create({
      data: {
        productId: escenario.productos['1002'],
        supplierId: escenario.proveedorErrecaldeId,
        supplierCode: 'ART-99999',
        alias: 'SALAME DE ERRECALDE',
        normalized: 'salame de errecalde',
        origin: 'MANUAL',
      },
    });

    await comprobante({
      supplierId: escenario.proveedorId,
      numero: '00100006',
      textoOcr: 'FACTURA A\nPunto de Venta 0010\nComp. Nro 00100006',
      codigo: 'ART-99999',
      productId: null,
    });

    const informe = await auditarAtribucion(escenario.admin, escenario.proveedorId);
    const auditado = [...informe.porVeredicto.SOSPECHOSO, ...informe.porVeredicto.SIN_EVIDENCIA]
      .find((c) => c.numero === '0010-00100006')!;
    const codigos = auditado.indicios.find((i) => i.fuente === 'CODIGOS_DE_ARTICULO')!;
    expect(codigos.aFavor).toBe(false);
    expect(codigos.detalle).toMatch(/Errecalde/i);
  });
});

describe('lo que la auditoría se niega a afirmar', () => {
  it('sin texto de OCR no dice ni que sí ni que no', async () => {
    /*
     * Un comprobante sin lectura guardada es indecidible, no sospechoso.
     * Meterlo entre los sospechosos convertiría "no sé" en "probablemente
     * mal", que es lo que hace desconfiar de un informe entero.
     */
    await comprobante({
      supplierId: escenario.proveedorId,
      numero: '00100007',
      textoOcr: null,
    });

    const informe = await auditarAtribucion(escenario.admin, escenario.proveedorId);
    expect(numerosDe(informe.porVeredicto.SIN_EVIDENCIA)).toEqual(['0010-00100007']);
    expect(informe.porVeredicto.SOSPECHOSO).toHaveLength(0);
    expect(informe.sinTextoDeOcr).toBe(1);

    // Y lo dice: los indicios del papel quedan explícitamente sin mirar.
    const auditado = informe.porVeredicto.SIN_EVIDENCIA[0];
    const delPapel = auditado.indicios.filter((i) => i.fuente.startsWith('OCR_'));
    expect(delPapel).toHaveLength(2);
    for (const i of delPapel) expect(i.aFavor).toBeNull();
  });

  it('informa todos los indicios, también los que no se pudieron mirar', async () => {
    await comprobante({
      supplierId: escenario.proveedorId,
      numero: '00100008',
      textoOcr: PAPEL_DE_LOS_CALVOS,
    });

    const informe = await auditarAtribucion(escenario.admin, escenario.proveedorId);
    const auditado = informe.porVeredicto.CORRECTO[0];

    // Las seis fuentes, siempre.
    expect(new Set(auditado.indicios.map((i) => i.fuente))).toEqual(
      new Set([
        'OCR_CUIT',
        'OCR_RAZON_SOCIAL',
        'CODIGOS_DE_ARTICULO',
        'ASOCIACIONES',
        'PLAZO_Y_AGENDA',
        'IMPUESTOS',
      ]),
    );
  });
});

describe('lo que pesa y lo que no', () => {
  /**
   * Un comprobante leído que quedó en revisión: sin confirmar, sin movimientos,
   * sin costo y sin agenda. Es lo que hay hoy en producción.
   */
  async function soloLeido(numero: string, textoOcr: string) {
    const doc = await createDocument(escenario.admin, escenario.sucursales.devoto);
    await prisma.ocrAttempt.create({
      data: {
        documentId: doc.id,
        attemptNumber: 1,
        stage: 'FULL',
        provider: 'tesseract-local',
        success: true,
        startedAt: new Date(),
        finishedAt: new Date(),
        recognizedText: textoOcr,
      },
    });
    await prisma.document.update({
      where: { id: doc.id },
      data: {
        supplierId: escenario.proveedorId,
        pointOfSale: '0010',
        number: numero,
        fullNumber: `0010-${numero}`,
        issueDate: new Date(),
        status: 'REQUIERE_REVISION',
      },
    });
    return doc.id;
  }

  it('una lectura en revisión no pesa en la deuda ni en los costos', async () => {
    /*
     * El caso que apareció en producción: un solo comprobante, sin número, en
     * cero, en revisión, sin nada derivado. Contarlo igual que a una factura
     * validada hace que el informe alarme —o tranquilice— sobre algo que no
     * está en ningún número.
     */
    await soloLeido('00500001', PAPEL_DE_UN_DESCONOCIDO);

    const informe = await auditarAtribucion(escenario.admin, escenario.proveedorId);
    expect(informe.total).toBe(1);
    expect(informe.conImpacto).toBe(0);

    const auditado = informe.porVeredicto.SOSPECHOSO[0];
    expect(auditado.conImpacto).toBe(false);
    expect(auditado.derivados.movimientos).toBe(0);
    expect(auditado.derivados.entradasDeCosto).toBe(0);
    expect(auditado.derivados.tieneAgenda).toBe(false);
  });

  it('una factura validada sí pesa', async () => {
    await comprobante({
      supplierId: escenario.proveedorId,
      numero: '00500002',
      textoOcr: PAPEL_DE_LOS_CALVOS,
    });

    const informe = await auditarAtribucion(escenario.admin, escenario.proveedorId);
    expect(informe.conImpacto).toBe(1);
    expect(informe.porVeredicto.CORRECTO[0].conImpacto).toBe(true);
  });

  it('cuenta por separado, dentro de cada grupo, los que pesan', async () => {
    // Dos sospechosos: uno validado y uno que quedó en revisión.
    await comprobante({
      supplierId: escenario.proveedorId,
      numero: '00500003',
      textoOcr: PAPEL_DE_UN_DESCONOCIDO,
      codigo: '77',
      productId: null,
    });
    await soloLeido('00500004', PAPEL_DE_UN_DESCONOCIDO);

    const informe = await auditarAtribucion(escenario.admin, escenario.proveedorId);
    expect(informe.porVeredicto.SOSPECHOSO).toHaveLength(2);
    // De los dos, uno solo pesa: es el número que hay que mirar.
    expect(informe.conImpactoPorVeredicto.SOSPECHOSO).toBe(1);
  });

  it('dentro del grupo, primero el que hay que resolver', async () => {
    await soloLeido('00500005', PAPEL_DE_UN_DESCONOCIDO);
    await comprobante({
      supplierId: escenario.proveedorId,
      numero: '00500006',
      textoOcr: PAPEL_DE_UN_DESCONOCIDO,
      codigo: '77',
      productId: null,
    });

    const informe = await auditarAtribucion(escenario.admin, escenario.proveedorId);
    const sospechosos = informe.porVeredicto.SOSPECHOSO;
    expect(sospechosos).toHaveLength(2);
    // El validado va primero, aunque se haya cargado después.
    expect(sospechosos[0].conImpacto).toBe(true);
    expect(sospechosos[0].numero).toBe('0010-00500006');
  });
});

describe('la auditoría es de sólo lectura', () => {
  it('correrla dos veces no cambia una sola fila', async () => {
    await comprobante({
      supplierId: escenario.proveedorId,
      numero: '00100009',
      textoOcr: PAPEL_DE_ERRECALDE,
    });

    const antes = await retrato();
    const primera = await auditarAtribucion(escenario.admin, escenario.proveedorId);
    const segunda = await auditarAtribucion(escenario.admin, escenario.proveedorId);
    const despues = await retrato();

    expect(despues).toEqual(antes);
    // Y el veredicto no depende de cuántas veces se haya corrido.
    expect(numerosDe(segunda.porVeredicto.OTRO_PROVEEDOR)).toEqual(
      numerosDe(primera.porVeredicto.OTRO_PROVEEDOR),
    );
  });

  it('muestra qué arrastraría una reasignación, antes de decidir nada', async () => {
    await comprobante({
      supplierId: escenario.proveedorId,
      numero: '00100010',
      textoOcr: PAPEL_DE_ERRECALDE,
    });

    const informe = await auditarAtribucion(escenario.admin, escenario.proveedorId);
    const acusado = informe.porVeredicto.OTRO_PROVEEDOR[0];
    expect(acusado.derivados.movimientos).toBe(1);
    expect(acusado.derivados.entradasDeCosto).toBe(1);
    expect(acusado.derivados.tieneAgenda).toBe(true);
    expect(acusado.derivados.asociacionesAprendidas).toBe(1);
  });

  it('sin permiso de gestionar proveedores no se puede auditar', async () => {
    await expect(
      auditarAtribucion(escenario.operadorDevoto, escenario.proveedorId),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

/** Cuántas filas hay de cada cosa que una corrección podría llegar a tocar. */
async function retrato() {
  const [documentos, renglones, movimientos, costos, agendas, alias, proveedores] =
    await Promise.all([
      prisma.document.count(),
      prisma.documentItem.count(),
      prisma.purchaseMovement.count(),
      prisma.costHistory.count(),
      prisma.paymentSchedule.count(),
      prisma.productAlias.count(),
      prisma.supplier.count(),
    ]);
  const porProveedor = await prisma.document.groupBy({
    by: ['supplierId'],
    _count: { _all: true },
  });
  return {
    documentos,
    renglones,
    movimientos,
    costos,
    agendas,
    alias,
    proveedores,
    porProveedor: porProveedor
      .map((p) => `${p.supplierId}:${p._count._all}`)
      .sort(),
  };
}
