import type { Metadata } from 'next';
import Link from 'next/link';
import { requireUserOrRedirect, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import { formatCorteAr } from '@/lib/datetime';
import {
  mermasRegistradas,
  recuentosDeLaSucursal,
  operacionesReversibles,
  interruptorDeCorreccionesReales,
  CATEGORIAS_DE_MERMA,
} from '@/lib/services/stock-erp-correcciones';
import { EnPreparacion } from '../EnPreparacion';
import { AbrirRecuento } from './AbrirRecuento';

export const metadata: Metadata = { title: 'Stock ERP · Correcciones' };
export const dynamic = 'force-dynamic';

/**
 * El tablero de correcciones operativas: mermas, recuentos y reversiones.
 *
 * Las tres cosas viven juntas porque son la misma familia —corregir lo que el
 * libro dice— y porque conviene que quien entra a dar de baja una merma vea que
 * existe el recuento: muchas veces lo que hace falta no es descontar a mano sino
 * contar la góndola.
 *
 * **No hay ningún campo para sumar o restar existencias.** Es deliberado: cada
 * corrección entra por su forma, con su causa.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ sucursal?: string }>;
}) {
  const { sucursal } = await searchParams;
  const user = await requireUserOrRedirect();

  if (!hasPermission(user, PERMISSIONS.STOCKERP_VER)) {
    return (
      <main className="contenido">
        <p className="mensaje mensaje-error">
          Tu usuario no puede ver Stock ERP. El permiso «stockerp.ver» se pide desde Configuración →
          Roles.
        </p>
      </main>
    );
  }

  const [sucursales, interruptor, mermas, recuentos, reversibles] = await Promise.all([
    prisma.branch.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    interruptorDeCorreccionesReales(),
    mermasRegistradas(user, { branchId: sucursal ?? null, limite: 25 }),
    recuentosDeLaSucursal(user, { branchId: sucursal ?? null }),
    operacionesReversibles(user, { branchId: sucursal ?? null, limite: 25 }),
  ]);

  const etiqueta = new Map(CATEGORIAS_DE_MERMA.map((c) => [c.valor, c.etiqueta]));
  const puedePreparar = hasPermission(user, PERMISSIONS.STOCKERP_RECUENTO_PREPARAR);
  const puedeMermar = hasPermission(user, PERMISSIONS.STOCKERP_MERMA);

  return (
    <main className="contenido">
      <EnPreparacion>
        Las correcciones cambian el saldo sin ningún comprobante detrás; las ventas todavía no
        descuentan.
      </EnPreparacion>

      <p className="chico">
        <Link href="/stock-erp/existencias">← Existencias</Link>{' '}
        <Link href="/stock-erp/movimientos">Movimientos →</Link>{' '}
        <Link href="/stock-erp/traslados">Traslados →</Link>
      </p>
      <h1>Correcciones operativas</h1>
      <p className="chico">
        Tres cosas distintas, y ninguna «entrada manual»: una <strong>merma</strong> es una pérdida
        con causa conocida; un <strong>recuento correctivo</strong> es contar lo que hay y dejar que
        el servidor calcule la diferencia; una <strong>reversión</strong> agrega asientos inversos y
        nunca borra nada del libro.
      </p>

      <p
        className={interruptor.encendido ? 'mensaje mensaje-aviso' : 'mensaje'}
        data-prueba="interruptor-correcciones"
      >
        Correcciones con existencias reales:{' '}
        <strong>{interruptor.encendido ? 'habilitadas' : 'apagado'}</strong>.{' '}
        {interruptor.encendido ? (
          <>
            Cambiado por {interruptor.cambiadoPor ?? 'alguien'} el{' '}
            {formatCorteAr(interruptor.cambiadoEl)}
            {interruptor.motivo ? `: ${interruptor.motivo}` : null}
          </>
        ) : (
          <>
            Sobre una apertura ficticia se puede practicar en una base de pruebas; sobre un
            inventario real, una corrección no se aplica hasta que alguien encienda el interruptor
            con su nombre y su motivo.
          </>
        )}
      </p>

      <form method="get" className="filtros" data-prueba="filtro-sucursal">
        <label>
          Sucursal
          <select name="sucursal" defaultValue={sucursal ?? ''}>
            <option value="">Todas</option>
            {sucursales.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Filtrar</button>
      </form>

      <p className="chico">
        {puedeMermar ? (
          <Link href="/stock-erp/correcciones/mermas" data-prueba="ir-a-nueva-merma">
            Registrar una merma →
          </Link>
        ) : (
          <span data-prueba="sin-permiso-merma">
            Registrar una merma exige el permiso «stockerp.merma».
          </span>
        )}
      </p>

      {puedePreparar && <AbrirRecuento sucursales={sucursales} />}

      {/* --- Recuentos ---------------------------------------------------- */}
      <section data-prueba="grupo-recuentos">
        <h2>Recuentos ({recuentos.length})</h2>
        <p className="chico">
          Contar lo que hay. La diferencia la calcula el servidor contra el saldo que bloquea al
          confirmar: acá no se escribe ningún delta.
        </p>
        {recuentos.length === 0 ? (
          <p className="chico" data-prueba="grupo-vacio">
            Ninguno.
          </p>
        ) : (
          <ul className="lista-simple">
            {recuentos.map((r) => (
              <li key={r.id} data-prueba="fila-recuento" data-estado={r.estado}>
                <Link href={`/stock-erp/correcciones/recuentos/${r.id}`}>{r.nombre}</Link> ·{' '}
                {r.sucursal} · <span data-prueba="estado">{r.estado}</span> · {r.lineas}{' '}
                {r.lineas === 1 ? 'artículo' : 'artículos'}
                <br />
                <span className="chico">
                  Abierto el {formatCorteAr(r.abiertaEl)}
                  {r.cerradaEl ? ` · cerrado el ${formatCorteAr(r.cerradaEl)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* --- Mermas ------------------------------------------------------- */}
      <section data-prueba="grupo-mermas">
        <h2>Mermas ({mermas.length})</h2>
        {mermas.length === 0 ? (
          <p className="chico" data-prueba="grupo-vacio">
            Ninguna.
          </p>
        ) : (
          <ul className="lista-simple">
            {mermas.map((m) => (
              <li key={m.id} data-prueba="fila-merma" data-revertida={m.revertida ? 'si' : 'no'}>
                <strong data-prueba="cantidad">{m.cantidad}</strong>{' '}
                <span data-prueba="unidad">{m.unidad}</span> de{' '}
                <span data-prueba="articulo">{m.articulo}</span> (PLU {m.plu}) en {m.sucursal}
                <br />
                <span className="chico">
                  <span data-prueba="categoria">{etiqueta.get(m.categoria) ?? m.categoria}</span> ·{' '}
                  <span data-prueba="motivo">{m.motivo}</span>
                  {m.detalle ? ` · ${m.detalle}` : ''} · {formatCorteAr(m.ocurrioEl)} ·{' '}
                  <span data-prueba="usuario">{m.registradaPor ?? '—'}</span>
                </span>
                <br />
                <span className="chico">
                  Saldo: <span data-prueba="saldo-anterior">{m.saldoAnterior ?? '—'}</span> →{' '}
                  <span data-prueba="saldo-resultante">{m.saldoResultante ?? '—'}</span> {m.unidad} ·{' '}
                  <Link
                    href={`/stock-erp/movimientos?operacion=${m.operationId}`}
                    data-prueba="ver-en-el-libro"
                  >
                    operación {m.operationId.slice(-8)} →
                  </Link>
                </span>
                <br />
                {m.revertida ? (
                  <span className="chico" data-prueba="ya-revertida">
                    Revertida por {m.revertidaPor ?? 'alguien'} el {formatCorteAr(m.revertidaEl)}
                  </span>
                ) : (
                  <Link
                    href={`/stock-erp/correcciones/reversiones/${m.operationId}`}
                    data-prueba="ir-a-revertir"
                  >
                    Revertir esta merma →
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* --- Reversibles -------------------------------------------------- */}
      <section data-prueba="grupo-reversibles">
        <h2>Se puede revertir ({reversibles.filter((r) => r.impedimentos.length === 0).length})</h2>
        <p className="chico">
          Sólo mermas, ajustes de recuento y despachos de traslado todavía en tránsito. Una apertura,
          una recepción de compra o un traslado ya recibido no se revierten en esta etapa.
        </p>
        {reversibles.length === 0 ? (
          <p className="chico" data-prueba="grupo-vacio">
            Nada por ahora.
          </p>
        ) : (
          <ul className="lista-simple">
            {reversibles.map((r) => (
              <li
                key={r.operationId}
                data-prueba="fila-reversible"
                data-clase={r.clase}
                data-bloqueada={r.impedimentos.length > 0 ? 'si' : 'no'}
              >
                <Link href={`/stock-erp/correcciones/reversiones/${r.operationId}`}>
                  {r.descripcion}
                </Link>{' '}
                · {r.sucursal} · {formatCorteAr(r.momento)} · {r.movimientos.length}{' '}
                {r.movimientos.length === 1 ? 'movimiento' : 'movimientos'}
                {r.impedimentos.length > 0 && (
                  <>
                    <br />
                    <span className="chico" data-prueba="impedimento">
                      {r.impedimentos.join(' ')}
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
