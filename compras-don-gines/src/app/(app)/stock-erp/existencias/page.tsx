import type { Metadata } from 'next';
import Link from 'next/link';
import { requireUserOrRedirect, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import { formatCorteAr } from '@/lib/datetime';
import {
  tableroDeExistencias,
  type EstadoDeExistencia,
  type FilaDelTablero,
} from '@/lib/services/stock-erp-consultas';
import { EnPreparacion } from '../EnPreparacion';

export const metadata: Metadata = { title: 'Stock ERP · Existencias' };
export const dynamic = 'force-dynamic';

/**
 * El tablero de existencias.
 *
 * **No tiene ninguna acción de servidor.** Los filtros viajan por `GET` en la
 * URL y la página sólo lee. Eso no es una limitación: es la garantía puesta en
 * la forma del código. Una pantalla sin acciones no puede escribir aunque
 * alguien se equivoque más adelante, y de paso los filtros quedan en un enlace
 * que se puede compartir.
 *
 * Lo que esta pantalla NO hace, y es su razón de ser: convertir una ausencia de
 * dato en un cero. Cada estado dice exactamente lo que sabe.
 */

/** Cómo se lee cada estado, y de qué color. Los textos explican, no etiquetan. */
const PRESENTACION: Record<
  EstadoDeExistencia,
  { titulo: string; color: string; explica: string }
> = {
  SUCURSAL_SIN_APERTURA: {
    titulo: 'Sucursal sin apertura',
    color: 'var(--ambar-suave, #fdf1d6)',
    explica:
      'Esta sucursal nunca se inauguró en Stock ERP. Sus artículos NO están en cero: están sin ' +
      'contar. No hay saldo que mostrar, y mostrar un cero sería inventarlo.',
  },
  NO_SE_MANEJA: {
    titulo: 'No se maneja acá',
    color: 'var(--gris-suave, #eef1f4)',
    explica:
      'La sucursal decidió que no trabaja este artículo, con motivo y con autor. No es un ' +
      'faltante ni un cero: es una decisión.',
  },
  PENDIENTE_DE_UNIDAD: {
    titulo: 'Pendiente de unidad',
    color: 'var(--rojo-suave, #fdecea)',
    explica:
      'Nadie aprobó todavía en qué unidad se cuenta este artículo. Hasta que alguien la apruebe ' +
      'no se puede contar ni mover, así que no tiene existencias operativas.',
  },
  CERO_CONFIRMADO: {
    titulo: 'Cero confirmado',
    color: 'var(--gris-suave, #eef1f4)',
    explica:
      'Alguien lo buscó en la góndola y no había. Este cero es un dato: costó el mismo gesto ' +
      'deliberado que cualquier otra cantidad.',
  },
  CON_SALDO: {
    titulo: 'Con saldo',
    color: 'var(--verde-suave, #e6f4ea)',
    explica: 'Hay existencia registrada en el libro.',
  },
  CERO_POR_MOVIMIENTOS: {
    titulo: 'En cero por movimientos',
    color: 'var(--gris-suave, #eef1f4)',
    explica:
      'Llegó a cero moviéndose, no contándose. Es distinto de un cero contado: acá el cero es el ' +
      'resultado de una cuenta, no de haber mirado.',
  },
  SIN_DATO: {
    titulo: 'Sin dato',
    color: 'var(--ambar-suave, #fdf1d6)',
    explica:
      'Está habilitado y la sucursal tiene apertura, pero no hay ni conteo ni movimiento: entró ' +
      'al catálogo después del corte y todavía nadie lo recibió. Ausencia de dato, no cero.',
  },
};

const ORDEN_DEL_RESUMEN: EstadoDeExistencia[] = [
  'CON_SALDO',
  'CERO_CONFIRMADO',
  'CERO_POR_MOVIMIENTOS',
  'SIN_DATO',
  'PENDIENTE_DE_UNIDAD',
  'NO_SE_MANEJA',
  'SUCURSAL_SIN_APERTURA',
];

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{
    sucursal?: string;
    q?: string;
    unidad?: string;
    estado?: string;
    configuracion?: string;
  }>;
}) {
  const f = await searchParams;
  const user = await requireUserOrRedirect();

  if (!hasPermission(user, PERMISSIONS.STOCKERP_MOVIMIENTOS_VER)) {
    return (
      <main className="contenido">
        <EnPreparacion />
        <p className="mensaje mensaje-error" data-prueba="sin-permiso">
          Tu usuario no puede consultar existencias. El permiso «stockerp.movimientos.ver» se pide
          desde Configuración → Roles. Es un permiso de lectura y no habilita modificar nada.
        </p>
      </main>
    );
  }

  const sucursales = await prisma.branch.findMany({ orderBy: { name: 'asc' } });
  const tablero = await tableroDeExistencias(user, {
    branchId: f.sucursal || undefined,
    texto: f.q || undefined,
    unidad: f.unidad === 'KG' || f.unidad === 'UNIT' ? f.unidad : undefined,
    estado: (f.estado as EstadoDeExistencia) || undefined,
    estadoDeConfiguracion:
      f.configuracion === 'APROBADA' || f.configuracion === 'PENDIENTE' ? f.configuracion : undefined,
  });

  return (
    <main className="contenido">
      <EnPreparacion>
        Este tablero muestra lo que el libro tiene registrado, que todavía no descuenta ventas.
      </EnPreparacion>

      <p className="chico">
        <Link href="/stock-erp/movimientos">Movimientos →</Link>{' '}
        <Link href="/stock-erp/integridad">Integridad →</Link>{' '}
        <Link href="/stock-erp/auditoria">Auditoría →</Link>
      </p>
      <h1>Existencias</h1>
      <p className="chico">
        Cada artículo dice en qué situación está, y los estados no son intercambiables: una sucursal
        sin apertura, un artículo que no se maneja y un cero contado son tres cosas distintas.{' '}
        <strong>Ninguna ausencia se muestra como cero.</strong>
      </p>

      {/* --- Filtros, todos por GET ---------------------------------------- */}
      <form
        method="get"
        data-prueba="form-filtros"
        style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-end' }}
      >
        <div style={{ flex: '1 1 160px', minWidth: 0 }}>
          <label className="etiqueta" htmlFor="q">
            Buscar
          </label>
          <input id="q" name="q" type="search" defaultValue={f.q ?? ''} placeholder="PLU, nombre o familia" data-prueba="buscar" />
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
        <div style={{ flex: '1 1 110px', minWidth: 0 }}>
          <label className="etiqueta" htmlFor="unidad">
            Unidad
          </label>
          <select id="unidad" name="unidad" defaultValue={f.unidad ?? ''} data-prueba="filtro-unidad">
            <option value="">Todas</option>
            <option value="KG">KG</option>
            <option value="UNIT">UNIT</option>
          </select>
        </div>
        <div style={{ flex: '1 1 170px', minWidth: 0 }}>
          <label className="etiqueta" htmlFor="estado">
            Situación
          </label>
          <select id="estado" name="estado" defaultValue={f.estado ?? ''} data-prueba="filtro-estado">
            <option value="">Todas</option>
            {ORDEN_DEL_RESUMEN.map((e) => (
              <option key={e} value={e}>
                {PRESENTACION[e].titulo}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="boton-secundario" data-prueba="aplicar">
          Filtrar
        </button>
      </form>

      {/* --- Resumen: cuentas y totales SEPARADOS por unidad --------------- */}
      <section className="tarjeta" data-prueba="resumen">
        <h2 className="chico">Qué hay</h2>
        <ul className="chico" style={{ margin: 0, paddingLeft: 18 }}>
          {ORDEN_DEL_RESUMEN.filter((e) => tablero.resumen[e] > 0).map((e) => (
            <li key={e} data-prueba="resumen-estado" data-estado={e}>
              {PRESENTACION[e].titulo}: <strong>{tablero.resumen[e]}</strong>
            </li>
          ))}
          {ORDEN_DEL_RESUMEN.every((e) => tablero.resumen[e] === 0) && (
            <li className="chico">Nada que mostrar con esos filtros.</li>
          )}
        </ul>

        <h2 className="chico" style={{ marginTop: 12 }}>
          Total por unidad
        </h2>
        {Object.keys(tablero.totalPorUnidad).length === 0 ? (
          <p className="chico">Sin saldos que totalizar.</p>
        ) : (
          <ul className="chico" style={{ margin: 0, paddingLeft: 18 }} data-prueba="totales">
            {Object.entries(tablero.totalPorUnidad).map(([unidad, total]) => (
              <li key={unidad} data-prueba="total-unidad" data-unidad={unidad}>
                <strong>{total}</strong> {unidad}
              </li>
            ))}
          </ul>
        )}
        <p className="chico" data-prueba="aviso-unidades">
          Los totales van <strong>separados por unidad</strong>, y no hay un total único. Sumar kilos
          con unidades sería inventar una equivalencia que nadie aprobó.
        </p>
      </section>

      {tablero.sucursalesSinApertura.length > 0 && (
        <p className="mensaje mensaje-aviso" data-prueba="aviso-sin-apertura">
          <strong>
            {tablero.sucursalesSinApertura.map((s) => s.sucursal).join(', ')}
          </strong>{' '}
          {tablero.sucursalesSinApertura.length === 1 ? 'no tiene' : 'no tienen'} apertura de Stock
          ERP confirmada. Sus artículos no están en cero: están sin contar.
        </p>
      )}

      {/* --- Las filas, como tarjetas en el teléfono ----------------------- */}
      <p className="chico" data-prueba="cuenta">
        {tablero.filas.length} filas · {tablero.mirados} artículos mirados
        {tablero.mirados >= tablero.tope ? ` (tope ${tablero.tope}: afiná la búsqueda)` : ''}
      </p>

      {tablero.filas.map((fila) => (
        <Fila key={`${fila.productId}|${fila.branchId}`} fila={fila} />
      ))}
    </main>
  );
}

function Fila({ fila }: { fila: FilaDelTablero }) {
  const p = PRESENTACION[fila.estado];
  return (
    <article
      className="tarjeta"
      data-prueba="fila"
      data-estado={fila.estado}
      data-plu={fila.plu}
      data-sucursal={fila.branchId}
      style={{ background: p.color, marginBottom: 10 }}
    >
      <header style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <strong data-prueba="plu">{fila.plu}</strong>
        <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{fila.nombre}</span>
        <span className="chico" data-prueba="sucursal-nombre">
          {fila.sucursal}
        </span>
      </header>

      <p className="chico" data-prueba="situacion">
        <strong>{p.titulo}</strong>
        {fila.cantidad !== null ? (
          <>
            {' · '}
            <strong data-prueba="cantidad">{fila.cantidad}</strong>{' '}
            <span data-prueba="unidad">{fila.unidadDeExistencia}</span>
          </>
        ) : (
          /*
           * Se dice «sin saldo que mostrar» y NO se escribe un cero. Un `0` acá
           * sería indistinguible de un cero real, que es justo la confusión que
           * esta pantalla existe para evitar.
           */
          <span data-prueba="sin-numero"> · sin saldo que mostrar</span>
        )}
      </p>

      <p className="chico" data-prueba="explicacion" style={{ overflowWrap: 'anywhere' }}>
        {p.explica}
      </p>

      {fila.motivo && (
        <p className="chico" data-prueba="motivo" style={{ overflowWrap: 'anywhere' }}>
          Motivo: {fila.motivo}
        </p>
      )}

      <p className="chico" data-prueba="detalle">
        {fila.origenDelSaldo ? `Origen del saldo: ${fila.origenDelSaldo} · ` : ''}
        {fila.movimientosPosteriores} movimientos después de la apertura
        {fila.cutoffAt ? ` · Corte: ${formatCorteAr(fila.cutoffAt)}` : ''}
      </p>

      <Link
        href={`/stock-erp/movimientos?producto=${fila.productId}&sucursal=${fila.branchId}`}
        className="boton-secundario chico"
        data-prueba="ver-movimientos"
      >
        Ver sus movimientos
      </Link>
    </article>
  );
}
