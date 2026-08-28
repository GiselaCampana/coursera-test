'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import {
  analizarCatalogo,
  aplicarCatalogo,
  type ResultadoImportacion,
} from './acciones';

function Boton({ texto, cargando }: { texto: string; cargando: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="boton" disabled={pending}>
      {pending ? cargando : texto}
    </button>
  );
}

function Grupo({
  titulo,
  ayuda,
  filas,
}: {
  titulo: string;
  ayuda: string;
  filas: { plu: string; nombre: string; detalle?: string }[];
}) {
  return (
    <details className="card">
      <summary>
        <strong>{titulo}</strong> · {filas.length}
      </summary>
      <p className="chico medio">{ayuda}</p>
      {filas.length === 0 ? (
        <p className="chico medio mb0">No hay ninguno.</p>
      ) : (
        <ul className="lista">
          {filas.map((f) => (
            <li key={`${f.plu}-${f.nombre}`} className="fila-dato">
              <div className="fila-dato-meta">
                <strong>{f.plu}</strong>
                <span>{f.nombre}</span>
              </div>
              {f.detalle ? <p className="chico medio mb0">{f.detalle}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

/**
 * Traer el catálogo de Control de Stock.
 *
 * En dos pasos y nunca en uno. El primero lee el archivo y **no escribe nada**:
 * dice cuántos artículos entrarían nuevos, cuáles cambiarían y qué, qué códigos
 * de proveedor quedarían aprendidos, qué está en Compras y no vino, y qué no se
 * puede resolver solo. Recién después, con una confirmación aparte, se aplica.
 *
 * Lo que se toca es la identidad de los artículos —su PLU, su nombre, su
 * familia—, y de eso cuelgan las compras, los costos y los precios. Conviene
 * poder leer antes lo que va a pasar.
 */
export function Importar() {
  const [previa, accionPrevia] = useActionState<ResultadoImportacion, FormData>(
    analizarCatalogo,
    {},
  );
  const [aplicado, accionAplicar] = useActionState<ResultadoImportacion, FormData>(
    aplicarCatalogo,
    {},
  );
  const [texto, setTexto] = useState('');
  const [nombreArchivo, setNombreArchivo] = useState<string | null>(null);

  const informe = previa.informe;

  /*
   * El contenido viaja en el formulario, y los formularios tienen un tope.
   *
   * Un catálogo de fiambrería entra de sobra, pero conviene decirlo acá y no
   * dejar que el navegador devuelva un error sin explicación si algún día el
   * archivo trae de más. El límite del servidor es 1 MB; se avisa antes.
   */
  const demasiadoGrande = new Blob([texto]).size > 900_000;

  return (
    <>
      <form action={accionPrevia} className="card">
        <h2>1. Elegí el archivo</h2>
        <p className="chico medio">
          La exportación del catálogo de Control de Stock, en CSV o JSON. Tiene que traer al menos
          PLU y Artículo. Para que los PDFs y filtros queden correctamente organizados, conviene
          exportar también «Tipo de Artículo» y «Subtipo de Artículo». El PLU se copia tal cual:
          acá no se renumera nada.
        </p>

        <div className="campo">
          <label htmlFor="archivo">Archivo</label>
          <input
            id="archivo"
            type="file"
            accept=".csv,.json,.txt,text/csv,application/json,text/plain"
            onChange={async (e) => {
              const archivo = e.target.files?.[0];
              if (!archivo) return;
              /*
               * Se lee en el navegador y viaja como texto en el formulario.
               *
               * Así el mismo contenido sirve para la vista previa y para
               * aplicar, sin subir el archivo dos veces ni guardarlo en el
               * medio: lo que se confirma es exactamente lo que se miró.
               */
              setTexto(await archivo.text());
              setNombreArchivo(archivo.name);
            }}
          />
          {nombreArchivo ? (
            <p className="ayuda">
              {nombreArchivo} · {texto.split('\n').length} líneas leídas.
            </p>
          ) : null}
        </div>

        <div className="campo">
          <label htmlFor="texto">O pegá el contenido</label>
          <textarea
            id="texto"
            name="texto"
            rows={5}
            value={texto}
            onChange={(e) => {
              setTexto(e.target.value);
              setNombreArchivo(null);
            }}
            placeholder={'PLU;Nombre;Familia\n1211;Cremoso Punta del Agua;Quesos'}
          />
        </div>

        <div className="campo">
          <label htmlFor="familiaDesde">Familia a partir de</label>
          <select id="familiaDesde" name="familiaDesde" defaultValue="auto">
            <option value="auto">El nivel más fino que traiga el archivo</option>
            <option value="subtipo">Subtipo de Artículo</option>
            <option value="tipo">Tipo de Artículo</option>
            <option value="ninguna">No agrupar en familias</option>
          </select>
          <p className="ayuda">
            La familia es lo que permite preguntar «cuánto Sardo compramos» y que sume los dos PLU
            de Sardo. Control de Stock trae dos niveles y cuál sirve depende de cómo estén
            cargados: elegí uno, mirá abajo qué familias saldrían, y cambialo si no es el que
            agrupa bien.
          </p>
        </div>

        {previa.error ? (
          <p className="mensaje mensaje-error" role="alert">
            {previa.error}
          </p>
        ) : null}
        {demasiadoGrande ? (
          <p className="mensaje mensaje-aviso" role="alert">
            El archivo pesa más de lo que se puede mandar de una vez. Partilo en dos y hacé dos
            importaciones: al ser un upsert por PLU, importar por partes da lo mismo que importar
            todo junto.
          </p>
        ) : null}

        <div className="acciones">
          <Boton texto="Ver qué cambiaría" cargando="Leyendo…" />
        </div>
      </form>

      {informe ? (
        <>
          <div className="card card-compacta">
            <h2>2. Lo que va a pasar</h2>
            <dl className="resumen-mes" style={{ margin: 0 }}>
              <div className="dato destacado">
                <dt>Artículos leídos</dt>
                <dd>{informe.totalLeidas}</dd>
              </div>
              <div className="dato">
                <dt>Nuevos</dt>
                <dd>{informe.nuevos.length}</dd>
              </div>
              <div className="dato">
                <dt>Se actualizan</dt>
                <dd>{informe.actualizables.length}</dd>
              </div>
              <div className="dato">
                <dt>Sin cambios</dt>
                <dd>{informe.sinCambios.length}</dd>
              </div>
              <div className="dato">
                <dt>Conflictos</dt>
                <dd>{informe.conflictos.length}</dd>
              </div>
              <div className="dato">
                <dt>Sólo en Compras</dt>
                <dd>{informe.soloEnCompras.length}</dd>
              </div>
            </dl>
            {informe.columnas.length > 0 ? (
              <p className="ayuda">Columnas reconocidas: {informe.columnas.join(', ')}.</p>
            ) : null}
            {!informe.traeTipo || !informe.traeSubtipo ? (
              <div className="mensaje mensaje-aviso" role="alert">
                <strong>La clasificación está incompleta.</strong>{' '}
                {!informe.traeTipo && !informe.traeSubtipo
                  ? 'Este archivo no trae Tipo de Artículo ni Subtipo de Artículo.'
                  : !informe.traeTipo
                    ? 'Este archivo no trae Tipo de Artículo.'
                    : 'Este archivo no trae Subtipo de Artículo.'}{' '}
                Los productos se pueden importar igual, pero los que no tengan clasificación
                quedarán al final del PDF como «Pendientes de clasificar». Para completar el
                catálogo, exportá Hoja 1 incluyendo esas columnas y volvé a importar: se actualiza
                por PLU sin tocar compras, costos ni marcajes.
              </div>
            ) : (
              <p className="mensaje mensaje-ok">
                El archivo trae Tipo de Artículo y Subtipo de Artículo. La clasificación se
                actualizará por PLU.
              </p>
            )}
          </div>

          {/*
            Los renombres sobre PLU que ya tienen compras van arriba y sin
            plegar. Es la única categoría donde confirmar sin mirar cambia el
            pasado: reetiqueta compras ya validadas.
          */}
          {informe.renombresConCompras.length > 0 ? (
            <div className="card">
              <h3>Cambian de nombre y ya tienen compras cargadas</h3>
              <div className="mensaje mensaje-error" role="alert">
                <p>
                  Estos PLU ya están usados en facturas validadas. Cambiarles el nombre reetiqueta
                  esas compras hacia atrás. Casi siempre significa que el número está ocupado por
                  otro artículo —de demostración, o cargado a mano— y que en Control de Stock ese
                  mismo número es otra cosa. Miralos uno por uno antes de confirmar.
                </p>
                <ul>
                  {informe.renombresConCompras.map((r) => (
                    <li key={r.plu}>
                      <strong>{r.plu}</strong> ·{' '}
                      {r.cambios.map((c) => `${c.campo}: ${c.antes} → ${c.despues}`).join(' · ')}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}

          {informe.proveedoresDesconocidos.length > 0 ? (
            <div className="card">
              <h3>Proveedores del archivo que no están en Compras</h3>
              <p className="chico medio mb0">
                El catálogo entra igual: el proveedor de la Hoja 1 es informativo y sólo se usa
                como proveedor habitual del artículo. Si querés que quede vinculado, dalos de alta
                en Proveedores y volvé a importar.{' '}
                <strong>{informe.proveedoresDesconocidos.join(', ')}</strong>
              </p>
            </div>
          ) : null}

          {informe.familiasNuevas.length > 0 ? (
            <details className="card">
              <summary>
                <strong>Familias que se crean</strong> · {informe.familiasNuevas.length}
              </summary>
              <p className="chico medio">
                Salen de la columna que elegiste arriba. Si ves una familia por cada artículo, el
                nivel es demasiado fino; si ves una sola para todo, es demasiado grueso.
              </p>
              <p className="chico mb0">{informe.familiasNuevas.join(' · ')}</p>
            </details>
          ) : null}

          {informe.problemas.length > 0 ? (
            <div className="card">
              <h3>Filas que no se pueden importar</h3>
              <div className="mensaje mensaje-aviso">
                <ul>
                  {informe.problemas.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}

          <Grupo
            titulo="Nuevos"
            ayuda="No están en Compras. Se crean con el PLU que trae el archivo."
            filas={informe.nuevos.map((n) => ({
              plu: n.plu,
              nombre: n.nombre,
              detalle: n.familia ? `Familia: ${n.familia}` : undefined,
            }))}
          />

          <Grupo
            titulo="Se actualizan"
            ayuda="Ya están, con ese mismo PLU, y algo cambió. El margen, el descuento por efectivo y el redondeo no se tocan: son de Compras, no de Stock."
            filas={informe.actualizables.map((a) => ({
              plu: a.plu,
              nombre: a.nombre,
              detalle: a.cambios.map((c) => `${c.campo}: ${c.antes} → ${c.despues}`).join(' · '),
            }))}
          />

          <Grupo
            titulo="Códigos de proveedor que quedan aprendidos"
            ayuda="A partir de acá, una factura con ese código entra asociada sola, sin depender de cómo salga la descripción del OCR."
            filas={informe.codigosPorAprender.map((c) => ({
              plu: c.plu,
              nombre: `${c.proveedor} · ${c.codigo}`,
            }))}
          />

          <Grupo
            titulo="Conflictos"
            ayuda="No se resuelven solos y no se aplican. Son los casos en que aplicar significaría renumerar un artículo o mudarle el código a otro."
            filas={informe.conflictos.map((c) => ({
              plu: c.plu,
              nombre: '',
              detalle: c.motivo,
            }))}
          />

          <Grupo
            titulo="Datos demo antiguos que se desactivan"
            ayuda="Son PLU inventados por versiones viejas del seed, no aparecen en el catálogo real y no tienen historial. Se desactivan para que dejen de aparecer en Productos y Precios; no se borra ningún registro."
            filas={informe.demosDesactivables.map((p) => ({
              plu: p.plu,
              nombre: p.nombre,
            }))}
          />

          <Grupo
            titulo="Sólo en Compras"
            ayuda="Están acá y no vinieron en el archivo. No se borra ninguno: puede que la exportación esté incompleta, y los que tienen compras cargadas se llevarían el historial puesto."
            filas={informe.soloEnCompras.map((p) => ({
              plu: p.plu,
              nombre: p.nombre,
              detalle: p.conMovimientos ? 'Tiene compras cargadas.' : undefined,
            }))}
          />

          <form action={accionAplicar} className="card">
            <h2>3. Confirmar</h2>
            <input type="hidden" name="texto" value={previa.texto ?? ''} />
            <input type="hidden" name="familiaDesde" value={previa.familiaDesde ?? 'auto'} />
            <p className="mensaje mensaje-aviso">
              Se van a crear {informe.nuevos.length} artículo/s y actualizar{' '}
              {informe.actualizables.length}. No se borra ninguno, no se renumera ninguno y no se
              tocan las compras, los impuestos ni los pagos ya cargados.
              {informe.demosDesactivables.length > 0
                ? ` Además, se desactivan ${informe.demosDesactivables.length} artículo/s demo antiguos sin historial.`
                : ''}
              Queda registrado en la auditoría con tu usuario.
            </p>
            {aplicado.error ? (
              <p className="mensaje mensaje-error" role="alert">
                {aplicado.error}
              </p>
            ) : null}
            <div className="acciones">
              <Boton texto="Sí, importar el catálogo" cargando="Importando…" />
            </div>
          </form>
        </>
      ) : null}
    </>
  );
}
