'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { abrirElRecuento, type Resultado } from './acciones';

/**
 * Abrir un recuento: sucursal y un nombre, nada más.
 *
 * Los artículos se cargan después, contando. Pedir la lista de antemano llevaría
 * a contar sólo lo que alguien esperaba encontrar, que es justo lo contrario de
 * un recuento.
 */
export function AbrirRecuento({ sucursales }: { sucursales: { id: string; name: string }[] }) {
  const router = useRouter();
  const [r, setR] = useState<Resultado | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function enviar(f: FormData) {
    setEnviando(true);
    const res = await abrirElRecuento(null, f);
    setR(res);
    setEnviando(false);
    if (res.ok && res.sessionId) router.push(`/stock-erp/correcciones/recuentos/${res.sessionId}`);
  }

  return (
    <section data-prueba="abrir-recuento">
      <h2>Nuevo recuento</h2>
      {r && !r.ok && (
        <p className="mensaje mensaje-error" data-prueba="resultado-error">
          {r.mensaje}
        </p>
      )}
      <form action={enviar}>
        <label>
          Sucursal
          <select name="branchId" required data-prueba="sucursal-recuento">
            <option value="">Elegí una…</option>
            {sucursales.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Nombre (opcional)
          <input name="nombre" placeholder="Control de quesos de la semana" data-prueba="nombre-recuento" />
        </label>
        <button type="submit" disabled={enviando} data-prueba="abrir">
          {enviando ? 'Abriendo…' : 'Abrir recuento'}
        </button>
      </form>
    </section>
  );
}
