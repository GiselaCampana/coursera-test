import type { Metadata } from 'next';
import Link from 'next/link';
import { requireUserOrRedirect, hasAnyPermission, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { salir } from '@/app/ingresar/acciones';

export const metadata: Metadata = { title: 'Más' };

export default async function PaginaMas() {
  const user = await requireUserOrRedirect();

  const secciones = [
    {
      href: '/precios',
      titulo: 'Precios',
      texto: 'Costos, variaciones y precios de venta sugeridos.',
      visible: hasPermission(user, PERMISSIONS.PRECIOS_VER),
    },
    {
      href: '/compras',
      titulo: 'Compras',
      texto: 'Historial de kilos, unidades y costos, con exportación.',
      visible: hasPermission(user, PERMISSIONS.REPORTES_VER),
    },
    {
      href: '/configuracion',
      titulo: 'Configuración',
      texto: 'Usuarios, sucursales, proveedores, productos y márgenes.',
      visible: hasAnyPermission(user, [
        PERMISSIONS.USUARIOS_GESTIONAR,
        PERMISSIONS.SUCURSALES_GESTIONAR,
        PERMISSIONS.PROVEEDORES_GESTIONAR,
        PERMISSIONS.PRODUCTOS_GESTIONAR,
        PERMISSIONS.ROLES_GESTIONAR,
      ]),
    },
    {
      href: '/configuracion/auditoria',
      titulo: 'Auditoría',
      texto: 'Quién hizo cada operación sensible y cuándo.',
      visible: hasPermission(user, PERMISSIONS.AUDITORIA_VER),
    },
    {
      href: '/diagnostico',
      titulo: 'Diagnóstico de lectura',
      texto: 'Probar una foto y ver por qué se lee bien o mal. No guarda nada.',
      // Lo ve cualquiera que cargue comprobantes: es quien se topa con el
      // problema y quien puede probar la foto ahí mismo, en el mostrador.
      visible: hasPermission(user, PERMISSIONS.COMPROBANTES_CARGAR),
    },
  ].filter((s) => s.visible);

  return (
    <>
      <h1>Más</h1>

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

      <div className="card mt">
        <h2>Tu sesión</h2>
        <dl style={{ margin: 0 }}>
          <div className="dato">
            <dt>Usuario</dt>
            <dd>{user.name}</dd>
          </div>
          <div className="dato">
            <dt>Correo</dt>
            <dd>{user.email}</dd>
          </div>
          <div className="dato">
            <dt>Rol</dt>
            <dd>{user.roleName}</dd>
          </div>
          <div className="dato">
            <dt>Alcance</dt>
            <dd>{user.scopeAllBranches ? 'Todas las sucursales' : (user.branchName ?? '—')}</dd>
          </div>
        </dl>

        <Link href="/cambiar-contrasena" className="boton boton-secundario boton-bloque mt">
          Cambiar mi contraseña
        </Link>

        <form action={salir} className="mt">
          <button type="submit" className="boton boton-secundario boton-bloque">
            Cerrar sesión
          </button>
        </form>
      </div>
    </>
  );
}
