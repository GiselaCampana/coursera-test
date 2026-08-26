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
          el PLU y el nombre; si además trae familia, categoría, proveedor, código del proveedor o
          activo, se usan. El PLU se copia tal cual: acá no se renumera nada.
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
          </div>

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
            <p className="mensaje mensaje-aviso">
              Se van a crear {informe.nuevos.length} artículo/s y actualizar{' '}
              {informe.actualizables.length}. No se borra ninguno, no se renumera ninguno y no se
              tocan las compras, los impuestos ni los pagos ya cargados. Queda registrado en la
              auditoría con tu usuario.
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
