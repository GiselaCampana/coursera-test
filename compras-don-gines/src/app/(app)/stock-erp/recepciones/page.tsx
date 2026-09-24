import type { Metadata } from 'next';
import Link from 'next/link';
import { requireUserOrRedirect, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import { formatCorteAr } from '@/lib/datetime';
import {
  listadoDeRecepciones,
  interruptorDeRecepcionesReales,
  type FilaPendiente,
} from '@/lib/services/stock-erp-recepcion';
import { EnPreparacion } from '../EnPreparacion';

export const metadata: Metadata = { title: 'Stock ERP · Recepciones' };
export const dynamic = 'force-dynamic';

/**
 * El listado de recepciones, en seis grupos.
 *
 * **No hay bandeja.** Nada de lo que se ve acá arriba está guardado en una
 * tabla de pendientes: son comprobantes validados sin una decisión de
 * recepción, calculados cada vez. Una bandeja guardada se desincroniza sola —un
 * comprobante anulado seguiría figurando, uno validado después no aparecería— y
 * el día que no coincide, nadie sabe cuál de las dos listas tiene razón.
 *
 * Lo que la base guarda es la DECISIÓN, que son los tres grupos de abajo.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; sucursal?: string }>;
}) {
  const { q, sucursal } = await searchParams;
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
  const interruptor = await interruptorDeRecepcionesReales();
  const listado = await listadoDeRecepciones(user, { texto: q, branchId: sucursal });

  const aplicadas = listado.decididas.filter((d) => d.resolution === 'APLICADA');
  const enApertura = listado.decididas.filter((d) => d.resolution === 'INCLUIDA_EN_APERTURA');
  const excluidas = listado.decididas.filter((d) => d.resolution === 'EXCLUIDA');

  const puedeConfirmar = hasPermission(user, PERMISSIONS.STOCKERP_RECEPCION_CONFIRMAR);

  return (
    <main className="contenido">
      <EnPreparacion>
        Recibir una compra suma mercadería al libro; todavía nada la descuenta.
      </EnPreparacion>

      <h1>Recepciones de compras</h1>
      <p className="chico">
        Validar una factura y recibir la mercadería son dos cosas distintas. Validar registra
        costos, deuda y pagos; recibir es este acto, con su fecha física y su confirmación. Un
        comprobante validado sin recepción no es un error: quiere decir que el papel llegó y la
        mercadería todavía no se recibió acá.
      </p>
      <p className="chico">
        Control de Stock Don Ginés sigue siendo una aplicación aparte. Esta pantalla{' '}
        <strong>no le envía nada</strong>: los movimientos se asientan en el libro de existencias de
        Compras.
      </p>

      <p
        className={interruptor.encendido ? 'mensaje mensaje-aviso' : 'mensaje'}
        data-prueba="interruptor-recepciones"
      >
        Recepciones con mercadería real:{' '}
        <strong>{interruptor.encendido ? 'HABILITADAS' : 'deshabilitadas'}</strong>.{' '}
        {interruptor.encendido
          ? `Lo habilitó ${interruptor.cambiadoPor ?? 'alguien'}: ${interruptor.motivo ?? ''}`
          : 'Sólo se aplican recepciones sobre aperturas ficticias, y únicamente contra una base de pruebas.'}
      </p>

      {!puedeConfirmar && (
        <p className="mensaje" data-prueba="sin-permiso-confirmar">
          Podés mirar y preparar, pero no confirmar: falta el permiso
          «stockerp.recepcion.confirmar», que se otorga a una persona por su nombre.
        </p>
      )}

      {/* --- Buscador ------------------------------------------------------- */}
      <form
        method="get"
        data-prueba="form-buscar"
        style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-end' }}
      >
        <div style={{ flex: '1 1 180px', minWidth: 0 }}>
          <label className="etiqueta" htmlFor="q">
            Buscar
          </label>
          <input
            id="q"
            name="q"
            type="search"
            defaultValue={q ?? ''}
            placeholder="Proveedor, número, artículo o PLU"
            data-prueba="buscar"
          />
        </div>
        <div style={{ flex: '1 1 140px', minWidth: 0 }}>
          <label className="etiqueta" htmlFor="sucursal">
            Sucursal
          </label>
          <select id="sucursal" name="sucursal" defaultValue={sucursal ?? ''} data-prueba="filtro-sucursal">
            <option value="">Todas</option>
            {sucursales.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="boton-secundario" data-prueba="aplicar-busqueda">
          Buscar
        </button>
      </form>

      <Pendientes
        titulo="Listas para recibir"
        grupo="pendientes"
        filas={listado.pendientes}
        vacio="No hay comprobantes validados esperando recepción."
      />

      <Pendientes
        titulo="Bloqueadas"
        grupo="bloqueadas"
        filas={listado.bloqueadas}
        vacio="Ninguna recepción bloqueada."
        nota="Algo las frena. El motivo está en cada una: hasta resolverlo, no se puede recibir."
      />

      <Pendientes
        titulo="Anteriores o iguales al corte"
        grupo="anteriores-al-corte"
        filas={listado.anterioresAlCorte}
        vacio="Ninguna."
        nota={
          'El comprobante es de antes del corte de apertura de su sucursal, así que lo más probable ' +
          'es que su mercadería ya esté contada. Es un AVISO, no la decisión: la decisión la toma la ' +
          'fecha en que llegó físicamente, que se carga al abrirla y puede ser posterior al corte.'
        }
      />

      {listado.mirados >= listado.tope && (
        <p className="chico" data-prueba="hay-mas">
          Se miraron los {listado.tope} comprobantes más recientes. Si esperabas uno más viejo,
          buscalo por proveedor o número.
        </p>
      )}

      {/* --- Las decisiones ya tomadas -------------------------------------- */}
      <Decididas titulo="Aplicadas" grupo="aplicadas" filas={aplicadas} />
      <Decididas titulo="Incluidas en la apertura" grupo="incluidas-en-apertura" filas={enApertura} />
      <Decididas titulo="Excluidas" grupo="excluidas" filas={excluidas} />

      <p className="chico">
        <Link href="/stock-erp/aperturas">Aperturas de existencias →</Link>
      </p>
    </main>
  );
}

function Pendientes({
  titulo,
  grupo,
  filas,
  vacio,
  nota,
}: {
  titulo: string;
  grupo: string;
  filas: FilaPendiente[];
  vacio: string;
  nota?: string;
}) {
  return (
    <section data-prueba={`grupo-${grupo}`}>
      <h2>
        {titulo} <span data-prueba="cuenta">({filas.length})</span>
      </h2>
      {nota && <p className="chico">{nota}</p>}
      {filas.length === 0 && <p className="chico">{vacio}</p>}
      {filas.map((f) => (
        <article className="tarjeta" key={f.documentId} data-prueba="fila" data-documento={f.documentId}>
          <header style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <strong style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{f.proveedor}</strong>
            <span className="chico" style={{ overflowWrap: 'anywhere' }}>
              {f.numero}
            </span>
            <span className="chico" style={{ flex: 1 }}>
              {f.sucursal}
            </span>
          </header>
          <p className="chico">
            {f.renglonesDeMercaderia} renglones con posible mercadería · Comprobante del{' '}
            {f.issueDate ? formatCorteAr(f.issueDate) : 'sin fecha'}
            {f.cutoffAt ? ` · Corte de apertura: ${formatCorteAr(f.cutoffAt)}` : ' · Sucursal sin apertura'}
          </p>
          {f.motivos.length > 0 && (
            <ul className="chico" data-prueba="motivos">
              {f.motivos.map((m) => (
                <li key={m} data-prueba="motivo" style={{ overflowWrap: 'anywhere' }}>
                  {m}
                </li>
              ))}
            </ul>
          )}
          <Link
            href={`/stock-erp/recepciones/${f.documentId}`}
            className="boton"
            data-prueba="abrir-recepcion"
          >
            Ver qué entraría
          </Link>
        </article>
      ))}
    </section>
  );
}

function Decididas({
  titulo,
  grupo,
  filas,
}: {
  titulo: string;
  grupo: string;
  filas: Awaited<ReturnType<typeof listadoDeRecepciones>>['decididas'];
}) {
  return (
    <section data-prueba={`grupo-${grupo}`}>
      <h2>
        {titulo} <span data-prueba="cuenta">({filas.length})</span>
      </h2>
      {filas.length === 0 && <p className="chico">Ninguna todavía.</p>}
      {filas.map((d) => (
        <article className="tarjeta" key={d.id} data-prueba="fila" data-documento={d.documentId}>
          <header style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <strong style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
              {d.document.supplier?.tradeName ?? '—'}
            </strong>
            <span className="chico" style={{ overflowWrap: 'anywhere' }}>
              {d.document.fullNumber ?? ''}
            </span>
            <span className="chico" style={{ flex: 1 }}>
              {d.branch.name}
            </span>
          </header>
          <p className="chico" data-prueba="detalle-decidida">
            Recibida el <strong>{formatCorteAr(d.receivedAt)}</strong> ·{' '}
            <strong data-prueba="movimientos">{d.operation?.movementCount ?? 0}</strong> movimientos
            {d.decidedBy?.name ? ` · por ${d.decidedBy.name}` : ''}
            {d.manualOverride ? ' · excepción histórica documentada' : ''}
          </p>
          {d.reason && (
            <p className="chico" data-prueba="motivo-decidida" style={{ overflowWrap: 'anywhere' }}>
              {d.reason}
            </p>
          )}
          <Link
            href={`/stock-erp/recepciones/${d.documentId}`}
            className="boton-secundario chico"
            data-prueba="abrir-recepcion"
          >
            Ver la decisión
          </Link>
        </article>
      ))}
    </section>
  );
}
