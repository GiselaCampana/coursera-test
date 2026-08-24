import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUserOrRedirect, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import { getPurchaseReport } from '@/lib/services/reports';
import { formatARS, formatQty } from '@/lib/money';
import { formatDateAr } from '@/lib/datetime';

export const metadata: Metadata = { title: 'Compras' };
export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<{
    producto?: string;
    proveedor?: string;
    sucursal?: string;
    desde?: string;
    hasta?: string;
    buscar?: string;
  }>;
}

export default async function PaginaCompras({ searchParams }: Props) {
  const user = await requireUserOrRedirect();
  if (!hasPermission(user, PERMISSIONS.REPORTES_VER)) redirect('/');

  const filtros = await searchParams;
  const [reporte, productos, proveedores, sucursales] = await Promise.all([
    getPurchaseReport(user, {
      productId: filtros.producto ?? null,
      supplierId: filtros.proveedor ?? null,
      branchId: filtros.sucursal ?? null,
      from: filtros.desde ?? null,
      to: filtros.hasta ?? null,
      search: filtros.buscar ?? null,
    }),
    prisma.product.findMany({
      orderBy: { normalizedName: 'asc' },
      select: { id: true, normalizedName: true },
    }),
    prisma.supplier.findMany({
      orderBy: { tradeName: 'asc' },
      select: { id: true, tradeName: true },
    }),
    prisma.branch.findMany({
      where: user.scopeAllBranches ? {} : { id: user.branchId ?? '__ninguna__' },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
  ]);

  const paramsCsv = new URLSearchParams();
  for (const [clave, valor] of Object.entries(filtros)) {
    if (valor) paramsCsv.set(clave, valor);
  }

  return (
    <>
      <h1>Compras</h1>
      <p className="medio">Historial de kilos, unidades y costos comprados.</p>

      <form className="card card-compacta" method="get">
        <div className="filtros">
          <div className="campo">
            <label htmlFor="producto">Producto</label>
            <select id="producto" name="producto" defaultValue={filtros.producto ?? ''}>
              <option value="">Todos</option>
              {productos.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.normalizedName}
                </option>
              ))}
            </select>
          </div>
          <div className="campo">
            <label htmlFor="proveedor">Proveedor</label>
            <select id="proveedor" name="proveedor" defaultValue={filtros.proveedor ?? ''}>
              <option value="">Todos</option>
              {proveedores.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.tradeName}
                </option>
              ))}
            </select>
          </div>
          {sucursales.length > 1 ? (
            <div className="campo">
              <label htmlFor="sucursal">Sucursal</label>
              <select id="sucursal" name="sucursal" defaultValue={filtros.sucursal ?? ''}>
                <option value="">Todas</option>
                {sucursales.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="campo">
            <label htmlFor="desde">Desde</label>
            <input id="desde" name="desde" type="date" defaultValue={filtros.desde ?? ''} />
          </div>
          <div className="campo">
            <label htmlFor="hasta">Hasta</label>
            <input id="hasta" name="hasta" type="date" defaultValue={filtros.hasta ?? ''} />
          </div>
          <div className="campo">
            <label htmlFor="buscar">Descripción</label>
            <input
              id="buscar"
              name="buscar"
              type="search"
              defaultValue={filtros.buscar ?? ''}
              placeholder="Texto de la factura"
            />
          </div>
        </div>
        <div className="acciones">
          <button type="submit" className="boton boton-chico">
            Filtrar
          </button>
          <Link href="/compras" className="boton boton-secundario boton-chico">
            Limpiar
          </Link>
          <a
            href={`/api/compras/exportar?${paramsCsv.toString()}`}
            className="boton boton-secundario boton-chico"
          >
            Exportar CSV
          </a>
        </div>
      </form>

      <div className="card card-compacta">
        <h2>Totales del período</h2>
        <dl style={{ margin: 0 }}>
          <div className="dato destacado">
            <dt>Costo total</dt>
            <dd>{formatARS(reporte.totals.costoTotal)}</dd>
          </div>
          <div className="dato">
            <dt>Kilos</dt>
            <dd>{formatQty(reporte.totals.kilos, 2)} kg</dd>
          </div>
          <div className="dato">
            <dt>Unidades</dt>
            <dd>{formatQty(reporte.totals.unidades, 0)}</dd>
          </div>
          <div className="dato">
            <dt>Piezas</dt>
            <dd>{reporte.totals.piezas}</dd>
          </div>
          <div className="dato">
            <dt>Neto</dt>
            <dd>{formatARS(reporte.totals.neto)}</dd>
          </div>
          <div className="dato">
            <dt>IVA</dt>
            <dd>{formatARS(reporte.totals.iva)}</dd>
          </div>
          <div className="dato">
            <dt>Percepciones</dt>
            <dd>{formatARS(reporte.totals.percepciones)}</dd>
          </div>
          <div className="dato">
            <dt>Comprobantes</dt>
            <dd>{reporte.totals.comprobantes}</dd>
          </div>
        </dl>
      </div>

      {reporte.rows.length === 0 ? (
        <div className="card">
          <div className="vacio">
            <div className="vacio-titulo">No hay compras con esos filtros</div>
            <p className="mb0">Probá ampliar el período.</p>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="card-titulo">
            <h2>Detalle</h2>
            <span className="chico medio">{reporte.rows.length} movimientos</span>
          </div>
          <div className="tabla-scroll">
            <table>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Producto</th>
                  <th>Proveedor</th>
                  <th>Sucursal</th>
                  <th className="num">Cantidad</th>
                  <th className="num">Piezas</th>
                  <th className="num">Precio neto</th>
                  <th className="num">Costo unit.</th>
                  <th className="num">Costo total</th>
                  <th>Comprobante</th>
                </tr>
              </thead>
              <tbody>
                {reporte.rows.map((fila) => (
                  <tr key={fila.id}>
                    <td>{formatDateAr(fila.date)}</td>
                    <td style={{ whiteSpace: 'normal', minWidth: 170 }}>
                      {fila.productName ?? <span className="suave">{fila.description}</span>}
                    </td>
                    <td>{fila.supplierName ?? '—'}</td>
                    <td>{fila.branchName}</td>
                    <td className="num">
                      {formatQty(fila.quantity, fila.unit === 'KG' ? 2 : 0)}{' '}
                      {fila.unit === 'KG' ? 'kg' : 'u.'}
                    </td>
                    <td className="num">{fila.pieceCount ?? '—'}</td>
                    <td className="num">{formatARS(fila.unitNetPrice)}</td>
                    <td className="num">{formatARS(fila.unitCost)}</td>
                    <td className="num">{formatARS(fila.totalCost)}</td>
                    <td>
                      <Link href={`/comprobantes/${fila.documentId}`}>{fila.documentNumber}</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
