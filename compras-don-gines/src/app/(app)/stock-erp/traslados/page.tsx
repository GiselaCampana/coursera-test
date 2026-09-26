import type { Metadata } from 'next';
import Link from 'next/link';
import { requireUserOrRedirect, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import { formatCorteAr } from '@/lib/datetime';
import {
  listadoDeTraslados,
  mercaderiaEnTransito,
  interruptorDeTrasladosReales,
  type FilaDeTraslado,
} from '@/lib/services/stock-erp-traslados';
import { EnPreparacion } from '../EnPreparacion';
import { NuevoTraslado } from './NuevoTraslado';

export const metadata: Metadata = { title: 'Stock ERP · Traslados' };
export const dynamic = 'force-dynamic';

/**
 * El listado de traslados, en cuatro grupos que son cuatro momentos.
 *
 * **En tránsito es un grupo propio, y es el importante.** Un traslado despachado
 * y no recibido es mercadería que ya no está en el origen y todavía no está en
 * el destino: si esta pantalla no lo mostrara aparte, esa mercadería
 * desaparecería de la vista de las dos sucursales, que es exactamente la forma
 * en que se pierde stock sin que nadie note nada.
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

  const [sucursales, interruptor, listado, enTransito] = await Promise.all([
    prisma.branch.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    interruptorDeTrasladosReales(),
    listadoDeTraslados(user, { sucursalId: sucursal ?? null }),
    mercaderiaEnTransito({}),
  ]);

  const puedePreparar = hasPermission(user, PERMISSIONS.STOCKERP_TRASLADO_PREPARAR);

  return (
    <main className="contenido">
      <EnPreparacion>
        Un traslado mueve saldo de una sucursal a otra; las ventas todavía no descuentan de ninguna
        de las dos.
      </EnPreparacion>

      <h1>Traslados entre sucursales</h1>
      <p className="chico">
        Un traslado son <strong>dos hechos físicos</strong>: el despacho saca la mercadería del
        origen y la recepción la ingresa al destino. Entre los dos, la mercadería está en tránsito:
        ya no está donde estaba y todavía no llegó. Esta fase no resuelve diferencias físicas —si lo
        que llega no coincide con lo que salió, el traslado se queda en tránsito y no se ajusta nada.
      </p>
      <p className="chico">
        Control de Stock Don Ginés sigue siendo una aplicación aparte. Esta pantalla{' '}
        <strong>no le envía nada</strong>.
      </p>

      <p
        className={interruptor.encendido ? 'mensaje mensaje-aviso' : 'mensaje'}
        data-prueba="interruptor-traslados"
      >
        Traslados con mercadería real:{' '}
        <strong>{interruptor.encendido ? 'habilitados' : 'apagado'}</strong>.{' '}
        {interruptor.encendido ? (
          <>
            Cambiado por {interruptor.cambiadoPor ?? 'alguien'} el{' '}
            {formatCorteAr(interruptor.cambiadoEl)}
            {interruptor.motivo ? `: ${interruptor.motivo}` : null}
          </>
        ) : (
          <>
            Sobre una apertura ficticia se puede practicar en una base de pruebas; sobre un
            inventario real, un traslado no se aplica hasta que alguien encienda el interruptor con
            su nombre y su motivo.
          </>
        )}
      </p>

      {/* El filtro por sucursal: GET, sin acción de servidor. */}
      <form method="get" className="filtros" data-prueba="filtro-sucursal">
        <label>
          Sucursal (origen o destino)
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

      {puedePreparar ? (
        <NuevoTraslado sucursales={sucursales} />
      ) : (
        <p className="chico" data-prueba="sin-permiso-preparar">
          Para armar un traslado hace falta el permiso «stockerp.traslado.preparar».
        </p>
      )}

      <Grupo
        nombre="en-transito"
        titulo={`En tránsito (${listado.enTransito.length})`}
        explicacion="Salieron del origen y todavía no llegaron. Esta mercadería no es saldo de ninguna de las dos sucursales."
        filas={listado.enTransito}
      />

      {enTransito.length > 0 && (
        <section data-prueba="detalle-en-transito">
          <h3>Qué hay en tránsito, artículo por artículo</h3>
          <ul className="lista-simple">
            {enTransito.map((t) => (
              <li key={`${t.trasladoId}-${t.productId}`} data-prueba="renglon-en-transito">
                <strong>
                  {t.cantidad} {t.unidad}
                </strong>{' '}
                de {t.articulo} (PLU {t.plu}) — de {t.origen} a {t.destino}, despachado el{' '}
                {formatCorteAr(t.despachadoEl)}{' '}
                <Link href={`/stock-erp/traslados/${t.trasladoId}`}>ver traslado</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Grupo
        nombre="borradores"
        titulo={`Borradores (${listado.borradores.length})`}
        explicacion="Se están preparando. No escribieron nada en el libro y se pueden editar o cancelar."
        filas={listado.borradores}
      />
      <Grupo
        nombre="cerrados"
        titulo={`Cerrados (${listado.cerrados.length})`}
        explicacion="Llegaron al destino. No se reciben dos veces y no se editan."
        filas={listado.cerrados}
      />
      <Grupo
        nombre="cancelados"
        titulo={`Cancelados (${listado.cancelados.length})`}
        explicacion="Borradores descartados. Nunca tocaron el libro."
        filas={listado.cancelados}
      />
    </main>
  );
}

function Grupo({
  nombre,
  titulo,
  explicacion,
  filas,
}: {
  nombre: string;
  titulo: string;
  explicacion: string;
  filas: FilaDeTraslado[];
}) {
  return (
    <section data-prueba={`grupo-${nombre}`}>
      <h2>{titulo}</h2>
      <p className="chico">{explicacion}</p>
      {filas.length === 0 ? (
        <p className="chico" data-prueba="grupo-vacio">
          Ninguno.
        </p>
      ) : (
        <ul className="lista-simple">
          {filas.map((f) => (
            <li key={f.id} data-prueba="fila-traslado" data-estado={f.estado}>
              <Link href={`/stock-erp/traslados/${f.id}`}>
                {f.origen} → {f.destino}
              </Link>{' '}
              · {f.renglones} {f.renglones === 1 ? 'artículo' : 'artículos'} ·{' '}
              <span data-prueba="estado">{f.estado}</span>
              <br />
              <span className="chico">
                Creado el {formatCorteAr(f.creadoEl)}
                {f.despachadoEl ? ` · despachado el ${formatCorteAr(f.despachadoEl)}` : ''}
                {f.recibidoEl ? ` · recibido el ${formatCorteAr(f.recibidoEl)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
