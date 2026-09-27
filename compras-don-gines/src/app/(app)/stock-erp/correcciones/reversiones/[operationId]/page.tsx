import type { Metadata } from 'next';
import Link from 'next/link';
import { requireUserOrRedirect, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import { formatCorteAr } from '@/lib/datetime';
import { operacionReversible } from '@/lib/services/stock-erp-correcciones';
import { EnPreparacion } from '../../../EnPreparacion';
import { Reversion } from './Reversion';

export const metadata: Metadata = { title: 'Stock ERP · Reversión' };
export const dynamic = 'force-dynamic';

/**
 * Revertir una operación: los asientos inversos, con el original a la vista.
 *
 * La pantalla muestra **lo que la operación escribió** —cada movimiento, con su
 * cantidad y su unidad— y al lado lo que la reversión va a escribir: el mismo
 * renglón en el sentido contrario. Eso es todo lo que hace una reversión acá.
 *
 * **Nada se borra y nada se edita.** El libro conserva el asiento original y la
 * reversión se suma después, con su propio momento, su propio autor y su motivo.
 * Por eso no hay ningún campo para «corregir» el movimiento viejo: si el número
 * original estaba mal, se revierte y se registra el bueno.
 */
export default async function Page({
  params,
}: {
  params: Promise<{ operationId: string }>;
}) {
  const { operationId } = await params;
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

  const operacion = await operacionReversible(user, operationId);

  /*
   * El vínculo con el libro, para las dos direcciones: la operación original y —si
   * ya se revirtió— la reversión que la dejó sin efecto. Se lee acá y no en el
   * servicio porque es información de pantalla: el servicio ya dijo lo único que
   * decide, que es si se puede revertir.
   */
  const [reversion, merma, linea, traslado, asientos] = await Promise.all([
    prisma.stockOperation.findFirst({
      where: { reversesOperationId: operationId },
      select: {
        id: true,
        appliedAt: true,
        requestedBy: { select: { name: true } },
        ledger: { orderBy: { seq: 'asc' }, take: 1, select: { reason: true } },
      },
    }),
    prisma.stockWaste.findUnique({
      where: { operationId },
      select: {
        reason: true,
        detail: true,
        category: true,
        occurredAt: true,
        createdBy: { select: { name: true } },
      },
    }),
    prisma.stockCountLine.findUnique({
      where: { operationId },
      select: {
        expectedQuantity: true,
        countedQuantity: true,
        difference: true,
        unit: true,
        confirmedBy: { select: { name: true } },
        session: { select: { id: true, name: true } },
      },
    }),
    prisma.stockTransfer.findUnique({
      where: { operationId },
      select: {
        id: true,
        status: true,
        dispatchedBy: { select: { name: true } },
        fromBranch: { select: { name: true } },
        toBranch: { select: { name: true } },
      },
    }),
    /*
     * El motivo escrito de un ajuste de recuento vive en el asiento del libro,
     * no en la línea: es el movimiento el que tiene que poder explicarse solo.
     */
    prisma.stockLedger.findMany({
      where: { operationId, reversesId: null },
      orderBy: { seq: 'asc' },
      select: { id: true, reason: true },
    }),
  ]);
  const motivoOriginal = asientos[0]?.reason ?? null;

  return (
    <main className="contenido">
      <EnPreparacion>
        Una reversión mueve el saldo del módulo; no se comunica con Control de Stock ni con las
        ventas.
      </EnPreparacion>

      <p className="chico">
        <Link href="/stock-erp/correcciones">← Correcciones</Link>{' '}
        <Link href={`/stock-erp/movimientos?operacion=${operationId}`} data-prueba="ver-en-el-libro">
          Ver el asiento en el libro →
        </Link>
      </p>

      <h1>Revertir</h1>
      <p className="chico" data-prueba="que-es" data-clase={operacion.clase}>
        <strong>{operacion.descripcion}</strong> · {operacion.sucursal} ·{' '}
        {formatCorteAr(operacion.momento)} · operación{' '}
        <span data-prueba="operacion">{operationId.slice(-8)}</span> ·{' '}
        <span data-prueba="estado-reversion">
          {operacion.yaRevertida || reversion !== null ? 'revertida' : 'sin revertir'}
        </span>
      </p>

      {/* Qué fue esto, en las palabras de quien lo registró. */}
      {merma && (
        <section data-prueba="origen-merma">
          <p className="chico" style={{ overflowWrap: 'anywhere' }}>
            Categoría <span data-prueba="categoria">{merma.category}</span> · motivo:{' '}
            <span data-prueba="motivo-original">{merma.reason}</span>
            {merma.detail ? ` · ${merma.detail}` : ''} · registrada por{' '}
            <span data-prueba="autor-original">{merma.createdBy?.name ?? '—'}</span> ·{' '}
            {formatCorteAr(merma.occurredAt)}
          </p>
        </section>
      )}
      {linea && (
        <section data-prueba="origen-recuento">
          <p className="chico" style={{ overflowWrap: 'anywhere' }}>
            Del recuento{' '}
            <Link href={`/stock-erp/correcciones/recuentos/${linea.session.id}`}>
              {linea.session.name}
            </Link>
            : el sistema tenía{' '}
            <span data-prueba="saldo-anterior">{linea.expectedQuantity.toString()}</span>, se contó{' '}
            <span data-prueba="cantidad-fisica">{linea.countedQuantity.toString()}</span>, diferencia{' '}
            <strong data-prueba="diferencia">{linea.difference.toString()}</strong>{' '}
            <span data-prueba="unidad">{linea.unit}</span> · motivo:{' '}
            <span data-prueba="motivo-original">{motivoOriginal ?? '—'}</span> · confirmado por{' '}
            <span data-prueba="autor-original">{linea.confirmedBy?.name ?? '—'}</span>
          </p>
        </section>
      )}
      {traslado && (
        <section data-prueba="origen-traslado">
          <p className="chico" style={{ overflowWrap: 'anywhere' }}>
            Traslado{' '}
            <Link href={`/stock-erp/traslados/${traslado.id}`}>
              {traslado.fromBranch.name} → {traslado.toBranch.name}
            </Link>{' '}
            · <span data-prueba="estado-traslado">{traslado.status}</span> · despachado por{' '}
            <span data-prueba="autor-original">{traslado.dispatchedBy?.name ?? '—'}</span>
          </p>
          <p className="chico">
            La reversión devuelve la mercadería al <strong>origen</strong> y no escribe nada en el
            destino, porque el destino todavía no la recibió. El traslado queda{' '}
            <strong>reversado</strong>: no vuelve a ser un borrador editable.
          </p>
        </section>
      )}

      {/* Si ya se revirtió, esto es historia y no hay nada que confirmar. */}
      {reversion && (
        <p className="mensaje mensaje-ok" data-prueba="ya-revertida">
          Ya revertida por {reversion.requestedBy?.name ?? 'alguien'} el{' '}
          {formatCorteAr(reversion.appliedAt)}
          {reversion.ledger[0]?.reason ? `: ${reversion.ledger[0].reason}` : ''}.{' '}
          <Link
            href={`/stock-erp/movimientos?operacion=${reversion.id}`}
            data-prueba="ver-reversion-en-el-libro"
          >
            Ver los asientos inversos →
          </Link>
        </p>
      )}

      <Reversion
        operacion={operacion}
        yaHayReversion={reversion !== null}
        puedeRevertir={hasPermission(user, PERMISSIONS.STOCKERP_REVERSAR)}
      />
    </main>
  );
}
