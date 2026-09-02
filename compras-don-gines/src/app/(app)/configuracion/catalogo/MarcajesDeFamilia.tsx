'use client';

import { useActionState, useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import {
  MARCAJES,
  MARCAJE_LABEL,
  marcajesDeLaFamilia,
  type FuenteDeMarcajes,
  type Marcaje,
} from '@/lib/domain/marcajes';
import {
  guardarMarcajesFamilia,
  type ResultadoMarcajesDeFamilia,
} from './acciones';

/**
 * Los marcajes de una familia.
 *
 * Un campo vacío no es un cero: es "esta familia no dice nada". Por eso ninguno
 * es obligatorio y ninguno viene con un número puesto de antemano. Escribir un
 * valor por omisión en el formulario haría que guardar sin mirar fijara ese
 * número para toda la familia.
 */

const CAMPO: Record<Marcaje, string> = {
  alCorteHormaDigital: 'alCorteHormaDigitalMarginPct',
  alCorteHormaCash: 'alCorteHormaCashMarginPct',
  alCorteCajaCash: 'alCorteCajaCashMarginPct',
  feteado100g: 'feteado100gMarginPct',
  feteadoQuarter: 'feteadoQuarterMarginPct',
  feteadoPieceDigital: 'feteadoPieceDigitalMarginPct',
  feteadoPieceCash: 'feteadoPieceCashMarginPct',
  wholeUnit: 'wholeUnitMarginPct',
};

/** Una fracción guardada (0,45) como porcentaje para el campo (45). */
function pct(valor: string | null | undefined): string {
  if (valor === null || valor === undefined || valor === '') return '';
  return String(Number(valor) * 100);
}

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
}: {
  familyId: string;
  nombre: string;
  articulos: number;
  heredanElBase: number;
  marcajes: FuenteDeMarcajes;
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

  // Lo que un artículo sin nada propio va a terminar usando, con esta familia.
  const efectivos = marcajesDeLaFamilia(marcajes);
  const defineAlgo =
    Boolean(marcajes.targetMarginPct) || MARCAJES.some((m) => Boolean(marcajes[CAMPO[m] as keyof FuenteDeMarcajes]));

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
            <span className="suave">Sin marcajes propios: cada artículo resuelve por su cuenta</span>
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
        Lo que dejes vacío no se aplica: cada artículo resuelve por su cuenta.{' '}
        {heredanElBase > 0
          ? `Al guardar, van a cambiar los precios de los ${heredanElBase} artículos que heredan el base.`
          : 'Ningún artículo de esta familia hereda el base hoy, así que esto no va a mover ningún precio todavía.'}
      </p>

      <div className="campo">
        <label htmlFor={`base-${familyId}`}>Marcaje base de la familia (%)</label>
        <input
          id={`base-${familyId}`}
          name="targetMarginPct"
          type="text"
          inputMode="decimal"
          defaultValue={pct(marcajes.targetMarginPct)}
          placeholder="Vacío: cada artículo usa el suyo"
        />
      </div>

      <div className="campo">
        <label htmlFor={`basis-${familyId}`}>Base del marcaje</label>
        <select id={`basis-${familyId}`} name="marginBasis" defaultValue={marcajes.marginBasis ?? ''}>
          <option value="">Vacío: la del artículo</option>
          <option value="SOBRE_COSTO">Sobre el costo</option>
          <option value="SOBRE_VENTA">Sobre la venta</option>
        </select>
      </div>

      <h4>Marcajes por forma de venta</h4>
      <div className="fila fila-2">
        {MARCAJES.map((m) => {
          const campo = CAMPO[m];
          const propio = marcajes[campo as keyof FuenteDeMarcajes] as string | null | undefined;
          return (
            <div className="campo" key={m}>
              <label htmlFor={`${m}-${familyId}`}>{MARCAJE_LABEL[m]} (%)</label>
              <input
                id={`${m}-${familyId}`}
                name={campo}
                type="text"
                inputMode="decimal"
                defaultValue={pct(propio)}
                placeholder={
                  marcajes.targetMarginPct ? `Vacío: ${pct(efectivos.especificos[m].valor)} %` : 'Vacío'
                }
              />
            </div>
          );
        })}
      </div>

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
