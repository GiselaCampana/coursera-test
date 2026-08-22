import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireUser, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { getPriceBoard, PRICE_ALERT_THRESHOLD } from '@/lib/services/pricing';
import { formatARS, formatRate } from '@/lib/money';
import { formatDateAr } from '@/lib/datetime';
import { SALE_MODE_LABEL } from '@/lib/domain/pricing';
import { FichaPrecio } from './FichaPrecio';

export const metadata: Metadata = { title: 'Precios' };
export const dynamic = 'force-dynamic';

export default async function PaginaPrecios() {
  const user = await requireUser();
  if (!hasPermission(user, PERMISSIONS.PRECIOS_VER)) redirect('/');

  const filas = await getPriceBoard(user);
  const puedeAprobar = hasPermission(user, PERMISSIONS.PRECIOS_GESTIONAR);
  const conCosto = filas.filter((f) => f.lastUnitCost !== null);
  const sinCosto = filas.filter((f) => f.lastUnitCost === null);
  const alertas = conCosto.filter((f) => f.alert);

  return (
    <>
      <h1>Precios</h1>
      <p className="medio">
        Los precios de venta se calculan sobre el costo unitario final, con el IVA y las
        percepciones ya distribuidos.
      </p>

      {alertas.length > 0 ? (
        <div className="mensaje mensaje-aviso">
          <strong>
            {alertas.length} producto{alertas.length === 1 ? '' : 's'} con aumento de más del{' '}
            {formatRate(PRICE_ALERT_THRESHOLD)}
          </strong>
          <div className="chico">{alertas.map((a) => a.name).join(', ')}</div>
        </div>
      ) : null}

      {conCosto.length === 0 ? (
        <div className="card">
          <div className="vacio">
            <div className="vacio-titulo">Todavía no hay costos cargados</div>
            <p className="mb0">
              Los precios se calculan a partir de las compras. Cargá una factura para empezar.
            </p>
          </div>
        </div>
      ) : (
        <ul className="lista">
          {conCosto.map((fila) => (
            <li key={fila.productId} className="fila-dato">
              <div className="fila-dato-cabecera">
                <span className="fila-dato-titulo">{fila.name}</span>
                <span className="fila-dato-importe">
                  {fila.suggestedPricePerKg ? formatARS(fila.suggestedPricePerKg) : '—'}
                </span>
              </div>
              <div className="fila-dato-meta">
                <span>{fila.internalCode}</span>
                <span>{SALE_MODE_LABEL[fila.saleMode]}</span>
                {fila.supplierName ? <span>{fila.supplierName}</span> : null}
                {fila.lastCostDate ? <span>{formatDateAr(fila.lastCostDate)}</span> : null}
              </div>

              <dl style={{ margin: '9px 0 0' }}>
                <div className="dato">
                  <dt>Último costo</dt>
                  <dd>{formatARS(fila.lastUnitCost!)}</dd>
                </div>
                {fila.previousUnitCost ? (
                  <div className="dato">
                    <dt>Costo anterior</dt>
                    <dd>{formatARS(fila.previousUnitCost)}</dd>
                  </div>
                ) : null}
                {fila.deltaAmount && fila.deltaPct ? (
                  <div className="dato">
                    <dt>Variación</dt>
                    <dd className={Number(fila.deltaAmount) > 0 ? 'negativo' : 'positivo'}>
                      {Number(fila.deltaAmount) > 0 ? '+' : ''}
                      {formatARS(fila.deltaAmount)} ({formatRate(fila.deltaPct)})
                    </dd>
                  </div>
                ) : null}

                <div className="dato">
                  <dt>Precio por kilo sugerido</dt>
                  <dd>{fila.suggestedPricePerKg ? formatARS(fila.suggestedPricePerKg) : '—'}</dd>
                </div>

                {fila.saleMode === 'FETEABLE' ? (
                  <>
                    <div className="dato">
                      <dt>Por 100 g</dt>
                      <dd>{fila.pricePer100g ? formatARS(fila.pricePer100g) : '—'}</dd>
                    </div>
                    <div className="dato">
                      <dt>Por 1/4 kg</dt>
                      <dd>{fila.pricePerQuarter ? formatARS(fila.pricePerQuarter) : '—'}</dd>
                    </div>
                    <div className="dato">
                      <dt>Por pieza (pago digital)</dt>
                      <dd>
                        {fila.pricePerPieceDigital ? formatARS(fila.pricePerPieceDigital) : '—'}
                      </dd>
                    </div>
                    <div className="dato">
                      <dt>Por pieza (efectivo)</dt>
                      <dd>{fila.pricePerPieceCash ? formatARS(fila.pricePerPieceCash) : '—'}</dd>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="dato">
                      <dt>Por horma (pago digital)</dt>
                      <dd>
                        {fila.pricePerPieceDigital ? formatARS(fila.pricePerPieceDigital) : '—'}
                      </dd>
                    </div>
                    <div className="dato">
                      <dt>Por horma (efectivo)</dt>
                      <dd>{fila.pricePerPieceCash ? formatARS(fila.pricePerPieceCash) : '—'}</dd>
                    </div>
                  </>
                )}

                {fila.approvedPricePerKg ? (
                  <div className="dato destacado">
                    <dt>Precio aprobado</dt>
                    <dd>{formatARS(fila.approvedPricePerKg)}</dd>
                  </div>
                ) : null}
              </dl>

              {puedeAprobar && fila.suggestedPricePerKg ? (
                <FichaPrecio
                  productId={fila.productId}
                  nombre={fila.name}
                  sugerido={fila.suggestedPricePerKg}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {sinCosto.length > 0 ? (
        <div className="card">
          <h2>Sin compras registradas</h2>
          <p className="chico medio">
            Estos productos todavía no tienen ninguna compra, así que no hay costo sobre el cual
            calcular el precio.
          </p>
          <p className="chico mb0">{sinCosto.map((f) => f.name).join(', ')}</p>
        </div>
      ) : null}
    </>
  );
}
