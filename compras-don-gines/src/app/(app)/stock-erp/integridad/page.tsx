import type { Metadata } from 'next';
import Link from 'next/link';
import { requireUserOrRedirect, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import { formatCorteAr } from '@/lib/datetime';
import {
  diagnosticoDeIntegridad,
  type ClaseDeDivergencia,
} from '@/lib/services/stock-erp-consultas';
import { EnPreparacion } from '../EnPreparacion';

export const metadata: Metadata = { title: 'Stock ERP · Integridad' };
export const dynamic = 'force-dynamic';

/**
 * El diagnóstico de integridad.
 *
 * **Detecta y no repara.** No hay botón, no hay acción de servidor y no hay
 * función que arregle: la pantalla no tiene forma de escribir. Es deliberado.
 * Una diferencia entre el saldo materializado y el libro significa que pasó
 * algo que nadie entiende todavía, y taparla con un recálculo automático
 * destruye la única evidencia de qué fue. Primero se mira; decidir es de otra
 * fase.
 *
 * Cuando los dos coinciden lo dice, con el momento exacto de la comprobación:
 * un «todo bien» sin fecha no dice nada, porque no se sabe de cuándo es.
 */

const QUE_SIGNIFICA: Record<ClaseDeDivergencia, string> = {
  SALDO_NO_COINCIDE:
    'La proyección y la suma del libro dan distinto. Se muestran los dos números por separado, sin ' +
    'corregir ninguno: cuál de los dos está mal es lo que hay que averiguar.',
  SALDO_SIN_LIBRO:
    'Hay un saldo materializado que el libro no puede explicar: no tiene ni un movimiento de ese ' +
    'artículo en esa sucursal.',
  LIBRO_SIN_SALDO:
    'El libro tiene movimientos y no hay saldo materializado. La proyección quedó atrás; el libro ' +
    'manda.',
  ULTIMO_MOVIMIENTO_AJENO:
    'El saldo apunta a un movimiento que no existe, o que es de otro artículo, otra sucursal u otra ' +
    'operación.',
  UNIDAD_INCONSISTENTE:
    'Hay movimientos en más de una unidad, o el saldo está en una unidad distinta de la de su ' +
    'último movimiento. Una suma así mezcla magnitudes incompatibles y no se puede leer.',
  ACTIVO_SIN_APERTURA:
    'Un artículo figura activo sin el movimiento de apertura que lo respalde.',
  APERTURA_SIN_MOVIMIENTO:
    'Una apertura confirmada sin los movimientos que debería haber escrito.',
};

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ sucursal?: string }>;
}) {
  const f = await searchParams;
  const user = await requireUserOrRedirect();

  if (!hasPermission(user, PERMISSIONS.STOCKERP_INTEGRIDAD_VER)) {
    return (
      <main className="contenido">
        <EnPreparacion />
        <p className="mensaje mensaje-error" data-prueba="sin-permiso">
          Tu usuario no puede ver el diagnóstico de integridad. El permiso
          «stockerp.integridad.ver» se pide desde Configuración → Roles. Es de lectura: el
          diagnóstico detecta y no repara.
        </p>
      </main>
    );
  }

  const sucursales = await prisma.branch.findMany({ orderBy: { name: 'asc' } });
  const d = await diagnosticoDeIntegridad(user, { branchId: f.sucursal || undefined });

  return (
    <main className="contenido">
      <EnPreparacion />

      <p className="chico">
        <Link href="/stock-erp/existencias">← Existencias</Link>{' '}
        <Link href="/stock-erp/movimientos">Movimientos →</Link>{' '}
        <Link href="/stock-erp/traslados">Traslados →</Link>{' '}
        <Link href="/stock-erp/auditoria">Auditoría →</Link>
      </p>
      <h1>Integridad del libro</h1>
      <p className="chico" data-prueba="detecta-no-repara">
        Compara el <strong>saldo materializado</strong> contra la <strong>suma del libro</strong>, que
        es la fuente de verdad. <strong>Detecta y no repara:</strong> no hay botón de arreglar, y no
        es un olvido. Una diferencia quiere decir que pasó algo que todavía nadie entiende, y
        taparla con un recálculo borra la evidencia de qué fue.
      </p>

      <form method="get" data-prueba="form-filtros" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ flex: '1 1 160px', minWidth: 0 }}>
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
        <button type="submit" className="boton-secundario" data-prueba="aplicar">
          Comprobar
        </button>
      </form>

      {d.coincide ? (
        <p className="mensaje mensaje-ok" data-prueba="coincide">
          <strong>El saldo materializado coincide con el libro.</strong> Se revisaron{' '}
          <strong data-prueba="pares">{d.paresRevisados}</strong> combinaciones de artículo y
          sucursal, sobre <strong data-prueba="movimientos">{d.movimientosRevisados}</strong>{' '}
          movimientos. Comprobado el{' '}
          <strong data-prueba="comprobado-el">{formatCorteAr(d.comprobadoEl)}</strong>.
        </p>
      ) : (
        <p className="mensaje mensaje-error" data-prueba="no-coincide">
          <strong>
            {d.divergencias.length}{' '}
            {d.divergencias.length === 1 ? 'divergencia detectada' : 'divergencias detectadas'}.
          </strong>{' '}
          Se revisaron <strong data-prueba="pares">{d.paresRevisados}</strong> combinaciones sobre{' '}
          <strong data-prueba="movimientos">{d.movimientosRevisados}</strong> movimientos. Comprobado
          el <strong data-prueba="comprobado-el">{formatCorteAr(d.comprobadoEl)}</strong>. No se
          corrigió nada.
        </p>
      )}

      {d.divergencias.map((div, i) => (
        <article
          className="tarjeta"
          key={`${div.clase}-${div.productId}-${div.branchId}-${i}`}
          data-prueba="divergencia"
          data-clase={div.clase}
          style={{ background: 'var(--rojo-suave, #fdecea)', marginBottom: 10 }}
        >
          <header style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <strong data-prueba="plu">{div.plu}</strong>
            <span className="chico" style={{ flex: 1 }}>
              {div.sucursal}
            </span>
            <span className="chico" data-prueba="clase">
              {div.clase}
            </span>
          </header>

          {/*
            * Los dos valores, SEPARADOS y nombrados. Nunca uno «corregido»: la
            * pantalla no sabe cuál de los dos es el bueno, y fingir que sí lo
            * sabe es peor que no mostrar nada.
            */}
          <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 8px', margin: '8px 0' }}>
            <dt className="chico">Según la proyección</dt>
            <dd className="chico" style={{ margin: 0, overflowWrap: 'anywhere' }} data-prueba="segun-saldo">
              {div.segunElSaldo ?? '—'}
            </dd>
            <dt className="chico">Según el libro</dt>
            <dd className="chico" style={{ margin: 0, overflowWrap: 'anywhere' }} data-prueba="segun-libro">
              {div.segunElLibro ?? '—'}
            </dd>
          </dl>

          <p className="chico" data-prueba="que-significa" style={{ overflowWrap: 'anywhere' }}>
            {QUE_SIGNIFICA[div.clase]}
          </p>
          <p className="chico" data-prueba="detalle" style={{ overflowWrap: 'anywhere' }}>
            {div.detalle}
          </p>

          <Link
            href={`/stock-erp/movimientos?producto=${div.productId}&sucursal=${div.branchId}`}
            className="boton-secundario chico"
            data-prueba="investigar"
          >
            Ver sus movimientos
          </Link>
        </article>
      ))}

      <p className="chico" data-prueba="sin-boton-reparar">
        Esta pantalla no ofrece ninguna acción. Si algo no cierra, se investiga con el historial del
        libro y se decide qué hacer; reconstruir un saldo es una operación que todavía no existe y
        que, cuando exista, va a pedir permiso, motivo y auditoría como todo lo demás.
      </p>
    </main>
  );
}
