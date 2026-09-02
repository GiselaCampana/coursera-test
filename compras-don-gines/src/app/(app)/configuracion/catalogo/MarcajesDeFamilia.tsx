'use client';

import { useActionState, useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { CAMPO_DEL_MARCAJE, MARCAJES, marcajesEfectivos, type FuenteDeMarcajes } from '@/lib/domain/marcajes';
import { CamposDeMarcajes, pct } from './CamposDeMarcajes';
import { guardarMarcajesFamilia, type ResultadoMarcajesDeFamilia } from './acciones';

/**
 * Los marcajes de una familia: el segundo nivel de la cadena.
 *
 * Un campo vacío no es un cero: es "esta familia no dice nada", y entonces
 * contesta la regla general. Por eso ninguno es obligatorio y ninguno viene con
 * un número puesto de antemano.
 */

function Guardar() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="boton boton-chico" disabled={pending}>
      {pending ? 'Guardando…' : 'Guardar los marcajes de la familia'}
    </button>
  );
}

export function MarcajesDeFamilia({
  familyId,
  nombre,
  articulos,
  heredanElBase,
  marcajes,
  general,
}: {
  familyId: string;
  nombre: string;
  articulos: number;
  heredanElBase: number;
  marcajes: FuenteDeMarcajes;
  /** El tercer nivel, para poder mostrar el valor efectivo de verdad. */
  general: FuenteDeMarcajes;
}) {
  const [abierto, setAbierto] = useState(false);
  const [estado, accion] = useActionState<ResultadoMarcajesDeFamilia, FormData>(
    guardarMarcajesFamilia,
    {},
  );

  /*
   * Al guardar bien, el formulario se cierra.
   *
   * No es sólo prolijidad: el aviso de "guardado" vive en la vista cerrada, así
   * que sin esto uno apretaba guardar y no pasaba nada visible. Cerrarlo además
   * muestra los valores que quedaron persistidos y no lo que había en los
   * campos.
   */
  useEffect(() => {
    if (estado.ok && estado.familyId === familyId) setAbierto(false);
  }, [estado.ok, estado.familyId, familyId]);

  /*
   * Lo que un artículo sin nada propio va a terminar usando, con esta familia.
   *
   * Se resuelve contra la regla general, que es lo que de verdad pasa: si la
   * familia no dice nada, el número no sale de la nada, sale del tercer nivel.
   */
  const efectivos = marcajesEfectivos({}, marcajes, general);
  const defineAlgo =
    Boolean(marcajes.targetMarginPct) ||
    MARCAJES.some((m) => Boolean(marcajes[CAMPO_DEL_MARCAJE[m]]));

  if (!abierto) {
    return (
      <div className="fila-dato">
        <div className="fila-dato-cabecera">
          <span className="fila-dato-titulo">{nombre}</span>
          <span className="chico medio">
            {articulos} artículo{articulos === 1 ? '' : 's'}
          </span>
        </div>
        <div className="fila-dato-meta">
          {defineAlgo ? (
            <span>
              Marcaje base{' '}
              <strong>
                {marcajes.targetMarginPct ? `${pct(marcajes.targetMarginPct)} %` : 'sin definir'}
              </strong>
            </span>
          ) : (
            <span className="suave">
              Sin marcajes propios: sus artículos resuelven con la regla general
            </span>
          )}
          {/*
            Cuántos artículos van a moverse. Es el número que hace falta antes
            de tocar nada: cambiar el marcaje de la familia mueve el precio de
            los que heredan y de ninguno de los que tienen el suyo.
          */}
          <span>
            {heredanElBase === 0
              ? 'Ningún artículo hereda el base'
              : `${heredanElBase} de ${articulos} heredan el base`}
          </span>
        </div>
        {estado.ok && estado.familyId === familyId ? (
          <p className="mensaje mensaje-ok mt mb0" role="status">
            Marcajes de la familia actualizados.
          </p>
        ) : null}
        <div className="acciones">
          <button
            type="button"
            className="boton boton-secundario boton-chico"
            onClick={() => setAbierto(true)}
          >
            Configurar marcajes
          </button>
        </div>
      </div>
    );
  }

  return (
    <form action={accion} className="fila-dato">
      <input type="hidden" name="familyId" value={familyId} />
      <h3>{nombre}</h3>
      {estado.error && estado.familyId === familyId ? (
        <p className="mensaje mensaje-error" role="alert">
          {estado.error}
        </p>
      ) : null}

      <p className="mensaje mensaje-info">
        Lo que dejes vacío no se aplica: contesta la regla general. Lo que un artículo tenga
        cargado le gana a esto.{' '}
        {heredanElBase > 0
          ? `Al guardar, van a cambiar los precios de los ${heredanElBase} artículos que heredan el base.`
          : 'Ningún artículo de esta familia hereda el base hoy, así que esto no va a mover ningún precio todavía.'}
      </p>

      <CamposDeMarcajes
        prefijo={familyId}
        marcajes={marcajes}
        efectivos={efectivos}
        etiquetaBase="Marcaje base de la familia (%)"
        ayudaBase="Es el precio por kilo, y el que usan las formas de venta que queden vacías."
      />

      <div className="acciones">
        <button
          type="button"
          className="boton boton-secundario boton-chico"
          onClick={() => setAbierto(false)}
        >
          Cancelar
        </button>
        <Guardar />
      </div>
    </form>
  );
}
