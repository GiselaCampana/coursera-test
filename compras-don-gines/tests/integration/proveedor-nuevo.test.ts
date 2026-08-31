import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { ForbiddenError, ValidationError } from '@/lib/errors';
import { createDocument, confirmDocument } from '@/lib/services/documents';
import { registrarLectura } from '@/lib/services/lectura';
import { crearProveedorDesdeLectura, findSupplierByReading } from '@/lib/services/suppliers';
import { limpiarBase, sembrarEscenario, type Escenario } from './ayudas';
import { MABELHERDI_COMPLETO } from '../fixtures/mabelherdi';

/**
 * Una factura de un proveedor que todavía no está cargado.
 *
 * Es el caso normal cuando la cadena empieza a comprarle a alguien nuevo, y
 * hasta ahora era un callejón sin salida: la factura se leía, el proveedor no
 * aparecía en la lista y había que irse a Configuración → Proveedores, con lo
 * que se perdía la lectura y el trabajo de asociar los renglones.
 *
 * Se prueba con la lectura real de Mabelherdi, que el escenario base no tiene
 * cargada: el proveedor desconocido es un proveedor de verdad, con su CUIT
 * impreso, no un nombre inventado para la prueba.
 */

let escenario: Escenario;

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();
});

async function leerFacturaDeUnDesconocido() {
  const doc = await createDocument(escenario.admin, escenario.sucursales.devoto);
  const resultado = await registrarLectura(escenario.admin, doc.id, {
    intento: 1,
    estrategia: 'Lectura completa de la página',
    proveedor: 'tesseract-local',
    modelo: 'tesseract 5 · spa',
    duracionMs: 4321,
    confianza: 0.81,
    observaciones: [],
    paginas: [
      {
        numero: 1,
        textoCompleto: MABELHERDI_COMPLETO,
        textoEncabezado: null,
        textoArticulos: null,
        textoResumen: null,
        confianza: 0.81,
      },
    ],
  });
  return { documentId: doc.id, resultado };
}

describe('la factura de un proveedor que no está cargado', () => {
  it('se lee igual, y queda anotado quién la firma', async () => {
    const { documentId, resultado } = await leerFacturaDeUnDesconocido();

    // El proveedor no existe: eso no se disimula.
    expect(resultado.supplierId).toBeNull();

    const guardado = await prisma.document.findUniqueOrThrow({
      where: { id: documentId },
      include: { items: true },
    });
    /*
     * El control que importa: la lectura completa sobrevive igual. Sin
     * proveedor, los nueve renglones y el pie de la factura tienen que estar
     * guardados lo mismo, porque son lo que se va a perder si el alta obliga a
     * salir del comprobante.
     */
    expect(guardado.items).toHaveLength(9);
    expect(guardado.netTotal?.toString()).toBe('32998.85');

    // Y con qué darlo de alta: la razón social y el CUIT del papel.
    expect(guardado.readSupplierCuit).toBe('30-67804306-7');
    expect(guardado.readSupplierName ?? '').toMatch(/MABELHERDI/i);
  });

  it('se lo da de alta sin tocar la lectura ni las asociaciones', async () => {
    const { documentId } = await leerFacturaDeUnDesconocido();

    // Alguien asocia un renglón a mano antes de darse cuenta de que falta el
    // proveedor. Ese trabajo es el que no se puede perder.
    const primero = await prisma.documentItem.findFirstOrThrow({
      where: { documentId },
      orderBy: { lineNumber: 'asc' },
    });
    await prisma.documentItem.update({
      where: { id: primero.id },
      data: { productId: escenario.productos['1001'], matchMethod: 'MANUAL' },
    });

    const proveedor = await crearProveedorDesdeLectura(escenario.admin, {
      nombre: 'MABELHERDI S.A.',
      cuit: '30-67804306-7',
    });
    expect(proveedor.creado).toBe(true);

    const despues = await prisma.document.findUniqueOrThrow({
      where: { id: documentId },
      include: { items: { orderBy: { lineNumber: 'asc' } }, ocrAttempts: true },
    });
    expect(despues.items).toHaveLength(9);
    expect(despues.items[0].productId).toBe(escenario.productos['1001']);
    expect(despues.items[0].matchMethod).toBe('MANUAL');
    expect(despues.ocrAttempts).toHaveLength(1);
  });

  it('la próxima factura del mismo proveedor ya lo reconoce sola', async () => {
    await crearProveedorDesdeLectura(escenario.admin, {
      nombre: 'MABELHERDI S.A.',
      cuit: '30-67804306-7',
    });

    const { resultado } = await leerFacturaDeUnDesconocido();
    expect(resultado.supplierId).not.toBeNull();

    const proveedor = await prisma.supplier.findUniqueOrThrow({
      where: { id: resultado.supplierId! },
    });
    expect(proveedor.tradeName).toBe('MABELHERDI S.A.');
  });

  it('el comprobante se puede terminar de cargar con el proveedor recién creado', async () => {
    const { documentId } = await leerFacturaDeUnDesconocido();
    const proveedor = await crearProveedorDesdeLectura(escenario.admin, {
      nombre: 'MABELHERDI S.A.',
      cuit: '30-67804306-7',
    });

    const renglones = await prisma.documentItem.findMany({
      where: { documentId },
      orderBy: { lineNumber: 'asc' },
    });
    const confirmado = await confirmDocument(escenario.admin, {
      documentId,
      supplierId: proveedor.id,
      docType: 'FACTURA',
      letter: 'A',
      pointOfSale: '0007',
      number: '00348491',
      issueDate: '2026-08-20',
      printed: {
        netTotal: '32998.85',
        ivaTotal: '6929.76',
        perceptionsTotal: '577.48',
        total: '40506.09',
        lineCount: 9,
      },
      items: renglones.map((item) => ({
        lineNumber: item.lineNumber,
        supplierCode: item.supplierCode,
        description: item.description,
        quantity: item.quantity.toString(),
        unit: item.unit as 'KG' | 'UNIT',
        unitNetPrice: item.unitNetPrice.toString(),
        grossSubtotal: item.grossFromPrint ? item.grossSubtotal.toString() : undefined,
        discountPct: item.discountPct.toString(),
        ivaRate: item.ivaRate.toString(),
        productId: item.productId,
      })),
      payment: { dueDate: '2026-09-20', paymentMethod: 'TRANSFERENCIA', notes: null },
    });

    expect(confirmado.report.canSave).toBe(true);
    const final = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(final.supplierId).toBe(proveedor.id);
    expect(final.status).toBe('VALIDADO');
  });
});

describe('nunca dos fichas del mismo proveedor', () => {
  it('con el CUIT ya cargado devuelve el que existe, aunque el nombre venga distinto', async () => {
    const primero = await crearProveedorDesdeLectura(escenario.admin, {
      nombre: 'MABELHERDI S.A.',
      cuit: '30-67804306-7',
    });
    const segundo = await crearProveedorDesdeLectura(escenario.admin, {
      // El OCR de otra foto leyó el nombre distinto. El CUIT es el mismo.
      nombre: 'M4BELHERD1 SA',
      cuit: '30-67804306-7',
    });

    expect(segundo.creado).toBe(false);
    expect(segundo.motivo).toBe('CUIT');
    expect(segundo.id).toBe(primero.id);
    expect(await prisma.supplier.count({ where: { cuit: { not: null } } })).toBeGreaterThan(0);
    const conEseCuit = await prisma.supplier.findMany({ where: { cuit: '30-67804306-7' } });
    expect(conEseCuit).toHaveLength(1);
  });

  it('compara los once dígitos y no cómo esté escrito', async () => {
    const primero = await crearProveedorDesdeLectura(escenario.admin, {
      nombre: 'MABELHERDI S.A.',
      cuit: '30-67804306-7',
    });
    // El mismo CUIT sin guiones, que es como sale de algunas lecturas.
    const segundo = await crearProveedorDesdeLectura(escenario.admin, {
      nombre: 'Mabelherdi',
      cuit: '30678043067',
    });

    expect(segundo.id).toBe(primero.id);
    expect(segundo.creado).toBe(false);
    // Los dos proveedores del escenario más éste: la segunda alta no sumó ficha.
    expect(await prisma.supplier.count()).toBe(3);
  });

  it('al proveedor cargado sin CUIT se le completa, en vez de abrirle otra ficha', async () => {
    const sinCuit = await prisma.supplier.create({
      data: { tradeName: 'Fiambres del Oeste', cuit: null, currency: 'ARS', active: true },
    });

    const resultado = await crearProveedorDesdeLectura(escenario.admin, {
      nombre: 'Fiambres del Oeste',
      cuit: '30-11111111-2',
    });

    expect(resultado.creado).toBe(false);
    expect(resultado.motivo).toBe('NOMBRE');
    expect(resultado.id).toBe(sinCuit.id);
    const actualizado = await prisma.supplier.findUniqueOrThrow({ where: { id: sinCuit.id } });
    expect(actualizado.cuit).toBe('30-11111111-2');
  });

  it('dos contribuyentes distintos con el mismo nombre no se fusionan', async () => {
    /*
     * Pasa con las razones sociales de familia: dos sociedades que se llaman
     * casi igual y facturan por separado. Si el alta las uniera, las dos
     * cuentas corrientes quedarían mezcladas en una sola, y eso no se
     * desarma después.
     */
    const primero = await crearProveedorDesdeLectura(escenario.admin, {
      nombre: 'Lácteos Hermanos',
      cuit: '30-22222222-3',
    });
    const segundo = await crearProveedorDesdeLectura(escenario.admin, {
      nombre: 'Lácteos Hermanos',
      cuit: '30-33333333-4',
    });

    expect(segundo.creado).toBe(true);
    expect(segundo.id).not.toBe(primero.id);
  });

  it('el alias del nombre leído queda guardado para reconocerlo la próxima vez', async () => {
    const creado = await crearProveedorDesdeLectura(escenario.admin, {
      nombre: 'Fiambres del Oeste S.R.L.',
      cuit: '30-44444444-5',
    });

    // Sin CUIT en la lectura, el reconocimiento tiene que salir por el nombre.
    const encontrado = await findSupplierByReading({
      supplierName: 'Fiambres del Oeste S.R.L.',
      cuit: null,
    });
    expect(encontrado.supplierId).toBe(creado.id);
  });

  it('un CUIT que no llega a once dígitos se rechaza en vez de guardarse a medias', async () => {
    await expect(
      crearProveedorDesdeLectura(escenario.admin, { nombre: 'Algo', cuit: '30-678' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.supplier.findFirst({ where: { tradeName: 'Algo' } })).toBeNull();
  });

  it('sin permiso de gestionar proveedores no se da de alta a nadie', async () => {
    await expect(
      crearProveedorDesdeLectura(escenario.operadorDevoto, {
        nombre: 'MABELHERDI S.A.',
        cuit: '30-67804306-7',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await prisma.supplier.findFirst({ where: { cuit: '30-67804306-7' } })).toBeNull();
  });
});
