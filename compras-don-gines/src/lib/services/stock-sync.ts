import 'server-only';
import { prisma } from '@/lib/db';
import { ForbiddenError } from '@/lib/errors';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { hasPermission, type AuthUser } from '@/lib/auth/session';
import { normalizeText } from '@/lib/domain/matching';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/services/audit';
import {
  RespuestaDeStockInvalida,
  leerRespuestaDeStock,
  type ProductoDeStock,
} from '@/lib/domain/stock-catalogo';
import { descargarCatalogoDeStock } from '@/lib/services/stock-descarga';

/**
 * Sincronizar el catálogo de Compras con Control de Stock.
 *
 * Control de Stock es la fuente de qué artículos existen y cómo se llaman.
 * Compras es la fuente de lo suyo: qué se compró, a cuánto, con qué marcaje se
 * vende. La sincronización cruza esa frontera en una sola dirección y no la
 * pisa nunca: **no toca** compras, costos, marcajes, reglas de precio,
 * márgenes, asociaciones de códigos de proveedor ni ningún histórico.
 *
 * Siempre en dos pasos. Primero una vista previa que no escribe nada y que
 * separa lo que va a pasar en cuatro montones —nuevos, modificados campo por
 * campo, sin cambios, y los que quedarían inactivos—, y después una
 * confirmación aparte. Que el paso 2 use exactamente el mismo cálculo que el
 * paso 1 no es prolijidad: una vista previa que estima por su cuenta es una
 * vista previa que puede mentir.
 *
 * Y nunca borra ni renumera. Un artículo que desaparece del catálogo maestro se
 * marca inactivo; su PLU, su historial y sus precios quedan donde están.
 */

/** De qué campos manda Control de Stock. Los demás no se tocan. */
const CAMPOS_MAESTROS = [
  'Nombre',
  'Proveedor habitual',
  'Tipo',
  'Subtipo',
  'Familia',
  'Unidad de compra',
  'Imagen',
  'Activo',
] as const;

export type CampoMaestro = (typeof CAMPOS_MAESTROS)[number];

export interface CambioDeCampo {
  campo: CampoMaestro;
  antes: string;
  despues: string;
}

/**
 * Un artículo cuyo proveedor entrante no se pudo resolver.
 *
 * Control de Stock nombra proveedores con texto libre, y ese texto muchas veces
 * es una marca o un fabricante y no la empresa a la que Compras le compra y le
 * paga. Compras no puede crear una ficha de proveedor con sólo un nombre: le
 * faltarían CUIT, razón social y condiciones comerciales, que es de donde salen
 * los plazos de pago y la cuenta corriente.
 *
 * Así que no se resuelve, y lo que importa es **qué pasa entonces con el
 * artículo**. Son tres casos distintos y la pantalla los separa, porque uno es
 * inofensivo y otro requiere que alguien cargue el proveedor después.
 */
export interface ProveedorSinResolver {
  plu: string;
  nombre: string;
  /** Lo que dijo Control de Stock. Vacío si no dijo nada. */
  entrante: string;
  /** El proveedor habitual que el artículo ya tiene, cuando lo tiene. */
  actual: string | null;
  efecto:
    | 'Se conserva el proveedor actual'
    | 'Artículo nuevo, queda sin proveedor habitual'
    | 'Sigue sin proveedor habitual';
}

export interface ArticuloDeLaVistaPrevia {
  plu: string;
  nombre: string;
  /** Vacío en los que no cambian; con el antes y el después en los demás. */
  cambios: CambioDeCampo[];
}

export interface VistaPreviaDeSincronizacion {
  schemaVersion: string;
  /** Cuántos artículos trajo el catálogo maestro. */
  leidos: number;
  nuevos: ArticuloDeLaVistaPrevia[];
  modificados: ArticuloDeLaVistaPrevia[];
  sinCambios: ArticuloDeLaVistaPrevia[];
  /**
   * Los que quedarían inactivos, con el motivo.
   *
   * Dos motivos posibles y conviene distinguirlos: que Control de Stock los
   * haya dado de baja, o que ya no aparezcan en su catálogo. En los dos casos
   * el artículo se conserva entero —PLU, compras, costos, precios— y sólo deja
   * de estar activo.
   */
  quedarianInactivos: { plu: string; nombre: string; motivo: string }[];
  /** Cuántos artículos tiene hoy Compras, activos e inactivos. */
  enCompras: number;
  /**
   * Los que Compras tiene, el maestro ya no nombra, y **ya estaban inactivos**.
   *
   * No cambian nada, así que no van al montón de las bajas. Pero sin contarlos
   * la cuenta no cierra: alguien mira «145 artículos, 134 modificados, 0
   * inactivaciones» y no tiene forma de saber qué pasó con los otros once. Un
   * número que no cierra obliga a desconfiar de todos los demás.
   */
  yaEstabanInactivos: number;
  /** Familias que habría que crear para poder clasificar lo que llega. */
  familiasNuevas: string[];
  /** Nombres de proveedor que Control de Stock usa y Compras no tiene. */
  proveedoresDesconocidos: string[];
  /**
   * Nombres que coinciden con **más de un** proveedor de Compras.
   *
   * Tampoco se aplican. «Reconocido» tiene que querer decir reconocido sin
   * ambigüedad: elegir uno de dos por el orden en que salieron de la base es
   * reasignarle el proveedor a un artículo por azar, y de ahí cuelgan el plazo
   * de pago y la cuenta corriente.
   */
  proveedoresAmbiguos: string[];
  /** Artículo por artículo, qué pasa cuando el proveedor no resuelve. */
  proveedoresSinResolver: ProveedorSinResolver[];
  /** Cuántos se escribieron. Cero mientras es sólo una vista previa. */
  aplicados: number;
}

const SIN_DATO = '—';

/** Lo que se muestra de un valor que puede faltar. */
const mostrar = (valor: string | null | undefined): string =>
  valor === null || valor === undefined || valor === '' ? SIN_DATO : valor;

/**
 * De dónde sale la familia con la que Compras agrupa: del **tipo**.
 *
 * Familia y tipo son el mismo nivel —«Quesos»—, y el subtipo —«Cremosos»— vive
 * en su propio campo. Antes esto devolvía el subtipo, y el resultado fue que
 * cada subtipo se convertía en una familia suelta: «Cremoso», «Cremosos»,
 * «Duros», «Especial», «Especiales», veintiocho familias donde el maestro tiene
 * un puñado de tipos. Eso rompe justo lo que la familia viene a resolver, que
 * es configurar el rubro una vez en lugar de treinta.
 *
 * Sin tipo no hay familia. No se cae al subtipo: sería volver al mismo error
 * por la puerta de atrás, y el artículo sin familia se ve —la pantalla de
 * catálogo cuenta los que no tienen— mientras que uno mal clasificado no.
 */
function familiaDe(articulo: ProductoDeStock): string | null {
  return articulo.tipo ?? null;
}

/**
 * Índice de proveedores por nombre, con la ambigüedad marcada.
 *
 * Un nombre puede llegar a más de un proveedor: la razón social de uno puede
 * coincidir con el alias de otro. Antes ganaba el último que saliera de la
 * base, en silencio. Ahora un nombre así queda con `null` —ambiguo— y se trata
 * igual que uno desconocido: no se aplica, se avisa, y el artículo conserva el
 * proveedor que ya tenía.
 *
 * Lo usan la vista previa y la confirmación, y por eso vive en un solo lugar:
 * si cada una armara el suyo, podrían no coincidir y la vista previa mentiría.
 */
function indiceDeProveedores(
  filas: { id: string; tradeName: string; aliases: { normalized: string }[] }[],
): Map<string, string | null> {
  const porNombre = new Map<string, string | null>();
  const anotar = (nombre: string, id: string) => {
    if (nombre === '') return;
    const anterior = porNombre.get(nombre);
    if (anterior === undefined) porNombre.set(nombre, id);
    else if (anterior !== id) porNombre.set(nombre, null); // ambiguo
  };
  for (const fila of filas) {
    anotar(normalizeText(fila.tradeName), fila.id);
    for (const alias of fila.aliases) anotar(alias.normalized, fila.id);
  }
  return porNombre;
}

/** Lo que hay hoy en Compras, en la forma en que hace falta compararlo. */
async function fotoDelCatalogoActual() {
  const productos = await prisma.product.findMany({
    select: {
      id: true,
      internalCode: true,
      normalizedName: true,
      category: true,
      subtype: true,
      purchaseUnit: true,
      imageUrl: true,
      active: true,
      familyId: true,
      family: { select: { name: true } },
      defaultSupplierId: true,
      defaultSupplier: { select: { tradeName: true } },
    },
  });
  return productos;
}

type ProductoActual = Awaited<ReturnType<typeof fotoDelCatalogoActual>>[number];

/**
 * Prepara la sincronización: descarga, valida y calcula qué cambiaría.
 *
 * Si algo de eso falla, lanza. No devuelve una vista previa a medias, porque
 * una vista previa a medias es una invitación a confirmar sin saber.
 */
export async function vistaPreviaDeStock(
  user: AuthUser,
  opciones: { contenido?: string } = {},
): Promise<VistaPreviaDeSincronizacion> {
  if (!hasPermission(user, PERMISSIONS.PRODUCTOS_GESTIONAR)) {
    throw new ForbiddenError('Tu usuario no puede administrar el catálogo.');
  }

  const crudo = opciones.contenido ?? (await descargarCatalogoDeStock());
  const catalogo = leerRespuestaDeStock(crudo);
  return await calcular(catalogo.schemaVersion, catalogo.productos);
}

async function calcular(
  schemaVersion: string,
  articulos: ProductoDeStock[],
): Promise<VistaPreviaDeSincronizacion> {
  const actuales = await fotoDelCatalogoActual();
  const porPlu = new Map(actuales.map((p) => [p.internalCode, p]));

  const proveedores = await prisma.supplier.findMany({
    select: { id: true, tradeName: true, aliases: { select: { normalized: true } } },
  });
  const proveedorPorNombre = indiceDeProveedores(proveedores);
  const nombrePorId = new Map(proveedores.map((p) => [p.id, p.tradeName]));

  const familias = await prisma.productFamily.findMany({ select: { id: true, name: true, normalized: true } });
  const familiaPorNombre = new Map(familias.map((f) => [f.normalized, f]));

  const vista: VistaPreviaDeSincronizacion = {
    schemaVersion,
    leidos: articulos.length,
    nuevos: [],
    modificados: [],
    sinCambios: [],
    quedarianInactivos: [],
    enCompras: actuales.length,
    yaEstabanInactivos: 0,
    familiasNuevas: [],
    proveedoresDesconocidos: [],
    proveedoresAmbiguos: [],
    proveedoresSinResolver: [],
    aplicados: 0,
  };

  const familiasQueFaltan = new Map<string, string>();
  const vistos = new Set<string>();

  for (const articulo of articulos) {
    vistos.add(articulo.plu);
    const actual = porPlu.get(articulo.plu);
    const familia = familiaDe(articulo);
    if (familia && !familiaPorNombre.has(normalizeText(familia))) {
      familiasQueFaltan.set(normalizeText(familia), familia);
    }

    /*
     * El proveedor entrante, resuelto o no.
     *
     * `undefined` es que el nombre no existe en Compras; `null`, que existe más
     * de una vez. Los dos casos terminan igual —no se aplica— pero se informan
     * distinto, porque uno se arregla dando de alta un proveedor y el otro
     * desambiguando alias que ya están cargados.
     */
    const proveedorNormal = articulo.proveedor ? normalizeText(articulo.proveedor) : '';
    const resuelto = proveedorNormal ? proveedorPorNombre.get(proveedorNormal) : undefined;
    const proveedorId = resuelto ?? null;

    if (articulo.proveedor && resuelto === undefined) {
      if (!vista.proveedoresDesconocidos.includes(articulo.proveedor)) {
        vista.proveedoresDesconocidos.push(articulo.proveedor);
      }
    } else if (articulo.proveedor && resuelto === null) {
      if (!vista.proveedoresAmbiguos.includes(articulo.proveedor)) {
        vista.proveedoresAmbiguos.push(articulo.proveedor);
      }
    }

    /*
     * Qué le pasa a **este** artículo cuando el proveedor no resuelve.
     *
     * Contar los nombres sueltos no alcanza para decidir: lo que hay que saber
     * antes de confirmar es si algún artículo pierde el proveedor que ya tiene.
     * Ninguno lo pierde —y esta lista es donde se ve—, pero los artículos
     * nuevos sí quedan sin proveedor y alguien los tiene que completar después.
     */
    if (proveedorId === null) {
      const actualNombre = actual?.defaultSupplier?.tradeName ?? null;
      vista.proveedoresSinResolver.push({
        plu: articulo.plu,
        nombre: articulo.nombre,
        entrante: articulo.proveedor ?? '',
        actual: actualNombre,
        efecto: !actual
          ? 'Artículo nuevo, queda sin proveedor habitual'
          : actualNombre
            ? 'Se conserva el proveedor actual'
            : 'Sigue sin proveedor habitual',
      });
    }

    if (!actual) {
      vista.nuevos.push({ plu: articulo.plu, nombre: articulo.nombre, cambios: [] });
      continue;
    }

    const cambios = diferencias(
      actual,
      articulo,
      familia,
      proveedorId ? (nombrePorId.get(proveedorId) ?? null) : null,
    );
    const resumen = { plu: articulo.plu, nombre: articulo.nombre, cambios };

    /*
     * Una baja va al montón de las bajas, aunque además cambie de nombre.
     *
     * Es la decisión que hay que mirar antes de confirmar, y mezclarla con los
     * cambios de clasificación la escondería en una lista larga.
     */
    if (articulo.activo === false && actual.active) {
      vista.quedarianInactivos.push({
        plu: articulo.plu,
        nombre: actual.normalizedName,
        motivo: 'Control de Stock lo dio de baja',
      });
      continue;
    }

    if (cambios.length > 0) vista.modificados.push(resumen);
    else vista.sinCambios.push(resumen);
  }

  /*
   * Los que Compras tiene y el catálogo maestro ya no nombra.
   *
   * No se borran nunca: se marcan inactivos. El PLU puede estar en facturas
   * validadas, en costos y en precios aprobados, y borrar la fila dejaría todo
   * eso apuntando a un artículo que no existe.
   */
  for (const actual of actuales) {
    if (vistos.has(actual.internalCode)) continue;
    if (!actual.active) {
      // Ya estaba inactivo: no hay nada que cambiar, pero se cuenta para que la
      // aritmética de la pantalla cierre.
      vista.yaEstabanInactivos += 1;
      continue;
    }
    vista.quedarianInactivos.push({
      plu: actual.internalCode,
      nombre: actual.normalizedName,
      motivo: 'Ya no está en el catálogo de Control de Stock',
    });
  }

  vista.familiasNuevas = [...familiasQueFaltan.values()].sort((a, b) => a.localeCompare(b, 'es'));
  vista.quedarianInactivos.sort((a, b) => a.plu.localeCompare(b.plu, 'es'));
  return vista;
}

/** Qué cambiaría, campo por campo, con el valor de antes y el de después. */
function diferencias(
  actual: ProductoActual,
  articulo: ProductoDeStock,
  familia: string | null,
  proveedor: string | null,
): CambioDeCampo[] {
  const cambios: CambioDeCampo[] = [];

  const anotar = (campo: CampoMaestro, antes: string | null, despues: string | null) => {
    if (despues === null) return; // lo que el maestro no dice, no se toca
    if ((antes ?? '') === despues) return;
    cambios.push({ campo, antes: mostrar(antes), despues });
  };

  anotar('Nombre', actual.normalizedName, articulo.nombre);
  anotar('Proveedor habitual', actual.defaultSupplier?.tradeName ?? null, proveedor);
  anotar('Tipo', actual.category, articulo.tipo);
  anotar('Subtipo', actual.subtype, articulo.subtipo);
  anotar('Familia', actual.family?.name ?? null, familia);
  anotar('Unidad de compra', actual.purchaseUnit, articulo.unidad);
  anotar('Imagen', actual.imageUrl, articulo.imagen);
  if (articulo.activo !== null && actual.active !== articulo.activo) {
    cambios.push({
      campo: 'Activo',
      antes: actual.active ? 'sí' : 'no',
      despues: articulo.activo ? 'sí' : 'no',
    });
  }

  return cambios;
}

/**
 * Aplica la sincronización, en una sola transacción.
 *
 * Se vuelve a descargar y a validar, y se vuelve a calcular con la misma
 * función que armó la vista previa. Confirmar con lo que se guardó de la vista
 * previa sería aplicar una foto vieja del catálogo maestro; recalcular con otro
 * recorrido sería aplicar algo que nadie miró.
 *
 * Todo o nada: si algo falla a mitad de camino, no queda nada escrito.
 */
export async function aplicarSincronizacionDeStock(
  user: AuthUser,
  opciones: { contenido?: string } = {},
): Promise<VistaPreviaDeSincronizacion> {
  if (!hasPermission(user, PERMISSIONS.PRODUCTOS_GESTIONAR)) {
    throw new ForbiddenError('Tu usuario no puede administrar el catálogo.');
  }

  const crudo = opciones.contenido ?? (await descargarCatalogoDeStock());
  const catalogo = leerRespuestaDeStock(crudo);
  const vista = await calcular(catalogo.schemaVersion, catalogo.productos);

  const porPlu = new Map(catalogo.productos.map((a) => [a.plu, a]));
  const aTocar = new Set([
    ...vista.nuevos.map((a) => a.plu),
    ...vista.modificados.map((a) => a.plu),
    ...vista.quedarianInactivos.map((a) => a.plu),
  ]);

  if (aTocar.size === 0) {
    /*
     * Nada que hacer.
     *
     * Es el caso normal de la segunda sincronización seguida, y termina sin
     * escribir ni una fila: sin auditoría de una importación que no importó
     * nada, y sin tocar `catalogSyncedAt`, que si se actualizara haría que
     * "sin cambios" igual dejara rastro de escritura.
     */
    return vista;
  }

  const aplicados = await prisma.$transaction(async (tx) => {
    // Las familias que falten, primero: los artículos las necesitan.
    const familias = await tx.productFamily.findMany({ select: { id: true, normalized: true } });
    const familiaPorNombre = new Map(familias.map((f) => [f.normalized, f.id]));
    for (const nombre of vista.familiasNuevas) {
      const normal = normalizeText(nombre);
      if (familiaPorNombre.has(normal)) continue;
      const creada = await tx.productFamily.create({ data: { name: nombre, normalized: normal } });
      familiaPorNombre.set(normal, creada.id);
    }

    /*
     * El mismo índice que armó la vista previa, con la misma regla de
     * ambigüedad. Nunca se crea un proveedor acá: un nombre de Control de Stock
     * puede ser una marca o un fabricante, y una ficha sin CUIT, razón social
     * ni condiciones comerciales no sirve para pagarle a nadie.
     */
    const proveedores = await tx.supplier.findMany({
      select: { id: true, tradeName: true, aliases: { select: { normalized: true } } },
    });
    const proveedorPorNombre = indiceDeProveedores(proveedores);

    let escritos = 0;

    for (const plu of aTocar) {
      const articulo = porPlu.get(plu);

      if (!articulo) {
        /*
         * Está en Compras y ya no en el catálogo maestro: se desactiva y nada
         * más. No se borra, no se renumera, no se le toca un solo dato de
         * Compras.
         */
        await tx.product.updateMany({ where: { internalCode: plu }, data: { active: false } });
        escritos += 1;
        continue;
      }

      const familia = familiaDe(articulo);
      const familyId = familia ? (familiaPorNombre.get(normalizeText(familia)) ?? null) : null;
      /*
       * Nulo si el nombre no existe, si es ambiguo, o si no vino ninguno. En
       * los tres casos `defaultSupplierId` **queda fuera** del objeto de abajo,
       * y lo que queda fuera no se escribe: el artículo conserva el proveedor
       * habitual que ya tenía. Un proveedor no es una etiqueta: de él cuelgan
       * el plazo de pago, la cuenta corriente y a quién se le paga.
       */
      const proveedorId = articulo.proveedor
        ? (proveedorPorNombre.get(normalizeText(articulo.proveedor)) ?? null)
        : null;

      /*
       * Sólo los campos de los que Control de Stock es la fuente, y sólo
       * cuando los trae.
       *
       * Lo que no está en este objeto no se escribe, y esa es la garantía de
       * que la sincronización no puede tocar un marcaje, un costo ni una
       * asociación de código de proveedor: no los nombra.
       */
      const datos = {
        normalizedName: articulo.nombre,
        catalogSyncedAt: new Date(),
        ...(familyId ? { familyId } : {}),
        ...(proveedorId ? { defaultSupplierId: proveedorId } : {}),
        ...(articulo.tipo ? { category: articulo.tipo } : {}),
        ...(articulo.subtipo ? { subtype: articulo.subtipo } : {}),
        ...(articulo.unidad ? { purchaseUnit: articulo.unidad } : {}),
        ...(articulo.imagen ? { imageUrl: articulo.imagen } : {}),
        ...(articulo.activo !== null ? { active: articulo.activo } : {}),
      };

      /*
       * Por PLU y sólo por PLU.
       *
       * `upsert` sobre `internalCode`, que es único. No se busca por nombre ni
       * por parecido: dos artículos que se llaman igual son dos artículos, y
       * el que decide es el número.
       */
      await tx.product.upsert({
        where: { internalCode: plu },
        update: datos,
        create: { internalCode: plu, ...datos },
      });
      escritos += 1;
    }

    return escritos;
  });

  vista.aplicados = aplicados;

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.STOCK_SYNCED,
    entity: 'Product',
    entityId: 'catalogo',
    after: {
      schemaVersion: vista.schemaVersion,
      leidos: vista.leidos,
      nuevos: vista.nuevos.length,
      modificados: vista.modificados.length,
      sinCambios: vista.sinCambios.length,
      inactivados: vista.quedarianInactivos.length,
      familiasCreadas: vista.familiasNuevas.length,
      escritos: aplicados,
    },
  });

  return vista;
}

export { RespuestaDeStockInvalida };
