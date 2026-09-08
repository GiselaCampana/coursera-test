'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { aprobarPrecio, type ResultadoPrecio } from './acciones';

function BotonAprobar() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="boton boton-chico" disabled={pending}>
      {pending ? 'Guardando…' : 'Aprobar'}
    </button>
  );
}

export function FichaPrecio({
  productId,
  nombre,
  sugerido,
  porUnidad = false,
}: {
  productId: string;
  nombre: string;
  sugerido: string;
  /** El artículo se vende entero, así que el precio es por unidad y no por kilo. */
  porUnidad?: boolean;
}) {
  const [abierto, setAbierto] = useState(false);
  const [estado, accion] = useActionState<ResultadoPrecio, FormData>(aprobarPrecio, {});

  if (estado.ok && estado.productId === productId) {
    return (
      <p className="mensaje mensaje-ok mt mb0" role="status">
        Precio aprobado y guardado en el historial.
      </p>
    );
  }

  if (!abierto) {
    return (
      <div className="acciones">
        <button
          type="button"
          className="boton boton-secundario boton-chico"
          onClick={() => setAbierto(true)}
        >
          Aprobar el precio
        </button>
      </div>
    );
  }

  return (
    <form action={accion} className="mt">
      <input type="hidden" name="productId" value={productId} />

      {estado.error && estado.productId === productId ? (
        <p className="mensaje mensaje-error" role="alert">
          {estado.error}
        </p>
      ) : null}

      <div className="fila fila-2">
        <div className="campo">
          <label htmlFor={`precio-${productId}`}>
            {porUnidad ? 'Precio por unidad' : 'Precio por kilo'} para {nombre}
          </label>
          <input
            id={`precio-${productId}`}
            name="precio"
            type="text"
            inputMode="decimal"
            defaultValue={sugerido}
            required
          />
          <p className="ayuda">Podés cambiar el sugerido antes de aprobarlo.</p>
        </div>
        <div className="campo">
          <label htmlFor={`vigencia-${productId}`}>Vigente desde</label>
          <input id={`vigencia-${productId}`} name="vigencia" type="date" />
        </div>
      </div>

      <div className="acciones">
        <button
          type="button"
          className="boton boton-secundario boton-chico"
          onClick={() => setAbierto(false)}
        >
          Cancelar
        </button>
        <BotonAprobar />
      </div>
    </form>
  );
}
