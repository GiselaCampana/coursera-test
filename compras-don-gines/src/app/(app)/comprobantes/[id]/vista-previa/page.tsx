import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUserOrRedirect } from '@/lib/auth/session';
import { vistaPreviaDeCompra, type Procedencia } from '@/lib/services/vista-previa-compra';
import { NotFoundError } from '@/lib/errors';
import { AplicarCompra } from './AplicarCompra';

export const metadata: Metadata = { title: 'Vista previa de la compra' };
export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ id: string }>;
}

/**
 * **Lo que va a pasar si se confirma esta compra, antes de que pase.**
 *
 * La pantalla existe para una sola pregunta: ¿qué se escribe cuando aprieto
 * aplicar? Y la contesta separando las dos cosas que se escriben —el egreso que
 * se va a pagar y la mercadería que se va a mover— porque se auditan por
 * separado y se equivocan por separado.
 *
 * Cada valor viene con **de dónde salió**. La diferencia que importa no es
 * estética: un total impreso se verifica mirando el papel; un total que salió
 * de una suma es una ayuda del motor, y por eso frena la aplicación hasta que
 * alguien lo confirme contra el comprobante.
 */

const COLOR: Record<Procedencia, string> = {
  LEIDO: 'bg-emerald-50 text-emerald-900 border-emerald-200',
  INFERIDO: 'bg-sky-50 text-sky-900 border-sky-200',
  SUGERIDO: 'bg-amber-50 text-amber-900 border-amber-200',
  PENDIENTE: 'bg-rose-50 text-rose-900 border-rose-200',
};

const COMO_SE_LLAMA: Record<Procedencia, string> = {
  LEIDO: 'leído del documento',
  INFERIDO: 'inferido por relaciones',
  SUGERIDO: 'sugerencia derivada',
  PENDIENTE: 'pendiente de confirmación',
};

function Valor({
  etiqueta,
  valor,
  procedencia,
  detalle,
}: {
  etiqueta: string;
  valor: string | null;
  procedencia: Procedencia;
  detalle: string | null;
}) {
  return (
    <div className={`rounded border px-3 py-2 ${COLOR[procedencia]}`}>
      <div className="text-xs uppercase tracking-wide opacity-70">{etiqueta}</div>
      <div className="text-lg font-semibold">{valor ?? '—'}</div>
      <div className="text-xs opacity-80">
        {COMO_SE_LLAMA[procedencia]}
        {detalle ? ` · ${detalle}` : ''}
      </div>
    </div>
  );
}

export default async function VistaPreviaDeLaCompra({ params }: Props) {
  const user = await requireUserOrRedirect();
  const { id } = await params;

  let previa;
  try {
    previa = await vistaPreviaDeCompra(user, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-4">
      <header className="space-y-1">
        <Link href={`/comprobantes/${id}`} className="text-sm text-slate-600 underline">
          ← Volver al comprobante
        </Link>
        <h1 className="text-2xl font-bold">Vista previa de la compra</h1>
        <p className="text-sm text-slate-600">
          Nada de lo que se ve acá está guardado todavía. La compra se aplica sólo con el botón
          del final.
        </p>
      </header>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Emisor</h2>
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="rounded border border-slate-200 px-3 py-2">
            <div className="text-xs uppercase tracking-wide text-slate-500">Proveedor</div>
            <div className="text-lg font-semibold">{previa.emisor.nombre ?? '—'}</div>
            <div className="text-xs text-slate-600">
              {previa.emisor.habitual ? 'Proveedor registrado' : 'Todavía sin elegir'}
            </div>
          </div>
          <Valor {...previa.emisor.cuit} />
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Encabezado</h2>
        <div className="grid gap-2 sm:grid-cols-3">
          {previa.encabezado.map((campo) => (
            <Valor key={campo.etiqueta} {...campo} />
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Renglones</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="py-1 pr-2">#</th>
                <th className="py-1 pr-2">Código</th>
                <th className="py-1 pr-2">Descripción</th>
                <th className="py-1 pr-2 text-right">Cantidad</th>
                <th className="py-1 pr-2 text-right">Importe</th>
                <th className="py-1 pr-2">Producto</th>
              </tr>
            </thead>
            <tbody>
              {previa.renglones.map((renglon) => (
                <tr key={renglon.numero} className="border-b align-top">
                  <td className="py-1 pr-2">{renglon.numero}</td>
                  <td className="py-1 pr-2">{renglon.codigoDelProveedor ?? '—'}</td>
                  <td className="py-1 pr-2">{renglon.descripcion}</td>
                  <td className="py-1 pr-2 text-right">
                    {renglon.cantidad} {renglon.unidad}
                  </td>
                  <td className="py-1 pr-2 text-right">{renglon.importe}</td>
                  <td className="py-1 pr-2">
                    <span
                      className={
                        renglon.producto.estado === 'INEQUIVOCA'
                          ? 'text-emerald-800'
                          : 'text-rose-800'
                      }
                    >
                      {renglon.producto.nombre ?? 'sin asociar'}
                    </span>
                    <div className="text-xs text-slate-600">{renglon.producto.porQue}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Pie fiscal</h2>
        <div className="grid gap-2 sm:grid-cols-4">
          {previa.pieFiscal.map((campo) => (
            <Valor key={campo.etiqueta} {...campo} />
          ))}
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="space-y-2 rounded border border-slate-200 p-3">
          <h2 className="text-lg font-semibold">Egreso</h2>
          <p className="text-xs text-slate-600">
            Un solo movimiento económico: lo que se va a pagar y cuándo.
          </p>
          <Valor {...previa.egreso.total} />
          <dl className="text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-600">Vencimiento</dt>
              <dd>{previa.egreso.vencimiento ?? 'a definir al aplicar'}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-600">Condición</dt>
              <dd>{previa.egreso.condicion ?? '—'}</dd>
            </div>
          </dl>
        </section>

        <section className="space-y-2 rounded border border-slate-200 p-3">
          <h2 className="text-lg font-semibold">Movimiento de stock</h2>
          <p className="text-xs text-slate-600">
            Un movimiento por renglón asociado. Se audita aparte del egreso.
          </p>
          {previa.stock.movimientos.length === 0 ? (
            <p className="text-sm text-rose-800">Ningún renglón movería mercadería todavía.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {previa.stock.movimientos.map((movimiento) => (
                <li key={movimiento.renglon} className="flex justify-between gap-2">
                  <span>{movimiento.producto}</span>
                  <span className="whitespace-nowrap text-slate-600">
                    {movimiento.cantidad} {movimiento.unidad} · {movimiento.costoTotal}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {previa.stock.renglonesSinMovimiento > 0 && (
            <p className="text-xs text-rose-800">
              {previa.stock.renglonesSinMovimiento} renglón/es no moverían nada porque no están
              asociados de forma inequívoca.
            </p>
          )}
        </section>
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Aplicar</h2>
        {previa.frenos.length > 0 && (
          <ul className="list-inside list-disc space-y-1 rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
            {previa.frenos.map((freno) => (
              <li key={freno}>{freno}</li>
            ))}
          </ul>
        )}
        <AplicarCompra documentId={id} sePuedeAplicar={previa.sePuedeAplicar} />
      </section>
    </main>
  );
}
