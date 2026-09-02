'use client';

import { useActionState, useEffect, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { guardarConfigPrecio, type ResultadoConfigPrecio } from './acciones';

function Guardar() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="boton boton-chico" disabled={pending}>
      {pending ? 'Guardando…' : 'Guardar configuración'}
    </button>
  );
}

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
  ayuda,
}: {
  id: string;
  name: string;
  label: string;
  propio: string | null | undefined;
  efectivo: string;
  origen: string;
  ayuda?: string;
}) {
  return (
    <div className="campo">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={name}
        type="text"
        inputMode="decimal"
        defaultValue={pct(propio)}
        placeholder={pct(efectivo)}
      />
      <p className="ayuda">
        {propio ? null : `Vacío: usa ${pct(efectivo)} %, ${origen}. `}
        {ayuda ?? ''}
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
  alCorteHormaDigitalMarginPct: string | null;
  alCorteHormaCashMarginPct: string | null;
  alCorteCajaCashMarginPct: string | null;
  feteado100gMarginPct: string | null;
  feteadoQuarterMarginPct: string | null;
  feteadoPieceDigitalMarginPct: string | null;
  feteadoPieceCashMarginPct: string | null;
  wholeUnitMarginPct: string | null;
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

      <div className="fila fila-2">
        <CampoMarcaje
          id={`marcaje-base-${productId}`}
          name="targetMarginPct"
          label="Marcaje base por kilo (%)"
          propio={propios.targetMarginPct}
          efectivo={targetMarginPct}
          origen={origenes.targetMarginPct}
          ayuda="Es el marcaje general del artículo y el que usan las modalidades que no tengan uno propio."
        />
        <div className="campo">
          <label htmlFor={`base-${productId}`}>Cómo calcular los marcajes</label>
          <select id={`base-${productId}`} name="marginBasis" defaultValue={marginBasis}>
            <option value="SOBRE_COSTO">Sobre costo</option>
            <option value="SOBRE_VENTA">Sobre precio de venta</option>
          </select>
        </div>
      </div>

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

      {modo === 'AL_CORTE' ? (
        <>
          <h4>Marcajes · productos al corte</h4>
          <div className="fila fila-2">
            <CampoMarcaje
              id={`horma-dig-${productId}`}
              name="alCorteHormaDigitalMarginPct"
              label="Por kilo · horma digital (%)"
              propio={propios.alCorteHormaDigitalMarginPct}
              efectivo={alCorteHormaDigitalMarginPct ?? "0"}
              origen={origenes.alCorteHormaDigitalMarginPct}
            />
            <CampoMarcaje
              id={`horma-ef-${productId}`}
              name="alCorteHormaCashMarginPct"
              label="Por kilo · horma efectivo (%)"
              propio={propios.alCorteHormaCashMarginPct}
              efectivo={alCorteHormaCashMarginPct ?? "0"}
              origen={origenes.alCorteHormaCashMarginPct}
            />
          </div>
          <CampoMarcaje
            id={`caja-ef-${productId}`}
            name="alCorteCajaCashMarginPct"
            label="Por kilo · horma por caja efectivo (%)"
            propio={propios.alCorteCajaCashMarginPct}
              efectivo={alCorteCajaCashMarginPct ?? "0"}
              origen={origenes.alCorteCajaCashMarginPct}
          />
          <input type="hidden" name="feteado100gMarginPct" value={pct(propios.feteado100gMarginPct)} />
          <input type="hidden" name="feteadoQuarterMarginPct" value={pct(propios.feteadoQuarterMarginPct)} />
          <input type="hidden" name="feteadoPieceDigitalMarginPct" value={pct(propios.feteadoPieceDigitalMarginPct)} />
          <input type="hidden" name="feteadoPieceCashMarginPct" value={pct(propios.feteadoPieceCashMarginPct)} />
        </>
      ) : (
        <>
          <h4>Marcajes · productos feteables</h4>
          <div className="fila fila-2">
            <CampoMarcaje
              id={`100g-${productId}`}
              name="feteado100gMarginPct"
              label="Venta por 100 g · precio/kg (%)"
              propio={propios.feteado100gMarginPct}
              efectivo={feteado100gMarginPct ?? "0"}
              origen={origenes.feteado100gMarginPct}
            />
            <CampoMarcaje
              id={`cuarto-${productId}`}
              name="feteadoQuarterMarginPct"
              label="Venta por 1/4 kg · precio/kg (%)"
              propio={propios.feteadoQuarterMarginPct}
              efectivo={feteadoQuarterMarginPct ?? "0"}
              origen={origenes.feteadoQuarterMarginPct}
            />
          </div>
          <div className="fila fila-2">
            <CampoMarcaje
              id={`pieza-dig-${productId}`}
              name="feteadoPieceDigitalMarginPct"
              label="Pieza entera digital · precio/kg (%)"
              propio={propios.feteadoPieceDigitalMarginPct}
              efectivo={feteadoPieceDigitalMarginPct ?? "0"}
              origen={origenes.feteadoPieceDigitalMarginPct}
            />
            <CampoMarcaje
              id={`pieza-ef-${productId}`}
              name="feteadoPieceCashMarginPct"
              label="Pieza entera efectivo · precio/kg (%)"
              propio={propios.feteadoPieceCashMarginPct}
              efectivo={feteadoPieceCashMarginPct ?? "0"}
              origen={origenes.feteadoPieceCashMarginPct}
            />
          </div>
          <input type="hidden" name="alCorteHormaDigitalMarginPct" value={pct(propios.alCorteHormaDigitalMarginPct)} />
          <input type="hidden" name="alCorteHormaCashMarginPct" value={pct(propios.alCorteHormaCashMarginPct)} />
          <input type="hidden" name="alCorteCajaCashMarginPct" value={pct(propios.alCorteCajaCashMarginPct)} />
        </>
      )}

      {unidad === 'UNIT' ? (
        <>
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
            label="Marcaje de lata/cajón/unidad entera (%)"
            propio={propios.wholeUnitMarginPct}
              efectivo={wholeUnitMarginPct ?? "0"}
              origen={origenes.wholeUnitMarginPct}
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
        Redondeo fijo: al $100 más cercano sólo para el precio por kilo de los productos al corte
        y para los precios por 100 g / 1/4 kg de los feteables. Horma, caja y pieza quedan con el
        importe exacto que da su marcaje.
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
