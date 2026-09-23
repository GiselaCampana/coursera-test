import 'server-only';
import { createHash } from 'node:crypto';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { Decimal } from '@/lib/money';
import type { AuthUser } from '@/lib/auth/session';
import { hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { ForbiddenError, NotFoundError, ValidationError, ConflictError } from '@/lib/errors';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/services/audit';
import { instanteDesdeHoraArgentina } from '@/lib/datetime';

/**
 * **Stock ERP, fase 3: la apertura que inaugura una sucursal.**
 *
 * Hasta que una sucursal tiene una apertura confirmada, Stock ERP no existe
 * para ella. Y eso **no es lo mismo que tener saldo cero**: cero es un dato
 * —se contó y no había— y la ausencia de apertura es la falta del dato. Toda
 * esta fase gira alrededor de esa distinción, porque confundirlas es la forma
 * más cara de arruinar un inventario: un sistema que asume cero empieza a
 * descontar de la nada y nadie lo nota hasta el primer recuento.
 *
 * NO SE IMPORTA NINGUNA CANTIDAD. Ni de Control de Stock, ni de las compras
 * históricas, ni de `PurchaseMovement`, ni de `StockOutbox`. El saldo inicial
 * sale de que alguien recorrió la góndola y contó.
 *
 * QUÉ SE REUTILIZA: `StockCountSession` es la apertura y
 * `ProductStockActivation` es su línea. No hay `StockOpening` ni
 * `StockOpeningLine`: serían las mismas dos tablas con otro nombre.
 */

/* ========================================================================== *
 * Los cinco estados funcionales, derivados y no almacenados.
 * ========================================================================== */

export type EstadoDeLinea =
  | 'PENDIENTE'
  | 'CONTADO'
  | 'CONTADO_CERO'
  | 'NO_SE_MANEJA'
  | 'BLOQUEADO_UNIDAD';

/**
 * De qué estado funcional es una línea.
 *
 * Se deriva; no hay una columna que lo guarde. Dos columnas de estado en la
 * misma fila terminan contradiciéndose, y cuando eso pasa nadie sabe cuál
 * manda. Acá el estado es una lectura de los datos que ya están.
 */
export function estadoDeLinea(fila: {
  state: string;
  countedQuantity: Prisma.Decimal | null;
}): EstadoDeLinea {
  if (fila.state === 'NO_SE_MANEJA') return 'NO_SE_MANEJA';
  if (fila.state === 'PENDIENTE_CONFIGURACION') return 'BLOQUEADO_UNIDAD';
  if (fila.countedQuantity === null) return 'PENDIENTE';
  return new Decimal(fila.countedQuantity.toString()).isZero() ? 'CONTADO_CERO' : 'CONTADO';
}

/** Los dos estados que impiden confirmar. */
export function bloqueaConfirmacion(e: EstadoDeLinea): boolean {
  return e === 'PENDIENTE' || e === 'BLOQUEADO_UNIDAD';
}

/* ========================================================================== *
 * Permisos
 * ========================================================================== */

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
 * El interruptor
 * ========================================================================== */

export async function interruptorDeAperturasReales(): Promise<{
  encendido: boolean;
  cambiadoPor: string | null;
  cambiadoEl: Date | null;
  motivo: string | null;
}> {
  const fila = await prisma.stockModuleSetting.findFirst({
    include: { changedBy: { select: { name: true } } },
  });
  return {
    encendido: fila?.realOpeningEnabled ?? false,
    cambiadoPor: fila?.changedBy?.name ?? null,
    cambiadoEl: fila?.changedAt ?? null,
    motivo: fila?.reason ?? null,
  };
}

export async function cambiarInterruptor(
  user: AuthUser,
  input: { encender: boolean; motivo: string },
): Promise<void> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_MODULO_CONFIGURAR, {
    entity: 'StockModuleSetting',
    detalle: input.encender ? 'encender aperturas reales' : 'apagar aperturas reales',
  });
  if (!input.motivo?.trim()) {
    throw new ValidationError('Cambiar el interruptor exige escribir por qué. Queda en la auditoría.');
  }
  const antes = await prisma.stockModuleSetting.findFirst();
  const fila = await prisma.stockModuleSetting.upsert({
    where: { unica: true },
    create: {
      unica: true,
      realOpeningEnabled: input.encender,
      changedById: user.id,
      changedAt: new Date(),
      reason: input.motivo.trim(),
    },
    update: {
      realOpeningEnabled: input.encender,
      changedById: user.id,
      changedAt: new Date(),
      reason: input.motivo.trim(),
    },
  });
  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.STOCKERP_INTERRUPTOR_CAMBIADO,
    entity: 'StockModuleSetting',
    entityId: fila.id,
    before: { realOpeningEnabled: antes?.realOpeningEnabled ?? false },
    after: { realOpeningEnabled: input.encender, motivo: input.motivo.trim() },
  });
}

/* ========================================================================== *
 * Preparar la apertura
 * ========================================================================== */

export interface LineaDeApertura {
  activationId: string;
  productId: string;
  plu: string;
  nombre: string;
  familia: string | null;
  estado: EstadoDeLinea;
  unidadDeExistencia: 'KG' | 'UNIT' | null;
  /** Texto exacto. Nunca `number`. */
  cantidad: string | null;
  motivo: string | null;
  contadoPor: string | null;
}

export interface Apertura {
  sessionId: string;
  branchId: string;
  sucursal: string;
  estado: 'BORRADOR' | 'CONFIRMADA';
  ficticia: boolean;
  cutoffAt: Date | null;
  catalogSnapshotAt: Date | null;
  confirmadaPor: string | null;
  confirmadaEl: Date | null;
  lineas: LineaDeApertura[];
  resumen: Record<EstadoDeLinea, number>;
  /** Lo que impide confirmar ahora mismo. Vacío = se puede. */
  impedimentos: string[];
}

const RESUMEN_VACIO = (): Record<EstadoDeLinea, number> => ({
  PENDIENTE: 0,
  CONTADO: 0,
  CONTADO_CERO: 0,
  NO_SE_MANEJA: 0,
  BLOQUEADO_UNIDAD: 0,
});

/**
 * Prepara el borrador de una sucursal.
 *
 * Incluye **todos los artículos activos del catálogo** en ese momento y guarda
 * cuándo se sacó esa foto. Los que tienen unidad aprobada nacen PENDIENTE; los
 * que no, BLOQUEADO_UNIDAD. Ninguno nace contado, y ninguno trae una cantidad
 * de ningún lado.
 */
export async function prepararApertura(
  user: AuthUser,
  input: { branchId: string; ficticia: boolean },
): Promise<Apertura> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_APERTURA_PREPARAR, {
    entity: 'StockCountSession',
    entityId: input.branchId,
    detalle: 'preparar apertura',
  });

  const sucursal = await prisma.branch.findUnique({ where: { id: input.branchId } });
  if (!sucursal) throw new NotFoundError('No existe esa sucursal.');

  const yaConfirmada = await prisma.stockCountSession.findFirst({
    where: { branchId: input.branchId, status: 'CONFIRMADA' },
  });
  if (yaConfirmada) {
    throw new ConflictError(
      `La sucursal ${sucursal.name} ya tiene su apertura confirmada. Una sucursal se inaugura una sola vez.`,
    );
  }

  const existente = await prisma.stockCountSession.findFirst({
    where: { branchId: input.branchId, status: 'BORRADOR' },
  });
  const sessionId = existente
    ? existente.id
    : (
        await prisma.stockCountSession.create({
          data: {
            branchId: input.branchId,
            name: `Apertura de ${sucursal.name}`,
            status: 'BORRADOR',
            ficticia: input.ficticia,
            createdById: user.id,
          },
        })
      ).id;

  await sincronizarLineas(sessionId, input.branchId, user.id);

  await recordAudit({
    userId: user.id,
    action: existente ? AUDIT_ACTIONS.STOCKERP_APERTURA_SNAPSHOT : AUDIT_ACTIONS.STOCKERP_APERTURA_PREPARADA,
    entity: 'StockCountSession',
    entityId: sessionId,
    after: { branchId: input.branchId, sucursal: sucursal.name, ficticia: input.ficticia },
  });

  return verApertura(user, sessionId);
}

/**
 * Trae al borrador los artículos activos que falten y actualiza los bloqueos.
 *
 * **No pisa un conteo ya cargado.** Es la condición para poder actualizar el
 * snapshot sin que alguien pierda una tarde de contar.
 */
async function sincronizarLineas(sessionId: string, branchId: string, userId: string): Promise<number> {
  const activos = await prisma.product.findMany({
    where: { active: true },
    select: { id: true, stockConfig: { select: { status: true, stockUnit: true } } },
  });
  const snapshot = new Date();

  let agregados = 0;
  for (const p of activos) {
    const aprobada = p.stockConfig?.status === 'APROBADA' && p.stockConfig.stockUnit;
    const estadoInicial = aprobada ? 'LISTO_PARA_CONTAR' : 'PENDIENTE_CONFIGURACION';
    const previa = await prisma.productStockActivation.findUnique({
      where: { productId_branchId: { productId: p.id, branchId } },
    });
    if (!previa) {
      await prisma.productStockActivation.create({
        data: { productId: p.id, branchId, sessionId, state: estadoInicial },
      });
      agregados += 1;
      continue;
    }
    /*
     * Ya existía. Sólo se corrige el bloqueo por unidad, y únicamente mientras
     * nadie la haya contado ni decidido: si alguien aprobó la unidad después,
     * la línea deja de estar bloqueada sin perder nada.
     */
    if (
      previa.countedQuantity === null &&
      previa.state !== 'NO_SE_MANEJA' &&
      previa.state !== 'ACTIVO' &&
      previa.state !== estadoInicial
    ) {
      await prisma.productStockActivation.update({
        where: { id: previa.id },
        data: { state: estadoInicial, sessionId },
      });
    } else if (previa.sessionId === null) {
      await prisma.productStockActivation.update({ where: { id: previa.id }, data: { sessionId } });
    }
  }

  await prisma.stockCountSession.update({
    where: { id: sessionId },
    data: { catalogSnapshotAt: snapshot },
  });
  void userId;
  return agregados;
}

/** Cuántos artículos activos quedaron fuera del borrador desde el snapshot. */
export async function faltantesDesdeElSnapshot(sessionId: string): Promise<number> {
  const sesion = await prisma.stockCountSession.findUnique({ where: { id: sessionId } });
  if (!sesion) return 0;
  const activos = await prisma.product.count({ where: { active: true } });
  const enElBorrador = await prisma.productStockActivation.count({
    where: { branchId: sesion.branchId, sessionId },
  });
  return Math.max(0, activos - enElBorrador);
}

export async function verApertura(user: AuthUser, sessionId: string): Promise<Apertura> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_VER, {
    entity: 'StockCountSession',
    entityId: sessionId,
  });
  const sesion = await prisma.stockCountSession.findUnique({
    where: { id: sessionId },
    include: {
      branch: { select: { name: true } },
      confirmedBy: { select: { name: true } },
      activations: {
        include: {
          product: {
            select: {
              internalCode: true,
              normalizedName: true,
              family: { select: { name: true } },
              stockConfig: { select: { status: true, stockUnit: true } },
            },
          },
          countedBy: { select: { name: true } },
        },
        orderBy: { product: { internalCode: 'asc' } },
      },
    },
  });
  if (!sesion) throw new NotFoundError('No existe esa apertura.');

  const resumen = RESUMEN_VACIO();
  const lineas: LineaDeApertura[] = sesion.activations.map((a) => {
    const estado = estadoDeLinea(a);
    resumen[estado] += 1;
    return {
      activationId: a.id,
      productId: a.productId,
      plu: a.product.internalCode,
      nombre: a.product.normalizedName,
      familia: a.product.family?.name ?? null,
      estado,
      unidadDeExistencia:
        a.product.stockConfig?.status === 'APROBADA'
          ? ((a.product.stockConfig.stockUnit as 'KG' | 'UNIT' | null) ?? null)
          : null,
      cantidad: a.countedQuantity === null ? null : a.countedQuantity.toString(),
      motivo: a.reason,
      contadoPor: a.countedBy?.name ?? null,
    };
  });

  const impedimentos: string[] = [];
  if (resumen.PENDIENTE > 0) {
    impedimentos.push(
      `${resumen.PENDIENTE} artículo(s) sin contar. Una fila sin contar no vale cero: hay que contarla, ponerla en cero o marcar que la sucursal no la maneja.`,
    );
  }
  if (resumen.BLOQUEADO_UNIDAD > 0) {
    impedimentos.push(
      `${resumen.BLOQUEADO_UNIDAD} artículo(s) sin unidad de existencia aprobada. Se resuelve aprobando la unidad o marcando que la sucursal no los maneja.`,
    );
  }
  if (!sesion.cutoffAt) {
    impedimentos.push('Falta la fecha y hora de corte del conteo.');
  }
  const faltantes = await faltantesDesdeElSnapshot(sessionId);
  if (faltantes > 0) {
    impedimentos.push(
      `Entraron ${faltantes} artículo(s) activo(s) al catálogo después de preparar este borrador. Hay que actualizarlo antes de confirmar; los conteos ya cargados se conservan.`,
    );
  }

  return {
    sessionId: sesion.id,
    branchId: sesion.branchId,
    sucursal: sesion.branch.name,
    estado: sesion.status === 'CONFIRMADA' ? 'CONFIRMADA' : 'BORRADOR',
    ficticia: sesion.ficticia,
    cutoffAt: sesion.cutoffAt,
    catalogSnapshotAt: sesion.catalogSnapshotAt,
    confirmadaPor: sesion.confirmedBy?.name ?? null,
    confirmadaEl: sesion.confirmedAt,
    lineas,
    resumen,
    impedimentos,
  };
}

/** Vuelve a mirar el catálogo sin perder un solo conteo. */
export async function actualizarSnapshot(user: AuthUser, sessionId: string): Promise<Apertura> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_APERTURA_PREPARAR, {
    entity: 'StockCountSession',
    entityId: sessionId,
  });
  const sesion = await prisma.stockCountSession.findUnique({ where: { id: sessionId } });
  if (!sesion) throw new NotFoundError('No existe esa apertura.');
  if (sesion.status === 'CONFIRMADA') {
    throw new ConflictError('La apertura ya está confirmada: su contenido no se toca.');
  }
  const agregados = await sincronizarLineas(sessionId, sesion.branchId, user.id);
  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.STOCKERP_APERTURA_SNAPSHOT,
    entity: 'StockCountSession',
    entityId: sessionId,
    after: { articulosAgregados: agregados },
  });
  return verApertura(user, sessionId);
}

/* ========================================================================== *
 * Contar
 * ========================================================================== */

export async function guardarConteo(
  user: AuthUser,
  input: { activationId: string; cantidad: string },
): Promise<void> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_APERTURA_PREPARAR, {
    entity: 'ProductStockActivation',
    entityId: input.activationId,
    detalle: 'guardar conteo',
  });

  const fila = await prisma.productStockActivation.findUnique({
    where: { id: input.activationId },
    include: { product: { select: { internalCode: true, stockConfig: true } }, session: true },
  });
  if (!fila) throw new NotFoundError('No existe esa línea.');
  if (fila.session?.status === 'CONFIRMADA') {
    throw new ConflictError('La apertura ya está confirmada: los conteos no se cambian.');
  }

  const cfg = fila.product.stockConfig;
  if (cfg?.status !== 'APROBADA' || !cfg.stockUnit) {
    throw new ValidationError(
      'Este artículo todavía no tiene unidad de existencia aprobada. Hasta que alguien la apruebe no se puede contar: no se sabría en qué se está contando.',
    );
  }

  let cantidad: Decimal;
  try {
    cantidad = new Decimal(String(input.cantidad).trim().replace(',', '.'));
  } catch {
    throw new ValidationError(`«${input.cantidad}» no es una cantidad válida.`);
  }
  if (!cantidad.isFinite() || cantidad.lessThan(0)) {
    throw new ValidationError('La cantidad contada no puede ser negativa.');
  }
  if (cantidad.isZero()) {
    throw new ValidationError(
      'Para dejar un artículo en cero usá «Contado en cero»: es una decisión distinta de escribir un número, y conviene que se note.',
    );
  }
  /*
   * Tres decimales. Se comprueba ACÁ, antes de cualquier cast: si se dejara
   * llegar a la base con cuatro, el CHECK la rechazaría igual —bien— pero el
   * mensaje hablaría de una restricción y no de lo que la persona escribió.
   */
  if (!cantidad.equals(cantidad.toDecimalPlaces(3))) {
    throw new ValidationError(
      `La cantidad admite hasta tres decimales. «${input.cantidad}» tiene más, y redondearla en silencio sería inventar un número.`,
    );
  }

  await prisma.productStockActivation.update({
    where: { id: input.activationId },
    data: {
      countedQuantity: cantidad.toString(),
      countedUnit: cfg.stockUnit,
      countedById: user.id,
      countedAt: new Date(),
      state: 'LISTO_PARA_CONTAR',
      reason: null,
    },
  });

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.STOCKERP_CONTEO_GUARDADO,
    entity: 'ProductStockActivation',
    entityId: input.activationId,
    after: { plu: fila.product.internalCode, cantidad: cantidad.toString(), unidad: cfg.stockUnit },
  });
}

/** «Se contó y no había». Es un dato, no una omisión. */
export async function contarEnCero(user: AuthUser, activationId: string): Promise<void> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_APERTURA_PREPARAR, {
    entity: 'ProductStockActivation',
    entityId: activationId,
    detalle: 'contar en cero',
  });
  const fila = await prisma.productStockActivation.findUnique({
    where: { id: activationId },
    include: { product: { select: { internalCode: true, stockConfig: true } }, session: true },
  });
  if (!fila) throw new NotFoundError('No existe esa línea.');
  if (fila.session?.status === 'CONFIRMADA') {
    throw new ConflictError('La apertura ya está confirmada.');
  }
  const cfg = fila.product.stockConfig;
  if (cfg?.status !== 'APROBADA' || !cfg.stockUnit) {
    throw new ValidationError('Este artículo todavía no tiene unidad de existencia aprobada.');
  }

  await prisma.productStockActivation.update({
    where: { id: activationId },
    data: {
      countedQuantity: '0',
      countedUnit: cfg.stockUnit,
      countedById: user.id,
      countedAt: new Date(),
      state: 'LISTO_PARA_CONTAR',
      reason: null,
    },
  });
  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.STOCKERP_CERO_CONFIRMADO,
    entity: 'ProductStockActivation',
    entityId: activationId,
    after: { plu: fila.product.internalCode, cantidad: '0' },
  });
}

export async function marcarNoSeManeja(
  user: AuthUser,
  input: { activationId: string; motivo: string },
): Promise<void> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_ACTIVACION_HABILITAR, {
    entity: 'ProductStockActivation',
    entityId: input.activationId,
    detalle: 'marcar NO_SE_MANEJA',
  });
  if (!input.motivo?.trim()) {
    throw new ValidationError(
      'Decir que la sucursal no maneja un artículo exige un motivo: es una decisión, y dentro de un año nadie va a recordar por qué.',
    );
  }
  const fila = await prisma.productStockActivation.findUnique({
    where: { id: input.activationId },
    include: { product: { select: { internalCode: true } }, session: true },
  });
  if (!fila) throw new NotFoundError('No existe esa línea.');
  if (fila.session?.status === 'CONFIRMADA') {
    throw new ConflictError('La apertura ya está confirmada.');
  }

  await prisma.productStockActivation.update({
    where: { id: input.activationId },
    data: {
      state: 'NO_SE_MANEJA',
      reason: input.motivo.trim(),
      /* No se cuenta: se limpia cualquier conteo previo. */
      countedQuantity: null,
      countedUnit: null,
      countedById: null,
      countedAt: null,
    },
  });
  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.STOCKERP_NO_SE_MANEJA,
    entity: 'ProductStockActivation',
    entityId: input.activationId,
    after: { plu: fila.product.internalCode, motivo: input.motivo.trim() },
  });
}

/* ========================================================================== *
 * El corte
 * ========================================================================== */

export async function fijarCorte(
  user: AuthUser,
  input: { sessionId: string; fecha: string; hora: string },
): Promise<Date> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_APERTURA_PREPARAR, {
    entity: 'StockCountSession',
    entityId: input.sessionId,
    detalle: 'fijar corte',
  });
  const sesion = await prisma.stockCountSession.findUnique({ where: { id: input.sessionId } });
  if (!sesion) throw new NotFoundError('No existe esa apertura.');
  if (sesion.status === 'CONFIRMADA') {
    throw new ConflictError(
      'La apertura ya está confirmada: su corte es inmutable. Moverlo reinterpretaría qué quedó dentro del conteo.',
    );
  }
  const instante = instanteDesdeHoraArgentina(input.fecha, input.hora);
  await prisma.stockCountSession.update({
    where: { id: input.sessionId },
    data: { cutoffAt: instante },
  });
  return instante;
}

/**
 * ¿Un movimiento con esta fecha efectiva cae antes del corte de su sucursal?
 *
 * **La fase 4 la va a necesitar** para rechazar una recepción anterior a la
 * apertura. Se escribe ahora, con sus pruebas, porque es la regla que da
 * sentido al corte: sin ella el corte sería una fecha decorativa. No se usa
 * todavía en ningún camino operativo — no hay recepciones.
 */
export async function esAnteriorAlCorte(branchId: string, effectiveAt: Date): Promise<boolean> {
  const sesion = await prisma.stockCountSession.findFirst({
    where: { branchId, status: 'CONFIRMADA' },
    select: { cutoffAt: true },
  });
  if (!sesion?.cutoffAt) return false;
  return effectiveAt.getTime() < sesion.cutoffAt.getTime();
}

/** ¿Esta sucursal tiene Stock ERP operativo? */
export async function sucursalConApertura(branchId: string): Promise<boolean> {
  const n = await prisma.stockCountSession.count({ where: { branchId, status: 'CONFIRMADA' } });
  return n > 0;
}

/* ========================================================================== *
 * La huella y la clave: idempotencia
 * ========================================================================== */

export const VERSION_DE_LA_HUELLA = 1;

/** La clave es estable y **no lleva reloj**: un reintento la reproduce igual. */
export function claveDeApertura(sessionId: string, branchId: string): string {
  return `apertura:${branchId}:${sessionId}`;
}

/**
 * La huella del contenido.
 *
 * Las líneas se ordenan de forma canónica —por PLU y después por id— antes de
 * calcularla: si dependiera del orden que devuelve la base, dos lecturas de lo
 * mismo darían huellas distintas y un reintento legítimo parecería un
 * conflicto.
 */
export function huellaDeApertura(datos: {
  branchId: string;
  cutoffAt: Date;
  lineas: {
    productId: string;
    pluHistorico: string;
    estado: EstadoDeLinea;
    cantidad: string | null;
    unidad: string | null;
    motivo: string | null;
  }[];
}): string {
  const ordenadas = [...datos.lineas].sort((a, b) =>
    a.pluHistorico === b.pluHistorico
      ? a.productId.localeCompare(b.productId)
      : a.pluHistorico.localeCompare(b.pluHistorico),
  );
  const texto = [
    `v${VERSION_DE_LA_HUELLA}`,
    `sucursal:${datos.branchId}`,
    `corte:${datos.cutoffAt.toISOString()}`,
    ...ordenadas.map((l) =>
      [
        l.productId,
        l.pluHistorico,
        l.estado,
        /* Canónica: «0» y «0.000» son la misma cantidad y tienen que dar igual. */
        l.cantidad === null ? 'sin-contar' : new Decimal(l.cantidad).toString(),
        l.unidad ?? 'sin-unidad',
        l.motivo ?? 'sin-motivo',
      ].join('|'),
    ),
  ].join('\n');
  return createHash('sha256').update(texto).digest('hex');
}

/* ========================================================================== *
 * Confirmar: todo o nada
 * ========================================================================== */

export interface ResultadoDeApertura {
  ok: true;
  yaEstabaAplicada: boolean;
  operationId: string;
  sessionId: string;
  movimientos: number;
  contados: number;
  ceros: number;
  noSeManeja: number;
  cutoffAt: string;
}

export interface ConfirmarInput {
  sessionId: string;
  /** La segunda confirmación, exigida también acá y no sólo en la pantalla. */
  confirmado: boolean;
  /** Lo que la persona vio al confirmar. Si no coincide, no se aplica. */
  esperado: { contados: number; ceros: number; noSeManeja: number };
}

export async function confirmarApertura(
  user: AuthUser,
  input: ConfirmarInput,
): Promise<ResultadoDeApertura> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_APERTURA_CONFIRMAR, {
    entity: 'StockCountSession',
    entityId: input.sessionId,
    detalle: 'confirmar apertura',
  });
  if (!input.confirmado) {
    throw new ValidationError(
      'Falta la segunda confirmación. Confirmar una apertura escribe el libro de existencias de la sucursal y no se deshace.',
    );
  }

  const previa = await prisma.stockCountSession.findUnique({ where: { id: input.sessionId } });
  if (!previa) throw new NotFoundError('No existe esa apertura.');

  /* El interruptor, antes de tocar nada. La base lo vuelve a comprobar. */
  if (!previa.ficticia) {
    const { encendido } = await interruptorDeAperturasReales();
    if (!encendido) {
      await recordAudit({
        userId: user.id,
        action: AUDIT_ACTIONS.STOCKERP_BLOQUEADO_INTERRUPTOR,
        entity: 'StockCountSession',
        entityId: input.sessionId,
        after: { motivo: 'El interruptor de aperturas reales está apagado.' },
      });
      throw new ForbiddenError(
        'El interruptor de aperturas reales de Stock ERP está apagado. Una apertura con datos de verdad no se confirma hasta que alguien lo encienda con motivo.',
      );
    }
  }

  try {
    return await aplicar(user, input);
  } catch (e) {
    /*
     * La transacción abortó. Cualquier cosa que haya que auditar o releer va
     * en una transacción NUEVA: dentro de la abortada no se puede escribir, y
     * un asiento perdido en un rollback es como no haberlo escrito.
     */
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return await resolverCarrera(user, input);
    }
    throw e;
  }
}

async function aplicar(user: AuthUser, input: ConfirmarInput): Promise<ResultadoDeApertura> {
  return prisma.$transaction(async (tx) => {
    /* 1. Bloquear y releer la sesión. */
    await tx.$executeRaw`SELECT id FROM "stock_count_session" WHERE id = ${input.sessionId} FOR UPDATE`;
    const sesion = await tx.stockCountSession.findUnique({
      where: { id: input.sessionId },
      include: {
        branch: true,
        activations: {
          include: { product: { select: { internalCode: true, stockConfig: true } } },
        },
      },
    });
    if (!sesion) throw new NotFoundError('No existe esa apertura.');

    const clave = claveDeApertura(sesion.id, sesion.branchId);

    /* Ya aplicada: se devuelve lo guardado, sin volver a sumar. */
    if (sesion.status === 'CONFIRMADA' && sesion.operationId) {
      const op = await tx.stockOperation.findUniqueOrThrow({ where: { id: sesion.operationId } });
      return comoResultado(op, sesion.id, true);
    }

    /* 2. Revalidar todo, del lado del servidor. */
    if (!sesion.cutoffAt) {
      throw new ValidationError('Falta la fecha y hora de corte del conteo.');
    }

    const activos = await tx.product.count({ where: { active: true } });
    if (activos > sesion.activations.length) {
      throw new ConflictError(
        `Entraron ${activos - sesion.activations.length} artículo(s) activo(s) al catálogo después de preparar este borrador. Actualizá el borrador antes de confirmar: los conteos cargados se conservan.`,
      );
    }

    const lineas = sesion.activations.map((a) => ({
      fila: a,
      estado: estadoDeLinea(a),
      plu: a.product.internalCode,
    }));
    const bloqueantes = lineas.filter((l) => bloqueaConfirmacion(l.estado));
    if (bloqueantes.length > 0) {
      const porEstado = bloqueantes.reduce<Record<string, number>>((acc, l) => {
        acc[l.estado] = (acc[l.estado] ?? 0) + 1;
        return acc;
      }, {});
      throw new ValidationError(
        `No se puede confirmar: ${Object.entries(porEstado)
          .map(([e, n]) => `${n} en ${e}`)
          .join(', ')}. Una fila sin contar no vale cero.`,
      );
    }

    const contados = lineas.filter((l) => l.estado === 'CONTADO');
    const ceros = lineas.filter((l) => l.estado === 'CONTADO_CERO');
    const noSeManeja = lineas.filter((l) => l.estado === 'NO_SE_MANEJA');

    if (
      input.esperado.contados !== contados.length ||
      input.esperado.ceros !== ceros.length ||
      input.esperado.noSeManeja !== noSeManeja.length
    ) {
      throw new ConflictError(
        `Lo que confirmaste no coincide con lo que hay ahora: mostraba ${input.esperado.contados} contados, ${input.esperado.ceros} en cero y ${input.esperado.noSeManeja} no manejados; hay ${contados.length}, ${ceros.length} y ${noSeManeja.length}. Revisá el resumen de nuevo.`,
      );
    }

    const huella = huellaDeApertura({
      branchId: sesion.branchId,
      cutoffAt: sesion.cutoffAt,
      lineas: lineas.map((l) => ({
        productId: l.fila.productId,
        pluHistorico: l.plu,
        estado: l.estado,
        cantidad: l.fila.countedQuantity === null ? null : l.fila.countedQuantity.toString(),
        unidad: l.fila.countedUnit,
        motivo: l.fila.reason,
      })),
    });

    /* Una operación con la misma clave: hay que comparar antes de escribir. */
    const opPrevia = await tx.stockOperation.findUnique({ where: { operationKey: clave } });
    if (opPrevia) {
      if (opPrevia.hashVersion === VERSION_DE_LA_HUELLA && opPrevia.contentHash === huella) {
        return comoResultado(opPrevia, sesion.id, true);
      }
      throw new ConflictError(
        'Ya se aplicó una apertura para esta sucursal con un contenido distinto. No se escribe nada: revisá qué cambió.',
      );
    }

    /* 3. La operación. */
    const operacion = await tx.stockOperation.create({
      data: {
        operationKey: clave,
        kind: 'ACTIVACION',
        hashVersion: VERSION_DE_LA_HUELLA,
        contentHash: huella,
        branchId: sesion.branchId,
        requestedById: user.id,
      },
    });

    /*
     * 4 y 5. Los movimientos, en orden determinístico.
     *
     * Por PLU y después por id de la línea: dos confirmaciones concurrentes
     * toman los mismos bloqueos en el mismo orden y no se abrazan.
     */
    const aEscribir = [...contados, ...ceros].sort((a, b) =>
      a.plu === b.plu ? a.fila.id.localeCompare(b.fila.id) : a.plu.localeCompare(b.plu),
    );

    let movimientos = 0;
    for (const l of aEscribir) {
      const unidad = l.fila.countedUnit!;
      const cantidad = new Decimal(l.fila.countedQuantity!.toString());

      /*
       * El movimiento se inserta con SQL, no con `tx.stockLedger.create`.
       *
       * HALLAZGO: la primera versión creaba la fila con Prisma y después le
       * ponía el `txId` con un UPDATE. El libro es inmutable por disparador y
       * rechazó el UPDATE, que es exactamente lo que tiene que hacer. El
       * `txId` lo exige el disparador del saldo y tiene que ser el de ESTA
       * transacción, así que va en el INSERT: `txid_current()` no se puede
       * expresar desde Prisma, y el libro no admite arreglarlo después.
       */
      const movId = `${operacion.id}-${l.fila.productId}`;
      await tx.$executeRaw`
        INSERT INTO "stock_ledger"
          ("id","txId","productId","pluHistorico","branchId","type","direction",
           "quantity","unit","effectiveAt","operationId","userId","idempotencyKey",
           "balanceAfterSeq","reason","createdAt")
        VALUES (${movId}, txid_current(), ${l.fila.productId}, ${l.plu},
                ${sesion.branchId}, 'OPENING_BALANCE'::"StockMovementType",
                'IN'::"StockDirection", ${cantidad.toString()}::numeric,
                ${unidad}::"StockUnit", ${sesion.cutoffAt!}, ${operacion.id},
                ${user.id}, ${`${clave}:${l.fila.productId}`},
                ${cantidad.toString()}::numeric, 'Apertura de existencias', now())`;
      const mov = { id: movId };

      /* 6. El saldo, respaldado por ese movimiento. */
      await tx.stockBalance.create({
        data: {
          productId: l.fila.productId,
          branchId: sesion.branchId,
          quantity: cantidad.toString(),
          unit: unidad,
          lastLedgerId: mov.id,
          lastOperationId: operacion.id,
          /* 7. De dónde nació este saldo. */
          openingSource: 'APERTURA',
        },
      });

      /* 8. La activación queda ACTIVA, con su corte y su movimiento. */
      await tx.productStockActivation.update({
        where: { id: l.fila.id },
        data: {
          state: 'ACTIVO',
          cutoffAt: sesion.cutoffAt!,
          openingLedgerId: mov.id,
          activatedById: user.id,
          activatedAt: new Date(),
        },
      });
      movimientos += 1;
    }

    /* NO_SE_MANEJA conserva su decisión y no escribe movimiento ni saldo. */
    for (const l of noSeManeja) {
      await tx.productStockActivation.update({
        where: { id: l.fila.id },
        data: { activatedById: user.id, activatedAt: new Date() },
      });
    }

    /* 9 y 10. La sesión y el resultado. */
    const resultado = {
      sessionId: sesion.id,
      branchId: sesion.branchId,
      movimientos,
      contados: contados.length,
      ceros: ceros.length,
      noSeManeja: noSeManeja.length,
      cutoffAt: sesion.cutoffAt!.toISOString(),
    };
    await tx.stockOperation.update({
      where: { id: operacion.id },
      data: { movementCount: movimientos, result: resultado },
    });
    await tx.stockCountSession.update({
      where: { id: sesion.id },
      data: {
        status: 'CONFIRMADA',
        confirmedById: user.id,
        confirmedAt: new Date(),
        operationId: operacion.id,
        closedAt: new Date(),
      },
    });

    /* 11. La auditoría, dentro de la misma transacción. */
    await recordAudit(
      {
        userId: user.id,
        action: AUDIT_ACTIONS.STOCKERP_APERTURA_CONFIRMADA,
        entity: 'StockCountSession',
        entityId: sesion.id,
        after: { ...resultado, sucursal: sesion.branch.name, ficticia: sesion.ficticia, huella },
      },
      tx,
    );

    return {
      ok: true as const,
      yaEstabaAplicada: false,
      operationId: operacion.id,
      ...resultado,
    };
  });
}

function comoResultado(
  op: { id: string; result: Prisma.JsonValue | null; movementCount: number },
  sessionId: string,
  yaEstaba: boolean,
): ResultadoDeApertura {
  const r = (op.result ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    yaEstabaAplicada: yaEstaba,
    operationId: op.id,
    sessionId,
    movimientos: op.movementCount,
    contados: Number(r.contados ?? 0),
    ceros: Number(r.ceros ?? 0),
    noSeManeja: Number(r.noSeManeja ?? 0),
    cutoffAt: String(r.cutoffAt ?? ''),
  };
}

/**
 * Dos confirmaciones a la vez: una ganó y la otra chocó con la unicidad.
 *
 * La que perdió **no puede** limitarse a decir «ya estaba»: una violación de
 * unicidad sola no demuestra idempotencia, sólo demuestra que hubo un choque.
 * Hay que releer en una transacción NUEVA —la anterior abortó— y comparar
 * versión y huella. Si coinciden, la otra aplicó exactamente esto; si no,
 * aplicó otra cosa y hay que decirlo.
 */
async function resolverCarrera(user: AuthUser, input: ConfirmarInput): Promise<ResultadoDeApertura> {
  const sesion = await prisma.stockCountSession.findUnique({
    where: { id: input.sessionId },
    include: { activations: { include: { product: { select: { internalCode: true } } } } },
  });
  if (!sesion?.cutoffAt) {
    throw new ConflictError('Otra confirmación se adelantó y esta apertura quedó en un estado que no se puede resolver solo.');
  }
  const clave = claveDeApertura(sesion.id, sesion.branchId);
  const op = await prisma.stockOperation.findUnique({ where: { operationKey: clave } });

  const huella = huellaDeApertura({
    branchId: sesion.branchId,
    cutoffAt: sesion.cutoffAt,
    lineas: sesion.activations.map((a) => ({
      productId: a.productId,
      pluHistorico: a.product.internalCode,
      estado: estadoDeLinea(a),
      cantidad: a.countedQuantity === null ? null : a.countedQuantity.toString(),
      unidad: a.countedUnit,
      motivo: a.reason,
    })),
  });

  if (op && op.hashVersion === VERSION_DE_LA_HUELLA && op.contentHash === huella) {
    await recordAudit({
      userId: user.id,
      action: AUDIT_ACTIONS.STOCKERP_APERTURA_SIMULTANEA,
      entity: 'StockCountSession',
      entityId: sesion.id,
      after: { resuelto: 'ALREADY_APPLIED', operationId: op.id },
    });
    return comoResultado(op, sesion.id, true);
  }

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.STOCKERP_CONFLICTO_DE_HUELLA,
    entity: 'StockCountSession',
    entityId: sesion.id,
    after: { huellaEsperada: huella, huellaGuardada: op?.contentHash ?? null },
  });
  throw new ConflictError(
    'Otra confirmación se adelantó con un contenido distinto. No se escribió nada: mirá el resumen antes de volver a intentar.',
  );
}
