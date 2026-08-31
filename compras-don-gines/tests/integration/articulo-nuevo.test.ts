import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { ConflictError, ValidationError } from '@/lib/errors';
import { confirmDocument, createDocument, matchItemsToProducts } from '@/lib/services/documents';
import { crearProductoRapido } from '@/lib/services/admin';
import { costItems } from '@/lib/domain/costing';
import { limpiarBase, sembrarEscenario, type Escenario } from './ayudas';

/**
 * Un artículo que el catálogo todavía no tiene, apareciendo en una factura.
 *
 * El circuito completo: el renglón llega sin asociar, se da de alta el PLU sin
 * salir del comprobante, se guarda la factura recordando la asociación, y la
 * **próxima** factura del mismo proveedor con el mismo código se asocia sola.
 * Ese último paso es el que justifica todo lo demás: si no pasara, dar de alta
 * el artículo no le ahorraría trabajo a nadie más que a esta factura.
 */

let escenario: Escenario;

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();
});

/** Un renglón de factura de un artículo que no está en el catálogo. */
const RENGLON_DESCONOCIDO = {
  lineNumber: 1,
  supplierCode: 'ART-77777',
  description: 'PROVOLONE HILADO EN BARRA',
  quantity: '3.5',
  unit: 'KG' as const,
  unitNetPrice: '12000.00',
  grossSubtotal: '42000.00',
  discountPct: '0',
  ivaRate: '0.21',
};

const PIE = {
  netTotal: '42000.00',
  ivaTotal: '8820.00',
  perceptionsTotal: '0',
  total: '50820.00',
  lineCount: 1,
};

async function facturaConElRenglonDesconocido(numero: string, productId: string | null) {
  const doc = await createDocument(escenario.admin, escenario.sucursales.devoto);
  await confirmDocument(escenario.admin, {
    documentId: doc.id,
    supplierId: escenario.proveedorErrecaldeId,
    docType: 'FACTURA',
    letter: 'A',
    pointOfSale: '0003',
    number: numero,
    issueDate: '2026-08-25',
    printed: PIE,
    items: [{ ...RENGLON_DESCONOCIDO, productId, learnAlias: productId !== null }],
    payment: { dueDate: '2026-09-25', paymentMethod: 'TRANSFERENCIA', notes: null },
  });
  return doc.id;
}

describe('un artículo que el catálogo no tiene', () => {
  it('el renglón llega sin asociar, sin inventarle un PLU', async () => {
    /*
     * Lo que no puede pasar es que la aplicación se invente una numeración
     * propia: el PLU lo asigna Control de Stock. Un renglón que no se reconoce
     * queda sin asociar y se ve, que es exactamente lo que hace falta para que
     * alguien lo resuelva.
     */
    const costeados = costItems([RENGLON_DESCONOCIDO], {
      netTotal: PIE.netTotal,
      ivaTotal: PIE.ivaTotal,
      perceptionsTotal: '0',
    });
    const asociaciones = await matchItemsToProducts(costeados, escenario.proveedorErrecaldeId);

    expect(asociaciones[0].productId).toBeNull();
    expect(asociaciones[0].method).toBe('NONE');
  });

  it('se da de alta con su PLU y queda asociado, y la próxima factura lo reconoce sola', async () => {
    const creado = await crearProductoRapido(escenario.admin, {
      nombre: 'Provolone hilado en barra',
      plu: '1876',
      usaPlu: true,
      unidadCompra: 'KG',
    });
    expect(creado.internalCode).toBe('1876');
    expect(creado.usesPlu).toBe(true);

    // Se guarda la factura con el renglón asociado y recordando la asociación.
    await facturaConElRenglonDesconocido('00000101', creado.id);

    /*
     * El código del proveedor quedó colgado del PLU, no al revés: ART-77777 es
     * de Errecalde y el 1876 es de Don Ginés.
     */
    const alias = await prisma.productAlias.findFirstOrThrow({
      where: { productId: creado.id, supplierId: escenario.proveedorErrecaldeId },
    });
    expect(alias.supplierCode).toBe('ART-77777');

    // Y la prueba que importa: la próxima factura se asocia sola.
    const costeados = costItems([RENGLON_DESCONOCIDO], {
      netTotal: PIE.netTotal,
      ivaTotal: PIE.ivaTotal,
      perceptionsTotal: '0',
    });
    const asociaciones = await matchItemsToProducts(costeados, escenario.proveedorErrecaldeId);
    expect(asociaciones[0].productId).toBe(creado.id);
    expect(asociaciones[0].method).toBe('SUPPLIER_CODE');
  });

  it('reconoce el código aunque la descripción venga escrita distinta', async () => {
    /*
     * El código es lo estable; la descripción la reescribe el proveedor cada
     * tanto y el OCR la maltrata. Asociar por código es lo que hace que un
     * cambio de redacción no vuelva a dejar el renglón huérfano.
     */
    const creado = await crearProductoRapido(escenario.admin, {
      nombre: 'Provolone hilado en barra',
      plu: '1876',
      usaPlu: true,
      unidadCompra: 'KG',
    });
    await facturaConElRenglonDesconocido('00000102', creado.id);

    const costeados = costItems(
      [{ ...RENGLON_DESCONOCIDO, description: 'PROVOL. HILADO BARRA x 3,5' }],
      { netTotal: PIE.netTotal, ivaTotal: PIE.ivaTotal, perceptionsTotal: '0' },
    );
    const asociaciones = await matchItemsToProducts(costeados, escenario.proveedorErrecaldeId);
    expect(asociaciones[0].productId).toBe(creado.id);
    expect(asociaciones[0].method).toBe('SUPPLIER_CODE');
  });

  it('el alta rápida sirve también para lo que se vende por unidad y no tiene PLU', async () => {
    const creado = await crearProductoRapido(escenario.admin, {
      nombre: 'Tomate en botella 950 g',
      usaPlu: false,
      codigoBarras: '7791111111118',
      unidadCompra: 'UNIT',
    });

    expect(creado.usesPlu).toBe(false);
    expect(creado.barcode).toBe('7791111111118');
    expect(creado.purchaseUnit).toBe('UNIT');
  });

  it('no deja repetir un PLU que ya existe', async () => {
    /*
     * El atajo no puede saltearse los controles del alta completa: dos
     * artículos con el mismo PLU son dos historias de costos para un mismo
     * número, y eso no se arregla después.
     */
    await crearProductoRapido(escenario.admin, {
      nombre: 'Provolone hilado en barra',
      plu: '1876',
      usaPlu: true,
      unidadCompra: 'KG',
    });
    await expect(
      crearProductoRapido(escenario.admin, {
        nombre: 'Otra cosa con el mismo PLU',
        plu: '1876',
        usaPlu: true,
        unidadCompra: 'KG',
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await prisma.product.count({ where: { internalCode: '1876' } })).toBe(1);
  });

  it('sin PLU y sin código de barras no se crea nada', async () => {
    await expect(
      crearProductoRapido(escenario.admin, { nombre: 'Algo sin identificar', usaPlu: false }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.product.findFirst({ where: { normalizedName: 'Algo sin identificar' } })).toBeNull();
  });
});
