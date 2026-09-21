/**
 * **El escenario del despacho manual, sembrado sólo para Playwright.**
 *
 * Existe porque el botón que manda mercadería a Control de Stock es la
 * operación más sensible de la aplicación y no tenía prueba de navegador. Para
 * que aparezca hace falta un comprobante **ya aplicado**, con movimientos
 * pendientes en la bandeja, y ninguno de los que había servía:
 *
 *  - la factura de Ezra de la demo está sin aplicar a propósito, y varias
 *    pruebas afirman justamente eso. Aplicarla acá las rompería, y peor: las
 *    rompería según el orden en que Playwright corriera los archivos, que es
 *    exactamente la clase de acoplamiento que no se quiere;
 *  - meterlo en `sembrar.ts` lo dejaría también en la demostración hospedada,
 *    donde aparecería un comprobante inventado que nadie pidió.
 *
 * Así que esto se siembra aparte, desde la propia prueba, y **no lo llama
 * `sembrar.ts`**: correr el sembrado de la demo no crea ninguna de estas filas.
 *
 * **Un escenario por proyecto.** Los dos proyectos de Playwright —iPhone y
 * escritorio— comparten la base, y esta prueba *muta* lo que ve: despacha, y
 * los movimientos quedan confirmados. Si los dos usaran las mismas filas, el
 * segundo encontraría el trabajo hecho. Por eso cada proyecto recibe su propio
 * proveedor, sus propios artículos y sus propios comprobantes, distinguidos por
 * un sufijo. No hay orden entre ellos ni datos compartidos.
 *
 * **Se puede volver a sembrar.** Empieza borrando lo suyo —y sólo lo suyo, por
 * el proveedor— así que correr la prueba dos veces seguidas deja el mismo
 * estado. No toca ninguna fila de las otras suites.
 */
import type { PrismaClient } from '@prisma/client';
import { claveDelEvento } from '../../src/lib/domain/ingreso-de-stock';
import { cargarEntornoE2E } from './entorno';

/**
 * Un cliente de Prisma con el entorno ya cargado y verificado.
 *
 * Las pruebas corren en procesos que no heredan `.env.e2e`, y esto borra filas:
 * el entorno se carga —y se comprueba contra qué base apunta— antes de que el
 * cliente exista, que es el mismo orden que usa el resto de las pruebas.
 */
async function cliente(): Promise<PrismaClient> {
  cargarEntornoE2E();
  const { PrismaClient: Cliente } = await import('@prisma/client');
  return new Cliente();
}

/**
 * Los cinco artículos, con la cantidad que el papel diría.
 *
 * Los decimales están elegidos para que la representación del contrato se vea:
 * la base guarda `Decimal(14,4)` y el contrato manda tres posiciones, así que
 * «4.2400» tiene que salir como «4.240» y no como «4.24».
 */
export const ARTICULOS_DEL_DESPACHO = [
  { plu: '9101', nombre: 'Provolone barra prueba', kg: '4.2400', contrato: '4.240', mostrado: '4.24' },
  { plu: '9102', nombre: 'Gruyere prueba', kg: '3.9850', contrato: '3.985', mostrado: '3.985' },
  { plu: '9103', nombre: 'Pategras prueba', kg: '7.3450', contrato: '7.345', mostrado: '7.345' },
  { plu: '9104', nombre: 'Sardo prueba', kg: '4.0400', contrato: '4.040', mostrado: '4.04' },
  { plu: '9105', nombre: 'Reggianito prueba', kg: '7.6650', contrato: '7.665', mostrado: '7.665' },
] as const;

/** El gasto: se paga, se ve en el comprobante y no mueve stock. */
export const GASTO_DEL_DESPACHO = 'BOLSA GRANDE DE PRUEBA';

export interface EscenarioDeDespacho {
  /** El comprobante que la prueba despacha. */
  objetivo: { id: string; numero: string; fullNumber: string };
  /** El otro, que el botón del primero no puede tocar nunca. */
  ajeno: { id: string; numero: string; fullNumber: string };
  proveedorId: string;
}

/**
 * Siembra el escenario para un proyecto, borrando antes lo suyo.
 *
 * `sufijo` distingue los datos de cada proyecto de Playwright. Va dentro del
 * CUIT y del número de comprobante para que ni el proveedor ni las facturas se
 * pisen entre proyectos.
 */
export async function sembrarEscenarioDeDespacho(sufijo: string): Promise<EscenarioDeDespacho> {
  const prisma = await cliente();
  try {
    const marca = sufijo.toUpperCase();
    const cuit = `3099${sufijo.length.toString().padStart(2, '0')}${hash(sufijo)}`;

    /*
     * Borrar lo propio antes de crear. Se busca por el proveedor, que es de
     * este escenario y de nadie más: así no hay forma de que este borrado
     * alcance una fila de otra suite.
     */
    const anterior = await prisma.supplier.findFirst({ where: { cuit } });
    if (anterior) {
      const documentos = await prisma.document.findMany({
        where: { supplierId: anterior.id },
        select: { id: true },
      });
      const ids = documentos.map((d) => d.id);
      if (ids.length > 0) {
        await prisma.stockOutbox.deleteMany({ where: { documentId: { in: ids } } });
        await prisma.documentItem.deleteMany({ where: { documentId: { in: ids } } });
        await prisma.document.deleteMany({ where: { id: { in: ids } } });
      }
      await prisma.productAlias.deleteMany({ where: { supplierId: anterior.id } });
      await prisma.product.deleteMany({
        where: { internalCode: { in: ARTICULOS_DEL_DESPACHO.map((a) => `${a.plu}${sufijo}`) } },
      });
      await prisma.supplier.delete({ where: { id: anterior.id } });
    }

    const devoto = await prisma.branch.findFirstOrThrow({ where: { code: 'DEVOTO' } });
    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@e2e.local' } });

    const proveedor = await prisma.supplier.create({
      data: {
        cuit,
        legalName: `Despacho de Prueba ${marca} SRL`,
        tradeName: `Despacho ${marca}`,
      },
    });

    const productos = await Promise.all(
      ARTICULOS_DEL_DESPACHO.map((articulo) =>
        prisma.product.create({
          data: {
            /* El PLU es el código interno: es lo que viaja en el contrato. */
            internalCode: `${articulo.plu}${sufijo}`,
            normalizedName: articulo.nombre,
            category: 'Quesos',
            purchaseUnit: 'KG',
            saleMode: 'FETEABLE',
            defaultSupplierId: proveedor.id,
          },
        }),
      ),
    );

    const objetivo = await crearComprobanteAplicado(prisma, {
      numero: `9000${sufijo.length}001`,
      sucursalId: devoto.id,
      proveedorId: proveedor.id,
      autorId: admin.id,
      productos,
    });

    const ajeno = await crearComprobanteAplicado(prisma, {
      numero: `9000${sufijo.length}002`,
      sucursalId: devoto.id,
      proveedorId: proveedor.id,
      autorId: admin.id,
      productos,
    });

    return { objetivo, ajeno, proveedorId: proveedor.id };
  } finally {
    await prisma.$disconnect();
  }
}

/** Borra todo lo de este escenario. Para dejar la base como estaba. */
export async function limpiarEscenarioDeDespacho(sufijo: string): Promise<void> {
  const prisma = await cliente();
  try {
    const cuit = `3099${sufijo.length.toString().padStart(2, '0')}${hash(sufijo)}`;
    const proveedor = await prisma.supplier.findFirst({ where: { cuit } });
    if (!proveedor) return;

    const documentos = await prisma.document.findMany({
      where: { supplierId: proveedor.id },
      select: { id: true },
    });
    const ids = documentos.map((d) => d.id);
    if (ids.length > 0) {
      await prisma.stockOutbox.deleteMany({ where: { documentId: { in: ids } } });
      await prisma.documentItem.deleteMany({ where: { documentId: { in: ids } } });
      await prisma.document.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.productAlias.deleteMany({ where: { supplierId: proveedor.id } });
    await prisma.product.deleteMany({
      where: { internalCode: { in: ARTICULOS_DEL_DESPACHO.map((a) => `${a.plu}${sufijo}`) } },
    });
    await prisma.supplier.delete({ where: { id: proveedor.id } });
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Un comprobante validado con sus movimientos anotados y pendientes.
 *
 * Se escribe directo y no pasando por `aplicarCompra` porque lo que esta prueba
 * mira es la pantalla del despacho, no el camino de la aplicación —que ya tiene
 * sus propias pruebas—. Lo que **sí** se respeta es la clave de idempotencia:
 * sale de `claveDelEvento`, la misma función que usa la aplicación, para que el
 * fixture no pueda alejarse del formato real sin que nadie se entere.
 *
 * La fecha es fija: nada de lo que se prueba depende de qué día es hoy.
 */
async function crearComprobanteAplicado(
  prisma: PrismaClient,
  datos: {
    numero: string;
    sucursalId: string;
    proveedorId: string;
    autorId: string;
    productos: { id: string; internalCode: string }[];
  },
) {
  const emision = new Date(Date.UTC(2026, 7, 20));

  const documento = await prisma.document.create({
    data: {
      branchId: datos.sucursalId,
      supplierId: datos.proveedorId,
      createdById: datos.autorId,
      validatedById: datos.autorId,
      validatedAt: emision,
      status: 'VALIDADO',
      checkState: 'OK',
      docType: 'FACTURA',
      letter: 'A',
      pointOfSale: '00009',
      number: datos.numero,
      fullNumber: `00009-${datos.numero}`,
      issueDate: emision,
      total: '1000000.00',
      netTotal: '826446.28',
    },
  });

  /* Los cinco de mercadería. */
  const renglones = await Promise.all(
    ARTICULOS_DEL_DESPACHO.map((articulo, i) =>
      prisma.documentItem.create({
        data: {
          documentId: documento.id,
          lineNumber: i + 1,
          description: articulo.nombre.toUpperCase(),
          quantity: articulo.kg,
          unit: 'KG',
          unitNetPrice: '25000.00',
          grossSubtotal: '100000.00',
          netAmount: '100000.00',
          totalCost: '121000.00',
          unitCost: '25000.00',
          productId: datos.productos[i]!.id,
        },
      }),
    ),
  );

  /*
   * Y el gasto. Va sin artículo y clasificado como gasto: queda en el
   * comprobante, se paga, y no genera movimiento de stock. Que esté acá es lo
   * que permite comprobar en el navegador que NO viaja.
   */
  await prisma.documentItem.create({
    data: {
      documentId: documento.id,
      lineNumber: ARTICULOS_DEL_DESPACHO.length + 1,
      description: GASTO_DEL_DESPACHO,
      quantity: '3.0000',
      unit: 'UNIT',
      unitNetPrice: '1000.00',
      grossSubtotal: '3000.00',
      netAmount: '3000.00',
      totalCost: '3630.00',
      unitCost: '1210.00',
      expenseKind: 'EMBALAJE',
    },
  });

  await Promise.all(
    renglones.map((renglon, i) =>
      prisma.stockOutbox.create({
        data: {
          eventKey: claveDelEvento({
            documentId: documento.id,
            documentItemId: renglon.id,
          }),
          documentId: documento.id,
          documentItemId: renglon.id,
          productId: datos.productos[i]!.id,
          branchId: datos.sucursalId,
          supplierId: datos.proveedorId,
          requestedById: datos.autorId,
          plu: datos.productos[i]!.internalCode,
          quantity: ARTICULOS_DEL_DESPACHO[i]!.kg,
          unit: 'KG',
          direction: 'INGRESO',
          occurredAt: emision,
        },
      }),
    ),
  );

  return { id: documento.id, numero: datos.numero, fullNumber: documento.fullNumber };
}

/** Un número estable a partir del nombre del proyecto, para el CUIT. */
function hash(texto: string): string {
  let n = 0;
  for (const letra of texto) n = (n * 31 + letra.charCodeAt(0)) % 100000;
  return n.toString().padStart(5, '0');
}
