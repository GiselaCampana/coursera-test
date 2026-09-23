import 'server-only';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { Decimal } from '@/lib/money';
import type { AuthUser } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { hasPermission } from '@/lib/auth/session';
import { ForbiddenError, NotFoundError, ValidationError, ConflictError } from '@/lib/errors';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/services/audit';

/**
 * **Stock ERP, fase 2: qué significa «uno» para cada artículo.**
 *
 * El módulo todavía no mueve existencias. Lo único que hace esta fase es dejar
 * decidida, con nombre y fecha, la unidad en la que se van a contar las cosas
 * el día que empiece a moverlas. Es a propósito el primer paso: una vez que hay
 * un libro escrito, cambiar la unidad de un artículo reinterpreta todo lo
 * anterior, y no hay forma honesta de arreglarlo después.
 *
 * LAS CUATRO UNIDADES, que son cuatro cosas distintas y por eso viven separadas:
 *
 *   `Product.catalogUnit`            lo que INFORMA Control de Stock. Dato
 *                                    externo. Puede estar en null y eso es
 *                                    información, no un agujero.
 *   `ProductStockConfig.stockUnit`   la unidad del LIBRO. Decisión interna, la
 *                                    aprueba una persona con permiso. Es la
 *                                    única que gobierna existencias.
 *   `ProductPurchasePresentation`    cómo se COMPRA a cada proveedor, con el
 *                                    factor que lleva de esa presentación a la
 *                                    unidad de existencia.
 *   `DocumentItem.unit`              lo que dice el PAPEL de esa factura.
 *
 * Nada de acá llama a Control de Stock ni le manda nada. La única integración
 * viva con esa aplicación es la lectura del catálogo, que vive en otro módulo.
 */

export type UnidadDeStock = 'KG' | 'UNIT';

/* ========================================================================== *
 * Permisos: una sola puerta, y deja constancia de quien la empuja sin llave.
 * ========================================================================== */

/**
 * Exige el permiso y **audita el rechazo**.
 *
 * Auditar el intento fallido no es celo: un rechazo dice quién quiso cambiar la
 * unidad de existencia de un artículo, que es exactamente la pregunta que uno
 * se hace cuando un inventario no cierra y nadie sabe por qué.
 */
async function exigirPermiso(
  user: AuthUser,
  permiso: string,
  contexto: { entity: string; entityId?: string; detalle?: string },
): Promise<void> {
  if (hasPermission(user, permiso)) return;
  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.STOCKERP_INTENTO_RECHAZADO,
    entity: contexto.entity,
    entityId: contexto.entityId,
    after: { permisoQueFaltaba: permiso, detalle: contexto.detalle ?? null },
  });
  throw new ForbiddenError(
    `Tu usuario no tiene el permiso «${permiso}». Se pide a un administrador desde Configuración → Roles.`,
  );
}

/* ========================================================================== *
 * Lectura: el estado de un artículo, sin decidir nada.
 * ========================================================================== */

export interface EstadoDeUnidad {
  productId: string;
  plu: string;
  nombre: string;
  familia: string | null;
  /** Lo que informa el catálogo. `null` = todavía no llegó por sincronización. */
  unidadDelCatalogo: UnidadDeStock | null;
  /** La del libro, y sólo si está aprobada. */
  unidadDeExistencia: UnidadDeStock | null;
  estado: 'PENDIENTE' | 'APROBADA';
  /** `true` mientras no haya una unidad aprobada: el artículo no se puede mover. */
  bloqueado: boolean;
  aprobadaPor: string | null;
  aprobadaEl: Date | null;
  notas: string | null;
  /**
   * El catálogo dice una unidad y la aprobada es otra.
   *
   * Se INFORMA, no se corrige. Puede ser perfectamente legítimo —el proveedor
   * factura cajas y el local cuenta kilos— y puede ser un error del catálogo.
   * Decidir cuál de las dos es, mirando sólo los dos valores, es imposible.
   */
  discrepancia: boolean;
  presentaciones: PresentacionDeCompra[];
}

export interface PresentacionDeCompra {
  id: string;
  proveedorId: string | null;
  proveedorNombre: string | null;
  codigoDelProveedor: string | null;
  unidadDeCompra: UnidadDeStock;
  /** Texto exacto, nunca un `number`: el factor multiplica cantidades. */
  factor: string;
  descripcion: string | null;
  estado: 'PENDIENTE' | 'APROBADA';
  aprobadaPor: string | null;
  aprobadaEl: Date | null;
}

const INCLUIR = {
  family: { select: { name: true } },
  stockConfig: { include: { approvedBy: { select: { name: true } } } },
  stockPresentations: {
    include: {
      approvedBy: { select: { name: true } },
    },
    orderBy: [{ supplierId: 'asc' }, { supplierCode: 'asc' }],
  },
} satisfies Prisma.ProductInclude;

type ProductoConTodo = Prisma.ProductGetPayload<{ include: typeof INCLUIR }>;

function armarEstado(
  p: ProductoConTodo,
  proveedores: Map<string, string>,
): EstadoDeUnidad {
  const cfg = p.stockConfig;
  const aprobada = cfg?.status === 'APROBADA' ? (cfg.stockUnit as UnidadDeStock | null) : null;
  const delCatalogo = (p.catalogUnit as UnidadDeStock | null) ?? null;
  return {
    productId: p.id,
    plu: p.internalCode,
    nombre: p.normalizedName,
    familia: p.family?.name ?? null,
    unidadDelCatalogo: delCatalogo,
    unidadDeExistencia: aprobada,
    estado: cfg?.status === 'APROBADA' ? 'APROBADA' : 'PENDIENTE',
    /*
     * La ausencia de configuración es PENDIENTE, no un caso aparte.
     *
     * Es la diferencia entre «este artículo no tiene fila» y «este artículo no
     * está resuelto». La primera invita a tratarlo como si no existiera; la
     * segunda lo pone en la cola donde alguien lo va a mirar. Por eso el
     * bloqueo se calcula de la unidad aprobada y no de que exista la fila.
     */
    bloqueado: aprobada === null,
    aprobadaPor: cfg?.approvedBy?.name ?? null,
    aprobadaEl: cfg?.approvedAt ?? null,
    notas: cfg?.notes ?? null,
    discrepancia: delCatalogo !== null && aprobada !== null && delCatalogo !== aprobada,
    presentaciones: p.stockPresentations.map((pr) => ({
      id: pr.id,
      proveedorId: pr.supplierId,
      proveedorNombre: pr.supplierId ? (proveedores.get(pr.supplierId) ?? null) : null,
      codigoDelProveedor: pr.supplierCode,
      unidadDeCompra: pr.purchaseUnit as UnidadDeStock,
      factor: pr.conversionFactor.toString(),
      descripcion: pr.description,
      estado: pr.status as 'PENDIENTE' | 'APROBADA',
      aprobadaPor: pr.approvedBy?.name ?? null,
      aprobadaEl: pr.approvedAt,
    })),
  };
}

export interface FiltroDeUnidades {
  texto?: string;
  /** `pendientes` incluye los artículos que ni siquiera tienen fila. */
  estado?: 'todos' | 'pendientes' | 'aprobados' | 'discrepancias';
  proveedorId?: string;
  limite?: number;
}

export async function listarUnidades(
  user: AuthUser,
  filtro: FiltroDeUnidades = {},
): Promise<EstadoDeUnidad[]> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_VER, { entity: 'ProductStockConfig' });

  const texto = filtro.texto?.trim();
  const where: Prisma.ProductWhereInput = {};
  if (texto) {
    where.OR = [
      { internalCode: { contains: texto, mode: 'insensitive' } },
      { normalizedName: { contains: texto, mode: 'insensitive' } },
      { family: { name: { contains: texto, mode: 'insensitive' } } },
    ];
  }
  if (filtro.proveedorId) {
    /* Por proveedor habitual o por tener una presentación suya. */
    where.AND = [
      {
        OR: [
          { defaultSupplierId: filtro.proveedorId },
          { stockPresentations: { some: { supplierId: filtro.proveedorId } } },
        ],
      },
    ];
  }

  const productos = await prisma.product.findMany({
    where,
    include: INCLUIR,
    orderBy: { internalCode: 'asc' },
    take: filtro.limite ?? 200,
  });

  const idsDeProveedor = new Set<string>();
  for (const p of productos) {
    for (const pr of p.stockPresentations) if (pr.supplierId) idsDeProveedor.add(pr.supplierId);
  }
  const proveedores = new Map(
    (
      await prisma.supplier.findMany({
        where: { id: { in: [...idsDeProveedor] } },
        select: { id: true, tradeName: true },
      })
    ).map((s) => [s.id, s.tradeName]),
  );

  const todos = productos.map((p) => armarEstado(p, proveedores));
  switch (filtro.estado) {
    case 'pendientes':
      return todos.filter((e) => e.estado === 'PENDIENTE');
    case 'aprobados':
      return todos.filter((e) => e.estado === 'APROBADA');
    case 'discrepancias':
      return todos.filter((e) => e.discrepancia);
    default:
      return todos;
  }
}

export async function verUnidad(user: AuthUser, productId: string): Promise<EstadoDeUnidad> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_VER, {
    entity: 'ProductStockConfig',
    entityId: productId,
  });
  const p = await prisma.product.findUnique({ where: { id: productId }, include: INCLUIR });
  if (!p) throw new NotFoundError('No existe ese artículo.');
  const proveedores = new Map(
    (
      await prisma.supplier.findMany({
        where: {
          id: {
            in: p.stockPresentations.map((x) => x.supplierId).filter((x): x is string => !!x),
          },
        },
        select: { id: true, tradeName: true },
      })
    ).map((s) => [s.id, s.tradeName]),
  );
  return armarEstado(p, proveedores);
}

/* ========================================================================== *
 * La barrera: un artículo con movimientos no se reinterpreta.
 * ========================================================================== */

/**
 * ¿Hay algo escrito en el libro para este artículo?
 *
 * En esta fase la respuesta es siempre «no», porque no hay movimientos todavía.
 * La función existe igual, y se llama de verdad, porque la barrera tiene que
 * estar puesta **antes** de que haya algo que proteger. Una barrera que se
 * agrega el día que aparece el primer movimiento llega un día tarde.
 */
export async function tieneMovimientos(productId: string): Promise<boolean> {
  const n = await prisma.stockLedger.count({ where: { productId } });
  return n > 0;
}

/* ========================================================================== *
 * Escritura: aprobar y modificar la unidad de existencia.
 * ========================================================================== */

export interface AprobarUnidadInput {
  productId: string;
  unidad: UnidadDeStock;
  /** Obligatorio al modificar una unidad ya aprobada. */
  motivo?: string | null;
  notas?: string | null;
  /**
   * La segunda confirmación de la pantalla, que viaja hasta acá.
   *
   * Podría quedarse en el navegador, y sería un error: el servidor tiene que
   * poder negarse a una aprobación que llegó sin que nadie confirmara, venga de
   * donde venga. Una doble confirmación que sólo existe en la pantalla es una
   * decoración.
   */
  confirmado: boolean;
}

export async function aprobarUnidadDeExistencia(
  user: AuthUser,
  input: AprobarUnidadInput,
): Promise<EstadoDeUnidad> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_UNIDADES_CONFIGURAR, {
    entity: 'ProductStockConfig',
    entityId: input.productId,
    detalle: `aprobar unidad ${input.unidad}`,
  });

  if (!input.confirmado) {
    throw new ValidationError(
      'Falta confirmar. Fijar la unidad de existencia decide cómo se va a contar este artículo: se pide dos veces a propósito.',
    );
  }
  if (input.unidad !== 'KG' && input.unidad !== 'UNIT') {
    throw new ValidationError('La unidad de existencia tiene que ser KG o UNIT, elegida a mano.');
  }

  const producto = await prisma.product.findUnique({
    where: { id: input.productId },
    include: { stockConfig: true },
  });
  if (!producto) throw new NotFoundError('No existe ese artículo.');

  const previa = producto.stockConfig;
  const unidadPrevia = (previa?.stockUnit as UnidadDeStock | null) ?? null;
  const yaEstabaAprobada = previa?.status === 'APROBADA';
  const esCambio = yaEstabaAprobada && unidadPrevia !== input.unidad;

  /*
   * Cambiar la unidad de un artículo que ya tiene movimientos reinterpretaría
   * el pasado: los kilos asentados pasarían a leerse como unidades sin que
   * ninguna fila del libro cambie. El libro NO se toca —es inmutable por
   * disparador— así que la única salida honesta es negarse y pedir un ajuste
   * explícito, que es otra fase.
   */
  if (esCambio && (await tieneMovimientos(input.productId))) {
    throw new ConflictError(
      'Este artículo ya tiene movimientos en el libro de existencias. Cambiar su unidad ahora ' +
        'reinterpretaría lo ya asentado: los saldos anteriores pasarían a significar otra cosa sin ' +
        'que ninguna fila cambie. Hace falta un ajuste explícito, que todavía no está implementado.',
    );
  }

  if (esCambio && !input.motivo?.trim()) {
    throw new ValidationError(
      'Para cambiar una unidad ya aprobada hace falta un motivo escrito. Queda en el historial.',
    );
  }

  const motivo = input.motivo?.trim() || 'Primera aprobación de la unidad de existencia.';

  return prisma.$transaction(async (tx) => {
    const cfg = await tx.productStockConfig.upsert({
      where: { productId: input.productId },
      create: {
        productId: input.productId,
        stockUnit: input.unidad,
        status: 'APROBADA',
        approvedById: user.id,
        approvedAt: new Date(),
        notes: input.notas ?? null,
      },
      update: {
        stockUnit: input.unidad,
        status: 'APROBADA',
        approvedById: user.id,
        approvedAt: new Date(),
        ...(input.notas !== undefined ? { notes: input.notas } : {}),
      },
    });

    /* El historial guarda el valor anterior leído de la BASE, no del pedido. */
    await tx.productStockConfigHistory.create({
      data: {
        configId: cfg.id,
        campo: 'stockUnit',
        antes: unidadPrevia,
        despues: input.unidad,
        reason: motivo,
        userId: user.id,
      },
    });

    await recordAudit(
      {
        userId: user.id,
        action: previa
          ? esCambio
            ? AUDIT_ACTIONS.STOCKERP_UNIDAD_MODIFICADA
            : AUDIT_ACTIONS.STOCKERP_UNIDAD_APROBADA
          : AUDIT_ACTIONS.STOCKERP_CONFIG_CREADA,
        entity: 'ProductStockConfig',
        entityId: cfg.id,
        before: { stockUnit: unidadPrevia, status: previa?.status ?? null },
        after: {
          stockUnit: input.unidad,
          status: 'APROBADA',
          motivo,
          plu: producto.internalCode,
          unidadDelCatalogo: producto.catalogUnit ?? null,
        },
      },
      tx,
    );

    const completo = await tx.product.findUniqueOrThrow({
      where: { id: input.productId },
      include: INCLUIR,
    });
    return armarEstado(completo, new Map());
  });
}

/* ========================================================================== *
 * Presentaciones de compra.
 * ========================================================================== */

export interface GuardarPresentacionInput {
  productId: string;
  proveedorId?: string | null;
  codigoDelProveedor?: string | null;
  unidadDeCompra: UnidadDeStock;
  /** Texto o Decimal. Nunca un `number`: el binario pierde exactitud. */
  factor: string;
  descripcion?: string | null;
  aprobar: boolean;
  confirmado: boolean;
}

export async function guardarPresentacion(
  user: AuthUser,
  input: GuardarPresentacionInput,
): Promise<PresentacionDeCompra> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_UNIDADES_CONFIGURAR, {
    entity: 'ProductPurchasePresentation',
    entityId: input.productId,
    detalle: `presentación ${input.unidadDeCompra} × ${input.factor}`,
  });

  if (input.aprobar && !input.confirmado) {
    throw new ValidationError('Falta confirmar la aprobación de la presentación.');
  }

  /*
   * El factor se lee con Decimal y nunca con Number.
   *
   * `Number('0.1')` ya no es 0,1, y ese factor multiplica cantidades de
   * inventario: el error no se nota en una caja y se nota en mil.
   */
  let factor: Decimal;
  try {
    factor = new Decimal(String(input.factor).trim().replace(',', '.'));
  } catch {
    throw new ValidationError(`«${input.factor}» no es un número válido para el factor.`);
  }
  if (!factor.isFinite() || factor.lessThanOrEqualTo(0)) {
    throw new ValidationError('El factor de conversión tiene que ser mayor que cero.');
  }

  const producto = await prisma.product.findUnique({ where: { id: input.productId } });
  if (!producto) throw new NotFoundError('No existe ese artículo.');

  const proveedorId = input.proveedorId ?? null;
  const codigo = input.codigoDelProveedor?.trim() || null;

  const previa = await prisma.productPurchasePresentation.findFirst({
    where: { productId: input.productId, supplierId: proveedorId, supplierCode: codigo },
  });

  const datos = {
    purchaseUnit: input.unidadDeCompra,
    conversionFactor: factor.toString(),
    description: input.descripcion ?? null,
    ...(input.aprobar
      ? { status: 'APROBADA' as const, approvedById: user.id, approvedAt: new Date() }
      : { status: 'PENDIENTE' as const }),
  };

  const guardada = previa
    ? await prisma.productPurchasePresentation.update({ where: { id: previa.id }, data: datos })
    : await prisma.productPurchasePresentation.create({
        data: { productId: input.productId, supplierId: proveedorId, supplierCode: codigo, ...datos },
      });

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.STOCKERP_PRESENTACION_GUARDADA,
    entity: 'ProductPurchasePresentation',
    entityId: guardada.id,
    before: previa
      ? {
          purchaseUnit: previa.purchaseUnit,
          conversionFactor: previa.conversionFactor.toString(),
          status: previa.status,
        }
      : null,
    after: {
      plu: producto.internalCode,
      proveedorId,
      codigoDelProveedor: codigo,
      purchaseUnit: input.unidadDeCompra,
      conversionFactor: factor.toString(),
      status: datos.status,
    },
  });

  return {
    id: guardada.id,
    proveedorId: guardada.supplierId,
    proveedorNombre: null,
    codigoDelProveedor: guardada.supplierCode,
    unidadDeCompra: guardada.purchaseUnit as UnidadDeStock,
    factor: guardada.conversionFactor.toString(),
    descripcion: guardada.description,
    estado: guardada.status as 'PENDIENTE' | 'APROBADA',
    aprobadaPor: null,
    aprobadaEl: guardada.approvedAt,
  };
}

/* ========================================================================== *
 * La conversión, que es para lo que todo esto existe.
 * ========================================================================== */

export type Conversion =
  | { ok: true; cantidadEnUnidadDeExistencia: Decimal; unidad: UnidadDeStock; factor: string }
  | { ok: false; motivo: string };

/**
 * Cuánta existencia representa una cantidad facturada.
 *
 * Todavía no la usa ninguna recepción, porque no hay recepciones. Se escribe
 * ahora porque es la regla que decide si un renglón se puede aplicar, y quiero
 * que exista con sus pruebas antes de que alguien la necesite con apuro.
 *
 * NO INVENTA EQUIVALENCIAS. Si la unidad del papel no es la de existencia y
 * nadie aprobó un factor, contesta que no y dice por qué. Suponer que «una
 * caja son 12» porque suele serlo es como se arruina un inventario.
 */
export async function convertirAUnidadDeExistencia(entrada: {
  productId: string;
  unidadFacturada: UnidadDeStock;
  cantidad: Decimal | string;
  proveedorId?: string | null;
  codigoDelProveedor?: string | null;
}): Promise<Conversion> {
  const cfg = await prisma.productStockConfig.findUnique({
    where: { productId: entrada.productId },
  });
  if (!cfg || cfg.status !== 'APROBADA' || !cfg.stockUnit) {
    return {
      ok: false,
      motivo:
        'Este artículo todavía no tiene una unidad de existencia aprobada. Hasta que alguien la apruebe, no se puede mover.',
    };
  }
  const unidadDeExistencia = cfg.stockUnit as UnidadDeStock;
  const cantidad = entrada.cantidad instanceof Decimal ? entrada.cantidad : new Decimal(entrada.cantidad);

  /* Misma unidad: no hay nada que convertir, y no hace falta presentación. */
  if (entrada.unidadFacturada === unidadDeExistencia) {
    return { ok: true, cantidadEnUnidadDeExistencia: cantidad, unidad: unidadDeExistencia, factor: '1' };
  }

  /*
   * Distintas: hace falta un factor APROBADO. Se busca de lo más específico a
   * lo más general —este proveedor y este código, después este proveedor,
   * después la genérica— y nunca se cae en un valor por omisión.
   */
  const candidatas = await prisma.productPurchasePresentation.findMany({
    where: {
      productId: entrada.productId,
      status: 'APROBADA',
      purchaseUnit: entrada.unidadFacturada,
      OR: [
        { supplierId: entrada.proveedorId ?? null, supplierCode: entrada.codigoDelProveedor ?? null },
        { supplierId: entrada.proveedorId ?? null, supplierCode: null },
        { supplierId: null, supplierCode: null },
      ],
    },
  });
  const elegida =
    candidatas.find(
      (c) => c.supplierId === (entrada.proveedorId ?? null) && c.supplierCode === (entrada.codigoDelProveedor ?? null),
    ) ??
    candidatas.find((c) => c.supplierId === (entrada.proveedorId ?? null) && c.supplierCode === null) ??
    candidatas.find((c) => c.supplierId === null && c.supplierCode === null);

  if (!elegida) {
    return {
      ok: false,
      motivo:
        `La factura dice ${entrada.unidadFacturada} y la existencia se lleva en ${unidadDeExistencia}. ` +
        'No hay una conversión aprobada para este artículo, así que el renglón queda bloqueado: ' +
        'hay que cargar la presentación de compra y aprobarla.',
    };
  }

  const factor = new Decimal(elegida.conversionFactor.toString());
  return {
    ok: true,
    cantidadEnUnidadDeExistencia: cantidad.times(factor),
    unidad: unidadDeExistencia,
    factor: factor.toString(),
  };
}

/* ========================================================================== *
 * Reconocer una discrepancia, que es una decisión y no un descarte.
 * ========================================================================== */

export async function reconocerDiscrepancia(
  user: AuthUser,
  input: { productId: string; motivo: string },
): Promise<void> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_UNIDADES_CONFIGURAR, {
    entity: 'ProductStockConfig',
    entityId: input.productId,
    detalle: 'reconocer discrepancia de unidad',
  });
  if (!input.motivo?.trim()) {
    throw new ValidationError('Para reconocer una discrepancia hace falta escribir por qué está bien así.');
  }
  const producto = await prisma.product.findUnique({
    where: { id: input.productId },
    include: { stockConfig: true },
  });
  if (!producto?.stockConfig) throw new NotFoundError('Ese artículo todavía no tiene configuración.');

  await prisma.productStockConfigHistory.create({
    data: {
      configId: producto.stockConfig.id,
      campo: 'discrepancia',
      antes: `catálogo ${producto.catalogUnit ?? 'sin dato'}`,
      despues: `existencia ${producto.stockConfig.stockUnit ?? 'sin aprobar'}`,
      reason: input.motivo.trim(),
      userId: user.id,
    },
  });

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.STOCKERP_DISCREPANCIA_RECONOCIDA,
    entity: 'ProductStockConfig',
    entityId: producto.stockConfig.id,
    after: {
      plu: producto.internalCode,
      unidadDelCatalogo: producto.catalogUnit ?? null,
      unidadDeExistencia: producto.stockConfig.stockUnit,
      motivo: input.motivo.trim(),
    },
  });
}

/** El historial de un artículo, para la pantalla y la auditoría. */
export async function historialDeUnidad(user: AuthUser, productId: string) {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_AUDITORIA_VER, {
    entity: 'ProductStockConfig',
    entityId: productId,
  });
  const cfg = await prisma.productStockConfig.findUnique({ where: { productId } });
  if (!cfg) return [];
  return prisma.productStockConfigHistory.findMany({
    where: { configId: cfg.id },
    orderBy: { at: 'desc' },
    take: 100,
  });
}
