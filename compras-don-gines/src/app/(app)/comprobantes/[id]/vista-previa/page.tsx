import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUserOrRedirect } from '@/lib/auth/session';
import { vistaPreviaDeCompra, type Procedencia } from '@/lib/services/vista-previa-compra';
import { formatARS, formatQty } from '@/lib/money';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABEL } from '@/lib/domain/payments';
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
 *
 * Los importes se formatean acá y no en el servicio: el servicio devuelve el
 * valor canónico —el que se compara y se guarda— y la pantalla lo escribe como
 * se lee en el mostrador.
 */

/**
 * Las formas de pago que ya usa el sistema, sin catálogo paralelo.
 *
 * Se arma acá, en el servidor, para que la pantalla no pueda ofrecer una que
 * el servidor después rechace.
 */
const FORMAS_DE_PAGO = PAYMENT_METHODS.map((codigo) => ({
  codigo,
  nombre: PAYMENT_METHOD_LABEL[codigo] ?? codigo,
}));

/** El semáforo del control contable, que ya significa esto en toda la aplicación. */
const CHIP: Record<Procedencia, string> = {
  LEIDO: 'estado-ok',
  INFERIDO: 'estado-info',
  SUGERIDO: 'estado-aviso',
  PENDIENTE: 'estado-error',
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
  dinero = false,
}: {
  etiqueta: string;
  valor: string | null;
  procedencia: Procedencia;
  detalle: string | null;
  dinero?: boolean;
}) {
  return (
    <div className="indicador">
      <div className="indicador-etiqueta">{etiqueta}</div>
      <div className="indicador-valor num">
        {valor === null ? '—' : dinero ? formatARS(valor) : valor}
      </div>
      <div className="indicador-detalle">
        <span className={`etiqueta-estado ${CHIP[procedencia]}`}>
          {COMO_SE_LLAMA[procedencia]}
        </span>
        {detalle ? <div style={{ marginTop: 4 }}>{detalle}</div> : null}
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
    <>
      <p style={{ marginBottom: 6 }}>
        <Link href={`/comprobantes/${id}`} className="chico">
          ← Volver al comprobante
        </Link>
      </p>
      <h1>Vista previa de la compra</h1>
      <p className="ayuda" style={{ marginBottom: 16 }}>
        Nada de lo que se ve acá está guardado todavía. La compra se aplica sólo con el botón
        del final.
      </p>

      <section className="card">
        <div className="card-titulo">
          <h2>Emisor</h2>
        </div>
        <div className="indicadores" style={{ marginBottom: 0 }}>
          <div className="indicador">
            <div className="indicador-etiqueta">Proveedor</div>
            <div className="indicador-valor">{previa.emisor.nombre ?? '—'}</div>
            <div className="indicador-detalle">
              <span
                className={`etiqueta-estado ${previa.emisor.habitual ? 'estado-ok' : 'estado-error'}`}
              >
                {previa.emisor.habitual ? 'proveedor registrado' : 'todavía sin elegir'}
              </span>
            </div>
          </div>
          <Valor {...previa.emisor.cuit} />
        </div>
      </section>

      <section className="card">
        <div className="card-titulo">
          <h2>Encabezado</h2>
        </div>
        <div className="indicadores" style={{ marginBottom: 0 }}>
          {previa.encabezado.map((campo) => (
            <Valor key={campo.etiqueta} {...campo} />
          ))}
        </div>
      </section>

      <section className="card">
        <div className="card-titulo">
          <h2>Renglones</h2>
        </div>
        <div className="tabla-scroll">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Código</th>
                <th>Descripción</th>
                <th className="num">Cantidad</th>
                <th className="num">Importe</th>
                <th>Producto</th>
              </tr>
            </thead>
            <tbody>
              {previa.renglones.map((renglon) => (
                <tr key={renglon.numero}>
                  <td>{renglon.numero}</td>
                  <td className="num">{renglon.codigoDelProveedor ?? '—'}</td>
                  <td>{renglon.descripcion}</td>
                  <td className="num">
                    {formatQty(renglon.cantidad, 3)} {renglon.unidad}
                  </td>
                  <td className="num">{formatARS(renglon.importe)}</td>
                  <td>
                    {/*
                      Un gasto no está «sin asociar»: está resuelto de otra
                      manera. Mostrarlo en rojo como si le faltara un artículo
                      mandaría a buscar algo que no existe.
                    */}
                    <span
                      className={`etiqueta-estado ${
                        renglon.gasto
                          ? 'estado-info'
                          : renglon.producto.estado === 'INEQUIVOCA'
                            ? 'estado-ok'
                            : 'estado-error'
                      }`}
                    >
                      {renglon.gasto
                        ? `${renglon.gasto.comoSeLlama} · sin impacto en stock`
                        : (renglon.producto.nombre ?? 'sin asociar')}
                    </span>
                    <div className="chico suave" style={{ marginTop: 4 }}>
                      {renglon.gasto ? renglon.gasto.porQue : renglon.producto.porQue}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="card-titulo">
          <h2>Pie fiscal</h2>
        </div>
        <div className="indicadores" style={{ marginBottom: 0 }}>
          {previa.pieFiscal.map((campo) => (
            <Valor key={campo.etiqueta} {...campo} dinero />
          ))}
        </div>
      </section>

      {/*
        Las dos escrituras, una al lado de la otra.
        Quien firma la compra mira la de la izquierda y quien controla la
        mercadería la de la derecha; verlas juntas es lo que deja comparar el
        total que se paga contra lo que efectivamente entra.
      */}
      <div className="fila fila-2">
        <section className="card">
          <div className="card-titulo">
            <h2>Egreso</h2>
          </div>
          <p className="ayuda">Un solo movimiento económico: lo que se va a pagar y cuándo.</p>
          <div className="indicadores" style={{ gridTemplateColumns: '1fr', marginBottom: 10 }}>
            <Valor {...previa.egreso.total} dinero />
            {/*
              La condición va con su procedencia y no como un dato suelto: un
              plazo que no se puede atribuir a este proveedor decide cuándo sale
              la plata, y ahí conviene que diga que falta en vez de mostrar un
              número prestado.
            */}
            <Valor
              {...previa.egreso.condicion}
              valor={previa.egreso.condicion.valor ?? 'a definir al aplicar'}
            />
            {/*
              El vencimiento, también con su procedencia.
              Era un dato suelto que decía «a definir al aplicar» mientras al
              aplicar se rellenaba con la fecha de emisión. Ahora o sale de una
              condición acordada —y dice la cuenta— o está pendiente y frena.
            */}
            <Valor
              {...previa.egreso.vencimiento}
              valor={previa.egreso.vencimiento.valor ?? 'a definir al aplicar'}
            />
          </div>
        </section>

        <section className="card">
          <div className="card-titulo">
            <h2>Movimiento de stock</h2>
          </div>
          <p className="ayuda">Un movimiento por renglón asociado. Se audita aparte del egreso.</p>
          {previa.stock.movimientos.length === 0 ? (
            <p className="mensaje mensaje-aviso">Ningún renglón movería mercadería todavía.</p>
          ) : (
            <ul className="lista-simple">
              {previa.stock.movimientos.map((movimiento) => (
                <li key={movimiento.renglon}>
                  <strong>{movimiento.producto}</strong>
                  <div className="chico suave">
                    {formatQty(movimiento.cantidad, 3)} {movimiento.unidad} ·{' '}
                    {formatARS(movimiento.costoTotal)}
                  </div>
                  {movimiento.porQueEsaUnidad ? (
                    <div className="chico suave">{movimiento.porQueEsaUnidad}</div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {previa.stock.renglonesSinMovimiento > 0 && (
            <p className="mensaje mensaje-aviso">
              {previa.stock.renglonesSinMovimiento} renglón/es no moverían nada porque no están
              asociados de forma inequívoca.
            </p>
          )}

          {/*
            Los gastos, en el mismo recuadro del stock y claramente separados.
            Van acá porque la pregunta que contestan es la misma —¿qué entra a
            la heladera?— y la respuesta es «esto no».
          */}
          {previa.gastos.length > 0 && (
            <>
              <h3 style={{ marginTop: 14 }}>Sin impacto en stock</h3>
              <p className="ayuda">
                Se paga con la factura y no mueve existencias. Su costo no se reparte entre los
                artículos: eso sería una decisión contable aparte.
              </p>
              <ul className="lista-simple">
                {previa.gastos.map((gasto) => (
                  <li key={gasto.renglon}>
                    <strong>{gasto.descripcion}</strong>
                    <div className="chico suave">
                      {formatQty(gasto.cantidad, 3)} {gasto.unidad} · {formatARS(gasto.importe)} ·{' '}
                      {gasto.comoSeLlama}
                    </div>
                    <div className="chico suave">{gasto.porQue}</div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>

      <section className="card">
        <div className="card-titulo">
          <h2>Aplicar</h2>
        </div>
        {previa.frenos.length > 0 && (
          <div className="mensaje mensaje-aviso">
            <strong>Todavía no se puede aplicar:</strong>
            <ul className="lista-simple" style={{ marginTop: 6 }}>
              {previa.frenos.map((freno) => (
                <li key={freno}>{freno}</li>
              ))}
            </ul>
          </div>
        )}
        <AplicarCompra
          documentId={id}
          sePuedeAplicar={previa.sePuedeAplicar}
          hayQueElegirComoSePaga={previa.egreso.hayQueElegirComoSePaga}
          formasDePago={FORMAS_DE_PAGO}
        />
      </section>
    </>
  );
}
