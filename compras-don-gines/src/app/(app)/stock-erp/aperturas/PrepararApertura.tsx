'use client';

import { useState } from 'react';
import { prepararLaApertura, type Resultado } from './acciones';

/** El botón que arma el borrador de una sucursal que todavía no tiene apertura. */
export function PrepararApertura({ branchId, sucursal }: { branchId: string; sucursal: string }) {
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
