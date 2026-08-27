'use client';

import { useActionState, useState } from 'react';
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

function pct(value: string | null | undefined, fallback: string): string {
  const raw = value ?? fallback;
  return (Number(raw) * 100).toString();
}

function CampoMarcaje({
  id,
  name,
  label,
  value,
  ayuda,
}: {
  id: string;
  name: string;
  label: string;
  value: string;
  ayuda?: string;
}) {
  return (
    <div className="campo">
      <label htmlFor={id}>{label}</label>
      <input id={id} name={name} type="text" inputMode="decimal" defaultValue={value} required />
      {ayuda ? <p className="ayuda">{ayuda}</p> : null}
    </div>
  );
}

export function ConfigurarPrecio({
  productId,
  nombre,
  targetMarginPct,
  marginBasis,
  roundingRule,
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
}: {
  productId: string;
  nombre: string;
  targetMarginPct: string;
  marginBasis: 'SOBRE_COSTO' | 'SOBRE_VENTA';
  roundingRule: string;
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
}) {
  const [abierto, setAbierto] = useState(false);
  const [unidad, setUnidad] = useState<'KG' | 'UNIT'>(purchaseUnit);
  const [modo, setModo] = useState<'FETEABLE' | 'AL_CORTE'>(saleMode);
  const [estado, accion] = useActionState<ResultadoConfigPrecio, FormData>(guardarConfigPrecio, {});

  if (estado.ok && estado.productId === productId && !abierto) {
    return <p className="mensaje mensaje-ok mt mb0" role="status">Configuración actualizada.</p>;
  }

  if (!abierto) {
    return (
      <div className="acciones">
        <button type="button" className="boton boton-secundario boton-chico" onClick={() => setAbierto(true)}>
          Configurar marcajes y venta
        </button>
      </div>
    );
  }

  const base = pct(targetMarginPct, targetMarginPct);

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
          value={base}
          ayuda="Este es el marcaje general del producto y también el valor por defecto de las modalidades que todavía no hayas personalizado."
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
              value={pct(alCorteHormaDigitalMarginPct, targetMarginPct)}
            />
            <CampoMarcaje
              id={`horma-ef-${productId}`}
              name="alCorteHormaCashMarginPct"
              label="Por kilo · horma efectivo (%)"
              value={pct(alCorteHormaCashMarginPct, targetMarginPct)}
            />
          </div>
          <CampoMarcaje
            id={`caja-ef-${productId}`}
            name="alCorteCajaCashMarginPct"
            label="Por kilo · horma por caja efectivo (%)"
            value={pct(alCorteCajaCashMarginPct, targetMarginPct)}
          />
          <input type="hidden" name="feteado100gMarginPct" value={pct(feteado100gMarginPct, targetMarginPct)} />
          <input type="hidden" name="feteadoQuarterMarginPct" value={pct(feteadoQuarterMarginPct, targetMarginPct)} />
          <input type="hidden" name="feteadoPieceDigitalMarginPct" value={pct(feteadoPieceDigitalMarginPct, targetMarginPct)} />
          <input type="hidden" name="feteadoPieceCashMarginPct" value={pct(feteadoPieceCashMarginPct, targetMarginPct)} />
        </>
      ) : (
        <>
          <h4>Marcajes · productos feteables</h4>
          <div className="fila fila-2">
            <CampoMarcaje
              id={`100g-${productId}`}
              name="feteado100gMarginPct"
              label="Venta por 100 g · precio/kg (%)"
              value={pct(feteado100gMarginPct, targetMarginPct)}
            />
            <CampoMarcaje
              id={`cuarto-${productId}`}
              name="feteadoQuarterMarginPct"
              label="Venta por 1/4 kg · precio/kg (%)"
              value={pct(feteadoQuarterMarginPct, targetMarginPct)}
            />
          </div>
          <div className="fila fila-2">
            <CampoMarcaje
              id={`pieza-dig-${productId}`}
              name="feteadoPieceDigitalMarginPct"
              label="Pieza entera digital · precio/kg (%)"
              value={pct(feteadoPieceDigitalMarginPct, targetMarginPct)}
            />
            <CampoMarcaje
              id={`pieza-ef-${productId}`}
              name="feteadoPieceCashMarginPct"
              label="Pieza entera efectivo · precio/kg (%)"
              value={pct(feteadoPieceCashMarginPct, targetMarginPct)}
            />
          </div>
          <input type="hidden" name="alCorteHormaDigitalMarginPct" value={pct(alCorteHormaDigitalMarginPct, targetMarginPct)} />
          <input type="hidden" name="alCorteHormaCashMarginPct" value={pct(alCorteHormaCashMarginPct, targetMarginPct)} />
          <input type="hidden" name="alCorteCajaCashMarginPct" value={pct(alCorteCajaCashMarginPct, targetMarginPct)} />
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
            value={pct(wholeUnitMarginPct, targetMarginPct)}
          />
        </>
      ) : (
        <>
          <input type="hidden" name="purchaseUnitWeightKg" value="" />
          <input type="hidden" name="wholeUnitMarginPct" value={pct(wholeUnitMarginPct, targetMarginPct)} />
        </>
      )}

      <div className="campo">
        <label htmlFor={`redondeo-${productId}`}>Redondeo</label>
        <select id={`redondeo-${productId}`} name="roundingRule" defaultValue={roundingRule}>
          <option value="NONE">Sin redondeo</option>
          <option value="NEAREST_10">Al $10 más cercano</option>
          <option value="NEAREST_50">Al $50 más cercano</option>
          <option value="NEAREST_100">Al $100 más cercano</option>
          <option value="UP_10">Hacia arriba al $10</option>
          <option value="UP_50">Hacia arriba al $50</option>
          <option value="UP_100">Hacia arriba al $100</option>
        </select>
      </div>

      <div className="acciones">
        <button type="button" className="boton boton-secundario boton-chico" onClick={() => setAbierto(false)}>
          Cancelar
        </button>
        <Guardar />
      </div>
    </form>
  );
}
