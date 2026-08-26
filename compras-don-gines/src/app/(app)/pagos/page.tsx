import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUserOrRedirect, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import {
  getPaymentCalendar,
  getProximosPagos,
  listPayments,
  type FiltrosDeAgenda,
} from '@/lib/services/payments';
import { prisma } from '@/lib/db';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABEL, PAYMENT_STATUS_LABEL } from '@/lib/domain/payments';
import { Calendario } from './Calendario';
import { Proximos } from './Proximos';
import { arTodayISO, formatDateAr, toISODate } from '@/lib/datetime';
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

/** Las tres formas de mirar la misma agenda. */
const VISTAS = [
  { clave: 'lista', titulo: 'Lista' },
  { clave: 'calendario', titulo: 'Calendario' },
  { clave: 'proximos', titulo: 'Próximos 7 días' },
] as const;

type Vista = (typeof VISTAS)[number]['clave'];

export default async function PaginaPagos({
  searchParams,
}: {
  searchParams: Promise<{
    grupo?: string;
    confirmado?: string;
    vista?: string;
    mes?: string;
    proveedor?: string;
    sucursal?: string;
    estado?: string;
    forma?: string;
  }>;
}) {
  const user = await requireUserOrRedirect();
  if (!hasPermission(user, PERMISSIONS.PAGOS_VER)) redirect('/');

  const parametros = await searchParams;
  const { grupo, confirmado } = parametros;
  const puedeConfirmar = hasPermission(user, PERMISSIONS.PAGOS_CONFIRMAR);
  /*
   * Mover el vencimiento es otro permiso que confirmar el pago.
   *
   * Confirmar registra un hecho —se pagó—; reprogramar cambia lo que la agenda
   * va a mostrar de acá en adelante, y de eso depende con qué plata se cuenta
   * cada semana.
   */
  const puedeReprogramar = hasPermission(user, PERMISSIONS.PAGOS_REPROGRAMAR);
  const hoy = arTodayISO();

  const vista = (VISTAS.find((v) => v.clave === parametros.vista)?.clave ?? 'lista') as Vista;
  const mes = /^\d{4}-\d{2}$/.test(parametros.mes ?? '') ? parametros.mes! : hoy.slice(0, 7);

  const filtros: FiltrosDeAgenda = {
    supplierId: parametros.proveedor || undefined,
    branchId: parametros.sucursal || undefined,
    status: parametros.estado || undefined,
    paymentMethod: parametros.forma || undefined,
  };
  /* Los filtros viajan en la URL para que cambiar de mes no los pierda. */
  const filtrosEnLaUrl = Object.entries({
    proveedor: filtros.supplierId,
    sucursal: filtros.branchId,
    estado: filtros.status,
    forma: filtros.paymentMethod,
  })
    .filter(([, v]) => v)
    .map(([k, v]) => `&${k}=${encodeURIComponent(v!)}`)
    .join('');

  if (vista !== 'lista') {
    const [proveedores, sucursales] = await Promise.all([
      prisma.supplier.findMany({ orderBy: { tradeName: 'asc' }, select: { id: true, tradeName: true } }),
      prisma.branch.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    ]);

    return (
      <>
        <h1>Pagos</h1>
        <Pestanas vista={vista} mes={mes} filtros={filtrosEnLaUrl} />

        <form className="card card-compacta" method="get">
          <input type="hidden" name="vista" value={vista} />
          <input type="hidden" name="mes" value={mes} />
          <div className="fila fila-2">
            <div className="campo">
              <label htmlFor="proveedor">Proveedor</label>
              <select id="proveedor" name="proveedor" defaultValue={filtros.supplierId ?? ''}>
                <option value="">Todos</option>
                {proveedores.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.tradeName}
                  </option>
                ))}
              </select>
            </div>
            <div className="campo">
              <label htmlFor="sucursal">Sucursal</label>
              <select id="sucursal" name="sucursal" defaultValue={filtros.branchId ?? ''}>
                <option value="">Todas</option>
                {sucursales.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="fila fila-2">
            <div className="campo">
              <label htmlFor="estado">Estado</label>
              <select id="estado" name="estado" defaultValue={filtros.status ?? ''}>
                <option value="">Todos</option>
                {Object.entries(PAYMENT_STATUS_LABEL).map(([clave, texto]) => (
                  <option key={clave} value={clave}>
                    {texto}
                  </option>
                ))}
              </select>
            </div>
            <div className="campo">
              <label htmlFor="forma">Forma de pago</label>
              <select id="forma" name="forma" defaultValue={filtros.paymentMethod ?? ''}>
                <option value="">Todas</option>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_METHOD_LABEL[m]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="acciones">
            <button type="submit" className="boton boton-secundario">
              Aplicar filtros
            </button>
          </div>
        </form>

        {vista === 'calendario' ? (
          <Calendario
            calendario={await getPaymentCalendar(user, mes, filtros)}
            hoy={hoy}
            puedeConfirmar={puedeConfirmar}
            puedeReprogramar={puedeReprogramar}
            filtros={filtrosEnLaUrl}
          />
        ) : (
          <Proximos
            dias={await getProximosPagos(user, 7, filtros)}
            hoy={hoy}
            puedeConfirmar={puedeConfirmar}
            puedeReprogramar={puedeReprogramar}
          />
        )}
      </>
    );
  }

  const agenda = await listPayments(user);

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
      <Pestanas vista={vista} mes={mes} filtros={filtrosEnLaUrl} />

      {confirmado ? (
        <p className="mensaje mensaje-ok" role="status">
          El pago quedó confirmado.
        </p>
      ) : null}

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
                      vence={toISODate(schedule.dueDate)}
                      puedeReprogramar={puedeReprogramar}
                      provisoria={schedule.dueDateProvisional}
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

/** Alternar entre las tres vistas de la misma agenda. */
function Pestanas({ vista, mes, filtros }: { vista: Vista; mes: string; filtros: string }) {
  return (
    <div className="pestanas">
      {VISTAS.map((v) => (
        <Link
          key={v.clave}
          href={`/pagos?vista=${v.clave}${v.clave === 'calendario' ? `&mes=${mes}` : ''}${filtros}`}
          className="pestana"
          aria-current={vista === v.clave ? 'page' : undefined}
        >
          {v.titulo}
        </Link>
      ))}
    </div>
  );
}
