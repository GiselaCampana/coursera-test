import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireUserOrRedirect, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import { arTodayISO } from '@/lib/datetime';
import { env } from '@/lib/env';
import { NuevaCompra } from './NuevaCompra';

export const metadata: Metadata = { title: 'Nueva compra' };
export const dynamic = 'force-dynamic';

/**
 * `?comprobante=<id>` reabre un comprobante que quedó en revisión.
 *
 * Hace falta y no es comodidad: cuando la lectura no alcanza, el comprobante
 * queda guardado en REQUIERE_REVISION con su imagen. Sin esta puerta, cerrar la
 * pestaña lo dejaba varado —existía, tenía la foto, y no había forma de volver
 * a entrar a completarlo—, así que «se puede cargar a mano» habría sido cierto
 * sólo mientras no se recargara la página.
 */
export default async function PaginaNuevaCompra({
  searchParams,
}: {
  searchParams: Promise<{ comprobante?: string }>;
}) {
  const user = await requireUserOrRedirect();
  const { comprobante } = await searchParams;
  if (!hasPermission(user, PERMISSIONS.COMPROBANTES_CARGAR)) redirect('/');

  const [branches, suppliers, products] = await Promise.all([
    prisma.branch.findMany({
      where: {
        active: true,
        ...(user.scopeAllBranches ? {} : { id: user.branchId ?? '__ninguna__' }),
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    prisma.supplier.findMany({
      where: { active: true },
      orderBy: { tradeName: 'asc' },
      select: { id: true, tradeName: true },
    }),
    prisma.product.findMany({
      where: { active: true },
      orderBy: { normalizedName: 'asc' },
      select: {
        id: true,
        internalCode: true,
        normalizedName: true,
        /*
         * Los códigos con que cada proveedor factura este artículo.
         *
         * Van al selector para poder buscarlo escribiendo el código que se ve
         * en el papel: es lo que uno tiene delante cuando está revisando la
         * factura, y muchas veces se recuerda antes que el PLU.
         */
        aliases: {
          where: { supplierCode: { not: null } },
          select: { supplierCode: true },
        },
      },
    }),
  ]);

  return (
    <NuevaCompra
      sucursales={branches.map((b) => ({ id: b.id, nombre: b.name }))}
      sucursalPorDefecto={user.scopeAllBranches ? (branches[0]?.id ?? '') : (user.branchId ?? '')}
      proveedores={suppliers.map((s) => ({ id: s.id, nombre: s.tradeName }))}
      productos={products.map((p) => ({
        id: p.id,
        codigo: p.internalCode,
        nombre: p.normalizedName,
        codigosDeProveedor: p.aliases
          .map((a) => a.supplierCode)
          .filter((c): c is string => Boolean(c)),
      }))}
      hoy={arTodayISO()}
      puedeForzar={hasPermission(user, PERMISSIONS.COMPROBANTES_ANULAR)}
      maximoIntentos={env.ocrMaxAttempts}
      comprobanteId={comprobante?.trim() || null}
    />
  );
}
