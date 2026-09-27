'use client';

import { useState } from 'react';
import type { RecuentoDetalle } from '@/lib/services/stock-erp-correcciones';
import { formatCorteAr } from '@/lib/datetime';
import {
  guardarLoContado,
  confirmarElAjuste,
  cerrarElRecuento,
  type Resultado,
} from '../../acciones';

/**
 * **El recuento, en el teléfono, frente a la góndola.**
 *
 * Cada artículo contado es una tarjeta que muestra las cuatro cosas que hacen
 * falta para decidir: el saldo que el sistema tenía, lo que la persona contó, la
 * diferencia y el saldo que quedaría. La diferencia se muestra para poder
 * mirarla; lo que viaja al servidor es la cantidad física.
 *
 * **No hay ningún campo para sumar o restar.** Si el número del sistema está mal,
 * se cuenta y se confirma; no se lo empuja a mano.
 */
export function Recuento({
  detalle,
  articulos,
  puedePreparar,
  puedeAjustar,
}: {
  detalle: RecuentoDetalle;
  articulos: { id: string; internalCode: string; normalizedName: string }[];
  puedePreparar: boolean;
  puedeAjustar: boolean;
}) {
  const [r, setR] = useState<Resultado | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [confirmando, setConfirmando] = useState<string | null>(null);

  const abierta = detalle.estado === 'ABIERTA';

  async function correr(
    accion: (p: Resultado | null, f: FormData) => Promise<Resultado>,
    f: FormData,
  ) {
    setEnviando(true);
    const res = await accion(null, f);
    setR(res);
    setEnviando(false);
    if (res.ok) setConfirmando(null);
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
        </div>
      )}

      <section data-prueba="cabecera-recuento" data-estado={detalle.estado}>
        <p className="chico">
          {detalle.sucursal} · <strong data-prueba="estado">{detalle.estado}</strong> · abierto el{' '}
          {formatCorteAr(detalle.abiertaEl)}
          {detalle.cerradaEl ? ` · cerrado el ${formatCorteAr(detalle.cerradaEl)}` : ''}
        </p>
        <p className="chico">
          {detalle.lineas.length} contados · <span data-prueba="con-diferencia">{detalle.conDiferencia}</span>{' '}
          con diferencia sin confirmar · {detalle.sinDiferencia} sin diferencia ·{' '}
          {detalle.pendientes} pendientes
        </p>
        <p className="chico" data-prueba="explicacion-delta">
          La diferencia la calcula el <strong>servidor</strong> contra el saldo que bloquea al
          confirmar. Acá se escribe lo que se contó, no un ajuste.
        </p>
      </section>

      {/* --- Lo contado --------------------------------------------------- */}
      <section data-prueba="lineas">
        <h2>Contado</h2>
        {detalle.lineas.length === 0 ? (
          <p className="chico" data-prueba="sin-lineas">
            Todavía no se contó ningún artículo.
          </p>
        ) : (
          <ul className="lista-simple">
            {detalle.lineas.map((l) => {
              const sube = !l.diferencia.startsWith('-') && l.diferencia !== '0';
              const baja = l.diferencia.startsWith('-');
              return (
                <li
                  key={l.id}
                  data-prueba="linea"
                  data-resolucion={l.resolucion ?? 'PENDIENTE'}
                  style={{
                    background:
                      l.resolucion === 'AJUSTADA'
                        ? 'var(--verde-suave, #e6f4ea)'
                        : l.resolucion === 'SIN_DIFERENCIA'
                          ? 'var(--gris-suave, #eef1f4)'
                          : l.impedimentos.length > 0
                            ? 'var(--rojo-suave, #fdecea)'
                            : 'var(--amarillo-suave, #fff4e5)',
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
                  <p className="chico">
                    Saldo del sistema: <span data-prueba="saldo-anterior">{l.saldoEsperado}</span>{' '}
                    {l.unidad} · contado:{' '}
                    <span data-prueba="cantidad-fisica">{l.cantidadFisica}</span> · diferencia:{' '}
                    <strong data-prueba="diferencia">{l.diferencia}</strong> · saldo resultante:{' '}
                    <span data-prueba="saldo-resultante">{l.cantidadFisica}</span> {l.unidad}
                  </p>
                  {l.resolucion && (
                    <p className="chico" data-prueba="resolucion">
                      {l.resolucion === 'SIN_DIFERENCIA'
                        ? 'Coincidía: queda la constancia y no se escribió ningún movimiento.'
                        : 'Ajustada.'}{' '}
                      {l.confirmadaPor ? (
                        <>
                          Confirmada por <span data-prueba="usuario">{l.confirmadaPor}</span>
                        </>
                      ) : (
                        ''
                      )}
                      {l.confirmadaEl ? ` el ${formatCorteAr(l.confirmadaEl)}` : ''}
                      {l.motivo ? (
                        <>
                          {' · '}
                          <span data-prueba="motivo">{l.motivo}</span>
                        </>
                      ) : (
                        ''
                      )}{' '}
                      ·{' '}
                      <span data-prueba="estado-reversion">
                        {l.revertida ? 'revertida' : 'sin revertir'}
                      </span>
                    </p>
                  )}
                  {l.operationId && (
                    <p className="chico">
                      <a
                        href={`/stock-erp/movimientos?operacion=${l.operationId}`}
                        data-prueba="ver-en-el-libro"
                      >
                        Ver el asiento en el libro (operación {l.operationId.slice(-8)})
                      </a>
                    </p>
                  )}
                  {l.impedimentos.length > 0 && (
                    <ul className="chico" data-prueba="impedimentos">
                      {l.impedimentos.map((m) => (
                        <li key={m} data-prueba="impedimento" style={{ overflowWrap: 'anywhere' }}>
                          {m}
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* Confirmar el ajuste de esta línea. */}
                  {abierta && !l.resolucion && l.impedimentos.length === 0 && (
                    <>
                      {!puedeAjustar ? (
                        <p className="chico" data-prueba="sin-permiso-ajuste">
                          Confirmar un ajuste escribe el libro: hace falta «stockerp.ajuste», que no
                          viene con el rol administrador.
                        </p>
                      ) : confirmando !== l.id ? (
                        <button
                          type="button"
                          onClick={() => setConfirmando(l.id)}
                          data-prueba="confirmar"
                        >
                          {l.diferencia === '0'
                            ? 'Registrar que coincidía'
                            : `Confirmar el ajuste de ${l.diferencia}`}
                        </button>
                      ) : (
                        <div className="mensaje mensaje-aviso" data-prueba="doble-confirmacion">
                          <p>
                            {l.diferencia === '0' ? (
                              <>
                                <strong>Coincidía.</strong> Queda la constancia del recuento y{' '}
                                <strong>no se escribe ningún movimiento</strong>.
                              </>
                            ) : (
                              <>
                                <strong>Confirmá el ajuste.</strong> El saldo va a pasar de{' '}
                                {l.saldoEsperado} a {l.cantidadFisica} {l.unidad}, asentando sólo la
                                diferencia de {l.diferencia}. <strong>No se deshace</strong>: si
                                estuviera mal, se revierte.
                              </>
                            )}
                          </p>
                          <form action={(f) => correr(confirmarElAjuste, f)}>
                            <input type="hidden" name="sessionId" value={detalle.sessionId} />
                            <input type="hidden" name="lineaId" value={l.id} />
                            <input type="hidden" name="confirmado" value="si" />
                            <label>
                              Por qué
                              <input name="motivo" required data-prueba="motivo-ajuste" />
                            </label>
                            <button type="submit" disabled={enviando} data-prueba="confirmar-definitivo">
                              {enviando ? 'Confirmando…' : 'Sí, confirmar'}
                            </button>
                          </form>
                          <button type="button" onClick={() => setConfirmando(null)}>
                            No
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* --- Cargar una cantidad contada ---------------------------------- */}
      {abierta && puedePreparar && (
        <section data-prueba="cargar-contado">
          <h2>Cargar lo contado</h2>
          <form action={(f) => correr(guardarLoContado, f)}>
            <input type="hidden" name="sessionId" value={detalle.sessionId} />
            <label>
              Artículo
              <select name="productId" required data-prueba="articulo-a-contar">
                <option value="">Elegí uno…</option>
                {articulos.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.internalCode} · {a.normalizedName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Cantidad física contada
              <input
                name="cantidadFisica"
                inputMode="decimal"
                required
                placeholder="Lo que hay, no la diferencia"
                data-prueba="cantidad-fisica-nueva"
              />
            </label>
            <button type="submit" disabled={enviando} data-prueba="guardar-contado">
              Guardar lo contado
            </button>
          </form>
        </section>
      )}

      {/* --- Cerrar ------------------------------------------------------- */}
      {abierta && puedePreparar && (
        <section data-prueba="cerrar-recuento">
          <form action={(f) => correr(cerrarElRecuento, f)}>
            <input type="hidden" name="sessionId" value={detalle.sessionId} />
            <button type="submit" disabled={enviando} data-prueba="cerrar">
              Cerrar el recuento
            </button>
            <p className="chico">
              Se cierra cuando cada cosa contada tiene una respuesta: ajustada o sin diferencia.
            </p>
          </form>
        </section>
      )}
    </>
  );
}
