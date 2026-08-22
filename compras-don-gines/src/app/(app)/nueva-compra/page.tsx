import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireUser, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import { arTodayISO } from '@/lib/datetime';
import { NuevaCompra } from './NuevaCompra';

export const metadata: Metadata = { title: 'Nueva compra' };
export const dynamic = 'force-dynamic';

export default async function PaginaNuevaCompra() {
  const user = await requireUser();
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
      select: { id: true, internalCode: true, normalizedName: true },
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
      }))}
      hoy={arTodayISO()}
      puedeForzar={hasPermission(user, PERMISSIONS.COMPROBANTES_ANULAR)}
    />
  );
}
