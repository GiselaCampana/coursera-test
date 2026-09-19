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
    <div className="space-y-2">
      <button
        type="button"
        onClick={aplicar}
        disabled={!sePuedeAplicar || aplicando}
        className="rounded bg-slate-900 px-4 py-2 text-white disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        {aplicando ? 'Aplicando…' : 'Aplicar la compra'}
      </button>
      {!sePuedeAplicar && (
        <p className="text-sm text-slate-600">
          Resolvé lo de arriba y volvé a abrir esta pantalla.
        </p>
      )}
      {error && <p className="text-sm text-rose-800">{error}</p>}
    </div>
  );
}
