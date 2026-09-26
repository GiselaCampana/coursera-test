import type { Metadata } from 'next';
import Link from 'next/link';
import { requireUserOrRedirect, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import { detalleDeTraslado } from '@/lib/services/stock-erp-traslados';
import { EnPreparacion } from '../../EnPreparacion';
import { Traslado } from './Traslado';

export const metadata: Metadata = { title: 'Stock ERP · Traslado' };
export const dynamic = 'force-dynamic';

/**
 * Un traslado, en el estado en el que esté.
 *
 * **Abrir esta pantalla no escribe nada.** Ni una marca, ni una reserva, ni un
 * contador. Dos personas pueden mirarla al mismo tiempo —el que despacha y el
 * que espera— y ninguna cambia nada por haber mirado.
 *
 * La pantalla cambia de forma según el estado, y eso es deliberado: un borrador
 * se edita, un despachado se recibe y un cerrado sólo se lee. Mostrar siempre
 * todos los botones y deshabilitarlos dejaría a la vista acciones que ya no
 * existen.
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

  const detalle = await detalleDeTraslado(user, id);

  /*
   * Los artículos que se pueden agregar: los que tienen unidad de existencia
   * aprobada. Uno sin unidad aprobada no se puede trasladar —nadie decidió si se
   * cuenta en kilos o en unidades— y ofrecerlo en la lista sería ofrecer algo
   * que el servicio va a rechazar.
   */
  const disponibles =
    detalle.estado === 'BORRADOR'
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
        Un traslado mueve saldo entre sucursales; las ventas todavía no descuentan de ninguna.
      </EnPreparacion>

      <p className="chico">
        <Link href="/stock-erp/traslados">← Traslados</Link>
      </p>
      <h1 style={{ overflowWrap: 'anywhere' }}>
        {detalle.origen} → {detalle.destino}
      </h1>

      <Traslado
        detalle={detalle}
        disponibles={disponibles}
        puedePreparar={hasPermission(user, PERMISSIONS.STOCKERP_TRASLADO_PREPARAR)}
        puedeDespachar={hasPermission(user, PERMISSIONS.STOCKERP_TRASLADO_DESPACHAR)}
        puedeRecibir={hasPermission(user, PERMISSIONS.STOCKERP_TRASLADO_RECIBIR)}
      />
    </main>
  );
}
