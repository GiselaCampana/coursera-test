import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUserOrRedirect, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import {
  buscarEnCatalogo,
  familiasConMarcajes,
  reglaGeneralDeMarcajes,
} from '@/lib/services/catalogo';
import { formatDateAr } from '@/lib/datetime';
import { Importar } from './Importar';
import { MarcajesDeFamilia } from './MarcajesDeFamilia';
import { ReglaGeneral } from './ReglaGeneral';

export const metadata: Metadata = { title: 'Catálogo Don Ginés' };
export const dynamic = 'force-dynamic';

/**
 * El catálogo interno de Don Ginés, tal como lo define Control de Stock.
 *
 * Compras no inventa PLU. Los artículos y sus números internos vienen de la
 * aplicación de Control de Stock, que es la fuente; acá se los mira, se los
 * busca y se los vuelve a traer cuando cambian.
 *
 * La búsqueda acepta las tres cosas que uno puede tener a mano —el PLU, el
 * nombre, o el código con que lo factura un proveedor— porque depende de dónde
 * uno esté parado: frente a la balanza se sabe el PLU, frente a la factura se
 * sabe el código del proveedor, y hablando con alguien se sabe el nombre.
 */

export default async function PaginaCatalogo({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    familia?: string;
    importado?: string;
    nuevos?: string;
    act?: string;
    cod?: string;
    conf?: string;
  }>;
}) {
  const user = await requireUserOrRedirect();
  if (!hasPermission(user, PERMISSIONS.PRODUCTOS_GESTIONAR)) redirect('/configuracion');

  const { q, familia, importado, nuevos, act, cod, conf } = await searchParams;

  const [articulos, familias, totales] = await Promise.all([
    buscarEnCatalogo(user, q ?? '', { familyId: familia || null }),
    prisma.productFamily.findMany({ orderBy: { name: 'asc' } }),
    prisma.product.aggregate({ _count: { _all: true } }),
  ]);

  const sinFamilia = await prisma.product.count({ where: { familyId: null } });
  const [marcajesPorFamilia, general] = await Promise.all([
    familiasConMarcajes(user),
    reglaGeneralDeMarcajes(user),
  ]);

  return (
    <>
      <h1>Catálogo Don Ginés</h1>
      <p className="medio">
        Los artículos y sus PLU internos. La fuente es Control de Stock: acá no se numera nada, se
        trae. Un PLU nunca cambia por una factura ni por un parecido de nombre.
      </p>

      {importado ? (
        <>
          <p className="mensaje mensaje-ok" role="status">
            Catálogo importado: {nuevos} artículo/s nuevos, {act} actualizado/s y {cod} código/s de
            proveedor aprendidos.
            {Number(conf) > 0
              ? ` Quedaron ${conf} conflicto/s sin aplicar: volvé a importar el archivo para verlos en detalle.`
              : ''}
          </p>
          <div className="acciones">
            <Link href="/configuracion/productos/asociaciones" className="boton">
              Continuar con asociaciones históricas
            </Link>
          </div>
        </>
      ) : null}

      <div className="card card-compacta">
        <dl className="resumen-mes" style={{ margin: 0 }}>
          <div className="dato destacado">
            <dt>Artículos</dt>
            <dd>{totales._count._all}</dd>
          </div>
          <div className="dato">
            <dt>Familias</dt>
            <dd>{familias.length}</dd>
          </div>
          <div className="dato">
            <dt>Sin familia</dt>
            <dd>{sinFamilia}</dd>
          </div>
        </dl>
      </div>

      {/*
        La cadena de marcajes, de abajo hacia arriba: primero la regla general
        —el último recurso— y después las familias. El artículo se configura en
        Precios, que es donde se lo mira contra su costo.
      */}
      <div className="card">
        <div className="card-titulo">
          <h2>Regla general de marcajes</h2>
        </div>
        <p className="chico medio">
          El tercer y último nivel: <strong>artículo → familia → regla general</strong>. Se aplica
          sólo donde el artículo y su familia no dicen nada. Es la única configuración global; no
          hay otra en paralelo.
        </p>
        <ReglaGeneral
          marcajes={general.marcajes}
          dependenDeElla={general.dependenDeElla}
          existe={general.id !== null}
        />
      </div>

      {/*
        Los marcajes de cada familia, arriba del buscador de artículos.

        Van acá porque es donde vive la familia, y porque configurarlos una vez
        por familia es lo que evita cargarlos treinta veces, una por PLU, con
        una oportunidad de equivocarse en cada una.
      */}
      <div className="card">
        <div className="card-titulo">
          <h2>Marcajes por familia</h2>
          <span className="chico medio">{marcajesPorFamilia.length}</span>
        </div>
        <p className="chico medio">
          Cada artículo puede tener el suyo; el que no lo tiene usa el de su familia, y si la
          familia tampoco lo define, la regla general. Configurarlo acá no toca ningún
          artículo: los que heredan pasan a usar el número nuevo y los que tienen el suyo siguen
          igual.
        </p>
        {marcajesPorFamilia.length === 0 ? (
          <div className="vacio">
            <div className="vacio-titulo">Todavía no hay familias</div>
            <p className="mb0">Se crean al importar el catálogo de Control de Stock.</p>
          </div>
        ) : (
          <ul className="lista">
            {marcajesPorFamilia.map((f) => (
              <li key={f.id}>
                <MarcajesDeFamilia
                  familyId={f.id}
                  nombre={f.nombre}
                  articulos={f.articulos}
                  heredanElBase={f.heredanElBase}
                  marcajes={f.marcajes}
                  general={general.marcajes}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <form className="card card-compacta" method="get">
        <div className="campo">
          <label htmlFor="q">Buscar</label>
          <input
            id="q"
            name="q"
            type="search"
            defaultValue={q ?? ''}
            placeholder="1211, cremoso, ART-00228"
          />
          <p className="ayuda">
            Sirve el PLU, el nombre o el código de cualquier proveedor: los tres encuentran el mismo
            artículo.
          </p>
        </div>
        <div className="campo">
          <label htmlFor="familia">Familia</label>
          <select id="familia" name="familia" defaultValue={familia ?? ''}>
            <option value="">Todas</option>
            {familias.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
        <div className="acciones">
          <button type="submit" className="boton boton-secundario">
            Buscar
          </button>
          {q || familia ? (
            <Link href="/configuracion/catalogo" className="boton boton-secundario">
              Ver todos
            </Link>
          ) : null}
        </div>
      </form>

      <div className="card">
        <div className="card-titulo">
          <h2>Artículos</h2>
          <span className="chico medio">{articulos.length}</span>
        </div>

        {articulos.length === 0 ? (
          <div className="vacio">
            <div className="vacio-titulo">
              {q || familia ? 'No hay ningún artículo con eso' : 'Todavía no hay catálogo cargado'}
            </div>
            <p className="mb0">
              {q || familia
                ? 'Probá con el PLU, con parte del nombre o con el código del proveedor.'
                : 'Importalo desde Control de Stock con el botón de abajo. Compras no da de alta artículos por su cuenta.'}
            </p>
          </div>
        ) : (
          <div className="tabla-scroll">
            <table>
              <thead>
                <tr>
                  <th>PLU</th>
                  <th>Nombre</th>
                  <th>Familia</th>
                  <th>Códigos por proveedor</th>
                  <th>Activo</th>
                  <th>Sincronizado</th>
                </tr>
              </thead>
              <tbody>
                {articulos.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <strong>{a.plu}</strong>
                    </td>
                    <td style={{ whiteSpace: 'normal', minWidth: 180 }}>{a.nombre}</td>
                    <td>{a.familia ?? <span className="suave">—</span>}</td>
                    <td style={{ whiteSpace: 'normal', minWidth: 200 }}>
                      {a.codigos.length === 0 ? (
                        <span className="suave">—</span>
                      ) : (
                        a.codigos.map((c) => `${c.proveedor}: ${c.codigo}`).join(' · ')
                      )}
                    </td>
                    <td>{a.activo ? 'Sí' : 'No'}</td>
                    <td>{a.sincronizado ? formatDateAr(a.sincronizado) : <span className="suave">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <h2>Importar o actualizar desde Control de Stock</h2>
      <Importar />

      <div className="acciones">
        <Link href="/configuracion/productos" className="boton boton-secundario">
          Productos y alias
        </Link>
        <Link href="/configuracion" className="boton boton-secundario">
          Volver a Configuración
        </Link>
      </div>
    </>
  );
}
