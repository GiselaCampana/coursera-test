import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireUser, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import { formatDateTimeAr } from '@/lib/datetime';
import { MIN_PASSWORD_LENGTH } from '@/lib/auth/password';
import { FormularioConfig, Casilla } from '@/components/FormularioConfig';
import { guardarUsuario } from '../acciones';

export const metadata: Metadata = { title: 'Usuarios' };
export const dynamic = 'force-dynamic';

export default async function PaginaUsuarios() {
  const user = await requireUser();
  if (!hasPermission(user, PERMISSIONS.USUARIOS_GESTIONAR)) redirect('/configuracion');

  const [usuarios, roles, sucursales] = await Promise.all([
    prisma.user.findMany({
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
      include: { role: true, branch: true },
    }),
    prisma.role.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
    prisma.branch.findMany({ where: { active: true }, orderBy: { name: 'asc' } }),
  ]);

  const camposComunes = (prefijo: string, valores?: (typeof usuarios)[number]) => (
    <>
      <div className="fila fila-2">
        <div className="campo">
          <label htmlFor={`${prefijo}-name`}>Nombre</label>
          <input
            id={`${prefijo}-name`}
            name="name"
            type="text"
            defaultValue={valores?.name ?? ''}
            required
          />
        </div>
        <div className="campo">
          <label htmlFor={`${prefijo}-email`}>Correo</label>
          <input
            id={`${prefijo}-email`}
            name="email"
            type="email"
            inputMode="email"
            autoCapitalize="none"
            defaultValue={valores?.email ?? ''}
            required
          />
        </div>
      </div>
      <div className="fila fila-2">
        <div className="campo">
          <label htmlFor={`${prefijo}-roleId`}>Rol</label>
          <select id={`${prefijo}-roleId`} name="roleId" defaultValue={valores?.roleId ?? ''}>
            <option value="">Elegí un rol…</option>
            {roles.map((rol) => (
              <option key={rol.id} value={rol.id}>
                {rol.name}
              </option>
            ))}
          </select>
        </div>
        <div className="campo">
          <label htmlFor={`${prefijo}-branchId`}>Sucursal</label>
          <select
            id={`${prefijo}-branchId`}
            name="branchId"
            defaultValue={valores?.branchId ?? ''}
          >
            <option value="">Sin sucursal (ve todas)</option>
            {sucursales.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <p className="ayuda">
            Los roles limitados a una sucursal necesitan que se les asigne una.
          </p>
        </div>
      </div>
      <div className="campo">
        <label htmlFor={`${prefijo}-password`}>
          {valores ? 'Nueva contraseña (dejalo vacío para no cambiarla)' : 'Contraseña inicial'}
        </label>
        <input
          id={`${prefijo}-password`}
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={valores ? undefined : MIN_PASSWORD_LENGTH}
        />
        <p className="ayuda">
          Al menos {MIN_PASSWORD_LENGTH} caracteres, combinando letras y números.
        </p>
      </div>
      <Casilla name="active" etiqueta="Activo" defecto={valores?.active ?? true} />
    </>
  );

  return (
    <>
      <h1>Usuarios</h1>

      <div className="card">
        <FormularioConfig
          titulo="Nuevo usuario"
          textoBoton="Agregar un usuario"
          accion={guardarUsuario}
        >
          {camposComunes('nuevo')}
        </FormularioConfig>
      </div>

      <ul className="lista">
        {usuarios.map((usuario) => (
          <li key={usuario.id} className="fila-dato">
            <div className="fila-dato-cabecera">
              <span className="fila-dato-titulo">{usuario.name}</span>
              <span
                className={`etiqueta-estado ${usuario.active ? 'estado-ok' : 'estado-neutro'}`}
              >
                {usuario.active ? 'Activo' : 'Baja'}
              </span>
            </div>
            <div className="fila-dato-meta">
              <span>{usuario.email}</span>
              <span>{usuario.role.name}</span>
              <span>{usuario.branch?.name ?? 'Todas las sucursales'}</span>
              {usuario.lastLoginAt ? (
                <span>Último ingreso: {formatDateTimeAr(usuario.lastLoginAt)}</span>
              ) : (
                <span>Nunca ingresó</span>
              )}
            </div>
            {usuario.mustChangePassword ? (
              <p className="chico medio mb0">Tiene que cambiar la contraseña en el primer ingreso.</p>
            ) : null}

            <FormularioConfig
              titulo={`Editar ${usuario.name}`}
              textoBoton="Editar"
              accion={guardarUsuario}
            >
              <input type="hidden" name="id" value={usuario.id} />
              {camposComunes(usuario.id, usuario)}
            </FormularioConfig>
          </li>
        ))}
      </ul>
    </>
  );
}
