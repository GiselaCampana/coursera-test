'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABEL } from '@/lib/domain/payments';
import { confirmarPago, reprogramarPago, type ResultadoPago } from './acciones';

function BotonConfirmar() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="boton" disabled={pending}>
      {pending ? 'Confirmando…' : 'Confirmar el pago'}
    </button>
  );
}

function BotonReprogramar() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="boton" disabled={pending}>
      {pending ? 'Cambiando…' : 'Cambiar la fecha'}
    </button>
  );
}

/**
 * Confirmación del pago, y cambio de la fecha prevista.
 *
 * Vencer y pagar son dos cosas distintas: confirmar registra que el pago se
 * hizo, con su fecha efectiva, forma de pago y referencia, y no toca la fecha
 * prevista. Cambiar la fecha es lo otro: mueve el vencimiento y no registra
 * ningún pago.
 *
 * Que la segunda exista es lo que permite corregir un vencimiento sin tocar la
 * compra. Una condición mal cargada —o cargada después de la factura— deja el
 * pago agendado en la fecha equivocada, y la única alternativa sería anular el
 * comprobante y volver a cargarlo: una factura correcta se daría de baja para
 * arreglar una fecha.
 */
export function FichaPago({
  scheduleId,
  importePendiente,
  formaDePago,
  hoy,
  vence,
  puedeReprogramar = false,
  provisoria = false,
}: {
  scheduleId: string;
  importePendiente: string;
  formaDePago: string;
  hoy: string;
  /** El vencimiento actual, en ISO, para poder corregirlo. */
  vence?: string;
  /** Permiso para mover la fecha prevista. */
  puedeReprogramar?: boolean;
  /**
   * ¿La fecha es una estimación?
   *
   * Con "factura contra factura" el vencimiento real lo fija la próxima
   * entrega, así que hasta que llegue lo que hay es una fecha tentativa. Vale
   * la pena decirlo donde se la va a cambiar.
   */
  provisoria?: boolean;
}) {
  const [abierto, setAbierto] = useState<'no' | 'pagar' | 'fecha'>('no');
  const [estado, accion] = useActionState<ResultadoPago, FormData>(confirmarPago, {});
  const [estadoFecha, accionFecha] = useActionState<ResultadoPago, FormData>(reprogramarPago, {});

  // Al confirmar, la acción lleva a la pestaña de pagados; acá sólo se muestran
  // los errores, que sí vuelven como estado.
  if (abierto === 'no') {
    return (
      <div className="acciones">
        <button
          type="button"
          className="boton boton-secundario boton-chico"
          onClick={() => setAbierto('pagar')}
        >
          Confirmar el pago
        </button>
        {puedeReprogramar && vence ? (
          <button
            type="button"
            className="boton boton-secundario boton-chico"
            onClick={() => setAbierto('fecha')}
          >
            Cambiar la fecha…
          </button>
        ) : null}
        {estadoFecha.ok && estadoFecha.scheduleId === scheduleId ? (
          <span className="chico" role="status">
            Fecha actualizada.
          </span>
        ) : null}
      </div>
    );
  }

  if (abierto === 'fecha') {
    return (
      <form action={accionFecha} className="mt">
        <input type="hidden" name="scheduleId" value={scheduleId} />

        {estadoFecha.error && estadoFecha.scheduleId === scheduleId ? (
          <p className="mensaje mensaje-error" role="alert">
            {estadoFecha.error}
          </p>
        ) : null}

        <p className="chico medio">
          {provisoria
            ? 'Esta fecha es una estimación: la condición es factura contra factura y el vencimiento real lo fija la próxima entrega. '
            : ''}
          Se mueve sólo el vencimiento previsto. El comprobante, sus importes y la compra no se
          tocan, y el cambio queda en el historial del pago.
        </p>

        <div className="fila fila-2">
          <div className="campo">
            <label htmlFor={`vence-${scheduleId}`}>Nueva fecha de vencimiento</label>
            <input
              id={`vence-${scheduleId}`}
              name="nuevaFecha"
              type="date"
              defaultValue={vence}
              required
            />
          </div>
          <div className="campo">
            <label htmlFor={`motivo-${scheduleId}`}>Motivo</label>
            <input
              id={`motivo-${scheduleId}`}
              name="motivo"
              type="text"
              placeholder="Por ejemplo: la condición es factura contra factura."
            />
          </div>
        </div>

        <div className="acciones">
          <button
            type="button"
            className="boton boton-secundario"
            onClick={() => setAbierto('no')}
          >
            Cancelar
          </button>
          <BotonReprogramar />
        </div>
      </form>
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
          onClick={() => setAbierto('no')}
        >
          Cancelar
        </button>
        <BotonConfirmar />
      </div>
    </form>
  );
}
