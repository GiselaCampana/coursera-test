'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import {
  aplicarSincronizacionDeStockAccion,
  verSincronizacionDeStock,
  type ResultadoDeSincronizacion,
} from './acciones';
import type {
  ArticuloDeLaVistaPrevia,
  VistaPreviaDeSincronizacion,
} from '@/lib/services/stock-sync';

/**
 * Sincronizar el catálogo con Control de Stock.
 *
 * En dos pasos y nunca en uno. El primero descarga, valida y **no escribe
 * nada**: dice cuántos artículos entrarían nuevos, cuáles cambiarían y en qué
 * campo, cuáles quedan igual y cuáles quedarían inactivos. Recién después, con
 * una confirmación aparte, se aplica.
 *
 * Todo el trabajo pasa del lado del servidor. En el navegador no funcionaba:
 * Safari bloquea el pedido entre dominios y desde el iPhone la sincronización
 * no arrancaba nunca.
 */

function Boton({ children, secundario }: { children: React.ReactNode; secundario?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={secundario ? 'boton boton-secundario' : 'boton'}
      disabled={pending}
    >
      {pending ? 'Consultando a Control de Stock…' : children}
    </button>
  );
}

/** Una lista plegada, para poder mirar el detalle sin llenar la pantalla. */
function Grupo({
  titulo,
  articulos,
  vacio,
}: {
  titulo: string;
  articulos: ArticuloDeLaVistaPrevia[];
  vacio: string;
}) {
  return (
    <details className="fila-dato">
      <summary>
        <strong>{titulo}</strong> <span className="chico medio">{articulos.length}</span>
      </summary>
      {articulos.length === 0 ? (
        <p className="chico medio mb0 mt">{vacio}</p>
      ) : (
        <ul className="lista mt">
          {articulos.map((a) => (
            <li key={a.plu} className="fila-dato">
              <div className="fila-dato-meta">
                <strong>{a.plu}</strong>
                <span>{a.nombre}</span>
              </div>
              {/*
                El antes y el después de cada campo.
                Decir "cambia" sin decir de qué a qué obliga a abrir el artículo
                para poder decidir, que es justo lo que la vista previa viene a
                evitar.
              */}
              {a.cambios.length > 0 ? (
                <ul className="lista-simple chico">
                  {a.cambios.map((c) => (
                    <li key={c.campo}>
                      {c.campo}: <span className="suave">{c.antes}</span> → <strong>{c.despues}</strong>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function Resumen({ vista, aplicada }: { vista: VistaPreviaDeSincronizacion; aplicada: boolean }) {
  const sinNovedades =
    vista.nuevos.length === 0 &&
    vista.modificados.length === 0 &&
    vista.quedarianInactivos.length === 0;

  return (
    <>
      <dl className="resumen-mes">
        <div className="dato destacado">
          <dt>{aplicada ? 'Nuevos' : 'Entrarían nuevos'}</dt>
          <dd>{vista.nuevos.length}</dd>
        </div>
        <div className="dato">
          <dt>{aplicada ? 'Modificados' : 'Cambiarían'}</dt>
          <dd>{vista.modificados.length}</dd>
        </div>
        <div className="dato">
          <dt>Sin cambios</dt>
          <dd>{vista.sinCambios.length}</dd>
        </div>
        <div className="dato">
          <dt>{aplicada ? 'Quedaron inactivos' : 'Quedarían inactivos'}</dt>
          <dd>{vista.quedarianInactivos.length}</dd>
        </div>
      </dl>

      <p className="chico medio">
        Control de Stock devolvió {vista.leidos} artículo{vista.leidos === 1 ? '' : 's'} (esquema{' '}
        {vista.schemaVersion}).
      </p>

      {sinNovedades ? (
        <p className="mensaje mensaje-ok" role="status">
          El catálogo de Compras ya coincide con el de Control de Stock. No hay nada que aplicar.
        </p>
      ) : null}

      <ul className="lista">
        <li>
          <Grupo
            titulo="Nuevos"
            articulos={vista.nuevos}
            vacio="Ningún artículo del catálogo maestro falta en Compras."
          />
        </li>
        <li>
          <Grupo
            titulo="Modificados"
            articulos={vista.modificados}
            vacio="Ningún artículo cambia de nombre, clasificación ni unidad."
          />
        </li>
        <li>
          <Grupo
            titulo="Sin cambios"
            articulos={vista.sinCambios}
            vacio="Ninguno coincide exactamente todavía."
          />
        </li>
        <li>
          <details className="fila-dato">
            <summary>
              <strong>{aplicada ? 'Quedaron inactivos' : 'Quedarían inactivos'}</strong>{' '}
              <span className="chico medio">{vista.quedarianInactivos.length}</span>
            </summary>
            <p className="chico medio mt">
              No se borra ninguno. El PLU, las compras, los costos y los precios quedan donde
              están: el artículo sólo deja de estar activo.
            </p>
            {vista.quedarianInactivos.length === 0 ? (
              <p className="chico medio mb0">Ninguno.</p>
            ) : (
              <ul className="lista">
                {vista.quedarianInactivos.map((a) => (
                  <li key={a.plu} className="fila-dato">
                    <div className="fila-dato-meta">
                      <strong>{a.plu}</strong>
                      <span>{a.nombre}</span>
                    </div>
                    <p className="chico medio mb0">{a.motivo}</p>
                  </li>
                ))}
              </ul>
            )}
          </details>
        </li>
      </ul>

      {vista.familiasNuevas.length > 0 ? (
        <p className="chico medio">
          Se crearían {vista.familiasNuevas.length} familia
          {vista.familiasNuevas.length === 1 ? '' : 's'}: {vista.familiasNuevas.join(', ')}.
        </p>
      ) : null}

      {vista.proveedoresDesconocidos.length > 0 ? (
        <p className="mensaje mensaje-aviso">
          Control de Stock nombra proveedores que Compras no tiene dados de alta:{' '}
          {vista.proveedoresDesconocidos.join(', ')}. El catálogo entra igual; esos artículos
          quedan sin proveedor habitual hasta que los des de alta.
        </p>
      ) : null}
    </>
  );
}

export function SincronizarConStock() {
  const [previa, verAccion] = useActionState<ResultadoDeSincronizacion, FormData>(
    verSincronizacionDeStock,
    {},
  );
  const [aplicado, aplicarAccion] = useActionState<ResultadoDeSincronizacion, FormData>(
    aplicarSincronizacionDeStockAccion,
    {},
  );

  // Lo aplicado manda sobre lo mirado: es el estado más nuevo de la pantalla.
  const resultado = aplicado.vista || aplicado.motivos || aplicado.error ? aplicado : previa;
  const vista = resultado.vista;

  return (
    <div className="card">
      <div className="card-titulo">
        <h2>Sincronizar con Control de Stock</h2>
      </div>
      <p className="chico medio">
        Control de Stock es la fuente de qué artículos existen: su nombre, proveedor, tipo,
        subtipo, imagen, unidad y si están activos. Compras conserva lo suyo —compras, costos,
        marcajes y precios—, que esta sincronización no toca. El PLU se copia tal cual: acá no se
        renumera ni se borra nada.
      </p>

      <form action={verAccion}>
        <div className="acciones">
          {/*
            El nombre dice a quién se le pregunta, y no sólo qué se obtiene.
            El importador de archivos tiene su propio «Ver qué cambiaría»; dos
            botones con el mismo nombre en la misma pantalla son dos cosas
            distintas que se leen igual.
          */}
          <Boton>{vista ? 'Volver a consultar' : 'Consultar a Control de Stock'}</Boton>
        </div>
      </form>

      {/*
        Los motivos van juntos y completos.
        Arreglar uno, reintentar y descubrir el siguiente es la peor forma de
        enterarse de que la respuesta tenía tres problemas.
      */}
      {resultado.motivos ? (
        <div className="mensaje mensaje-error" role="alert">
          <strong>No se pudo usar la respuesta de Control de Stock.</strong>
          <ul className="lista-simple mb0">
            {resultado.motivos.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {resultado.error ? (
        <p className="mensaje mensaje-error" role="alert">
          {resultado.error}
        </p>
      ) : null}

      {vista ? (
        <>
          {resultado.aplicada ? (
            <p className="mensaje mensaje-ok" role="status">
              Catálogo sincronizado: se escribieron {vista.aplicados} artículo
              {vista.aplicados === 1 ? '' : 's'}.
            </p>
          ) : null}

          <Resumen vista={vista} aplicada={Boolean(resultado.aplicada)} />

          {!resultado.aplicada &&
          (vista.nuevos.length > 0 ||
            vista.modificados.length > 0 ||
            vista.quedarianInactivos.length > 0) ? (
            <form action={aplicarAccion}>
              <p className="chico medio">
                Al confirmar se vuelve a consultar a Control de Stock y se aplica todo junto: si
                algo falla, no queda nada escrito a medias.
              </p>
              <div className="acciones">
                <Boton>Confirmar y aplicar</Boton>
              </div>
            </form>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
