import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { limpiarBase, sembrarEscenario, type Escenario } from './ayudas';
import { createDocument } from '@/lib/services/documents';
import { crearProveedorDesdeLectura } from '@/lib/services/suppliers';
import { aplicarCompra, vistaPreviaDeCompra } from '@/lib/services/vista-previa-compra';

/**
 * **Ver la compra entera antes de que se escriba, y no poder aplicarla a medias.**
 *
 * Confirmar una factura escribe en tres lugares al mismo tiempo: el
 * comprobante, el egreso que se va a pagar y la mercadería que entra. Lo que
 * faltaba era poder mirarlo antes, con cada valor diciendo de dónde salió, y
 * que la puerta de aplicar estuviera cerrada mientras algo no esté resuelto.
 *
 * Las dos cosas que se prueban acá son una sola en el fondo: **la vista previa
 * no escribe** y **la confirmación mira exactamente lo mismo que la vista
 * previa mostró**. Si fueran dos listas distintas, la pantalla podría decir que
 * se puede y el backend negarse, que es la peor manera de enterarse.
 *
 * Los productos se asocian por el código del proveedor o porque alguien los
 * eligió. Nunca por parecido del nombre: dos artículos del catálogo pueden
 * llamarse casi igual y costar la mitad uno del otro.
 */

let escenario: Escenario;
let productoId: string;

const FECHA = new Date('2026-09-10T12:00:00Z');

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();

  const producto = await prisma.product.create({
    data: {
      internalCode: '9001',
      normalizedName: 'Queso cremoso La Paulina',
      purchaseUnit: 'KG',
      active: true,
    },
  });
  productoId = producto.id;
});

/**
 * Un comprobante leído y sin confirmar, que es el estado en el que se mira la
 * vista previa. Se escribe directo para poder fijar cada caso sin arrastrar la
 * lectura entera.
 */
async function comprobanteLeido(opciones: {
  proveedorId?: string | null;
  totalImpreso?: string | null;
  renglones?: {
    descripcion: string;
    codigo?: string | null;
    productId?: string | null;
    matchMethod?: string;
  }[];
}) {
  const documento = await createDocument(escenario.admin, escenario.sucursales.devoto);
  const renglones = opciones.renglones ?? [
    { descripcion: 'QUESO CREMOSO LA PAULINA', codigo: '47', productId: productoId, matchMethod: 'MANUAL' },
  ];

  await prisma.document.update({
    where: { id: documento.id },
    data: {
      supplierId: opciones.proveedorId === undefined ? escenario.proveedorId : opciones.proveedorId,
      pointOfSale: '0002',
      number: '00000185',
      fullNumber: 'A 0002-00000185',
      issueDate: FECHA,
      netTotal: '10000',
      ivaTotal: '2100',
      perceptionsTotal: '0',
      total: opciones.totalImpreso === undefined ? '12100' : opciones.totalImpreso,
    },
  });

  for (const [indice, renglon] of renglones.entries()) {
    await prisma.documentItem.create({
      data: {
        documentId: documento.id,
        lineNumber: indice + 1,
        supplierCode: renglon.codigo ?? null,
        description: renglon.descripcion,
        quantity: '10',
        unit: 'KG',
        unitNetPrice: '1000',
        grossSubtotal: '10000',
        netAmount: '10000',
        ivaRate: '0.21',
        ivaAmount: '2100',
        perceptionAmount: '0',
        totalCost: '12100',
        unitCost: '1210',
        productId: renglon.productId ?? null,
        matchMethod: renglon.matchMethod ?? 'NONE',
      },
    });
  }

  return documento.id;
}

// ---------------------------------------------------------------------------

describe('la vista previa no escribe nada', () => {
  it('mirarla no cambia el comprobante, ni los renglones, ni crea movimientos', async () => {
    const documentId = await comprobanteLeido({});

    const antes = {
      documento: await prisma.document.findUnique({ where: { id: documentId } }),
      renglones: await prisma.documentItem.findMany({ where: { documentId } }),
      movimientos: await prisma.purchaseMovement.count(),
      pagos: await prisma.paymentSchedule.count(),
      auditoria: await prisma.auditLog.count(),
    };

    await vistaPreviaDeCompra(escenario.admin, documentId);
    await vistaPreviaDeCompra(escenario.admin, documentId);

    expect(await prisma.document.findUnique({ where: { id: documentId } })).toEqual(antes.documento);
    expect(await prisma.documentItem.findMany({ where: { documentId } })).toEqual(antes.renglones);
    expect(await prisma.purchaseMovement.count()).toBe(antes.movimientos);
    expect(await prisma.paymentSchedule.count()).toBe(antes.pagos);
    expect(await prisma.auditLog.count()).toBe(antes.auditoria);
  });

  it('muestra el egreso y el stock por separado', async () => {
    const previa = await vistaPreviaDeCompra(escenario.admin, await comprobanteLeido({}));

    expect(previa.egreso.total.valor).toBe('12100.00');
    expect(previa.stock.movimientos).toHaveLength(1);
    expect(previa.stock.movimientos[0].producto).toBe('Queso cremoso La Paulina');
    expect(previa.stock.movimientos[0].unidad).toBe('kg');
  });
});

describe('cada valor dice de dónde salió', () => {
  it('un total impreso es leído; uno que sale de la suma es una sugerencia', async () => {
    const conPapel = await vistaPreviaDeCompra(escenario.admin, await comprobanteLeido({}));
    expect(conPapel.egreso.total.procedencia).toBe('LEIDO');

    const sinPapel = await vistaPreviaDeCompra(
      escenario.admin,
      await comprobanteLeido({ totalImpreso: null }),
    );
    expect(sinPapel.egreso.total.procedencia).toBe('SUGERIDO');
    // El número que ofrece es la suma de los renglones, y lo dice.
    expect(sinPapel.egreso.total.valor).toBe('12100.00');
    expect(sinPapel.egreso.total.detalle).toContain('No está impreso');
  });
});

describe('el proveedor', () => {
  it('un proveedor no habitual se registra y la compra queda a su nombre', async () => {
    const alta = await crearProveedorDesdeLectura(escenario.admin, {
      nombre: 'Distribuidora Ezra',
      razonSocial: 'Cooperativa de Trabajo Ezra Alimentos',
      cuit: '30-71951960-8',
    });

    const previa = await vistaPreviaDeCompra(
      escenario.admin,
      await comprobanteLeido({ proveedorId: alta.id }),
    );
    expect(previa.emisor.nombre).toBe('Distribuidora Ezra');
    expect(previa.emisor.cuit.valor).toBe('30-71951960-8');
    expect(previa.emisor.habitual).toBe(true);
  });

  it('sin proveedor elegido, la compra no se puede aplicar', async () => {
    const documentId = await comprobanteLeido({ proveedorId: null });
    const previa = await vistaPreviaDeCompra(escenario.admin, documentId);

    expect(previa.sePuedeAplicar).toBe(false);
    expect(previa.frenos.join(' ')).toContain('proveedor');
  });
});

describe('los productos se asocian por código, nunca por nombre', () => {
  it('un producto que ya existe se usa tal cual, sin duplicarlo', async () => {
    const cuantos = await prisma.product.count();
    const previa = await vistaPreviaDeCompra(escenario.admin, await comprobanteLeido({}));

    expect(previa.renglones[0].producto.id).toBe(productoId);
    expect(previa.renglones[0].producto.estado).toBe('INEQUIVOCA');
    expect(await prisma.product.count()).toBe(cuantos);
  });

  it('un renglón que sólo se parece por el nombre queda bloqueado', async () => {
    /*
     * El catálogo tiene «Queso cremoso La Paulina» y el papel dice casi lo
     * mismo. Sin el código del proveedor ni una elección humana, eso no alcanza:
     * cargarle la compra al producto equivocado ensucia el costo, el precio de
     * venta y el stock a la vez.
     */
    const documentId = await comprobanteLeido({
      renglones: [{ descripcion: 'QUESO CREMOSO LA PAULINA', codigo: null, productId: null }],
    });
    const previa = await vistaPreviaDeCompra(escenario.admin, documentId);

    expect(previa.renglones[0].producto.estado).not.toBe('INEQUIVOCA');
    expect(previa.stock.movimientos).toHaveLength(0);
    expect(previa.sePuedeAplicar).toBe(false);
    expect(previa.frenos.join(' ')).toContain('inequívoca');

    await expect(aplicarCompra(escenario.admin, documentId)).rejects.toThrow(/no se puede aplicar/i);
  });
});

describe('aplicar la compra', () => {
  it('no aplica mientras el total sea sólo una sugerencia del motor', async () => {
    const documentId = await comprobanteLeido({ totalImpreso: null });

    await expect(aplicarCompra(escenario.admin, documentId)).rejects.toThrow(/no está impreso/i);
    expect(await prisma.purchaseMovement.count()).toBe(0);
    expect(await prisma.paymentSchedule.count()).toBe(0);
  });

  it('con todo resuelto escribe el egreso y el stock, vinculados a la factura', async () => {
    const documentId = await comprobanteLeido({});
    const previa = await vistaPreviaDeCompra(escenario.admin, documentId);
    expect(previa.sePuedeAplicar).toBe(true);

    await aplicarCompra(escenario.admin, documentId);

    const pago = await prisma.paymentSchedule.findFirst({ where: { documentId } });
    expect(pago).not.toBeNull();
    expect(pago?.plannedAmount.toString()).toBe('12100');

    const movimientos = await prisma.purchaseMovement.findMany({ where: { documentId } });
    expect(movimientos).toHaveLength(1);
    expect(movimientos[0].productId).toBe(productoId);
    // Los dos cuelgan de la misma factura y se pueden auditar por separado.
    expect(movimientos[0].documentId).toBe(documentId);
    expect(pago?.documentId).toBe(documentId);
  });

  it('aplicarla dos veces no duplica nada', async () => {
    const documentId = await comprobanteLeido({});
    await aplicarCompra(escenario.admin, documentId);

    await expect(aplicarCompra(escenario.admin, documentId)).rejects.toThrow();

    expect(await prisma.purchaseMovement.count({ where: { documentId } })).toBe(1);
    expect(await prisma.paymentSchedule.count({ where: { documentId } })).toBe(1);
    const documento = await prisma.document.findUnique({ where: { id: documentId } });
    expect(documento?.status).toBe('VALIDADO');
  });

  it('si la compra no se puede aplicar, no queda nada escrito a medias', async () => {
    const documentId = await comprobanteLeido({
      renglones: [
        { descripcion: 'QUESO CREMOSO LA PAULINA', codigo: '47', productId: productoId, matchMethod: 'MANUAL' },
        { descripcion: 'ALGO QUE NADIE ASOCIÓ', codigo: null, productId: null },
      ],
    });

    await expect(aplicarCompra(escenario.admin, documentId)).rejects.toThrow();

    expect(await prisma.purchaseMovement.count()).toBe(0);
    expect(await prisma.paymentSchedule.count()).toBe(0);
    const documento = await prisma.document.findUnique({ where: { id: documentId } });
    expect(documento?.status).not.toBe('VALIDADO');
  });
});

// ---------------------------------------------------------------------------
// El caso de aceptación
// ---------------------------------------------------------------------------

describe('Ezra, de punta a punta por la vista previa', () => {
  /**
   * La factura de Ezra con sus cinco renglones, cada uno asociado al PLU que ya
   * existía en el catálogo. Es el caso que la usuaria pidió como aceptación: la
   * compra tiene que quedar a nombre de Ezra, generar el egreso por el total
   * impreso, mover los productos habituales respetando su unidad y no crear
   * ninguno nuevo.
   */
  const RENGLONES = [
    { codigo: '47', descripcion: 'QUESO CREMOSO LA PAULINA', plu: '3101', kilos: '13.674', total: '85235.09' },
    { codigo: '49', descripcion: 'PERNIL PATA CELESTE MINI 1284', plu: '3102', kilos: '11.428', total: '42876.82' },
    { codigo: '48', descripcion: 'QUESO DE MAQUINA DAMBO LA PAULINA', plu: '3103', kilos: '7.116', total: '60027.53' },
    { codigo: '10', descripcion: 'JAMON COCIDO MINI TRADICIONAL LOS CALVOS', plu: '3104', kilos: '4.512', total: '53194.06' },
    { codigo: '2514', descripcion: 'JAMON COCIDO MINI IL MOLISE', plu: '3105', kilos: '3.180', total: '26547.00' },
  ];

  async function facturaDeEzra() {
    const ezra = await crearProveedorDesdeLectura(escenario.admin, {
      nombre: 'Distribuidora Ezra',
      razonSocial: 'Cooperativa de Trabajo Ezra Alimentos',
      cuit: '30-71951960-8',
    });

    const productos: Record<string, string> = {};
    for (const renglon of RENGLONES) {
      const producto = await prisma.product.create({
        data: {
          internalCode: renglon.plu,
          normalizedName: renglon.descripcion,
          purchaseUnit: 'KG',
          active: true,
        },
      });
      productos[renglon.plu] = producto.id;
    }

    const documento = await createDocument(escenario.admin, escenario.sucursales.devoto);
    await prisma.document.update({
      where: { id: documento.id },
      data: {
        supplierId: ezra.id,
        letter: 'A',
        pointOfSale: '0002',
        number: '00000185',
        fullNumber: 'A 0002-00000185',
        issueDate: FECHA,
        netTotal: '221388.84',
        ivaTotal: '46491.66',
        perceptionsTotal: '0',
        total: '267880.50',
      },
    });

    for (const [indice, renglon] of RENGLONES.entries()) {
      const neto = (Number(renglon.total) / 1.21).toFixed(4);
      await prisma.documentItem.create({
        data: {
          documentId: documento.id,
          lineNumber: indice + 1,
          supplierCode: renglon.codigo,
          description: renglon.descripcion,
          quantity: renglon.kilos,
          unit: 'KG',
          unitNetPrice: (Number(neto) / Number(renglon.kilos)).toFixed(4),
          grossSubtotal: neto,
          netAmount: neto,
          ivaRate: '0.21',
          ivaAmount: (Number(renglon.total) - Number(neto)).toFixed(4),
          perceptionAmount: '0',
          totalCost: renglon.total,
          unitCost: (Number(renglon.total) / Number(renglon.kilos)).toFixed(4),
          // El operador eligió el PLU en la pantalla de revisión.
          productId: productos[renglon.plu],
          matchMethod: 'MANUAL',
        },
      });
    }

    return { documentId: documento.id, ezraId: ezra.id, productos };
  }

  it('la vista previa la atribuye a Ezra y muestra el egreso por 267.880,50', async () => {
    const { documentId } = await facturaDeEzra();
    const previa = await vistaPreviaDeCompra(escenario.admin, documentId);

    expect(previa.emisor.nombre).toBe('Distribuidora Ezra');
    expect(previa.emisor.cuit.valor).toBe('30-71951960-8');
    expect(previa.egreso.total.valor).toBe('267880.50');
    expect(previa.egreso.total.procedencia).toBe('LEIDO');
    expect(previa.sePuedeAplicar).toBe(true);
  });

  it('los cinco renglones mueven su producto habitual, en kilos', async () => {
    const { documentId } = await facturaDeEzra();
    const previa = await vistaPreviaDeCompra(escenario.admin, documentId);

    expect(previa.stock.movimientos).toHaveLength(5);
    expect(previa.stock.renglonesSinMovimiento).toBe(0);
    for (const movimiento of previa.stock.movimientos) {
      expect(movimiento.unidad).toBe('kg');
    }
  });

  it('al aplicarla quedan el egreso y los cinco movimientos, sin productos nuevos', async () => {
    const { documentId, ezraId } = await facturaDeEzra();
    const productosAntes = await prisma.product.count();

    await aplicarCompra(escenario.admin, documentId);

    const documento = await prisma.document.findUnique({ where: { id: documentId } });
    expect(documento?.status).toBe('VALIDADO');
    expect(documento?.supplierId).toBe(ezraId);

    // El movimiento económico: uno solo, por el total impreso.
    const pago = await prisma.paymentSchedule.findFirst({ where: { documentId } });
    expect(pago?.plannedAmount.toString()).toBe('267880.5');

    // Y los de mercadería: uno por renglón, cada uno con su producto y su PLU.
    const movimientos = await prisma.purchaseMovement.findMany({
      where: { documentId },
      include: { product: true },
    });
    expect(movimientos).toHaveLength(5);
    expect(movimientos.every((m) => m.productId !== null)).toBe(true);
    expect(movimientos.every((m) => m.unit === 'KG')).toBe(true);
    expect(new Set(movimientos.map((m) => m.product?.internalCode))).toEqual(
      new Set(['3101', '3102', '3103', '3104', '3105']),
    );

    // No se creó ningún producto: los cinco ya existían.
    expect(await prisma.product.count()).toBe(productosAntes);
  });

  it('el egreso y el stock se auditan por separado, colgando de la misma factura', async () => {
    const { documentId } = await facturaDeEzra();
    await aplicarCompra(escenario.admin, documentId);

    const pago = await prisma.paymentSchedule.findFirst({ where: { documentId } });
    const movimientos = await prisma.purchaseMovement.findMany({ where: { documentId } });

    expect(pago?.documentId).toBe(documentId);
    expect(movimientos.every((m) => m.documentId === documentId)).toBe(true);
    // Son dos tablas distintas: se puede mirar la plata sin mirar la mercadería.
    expect(movimientos).toHaveLength(5);
    expect(await prisma.paymentSchedule.count({ where: { documentId } })).toBe(1);
  });
});
