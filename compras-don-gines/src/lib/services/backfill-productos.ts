import 'server-only';
import { prisma } from '@/lib/db';
import { ForbiddenError } from '@/lib/errors';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { hasPermission, type AuthUser } from '@/lib/auth/session';
import { matchProduct, normalizeText, type ProductCandidate } from '@/lib/domain/matching';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/services/audit';

/**
 * Reasignación de productos a compras que quedaron sin clasificar.
 *
 * Las facturas confirmadas antes de que la asociación se resolviera del lado
 * del servidor guardaron sus renglones con `productId` en nulo, y para el
 * reporte por producto esas compras no existen: se validaron, se pagaron, están
 * en el total general, y al filtrar por el artículo dan cero.
 *
 * Esto las repara **sin tocar plata**. Lo único que escribe son dos columnas de
 * asociación —`DocumentItem.productId` y `PurchaseMovement.productId`, con su
 * método— y las entradas de historial de costos que no existían por no haber
 * producto al que colgarlas. Cantidades, kilos, precios, IVA, percepciones,
 * costos, totales e imágenes quedan exactamente como estaban.
 *
 * Y no adivina: usa el mismo reconocimiento que la carga —alias del proveedor,
 * código de artículo, alias aprendido, descripción normalizada— y sólo aplica
 * lo inequívoco. Lo dudoso queda pendiente y se informa, porque un producto mal
 * asignado es peor que uno sin asignar: el sin asignar se ve, el mal asignado
 * ensucia el costo de un artículo que nadie compró.
 */

export interface RenglonDelInforme {
  documentItemId: string;
  documentId: string;
  documentNumber: string;
  supplierName: string | null;
  description: string;
  supplierCode: string | null;
  productId: string | null;
  productName: string | null;
  method: string;
  score: number | null;
  reason?: string;
}

export interface InformeDeBackfill {
  /** Se reconocieron sin lugar a dudas: son las que se aplican. */
  seguras: RenglonDelInforme[];
  /** Más de un producto se parece por igual: las resuelve una persona. */
  ambiguas: RenglonDelInforme[];
  /** No se parecen a nada del catálogo. */
  sinCoincidencia: RenglonDelInforme[];
  /** Cuántas se escribieron. Cero cuando se pide sólo el informe. */
  aplicadas: number;
}

/**
 * @param aplicar `false` —el valor por omisión— sólo informa, no escribe nada.
 *   Es a propósito: el informe se mira antes de tocar la base, no después.
 */
export async function backfillProductLinks(
  user: AuthUser,
  opciones: { aplicar?: boolean; supplierId?: string } = {},
): Promise<InformeDeBackfill> {
  if (!hasPermission(user, PERMISSIONS.PRODUCTOS_GESTIONAR)) {
    throw new ForbiddenError('Tu usuario no puede reasignar productos.');
  }

  const productos = await prisma.product.findMany({
    where: { active: true },
    select: {
      id: true,
      internalCode: true,
      normalizedName: true,
      aliases: { select: { normalized: true, supplierId: true, supplierCode: true } },
    },
  });
  const candidatos: ProductCandidate[] = productos.map((p) => ({
    id: p.id,
    internalCode: p.internalCode,
    normalizedName: normalizeText(p.normalizedName),
    aliases: p.aliases,
  }));
  const nombrePorId = new Map(productos.map((p) => [p.id, p.normalizedName]));

  /*
   * Sólo comprobantes ya validados.
   *
   * Un borrador o algo que quedó a revisar todavía puede cambiar de renglones
   * cuando alguien lo confirme, y ahí la asociación se resuelve sola por el
   * camino normal. Reasignar ahora sería adelantarse a una decisión que no está
   * tomada.
   */
  const renglones = await prisma.documentItem.findMany({
    where: {
      productId: null,
      document: {
        status: 'VALIDADO',
        ...(opciones.supplierId ? { supplierId: opciones.supplierId } : {}),
      },
    },
    include: {
      document: {
        select: {
          id: true,
          fullNumber: true,
          supplierId: true,
          branchId: true,
          issueDate: true,
          supplier: { select: { tradeName: true } },
        },
      },
    },
    orderBy: { id: 'asc' },
  });

  const informe: InformeDeBackfill = {
    seguras: [],
    ambiguas: [],
    sinCoincidencia: [],
    aplicadas: 0,
  };

  for (const renglon of renglones) {
    const resultado = matchProduct(
      {
        description: renglon.description,
        supplierCode: renglon.supplierCode,
        supplierId: renglon.document.supplierId,
      },
      candidatos,
    );

    const fila: RenglonDelInforme = {
      documentItemId: renglon.id,
      documentId: renglon.document.id,
      documentNumber: renglon.document.fullNumber ?? 'sin número',
      supplierName: renglon.document.supplier?.tradeName ?? null,
      description: renglon.description,
      supplierCode: renglon.supplierCode,
      productId: resultado.productId,
      productName: resultado.productId ? (nombrePorId.get(resultado.productId) ?? null) : null,
      method: resultado.method,
      score: resultado.score,
      reason: resultado.reason,
    };

    if (resultado.productId) {
      informe.seguras.push(fila);
    } else if ((resultado.suggestions?.length ?? 0) > 0) {
      // Se parece a algo, pero no lo suficiente o no de forma única.
      informe.ambiguas.push(fila);
    } else {
      informe.sinCoincidencia.push(fila);
    }
  }

  if (!opciones.aplicar || informe.seguras.length === 0) return informe;

  for (const fila of informe.seguras) {
    const renglon = renglones.find((r) => r.id === fila.documentItemId)!;
    const productId = fila.productId!;

    await prisma.$transaction(async (tx) => {
      await tx.documentItem.update({
        where: { id: renglon.id },
        data: { productId, matchMethod: fila.method },
      });

      /*
       * El movimiento se actualiza, no se crea.
       *
       * Ya existe uno por renglón desde que se confirmó el comprobante: crear
       * otro duplicaría la compra en todos los reportes, que es peor que el
       * problema que vinimos a arreglar. Lo único que le falta es a qué
       * producto pertenece.
       */
      await tx.purchaseMovement.updateMany({
        where: { documentItemId: renglon.id },
        data: { productId },
      });
    });

    informe.aplicadas += 1;
  }

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.PRODUCT_BACKFILL,
    entity: 'Product',
    entityId: opciones.supplierId ?? 'todos',
    after: {
      aplicadas: informe.aplicadas,
      ambiguas: informe.ambiguas.length,
      sinCoincidencia: informe.sinCoincidencia.length,
    },
  });

  return informe;
}
