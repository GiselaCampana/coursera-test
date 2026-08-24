import { IconoAlerta, IconoGuion, IconoInfo, IconoTilde } from '@/components/Iconos';
import type { CheckResult, ValidationReport } from '@/lib/domain/validation';

/**
 * Semáforo del control contable.
 *
 * Verde sólo cuando artículos, neto, impuestos y total están realmente
 * controlados. Amarillo cuando hizo falta corregir la lectura pero reconcilió.
 * Rojo cuando el detalle no coincide, y en ese caso el guardado queda bloqueado.
 */
export function Semaforo({ report }: { report: ValidationReport | null }) {
  if (!report || report.state === 'PENDIENTE') {
    return (
      <div className="semaforo semaforo-neutro">
        <span className="semaforo-punto" aria-hidden="true" />
        <div className="semaforo-cuerpo">
          <strong>Sin controlar</strong>
          <span>Todavía no se leyó el comprobante.</span>
        </div>
      </div>
    );
  }

  if (report.state === 'DIFERENCIA') {
    const errores = report.checks.filter((c) => c.severity === 'ERROR');
    return (
      <div className="semaforo semaforo-error" role="alert">
        <span className="semaforo-punto" aria-hidden="true" />
        <div className="semaforo-cuerpo">
          <strong>El detalle no coincide con el comprobante</strong>
          <span>
            {errores.length === 1
              ? errores[0].message
              : `Hay ${errores.length} controles que no cierran. No se puede guardar como controlado hasta resolverlos.`}
          </span>
        </div>
      </div>
    );
  }

  if (report.state === 'RECONCILIADO') {
    return (
      <div className="semaforo semaforo-aviso">
        <span className="semaforo-punto" aria-hidden="true" />
        <div className="semaforo-cuerpo">
          <strong>Comprobante controlado, con correcciones</strong>
          <span>
            Hizo falta más de una lectura, pero los artículos, el neto, los impuestos y el total
            cierran. Conviene repasar el detalle antes de guardar.
          </span>
          <NotaDeConciliacion report={report} />
        </div>
      </div>
    );
  }

  return (
    <div className="semaforo semaforo-ok">
      <span className="semaforo-punto" aria-hidden="true" />
      <div className="semaforo-cuerpo">
        <strong>Comprobante controlado</strong>
        <span>Los artículos, el neto, los impuestos y el total coinciden con lo impreso.</span>
        <NotaDeConciliacion report={report} />
      </div>
    </div>
  );
}

/**
 * "Se conciliaron automáticamente $0,51 por diferencias de centavos de OCR".
 *
 * Va en cualquier estado en que el comprobante se pueda guardar, no sólo en el
 * verde: que además haya hecho falta releer no quita que un importe no sea
 * exactamente el que se leyó de la foto, y eso se dice siempre.
 *
 * En chico y debajo del estado porque el comprobante *está* controlado —la
 * corrección sólo se aplica cuando el renglón ya coincidía hasta los pesos y
 * las diferencias empujan hacia lo que le falta al detalle—, pero quien mira la
 * pantalla tiene derecho a enterarse sin ir a buscarlo.
 */
function NotaDeConciliacion({ report }: { report: ValidationReport }) {
  if (!report.reconciliation) return null;
  return <span className="semaforo-nota">{report.reconciliation.mensaje}</span>;
}

export function ListaControles({ checks }: { checks: CheckResult[] }) {
  if (checks.length === 0) return null;
  // Primero lo que falla: es lo que hay que resolver.
  const orden = { ERROR: 0, WARN: 1, OK: 2 } as const;
  const ordenados = [...checks].sort((a, b) => orden[a.severity] - orden[b.severity]);

  return (
    <ul className="controles">
      {ordenados.map((check) => {
        const clase =
          check.severity === 'ERROR'
            ? 'control control-error'
            : check.severity === 'WARN'
              ? 'control control-aviso'
              : check.skipped
                ? 'control control-omitido'
                : 'control';
        const Icono =
          check.severity === 'ERROR'
            ? IconoAlerta
            : check.severity === 'WARN'
              ? IconoInfo
              : check.skipped
                ? IconoGuion
                : IconoTilde;

        return (
          <li key={check.code} className={clase}>
            <Icono />
            <div>
              <span className="control-nombre">{check.label}</span>
              <div>{check.message}</div>
              {check.expected && check.actual ? (
                <div className="control-cifras">
                  <span>Impreso: {check.expected}</span>
                  <span>Leído: {check.actual}</span>
                  {check.difference ? <span>Diferencia: {check.difference}</span> : null}
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

const ESTADO_COMPROBANTE: Record<string, { texto: string; clase: string }> = {
  BORRADOR: { texto: 'Borrador', clase: 'estado-neutro' },
  PROCESANDO: { texto: 'Leyendo', clase: 'estado-info' },
  REQUIERE_REVISION: { texto: 'A revisar', clase: 'estado-aviso' },
  VALIDADO: { texto: 'Confirmado', clase: 'estado-ok' },
  RECHAZADO: { texto: 'Rechazado', clase: 'estado-neutro' },
  ANULADO: { texto: 'Anulado', clase: 'estado-error' },
};

const ESTADO_PAGO: Record<string, { texto: string; clase: string }> = {
  AGENDADO: { texto: 'Agendado', clase: 'estado-info' },
  VENCE_HOY: { texto: 'Vence hoy', clase: 'estado-aviso' },
  VENCIDO: { texto: 'Vencido', clase: 'estado-error' },
  PAGADO: { texto: 'Pagado', clase: 'estado-ok' },
  CANCELADO: { texto: 'Cancelado', clase: 'estado-neutro' },
};

const ESTADO_CONTROL: Record<string, { texto: string; clase: string }> = {
  OK: { texto: 'Controlado', clase: 'estado-ok' },
  RECONCILIADO: { texto: 'Con correcciones', clase: 'estado-aviso' },
  DIFERENCIA: { texto: 'No cierra', clase: 'estado-error' },
  PENDIENTE: { texto: 'Sin controlar', clase: 'estado-neutro' },
};

export function EtiquetaComprobante({ estado }: { estado: string }) {
  const info = ESTADO_COMPROBANTE[estado] ?? { texto: estado, clase: 'estado-neutro' };
  return <span className={`etiqueta-estado ${info.clase}`}>{info.texto}</span>;
}

export function EtiquetaPago({ estado }: { estado: string }) {
  const info = ESTADO_PAGO[estado] ?? { texto: estado, clase: 'estado-neutro' };
  return <span className={`etiqueta-estado ${info.clase}`}>{info.texto}</span>;
}

export function EtiquetaControl({ estado }: { estado: string }) {
  const info = ESTADO_CONTROL[estado] ?? { texto: estado, clase: 'estado-neutro' };
  return <span className={`etiqueta-estado ${info.clase}`}>{info.texto}</span>;
}
