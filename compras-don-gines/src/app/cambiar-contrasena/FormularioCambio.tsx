'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { cambiarMiContrasena, type CambioState } from './acciones';

function BotonGuardar() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="boton boton-bloque" disabled={pending}>
      {pending ? 'Guardando…' : 'Guardar contraseña'}
    </button>
  );
}

export function FormularioCambio({ minimo }: { minimo: number }) {
  const [state, formAction] = useActionState<CambioState, FormData>(cambiarMiContrasena, {});

  return (
    <form action={formAction} noValidate>
      {state.error ? (
        <p className="mensaje mensaje-error" role="alert">
          {state.error}
        </p>
      ) : null}

      <div className="campo">
        <label htmlFor="actual">Contraseña actual</label>
        <input
          id="actual"
          name="actual"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>

      <div className="campo">
        <label htmlFor="nueva">Contraseña nueva</label>
        <input id="nueva" name="nueva" type="password" autoComplete="new-password" required />
        <p className="ayuda">
          Al menos {minimo} caracteres, combinando letras y números.
        </p>
      </div>

      <div className="campo">
        <label htmlFor="repetida">Repetir la nueva</label>
        <input
          id="repetida"
          name="repetida"
          type="password"
          autoComplete="new-password"
          required
        />
      </div>

      <BotonGuardar />
    </form>
  );
}
