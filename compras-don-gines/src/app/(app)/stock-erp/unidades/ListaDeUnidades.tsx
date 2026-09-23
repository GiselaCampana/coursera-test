'use client';

import { useState } from 'react';
import type { EstadoDeUnidad } from '@/lib/services/stock-erp-unidades';
import { aprobarUnidad, guardarPresentacionDeCompra, reconocerLaDiscrepancia, type Resultado } from './acciones';

/**
 * **Configuración de unidades de Stock ERP, pensada para el teléfono.**
 *
 * Cada artículo es una tarjeta y no una fila: en 390 píxeles una tabla de siete
 * columnas obliga a desplazar de lado para leer un dato, y el dato que importa
 * acá —¿cuál es la unidad y quién la decidió?— no puede quedar fuera de la
 * pantalla.
 *
 * LO QUE LA PANTALLA TIENE QUE DEJAR CLARO, y es su razón de existir:
 * **cuál número es dato externo y cuál es decisión nuestra.** El catálogo
 * informa; Stock ERP decide. Mezclarlos visualmente sería volver al problema
 * que esta fase vino a separar, así que van con etiqueta propia y en ese orden.
 */

function Etiqueta({ children, tono }: { children: React.ReactNode; tono: 'externo' | 'interno' | 'aviso' }) {
  const colores = {
    externo: { fondo: 'var(--gris-suave, #eef1f4)', texto: 'var(--gris-fuerte, #44515e)' },
    interno: { fondo: 'var(--verde-suave, #e6f4ea)', texto: 'var(--verde-fuerte, #1e5631)' },
    aviso: { fondo: 'var(--ambar-suave, #fdf1d6)', texto: 'var(--ambar-fuerte, #7a5200)' },
  }[tono];
  return (
    <span
      className="chico"
      style={{
        background: colores.fondo,
        color: colores.texto,
        borderRadius: 6,
        padding: '2px 7px',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

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

function Tarjeta({ item, proveedores }: { item: EstadoDeUnidad; proveedores: { id: string; nombre: string }[] }) {
  const [abierto, setAbierto] = useState(false);
  const [confirmando, setConfirmando] = useState<string | null>(null);
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function enviar(accion: (p: Resultado | null, f: FormData) => Promise<Resultado>, f: FormData) {
    setEnviando(true);
    const r = await accion(null, f);
    setResultado(r);
    setEnviando(false);
    if (r.ok) setConfirmando(null);
  }

  return (
    <article className="tarjeta" data-prueba="articulo" data-plu={item.plu} style={{ marginBottom: 12 }}>
      <header style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong data-prueba="plu">{item.plu}</strong>
        <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{item.nombre}</span>
        {item.bloqueado ? (
          <Etiqueta tono="aviso">
            <span data-prueba="estado">PENDIENTE — bloqueado</span>
          </Etiqueta>
        ) : (
          <Etiqueta tono="interno">
            <span data-prueba="estado">APROBADA</span>
          </Etiqueta>
        )}
      </header>

      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 10px', margin: '10px 0 0' }}>
        <dt className="chico">Catálogo informa</dt>
        <dd className="chico" style={{ margin: 0 }} data-prueba="unidad-catalogo">
          {item.unidadDelCatalogo ? (
            <Etiqueta tono="externo">{item.unidadDelCatalogo} · dato externo</Etiqueta>
          ) : (
            <Etiqueta tono="externo">sin dato · no se sincronizó todavía</Etiqueta>
          )}
        </dd>
        <dt className="chico">Existencia (ERP)</dt>
        <dd className="chico" style={{ margin: 0 }} data-prueba="unidad-existencia">
          {item.unidadDeExistencia ? (
            <Etiqueta tono="interno">
              {item.unidadDeExistencia} · decisión interna{item.aprobadaPor ? ` de ${item.aprobadaPor}` : ''}
            </Etiqueta>
          ) : (
            <Etiqueta tono="aviso">sin aprobar</Etiqueta>
          )}
        </dd>
      </dl>

      {item.discrepancia && (
        <p className="mensaje mensaje-aviso" data-prueba="discrepancia" style={{ marginTop: 10 }}>
          El catálogo informa <strong>{item.unidadDelCatalogo}</strong> y la existencia aprobada es{' '}
          <strong>{item.unidadDeExistencia}</strong>. Puede estar bien —un proveedor factura cajas y el
          local cuenta kilos— o puede ser un error del catálogo. No se corrige sola.
        </p>
      )}

      <button type="button" className="boton-secundario chico" onClick={() => setAbierto((v) => !v)}>
        {abierto ? 'Cerrar' : 'Configurar'}
      </button>

      {abierto && (
        <div style={{ marginTop: 12, borderTop: '1px solid var(--borde, #dfe3e8)', paddingTop: 12 }}>
          <Aviso r={resultado} />

          {/* --- Unidad de existencia ------------------------------------- */}
          <form
            data-prueba="form-unidad"
            action={(f) => {
              f.set('confirmado', confirmando === 'unidad' ? 'si' : 'no');
              return enviar(aprobarUnidad, f);
            }}
          >
            <input type="hidden" name="productId" value={item.productId} />
            <label className="etiqueta" htmlFor={`unidad-${item.plu}`}>
              Unidad de existencia
            </label>
            <select
              id={`unidad-${item.plu}`}
              name="unidad"
              defaultValue={item.unidadDeExistencia ?? ''}
              data-prueba="elegir-unidad"
            >
              <option value="">Elegir…</option>
              <option value="KG">KG — se cuenta por kilo</option>
              <option value="UNIT">UNIT — se cuenta por unidad</option>
            </select>

            {item.unidadDeExistencia && (
              <>
                <label className="etiqueta" htmlFor={`motivo-${item.plu}`}>
                  Motivo del cambio (obligatorio)
                </label>
                <input id={`motivo-${item.plu}`} name="motivo" data-prueba="motivo" />
              </>
            )}

            {confirmando === 'unidad' ? (
              <div className="mensaje mensaje-aviso" data-prueba="doble-confirmacion">
                <p>
                  Esto fija cómo se va a contar este artículo en el libro de existencias. Una vez que
                  haya movimientos no se puede cambiar sin un ajuste explícito.
                </p>
                <button type="submit" className="boton" disabled={enviando} data-prueba="confirmar-unidad">
                  Sí, fijar la unidad
                </button>
                <button
                  type="button"
                  className="boton-secundario"
                  onClick={() => setConfirmando(null)}
                  data-prueba="cancelar-unidad"
                >
                  Cancelar
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="boton"
                onClick={() => setConfirmando('unidad')}
                data-prueba="aprobar-unidad"
              >
                Aprobar unidad
              </button>
            )}
          </form>

          {/* --- Presentaciones de compra --------------------------------- */}
          <h3 className="chico" style={{ marginTop: 16 }}>
            Presentaciones de compra
          </h3>
          {item.presentaciones.length === 0 ? (
            <p className="chico" data-prueba="sin-presentaciones">
              Ninguna cargada. Sin una conversión aprobada, un renglón facturado en otra unidad queda
              bloqueado.
            </p>
          ) : (
            <div className="tabla-scroll">
              <table data-prueba="tabla-presentaciones">
                <thead>
                  <tr>
                    <th>Proveedor</th>
                    <th>Código</th>
                    <th>Unidad</th>
                    <th>Factor</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {item.presentaciones.map((p) => (
                    <tr key={p.id} data-prueba="presentacion">
                      <td>{p.proveedorNombre ?? 'cualquiera'}</td>
                      <td>{p.codigoDelProveedor ?? '—'}</td>
                      <td>{p.unidadDeCompra}</td>
                      <td data-prueba="factor">{p.factor}</td>
                      <td>{p.estado}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <form
            data-prueba="form-presentacion"
            action={(f) => {
              f.set('confirmado', 'si');
              f.set('aprobar', 'si');
              return enviar(guardarPresentacionDeCompra, f);
            }}
          >
            <input type="hidden" name="productId" value={item.productId} />
            <label className="etiqueta" htmlFor={`prov-${item.plu}`}>
              Proveedor
            </label>
            <select id={`prov-${item.plu}`} name="proveedorId" data-prueba="presentacion-proveedor">
              <option value="">Cualquiera</option>
              {proveedores.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nombre}
                </option>
              ))}
            </select>
            <label className="etiqueta" htmlFor={`cod-${item.plu}`}>
              Código del proveedor
            </label>
            <input id={`cod-${item.plu}`} name="codigoDelProveedor" data-prueba="presentacion-codigo" />
            <label className="etiqueta" htmlFor={`uc-${item.plu}`}>
              Unidad de compra
            </label>
            <select id={`uc-${item.plu}`} name="unidadDeCompra" data-prueba="presentacion-unidad">
              <option value="UNIT">UNIT</option>
              <option value="KG">KG</option>
            </select>
            <label className="etiqueta" htmlFor={`fac-${item.plu}`}>
              Factor de conversión
            </label>
            <input id={`fac-${item.plu}`} name="factor" inputMode="decimal" data-prueba="presentacion-factor" />
            <button type="submit" className="boton-secundario" disabled={enviando} data-prueba="guardar-presentacion">
              Guardar presentación
            </button>
          </form>

          {item.discrepancia && (
            <form
              data-prueba="form-discrepancia"
              action={(f) => enviar(reconocerLaDiscrepancia, f)}
              style={{ marginTop: 12 }}
            >
              <input type="hidden" name="productId" value={item.productId} />
              <label className="etiqueta" htmlFor={`disc-${item.plu}`}>
                Reconocer la diferencia (queda registrado quién y por qué)
              </label>
              <input id={`disc-${item.plu}`} name="motivo" data-prueba="motivo-discrepancia" />
              <button type="submit" className="boton-secundario" disabled={enviando}>
                Reconocer
              </button>
            </form>
          )}
        </div>
      )}
    </article>
  );
}

export function ListaDeUnidades({
  items,
  proveedores,
  puedeConfigurar,
}: {
  items: EstadoDeUnidad[];
  proveedores: { id: string; nombre: string }[];
  puedeConfigurar: boolean;
}) {
  const [filtro, setFiltro] = useState<'todos' | 'pendientes' | 'aprobados' | 'discrepancias'>('todos');
  const [texto, setTexto] = useState('');

  const visibles = items.filter((i) => {
    if (filtro === 'pendientes' && i.estado !== 'PENDIENTE') return false;
    if (filtro === 'aprobados' && i.estado !== 'APROBADA') return false;
    if (filtro === 'discrepancias' && !i.discrepancia) return false;
    if (!texto.trim()) return true;
    const t = texto.trim().toLowerCase();
    return (
      i.plu.toLowerCase().includes(t) ||
      i.nombre.toLowerCase().includes(t) ||
      (i.familia ?? '').toLowerCase().includes(t)
    );
  });

  return (
    <>
      <input
        type="search"
        placeholder="Buscar por PLU, nombre o familia"
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        data-prueba="buscar"
        aria-label="Buscar artículos"
      />
      <div
        role="group"
        aria-label="Filtrar"
        style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '10px 0 14px' }}
      >
        {(['todos', 'pendientes', 'aprobados', 'discrepancias'] as const).map((f) => (
          <button
            key={f}
            type="button"
            className={filtro === f ? 'boton chico' : 'boton-secundario chico'}
            onClick={() => setFiltro(f)}
            data-prueba={`filtro-${f}`}
            aria-pressed={filtro === f}
          >
            {f}
          </button>
        ))}
      </div>

      {!puedeConfigurar && (
        <p className="mensaje mensaje-aviso" data-prueba="sin-permiso-configurar">
          Tu usuario puede mirar pero no aprobar unidades. El permiso
          «stockerp.unidades.configurar» se pide a un administrador desde Configuración → Roles.
        </p>
      )}

      <p className="chico" data-prueba="cuenta">
        {visibles.length} de {items.length} artículos
      </p>

      {visibles.map((i) => (
        <Tarjeta key={i.productId} item={i} proveedores={proveedores} />
      ))}
    </>
  );
}
