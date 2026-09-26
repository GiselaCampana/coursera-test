import 'server-only';
import { createHash } from 'node:crypto';
import { Prisma, type StockUnit } from '@prisma/client';
import { Decimal } from '@/lib/money';
import { prisma } from '@/lib/db';
import { ahora, formatCorteAr } from '@/lib/datetime';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import type { AuthUser } from '@/lib/auth/session';
import { hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/services/audit';
import { esUnaBaseDePruebas } from '@/lib/base-de-pruebas';

/**
 * **Traslados entre sucursales: dos hechos físicos, no uno.**
 *
 * La mercadería sale de una sucursal un día y llega a la otra al siguiente.
 * Entre las dos cosas existe y no está en ninguna góndola, y eso es lo que este
 * servicio modela: el despacho baja el saldo del origen, el destino no sube
 * hasta que alguien confirma la recepción, y en el medio el traslado está **en
 * tránsito**.
 *
 * LO QUE ESTA FASE **NO** HACE
 *
 * No hay recepciones parciales ni diferencias físicas. Si lo que llegó no
 * coincide con lo que salió, la recepción **no se confirma**: el traslado se
 * queda en tránsito y la diferencia se resolverá con el flujo de incidencias,
 * mermas o devolución, que todavía no existe. No se ajusta nada en silencio, no
 * se inventa una merma y no se fuerza el cierre. Un movimiento compensatorio a
 * medias es peor que una diferencia visible.
 *
 * DÓNDE VIVE CADA REGLA
 *
 * Las que no se pueden confiar al servicio viven en la base: cantidades
 * positivas y de escala tres, recepción exacta, sucursales distintas, el estado
 * coherente con lo que promete, las transiciones, la inmutabilidad de los
 * renglones desde el despacho, el corte de la apertura y el interruptor. Este
 * archivo las vuelve a comprobar para poder explicarlas en castellano, no para
 * reemplazarlas: una consulta suelta se saltea el servicio, no la base.
 */

export const VERSION_DE_LA_HUELLA_DE_TRASLADO = 1;

export type EstadoDeTraslado = 'BORRADOR' | 'DESPACHADO' | 'RECIBIDO' | 'CANCELADO';

/* ========================================================================== *
 * Permisos
 * ========================================================================== */

async function exigirPermiso(
  user: AuthUser,
  permiso: string,
  contexto: { entityId?: string; detalle?: string },
): Promise<void> {
  if (hasPermission(user, permiso)) return;
  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.STOCKERP_INTENTO_RECHAZADO,
    entity: 'StockTransfer',
    entityId: contexto.entityId,
    after: { permisoQueFaltaba: permiso, detalle: contexto.detalle ?? null },
  });
  throw new ForbiddenError(
    `Tu usuario no tiene el permiso «${permiso}». Se pide a un administrador desde Configuración → Roles.`,
  );
}

/* ========================================================================== *
 * El interruptor de traslados reales
 * ========================================================================== */

export async function interruptorDeTrasladosReales(): Promise<{
  encendido: boolean;
  cambiadoPor: string | null;
  cambiadoEl: Date | null;
  motivo: string | null;
}> {
  const fila = await prisma.stockModuleSetting.findFirst({
    include: { transfersChangedBy: { select: { name: true } } },
  });
  return {
    encendido: fila?.realTransfersEnabled ?? false,
    cambiadoPor: fila?.transfersChangedBy?.name ?? null,
    cambiadoEl: fila?.transfersChangedAt ?? null,
    motivo: fila?.transfersReason ?? null,
  };
}

export async function cambiarInterruptorDeTraslados(
  user: AuthUser,
  input: { encender: boolean; motivo: string },
): Promise<{ encendido: boolean }> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_MODULO_CONFIGURAR, {
    detalle: 'cambiar el interruptor de traslados reales',
  });
  const motivo = input.motivo?.trim();
  if (!motivo) {
    throw new ValidationError(
      'Cambiar el interruptor de traslados reales exige escribir por qué. Queda auditado con tu nombre.',
    );
  }

  const fila = await prisma.stockModuleSetting.findFirst();
  if (!fila) {
    throw new NotFoundError('No existe la fila de configuración de Stock ERP.');
  }
  /* El valor anterior se lee de la BASE, no de lo que mande el navegador. */
  const antes = fila.realTransfersEnabled;

  await prisma.stockModuleSetting.update({
    where: { id: fila.id },
    data: {
      realTransfersEnabled: input.encender,
      transfersChangedById: user.id,
      transfersChangedAt: ahora(),
      transfersReason: motivo,
    },
  });
  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.STOCKERP_TRASLADOS_INTERRUPTOR,
    entity: 'StockModuleSetting',
    entityId: fila.id,
    before: { realTransfersEnabled: antes },
    after: { realTransfersEnabled: input.encender, motivo },
    reason: motivo,
  });
  return { encendido: input.encender };
}

/* ========================================================================== *
 * Cantidades
 * ========================================================================== */

/** Tres decimales, como el libro. Nunca `Number`: `0.1 + 0.2` no es `0.3`. */
export function cantidadValida(texto: string): Decimal {
  const limpio = (texto ?? '').toString().trim().replace(',', '.');
  if (limpio === '') {
    throw new ValidationError('Falta la cantidad.');
  }
  let valor: Decimal;
  try {
    valor = new Decimal(limpio);
  } catch {
    throw new ValidationError(`«${texto}» no es una cantidad.`);
  }
  if (!valor.isFinite()) throw new ValidationError(`«${texto}» no es una cantidad.`);
  if (valor.lessThanOrEqualTo(0)) {
    throw new ValidationError(
      'La cantidad de un traslado tiene que ser mayor que cero. Un traslado de cero no mueve nada, y uno negativo es un traslado al revés: eso se hace trasladando en el otro sentido.',
    );
  }
  if (valor.decimalPlaces() > 3) {
    throw new ValidationError(
      `La cantidad admite hasta tres decimales y «${texto}» tiene ${valor.decimalPlaces()}. El libro guarda tres: aceptar más acá haría que lo guardado no fuera lo escrito.`,
    );
  }
  if (valor.greaterThan(1_000_000)) {
    throw new ValidationError('La cantidad excede el máximo de 1.000.000.');
  }
  return valor;
}

/* ========================================================================== *
 * El borrador
 * ========================================================================== */

export async function crearBorrador(
  user: AuthUser,
  input: { origenId: string; destinoId: string },
): Promise<{ id: string }> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_TRASLADO_PREPARAR, {
    detalle: 'crear un borrador de traslado',
  });

  if (!input.origenId || !input.destinoId) {
    throw new ValidationError('Hay que elegir la sucursal de origen y la de destino.');
  }
  if (input.origenId === input.destinoId) {
    throw new ValidationError(
      'El origen y el destino tienen que ser distintos. Un traslado de una sucursal a sí misma no mueve mercadería: mueve dos asientos que se cancelan.',
    );
  }

  const sucursales = await prisma.branch.findMany({
    where: { id: { in: [input.origenId, input.destinoId] } },
    select: { id: true, name: true },
  });
  if (sucursales.length !== 2) {
    throw new NotFoundError('Alguna de las dos sucursales no existe.');
  }

  const traslado = await prisma.stockTransfer.create({
    data: {
      fromBranchId: input.origenId,
      toBranchId: input.destinoId,
      status: 'BORRADOR',
      preparedById: user.id,
      userId: user.id,
    },
  });
  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.STOCKERP_TRASLADO_CREADO,
    entity: 'StockTransfer',
    entityId: traslado.id,
    after: {
      origen: input.origenId,
      destino: input.destinoId,
      estado: 'BORRADOR',
    },
  });
  return { id: traslado.id };
}

/** El borrador, con su bloqueo optimista comprobado. */
async function borradorEditable(trasladoId: string, version?: number) {
  const traslado = await prisma.stockTransfer.findUnique({ where: { id: trasladoId } });
  if (!traslado) throw new NotFoundError('Ese traslado no existe.');
  if (traslado.status !== 'BORRADOR') {
    throw new ConflictError(
      `Este traslado está ${traslado.status.toLowerCase()} y ya no se edita. ` +
        (traslado.status === 'DESPACHADO'
          ? 'La mercadería salió del origen: lo único que falta es recibirla.'
          : 'Un traslado cerrado o cancelado es historia.'),
    );
  }
  if (version !== undefined && version !== traslado.version) {
    throw new ConflictError(
      'Alguien más cambió este borrador mientras lo editabas. No se escribió nada: volvé a abrirlo para ver cómo quedó.',
    );
  }
  return traslado;
}

export async function agregarRenglon(
  user: AuthUser,
  input: { trasladoId: string; productId: string; cantidad: string; version?: number },
): Promise<{ lineaId: string }> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_TRASLADO_PREPARAR, {
    entityId: input.trasladoId,
    detalle: 'agregar un renglón',
  });
  const traslado = await borradorEditable(input.trasladoId, input.version);
  const cantidad = cantidadValida(input.cantidad);

  const producto = await prisma.product.findUnique({
    where: { id: input.productId },
    include: { stockConfig: true },
  });
  if (!producto) throw new NotFoundError('Ese artículo no existe.');

  const unidad = unidadAprobadaDe(producto.stockConfig, producto.normalizedName);

  const yaEsta = await prisma.stockTransferLine.findFirst({
    where: { transferId: traslado.id, productId: producto.id },
  });
  if (yaEsta) {
    throw new ValidationError(
      `«${producto.normalizedName}» ya está en este traslado. Cambiale la cantidad en vez de agregarlo dos veces: dos renglones del mismo artículo no dicen nada que uno no diga.`,
    );
  }

  const linea = await prisma.$transaction(async (tx) => {
    const creada = await tx.stockTransferLine.create({
      data: {
        transferId: traslado.id,
        productId: producto.id,
        quantity: cantidad.toString(),
        unit: unidad,
      },
    });
    await tx.stockTransfer.update({
      where: { id: traslado.id },
      data: { version: { increment: 1 } },
    });
    await recordAudit(
      {
        userId: user.id,
        action: AUDIT_ACTIONS.STOCKERP_TRASLADO_RENGLON,
        entity: 'StockTransferLine',
        entityId: creada.id,
        after: {
          traslado: traslado.id,
          origen: traslado.fromBranchId,
          destino: traslado.toBranchId,
          articulo: producto.normalizedName,
          plu: producto.internalCode,
          cantidad: cantidad.toString(),
          unidad,
          cambio: 'AGREGADO',
        },
      },
      tx,
    );
    return creada;
  });

  return { lineaId: linea.id };
}

export async function modificarRenglon(
  user: AuthUser,
  input: { lineaId: string; cantidad: string; version?: number },
): Promise<void> {
  const linea = await prisma.stockTransferLine.findUnique({
    where: { id: input.lineaId },
    include: { transfer: true, product: { select: { normalizedName: true, internalCode: true } } },
  });
  if (!linea) throw new NotFoundError('Ese renglón no existe.');

  await exigirPermiso(user, PERMISSIONS.STOCKERP_TRASLADO_PREPARAR, {
    entityId: linea.transferId,
    detalle: 'modificar un renglón',
  });
  const traslado = await borradorEditable(linea.transferId, input.version);
  const cantidad = cantidadValida(input.cantidad);
  const antes = linea.quantity.toString();

  await prisma.$transaction(async (tx) => {
    await tx.stockTransferLine.update({
      where: { id: linea.id },
      data: { quantity: cantidad.toString() },
    });
    await tx.stockTransfer.update({
      where: { id: traslado.id },
      data: { version: { increment: 1 } },
    });
    await recordAudit(
      {
        userId: user.id,
        action: AUDIT_ACTIONS.STOCKERP_TRASLADO_RENGLON,
        entity: 'StockTransferLine',
        entityId: linea.id,
        before: { cantidad: antes },
        after: {
          traslado: traslado.id,
          origen: traslado.fromBranchId,
          destino: traslado.toBranchId,
          articulo: linea.product.normalizedName,
          plu: linea.product.internalCode,
          cantidad: cantidad.toString(),
          unidad: linea.unit,
          cambio: 'MODIFICADO',
        },
      },
      tx,
    );
  });
}

export async function retirarRenglon(
  user: AuthUser,
  input: { lineaId: string; version?: number },
): Promise<void> {
  const linea = await prisma.stockTransferLine.findUnique({
    where: { id: input.lineaId },
    include: { transfer: true, product: { select: { normalizedName: true, internalCode: true } } },
  });
  if (!linea) throw new NotFoundError('Ese renglón no existe.');

  await exigirPermiso(user, PERMISSIONS.STOCKERP_TRASLADO_PREPARAR, {
    entityId: linea.transferId,
    detalle: 'retirar un renglón',
  });
  const traslado = await borradorEditable(linea.transferId, input.version);

  await prisma.$transaction(async (tx) => {
    await tx.stockTransferLine.delete({ where: { id: linea.id } });
    await tx.stockTransfer.update({
      where: { id: traslado.id },
      data: { version: { increment: 1 } },
    });
    await recordAudit(
      {
        userId: user.id,
        action: AUDIT_ACTIONS.STOCKERP_TRASLADO_RENGLON,
        entity: 'StockTransferLine',
        entityId: linea.id,
        before: {
          articulo: linea.product.normalizedName,
          plu: linea.product.internalCode,
          cantidad: linea.quantity.toString(),
          unidad: linea.unit,
        },
        after: { traslado: traslado.id, cambio: 'RETIRADO' },
      },
      tx,
    );
  });
}

export async function cancelarBorrador(
  user: AuthUser,
  input: { trasladoId: string; motivo: string },
): Promise<void> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_TRASLADO_PREPARAR, {
    entityId: input.trasladoId,
    detalle: 'cancelar un borrador',
  });
  const traslado = await borradorEditable(input.trasladoId);
  const motivo = input.motivo?.trim();
  if (!motivo) {
    throw new ValidationError('Cancelar un borrador exige escribir por qué. Queda auditado.');
  }

  await prisma.$transaction(async (tx) => {
    await tx.stockTransfer.update({
      where: { id: traslado.id },
      data: {
        status: 'CANCELADO',
        cancelledById: user.id,
        cancelledAt: ahora(),
        reason: motivo,
        version: { increment: 1 },
      },
    });
    await recordAudit(
      {
        userId: user.id,
        action: AUDIT_ACTIONS.STOCKERP_TRASLADO_CANCELADO,
        entity: 'StockTransfer',
        entityId: traslado.id,
        before: { estado: 'BORRADOR' },
        after: {
          estado: 'CANCELADO',
          origen: traslado.fromBranchId,
          destino: traslado.toBranchId,
          motivo,
        },
        reason: motivo,
      },
      tx,
    );
  });
}

/* ========================================================================== *
 * La revisión previa: qué pasaría, sin que pase
 * ========================================================================== */

export type ClaseDeRenglonDeTraslado = 'LISTO' | 'BLOQUEADO';

export interface RenglonDeTraslado {
  lineaId: string;
  productId: string;
  articulo: string;
  plu: string;
  cantidad: string;
  unidad: StockUnit;
  clase: ClaseDeRenglonDeTraslado;
  motivo: string | null;
  /** Saldos de ORIGEN antes y después del despacho. */
  saldoOrigenAntes: string | null;
  saldoOrigenDespues: string | null;
  /** Saldos de DESTINO antes y después de la recepción. */
  saldoDestinoAntes: string | null;
  saldoDestinoDespues: string | null;
  dispatchedQuantity: string | null;
  receivedQuantity: string | null;
}

export interface TrasladoDetalle {
  id: string;
  estado: EstadoDeTraslado | 'APLICADO' | 'REVERSADO';
  version: number;
  origenId: string;
  origen: string;
  destinoId: string;
  destino: string;
  preparadoPor: string | null;
  despachadoPor: string | null;
  recibidoPor: string | null;
  canceladoPor: string | null;
  creadoEl: Date;
  despachadoEl: Date | null;
  recibidoEl: Date | null;
  canceladoEl: Date | null;
  motivo: string | null;
  operacionDeDespacho: string | null;
  operacionDeRecepcion: string | null;
  renglones: RenglonDeTraslado[];
  /** Impedimentos que frenan el despacho, en castellano. */
  impedimentos: string[];
  /** Cuántos movimientos escribiría el despacho. */
  movimientosPrevistos: number;
  ficticio: boolean;
  interruptorEncendido: boolean;
}

function unidadAprobadaDe(
  config: { status: string; stockUnit: StockUnit | null } | null,
  nombre: string,
): StockUnit {
  if (!config || config.status !== 'APROBADA' || !config.stockUnit) {
    throw new ValidationError(
      `«${nombre}» no tiene unidad de existencia aprobada, así que no se puede trasladar: nadie decidió todavía si se cuenta en kilos o en unidades. Se aprueba en Stock ERP → Unidades.`,
    );
  }
  return config.stockUnit;
}

/**
 * La revisión previa. **No escribe nada.**
 *
 * Calcula, por renglón, el saldo de origen antes y después y el de destino antes
 * y después, y junta los impedimentos en castellano. Es la pantalla que alguien
 * mira antes de decidir, y por eso tiene que decir lo mismo que va a pasar.
 */
export async function detalleDeTraslado(
  user: AuthUser,
  trasladoId: string,
): Promise<TrasladoDetalle> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_VER, {
    entityId: trasladoId,
    detalle: 'ver un traslado',
  });

  const traslado = await prisma.stockTransfer.findUnique({
    where: { id: trasladoId },
    include: {
      fromBranch: { select: { id: true, name: true } },
      toBranch: { select: { id: true, name: true } },
      preparedBy: { select: { name: true } },
      dispatchedBy: { select: { name: true } },
      receivedBy: { select: { name: true } },
      cancelledBy: { select: { name: true } },
      lines: {
        orderBy: { id: 'asc' },
        include: {
          product: {
            select: {
              id: true,
              normalizedName: true,
              internalCode: true,
              stockConfig: { select: { status: true, stockUnit: true } },
            },
          },
        },
      },
    },
  });
  if (!traslado) throw new NotFoundError('Ese traslado no existe.');

  const [aperturaOrigen, aperturaDestino, interruptor] = await Promise.all([
    prisma.stockCountSession.findFirst({
      where: { branchId: traslado.fromBranchId, status: 'CONFIRMADA' },
      select: { cutoffAt: true, ficticia: true },
    }),
    prisma.stockCountSession.findFirst({
      where: { branchId: traslado.toBranchId, status: 'CONFIRMADA' },
      select: { cutoffAt: true, ficticia: true },
    }),
    interruptorDeTrasladosReales(),
  ]);

  const impedimentos: string[] = [];
  if (!aperturaOrigen) {
    impedimentos.push(
      `${traslado.fromBranch.name} no tiene apertura confirmada de Stock ERP. Sin apertura no hay saldo del cual despachar: sus artículos no están en cero, están sin contar.`,
    );
  }
  if (!aperturaDestino) {
    impedimentos.push(
      `${traslado.toBranch.name} no tiene apertura confirmada de Stock ERP. La mercadería no puede llegar a una sucursal que todavía no inauguró su inventario.`,
    );
  }
  if (traslado.lines.length === 0) {
    impedimentos.push('El traslado no tiene ningún renglón: no hay nada que despachar.');
  }

  const ficticio = aperturaOrigen?.ficticia ?? false;
  if (!ficticio && aperturaOrigen && !interruptor.encendido) {
    impedimentos.push(
      'El interruptor de traslados reales está apagado. Los saldos todavía no incluyen ventas: mover mercadería real entre sucursales dejaría dos inventarios que nada verifica.',
    );
  }
  if (ficticio && !esUnaBaseDePruebas(process.env.DATABASE_URL)) {
    impedimentos.push(
      'La apertura del origen es ficticia y esta no es una base de pruebas. Un traslado sobre un inventario inventado no se aplica acá.',
    );
  }

  const productos = traslado.lines.map((l) => l.productId);
  const [saldosOrigen, saldosDestino, activaciones] = await Promise.all([
    prisma.stockBalance.findMany({
      where: { branchId: traslado.fromBranchId, productId: { in: productos } },
    }),
    prisma.stockBalance.findMany({
      where: { branchId: traslado.toBranchId, productId: { in: productos } },
    }),
    prisma.productStockActivation.findMany({
      where: {
        productId: { in: productos },
        branchId: { in: [traslado.fromBranchId, traslado.toBranchId] },
      },
    }),
  ]);
  const porProducto = <T extends { productId: string }>(filas: T[]) =>
    new Map(filas.map((f) => [f.productId, f]));
  const origen = porProducto(saldosOrigen);
  const destino = porProducto(saldosDestino);
  const activacion = new Map(activaciones.map((a) => [`${a.productId}:${a.branchId}`, a]));

  const renglones: RenglonDeTraslado[] = traslado.lines.map((l) => {
    const motivos: string[] = [];
    const cfg = l.product.stockConfig;
    if (!cfg || cfg.status !== 'APROBADA' || !cfg.stockUnit) {
      motivos.push('no tiene unidad de existencia aprobada');
    } else if (cfg.stockUnit !== l.unit) {
      /*
       * La unidad del renglón se fijó al agregarlo. Si la configuración cambió
       * después, NO se reinterpreta: dos kilos no se convierten en dos unidades
       * porque alguien editó una tabla.
       */
      motivos.push(
        `se preparó en ${l.unit} y la unidad aprobada hoy es ${cfg.stockUnit}: no se reinterpreta, hay que rehacer el renglón`,
      );
    }

    const actOrigen = activacion.get(`${l.productId}:${traslado.fromBranchId}`);
    const actDestino = activacion.get(`${l.productId}:${traslado.toBranchId}`);
    if (actOrigen?.state === 'NO_SE_MANEJA') {
      motivos.push(`${traslado.fromBranch.name} no maneja este artículo`);
    }
    if (actOrigen?.state === 'PENDIENTE_CONFIGURACION') {
      motivos.push(`en ${traslado.fromBranch.name} está pendiente de configuración`);
    }
    if (actDestino?.state === 'NO_SE_MANEJA') {
      motivos.push(`${traslado.toBranch.name} no maneja este artículo`);
    }
    if (actDestino?.state === 'PENDIENTE_CONFIGURACION') {
      motivos.push(`en ${traslado.toBranch.name} está pendiente de configuración`);
    }

    const saldoO = origen.get(l.productId);
    const saldoD = destino.get(l.productId);
    const cantidad = new Decimal(l.quantity.toString());
    const antesO = saldoO ? new Decimal(saldoO.quantity.toString()) : null;
    const antesD = saldoD ? new Decimal(saldoD.quantity.toString()) : null;

    if (antesO === null) {
      motivos.push(
        `no hay saldo de este artículo en ${traslado.fromBranch.name}: nunca se contó ni entró`,
      );
    } else if (antesO.lessThan(cantidad)) {
      motivos.push(
        `hay ${antesO.toString()} ${l.unit} y se quieren despachar ${cantidad.toString()}`,
      );
    }
    if (saldoD && saldoD.unit !== l.unit) {
      motivos.push(
        `${traslado.toBranch.name} lleva este artículo en ${saldoD.unit} y el traslado va en ${l.unit}: no se suman unidades incompatibles`,
      );
    }

    return {
      lineaId: l.id,
      productId: l.productId,
      articulo: l.product.normalizedName,
      plu: l.product.internalCode,
      cantidad: cantidad.toString(),
      unidad: l.unit,
      clase: motivos.length === 0 ? 'LISTO' : 'BLOQUEADO',
      motivo: motivos.length === 0 ? null : motivos.join('; '),
      saldoOrigenAntes: antesO?.toString() ?? null,
      saldoOrigenDespues:
        antesO !== null && antesO.greaterThanOrEqualTo(cantidad)
          ? antesO.minus(cantidad).toString()
          : null,
      saldoDestinoAntes: antesD?.toString() ?? null,
      saldoDestinoDespues: (antesD ?? new Decimal(0)).plus(cantidad).toString(),
      dispatchedQuantity: l.dispatchedQuantity?.toString() ?? null,
      receivedQuantity: l.receivedQuantity?.toString() ?? null,
    };
  });

  const bloqueados = renglones.filter((r) => r.clase === 'BLOQUEADO');
  if (bloqueados.length > 0) {
    impedimentos.push(
      `${bloqueados.length} ${bloqueados.length === 1 ? 'renglón' : 'renglones'} no se puede despachar. El traslado va entero o no va: no se despacha una parte.`,
    );
  }

  return {
    id: traslado.id,
    estado: traslado.status as TrasladoDetalle['estado'],
    version: traslado.version,
    origenId: traslado.fromBranch.id,
    origen: traslado.fromBranch.name,
    destinoId: traslado.toBranch.id,
    destino: traslado.toBranch.name,
    preparadoPor: traslado.preparedBy?.name ?? null,
    despachadoPor: traslado.dispatchedBy?.name ?? null,
    recibidoPor: traslado.receivedBy?.name ?? null,
    canceladoPor: traslado.cancelledBy?.name ?? null,
    creadoEl: traslado.createdAt,
    despachadoEl: traslado.dispatchedAt,
    recibidoEl: traslado.receivedAt,
    canceladoEl: traslado.cancelledAt,
    motivo: traslado.reason,
    operacionDeDespacho: traslado.operationId,
    operacionDeRecepcion: traslado.receiptOperationId,
    renglones,
    impedimentos,
    movimientosPrevistos: renglones.filter((r) => r.clase === 'LISTO').length,
    ficticio,
    interruptorEncendido: interruptor.encendido,
  };
}

/* ========================================================================== *
 * La huella y las claves
 * ========================================================================== */

export function claveDeDespacho(trasladoId: string): string {
  return `traslado:${trasladoId}:despacho`;
}

export function claveDeRecepcionDeTraslado(trasladoId: string): string {
  return `traslado:${trasladoId}:recepcion`;
}

/**
 * La huella del traslado, canónica.
 *
 * **Sin reloj.** Dos intentos del mismo despacho tienen que dar la misma huella
 * aunque pasen minutos entre uno y otro: si el instante entrara, cada reintento
 * sería un contenido distinto y la idempotencia no existiría.
 *
 * Los renglones van ordenados por identificador y las cantidades canónicas a
 * tres decimales: «3» y «3.000» son la misma cantidad y no pueden dar huellas
 * distintas.
 */
export function huellaDeTraslado(datos: {
  trasladoId: string;
  origenId: string;
  destinoId: string;
  paso: 'despacho' | 'recepcion';
  renglones: { lineaId: string; productId: string; unidad: StockUnit; cantidad: string }[];
}): string {
  const ordenadas = [...datos.renglones].sort((a, b) => a.lineaId.localeCompare(b.lineaId));
  const texto = [
    `v${VERSION_DE_LA_HUELLA_DE_TRASLADO}`,
    'tipo:TRASLADO',
    `paso:${datos.paso}`,
    `traslado:${datos.trasladoId}`,
    `origen:${datos.origenId}`,
    `destino:${datos.destinoId}`,
    ...ordenadas.map((r) =>
      [
        r.lineaId,
        r.productId,
        r.unidad,
        new Decimal(r.cantidad).toDecimalPlaces(3).toString(),
      ].join('|'),
    ),
  ].join('\n');
  return createHash('sha256').update(texto).digest('hex');
}

/* ========================================================================== *
 * Despachar: todo o nada
 * ========================================================================== */

export interface ResultadoDeTraslado {
  ok: true;
  yaEstabaAplicado: boolean;
  trasladoId: string;
  estado: EstadoDeTraslado;
  operationId: string;
  movimientos: number;
  momento: string;
}

export async function despachar(
  user: AuthUser,
  input: { trasladoId: string; confirmado: boolean },
): Promise<ResultadoDeTraslado> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_TRASLADO_DESPACHAR, {
    entityId: input.trasladoId,
    detalle: 'despachar un traslado',
  });
  if (!input.confirmado) {
    throw new ValidationError(
      'Falta la segunda confirmación. Despachar saca la mercadería del origen y escribe el libro: no se deshace.',
    );
  }

  for (let intento = 1; intento <= 3; intento += 1) {
    try {
      return await aplicarDespacho(user, input.trasladoId);
    } catch (e) {
      const codigo = e instanceof Prisma.PrismaClientKnownRequestError ? e.code : null;
      if (codigo === 'P2002') return await resolverCarrera(user, input.trasladoId, 'despacho');
      const serializacion =
        e instanceof Prisma.PrismaClientUnknownRequestError &&
        /40001|could not serialize/i.test(e.message);
      if (serializacion && intento < 3) continue;
      throw e;
    }
  }
  throw new ConflictError('El despacho no se pudo aplicar después de tres intentos.');
}

async function aplicarDespacho(
  user: AuthUser,
  trasladoId: string,
): Promise<ResultadoDeTraslado> {
  /* La revisión se calcula FUERA y se revalida ADENTRO. */
  const previa = await detalleDeTraslado(user, trasladoId);
  if (previa.estado !== 'BORRADOR') {
    if (previa.estado === 'DESPACHADO' || previa.estado === 'RECIBIDO') {
      return await resolverCarrera(user, trasladoId, 'despacho');
    }
    throw new ConflictError(`Un traslado ${previa.estado.toLowerCase()} no se despacha.`);
  }
  if (previa.impedimentos.length > 0) {
    await registrarBloqueo(user, previa);
    throw new ValidationError(
      `Este traslado no se puede despachar. ${previa.impedimentos.join(' ')} No se escribió nada.`,
    );
  }

  const clave = claveDeDespacho(trasladoId);
  const huella = huellaDeTraslado({
    trasladoId,
    origenId: previa.origenId,
    destinoId: previa.destinoId,
    paso: 'despacho',
    renglones: previa.renglones.map((r) => ({
      lineaId: r.lineaId,
      productId: r.productId,
      unidad: r.unidad,
      cantidad: r.cantidad,
    })),
  });
  const momento = ahora();

  /* Si ya existe la operación, no se escribe: se compara y se contesta. */
  const existente = await prisma.stockOperation.findUnique({ where: { operationKey: clave } });
  if (existente) return await compararConLoGuardado(trasladoId, 'despacho', huella);

  return await prisma.$transaction(async (tx) => {
    /*
     * **Todo se revalida acá adentro.** Lo de arriba se leyó sin candado y pudo
     * cambiar entre la lectura y este momento: otro despacho, un saldo que bajó,
     * una unidad que alguien tocó.
     */
    const traslado = await tx.stockTransfer.findUniqueOrThrow({
      where: { id: trasladoId },
      include: { lines: { orderBy: { id: 'asc' } } },
    });
    if (traslado.status !== 'BORRADOR') {
      throw new ConflictError(
        'Este traslado dejó de ser un borrador mientras se despachaba. No se escribió nada.',
      );
    }
    if (traslado.lines.length !== previa.renglones.length) {
      throw new ConflictError(
        'Los renglones del traslado cambiaron mientras se despachaba. No se escribió nada: volvé a mirar la revisión.',
      );
    }

    const apertura = await tx.stockCountSession.findFirst({
      where: { branchId: traslado.fromBranchId, status: 'CONFIRMADA' },
      select: { cutoffAt: true },
    });
    if (!apertura) {
      throw new ConflictError('La sucursal de origen dejó de tener apertura confirmada.');
    }

    const operacion = await tx.stockOperation.create({
      data: {
        operationKey: clave,
        kind: 'TRASLADO',
        hashVersion: VERSION_DE_LA_HUELLA_DE_TRASLADO,
        contentHash: huella,
        branchId: traslado.fromBranchId,
        requestedById: user.id,
        receivedAt: momento,
      },
    });

    /* Candados en orden determinístico, para no abrazarse con otra transacción. */
    const productos = [...new Set(traslado.lines.map((l) => l.productId))].sort();
    for (const pid of productos) {
      await tx.$executeRaw`SELECT id FROM "stock_balance" WHERE "productId" = ${pid} AND "branchId" = ${traslado.fromBranchId} FOR UPDATE`;
    }

    let movimientos = 0;
    for (const linea of traslado.lines) {
      const cantidad = new Decimal(linea.quantity.toString());
      const saldo = await tx.stockBalance.findUnique({
        where: {
          productId_branchId: { productId: linea.productId, branchId: traslado.fromBranchId },
        },
      });
      if (!saldo) {
        throw new ConflictError(
          'Un artículo del traslado dejó de tener saldo en el origen. No se escribió nada.',
        );
      }
      const anterior = new Decimal(saldo.quantity.toString());
      if (anterior.lessThan(cantidad)) {
        /* Revalidado DENTRO: el saldo pudo bajar entre la revisión y ahora. */
        throw new ValidationError(
          `No hay saldo suficiente: quedan ${anterior.toString()} ${linea.unit} y el traslado despacha ${cantidad.toString()}. No se escribió nada.`,
        );
      }
      if (saldo.unit !== linea.unit) {
        throw new ConflictError(
          `El origen lleva este artículo en ${saldo.unit} y el renglón va en ${linea.unit}. No se convierte solo.`,
        );
      }
      const posterior = anterior.minus(cantidad);
      const producto = await tx.product.findUniqueOrThrow({
        where: { id: linea.productId },
        select: { internalCode: true },
      });

      const movId = `${operacion.id}-${linea.id}`;
      await tx.$executeRaw`
        INSERT INTO "stock_ledger"
          ("id","txId","productId","pluHistorico","branchId","type","direction",
           "quantity","unit","effectiveAt","operationId","userId","idempotencyKey",
           "balanceAfterSeq","transferLineId","reason","createdAt")
        VALUES (${movId}, txid_current(), ${linea.productId}, ${producto.internalCode},
                ${traslado.fromBranchId}, 'TRANSFER_OUT'::"StockMovementType",
                'OUT'::"StockDirection", ${cantidad.toString()}::numeric,
                ${linea.unit}::"StockUnit", ${momento}, ${operacion.id}, ${user.id},
                ${`${clave}:${linea.id}`}, ${posterior.toString()}::numeric,
                ${linea.id}, 'Traslado: salida del origen', now())`;

      await tx.stockBalance.update({
        where: { id: saldo.id },
        data: {
          quantity: posterior.toString(),
          lastLedgerId: movId,
          lastOperationId: operacion.id,
          version: { increment: 1 },
        },
      });
      /* La cantidad despachada se registra en el renglón: es un dato del negocio. */
      await tx.stockTransferLine.update({
        where: { id: linea.id },
        data: { dispatchedQuantity: cantidad.toString() },
      });
      movimientos += 1;
    }

    const resultado = {
      paso: 'despacho',
      trasladoId,
      origen: traslado.fromBranchId,
      destino: traslado.toBranchId,
      movimientos,
      momento: momento.toISOString(),
      renglones: traslado.lines.map((l) => ({
        lineaId: l.id,
        productId: l.productId,
        cantidad: l.quantity.toString(),
        unidad: l.unit,
      })),
    };
    await tx.stockOperation.update({
      where: { id: operacion.id },
      data: { movementCount: movimientos, result: resultado },
    });
    await tx.stockTransfer.update({
      where: { id: trasladoId },
      data: {
        status: 'DESPACHADO',
        operationId: operacion.id,
        dispatchedById: user.id,
        dispatchedAt: momento,
        version: { increment: 1 },
      },
    });
    await recordAudit(
      {
        userId: user.id,
        action: AUDIT_ACTIONS.STOCKERP_TRASLADO_DESPACHADO,
        entity: 'StockTransfer',
        entityId: trasladoId,
        before: { estado: 'BORRADOR' },
        after: { ...resultado, estado: 'DESPACHADO', huella, operacion: operacion.id },
      },
      tx,
    );

    return {
      ok: true as const,
      yaEstabaAplicado: false,
      trasladoId,
      estado: 'DESPACHADO' as const,
      operationId: operacion.id,
      movimientos,
      momento: momento.toISOString(),
    };
  });
}

/* ========================================================================== *
 * Recibir: la otra transacción completa
 * ========================================================================== */

export async function recibir(
  user: AuthUser,
  input: {
    trasladoId: string;
    confirmado: boolean;
    /** Lo que se contó al abrir el bulto, por renglón. Tiene que coincidir. */
    contado?: Record<string, string>;
  },
): Promise<ResultadoDeTraslado> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_TRASLADO_RECIBIR, {
    entityId: input.trasladoId,
    detalle: 'recibir un traslado',
  });
  if (!input.confirmado) {
    throw new ValidationError(
      'Falta la segunda confirmación. Recibir ingresa la mercadería al destino y cierra el traslado.',
    );
  }

  for (let intento = 1; intento <= 3; intento += 1) {
    try {
      return await aplicarRecepcion(user, input);
    } catch (e) {
      const codigo = e instanceof Prisma.PrismaClientKnownRequestError ? e.code : null;
      if (codigo === 'P2002') return await resolverCarrera(user, input.trasladoId, 'recepcion');
      const serializacion =
        e instanceof Prisma.PrismaClientUnknownRequestError &&
        /40001|could not serialize/i.test(e.message);
      if (serializacion && intento < 3) continue;
      throw e;
    }
  }
  throw new ConflictError('La recepción no se pudo aplicar después de tres intentos.');
}

async function aplicarRecepcion(
  user: AuthUser,
  input: { trasladoId: string; contado?: Record<string, string> },
): Promise<ResultadoDeTraslado> {
  const trasladoId = input.trasladoId;
  const previa = await detalleDeTraslado(user, trasladoId);

  if (previa.estado === 'RECIBIDO') {
    /* Ya llegó. No se recibe dos veces. */
    return await compararConLoGuardado(trasladoId, 'recepcion', null);
  }
  if (previa.estado !== 'DESPACHADO') {
    throw new ConflictError(
      `Sólo se recibe un traslado despachado, y éste está ${previa.estado.toLowerCase()}. La mercadería tiene que haber salido del origen antes de poder llegar.`,
    );
  }

  /*
   * **La recepción es EXACTA.**
   *
   * Si lo contado no coincide con lo despachado, no se confirma nada: el
   * traslado se queda en tránsito. No se ajusta en silencio, no se inventa una
   * merma y no se fuerza el cierre; la diferencia se resolverá con el flujo de
   * incidencias que todavía no existe. Un movimiento compensatorio a medias
   * dejaría dos sucursales con saldos que nadie puede explicar.
   */
  const diferencias: string[] = [];
  for (const r of previa.renglones) {
    const despachada = r.dispatchedQuantity;
    if (despachada === null) {
      throw new ConflictError(
        'Un renglón despachado quedó sin cantidad despachada. No se recibe: hay que revisar el traslado.',
      );
    }
    const contado = input.contado?.[r.lineaId];
    if (contado === undefined || contado === null || contado.toString().trim() === '') continue;
    const cuenta = cantidadValida(contado);
    if (!cuenta.equals(new Decimal(despachada))) {
      diferencias.push(
        `${r.articulo} (PLU ${r.plu}): salieron ${despachada} ${r.unidad} y se contaron ${cuenta.toString()}`,
      );
    }
  }
  if (diferencias.length > 0) {
    await recordAudit({
      userId: user.id,
      action: AUDIT_ACTIONS.STOCKERP_TRASLADO_DIFERENCIA,
      entity: 'StockTransfer',
      entityId: trasladoId,
      after: {
        estado: 'DESPACHADO',
        diferencias,
        detalle: 'la recepción no se confirmó: el traslado sigue en tránsito',
      },
    });
    throw new ValidationError(
      `Lo que llegó no coincide con lo que salió, así que la recepción no se confirma y el traslado SIGUE EN TRÁNSITO: ${diferencias.join('; ')}. ` +
        'Esta fase no resuelve diferencias físicas: no se ajusta nada, no se registra una merma y no se cierra a la fuerza. ' +
        'La diferencia se resolverá con el flujo de incidencias, mermas o devolución, que todavía no existe.',
    );
  }

  const clave = claveDeRecepcionDeTraslado(trasladoId);
  const huella = huellaDeTraslado({
    trasladoId,
    origenId: previa.origenId,
    destinoId: previa.destinoId,
    paso: 'recepcion',
    renglones: previa.renglones.map((r) => ({
      lineaId: r.lineaId,
      productId: r.productId,
      unidad: r.unidad,
      cantidad: r.dispatchedQuantity!,
    })),
  });
  const momento = ahora();

  const existente = await prisma.stockOperation.findUnique({ where: { operationKey: clave } });
  if (existente) return await compararConLoGuardado(trasladoId, 'recepcion', huella);

  return await prisma.$transaction(async (tx) => {
    const traslado = await tx.stockTransfer.findUniqueOrThrow({
      where: { id: trasladoId },
      include: { lines: { orderBy: { id: 'asc' } } },
    });
    if (traslado.status !== 'DESPACHADO') {
      throw new ConflictError(
        'Este traslado cambió de estado mientras se recibía. No se escribió nada.',
      );
    }

    const apertura = await tx.stockCountSession.findFirst({
      where: { branchId: traslado.toBranchId, status: 'CONFIRMADA' },
      select: { cutoffAt: true },
    });
    if (!apertura) {
      throw new ConflictError(
        'La sucursal de destino no tiene apertura confirmada. No se escribió nada.',
      );
    }

    const operacion = await tx.stockOperation.create({
      data: {
        operationKey: clave,
        kind: 'TRASLADO',
        hashVersion: VERSION_DE_LA_HUELLA_DE_TRASLADO,
        contentHash: huella,
        branchId: traslado.toBranchId,
        requestedById: user.id,
        receivedAt: momento,
      },
    });

    const productos = [...new Set(traslado.lines.map((l) => l.productId))].sort();
    for (const pid of productos) {
      await tx.$executeRaw`SELECT id FROM "stock_balance" WHERE "productId" = ${pid} AND "branchId" = ${traslado.toBranchId} FOR UPDATE`;
    }

    let movimientos = 0;
    for (const linea of traslado.lines) {
      if (linea.dispatchedQuantity === null) {
        throw new ConflictError('Un renglón despachado quedó sin cantidad despachada.');
      }
      const cantidad = new Decimal(linea.dispatchedQuantity.toString());

      /* La activación del destino se revalida ACÁ, no sólo en la revisión. */
      const activacion = await tx.productStockActivation.findUnique({
        where: {
          productId_branchId: { productId: linea.productId, branchId: traslado.toBranchId },
        },
      });
      if (activacion?.state === 'NO_SE_MANEJA' || activacion?.state === 'PENDIENTE_CONFIGURACION') {
        throw new ValidationError(
          `El destino dejó de aceptar este artículo (${activacion.state}). No se escribió nada.`,
        );
      }

      const saldo = await tx.stockBalance.findUnique({
        where: {
          productId_branchId: { productId: linea.productId, branchId: traslado.toBranchId },
        },
      });
      if (saldo && saldo.unit !== linea.unit) {
        throw new ConflictError(
          `El destino lleva este artículo en ${saldo.unit} y el traslado va en ${linea.unit}: no se suman unidades incompatibles.`,
        );
      }
      const anterior = saldo ? new Decimal(saldo.quantity.toString()) : new Decimal(0);
      const posterior = anterior.plus(cantidad);
      const producto = await tx.product.findUniqueOrThrow({
        where: { id: linea.productId },
        select: { internalCode: true },
      });

      const movId = `${operacion.id}-${linea.id}`;
      await tx.$executeRaw`
        INSERT INTO "stock_ledger"
          ("id","txId","productId","pluHistorico","branchId","type","direction",
           "quantity","unit","effectiveAt","operationId","userId","idempotencyKey",
           "balanceAfterSeq","transferLineId","reason","createdAt")
        VALUES (${movId}, txid_current(), ${linea.productId}, ${producto.internalCode},
                ${traslado.toBranchId}, 'TRANSFER_IN'::"StockMovementType",
                'IN'::"StockDirection", ${cantidad.toString()}::numeric,
                ${linea.unit}::"StockUnit", ${momento}, ${operacion.id}, ${user.id},
                ${`${clave}:${linea.id}`}, ${posterior.toString()}::numeric,
                ${linea.id}, 'Traslado: entrada al destino', now())`;

      if (saldo) {
        await tx.stockBalance.update({
          where: { id: saldo.id },
          data: {
            quantity: posterior.toString(),
            lastLedgerId: movId,
            lastOperationId: operacion.id,
            version: { increment: 1 },
          },
        });
      } else {
        /*
         * El artículo no tenía saldo en el destino: nace acá, y se marca como
         * POSTERIOR_AL_CORTE, igual que en la recepción de compras. Nadie lo
         * contó en la apertura del destino, y mezclarlo con los que sí se
         * contaron borraría la diferencia entre «se contó» y «llegó después».
         */
        await tx.stockBalance.create({
          data: {
            productId: linea.productId,
            branchId: traslado.toBranchId,
            quantity: posterior.toString(),
            unit: linea.unit,
            lastLedgerId: movId,
            lastOperationId: operacion.id,
            openingSource: 'POSTERIOR_AL_CORTE',
          },
        });
      }

      /*
       * Y si el destino no lo manejaba todavía, la recepción lo activa. No se le
       * toca el corte ni la apertura: sólo pasa a ACTIVO, que es lo que dice que
       * la sucursal ahora lo maneja.
       */
      if (!activacion) {
        await tx.productStockActivation.create({
          data: {
            productId: linea.productId,
            branchId: traslado.toBranchId,
            state: 'ACTIVO',
            activatedById: user.id,
            activatedAt: momento,
          },
        });
      } else if (activacion.state === 'SIN_INICIAR' || activacion.state === 'LISTO_PARA_CONTAR') {
        await tx.productStockActivation.update({
          where: { id: activacion.id },
          data: { state: 'ACTIVO', activatedById: user.id, activatedAt: momento },
        });
      }

      await tx.stockTransferLine.update({
        where: { id: linea.id },
        data: { receivedQuantity: cantidad.toString() },
      });
      movimientos += 1;
    }

    const resultado = {
      paso: 'recepcion',
      trasladoId,
      origen: traslado.fromBranchId,
      destino: traslado.toBranchId,
      movimientos,
      momento: momento.toISOString(),
      renglones: traslado.lines.map((l) => ({
        lineaId: l.id,
        productId: l.productId,
        cantidad: l.dispatchedQuantity?.toString() ?? null,
        unidad: l.unit,
      })),
    };
    await tx.stockOperation.update({
      where: { id: operacion.id },
      data: { movementCount: movimientos, result: resultado },
    });
    await tx.stockTransfer.update({
      where: { id: trasladoId },
      data: {
        status: 'RECIBIDO',
        receiptOperationId: operacion.id,
        receivedById: user.id,
        receivedAt: momento,
        version: { increment: 1 },
      },
    });
    await recordAudit(
      {
        userId: user.id,
        action: AUDIT_ACTIONS.STOCKERP_TRASLADO_RECIBIDO,
        entity: 'StockTransfer',
        entityId: trasladoId,
        before: { estado: 'DESPACHADO' },
        after: { ...resultado, estado: 'RECIBIDO', huella, operacion: operacion.id },
      },
      tx,
    );

    return {
      ok: true as const,
      yaEstabaAplicado: false,
      trasladoId,
      estado: 'RECIBIDO' as const,
      operationId: operacion.id,
      movimientos,
      momento: momento.toISOString(),
    };
  });
}

/* ========================================================================== *
 * Idempotencia: comparar lo guardado, no suponerlo
 * ========================================================================== */

/**
 * Relee la operación persistida y compara versión y huella.
 *
 * **Una violación de unicidad no demuestra idempotencia por sí sola**: sólo dice
 * que hubo un choque. Puede haber chocado con el mismo contenido —y entonces ya
 * estaba aplicado— o con otro, y entonces es un conflicto que hay que nombrar.
 */
async function compararConLoGuardado(
  trasladoId: string,
  paso: 'despacho' | 'recepcion',
  huellaEsperada: string | null,
): Promise<ResultadoDeTraslado> {
  const clave = paso === 'despacho' ? claveDeDespacho(trasladoId) : claveDeRecepcionDeTraslado(trasladoId);
  const op = await prisma.stockOperation.findUnique({ where: { operationKey: clave } });
  const traslado = await prisma.stockTransfer.findUnique({ where: { id: trasladoId } });
  if (!op || !traslado) {
    throw new ConflictError(
      'El traslado cambió mientras se confirmaba y no se pudo releer lo aplicado. No se escribió nada.',
    );
  }

  const mismaHuella =
    huellaEsperada === null ||
    (op.hashVersion === VERSION_DE_LA_HUELLA_DE_TRASLADO && op.contentHash === huellaEsperada);

  if (mismaHuella) {
    return {
      ok: true,
      yaEstabaAplicado: true,
      trasladoId,
      estado: traslado.status as EstadoDeTraslado,
      operationId: op.id,
      movimientos: op.movementCount,
      momento: (op.receivedAt ?? op.appliedAt).toISOString(),
    };
  }

  throw new ConflictError(
    `Este traslado ya tiene un ${paso} registrado (${formatCorteAr(op.receivedAt ?? op.appliedAt)}) ` +
      'con un contenido distinto del que estás confirmando. No se escribió nada: volvé a abrir el traslado para ver cómo quedó.',
  );
}

/**
 * Dos despachos —o dos recepciones— a la vez: uno ganó y el otro chocó.
 *
 * Se relee en una transacción NUEVA, porque la anterior abortó, y se audita que
 * hubo una carrera: sin eso, el segundo usuario ve «ya estaba aplicado» y nadie
 * sabe que fueron dos.
 */
async function resolverCarrera(
  user: AuthUser,
  trasladoId: string,
  paso: 'despacho' | 'recepcion',
): Promise<ResultadoDeTraslado> {
  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.STOCKERP_TRASLADO_SIMULTANEO,
    entity: 'StockTransfer',
    entityId: trasladoId,
    after: { paso, detalle: 'dos confirmaciones al mismo tiempo: una aplicó, la otra no' },
  });
  return await compararConLoGuardado(trasladoId, paso, null);
}

async function registrarBloqueo(user: AuthUser, previa: TrasladoDetalle): Promise<void> {
  const porSaldo = previa.renglones.some((r) => r.motivo?.includes('se quieren despachar'));
  const porUnidad = previa.renglones.some(
    (r) => r.motivo?.includes('unidad') || r.motivo?.includes('maneja'),
  );
  if (porSaldo) {
    await recordAudit({
      userId: user.id,
      action: AUDIT_ACTIONS.STOCKERP_TRASLADO_BLOQUEADO_SALDO,
      entity: 'StockTransfer',
      entityId: previa.id,
      after: {
        origen: previa.origenId,
        destino: previa.destinoId,
        impedimentos: previa.impedimentos,
      },
    });
  }
  if (porUnidad) {
    await recordAudit({
      userId: user.id,
      action: AUDIT_ACTIONS.STOCKERP_BLOQUEADO_UNIDAD,
      entity: 'StockTransfer',
      entityId: previa.id,
      after: { impedimentos: previa.impedimentos },
    });
  }
  if (!previa.interruptorEncendido && !previa.ficticio) {
    await recordAudit({
      userId: user.id,
      action: AUDIT_ACTIONS.STOCKERP_BLOQUEADO_INTERRUPTOR,
      entity: 'StockTransfer',
      entityId: previa.id,
      after: { motivo: 'El interruptor de traslados reales está apagado.' },
    });
  }
}

/* ========================================================================== *
 * Listado y mercadería en tránsito
 * ========================================================================== */

export interface FilaDeTraslado {
  id: string;
  estado: string;
  origen: string;
  destino: string;
  renglones: number;
  creadoEl: Date;
  despachadoEl: Date | null;
  recibidoEl: Date | null;
}

export interface ListadoDeTraslados {
  borradores: FilaDeTraslado[];
  enTransito: FilaDeTraslado[];
  cerrados: FilaDeTraslado[];
  cancelados: FilaDeTraslado[];
}

export async function listadoDeTraslados(
  user: AuthUser,
  filtros: { sucursalId?: string | null } = {},
): Promise<ListadoDeTraslados> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_VER, { detalle: 'ver el listado de traslados' });

  const where: Prisma.StockTransferWhereInput = filtros.sucursalId
    ? {
        OR: [{ fromBranchId: filtros.sucursalId }, { toBranchId: filtros.sucursalId }],
      }
    : {};

  const filas = await prisma.stockTransfer.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: {
      fromBranch: { select: { name: true } },
      toBranch: { select: { name: true } },
      _count: { select: { lines: true } },
    },
  });

  const mapear = (f: (typeof filas)[number]): FilaDeTraslado => ({
    id: f.id,
    estado: f.status,
    origen: f.fromBranch.name,
    destino: f.toBranch.name,
    renglones: f._count.lines,
    creadoEl: f.createdAt,
    despachadoEl: f.dispatchedAt,
    recibidoEl: f.receivedAt,
  });

  return {
    borradores: filas.filter((f) => f.status === 'BORRADOR').map(mapear),
    enTransito: filas.filter((f) => f.status === 'DESPACHADO').map(mapear),
    cerrados: filas.filter((f) => f.status === 'RECIBIDO' || f.status === 'APLICADO').map(mapear),
    cancelados: filas
      .filter((f) => f.status === 'CANCELADO' || f.status === 'REVERSADO')
      .map(mapear),
  };
}

export interface EnTransito {
  productId: string;
  articulo: string;
  plu: string;
  cantidad: string;
  unidad: StockUnit;
  origen: string;
  destino: string;
  trasladoId: string;
  despachadoEl: Date | null;
}

/**
 * La mercadería que salió y todavía no llegó.
 *
 * **No es saldo de nadie.** Ya no está en el origen —el despacho la descontó— y
 * todavía no está en el destino. Las consultas la muestran aparte del saldo
 * disponible a propósito: sumarla al destino diría que hay mercadería en una
 * góndola donde no hay nada.
 */
export async function mercaderiaEnTransito(filtros: {
  destinoId?: string | null;
  origenId?: string | null;
}): Promise<EnTransito[]> {
  const lineas = await prisma.stockTransferLine.findMany({
    where: {
      transfer: {
        status: 'DESPACHADO',
        ...(filtros.destinoId ? { toBranchId: filtros.destinoId } : {}),
        ...(filtros.origenId ? { fromBranchId: filtros.origenId } : {}),
      },
    },
    include: {
      transfer: {
        select: {
          id: true,
          dispatchedAt: true,
          fromBranch: { select: { name: true } },
          toBranch: { select: { name: true } },
        },
      },
      product: { select: { normalizedName: true, internalCode: true } },
    },
    orderBy: { id: 'asc' },
  });

  return lineas.map((l) => ({
    productId: l.productId,
    articulo: l.product.normalizedName,
    plu: l.product.internalCode,
    cantidad: (l.dispatchedQuantity ?? l.quantity).toString(),
    unidad: l.unit,
    origen: l.transfer.fromBranch.name,
    destino: l.transfer.toBranch.name,
    trasladoId: l.transfer.id,
    despachadoEl: l.transfer.dispatchedAt,
  }));
}
