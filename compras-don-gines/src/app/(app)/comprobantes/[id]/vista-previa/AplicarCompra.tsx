'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * El botón que escribe, y lo único de esta pantalla que escribe.
 *
 * Queda deshabilitado mientras la vista previa tenga frenos, pero eso es una
 * cortesía y no la defensa: el backend vuelve a mirar la misma lista antes de
 * aplicar, así que una pantalla vieja o una llamada directa tampoco pueden
 * saltearla.
 */
export function AplicarCompra({
  documentId,
  sePuedeAplicar,
}: {
  documentId: string;
  sePuedeAplicar: boolean;
}) {
  const router = useRouter();
  const [aplicando, setAplicando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function aplicar() {
    setAplicando(true);
    setError(null);
    try {
      const respuesta = await fetch(`/api/comprobantes/${documentId}/vista-previa`, {
        method: 'POST',
      });
      const cuerpo = await respuesta.json();
      if (!respuesta.ok) {
        setError(cuerpo?.error ?? 'No se pudo aplicar la compra.');
        return;
      }
      router.push(`/comprobantes/${documentId}`);
      router.refresh();
    } catch {
      setError('No se pudo aplicar la compra.');
    } finally {
      setAplicando(false);
    }
  }

  return (
    <div>
      <div className="acciones">
        <button
          type="button"
          onClick={aplicar}
          disabled={!sePuedeAplicar || aplicando}
          className="boton"
        >
          {aplicando ? 'Aplicando…' : 'Aplicar la compra'}
        </button>
      </div>
      {!sePuedeAplicar && (
        <p className="ayuda">Resolvé lo de arriba y volvé a abrir esta pantalla.</p>
      )}
      {error && (
        <p className="mensaje mensaje-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
