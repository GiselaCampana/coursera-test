'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { ingresar, type LoginState } from './acciones';

function BotonIngresar() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="boton boton-bloque" disabled={pending}>
      {pending ? 'Ingresando…' : 'Ingresar'}
    </button>
  );
}

export function FormularioIngreso() {
  const [state, formAction] = useActionState<LoginState, FormData>(ingresar, {});

  return (
    <form action={formAction} noValidate>
      {state.error ? (
        <p className="mensaje mensaje-error" role="alert">
          {state.error}
        </p>
      ) : null}

      <div className="campo">
        <label htmlFor="email">Correo</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
        />
      </div>

      <div className="campo">
        <label htmlFor="password">Contraseña</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>

      <BotonIngresar />

      <p className="ayuda centrado mt mb0">
        Si no podés entrar, pedile al administrador que revise tu usuario.
      </p>
    </form>
  );
}
