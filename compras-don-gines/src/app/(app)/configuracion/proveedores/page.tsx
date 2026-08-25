import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireUserOrRedirect, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import { arTodayISO, formatDateAr } from '@/lib/datetime';
import { formatRate } from '@/lib/money';
import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABEL,
  describeTerm,
  type TermType,
} from '@/lib/domain/payments';
import { FormularioConfig, Casilla } from '@/components/FormularioConfig';
import { guardarPlazo, guardarProveedor, guardarReglaImpositiva } from '../acciones';

export const metadata: Metadata = { title: 'Proveedores' };
export const dynamic = 'force-dynamic';

export default async function PaginaProveedores() {
  const user = await requireUserOrRedirect();
  if (!hasPermission(user, PERMISSIONS.PROVEEDORES_GESTIONAR)) redirect('/configuracion');

  const hoy = arTodayISO();
  const proveedores = await prisma.supplier.findMany({
    orderBy: [{ active: 'desc' }, { tradeName: 'asc' }],
    include: {
      aliases: true,
      paymentTerms: { orderBy: { validFrom: 'desc' } },
      taxRules: { orderBy: { validFrom: 'desc' } },
      _count: { select: { documents: true } },
    },
  });

  return (
    <>
      <h1>Proveedores</h1>
      <p className="medio">
        Las condiciones de pago y las reglas impositivas tienen historial de vigencia: al cambiar
        una, las facturas anteriores conservan la que regía cuando se cargaron.
      </p>

      <div className="card">
        <FormularioConfig
          titulo="Nuevo proveedor"
          textoBoton="Agregar un proveedor"
          accion={guardarProveedor}
        >
          <div className="fila fila-2">
            <div className="campo">
              <label htmlFor="prov-tradeName">Nombre comercial</label>
              <input id="prov-tradeName" name="tradeName" type="text" required />
            </div>
            <div className="campo">
              <label htmlFor="prov-legalName">Razón social</label>
              <input id="prov-legalName" name="legalName" type="text" />
            </div>
          </div>
          <div className="fila fila-2">
            <div className="campo">
              <label htmlFor="prov-cuit">CUIT</label>
              <input id="prov-cuit" name="cuit" type="text" inputMode="numeric" placeholder="30-12345678-9" />
            </div>
            <div className="campo">
              <label htmlFor="prov-currency">Moneda</label>
              <input id="prov-currency" name="currency" type="text" defaultValue="ARS" />
            </div>
          </div>
          <div className="campo">
            <label htmlFor="prov-aliases">Alias para el reconocimiento (uno por línea)</label>
            <textarea id="prov-aliases" name="aliases" placeholder={'LOS CALVOS S.A.\nLOSCALVOS'} />
          </div>
          <div className="campo">
            <label htmlFor="prov-notes">Observaciones</label>
            <textarea id="prov-notes" name="notes" />
          </div>
          <Casilla name="active" etiqueta="Activo" defecto />
        </FormularioConfig>
      </div>

      {proveedores.map((proveedor) => {
        const plazoVigente = proveedor.paymentTerms.find(
          (t) => !t.validTo || t.validTo >= new Date(),
        );
        const reglaVigente = proveedor.taxRules.find((r) => !r.validTo || r.validTo >= new Date());

        return (
          <div className="card" key={proveedor.id}>
            <div className="card-titulo">
              <h2>{proveedor.tradeName}</h2>
              <span
                className={`etiqueta-estado ${proveedor.active ? 'estado-ok' : 'estado-neutro'}`}
              >
                {proveedor.active ? 'Activo' : 'Baja'}
              </span>
            </div>

            <dl style={{ margin: 0 }}>
              <div className="dato">
                <dt>Razón social</dt>
                <dd>{proveedor.legalName ?? '—'}</dd>
              </div>
              <div className="dato">
                <dt>CUIT</dt>
                <dd>{proveedor.cuit ?? '—'}</dd>
              </div>
              <div className="dato">
                <dt>Plazo vigente</dt>
                <dd>
                  {plazoVigente
                    ? `${describeTerm({ termType: plazoVigente.termType as TermType, days: plazoVigente.days })} · ${PAYMENT_METHOD_LABEL[plazoVigente.paymentMethod] ?? plazoVigente.paymentMethod}`
                    : 'Sin condición configurada'}
                </dd>
              </div>
              <div className="dato">
                <dt>Impuestos vigentes</dt>
                <dd>
                  {reglaVigente
                    ? `IVA ${formatRate(reglaVigente.ivaRate.toString())} · IIBB ${formatRate(reglaVigente.iibbRate.toString())}`
                    : 'Sin regla configurada'}
                </dd>
              </div>
              <div className="dato">
                <dt>Comprobantes</dt>
                <dd>{proveedor._count.documents}</dd>
              </div>
              {proveedor.aliases.length > 0 ? (
                <div className="dato">
                  <dt>Alias</dt>
                  <dd>{proveedor.aliases.map((a) => a.alias).join(', ')}</dd>
                </div>
              ) : null}
            </dl>

            <FormularioConfig
              titulo={`Editar ${proveedor.tradeName}`}
              textoBoton="Editar los datos"
              accion={guardarProveedor}
            >
              <input type="hidden" name="id" value={proveedor.id} />
              <div className="fila fila-2">
                <div className="campo">
                  <label htmlFor={`tn-${proveedor.id}`}>Nombre comercial</label>
                  <input
                    id={`tn-${proveedor.id}`}
                    name="tradeName"
                    type="text"
                    defaultValue={proveedor.tradeName}
                    required
                  />
                </div>
                <div className="campo">
                  <label htmlFor={`ln-${proveedor.id}`}>Razón social</label>
                  <input
                    id={`ln-${proveedor.id}`}
                    name="legalName"
                    type="text"
                    defaultValue={proveedor.legalName ?? ''}
                  />
                </div>
              </div>
              <div className="fila fila-2">
                <div className="campo">
                  <label htmlFor={`cuit-${proveedor.id}`}>CUIT</label>
                  <input
                    id={`cuit-${proveedor.id}`}
                    name="cuit"
                    type="text"
                    defaultValue={proveedor.cuit ?? ''}
                  />
                </div>
                <div className="campo">
                  <label htmlFor={`cur-${proveedor.id}`}>Moneda</label>
                  <input
                    id={`cur-${proveedor.id}`}
                    name="currency"
                    type="text"
                    defaultValue={proveedor.currency}
                  />
                </div>
              </div>
              <div className="campo">
                <label htmlFor={`alias-${proveedor.id}`}>Alias nuevos (uno por línea)</label>
                <textarea id={`alias-${proveedor.id}`} name="aliases" />
              </div>
              <div className="campo">
                <label htmlFor={`notes-${proveedor.id}`}>Observaciones</label>
                <textarea
                  id={`notes-${proveedor.id}`}
                  name="notes"
                  defaultValue={proveedor.notes ?? ''}
                />
              </div>
              <Casilla name="active" etiqueta="Activo" defecto={proveedor.active} />
            </FormularioConfig>

            <hr className="separador" />

            <h3>Condiciones de pago</h3>
            <ul className="lista">
              {proveedor.paymentTerms.map((plazo) => (
                <li key={plazo.id} className="fila-dato">
                  <div className="fila-dato-cabecera">
                    <span className="fila-dato-titulo">
                      {describeTerm({ termType: plazo.termType as TermType, days: plazo.days })}
                    </span>
                    <span className="chico">
                      {PAYMENT_METHOD_LABEL[plazo.paymentMethod] ?? plazo.paymentMethod}
                    </span>
                  </div>
                  <div className="fila-dato-meta">
                    <span>Desde {formatDateAr(plazo.validFrom)}</span>
                    <span>{plazo.validTo ? `hasta ${formatDateAr(plazo.validTo)}` : 'vigente'}</span>
                  </div>
                </li>
              ))}
            </ul>

            <FormularioConfig
              titulo="Nueva condición de pago"
              textoBoton="Cambiar la condición de pago"
              accion={guardarPlazo}
            >
              <input type="hidden" name="supplierId" value={proveedor.id} />
              <div className="fila fila-2">
                <div className="campo">
                  <label htmlFor={`tt-${proveedor.id}`}>Tipo de plazo</label>
                  <select id={`tt-${proveedor.id}`} name="termType" defaultValue="DAYS">
                    <option value="SAME_DAY">En el día</option>
                    <option value="DAYS">A x días</option>
                    <option value="NEXT_INVOICE">Factura contra factura</option>
                    <option value="MANUAL">Fecha manual</option>
                  </select>
                </div>
                <div className="campo">
                  <label htmlFor={`days-${proveedor.id}`}>Días</label>
                  <input
                    id={`days-${proveedor.id}`}
                    name="days"
                    type="text"
                    inputMode="numeric"
                    defaultValue="0"
                  />
                </div>
              </div>
              <div className="fila fila-2">
                <div className="campo">
                  <label htmlFor={`pm-${proveedor.id}`}>Forma de pago habitual</label>
                  <select id={`pm-${proveedor.id}`} name="paymentMethod" defaultValue="TRANSFERENCIA">
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m} value={m}>
                        {PAYMENT_METHOD_LABEL[m]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="campo">
                  <label htmlFor={`vf-${proveedor.id}`}>Vigente desde</label>
                  <input id={`vf-${proveedor.id}`} name="validFrom" type="date" defaultValue={hoy} />
                </div>
              </div>
              <div className="campo">
                <label htmlFor={`nif-${proveedor.id}`}>Próxima factura o visita prevista</label>
                <input
                  id={`nif-${proveedor.id}`}
                  name="nextInvoiceDate"
                  type="date"
                  defaultValue={
                    proveedor.nextInvoiceDate
                      ? proveedor.nextInvoiceDate.toISOString().slice(0, 10)
                      : ''
                  }
                />
                <p className="ayuda">
                  Sólo para «factura contra factura»: es cuándo se espera que vuelva a pasar. Cada
                  factura se agenda para esa fecha hasta que llegue la siguiente. Si se deja vacía,
                  la fecha se pide al cargar cada comprobante.
                </p>
              </div>
              <div className="campo">
                <label htmlFor={`tnotes-${proveedor.id}`}>Nota</label>
                <input id={`tnotes-${proveedor.id}`} name="notes" type="text" />
              </div>
            </FormularioConfig>

            <hr className="separador" />

            <h3>Reglas impositivas</h3>
            <ul className="lista">
              {proveedor.taxRules.map((regla) => (
                <li key={regla.id} className="fila-dato">
                  <div className="fila-dato-cabecera">
                    <span className="fila-dato-titulo">
                      IVA {formatRate(regla.ivaRate.toString())} · IIBB{' '}
                      {formatRate(regla.iibbRate.toString())}
                    </span>
                  </div>
                  <div className="fila-dato-meta">
                    <span>Desde {formatDateAr(regla.validFrom)}</span>
                    <span>{regla.validTo ? `hasta ${formatDateAr(regla.validTo)}` : 'vigente'}</span>
                  </div>
                </li>
              ))}
            </ul>

            <FormularioConfig
              titulo="Nueva regla impositiva"
              textoBoton="Cambiar las tasas"
              accion={guardarReglaImpositiva}
            >
              <input type="hidden" name="supplierId" value={proveedor.id} />
              <div className="fila fila-3">
                <div className="campo">
                  <label htmlFor={`iva-${proveedor.id}`}>IVA (%)</label>
                  <input
                    id={`iva-${proveedor.id}`}
                    name="ivaRate"
                    type="text"
                    inputMode="decimal"
                    defaultValue="21"
                    required
                  />
                </div>
                <div className="campo">
                  <label htmlFor={`iibb-${proveedor.id}`}>IIBB (%)</label>
                  <input
                    id={`iibb-${proveedor.id}`}
                    name="iibbRate"
                    type="text"
                    inputMode="decimal"
                    defaultValue="1,5"
                  />
                </div>
                <div className="campo">
                  <label htmlFor={`tvf-${proveedor.id}`}>Vigente desde</label>
                  <input id={`tvf-${proveedor.id}`} name="validFrom" type="date" defaultValue={hoy} />
                </div>
              </div>
              <div className="campo">
                <label htmlFor={`rnotes-${proveedor.id}`}>Nota</label>
                <input id={`rnotes-${proveedor.id}`} name="notes" type="text" />
              </div>
            </FormularioConfig>
          </div>
        );
      })}
    </>
  );
}
