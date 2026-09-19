import type { PrismaClient } from '@prisma/client';
import { normalizeText } from '../../src/lib/domain/matching';
import { EZRA_ARTICULOS_IMPRESOS, EZRA_ENCABEZADO, EZRA_PIE } from './ezra';

/**
 * **La compra de Ezra, cargada y sin confirmar, para mirarla andando.**
 *
 * Deja dos comprobantes con los **seis** renglones del papel:
 *
 *  1. la completa, con los seis asociados por el código que Ezra usa para cada
 *     artículo: muestra el egreso por el total impreso y los seis movimientos
 *     de mercadería, y deja aplicar;
 *  2. la frenada, donde la bolsa quedó sin código legible y el total no está
 *     impreso: el renglón se ve igual, no se puede aplicar, y los frenos lo
 *     dicen.
 *
 * Hacen falta las dos. Una sola mostraría o la pantalla que aplica o la que
 * frena, y lo que hay que poder ver —en el navegador y en las pruebas— es la
 * diferencia entre las dos.
 *
 * Vive acá, entre los fixtures, porque la usan dos lugares: el sembrado de las
 * end to end y el script que prepara la demostración. Tenerla escrita dos veces
 * garantizaría que un día la pantalla y la prueba miren cosas distintas.
 *
 * **Los números no se escriben acá.** Salen de `ezra.ts`, que es la
 * transcripción columna por columna del comprobante.
 */

/** El código del renglón que no es mercadería. */
export const CODIGO_DE_LA_BOLSA = '4249';

/**
 * El artículo del catálogo al que corresponde cada código de Ezra.
 *
 * Esto sí se inventa: una base de pruebas vacía no tiene catálogo. Son los
 * cinco de mercadería y nada más.
 */
export const CATALOGO_DE_EZRA: Record<
  string,
  { plu: string; nombre: string; unidad: 'KG' | 'UNIT' }
> = {
  '47': { plu: '3101', nombre: 'Queso cremoso La Paulina', unidad: 'KG' },
  '49': { plu: '3102', nombre: 'Pernil pata celeste mini 1284', unidad: 'KG' },
  '48': { plu: '3103', nombre: 'Queso de maquina dambo La Paulina', unidad: 'KG' },
  '10': { plu: '3104', nombre: 'Jamon cocido mini tradicional Los Calvos', unidad: 'KG' },
  '2514': { plu: '3105', nombre: 'Jamon cocido mini Il Molise', unidad: 'KG' },
  // El 4249 NO está: las bolsas no son un artículo del catálogo. Ver abajo.
};

/**
 * El código con el que Ezra cobra las bolsas del transporte.
 *
 * Son tres bolsas que el proveedor cobra para llevar la compra, no mercadería:
 * se pagan con el resto de la factura y no entran al stock. Antes acá había un
 * artículo inventado —«Bolsa grande», PLU 3106— y eso era el defecto: la compra
 * terminaba moviendo tres kilos de un producto que no existe.
 *
 * La clasificación va atada al **código**, no al texto: si mañana el OCR lee
 * «BOLSA GRANOE», el código sigue siendo 4249.
 */
export const GASTO_DE_EZRA = {
  supplierCode: CODIGO_DE_LA_BOLSA,
  kind: 'EMBALAJE' as const,
  unit: 'UNIT' as const,
  label: 'Bolsas del transporte',
};

/** Los números de comprobante de cada una de las dos. */
export const NUMERO_COMPLETA = EZRA_ENCABEZADO.number;
export const NUMERO_FRENADA = '00000186';

export interface CompraDeEzraSembrada {
  proveedorId: string;
  completa: string;
  frenada: string;
  productos: number;
}

export async function sembrarLaCompraDeEzra(
  prisma: PrismaClient,
  contexto: { sucursalId: string; autorId: string },
): Promise<CompraDeEzraSembrada> {
  const proveedor = await proveedorEzra(prisma);
  const productos = await productosDeEzra(prisma, proveedor.id);
  await gastoDeEzra(prisma, proveedor.id);

  const completa = await facturaDeEzra(prisma, {
    ...contexto,
    proveedorId: proveedor.id,
    numero: NUMERO_COMPLETA,
    totalImpreso: EZRA_PIE.total,
    bolsaSinCodigo: false,
  });

  const frenada = await facturaDeEzra(prisma, {
    ...contexto,
    proveedorId: proveedor.id,
    numero: NUMERO_FRENADA,
    totalImpreso: null,
    bolsaSinCodigo: true,
  });

  return { proveedorId: proveedor.id, completa, frenada, productos: productos.length };
}

/**
 * Ezra, como está en la realidad: **proveedor no habitual**.
 *
 * Se le compró una vez, de urgencia. No tiene condición de pago ni régimen
 * impositivo cargados, y no se le ponen: prestarle los de otro proveedor sería
 * exactamente el error que la vista previa tiene que hacer visible.
 */
async function proveedorEzra(prisma: PrismaClient) {
  const existente = await prisma.supplier.findFirst({ where: { cuit: EZRA_ENCABEZADO.cuit } });
  if (existente) return existente;

  return prisma.supplier.create({
    data: {
      tradeName: EZRA_ENCABEZADO.supplierName,
      legalName: EZRA_ENCABEZADO.legalName,
      cuit: EZRA_ENCABEZADO.cuit,
      aliases: {
        create: {
          alias: EZRA_ENCABEZADO.supplierName,
          normalized: normalizeText(EZRA_ENCABEZADO.supplierName),
        },
      },
    },
  });
}

/**
 * Los artículos del catálogo, cada uno con el código que Ezra le pone.
 *
 * El alias con `supplierCode` es lo que hace que la asociación sea por
 * identificación y no por parecido: es el único camino, junto con la elección
 * de una persona, que la vista previa acepta como inequívoco.
 */
async function productosDeEzra(prisma: PrismaClient, proveedorId: string) {
  const productos = [];
  for (const impreso of EZRA_ARTICULOS_IMPRESOS) {
    const ficha = CATALOGO_DE_EZRA[impreso.codigo];
    // Las bolsas no son artículo: se configuran como gasto, aparte.
    if (!ficha) continue;
    const existente = await prisma.product.findFirst({ where: { internalCode: ficha.plu } });
    if (existente) {
      productos.push(existente);
      continue;
    }
    productos.push(
      await prisma.product.create({
        data: {
          internalCode: ficha.plu,
          normalizedName: ficha.nombre,
          purchaseUnit: ficha.unidad,
          active: true,
          aliases: {
            create: {
              supplierId: proveedorId,
              supplierCode: impreso.codigo,
              alias: impreso.descripcion,
              normalized: normalizeText(impreso.descripcion),
              origin: 'MANUAL',
            },
          },
        },
      }),
    );
  }
  return productos;
}

/**
 * La configuración que dice que el 4249 de Ezra es un gasto, no mercadería.
 *
 * Es lo único que evita que tres bolsas entren como tres kilos de algo. Va
 * atada al código y trae la unidad, porque el papel no la dice.
 */
async function gastoDeEzra(prisma: PrismaClient, proveedorId: string) {
  const existente = await prisma.supplierExpenseCode.findFirst({
    where: { supplierId: proveedorId, supplierCode: GASTO_DE_EZRA.supplierCode },
  });
  if (existente) return existente;

  return prisma.supplierExpenseCode.create({
    data: { supplierId: proveedorId, ...GASTO_DE_EZRA },
  });
}

async function facturaDeEzra(
  prisma: PrismaClient,
  opciones: {
    sucursalId: string;
    autorId: string;
    proveedorId: string;
    numero: string;
    totalImpreso: string | null;
    bolsaSinCodigo: boolean;
  },
) {
  const anterior = await prisma.document.findFirst({
    where: { number: opciones.numero, supplierId: opciones.proveedorId },
  });
  if (anterior) {
    await prisma.documentItem.deleteMany({ where: { documentId: anterior.id } });
    await prisma.document.delete({ where: { id: anterior.id } });
  }

  const documento = await prisma.document.create({
    data: {
      branchId: opciones.sucursalId,
      supplierId: opciones.proveedorId,
      createdById: opciones.autorId,
      readSupplierName: EZRA_ENCABEZADO.legalName,
      readSupplierCuit: EZRA_ENCABEZADO.cuit,
      docType: 'FACTURA',
      letter: EZRA_ENCABEZADO.letter,
      pointOfSale: EZRA_ENCABEZADO.pointOfSale,
      number: opciones.numero,
      fullNumber: `${EZRA_ENCABEZADO.letter} ${EZRA_ENCABEZADO.pointOfSale}-${opciones.numero}`,
      issueDate: new Date(`${EZRA_ENCABEZADO.issueDate}T12:00:00Z`),
      status: 'BORRADOR',
      netTotal: EZRA_PIE.netTotal,
      ivaTotal: EZRA_PIE.iva21,
      perceptionsTotal: '0',
      total: opciones.totalImpreso,
      /*
       * Sin condición de pago, y a propósito.
       *
       * Ezra no tiene ninguna configurada, así que el comprobante no puede
       * traer una: escribir acá un plazo sería inventarle a un proveedor nuevo
       * las condiciones de otro. La pantalla lo dice: «a definir al aplicar».
       */
    },
  });

  for (const [indice, impreso] of EZRA_ARTICULOS_IMPRESOS.entries()) {
    /*
     * El importe del papel ya viene neto: el descuento por renglón está
     * aplicado adentro. El IVA sale de la alícuota del comprobante.
     */
    const neto = impreso.subtotal;
    const total = (Number(neto) * 1.21).toFixed(4);

    /*
     * En la factura frenada, la bolsa se queda sin código legible.
     *
     * Es el caso que la pantalla tiene que bloquear: el renglón está —su
     * importe sigue formando parte del egreso— pero no hay forma de saber a
     * qué artículo cargarle la mercadería, y eso no se resuelve adivinando.
     */
    const sinCodigo = opciones.bolsaSinCodigo && impreso.codigo === CODIGO_DE_LA_BOLSA;

    await prisma.documentItem.create({
      data: {
        documentId: documento.id,
        lineNumber: indice + 1,
        supplierCode: sinCodigo ? null : impreso.codigo,
        description: sinCodigo ? `${impreso.descripcion} (sin codigo legible)` : impreso.descripcion,
        quantity: impreso.cantidad,
        /*
         * Todos los renglones entran en kilos porque es lo que dice la lectura:
         * la columna «Cantidad» imprime 3,000 para las bolsas igual que imprime
         * 4,240 para el queso, y el papel no trae nada que las distinga. La
         * unidad de verdad la pone el catálogo cuando el renglón se asocia.
         */
        unit: 'KG',
        unitNetPrice: impreso.precioConDescuento,
        grossSubtotal: neto,
        netAmount: neto,
        ivaRate: '0.21',
        ivaAmount: (Number(neto) * 0.21).toFixed(4),
        perceptionAmount: '0',
        totalCost: total,
        unitCost: (Number(total) / Number(impreso.cantidad)).toFixed(4),
        productId: null,
        matchMethod: 'NONE',
      },
    });
  }

  return documento.id;
}
