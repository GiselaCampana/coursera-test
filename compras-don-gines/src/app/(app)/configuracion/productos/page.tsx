import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireUser, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import { formatQty, formatRate } from '@/lib/money';
import {
  MARGIN_BASIS_LABEL,
  ROUNDING_RULES,
  ROUNDING_RULE_LABEL,
  SALE_MODE_LABEL,
  type RoundingRule,
} from '@/lib/domain/pricing';
import { FormularioConfig, Casilla } from '@/components/FormularioConfig';
import { guardarProducto } from '../acciones';

export const metadata: Metadata = { title: 'Productos' };
export const dynamic = 'force-dynamic';

export default async function PaginaProductos() {
  const user = await requireUser();
  if (!hasPermission(user, PERMISSIONS.PRODUCTOS_GESTIONAR)) redirect('/configuracion');

  const [productos, proveedores] = await Promise.all([
    prisma.product.findMany({
      orderBy: [{ active: 'desc' }, { category: 'asc' }, { normalizedName: 'asc' }],
      include: { aliases: true, defaultSupplier: true },
    }),
    prisma.supplier.findMany({ where: { active: true }, orderBy: { tradeName: 'asc' } }),
  ]);

  const campos = (prefijo: string, p?: (typeof productos)[number]) => (
    <>
      <div className="fila fila-2">
        <div className="campo">
          <label htmlFor={`${prefijo}-code`}>Código interno o PLU</label>
          <input
            id={`${prefijo}-code`}
            name="internalCode"
            type="text"
            defaultValue={p?.internalCode ?? ''}
            required
          />
        </div>
        <div className="campo">
          <label htmlFor={`${prefijo}-name`}>Nombre normalizado</label>
          <input
            id={`${prefijo}-name`}
            name="normalizedName"
            type="text"
            defaultValue={p?.normalizedName ?? ''}
            required
          />
        </div>
      </div>

      <div className="fila fila-2">
        <div className="campo">
          <label htmlFor={`${prefijo}-cat`}>Categoría</label>
          <input
            id={`${prefijo}-cat`}
            name="category"
            type="text"
            defaultValue={p?.category ?? ''}
          />
        </div>
        <div className="campo">
          <label htmlFor={`${prefijo}-sup`}>Proveedor habitual</label>
          <select
            id={`${prefijo}-sup`}
            name="defaultSupplierId"
            defaultValue={p?.defaultSupplierId ?? ''}
          >
            <option value="">Sin proveedor habitual</option>
            {proveedores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.tradeName}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="fila fila-3">
        <div className="campo">
          <label htmlFor={`${prefijo}-unit`}>Unidad de compra</label>
          <select
            id={`${prefijo}-unit`}
            name="purchaseUnit"
            defaultValue={p?.purchaseUnit ?? 'KG'}
          >
            <option value="KG">Kilos</option>
            <option value="UNIT">Unidades</option>
          </select>
        </div>
        <div className="campo">
          <label htmlFor={`${prefijo}-mode`}>Modo de venta</label>
          <select id={`${prefijo}-mode`} name="saleMode" defaultValue={p?.saleMode ?? 'FETEABLE'}>
            <option value="FETEABLE">Feteable</option>
            <option value="AL_CORTE">Al corte</option>
          </select>
        </div>
        <div className="campo">
          <label htmlFor={`${prefijo}-piece`}>Peso de pieza u horma (kg)</label>
          <input
            id={`${prefijo}-piece`}
            name="avgPieceWeightKg"
            type="text"
            inputMode="decimal"
            defaultValue={p?.avgPieceWeightKg?.toString() ?? ''}
          />
        </div>
      </div>

      <div className="fila fila-3">
        <div className="campo">
          <label htmlFor={`${prefijo}-margin`}>Margen objetivo (%)</label>
          <input
            id={`${prefijo}-margin`}
            name="targetMarginPct"
            type="text"
            inputMode="decimal"
            defaultValue={p ? Number(p.targetMarginPct) * 100 : '45'}
            required
          />
        </div>
        <div className="campo">
          <label htmlFor={`${prefijo}-basis`}>Base del margen</label>
          <select
            id={`${prefijo}-basis`}
            name="marginBasis"
            defaultValue={p?.marginBasis ?? 'SOBRE_COSTO'}
          >
            <option value="SOBRE_COSTO">Sobre el costo · precio = costo × (1 + margen)</option>
            <option value="SOBRE_VENTA">Sobre la venta · precio = costo / (1 − margen)</option>
          </select>
        </div>
        <div className="campo">
          <label htmlFor={`${prefijo}-cash`}>Descuento por efectivo (%)</label>
          <input
            id={`${prefijo}-cash`}
            name="cashDiscountPct"
            type="text"
            inputMode="decimal"
            defaultValue={p ? Number(p.cashDiscountPct) * 100 : '10'}
          />
        </div>
      </div>

      <div className="campo">
        <label htmlFor={`${prefijo}-round`}>Regla de redondeo</label>
        <select
          id={`${prefijo}-round`}
          name="roundingRule"
          defaultValue={p?.roundingRule ?? 'NEAREST_100'}
        >
          {ROUNDING_RULES.map((regla) => (
            <option key={regla} value={regla}>
              {ROUNDING_RULE_LABEL[regla]}
            </option>
          ))}
        </select>
      </div>

      <div className="campo">
        <label htmlFor={`${prefijo}-alias`}>Alias nuevos (uno por línea)</label>
        <textarea
          id={`${prefijo}-alias`}
          name="aliases"
          placeholder="Cómo escribe el proveedor este producto en la factura"
        />
      </div>

      <Casilla name="active" etiqueta="Activo" defecto={p?.active ?? true} />
    </>
  );

  return (
    <>
      <h1>Productos y alias</h1>
      <p className="medio">
        Cada producto define cómo se compra, cómo se vende y con qué margen, descuento por efectivo
        y redondeo se forma su precio.
      </p>

      <div className="card">
        <FormularioConfig
          titulo="Nuevo producto"
          textoBoton="Agregar un producto"
          accion={guardarProducto}
        >
          {campos('nuevo')}
        </FormularioConfig>
      </div>

      <ul className="lista">
        {productos.map((producto) => (
          <li key={producto.id} className="fila-dato">
            <div className="fila-dato-cabecera">
              <span className="fila-dato-titulo">{producto.normalizedName}</span>
              <span className="etiqueta-estado estado-neutro">{producto.internalCode}</span>
            </div>
            <div className="fila-dato-meta">
              {producto.category ? <span>{producto.category}</span> : null}
              <span>{SALE_MODE_LABEL[producto.saleMode]}</span>
              <span>
                {MARGIN_BASIS_LABEL[producto.marginBasis]}:{' '}
                {formatRate(producto.targetMarginPct.toString())}
              </span>
              <span>
                Efectivo −{formatRate(producto.cashDiscountPct.toString())}
              </span>
              <span>{ROUNDING_RULE_LABEL[producto.roundingRule as RoundingRule]}</span>
              {producto.avgPieceWeightKg ? (
                <span>Pieza {formatQty(producto.avgPieceWeightKg.toString(), 3)} kg</span>
              ) : null}
              {producto.defaultSupplier ? <span>{producto.defaultSupplier.tradeName}</span> : null}
              {!producto.active ? <span>Inactivo</span> : null}
            </div>
            {producto.aliases.length > 0 ? (
              <p className="chico medio mb0">
                Alias: {producto.aliases.map((a) => a.alias).join(' · ')}
              </p>
            ) : null}

            <FormularioConfig
              titulo={`Editar ${producto.normalizedName}`}
              textoBoton="Editar"
              accion={guardarProducto}
            >
              <input type="hidden" name="id" value={producto.id} />
              {campos(producto.id, producto)}
            </FormularioConfig>
          </li>
        ))}
      </ul>
    </>
  );
}
