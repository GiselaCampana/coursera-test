import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { listPayments } from '@/lib/services/payments';
import { arTodayISO, formatDateAr } from '@/lib/datetime';
import { formatARS, toDecimal } from '@/lib/money';
import { EtiquetaPago } from '@/components/Estado';
import { FichaPago } from './FichaPago';

export const metadata: Metadata = { title: 'Pagos' };
export const dynamic = 'force-dynamic';

const GRUPOS = [
  { clave: 'venceHoy', titulo: 'Vence hoy' },
  { clave: 'vencidos', titulo: 'Vencidos' },
  { clave: 'proximos', titulo: 'Próximos' },
  { clave: 'pagados', titulo: 'Pagados' },
] as const;

export default async function PaginaPagos({
  searchParams,
}: {
  searchParams: Promise<{ grupo?: string }>;
}) {
  const user = await requireUser();
  if (!hasPermission(user, PERMISSIONS.PAGOS_VER)) redirect('/');

  const { grupo } = await searchParams;
  const agenda = await listPayments(user);
  const puedeConfirmar = hasPermission(user, PERMISSIONS.PAGOS_CONFIRMAR);
  const hoy = arTodayISO();

  const activo = (GRUPOS.find((g) => g.clave === grupo)?.clave ?? 'venceHoy') as
    | 'venceHoy'
    | 'vencidos'
    | 'proximos'
    | 'pagados';
  const lista = agenda[activo];

  const totalPendiente = lista.reduce(
    (acc, s) =>
      acc.plus(toDecimal(s.plannedAmount.toString()).minus(toDecimal(s.paidAmount.toString()))),
    toDecimal('0'),
  );

  return (
    <>
      <h1>Pagos</h1>

      <div className="pestanas">
        {GRUPOS.map((g) => (
          <Link
            key={g.clave}
            href={`/pagos?grupo=${g.clave}`}
            className="pestana"
            aria-current={activo === g.clave ? 'page' : undefined}
          >
            {g.titulo}
            <span className="pestana-cuenta">{agenda[g.clave].length}</span>
          </Link>
        ))}
      </div>

      {lista.length === 0 ? (
        <div className="card">
          <div className="vacio">
            <div className="vacio-titulo">
              {activo === 'venceHoy'
                ? 'Hoy no vence ningún pago'
                : activo === 'vencidos'
                  ? 'No hay pagos vencidos'
                  : activo === 'proximos'
                    ? 'No hay pagos agendados'
                    : 'Todavía no hay pagos confirmados'}
            </div>
            <p className="mb0">
              {activo === 'vencidos'
                ? 'Al día con los proveedores.'
                : 'Los comprobantes que confirmes van a aparecer acá.'}
            </p>
          </div>
        </div>
      ) : (
        <>
          {activo !== 'pagados' ? (
            <div className="card card-compacta">
              <dl style={{ margin: 0 }}>
                <div className="dato destacado">
                  <dt>
                    Total a pagar · {lista.length} comprobante{lista.length === 1 ? '' : 's'}
                  </dt>
                  <dd>{formatARS(totalPendiente)}</dd>
                </div>
              </dl>
            </div>
          ) : null}

          <ul className="lista">
            {lista.map((schedule) => (
              <li key={schedule.id}>
                <div className="fila-dato">
                  <div className="fila-dato-cabecera">
                    <span className="fila-dato-titulo">
                      {schedule.document.supplier?.tradeName ?? 'Proveedor sin identificar'}
                    </span>
                    <span className="fila-dato-importe">
                      {formatARS(schedule.plannedAmount.toString())}
                    </span>
                  </div>
                  <div className="fila-dato-meta">
                    <Link href={`/comprobantes/${schedule.documentId}`}>
                      {schedule.document.fullNumber || 'sin número'}
                    </Link>
                    <span>Vence {formatDateAr(schedule.dueDate)}</span>
                    <span>{schedule.document.branch.name}</span>
                  </div>
                  <div className="fila-dato-meta mt">
                    <EtiquetaPago estado={schedule.status} />
                  </div>

                  {schedule.status === 'PAGADO' && schedule.events[0] ? (
                    <p className="chico medio mt mb0">
                      Pagado el {formatDateAr(schedule.events[0].effectiveDate)} por{' '}
                      {schedule.events[0].user.name}
                      {schedule.events[0].reference
                        ? ` · Ref.: ${schedule.events[0].reference}`
                        : ''}
                    </p>
                  ) : null}

                  {puedeConfirmar && schedule.status !== 'PAGADO' && schedule.status !== 'CANCELADO' ? (
                    <FichaPago
                      scheduleId={schedule.id}
                      importePendiente={toDecimal(schedule.plannedAmount.toString())
                        .minus(toDecimal(schedule.paidAmount.toString()))
                        .toFixed(2)}
                      formaDePago={schedule.plannedPaymentMethod}
                      hoy={hoy}
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
