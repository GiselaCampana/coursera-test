import type { Metadata } from 'next';
import Link from 'next/link';
import { requireUserOrRedirect, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import { formatCorteAr } from '@/lib/datetime';
import { AUDIT_ACTION_LABEL } from '@/lib/services/audit';
import { auditoriaDeStockErp, ACCIONES_DE_STOCK_ERP } from '@/lib/services/stock-erp-consultas';
import { EnPreparacion } from '../EnPreparacion';

export const metadata: Metadata = { title: 'Stock ERP · Auditoría' };
export const dynamic = 'force-dynamic';

/**
 * La auditoría de Stock ERP, sobre el `AuditLog` que ya existe.
 *
 * **No crea un segundo registro** y **no ofrece modificar ni borrar nada**: no
 * hay formulario de escritura, no hay acción de servidor y no hay botón. Una
 * auditoría que se puede editar desde la pantalla que la muestra no es una
 * auditoría; es un borrador.
 */

/** Un valor guardado en `before`/`after`, escrito para que se pueda leer. */
function comoTexto(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === 'string') return valor;
  if (typeof valor === 'number' || typeof valor === 'boolean') return String(valor);
  try {
    return Object.entries(valor as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
      .join(' · ');
  } catch {
    return null;
  }
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ usuario?: string; accion?: string; q?: string; desde?: string; hasta?: string }>;
}) {
  const f = await searchParams;
  const user = await requireUserOrRedirect();

  if (!hasPermission(user, PERMISSIONS.STOCKERP_AUDITORIA_VER)) {
    return (
      <main className="contenido">
        <EnPreparacion />
        <p className="mensaje mensaje-error" data-prueba="sin-permiso">
          Tu usuario no puede ver la auditoría de Stock ERP. El permiso «stockerp.auditoria.ver» se
          pide desde Configuración → Roles.
        </p>
      </main>
    );
  }

  const usuarios = await prisma.user.findMany({
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  const comoFecha = (t?: string) => (t && /^\d{4}-\d{2}-\d{2}$/.test(t) ? new Date(`${t}T00:00:00Z`) : undefined);
  const asientos = await auditoriaDeStockErp(user, {
    usuarioId: f.usuario || undefined,
    accion: f.accion || undefined,
    texto: f.q || undefined,
    desde: comoFecha(f.desde),
    hasta: f.hasta && /^\d{4}-\d{2}-\d{2}$/.test(f.hasta) ? new Date(`${f.hasta}T23:59:59.999Z`) : undefined,
    limite: 200,
  });

  return (
    <main className="contenido">
      <EnPreparacion />

      <p className="chico">
        <Link href="/stock-erp/existencias">← Existencias</Link>{' '}
        <Link href="/stock-erp/movimientos">Movimientos →</Link>{' '}
        <Link href="/stock-erp/traslados">Traslados →</Link>{' '}
        <Link href="/stock-erp/integridad">Integridad →</Link>
      </p>
      <h1>Auditoría de Stock ERP</h1>
      <p className="chico" data-prueba="solo-lectura">
        Esta pantalla <strong>sólo lee</strong>. No hay forma de modificar ni borrar un asiento desde
        acá, y no la va a haber: una auditoría que se puede editar no sirve para responder qué pasó.
      </p>

      <form
        method="get"
        data-prueba="form-filtros"
        style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-end' }}
      >
        <div style={{ flex: '1 1 150px', minWidth: 0 }}>
          <label className="etiqueta" htmlFor="q">
            Buscar
          </label>
          <input id="q" name="q" type="search" defaultValue={f.q ?? ''} placeholder="Entidad, id o motivo" data-prueba="buscar" />
        </div>
        <div style={{ flex: '1 1 160px', minWidth: 0 }}>
          <label className="etiqueta" htmlFor="usuario">
            Usuario
          </label>
          <select id="usuario" name="usuario" defaultValue={f.usuario ?? ''} data-prueba="filtro-usuario">
            <option value="">Todos</option>
            {usuarios.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <label className="etiqueta" htmlFor="accion">
            Acción
          </label>
          <select id="accion" name="accion" defaultValue={f.accion ?? ''} data-prueba="filtro-accion">
            <option value="">Todas las de Stock ERP</option>
            {ACCIONES_DE_STOCK_ERP.map((a) => (
              <option key={a} value={a}>
                {AUDIT_ACTION_LABEL[a] ?? a}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: '1 1 130px', minWidth: 0 }}>
          <label className="etiqueta" htmlFor="desde">
            Desde
          </label>
          <input id="desde" name="desde" type="date" defaultValue={f.desde ?? ''} data-prueba="desde" />
        </div>
        <div style={{ flex: '1 1 130px', minWidth: 0 }}>
          <label className="etiqueta" htmlFor="hasta">
            Hasta
          </label>
          <input id="hasta" name="hasta" type="date" defaultValue={f.hasta ?? ''} data-prueba="hasta" />
        </div>
        <button type="submit" className="boton-secundario" data-prueba="aplicar">
          Filtrar
        </button>
      </form>

      <p className="chico" data-prueba="cuenta">
        {asientos.length} asientos
      </p>

      {asientos.length === 0 && (
        <p className="chico" data-prueba="vacio">
          No hay asientos con esos filtros.
        </p>
      )}

      {asientos.map((a) => {
        const antes = comoTexto(a.antes);
        const despues = comoTexto(a.despues);
        return (
          <article className="tarjeta" key={a.id} data-prueba="asiento" data-accion={a.accion}>
            <header style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <strong style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }} data-prueba="etiqueta">
                {a.etiqueta}
              </strong>
              <span className="chico" data-prueba="cuando">
                {formatCorteAr(a.createdAt)}
              </span>
            </header>

            <p className="chico" data-prueba="quien">
              {a.usuario ?? 'Sin usuario registrado'} · {a.entidad}
              {a.entidadId ? ` ${a.entidadId}` : ''}
            </p>

            {a.motivo && (
              <p className="chico" data-prueba="motivo" style={{ overflowWrap: 'anywhere' }}>
                Motivo: {a.motivo}
              </p>
            )}

            {(antes || despues) && (
              <dl
                style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 8px', margin: '8px 0' }}
              >
                {antes && (
                  <>
                    <dt className="chico">Antes</dt>
                    <dd className="chico" style={{ margin: 0, overflowWrap: 'anywhere' }} data-prueba="antes">
                      {antes}
                    </dd>
                  </>
                )}
                {despues && (
                  <>
                    <dt className="chico">Después</dt>
                    <dd className="chico" style={{ margin: 0, overflowWrap: 'anywhere' }} data-prueba="despues">
                      {despues}
                    </dd>
                  </>
                )}
              </dl>
            )}
          </article>
        );
      })}
    </main>
  );
}
