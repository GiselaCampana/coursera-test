import type { Metadata } from 'next';
import Link from 'next/link';
import { requireUserOrRedirect, branchScopeFilter } from '@/lib/auth/session';
import { prisma, type Prisma } from '@/lib/db';
import { formatARS } from '@/lib/money';
import { formatDateAr, parseArDate } from '@/lib/datetime';
import { EtiquetaComprobante, EtiquetaControl } from '@/components/Estado';

export const metadata: Metadata = { title: 'Comprobantes' };
export const dynamic = 'force-dynamic';

const ESTADOS = [
  { valor: '', texto: 'Todos' },
  { valor: 'REQUIERE_REVISION', texto: 'A revisar' },
  { valor: 'VALIDADO', texto: 'Confirmados' },
  { valor: 'BORRADOR', texto: 'Borradores' },
  { valor: 'ANULADO', texto: 'Anulados' },
];

interface Props {
  searchParams: Promise<{
    estado?: string;
    proveedor?: string;
    sucursal?: string;
    desde?: string;
    hasta?: string;
    buscar?: string;
  }>;
}

export default async function PaginaComprobantes({ searchParams }: Props) {
  const user = await requireUserOrRedirect();
  const filtros = await searchParams;

  const where: Prisma.DocumentWhereInput = { ...branchScopeFilter(user) };

  if (filtros.estado && ESTADOS.some((e) => e.valor === filtros.estado)) {
    where.status = filtros.estado as Prisma.DocumentWhereInput['status'];
  }
  if (filtros.proveedor) where.supplierId = filtros.proveedor;
  // Un operador no puede consultar otra sucursal ni pidiéndolo por la URL.
  if (filtros.sucursal && (user.scopeAllBranches || filtros.sucursal === user.branchId)) {
    where.branchId = filtros.sucursal;
  }

  const desde = filtros.desde ? parseArDate(filtros.desde) : null;
  const hasta = filtros.hasta ? parseArDate(filtros.hasta) : null;
  if (desde || hasta) {
    where.issueDate = {};
    if (desde) where.issueDate.gte = desde;
    if (hasta) where.issueDate.lte = hasta;
  }
  if (filtros.buscar?.trim()) {
    const texto = filtros.buscar.trim();
    where.OR = [
      { fullNumber: { contains: texto, mode: 'insensitive' } },
      { number: { contains: texto, mode: 'insensitive' } },
      { supplier: { tradeName: { contains: texto, mode: 'insensitive' } } },
    ];
  }

  const [documentos, proveedores, sucursales] = await Promise.all([
    prisma.document.findMany({
      where,
      include: {
        supplier: { select: { tradeName: true } },
        branch: { select: { name: true } },
        paymentSchedule: { select: { status: true } },
        _count: { select: { items: true } },
      },
      orderBy: [{ issueDate: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    }),
    prisma.supplier.findMany({ orderBy: { tradeName: 'asc' }, select: { id: true, tradeName: true } }),
    prisma.branch.findMany({
      where: user.scopeAllBranches ? {} : { id: user.branchId ?? '__ninguna__' },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
  ]);

  return (
    <>
      <h1>Comprobantes</h1>

      <div className="pestanas">
        {ESTADOS.map((estado) => {
          const params = new URLSearchParams();
          if (estado.valor) params.set('estado', estado.valor);
          const actual = (filtros.estado ?? '') === estado.valor;
          return (
            <Link
              key={estado.valor || 'todos'}
              href={`/comprobantes${params.toString() ? `?${params}` : ''}`}
              className="pestana"
              aria-current={actual ? 'page' : undefined}
            >
              {estado.texto}
            </Link>
          );
        })}
      </div>

      <form className="card card-compacta" method="get">
        {filtros.estado ? <input type="hidden" name="estado" value={filtros.estado} /> : null}
        <div className="filtros">
          <div className="campo">
            <label htmlFor="buscar">Buscar</label>
            <input
              id="buscar"
              name="buscar"
              type="search"
              defaultValue={filtros.buscar ?? ''}
              placeholder="Número o proveedor"
            />
          </div>
          <div className="campo">
            <label htmlFor="proveedor">Proveedor</label>
            <select id="proveedor" name="proveedor" defaultValue={filtros.proveedor ?? ''}>
              <option value="">Todos</option>
              {proveedores.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.tradeName}
                </option>
              ))}
            </select>
          </div>
          {sucursales.length > 1 ? (
            <div className="campo">
              <label htmlFor="sucursal">Sucursal</label>
              <select id="sucursal" name="sucursal" defaultValue={filtros.sucursal ?? ''}>
                <option value="">Todas</option>
                {sucursales.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="campo">
            <label htmlFor="desde">Desde</label>
            <input id="desde" name="desde" type="date" defaultValue={filtros.desde ?? ''} />
          </div>
          <div className="campo">
            <label htmlFor="hasta">Hasta</label>
            <input id="hasta" name="hasta" type="date" defaultValue={filtros.hasta ?? ''} />
          </div>
        </div>
        <div className="acciones">
          <button type="submit" className="boton boton-chico">
            Filtrar
          </button>
          <Link href="/comprobantes" className="boton boton-secundario boton-chico">
            Limpiar
          </Link>
        </div>
      </form>

      {documentos.length === 0 ? (
        <div className="card">
          <div className="vacio">
            <div className="vacio-titulo">No hay comprobantes con esos filtros</div>
            <p className="mb0">Probá ampliar el período o quitar algún filtro.</p>
          </div>
        </div>
      ) : (
        <ul className="lista">
          {documentos.map((doc) => (
            <li key={doc.id}>
              <Link href={`/comprobantes/${doc.id}`} className="fila-dato">
                <div className="fila-dato-cabecera">
                  <span className="fila-dato-titulo">
                    {doc.supplier?.tradeName ?? 'Proveedor sin identificar'}
                  </span>
                  <span className="fila-dato-importe">
                    {doc.total ? formatARS(doc.total.toString()) : '—'}
                  </span>
                </div>
                <div className="fila-dato-meta">
                  <span>
                    {doc.docType === 'REMITO'
                      ? 'Remito'
                      : doc.docType === 'NOTA_CREDITO'
                        ? `Nota de crédito ${doc.letter ?? ''}`.trim()
                        : `Factura ${doc.letter ?? ''}`.trim()}{' '}
                    {doc.fullNumber || 'sin número'}
                  </span>
                  <span>{formatDateAr(doc.issueDate)}</span>
                  <span>{doc.branch.name}</span>
                  <span>
                    {doc._count.items} artículo{doc._count.items === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="fila-dato-meta mt">
                  <EtiquetaComprobante estado={doc.status} />
                  <EtiquetaControl estado={doc.checkState} />
                  {doc.paymentSchedule ? (
                    <span className="chico medio">
                      Pago: {doc.paymentSchedule.status.toLowerCase().replace('_', ' ')}
                    </span>
                  ) : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
