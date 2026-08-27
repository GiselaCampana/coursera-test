'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import {
  aplicarAsociaciones,
  resolverAsociacion,
  analizarMapeoCodigos,
  aplicarMapeoCodigos,
  type ResultadoAsociacion,
  type ResultadoMapeoCodigos,
} from './acciones';

function Boton({ texto, cargando }: { texto: string; cargando: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="boton" disabled={pending}>
      {pending ? cargando : texto}
    </button>
  );
}

/**
 * El segundo paso: aplicar lo que el análisis dio por seguro.
 *
 * Va detrás de una confirmación aparte y no de un botón suelto. Lo que se
 * escribe es a qué artículo pertenece cada compra, y de eso dependen el costo
 * del producto y el precio de venta: conviene que apretarlo sea una decisión y
 * no un accidente.
 */
export function Aplicar({
  cantidad,
  proveedorId,
  proveedorNombre,
}: {
  cantidad: number;
  proveedorId: string;
  proveedorNombre: string | null;
}) {
  const [confirmando, setConfirmando] = useState(false);
  const [estado, accion] = useActionState<ResultadoAsociacion, FormData>(aplicarAsociaciones, {});

  if (cantidad === 0) {
    return (
      <div className="card">
        <h2>Aplicar</h2>
        <p className="chico medio mb0">
          No hay ninguna asociación segura para aplicar
          {proveedorNombre ? ` en ${proveedorNombre}` : ''}.
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Aplicar las asociaciones seguras</h2>
      <p className="chico medio">
        Se van a completar {cantidad} renglón/es que hoy están sin producto
        {proveedorNombre ? `, de ${proveedorNombre}` : ''}. Se toca sólo la asociación y sus derivados: cantidades, kilos, precios impresos, IVA,
        percepciones e imágenes quedan como están; no se crea ningún movimiento nuevo y, si faltaba,
        se genera el historial de costo que usa la pantalla Precios.
      </p>

      {estado.error ? (
        <p className="mensaje mensaje-error" role="alert">
          {estado.error}
        </p>
      ) : null}

      {!confirmando ? (
        <div className="acciones">
          <button type="button" className="boton" onClick={() => setConfirmando(true)}>
            Aplicar {cantidad} asociación/es…
          </button>
        </div>
      ) : (
        <form action={accion}>
          <input type="hidden" name="proveedor" value={proveedorId} />
          <p className="mensaje mensaje-aviso">
            Confirmá: se van a asociar {cantidad} renglón/es de compras ya validadas. Queda
            registrado en la auditoría con tu usuario y con el producto que se le puso a cada uno.
          </p>
          <div className="acciones">
            <button
              type="button"
              className="boton boton-secundario"
              onClick={() => setConfirmando(false)}
            >
              Cancelar
            </button>
            <Boton texto="Sí, aplicar" cargando="Aplicando…" />
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * Resolver a mano un renglón dudoso.
 *
 * Se ofrecen primero los candidatos que el reconocimiento encontró cerca —son
 * los que casi siempre son— y después el catálogo entero, para el caso en que
 * no sea ninguno de ellos.
 */


export function ImportarMapeoCodigos({
  supplierId,
  supplierName,
}: {
  supplierId: string;
  supplierName: string;
}) {
  const [texto, setTexto] = useState('');
  const [previa, accionPrevia] = useActionState<ResultadoMapeoCodigos, FormData>(
    analizarMapeoCodigos,
    {},
  );
  const [aplicado, accionAplicar] = useActionState<ResultadoMapeoCodigos, FormData>(
    aplicarMapeoCodigos,
    {},
  );
  const informe = previa.informe;

  return (
    <div className="card">
      <h2>Códigos confirmados de {supplierName}</h2>
      <p className="chico medio">
        Para cargar varias relaciones de una vez. El archivo o texto necesita dos columnas:
        <strong> Código proveedor</strong> y <strong>PLU</strong>. Primero se muestra la vista previa;
        recién después se aplica.
      </p>

      <form action={accionPrevia}>
        <input type="hidden" name="supplierId" value={supplierId} />
        <div className="campo">
          <label htmlFor="mapeo-codigos">CSV o texto</label>
          <textarea
            id="mapeo-codigos"
            name="texto"
            rows={8}
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            placeholder={'Código proveedor;PLU\nART-00228;1211'}
          />
        </div>
        {previa.error ? <p className="mensaje mensaje-error">{previa.error}</p> : null}
        <div className="acciones">
          <Boton texto="Ver propuesta" cargando="Analizando…" />
        </div>
      </form>

      {informe ? (
        <>
          <div className="resumen-mes">
            <div className="dato destacado">
              <dt>Aplicables</dt>
              <dd>{informe.aplicables.length}</dd>
            </div>
            <div className="dato">
              <dt>Ya estaban</dt>
              <dd>{informe.yaExistentes.length}</dd>
            </div>
            <div className="dato">
              <dt>Conflictos</dt>
              <dd>{informe.conflictos.length}</dd>
            </div>
          </div>

          {informe.aplicables.length > 0 ? (
            <ul className="lista">
              {informe.aplicables.map((f) => (
                <li key={f.codigoProveedor} className="fila-dato">
                  <strong>{f.codigoProveedor}</strong> → PLU <strong>{f.plu}</strong> · {f.producto}
                </li>
              ))}
            </ul>
          ) : null}

          {informe.conflictos.length > 0 ? (
            <div className="mensaje mensaje-error">
              <strong>Conflictos sin aplicar</strong>
              <ul>
                {informe.conflictos.map((f, i) => (
                  <li key={`${f.codigoProveedor}-${f.plu}-${i}`}>
                    {f.codigoProveedor || 'sin código'} → {f.plu || 'sin PLU'}: {f.motivo}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <form action={accionAplicar}>
            <input type="hidden" name="supplierId" value={supplierId} />
            <input type="hidden" name="texto" value={previa.texto ?? texto} />
            {aplicado.error ? <p className="mensaje mensaje-error">{aplicado.error}</p> : null}
            <div className="acciones">
              <Boton
                texto={`Aplicar ${informe.aplicables.length} código/s`}
                cargando="Aplicando…"
              />
            </div>
          </form>
        </>
      ) : null}
    </div>
  );
}

export function ResolverAmbigua({
  documentItemId,
  tieneCodigo,
  supplierName,
  supplierCode,
  sugerencias,
  productos,
}: {
  documentItemId: string;
  tieneCodigo: boolean;
  supplierName: string | null;
  supplierCode: string | null;
  sugerencias: { productId: string; productCode: string; productName: string; score: number }[];
  productos: { id: string; internalCode: string; normalizedName: string }[];
}) {
  const [abierto, setAbierto] = useState(false);
  const [estado, accion] = useActionState<ResultadoAsociacion, FormData>(resolverAsociacion, {});

  if (!abierto) {
    return (
      <div className="acciones">
        <button
          type="button"
          className="boton boton-secundario"
          onClick={() => setAbierto(true)}
        >
          Elegir el PLU…
        </button>
      </div>
    );
  }

  return (
    <form action={accion} className="mt">
      <input type="hidden" name="documentItemId" value={documentItemId} />

      {estado.error ? (
        <p className="mensaje mensaje-error" role="alert">
          {estado.error}
        </p>
      ) : null}

      <div className="campo">
        <label htmlFor={`plu-${documentItemId}`}>PLU Don Ginés</label>
        <select id={`plu-${documentItemId}`} name="productId" required defaultValue="">
          <option value="">Elegí el artículo…</option>
          {sugerencias.length > 0 ? (
            <optgroup label="Los que más se parecen">
              {sugerencias.map((s) => (
                <option key={s.productId} value={s.productId}>
                  {s.productCode} · {s.productName}
                </option>
              ))}
            </optgroup>
          ) : null}
          <optgroup label="Todo el catálogo">
            {productos.map((p) => (
              <option key={p.id} value={p.id}>
                {p.internalCode} · {p.normalizedName}
              </option>
            ))}
          </optgroup>
        </select>
      </div>

      {tieneCodigo ? (
        <label className="casilla">
          <input type="checkbox" name="aprenderCodigo" defaultChecked />
          <span>
            Recordar que {supplierCode} de {supplierName ?? 'este proveedor'} es este artículo, para
            las próximas facturas
          </span>
        </label>
      ) : null}

      <div className="acciones">
        <button type="button" className="boton boton-secundario" onClick={() => setAbierto(false)}>
          Cancelar
        </button>
        <Boton texto="Asociar" cargando="Asociando…" />
      </div>
    </form>
  );
}
