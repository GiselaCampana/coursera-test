import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUserOrRedirect, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import {
  backfillProductLinks,
  segurasDe,
  type RenglonDelInforme,
} from '@/lib/services/backfill-productos';
import { Aplicar, ResolverAmbigua, ImportarMapeoCodigos } from './Acciones';

export const metadata: Metadata = { title: 'Asociaciones históricas' };
export const dynamic = 'force-dynamic';

/**
 * Mantenimiento de las compras que quedaron sin clasificar.
 *
 * Las facturas confirmadas antes de que la asociación se resolviera del lado
 * del servidor guardaron sus renglones sin producto, y para el reporte por
 * artículo esas compras no existen: se validaron, se pagaron, están en el total
 * general, y al filtrar por el producto dan cero.
 *
 * El flujo es en dos pasos y nunca en uno. Primero se analiza y **no se escribe
 * nada**: se muestra qué se reconocería y con qué confianza. Recién después, con
 * una confirmación aparte, se aplica. Un backfill que arranca escribiendo es un
 * backfill que no se puede revisar antes, y acá lo que se toca es a qué artículo
 * pertenece cada compra: si se equivoca, ensucia el costo de un producto que
 * nadie compró.
 *
 * Las dudosas no se aplican nunca solas. Se resuelven de a una, eligiendo el
 * PLU, y al confirmarlas queda aprendida la relación proveedor + código para que
 * el trabajo se haga una sola vez.
 */

function Fila({
  renglon,
  productos,
  resoluble,
}: {
  renglon: RenglonDelInforme;
  productos: { id: string; internalCode: string; normalizedName: string }[];
  resoluble: boolean;
}) {
  return (
    <li className="fila-dato">
      <div className="fila-dato-meta">
        <span>{renglon.supplierName ?? 'Sin proveedor'}</span>
        {renglon.supplierCode ? <strong>{renglon.supplierCode}</strong> : <span>sin código</span>}
        {renglon.productCode ? (
          <span>
            → PLU <strong>{renglon.productCode}</strong> · {renglon.productName}
          </span>
        ) : null}
      </div>
      <div className="fila-dato-meta">
        <span className="chico medio">{renglon.description}</span>
        <Link href={`/comprobantes/${renglon.documentId}`} className="chico">
          {renglon.documentNumber}
        </Link>
      </div>

      {resoluble ? (
        <ResolverAmbigua
          documentItemId={renglon.documentItemId}
          descripcion={renglon.description}
          tieneCodigo={Boolean(renglon.supplierCode)}
          supplierName={renglon.supplierName}
          supplierCode={renglon.supplierCode}
          sugerencias={renglon.sugerencias ?? []}
          productos={productos}
        />
      ) : null}
    </li>
  );
}

function Grupo({
  titulo,
  ayuda,
  renglones,
  productos,
  resoluble = false,
}: {
  titulo: string;
  ayuda: string;
  renglones: RenglonDelInforme[];
  productos: { id: string; internalCode: string; normalizedName: string }[];
  resoluble?: boolean;
}) {
  return (
    <details className="card">
      <summary>
        <strong>{titulo}</strong> · {renglones.length}
      </summary>
      <p className="chico medio">{ayuda}</p>
      {renglones.length === 0 ? (
        <p className="chico medio mb0">No hay ninguna.</p>
      ) : (
        <ul className="lista">
          {renglones.map((r) => (
            <Fila
              key={r.documentItemId}
              renglon={r}
              productos={productos}
              resoluble={resoluble}
            />
          ))}
        </ul>
      )}
    </details>
  );
}

export default async function PaginaAsociaciones({
  searchParams,
}: {
  searchParams: Promise<{ proveedor?: string; aplicado?: string }>;
}) {
  const user = await requireUserOrRedirect();
  if (!hasPermission(user, PERMISSIONS.PRODUCTOS_GESTIONAR)) redirect('/configuracion');

  const { proveedor, aplicado } = await searchParams;

  const [proveedores, productos] = await Promise.all([
    prisma.supplier.findMany({ orderBy: { tradeName: 'asc' }, select: { id: true, tradeName: true } }),
    prisma.product.findMany({
      where: { active: true },
      orderBy: { normalizedName: 'asc' },
      select: { id: true, internalCode: true, normalizedName: true },
    }),
  ]);

  // Paso 1: analizar. Sin `aplicar`, esto no escribe absolutamente nada.
  const informe = await backfillProductLinks(user, {
    supplierId: proveedor || undefined,
  });
  const seguras = segurasDe(informe);

  return (
    <>
      <h1>Asociaciones históricas</h1>
      <p className="medio">
        Compras ya validadas que quedaron sin producto asociado. Para el reporte por artículo esas
        compras no existen: están en el total general y al filtrar por el producto dan cero.
      </p>

      {aplicado ? (
        <p className="mensaje mensaje-ok" role="status">
          Se aplicaron {aplicado} asociación/es. Las que quedan abajo son las que hay que resolver a
          mano.
        </p>
      ) : null}

      <form className="card card-compacta" method="get">
        <div className="campo">
          <label htmlFor="proveedor">Proveedor</label>
          <select id="proveedor" name="proveedor" defaultValue={proveedor ?? ''}>
            <option value="">Todos</option>
            {proveedores.map((p) => (
              <option key={p.id} value={p.id}>
                {p.tradeName}
              </option>
            ))}
          </select>
          <p className="ayuda">
            Conviene ir proveedor por proveedor: los códigos se cargan de a uno y así se ve el
            avance de cada uno por separado.
          </p>
        </div>
        <div className="acciones">
          <button type="submit" className="boton boton-secundario">
            Analizar
          </button>
        </div>
      </form>

      {proveedor ? (
        <ImportarMapeoCodigos
          supplierId={proveedor}
          supplierName={proveedores.find((p) => p.id === proveedor)?.tradeName ?? 'proveedor'}
        />
      ) : null}

      <div className="card card-compacta">
        <dl className="resumen-mes" style={{ margin: 0 }}>
          <div className="dato destacado">
            <dt>Por código de proveedor</dt>
            <dd>{informe.porCodigo.length}</dd>
          </div>
          <div className="dato">
            <dt>Seguras por alias o descripción</dt>
            <dd>{informe.porDescripcion.length}</dd>
          </div>
          <div className="dato">
            <dt>Ambiguas</dt>
            <dd>{informe.ambiguas.length}</dd>
          </div>
          <div className="dato">
            <dt>Sin coincidencia</dt>
            <dd>{informe.sinCoincidencia.length}</dd>
          </div>
        </dl>
      </div>

      <Grupo
        titulo="Por código de proveedor"
        ayuda="Las de mayor confianza: el proveedor ya dijo alguna vez qué artículo es ese código, así que no dependen de cómo haya salido la descripción del OCR."
        renglones={informe.porCodigo}
        productos={productos}
      />

      <Grupo
        titulo="Seguras por alias o descripción"
        ayuda="La descripción coincide con un solo producto del catálogo, por encima del umbral y sin empate."
        renglones={informe.porDescripcion}
        productos={productos}
      />

      <Grupo
        titulo="Ambiguas"
        ayuda="Más de un producto se parece por igual, o ninguno lo suficiente. Estas no se aplican solas: elegí el PLU. Si el renglón trae código de proveedor, queda aprendido para las próximas facturas."
        renglones={informe.ambiguas}
        productos={productos}
        resoluble
      />

      <Grupo
        titulo="Sin coincidencia"
        ayuda="No se parecen a nada del catálogo. Puede que falte dar de alta el producto, o que sean artículos que no se venden."
        renglones={informe.sinCoincidencia}
        productos={productos}
        resoluble
      />

      {/* Paso 2: aplicar, con confirmación aparte. */}
      <Aplicar
        cantidad={seguras.length}
        proveedorId={proveedor ?? ''}
        proveedorNombre={
          proveedor ? (proveedores.find((p) => p.id === proveedor)?.tradeName ?? null) : null
        }
      />
    </>
  );
}
