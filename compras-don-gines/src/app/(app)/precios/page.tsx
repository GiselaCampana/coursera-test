import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireUserOrRedirect, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { getPriceBoard, PRICE_ALERT_THRESHOLD } from '@/lib/services/pricing';
import { formatARS, formatRate } from '@/lib/money';
import { formatDateAr } from '@/lib/datetime';
import { SALE_MODE_LABEL } from '@/lib/domain/pricing';
import { FichaPrecio } from './FichaPrecio';
import { ConfigurarPrecio } from './ConfigurarPrecio';

export const metadata: Metadata = { title: 'Precios' };
export const dynamic = 'force-dynamic';

export default async function PaginaPrecios({
  searchParams,
}: {
  searchParams: Promise<{ tipo?: string; proveedor?: string }>;
}) {
  const user = await requireUserOrRedirect();
  if (!hasPermission(user, PERMISSIONS.PRECIOS_VER)) redirect('/');

  const { tipo = '', proveedor = '' } = await searchParams;
  const filas = await getPriceBoard(user);
  const puedeAprobar = hasPermission(user, PERMISSIONS.PRECIOS_GESTIONAR);
  const tipos = [...new Set(filas.map((f) => f.category).filter(Boolean) as string[])].sort((a, b) =>
    a.localeCompare(b, 'es'),
  );
  const proveedores = [...new Set(filas.map((f) => f.supplierName).filter(Boolean) as string[])].sort((a, b) =>
    a.localeCompare(b, 'es'),
  );
  const filtradas = filas.filter(
    (f) => (!tipo || f.category === tipo) && (!proveedor || f.supplierName === proveedor),
  );
  const conCosto = filtradas.filter((f) => f.purchaseUnitCost !== null);
  const sinCosto = filtradas.filter((f) => f.purchaseUnitCost === null);
  const alertas = conCosto.filter((f) => f.alert);

  return (
    <>
      <h1>Precios</h1>
      <p className="medio">
        Los precios de venta se calculan por kilo sobre el costo final, con IVA y percepciones
        distribuidos. El marcaje, el modo de venta y las conversiones de unidades los definís vos.
      </p>

      <form className="card card-compacta" method="get">
        <div className="fila fila-2">
          <div className="campo">
            <label htmlFor="tipo">Tipo de producto</label>
            <select id="tipo" name="tipo" defaultValue={tipo}>
              <option value="">Todos</option>
              {tipos.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="campo">
            <label htmlFor="proveedor">Proveedor</label>
            <select id="proveedor" name="proveedor" defaultValue={proveedor}>
              <option value="">Todos</option>
              {proveedores.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        </div>
        <div className="acciones">
          <button type="submit" className="boton">Filtrar</button>
          {(tipo || proveedor) ? (
            <a href="/precios" className="boton boton-secundario">Limpiar</a>
          ) : null}
        </div>
      </form>

      <div className="card card-compacta">
        <h2>Exportar listas</h2>
        <p className="chico medio">
          Se respetan los filtros de tipo de producto y proveedor elegidos arriba.
        </p>
        <div className="acciones">
          <a
            className="boton boton-secundario"
            href={`/api/precios/exportar?formato=pdf&vista=empleados&tipo=${encodeURIComponent(tipo)}&proveedor=${encodeURIComponent(proveedor)}`}
          >
            PDF para empleados
          </a>
          <a
            className="boton boton-secundario"
            href={`/api/precios/exportar?formato=pdf&vista=gestion&tipo=${encodeURIComponent(tipo)}&proveedor=${encodeURIComponent(proveedor)}`}
          >
            PDF completo
          </a>
          <a
            className="boton boton-secundario"
            href={`/api/precios/exportar?formato=xlsx&tipo=${encodeURIComponent(tipo)}&proveedor=${encodeURIComponent(proveedor)}`}
          >
            Excel completo
          </a>
        </div>
      </div>

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
                  {fila.approvedPricePerKg
                    ? formatARS(fila.approvedPricePerKg)
                    : fila.suggestedPricePerKg
                      ? formatARS(fila.suggestedPricePerKg)
                      : '—'}
                </span>
              </div>
              <div className="fila-dato-meta">
                <span>{fila.internalCode}</span>
                <span>{SALE_MODE_LABEL[fila.saleMode]}</span>
                {fila.supplierName ? <span>{fila.supplierName}</span> : null}
                {fila.lastCostDate ? <span>{formatDateAr(fila.lastCostDate)}</span> : null}
              </div>

              <dl style={{ margin: '9px 0 0' }}>
                {fila.purchaseUnit === 'UNIT' ? (
                  <div className="dato">
                    <dt>Último costo por unidad comprada</dt>
                    <dd>{fila.purchaseUnitCost ? formatARS(fila.purchaseUnitCost) : '—'}</dd>
                  </div>
                ) : null}

                <div className="dato">
                  <dt>Último costo por kilo</dt>
                  <dd>{fila.lastUnitCost ? formatARS(fila.lastUnitCost) : '—'}</dd>
                </div>

                {fila.purchaseUnit === 'UNIT' && fila.purchaseUnitWeightKg ? (
                  <div className="dato">
                    <dt>Conversión</dt>
                    <dd>{fila.purchaseUnitWeightKg} kg por unidad</dd>
                  </div>
                ) : null}

                {fila.needsPurchaseUnitWeight ? (
                  <div className="mensaje mensaje-aviso">
                    Falta indicar cuántos kilos trae cada unidad comprada para calcular costo y venta por kilo.
                  </div>
                ) : null}

                {fila.previousUnitCost ? (
                  <div className="dato">
                    <dt>Costo anterior por kilo</dt>
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

                {fila.saleMode === 'AL_CORTE' ? (
                  <>
                    <div className="dato destacado">
                      <dt>Por kilo</dt>
                      <dd>{fila.suggestedPricePerKg ? formatARS(fila.suggestedPricePerKg) : '—'}</dd>
                    </div>
                    <div className="dato">
                      <dt>Por kilo · horma digital</dt>
                      <dd>{fila.alCorteHormaDigitalKg ? formatARS(fila.alCorteHormaDigitalKg) : '—'}</dd>
                    </div>
                    <div className="dato">
                      <dt>Por kilo · horma efectivo</dt>
                      <dd>{fila.alCorteHormaCashKg ? formatARS(fila.alCorteHormaCashKg) : '—'}</dd>
                    </div>
                    <div className="dato">
                      <dt>Por kilo · horma por caja efectivo</dt>
                      <dd>{fila.alCorteCajaCashKg ? formatARS(fila.alCorteCajaCashKg) : '—'}</dd>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="dato destacado">
                      <dt>Venta por 100 g · precio expresado por kilo</dt>
                      <dd>{fila.feteado100gKg ? formatARS(fila.feteado100gKg) : '—'}</dd>
                    </div>
                    <div className="dato">
                      <dt>Venta por 1/4 kg · precio expresado por kilo</dt>
                      <dd>{fila.feteadoQuarterKg ? formatARS(fila.feteadoQuarterKg) : '—'}</dd>
                    </div>
                    <div className="dato">
                      <dt>Pieza entera digital · precio expresado por kilo</dt>
                      <dd>{fila.feteadoPieceDigitalKg ? formatARS(fila.feteadoPieceDigitalKg) : '—'}</dd>
                    </div>
                    <div className="dato">
                      <dt>Pieza entera efectivo · precio expresado por kilo</dt>
                      <dd>{fila.feteadoPieceCashKg ? formatARS(fila.feteadoPieceCashKg) : '—'}</dd>
                    </div>
                  </>
                )}

                {fila.purchaseUnit === 'UNIT' && fila.purchaseUnitWeightKg ? (
                  <div className="dato">
                    <dt>Unidad/lata/cajón entero</dt>
                    <dd>{fila.wholeUnitTotal ? formatARS(fila.wholeUnitTotal) : '—'}</dd>
                  </div>
                ) : null}

                {fila.approvedPricePerKg ? (
                  <div className="dato destacado">
                    <dt>Precio base aprobado por kilo</dt>
                    <dd>{formatARS(fila.approvedPricePerKg)}</dd>
                  </div>
                ) : null}
              </dl>

              {puedeAprobar ? (
                <ConfigurarPrecio
                  productId={fila.productId}
                  nombre={fila.name}
                  targetMarginPct={fila.targetMarginPct}
                  marginBasis={fila.marginBasis}
                  roundingRule={fila.roundingRule}
                  saleMode={fila.saleMode}
                  purchaseUnit={fila.purchaseUnit}
                  purchaseUnitWeightKg={fila.purchaseUnitWeightKg}
                  alCorteHormaDigitalMarginPct={fila.alCorteHormaDigitalMarginPct}
                  alCorteHormaCashMarginPct={fila.alCorteHormaCashMarginPct}
                  alCorteCajaCashMarginPct={fila.alCorteCajaCashMarginPct}
                  feteado100gMarginPct={fila.feteado100gMarginPct}
                  feteadoQuarterMarginPct={fila.feteadoQuarterMarginPct}
                  feteadoPieceDigitalMarginPct={fila.feteadoPieceDigitalMarginPct}
                  feteadoPieceCashMarginPct={fila.feteadoPieceCashMarginPct}
                  wholeUnitMarginPct={fila.wholeUnitMarginPct}
                />
              ) : null}

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
            Estos productos todavía no tienen ninguna compra asociada. Los que se compran por unidad
            además necesitan el peso neto de esa unidad para poder calcular el costo por kilo.
          </p>
          <p className="chico mb0">{sinCosto.map((f) => f.name).join(', ')}</p>
        </div>
      ) : null}
    </>
  );
}
