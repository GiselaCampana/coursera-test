import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUserOrRedirect, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { getDocumentForReview } from '@/lib/services/documents';
import { diagnosticarDerivados } from '@/lib/services/reparar-derivados';
import { notasDeCreditoDe } from '@/lib/services/notas-credito';
import { MOTIVO_DE_CREDITO_LABEL, type MotivoDeCredito } from '@/lib/domain/notas-credito';
import { getStorage } from '@/lib/storage';
import { NotFoundError } from '@/lib/errors';
import { formatARS, formatQty, formatRate, toDecimal } from '@/lib/money';
import { formatDateAr, formatDateTimeAr } from '@/lib/datetime';
import { describeTerm, PAYMENT_METHOD_LABEL, type TermType } from '@/lib/domain/payments';
import type { ValidationReport } from '@/lib/domain/validation';
import {
  EtiquetaComprobante,
  EtiquetaControl,
  EtiquetaPago,
  ListaControles,
  Semaforo,
} from '@/components/Estado';
import { AccionesComprobante } from './AccionesComprobante';
import { RepararDerivados } from './RepararDerivados';

export const metadata: Metadata = { title: 'Comprobante' };
export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    guardado?: string;
    reparado?: string;
    mov?: string;
    cos?: string;
    aso?: string;
    age?: string;
  }>;
}

/** El detalle de lo que la reparación arregló, para poder decirlo y no sólo "listo". */
function resumenDeReparacion(p: {
  mov?: string;
  cos?: string;
  aso?: string;
  age?: string;
}): string {
  const partes: string[] = [];
  const n = (v?: string) => Number(v ?? '0') || 0;
  if (n(p.aso) > 0) partes.push(`${n(p.aso)} renglón/es asociados a su producto`);
  if (n(p.mov) > 0) partes.push(`${n(p.mov)} movimiento/s de compra`);
  if (n(p.cos) > 0) partes.push(`${n(p.cos)} costo/s en el historial`);
  if (p.age === '1') partes.push('la agenda de pago');
  if (partes.length === 0) return 'No hacía falta cambiar nada: ya estaba completo.';
  return `Se reconstruyó: ${partes.join(', ')}.`;
}

export default async function PaginaComprobante({ params, searchParams }: Props) {
  const user = await requireUserOrRedirect();
  const { id } = await params;
  const { guardado, reparado, mov, cos, aso, age } = await searchParams;

  let documento;
  try {
    documento = await getDocumentForReview(user, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const storage = await getStorage();

  /*
   * Las imágenes archivadas ya no están en el almacenamiento: se borraron para
   * liberar espacio, después de exportarlas en un ZIP. Pedirles una URL firmada
   * rompería la pantalla entera del comprobante, que es justamente lo que el
   * archivado promete que no pasa: los datos se conservan y el comprobante se
   * sigue viendo. Así que se separan y se explica en su lugar.
   */
  const vigentes = documento.files.filter((f) => f.archivedAt === null);
  const archivadas = documento.files.filter((f) => f.archivedAt !== null);

  const paginas = await Promise.all(
    vigentes.map(async (file) => ({
      id: file.id,
      orden: file.pageOrder,
      url: await storage.signedUrl(file.storageKey),
      esPdf: file.mimeType === 'application/pdf',
    })),
  );

  const fechaArchivado = archivadas[0]?.archivedAt ?? null;

  const informe = documento.checkReport as unknown as ValidationReport | null;
  const puedeAnular = hasPermission(user, PERMISSIONS.COMPROBANTES_ANULAR);
  const puedeValidar = hasPermission(user, PERMISSIONS.COMPROBANTES_VALIDAR);

  /*
   * ¿Este comprobante validado dejó todo lo que tenía que dejar?
   *
   * Se pregunta sólo a quien podría repararlo: al resto no le sirve enterarse
   * de un problema que no puede resolver. La invariante que corre dentro de la
   * transacción impide que un comprobante nuevo quede así; esto es para los que
   * se validaron antes de que existiera.
   */
  const faltantes = puedeValidar ? await diagnosticarDerivados(documento.id) : [];

  /*
   * Las notas de crédito que corrigen esta factura, y qué queda por pagar.
   *
   * Van en la pantalla de la factura porque es donde alguien mira antes de
   * transferir. Una nota de crédito guardada en otra pantalla es plata que
   * existe y que no se ve: el importe grande de la factura queda solo, y es el
   * que se termina pagando.
   */
  const notas =
    documento.docType === 'NOTA_CREDITO' ? [] : await notasDeCreditoDe(documento.id);
  const creditoTotal = notas
    .filter((n) => n.status === 'VALIDADO')
    .reduce((acc, n) => acc.plus(toDecimal(n.total?.toString() ?? '0')), toDecimal('0'));

  return (
    <>
      {guardado ? (
        <p className="mensaje mensaje-ok" role="status">
          {documento.docType === 'NOTA_CREDITO'
            ? 'La nota de crédito se guardó y ya está descontando del saldo con el proveedor.'
            : 'El comprobante se guardó y el pago quedó agendado.'}
        </p>
      ) : null}

      {reparado ? (
        <p className="mensaje mensaje-ok" role="status">
          {resumenDeReparacion({ mov, cos, aso, age })} Los importes del comprobante no se tocaron.
        </p>
      ) : null}

      <h1>
        {documento.docType === 'REMITO'
          ? 'Remito'
          : documento.docType === 'NOTA_CREDITO'
            ? `Nota de crédito ${documento.letter ?? ''}`.trim()
            : `Factura ${documento.letter ?? ''}`.trim()}{' '}
        {documento.fullNumber || 'sin número'}
      </h1>
      <div className="fila-dato-meta" style={{ marginBottom: 14 }}>
        <EtiquetaComprobante estado={documento.status} />
        <EtiquetaControl estado={documento.checkState} />
        {documento.paymentSchedule ? (
          <EtiquetaPago estado={documento.paymentSchedule.status} />
        ) : null}
      </div>

      {documento.status === 'ANULADO' && documento.voidReason ? (
        <div className="mensaje mensaje-error">
          <strong>Comprobante anulado.</strong> Motivo: {documento.voidReason}
          {documento.voidedAt ? ` · ${formatDateTimeAr(documento.voidedAt)}` : ''}
        </div>
      ) : null}

      <Semaforo report={informe} />

      {faltantes.length > 0 ? (
        <RepararDerivados documentId={documento.id} hallazgos={faltantes} />
      ) : null}

      <div className="card">
        <h2>Datos del comprobante</h2>
        <dl style={{ margin: 0 }}>
          <div className="dato">
            <dt>Proveedor</dt>
            <dd>{documento.supplier?.tradeName ?? 'Sin identificar'}</dd>
          </div>
          <div className="dato">
            <dt>Sucursal</dt>
            <dd>{documento.branch.name}</dd>
          </div>
          <div className="dato">
            <dt>Fecha de emisión</dt>
            <dd>{formatDateAr(documento.issueDate)}</dd>
          </div>
          <div className="dato">
            <dt>Cargado por</dt>
            <dd>{documento.createdBy.name}</dd>
          </div>
          {documento.validatedBy ? (
            <div className="dato">
              <dt>Confirmado por</dt>
              <dd>
                {documento.validatedBy.name}
                {documento.validatedAt ? ` · ${formatDateTimeAr(documento.validatedAt)}` : ''}
              </dd>
            </div>
          ) : null}
        </dl>
      </div>

      {notas.length > 0 ? (
        <div className="card">
          <div className="card-titulo">
            <h2>Notas de crédito</h2>
            <span className="chico medio">−{formatARS(creditoTotal)}</span>
          </div>
          <ul className="lista">
            {notas.map((nota) => (
              <li key={nota.id}>
                <div className="fila-dato">
                  <div className="fila-dato-cabecera">
                    <span className="fila-dato-titulo">
                      <Link href={`/comprobantes/${nota.id}`}>{nota.fullNumber || 'sin número'}</Link>
                    </span>
                    <span className="fila-dato-importe">−{formatARS(nota.total?.toString() ?? '0')}</span>
                  </div>
                  <div className="fila-dato-meta">
                    <span>{formatDateAr(nota.issueDate)}</span>
                    <span>{MOTIVO_DE_CREDITO_LABEL[nota.creditReason as MotivoDeCredito] ?? 'Sin motivo'}</span>
                    {/*
                      Si movió mercadería o no, dicho acá. Es la pregunta que
                      aparece cuando el stock no cierra, y la respuesta no se
                      puede deducir de que exista la nota.
                    */}
                    <span>
                      {nota.items.some((i) => i.stockReturn)
                        ? `${nota.items.filter((i) => i.stockReturn).length} renglón/es devueltos`
                        : 'Sin devolución de mercadería'}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {documento.paymentSchedule ? (
            <p className="mensaje mensaje-info mb0">
              De esta factura hay que pagar{' '}
              <strong>
                {formatARS(
                  toDecimal(documento.paymentSchedule.plannedAmount.toString())
                    .minus(creditoTotal)
                    .minus(toDecimal(documento.paymentSchedule.paidAmount.toString()))
                    .toFixed(2),
                )}
              </strong>
              .
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="card">
        <h2>Totales</h2>
        <dl style={{ margin: 0 }}>
          <div className="dato">
            <dt>Subtotal bruto</dt>
            <dd>{documento.grossSubtotal ? formatARS(documento.grossSubtotal.toString()) : '—'}</dd>
          </div>
          <div className="dato">
            <dt>Descuento</dt>
            <dd>{documento.discountTotal ? formatARS(documento.discountTotal.toString()) : '—'}</dd>
          </div>
          <div className="dato">
            <dt>Neto gravado</dt>
            <dd>{documento.netTotal ? formatARS(documento.netTotal.toString()) : '—'}</dd>
          </div>
          {documento.taxLines.map((linea) => (
            <div className="dato" key={linea.id}>
              <dt>{linea.label}</dt>
              <dd>{formatARS(linea.amount.toString())}</dd>
            </div>
          ))}
          <div className="dato destacado">
            <dt>Total</dt>
            <dd>{documento.total ? formatARS(documento.total.toString()) : '—'}</dd>
          </div>
          {documento.printedNetWeightKg ? (
            <div className="dato">
              <dt>Peso neto impreso</dt>
              <dd>{formatQty(documento.printedNetWeightKg.toString(), 2)} kg</dd>
            </div>
          ) : null}
          {documento.printedLineCount ? (
            <div className="dato">
              <dt>Renglones impresos</dt>
              <dd>{documento.printedLineCount}</dd>
            </div>
          ) : null}
        </dl>
      </div>

      {documento.paymentSchedule ? (
        <div className="card">
          <div className="card-titulo">
            <h2>Pago</h2>
            <Link href="/pagos" className="chico">
              Ir a Pagos
            </Link>
          </div>
          <dl style={{ margin: 0 }}>
            <div className="dato destacado">
              <dt>Importe</dt>
              <dd>{formatARS(documento.paymentSchedule.plannedAmount.toString())}</dd>
            </div>
            <div className="dato">
              <dt>Fecha prevista</dt>
              <dd>{formatDateAr(documento.paymentSchedule.dueDate)}</dd>
            </div>
            <div className="dato">
              <dt>Plazo aplicado</dt>
              <dd>
                {documento.appliedTermType
                  ? describeTerm({
                      termType: documento.appliedTermType as TermType,
                      days: documento.appliedTermDays,
                    })
                  : '—'}
              </dd>
            </div>
            <div className="dato">
              <dt>Forma de pago prevista</dt>
              <dd>
                {PAYMENT_METHOD_LABEL[documento.paymentSchedule.plannedPaymentMethod] ??
                  documento.paymentSchedule.plannedPaymentMethod}
              </dd>
            </div>
            <div className="dato">
              <dt>Estado</dt>
              <dd>
                <EtiquetaPago estado={documento.paymentSchedule.status} />
              </dd>
            </div>
          </dl>

          {documento.paymentSchedule.events.length > 0 ? (
            <>
              <hr className="separador" />
              <h3>Historial del pago</h3>
              <ul className="lista">
                {documento.paymentSchedule.events.map((evento) => (
                  <li key={evento.id} className="fila-dato">
                    <div className="fila-dato-cabecera">
                      <span className="fila-dato-titulo">
                        {evento.kind === 'CONFIRMACION'
                          ? 'Pago confirmado'
                          : evento.kind === 'REPROGRAMACION'
                            ? 'Reprogramado'
                            : 'Cancelado'}
                      </span>
                      {evento.amount ? (
                        <span className="fila-dato-importe">
                          {formatARS(evento.amount.toString())}
                        </span>
                      ) : null}
                    </div>
                    <div className="fila-dato-meta">
                      {evento.effectiveDate ? (
                        <span>Fecha efectiva: {formatDateAr(evento.effectiveDate)}</span>
                      ) : null}
                      {evento.paymentMethod ? (
                        <span>
                          {PAYMENT_METHOD_LABEL[evento.paymentMethod] ?? evento.paymentMethod}
                        </span>
                      ) : null}
                      {evento.reference ? <span>Ref.: {evento.reference}</span> : null}
                      <span>{formatDateTimeAr(evento.createdAt)}</span>
                    </div>
                    {evento.notes ? <p className="chico medio mb0">{evento.notes}</p> : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="card">
        <div className="card-titulo">
          <h2>Artículos</h2>
          <span className="chico medio">{documento.items.length}</span>
        </div>

        {documento.items.length === 0 ? (
          <p className="medio mb0">No se leyó ningún artículo.</p>
        ) : (
          <div className="tabla-scroll">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Descripción</th>
                  <th>Producto</th>
                  <th className="num">Cantidad</th>
                  <th className="num">Precio</th>
                  <th className="num">Bonif.</th>
                  <th className="num">Neto</th>
                  <th className="num">IVA</th>
                  <th className="num">Percep.</th>
                  <th className="num">Costo unit.</th>
                  <th className="num">Costo total</th>
                </tr>
              </thead>
              <tbody>
                {documento.items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.lineNumber}</td>
                    <td style={{ whiteSpace: 'normal', minWidth: 200 }}>{item.description}</td>
                    <td>
                      {item.product ? (
                        item.product.normalizedName
                      ) : (
                        <span className="suave">Sin asociar</span>
                      )}
                    </td>
                    <td className="num">
                      {formatQty(item.quantity.toString(), 2)} {item.unit === 'KG' ? 'kg' : 'u.'}
                    </td>
                    <td className="num">{formatARS(item.unitNetPrice.toString())}</td>
                    <td className="num">{formatRate(item.discountPct.toString())}</td>
                    <td className="num">{formatARS(item.netAmount.toString())}</td>
                    <td className="num">{formatARS(item.ivaAmount.toString())}</td>
                    <td className="num">{formatARS(item.perceptionAmount.toString())}</td>
                    <td className="num">{formatARS(item.unitCost.toString())}</td>
                    <td className="num">{formatARS(item.totalCost.toString())}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {informe ? (
        <div className="card">
          <div className="card-titulo">
            <h2>Controles</h2>
          </div>
          <ListaControles checks={informe.checks} />
        </div>
      ) : null}

      {paginas.length > 0 ? (
        <div className="card">
          <h2>Imágenes</h2>
          <ul className="miniaturas">
            {paginas.map((pagina) => (
              <li key={pagina.id} className="miniatura">
                <span className="miniatura-orden">{pagina.orden}</span>
                <a href={pagina.url} target="_blank" rel="noreferrer">
                  {pagina.esPdf ? (
                    <div className="miniatura-pdf">Ver el PDF</div>
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={pagina.url} alt={`Página ${pagina.orden}`} />
                  )}
                </a>
              </li>
            ))}
          </ul>
          <p className="ayuda">Los enlaces vencen a los 15 minutos por seguridad.</p>
        </div>
      ) : null}

      {archivadas.length > 0 ? (
        <div className="card">
          <h2>Imágenes archivadas</h2>
          <p className="chico medio mb0">
            {archivadas.length === 1 ? 'La imagen de este comprobante se archivó' : `Las ${archivadas.length} imágenes de este comprobante se archivaron`}
            {fechaArchivado ? ` el ${formatDateAr(fechaArchivado)}` : ''} para liberar espacio, y
            están en el ZIP que se descargó antes de borrarlas.{' '}
            <strong>Los datos del comprobante están completos</strong>: artículos, importes,
            impuestos y pago son los que se cargaron y no cambiaron.
          </p>
        </div>
      ) : null}

      {documento.ocrAttempts.length > 0 ? (
        <details className="card">
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
            Lecturas realizadas ({documento.ocrAttempts.length})
          </summary>
          <ul className="lista mt">
            {documento.ocrAttempts.map((intento) => (
              <li key={intento.id} className="fila-dato">
                <div className="fila-dato-cabecera">
                  <span className="fila-dato-titulo">
                    Intento {intento.attemptNumber} · {intento.stage}
                  </span>
                  <span className="chico">{intento.success ? 'OK' : 'Falló'}</span>
                </div>
                <div className="fila-dato-meta">
                  <span>{intento.provider}</span>
                  {intento.model ? <span>{intento.model}</span> : null}
                  {intento.durationMs !== null ? <span>{intento.durationMs} ms</span> : null}
                  {intento.overallConfidence ? (
                    <span>Confianza {formatRate(intento.overallConfidence.toString())}</span>
                  ) : null}
                </div>
                {intento.strategy ? <p className="chico medio mb0">{intento.strategy}</p> : null}
                {intento.error ? <p className="chico negativo mb0">{intento.error}</p> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <AccionesComprobante
        documentId={documento.id}
        estado={documento.status}
        puedeAnular={puedeAnular}
        puedeValidar={puedeValidar}
        /*
         * Lo que decide es el conteo de errores del informe, no el estado del
         * semáforo. Un comprobante en amarillo —hizo falta releer, o quedó
         * alguna advertencia— tiene cero errores y se puede validar; el semáforo
         * amarillo describe cómo se leyó, no si se puede pagar.
         */
        hayErrores={(informe?.errorCount ?? 0) > 0}
      />
    </>
  );
}
