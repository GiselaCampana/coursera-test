import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { limpiarBase, sembrarEscenario, type Escenario } from './ayudas';
import { createDocument } from '@/lib/services/documents';
import { crearProveedorDesdeLectura } from '@/lib/services/suppliers';
import { aplicarCompra, vistaPreviaDeCompra } from '@/lib/services/vista-previa-compra';
import { normalizeText } from '@/lib/domain/matching';
import { Decimal } from '@/lib/money';
import { EZRA_ARTICULOS_IMPRESOS, EZRA_ENCABEZADO, EZRA_PIE } from '../fixtures/ezra';

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

/**
 * La factura de Ezra, con los **seis** renglones que tiene el papel.
 *
 * Los importes, las cantidades y el pie salen de `tests/fixtures/ezra.ts`, que
 * es la transcripción columna por columna del comprobante. No se vuelven a
 * escribir acá: una prueba que copia los números a mano deja de ser una
 * regresión del papel y pasa a ser una regresión de lo que yo tecleé.
 *
 * El sexto renglón es el que hace falta que esté. BOLSA GRANDE se factura por
 * unidad y el comprobante no lo dice en ninguna parte —la columna «Cantidad»
 * imprime 3,000 igual que imprime los 4,240 kilos de cremoso—, así que la
 * unidad sólo puede salir del catálogo. Y si el renglón no se puede asociar,
 * no desaparece: se ve, frena la aplicación, y su importe sigue estando en lo
 * que se le debe a Ezra.
 */
describe('Ezra, de punta a punta con los seis renglones del papel', () => {
  /** El artículo del catálogo al que corresponde cada código de Ezra. */
  const CATALOGO: Record<string, { plu: string; nombre: string; unidad: 'KG' | 'UNIT' }> = {
    '47': { plu: '3101', nombre: 'Queso cremoso La Paulina', unidad: 'KG' },
    '49': { plu: '3102', nombre: 'Pernil pata celeste mini 1284', unidad: 'KG' },
    '48': { plu: '3103', nombre: 'Queso de maquina dambo La Paulina', unidad: 'KG' },
    '10': { plu: '3104', nombre: 'Jamon cocido mini tradicional Los Calvos', unidad: 'KG' },
    '2514': { plu: '3105', nombre: 'Jamon cocido mini Il Molise', unidad: 'KG' },
    '4249': { plu: '3106', nombre: 'Bolsa grande', unidad: 'UNIT' },
  };
  const BOLSA = '4249';

  /**
   * @param bolsaEnElCatalogo si la bolsa ya tiene artículo y código aprendido.
   *   Con `false` el renglón existe igual, pero sin nada a qué asociarlo.
   */
  async function facturaDeEzra({ bolsaEnElCatalogo = true } = {}) {
    const ezra = await crearProveedorDesdeLectura(escenario.admin, {
      nombre: EZRA_ENCABEZADO.supplierName,
      razonSocial: EZRA_ENCABEZADO.legalName,
      cuit: EZRA_ENCABEZADO.cuit,
    });

    const productos: Record<string, string> = {};
    for (const impreso of EZRA_ARTICULOS_IMPRESOS) {
      const ficha = CATALOGO[impreso.codigo];
      const esLaBolsa = impreso.codigo === BOLSA;
      if (esLaBolsa && !bolsaEnElCatalogo) continue;

      const producto = await prisma.product.create({
        data: {
          internalCode: ficha.plu,
          normalizedName: ficha.nombre,
          purchaseUnit: ficha.unidad,
          active: true,
          aliases: {
            create: {
              supplierId: ezra.id,
              supplierCode: impreso.codigo,
              alias: impreso.descripcion,
              normalized: normalizeText(impreso.descripcion),
              origin: 'MANUAL',
            },
          },
        },
      });
      productos[impreso.codigo] = producto.id;
    }

    const documento = await createDocument(escenario.admin, escenario.sucursales.devoto);
    await prisma.document.update({
      where: { id: documento.id },
      data: {
        supplierId: ezra.id,
        letter: EZRA_ENCABEZADO.letter,
        pointOfSale: EZRA_ENCABEZADO.pointOfSale,
        number: EZRA_ENCABEZADO.number,
        fullNumber: EZRA_ENCABEZADO.fullNumber,
        issueDate: new Date(`${EZRA_ENCABEZADO.issueDate}T12:00:00Z`),
        netTotal: EZRA_PIE.netTotal,
        ivaTotal: EZRA_PIE.iva21,
        perceptionsTotal: '0',
        total: EZRA_PIE.total,
      },
    });

    for (const [indice, impreso] of EZRA_ARTICULOS_IMPRESOS.entries()) {
      const neto = impreso.subtotal;
      await prisma.documentItem.create({
        data: {
          documentId: documento.id,
          lineNumber: indice + 1,
          supplierCode: impreso.codigo,
          description: impreso.descripcion,
          quantity: impreso.cantidad,
          /*
           * Todo entra en kilos porque es lo que produce la lectura: el papel
           * no distingue la bolsa del queso. La unidad de verdad la pone el
           * catálogo cuando el renglón se asocia, y eso es lo que se prueba.
           */
          unit: 'KG',
          unitNetPrice: impreso.precioConDescuento,
          grossSubtotal: neto,
          netAmount: neto,
          ivaRate: '0.21',
          ivaAmount: (Number(neto) * 0.21).toFixed(4),
          perceptionAmount: '0',
          totalCost: (Number(neto) * 1.21).toFixed(4),
          unitCost: ((Number(neto) * 1.21) / Number(impreso.cantidad)).toFixed(4),
          productId: null,
          matchMethod: 'NONE',
        },
      });
    }

    return { documentId: documento.id, ezraId: ezra.id, productos };
  }

  it('la atribuye a Ezra y muestra el egreso por el total impreso', async () => {
    const { documentId } = await facturaDeEzra();
    const previa = await vistaPreviaDeCompra(escenario.admin, documentId);

    expect(previa.emisor.nombre).toBe('Distribuidora Ezra');
    expect(previa.emisor.cuit.valor).toBe('30-71951960-8');
    expect(previa.egreso.total.valor).toBe('267880.50');
    expect(previa.egreso.total.procedencia).toBe('LEIDO');
    expect(previa.sePuedeAplicar).toBe(true);
  });

  it('muestra los seis renglones del papel, no cinco', async () => {
    const { documentId } = await facturaDeEzra();
    const previa = await vistaPreviaDeCompra(escenario.admin, documentId);

    expect(previa.renglones).toHaveLength(6);
    expect(previa.renglones.map((r) => r.codigoDelProveedor)).toEqual(
      EZRA_ARTICULOS_IMPRESOS.map((a) => a.codigo),
    );
  });

  it('la suma de los renglones es la del papel, hasta el truncamiento del pie', async () => {
    /*
     * 221.388,847 en los renglones y 221.388,84 impreso: el pie trunca, no
     * redondea. Si alguien cambia un importe del fixture, esto lo dice.
     */
    const { documentId } = await facturaDeEzra();
    const renglones = await prisma.documentItem.findMany({ where: { documentId } });
    const suma = renglones.reduce(
      (total, r) => total.plus(r.netAmount.toString()),
      new Decimal(0),
    );

    expect(suma.toFixed(3)).toBe('221388.847');
    expect(suma.toDecimalPlaces(2, Decimal.ROUND_DOWN).toFixed(2)).toBe(EZRA_PIE.netTotal);
  });

  it('el sexto renglón mueve tres unidades, no tres kilos', async () => {
    const { documentId } = await facturaDeEzra();
    const previa = await vistaPreviaDeCompra(escenario.admin, documentId);

    expect(previa.stock.movimientos).toHaveLength(6);
    expect(previa.stock.renglonesSinMovimiento).toBe(0);

    const bolsa = previa.stock.movimientos.find((m) => m.renglon === 6)!;
    expect(bolsa.producto).toBe('Bolsa grande');
    expect(bolsa.cantidad).toBe('3.000');
    expect(bolsa.unidad).toBe('unidades');
    // Y dice por qué no es la unidad del renglón, en vez de cambiarla callado.
    expect(bolsa.porQueEsaUnidad).toContain('catálogo');

    // Los otros cinco siguen en kilos, y sin nota: ahí no hay diferencia.
    for (const movimiento of previa.stock.movimientos.filter((m) => m.renglon !== 6)) {
      expect(movimiento.unidad).toBe('kg');
      expect(movimiento.porQueEsaUnidad).toBeNull();
    }
  });

  it('sin artículo al cual asociarla, la bolsa se ve, frena y sigue en el egreso', async () => {
    const { documentId } = await facturaDeEzra({ bolsaEnElCatalogo: false });
    const previa = await vistaPreviaDeCompra(escenario.admin, documentId);

    // Está: el renglón no desaparece por no saber a qué artículo va.
    expect(previa.renglones).toHaveLength(6);
    const bolsa = previa.renglones[5];
    expect(bolsa.descripcion).toBe('BOLSA GRANDE');
    expect(bolsa.producto.estado).toBe('SIN_ASOCIAR');

    // Frena, y el freno lo nombra.
    expect(previa.sePuedeAplicar).toBe(false);
    expect(previa.frenos.some((f) => f.includes('BOLSA GRANDE'))).toBe(true);

    // Y su importe sigue siendo plata que se le debe a Ezra.
    expect(previa.egreso.total.valor).toBe('267880.50');
    expect(previa.stock.movimientos).toHaveLength(5);
    expect(previa.stock.renglonesSinMovimiento).toBe(1);
  });

  it('al aplicarla quedan el egreso y los seis movimientos, sin productos nuevos', async () => {
    const { documentId, ezraId } = await facturaDeEzra();
    const productosAntes = await prisma.product.count();

    await aplicarCompra(escenario.admin, documentId);

    const documento = await prisma.document.findUnique({ where: { id: documentId } });
    expect(documento?.status).toBe('VALIDADO');
    expect(documento?.supplierId).toBe(ezraId);

    const pago = await prisma.paymentSchedule.findFirst({ where: { documentId } });
    expect(pago?.plannedAmount.toString()).toBe('267880.5');

    const movimientos = await prisma.purchaseMovement.findMany({
      where: { documentId },
      include: { product: true },
    });
    expect(movimientos).toHaveLength(6);
    expect(movimientos.every((m) => m.productId !== null)).toBe(true);
    expect(new Set(movimientos.map((m) => m.product?.internalCode))).toEqual(
      new Set(['3101', '3102', '3103', '3104', '3105', '3106']),
    );

    expect(await prisma.product.count()).toBe(productosAntes);
  });

  it('el egreso y el stock se auditan por separado, colgando de la misma factura', async () => {
    const { documentId } = await facturaDeEzra();
    await aplicarCompra(escenario.admin, documentId);

    const pago = await prisma.paymentSchedule.findFirst({ where: { documentId } });
    const movimientos = await prisma.purchaseMovement.findMany({ where: { documentId } });

    expect(pago?.documentId).toBe(documentId);
    expect(movimientos.every((m) => m.documentId === documentId)).toBe(true);
    expect(movimientos).toHaveLength(6);
    expect(await prisma.paymentSchedule.count({ where: { documentId } })).toBe(1);
  });

  // -------------------------------------------------------------------------
  // La condición de pago
  // -------------------------------------------------------------------------

  it('Ezra sigue siendo proveedor no habitual: sin condiciones ni tasas propias', async () => {
    const { ezraId } = await facturaDeEzra();

    expect(await prisma.supplierPaymentTerm.count({ where: { supplierId: ezraId } })).toBe(0);
    expect(await prisma.supplierTaxRule.count({ where: { supplierId: ezraId } })).toBe(0);
  });

  it('sin condición configurada, la vista dice que se define al aplicar', async () => {
    const { documentId } = await facturaDeEzra();
    const previa = await vistaPreviaDeCompra(escenario.admin, documentId);

    expect(previa.egreso.condicion.valor).toBeNull();
    expect(previa.egreso.condicion.procedencia).toBe('PENDIENTE');
    expect(previa.egreso.condicion.detalle).toContain('no tiene condición de pago configurada');
  });

  it('un plazo que el proveedor no tiene configurado no se muestra', async () => {
    /*
     * El caso que importa: el comprobante quedó con un plazo escrito y Ezra no
     * tiene ninguno. Ese número salió de otra parte —del proveedor habitual,
     * de un valor general— y mostrarlo sería prestarle a un proveedor nuevo las
     * condiciones de otro. Decide cuándo sale la plata: se dice que falta.
     */
    const { documentId } = await facturaDeEzra();
    await prisma.document.update({
      where: { id: documentId },
      data: { appliedTermType: 'DAYS', appliedTermDays: 30 },
    });

    const previa = await vistaPreviaDeCompra(escenario.admin, documentId);

    expect(previa.egreso.condicion.valor).toBeNull();
    expect(previa.egreso.condicion.procedencia).toBe('PENDIENTE');
    expect(previa.egreso.condicion.detalle).toContain('sería la condición de otro proveedor');
  });

  it('la condición cargada en la ficha del proveedor sí se muestra, con su origen', async () => {
    const { documentId, ezraId } = await facturaDeEzra();
    await prisma.supplierPaymentTerm.create({
      data: {
        supplierId: ezraId,
        termType: 'DAYS',
        days: 15,
        paymentMethod: 'TRANSFERENCIA',
        validFrom: new Date('2020-01-01T00:00:00Z'),
      },
    });

    const previa = await vistaPreviaDeCompra(escenario.admin, documentId);

    expect(previa.egreso.condicion.valor).toBe('A 15 días');
    expect(previa.egreso.condicion.procedencia).toBe('INFERIDO');
    expect(previa.egreso.condicion.detalle).toContain('ficha de este proveedor');
  });
});
