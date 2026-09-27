'use client';

import { useState } from 'react';
import type { StockWasteCategory } from '@prisma/client';
import { registrarLaMerma, type Resultado } from '../acciones';

/**
 * **La merma, pensada para el teléfono de quien está frente a la góndola.**
 *
 * La revisión y la confirmación viven en la misma pantalla, en dos pasos: primero
 * se arma, después se confirma con el resumen a la vista. La segunda confirmación
 * viaja al servidor como campo del formulario, porque una doble confirmación que
 * sólo existe en el navegador es una decoración que cualquier pedido directo se
 * saltea.
 *
 * **No hay ningún campo de signo ni de «sumar/restar».** La cantidad es lo que se
 * perdió; la dirección la decide el servicio.
 */
export function NuevaMerma({
  mermaId,
  sucursales,
  articulos,
  categorias,
  puedeRegistrar,
  interruptorEncendido,
}: {
  mermaId: string;
  sucursales: { id: string; name: string }[];
  articulos: { id: string; internalCode: string; normalizedName: string }[];
  categorias: { valor: StockWasteCategory; etiqueta: string }[];
  puedeRegistrar: boolean;
  interruptorEncendido: boolean;
}) {
  /*
   * **La clave idempotente se congela al montar la pantalla.**
   *
   * HALLAZGO de la prueba end to end: el identificador lo genera el servidor una
   * vez por carga, pero cualquier `revalidatePath` de la acción hace que Next
   * devuelva el árbol de esta ruta ya re-renderizado, y con él un identificador
   * NUEVO. La consecuencia es la contraria de la buscada: si la respuesta se
   * pierde y la persona vuelve a confirmar, la segunda confirmación viaja con
   * otra clave y la pérdida se descuenta dos veces.
   *
   * `useState` con el valor inicial resuelve eso sin inventar nada en el
   * navegador: toma el identificador que trajo el servidor la primera vez y no
   * lo cambia más mientras la pantalla siga montada. Para registrar otra merma
   * se recarga la pantalla, que es un acto distinto y visible.
   */
  const [clave] = useState(mermaId);

  const [r, setR] = useState<Resultado | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [confirmando, setConfirmando] = useState(false);

  const [branchId, setBranchId] = useState('');
  const [productId, setProductId] = useState('');
  const [cantidad, setCantidad] = useState('');
  const [categoria, setCategoria] = useState<StockWasteCategory | ''>('');
  const [motivo, setMotivo] = useState('');
  const [detalle, setDetalle] = useState('');

  const exigeDetalle = categoria === 'OTRO';
  const completo =
    branchId !== '' &&
    productId !== '' &&
    cantidad.trim() !== '' &&
    categoria !== '' &&
    motivo.trim().length >= 3 &&
    (!exigeDetalle || detalle.trim().length >= 3);

  const articulo = articulos.find((a) => a.id === productId);
  const sucursal = sucursales.find((s) => s.id === branchId);

  async function enviar(f: FormData) {
    setEnviando(true);
    const res = await registrarLaMerma(null, f);
    setR(res);
    setEnviando(false);
    if (res.ok) setConfirmando(false);
  }

  return (
    <>
      {r && (
        <div
          className={
            r.ok ? 'mensaje mensaje-ok' : r.conflicto ? 'mensaje mensaje-aviso' : 'mensaje mensaje-error'
          }
          data-prueba={r.ok ? 'resultado-ok' : r.conflicto ? 'resultado-conflicto' : 'resultado-error'}
        >
          <p style={{ overflowWrap: 'anywhere' }}>{r.mensaje}</p>
          {r.detalle?.yaEstabaAplicada && (
            <p className="chico" data-prueba="ya-aplicada">
              Respuesta idempotente: se devolvió el resultado ya guardado, con la misma clave y la
              misma huella. No se escribió nada nuevo.
            </p>
          )}
        </div>
      )}

      {!interruptorEncendido && (
        <p className="mensaje" data-prueba="aviso-interruptor">
          El interruptor de correcciones reales está apagado: sobre una apertura real esta merma no se
          va a aplicar. Sobre una apertura ficticia, en una base de pruebas, sí.
        </p>
      )}

      <section data-prueba="formulario-merma">
        <label>
          Sucursal
          <select
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            required
            data-prueba="sucursal"
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
          Artículo
          <select
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
            required
            data-prueba="articulo"
          >
            <option value="">Elegí uno…</option>
            {articulos.map((a) => (
              <option key={a.id} value={a.id}>
                {a.internalCode} · {a.normalizedName}
              </option>
            ))}
          </select>
        </label>
        <p className="chico">
          Sólo aparecen los artículos con unidad de existencia aprobada: sin unidad no se sabe si se
          cuenta en kilos o en unidades, y no se puede dar de baja lo que no se sabe medir.
        </p>

        <label>
          Cantidad perdida
          <input
            value={cantidad}
            onChange={(e) => setCantidad(e.target.value)}
            inputMode="decimal"
            required
            data-prueba="cantidad"
          />
        </label>

        <label>
          Categoría
          <select
            value={categoria}
            onChange={(e) => setCategoria(e.target.value as StockWasteCategory)}
            required
            data-prueba="categoria"
          >
            <option value="">Elegí una…</option>
            {categorias.map((c) => (
              <option key={c.valor} value={c.valor}>
                {c.etiqueta}
              </option>
            ))}
          </select>
        </label>

        <label>
          Motivo
          <input
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            required
            placeholder="Qué pasó, en una frase"
            data-prueba="motivo"
          />
        </label>

        {exigeDetalle && (
          <label data-prueba="pide-detalle">
            Detalle (obligatorio con «Otro»)
            <input
              value={detalle}
              onChange={(e) => setDetalle(e.target.value)}
              required
              placeholder="Una categoría que explica todo no explica nada"
              data-prueba="detalle"
            />
          </label>
        )}

        {!puedeRegistrar ? (
          <p className="chico" data-prueba="sin-permiso-merma">
            Registrar una merma baja el saldo y escribe el libro: hace falta el permiso
            «stockerp.merma», que no viene con el rol administrador.
          </p>
        ) : !confirmando ? (
          <button
            type="button"
            onClick={() => setConfirmando(true)}
            disabled={!completo}
            data-prueba="revisar"
          >
            Revisar la merma
          </button>
        ) : (
          <div className="mensaje mensaje-aviso" data-prueba="doble-confirmacion">
            <p>
              <strong>Confirmá la merma.</strong> Van a salir{' '}
              <span data-prueba="resumen-cantidad">{cantidad}</span> de{' '}
              <span data-prueba="resumen-articulo">{articulo?.normalizedName ?? ''}</span> en{' '}
              <span data-prueba="resumen-sucursal">{sucursal?.name ?? ''}</span>, por{' '}
              <span data-prueba="resumen-categoria">
                {categorias.find((c) => c.valor === categoria)?.etiqueta ?? ''}
              </span>
              . <strong>No se deshace</strong>: si estuviera mal, se revierte y queda constancia de
              las dos cosas.
            </p>
            <form action={enviar}>
              <input type="hidden" name="mermaId" value={clave} />
              <input type="hidden" name="branchId" value={branchId} />
              <input type="hidden" name="productId" value={productId} />
              <input type="hidden" name="cantidad" value={cantidad} />
              <input type="hidden" name="categoria" value={categoria} />
              <input type="hidden" name="motivo" value={motivo} />
              <input type="hidden" name="detalle" value={detalle} />
              <input type="hidden" name="confirmado" value="si" />
              <button type="submit" disabled={enviando} data-prueba="confirmar-definitivo">
                {enviando ? 'Registrando…' : 'Sí, registrar la merma'}
              </button>
            </form>
            <button type="button" onClick={() => setConfirmando(false)}>
              No
            </button>
          </div>
        )}
      </section>
    </>
  );
}
