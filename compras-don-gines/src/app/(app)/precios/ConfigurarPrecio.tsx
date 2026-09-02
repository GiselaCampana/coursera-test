'use client';

import { useActionState, useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { REDONDEA_AL_100 } from '@/lib/domain/marcajes';
import { guardarConfigPrecio, type ResultadoConfigPrecio } from './acciones';

function Guardar() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="boton boton-chico" disabled={pending}>
      {pending ? 'Guardando…' : 'Guardar configuración'}
    </button>
  );
}

const BASE_LABEL: Record<'SOBRE_COSTO' | 'SOBRE_VENTA', string> = {
  SOBRE_COSTO: 'sobre costo',
  SOBRE_VENTA: 'sobre precio de venta',
};

/** Una fracción guardada (0,45) como porcentaje para el campo (45). */
function pct(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  return (Number(value) * 100).toString();
}

/**
 * Qué se ve en un campo de marcaje que el artículo no define.
 *
 * Vacío, con el heredado de fondo como sugerencia. Antes se escribía el valor
 * heredado dentro del campo, y eso tenía una consecuencia que no se veía: al
 * guardar, ese número quedaba grabado **en el artículo**, que dejaba de seguir
 * a su familia por el solo hecho de que alguien abrió la pantalla y apretó
 * guardar. Vacío significa heredar, y guardar vacío lo mantiene heredando.
 */
function CampoMarcaje({
  id,
  name,
  label,
  propio,
  efectivo,
  origen,
  redondeo,
  ayuda,
}: {
  id: string;
  name: string;
  label: string;
  propio: string | null | undefined;
  efectivo: string;
  origen: string;
  /** Si el precio que sale de este marcaje va al $100 o queda exacto. */
  redondeo?: boolean;
  ayuda?: string;
}) {
  /*
   * Los tres datos, siempre los tres: el valor propio editable, el efectivo y
   * de dónde sale.
   *
   * También cuando el artículo tiene el suyo. Sin decirlo, "45 %" en un campo
   * no distingue el que alguien eligió para este artículo del que le llega de
   * la familia, y son cosas que se comportan distinto: al cambiar el de la
   * familia uno se mueve y el otro no.
   */
  const propioCargado = propio !== null && propio !== undefined && propio !== '';
  return (
    <div className="campo">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={name}
        type="text"
        inputMode="decimal"
        defaultValue={pct(propio)}
        placeholder={`Vacío: ${pct(efectivo)} %`}
      />
      <p className="ayuda">
        <strong>{pct(efectivo)} %</strong> · {origen}
        {propioCargado ? null : ' · vaciar mantiene la herencia'}
        {redondeo === undefined ? null : redondeo ? ' · redondea al $100' : ' · importe exacto'}
        {ayuda ? ` · ${ayuda}` : ''}
      </p>
    </div>
  );
}

export function ConfigurarPrecio({
  productId,
  nombre,
  targetMarginPct,
  marginBasis,
  saleMode,
  purchaseUnit,
  purchaseUnitWeightKg,
  alCorteHormaDigitalMarginPct,
  alCorteHormaCashMarginPct,
  alCorteCajaCashMarginPct,
  feteado100gMarginPct,
  feteadoQuarterMarginPct,
  feteadoPieceDigitalMarginPct,
  feteadoPieceCashMarginPct,
  wholeUnitMarginPct,
  propios,
  origenes,
  familia,
}: {
  productId: string;
  nombre: string;
  targetMarginPct: string;
  marginBasis: 'SOBRE_COSTO' | 'SOBRE_VENTA';
  saleMode: 'FETEABLE' | 'AL_CORTE';
  purchaseUnit: 'KG' | 'UNIT';
  purchaseUnitWeightKg: string | null;
  alCorteHormaDigitalMarginPct: string;
  alCorteHormaCashMarginPct: string;
  alCorteCajaCashMarginPct: string;
  feteado100gMarginPct: string;
  feteadoQuarterMarginPct: string;
  feteadoPieceDigitalMarginPct: string;
  feteadoPieceCashMarginPct: string;
  wholeUnitMarginPct: string;
  /** Lo que el artículo tiene guardado. Null donde hereda. */
  propios: Record<string, string | null | undefined>;
  /** De dónde sale cada marcaje efectivo, en castellano. */
  origenes: Record<string, string>;
  familia: { id: string; nombre: string } | null;
}) {
  const [abierto, setAbierto] = useState(false);
  const [unidad, setUnidad] = useState<'KG' | 'UNIT'>(purchaseUnit);
  const [modo, setModo] = useState<'FETEABLE' | 'AL_CORTE'>(saleMode);
  const [estado, accion] = useActionState<ResultadoConfigPrecio, FormData>(guardarConfigPrecio, {});

  // Estos estados son controles editables. Si el servidor refresca el producto
  // después de guardar/importar, tienen que acompañar los valores nuevos y no
  // quedarse con el valor que tenían cuando se montó la tarjeta.
  useEffect(() => setModo(saleMode), [saleMode]);
  useEffect(() => setUnidad(purchaseUnit), [purchaseUnit]);

  // Al guardar correctamente cerramos el formulario. Así, al volver a abrirlo
  // se muestran los valores efectivamente persistidos y no el reset del form.
  useEffect(() => {
    if (estado.ok && estado.productId === productId) setAbierto(false);
  }, [estado.ok, estado.productId, productId]);

  if (!abierto) {
    return (
      <>
        {estado.ok && estado.productId === productId ? (
          <p className="mensaje mensaje-ok mt mb0" role="status">Configuración actualizada.</p>
        ) : null}
        <div className="acciones">
          <button type="button" className="boton boton-secundario boton-chico" onClick={() => setAbierto(true)}>
            Configurar marcajes y venta
          </button>
        </div>
      </>
    );
  }

  return (
    <form action={accion} className="mt">
      <input type="hidden" name="productId" value={productId} />
      {estado.error && estado.productId === productId ? (
        <p className="mensaje mensaje-error" role="alert">{estado.error}</p>
      ) : null}

      <h3>{nombre}</h3>

      {/*
        La cadena, dicha una vez arriba de todo: cada campo repite después de
        dónde sale el suyo. Sin esto, "heredado de la familia" en un campo
        suelto no dice de qué familia ni qué pasa si se vacía.
      */}
      <p className="mensaje mensaje-info">
        Cada marcaje se resuelve en este orden: <strong>este artículo</strong> →{' '}
        {familia ? <strong>familia {familia.nombre}</strong> : 'su familia (no tiene)'} →{' '}
        <strong>regla general</strong>. Lo que dejes vacío se hereda; escribir 0 es vender al
        costo.
      </p>

      <div className="fila fila-2">
        <div className="campo">
          <label htmlFor={`modo-${productId}`}>Modo de venta</label>
          <select
            id={`modo-${productId}`}
            name="saleMode"
            value={modo}
            onChange={(e) => setModo(e.target.value as 'FETEABLE' | 'AL_CORTE')}
          >
            <option value="FETEABLE">Feteable</option>
            <option value="AL_CORTE">Al corte</option>
          </select>
        </div>
        <div className="campo">
          <label htmlFor={`unidad-${productId}`}>Cómo lo compra Don Ginés</label>
          <select
            id={`unidad-${productId}`}
            name="purchaseUnit"
            value={unidad}
            onChange={(e) => setUnidad(e.target.value as 'KG' | 'UNIT')}
          >
            <option value="KG">Por kilo</option>
            <option value="UNIT">Por unidad</option>
          </select>
        </div>
      </div>

      {/*
        La base del marcaje sigue la misma cadena que los marcajes, así que
        también puede quedar vacía. Si acá siempre se eligiera un valor, abrir
        y guardar el artículo se lo grabaría encima y dejaría de seguir a su
        familia sin que nadie lo pidiera.
      */}
      <div className="campo">
        <label htmlFor={`base-${productId}`}>Cómo calcular los marcajes</label>
        <select
          id={`base-${productId}`}
          name="marginBasis"
          defaultValue={propios.marginBasis ?? ''}
        >
          <option value="">Vacío: {BASE_LABEL[marginBasis]}, heredado</option>
          <option value="SOBRE_COSTO">Sobre costo</option>
          <option value="SOBRE_VENTA">Sobre precio de venta</option>
        </select>
        <p className="ayuda">
          <strong>{BASE_LABEL[marginBasis]}</strong> · {origenes.marginBasis}
        </p>
      </div>

      {/*
        Los marcajes agrupados por modalidad de venta.
        Cada campo es independiente: cambiar el de horma no toca el de kilo, y
        cambiar el de pieza no toca el de 100 g ni el de 1/4. La modalidad que
        no se está editando viaja en campos ocultos con **su propio valor**
        —vacío si estaba vacío—, para que abrir y guardar no materialice nada.
      */}
      {modo === 'AL_CORTE' ? (
        <>
          <h4>Marcajes · venta al corte</h4>
          <div className="fila fila-2">
            <CampoMarcaje
              id={`marcaje-base-${productId}`}
              name="targetMarginPct"
              label="Por kilo (%)"
              propio={propios.targetMarginPct}
              efectivo={targetMarginPct}
              origen={origenes.targetMarginPct}
              redondeo={REDONDEA_AL_100.kilo}
              ayuda="Es además el marcaje base: lo usan las formas de venta que quedan vacías."
            />
            <CampoMarcaje
              id={`horma-dig-${productId}`}
              name="alCorteHormaDigitalMarginPct"
              label="Horma digital (%)"
              propio={propios.alCorteHormaDigitalMarginPct}
              efectivo={alCorteHormaDigitalMarginPct}
              origen={origenes.alCorteHormaDigitalMarginPct}
              redondeo={REDONDEA_AL_100.alCorteHormaDigital}
            />
          </div>
          <div className="fila fila-2">
            <CampoMarcaje
              id={`horma-ef-${productId}`}
              name="alCorteHormaCashMarginPct"
              label="Horma efectivo (%)"
              propio={propios.alCorteHormaCashMarginPct}
              efectivo={alCorteHormaCashMarginPct}
              origen={origenes.alCorteHormaCashMarginPct}
              redondeo={REDONDEA_AL_100.alCorteHormaCash}
            />
            <CampoMarcaje
              id={`caja-ef-${productId}`}
              name="alCorteCajaCashMarginPct"
              label="Caja efectivo (%)"
              propio={propios.alCorteCajaCashMarginPct}
              efectivo={alCorteCajaCashMarginPct}
              origen={origenes.alCorteCajaCashMarginPct}
              redondeo={REDONDEA_AL_100.alCorteCajaCash}
            />
          </div>
          <input type="hidden" name="feteado100gMarginPct" value={pct(propios.feteado100gMarginPct)} />
          <input type="hidden" name="feteadoQuarterMarginPct" value={pct(propios.feteadoQuarterMarginPct)} />
          <input type="hidden" name="feteadoPieceDigitalMarginPct" value={pct(propios.feteadoPieceDigitalMarginPct)} />
          <input type="hidden" name="feteadoPieceCashMarginPct" value={pct(propios.feteadoPieceCashMarginPct)} />
        </>
      ) : (
        <>
          <h4>Marcajes · venta feteada</h4>
          <div className="fila fila-2">
            <CampoMarcaje
              id={`100g-${productId}`}
              name="feteado100gMarginPct"
              label="100 g (%)"
              propio={propios.feteado100gMarginPct}
              efectivo={feteado100gMarginPct}
              origen={origenes.feteado100gMarginPct}
              redondeo={REDONDEA_AL_100.feteado100g}
            />
            <CampoMarcaje
              id={`cuarto-${productId}`}
              name="feteadoQuarterMarginPct"
              label="1/4 kg (%)"
              propio={propios.feteadoQuarterMarginPct}
              efectivo={feteadoQuarterMarginPct}
              origen={origenes.feteadoQuarterMarginPct}
              redondeo={REDONDEA_AL_100.feteadoQuarter}
            />
          </div>
          <div className="fila fila-2">
            <CampoMarcaje
              id={`pieza-dig-${productId}`}
              name="feteadoPieceDigitalMarginPct"
              label="Pieza digital (%)"
              propio={propios.feteadoPieceDigitalMarginPct}
              efectivo={feteadoPieceDigitalMarginPct}
              origen={origenes.feteadoPieceDigitalMarginPct}
              redondeo={REDONDEA_AL_100.feteadoPieceDigital}
            />
            <CampoMarcaje
              id={`pieza-ef-${productId}`}
              name="feteadoPieceCashMarginPct"
              label="Pieza efectivo (%)"
              propio={propios.feteadoPieceCashMarginPct}
              efectivo={feteadoPieceCashMarginPct}
              origen={origenes.feteadoPieceCashMarginPct}
              redondeo={REDONDEA_AL_100.feteadoPieceCash}
            />
          </div>
          <CampoMarcaje
            id={`marcaje-base-${productId}`}
            name="targetMarginPct"
            label="Por kilo · marcaje base (%)"
            propio={propios.targetMarginPct}
            efectivo={targetMarginPct}
            origen={origenes.targetMarginPct}
            redondeo={REDONDEA_AL_100.kilo}
            ayuda="Lo usan las formas de venta que quedan vacías."
          />
          <input type="hidden" name="alCorteHormaDigitalMarginPct" value={pct(propios.alCorteHormaDigitalMarginPct)} />
          <input type="hidden" name="alCorteHormaCashMarginPct" value={pct(propios.alCorteHormaCashMarginPct)} />
          <input type="hidden" name="alCorteCajaCashMarginPct" value={pct(propios.alCorteCajaCashMarginPct)} />
        </>
      )}

      {unidad === 'UNIT' ? (
        <>
          <h4>Marcajes · venta por unidad</h4>
          <div className="campo">
            <label htmlFor={`peso-compra-${productId}`}>Kilos que trae cada unidad comprada</label>
            <input
              id={`peso-compra-${productId}`}
              name="purchaseUnitWeightKg"
              type="text"
              inputMode="decimal"
              defaultValue={purchaseUnitWeightKg ?? ''}
              placeholder="Ej. 5"
            />
            <p className="ayuda">
              Ej.: dulce de lata/cajón 5 kg; postre de maní 3 kg. El costo unitario se convierte automáticamente a costo por kilo.
            </p>
          </div>
          <CampoMarcaje
            id={`unidad-entera-${productId}`}
            name="wholeUnitMarginPct"
            label="Unidad entera · lata/cajón (%)"
            propio={propios.wholeUnitMarginPct}
            efectivo={wholeUnitMarginPct}
            origen={origenes.wholeUnitMarginPct}
            redondeo={REDONDEA_AL_100.wholeUnit}
            ayuda="Se cobra el importe que da este marcaje, sin redondear."
          />
        </>
      ) : (
        <>
          <input type="hidden" name="purchaseUnitWeightKg" value="" />
          <input type="hidden" name="wholeUnitMarginPct" value={pct(propios.wholeUnitMarginPct)} />
        </>
      )}

      <input type="hidden" name="roundingRule" value="NEAREST_100" />
      <p className="ayuda">
        Redondeo fijo, no configurable: por kilo, 100 g y 1/4 kg van al $100 más cercano. Horma,
        caja, pieza y unidad entera quedan con el importe exacto que da su marcaje.
      </p>

      <div className="acciones">
        <button type="button" className="boton boton-secundario boton-chico" onClick={() => setAbierto(false)}>
          Cancelar
        </button>
        <Guardar />
      </div>
    </form>
  );
}
