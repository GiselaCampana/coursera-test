import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { limpiarBase, sembrarEscenario, type Escenario } from './ayudas';
import { createDocument } from '@/lib/services/documents';
import { crearProveedorDesdeLectura } from '@/lib/services/suppliers';
import { aplicarCompra, vistaPreviaDeCompra } from '@/lib/services/vista-previa-compra';
import { normalizeText } from '@/lib/domain/matching';
import { Decimal } from '@/lib/money';
import { EZRA_ARTICULOS_IMPRESOS, EZRA_PIE } from '../fixtures/ezra';
import {
  CATALOGO_DE_EZRA,
  CODIGO_DE_LA_BOLSA,
  sembrarLaCompraDeEzra,
} from '../fixtures/compra-de-ezra';

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
 * **La factura de Ezra, con los seis renglones que tiene el papel.**
 *
 * Cinco son mercadería, en kilos. El sexto son tres bolsas que Ezra cobra para
 * transportar la compra: se pagan con el resto de la factura y **no entran al
 * stock**. No hay tres bolsas más en la heladera, no hay un artículo que
 * vender, y cargarlas como mercadería ensucia las existencias de algo que no
 * existe.
 *
 * Eso fue exactamente lo que pasó la primera vez: el renglón terminó moviendo
 * «3 KG de Bolsa grande» contra un artículo inventado. Lo que se prueba acá es
 * que ya no, y que la corrección no se apoya en leer la palabra «BOLSA».
 *
 * Los importes salen de `tests/fixtures/ezra.ts`, la transcripción del papel,
 * y el sembrado es el mismo que usan la demostración y las end to end.
 */
describe('Ezra, de punta a punta con los seis renglones del papel', () => {
  /** Los cinco PLU de mercadería. La bolsa no tiene, y no debe tener. */
  const PLU_DE_MERCADERIA = ['3101', '3102', '3103', '3104', '3105'];

  /**
   * Las existencias: lo que entró por compras, por artículo.
   *
   * Se miden así y no contando movimientos porque la pregunta es cuánta
   * mercadería hay, no cuántas filas se escribieron. Un movimiento de más con
   * cantidad cero no cambia el stock; uno de 3 kg de algo que no existe, sí.
   */
  async function existencias(): Promise<Record<string, string>> {
    const productos = await prisma.product.findMany({
      select: { id: true, internalCode: true },
    });
    const porProducto = await prisma.purchaseMovement.groupBy({
      by: ['productId'],
      _sum: { quantity: true },
    });
    const filas: Record<string, string> = {};
    for (const producto of productos) {
      const suyo = porProducto.find((m) => m.productId === producto.id);
      filas[producto.internalCode] = new Decimal(
        (suyo?._sum.quantity ?? 0).toString(),
      ).toFixed(3);
    }
    return filas;
  }

  async function sembrar() {
    return sembrarLaCompraDeEzra(prisma, {
      sucursalId: escenario.sucursales.devoto,
      autorId: escenario.admin.id,
    });
  }

  /** El mismo escenario, pero sin la configuración que clasifica la bolsa. */
  async function sembrarSinClasificarLaBolsa() {
    const sembrada = await sembrar();
    await prisma.supplierExpenseCode.deleteMany({
      where: { supplierId: sembrada.proveedorId, supplierCode: CODIGO_DE_LA_BOLSA },
    });
    return sembrada;
  }

  // -------------------------------------------------------------------------
  // La vista previa
  // -------------------------------------------------------------------------

  it('la atribuye a Ezra y muestra el egreso por el total impreso', async () => {
    const { completa } = await sembrar();
    const previa = await vistaPreviaDeCompra(escenario.admin, completa);

    expect(previa.emisor.nombre).toBe('Distribuidora Ezra');
    expect(previa.emisor.cuit.valor).toBe('30-71951960-8');
    expect(previa.egreso.total.valor).toBe('267880.50');
    expect(previa.egreso.total.procedencia).toBe('LEIDO');
  });

  it('muestra los seis renglones del papel, no cinco', async () => {
    const { completa } = await sembrar();
    const previa = await vistaPreviaDeCompra(escenario.admin, completa);

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
    const { completa } = await sembrar();
    const renglones = await prisma.documentItem.findMany({ where: { documentId: completa } });
    const suma = renglones.reduce(
      (total, r) => total.plus(r.netAmount.toString()),
      new Decimal(0),
    );

    expect(suma.toFixed(3)).toBe('221388.847');
    expect(suma.toDecimalPlaces(2, Decimal.ROUND_DOWN).toFixed(2)).toBe(EZRA_PIE.netTotal);
  });

  it('separa cinco ingresos de mercadería de la bolsa, que no mueve stock', async () => {
    const { completa } = await sembrar();
    const previa = await vistaPreviaDeCompra(escenario.admin, completa);

    // Lo que entra a la heladera: cinco, en kilos.
    expect(previa.stock.movimientos).toHaveLength(5);
    expect(previa.stock.renglonesSinMovimiento).toBe(0);
    for (const movimiento of previa.stock.movimientos) {
      expect(movimiento.unidad).toBe('kg');
    }

    // Y la bolsa, aparte, sin impacto en stock.
    expect(previa.gastos).toHaveLength(1);
    const bolsa = previa.gastos[0];
    expect(bolsa.renglon).toBe(6);
    expect(bolsa.descripcion).toBe('BOLSA GRANDE');
    expect(bolsa.cantidad).toBe('3.000');
    expect(bolsa.unidad).toBe('unidades');
    // 223,140 del papel + 21 % de IVA = 269,9994, que se muestra 270,00.
    expect(bolsa.importe).toBe('270.00');
    expect(bolsa.comoSeLlama).toBe('Bolsas del transporte');
    expect(bolsa.porQue).toContain('código');
  });

  it('el renglón de la bolsa no pide artículo y no frena la compra', async () => {
    const { completa } = await sembrar();
    const previa = await vistaPreviaDeCompra(escenario.admin, completa);

    const bolsa = previa.renglones[5];
    expect(bolsa.gasto?.clase).toBe('EMBALAJE');
    expect(bolsa.producto.id).toBeNull();
    expect(previa.frenos).toEqual([]);
    expect(previa.sePuedeAplicar).toBe(true);
  });

  // -------------------------------------------------------------------------
  // La prueba negativa: el texto no clasifica
  // -------------------------------------------------------------------------

  it('sin la configuración, «BOLSA GRANDE» vuelve a ser mercadería sin asociar y frena', async () => {
    /*
     * La garantía que sostiene todo lo demás. El renglón dice exactamente lo
     * mismo —«BOLSA GRANDE», tres, el mismo importe— y sin el código
     * configurado no se convierte ni en gasto ni en producto: queda pidiendo
     * una decisión humana, que es lo correcto.
     *
     * Si alguien alguna vez clasifica por la descripción, esta prueba falla.
     */
    const { completa } = await sembrarSinClasificarLaBolsa();
    const previa = await vistaPreviaDeCompra(escenario.admin, completa);

    expect(previa.renglones).toHaveLength(6);
    const bolsa = previa.renglones[5];
    expect(bolsa.descripcion).toBe('BOLSA GRANDE');
    expect(bolsa.gasto).toBeNull();
    expect(bolsa.producto.estado).toBe('SIN_ASOCIAR');

    expect(previa.gastos).toEqual([]);
    expect(previa.sePuedeAplicar).toBe(false);
    expect(previa.frenos.some((f) => f.includes('BOLSA GRANDE'))).toBe(true);

    // Y su importe sigue siendo plata que se le debe a Ezra.
    expect(previa.egreso.total.valor).toBe('267880.50');
  });

  it('el texto tampoco la convierte en producto, ni con un artículo que se llame igual', async () => {
    /*
     * La otra mitad de la prueba negativa. Se carga al catálogo un artículo
     * llamado exactamente «BOLSA GRANDE» —existe: hay bolsas que se compran
     * para revender— y el renglón sigue sin poder aplicarse.
     *
     * Coincidir por el nombre alcanza para proponer y no para cargarle la
     * compra: dos artículos pueden llamarse igual y ser cosas distintas, y de
     * eso se trata todo este archivo.
     */
    const { completa } = await sembrarSinClasificarLaBolsa();
    await prisma.product.create({
      data: {
        internalCode: '9999',
        normalizedName: 'BOLSA GRANDE',
        purchaseUnit: 'UNIT',
        active: true,
      },
    });

    const previa = await vistaPreviaDeCompra(escenario.admin, completa);
    const bolsa = previa.renglones[5];

    // Ni gasto ni asociación inequívoca: sigue pidiendo una decisión.
    expect(bolsa.gasto).toBeNull();
    expect(bolsa.producto.estado).not.toBe('INEQUIVOCA');
    expect(previa.sePuedeAplicar).toBe(false);

    await expect(aplicarCompra(escenario.admin, completa)).rejects.toThrow(
      /no está asociado a un producto/,
    );

    // Y no se movió un solo kilo de ese artículo.
    const movimientos = await prisma.purchaseMovement.count({ where: { documentId: completa } });
    expect(movimientos).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Aplicar: las existencias antes y después
  // -------------------------------------------------------------------------

  it('al aplicarla suben los cinco artículos en kilos y nada más', async () => {
    const { completa } = await sembrar();

    const antes = await existencias();
    const productosAntes = await prisma.product.count();

    await aplicarCompra(escenario.admin, completa);

    const despues = await existencias();

    // Los cinco de mercadería suben exactamente lo que dice el papel.
    const esperado: Record<string, string> = {};
    for (const impreso of EZRA_ARTICULOS_IMPRESOS) {
      const plu = CATALOGO_DE_EZRA[impreso.codigo]?.plu;
      if (plu) esperado[plu] = new Decimal(impreso.cantidad).toFixed(3);
    }
    for (const plu of PLU_DE_MERCADERIA) {
      expect(antes[plu], `${plu} antes`).toBe('0.000');
      expect(despues[plu], `${plu} después`).toBe(esperado[plu]);
    }

    // Ningún artículo nuevo, y ninguno que se llame como la bolsa.
    expect(await prisma.product.count()).toBe(productosAntes);
    expect(Object.keys(despues)).toEqual(Object.keys(antes));

    // Y ningún otro artículo se movió: el costo de la bolsa no se repartió.
    for (const plu of Object.keys(antes)) {
      if (PLU_DE_MERCADERIA.includes(plu)) continue;
      expect(despues[plu], `${plu} no debía moverse`).toBe(antes[plu]);
    }
  });

  it('la bolsa no deja movimiento de stock, y sigue en la factura y en el egreso', async () => {
    const { completa } = await sembrar();
    await aplicarCompra(escenario.admin, completa);

    // Cinco movimientos, ninguno de la bolsa.
    const movimientos = await prisma.purchaseMovement.findMany({
      where: { documentId: completa },
      include: { product: true },
    });
    expect(movimientos).toHaveLength(5);
    expect(movimientos.every((m) => m.productId !== null)).toBe(true);
    expect(movimientos.every((m) => m.unit === 'KG')).toBe(true);
    expect(movimientos.some((m) => m.description.includes('BOLSA'))).toBe(false);
    expect(new Set(movimientos.map((m) => m.product?.internalCode))).toEqual(
      new Set(PLU_DE_MERCADERIA),
    );

    // Pero el renglón sigue estando, con su clasificación y su unidad.
    const renglones = await prisma.documentItem.findMany({
      where: { documentId: completa },
      orderBy: { lineNumber: 'asc' },
    });
    expect(renglones).toHaveLength(6);
    const bolsa = renglones[5];
    expect(bolsa.description).toBe('BOLSA GRANDE');
    expect(bolsa.expenseKind).toBe('EMBALAJE');
    expect(bolsa.unit).toBe('UNIT');
    expect(new Decimal(bolsa.quantity.toString()).toFixed(3)).toBe('3.000');
    expect(bolsa.productId).toBeNull();

    // Y el egreso cierra en el total del papel, con la bolsa adentro.
    const pago = await prisma.paymentSchedule.findFirst({ where: { documentId: completa } });
    expect(pago?.plannedAmount.toString()).toBe('267880.5');
  });

  it('no le deja costo a ningún artículo por la bolsa', async () => {
    /*
     * El costo de las bolsas no se reparte entre los productos: eso sería una
     * decisión contable que nadie tomó. Cinco renglones asociados, cinco
     * entradas de costo.
     */
    const { completa } = await sembrar();
    await aplicarCompra(escenario.admin, completa);

    expect(await prisma.costHistory.count({ where: { documentId: completa } })).toBe(5);
  });

  it('aplicar dos veces no duplica existencias ni movimientos', async () => {
    const { completa } = await sembrar();
    await aplicarCompra(escenario.admin, completa);

    const despuesDeLaPrimera = await existencias();
    const movimientosDeLaPrimera = await prisma.purchaseMovement.count({
      where: { documentId: completa },
    });

    await expect(aplicarCompra(escenario.admin, completa)).rejects.toThrow();

    expect(await existencias()).toEqual(despuesDeLaPrimera);
    expect(await prisma.purchaseMovement.count({ where: { documentId: completa } })).toBe(
      movimientosDeLaPrimera,
    );
    expect(await prisma.paymentSchedule.count({ where: { documentId: completa } })).toBe(1);
  });

  it('el egreso y el stock se auditan por separado, colgando de la misma factura', async () => {
    const { completa } = await sembrar();
    await aplicarCompra(escenario.admin, completa);

    const pago = await prisma.paymentSchedule.findFirst({ where: { documentId: completa } });
    const movimientos = await prisma.purchaseMovement.findMany({ where: { documentId: completa } });

    expect(pago?.documentId).toBe(completa);
    expect(movimientos.every((m) => m.documentId === completa)).toBe(true);
    expect(await prisma.paymentSchedule.count({ where: { documentId: completa } })).toBe(1);
  });

  // -------------------------------------------------------------------------
  // La condición de pago
  // -------------------------------------------------------------------------

  it('Ezra sigue siendo proveedor no habitual: sin condiciones ni tasas propias', async () => {
    const { proveedorId } = await sembrar();

    expect(await prisma.supplierPaymentTerm.count({ where: { supplierId: proveedorId } })).toBe(0);
    expect(await prisma.supplierTaxRule.count({ where: { supplierId: proveedorId } })).toBe(0);
  });

  it('sin condición configurada, la vista dice que se define al aplicar', async () => {
    const { completa } = await sembrar();
    const previa = await vistaPreviaDeCompra(escenario.admin, completa);

    expect(previa.egreso.condicion.valor).toBeNull();
    expect(previa.egreso.condicion.procedencia).toBe('PENDIENTE');
    expect(previa.egreso.condicion.detalle).toContain('no tiene condición de pago configurada');
  });

  it('un plazo que el proveedor no tiene configurado no se muestra', async () => {
    /*
     * El comprobante quedó con un plazo escrito y Ezra no tiene ninguno. Ese
     * número salió de otra parte —del proveedor habitual, de un valor general—
     * y mostrarlo sería prestarle a un proveedor nuevo las condiciones de otro.
     */
    const { completa } = await sembrar();
    await prisma.document.update({
      where: { id: completa },
      data: { appliedTermType: 'DAYS', appliedTermDays: 30 },
    });

    const previa = await vistaPreviaDeCompra(escenario.admin, completa);

    expect(previa.egreso.condicion.valor).toBeNull();
    expect(previa.egreso.condicion.procedencia).toBe('PENDIENTE');
    expect(previa.egreso.condicion.detalle).toContain('sería la condición de otro proveedor');
  });

  it('la condición cargada en la ficha del proveedor sí se muestra, con su origen', async () => {
    const { completa, proveedorId } = await sembrar();
    await prisma.supplierPaymentTerm.create({
      data: {
        supplierId: proveedorId,
        termType: 'DAYS',
        days: 15,
        paymentMethod: 'TRANSFERENCIA',
        validFrom: new Date('2020-01-01T00:00:00Z'),
      },
    });

    const previa = await vistaPreviaDeCompra(escenario.admin, completa);

    expect(previa.egreso.condicion.valor).toBe('A 15 días');
    expect(previa.egreso.condicion.procedencia).toBe('INFERIDO');
    expect(previa.egreso.condicion.detalle).toContain('ficha de este proveedor');
  });
});
