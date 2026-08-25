'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import {
  aceptarComprobante,
  anularComprobante,
  rechazarComprobante,
  type ResultadoAccion,
} from './acciones';

function BotonEnviar({ texto, cargando }: { texto: string; cargando: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="boton boton-peligro" disabled={pending}>
      {pending ? cargando : texto}
    </button>
  );
}

function BotonAceptar() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="boton boton-bloque" disabled={pending}>
      {pending ? 'Controlando…' : 'Aceptar y validar comprobante'}
    </button>
  );
}

export function AccionesComprobante({
  documentId,
  estado,
  puedeAnular,
  puedeValidar,
  hayErrores,
}: {
  documentId: string;
  estado: string;
  puedeAnular: boolean;
  /** Permiso para validar comprobantes. */
  puedeValidar: boolean;
  /** ¿El último informe dejó algún control en error? */
  hayErrores: boolean;
}) {
  const [abierto, setAbierto] = useState(false);
  const esConfirmado = estado === 'VALIDADO';
  const esAnulable = esConfirmado && puedeAnular;
  const esRechazable = estado === 'REQUIERE_REVISION' || estado === 'BORRADOR';
  /*
   * Aceptar es una acción distinta de rechazar, y va primero.
   *
   * Un comprobante leído queda en REQUIERE_REVISION esperando que alguien lo
   * confirme. Que tenga advertencias no lo invalida: una relectura que hizo
   * falta, un renglón cuyo importe no entró en el recorte o unos centavos
   * conciliados son cosas que no impiden pagar la factura. Lo que impide
   * validarla es un **error**, y para eso está el otro camino.
   *
   * El botón se ofrece igual cuando hay errores, pero deshabilitado y diciendo
   * cuáles: esconderlo dejaría al operador otra vez sin entender por qué la
   * única salida es rechazar.
   */
  const esAceptable = esRechazable && puedeValidar;

  const [estadoAnular, accionAnular] = useActionState<ResultadoAccion, FormData>(
    anularComprobante,
    {},
  );
  const [estadoRechazar, accionRechazar] = useActionState<ResultadoAccion, FormData>(
    rechazarComprobante,
    {},
  );
  const [estadoAceptar, accionAceptar] = useActionState<ResultadoAccion, FormData>(
    aceptarComprobante,
    {},
  );

  if (!esAnulable && !esRechazable) {
    return (
      <div className="acciones">
        <Link href="/comprobantes" className="boton boton-secundario boton-bloque">
          Volver a los comprobantes
        </Link>
      </div>
    );
  }

  const resultado = estadoAnular.error ? estadoAnular : estadoRechazar;

  return (
    <>
      {esAceptable ? (
        <div className="card">
          <h2>Aceptar el comprobante</h2>
          <p className="chico medio">
            {hayErrores
              ? 'Este comprobante todavía tiene controles que no cierran, así que no se puede validar. Resolvelos desde la carga, o volvé a leer la imagen.'
              : 'Los controles cierran. Al aceptarlo se vuelven a correr todos con los datos guardados, ' +
                'el comprobante queda validado y se agenda el pago. Las advertencias quedan registradas.'}
          </p>

          {estadoAceptar.error ? (
            <div className="mensaje mensaje-error" role="alert">
              <p>{estadoAceptar.error}</p>
              {estadoAceptar.controles ? (
                <ul>
                  {estadoAceptar.controles.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {hayErrores ? (
            <button type="button" className="boton boton-bloque" disabled>
              Aceptar y validar comprobante
            </button>
          ) : (
            <form action={accionAceptar}>
              <input type="hidden" name="documentId" value={documentId} />
              <BotonAceptar />
            </form>
          )}
        </div>
      ) : null}

      <div className="card">
        <h2>{esAnulable ? 'Anular el comprobante' : 'Rechazar la carga'}</h2>
      <p className="chico medio">
        {esAnulable
          ? 'Da de baja el comprobante, cancela su pago y libera el número para volver a cargarlo. Queda registrado en la auditoría con tu usuario.'
          : 'Descarta esta carga y libera el número del comprobante para volver a cargarlo bien.'}
      </p>

      {resultado.error ? (
        <p className="mensaje mensaje-error" role="alert">
          {resultado.error}
        </p>
      ) : null}
      {estadoAnular.ok || estadoRechazar.ok ? (
        <p className="mensaje mensaje-ok" role="status">
          Listo.
        </p>
      ) : null}

      {!abierto ? (
        <div className="acciones">
          <button
            type="button"
            className="boton boton-secundario"
            onClick={() => setAbierto(true)}
          >
            {esAnulable ? 'Anular…' : 'Rechazar…'}
          </button>
          <Link href="/comprobantes" className="boton boton-secundario">
            Volver
          </Link>
        </div>
      ) : (
        <form action={esAnulable ? accionAnular : accionRechazar}>
          <input type="hidden" name="documentId" value={documentId} />
          <div className="campo">
            <label htmlFor="motivo">Motivo</label>
            <textarea
              id="motivo"
              name="motivo"
              required
              minLength={esAnulable ? 10 : 5}
              placeholder={
                esAnulable
                  ? 'Por ejemplo: el proveedor emitió una nota de crédito por esta factura.'
                  : 'Por ejemplo: se cargó la factura de otra sucursal.'
              }
            />
            <p className="ayuda">
              {esAnulable ? 'Mínimo 10 caracteres.' : 'Mínimo 5 caracteres.'}
            </p>
          </div>
          <div className="acciones">
            <button
              type="button"
              className="boton boton-secundario"
              onClick={() => setAbierto(false)}
            >
              Cancelar
            </button>
            <BotonEnviar
              texto={esAnulable ? 'Anular el comprobante' : 'Rechazar la carga'}
              cargando="Procesando…"
            />
          </div>
        </form>
      )}
      </div>
    </>
  );
}
