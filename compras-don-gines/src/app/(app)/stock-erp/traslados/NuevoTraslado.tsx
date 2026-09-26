'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { crearElBorrador, type Resultado } from './acciones';

/**
 * Alta de un traslado: elegir origen y destino, nada más.
 *
 * Los artículos se agregan después, en el borrador. Pedir todo junto en una sola
 * pantalla obliga a decidir el destino con la lista de artículos a medio armar, y
 * el destino es lo que determina qué se puede mandar.
 *
 * El botón queda deshabilitado mientras origen y destino coincidan: el servicio
 * lo rechaza igual —y una prueba lo comprueba—, pero avisar antes evita que
 * alguien complete el formulario para que se lo rechacen al final.
 */
export function NuevoTraslado({ sucursales }: { sucursales: { id: string; name: string }[] }) {
  const router = useRouter();
  const [origen, setOrigen] = useState('');
  const [destino, setDestino] = useState('');
  const [r, setR] = useState<Resultado | null>(null);
  const [enviando, setEnviando] = useState(false);

  const mismas = origen !== '' && origen === destino;

  async function enviar(f: FormData) {
    setEnviando(true);
    const res = await crearElBorrador(null, f);
    setR(res);
    setEnviando(false);
    if (res.ok && res.trasladoId) router.push(`/stock-erp/traslados/${res.trasladoId}`);
  }

  return (
    <section data-prueba="nuevo-traslado">
      <h2>Nuevo traslado</h2>
      {r && !r.ok && (
        <p className="mensaje mensaje-error" data-prueba="resultado-error">
          {r.mensaje}
        </p>
      )}
      <form action={enviar}>
        <label>
          Sucursal de origen
          <select
            name="origenId"
            value={origen}
            onChange={(e) => setOrigen(e.target.value)}
            required
            data-prueba="origen"
          >
            <option value="">Elegí una…</option>
            {sucursales.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sucursal de destino
          <select
            name="destinoId"
            value={destino}
            onChange={(e) => setDestino(e.target.value)}
            required
            data-prueba="destino"
          >
            <option value="">Elegí una…</option>
            {sucursales.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        {mismas && (
          <p className="mensaje mensaje-error" data-prueba="mismas-sucursales">
            El origen y el destino tienen que ser distintos: un traslado de una sucursal a sí misma
            no mueve mercadería.
          </p>
        )}
        <button
          type="submit"
          disabled={enviando || mismas || origen === '' || destino === ''}
          data-prueba="crear-borrador"
        >
          {enviando ? 'Creando…' : 'Crear borrador'}
        </button>
      </form>
    </section>
  );
}
