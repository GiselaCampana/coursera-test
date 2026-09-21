'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { despacharMovimientosDeStock, type ResultadoDelDespacho } from './acciones';

/**
 * **Mandar a mano la mercadería de este comprobante a Control de Stock.**
 *
 * Todo lo que se ve acá existe para poder mirar **antes** de mandar. Un botón
 * que manda algo que nadie puede ver es un botón que nadie puede revisar, y lo
 * que se está moviendo son existencias reales en otra aplicación.
 *
 * Tres cosas que esta pantalla hace a propósito:
 *
 *  - **manda sólo este comprobante.** No hay ninguna forma de apretar acá y
 *    despachar la bandeja entera: el comprobante viaja en el formulario y el
 *    servicio lo exige como argumento obligatorio;
 *  - **pide confirmación aparte.** El primer clic muestra qué se va a mandar;
 *    el segundo lo manda. Mover stock no es una acción que convenga poder hacer
 *    de un saque;
 *  - **si falta configuración, no deja apretar y dice qué falta**, por el
 *    nombre de la variable. El valor no pasa por acá ni tendría por qué.
 *
 * Y una que no hace: después de un envío sin respuesta **no dice que salió
 * bien**. Ese caso se nombra como lo que es —puede haber llegado— y el
 * reintento va con la misma clave de idempotencia, que es lo único que impide
 * que la mercadería entre dos veces.
 */

export interface MovimientoEnPantalla {
  id: string;
  sucursal: string;
  branchCode: string | null;
  plu: string;
  quantity: string;
  unit: string;
  direction: string;
  status: string;
  attempts: number;
  lastError: string | null;
  externalId: string | null;
  reintentable: boolean;
}

/** Cómo se nombra cada estado de un movimiento, y con qué color. */
const ESTADO: Record<string, { texto: string; clase: string }> = {
  PENDIENTE: { texto: 'pendiente de enviar', clase: 'estado-aviso' },
  EN_PROCESO: { texto: 'enviado, sin confirmación', clase: 'estado-info' },
  COMPLETADO: { texto: 'completado', clase: 'estado-ok' },
  FALLIDO: { texto: 'falló', clase: 'estado-error' },
};

function Boton({ etiqueta }: { etiqueta: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="boton boton-bloque"
      disabled={pending}
      data-prueba="confirmar-despacho"
    >
      {pending ? 'Enviando…' : etiqueta}
    </button>
  );
}

export function DespacharStock({
  documentId,
  movimientos,
  faltaConfigurar,
  sinImpacto,
}: {
  documentId: string;
  movimientos: MovimientoEnPantalla[];
  faltaConfigurar: string[];
  /** Los renglones que no mueven stock, y por qué. Se muestran aparte. */
  sinImpacto: { descripcion: string; motivo: string }[];
}) {
  const [estado, accion] = useActionState<ResultadoDelDespacho, FormData>(
    despacharMovimientosDeStock,
    {},
  );
  const [confirmando, setConfirmando] = useState(false);

  /* Lo devuelto por el servidor manda sobre lo que se cargó con la página. */
  const enPantalla = estado.resultado?.movimientos ?? movimientos;
  const faltan = estado.resultado?.faltaConfigurar ?? faltaConfigurar;
  const sinConfigurar = faltan.length > 0;

  const completados = enPantalla.filter((m) => m.status === 'COMPLETADO');
  const agotados = enPantalla.filter((m) => m.status !== 'COMPLETADO' && !m.reintentable);
  /*
   * Los que nunca salieron y los que ya salieron se cuentan por separado, y se
   * mandan por separado. Un movimiento EN_PROCESO puede haber llegado: volver a
   * mandarlo es inofensivo por la clave, pero no es la misma decisión que
   * mandar algo que no salió nunca, y quien aprieta tiene que poder verlo.
   */
  const porMandar = enPantalla.filter((m) => m.reintentable && m.status !== 'EN_PROCESO');
  const inciertos = enPantalla.filter((m) => m.reintentable && m.status === 'EN_PROCESO');

  return (
    <div className="card" data-prueba="despacho-de-stock">
      <div className="card-titulo">
        <h2>Enviar la mercadería a Control de Stock</h2>
      </div>

      <p className="ayuda">
        Se envían únicamente los movimientos de <strong>este comprobante</strong>. Nada de esto
        toca el pago, el costo ni el estado del comprobante: es la otra consecuencia de la misma
        compra, y se audita por separado.
      </p>

      {/*
        La tabla va envuelta, como las otras cuatro de la aplicación: `table`
        tiene un ancho mínimo de 560px y la pantalla del teléfono mide 390. Sin
        esto se desborda, empuja el cuerpo a lo ancho y —lo que es peor— queda
        por encima del botón de enviar, que es justamente el control que no
        puede quedar tapado. Lo encontró la prueba de navegador.
      */}
      <div className="tabla-scroll">
        <table className="tabla" data-prueba="movimientos-de-stock">
          <thead>
            <tr>
              <th>Sucursal</th>
              <th>PLU</th>
              <th>Cantidad</th>
              <th>Unidad</th>
              <th>Movimiento</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {enPantalla.map((m) => (
              <tr key={m.id} data-prueba="movimiento" data-estado={m.status}>
                <td>
                  {m.sucursal}
                  {m.branchCode ? (
                    <span className="chico medio"> ({m.branchCode})</span>
                  ) : (
                    <span className="chico" data-prueba="sin-codigo-de-sucursal">
                      {' '}
                      sin código de Control de Stock
                    </span>
                  )}
                </td>
                <td data-prueba="plu">{m.plu}</td>
                <td data-prueba="cantidad">{m.quantity}</td>
                <td data-prueba="unidad">{m.unit}</td>
                <td>{m.direction === 'INGRESO' ? 'Ingreso' : m.direction}</td>
                <td>
                  <span className={`etiqueta-estado ${ESTADO[m.status]?.clase ?? 'estado-neutro'}`}>
                    {ESTADO[m.status]?.texto ?? m.status}
                  </span>
                  {m.externalId ? (
                    <div className="chico medio" data-prueba="id-externo">
                      id {m.externalId}
                    </div>
                  ) : null}
                  {m.lastError ? (
                    <div className="chico" data-prueba="motivo-del-movimiento">
                      {m.lastError}
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sinImpacto.length > 0 ? (
        <div className="mensaje mensaje-info" style={{ marginTop: 10 }}>
          <strong>No mueven stock, y no se envían:</strong>
          <ul className="lista-simple" style={{ marginTop: 6 }} data-prueba="sin-impacto">
            {sinImpacto.map((r) => (
              <li key={r.descripcion}>
                {r.descripcion} — {r.motivo}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {sinConfigurar ? (
        <div className="mensaje mensaje-aviso" style={{ marginTop: 10 }} data-prueba="sin-configurar">
          <strong>La integración de escritura no está configurada.</strong>
          <p className="chico" style={{ marginTop: 6 }}>
            Falta cargar {faltan.join(' y ')} en el entorno del servidor. Hasta entonces no sale
            ningún pedido: los movimientos quedan anotados y no se pierde nada.
          </p>
        </div>
      ) : null}

      {estado.error ? (
        <p className="mensaje mensaje-error" role="alert" data-prueba="error-del-despacho">
          {estado.error}
        </p>
      ) : null}

      {estado.resultado ? (
        <p
          className={`mensaje ${estado.resultado.ok ? 'mensaje-ok' : 'mensaje-aviso'}`}
          role="status"
          data-prueba="resultado-del-despacho"
          data-estado={estado.resultado.estado}
        >
          {estado.resultado.mensaje}
        </p>
      ) : null}

      {completados.length > 0 ? (
        <p className="chico medio" data-prueba="ya-completados">
          {completados.length} {completados.length === 1 ? 'movimiento' : 'movimientos'} ya
          confirmados por Control de Stock. No se vuelven a enviar.
        </p>
      ) : null}

      {agotados.length > 0 ? (
        <p className="chico" data-prueba="agotados">
          {agotados.length} sin reintentos disponibles. Hay que mirarlos antes de insistir.
        </p>
      ) : null}

      {inciertos.length > 0 ? (
        <div className="mensaje mensaje-info" style={{ marginTop: 10 }} data-prueba="inciertos">
          <strong>
            {inciertos.length} {inciertos.length === 1 ? 'movimiento salió' : 'movimientos salieron'}{' '}
            y no volvió confirmación.
          </strong>
          <p className="chico" style={{ marginTop: 6 }}>
            Pueden haber llegado: desde acá no se distingue de un pedido que nunca llegó. Volver a
            mandarlos usa la misma clave de idempotencia, así que Control de Stock los reconoce y no
            mueve nada dos veces.
          </p>
          <form action={accion} style={{ marginTop: 8 }}>
            <input type="hidden" name="documentId" value={documentId} />
            <input type="hidden" name="incluirInciertas" value="1" />
            <button
              type="submit"
              className="boton boton-secundario boton-bloque"
              disabled={sinConfigurar}
              data-prueba="reintentar-inciertos"
            >
              Reintentar los {inciertos.length} sin confirmación
            </button>
          </form>
        </div>
      ) : null}

      {porMandar.length === 0 ? (
        <p className="chico medio" data-prueba="nada-para-enviar">
          No hay movimientos nuevos para enviar.
        </p>
      ) : !confirmando ? (
        <button
          type="button"
          className="boton boton-bloque"
          onClick={() => setConfirmando(true)}
          disabled={sinConfigurar}
          data-prueba="pedir-despacho"
        >
          Enviar {porMandar.length}{' '}
          {porMandar.length === 1 ? 'movimiento' : 'movimientos'} a Control de Stock
        </button>
      ) : (
        <div className="mensaje mensaje-aviso" style={{ marginTop: 10 }}>
          <strong>
            Se van a enviar {porMandar.length}{' '}
            {porMandar.length === 1 ? 'movimiento' : 'movimientos'} de este comprobante.
          </strong>
          <p className="chico" style={{ marginTop: 6 }}>
            Esto mueve existencias reales en Control de Stock. Los que ya están confirmados no se
            reenvían, y si algo sale a medias el reintento va con la misma clave, así que la
            mercadería no entra dos veces.
          </p>
          <form action={accion} style={{ marginTop: 8 }}>
            <input type="hidden" name="documentId" value={documentId} />
            <Boton etiqueta="Confirmar y enviar" />
          </form>
          <button
            type="button"
            className="boton boton-secundario boton-bloque"
            style={{ marginTop: 6 }}
            onClick={() => setConfirmando(false)}
            data-prueba="cancelar-despacho"
          >
            Cancelar
          </button>
        </div>
      )}
    </div>
  );
}
