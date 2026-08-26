import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUserOrRedirect, hasAnyPermission, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import { estadoAlmacenamiento, formatearBytes } from '@/lib/services/almacenamiento';

export const metadata: Metadata = { title: 'Configuración' };
export const dynamic = 'force-dynamic';

export default async function PaginaConfiguracion() {
  const user = await requireUserOrRedirect();
  const puedeEntrar = hasAnyPermission(user, [
    PERMISSIONS.USUARIOS_GESTIONAR,
    PERMISSIONS.SUCURSALES_GESTIONAR,
    PERMISSIONS.PROVEEDORES_GESTIONAR,
    PERMISSIONS.PRODUCTOS_GESTIONAR,
    PERMISSIONS.ROLES_GESTIONAR,
    PERMISSIONS.AUDITORIA_VER,
    PERMISSIONS.ALMACENAMIENTO_GESTIONAR,
  ]);
  if (!puedeEntrar) redirect('/');

  const [usuarios, sucursales, proveedores, productos, roles, almacenamiento] = await Promise.all([
    prisma.user.count(),
    prisma.branch.count(),
    prisma.supplier.count(),
    prisma.product.count(),
    prisma.role.count(),
    estadoAlmacenamiento(),
  ]);

  const secciones = [
    {
      href: '/configuracion/usuarios',
      titulo: 'Usuarios',
      texto: `${usuarios} usuarios. Altas, bajas, rol y sucursal.`,
      visible: hasPermission(user, PERMISSIONS.USUARIOS_GESTIONAR),
    },
    {
      href: '/configuracion/roles',
      titulo: 'Roles y permisos',
      texto: `${roles} roles. Podés crear roles nuevos sin tocar el código.`,
      visible: hasPermission(user, PERMISSIONS.ROLES_GESTIONAR),
    },
    {
      href: '/configuracion/sucursales',
      titulo: 'Sucursales',
      texto: `${sucursales} sucursales.`,
      visible: hasPermission(user, PERMISSIONS.SUCURSALES_GESTIONAR),
    },
    {
      href: '/configuracion/proveedores',
      titulo: 'Proveedores',
      texto: `${proveedores} proveedores, con sus condiciones de pago y reglas impositivas.`,
      visible: hasPermission(user, PERMISSIONS.PROVEEDORES_GESTIONAR),
    },
    {
      href: '/configuracion/catalogo',
      titulo: 'Catálogo Don Ginés',
      texto:
        'Los artículos con su PLU interno y su familia, tal como los define Control de Stock. ' +
        'Se importan desde ahí: Compras no numera artículos.',
      visible: hasPermission(user, PERMISSIONS.PRODUCTOS_GESTIONAR),
    },
    {
      href: '/configuracion/productos',
      titulo: 'Productos y alias',
      texto: `${productos} productos, con márgenes, descuentos y redondeos.`,
      visible: hasPermission(user, PERMISSIONS.PRODUCTOS_GESTIONAR),
    },
    {
      href: '/configuracion/almacenamiento',
      titulo: 'Almacenamiento',
      texto:
        `${formatearBytes(almacenamiento.usadoBytes)} de ${formatearBytes(almacenamiento.limiteBytes)} ` +
        `(${Math.round(almacenamiento.proporcion * 100)} %). Archivar comprobantes viejos y liberar espacio.`,
      visible: hasPermission(user, PERMISSIONS.ALMACENAMIENTO_GESTIONAR),
    },
    {
      href: '/configuracion/auditoria',
      titulo: 'Auditoría',
      texto: 'Historial de las operaciones sensibles.',
      visible: hasPermission(user, PERMISSIONS.AUDITORIA_VER),
    },
  ].filter((s) => s.visible);

  return (
    <>
      <h1>Configuración</h1>

      {almacenamiento.mensaje && hasPermission(user, PERMISSIONS.ALMACENAMIENTO_GESTIONAR) ? (
        <p
          className={`mensaje ${almacenamiento.bloqueado ? 'mensaje-error' : 'mensaje-aviso'}`}
          role={almacenamiento.bloqueado ? 'alert' : 'status'}
        >
          {almacenamiento.mensaje}
        </p>
      ) : null}
      <ul className="lista">
        {secciones.map((seccion) => (
          <li key={seccion.href}>
            <Link href={seccion.href} className="fila-dato">
              <div className="fila-dato-titulo">{seccion.titulo}</div>
              <div className="chico medio">{seccion.texto}</div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
