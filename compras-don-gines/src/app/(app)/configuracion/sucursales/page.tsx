import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireUser, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import { FormularioConfig, Casilla } from '@/components/FormularioConfig';
import { guardarSucursal } from '../acciones';

export const metadata: Metadata = { title: 'Sucursales' };
export const dynamic = 'force-dynamic';

export default async function PaginaSucursales() {
  const user = await requireUser();
  if (!hasPermission(user, PERMISSIONS.SUCURSALES_GESTIONAR)) redirect('/configuracion');

  const sucursales = await prisma.branch.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { users: true, documents: true } } },
  });

  return (
    <>
      <h1>Sucursales</h1>
      <p className="medio">
        Podés dar de alta las sucursales que hagan falta: la aplicación no está limitada a tres.
      </p>

      <div className="card">
        <FormularioConfig
          titulo="Nueva sucursal"
          textoBoton="Agregar una sucursal"
          accion={guardarSucursal}
        >
          <div className="fila fila-2">
            <div className="campo">
              <label htmlFor="nueva-code">Código</label>
              <input id="nueva-code" name="code" type="text" required placeholder="VILLA_URQUIZA" />
            </div>
            <div className="campo">
              <label htmlFor="nueva-name">Nombre</label>
              <input id="nueva-name" name="name" type="text" required placeholder="Villa Urquiza" />
            </div>
          </div>
          <div className="fila fila-2">
            <div className="campo">
              <label htmlFor="nueva-address">Dirección</label>
              <input id="nueva-address" name="address" type="text" />
            </div>
            <div className="campo">
              <label htmlFor="nueva-phone">Teléfono</label>
              <input id="nueva-phone" name="phone" type="text" inputMode="tel" />
            </div>
          </div>
          <Casilla name="active" etiqueta="Activa" defecto />
        </FormularioConfig>
      </div>

      <ul className="lista">
        {sucursales.map((sucursal) => (
          <li key={sucursal.id} className="fila-dato">
            <div className="fila-dato-cabecera">
              <span className="fila-dato-titulo">{sucursal.name}</span>
              <span className="etiqueta-estado estado-neutro">{sucursal.code}</span>
            </div>
            <div className="fila-dato-meta">
              <span>{sucursal._count.users} usuarios</span>
              <span>{sucursal._count.documents} comprobantes</span>
              <span>{sucursal.active ? 'Activa' : 'Dada de baja'}</span>
            </div>

            <FormularioConfig
              titulo={`Editar ${sucursal.name}`}
              textoBoton="Editar"
              accion={guardarSucursal}
            >
              <input type="hidden" name="id" value={sucursal.id} />
              <div className="fila fila-2">
                <div className="campo">
                  <label htmlFor={`code-${sucursal.id}`}>Código</label>
                  <input
                    id={`code-${sucursal.id}`}
                    name="code"
                    type="text"
                    defaultValue={sucursal.code}
                    required
                  />
                </div>
                <div className="campo">
                  <label htmlFor={`name-${sucursal.id}`}>Nombre</label>
                  <input
                    id={`name-${sucursal.id}`}
                    name="name"
                    type="text"
                    defaultValue={sucursal.name}
                    required
                  />
                </div>
              </div>
              <div className="fila fila-2">
                <div className="campo">
                  <label htmlFor={`address-${sucursal.id}`}>Dirección</label>
                  <input
                    id={`address-${sucursal.id}`}
                    name="address"
                    type="text"
                    defaultValue={sucursal.address ?? ''}
                  />
                </div>
                <div className="campo">
                  <label htmlFor={`phone-${sucursal.id}`}>Teléfono</label>
                  <input
                    id={`phone-${sucursal.id}`}
                    name="phone"
                    type="text"
                    defaultValue={sucursal.phone ?? ''}
                  />
                </div>
              </div>
              <Casilla name="active" etiqueta="Activa" defecto={sucursal.active} />
            </FormularioConfig>
          </li>
        ))}
      </ul>
    </>
  );
}
