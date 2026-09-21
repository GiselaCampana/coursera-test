import { prisma } from '@/lib/db';
import { anotarIngresos } from '@/lib/services/stock-ingreso';
import { planDeIngresos, type RenglonParaStock } from '@/lib/domain/ingreso-de-stock';

/**
 * **Anota la bandeja como la anotaba aplicar una compra, antes del retiro.**
 *
 * Aplicar una compra ya **no** escribe en `StockOutbox`: la integración de
 * escritura con Control de Stock está retirada. Pero la bandeja, el transporte
 * y el contrato siguen existiendo, y su retiro definitivo es una etapa aparte.
 *
 * Las pruebas que documentan ese contrato —qué cuerpo viaja, cómo se lee cada
 * código de estado, que la clave no se regenera en un reintento, que un lote a
 * medias no se marca completado— **no perdieron valor**: describen el sistema
 * que todavía está en el árbol y que alguien va a tener que desarmar. Lo único
 * que cambió es de dónde salen las filas que examinan.
 *
 * Por eso existe esta función: reemplaza el paso de *preparación* de esas
 * pruebas y no toca ni una de sus afirmaciones. Arma el plan con la misma
 * `planDeIngresos` que usaba la compra y llama a `anotarIngresos`, que es
 * literalmente la línea que se retiró de `confirmDocument`.
 *
 * No la usa ningún código de la aplicación, y no debe usarla: vive en
 * `tests/fixtures` justamente para que anotar la bandeja sea algo que sólo
 * puede pasar dentro de una prueba.
 */
export async function anotarLaBandejaComoAntes(
  documentId: string,
  opciones?: { requestedById?: string | null },
): Promise<number> {
  const documento = await prisma.document.findUniqueOrThrow({
    where: { id: documentId },
    select: {
      id: true,
      branchId: true,
      supplierId: true,
      issueDate: true,
      items: {
        orderBy: { lineNumber: 'asc' },
        select: {
          id: true,
          lineNumber: true,
          description: true,
          quantity: true,
          unit: true,
          productId: true,
          expenseKind: true,
        },
      },
    },
  });

  const idsDeProducto = documento.items
    .map((i) => i.productId)
    .filter((id): id is string => id !== null);
  const productos = idsDeProducto.length
    ? await prisma.product.findMany({
        where: { id: { in: [...new Set(idsDeProducto)] } },
        select: { id: true, internalCode: true, purchaseUnit: true },
      })
    : [];
  const porId = new Map(productos.map((p) => [p.id, p]));

  const plan = planDeIngresos(
    documento.items.map((item): RenglonParaStock => {
      const producto = item.productId ? porId.get(item.productId) : undefined;
      return {
        documentItemId: item.id,
        lineNumber: item.lineNumber,
        description: item.description,
        quantity: item.quantity.toString(),
        unit: item.unit,
        producto: producto
          ? { id: producto.id, plu: producto.internalCode, purchaseUnit: producto.purchaseUnit }
          : null,
        esGasto: item.expenseKind !== null,
      };
    }),
  );

  if (plan.impedimentos.length > 0) {
    throw new Error(
      `El escenario de la prueba tiene impedimentos de stock: ${plan.impedimentos
        .map((i) => i.motivo)
        .join(' ')}`,
    );
  }

  await prisma.$transaction(async (tx) => {
    await anotarIngresos(tx, {
      documentId: documento.id,
      branchId: documento.branchId,
      supplierId: documento.supplierId,
      requestedById: opciones?.requestedById ?? null,
      occurredAt: documento.issueDate ?? new Date(),
      ingresos: plan.ingresos,
    });
  });

  return plan.ingresos.length;
}
