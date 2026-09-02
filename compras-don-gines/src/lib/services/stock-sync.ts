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
  /** Familias que habría que crear para poder clasificar lo que llega. */
  familiasNuevas: string[];
  /** Nombres de proveedor que Control de Stock usa y Compras no tiene. */
  proveedoresDesconocidos: string[];
  /** Cuántos se escribieron. Cero mientras es sólo una vista previa. */
  aplicados: number;
}

const SIN_DATO = '—';

/** Lo que se muestra de un valor que puede faltar. */
const mostrar = (valor: string | null | undefined): string =>
  valor === null || valor === undefined || valor === '' ? SIN_DATO : valor;

/**
 * De dónde sale la familia con la que Compras agrupa.
 *
 * El subtipo cuando está, porque es el nivel que agrupa sin mezclar: si el tipo
 * es «Quesos» y el subtipo «Cremosos», la familia útil para marcar precios es
 * la segunda. El tipo queda de respaldo.
 */
function familiaDe(articulo: ProductoDeStock): string | null {
  return articulo.subtipo ?? articulo.tipo ?? null;
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
  const proveedorPorNombre = new Map<string, (typeof proveedores)[number]>();
  for (const proveedor of proveedores) {
    proveedorPorNombre.set(normalizeText(proveedor.tradeName), proveedor);
    for (const alias of proveedor.aliases) proveedorPorNombre.set(alias.normalized, proveedor);
  }

  const familias = await prisma.productFamily.findMany({ select: { id: true, name: true, normalized: true } });
  const familiaPorNombre = new Map(familias.map((f) => [f.normalized, f]));

  const vista: VistaPreviaDeSincronizacion = {
    schemaVersion,
    leidos: articulos.length,
    nuevos: [],
    modificados: [],
    sinCambios: [],
    quedarianInactivos: [],
    familiasNuevas: [],
    proveedoresDesconocidos: [],
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

    const proveedorNormal = articulo.proveedor ? normalizeText(articulo.proveedor) : '';
    const proveedor = proveedorNormal ? proveedorPorNombre.get(proveedorNormal) : undefined;
    if (articulo.proveedor && !proveedor && !vista.proveedoresDesconocidos.includes(articulo.proveedor)) {
      vista.proveedoresDesconocidos.push(articulo.proveedor);
    }

    if (!actual) {
      vista.nuevos.push({ plu: articulo.plu, nombre: articulo.nombre, cambios: [] });
      continue;
    }

    const cambios = diferencias(actual, articulo, familia, proveedor?.tradeName ?? null);
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
    if (vistos.has(actual.internalCode) || !actual.active) continue;
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

    const proveedores = await tx.supplier.findMany({
      select: { id: true, tradeName: true, aliases: { select: { normalized: true } } },
    });
    const proveedorPorNombre = new Map<string, string>();
    for (const p of proveedores) {
      proveedorPorNombre.set(normalizeText(p.tradeName), p.id);
      for (const alias of p.aliases) proveedorPorNombre.set(alias.normalized, p.id);
    }

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
