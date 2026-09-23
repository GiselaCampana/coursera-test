import type { Metadata } from 'next';
import Link from 'next/link';
import { requireUserOrRedirect, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import { formatCorteAr } from '@/lib/datetime';
import { interruptorDeAperturasReales, estadoDeLinea } from '@/lib/services/stock-erp-apertura';
import { PrepararApertura } from './PrepararApertura';

export const metadata: Metadata = { title: 'Stock ERP · Aperturas' };
export const dynamic = 'force-dynamic';

/**
 * Las aperturas, por sucursal.
 *
 * Lo primero de cada sucursal sin apertura es la frase **«Sucursal sin apertura
 * de Stock ERP»**, y está antes que cualquier número a propósito: sin ella, una
 * sucursal sin datos se ve igual que una sucursal con todo en cero, que es
 * precisamente la confusión que este módulo no puede permitirse.
 */
export default async function Page() {
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

  const sucursales = await prisma.branch.findMany({ orderBy: { name: 'asc' } });
  const sesiones = await prisma.stockCountSession.findMany({
    where: { status: { in: ['BORRADOR', 'CONFIRMADA'] } },
    include: {
      branch: { select: { name: true } },
      confirmedBy: { select: { name: true } },
      activations: { select: { state: true, countedQuantity: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  const interruptor = await interruptorDeAperturasReales();

  const porSucursal = new Map(sesiones.map((s) => [s.branchId, s]));

  return (
    <main className="contenido">
      <p className="mensaje mensaje-aviso" data-prueba="stock-erp-en-preparacion">
        <strong>Stock ERP en preparación</strong> — todavía no incluye ventas. Esta pantalla registra
        el inventario físico que inaugura cada sucursal; no hay recepciones, traslados ni ajustes.
      </p>

      <h1>Aperturas de existencias</h1>
      <p className="chico">
        Control de Stock Don Ginés sigue siendo una aplicación aparte. La apertura se cuenta a mano
        acá dentro y no copia ninguna cantidad de allá.
      </p>

      <p
        className={interruptor.encendido ? 'mensaje mensaje-aviso' : 'mensaje'}
        data-prueba="interruptor"
      >
        Aperturas con datos reales:{' '}
        <strong>{interruptor.encendido ? 'HABILITADAS' : 'deshabilitadas'}</strong>.{' '}
        {interruptor.encendido
          ? `Lo habilitó ${interruptor.cambiadoPor ?? 'alguien'}: ${interruptor.motivo ?? ''}`
          : 'Sólo se pueden confirmar aperturas de datos ficticios, y únicamente contra una base de pruebas.'}
      </p>

      {sucursales.map((s) => {
        const sesion = porSucursal.get(s.id);
        const resumen = { PENDIENTE: 0, CONTADO: 0, CONTADO_CERO: 0, NO_SE_MANEJA: 0, BLOQUEADO_UNIDAD: 0 };
        for (const a of sesion?.activations ?? []) resumen[estadoDeLinea(a)] += 1;

        return (
          <article className="tarjeta" key={s.id} data-prueba="sucursal" data-sucursal={s.code}>
            <header style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <strong style={{ flex: 1 }}>{s.name}</strong>
              <span className="chico" data-prueba="estado-sucursal">
                {sesion?.status === 'CONFIRMADA'
                  ? 'Con apertura confirmada'
                  : sesion
                    ? 'Borrador en preparación'
                    : 'Sin apertura'}
              </span>
            </header>

            {!sesion && (
              <p className="mensaje mensaje-aviso" data-prueba="sin-apertura">
                <strong>Sucursal sin apertura de Stock ERP.</strong> Sus artículos no tienen saldo, y
                eso no es lo mismo que tener cero: todavía no se contaron. Hasta que haya una
                apertura confirmada, las futuras recepciones y demás operaciones quedan bloqueadas.
              </p>
            )}

            {sesion && (
              <>
                <dl
                  style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 10px', margin: '10px 0' }}
                >
                  <dt className="chico">Corte</dt>
                  <dd className="chico" style={{ margin: 0 }} data-prueba="corte">
                    {formatCorteAr(sesion.cutoffAt)}
                  </dd>
                  {sesion.status === 'CONFIRMADA' && (
                    <>
                      <dt className="chico">Confirmada por</dt>
                      <dd className="chico" style={{ margin: 0 }}>
                        {sesion.confirmedBy?.name ?? '—'}
                      </dd>
                    </>
                  )}
                  <dt className="chico">Datos</dt>
                  <dd className="chico" style={{ margin: 0 }} data-prueba="ficticia">
                    {sesion.ficticia ? 'ficticios (homologación)' : 'reales'}
                  </dd>
                </dl>

                <p className="chico" data-prueba="resumen-sucursal">
                  {resumen.PENDIENTE} pendientes · {resumen.CONTADO} contados · {resumen.CONTADO_CERO}{' '}
                  en cero · {resumen.NO_SE_MANEJA} no manejados · {resumen.BLOQUEADO_UNIDAD}{' '}
                  bloqueados por unidad
                </p>

                <Link
                  href={`/stock-erp/aperturas/${sesion.id}`}
                  className="boton"
                  data-prueba="abrir-apertura"
                >
                  {sesion.status === 'CONFIRMADA' ? 'Ver la apertura' : 'Preparar y contar'}
                </Link>
              </>
            )}

            {!sesion && hasPermission(user, PERMISSIONS.STOCKERP_APERTURA_PREPARAR) && (
              <PrepararApertura branchId={s.id} sucursal={s.name} />
            )}
          </article>
        );
      })}
    </main>
  );
}
