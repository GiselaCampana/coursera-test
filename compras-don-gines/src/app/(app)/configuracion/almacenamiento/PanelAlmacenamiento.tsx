'use client';

import { useState } from 'react';
import { toUserMessage } from '@/lib/errors';

interface EstadoVista {
  usadoBytes: number;
  limiteBytes: number;
  proporcion: number;
  archivos: number;
  archivosArchivados: number;
  bytesLiberables: number;
  enAviso: boolean;
  bloqueado: boolean;
  mensaje: string | null;
  usadoLegible: string;
  limiteLegible: string;
  liberableLegible: string;
}

interface Resumen {
  comprobantes: number;
  paginas: number;
  bytes: number;
  bytesLegible: string;
  desde: string | null;
  hasta: string | null;
}

/**
 * Administración del espacio.
 *
 * El plan gratuito no cobra excedente: cuando se llena, deja de aceptar
 * archivos. Por eso esta pantalla no es informativa nada más, es la herramienta
 * para no llegar nunca a ese punto: muestra cuánto queda, avisa al 80 % y
 * permite bajar los comprobantes viejos antes de liberar el espacio.
 */
export function PanelAlmacenamiento({
  estado,
  resumenInicial,
  corteInicial,
  hoy,
}: {
  estado: EstadoVista;
  resumenInicial: Resumen;
  corteInicial: string;
  hoy: string;
}) {
  const [corte, setCorte] = useState(corteInicial);
  const [resumen, setResumen] = useState(resumenInicial);
  const [descargado, setDescargado] = useState(false);
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hecho, setHecho] = useState<string | null>(null);

  const porcentaje = Math.min(100, Math.round(estado.proporcion * 100));
  const clase = estado.bloqueado ? 'grave' : estado.enAviso ? 'aviso' : 'bien';

  const consultar = async (fecha: string) => {
    setCorte(fecha);
    setDescargado(false);
    setError(null);
    setHecho(null);
    try {
      const respuesta = await fetch(`/api/almacenamiento/archivado?anteriorA=${fecha}`);
      const datos = await respuesta.json();
      if (respuesta.ok) setResumen(datos);
    } catch {
      // Sin conexión se deja lo último que se había consultado.
    }
  };

  const descargar = async () => {
    setTrabajando(true);
    setError(null);
    try {
      const respuesta = await fetch(`/api/almacenamiento/archivado?anteriorA=${corte}&formato=zip`);
      if (!respuesta.ok) {
        const datos = await respuesta.json().catch(() => ({}));
        throw new Error(datos.error ?? 'No pudimos preparar la descarga.');
      }
      const blob = await respuesta.blob();
      const url = URL.createObjectURL(blob);
      const enlace = document.createElement('a');
      enlace.href = url;
      enlace.download = `comprobantes-hasta-${corte}.zip`;
      document.body.appendChild(enlace);
      enlace.click();
      enlace.remove();
      URL.revokeObjectURL(url);
      setDescargado(true);
    } catch (e) {
      setError(toUserMessage(e));
    } finally {
      setTrabajando(false);
    }
  };

  const archivar = async () => {
    setTrabajando(true);
    setError(null);
    try {
      const respuesta = await fetch('/api/almacenamiento/archivado', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ anteriorA: corte, confirmoDescarga: true }),
      });
      const datos = await respuesta.json();
      if (!respuesta.ok) throw new Error(datos.error ?? 'No pudimos archivar las imágenes.');
      setHecho(
        `Se archivaron ${datos.paginas} imágenes y se liberaron ${datos.bytesLiberadosLegible}. ` +
          'Los datos de esos comprobantes siguen estando completos.',
      );
      setResumen({ ...resumen, comprobantes: 0, paginas: 0, bytes: 0, bytesLegible: '0 B' });
    } catch (e) {
      setError(toUserMessage(e));
    } finally {
      setTrabajando(false);
    }
  };

  return (
    <>
      <h1>Almacenamiento</h1>

      {estado.mensaje ? (
        <p
          className={`mensaje ${estado.bloqueado ? 'mensaje-error' : 'mensaje-aviso'}`}
          role={estado.bloqueado ? 'alert' : 'status'}
        >
          {estado.mensaje}
        </p>
      ) : null}

      {error ? (
        <p className="mensaje mensaje-error" role="alert">
          {error}
        </p>
      ) : null}
      {hecho ? (
        <p className="mensaje mensaje-ok" role="status">
          {hecho}
        </p>
      ) : null}

      <div className="card">
        <h2>Espacio usado</h2>
        <div className={`barra-uso barra-uso-${clase}`} aria-hidden="true">
          <span style={{ width: `${porcentaje}%` }} />
        </div>
        <p
          className="chico medio"
          role="status"
          aria-label={`Almacenamiento usado: ${porcentaje} por ciento`}
        >
          <strong>
            {estado.usadoLegible} de {estado.limiteLegible}
          </strong>{' '}
          ({porcentaje} %) · {estado.archivos} imágenes guardadas
          {estado.archivosArchivados > 0 ? ` · ${estado.archivosArchivados} ya archivadas` : ''}
        </p>
        <p className="ayuda mb0">
          Cada comprobante se guarda optimizado a unos 500 kB, en una sola versión. El plan
          gratuito no cobra excedente: cuando se llena, deja de aceptar imágenes nuevas. Por eso la
          aplicación avisa al 80 % y bloquea antes de llegar al límite.
        </p>
      </div>

      <div className="card">
        <h2>Archivar comprobantes viejos</h2>
        <p className="chico medio">
          Se descargan las imágenes en un ZIP y recién después se borran del almacenamiento.{' '}
          <strong>
            Los datos de los comprobantes —artículos, cantidades, costos, impuestos y pagos— quedan
            en el sistema para siempre.
          </strong>{' '}
          Lo único que se archiva es la foto.
        </p>

        <div className="campo">
          <label htmlFor="corte">Archivar comprobantes anteriores a</label>
          <input
            id="corte"
            type="date"
            value={corte}
            max={hoy}
            onChange={(e) => consultar(e.target.value)}
            disabled={trabajando}
          />
        </div>

        <dl style={{ margin: 0 }}>
          <div className="dato">
            <dt>Comprobantes</dt>
            <dd>{resumen.comprobantes}</dd>
          </div>
          <div className="dato">
            <dt>Imágenes</dt>
            <dd>{resumen.paginas}</dd>
          </div>
          <div className="dato destacado">
            <dt>Espacio a liberar</dt>
            <dd>{resumen.bytesLegible}</dd>
          </div>
          {resumen.desde ? (
            <div className="dato">
              <dt>Período</dt>
              <dd>
                {resumen.desde} a {resumen.hasta}
              </dd>
            </div>
          ) : null}
        </dl>

        {resumen.paginas === 0 ? (
          <p className="mensaje mensaje-info mb0">
            No hay comprobantes confirmados con imagen anteriores a esa fecha.
          </p>
        ) : (
          <div className="acciones">
            <button type="button" className="boton" onClick={descargar} disabled={trabajando}>
              {trabajando ? 'Preparando…' : '1. Descargar el ZIP'}
            </button>
            <button
              type="button"
              className="boton boton-peligro"
              onClick={archivar}
              disabled={trabajando || !descargado}
            >
              2. Borrar las imágenes y liberar espacio
            </button>
          </div>
        )}

        {resumen.paginas > 0 && !descargado ? (
          <p className="ayuda mb0">
            El borrado se habilita después de descargar el ZIP: esa va a ser la única copia de las
            imágenes.
          </p>
        ) : null}
      </div>
    </>
  );
}
