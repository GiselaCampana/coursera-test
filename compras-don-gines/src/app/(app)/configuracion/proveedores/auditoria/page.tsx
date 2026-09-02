import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUserOrRedirect, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import { formatARS } from '@/lib/money';
import { formatDateAr, formatDateTimeAr } from '@/lib/datetime';
import {
  auditarAtribucion,
  VEREDICTO_LABEL,
  type ComprobanteAuditado,
  type VeredictoDeAtribucion,
} from '@/lib/services/auditoria-proveedor';

export const metadata: Metadata = { title: 'Auditoría de atribución' };
export const dynamic = 'force-dynamic';

/**
 * ¿Los comprobantes de un proveedor son de verdad suyos?
 *
 * Esta pantalla **no corrige nada**. Lee, contrasta y muestra. La reasignación
 * de un comprobante arrastra la cuenta corriente, la agenda de pagos, los
 * costos y las asociaciones aprendidas: no es una decisión que pueda tomar un
 * procedimiento a partir de indicios, así que acá se juntan los indicios y los
 * mira una persona.
 *
 * Existe por un defecto concreto ya corregido: el analizador de Los Calvos
 * reconocía un comprobante sólo por sus cabeceras de columna y después escribía
 * "Los Calvos" como razón social. Lo que queda es saber qué se cargó antes de
 * la corrección.
 */

const ORDEN: VeredictoDeAtribucion[] = [
  'OTRO_PROVEEDOR',
  'SOSPECHOSO',
  'SIN_EVIDENCIA',
  'CORRECTO',
];

const CLASE: Record<VeredictoDeAtribucion, string> = {
  OTRO_PROVEEDOR: 'mensaje-error',
  SOSPECHOSO: 'mensaje-aviso',
  SIN_EVIDENCIA: 'mensaje-info',
  CORRECTO: 'mensaje-ok',
};

const EXPLICACION: Record<VeredictoDeAtribucion, string> = {
  OTRO_PROVEEDOR:
    'El papel nombra —por CUIT o por razón social— a otro proveedor que está cargado en el sistema.',
  SOSPECHOSO:
    'El papel no confirma este proveedor y hay más indicios en contra que a favor. No alcanza para afirmarlo.',
  SIN_EVIDENCIA:
    'No quedó con qué decidir: el comprobante no guardó el texto de la lectura, o lo que hay no dice nada en ningún sentido.',
  CORRECTO: 'El CUIT o el nombre del proveedor están impresos en el comprobante.',
};

function Ficha({ c }: { c: ComprobanteAuditado }) {
  return (
    <li className="fila-dato">
      <div className="fila-dato-cabecera">
        <span className="fila-dato-titulo">
          <Link href={`/comprobantes/${c.documentId}`}>{c.numero}</Link>
        </span>
        <span className="fila-dato-importe">{formatARS(c.total)}</span>
      </div>
      <div className="fila-dato-meta">
        <span>{formatDateAr(c.fecha)}</span>
        <span>{c.sucursal}</span>
        <span>{c.estado}</span>
        {/*
          Si el comprobante pesa o no, dicho en la fila y no en letra chica.

          Un comprobante mal atribuido suena a problema; si resulta ser una
          lectura en revisión de cero pesos, no lo es. Sin distinguirlo, el
          informe alarma sobre algo que no pasó, y la próxima vez que alarme en
          serio nadie le va a creer.
        */}
        <span className={`etiqueta-estado ${c.conImpacto ? 'estado-aviso' : 'estado-neutro'}`}>
          {c.conImpacto ? 'Pesa en deuda y costos' : 'Sin impacto'}
        </span>
      </div>

      {c.proveedorProbable ? (
        <p className="chico mt mb0">
          Probablemente sea de <strong>{c.proveedorProbable.nombre}</strong>.{' '}
          {c.proveedorProbable.porQue}
        </p>
      ) : null}

      {/*
        Los indicios se muestran todos, incluidos los que no se pudieron mirar.

        Un informe que sólo lista lo que encontró no deja distinguir "esto se
        revisó y está bien" de "esto no se pudo revisar", y en una auditoría esa
        diferencia es la mitad del valor.

        Y separados en dos grupos, porque no valen lo mismo. Los de arriba dicen
        quién emitió el comprobante y son los que deciden. Los de abajo son lo
        que el sistema le copió del proveedor que ya tenía asignado: coinciden
        por construcción, así que no prueban nada, pero son exactamente lo que
        quedaría mal si el comprobante se reasignara.
      */}
      <p className="chico medio mt mb0">Lo que dice el comprobante</p>
      <ul className="lista-simple chico">
        {c.indicios
          .filter((i) => i.decide)
          .map((i, n) => (
            <li key={n}>
              <span aria-hidden="true">
                {i.aFavor === true ? '✓ ' : i.aFavor === false ? '✗ ' : '· '}
              </span>
              <span className={i.aFavor === false ? 'negativo' : undefined}>{i.detalle}</span>
            </li>
          ))}
      </ul>

      <p className="chico medio mt mb0">
        Lo que el sistema aplicó <em>(no decide: se copió del proveedor asignado)</em>
      </p>
      <ul className="lista-simple chico">
        {c.indicios
          .filter((i) => !i.decide)
          .map((i, n) => (
            <li key={n}>
              <span aria-hidden="true">· </span>
              {i.detalle}
            </li>
          ))}
      </ul>

      {/*
        Qué habría que revisar si el comprobante se reasignara. Va a la vista
        antes de cualquier corrección, no después: es el tamaño real del
        problema, y decidir sin verlo sería decidir a ciegas.
      */}
      <p className="chico medio mt mb0">
        Arrastra: {c.derivados.movimientos} movimiento{c.derivados.movimientos === 1 ? '' : 's'} de
        compra, {c.derivados.entradasDeCosto} entrada
        {c.derivados.entradasDeCosto === 1 ? '' : 's'} de costo,{' '}
        {c.derivados.asociacionesAprendidas} renglón
        {c.derivados.asociacionesAprendidas === 1 ? '' : 'es'} asociado
        {c.derivados.asociacionesAprendidas === 1 ? '' : 's'}
        {c.derivados.tieneAgenda
          ? `, agenda de pago con ${formatARS(c.derivados.pagado)} pagados`
          : ', sin agenda de pago'}
        .
      </p>
    </li>
  );
}

export default async function PaginaAuditoriaDeAtribucion({
  searchParams,
}: {
  searchParams: Promise<{ proveedor?: string }>;
}) {
  const user = await requireUserOrRedirect();
  if (!hasPermission(user, PERMISSIONS.PROVEEDORES_GESTIONAR)) redirect('/configuracion');

  const { proveedor: elegido } = await searchParams;
  const proveedores = await prisma.supplier.findMany({
    orderBy: { tradeName: 'asc' },
    select: { id: true, tradeName: true },
  });

  const informe = elegido ? await auditarAtribucion(user, elegido) : null;

  return (
    <>
      <h1>Auditoría de atribución</h1>
      <p className="chico medio">
        Revisa si los comprobantes cargados a nombre de un proveedor son de verdad suyos. Cruza
        seis fuentes: el CUIT y la razón social del texto que leyó el OCR, los códigos de artículo,
        las asociaciones al catálogo, el plazo de pago aplicado y las tasas impositivas. Las tres
        primeras dicen quién emitió el comprobante y son las que deciden; las otras tres son lo que
        el sistema le copió del proveedor asignado, coinciden por construcción y se informan como
        contexto.
      </p>

      <div className="card">
        <p className="mensaje mensaje-info mb0" role="status">
          <strong>Esto no modifica nada.</strong> Es sólo lectura: muestra qué encontró y con qué
          evidencia. Cualquier corrección se decide después, comprobante por comprobante.
        </p>
      </div>

      <div className="card">
        <h2>Proveedor a revisar</h2>
        <ul className="lista">
          {proveedores.map((p) => (
            <li key={p.id}>
              <Link
                href={`/configuracion/proveedores/auditoria?proveedor=${p.id}`}
                className={p.id === elegido ? 'boton' : 'boton boton-secundario'}
              >
                {p.tradeName}
              </Link>
            </li>
          ))}
        </ul>
      </div>

      {informe ? (
        <>
          <div className="card">
            <div className="card-titulo">
              <h2>{informe.proveedor.nombre}</h2>
              <span className="chico medio">
                {informe.total} comprobante{informe.total === 1 ? '' : 's'}
              </span>
            </div>
            {/*
              Los dos números juntos: cuántos hay y cuántos pesan.

              El segundo es el que importa. Un grupo de tres sospechosos donde
              ninguno está validado no tiene ningún efecto sobre la deuda, los
              costos ni el stock, y leer sólo el primer número lleva a la
              conclusión contraria.
            */}
            <dl style={{ margin: 0 }}>
              {ORDEN.map((v) => (
                <div className="dato" key={v}>
                  <dt>{VEREDICTO_LABEL[v]}</dt>
                  <dd>
                    {informe.porVeredicto[v].length}
                    {informe.porVeredicto[v].length > 0 ? (
                      <span className="chico medio">
                        {' · '}
                        {informe.conImpactoPorVeredicto[v] === 0
                          ? 'ninguno pesa'
                          : `${informe.conImpactoPorVeredicto[v]} pesa${
                              informe.conImpactoPorVeredicto[v] === 1 ? '' : 'n'
                            } en deuda y costos`}
                      </span>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>

            <p className="chico medio mt mb0">
              {informe.conImpacto === 0
                ? `Ninguno de los ${informe.total} comprobantes está validado: no pesan en la deuda, ` +
                  'en los costos ni en el stock.'
                : `${informe.conImpacto} de ${informe.total} están validados y pesan en la deuda, ` +
                  'los costos y el stock. Los demás son lecturas en revisión o comprobantes ' +
                  'anulados, que no están en ninguno de esos números.'}
            </p>
            {informe.sinTextoDeOcr > 0 ? (
              <p className="chico medio mt mb0">
                {informe.sinTextoDeOcr} de esos comprobantes no guardaron el texto de la lectura:
                de ésos no hay papel que mirar.
              </p>
            ) : null}
            <p className="chico medio mt mb0">
              Generado el {formatDateTimeAr(informe.generadaEl)}.
            </p>
          </div>

          {/*
            Cuando nada de lo señalado pesa, decirlo antes que los grupos.

            Es la conclusión operativa —"no hay nada que arreglar hoy"— y tiene
            que llegar antes que la lista, no después de leerla entera.
          */}
          {informe.total > 0 &&
          informe.conImpactoPorVeredicto.OTRO_PROVEEDOR +
            informe.conImpactoPorVeredicto.SOSPECHOSO ===
            0 ? (
            <div className="card">
              <p className="mensaje mensaje-ok mb0" role="status">
                No hay comprobantes validados con la atribución en duda: nada de lo que aparece
                acá abajo afecta la deuda con el proveedor, los costos ni el stock.
              </p>
            </div>
          ) : null}

          {informe.total === 0 ? (
            <div className="card">
              <div className="vacio">
                <div className="vacio-titulo">Sin comprobantes cargados</div>
                <p className="mb0">Este proveedor no tiene ningún comprobante que revisar.</p>
              </div>
            </div>
          ) : null}

          {ORDEN.filter((v) => informe.porVeredicto[v].length > 0).map((v) => (
            <div className="card" key={v}>
              <div className="card-titulo">
                <h2>{VEREDICTO_LABEL[v]}</h2>
                <span className="chico medio">{informe.porVeredicto[v].length}</span>
              </div>
              <p className={`mensaje ${CLASE[v]}`}>{EXPLICACION[v]}</p>
              <ul className="lista">
                {informe.porVeredicto[v].map((c) => (
                  <Ficha key={c.documentId} c={c} />
                ))}
              </ul>
            </div>
          ))}
        </>
      ) : (
        <div className="card">
          <div className="vacio">
            <div className="vacio-titulo">Elegí un proveedor</div>
            <p className="mb0">La revisión se hace de a un proveedor por vez.</p>
          </div>
        </div>
      )}
    </>
  );
}
