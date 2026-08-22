import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireUser, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import { formatDateTimeAr } from '@/lib/datetime';
import { AUDIT_ACTION_LABEL } from '@/lib/services/audit';

export const metadata: Metadata = { title: 'Auditoría' };
export const dynamic = 'force-dynamic';

export default async function PaginaAuditoria({
  searchParams,
}: {
  searchParams: Promise<{ accion?: string }>;
}) {
  const user = await requireUser();
  if (!hasPermission(user, PERMISSIONS.AUDITORIA_VER)) redirect('/configuracion');

  const { accion } = await searchParams;
  const registros = await prisma.auditLog.findMany({
    where: accion ? { action: accion } : {},
    include: { user: { select: { name: true, email: true } } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  return (
    <>
      <h1>Auditoría</h1>
      <p className="medio">
        Las últimas {registros.length} operaciones registradas. Las anulaciones y los guardados
        forzados siempre incluyen el motivo.
      </p>

      {registros.length === 0 ? (
        <div className="card">
          <div className="vacio">
            <div className="vacio-titulo">Todavía no hay operaciones registradas</div>
          </div>
        </div>
      ) : (
        <ul className="lista">
          {registros.map((registro) => (
            <li key={registro.id} className="fila-dato">
              <div className="fila-dato-cabecera">
                <span className="fila-dato-titulo">
                  {AUDIT_ACTION_LABEL[registro.action] ?? registro.action}
                </span>
                <span className="chico">{formatDateTimeAr(registro.createdAt)}</span>
              </div>
              <div className="fila-dato-meta">
                <span>{registro.user?.name ?? 'Sistema'}</span>
                <span>{registro.entity}</span>
                {registro.ip ? <span>{registro.ip}</span> : null}
              </div>
              {registro.reason ? (
                <p className="chico mb0">
                  <strong>Motivo:</strong> {registro.reason}
                </p>
              ) : null}
              {registro.after ? (
                <details>
                  <summary className="chico medio" style={{ cursor: 'pointer' }}>
                    Ver el detalle
                  </summary>
                  <pre
                    className="chico"
                    style={{
                      overflowX: 'auto',
                      background: 'var(--crema-hundida)',
                      padding: 9,
                      borderRadius: 8,
                      margin: '7px 0 0',
                    }}
                  >
                    {JSON.stringify(registro.after, null, 2)}
                  </pre>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
