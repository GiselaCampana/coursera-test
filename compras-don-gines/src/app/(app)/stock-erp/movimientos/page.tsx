import type { Metadata } from 'next';
import Link from 'next/link';
import { requireUserOrRedirect, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import { formatCorteAr } from '@/lib/datetime';
import {
  movimientosDelLibro,
  recorridoCronologico,
  type MovimientoDelLibro,
} from '@/lib/services/stock-erp-consultas';
import { EnPreparacion } from '../EnPreparacion';

export const metadata: Metadata = { title: 'Stock ERP · Movimientos' };
export const dynamic = 'force-dynamic';

/**
 * El historial del libro de existencias.
 *
 * Sin acciones de servidor: filtros y cursor por `GET`. La pantalla lee y
 * nada más.
 *
 * LO QUE ESTA PANTALLA TIENE QUE DEJAR CLARO, porque es lo que se malinterpreta:
 * `balanceAfterSeq` es el saldo posterior **en el orden en que el libro se
 * escribió**, no en el orden en que las cosas pasaron. Cuando alguien carga hoy
 * una mercadería que llegó la semana pasada, los dos órdenes se separan. El
 * movimiento se marca retroactivo y se explica; no se reordena el libro ni se
 * recalculan los saldos para que la lista quede prolija.
 */

const TIPOS = [
  'OPENING_BALANCE',
  'PURCHASE_IN',
  'SALE_OUT',
  'CUSTOMER_RETURN_IN',
  'SUPPLIER_RETURN_OUT',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'WASTE_OUT',
  'INTERNAL_USE_OUT',
  'ADJUSTMENT_IN',
  'ADJUSTMENT_OUT',
  'INVENTORY_CORRECTION',
];

const NOMBRE_DEL_TIPO: Record<string, string> = {
  OPENING_BALANCE: 'Apertura',
  PURCHASE_IN: 'Ingreso por compra',
  SALE_OUT: 'Venta',
  CUSTOMER_RETURN_IN: 'Devolución de cliente',
  SUPPLIER_RETURN_OUT: 'Devolución a proveedor',
  TRANSFER_OUT: 'Traslado (salida)',
  TRANSFER_IN: 'Traslado (entrada)',
  WASTE_OUT: 'Merma',
  INTERNAL_USE_OUT: 'Consumo interno',
  ADJUSTMENT_IN: 'Ajuste (entrada)',
  ADJUSTMENT_OUT: 'Ajuste (salida)',
  INVENTORY_CORRECTION: 'Corrección de inventario',
};

function fecha(d: Date): string {
  return formatCorteAr(d);
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{
    sucursal?: string;
    producto?: string;
    q?: string;
    tipo?: string;
    direccion?: string;
    efectivaDesde?: string;
    efectivaHasta?: string;
    registradaDesde?: string;
    registradaHasta?: string;
    operacion?: string;
    documento?: string;
    cursor?: string;
    cronologico?: string;
  }>;
}) {
  const f = await searchParams;
  const user = await requireUserOrRedirect();

  if (!hasPermission(user, PERMISSIONS.STOCKERP_MOVIMIENTOS_VER)) {
    return (
      <main className="contenido">
        <EnPreparacion />
        <p className="mensaje mensaje-error" data-prueba="sin-permiso">
          Tu usuario no puede consultar el libro de existencias. El permiso
          «stockerp.movimientos.ver» se pide desde Configuración → Roles, y es de lectura: no
          habilita modificar nada.
        </p>
      </main>
    );
  }

  const sucursales = await prisma.branch.findMany({ orderBy: { name: 'asc' } });

  const comoFecha = (t?: string) => (t && /^\d{4}-\d{2}-\d{2}$/.test(t) ? new Date(`${t}T00:00:00Z`) : undefined);
  const comoFechaFin = (t?: string) =>
    t && /^\d{4}-\d{2}-\d{2}$/.test(t) ? new Date(`${t}T23:59:59.999Z`) : undefined;

  const filtro = {
    branchId: f.sucursal || undefined,
    productId: f.producto || undefined,
    texto: f.q || undefined,
    type: f.tipo || undefined,
    direction: (f.direccion === 'IN' || f.direccion === 'OUT' ? f.direccion : undefined) as
      | 'IN'
      | 'OUT'
      | undefined,
    efectivaDesde: comoFecha(f.efectivaDesde),
    efectivaHasta: comoFechaFin(f.efectivaHasta),
    registradaDesde: comoFecha(f.registradaDesde),
    registradaHasta: comoFechaFin(f.registradaHasta),
    operationId: f.operacion || undefined,
    documentId: f.documento || undefined,
  };

  const pagina = await movimientosDelLibro(user, filtro, { cursor: f.cursor ?? null, tamano: 25 });

  /*
   * El recorrido cronológico se ofrece SÓLO cuando hay un artículo y una
   * sucursal elegidos, porque es lo único en que la pregunta tiene sentido: un
   * saldo acumulado que mezclara artículos o sucursales no significaría nada.
   */
  const cronologico =
    f.cronologico === 'si' && filtro.productId && filtro.branchId
      ? await recorridoCronologico(user, {
          productId: filtro.productId,
          branchId: filtro.branchId,
        })
      : null;

  /** Los filtros vigentes, para que el enlace de «más» los conserve. */
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (k !== 'cursor' && typeof v === 'string' && v !== '') params.set(k, v);
  }
  const siguiente = pagina.siguiente
    ? `?${new URLSearchParams({ ...Object.fromEntries(params), cursor: pagina.siguiente }).toString()}`
    : null;

  const hayRetroactivos = pagina.movimientos.some((m) => m.retroactivo);

  return (
    <main className="contenido">
      <EnPreparacion>
        El libro todavía no recibe ventas, así que su saldo sube y nunca baja por venta.
      </EnPreparacion>

      <p className="chico">
        <Link href="/stock-erp/existencias">← Existencias</Link>{' '}
        <Link href="/stock-erp/integridad">Integridad →</Link>{' '}
        <Link href="/stock-erp/auditoria">Auditoría →</Link>
      </p>
      <h1>Movimientos del libro</h1>
      <p className="chico" data-prueba="explica-tiempos">
        Cada movimiento tiene <strong>dos momentos</strong>: la <em>fecha efectiva</em>, cuándo pasó
        en el mundo, y la <em>registración</em>, cuándo entró al libro. El saldo posterior que se
        muestra corresponde al <strong>orden de registración</strong>, que es el orden en que el
        libro se escribió y no se puede cambiar.
      </p>

      {/* --- Filtros -------------------------------------------------------- */}
      <form
        method="get"
        data-prueba="form-filtros"
        style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-end' }}
      >
        <div style={{ flex: '1 1 150px', minWidth: 0 }}>
          <label className="etiqueta" htmlFor="q">
            Artículo o PLU
          </label>
          <input id="q" name="q" type="search" defaultValue={f.q ?? ''} placeholder="PLU actual o viejo" data-prueba="buscar" />
        </div>
        <div style={{ flex: '1 1 140px', minWidth: 0 }}>
          <label className="etiqueta" htmlFor="sucursal">
            Sucursal
          </label>
          <select id="sucursal" name="sucursal" defaultValue={f.sucursal ?? ''} data-prueba="filtro-sucursal">
            <option value="">Todas</option>
            {sucursales.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: '1 1 160px', minWidth: 0 }}>
          <label className="etiqueta" htmlFor="tipo">
            Tipo
          </label>
          <select id="tipo" name="tipo" defaultValue={f.tipo ?? ''} data-prueba="filtro-tipo">
            <option value="">Todos</option>
            {TIPOS.map((t) => (
              <option key={t} value={t}>
                {NOMBRE_DEL_TIPO[t] ?? t}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: '1 1 110px', minWidth: 0 }}>
          <label className="etiqueta" htmlFor="direccion">
            Dirección
          </label>
          <select id="direccion" name="direccion" defaultValue={f.direccion ?? ''} data-prueba="filtro-direccion">
            <option value="">Las dos</option>
            <option value="IN">Entrada</option>
            <option value="OUT">Salida</option>
          </select>
        </div>
        <div style={{ flex: '1 1 140px', minWidth: 0 }}>
          <label className="etiqueta" htmlFor="efectivaDesde">
            Efectiva desde
          </label>
          <input id="efectivaDesde" name="efectivaDesde" type="date" defaultValue={f.efectivaDesde ?? ''} data-prueba="efectiva-desde" />
        </div>
        <div style={{ flex: '1 1 140px', minWidth: 0 }}>
          <label className="etiqueta" htmlFor="efectivaHasta">
            Efectiva hasta
          </label>
          <input id="efectivaHasta" name="efectivaHasta" type="date" defaultValue={f.efectivaHasta ?? ''} data-prueba="efectiva-hasta" />
        </div>
        <div style={{ flex: '1 1 140px', minWidth: 0 }}>
          <label className="etiqueta" htmlFor="registradaDesde">
            Registrada desde
          </label>
          <input id="registradaDesde" name="registradaDesde" type="date" defaultValue={f.registradaDesde ?? ''} data-prueba="registrada-desde" />
        </div>
        <button type="submit" className="boton-secundario" data-prueba="aplicar">
          Filtrar
        </button>
      </form>

      {hayRetroactivos && (
        <p className="mensaje mensaje-aviso" data-prueba="aviso-retroactivo">
          Hay movimientos <strong>retroactivos</strong>: se registraron después de algo cuya fecha
          efectiva es posterior. No es una corrupción —pasa cuando alguien carga el lunes una
          mercadería que llegó el viernes— pero su saldo posterior corresponde al{' '}
          <strong>orden de registración</strong> y no al recorrido cronológico.
        </p>
      )}

      <p className="chico" data-prueba="cuenta">
        {pagina.movimientos.length} movimientos en esta página
      </p>

      {pagina.movimientos.length === 0 && (
        <p className="chico" data-prueba="vacio">
          No hay movimientos con esos filtros.
        </p>
      )}

      {pagina.movimientos.map((m) => (
        <Movimiento key={m.id} m={m} />
      ))}

      {siguiente && (
        <p>
          <Link href={siguiente} className="boton" data-prueba="siguiente">
            Ver más antiguos
          </Link>
        </p>
      )}

      {/* --- El recorrido cronológico, que es otra pregunta ---------------- */}
      {filtro.productId && filtro.branchId && (
        <section className="tarjeta" data-prueba="bloque-cronologico">
          <h2 className="chico">Recorrido cronológico</h2>
          <p className="chico">
            Ordenado por <strong>fecha efectiva</strong>, con desempate por orden de registración.
            Contesta «¿cuánto había tal día?», que es una pregunta distinta de «¿qué decía el libro
            cuando se escribió esta fila?». Las dos son ciertas.
          </p>
          {cronologico === null ? (
            <Link
              href={`?${new URLSearchParams({ ...Object.fromEntries(params), cronologico: 'si' }).toString()}`}
              className="boton-secundario chico"
              data-prueba="ver-cronologico"
            >
              Calcularlo
            </Link>
          ) : (
            <ul className="chico" style={{ paddingLeft: 18 }} data-prueba="cronologico">
              {cronologico.map((paso) => (
                <li key={paso.movimiento.id} data-prueba="paso-cronologico">
                  {fecha(paso.movimiento.effectiveAt)} ·{' '}
                  {NOMBRE_DEL_TIPO[paso.movimiento.type] ?? paso.movimiento.type} ·{' '}
                  {paso.movimiento.direction === 'IN' ? '+' : '−'}
                  {paso.movimiento.cantidad} {paso.movimiento.unidad} → acumulado{' '}
                  <strong data-prueba="saldo-cronologico">{paso.saldoCronologico}</strong>
                  {!paso.coincideConElDeRegistracion && (
                    <span data-prueba="no-coincide">
                      {' '}
                      (el libro, en su orden de registración, decía{' '}
                      {paso.movimiento.balanceAfterSeq})
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}

function Movimiento({ m }: { m: MovimientoDelLibro }) {
  return (
    <article
      className="tarjeta"
      data-prueba="movimiento"
      data-seq={m.seq}
      data-tipo={m.type}
      data-retroactivo={m.retroactivo ? 'si' : 'no'}
      style={{
        background: m.retroactivo ? 'var(--ambar-suave, #fdf1d6)' : undefined,
        marginBottom: 10,
      }}
    >
      <header style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span className="chico" data-prueba="seq">
          #{m.seq}
        </span>
        <strong data-prueba="plu">{m.pluHistorico}</strong>
        <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{m.producto}</span>
        <span className="chico" data-prueba="tipo">
          {NOMBRE_DEL_TIPO[m.type] ?? m.type}
        </span>
      </header>

      <p className="chico" data-prueba="cantidad">
        <strong>
          {m.direction === 'IN' ? '+' : '−'}
          {m.cantidad} {m.unidad}
        </strong>{' '}
        · saldo posterior <strong data-prueba="saldo-posterior">{m.balanceAfterSeq}</strong>{' '}
        <span className="chico">(por orden de registración)</span>
      </p>

      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 8px', margin: '8px 0' }}>
        <dt className="chico">Fecha efectiva</dt>
        <dd className="chico" style={{ margin: 0 }} data-prueba="efectiva">
          {fecha(m.effectiveAt)}
        </dd>
        <dt className="chico">Registrado</dt>
        <dd className="chico" style={{ margin: 0 }} data-prueba="registrado">
          {fecha(m.createdAt)}
        </dd>
        <dt className="chico">Sucursal</dt>
        <dd className="chico" style={{ margin: 0 }}>
          {m.sucursal}
        </dd>
        {m.pluActual && m.pluActual !== m.pluHistorico && (
          <>
            <dt className="chico">PLU hoy</dt>
            <dd className="chico" style={{ margin: 0 }} data-prueba="plu-actual">
              {m.pluActual} (el movimiento guarda {m.pluHistorico}, el de su momento)
            </dd>
          </>
        )}
        {m.usuario && (
          <>
            <dt className="chico">Usuario</dt>
            <dd className="chico" style={{ margin: 0 }}>
              {m.usuario}
            </dd>
          </>
        )}
        {m.openingSource && (
          <>
            <dt className="chico">Origen del saldo</dt>
            <dd className="chico" style={{ margin: 0 }}>
              {m.openingSource}
            </dd>
          </>
        )}
        {m.invoicedQuantity && (
          <>
            <dt className="chico">Facturado</dt>
            <dd className="chico" style={{ margin: 0 }} data-prueba="facturado">
              {m.invoicedQuantity} {m.invoicedUnit}
              {m.conversionFactorUsed ? ` · factor ${m.conversionFactorUsed}` : ''}
              {m.pieceCount !== null ? ` · ${m.pieceCount} piezas` : ''}
              {m.realWeightKg ? ` · ${m.realWeightKg} kg reales` : ''}
            </dd>
          </>
        )}
        {(m.reversesId || m.reversedById) && (
          <>
            <dt className="chico">Reversión</dt>
            <dd className="chico" style={{ margin: 0 }} data-prueba="reversion">
              {m.reversesId ? `reversa el movimiento ${m.reversesId}` : ''}
              {m.reversedById ? `reversado por ${m.reversedById}` : ''}
            </dd>
          </>
        )}
      </dl>

      {m.retroactivo && (
        <p className="chico" data-prueba="marca-retroactivo">
          <strong>Retroactivo.</strong> Entró al libro después de un movimiento cuya fecha efectiva
          es posterior. Su saldo posterior refleja el orden de registración, no el cronológico.
        </p>
      )}

      {m.motivo && (
        <p className="chico" style={{ overflowWrap: 'anywhere' }}>
          {m.motivo}
        </p>
      )}

      <p className="chico" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {m.documentId && (
          <Link href={`/comprobantes/${m.documentId}`} data-prueba="enlace-comprobante">
            Comprobante {m.documentoNumero ?? ''}
          </Link>
        )}
        <Link
          href={`/stock-erp/movimientos?operacion=${m.operationId}`}
          data-prueba="enlace-operacion"
        >
          Operación {m.operacionTipo ?? ''}
        </Link>
      </p>
    </article>
  );
}
