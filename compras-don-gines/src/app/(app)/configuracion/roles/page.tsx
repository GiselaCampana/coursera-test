import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireUserOrRedirect, hasPermission } from '@/lib/auth/session';
import { ALL_PERMISSIONS, PERMISSIONS, PERMISSION_LABEL } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import { FormularioConfig, Casilla } from '@/components/FormularioConfig';
import { guardarRol } from '../acciones';

export const metadata: Metadata = { title: 'Roles y permisos' };
export const dynamic = 'force-dynamic';

function Permisos({ prefijo, seleccionados }: { prefijo: string; seleccionados?: string[] }) {
  return (
    <fieldset style={{ border: 'none', padding: 0, margin: '0 0 12px' }}>
      <legend className="etiqueta">Permisos</legend>
      {ALL_PERMISSIONS.map((permiso) => (
        <label
          key={permiso}
          className="chico"
          style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '5px 0' }}
        >
          <input
            type="checkbox"
            name="permissions"
            value={permiso}
            defaultChecked={seleccionados?.includes(permiso)}
            style={{ width: 'auto', minHeight: 0 }}
            id={`${prefijo}-${permiso}`}
          />
          {PERMISSION_LABEL[permiso]}
        </label>
      ))}
    </fieldset>
  );
}

export default async function PaginaRoles() {
  const user = await requireUserOrRedirect();
  if (!hasPermission(user, PERMISSIONS.ROLES_GESTIONAR)) redirect('/configuracion');

  const roles = await prisma.role.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { users: true } } },
  });

  return (
    <>
      <h1>Roles y permisos</h1>
      <p className="medio">
        Los roles se definen acá, no en el código: podés crear un supervisor, un encargado o un
        contador y darle exactamente los permisos que necesite.
      </p>

      <div className="card">
        <FormularioConfig titulo="Nuevo rol" textoBoton="Crear un rol" accion={guardarRol}>
          <div className="fila fila-2">
            <div className="campo">
              <label htmlFor="rol-code">Código</label>
              <input id="rol-code" name="code" type="text" required placeholder="ENCARGADO" />
            </div>
            <div className="campo">
              <label htmlFor="rol-name">Nombre</label>
              <input id="rol-name" name="name" type="text" required placeholder="Encargado" />
            </div>
          </div>
          <div className="campo">
            <label htmlFor="rol-description">Descripción</label>
            <input id="rol-description" name="description" type="text" />
          </div>
          <Permisos prefijo="nuevo" />
          <Casilla
            name="scopeAllBranches"
            etiqueta="Ve todas las sucursales (si no, queda limitado a la suya)"
          />
          <Casilla name="active" etiqueta="Activo" defecto />
        </FormularioConfig>
      </div>

      <ul className="lista">
        {roles.map((rol) => (
          <li key={rol.id} className="fila-dato">
            <div className="fila-dato-cabecera">
              <span className="fila-dato-titulo">{rol.name}</span>
              <span className="etiqueta-estado estado-neutro">{rol.code}</span>
            </div>
            <div className="fila-dato-meta">
              <span>{rol._count.users} usuarios</span>
              <span>{rol.permissions.length} permisos</span>
              <span>{rol.scopeAllBranches ? 'Todas las sucursales' : 'Sólo su sucursal'}</span>
              <span>{rol.active ? 'Activo' : 'Inactivo'}</span>
            </div>
            {rol.description ? <p className="chico medio mb0">{rol.description}</p> : null}

            <FormularioConfig titulo={`Editar ${rol.name}`} textoBoton="Editar" accion={guardarRol}>
              <input type="hidden" name="id" value={rol.id} />
              <div className="fila fila-2">
                <div className="campo">
                  <label htmlFor={`rol-code-${rol.id}`}>Código</label>
                  <input
                    id={`rol-code-${rol.id}`}
                    name="code"
                    type="text"
                    defaultValue={rol.code}
                    required
                    readOnly={rol.isSystem}
                  />
                  {rol.isSystem ? (
                    <p className="ayuda">Es un rol del sistema: el código no se cambia.</p>
                  ) : null}
                </div>
                <div className="campo">
                  <label htmlFor={`rol-name-${rol.id}`}>Nombre</label>
                  <input
                    id={`rol-name-${rol.id}`}
                    name="name"
                    type="text"
                    defaultValue={rol.name}
                    required
                  />
                </div>
              </div>
              <div className="campo">
                <label htmlFor={`rol-desc-${rol.id}`}>Descripción</label>
                <input
                  id={`rol-desc-${rol.id}`}
                  name="description"
                  type="text"
                  defaultValue={rol.description ?? ''}
                />
              </div>
              <Permisos prefijo={rol.id} seleccionados={rol.permissions} />
              <Casilla
                name="scopeAllBranches"
                etiqueta="Ve todas las sucursales"
                defecto={rol.scopeAllBranches}
              />
              <Casilla name="active" etiqueta="Activo" defecto={rol.active} />
            </FormularioConfig>
          </li>
        ))}
      </ul>
    </>
  );
}
