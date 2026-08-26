'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { repararComprobante, type ResultadoAccion } from './acciones';

function Boton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="boton boton-bloque" disabled={pending}>
      {pending ? 'Reparando…' : 'Reparar derivados del comprobante'}
    </button>
  );
}

/**
 * La salida para un comprobante que quedó validado pero incompleto.
 *
 * Se ofrece solamente cuando falta algo, y diciendo qué falta antes de tocar
 * nada. Un comprobante sano no muestra esta tarjeta: un botón de reparar
 * siempre presente invita a apretarlo por las dudas, y lo que hay que mirar
 * cuando aparece es por qué apareció.
 *
 * Lo que se repara son los movimientos de compra, el historial de costos y la
 * agenda de pago. Los importes del comprobante no se tocan —salen de los
 * renglones que ya están guardados— y la foto no se vuelve a leer.
 */
export function RepararDerivados({
  documentId,
  hallazgos,
}: {
  documentId: string;
  hallazgos: string[];
}) {
  const [estado, accion] = useActionState<ResultadoAccion, FormData>(repararComprobante, {});

  return (
    <div className="card">
      <h2>Este comprobante está validado pero incompleto</h2>
      <p className="chico medio">
        Quedó guardado y sus importes están bien, pero al confirmarlo no se escribió todo lo que
        depende de él. Mientras siga así, esta compra no aparece completa en Compras, Precios o
        Pagos.
      </p>

      <div className="mensaje mensaje-aviso">
        <ul>
          {hallazgos.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      </div>

      <p className="chico medio">
        Reparar rehace los movimientos de compra, el historial de costos y la agenda a partir de
        los renglones ya guardados. No cambia ningún importe, no duplica movimientos y no vuelve a
        leer la imagen. Queda registrado en la auditoría con tu usuario.
      </p>

      {estado.error ? (
        <p className="mensaje mensaje-error" role="alert">
          {estado.error}
        </p>
      ) : null}

      <form action={accion}>
        <input type="hidden" name="documentId" value={documentId} />
        <Boton />
      </form>
    </div>
  );
}
