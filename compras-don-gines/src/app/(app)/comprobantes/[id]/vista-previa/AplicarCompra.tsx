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
 *
 * **Cuando el proveedor no tiene condición de pago acordada**, antes del botón
 * hay que elegir dos cosas: la forma de pago y el vencimiento. Nada viene
 * marcado. Eso no es una molestia de la pantalla: es lo que faltaba. Antes la
 * compra se aplicaba sola con el vencimiento puesto en la fecha de emisión y
 * la forma en «Transferencia», las dos sin que nadie las eligiera, y una fecha
 * de pago inventada no se distingue después de una acordada.
 */

type Condicion = '' | 'CONTADO' | 'DIAS' | 'FECHA';

export function AplicarCompra({
  documentId,
  sePuedeAplicar,
  hayQueElegirComoSePaga,
  formasDePago,
}: {
  documentId: string;
  sePuedeAplicar: boolean;
  hayQueElegirComoSePaga: boolean;
  formasDePago: { codigo: string; nombre: string }[];
}) {
  const router = useRouter();
  const [aplicando, setAplicando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Nada preseleccionado, a propósito: elegir es el punto.
  const [forma, setForma] = useState('');
  const [condicion, setCondicion] = useState<Condicion>('');
  const [dias, setDias] = useState('');
  const [fecha, setFecha] = useState('');

  const decisionCompleta =
    forma !== '' &&
    (condicion === 'CONTADO' ||
      (condicion === 'DIAS' && dias.trim() !== '') ||
      (condicion === 'FECHA' && fecha.trim() !== ''));

  const listo = sePuedeAplicar || (hayQueElegirComoSePaga && decisionCompleta);

  async function aplicar() {
    setAplicando(true);
    setError(null);
    try {
      const cuerpo = hayQueElegirComoSePaga
        ? {
            pago: {
              forma,
              condicion:
                condicion === 'DIAS'
                  ? { tipo: 'DIAS', dias: Number(dias) }
                  : condicion === 'FECHA'
                    ? { tipo: 'FECHA', fecha }
                    : { tipo: 'CONTADO' },
            },
          }
        : {};

      const respuesta = await fetch(`/api/comprobantes/${documentId}/vista-previa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cuerpo),
      });
      const datos = await respuesta.json();
      if (!respuesta.ok) {
        setError(datos?.error ?? 'No se pudo aplicar la compra.');
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
      {hayQueElegirComoSePaga && (
        <div className="card card-compacta" style={{ marginBottom: 12 }}>
          <div className="card-titulo">
            <h3>Cómo se paga</h3>
          </div>
          <p className="ayuda">
            Este proveedor no tiene condición de pago acordada, así que hay que elegirla. No hay
            ninguna opción marcada por omisión.
          </p>

          <div className="fila fila-2">
            <div className="campo">
              <label htmlFor="forma-de-pago">Forma de pago</label>
              <select
                id="forma-de-pago"
                value={forma}
                onChange={(evento) => setForma(evento.target.value)}
              >
                <option value="">Elegir…</option>
                {formasDePago.map((opcion) => (
                  <option key={opcion.codigo} value={opcion.codigo}>
                    {opcion.nombre}
                  </option>
                ))}
              </select>
            </div>

            <div className="campo">
              <label htmlFor="condicion-de-pago">Condición</label>
              <select
                id="condicion-de-pago"
                value={condicion}
                onChange={(evento) => setCondicion(evento.target.value as Condicion)}
              >
                <option value="">Elegir…</option>
                <option value="CONTADO">Contado (vence el día de emisión)</option>
                <option value="DIAS">A x días de la emisión</option>
                <option value="FECHA">Una fecha puntual</option>
              </select>
            </div>
          </div>

          {condicion === 'DIAS' && (
            <div className="campo">
              <label htmlFor="dias-de-plazo">Días</label>
              <input
                id="dias-de-plazo"
                type="number"
                min={1}
                max={365}
                inputMode="numeric"
                value={dias}
                onChange={(evento) => setDias(evento.target.value)}
              />
              <p className="ayuda">El vencimiento se calcula desde la fecha de emisión.</p>
            </div>
          )}

          {condicion === 'FECHA' && (
            <div className="campo">
              <label htmlFor="fecha-de-vencimiento">Fecha de vencimiento</label>
              <input
                id="fecha-de-vencimiento"
                type="date"
                value={fecha}
                onChange={(evento) => setFecha(evento.target.value)}
              />
              <p className="ayuda">
                Queda registrada como una decisión manual. No puede ser anterior a la emisión.
              </p>
            </div>
          )}
        </div>
      )}

      <div className="acciones">
        <button type="button" onClick={aplicar} disabled={!listo || aplicando} className="boton">
          {aplicando ? 'Aplicando…' : 'Aplicar la compra'}
        </button>
      </div>

      {!listo && (
        <p className="ayuda">
          {hayQueElegirComoSePaga
            ? 'Elegí la forma de pago y la condición para poder aplicar.'
            : 'Resolvé lo de arriba y volvé a abrir esta pantalla.'}
        </p>
      )}
      {error && (
        <p className="mensaje mensaje-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
