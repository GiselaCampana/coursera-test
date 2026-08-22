'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABEL } from '@/lib/domain/payments';
import { confirmarPago, type ResultadoPago } from './acciones';

function BotonConfirmar() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="boton" disabled={pending}>
      {pending ? 'Confirmando…' : 'Confirmar el pago'}
    </button>
  );
}

/**
 * Confirmación del pago.
 *
 * Vencer y pagar son dos cosas distintas: acá se registra que el pago se hizo,
 * con su fecha efectiva, forma de pago y referencia. La fecha prevista queda
 * como estaba.
 */
export function FichaPago({
  scheduleId,
  importePendiente,
  formaDePago,
  hoy,
}: {
  scheduleId: string;
  importePendiente: string;
  formaDePago: string;
  hoy: string;
}) {
  const [abierto, setAbierto] = useState(false);
  const [estado, accion] = useActionState<ResultadoPago, FormData>(confirmarPago, {});

  // Al confirmar, la acción lleva a la pestaña de pagados; acá sólo se muestran
  // los errores, que sí vuelven como estado.
  if (!abierto) {
    return (
      <div className="acciones">
        <button
          type="button"
          className="boton boton-secundario boton-chico"
          onClick={() => setAbierto(true)}
        >
          Confirmar el pago
        </button>
      </div>
    );
  }

  return (
    <form action={accion} className="mt">
      <input type="hidden" name="scheduleId" value={scheduleId} />

      {estado.error && estado.scheduleId === scheduleId ? (
        <p className="mensaje mensaje-error" role="alert">
          {estado.error}
        </p>
      ) : null}

      <div className="fila fila-2">
        <div className="campo">
          <label htmlFor={`fecha-${scheduleId}`}>Fecha efectiva</label>
          <input
            id={`fecha-${scheduleId}`}
            name="fechaEfectiva"
            type="date"
            defaultValue={hoy}
            max={hoy}
            required
          />
        </div>
        <div className="campo">
          <label htmlFor={`forma-${scheduleId}`}>Forma de pago</label>
          <select id={`forma-${scheduleId}`} name="formaDePago" defaultValue={formaDePago}>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHOD_LABEL[m]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="fila fila-2">
        <div className="campo">
          <label htmlFor={`importe-${scheduleId}`}>Importe</label>
          <input
            id={`importe-${scheduleId}`}
            name="importe"
            type="text"
            inputMode="decimal"
            defaultValue={importePendiente}
          />
        </div>
        <div className="campo">
          <label htmlFor={`ref-${scheduleId}`}>Referencia o número de operación</label>
          <input id={`ref-${scheduleId}`} name="referencia" type="text" />
        </div>
      </div>

      <div className="campo">
        <label htmlFor={`obs-${scheduleId}`}>Observación</label>
        <input id={`obs-${scheduleId}`} name="observacion" type="text" />
      </div>

      <div className="acciones">
        <button
          type="button"
          className="boton boton-secundario"
          onClick={() => setAbierto(false)}
        >
          Cancelar
        </button>
        <BotonConfirmar />
      </div>
    </form>
  );
}
