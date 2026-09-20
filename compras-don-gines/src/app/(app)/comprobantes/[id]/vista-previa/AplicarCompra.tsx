'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { resolverDecisionDePago, FRENO_DE_COMO_SE_PAGA } from '@/lib/domain/decision-de-pago';
import { dateOnlyFromISO, formatDateAr } from '@/lib/datetime';

/**
 * El botón que escribe, y lo único de esta pantalla que escribe.
 *
 * Queda deshabilitado mientras la compra tenga frenos, pero eso es una cortesía
 * y no la defensa: el backend vuelve a mirar la misma lista antes de aplicar,
 * así que una pantalla vieja o una llamada directa tampoco pueden saltearla.
 *
 * **Cuando el proveedor no tiene condición de pago acordada**, antes del botón
 * hay que elegir dos cosas: la forma de pago y el vencimiento. Nada viene
 * marcado. Eso no es una molestia de la pantalla: es lo que faltaba. Antes la
 * compra se aplicaba sola con el vencimiento puesto en la fecha de emisión y
 * la forma en «Transferencia», las dos sin que nadie las eligiera, y una fecha
 * de pago inventada no se distingue después de una acordada.
 *
 * **Los avisos viven acá y no en la página** porque tienen que moverse con lo
 * que la persona elige. Armados en el servidor quedaban congelados en el
 * estado inicial: el recuadro amarillo seguía diciendo «todavía no se puede
 * aplicar» con el botón ya habilitado, y el texto de abajo seguía pidiendo que
 * se eligiera la forma y la condición cuando las dos ya estaban elegidas y lo
 * único mal era la fecha. Un aviso que no corresponde al estado enseña a no
 * leer los avisos.
 */

type Condicion = '' | 'CONTADO' | 'DIAS' | 'FECHA';

export function AplicarCompra({
  documentId,
  frenos,
  yaValidado,
  hayQueElegirComoSePaga,
  formasDePago,
  emisionISO,
}: {
  documentId: string;
  /** Todo lo que frena la compra, tal como lo calculó el servidor. */
  frenos: string[];
  /** El comprobante ya está validado: no hay nada que aplicar. */
  yaValidado: boolean;
  hayQueElegirComoSePaga: boolean;
  formasDePago: { codigo: string; nombre: string }[];
  emisionISO: string | null;
}) {
  const router = useRouter();
  const [aplicando, setAplicando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Nada preseleccionado, a propósito: elegir es el punto.
  const [forma, setForma] = useState('');
  const [condicion, setCondicion] = useState<Condicion>('');
  const [dias, setDias] = useState('');
  const [fecha, setFecha] = useState('');

  /*
   * Los frenos que esta pantalla no puede levantar.
   *
   * Un renglón sin asociar o un total que no está impreso necesitan que alguien
   * vuelva al comprobante; no hay nada que elegir acá que los resuelva. Se
   * separan del de cómo se paga para no hacer desaparecer un aviso que sigue
   * siendo cierto —ni dejar el botón habilitado cuando todavía falta algo más.
   */
  const otrosFrenos = frenos.filter((freno) => freno !== FRENO_DE_COMO_SE_PAGA);

  const decisionCompleta =
    forma !== '' &&
    (condicion === 'CONTADO' ||
      (condicion === 'DIAS' && dias.trim() !== '') ||
      (condicion === 'FECHA' && fecha.trim() !== ''));

  /*
   * Qué día cae lo que se acaba de elegir, antes de apretar el botón.
   *
   * Se resuelve con la MISMA función que usa el servidor para validar, no con
   * una cuenta parecida escrita acá: si las dos cuentas fueran distintas, la
   * pantalla podría prometer una fecha y el servidor guardar otra, que es una
   * variante más silenciosa del mismo defecto. Por eso también se muestra el
   * motivo cuando la decisión no sirve —una fecha anterior a la emisión, un
   * plazo absurdo— en vez de dejar que el error aparezca recién al aplicar.
   */
  const resuelto =
    decisionCompleta && emisionISO
      ? resolverDecisionDePago(
          {
            forma,
            condicion:
              condicion === 'DIAS'
                ? { tipo: 'DIAS', dias: Number(dias) }
                : condicion === 'FECHA'
                  ? { tipo: 'FECHA', fecha }
                  : { tipo: 'CONTADO' },
          },
          dateOnlyFromISO(emisionISO),
        )
      : null;

  /** El pago está resuelto: o no había que elegirlo, o lo elegido sirve. */
  const pagoListo = !hayQueElegirComoSePaga || resuelto?.ok === true;
  const listo = !yaValidado && otrosFrenos.length === 0 && pagoListo;

  /**
   * Qué falta, dicho como está el formulario ahora mismo.
   *
   * Se calcula en cada render a partir del estado, así que cambia con cada
   * elección. `null` quiere decir que no falta nada y no va ningún aviso: el
   * botón habilitado ya lo dice, y agregar un mensaje positivo sería una
   * felicitación que nadie pidió.
   */
  function loQueFalta(): string | null {
    if (yaValidado) return 'Este comprobante ya está validado.';
    if (otrosFrenos.length > 0) return 'Resolvé lo de arriba y volvé a abrir esta pantalla.';
    if (!hayQueElegirComoSePaga) return null;

    if (forma === '' && condicion === '') {
      return 'Elegí la forma de pago y la condición para poder aplicar.';
    }
    if (forma === '') return 'Elegí la forma de pago para poder aplicar.';
    if (condicion === '') return 'Elegí la condición para poder aplicar.';
    if (condicion === 'DIAS' && dias.trim() === '') {
      return 'Escribí a cuántos días vence para poder aplicar.';
    }
    if (condicion === 'FECHA' && fecha.trim() === '') {
      return 'Elegí la fecha de vencimiento para poder aplicar.';
    }

    /*
     * Acá ya está todo elegido y lo elegido no sirve. El error rojo de arriba
     * dice exactamente por qué —esa redacción es la del dominio y no se
     * duplica—; esto sólo nombra qué hay que corregir.
     */
    if (resuelto && !resuelto.ok) {
      return condicion === 'FECHA'
        ? 'Corregí el vencimiento antes de aplicar.'
        : 'Corregí el plazo antes de aplicar.';
    }
    return null;
  }

  const falta = loQueFalta();

  /** Los frenos que todavía valen, con el del pago sólo si sigue sin resolverse. */
  const frenosVigentes = pagoListo ? otrosFrenos : frenos;

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
      {frenosVigentes.length > 0 && (
        <div className="mensaje mensaje-aviso" data-prueba="frenos">
          <strong>Todavía no se puede aplicar:</strong>
          <ul className="lista-simple" style={{ marginTop: 6 }}>
            {frenosVigentes.map((freno) => (
              <li key={freno}>{freno}</li>
            ))}
          </ul>
        </div>
      )}

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

          {/*
            La fecha que se va a guardar, dicha antes de guardarla.
            Elegir «a 30 días» sin ver el día es elegir a medias: el plazo se
            acuerda, pero lo que después se mira en Pagos es la fecha.
          */}
          {resuelto?.ok && (
            <p className="mensaje mensaje-info" data-prueba="vencimiento-calculado">
              Vencería el <strong>{formatDateAr(resuelto.pago.dueDate)}</strong>.{' '}
              <span className="suave">{resuelto.pago.comoSeCalculo}</span>
            </p>
          )}
          {resuelto && !resuelto.ok && (
            <p className="mensaje mensaje-error" role="alert" data-prueba="decision-invalida">
              {resuelto.motivo}
            </p>
          )}
        </div>
      )}

      <div className="acciones">
        <button type="button" onClick={aplicar} disabled={!listo || aplicando} className="boton">
          {aplicando ? 'Aplicando…' : 'Aplicar la compra'}
        </button>
      </div>

      {falta && (
        <p className="ayuda" data-prueba="lo-que-falta">
          {falta}
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
