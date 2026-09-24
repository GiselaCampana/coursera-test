'use client';

import { useState } from 'react';
import { prepararLaApertura, type Resultado } from './acciones';

/** El botón que arma el borrador de una sucursal que todavía no tiene apertura. */
export function PrepararApertura({
  branchId,
  sucursal,
  admiteHomologacion,
}: {
  branchId: string;
  sucursal: string;
  /** Lo dice el servidor, mirando el nombre de la base. */
  admiteHomologacion: boolean;
}) {
  const [r, setR] = useState<Resultado | null>(null);
  const [enviando, setEnviando] = useState(false);

  return (
    <form
      data-prueba="form-preparar"
      action={async (f) => {
        setEnviando(true);
        setR(await prepararLaApertura(null, f));
        setEnviando(false);
      }}
    >
      <input type="hidden" name="branchId" value={branchId} />
      {admiteHomologacion ? (
        /*
         * La casilla existe sólo donde la homologación tiene sentido. Nace SIN
         * marcar: una apertura ficticia es la excepción, no lo normal, y el
         * valor por omisión decide lo que pasa cuando nadie mira.
         */
        <label className="chico" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="checkbox"
            name="ficticia"
            value="si"
            data-prueba="marcar-ficticia"
            style={{ width: 'auto', minHeight: 0 }}
          />
          Apertura ficticia (datos inventados, sólo para homologación)
        </label>
      ) : (
        <p className="chico" data-prueba="sin-homologacion">
          Esta base no admite datos de homologación, así que la apertura será con datos reales y
          exige el interruptor encendido.
        </p>
      )}
      {r && (
        <p
          className={r.ok ? 'mensaje mensaje-ok' : 'mensaje mensaje-error'}
          data-prueba={r.ok ? 'resultado-ok' : 'resultado-error'}
        >
          {r.mensaje}
        </p>
      )}
      <button type="submit" className="boton" disabled={enviando} data-prueba="preparar">
        Preparar la apertura de {sucursal}
      </button>
      <p className="chico">
        Se arma con todos los artículos activos del catálogo, ninguno contado. Las cantidades salen
        de recorrer la góndola, no de ningún otro sistema.
      </p>
    </form>
  );
}
