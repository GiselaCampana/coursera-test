'use client';

import { useState } from 'react';
import type { Apertura, EstadoDeLinea } from '@/lib/services/stock-erp-apertura';
import {
  guardarElConteo,
  contarloEnCero,
  noSeManejaAca,
  fijarElCorte,
  confirmarLaApertura,
  actualizarElSnapshot,
  type Resultado,
} from '../acciones';

/**
 * **Preparación, conteo y confirmación, pensados para el teléfono.**
 *
 * Quien usa esta pantalla está parado frente a una heladera con el teléfono en
 * una mano. Por eso cada artículo es una tarjeta con tres acciones grandes
 * —contar, contar en cero, no se maneja— y no una fila de tabla con un campo
 * diminuto.
 *
 * «Contado en cero» es un botón aparte y no escribir un 0 en el campo, y esa
 * es la decisión de diseño que sostiene toda la fase: un cero tiene que
 * costarle a la persona el mismo gesto deliberado que cualquier otra cantidad,
 * porque significa «lo busqué y no había» y no «lo salteé».
 */

const COLOR: Record<EstadoDeLinea, string> = {
  PENDIENTE: 'var(--ambar-suave, #fdf1d6)',
  CONTADO: 'var(--verde-suave, #e6f4ea)',
  CONTADO_CERO: 'var(--gris-suave, #eef1f4)',
  NO_SE_MANEJA: 'var(--gris-suave, #eef1f4)',
  BLOQUEADO_UNIDAD: 'var(--rojo-suave, #fdecea)',
};

function Aviso({ r }: { r: Resultado | null }) {
  if (!r) return null;
  return (
    <p
      className={r.ok ? 'mensaje mensaje-ok' : 'mensaje mensaje-error'}
      data-prueba={r.ok ? 'resultado-ok' : 'resultado-error'}
    >
      {r.mensaje}
    </p>
  );
}

function Linea({
  linea,
  sessionId,
  avisar,
  puedeContar,
  puedeHabilitar,
}: {
  linea: Apertura['lineas'][number];
  sessionId: string;
  avisar: (r: Resultado) => void;
  puedeContar: boolean;
  puedeHabilitar: boolean;
}) {
  const [enviando, setEnviando] = useState(false);
  const [pidiendoMotivo, setPidiendoMotivo] = useState(false);

  async function enviar(accion: (p: Resultado | null, f: FormData) => Promise<Resultado>, f: FormData) {
    setEnviando(true);
    avisar(await accion(null, f));
    setEnviando(false);
    setPidiendoMotivo(false);
  }

  return (
    <article
      className="tarjeta"
      data-prueba="linea"
      data-plu={linea.plu}
      data-estado={linea.estado}
      style={{ background: COLOR[linea.estado], marginBottom: 10 }}
    >
      <header style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong>{linea.plu}</strong>
        <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{linea.nombre}</span>
        <span className="chico" data-prueba="estado-linea">
          {linea.estado}
        </span>
      </header>

      {linea.estado === 'BLOQUEADO_UNIDAD' ? (
        <p className="chico" data-prueba="bloqueado-unidad">
          Sin unidad de existencia aprobada: no se puede contar, porque no se sabría en qué. Se
          resuelve aprobando la unidad en <a href="/stock-erp/unidades">Configuración de unidades</a>{' '}
          o marcando que la sucursal no lo maneja.
        </p>
      ) : (
        <p className="chico">
          {linea.cantidad !== null ? (
            <>
              Contado: <strong data-prueba="cantidad">{linea.cantidad}</strong>{' '}
              {linea.unidadDeExistencia}
              {linea.contadoPor ? ` · por ${linea.contadoPor}` : ''}
            </>
          ) : linea.estado === 'NO_SE_MANEJA' ? (
            <>No se maneja acá: {linea.motivo}</>
          ) : (
            <>Todavía nadie lo contó. Una fila sin contar no vale cero.</>
          )}
        </p>
      )}

      {puedeContar && linea.estado !== 'BLOQUEADO_UNIDAD' && (
        <>
          <form
            data-prueba="form-conteo"
            action={(f) => enviar(guardarElConteo, f)}
            style={{ display: 'flex', gap: 6, alignItems: 'flex-end', flexWrap: 'wrap' }}
          >
            <input type="hidden" name="activationId" value={linea.activationId} />
            <input type="hidden" name="sessionId" value={sessionId} />
            <div style={{ flex: '1 1 120px' }}>
              <label className="etiqueta" htmlFor={`c-${linea.plu}`}>
                Cantidad ({linea.unidadDeExistencia})
              </label>
              <input
                id={`c-${linea.plu}`}
                name="cantidad"
                inputMode="decimal"
                defaultValue={linea.cantidad ?? ''}
                data-prueba="entrada-cantidad"
              />
            </div>
            <button type="submit" className="boton" disabled={enviando} data-prueba="guardar-conteo">
              Guardar
            </button>
          </form>

          <form data-prueba="form-cero" action={(f) => enviar(contarloEnCero, f)}>
            <input type="hidden" name="activationId" value={linea.activationId} />
            <input type="hidden" name="sessionId" value={sessionId} />
            <button
              type="submit"
              className="boton-secundario"
              disabled={enviando}
              data-prueba="contar-en-cero"
            >
              Contado en cero
            </button>
          </form>
        </>
      )}

      {puedeHabilitar &&
        (pidiendoMotivo ? (
          <form data-prueba="form-no-se-maneja" action={(f) => enviar(noSeManejaAca, f)}>
            <input type="hidden" name="activationId" value={linea.activationId} />
            <input type="hidden" name="sessionId" value={sessionId} />
            <label className="etiqueta" htmlFor={`m-${linea.plu}`}>
              ¿Por qué no se maneja acá?
            </label>
            <input id={`m-${linea.plu}`} name="motivo" data-prueba="motivo-no-se-maneja" />
            <button
              type="submit"
              className="boton-secundario"
              disabled={enviando}
              data-prueba="guardar-no-se-maneja"
            >
              Guardar
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="boton-secundario chico"
            onClick={() => setPidiendoMotivo(true)}
            data-prueba="no-se-maneja"
          >
            No se maneja en esta sucursal
          </button>
        ))}
    </article>
  );
}

export function Conteo({
  apertura,
  puedeContar,
  puedeHabilitar,
  puedeConfirmar,
}: {
  apertura: Apertura;
  puedeContar: boolean;
  puedeHabilitar: boolean;
  puedeConfirmar: boolean;
}) {
  const [r, setR] = useState<Resultado | null>(null);
  const [filtro, setFiltro] = useState<'todos' | EstadoDeLinea>('todos');
  const [texto, setTexto] = useState('');
  const [confirmando, setConfirmando] = useState(false);
  const [enviando, setEnviando] = useState(false);

  const visibles = apertura.lineas.filter((l) => {
    if (filtro !== 'todos' && l.estado !== filtro) return false;
    if (!texto.trim()) return true;
    const t = texto.trim().toLowerCase();
    return (
      l.plu.toLowerCase().includes(t) ||
      l.nombre.toLowerCase().includes(t) ||
      (l.familia ?? '').toLowerCase().includes(t)
    );
  });

  async function enviar(accion: (p: Resultado | null, f: FormData) => Promise<Resultado>, f: FormData) {
    setEnviando(true);
    const res = await accion(null, f);
    setR(res);
    setEnviando(false);
    if (res.ok) setConfirmando(false);
  }

  const sePuedeConfirmar = apertura.impedimentos.length === 0;

  return (
    <>
      <Aviso r={r} />

      {apertura.ficticia && (
        <p className="mensaje mensaje-aviso" data-prueba="datos-ficticios">
          <strong>Datos ficticios (homologación).</strong> Esta apertura sólo se puede confirmar
          contra una base de pruebas. No representa existencias de ningún local.
        </p>
      )}

      {/* --- El corte ------------------------------------------------------ */}
      <section className="tarjeta">
        <h2 className="chico">Fecha y hora de corte</h2>
        <p className="chico" data-prueba="corte-actual">
          {apertura.cutoffAt
            ? `Corte: ${new Intl.DateTimeFormat('es-AR', {
                timeZone: 'America/Argentina/Buenos_Aires',
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              }).format(apertura.cutoffAt)} (hora de Argentina)`
            : 'Todavía sin fijar. Es el instante en que terminó el conteo físico.'}
        </p>
        {apertura.estado === 'BORRADOR' && puedeContar && (
          <form
            data-prueba="form-corte"
            action={(f) => enviar(fijarElCorte, f)}
            style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-end' }}
          >
            <input type="hidden" name="sessionId" value={apertura.sessionId} />
            <div style={{ flex: '1 1 140px' }}>
              <label className="etiqueta" htmlFor="fecha-corte">
                Fecha
              </label>
              <input id="fecha-corte" name="fecha" type="date" data-prueba="corte-fecha" />
            </div>
            <div style={{ flex: '1 1 100px' }}>
              <label className="etiqueta" htmlFor="hora-corte">
                Hora (Argentina)
              </label>
              <input id="hora-corte" name="hora" type="time" data-prueba="corte-hora" />
            </div>
            <button type="submit" className="boton-secundario" disabled={enviando} data-prueba="fijar-corte">
              Fijar
            </button>
          </form>
        )}
      </section>

      {/* --- Impedimentos --------------------------------------------------- */}
      {apertura.estado === 'BORRADOR' && apertura.impedimentos.length > 0 && (
        <div className="mensaje mensaje-error" data-prueba="impedimentos">
          <strong>No se puede confirmar todavía:</strong>
          <ul>
            {apertura.impedimentos.map((i) => (
              <li key={i} data-prueba="impedimento">
                {i}
              </li>
            ))}
          </ul>
          {puedeContar && (
            <form data-prueba="form-snapshot" action={(f) => enviar(actualizarElSnapshot, f)}>
              <input type="hidden" name="sessionId" value={apertura.sessionId} />
              <button type="submit" className="boton-secundario chico" disabled={enviando} data-prueba="actualizar-snapshot">
                Actualizar el borrador con el catálogo de ahora
              </button>
            </form>
          )}
        </div>
      )}

      {/* --- Confirmación --------------------------------------------------- */}
      {apertura.estado === 'BORRADOR' && puedeConfirmar && sePuedeConfirmar && (
        <section className="tarjeta" data-prueba="confirmacion">
          <h2 className="chico">Confirmar la apertura</h2>
          <ul className="chico" data-prueba="resumen-previo">
            <li>Sucursal: {apertura.sucursal}</li>
            <li data-prueba="resumen-contados">Contados: {apertura.resumen.CONTADO}</li>
            <li data-prueba="resumen-ceros">En cero: {apertura.resumen.CONTADO_CERO}</li>
            <li data-prueba="resumen-no-maneja">No manejados: {apertura.resumen.NO_SE_MANEJA}</li>
          </ul>
          {confirmando ? (
            <form data-prueba="form-confirmar" action={(f) => enviar(confirmarLaApertura, f)}>
              <input type="hidden" name="sessionId" value={apertura.sessionId} />
              <input type="hidden" name="confirmado" value="si" />
              <input type="hidden" name="contados" value={apertura.resumen.CONTADO} />
              <input type="hidden" name="ceros" value={apertura.resumen.CONTADO_CERO} />
              <input type="hidden" name="noSeManeja" value={apertura.resumen.NO_SE_MANEJA} />
              <div className="mensaje mensaje-aviso" data-prueba="doble-confirmacion">
                <p>
                  Vas a inaugurar el inventario de <strong>{apertura.sucursal}</strong> con{' '}
                  <strong>{apertura.resumen.CONTADO}</strong> artículos contados,{' '}
                  <strong>{apertura.resumen.CONTADO_CERO}</strong> en cero y{' '}
                  <strong>{apertura.resumen.NO_SE_MANEJA}</strong> que la sucursal no maneja. El
                  corte queda fijo y la apertura no se deshace.
                </p>
                <button type="submit" className="boton" disabled={enviando} data-prueba="confirmar-definitivo">
                  Sí, confirmar la apertura
                </button>
                <button
                  type="button"
                  className="boton-secundario"
                  onClick={() => setConfirmando(false)}
                  data-prueba="cancelar-confirmacion"
                >
                  Cancelar
                </button>
              </div>
            </form>
          ) : (
            <button type="button" className="boton" onClick={() => setConfirmando(true)} data-prueba="confirmar">
              Confirmar la apertura
            </button>
          )}
        </section>
      )}

      {apertura.estado === 'CONFIRMADA' && (
        <p className="mensaje mensaje-ok" data-prueba="apertura-confirmada">
          Apertura confirmada{apertura.confirmadaPor ? ` por ${apertura.confirmadaPor}` : ''}. El
          corte quedó fijo y los conteos ya no se modifican.
        </p>
      )}

      {/* --- Buscador y filtros --------------------------------------------- */}
      <input
        type="search"
        placeholder="Buscar por PLU, nombre o familia"
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        data-prueba="buscar"
        aria-label="Buscar artículos"
      />
      <div role="group" aria-label="Filtrar" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '10px 0' }}>
        {(['todos', 'PENDIENTE', 'CONTADO', 'CONTADO_CERO', 'NO_SE_MANEJA', 'BLOQUEADO_UNIDAD'] as const).map(
          (f) => (
            <button
              key={f}
              type="button"
              className={filtro === f ? 'boton chico' : 'boton-secundario chico'}
              onClick={() => setFiltro(f)}
              data-prueba={`filtro-${f}`}
              aria-pressed={filtro === f}
            >
              {f === 'todos' ? 'todos' : f} ({f === 'todos' ? apertura.lineas.length : apertura.resumen[f]})
            </button>
          ),
        )}
      </div>

      <p className="chico" data-prueba="cuenta">
        {visibles.length} de {apertura.lineas.length} artículos
      </p>

      {visibles.map((l) => (
        <Linea
          key={l.activationId}
          linea={l}
          sessionId={apertura.sessionId}
          avisar={setR}
          puedeContar={puedeContar && apertura.estado === 'BORRADOR'}
          puedeHabilitar={puedeHabilitar && apertura.estado === 'BORRADOR'}
        />
      ))}
    </>
  );
}
