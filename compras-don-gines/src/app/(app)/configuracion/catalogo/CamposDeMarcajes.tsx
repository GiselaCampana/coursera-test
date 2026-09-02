'use client';

import {
  CAMPO_DEL_MARCAJE,
  MARCAJES_POR_MODALIDAD,
  REDONDEA_AL_100,
  type FuenteDeMarcajes,
  type Marcaje,
  type MarcajesEfectivos,
} from '@/lib/domain/marcajes';

/**
 * Los campos de marcaje de un nivel que no es el artículo: una familia o la
 * regla general.
 *
 * Van agrupados por modalidad de venta porque así se decide el negocio: los
 * cuatro precios de un producto al corte se piensan juntos, y los cuatro de un
 * feteable también. Mezclados en una lista de ocho, elegir cuál tocar es un
 * ejercicio de memoria.
 *
 * Ninguno viene con un número puesto de antemano. Vacío es "este nivel no dice
 * nada"; escribir un valor por omisión haría que guardar sin mirar fijara ese
 * número para todo lo que cuelga de acá.
 */

/** Cómo se llama cada forma de venta en la pantalla. */
const ETIQUETA: Record<Marcaje, string> = {
  alCorteHormaDigital: 'Horma digital',
  alCorteHormaCash: 'Horma efectivo',
  alCorteCajaCash: 'Caja efectivo',
  feteado100g: '100 g',
  feteadoQuarter: '1/4 kg',
  feteadoPieceDigital: 'Pieza digital',
  feteadoPieceCash: 'Pieza efectivo',
  wholeUnit: 'Unidad entera',
};

/** Una fracción guardada (0,45) como porcentaje para el campo (45). */
export function pct(valor: string | null | undefined): string {
  if (valor === null || valor === undefined || valor === '') return '';
  return String(Number(valor) * 100);
}

function Campo({
  prefijo,
  marcaje,
  propio,
  efectivo,
  hayBase,
}: {
  prefijo: string;
  marcaje: Marcaje;
  propio: string | null | undefined;
  efectivo: MarcajesEfectivos;
  hayBase: boolean;
}) {
  const campo = CAMPO_DEL_MARCAJE[marcaje];
  return (
    <div className="campo">
      <label htmlFor={`${marcaje}-${prefijo}`}>{ETIQUETA[marcaje]} (%)</label>
      <input
        id={`${marcaje}-${prefijo}`}
        name={campo}
        type="text"
        inputMode="decimal"
        defaultValue={pct(propio)}
        placeholder={hayBase ? `Vacío: ${pct(efectivo.especificos[marcaje].valor)} %` : 'Vacío'}
      />
      <p className="ayuda">
        {REDONDEA_AL_100[marcaje] ? 'Redondea al $100' : 'Importe exacto'}
      </p>
    </div>
  );
}

export function CamposDeMarcajes({
  prefijo,
  marcajes,
  efectivos,
  etiquetaBase,
  ayudaBase,
  baseObligatorio = false,
}: {
  /** Sufijo de los id, para que dos formularios en la misma página no choquen. */
  prefijo: string;
  marcajes: FuenteDeMarcajes;
  efectivos: MarcajesEfectivos;
  etiquetaBase: string;
  ayudaBase: string;
  /**
   * Sólo la regla general: es el piso de la cadena y no hereda de nadie, así
   * que su base no puede quedar vacío.
   */
  baseObligatorio?: boolean;
}) {
  const hayBase = Boolean(marcajes.targetMarginPct);
  const valor = (m: Marcaje) => marcajes[CAMPO_DEL_MARCAJE[m]] as string | null;

  return (
    <>
      <div className="campo">
        <label htmlFor={`base-${prefijo}`}>{etiquetaBase}</label>
        <input
          id={`base-${prefijo}`}
          name="targetMarginPct"
          type="text"
          inputMode="decimal"
          defaultValue={pct(marcajes.targetMarginPct)}
          placeholder={baseObligatorio ? 'Ej. 45' : 'Vacío: no dice nada'}
          required={baseObligatorio}
        />
        <p className="ayuda">{ayudaBase} Redondea al $100.</p>
      </div>

      <div className="campo">
        <label htmlFor={`basis-${prefijo}`}>Base del marcaje</label>
        <select
          id={`basis-${prefijo}`}
          name="marginBasis"
          defaultValue={marcajes.marginBasis ?? (baseObligatorio ? 'SOBRE_COSTO' : '')}
        >
          {baseObligatorio ? null : <option value="">Vacío: no dice nada</option>}
          <option value="SOBRE_COSTO">Sobre el costo</option>
          <option value="SOBRE_VENTA">Sobre la venta</option>
        </select>
      </div>

      <h4>Venta al corte</h4>
      <div className="fila fila-2">
        {MARCAJES_POR_MODALIDAD.AL_CORTE.map((m) => (
          <Campo
            key={m}
            prefijo={prefijo}
            marcaje={m}
            propio={valor(m)}
            efectivo={efectivos}
            hayBase={hayBase}
          />
        ))}
      </div>

      <h4>Venta feteada</h4>
      <div className="fila fila-2">
        {MARCAJES_POR_MODALIDAD.FETEABLE.map((m) => (
          <Campo
            key={m}
            prefijo={prefijo}
            marcaje={m}
            propio={valor(m)}
            efectivo={efectivos}
            hayBase={hayBase}
          />
        ))}
      </div>

      <h4>Venta por unidad</h4>
      <Campo
        prefijo={prefijo}
        marcaje="wholeUnit"
        propio={valor('wholeUnit')}
        efectivo={efectivos}
        hayBase={hayBase}
      />
    </>
  );
}
