'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import { anularComprobante, rechazarComprobante, type ResultadoAccion } from './acciones';

function BotonEnviar({ texto, cargando }: { texto: string; cargando: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="boton boton-peligro" disabled={pending}>
      {pending ? cargando : texto}
    </button>
  );
}

export function AccionesComprobante({
  documentId,
  estado,
  puedeAnular,
}: {
  documentId: string;
  estado: string;
  puedeAnular: boolean;
}) {
  const [abierto, setAbierto] = useState(false);
  const esConfirmado = estado === 'VALIDADO';
  const esAnulable = esConfirmado && puedeAnular;
  const esRechazable = estado === 'REQUIERE_REVISION' || estado === 'BORRADOR';

  const [estadoAnular, accionAnular] = useActionState<ResultadoAccion, FormData>(
    anularComprobante,
    {},
  );
  const [estadoRechazar, accionRechazar] = useActionState<ResultadoAccion, FormData>(
    rechazarComprobante,
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
  );
}
