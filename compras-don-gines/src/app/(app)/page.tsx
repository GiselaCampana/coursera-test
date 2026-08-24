import type { Metadata } from 'next';
import Link from 'next/link';
import { requireUserOrRedirect, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { getDashboard } from '@/lib/services/reports';
import { formatARS, formatQty } from '@/lib/money';
import { formatDateAr } from '@/lib/datetime';
import { EtiquetaComprobante, EtiquetaControl } from '@/components/Estado';

export const metadata: Metadata = { title: 'Inicio' };
export const dynamic = 'force-dynamic';

export default async function PaginaInicio() {
  const user = await requireUserOrRedirect();
  const data = await getDashboard(user);

  return (
    <>
      <h1>Hola, {user.name.split(' ')[0]}</h1>
      <p className="medio">
        {user.scopeAllBranches
          ? 'Estás viendo las tres sucursales.'
          : `Sucursal ${user.branchName ?? 'sin asignar'}.`}
      </p>

      <div className="indicadores">
        <Link href="/comprobantes?estado=REQUIERE_REVISION" className="indicador atencion">
          <div className="indicador-etiqueta">A revisar</div>
          <div className="indicador-valor">{data.pendientesDeRevision}</div>
          <div className="indicador-detalle">comprobantes pendientes</div>
        </Link>

        <Link href="/pagos" className={`indicador ${data.venceHoy.cantidad > 0 ? 'atencion' : ''}`}>
          <div className="indicador-etiqueta">Vence hoy</div>
          <div className="indicador-valor">{data.venceHoy.cantidad}</div>
          <div className="indicador-detalle">{formatARS(data.venceHoy.importe)}</div>
        </Link>

        <Link
          href="/pagos"
          className={`indicador ${data.vencidos.cantidad > 0 ? 'urgente' : ''}`}
        >
          <div className="indicador-etiqueta">Vencidos</div>
          <div className="indicador-valor">{data.vencidos.cantidad}</div>
          <div className="indicador-detalle">{formatARS(data.vencidos.importe)}</div>
        </Link>

        <Link href="/pagos" className="indicador">
          <div className="indicador-etiqueta">Próximos 7 días</div>
          <div className="indicador-valor">{data.proximosSieteDias.cantidad}</div>
          <div className="indicador-detalle">{formatARS(data.proximosSieteDias.importe)}</div>
        </Link>
      </div>

      <div className="card">
        <div className="card-titulo">
          <h2>Compras del mes</h2>
          <Link href="/compras" className="chico">
            Ver detalle
          </Link>
        </div>
        <dl style={{ margin: 0 }}>
          <div className="dato destacado">
            <dt>Total comprado</dt>
            <dd>{formatARS(data.comprasDelMes.importe)}</dd>
          </div>
          <div className="dato">
            <dt>Comprobantes</dt>
            <dd>{data.comprasDelMes.comprobantes}</dd>
          </div>
          <div className="dato">
            <dt>Kilos</dt>
            <dd>{formatQty(data.comprasDelMes.kilos, 2)} kg</dd>
          </div>
          {hasPermission(user, PERMISSIONS.PRECIOS_VER) ? (
            <div className="dato">
              <dt>Productos con aumento</dt>
              <dd>
                {data.productosConAumento > 0 ? (
                  <Link href="/precios" className="negativo">
                    {data.productosConAumento}
                  </Link>
                ) : (
                  '0'
                )}
              </dd>
            </div>
          ) : null}
        </dl>
      </div>

      <div className="card">
        <div className="card-titulo">
          <h2>Últimas facturas cargadas</h2>
          <Link href="/comprobantes" className="chico">
            Ver todas
          </Link>
        </div>

        {data.ultimosComprobantes.length === 0 ? (
          <div className="vacio">
            <div className="vacio-titulo">Todavía no hay comprobantes</div>
            <p className="mb0">Sacale una foto a la primera factura para empezar.</p>
            {hasPermission(user, PERMISSIONS.COMPROBANTES_CARGAR) ? (
              <Link href="/nueva-compra" className="boton mt">
                Cargar un comprobante
              </Link>
            ) : null}
          </div>
        ) : (
          <ul className="lista">
            {data.ultimosComprobantes.map((doc) => (
              <li key={doc.id}>
                <Link href={`/comprobantes/${doc.id}`} className="fila-dato">
                  <div className="fila-dato-cabecera">
                    <span className="fila-dato-titulo">
                      {doc.supplierName ?? 'Proveedor sin identificar'}
                    </span>
                    <span className="fila-dato-importe">
                      {doc.total ? formatARS(doc.total) : '—'}
                    </span>
                  </div>
                  <div className="fila-dato-meta">
                    <span>{doc.fullNumber}</span>
                    <span>{formatDateAr(doc.issueDate)}</span>
                    <span>{doc.branchName}</span>
                    <span>
                      {doc.itemCount} artículo{doc.itemCount === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="fila-dato-meta mt">
                    <EtiquetaComprobante estado={doc.status} />
                    <EtiquetaControl estado={doc.checkState} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {hasPermission(user, PERMISSIONS.COMPROBANTES_CARGAR) ? (
        <Link href="/nueva-compra" className="boton boton-bloque">
          Cargar un comprobante
        </Link>
      ) : null}
    </>
  );
}
