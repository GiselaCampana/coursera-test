'use client';

import { useActionState, useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import {
  SIN_REGLA_GENERAL,
  marcajesEfectivos,
  type FuenteDeMarcajes,
} from '@/lib/domain/marcajes';
import { CamposDeMarcajes, pct } from './CamposDeMarcajes';
import { guardarReglaGeneral, type ResultadoReglaGeneral } from './acciones';

/**
 * La regla general: el tercer y último nivel de la cadena.
 *
 * Existía desde el principio en la base y no la usaba nadie: se consultaba y se
 * descartaba. Ahora es la que contesta cuando ni el artículo ni la familia
 * dicen nada, y es la única configuración global que hay. Editarla acá edita
 * exactamente la fila que el cálculo de precios lee.
 *
 * Sigue siendo el último recurso, no el primero: cualquier valor cargado en un
 * artículo o en una familia le gana.
 */

function Guardar() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="boton boton-chico" disabled={pending}>
      {pending ? 'Guardando…' : 'Guardar la regla general'}
    </button>
  );
}

export function ReglaGeneral({
  marcajes,
  dependenDeElla,
  existe,
}: {
  marcajes: FuenteDeMarcajes;
  dependenDeElla: number;
  /** Si todavía no hay ninguna fila cargada, la primera vez que se guarda se crea. */
  existe: boolean;
}) {
  const [abierto, setAbierto] = useState(false);
  const [estado, accion] = useActionState<ResultadoReglaGeneral, FormData>(
    guardarReglaGeneral,
    {},
  );

  useEffect(() => {
    if (estado.ok) setAbierto(false);
  }, [estado.ok]);

  // La regla general no hereda de nadie: lo que muestra es lo suyo.
  const efectivos = marcajesEfectivos({}, marcajes);

  if (!abierto) {
    return (
      <>
        <div className="fila-dato-meta">
          <span>
            Marcaje base{' '}
            <strong>
              {marcajes.targetMarginPct
                ? `${pct(marcajes.targetMarginPct)} %`
                : `sin cargar (se usa ${pct(SIN_REGLA_GENERAL)} %)`}
            </strong>
          </span>
          <span>
            {dependenDeElla === 0
              ? 'Ningún artículo depende hoy de la regla general'
              : dependenDeElla === 1
                ? '1 artículo depende de ella'
                : `${dependenDeElla} artículos dependen de ella`}
          </span>
        </div>
        {estado.ok ? (
          <p className="mensaje mensaje-ok mt mb0" role="status">
            Regla general actualizada.
          </p>
        ) : null}
        <div className="acciones">
          <button
            type="button"
            className="boton boton-secundario boton-chico"
            onClick={() => setAbierto(true)}
          >
            Configurar la regla general
          </button>
        </div>
      </>
    );
  }

  return (
    <form action={accion}>
      {estado.error ? (
        <p className="mensaje mensaje-error" role="alert">
          {estado.error}
        </p>
      ) : null}

      <p className="mensaje mensaje-info">
        Es el último nivel: sólo se aplica donde el artículo y su familia no dicen nada.{' '}
        {existe
          ? null
          : 'Todavía no hay ninguna cargada; al guardar se crea. '}
        {dependenDeElla === 0
          ? 'Hoy ningún artículo depende de ella, así que esto no va a mover ningún precio todavía.'
          : dependenDeElla === 1
            ? 'Al guardar, va a cambiar el precio del único artículo que depende de ella.'
            : `Al guardar, van a cambiar los precios de los ${dependenDeElla} artículos que dependen de ella.`}
      </p>

      <CamposDeMarcajes
        prefijo="general"
        marcajes={marcajes}
        efectivos={efectivos}
        etiquetaBase="Marcaje base general (%)"
        ayudaBase="Es el precio por kilo, y el que usan las formas de venta que queden vacías. Obligatorio: abajo de la regla general no hay de dónde heredar."
        baseObligatorio
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
