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

export function ConfigurarPrecio({
  productId,
  nombre,
  targetMarginPct,
  marginBasis,
  cashDiscountPct,
  roundingRule,
  saleMode,
  purchaseUnit,
  purchaseUnitWeightKg,
}: {
  productId: string;
  nombre: string;
  targetMarginPct: string;
  marginBasis: 'SOBRE_COSTO' | 'SOBRE_VENTA';
  cashDiscountPct: string;
  roundingRule: string;
  saleMode: 'FETEABLE' | 'AL_CORTE';
  purchaseUnit: 'KG' | 'UNIT';
  purchaseUnitWeightKg: string | null;
}) {
  const [abierto, setAbierto] = useState(false);
  const [unidad, setUnidad] = useState<'KG' | 'UNIT'>(purchaseUnit);
  const [estado, accion] = useActionState<ResultadoConfigPrecio, FormData>(guardarConfigPrecio, {});

  if (estado.ok && estado.productId === productId && !abierto) {
    return (
      <p className="mensaje mensaje-ok mt mb0" role="status">
        Configuración actualizada.
      </p>
    );
  }

  if (!abierto) {
    return (
      <div className="acciones">
        <button
          type="button"
          className="boton boton-secundario boton-chico"
          onClick={() => setAbierto(true)}
        >
          Configurar marcaje y venta
        </button>
      </div>
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
        <div className="campo">
          <label htmlFor={`marcaje-${productId}`}>Marcaje (%)</label>
          <input
            id={`marcaje-${productId}`}
            name="targetMarginPct"
            type="text"
            inputMode="decimal"
            defaultValue={(Number(targetMarginPct) * 100).toString()}
            required
          />
          <p className="ayuda">Lo elegís vos. Ej.: 45 = 45 %.</p>
        </div>
        <div className="campo">
          <label htmlFor={`base-${productId}`}>Cómo calcular el marcaje</label>
          <select id={`base-${productId}`} name="marginBasis" defaultValue={marginBasis}>
            <option value="SOBRE_COSTO">Sobre costo</option>
            <option value="SOBRE_VENTA">Sobre precio de venta</option>
          </select>
        </div>
      </div>

      <div className="fila fila-2">
        <div className="campo">
          <label htmlFor={`modo-${productId}`}>Modo de venta</label>
          <select id={`modo-${productId}`} name="saleMode" defaultValue={saleMode}>
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

      {unidad === 'UNIT' ? (
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
            Ej.: lata/cajón de dulce 5 kg; postre de maní 3 kg. El sistema divide el costo de la unidad por esos kilos.
          </p>
        </div>
      ) : (
        <input type="hidden" name="purchaseUnitWeightKg" value="" />
      )}

      <div className="fila fila-2">
        <div className="campo">
          <label htmlFor={`efectivo-${productId}`}>Descuento en efectivo (%)</label>
          <input
            id={`efectivo-${productId}`}
            name="cashDiscountPct"
            type="text"
            inputMode="decimal"
            defaultValue={(Number(cashDiscountPct) * 100).toString()}
          />
        </div>
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
