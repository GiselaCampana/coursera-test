import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { limpiarBase, sembrarEscenario, type Escenario } from './ayudas';
import { confirmDocument, createDocument } from '@/lib/services/documents';
import { aplicarCompra, vistaPreviaDeCompra } from '@/lib/services/vista-previa-compra';
import { AUDIT_ACTIONS } from '@/lib/services/audit';
import { Decimal } from '@/lib/money';
import { BARRAZA_ARTICULOS_IMPRESOS, BARRAZA_PIE } from '../fixtures/barraza';

/**
 * **El cierre operativo de Compras: lo que no se lee, se carga a mano.**
 *
 * Una factura difícil no puede convertirse en una compra incorrecta, y tampoco
 * puede dejar bloqueada la operación. Lo que se prueba acá es el segundo
 * camino: que un comprobante que el OCR no pudo leer se pueda completar, que lo
 * completado se controle con las mismas reglas que lo leído, y que nada de eso
 * abra una puerta para aplicar una compra a medias.
 *
 * Y los costos de Barraza contra la base, que es la razón por la que la
 * bonificación inferida existe.
 */

let escenario: Escenario;
const PAGO = { forma: 'TRANSFERENCIA', condicion: { tipo: 'DIAS' as const, dias: 30 } };

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();
});

/* ========================================================================== */

describe('un renglón sin clasificar no se aplica', () => {
  /*
   * El freno vive en el servidor y no en la pantalla. La pantalla lo avisa para
   * que la persona no pierda el viaje; la defensa es ésta, y se comprueba
   * llamando al servicio directamente, que es el camino que usaría cualquiera
   * que mire la red.
   */
  async function confirmarCon(clasificacion: 'MERCADERIA' | 'PENDIENTE' | 'EMBALAJE') {
    const doc = await createDocument(escenario.admin, escenario.sucursales.devoto);
    const producto = await prisma.product.findFirstOrThrow({ select: { id: true } });
    return confirmDocument(escenario.admin, {
      documentId: doc.id,
      supplierId: (await prisma.supplier.findFirstOrThrow({ select: { id: true } })).id,
      docType: 'FACTURA',
      letter: 'A',
      pointOfSale: '0001',
      number: `9000${clasificacion.slice(0, 2)}`,
      issueDate: '2026-09-10',
      printed: { netTotal: '1000.00', ivaTotal: '210.00', total: '1210.00' },
      items: [
        {
          lineNumber: 1,
          supplierCode: 'X1',
          description: 'ARTÍCULO DE PRUEBA',
          quantity: '10',
          unit: 'KG' as const,
          unitNetPrice: '100',
          discountPct: '0',
          ivaRate: '0.21',
          productId: clasificacion === 'EMBALAJE' ? null : producto.id,
          matchMethod: 'MANUAL',
          clasificacion,
          expenseKind: clasificacion === 'EMBALAJE' ? ('EMBALAJE' as const) : null,
        },
      ],
      payment: { dueDate: '2026-10-10', paymentMethod: 'TRANSFERENCIA', notes: null },
    });
  }

  it('PENDIENTE lo rechaza el servidor, no la pantalla', async () => {
    await expect(confirmarCon('PENDIENTE')).rejects.toThrow(/sin clasificar no se puede aplicar/i);
  });

  it('y no deja nada escrito', async () => {
    const antes = await prisma.documentItem.count();
    await confirmarCon('PENDIENTE').catch(() => null);
    expect(await prisma.documentItem.count()).toBe(antes);
  });

  it('MERCADERIA sí se confirma', async () => {
    const r = await confirmarCon('MERCADERIA');
    expect(r.documentId).toBeTruthy();
  });

  it('un gasto se confirma sin artículo, porque no lo necesita', async () => {
    const r = await confirmarCon('EMBALAJE');
    const renglon = await prisma.documentItem.findFirstOrThrow({
      where: { documentId: r.documentId },
      select: { expenseKind: true, productId: true },
    });
    expect(renglon.expenseKind).toBe('EMBALAJE');
    expect(renglon.productId).toBeNull();
  });
});

/* ========================================================================== */

describe('Barraza: los costos se guardan sobre el neto, no sobre el bruto', () => {
  /*
   * La razón de ser de la bonificación inferida, comprobada contra la base y no
   * contra un cálculo en memoria. Sin el 16 %, cada renglón quedaría costeado
   * sobre su bruto: el total cerraría igual —porque el neto del pie manda— y el
   * costo de cada artículo estaría mal, que es la combinación que no ve ningún
   * control.
   */
  let documentId: string;
  const productosPorCodigo = new Map<string, string>();

  beforeEach(async () => {
    const proveedor = await prisma.supplier.create({
      data: { tradeName: 'Barraza', legalName: 'BARRAZA SA', cuit: '30-11111111-1' },
    });

    for (const a of BARRAZA_ARTICULOS_IMPRESOS) {
      const producto = await prisma.product.create({
        data: {
          internalCode: `PLU-BZ-${a.codigo}`,
          normalizedName: a.descripcion,
          purchaseUnit: 'KG',
        },
      });
      productosPorCodigo.set(a.codigo, producto.id);
    }

    const doc = await createDocument(escenario.admin, escenario.sucursales.devoto);
    documentId = doc.id;

    /*
     * Se confirma con la bonificación del 16 % **ya inferida**, que es lo que
     * la lectura deja en cada renglón. Lo que se mide es lo que el servidor
     * guarda a partir de eso.
     */
    await confirmDocument(escenario.admin, {
      documentId,
      supplierId: proveedor.id,
      docType: 'FACTURA',
      letter: 'A',
      pointOfSale: '0041',
      number: '00196670',
      issueDate: '2026-09-10',
      printed: {
        netTotal: BARRAZA_PIE.netTotal,
        ivaTotal: BARRAZA_PIE.iva21,
        perceptionsTotal: BARRAZA_PIE.percepcionIibbCaba,
        total: BARRAZA_PIE.total,
      },
      items: BARRAZA_ARTICULOS_IMPRESOS.map((a, i) => ({
        lineNumber: i + 1,
        supplierCode: a.codigo,
        description: a.descripcion,
        quantity: a.kilos,
        unit: 'KG' as const,
        pieceCount: a.piezas,
        unitNetPrice: a.precioPorKg,
        discountPct: '0.16',
        ivaRate: '0.21',
        productId: productosPorCodigo.get(a.codigo) ?? null,
        matchMethod: 'MANUAL',
        clasificacion: 'MERCADERIA' as const,
        expenseKind: null,
      })),
      payment: { dueDate: '2026-10-10', paymentMethod: 'TRANSFERENCIA', notes: null },
    });
  });

  it('cada renglón conserva su código y su bonificación del 16 %', async () => {
    const renglones = await prisma.documentItem.findMany({
      where: { documentId },
      orderBy: { lineNumber: 'asc' },
      select: { supplierCode: true, discountPct: true, netAmount: true, grossSubtotal: true },
    });

    expect(renglones.map((r) => r.supplierCode)).toEqual(['03', '30']);
    for (const r of renglones) {
      expect(new Decimal(r.discountPct.toString()).toFixed(2)).toBe('0.16');
    }
  });

  it('el neto de cada renglón es el del papel, no el bruto', async () => {
    const renglones = await prisma.documentItem.findMany({
      where: { documentId },
      orderBy: { lineNumber: 'asc' },
      select: { supplierCode: true, netAmount: true, grossSubtotal: true },
    });

    const esperado = new Map(BARRAZA_ARTICULOS_IMPRESOS.map((a) => [a.codigo, a.neto]));
    for (const r of renglones) {
      const neto = new Decimal(r.netAmount.toString());
      expect(neto.toFixed(2), `neto del renglón ${r.supplierCode}`).toBe(
        new Decimal(esperado.get(r.supplierCode!)!).toFixed(2),
      );
      /* Y el bruto quedó guardado aparte, sin pisar al neto. */
      expect(new Decimal(r.grossSubtotal.toString()).greaterThan(neto)).toBe(true);
    }
  });

  it('el costo unitario efectivo es el de después de la bonificación', async () => {
    const renglones = await prisma.documentItem.findMany({
      where: { documentId },
      orderBy: { lineNumber: 'asc' },
      select: { supplierCode: true, quantity: true, unitCost: true, totalCost: true },
    });

    for (const r of renglones) {
      const articulo = BARRAZA_ARTICULOS_IMPRESOS.find((a) => a.codigo === r.supplierCode)!;
      /*
       * El costo unitario incluye IVA y percepciones repartidas, así que no es
       * exactamente precio × 0,84. Lo que sí tiene que ser es MENOR que el
       * precio bruto más impuestos y coherente con el neto del papel: se
       * comprueba que el costo total del renglón parta del neto correcto.
       */
      const costoTotal = new Decimal(r.totalCost.toString());
      const neto = new Decimal(articulo.neto);
      expect(costoTotal.greaterThan(neto), `el costo de ${r.supplierCode} suma impuestos`).toBe(
        true,
      );
      /* Y nunca parte del bruto: el bruto más IVA sería un techo inalcanzable. */
      const brutoConIva = new Decimal(articulo.kilos)
        .times(articulo.precioPorKg)
        .times('1.21');
      expect(costoTotal.lessThan(brutoConIva), `el costo de ${r.supplierCode} no es el bruto`).toBe(
        true,
      );
      expect(new Decimal(r.unitCost.toString()).greaterThan(0)).toBe(true);
    }
  });

  it('el historial de costo de cada artículo sale del neto', async () => {
    await aplicarCompra(escenario.admin, documentId, PAGO).catch(() => null);

    for (const a of BARRAZA_ARTICULOS_IMPRESOS) {
      const productId = productosPorCodigo.get(a.codigo)!;
      const historial = await prisma.costHistory.findFirst({
        where: { productId, documentId },
        select: { unitCost: true },
      });
      expect(historial, `historial de ${a.codigo}`).not.toBeNull();
      /* El costo por kilo, partiendo del neto, más impuestos. */
      const porKiloNeto = new Decimal(a.neto).div(a.kilos);
      const porKiloBruto = new Decimal(a.precioPorKg);
      const guardado = new Decimal(historial!.unitCost.toString());
      expect(guardado.greaterThan(porKiloNeto), `${a.codigo} suma impuestos sobre el neto`).toBe(
        true,
      );
      expect(
        guardado.lessThan(porKiloBruto.times('1.21')),
        `${a.codigo} no se costeó sobre el bruto`,
      ).toBe(true);
    }
  });

  it('el total y la deuda son los del papel', async () => {
    const documento = await prisma.document.findUniqueOrThrow({
      where: { id: documentId },
      select: { netTotal: true, total: true },
    });
    expect(new Decimal(documento.netTotal!.toString()).toFixed(2)).toBe('473232.44');
    expect(new Decimal(documento.total!.toString()).toFixed(2)).toBe(
      new Decimal(BARRAZA_PIE.total).toFixed(2),
    );
  });

  it('y no se escribió nada de stock', async () => {
    expect(await prisma.stockOutbox.count()).toBe(0);
  });
});

/* ========================================================================== */

describe('la auditoría de las correcciones la calcula el servidor', () => {
  let documentId: string;
  let proveedorId: string;
  let productoId: string;

  beforeEach(async () => {
    const proveedor = await prisma.supplier.create({
      data: { tradeName: 'Proveedor de prueba', cuit: '30-22222222-2' },
    });
    proveedorId = proveedor.id;
    const producto = await prisma.product.create({
      data: { internalCode: 'PLU-CORR-1', normalizedName: 'Artículo corregible', purchaseUnit: 'KG' },
    });
    productoId = producto.id;

    const doc = await createDocument(escenario.admin, escenario.sucursales.devoto);
    documentId = doc.id;

    /*
     * Los renglones se escriben como los deja **la lectura**, no una
     * confirmación previa.
     *
     * Es el escenario real y el único que sirve: lo que la auditoría compara es
     * lo que el OCR dejó persistido contra lo que la persona manda al
     * confirmar. Confirmar dos veces no vale como escenario —el servicio lo
     * rechaza, y con razón: el historial de costo ya está escrito— así que los
     * renglones se siembran directamente, igual que `registrarLectura`.
     */
    await prisma.document.update({
      where: { id: documentId },
      data: {
        supplierId: proveedorId,
        docType: 'FACTURA',
        letter: 'A',
        pointOfSale: '0001',
        number: '80000001',
        fullNumber: 'A 0001-80000001',
        issueDate: new Date('2026-09-10T00:00:00.000Z'),
        netTotal: '1000.00',
        ivaTotal: '210.00',
        total: '1210.00',
        status: 'REQUIERE_REVISION',
      },
    });
    await prisma.documentItem.create({
      data: {
        documentId,
        lineNumber: 1,
        supplierCode: 'A1',
        description: 'PRIMER RENGLÓN',
        quantity: '10',
        unit: 'KG',
        unitNetPrice: '100',
        grossSubtotal: '1000',
        grossFromPrint: true,
        discountPct: '0',
        discountAmount: '0',
        netAmount: '1000',
        ivaRate: '0.21',
        ivaAmount: '210',
        perceptionAmount: '0',
        totalCost: '1210',
        unitCost: '121',
        productId: productoId,
        matchMethod: 'MANUAL',
      },
    });
  });

  it('registra el valor anterior y el final de cada campo corregido', async () => {
    await confirmDocument(escenario.admin, {
      documentId,
      supplierId: proveedorId,
      docType: 'FACTURA',
      letter: 'A',
      pointOfSale: '0001',
      number: '80000001',
      issueDate: '2026-09-10',
      printed: { netTotal: '1200.00', ivaTotal: '252.00', total: '1452.00' },
      items: [
        {
          lineNumber: 1,
          supplierCode: 'A1',
          description: 'PRIMER RENGLÓN CORREGIDO',
          quantity: '12',
          unit: 'KG' as const,
          unitNetPrice: '100',
          discountPct: '0',
          ivaRate: '0.21',
          productId: productoId,
          matchMethod: 'MANUAL',
          clasificacion: 'MERCADERIA' as const,
          expenseKind: null,
        },
      ],
      payment: { dueDate: '2026-10-10', paymentMethod: 'TRANSFERENCIA', notes: null },
    });

    const asiento = await prisma.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.DOCUMENT_CORRECTED, entityId: documentId },
      orderBy: { createdAt: 'desc' },
    });
    expect(asiento, 'tiene que haber un asiento de corrección').not.toBeNull();
    expect(asiento!.userId).toBe(escenario.admin.id);
    expect(asiento!.createdAt).toBeInstanceOf(Date);

    const despues = asiento!.after as {
      campos: { donde: string; campo: string; antes: string | null; despues: string | null }[];
    };
    const cantidad = despues.campos.find((c) => c.campo === 'quantity');
    expect(cantidad, 'la cantidad corregida').toBeDefined();
    expect(cantidad!.antes).toBe('10');
    expect(cantidad!.despues).toBe('12');

    const descripcion = despues.campos.find((c) => c.campo === 'description');
    expect(descripcion!.antes).toBe('PRIMER RENGLÓN');
    expect(descripcion!.despues).toBe('PRIMER RENGLÓN CORREGIDO');

    const neto = despues.campos.find((c) => c.campo === 'netTotal');
    expect(neto!.antes).toBe('1000');
    expect(neto!.despues).toBe('1200');
  });

  it('el valor anterior lo reconstruye de la base, no del pedido', async () => {
    /*
     * La prueba que da sentido a que esto viva en el servidor. El cuerpo del
     * pedido **no contiene** el valor anterior de ningún campo: no hay dónde
     * ponerlo, y si lo hubiera no habría que creerle, porque lo manda
     * exactamente quien acaba de cambiarlo. Acá se corrige el código del
     * proveedor —un campo que el pedido manda una sola vez, ya cambiado— y la
     * auditoría igual sabe cuál era.
     *
     * La corrección se elige para que el comprobante siga cerrando: si no
     * cerrara, el servicio frenaría antes y no habría asiento que mirar, y la
     * prueba pasaría por el motivo equivocado.
     */
    await confirmDocument(escenario.admin, {
      documentId,
      supplierId: proveedorId,
      docType: 'FACTURA',
      letter: 'A',
      pointOfSale: '0001',
      number: '80000001',
      issueDate: '2026-09-10',
      printed: { netTotal: '1000.00', ivaTotal: '210.00', total: '1210.00' },
      items: [
        {
          lineNumber: 1,
          supplierCode: 'A9',
          description: 'PRIMER RENGLÓN',
          quantity: '10',
          unit: 'KG' as const,
          unitNetPrice: '100',
          discountPct: '0',
          ivaRate: '0.21',
          productId: productoId,
          matchMethod: 'MANUAL',
          clasificacion: 'MERCADERIA' as const,
          expenseKind: null,
        },
      ],
      payment: { dueDate: '2026-10-10', paymentMethod: 'TRANSFERENCIA', notes: null },
    }).catch(() => null);

    const asiento = await prisma.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.DOCUMENT_CORRECTED, entityId: documentId },
      orderBy: { createdAt: 'desc' },
    });
    expect(asiento, 'tiene que haber asiento: el comprobante cerró').not.toBeNull();
    const despues = asiento!.after as {
      campos: { campo: string; antes: string | null; despues: string | null }[];
    };
    const codigo = despues.campos.find((c) => c.campo === 'supplierCode');
    expect(codigo, 'el código corregido').toBeDefined();
    /* El «A1» lo puso la base: en el pedido sólo viaja el «A9». */
    expect(codigo!.antes).toBe('A1');
    expect(codigo!.despues).toBe('A9');
  });

  it('el número del comprobante corregido a mano también sale de la base', async () => {
    /*
     * HALLAZGO de una rotura deliberada. Cambié el encabezado guardado para que
     * el punto de venta y el número se tomaran **del pedido** en lugar de la
     * base —exactamente «creerle al navegador cuál era el valor anterior»— y
     * las 17 pruebas siguieron verdes. El motivo: todas mandaban el número sin
     * cambiar, así que ninguna podía notar la diferencia. Un campo que nadie
     * corrige en ninguna prueba es un campo sin protección.
     *
     * Y es justo el campo donde más importa: el número es lo que el OCR lee
     * peor y lo que la persona corrige más seguido, y es la clave por la que
     * después se busca la factura. Si la auditoría toma el número corregido
     * como si fuese el original, la corrección desaparece del registro.
     */
    await confirmDocument(escenario.admin, {
      documentId,
      supplierId: proveedorId,
      docType: 'FACTURA',
      letter: 'A',
      /* El papel decía 0002-80000009. La lectura había dejado 0001-80000001. */
      pointOfSale: '0002',
      number: '80000009',
      issueDate: '2026-09-10',
      printed: { netTotal: '1000.00', ivaTotal: '210.00', total: '1210.00' },
      items: [
        {
          lineNumber: 1,
          supplierCode: 'A1',
          description: 'PRIMER RENGLÓN',
          quantity: '10',
          unit: 'KG' as const,
          unitNetPrice: '100',
          discountPct: '0',
          ivaRate: '0.21',
          productId: productoId,
          matchMethod: 'MANUAL',
          clasificacion: 'MERCADERIA' as const,
          expenseKind: null,
        },
      ],
      payment: { dueDate: '2026-10-10', paymentMethod: 'TRANSFERENCIA', notes: null },
    });

    const asiento = await prisma.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.DOCUMENT_CORRECTED, entityId: documentId },
      orderBy: { createdAt: 'desc' },
    });
    expect(asiento, 'tiene que haber asiento: el número cambió').not.toBeNull();
    const despues = asiento!.after as {
      campos: { campo: string; antes: string | null; despues: string | null }[];
    };

    /*
     * Los dos campos, con el valor anterior que sólo la base conocía: el pedido
     * manda el número ya corregido y nada más.
     */
    const numero = despues.campos.find((c) => c.campo === 'number');
    expect(numero, 'el número corregido tiene que quedar auditado').toBeDefined();
    expect(numero!.antes).toBe('80000001');
    expect(numero!.despues).toBe('80000009');

    const punto = despues.campos.find((c) => c.campo === 'pointOfSale');
    expect(punto, 'el punto de venta corregido tiene que quedar auditado').toBeDefined();
    expect(punto!.antes).toBe('0001');
    expect(punto!.despues).toBe('0002');

    /* Y el comprobante quedó con el número del papel, no con el de la lectura. */
    const guardado = await prisma.document.findUnique({ where: { id: documentId } });
    expect(guardado!.number).toBe('80000009');
    expect(guardado!.pointOfSale).toBe('0002');
  });

  it('audita un renglón agregado y uno quitado', async () => {
    await confirmDocument(escenario.admin, {
      documentId,
      supplierId: proveedorId,
      docType: 'FACTURA',
      letter: 'A',
      pointOfSale: '0001',
      number: '80000001',
      issueDate: '2026-09-10',
      printed: { netTotal: '2000.00', ivaTotal: '420.00', total: '2420.00' },
      items: [
        {
          lineNumber: 2,
          supplierCode: 'A2',
          description: 'RENGLÓN AGREGADO A MANO',
          quantity: '20',
          unit: 'KG' as const,
          unitNetPrice: '100',
          discountPct: '0',
          ivaRate: '0.21',
          productId: productoId,
          matchMethod: 'MANUAL',
          clasificacion: 'MERCADERIA' as const,
          expenseKind: null,
        },
      ],
      payment: { dueDate: '2026-10-10', paymentMethod: 'TRANSFERENCIA', notes: null },
    }).catch(() => null);

    const asiento = await prisma.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.DOCUMENT_CORRECTED, entityId: documentId },
      orderBy: { createdAt: 'desc' },
    });
    const despues = asiento!.after as {
      renglonesAgregados: number[];
      renglonesQuitados: number[];
    };
    expect(despues.renglonesAgregados).toContain(2);
    expect(despues.renglonesQuitados).toContain(1);
  });

  it('audita una reclasificación', async () => {
    await confirmDocument(escenario.admin, {
      documentId,
      supplierId: proveedorId,
      docType: 'FACTURA',
      letter: 'A',
      pointOfSale: '0001',
      number: '80000001',
      issueDate: '2026-09-10',
      printed: { netTotal: '1000.00', ivaTotal: '210.00', total: '1210.00' },
      items: [
        {
          lineNumber: 1,
          supplierCode: 'A1',
          description: 'PRIMER RENGLÓN',
          quantity: '10',
          unit: 'KG' as const,
          unitNetPrice: '100',
          discountPct: '0',
          ivaRate: '0.21',
          productId: null,
          matchMethod: 'MANUAL',
          clasificacion: 'EMBALAJE' as const,
          expenseKind: 'EMBALAJE' as const,
        },
      ],
      payment: { dueDate: '2026-10-10', paymentMethod: 'TRANSFERENCIA', notes: null },
    }).catch(() => null);

    const asiento = await prisma.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.DOCUMENT_CORRECTED, entityId: documentId },
      orderBy: { createdAt: 'desc' },
    });
    const despues = asiento!.after as {
      clasificacionesCambiadas: { renglon: number; antes: string | null; despues: string | null }[];
      asociacionesCambiadas: { renglon: number }[];
    };
    expect(despues.clasificacionesCambiadas).toEqual([
      { renglon: 1, antes: null, despues: 'EMBALAJE' },
    ]);
    expect(despues.asociacionesCambiadas.some((a) => a.renglon === 1)).toBe(true);
  });

  it('confirmar sin cambiar nada no deja asiento de corrección', async () => {
    /*
     * Sin esto la auditoría se llenaría de ruido y el ruido esconde lo que
     * importa: un asiento por cada guardado, diga lo que diga.
     */
    const antes = await prisma.auditLog.count({
      where: { action: AUDIT_ACTIONS.DOCUMENT_CORRECTED },
    });

    await confirmDocument(escenario.admin, {
      documentId,
      supplierId: proveedorId,
      docType: 'FACTURA',
      letter: 'A',
      pointOfSale: '0001',
      number: '80000001',
      issueDate: '2026-09-10',
      printed: { netTotal: '1000.00', ivaTotal: '210.00', total: '1210.00' },
      items: [
        {
          lineNumber: 1,
          supplierCode: 'A1',
          description: 'PRIMER RENGLÓN',
          quantity: '10',
          unit: 'KG' as const,
          unitNetPrice: '100',
          discountPct: '0',
          ivaRate: '0.21',
          productId: productoId,
          matchMethod: 'MANUAL',
          clasificacion: 'MERCADERIA' as const,
          expenseKind: null,
        },
      ],
      payment: { dueDate: '2026-10-10', paymentMethod: 'TRANSFERENCIA', notes: null },
    });

    expect(
      await prisma.auditLog.count({ where: { action: AUDIT_ACTIONS.DOCUMENT_CORRECTED } }),
    ).toBe(antes);
  });
});

/* ========================================================================== */

describe('una carga manual completa termina en una compra correcta', () => {
  /*
   * El caso Los Calvos, reducido a lo que importa: un comprobante que llegó sin
   * ningún renglón leído se completa a mano, concilia y se aplica. Lo que se
   * comprueba es que el camino manual produzca exactamente lo mismo que el
   * automático: costos, deuda, un solo registro, y nada de stock.
   */
  it('de cero renglones a una compra aplicada, con costos y deuda', async () => {
    const proveedor = await prisma.supplier.create({
      data: { tradeName: 'Los Calvos manual', cuit: '30-33333333-3' },
    });
    const productos = await Promise.all(
      [1, 2, 3].map((n) =>
        prisma.product.create({
          data: {
            internalCode: `PLU-MAN-${n}`,
            normalizedName: `Artículo manual ${n}`,
            purchaseUnit: 'KG',
          },
        }),
      ),
    );

    /* El comprobante nace vacío, como lo deja una lectura insuficiente. */
    const doc = await createDocument(escenario.admin, escenario.sucursales.devoto);
    expect(await prisma.documentItem.count({ where: { documentId: doc.id } })).toBe(0);

    /*
     * Y se carga entero a mano: tres renglones de 10 kg a $100.
     *
     * Confirmar ES aplicar: escribe los renglones, los movimientos de compra,
     * el historial de costo y la agenda de pago en una transacción. Con el
     * espía puesto, para afirmar que en todo el camino no sale nada a la red.
     */
    const espia = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      throw new Error(`Salió a la red en una carga manual: ${String(url)}`);
    });
    await confirmDocument(escenario.admin, {
      documentId: doc.id,
      supplierId: proveedor.id,
      docType: 'FACTURA',
      letter: 'A',
      pointOfSale: '0010',
      number: '00212356',
      issueDate: '2026-09-10',
      printed: { netTotal: '3000.00', ivaTotal: '630.00', total: '3630.00' },
      items: productos.map((p, i) => ({
        lineNumber: i + 1,
        supplierCode: `M${i + 1}`,
        description: `Artículo manual ${i + 1}`,
        quantity: '10',
        unit: 'KG' as const,
        unitNetPrice: '100',
        discountPct: '0',
        ivaRate: '0.21',
        productId: p.id,
        matchMethod: 'MANUAL',
        clasificacion: 'MERCADERIA' as const,
        expenseKind: null,
      })),
      payment: { dueDate: '2026-10-10', paymentMethod: 'TRANSFERENCIA', notes: null },
    });

    expect(espia).not.toHaveBeenCalled();
    espia.mockRestore();

    const documento = await prisma.document.findUniqueOrThrow({
      where: { id: doc.id },
      select: { status: true, total: true },
    });
    expect(documento.status).toBe('VALIDADO');
    expect(new Decimal(documento.total!.toString()).toFixed(2)).toBe('3630.00');

    /* Tres movimientos, tres costos, una agenda. */
    expect(await prisma.purchaseMovement.count({ where: { documentId: doc.id } })).toBe(3);
    expect(await prisma.costHistory.count({ where: { documentId: doc.id } })).toBe(3);
    expect(await prisma.paymentSchedule.count({ where: { documentId: doc.id } })).toBe(1);

    /* Nada de stock, y ningún producto creado por el camino manual. */
    expect(await prisma.stockOutbox.count()).toBe(0);
    expect(
      await prisma.product.count({ where: { internalCode: { startsWith: 'PLU-MAN-' } } }),
    ).toBe(3);

    /* Y la vista previa describe el impacto futuro sin movimientos reales. */
    const previa = await vistaPreviaDeCompra(escenario.admin, doc.id);
    expect(previa.stock.movimientos).toHaveLength(3);
    expect(previa.stock.impedimentos).toHaveLength(0);
  });

  it('un gasto cargado a mano entra al total y queda fuera del impacto', async () => {
    const proveedor = await prisma.supplier.create({
      data: { tradeName: 'Con bolsa manual', cuit: '30-44444444-4' },
    });
    const producto = await prisma.product.create({
      data: { internalCode: 'PLU-MAN-G', normalizedName: 'Queso manual', purchaseUnit: 'KG' },
    });
    const doc = await createDocument(escenario.admin, escenario.sucursales.devoto);

    await confirmDocument(escenario.admin, {
      documentId: doc.id,
      supplierId: proveedor.id,
      docType: 'FACTURA',
      letter: 'A',
      pointOfSale: '0001',
      number: '70000001',
      issueDate: '2026-09-10',
      printed: { netTotal: '1100.00', ivaTotal: '231.00', total: '1331.00' },
      items: [
        {
          lineNumber: 1,
          supplierCode: 'Q1',
          description: 'QUESO',
          quantity: '10',
          unit: 'KG' as const,
          unitNetPrice: '100',
          discountPct: '0',
          ivaRate: '0.21',
          productId: producto.id,
          matchMethod: 'MANUAL',
          clasificacion: 'MERCADERIA' as const,
          expenseKind: null,
        },
        {
          lineNumber: 2,
          supplierCode: '4249',
          description: 'BOLSA GRANDE',
          quantity: '3',
          unit: 'UNIT' as const,
          unitNetPrice: '33.3333',
          discountPct: '0',
          ivaRate: '0.21',
          productId: null,
          matchMethod: 'MANUAL',
          clasificacion: 'EMBALAJE' as const,
          expenseKind: 'EMBALAJE' as const,
        },
      ],
      payment: { dueDate: '2026-10-10', paymentMethod: 'TRANSFERENCIA', notes: null },
    });

    const previa = await vistaPreviaDeCompra(escenario.admin, doc.id);

    /* La bolsa: en los gastos, en unidades, y fuera de los movimientos. */
    const bolsa = previa.gastos.find((g) => g.descripcion.includes('BOLSA'));
    expect(bolsa, 'la bolsa figura como gasto').toBeDefined();
    expect(bolsa!.unidad).toBe('unidades');
    expect(new Decimal(bolsa!.cantidad).equals(new Decimal(3))).toBe(true);
    expect(previa.stock.movimientos).toHaveLength(1);
    expect(previa.stock.movimientos.some((m) => m.producto.includes('BOLSA'))).toBe(false);

    /* Y su importe está dentro del total. */
    expect(new Decimal(previa.egreso.total.valor!).toFixed(2)).toBe('1331.00');
  });
});
