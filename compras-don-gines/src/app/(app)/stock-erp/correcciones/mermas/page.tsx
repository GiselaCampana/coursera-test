import type { Metadata } from 'next';
import Link from 'next/link';
import { randomUUID } from 'node:crypto';
import { requireUserOrRedirect, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import {
  interruptorDeCorreccionesReales,
  articulosCorregiblesPorSucursal,
  CATEGORIAS_DE_MERMA,
} from '@/lib/services/stock-erp-correcciones';
import { EnPreparacion } from '../../EnPreparacion';
import { NuevaMerma } from './NuevaMerma';

export const metadata: Metadata = { title: 'Stock ERP · Nueva merma' };
export const dynamic = 'force-dynamic';

/**
 * Registrar una merma: qué se perdió, cuánto y por qué.
 *
 * El identificador de la merma se genera ACÁ, en el servidor, una sola vez por
 * carga de la pantalla. Es lo que hace que dos clics en el botón manden la misma
 * clave idempotente y la segunda vez conteste «ya estaba registrada» en vez de
 * descontar dos veces la misma pérdida.
 */
export default async function Page() {
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

  const [sucursales, porSucursal, interruptor] = await Promise.all([
    prisma.branch.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    /*
     * Los artículos que cada sucursal MANEJA, con unidad aprobada, y no el
     * catálogo entero. Ofrecer un artículo que la sucursal no maneja es hacer que
     * la persona descubra la regla a fuerza de errores; el servidor lo rechazaba
     * igual, y lo sigue rechazando.
     */
    articulosCorregiblesPorSucursal(user),
    interruptorDeCorreccionesReales(),
  ]);

  return (
    <main className="contenido">
      <EnPreparacion>
        Una merma baja el saldo sin ningún comprobante detrás; las ventas todavía no descuentan.
      </EnPreparacion>

      <p className="chico">
        <Link href="/stock-erp/correcciones">← Correcciones</Link>
      </p>
      <h1>Registrar una merma</h1>
      <p className="chico">
        Una merma es una pérdida con <strong>causa conocida</strong>. La cantidad va en positivo: es
        lo que se perdió, no un número con signo. Y el motivo es obligatorio, porque un saldo que baja
        sin explicación es indistinguible de un faltante no declarado.
      </p>

      <NuevaMerma
        mermaId={randomUUID()}
        sucursales={sucursales}
        articulosPorSucursal={porSucursal}
        categorias={[...CATEGORIAS_DE_MERMA]}
        puedeRegistrar={hasPermission(user, PERMISSIONS.STOCKERP_MERMA)}
        interruptorEncendido={interruptor.encendido}
      />
    </main>
  );
}
