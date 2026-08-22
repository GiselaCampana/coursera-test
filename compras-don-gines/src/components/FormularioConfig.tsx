'use client';

import { useActionState, useState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import type { ResultadoConfig } from '@/app/(app)/configuracion/acciones';

function BotonGuardar({ texto = 'Guardar' }: { texto?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="boton" disabled={pending}>
      {pending ? 'Guardando…' : texto}
    </button>
  );
}

/**
 * Formulario plegable de configuración.
 *
 * Todos los ABM de esta sección se comportan igual: se despliegan, muestran el
 * error en castellano que devuelve el servidor y se cierran al guardar bien.
 */
export function FormularioConfig({
  titulo,
  textoBoton,
  accion,
  children,
  abiertoInicial = false,
  textoGuardar,
}: {
  titulo: string;
  textoBoton: string;
  accion: (prev: ResultadoConfig, form: FormData) => Promise<ResultadoConfig>;
  children: ReactNode;
  abiertoInicial?: boolean;
  textoGuardar?: string;
}) {
  const [abierto, setAbierto] = useState(abiertoInicial);
  const [estado, formAction] = useActionState<ResultadoConfig, FormData>(accion, {});

  if (!abierto) {
    return (
      <div className="acciones">
        <button
          type="button"
          className="boton boton-secundario boton-chico"
          onClick={() => setAbierto(true)}
        >
          {textoBoton}
        </button>
        {estado.ok ? (
          <span className="chico positivo" role="status">
            Guardado.
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <form action={formAction} className="mt">
      <h3>{titulo}</h3>

      {estado.error ? (
        <p className="mensaje mensaje-error" role="alert">
          {estado.error}
        </p>
      ) : null}
      {estado.ok ? (
        <p className="mensaje mensaje-ok" role="status">
          Guardado.
        </p>
      ) : null}

      {children}

      <div className="acciones">
        <button
          type="button"
          className="boton boton-secundario"
          onClick={() => setAbierto(false)}
        >
          Cerrar
        </button>
        <BotonGuardar texto={textoGuardar} />
      </div>
    </form>
  );
}

export function Casilla({
  name,
  etiqueta,
  defecto = false,
  valor,
}: {
  name: string;
  etiqueta: string;
  defecto?: boolean;
  valor?: string;
}) {
  return (
    <label className="etiqueta" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <input
        type="checkbox"
        name={name}
        value={valor}
        defaultChecked={defecto}
        style={{ width: 'auto', minHeight: 0 }}
      />
      {etiqueta}
    </label>
  );
}
