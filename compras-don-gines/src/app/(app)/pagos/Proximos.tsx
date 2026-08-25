'use client';

import Link from 'next/link';
import { formatARS } from '@/lib/money';
import { formatDateAr } from '@/lib/datetime';
import { PAYMENT_METHOD_LABEL, PAYMENT_STATUS_LABEL } from '@/lib/domain/payments';
import type { DiaDelCalendario } from '@/lib/services/payments';
import { FichaPago } from './FichaPago';

/**
 * Los pagos de la semana, en agenda corta.
 *
 * Es la vista de todos los días: quien abre la aplicación a la mañana quiere
 * saber qué hay que pagar esta semana, no navegar un mes ni abrir un día a la
 * vez. Sale de la misma consulta que el calendario, así que no puede decir algo
 * distinto.
 *
 * Los días vencidos aparecen aunque ya hayan pasado: siguen habiendo que
 * pagarse, y esconderlos porque la fecha quedó atrás sería justamente perder de
 * vista lo que más importa.
 */
export function Proximos({
  dias,
  hoy,
  puedeConfirmar,
}: {
  dias: DiaDelCalendario[];
  hoy: string;
  puedeConfirmar: boolean;
}) {
  if (dias.length === 0) {
    return (
      <div className="card">
        <div className="vacio">
          <div className="vacio-titulo">No hay pagos en los próximos siete días</div>
          <p className="mb0">Al día con los proveedores.</p>
        </div>
      </div>
    );
  }

  return (
    <>
      {dias.map((dia) => (
        <div className="card" key={dia.fecha}>
          <div className="calendario-barra">
            <h2 style={{ margin: 0 }}>
              {formatDateAr(dia.fecha)}
              {dia.fecha === hoy ? ' · hoy' : ''}
              {dia.fecha < hoy ? ' · vencido' : ''}
            </h2>
            <strong>{formatARS(dia.aPagar)}</strong>
          </div>

          <ul className="lista">
            {dia.pagos.map((pago) => (
              <li key={pago.scheduleId}>
                <div className="fila-dato">
                  <div className="fila-dato-cabecera">
                    <span className="fila-dato-titulo">
                      {pago.supplierName ?? 'Proveedor sin identificar'}
                    </span>
                    <span className="fila-dato-importe">{formatARS(pago.saldo)}</span>
                  </div>
                  <div className="fila-dato-meta">
                    <Link href={`/comprobantes/${pago.documentId}`}>{pago.documentNumber}</Link>
                    <span>{pago.branchName}</span>
                    <span>{pago.condicion}</span>
                    <span>{PAYMENT_METHOD_LABEL[pago.paymentMethod] ?? pago.paymentMethod}</span>
                    {/* El estado va escrito, no sólo pintado. */}
                    <span>{PAYMENT_STATUS_LABEL[pago.status]}</span>
                    {pago.provisoria ? <span>Fecha provisoria</span> : null}
                  </div>

                  {puedeConfirmar && pago.status !== 'PAGADO' && pago.status !== 'CANCELADO' ? (
                    <FichaPago
                      scheduleId={pago.scheduleId}
                      importePendiente={pago.saldo}
                      formaDePago={pago.paymentMethod}
                      hoy={hoy}
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}
