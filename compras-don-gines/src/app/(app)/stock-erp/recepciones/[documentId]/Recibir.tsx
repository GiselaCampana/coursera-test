'use client';

import { useState } from 'react';
import type {
  VistaPreviaDeRecepcion,
  ClaseDeRenglon,
} from '@/lib/services/stock-erp-recepcion';
import { formatCorteAr } from '@/lib/datetime';
import { recibirLaCompra, type Resultado } from '../acciones';

/**
 * **Vista previa y confirmación de una recepción, pensadas para el teléfono.**
 *
 * Cada renglón es una tarjeta con su clasificación a la vista —mercadería,
 * gasto, bloqueado— y no una fila de tabla: en un iPhone una tabla de nueve
 * columnas se sale de la pantalla, y lo que se sale es siempre la columna que
 * dice por qué algo no entra.
 *
 * La confirmación se pide DOS veces. La primera abre el resumen final; la
 * segunda es la que manda. Y las dos viajan al servidor: la segunda va como un
 * campo del formulario, porque una doble confirmación que sólo existe en el
 * navegador es una decoración que cualquier pedido directo se saltea.
 */

const ETIQUETA: Record<ClaseDeRenglon, string> = {
  MERCADERIA: 'Mercadería',
  GASTO_SIN_IMPACTO: 'Gasto (no mueve existencias)',
  BLOQUEADO: 'Bloqueado',
  EXCLUIDO: 'Excluido',
};

const COLOR: Record<ClaseDeRenglon, string> = {
  MERCADERIA: 'var(--verde-suave, #e6f4ea)',
  GASTO_SIN_IMPACTO: 'var(--gris-suave, #eef1f4)',
  BLOQUEADO: 'var(--rojo-suave, #fdecea)',
  EXCLUIDO: 'var(--gris-suave, #eef1f4)',
};

export function Recibir({
  previa,
  puedePreparar,
  puedeConfirmar,
  puedeExcepcion,
  interruptorEncendido,
  fechaPropuesta,
  horaPropuesta,
}: {
  previa: VistaPreviaDeRecepcion;
  puedePreparar: boolean;
  puedeConfirmar: boolean;
  puedeExcepcion: boolean;
  interruptorEncendido: boolean;
  fechaPropuesta: string;
  horaPropuesta: string;
}) {
  const [r, setR] = useState<Resultado | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [fecha, setFecha] = useState(fechaPropuesta);
  const [hora, setHora] = useState(horaPropuesta);

  const mercaderia = previa.renglones.filter((x) => x.clase === 'MERCADERIA');
  const gastos = previa.renglones.filter((x) => x.clase === 'GASTO_SIN_IMPACTO');
  const bloqueados = previa.renglones.filter((x) => x.clase === 'BLOQUEADO');

  /*
   * La resolución se recalcula acá con la fecha que la persona tiene escrita,
   * para que el resumen diga lo que va a pasar ANTES de confirmar. El servidor
   * la vuelve a calcular por su cuenta y es el que manda: esto es información,
   * no la decisión.
   *
   * La comparación se hace sobre la HORA DE PARED argentina —«2026-09-24T14:30»
   * contra «2026-09-24T09:00»—, que es exactamente lo que dicen los dos campos
   * y lo que el servidor manda en `corteLocal`. Tentaba armar un instante con
   * `new Date(\`${fecha}T${hora}:00-03:00\`)`, y ese −03:00 escrito a mano es
   * justo la suposición que el resto de la aplicación evita: si Argentina
   * volviera a tener horario de verano, la pantalla diría una cosa y el
   * servidor haría otra. Comparar textos ISO locales no supone ningún desfase.
   */
  const anteriorAlCorte =
    previa.corteLocal !== null &&
    /^\d{4}-\d{2}-\d{2}$/.test(fecha) &&
    /^\d{2}:\d{2}$/.test(hora) &&
    `${fecha}T${hora}` <= previa.corteLocal;
  const resolucionPrevista =
    mercaderia.length === 0 && bloqueados.length === 0
      ? 'EXCLUIDA'
      : anteriorAlCorte
        ? 'INCLUIDA_EN_APERTURA'
        : 'APLICADA';

  const frenos = previa.impedimentos.filter((m) => !m.startsWith('Falta la fecha y hora'));
  const sePuede = frenos.length === 0 && !previa.yaDecidida;

  async function enviar(f: FormData) {
    setEnviando(true);
    const res = await recibirLaCompra(null, f);
    setR(res);
    setEnviando(false);
    if (res.ok) setConfirmando(false);
  }

  return (
    <>
      {r && (
        <div
          className={r.ok ? 'mensaje mensaje-ok' : r.conflicto ? 'mensaje mensaje-aviso' : 'mensaje mensaje-error'}
          data-prueba={r.ok ? 'resultado-ok' : r.conflicto ? 'resultado-conflicto' : 'resultado-error'}
        >
          <p style={{ overflowWrap: 'anywhere' }}>{r.mensaje}</p>
          {r.detalle?.yaEstabaAplicada && (
            <p className="chico" data-prueba="ya-aplicada">
              Respuesta idempotente: se devolvió el resultado que ya estaba guardado, con la misma
              clave y la misma huella. No se escribió nada nuevo.
            </p>
          )}
          {r.conflicto && (
            <p className="chico" data-prueba="explicacion-conflicto">
              Dos confirmaciones distintas para el mismo comprobante. La que llegó primera quedó
              registrada; ésta no escribió nada. Volvé a mirar la vista previa antes de insistir.
            </p>
          )}
        </div>
      )}

      {/* --- Encabezado ----------------------------------------------------- */}
      <section className="tarjeta" data-prueba="encabezado">
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 10px', margin: 0 }}>
          <dt className="chico">Sucursal</dt>
          <dd className="chico" style={{ margin: 0 }} data-prueba="sucursal">
            {previa.sucursal}
          </dd>
          <dt className="chico">Corte de apertura</dt>
          <dd className="chico" style={{ margin: 0 }} data-prueba="corte">
            {previa.sucursalConApertura ? formatCorteAr(previa.cutoffAt) : 'Sucursal sin apertura'}
          </dd>
          <dt className="chico">Datos</dt>
          <dd className="chico" style={{ margin: 0 }} data-prueba="tipo-de-datos">
            {previa.aperturaFicticia === null
              ? '—'
              : previa.aperturaFicticia
                ? 'ficticios (homologación)'
                : 'reales'}
          </dd>
        </dl>
      </section>

      <p className="mensaje" data-prueba="mirar-no-escribe">
        Mirar esta pantalla <strong>no escribe nada</strong>. No queda reservado, ni marcado como
        visto, ni a medio recibir. Podés cerrarla y volver mañana y va a estar igual.
      </p>

      {previa.yaDecidida && (
        <p className="mensaje mensaje-ok" data-prueba="ya-decidida">
          Este comprobante ya tiene una recepción registrada:{' '}
          <strong>{previa.yaDecidida.resolucion}</strong>, recibida el{' '}
          <strong>{formatCorteAr(previa.yaDecidida.receivedAt)}</strong>
          {previa.yaDecidida.decididaPor ? ` por ${previa.yaDecidida.decididaPor}` : ''}. La fecha de
          recepción no se cambia después de decidida.
        </p>
      )}

      {frenos.length > 0 && (
        <div className="mensaje mensaje-error" data-prueba="impedimentos">
          <strong>No se puede recibir todavía:</strong>
          <ul>
            {frenos.map((i) => (
              <li key={i} data-prueba="impedimento" style={{ overflowWrap: 'anywhere' }}>
                {i}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* --- Fecha física --------------------------------------------------- */}
      {sePuede && puedePreparar && (
        <section className="tarjeta" data-prueba="fecha-de-recepcion">
          <h2 className="chico">¿Cuándo llegó la mercadería?</h2>
          <p className="chico">
            La fecha y hora en que el camión descargó, cargada por vos. Se propone «ahora».{' '}
            <strong>No es la fecha del comprobante</strong>, que es otra cosa: el papel puede ser de
            agosto y la mercadería haber llegado en septiembre.
          </p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 140px', minWidth: 0 }}>
              <label className="etiqueta" htmlFor="fecha-recepcion">
                Fecha
              </label>
              <input
                id="fecha-recepcion"
                type="date"
                value={fecha}
                onChange={(e) => setFecha(e.target.value)}
                data-prueba="recepcion-fecha"
              />
            </div>
            <div style={{ flex: '1 1 100px', minWidth: 0 }}>
              <label className="etiqueta" htmlFor="hora-recepcion">
                Hora (Argentina)
              </label>
              <input
                id="hora-recepcion"
                type="time"
                value={hora}
                onChange={(e) => setHora(e.target.value)}
                data-prueba="recepcion-hora"
              />
            </div>
          </div>

          {anteriorAlCorte && (
            <p className="mensaje mensaje-aviso" data-prueba="anterior-al-corte">
              Esa fecha es <strong>anterior o igual al corte</strong> de la apertura. Esa mercadería
              ya está contada en el conteo inicial: sumarla otra vez la duplicaría. Se va a registrar
              la decisión <strong>INCLUIDA_EN_APERTURA</strong>, sin ningún movimiento.
            </p>
          )}
        </section>
      )}

      {/* --- Los renglones --------------------------------------------------- */}
      <h2>
        Mercadería que entraría <span data-prueba="cuenta-mercaderia">({mercaderia.length})</span>
      </h2>
      {mercaderia.length === 0 && (
        <p className="chico">Ningún renglón de este comprobante mueve existencias.</p>
      )}
      {mercaderia.map((x) => (
        <Renglon key={x.documentItemId} x={x} />
      ))}

      <h2>
        Gastos, sin impacto <span data-prueba="cuenta-gastos">({gastos.length})</span>
      </h2>
      {gastos.length === 0 && <p className="chico">Ninguno.</p>}
      {gastos.map((x) => (
        <Renglon key={x.documentItemId} x={x} />
      ))}

      {bloqueados.length > 0 && (
        <>
          <h2>
            Renglones bloqueados <span data-prueba="cuenta-bloqueados">({bloqueados.length})</span>
          </h2>
          {bloqueados.map((x) => (
            <Renglon key={x.documentItemId} x={x} />
          ))}
        </>
      )}

      {/* --- Confirmación ---------------------------------------------------- */}
      {sePuede && puedeConfirmar && (
        <section className="tarjeta" data-prueba="confirmacion">
          <h2 className="chico">Confirmar la recepción</h2>

          {resolucionPrevista === 'APLICADA' && !previa.aperturaFicticia && !interruptorEncendido && (
            <p className="mensaje mensaje-aviso" data-prueba="interruptor-apagado">
              El interruptor de recepciones reales está apagado, así que esta confirmación va a ser
              rechazada por el servidor. No es un capricho de la pantalla: los saldos todavía no
              bajan con las ventas.
            </p>
          )}

          {confirmando ? (
            <form data-prueba="form-confirmar" action={enviar}>
              <input type="hidden" name="documentId" value={previa.documentId} />
              <input type="hidden" name="fecha" value={fecha} />
              <input type="hidden" name="hora" value={hora} />
              <input type="hidden" name="confirmado" value="si" />
              <div className="mensaje mensaje-aviso" data-prueba="doble-confirmacion">
                <p data-prueba="resumen-final">
                  Vas a registrar <strong data-prueba="resolucion-prevista">{resolucionPrevista}</strong>{' '}
                  para <strong style={{ overflowWrap: 'anywhere' }}>{previa.numero}</strong> en{' '}
                  <strong>{previa.sucursal}</strong>, recibida el{' '}
                  <strong data-prueba="resumen-fecha">
                    {fecha} {hora} (hora de Argentina)
                  </strong>
                  .{' '}
                  {resolucionPrevista === 'APLICADA' ? (
                    <>
                      Entran <strong data-prueba="resumen-movimientos">{mercaderia.length}</strong>{' '}
                      movimientos de mercadería al libro de existencias. No se deshace.
                    </>
                  ) : (
                    <>No se genera ningún movimiento: queda registrada la decisión.</>
                  )}
                </p>

                {anteriorAlCorte && puedeExcepcion && (
                  <label className="chico" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <input
                      type="checkbox"
                      name="excepcionHistorica"
                      value="si"
                      data-prueba="marcar-excepcion"
                      style={{ width: 'auto', minHeight: 0 }}
                    />
                    <span>
                      Dejar constancia de una excepción histórica. Exige un motivo y{' '}
                      <strong>no genera movimientos</strong>: no existe forma de asentar mercadería
                      con fecha anterior al corte.
                    </span>
                  </label>
                )}

                <label className="etiqueta" htmlFor="motivo-recepcion">
                  Motivo (opcional, salvo excepción histórica)
                </label>
                <input id="motivo-recepcion" name="motivo" data-prueba="motivo" />

                <button type="submit" className="boton" disabled={enviando} data-prueba="confirmar-definitivo">
                  Sí, registrar la recepción
                </button>
                <button
                  type="button"
                  className="boton-secundario"
                  onClick={() => setConfirmando(false)}
                  data-prueba="cancelar-confirmacion"
                >
                  Cancelar
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              className="boton"
              onClick={() => setConfirmando(true)}
              data-prueba="confirmar"
            >
              Recibir esta compra
            </button>
          )}
        </section>
      )}
    </>
  );
}

function Renglon({ x }: { x: VistaPreviaDeRecepcion['renglones'][number] }) {
  return (
    <article
      className="tarjeta"
      data-prueba="renglon"
      data-clase={x.clase}
      data-renglon={x.documentItemId}
      data-plu={x.plu ?? ''}
      style={{ background: COLOR[x.clase], marginBottom: 10 }}
    >
      <header style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        {x.plu && <strong data-prueba="plu">{x.plu}</strong>}
        <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{x.descripcion}</span>
        <span className="chico" data-prueba="clase">
          {ETIQUETA[x.clase]}
        </span>
      </header>

      <p className="chico" data-prueba="facturado">
        Facturado: {x.cantidadFacturada} {x.unidadFacturada}
        {x.piezas !== null ? ` · ${x.piezas} piezas` : ''}
        {x.pesoRealKg !== null ? ` · ${x.pesoRealKg} kg reales` : ''}
      </p>

      {x.clase === 'MERCADERIA' && (
        <p className="chico" data-prueba="conversion">
          Entra:{' '}
          <strong data-prueba="cantidad-existencia">
            {x.cantidadDeExistencia} {x.unidadDeExistencia}
          </strong>{' '}
          (factor {x.factorUsado}) · Saldo{' '}
          <span data-prueba="saldo-anterior">{x.saldoAnterior}</span> →{' '}
          <strong data-prueba="saldo-previsto">{x.saldoPrevisto}</strong>
        </p>
      )}

      {x.motivo && (
        <p className="chico" data-prueba="motivo-renglon" style={{ overflowWrap: 'anywhere' }}>
          {x.motivo}
        </p>
      )}
    </article>
  );
}
