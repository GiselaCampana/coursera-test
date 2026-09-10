import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { limpiarBase, sembrarEscenario, type Escenario } from './ayudas';
import { confirmDocument, createDocument, matchItemsToProducts } from '@/lib/services/documents';
import { crearProveedorDesdeLectura } from '@/lib/services/suppliers';
import { confirmPayment } from '@/lib/services/payments';
import { approveSalePrice } from '@/lib/services/pricing';
import { normalizeText } from '@/lib/domain/matching';
import { costItems } from '@/lib/domain/costing';
import { Decimal } from '@/lib/money';

/**
 * La compra excepcional a Distribuidora Ezra.
 *
 * Ezra no es proveedor habitual: se le compró una vez, porque se había acabado
 * el stock y la fábrica de siempre ya estaba cerrada. Eso hace que esta factura
 * ejercite algo que ninguna otra ejercita: **mercadería conocida que llega por
 * un proveedor nuevo**. Los artículos son los mismos PLU de siempre, con sus
 * precios de venta ya aprobados y su proveedor habitual cargado, y lo que entra
 * es una compra más cara, de otro emisor.
 *
 * Todo lo que se prueba acá gira alrededor de una idea: **la compra se registra
 * entera y no cambia nada de lo que ya estaba decidido**. Ni el proveedor
 * habitual del artículo, ni su precio de venta, ni sus costos anteriores.
 */

let escenario: Escenario;
let ezraId: string;
/** Los PLU de siempre, con Los Calvos como proveedor habitual. */
let plu: { cremoso: string; pernil: string; dambo: string; jamonLC: string; jamonIM: string };

const FECHA = '2026-09-09';

/**
 * Los cinco renglones de mercadería de la factura de Ezra.
 *
 * BOLSA GRANDE no está: no es un artículo del catálogo comercial y queda
 * pendiente de decisión manual. Ver la prueba del final.
 */
const RENGLONES = [
  { supplierCode: '47', description: 'Cremoso LA PAULINA', quantity: '4.240', unitNetPrice: '6387.115', grossSubtotal: '27081.371' },
  { supplierCode: '49', description: 'PERNIL PATA CELESTE MINI 1284 GALAICO', quantity: '3.985', unitNetPrice: '3838.180', grossSubtotal: '15295.149' },
  { supplierCode: '48', description: 'QUESO DE MAQUINA DAMBO LA PAULINA', quantity: '7.345', unitNetPrice: '8267.696', grossSubtotal: '60726.232' },
  { supplierCode: '10', description: 'JAMON COCIDO MINI TRADICIONAL LOS CALVOS', quantity: '4.040', unitNetPrice: '12258.780', grossSubtotal: '49525.474' },
  { supplierCode: '2514', description: 'JAMON COCIDO MINI IL MOLISE', quantity: '7.665', unitNetPrice: '8941.615', grossSubtotal: '68537.481' },
];

/**
 * El pie, sin BOLSA GRANDE.
 *
 * El papel cierra en 221.388,84 con los seis renglones; sacando la bolsa
 * ($223,14) quedan 221.165,707, que truncado da 221.165,70.
 */
const PIE = {
  netTotal: '221165.70',
  ivaTotal: '46444.80',
  perceptionsTotal: '0',
  total: '267610.50',
  lineCount: 5,
};

/** Un producto del catálogo, con Los Calvos como proveedor habitual. */
async function productoHabitual(
  codigo: string,
  nombre: string,
  alias: string,
  costoAnterior: string,
) {
  const producto = await prisma.product.create({
    data: {
      internalCode: codigo,
      normalizedName: nombre,
      category: 'Fiambres',
      purchaseUnit: 'KG',
      saleMode: 'FETEABLE',
      usesPlu: true,
      // El proveedor habitual, que esta compra no puede tocar.
      defaultSupplierId: escenario.proveedorId,
      targetMarginPct: '0.45',
      marginBasis: 'SOBRE_COSTO',
      cashDiscountPct: '0',
      roundingRule: 'NEAREST_100',
      aliases: {
        create: { alias, normalized: normalizeText(alias), origin: 'MANUAL' },
      },
    },
  });
  // Un costo anterior, más barato, que esta compra tampoco puede pisar.
  await prisma.costHistory.create({
    data: {
      productId: producto.id,
      supplierId: escenario.proveedorId,
      branchId: escenario.sucursales.devoto,
      date: new Date('2026-08-01T00:00:00Z'),
      kind: 'COMPRA',
      unitNetPrice: costoAnterior,
      unitCost: costoAnterior,
    },
  });
  /*
   * Y un precio de venta vigente, aprobado por el camino real.
   *
   * Se usa `approveSalePrice` y no una fila escrita a mano: lo que hay que
   * poder afirmar después es que **un precio que aprobó una persona** no se
   * mueve, y para eso el precio tiene que haber nacido como nacen los de
   * verdad, con su costo base y su marcaje.
   */
  await approveSalePrice(escenario.admin, {
    productId: producto.id,
    approvedPricePerKg: '11900',
  });
  return producto.id;
}

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();

  plu = {
    cremoso: await productoHabitual('3101', 'Queso cremoso La Paulina', 'Cremoso LA PAULINA', '5200'),
    pernil: await productoHabitual('3102', 'Pernil pata celeste mini', 'PERNIL PATA CELESTE MINI 1284', '3100'),
    dambo: await productoHabitual('3103', 'Queso de maquina Dambo', 'QUESO DE MAQUINA DAMBO LA PAULINA', '7000'),
    jamonLC: await productoHabitual('3104', 'Jamon cocido mini tradicional', 'JAMON COCIDO MINI TRADICIONAL LOS CALVOS', '10500'),
    jamonIM: await productoHabitual('3105', 'Jamon cocido mini Il Molise', 'JAMON COCIDO MINI IL MOLISE', '8000'),
  };

  const alta = await crearProveedorDesdeLectura(escenario.admin, {
    nombre: 'Distribuidora Ezra',
    razonSocial: 'Cooperativa de Trabajo Ezra Alimentos',
    cuit: '30-71951960-8',
  });
  ezraId = alta.id;
});

/**
 * El PLU que el operador eligió para cada renglón, en la pantalla de revisión.
 *
 * Es el flujo real y es el que pidió la usuaria: la asociación se persiste
 * **después de su confirmación**. El matcher resuelve solo cuatro de los cinco
 * —al pernil, Ezra le pega la marca al nombre y no llega al umbral—, y ése es
 * justamente el que una persona tiene que confirmar la primera vez. De ahí en
 * adelante queda aprendido, y eso se comprueba aparte.
 */
function pluElegido(codigo: string): string {
  const porCodigo: Record<string, string> = {
    '47': plu.cremoso,
    '49': plu.pernil,
    '48': plu.dambo,
    '10': plu.jamonLC,
    '2514': plu.jamonIM,
  };
  return porCodigo[codigo];
}

/** Valida la factura de Ezra en Devoto. Devuelve el id del comprobante. */
async function validarFacturaDeEzra(numero = '00000185') {
  const doc = await createDocument(escenario.admin, escenario.sucursales.devoto);
  await confirmDocument(escenario.admin, {
    documentId: doc.id,
    supplierId: ezraId,
    docType: 'FACTURA',
    letter: 'A',
    pointOfSale: '0002',
    number: numero,
    issueDate: FECHA,
    printed: PIE,
    items: RENGLONES.map((r, i) => ({
      ...r,
      lineNumber: i + 1,
      unit: 'KG' as const,
      discountPct: '0',
      ivaRate: '0.21',
      productId: pluElegido(r.supplierCode),
      learnAlias: true,
    })),
    payment: { dueDate: '2026-10-09', paymentMethod: 'TRANSFERENCIA', notes: null },
  });
  return doc.id;
}

describe('el alta del proveedor', () => {
  it('no duplica a Ezra si el CUIT ya está cargado', async () => {
    const otraVez = await crearProveedorDesdeLectura(escenario.admin, {
      nombre: 'EZRA',
      razonSocial: null,
      cuit: '30-71951960-8',
    });
    expect(otraVez.creado).toBe(false);
    expect(otraVez.motivo).toBe('CUIT');
    expect(otraVez.id).toBe(ezraId);

    const cuantos = await prisma.supplier.count({ where: { cuit: '30-71951960-8' } });
    expect(cuantos).toBe(1);
  });
});

describe('1. la factura queda a nombre de Ezra', () => {
  it('el comprobante validado tiene a Ezra como proveedor', async () => {
    const id = await validarFacturaDeEzra();
    const doc = await prisma.document.findUnique({
      where: { id },
      include: { supplier: true },
    });

    expect(doc!.status).toBe('VALIDADO');
    expect(doc!.supplierId).toBe(ezraId);
    expect(doc!.supplier!.cuit).toBe('30-71951960-8');
    expect(doc!.fullNumber).toBe('0002-00000185');
  });

  it('no hereda el plazo ni las tasas de Los Calvos por la marca de un artículo', async () => {
    /*
     * En el renglón 10 la marca es «LOS CALVOS». Antes eso alcanzaba para que
     * el analizador atribuyera la factura a ese proveedor, y con él venían su
     * plazo de pago y sus tasas. Acá se comprueba del lado del guardado: las
     * condiciones aplicadas son las de Ezra, no las del proveedor cuya marca
     * aparece en la tabla.
     */
    const id = await validarFacturaDeEzra();
    const doc = await prisma.document.findUnique({ where: { id } });

    const condicionesDeLosCalvos = await prisma.supplierPaymentTerm.findFirst({
      where: { supplierId: escenario.proveedorId },
    });
    expect(doc!.supplierId).not.toBe(escenario.proveedorId);
    if (condicionesDeLosCalvos) {
      expect(doc!.appliedTermDays).not.toBe(condicionesDeLosCalvos.days);
    }

    const items = await prisma.documentItem.findMany({ where: { documentId: id } });
    expect(items.some((i) => i.description.includes('LOS CALVOS'))).toBe(true);
  });
});

describe('2. la deuda se genera sólo con Ezra', () => {
  it('la agenda de pago apunta a la factura de Ezra y a ninguna otra', async () => {
    const id = await validarFacturaDeEzra();

    const agendas = await prisma.paymentSchedule.findMany({
      include: { document: { include: { supplier: true } } },
    });
    expect(agendas).toHaveLength(1);
    expect(agendas[0].documentId).toBe(id);
    expect(agendas[0].document.supplierId).toBe(ezraId);
    expect(agendas[0].document.supplier!.tradeName).toContain('Ezra');
  });

  it('no queda paga sola por decir «Transf.: MP» en el comprobante', async () => {
    /*
     * La condición de pago impresa dice cómo se va a pagar, no que se haya
     * pagado. Un comprobante que naciera pagado desaparecería de la agenda sin
     * que nadie hubiera transferido nada.
     */
    const id = await validarFacturaDeEzra();
    const agenda = await prisma.paymentSchedule.findUnique({ where: { documentId: id } });

    expect(agenda!.status).not.toBe('PAGADO');
    expect(agenda!.paidAmount.toString()).toBe('0');
    expect(new Decimal(agenda!.plannedAmount.toString()).toFixed(2)).toBe('267610.50');

    const egresos = await prisma.paymentEvent.count();
    expect(egresos).toBe(0);
  });
});

describe('3. se registra el movimiento de compra en la sucursal elegida', () => {
  it('cada PLU asociado recibe su movimiento de compra en Devoto, con su cantidad', async () => {
    /*
     * Se dice «se registró el movimiento de compra», no «aumentó el saldo de
     * stock», y la diferencia es real: Compras **no lleva saldo de
     * existencias**. El maestro es Control de Stock, y registrar este
     * movimiento hoy no modifica nada allá.
     *
     * Lo que se comprueba es lo que Compras sí hace y lo que hará falta el día
     * que esos movimientos se envíen: producto, cantidad, unidad, sucursal,
     * proveedor y comprobante, cada uno en su lugar.
     */
    const id = await validarFacturaDeEzra();
    const movimientos = await prisma.purchaseMovement.findMany({
      where: { documentId: id },
      include: { product: true },
    });

    expect(movimientos).toHaveLength(5);
    for (const m of movimientos) {
      expect(m.branchId).toBe(escenario.sucursales.devoto);
      expect(m.supplierId).toBe(ezraId);
      expect(m.productId).not.toBeNull();
    }

    const porPlu = new Map(movimientos.map((m) => [m.product!.internalCode, m]));
    expect(new Decimal(porPlu.get('3101')!.quantity.toString()).toFixed(3)).toBe('4.240');
    expect(new Decimal(porPlu.get('3102')!.quantity.toString()).toFixed(3)).toBe('3.985');
    expect(new Decimal(porPlu.get('3103')!.quantity.toString()).toFixed(3)).toBe('7.345');
    expect(new Decimal(porPlu.get('3104')!.quantity.toString()).toFixed(3)).toBe('4.040');
    expect(new Decimal(porPlu.get('3105')!.quantity.toString()).toFixed(3)).toBe('7.665');
  });

  it('no se registra en otra sucursal', async () => {
    const id = await validarFacturaDeEzra();
    const enOtras = await prisma.purchaseMovement.count({
      where: { documentId: id, branchId: { not: escenario.sucursales.devoto } },
    });
    expect(enOtras).toBe(0);
  });

  it('los cinco renglones se asocian a los PLU que ya existían, sin crear productos', async () => {
    const antes = await prisma.product.count();
    await validarFacturaDeEzra();
    const despues = await prisma.product.count();

    // Ningún producto nuevo por venir de otro proveedor.
    expect(despues).toBe(antes);

    const items = await prisma.documentItem.findMany({
      where: { productId: { not: null } },
      include: { product: true },
    });
    expect(items.map((i) => i.product!.internalCode).sort()).toEqual([
      '3101',
      '3102',
      '3103',
      '3104',
      '3105',
    ]);
  });
});

describe('4. el costo real pagado a Ezra entra al historial', () => {
  it('cada PLU suma una entrada nueva, con esta factura y este proveedor', async () => {
    const id = await validarFacturaDeEzra();

    const costos = await prisma.costHistory.findMany({
      where: { documentId: id },
      include: { product: true },
    });
    expect(costos).toHaveLength(5);

    const cremoso = costos.find((c) => c.product.internalCode === '3101')!;
    expect(cremoso.supplierId).toBe(ezraId);
    expect(cremoso.branchId).toBe(escenario.sucursales.devoto);
    expect(cremoso.kind).toBe('COMPRA');
    // El costo unitario real de esta compra, con las percepciones repartidas.
    expect(new Decimal(cremoso.unitNetPrice.toString()).toFixed(3)).toBe('6387.115');
  });

  it('no sobrescribe los costos anteriores', async () => {
    /*
     * Ezra fue más caro que el proveedor habitual. Si la compra excepcional
     * pisara el costo anterior, el historial diría que el cremoso siempre costó
     * lo que costó esta vez, y la serie de precios quedaría deformada para
     * siempre.
     */
    await validarFacturaDeEzra();

    const serie = await prisma.costHistory.findMany({
      where: { productId: plu.cremoso },
      orderBy: { date: 'asc' },
    });
    expect(serie).toHaveLength(2);

    // El de agosto, con Los Calvos, intacto.
    expect(serie[0].supplierId).toBe(escenario.proveedorId);
    expect(new Decimal(serie[0].unitCost.toString()).toFixed(2)).toBe('5200.00');
    // Y el de Ezra, nuevo y más caro.
    expect(serie[1].supplierId).toBe(ezraId);
    expect(new Decimal(serie[1].unitCost.toString()).gt('5200')).toBe(true);
  });
});

describe('5. el proveedor habitual de cada producto no cambia', () => {
  it('los cinco PLU siguen con Los Calvos como proveedor habitual', async () => {
    await validarFacturaDeEzra();

    const productos = await prisma.product.findMany({
      where: { id: { in: Object.values(plu) } },
    });
    expect(productos).toHaveLength(5);
    for (const p of productos) {
      expect(p.defaultSupplierId, `${p.internalCode} cambió de proveedor habitual`).toBe(
        escenario.proveedorId,
      );
      expect(p.defaultSupplierId).not.toBe(ezraId);
    }
  });
});

describe('6. el precio de venta vigente no se toca', () => {
  it('no se aprueba ningún precio nuevo al validar la compra', async () => {
    const antes = await prisma.salePriceHistory.findMany({ orderBy: { id: 'asc' } });
    await validarFacturaDeEzra();
    const despues = await prisma.salePriceHistory.findMany({ orderBy: { id: 'asc' } });

    expect(despues).toHaveLength(antes.length);
    expect(despues.map((p) => p.approvedPricePerKg.toString())).toEqual(
      antes.map((p) => p.approvedPricePerKg.toString()),
    );
  });

  it('el precio aprobado del cremoso sigue siendo el mismo aunque el costo haya subido', async () => {
    await validarFacturaDeEzra();

    const precios = await prisma.salePriceHistory.findMany({ where: { productId: plu.cremoso } });
    expect(precios).toHaveLength(1);
    expect(new Decimal(precios[0].approvedPricePerKg.toString()).toFixed(2)).toBe('11900.00');
    // Y su base de costo sigue siendo la de cuando se aprobó, no la de Ezra.
    expect(new Decimal(precios[0].costBasis.toString()).toFixed(2)).toBe('5200.00');
  });
});

describe('7. los códigos de Ezra quedan asociados sin tocar los de nadie más', () => {
  it('se aprende un alias por cada código de Ezra, con su proveedor', async () => {
    await validarFacturaDeEzra();

    const deEzra = await prisma.productAlias.findMany({
      where: { supplierId: ezraId },
      include: { product: true },
    });
    expect(deEzra.map((a) => a.supplierCode).sort()).toEqual(['10', '2514', '47', '48', '49']);

    // Cada código apunta al PLU que corresponde.
    const porCodigo = new Map(deEzra.map((a) => [a.supplierCode, a.product.internalCode]));
    expect(porCodigo.get('47')).toBe('3101');
    expect(porCodigo.get('2514')).toBe('3105');
  });

  it('el mismo código puede existir en otro proveedor apuntando a otro producto', async () => {
    /*
     * «10» es el código de Ezra para el jamón de Los Calvos. Nada impide que
     * Los Calvos use el «10» para otra cosa: el código es del proveedor, no del
     * artículo. Los dos alias tienen que poder convivir.
     */
    await prisma.productAlias.create({
      data: {
        productId: plu.cremoso,
        supplierId: escenario.proveedorId,
        supplierCode: '10',
        alias: 'CREMOSO LC',
        normalized: normalizeText('CREMOSO LC'),
        origin: 'MANUAL',
      },
    });

    await validarFacturaDeEzra();

    const diez = await prisma.productAlias.findMany({ where: { supplierCode: '10' } });
    expect(diez).toHaveLength(2);
    const porProveedor = new Map(diez.map((a) => [a.supplierId, a.productId]));
    expect(porProveedor.get(escenario.proveedorId)).toBe(plu.cremoso);
    expect(porProveedor.get(ezraId)).toBe(plu.jamonLC);
  });

  it('una vez confirmada, la próxima factura de Ezra reconoce los códigos sola', async () => {
    /*
     * El requisito completo: la asociación se persiste **después** de que la
     * usuaria la confirma, y a partir de ahí vale. El pernil es el caso que lo
     * demuestra: Ezra le pega la marca al nombre y el reconocedor no llega al
     * umbral por descripción, así que la primera vez lo asocia una persona. La
     * segunda vez tiene que salir solo, por el código de Ezra.
     */
    const costeados = costItems(
      RENGLONES.map((r, i) => ({ ...r, lineNumber: i + 1, unit: 'KG' as const, discountPct: '0', ivaRate: '0.21' })),
      { netTotal: PIE.netTotal, ivaTotal: PIE.ivaTotal, perceptionsTotal: '0' },
    );

    // Antes de la confirmación, el pernil no se resuelve solo.
    const antes = await matchItemsToProducts(costeados, ezraId);
    expect(antes[1].productId).toBeNull();

    await validarFacturaDeEzra();

    // Después, sí, y por el código del proveedor.
    const despues = await matchItemsToProducts(costeados, ezraId);
    expect(despues[1].productId).toBe(plu.pernil);
    expect(despues[1].method).toBe('SUPPLIER_CODE');
    expect(despues.every((m) => m.productId !== null)).toBe(true);
  });

  it('no altera los alias que ya tenían los productos', async () => {
    const antes = await prisma.productAlias.findMany({
      where: { supplierId: null },
      orderBy: { id: 'asc' },
    });
    await validarFacturaDeEzra();
    const despues = await prisma.productAlias.findMany({
      where: { supplierId: null },
      orderBy: { id: 'asc' },
    });

    expect(despues.map((a) => a.alias)).toEqual(antes.map((a) => a.alias));
  });
});

describe('8. validar dos veces no duplica nada', () => {
  it('la segunda corrida deja la misma factura, deuda, movimientos, costos y alias', async () => {
    const id = await validarFacturaDeEzra();

    const contar = async () => ({
      documentos: await prisma.document.count({ where: { status: 'VALIDADO' } }),
      renglones: await prisma.documentItem.count({ where: { documentId: id } }),
      movimientos: await prisma.purchaseMovement.count({ where: { documentId: id } }),
      costos: await prisma.costHistory.count({ where: { documentId: id } }),
      agendas: await prisma.paymentSchedule.count(),
      aliasDeEzra: await prisma.productAlias.count({ where: { supplierId: ezraId } }),
    });
    const primera = await contar();

    /*
     * Volver a validar el mismo comprobante tiene que ser rechazado, y sin
     * dejar rastro. Es lo que pasa cuando alguien toca «Validar» dos veces
     * porque la primera tardó.
     */
    await expect(validarFacturaDeEzra()).rejects.toThrow(/ya fue confirmado|ya está cargada/i);

    expect(await contar()).toEqual(primera);
  });

  it('cargar la misma factura desde otro comprobante se rechaza como duplicada', async () => {
    await validarFacturaDeEzra();

    const otro = await createDocument(escenario.admin, escenario.sucursales.devoto);
    await expect(
      confirmDocument(escenario.admin, {
        documentId: otro.id,
        supplierId: ezraId,
        docType: 'FACTURA',
        letter: 'A',
        pointOfSale: '0002',
        number: '00000185',
        issueDate: FECHA,
        printed: PIE,
        items: RENGLONES.map((r, i) => ({
          ...r,
          lineNumber: i + 1,
          unit: 'KG' as const,
          discountPct: '0',
          ivaRate: '0.21',
          productId: pluElegido(r.supplierCode),
          learnAlias: true,
        })),
        payment: { dueDate: '2026-10-09', paymentMethod: 'TRANSFERENCIA', notes: null },
      }),
    ).rejects.toThrow(/ya está cargada/i);

    expect(await prisma.paymentSchedule.count()).toBe(1);
    expect(await prisma.costHistory.count({ where: { supplierId: ezraId } })).toBe(5);
  });
});

describe('9. el pago se registra contra la deuda de Ezra', () => {
  it('baja la deuda de Ezra y deja un solo egreso', async () => {
    const id = await validarFacturaDeEzra();
    const agenda = await prisma.paymentSchedule.findUnique({ where: { documentId: id } });

    await confirmPayment(escenario.admin, {
      scheduleId: agenda!.id,
      effectiveDate: FECHA,
      amount: '267610.50',
      paymentMethod: 'TRANSFERENCIA',
      notes: null,
    });

    const despues = await prisma.paymentSchedule.findUnique({
      where: { id: agenda!.id },
      include: { document: true },
    });
    expect(despues!.status).toBe('PAGADO');
    expect(new Decimal(despues!.paidAmount.toString()).toFixed(2)).toBe('267610.50');
    expect(despues!.document.supplierId).toBe(ezraId);

    const eventos = await prisma.paymentEvent.findMany();
    expect(eventos).toHaveLength(1);
  });

  it('confirmar el pago dos veces no duplica el egreso', async () => {
    const id = await validarFacturaDeEzra();
    const agenda = await prisma.paymentSchedule.findUnique({ where: { documentId: id } });
    const pago = {
      scheduleId: agenda!.id,
      effectiveDate: FECHA,
      amount: '267610.50',
      paymentMethod: 'TRANSFERENCIA',
      notes: null,
    };

    await confirmPayment(escenario.admin, pago);
    await expect(confirmPayment(escenario.admin, pago)).rejects.toThrow(/ya estaba confirmado/i);

    expect(await prisma.paymentEvent.count()).toBe(1);
  });
});

describe('BOLSA GRANDE, que no es del catálogo comercial', () => {
  it('no se asocia a ningún PLU ni se le inventa uno', async () => {
    /*
     * No existe como artículo ni como insumo: el catálogo de Compras se
     * sincroniza desde Control de Stock y sólo trae artículos comerciales. Un
     * renglón así queda **sin asociar**, que es la forma que tiene el sistema de
     * pedir una decisión humana.
     */
    const costeados = costItems(
      [
        {
          lineNumber: 1,
          supplierCode: '4249',
          description: 'BOLSA GRANDE',
          quantity: '3',
          unit: 'KG' as const,
          unitNetPrice: '74.380',
          grossSubtotal: '223.140',
          discountPct: '0',
          ivaRate: '0.21',
        },
      ],
      { netTotal: '223.14', ivaTotal: '46.86', perceptionsTotal: '0' },
    );
    const asociaciones = await matchItemsToProducts(costeados, ezraId);

    expect(asociaciones[0].productId).toBeNull();
    expect(asociaciones[0].method).toBe('NONE');
  });

  it('el catálogo no tiene nada parecido a una bolsa', async () => {
    // Deja constancia del estado de hoy: si mañana alguien la carga como
    // artículo, esta prueba lo va a decir.
    const parecidos = await prisma.product.findMany({
      where: { normalizedName: { contains: 'olsa' } },
    });
    expect(parecidos).toEqual([]);
  });
});

/**
 * BOLSA GRANDE entra a la factura como insumo no comercial.
 *
 * La decisión: el renglón se carga, su importe integra el neto, el IVA, el
 * total y la deuda con Ezra —se compró y hay que pagarlo— pero no se le inventa
 * un PLU, no entra al catálogo comercial y no genera costo de ningún producto.
 * No hay modelo de insumos y no se agrega uno: si algún día hay que controlar
 * bolsas y descartables, será un módulo aparte.
 */
describe('BOLSA GRANDE como insumo no comercial', () => {
  /** Los seis renglones del papel, con la bolsa incluida. */
  const SEIS = [
    ...RENGLONES,
    {
      supplierCode: '4249',
      description: 'BOLSA GRANDE',
      quantity: '3',
      unitNetPrice: '74.380',
      grossSubtotal: '223.140',
    },
  ];
  /** El pie completo del papel, con los seis renglones. */
  const PIE_COMPLETO = {
    netTotal: '221388.84',
    ivaTotal: '46491.66',
    perceptionsTotal: '0',
    total: '267880.50',
    lineCount: 6,
  };

  async function validarConLaBolsa(numero = '00000185') {
    const doc = await createDocument(escenario.admin, escenario.sucursales.devoto);
    await confirmDocument(escenario.admin, {
      documentId: doc.id,
      supplierId: ezraId,
      docType: 'FACTURA',
      letter: 'A',
      pointOfSale: '0002',
      number: numero,
      issueDate: FECHA,
      printed: PIE_COMPLETO,
      items: SEIS.map((r, i) => ({
        ...r,
        lineNumber: i + 1,
        unit: 'KG' as const,
        discountPct: '0',
        ivaRate: '0.21',
        // La bolsa no tiene PLU y no se le inventa uno.
        productId: r.supplierCode === '4249' ? null : pluElegido(r.supplierCode),
        learnAlias: r.supplierCode !== '4249',
      })),
      payment: { dueDate: '2026-10-09', paymentMethod: 'TRANSFERENCIA', notes: null },
    });
    return doc.id;
  }

  it('queda visible en el comprobante, con su importe', async () => {
    const id = await validarConLaBolsa();
    const renglones = await prisma.documentItem.findMany({
      where: { documentId: id },
      orderBy: { lineNumber: 'asc' },
    });

    expect(renglones).toHaveLength(6);
    const bolsa = renglones.find((r) => r.supplierCode === '4249')!;
    expect(bolsa.description).toBe('BOLSA GRANDE');
    expect(new Decimal(bolsa.grossSubtotal.toString()).toFixed(2)).toBe('223.14');
    // Sin producto, y sin que nadie le haya inventado uno.
    expect(bolsa.productId).toBeNull();
    expect(bolsa.matchMethod).toBe('NONE');
  });

  it('su importe integra el neto, el IVA, el total y la deuda', async () => {
    const id = await validarConLaBolsa();
    const doc = await prisma.document.findUnique({
      where: { id },
      include: { paymentSchedule: true },
    });

    // El comprobante cierra con los seis renglones, no con cinco.
    expect(new Decimal(doc!.netTotal!.toString()).toFixed(2)).toBe('221388.84');
    expect(new Decimal(doc!.total!.toString()).toFixed(2)).toBe('267880.50');
    // Y la deuda con Ezra es la del papel entero.
    expect(new Decimal(doc!.paymentSchedule!.plannedAmount.toString()).toFixed(2)).toBe(
      '267880.50',
    );

    /*
     * La prueba de que la bolsa está adentro: sacándola, el neto es otro. Sin
     * esto, un comprobante al que se le perdiera el renglón pasaría igual.
     */
    const sinLaBolsa = new Decimal('221388.84').minus('223.14');
    expect(new Decimal(doc!.netTotal!.toString()).eq(sinLaBolsa)).toBe(false);
  });

  it('no genera costo histórico de ningún producto', async () => {
    const id = await validarConLaBolsa();

    // Cinco costos, uno por cada PLU comercial. La bolsa no suma ninguno.
    const costos = await prisma.costHistory.findMany({ where: { documentId: id } });
    expect(costos).toHaveLength(5);
    expect(costos.every((c) => c.productId !== null)).toBe(true);
  });

  it('deja su movimiento de compra, pero sin producto', async () => {
    /*
     * El movimiento se registra igual: la mercadería entró y el comprobante la
     * documenta. Lo que no tiene es producto, así que no aparece en ningún
     * reporte por artículo ni afecta el costo de ninguno.
     *
     * Se dice «se registró el movimiento de compra» y no «aumentó el stock»:
     * Compras no lleva saldo de existencias, y el maestro es Control de Stock.
     */
    const id = await validarConLaBolsa();
    const movimientos = await prisma.purchaseMovement.findMany({ where: { documentId: id } });

    expect(movimientos).toHaveLength(6);
    const bolsa = movimientos.find((m) => m.description === 'BOLSA GRANDE')!;
    expect(bolsa.productId).toBeNull();
    expect(bolsa.supplierId).toBe(ezraId);
    expect(bolsa.branchId).toBe(escenario.sucursales.devoto);
    expect(new Decimal(bolsa.quantity.toString()).toFixed(0)).toBe('3');
  });

  it('no entra al catálogo comercial', async () => {
    const antes = await prisma.product.count();
    await validarConLaBolsa();

    expect(await prisma.product.count()).toBe(antes);
    expect(await prisma.product.findMany({ where: { normalizedName: { contains: 'olsa' } } })).toEqual(
      [],
    );
    // Ni se le aprende un alias: no hay producto al que asociarlo.
    const alias = await prisma.productAlias.findMany({ where: { supplierCode: '4249' } });
    expect(alias).toEqual([]);
  });

  it('el movimiento conserva lo que hará falta para enviarlo una sola vez', async () => {
    /*
     * Todavía no se le escribe nada a Control de Stock, y no se va a hacer en
     * este commit. Lo que sí tiene que quedar guardado es todo lo necesario
     * para poder hacerlo después **exactamente una vez**: qué producto, cuánto,
     * en qué unidad, en qué sucursal, de qué proveedor, por qué comprobante, y
     * un identificador propio del movimiento que sirva de clave de
     * idempotencia.
     */
    const id = await validarConLaBolsa();
    const movimientos = await prisma.purchaseMovement.findMany({
      where: { documentId: id },
    });

    for (const m of movimientos) {
      expect(m.id).toBeTruthy();
      expect(m.documentItemId).toBeTruthy();
      expect(m.documentId).toBe(id);
      expect(m.supplierId).toBe(ezraId);
      expect(m.branchId).toBe(escenario.sucursales.devoto);
      expect(m.unit).toBeTruthy();
      expect(m.date).toBeInstanceOf(Date);
      expect(new Decimal(m.quantity.toString()).gt(0)).toBe(true);
    }

    // `documentItemId` es único: un renglón produce un movimiento y no dos.
    const ids = movimientos.map((m) => m.documentItemId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
