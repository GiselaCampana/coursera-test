import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireUserOrRedirect, hasPermission } from '@/lib/auth/session';
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
import { guardarCodigoDeProveedor, guardarProducto, quitarCodigoDeProveedor } from '../acciones';

export const metadata: Metadata = { title: 'Productos' };
export const dynamic = 'force-dynamic';

export default async function PaginaProductos({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const user = await requireUserOrRedirect();
  if (!hasPermission(user, PERMISSIONS.PRODUCTOS_GESTIONAR)) redirect('/configuracion');

  const { q } = await searchParams;
  const busqueda = (q ?? '').trim();

  /*
   * Se busca por PLU, por nombre y por el código de cualquier proveedor.
   *
   * Los tres hacen falta y por razones distintas: el PLU es con el que se vende,
   * el nombre es con el que uno lo llama, y el código del proveedor es lo que
   * está impreso en la factura que se tiene en la mano. Poder entrar por el
   * código es lo que permite responder "¿qué es el ART-00228?" sin buscar a ojo.
   */
  const filtro = busqueda
    ? {
        OR: [
          { internalCode: { contains: busqueda, mode: 'insensitive' as const } },
          { barcode: { contains: busqueda, mode: 'insensitive' as const } },
          { normalizedName: { contains: busqueda, mode: 'insensitive' as const } },
          {
            aliases: {
              some: {
                OR: [
                  { supplierCode: { contains: busqueda, mode: 'insensitive' as const } },
                  { alias: { contains: busqueda, mode: 'insensitive' as const } },
                ],
              },
            },
          },
        ],
      }
    : {};

  const [productos, proveedores] = await Promise.all([
    prisma.product.findMany({
      where: filtro,
      orderBy: [{ active: 'desc' }, { category: 'asc' }, { normalizedName: 'asc' }],
      include: {
        aliases: { include: { supplier: { select: { tradeName: true } } } },
        defaultSupplier: true,
      },
    }),
    prisma.supplier.findMany({ where: { active: true }, orderBy: { tradeName: 'asc' } }),
  ]);

  const campos = (prefijo: string, p?: (typeof productos)[number]) => (
    <>
      <div className="fila fila-2">
        <div className="campo">
          <label htmlFor={`${prefijo}-code`}>PLU</label>
          <input
            id={`${prefijo}-code`}
            name="internalCode"
            type="text"
            defaultValue={p?.usesPlu === false ? '' : p?.internalCode ?? ''}
            placeholder="Ej. 1211"
          />
          <p className="ayuda">Si el artículo no usa PLU, dejalo vacío y cargá el código de barras.</p>
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
          <label htmlFor={`${prefijo}-barcode`}>Código de barras</label>
          <input
            id={`${prefijo}-barcode`}
            name="barcode"
            type="text"
            inputMode="numeric"
            defaultValue={p?.barcode ?? ''}
            placeholder="Escanealo con un lector o escribilo"
          />
          <p className="ayuda">Acepta lector USB/Bluetooth que escriba como teclado, o carga manual.</p>
        </div>
        <div className="campo">
          <Casilla name="usesPlu" etiqueta="Se identifica con PLU" defecto={p?.usesPlu ?? true} />
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
          <label htmlFor={`${prefijo}-buy-weight`}>Kg por unidad comprada</label>
          <input
            id={`${prefijo}-buy-weight`}
            name="purchaseUnitWeightKg"
            type="text"
            inputMode="decimal"
            defaultValue={p?.purchaseUnitWeightKg?.toString() ?? ''}
            placeholder="Ej. 5 para una lata de 5 kg"
          />
          <p className="ayuda">
            Usalo sólo si el proveedor factura por unidad y el producto se vende por kilo.
          </p>
        </div>
      </div>

      <div className="campo">
        <label htmlFor={`${prefijo}-piece`}>Peso de pieza u horma (kg, opcional)</label>
        <input
          id={`${prefijo}-piece`}
          name="avgPieceWeightKg"
          type="text"
          inputMode="decimal"
          defaultValue={p?.avgPieceWeightKg?.toString() ?? ''}
        />
      </div>

      <div className="fila fila-2">
        <div className="campo">
          <label htmlFor={`${prefijo}-margin`}>Marcaje base (%)</label>
          <input
            id={`${prefijo}-margin`}
            name="targetMarginPct"
            type="text"
            inputMode="decimal"
            defaultValue={p ? Number(p.targetMarginPct) * 100 : '45'}
            required
          />
          <p className="ayuda">
            Los marcajes específicos de horma, caja, feteado y efectivo se ajustan en la pantalla Precios.
          </p>
        </div>
        <div className="campo">
          <label htmlFor={`${prefijo}-basis`}>Base del marcaje</label>
          <select
            id={`${prefijo}-basis`}
            name="marginBasis"
            defaultValue={p?.marginBasis ?? 'SOBRE_COSTO'}
          >
            <option value="SOBRE_COSTO">Sobre el costo · precio = costo × (1 + marcaje)</option>
            <option value="SOBRE_VENTA">Sobre la venta · precio = costo / (1 − marcaje)</option>
          </select>
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

      <div className="acciones">
        <a href="/configuracion/catalogo" className="boton boton-secundario">
          Catálogo Don Ginés
        </a>
        <a href="/configuracion/productos/asociaciones" className="boton boton-secundario">
          Asociaciones históricas
        </a>
      </div>

      <form className="card card-compacta" method="get">
        <div className="campo">
          <label htmlFor="q">Buscar por PLU, código de barras, nombre o código de proveedor</label>
          <input id="q" name="q" type="search" defaultValue={busqueda} placeholder="1211, 779..., cremoso, ART-00228" />
        </div>
        <div className="acciones">
          <button type="submit" className="boton boton-secundario">
            Buscar
          </button>
          {busqueda ? (
            <a href="/configuracion/productos" className="boton boton-secundario">
              Ver todos
            </a>
          ) : null}
        </div>
      </form>
      <p className="medio">
        Cada producto define cómo se compra, cómo se vende y con qué marcajes y redondeo se forman
        sus precios. Los artículos sin PLU pueden identificarse por código de barras.
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
              <span className="etiqueta-estado estado-neutro">
                {producto.usesPlu ? `PLU ${producto.internalCode}` : `Código ${producto.barcode ?? producto.internalCode}`}
              </span>
            </div>
            <div className="fila-dato-meta">
              {producto.category ? <span>{producto.category}</span> : null}
              <span>{SALE_MODE_LABEL[producto.saleMode]}</span>
              <span>
                {MARGIN_BASIS_LABEL[producto.marginBasis]}:{' '}
                {formatRate(producto.targetMarginPct.toString())}
              </span>
              <span>{ROUNDING_RULE_LABEL[producto.roundingRule as RoundingRule]}</span>
              {producto.purchaseUnit === 'UNIT' && producto.purchaseUnitWeightKg ? (
                <span>Compra: {formatQty(producto.purchaseUnitWeightKg.toString(), 3)} kg/unidad</span>
              ) : null}
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

            {/*
              Los códigos con que cada proveedor factura este mismo artículo.
              Van aparte de los alias porque son otra cosa: el alias es una
              forma de escribir el nombre, el código es una identificación. El
              PLU de Don Ginés es el de arriba y no lo reemplaza ninguno.
            */}
            <details className="mt">
              <summary>
                Códigos por proveedor ({producto.aliases.filter((a) => a.supplierCode).length})
              </summary>

              {producto.aliases.filter((a) => a.supplierCode).length > 0 ? (
                <ul className="lista chica">
                  {producto.aliases
                    .filter((a) => a.supplierCode)
                    .map((a) => (
                      <li key={a.id} className="fila-dato-meta">
                        <span>{a.supplier?.tradeName ?? 'Sin proveedor'}</span>
                        <strong>{a.supplierCode}</strong>
                        <FormularioConfig
                          titulo="Quitar"
                          textoBoton="Quitar"
                          accion={quitarCodigoDeProveedor}
                        >
                          <input type="hidden" name="aliasId" value={a.id} />
                        </FormularioConfig>
                      </li>
                    ))}
                </ul>
              ) : (
                <p className="chico medio">
                  Todavía no hay ningún código cargado. Se aprenden solos cuando se confirma una
                  factura eligiendo el producto, o se pueden cargar acá.
                </p>
              )}

              <FormularioConfig
                titulo="Agregar el código de un proveedor"
                textoBoton="Agregar el código"
                accion={guardarCodigoDeProveedor}
              >
                <input type="hidden" name="productId" value={producto.id} />
                <div className="fila fila-2">
                  <div className="campo">
                    <label htmlFor={`sc-prov-${producto.id}`}>Proveedor</label>
                    <select id={`sc-prov-${producto.id}`} name="supplierId" required>
                      <option value="">Elegí el proveedor…</option>
                      {proveedores.map((prov) => (
                        <option key={prov.id} value={prov.id}>
                          {prov.tradeName}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="campo">
                    <label htmlFor={`sc-cod-${producto.id}`}>Código en su factura</label>
                    <input
                      id={`sc-cod-${producto.id}`}
                      name="supplierCode"
                      type="text"
                      placeholder="ART-00228"
                      required
                    />
                  </div>
                </div>
              </FormularioConfig>
            </details>

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
