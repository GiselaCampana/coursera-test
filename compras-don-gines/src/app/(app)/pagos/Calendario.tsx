'use client';

import { useState } from 'react';
import Link from 'next/link';
import { formatARS } from '@/lib/money';
import { formatDateAr } from '@/lib/datetime';
import { PAYMENT_METHOD_LABEL, PAYMENT_STATUS_LABEL } from '@/lib/domain/payments';
import type { CalendarioDePagos, DiaDelCalendario } from '@/lib/services/payments';
import { FichaPago } from './FichaPago';

/**
 * La agenda de pagos vista como calendario.
 *
 * No reemplaza a la lista: son la misma información mirada de dos formas, y las
 * dos salen de la misma consulta. La lista sirve para trabajar comprobante por
 * comprobante; el calendario, para ver de un vistazo cómo se reparte la plata a
 * lo largo del mes y darse cuenta de que el jueves 12 vencen cuatro facturas.
 *
 * En el teléfono la celda de un día no puede contener el detalle de sus pagos:
 * no entra, y apretarlo todo lo vuelve ilegible. Cada día muestra tres cosas
 * —importe, cuántos son y en qué estado está el más urgente— y el detalle se
 * abre en un panel abajo. Es la misma decisión que toma cualquier app de
 * calendario en un teléfono, y por la misma razón.
 */

const DIAS_DE_LA_SEMANA = ['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá', 'Do'];

/**
 * Cómo se marca cada estado, sin depender del color.
 *
 * El color solo no alcanza: hay quien no lo distingue, y una pantalla al sol en
 * la vereda del depósito tampoco. Cada estado lleva además un signo y su nombre
 * escrito en el detalle.
 */
const MARCA: Record<string, { signo: string; clase: string; texto: string }> = {
  VENCIDO: { signo: '!', clase: 'dia-vencido', texto: 'Vencido' },
  VENCE_HOY: { signo: '•', clase: 'dia-hoy', texto: 'Vence hoy' },
  AGENDADO: { signo: '›', clase: 'dia-agendado', texto: 'Agendado' },
  PAGADO: { signo: '✓', clase: 'dia-pagado', texto: 'Pagado' },
  CANCELADO: { signo: '×', clase: 'dia-cancelado', texto: 'Cancelado' },
};

function mesAnterior(mes: string): string {
  const [a, m] = mes.split('-').map(Number);
  return m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, '0')}`;
}

function mesSiguiente(mes: string): string {
  const [a, m] = mes.split('-').map(Number);
  return m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, '0')}`;
}

const NOMBRE_DEL_MES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

function tituloDelMes(mes: string): string {
  const [a, m] = mes.split('-').map(Number);
  return `${NOMBRE_DEL_MES[m - 1]} de ${a}`;
}

/**
 * Las casillas del mes, incluidas las vacías del principio.
 *
 * La semana arranca el lunes, que es como se mira un calendario de trabajo acá.
 */
function casillasDelMes(mes: string): (string | null)[] {
  const [anio, numero] = mes.split('-').map(Number);
  const primero = new Date(Date.UTC(anio, numero - 1, 1));
  const diasEnElMes = new Date(Date.UTC(anio, numero, 0)).getUTCDate();
  // getUTCDay da 0 para domingo; se corre para que el lunes sea 0.
  const arranque = (primero.getUTCDay() + 6) % 7;

  const casillas: (string | null)[] = Array(arranque).fill(null);
  for (let d = 1; d <= diasEnElMes; d++) {
    casillas.push(`${mes}-${String(d).padStart(2, '0')}`);
  }
  return casillas;
}

export function Calendario({
  calendario,
  hoy,
  puedeConfirmar,
  filtros,
}: {
  calendario: CalendarioDePagos;
  /** "YYYY-MM-DD" de hoy, calculado en el servidor con la zona horaria de acá. */
  hoy: string;
  puedeConfirmar: boolean;
  /** Los filtros vigentes, para conservarlos al cambiar de mes. */
  filtros: string;
}) {
  const [abierto, setAbierto] = useState<string | null>(null);

  const porFecha = new Map<string, DiaDelCalendario>(calendario.dias.map((d) => [d.fecha, d]));
  const casillas = casillasDelMes(calendario.mes);
  const diaAbierto = abierto ? porFecha.get(abierto) : null;

  const enlace = (mes: string) => `/pagos?vista=calendario&mes=${mes}${filtros}`;

  return (
    <>
      <div className="card card-compacta">
        <div className="calendario-barra">
          <Link href={enlace(mesAnterior(calendario.mes))} className="boton boton-secundario">
            ‹ Mes anterior
          </Link>
          <strong className="calendario-titulo">{tituloDelMes(calendario.mes)}</strong>
          <Link href={enlace(mesSiguiente(calendario.mes))} className="boton boton-secundario">
            Mes siguiente ›
          </Link>
        </div>
        <div className="acciones" style={{ marginTop: 8 }}>
          <Link href={enlace(hoy.slice(0, 7))} className="boton boton-secundario">
            Hoy
          </Link>
        </div>
      </div>

      <div className="card card-compacta">
        <dl className="resumen-mes" style={{ margin: 0 }}>
          <div className="dato destacado">
            <dt>Total previsto del mes</dt>
            <dd>{formatARS(calendario.totales.previsto)}</dd>
          </div>
          <div className="dato">
            <dt>Pagado</dt>
            <dd>{formatARS(calendario.totales.pagado)}</dd>
          </div>
          <div className="dato">
            <dt>Pendiente</dt>
            <dd>{formatARS(calendario.totales.pendiente)}</dd>
          </div>
          <div className="dato">
            <dt>Vencido</dt>
            <dd>{formatARS(calendario.totales.vencido)}</dd>
          </div>
        </dl>
      </div>

      <div className="card">
        <div className="calendario-grilla" role="grid" aria-label={`Pagos de ${tituloDelMes(calendario.mes)}`}>
          {DIAS_DE_LA_SEMANA.map((d) => (
            <div key={d} className="calendario-encabezado" role="columnheader">
              {d}
            </div>
          ))}

          {casillas.map((fecha, i) => {
            if (!fecha) return <div key={`vacia-${i}`} className="calendario-celda vacia" />;
            const dia = porFecha.get(fecha);
            const numero = Number(fecha.slice(-2));
            const marca = dia?.estado ? MARCA[dia.estado] : null;
            const esHoy = fecha === hoy;

            if (!dia) {
              return (
                <div
                  key={fecha}
                  className={`calendario-celda${esHoy ? ' es-hoy' : ''}`}
                  role="gridcell"
                >
                  <span className="calendario-numero">{numero}</span>
                </div>
              );
            }

            return (
              <button
                key={fecha}
                type="button"
                role="gridcell"
                className={`calendario-celda con-pagos ${marca?.clase ?? ''}${
                  esHoy ? ' es-hoy' : ''
                }${abierto === fecha ? ' abierta' : ''}`}
                onClick={() => setAbierto(abierto === fecha ? null : fecha)}
                aria-label={
                  `${formatDateAr(fecha)}: ${dia.cantidad} pago${dia.cantidad === 1 ? '' : 's'}, ` +
                  `${dia.aPagar} pendiente${marca ? `, ${marca.texto}` : ''}` +
                  `${dia.hayProvisorias ? ', fecha provisoria' : ''}`
                }
              >
                <span className="calendario-numero">{numero}</span>
                <span className="calendario-importe">{formatARS(dia.aPagar)}</span>
                <span className="calendario-marca">
                  {marca ? <span aria-hidden="true">{marca.signo}</span> : null}
                  {dia.cantidad}
                  {dia.hayProvisorias ? <span aria-hidden="true"> ~</span> : null}
                </span>
              </button>
            );
          })}
        </div>

        {calendario.dias.length === 0 ? (
          <div className="vacio">
            <div className="vacio-titulo">No hay pagos agendados este mes</div>
            <p className="mb0">Probá con otro mes o sacá algún filtro.</p>
          </div>
        ) : null}
      </div>

      {diaAbierto ? (
        <div className="card panel-dia" role="region" aria-label={`Pagos del ${formatDateAr(diaAbierto.fecha)}`}>
          <div className="calendario-barra">
            <h2 style={{ margin: 0 }}>{formatDateAr(diaAbierto.fecha)}</h2>
            <button type="button" className="boton boton-secundario" onClick={() => setAbierto(null)}>
              Cerrar
            </button>
          </div>

          <ul className="lista">
            {diaAbierto.pagos.map((pago) => (
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
                  </div>
                  <div className="fila-dato-meta mt">
                    {/* El estado va escrito, no sólo pintado. */}
                    <span className={`etiqueta ${MARCA[pago.status]?.clase ?? ''}`}>
                      {PAYMENT_STATUS_LABEL[pago.status]}
                    </span>
                    {pago.provisoria ? (
                      <span className="etiqueta">
                        Fecha provisoria · se confirma cuando llegue la próxima factura
                      </span>
                    ) : null}
                    {Number(pago.paidAmount) > 0 && pago.status !== 'PAGADO' ? (
                      <span className="etiqueta">
                        Pago parcial: {formatARS(pago.paidAmount)} de{' '}
                        {formatARS(pago.plannedAmount)}
                      </span>
                    ) : null}
                  </div>

                  <div className="acciones mt">
                    <Link
                      href={`/comprobantes/${pago.documentId}`}
                      className="boton boton-secundario"
                    >
                      Abrir el comprobante
                    </Link>
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
      ) : null}
    </>
  );
}
