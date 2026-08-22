import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentUser, hasAnyPermission, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import { branchScopeFilter } from '@/lib/auth/session';
import { Navegacion, type ItemNavegacion } from '@/components/Navegacion';

export default async function LayoutAplicacion({ children }: { children: React.ReactNode }) {
  // Toda página bajo este layout exige sesión. El control vive en el servidor:
  // esconder un enlace en el frontend no es una defensa.
  const user = await getCurrentUser();
  if (!user) redirect('/ingresar');

  const pendientes = await prisma.document.count({
    where: { ...branchScopeFilter(user), status: 'REQUIERE_REVISION' },
  });

  const items: ItemNavegacion[] = [
    { href: '/', etiqueta: 'Inicio', icono: 'inicio' },
    { href: '/comprobantes', etiqueta: 'Comprobantes', icono: 'comprobantes', badge: pendientes },
  ];

  if (hasPermission(user, PERMISSIONS.COMPROBANTES_CARGAR)) {
    items.push({ href: '/nueva-compra', etiqueta: 'Nueva', icono: 'nueva' });
  }
  if (hasPermission(user, PERMISSIONS.PAGOS_VER)) {
    items.push({ href: '/pagos', etiqueta: 'Pagos', icono: 'pagos' });
  }
  if (hasPermission(user, PERMISSIONS.PRECIOS_VER)) {
    items.push({ href: '/precios', etiqueta: 'Precios', icono: 'precios', soloEnMas: true });
  }
  if (hasPermission(user, PERMISSIONS.REPORTES_VER)) {
    items.push({ href: '/compras', etiqueta: 'Compras', icono: 'compras', soloEnMas: true });
  }
  if (
    hasAnyPermission(user, [
      PERMISSIONS.USUARIOS_GESTIONAR,
      PERMISSIONS.SUCURSALES_GESTIONAR,
      PERMISSIONS.PROVEEDORES_GESTIONAR,
      PERMISSIONS.PRODUCTOS_GESTIONAR,
      PERMISSIONS.ROLES_GESTIONAR,
    ])
  ) {
    items.push({
      href: '/configuracion',
      etiqueta: 'Configuración',
      icono: 'configuracion',
      soloEnMas: true,
    });
  }

  return (
    <div className="app">
      <header className="encabezado">
        <div className="encabezado-interior">
          <Link href="/" className="marca">
            <span className="marca-sello" aria-hidden="true">
              DG
            </span>
            Compras Don Ginés
          </Link>
          <div className="usuario-chip">
            <strong>{user.name}</strong>
            <span>{user.branchName ?? user.roleName}</span>
          </div>
        </div>
      </header>

      <Navegacion items={items} />

      <main className="contenido">{children}</main>
    </div>
  );
}
