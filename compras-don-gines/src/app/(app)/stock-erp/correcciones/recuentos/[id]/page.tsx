import type { Metadata } from 'next';
import Link from 'next/link';
import { requireUserOrRedirect, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import { verRecuento } from '@/lib/services/stock-erp-correcciones';
import { EnPreparacion } from '../../../EnPreparacion';
import { Recuento } from './Recuento';

export const metadata: Metadata = { title: 'Stock ERP · Recuento' };
export const dynamic = 'force-dynamic';

/**
 * Un recuento correctivo: cargar lo contado y confirmar las diferencias.
 *
 * **La pantalla no calcula la diferencia para mandarla.** La muestra porque quien
 * cuenta tiene que ver contra qué está comparando, pero el número que viaja al
 * servidor es la cantidad FÍSICA, y el delta lo vuelve a calcular el servidor
 * contra el saldo que bloquea al confirmar.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUserOrRedirect();

  if (!hasPermission(user, PERMISSIONS.STOCKERP_VER)) {
    return (
      <main className="contenido">
        <p className="mensaje mensaje-error">
          Tu usuario no puede ver Stock ERP. El permiso «stockerp.ver» se pide desde Configuración →
          Roles.
        </p>
      </main>
    );
  }

  const detalle = await verRecuento(user, id);
  const articulos =
    detalle.estado === 'ABIERTA'
      ? await prisma.product.findMany({
          where: { active: true, stockConfig: { status: 'APROBADA' } },
          orderBy: { internalCode: 'asc' },
          select: { id: true, internalCode: true, normalizedName: true },
          take: 500,
        })
      : [];

  return (
    <main className="contenido">
      <EnPreparacion>
        Un ajuste de recuento cambia el saldo sin comprobante; las ventas todavía no descuentan.
      </EnPreparacion>

      <p className="chico">
        <Link href="/stock-erp/correcciones">← Correcciones</Link>
      </p>
      <h1 style={{ overflowWrap: 'anywhere' }}>{detalle.nombre}</h1>

      <Recuento
        detalle={detalle}
        articulos={articulos}
        puedePreparar={hasPermission(user, PERMISSIONS.STOCKERP_RECUENTO_PREPARAR)}
        puedeAjustar={hasPermission(user, PERMISSIONS.STOCKERP_AJUSTE)}
      />
    </main>
  );
}
