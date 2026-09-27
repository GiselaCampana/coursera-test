'use client';

import { useState } from 'react';
import type { OperacionReversible } from '@/lib/services/stock-erp-correcciones';
import { revertirLaOperacion, type Resultado } from '../../acciones';

/**
 * **La confirmación de una reversión, con el asiento original a la vista.**
 *
 * Cada renglón se muestra dos veces: lo que la operación escribió y lo que la
 * reversión va a escribir al lado, en el sentido contrario. No hay nada que
 * elegir —la reversión es total, entera, una sola vez— así que tampoco hay
 * casillas por renglón: la única decisión es sí o no.
 *
 * **Y no hay ningún campo para sumar o restar.** Revertir no es empujar el saldo
 * hasta donde uno quiere: es cancelar un asiento con su inverso exacto.
 */
export function Reversion({
  operacion,
  yaHayReversion,
  puedeRevertir,
}: {
  operacion: OperacionReversible;
  yaHayReversion: boolean;
  puedeRevertir: boolean;
}) {
  const [r, setR] = useState<Resultado | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [confirmando, setConfirmando] = useState(false);

  const bloqueada = operacion.impedimentos.length > 0 || operacion.yaRevertida || yaHayReversion;

  async function enviar(f: FormData) {
    setEnviando(true);
    const res = await revertirLaOperacion(null, f);
    setR(res);
    setEnviando(false);
    if (res.ok) setConfirmando(false);
  }

  return (
    <>
      {r && (
        <div
          className={
            r.ok ? 'mensaje mensaje-ok' : r.conflicto ? 'mensaje mensaje-aviso' : 'mensaje mensaje-error'
          }
          data-prueba={r.ok ? 'resultado-ok' : r.conflicto ? 'resultado-conflicto' : 'resultado-error'}
        >
          <p style={{ overflowWrap: 'anywhere' }}>{r.mensaje}</p>
          {r.detalle?.yaEstabaAplicada && (
            <p className="chico" data-prueba="ya-aplicada">
              Respuesta idempotente: se devolvió el resultado ya guardado. No se escribió un segundo
              juego de asientos inversos.
            </p>
          )}
        </div>
      )}

      {/* --- Qué escribió, y qué se va a escribir ------------------------- */}
      <section data-prueba="movimientos-originales">
        <h2>Lo que hay en el libro ({operacion.movimientos.length})</h2>
        <ul className="lista-simple">
          {operacion.movimientos.map((m) => (
            <li
              key={m.id}
              data-prueba="movimiento"
              data-direccion={m.direccion}
              style={{
                padding: '0.6rem',
                borderRadius: '0.5rem',
                marginBottom: '0.5rem',
                background: 'var(--gris-suave, #eef1f4)',
              }}
            >
              <p style={{ overflowWrap: 'anywhere' }}>
                <strong data-prueba="articulo">{m.articulo}</strong>{' '}
                <span className="chico">
                  PLU <span data-prueba="plu">{m.plu}</span>
                </span>
              </p>
              <p className="chico">
                Original: <span data-prueba="tipo">{m.tipo}</span> ·{' '}
                {m.direccion === 'IN' ? 'entraron' : 'salieron'}{' '}
                <strong data-prueba="cantidad">{m.cantidad}</strong>{' '}
                <span data-prueba="unidad">{m.unidad}</span>
              </p>
              <p className="chico" data-prueba="inverso">
                La reversión va a <strong>{m.direccion === 'IN' ? 'sacar' : 'devolver'}</strong> las
                mismas {m.cantidad} {m.unidad}, con el mismo tipo de movimiento y vinculada a este
                asiento. El asiento original <strong>queda donde está</strong>.
              </p>
            </li>
          ))}
        </ul>
      </section>

      {/* --- Impedimentos ------------------------------------------------- */}
      {operacion.impedimentos.length > 0 && (
        <section className="mensaje mensaje-error" data-prueba="impedimentos">
          <p>No se puede revertir:</p>
          <ul>
            {operacion.impedimentos.map((m) => (
              <li key={m} data-prueba="impedimento" style={{ overflowWrap: 'anywhere' }}>
                {m}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* --- Confirmar ---------------------------------------------------- */}
      {!bloqueada &&
        (!puedeRevertir ? (
          <p className="chico" data-prueba="sin-permiso-reversion">
            Revertir escribe movimientos inversos en el libro: hace falta el permiso
            «stockerp.reversar», que no viene con el rol administrador.
          </p>
        ) : !confirmando ? (
          <button type="button" onClick={() => setConfirmando(true)} data-prueba="revisar-reversion">
            Revertir esta operación
          </button>
        ) : (
          <div className="mensaje mensaje-aviso" data-prueba="doble-confirmacion">
            <p>
              <strong>Confirmá la reversión.</strong> Se van a agregar{' '}
              <span data-prueba="cuantos-inversos">{operacion.movimientos.length}</span>{' '}
              {operacion.movimientos.length === 1 ? 'asiento inverso' : 'asientos inversos'}. La
              reversión es <strong>total</strong> y se hace <strong>una sola vez</strong>: no se
              revierte una reversión. Nada se borra: el libro va a mostrar las dos cosas.
            </p>
            <form action={enviar}>
              <input type="hidden" name="operationId" value={operacion.operationId} />
              <input type="hidden" name="confirmado" value="si" />
              <label>
                Por qué se revierte
                <input
                  name="motivo"
                  required
                  placeholder="Lo único que explica dos asientos que se cancelan"
                  data-prueba="motivo-reversion"
                />
              </label>
              <button type="submit" disabled={enviando} data-prueba="confirmar-definitivo">
                {enviando ? 'Revirtiendo…' : 'Sí, revertir'}
              </button>
            </form>
            <button type="button" onClick={() => setConfirmando(false)}>
              No
            </button>
          </div>
        ))}
    </>
  );
}
