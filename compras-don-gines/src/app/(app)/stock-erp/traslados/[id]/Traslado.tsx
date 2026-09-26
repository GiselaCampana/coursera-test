'use client';

import { useState } from 'react';
import type { TrasladoDetalle } from '@/lib/services/stock-erp-traslados';
import { formatCorteAr } from '@/lib/datetime';
import {
  agregarElRenglon,
  modificarElRenglon,
  retirarElRenglon,
  cancelarElBorrador,
  despacharElTraslado,
  recibirElTraslado,
  type Resultado,
} from '../acciones';

/**
 * **El traslado, pensado para el teléfono del que despacha o recibe.**
 *
 * Cada renglón es una tarjeta con su artículo, su cantidad, su unidad y —cuando
 * corresponde— el motivo por el que no se puede mover. No es una tabla: en un
 * iPhone una tabla de ocho columnas se sale de la pantalla, y lo que se sale es
 * siempre la columna que dice por qué algo está frenado.
 *
 * Las dos confirmaciones —despacho y recepción— se piden DOS veces, y las dos
 * viajan al servidor: la segunda va como un campo del formulario, porque una
 * doble confirmación que sólo existe en el navegador es una decoración que
 * cualquier pedido directo se saltea.
 */

const COLOR_POR_ESTADO: Record<string, string> = {
  BORRADOR: 'var(--gris-suave, #eef1f4)',
  DESPACHADO: 'var(--amarillo-suave, #fff4e5)',
  RECIBIDO: 'var(--verde-suave, #e6f4ea)',
  CANCELADO: 'var(--gris-suave, #eef1f4)',
  APLICADO: 'var(--verde-suave, #e6f4ea)',
  REVERSADO: 'var(--gris-suave, #eef1f4)',
};

const EXPLICACION_POR_ESTADO: Record<string, string> = {
  BORRADOR:
    'Se está preparando. Todavía no escribió nada en el libro: se puede editar y se puede cancelar.',
  DESPACHADO:
    'La mercadería SALIÓ del origen y todavía no llegó al destino: está en tránsito. El saldo del origen ya bajó; el del destino no subió.',
  RECIBIDO:
    'Llegó al destino y el traslado está cerrado. No se recibe dos veces y no se edita.',
  CANCELADO: 'El borrador se descartó. Nunca tocó el libro de existencias.',
  APLICADO: 'Traslado instantáneo de la fase 1: la salida y la entrada se asentaron juntas.',
  REVERSADO: 'Reversado por otro traslado.',
};

export function Traslado({
  detalle,
  disponibles,
  puedePreparar,
  puedeDespachar,
  puedeRecibir,
}: {
  detalle: TrasladoDetalle;
  disponibles: { id: string; internalCode: string; normalizedName: string }[];
  puedePreparar: boolean;
  puedeDespachar: boolean;
  puedeRecibir: boolean;
}) {
  const [r, setR] = useState<Resultado | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [confirmandoDespacho, setConfirmandoDespacho] = useState(false);
  const [confirmandoRecepcion, setConfirmandoRecepcion] = useState(false);
  const [cancelando, setCancelando] = useState(false);

  const esBorrador = detalle.estado === 'BORRADOR';
  const enTransito = detalle.estado === 'DESPACHADO';
  const cerrado = detalle.estado === 'RECIBIDO' || detalle.estado === 'APLICADO';
  const sePuedeDespachar = esBorrador && detalle.impedimentos.length === 0;

  async function correr(accion: (p: Resultado | null, f: FormData) => Promise<Resultado>, f: FormData) {
    setEnviando(true);
    const res = await accion(null, f);
    setR(res);
    setEnviando(false);
    if (res.ok) {
      setConfirmandoDespacho(false);
      setConfirmandoRecepcion(false);
      setCancelando(false);
    }
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
          {r.detalle?.yaEstabaAplicado && (
            <p className="chico" data-prueba="ya-aplicado">
              Respuesta idempotente: se devolvió el resultado que ya estaba guardado, con la misma
              clave y la misma huella. No se escribió nada nuevo.
            </p>
          )}
        </div>
      )}

      {/* --- Qué es y en qué estado está ---------------------------------- */}
      <section
        data-prueba="cabecera"
        data-estado={detalle.estado}
        style={{
          background: COLOR_POR_ESTADO[detalle.estado] ?? 'var(--gris-suave, #eef1f4)',
          padding: '0.75rem',
          borderRadius: '0.5rem',
        }}
      >
        <p>
          <strong data-prueba="estado">{detalle.estado}</strong>
        </p>
        <p className="chico" data-prueba="explicacion-estado">
          {EXPLICACION_POR_ESTADO[detalle.estado] ?? ''}
        </p>
        <dl className="chico">
          <dt>Origen</dt>
          <dd data-prueba="origen">{detalle.origen}</dd>
          <dt>Destino</dt>
          <dd data-prueba="destino">{detalle.destino}</dd>
          <dt>Preparado por</dt>
          <dd data-prueba="preparado-por">{detalle.preparadoPor ?? '—'}</dd>
          <dt>Despachado por</dt>
          <dd data-prueba="despachado-por">
            {detalle.despachadoPor ?? '—'}
            {detalle.despachadoEl ? ` · ${formatCorteAr(detalle.despachadoEl)}` : ''}
          </dd>
          <dt>Recibido por</dt>
          <dd data-prueba="recibido-por">
            {detalle.recibidoPor ?? '—'}
            {detalle.recibidoEl ? ` · ${formatCorteAr(detalle.recibidoEl)}` : ''}
          </dd>
          {detalle.canceladoPor && (
            <>
              <dt>Cancelado por</dt>
              <dd data-prueba="cancelado-por">
                {detalle.canceladoPor} · {formatCorteAr(detalle.canceladoEl)}
              </dd>
            </>
          )}
          {detalle.motivo && (
            <>
              <dt>Motivo</dt>
              <dd data-prueba="motivo">{detalle.motivo}</dd>
            </>
          )}
          <dt>Operación del despacho</dt>
          <dd data-prueba="operacion-despacho" style={{ overflowWrap: 'anywhere' }}>
            {detalle.operacionDeDespacho ?? '—'}
          </dd>
          <dt>Operación de la recepción</dt>
          <dd data-prueba="operacion-recepcion" style={{ overflowWrap: 'anywhere' }}>
            {detalle.operacionDeRecepcion ?? '—'}
          </dd>
        </dl>
        {detalle.operacionDeDespacho && (
          <p className="chico">
            <a
              href={`/stock-erp/movimientos?operacion=${detalle.operacionDeDespacho}`}
              data-prueba="ver-movimientos-despacho"
            >
              Ver en el libro los movimientos de la salida
            </a>
          </p>
        )}
        {detalle.operacionDeRecepcion && (
          <p className="chico">
            <a
              href={`/stock-erp/movimientos?operacion=${detalle.operacionDeRecepcion}`}
              data-prueba="ver-movimientos-recepcion"
            >
              Ver en el libro los movimientos de la entrada
            </a>
          </p>
        )}
      </section>

      {/* --- Los impedimentos, cuando hay ------------------------------- */}
      {esBorrador && detalle.impedimentos.length > 0 && (
        <section className="mensaje mensaje-error" data-prueba="impedimentos">
          <p>
            <strong>Este traslado todavía no se puede despachar.</strong>
          </p>
          <ul>
            {detalle.impedimentos.map((m) => (
              <li key={m} data-prueba="impedimento" style={{ overflowWrap: 'anywhere' }}>
                {m}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* --- Los renglones ---------------------------------------------- */}
      <section data-prueba="renglones">
        <h2>Artículos</h2>
        {enTransito && (
          <p className="chico" data-prueba="aviso-transito">
            Estas cantidades ya salieron de {detalle.origen} y todavía no están en {detalle.destino}.
          </p>
        )}
        {detalle.renglones.length === 0 ? (
          <p className="chico" data-prueba="sin-renglones">
            Todavía no hay ningún artículo en este traslado.
          </p>
        ) : (
          <ul className="lista-simple">
            {detalle.renglones.map((l) => (
              <li
                key={l.lineaId}
                data-prueba="renglon"
                data-clase={l.clase}
                style={{
                  background:
                    l.clase === 'BLOQUEADO'
                      ? 'var(--rojo-suave, #fdecea)'
                      : 'var(--verde-suave, #e6f4ea)',
                  padding: '0.6rem',
                  borderRadius: '0.5rem',
                  marginBottom: '0.5rem',
                }}
              >
                <p style={{ overflowWrap: 'anywhere' }}>
                  <strong data-prueba="articulo">{l.articulo}</strong>{' '}
                  <span className="chico">
                    PLU <span data-prueba="plu">{l.plu}</span>
                  </span>
                </p>
                <p>
                  <span data-prueba="cantidad">{l.cantidad}</span>{' '}
                  <span data-prueba="unidad">{l.unidad}</span>
                </p>
                {l.motivo && (
                  <p className="chico" data-prueba="motivo-renglon" style={{ overflowWrap: 'anywhere' }}>
                    {l.motivo}
                  </p>
                )}

                {/* El impacto previsto, antes de decidir. */}
                {esBorrador && l.clase === 'LISTO' && (
                  <p className="chico" data-prueba="impacto-previsto">
                    En {detalle.origen}: <span data-prueba="saldo-origen-antes">{l.saldoOrigenAntes}</span>{' '}
                    → <span data-prueba="saldo-origen-despues">{l.saldoOrigenDespues}</span>. En{' '}
                    {detalle.destino}:{' '}
                    <span data-prueba="saldo-destino-antes">
                      {l.saldoDestinoAntes ?? 'sin saldo'}
                    </span>{' '}
                    → <span data-prueba="saldo-destino-despues">{l.saldoDestinoDespues}</span> cuando
                    se reciba.
                  </p>
                )}
                {(enTransito || cerrado) && (
                  <p className="chico">
                    Despachada: <span data-prueba="cantidad-despachada">{l.dispatchedQuantity ?? '—'}</span>
                    {' · '}
                    Recibida: <span data-prueba="cantidad-recibida">{l.receivedQuantity ?? '—'}</span>
                  </p>
                )}

                {/* Edición, sólo en borrador. */}
                {esBorrador && puedePreparar && (
                  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <form action={(f) => correr(modificarElRenglon, f)}>
                      <input type="hidden" name="trasladoId" value={detalle.id} />
                      <input type="hidden" name="lineaId" value={l.lineaId} />
                      <input type="hidden" name="version" value={detalle.version} />
                      <input
                        name="cantidad"
                        defaultValue={l.cantidad}
                        inputMode="decimal"
                        aria-label={`Cantidad de ${l.articulo}`}
                        data-prueba="editar-cantidad"
                        style={{ maxWidth: '7rem' }}
                      />
                      <button type="submit" disabled={enviando} data-prueba="guardar-cantidad">
                        Guardar
                      </button>
                    </form>
                    <form action={(f) => correr(retirarElRenglon, f)}>
                      <input type="hidden" name="trasladoId" value={detalle.id} />
                      <input type="hidden" name="lineaId" value={l.lineaId} />
                      <input type="hidden" name="version" value={detalle.version} />
                      <button type="submit" disabled={enviando} data-prueba="retirar-renglon">
                        Retirar
                      </button>
                    </form>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {/* Agregar, sólo en borrador. */}
        {esBorrador && puedePreparar && (
          <form action={(f) => correr(agregarElRenglon, f)} data-prueba="agregar-renglon">
            <input type="hidden" name="trasladoId" value={detalle.id} />
            <input type="hidden" name="version" value={detalle.version} />
            <label>
              Artículo
              <select name="productId" required data-prueba="articulo-nuevo">
                <option value="">Elegí uno…</option>
                {disponibles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.internalCode} · {p.normalizedName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Cantidad
              <input name="cantidad" inputMode="decimal" required data-prueba="cantidad-nueva" />
            </label>
            <button type="submit" disabled={enviando} data-prueba="agregar">
              Agregar al traslado
            </button>
          </form>
        )}
      </section>

      {/* --- Despachar --------------------------------------------------- */}
      {esBorrador && (
        <section data-prueba="despachar">
          <h2>Despachar</h2>
          {!puedeDespachar ? (
            <p className="chico" data-prueba="sin-permiso-despachar">
              Despachar saca mercadería del origen y escribe el libro: hace falta el permiso
              «stockerp.traslado.despachar», que no viene con el rol administrador.
            </p>
          ) : !sePuedeDespachar ? (
            <p className="chico" data-prueba="despacho-frenado">
              Primero hay que resolver lo que está más arriba.
            </p>
          ) : !confirmandoDespacho ? (
            <button
              type="button"
              onClick={() => setConfirmandoDespacho(true)}
              data-prueba="confirmar"
            >
              Despachar {detalle.movimientosPrevistos}{' '}
              {detalle.movimientosPrevistos === 1 ? 'artículo' : 'artículos'}
            </button>
          ) : (
            <div className="mensaje mensaje-aviso" data-prueba="doble-confirmacion">
              <p>
                <strong>Confirmá el despacho.</strong> Van a salir{' '}
                <span data-prueba="resumen-movimientos">{detalle.movimientosPrevistos}</span>{' '}
                {detalle.movimientosPrevistos === 1 ? 'artículo' : 'artículos'} de {detalle.origen}.
                La mercadería queda en tránsito hasta que {detalle.destino} la reciba.{' '}
                <strong>No se deshace.</strong>
              </p>
              <form action={(f) => correr(despacharElTraslado, f)}>
                <input type="hidden" name="trasladoId" value={detalle.id} />
                <input type="hidden" name="confirmado" value="si" />
                <button type="submit" disabled={enviando} data-prueba="confirmar-definitivo">
                  {enviando ? 'Despachando…' : 'Sí, despachar'}
                </button>
              </form>
              <button type="button" onClick={() => setConfirmandoDespacho(false)}>
                No
              </button>
            </div>
          )}
        </section>
      )}

      {/* --- Recibir ----------------------------------------------------- */}
      {enTransito && (
        <section data-prueba="recibir">
          <h2>Recibir en {detalle.destino}</h2>
          <p className="chico" data-prueba="recepcion-exacta">
            La recepción de esta fase es <strong>exacta</strong>: si lo que contás no coincide con lo
            que salió, no se confirma nada y el traslado sigue en tránsito. La diferencia se
            resolverá con el flujo de incidencias, mermas o devolución, que todavía no existe. No se
            ajusta nada en silencio y no se fuerza el cierre.
          </p>
          {!puedeRecibir ? (
            <p className="chico" data-prueba="sin-permiso-recibir">
              Recibir ingresa mercadería al destino y escribe el libro: hace falta el permiso
              «stockerp.traslado.recibir», que no viene con el rol administrador.
            </p>
          ) : !confirmandoRecepcion ? (
            <button
              type="button"
              onClick={() => setConfirmandoRecepcion(true)}
              data-prueba="confirmar-recepcion"
            >
              Recibir {detalle.renglones.length}{' '}
              {detalle.renglones.length === 1 ? 'artículo' : 'artículos'}
            </button>
          ) : (
            <div className="mensaje mensaje-aviso" data-prueba="doble-confirmacion-recepcion">
              <p>
                <strong>Confirmá la recepción.</strong> Lo que ingrese va a sumar al saldo de{' '}
                {detalle.destino}. <strong>No se deshace.</strong>
              </p>
              <form action={(f) => correr(recibirElTraslado, f)}>
                <input type="hidden" name="trasladoId" value={detalle.id} />
                <input type="hidden" name="confirmado" value="si" />
                {detalle.renglones.map((l) => (
                  <label key={l.lineaId}>
                    {l.articulo} — salieron {l.dispatchedQuantity} {l.unidad}. ¿Cuánto contaste?
                    <input
                      name={`contado:${l.lineaId}`}
                      defaultValue={l.dispatchedQuantity ?? ''}
                      inputMode="decimal"
                      data-prueba="contado"
                      data-linea={l.lineaId}
                    />
                  </label>
                ))}
                <button type="submit" disabled={enviando} data-prueba="confirmar-recepcion-definitivo">
                  {enviando ? 'Recibiendo…' : 'Sí, recibir'}
                </button>
              </form>
              <button type="button" onClick={() => setConfirmandoRecepcion(false)}>
                No
              </button>
            </div>
          )}
        </section>
      )}

      {/* --- Cancelar el borrador ---------------------------------------- */}
      {esBorrador && puedePreparar && (
        <section data-prueba="cancelar">
          <h2>Cancelar el borrador</h2>
          {!cancelando ? (
            <button type="button" onClick={() => setCancelando(true)} data-prueba="cancelar-borrador">
              Cancelar este borrador
            </button>
          ) : (
            <form action={(f) => correr(cancelarElBorrador, f)} data-prueba="form-cancelar">
              <input type="hidden" name="trasladoId" value={detalle.id} />
              <label>
                Por qué se cancela
                <input name="motivo" required data-prueba="motivo-cancelacion" />
              </label>
              <p className="chico">
                Cancelar no escribe nada en el libro: este borrador nunca movió existencias.
              </p>
              <button type="submit" disabled={enviando} data-prueba="cancelar-definitivo">
                {enviando ? 'Cancelando…' : 'Sí, cancelar'}
              </button>
            </form>
          )}
        </section>
      )}

      {cerrado && (
        <p className="mensaje" data-prueba="traslado-cerrado">
          Este traslado está cerrado. No se edita, no se cancela y no se recibe de nuevo: lo que
          pasó, pasó, y está en el libro.
        </p>
      )}
      {detalle.estado === 'CANCELADO' && (
        <p className="mensaje" data-prueba="traslado-cancelado">
          Este borrador fue cancelado y nunca tocó el libro de existencias.
        </p>
      )}
    </>
  );
}
