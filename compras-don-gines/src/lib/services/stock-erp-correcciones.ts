import 'server-only';
import { createHash } from 'node:crypto';
import { Prisma, type StockUnit, type StockWasteCategory } from '@prisma/client';
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
 * **Correcciones operativas: merma, recuento correctivo y reversión.**
 *
 * Tres conceptos distintos, y ninguna entrada manual genérica. No existe «sumar
 * o restar a mano»: cada corrección tiene una forma, una causa y una explicación
 * de por qué el número cambió.
 *
 *   * **Merma.** Se conoce la causa de la pérdida. Cantidad POSITIVA que sale,
 *     con categoría y motivo escrito.
 *   * **Recuento correctivo.** La persona escribe la cantidad FÍSICA que contó,
 *     nunca una diferencia. El servidor bloquea el saldo, lo relee, calcula el
 *     delta y asienta sólo esa diferencia. Si coincide, no hay movimiento: un
 *     asiento de cero es ruido que después alguien tiene que explicar.
 *   * **Reversión.** Agrega asientos inversos. **Nunca** borra ni edita el libro.
 *
 * QUÉ ES REVERSIBLE EN ESTA FASE, y punto: las mermas y los ajustes de recuento
 * que esta fase creó, y el despacho de un traslado que todavía está en tránsito.
 * No una apertura, no una recepción de compra, no un traslado ya recibido, no una
 * reversión, no una operación ya revertida. La base lo hace cumplir con
 * `stock_reversion_elegible`, así que no depende de que este archivo se acuerde.
 */

export const VERSION_DE_LA_HUELLA_DE_CORRECCION = 1;

/** Las categorías, con su etiqueta para la pantalla. */
export const CATEGORIAS_DE_MERMA: { valor: StockWasteCategory; etiqueta: string }[] = [
  { valor: 'VENCIMIENTO', etiqueta: 'Vencimiento' },
  { valor: 'ROTURA', etiqueta: 'Rotura' },
  { valor: 'DETERIORO_O_FRIO', etiqueta: 'Deterioro o cadena de frío' },
  { valor: 'ELABORACION_O_RECORTE', etiqueta: 'Elaboración o recorte' },
  { valor: 'CONSUMO_INTERNO', etiqueta: 'Consumo interno' },
  { valor: 'FALTANTE', etiqueta: 'Faltante' },
  { valor: 'ERROR_OPERATIVO', etiqueta: 'Error operativo' },
  { valor: 'OTRO', etiqueta: 'Otro (exige detalle)' },
];

/**
 * El consumo interno no es una pérdida: es mercadería que la casa usó.
 *
 * Por eso va al libro como `INTERNAL_USE_OUT` y no como `WASTE_OUT`. Los dos
 * tipos existían desde la fase 1 sin usarse, y mezclarlos haría que el día que
 * alguien mida «cuánto se pierde» cuente como pérdida lo que se comió el
 * personal.
 */
function tipoDeMovimientoDe(categoria: StockWasteCategory): 'WASTE_OUT' | 'INTERNAL_USE_OUT' {
  return categoria === 'CONSUMO_INTERNO' ? 'INTERNAL_USE_OUT' : 'WASTE_OUT';
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
 * El interruptor de correcciones reales
 * ========================================================================== */

export async function interruptorDeCorreccionesReales(): Promise<{
  encendido: boolean;
  cambiadoPor: string | null;
  cambiadoEl: Date | null;
  motivo: string | null;
}> {
  const fila = await prisma.stockModuleSetting.findFirst({
    include: { correctionsChangedBy: { select: { name: true } } },
  });
  return {
    encendido: fila?.realCorrectionsEnabled ?? false,
    cambiadoPor: fila?.correctionsChangedBy?.name ?? null,
    cambiadoEl: fila?.correctionsChangedAt ?? null,
    motivo: fila?.correctionsReason ?? null,
  };
}

export async function cambiarInterruptorDeCorrecciones(
  user: AuthUser,
  input: { encender: boolean; motivo: string },
): Promise<{ encendido: boolean }> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_MODULO_CONFIGURAR, {
    entity: 'StockModuleSetting',
    detalle: 'cambiar el interruptor de correcciones reales',
  });
  const motivo = input.motivo?.trim();
  if (!motivo) {
    throw new ValidationError(
      'Cambiar el interruptor de correcciones reales exige escribir por qué. Queda auditado con tu nombre.',
    );
  }
  const fila = await prisma.stockModuleSetting.findFirst();
  if (!fila) throw new NotFoundError('No existe la fila de configuración de Stock ERP.');

  /* El valor anterior se lee de la BASE, no de lo que mande el navegador. */
  const antes = fila.realCorrectionsEnabled;
  await prisma.stockModuleSetting.update({
    where: { id: fila.id },
    data: {
      realCorrectionsEnabled: input.encender,
      correctionsChangedById: user.id,
      correctionsChangedAt: ahora(),
      correctionsReason: motivo,
    },
  });
  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.STOCKERP_CORRECCIONES_INTERRUPTOR,
    entity: 'StockModuleSetting',
    entityId: fila.id,
    before: { realCorrectionsEnabled: antes },
    after: { realCorrectionsEnabled: input.encender, motivo },
    reason: motivo,
  });
  return { encendido: input.encender };
}

/* ========================================================================== *
 * Cantidades
 * ========================================================================== */

/** Tres decimales, como el libro. Nunca `Number`. */
export function cantidadValida(texto: string, opciones: { ceroVale?: boolean } = {}): Decimal {
  const limpio = (texto ?? '').toString().trim().replace(',', '.');
  if (limpio === '') throw new ValidationError('Falta la cantidad.');
  let valor: Decimal;
  try {
    valor = new Decimal(limpio);
  } catch {
    throw new ValidationError(`«${texto}» no es una cantidad.`);
  }
  if (!valor.isFinite()) throw new ValidationError(`«${texto}» no es una cantidad.`);
  if (valor.isNegative()) {
    throw new ValidationError(
      'La cantidad no puede ser negativa. Una merma se registra en positivo: lo que sale es la cantidad perdida, no un número con signo.',
    );
  }
  if (valor.isZero() && !opciones.ceroVale) {
    throw new ValidationError(
      'La cantidad tiene que ser mayor que cero: una merma de cero no perdió nada.',
    );
  }
  if (valor.decimalPlaces() > 3) {
    throw new ValidationError(
      `La cantidad admite hasta tres decimales y «${texto}» tiene ${valor.decimalPlaces()}. El libro guarda tres.`,
    );
  }
  if (valor.greaterThan(1_000_000)) {
    throw new ValidationError('La cantidad excede el máximo de 1.000.000.');
  }
  return valor;
}

/* ========================================================================== *
 * El contexto común: apertura, unidad, activación e interruptor
 * ========================================================================== */

interface Contexto {
  unidad: StockUnit;
  saldo: Decimal | null;
  corte: Date;
  ficticia: boolean;
  interruptorEncendido: boolean;
  impedimentos: string[];
  articulo: string;
  plu: string;
  sucursal: string;
}

/**
 * Todo lo que hay que saber antes de tocar el saldo de un artículo.
 *
 * Se calcula FUERA de la transacción para poder mostrarlo, y todo lo que importa
 * se revalida ADENTRO: entre mirar y escribir puede pasar cualquier cosa.
 */
async function contextoDe(
  branchId: string,
  productId: string,
  unidadDelPedido?: StockUnit,
): Promise<Contexto> {
  const [sucursal, producto, apertura, activacion, saldo, interruptor] = await Promise.all([
    prisma.branch.findUnique({ where: { id: branchId }, select: { name: true } }),
    prisma.product.findUnique({
      where: { id: productId },
      select: {
        normalizedName: true,
        internalCode: true,
        active: true,
        stockConfig: { select: { status: true, stockUnit: true } },
      },
    }),
    prisma.stockCountSession.findFirst({
      where: { branchId, kind: 'APERTURA', status: 'CONFIRMADA' },
      select: { cutoffAt: true, ficticia: true },
    }),
    prisma.productStockActivation.findUnique({
      where: { productId_branchId: { productId, branchId } },
    }),
    prisma.stockBalance.findUnique({
      where: { productId_branchId: { productId, branchId } },
    }),
    interruptorDeCorreccionesReales(),
  ]);

  if (!sucursal) throw new NotFoundError('Esa sucursal no existe.');
  if (!producto) throw new NotFoundError('Ese artículo no existe.');

  const impedimentos: string[] = [];
  if (!producto.active) impedimentos.push('El artículo está dado de baja del catálogo.');

  const cfg = producto.stockConfig;
  if (!cfg || cfg.status !== 'APROBADA' || !cfg.stockUnit) {
    impedimentos.push(
      `«${producto.normalizedName}» no tiene unidad de existencia aprobada: nadie decidió todavía si se cuenta en kilos o en unidades. Se aprueba en Stock ERP → Unidades.`,
    );
  }
  const unidad = (cfg?.stockUnit ?? 'KG') as StockUnit;
  if (unidadDelPedido && cfg?.stockUnit && unidadDelPedido !== cfg.stockUnit) {
    impedimentos.push(
      `El pedido viene en ${unidadDelPedido} y la unidad aprobada es ${cfg.stockUnit}: no se convierte solo ni se reinterpreta.`,
    );
  }

  if (!apertura?.cutoffAt) {
    impedimentos.push(
      `${sucursal.name} no tiene apertura confirmada de Stock ERP. Sin apertura no hay saldo que corregir: sus artículos no están en cero, están sin contar.`,
    );
  }
  if (activacion?.state === 'NO_SE_MANEJA') {
    impedimentos.push(`${sucursal.name} no maneja este artículo.`);
  }
  if (activacion?.state === 'PENDIENTE_CONFIGURACION') {
    impedimentos.push(`En ${sucursal.name} el artículo está pendiente de configuración.`);
  }
  if (saldo && saldo.unit !== unidad) {
    impedimentos.push(
      `El saldo de ${sucursal.name} está en ${saldo.unit} y la unidad aprobada es ${unidad}: no se suman unidades incompatibles.`,
    );
  }

  const ficticia = apertura?.ficticia ?? false;
  if (apertura && !ficticia && !interruptor.encendido) {
    impedimentos.push(
      'El interruptor de correcciones reales está apagado. Una merma o un ajuste cambian un inventario real sin ningún comprobante detrás, y las ventas todavía no descuentan.',
    );
  }
  if (ficticia && !esUnaBaseDePruebas(process.env.DATABASE_URL)) {
    impedimentos.push(
      'La apertura de la sucursal es ficticia y ésta no es una base de pruebas: una corrección sobre un inventario inventado no se aplica acá.',
    );
  }

  return {
    unidad,
    saldo: saldo ? new Decimal(saldo.quantity.toString()) : null,
    corte: apertura?.cutoffAt ?? new Date(0),
    ficticia,
    interruptorEncendido: interruptor.encendido,
    impedimentos,
    articulo: producto.normalizedName,
    plu: producto.internalCode,
    sucursal: sucursal.name,
  };
}

/* ========================================================================== *
 * La merma
 * ========================================================================== */

export interface VistaPreviaDeMerma {
  branchId: string;
  sucursal: string;
  productId: string;
  articulo: string;
  plu: string;
  cantidad: string;
  unidad: StockUnit;
  categoria: StockWasteCategory;
  motivo: string;
  detalle: string | null;
  saldoAnterior: string | null;
  saldoResultante: string | null;
  impedimentos: string[];
  ficticia: boolean;
  interruptorEncendido: boolean;
}

export interface MermaInput {
  /**
   * Identificador de la merma, generado por quien la prepara.
   *
   * Es lo que hace que la clave idempotente exista ANTES de escribir: dos clics
   * mandan el mismo `mermaId` y la segunda llamada encuentra la operación ya
   * aplicada en vez de registrar dos pérdidas iguales.
   */
  mermaId: string;
  branchId: string;
  productId: string;
  cantidad: string;
  categoria: StockWasteCategory;
  motivo: string;
  detalle?: string | null;
  confirmado?: boolean;
}

export function claveDeMerma(mermaId: string): string {
  return `merma:${mermaId}`;
}

/**
 * La huella de la merma. **Sin reloj**: dos intentos del mismo registro tienen
 * que dar la misma huella aunque pasen minutos entre uno y otro.
 */
export function huellaDeMerma(datos: {
  mermaId: string;
  branchId: string;
  productId: string;
  cantidad: string;
  unidad: StockUnit;
  categoria: StockWasteCategory;
  motivo: string;
  detalle: string | null;
}): string {
  const texto = [
    `v${VERSION_DE_LA_HUELLA_DE_CORRECCION}`,
    'tipo:MERMA',
    `merma:${datos.mermaId}`,
    `sucursal:${datos.branchId}`,
    `articulo:${datos.productId}`,
    /* Canónica a tres decimales: «3» y «3.000» son la misma cantidad. */
    `cantidad:${new Decimal(datos.cantidad).toDecimalPlaces(3).toString()}`,
    `unidad:${datos.unidad}`,
    `categoria:${datos.categoria}`,
    `motivo:${datos.motivo.trim()}`,
    `detalle:${datos.detalle?.trim() ?? 'sin-detalle'}`,
  ].join('\n');
  return createHash('sha256').update(texto).digest('hex');
}

/** Valida la forma de la merma y devuelve lo normalizado. No escribe nada. */
function revisarMerma(input: MermaInput) {
  const cantidad = cantidadValida(input.cantidad);
  const motivo = (input.motivo ?? '').trim();
  if (motivo.length < 3) {
    throw new ValidationError(
      'Una merma exige motivo escrito. Un saldo que baja sin explicación es indistinguible de un faltante no declarado.',
    );
  }
  const detalle = (input.detalle ?? '').trim() || null;
  if (input.categoria === 'OTRO' && (detalle === null || detalle.length < 3)) {
    throw new ValidationError(
      'La categoría «Otro» exige detalle escrito: una categoría que explica todo no explica nada.',
    );
  }
  if (!CATEGORIAS_DE_MERMA.some((c) => c.valor === input.categoria)) {
    throw new ValidationError('Esa categoría de merma no existe.');
  }
  return { cantidad, motivo, detalle };
}

export async function vistaPreviaDeMerma(
  user: AuthUser,
  input: MermaInput,
): Promise<VistaPreviaDeMerma> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_VER, {
    entity: 'StockWaste',
    detalle: 'mirar la vista previa de una merma',
  });
  const { cantidad, motivo, detalle } = revisarMerma(input);
  const ctx = await contextoDe(input.branchId, input.productId);

  const impedimentos = [...ctx.impedimentos];
  if (ctx.saldo === null) {
    impedimentos.push(
      `No hay saldo de este artículo en ${ctx.sucursal}: nunca se contó ni entró, así que no hay nada que dar de baja.`,
    );
  } else if (ctx.saldo.lessThan(cantidad)) {
    impedimentos.push(
      `Hay ${ctx.saldo.toString()} ${ctx.unidad} y la merma sería de ${cantidad.toString()}: el saldo no puede quedar negativo.`,
    );
  }

  return {
    branchId: input.branchId,
    sucursal: ctx.sucursal,
    productId: input.productId,
    articulo: ctx.articulo,
    plu: ctx.plu,
    cantidad: cantidad.toString(),
    unidad: ctx.unidad,
    categoria: input.categoria,
    motivo,
    detalle,
    saldoAnterior: ctx.saldo?.toString() ?? null,
    saldoResultante:
      ctx.saldo !== null && ctx.saldo.greaterThanOrEqualTo(cantidad)
        ? ctx.saldo.minus(cantidad).toString()
        : null,
    impedimentos,
    ficticia: ctx.ficticia,
    interruptorEncendido: ctx.interruptorEncendido,
  };
}

export interface ResultadoDeCorreccion {
  ok: true;
  yaEstabaAplicada: boolean;
  operationId: string;
  movimientos: number;
  momento: string;
  /** El saldo que quedó, para poder mostrarlo sin volver a consultar. */
  saldoResultante: string | null;
}

export async function registrarMerma(
  user: AuthUser,
  input: MermaInput,
): Promise<ResultadoDeCorreccion> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_MERMA, {
    entity: 'StockWaste',
    entityId: input.mermaId,
    detalle: 'registrar una merma',
  });
  if (!input.confirmado) {
    throw new ValidationError(
      'Falta la segunda confirmación. Registrar una merma baja el saldo y escribe el libro: no se deshace.',
    );
  }
  const { cantidad, motivo, detalle } = revisarMerma(input);

  for (let intento = 1; intento <= 3; intento += 1) {
    try {
      return await aplicarMerma(user, input, { cantidad, motivo, detalle });
    } catch (e) {
      const codigo = e instanceof Prisma.PrismaClientKnownRequestError ? e.code : null;
      if (codigo === 'P2002') return await releerMerma(user, input.mermaId, null);
      const serializacion =
        e instanceof Prisma.PrismaClientUnknownRequestError &&
        /40001|could not serialize/i.test(e.message);
      if (serializacion && intento < 3) continue;
      throw e;
    }
  }
  throw new ConflictError('La merma no se pudo registrar después de tres intentos.');
}

async function aplicarMerma(
  user: AuthUser,
  input: MermaInput,
  limpio: { cantidad: Decimal; motivo: string; detalle: string | null },
): Promise<ResultadoDeCorreccion> {
  const previa = await vistaPreviaDeMerma(user, input);
  if (previa.impedimentos.length > 0) {
    if (previa.impedimentos.some((m) => m.includes('no puede quedar negativo') || m.includes('no hay nada que dar de baja'))) {
      await recordAudit({
        userId: user.id,
        action: AUDIT_ACTIONS.STOCKERP_CORRECCION_SIN_SALDO,
        entity: 'StockWaste',
        entityId: input.mermaId,
        after: {
          sucursal: input.branchId,
          articulo: input.productId,
          cantidad: limpio.cantidad.toString(),
          impedimentos: previa.impedimentos,
        },
      });
    }
    throw new ValidationError(
      `Esta merma no se puede registrar. ${previa.impedimentos.join(' ')} No se escribió nada.`,
    );
  }

  const clave = claveDeMerma(input.mermaId);
  const huella = huellaDeMerma({
    mermaId: input.mermaId,
    branchId: input.branchId,
    productId: input.productId,
    cantidad: limpio.cantidad.toString(),
    unidad: previa.unidad,
    categoria: input.categoria,
    motivo: limpio.motivo,
    detalle: limpio.detalle,
  });
  const momento = ahora();

  const existente = await prisma.stockOperation.findUnique({ where: { operationKey: clave } });
  if (existente) return await releerMerma(user, input.mermaId, huella);

  return await prisma.$transaction(async (tx) => {
    /* Candado sobre el saldo, y recién después se lee. */
    await tx.$executeRaw`
      SELECT id FROM "stock_balance"
       WHERE "productId" = ${input.productId} AND "branchId" = ${input.branchId} FOR UPDATE`;

    const saldo = await tx.stockBalance.findUnique({
      where: {
        productId_branchId: { productId: input.productId, branchId: input.branchId },
      },
    });
    if (!saldo) {
      throw new ConflictError(
        'El artículo dejó de tener saldo en esta sucursal. No se escribió nada.',
      );
    }
    if (saldo.unit !== previa.unidad) {
      throw new ConflictError(
        `El saldo está en ${saldo.unit} y la unidad aprobada es ${previa.unidad}. No se convierte solo.`,
      );
    }
    const anterior = new Decimal(saldo.quantity.toString());
    if (anterior.lessThan(limpio.cantidad)) {
      /* Revalidado DENTRO: el saldo pudo bajar entre la vista previa y ahora. */
      throw new ValidationError(
        `No hay saldo suficiente: quedan ${anterior.toString()} ${previa.unidad} y la merma es de ${limpio.cantidad.toString()}. No se escribió nada.`,
      );
    }
    const posterior = anterior.minus(limpio.cantidad);

    const operacion = await tx.stockOperation.create({
      data: {
        operationKey: clave,
        kind: 'AJUSTE',
        hashVersion: VERSION_DE_LA_HUELLA_DE_CORRECCION,
        contentHash: huella,
        branchId: input.branchId,
        requestedById: user.id,
        receivedAt: momento,
        movementCount: 1,
      },
    });

    const tipo = tipoDeMovimientoDe(input.categoria);
    const movId = `${operacion.id}-merma`;
    await tx.$executeRaw`
      INSERT INTO "stock_ledger"
        ("id","txId","productId","pluHistorico","branchId","type","direction",
         "quantity","unit","effectiveAt","operationId","userId","idempotencyKey",
         "balanceAfterSeq","reason","notes","createdAt")
      VALUES (${movId}, txid_current(), ${input.productId}, ${previa.plu}, ${input.branchId},
              ${tipo}::"StockMovementType", 'OUT'::"StockDirection",
              ${limpio.cantidad.toString()}::numeric, ${previa.unidad}::"StockUnit",
              ${momento}, ${operacion.id}, ${user.id}, ${`${clave}:1`},
              ${posterior.toString()}::numeric,
              ${`Merma (${input.categoria}): ${limpio.motivo}`}, ${limpio.detalle}, now())`;

    await tx.stockBalance.update({
      where: { id: saldo.id },
      data: {
        quantity: posterior.toString(),
        lastLedgerId: movId,
        lastOperationId: operacion.id,
        version: { increment: 1 },
      },
    });

    await tx.stockWaste.create({
      data: {
        id: input.mermaId,
        branchId: input.branchId,
        productId: input.productId,
        quantity: limpio.cantidad.toString(),
        unit: previa.unidad,
        category: input.categoria,
        reason: limpio.motivo,
        detail: limpio.detalle,
        operationId: operacion.id,
        occurredAt: momento,
        createdById: user.id,
      },
    });

    const resultado = {
      mermaId: input.mermaId,
      sucursal: input.branchId,
      articulo: input.productId,
      plu: previa.plu,
      cantidad: limpio.cantidad.toString(),
      unidad: previa.unidad,
      categoria: input.categoria,
      tipoDeMovimiento: tipo,
      saldoAnterior: anterior.toString(),
      saldoResultante: posterior.toString(),
      momento: momento.toISOString(),
    };
    await tx.stockOperation.update({
      where: { id: operacion.id },
      data: { result: resultado },
    });
    await recordAudit(
      {
        userId: user.id,
        action: AUDIT_ACTIONS.STOCKERP_MERMA_CONFIRMADA,
        entity: 'StockWaste',
        entityId: input.mermaId,
        before: { saldo: anterior.toString() },
        after: { ...resultado, motivo: limpio.motivo, detalle: limpio.detalle, huella },
        reason: limpio.motivo,
      },
      tx,
    );

    return {
      ok: true as const,
      yaEstabaAplicada: false,
      operationId: operacion.id,
      movimientos: 1,
      momento: momento.toISOString(),
      saldoResultante: posterior.toString(),
    };
  });
}

/**
 * Relee lo aplicado y compara la huella.
 *
 * Una violación de unicidad **no demuestra** idempotencia por sí sola: sólo dice
 * que hubo un choque. Puede haber chocado con el mismo contenido —y entonces ya
 * estaba aplicado— o con otro, y eso es un conflicto que hay que nombrar.
 */
async function releerMerma(
  user: AuthUser,
  mermaId: string,
  huellaEsperada: string | null,
): Promise<ResultadoDeCorreccion> {
  const clave = claveDeMerma(mermaId);
  const op = await prisma.stockOperation.findUnique({ where: { operationKey: clave } });
  if (!op) {
    throw new ConflictError(
      'La merma cambió mientras se registraba y no se pudo releer lo aplicado. No se escribió nada.',
    );
  }
  const mismaHuella =
    huellaEsperada === null ||
    (op.hashVersion === VERSION_DE_LA_HUELLA_DE_CORRECCION && op.contentHash === huellaEsperada);

  if (!mismaHuella) {
    throw new ConflictError(
      `Ya hay una merma registrada con este identificador (${formatCorteAr(op.receivedAt ?? op.appliedAt)}) ` +
        'y un contenido distinto del que estás confirmando. No se escribió nada.',
    );
  }

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.STOCKERP_CORRECCION_DUPLICADA,
    entity: 'StockWaste',
    entityId: mermaId,
    after: { operacion: op.id, detalle: 'se contestó el resultado ya guardado' },
  });

  const guardado = op.result as { saldoResultante?: string } | null;
  return {
    ok: true,
    yaEstabaAplicada: true,
    operationId: op.id,
    movimientos: op.movementCount,
    momento: (op.receivedAt ?? op.appliedAt).toISOString(),
    saldoResultante: guardado?.saldoResultante ?? null,
  };
}

export async function mermasRegistradas(
  user: AuthUser,
  filtros: { branchId?: string | null; limite?: number } = {},
) {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_VER, {
    entity: 'StockWaste',
    detalle: 'ver las mermas',
  });
  const filas = await prisma.stockWaste.findMany({
    where: filtros.branchId ? { branchId: filtros.branchId } : {},
    orderBy: { occurredAt: 'desc' },
    take: Math.min(filtros.limite ?? 100, 500),
    include: {
      branch: { select: { name: true } },
      product: { select: { normalizedName: true, internalCode: true } },
      createdBy: { select: { name: true } },
      reversedBy: { select: { name: true } },
      /*
       * El saldo de antes y el de después salen del `result` que guardó la
       * operación, no de una resta hecha hoy: hoy el saldo ya es otro, y lo que
       * la pantalla tiene que mostrar es lo que pasó cuando pasó.
       */
      operation: { select: { result: true } },
    },
  });
  return filas.map((m) => {
    const guardado = m.operation.result as {
      saldoAnterior?: string;
      saldoResultante?: string;
    } | null;
    return {
      id: m.id,
      sucursal: m.branch.name,
      articulo: m.product.normalizedName,
      plu: m.product.internalCode,
      cantidad: m.quantity.toString(),
      unidad: m.unit,
      categoria: m.category,
      motivo: m.reason,
      detalle: m.detail,
      ocurrioEl: m.occurredAt,
      registradaPor: m.createdBy?.name ?? null,
      operationId: m.operationId,
      saldoAnterior: guardado?.saldoAnterior ?? null,
      saldoResultante: guardado?.saldoResultante ?? null,
      revertida: m.reversalOperationId !== null,
      revertidaPor: m.reversedBy?.name ?? null,
      revertidaEl: m.reversedAt,
    };
  });
}

/* ========================================================================== *
 * El recuento correctivo
 *
 * **La persona escribe la cantidad FÍSICA. Nunca un delta.**
 *
 * Aceptar una diferencia calculada en el navegador sería aceptar un número que
 * nadie puede verificar: bastaría con mandar otro para mover el saldo a
 * voluntad, y el registro diría «diferencia de 3» sin que exista forma de saber
 * contra qué. Acá el delta lo calcula el servidor contra el saldo que tiene
 * BLOQUEADO, y una CHECK de la base exige que la diferencia guardada sea
 * exactamente contada − esperada.
 * ========================================================================== */

export interface LineaDeRecuento {
  id: string;
  productId: string;
  articulo: string;
  plu: string;
  unidad: StockUnit;
  /** Lo que el sistema creía cuando se contó. */
  saldoEsperado: string;
  /** Lo que la persona contó. */
  cantidadFisica: string;
  /** Contada − esperada, calculada por el servidor. */
  diferencia: string;
  resolucion: 'SIN_DIFERENCIA' | 'AJUSTADA' | null;
  operationId: string | null;
  contadaPor: string | null;
  contadaEl: Date | null;
  confirmadaPor: string | null;
  confirmadaEl: Date | null;
  /** El motivo escrito del ajuste, tal como quedó en el asiento del libro. */
  motivo: string | null;
  revertida: boolean;
  /** Impedimentos vigentes, recalculados al mirar. */
  impedimentos: string[];
}

export interface RecuentoDetalle {
  sessionId: string;
  nombre: string;
  branchId: string;
  sucursal: string;
  estado: string;
  abiertaEl: Date;
  cerradaEl: Date | null;
  lineas: LineaDeRecuento[];
  /** Cuántas líneas tienen diferencia sin confirmar todavía. */
  conDiferencia: number;
  sinDiferencia: number;
  pendientes: number;
}

export async function abrirRecuento(
  user: AuthUser,
  input: { branchId: string; nombre?: string },
): Promise<{ sessionId: string }> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_RECUENTO_PREPARAR, {
    entity: 'StockCountSession',
    detalle: 'abrir un recuento correctivo',
  });

  const sucursal = await prisma.branch.findUnique({
    where: { id: input.branchId },
    select: { name: true },
  });
  if (!sucursal) throw new NotFoundError('Esa sucursal no existe.');

  const apertura = await prisma.stockCountSession.findFirst({
    where: { branchId: input.branchId, kind: 'APERTURA', status: 'CONFIRMADA' },
    select: { id: true },
  });
  if (!apertura) {
    throw new ValidationError(
      `${sucursal.name} no tiene apertura confirmada de Stock ERP. Sin apertura no hay saldo que recontar: sus artículos no están en cero, están sin contar.`,
    );
  }

  /* Una sola sesión abierta por sucursal: dos recuentos simultáneos del mismo
   * local contarían la misma góndola dos veces y confirmarían dos ajustes. */
  const abierta = await prisma.stockCountSession.findFirst({
    where: { branchId: input.branchId, kind: 'RECUENTO', status: 'ABIERTA' },
  });
  if (abierta) {
    throw new ConflictError(
      `${sucursal.name} ya tiene un recuento abierto. Cerralo antes de empezar otro: dos recuentos a la vez contarían la misma góndola dos veces.`,
    );
  }

  const sesion = await prisma.stockCountSession.create({
    data: {
      branchId: input.branchId,
      kind: 'RECUENTO',
      status: 'ABIERTA',
      name: input.nombre?.trim() || `Recuento de ${sucursal.name}`,
      createdById: user.id,
    },
  });
  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.STOCKERP_RECUENTO_INICIADO,
    entity: 'StockCountSession',
    entityId: sesion.id,
    after: { sucursal: input.branchId, nombre: sesion.name },
  });
  return { sessionId: sesion.id };
}

export async function guardarCantidadFisica(
  user: AuthUser,
  input: { sessionId: string; productId: string; cantidadFisica: string },
): Promise<{ lineaId: string; diferencia: string }> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_RECUENTO_PREPARAR, {
    entity: 'StockCountLine',
    entityId: input.sessionId,
    detalle: 'cargar una cantidad contada',
  });

  const sesion = await prisma.stockCountSession.findUnique({ where: { id: input.sessionId } });
  if (!sesion || sesion.kind !== 'RECUENTO') throw new NotFoundError('Ese recuento no existe.');
  if (sesion.status !== 'ABIERTA') {
    throw new ConflictError('Este recuento ya está cerrado: no se le cargan cantidades nuevas.');
  }

  /* Cero es válido y significa «lo busqué y no había». */
  const contada = cantidadValida(input.cantidadFisica, { ceroVale: true });
  const ctx = await contextoDe(sesion.branchId, input.productId);
  if (ctx.impedimentos.length > 0) {
    throw new ValidationError(
      `Este artículo no se puede recontar acá. ${ctx.impedimentos.join(' ')}`,
    );
  }
  /*
   * El saldo esperado se guarda tal como estaba AL CONTAR. Es la referencia
   * contra la que después se compara al confirmar: si cambió en el medio, el
   * conteo se hizo sobre otra realidad y no se puede aplicar en silencio.
   */
  const esperado = ctx.saldo ?? new Decimal(0);
  const diferencia = contada.minus(esperado);

  const existente = await prisma.stockCountLine.findUnique({
    where: { sessionId_productId: { sessionId: sesion.id, productId: input.productId } },
  });
  if (existente?.resolution) {
    throw new ConflictError(
      'Esta línea ya está confirmada: contar de nuevo es abrir otro recuento. Lo confirmado es historia.',
    );
  }

  const linea = await prisma.stockCountLine.upsert({
    where: { sessionId_productId: { sessionId: sesion.id, productId: input.productId } },
    create: {
      sessionId: sesion.id,
      productId: input.productId,
      expectedQuantity: esperado.toString(),
      countedQuantity: contada.toString(),
      difference: diferencia.toString(),
      unit: ctx.unidad,
      countedById: user.id,
      countedAt: ahora(),
    },
    update: {
      expectedQuantity: esperado.toString(),
      countedQuantity: contada.toString(),
      difference: diferencia.toString(),
      unit: ctx.unidad,
      countedById: user.id,
      countedAt: ahora(),
    },
  });

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.STOCKERP_RECUENTO_CONTADO,
    entity: 'StockCountLine',
    entityId: linea.id,
    before: existente ? { cantidadFisica: existente.countedQuantity.toString() } : undefined,
    after: {
      recuento: sesion.id,
      sucursal: sesion.branchId,
      articulo: input.productId,
      plu: ctx.plu,
      saldoEsperado: esperado.toString(),
      cantidadFisica: contada.toString(),
      diferencia: diferencia.toString(),
      unidad: ctx.unidad,
    },
  });
  if (!diferencia.isZero()) {
    await recordAudit({
      userId: user.id,
      action: AUDIT_ACTIONS.STOCKERP_RECUENTO_DIFERENCIA,
      entity: 'StockCountLine',
      entityId: linea.id,
      after: {
        articulo: input.productId,
        plu: ctx.plu,
        saldoEsperado: esperado.toString(),
        cantidadFisica: contada.toString(),
        diferencia: diferencia.toString(),
      },
    });
  }

  return { lineaId: linea.id, diferencia: diferencia.toString() };
}

export async function verRecuento(user: AuthUser, sessionId: string): Promise<RecuentoDetalle> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_VER, {
    entity: 'StockCountSession',
    entityId: sessionId,
    detalle: 'ver un recuento',
  });
  const sesion = await prisma.stockCountSession.findUnique({
    where: { id: sessionId },
    include: {
      branch: { select: { id: true, name: true } },
      countLines: {
        orderBy: { createdAt: 'asc' },
        include: {
          product: { select: { normalizedName: true, internalCode: true } },
          countedBy: { select: { name: true } },
          confirmedBy: { select: { name: true } },
          /*
           * El motivo escrito del ajuste vive en el asiento, no en la línea: es
           * el movimiento el que tiene que poder explicarse solo cuando alguien
           * lo mira en el libro dentro de dos años.
           */
          operation: { select: { ledger: { select: { reason: true }, take: 1 } } },
        },
      },
    },
  });
  if (!sesion || sesion.kind !== 'RECUENTO') throw new NotFoundError('Ese recuento no existe.');

  const lineas: LineaDeRecuento[] = [];
  for (const l of sesion.countLines) {
    const ctx = await contextoDe(sesion.branchId, l.productId);
    const impedimentos = [...ctx.impedimentos];
    /*
     * El saldo de hoy contra el que se anotó al contar. Si no coinciden, la
     * confirmación se va a frenar, y conviene decirlo ANTES de que alguien
     * intente confirmar.
     */
    const hoy = ctx.saldo ?? new Decimal(0);
    if (!l.resolution && !hoy.equals(new Decimal(l.expectedQuantity.toString()))) {
      impedimentos.push(
        `El saldo cambió desde que se contó: era ${l.expectedQuantity.toString()} y ahora es ${hoy.toString()}. Hay que revisar qué pasó o volver a contar; no se recalcula solo.`,
      );
    }
    lineas.push({
      id: l.id,
      productId: l.productId,
      articulo: l.product.normalizedName,
      plu: l.product.internalCode,
      unidad: l.unit,
      saldoEsperado: l.expectedQuantity.toString(),
      cantidadFisica: l.countedQuantity.toString(),
      diferencia: l.difference.toString(),
      resolucion: l.resolution,
      operationId: l.operationId,
      contadaPor: l.countedBy?.name ?? null,
      contadaEl: l.countedAt,
      confirmadaPor: l.confirmedBy?.name ?? null,
      confirmadaEl: l.confirmedAt,
      motivo: l.operation?.ledger[0]?.reason ?? null,
      revertida: l.reversalOperationId !== null,
      impedimentos,
    });
  }

  return {
    sessionId: sesion.id,
    nombre: sesion.name,
    branchId: sesion.branch.id,
    sucursal: sesion.branch.name,
    estado: sesion.status,
    abiertaEl: sesion.createdAt,
    cerradaEl: sesion.closedAt,
    lineas,
    conDiferencia: lineas.filter((l) => !l.resolucion && l.diferencia !== '0').length,
    sinDiferencia: lineas.filter((l) => l.resolucion === 'SIN_DIFERENCIA').length,
    pendientes: lineas.filter((l) => !l.resolucion).length,
  };
}

export function claveDeRecuento(sessionId: string, lineaId: string): string {
  return `recuento:${sessionId}:${lineaId}`;
}

export function huellaDeRecuento(datos: {
  sessionId: string;
  lineaId: string;
  productId: string;
  branchId: string;
  esperado: string;
  contado: string;
  unidad: StockUnit;
}): string {
  const texto = [
    `v${VERSION_DE_LA_HUELLA_DE_CORRECCION}`,
    'tipo:RECUENTO',
    `recuento:${datos.sessionId}`,
    `linea:${datos.lineaId}`,
    `sucursal:${datos.branchId}`,
    `articulo:${datos.productId}`,
    `esperado:${new Decimal(datos.esperado).toDecimalPlaces(3).toString()}`,
    `contado:${new Decimal(datos.contado).toDecimalPlaces(3).toString()}`,
    `unidad:${datos.unidad}`,
  ].join('\n');
  return createHash('sha256').update(texto).digest('hex');
}

export async function confirmarLineaDeRecuento(
  user: AuthUser,
  input: { lineaId: string; confirmado: boolean; motivo: string },
): Promise<ResultadoDeCorreccion> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_AJUSTE, {
    entity: 'StockCountLine',
    entityId: input.lineaId,
    detalle: 'confirmar un ajuste de recuento',
  });
  if (!input.confirmado) {
    throw new ValidationError(
      'Falta la segunda confirmación. Un ajuste de recuento cambia el saldo y escribe el libro: no se deshace.',
    );
  }
  const motivo = (input.motivo ?? '').trim();
  if (motivo.length < 3) {
    throw new ValidationError(
      'Confirmar un ajuste exige escribir por qué. Un saldo que cambia sin explicación no se puede auditar después.',
    );
  }

  for (let intento = 1; intento <= 3; intento += 1) {
    try {
      return await aplicarAjusteDeRecuento(user, input.lineaId, motivo);
    } catch (e) {
      const codigo = e instanceof Prisma.PrismaClientKnownRequestError ? e.code : null;
      if (codigo === 'P2002') return await releerAjuste(user, input.lineaId);
      const serializacion =
        e instanceof Prisma.PrismaClientUnknownRequestError &&
        /40001|could not serialize/i.test(e.message);
      if (serializacion && intento < 3) continue;
      throw e;
    }
  }
  throw new ConflictError('El ajuste no se pudo confirmar después de tres intentos.');
}

async function aplicarAjusteDeRecuento(
  user: AuthUser,
  lineaId: string,
  motivo: string,
): Promise<ResultadoDeCorreccion> {
  const linea = await prisma.stockCountLine.findUnique({
    where: { id: lineaId },
    include: { session: true, product: { select: { internalCode: true, normalizedName: true } } },
  });
  if (!linea) throw new NotFoundError('Esa línea de recuento no existe.');
  if (linea.resolution) {
    /* Ya resuelta: se contesta lo guardado en vez de hacer otra cosa. */
    return await releerAjuste(user, lineaId);
  }
  if (linea.session.status !== 'ABIERTA') {
    throw new ConflictError('El recuento está cerrado: sus líneas ya no se confirman.');
  }

  const branchId = linea.session.branchId;
  const ctx = await contextoDe(branchId, linea.productId, linea.unit);
  if (ctx.impedimentos.length > 0) {
    throw new ValidationError(
      `Este ajuste no se puede confirmar. ${ctx.impedimentos.join(' ')} No se escribió nada.`,
    );
  }

  const clave = claveDeRecuento(linea.sessionId, linea.id);
  const huella = huellaDeRecuento({
    sessionId: linea.sessionId,
    lineaId: linea.id,
    productId: linea.productId,
    branchId,
    esperado: linea.expectedQuantity.toString(),
    contado: linea.countedQuantity.toString(),
    unidad: linea.unit,
  });
  const momento = ahora();

  const existente = await prisma.stockOperation.findUnique({ where: { operationKey: clave } });
  if (existente) return await releerAjuste(user, lineaId);

  return await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT id FROM "stock_balance"
       WHERE "productId" = ${linea.productId} AND "branchId" = ${branchId} FOR UPDATE`;

    const saldo = await tx.stockBalance.findUnique({
      where: { productId_branchId: { productId: linea.productId, branchId } },
    });
    const actual = saldo ? new Decimal(saldo.quantity.toString()) : new Decimal(0);
    const esperado = new Decimal(linea.expectedQuantity.toString());

    /*
     * **El saldo cambió entre el conteo y la confirmación.**
     *
     * No se recalcula en silencio: el conteo se hizo contra otra realidad, y
     * aplicarlo ahora escribiría una diferencia que nadie contó. Se frena y se
     * dice qué pasó.
     */
    if (!actual.equals(esperado)) {
      await recordAudit({
        userId: user.id,
        action: AUDIT_ACTIONS.STOCKERP_RECUENTO_SALDO_CAMBIADO,
        entity: 'StockCountLine',
        entityId: linea.id,
        before: { saldoAlContar: esperado.toString() },
        after: {
          saldoAhora: actual.toString(),
          cantidadFisica: linea.countedQuantity.toString(),
          detalle: 'no se aplicó ningún ajuste',
        },
      });
      throw new ConflictError(
        `El saldo cambió desde que se contó: era ${esperado.toString()} ${linea.unit} y ahora es ${actual.toString()}. ` +
          'No se aplicó nada y no se recalculó la diferencia: hay que revisar qué movimiento entró en el medio o volver a contar.',
      );
    }

    const contado = new Decimal(linea.countedQuantity.toString());
    /* El delta lo calcula el SERVIDOR, contra el saldo que tiene bloqueado. */
    const diferencia = contado.minus(actual);

    /* --- Coincidía: constancia sí, movimiento no -------------------------- */
    if (diferencia.isZero()) {
      await tx.stockCountLine.update({
        where: { id: linea.id },
        data: {
          resolution: 'SIN_DIFERENCIA',
          confirmedById: user.id,
          confirmedAt: momento,
          difference: '0',
          expectedQuantity: actual.toString(),
        },
      });
      await recordAudit(
        {
          userId: user.id,
          action: AUDIT_ACTIONS.STOCKERP_RECUENTO_SIN_DIFERENCIA,
          entity: 'StockCountLine',
          entityId: linea.id,
          after: {
            articulo: linea.productId,
            plu: linea.product.internalCode,
            saldo: actual.toString(),
            cantidadFisica: contado.toString(),
            detalle: 'coincidía: no se escribió ningún movimiento',
          },
          reason: motivo,
        },
        tx,
      );
      return {
        ok: true as const,
        yaEstabaAplicada: false,
        operationId: '',
        movimientos: 0,
        momento: momento.toISOString(),
        saldoResultante: actual.toString(),
      };
    }

    /* --- Había diferencia: se asienta SÓLO la diferencia ------------------ */
    const posterior = contado;
    if (posterior.isNegative()) {
      throw new ValidationError('Un recuento no puede dejar el saldo negativo.');
    }
    const entra = diferencia.isPositive();
    const magnitud = diferencia.abs();

    const operacion = await tx.stockOperation.create({
      data: {
        operationKey: clave,
        kind: 'AJUSTE',
        hashVersion: VERSION_DE_LA_HUELLA_DE_CORRECCION,
        contentHash: huella,
        branchId,
        requestedById: user.id,
        receivedAt: momento,
        movementCount: 1,
      },
    });

    const movId = `${operacion.id}-ajuste`;
    await tx.$executeRaw`
      INSERT INTO "stock_ledger"
        ("id","txId","productId","pluHistorico","branchId","type","direction",
         "quantity","unit","effectiveAt","operationId","userId","idempotencyKey",
         "balanceAfterSeq","reason","createdAt")
      VALUES (${movId}, txid_current(), ${linea.productId}, ${linea.product.internalCode},
              ${branchId},
              ${entra ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT'}::"StockMovementType",
              ${entra ? 'IN' : 'OUT'}::"StockDirection",
              ${magnitud.toString()}::numeric, ${linea.unit}::"StockUnit",
              ${momento}, ${operacion.id}, ${user.id}, ${`${clave}:1`},
              ${posterior.toString()}::numeric,
              ${`Recuento correctivo: contado ${contado.toString()} contra ${actual.toString()}. ${motivo}`},
              now())`;

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
      await tx.stockBalance.create({
        data: {
          productId: linea.productId,
          branchId,
          quantity: posterior.toString(),
          unit: linea.unit,
          lastLedgerId: movId,
          lastOperationId: operacion.id,
          openingSource: 'POSTERIOR_AL_CORTE',
        },
      });
    }

    await tx.stockCountLine.update({
      where: { id: linea.id },
      data: {
        resolution: 'AJUSTADA',
        operationId: operacion.id,
        confirmedById: user.id,
        confirmedAt: momento,
        expectedQuantity: actual.toString(),
        difference: diferencia.toString(),
      },
    });

    const resultado = {
      recuento: linea.sessionId,
      linea: linea.id,
      sucursal: branchId,
      articulo: linea.productId,
      plu: linea.product.internalCode,
      saldoAnterior: actual.toString(),
      cantidadFisica: contado.toString(),
      diferencia: diferencia.toString(),
      tipoDeMovimiento: entra ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT',
      saldoResultante: posterior.toString(),
      unidad: linea.unit,
      momento: momento.toISOString(),
    };
    await tx.stockOperation.update({
      where: { id: operacion.id },
      data: { result: resultado },
    });
    await recordAudit(
      {
        userId: user.id,
        action: AUDIT_ACTIONS.STOCKERP_RECUENTO_AJUSTADO,
        entity: 'StockCountLine',
        entityId: linea.id,
        before: { saldo: actual.toString() },
        after: { ...resultado, huella },
        reason: motivo,
      },
      tx,
    );

    return {
      ok: true as const,
      yaEstabaAplicada: false,
      operationId: operacion.id,
      movimientos: 1,
      momento: momento.toISOString(),
      saldoResultante: posterior.toString(),
    };
  });
}

async function releerAjuste(user: AuthUser, lineaId: string): Promise<ResultadoDeCorreccion> {
  const linea = await prisma.stockCountLine.findUnique({
    where: { id: lineaId },
    include: { operation: true },
  });
  if (!linea || !linea.resolution) {
    throw new ConflictError(
      'La línea de recuento cambió mientras se confirmaba y no se pudo releer lo aplicado. No se escribió nada.',
    );
  }
  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.STOCKERP_CORRECCION_DUPLICADA,
    entity: 'StockCountLine',
    entityId: lineaId,
    after: { detalle: 'se contestó el resultado ya guardado', resolucion: linea.resolution },
  });
  const guardado = linea.operation?.result as { saldoResultante?: string } | null;
  return {
    ok: true,
    yaEstabaAplicada: true,
    operationId: linea.operationId ?? '',
    movimientos: linea.resolution === 'AJUSTADA' ? 1 : 0,
    momento: (linea.confirmedAt ?? linea.createdAt).toISOString(),
    saldoResultante: guardado?.saldoResultante ?? linea.countedQuantity.toString(),
  };
}

export async function cerrarRecuento(
  user: AuthUser,
  input: { sessionId: string },
): Promise<void> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_RECUENTO_PREPARAR, {
    entity: 'StockCountSession',
    entityId: input.sessionId,
    detalle: 'cerrar un recuento',
  });
  const sesion = await prisma.stockCountSession.findUnique({
    where: { id: input.sessionId },
    include: { countLines: true },
  });
  if (!sesion || sesion.kind !== 'RECUENTO') throw new NotFoundError('Ese recuento no existe.');
  if (sesion.status === 'CERRADA') return;

  const pendientes = sesion.countLines.filter((l) => !l.resolution);
  if (pendientes.length > 0) {
    throw new ConflictError(
      `Quedan ${pendientes.length} ${pendientes.length === 1 ? 'línea' : 'líneas'} sin confirmar. Un recuento se cierra cuando cada cosa contada tiene una respuesta: ajustada o sin diferencia.`,
    );
  }
  await prisma.stockCountSession.update({
    where: { id: sesion.id },
    data: { status: 'CERRADA', closedAt: ahora() },
  });
}

export async function recuentosDeLaSucursal(
  user: AuthUser,
  filtros: { branchId?: string | null } = {},
) {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_VER, {
    entity: 'StockCountSession',
    detalle: 'ver los recuentos',
  });
  const filas = await prisma.stockCountSession.findMany({
    where: { kind: 'RECUENTO', ...(filtros.branchId ? { branchId: filtros.branchId } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      branch: { select: { name: true } },
      _count: { select: { countLines: true } },
    },
  });
  return filas.map((s) => ({
    id: s.id,
    nombre: s.name,
    sucursal: s.branch.name,
    estado: s.status,
    lineas: s._count.countLines,
    abiertaEl: s.createdAt,
    cerradaEl: s.closedAt,
  }));
}

/* ========================================================================== *
 * La reversión acotada
 *
 * **Agrega asientos inversos. Nunca borra ni edita el libro.**
 *
 * Elegibles en esta fase, y nada más: las mermas y los ajustes de recuento que
 * esta fase creó, y el despacho de un traslado que todavía está en tránsito. La
 * base lo hace cumplir con `stock_reversion_elegible`, así que la regla no
 * depende de que este archivo se acuerde de comprobarla.
 * ========================================================================== */

export type ClaseReversible = 'MERMA' | 'AJUSTE_DE_RECUENTO' | 'DESPACHO_DE_TRASLADO';

export interface OperacionReversible {
  operationId: string;
  clase: ClaseReversible;
  descripcion: string;
  sucursal: string;
  branchId: string;
  momento: Date;
  movimientos: {
    id: string;
    productId: string;
    articulo: string;
    plu: string;
    tipo: string;
    direccion: string;
    cantidad: string;
    unidad: StockUnit;
  }[];
  yaRevertida: boolean;
  /** Por qué no se puede revertir, si no se puede. */
  impedimentos: string[];
}

export function claveDeReversion(operationId: string): string {
  return `reversion:${operationId}`;
}

export function huellaDeReversion(datos: {
  operationId: string;
  movimientos: { id: string; cantidad: string; unidad: StockUnit; tipo: string }[];
}): string {
  const ordenados = [...datos.movimientos].sort((a, b) => a.id.localeCompare(b.id));
  const texto = [
    `v${VERSION_DE_LA_HUELLA_DE_CORRECCION}`,
    'tipo:REVERSION',
    `operacion:${datos.operationId}`,
    ...ordenados.map((m) =>
      [m.id, m.tipo, new Decimal(m.cantidad).toDecimalPlaces(3).toString(), m.unidad].join('|'),
    ),
  ].join('\n');
  return createHash('sha256').update(texto).digest('hex');
}

/**
 * Qué es esta operación y si se puede revertir.
 *
 * La clase se deduce de lo que la operación ESCRIBIÓ, no de su `kind`: una
 * operación de clase `AJUSTE` puede ser una merma o un recuento, y la diferencia
 * importa para saber qué se revierte.
 */
async function claseDe(operationId: string): Promise<{
  clase: ClaseReversible;
  impedimentos: string[];
  yaRevertida: boolean;
}> {
  const [merma, linea, traslado, op] = await Promise.all([
    prisma.stockWaste.findUnique({ where: { operationId } }),
    prisma.stockCountLine.findUnique({ where: { operationId } }),
    prisma.stockTransfer.findUnique({ where: { operationId } }),
    prisma.stockOperation.findUnique({
      where: { id: operationId },
      include: { reversedBy: { select: { id: true } } },
    }),
  ]);

  const impedimentos: string[] = [];
  if (!op) throw new NotFoundError('Esa operación no existe.');

  if (op.kind === 'REVERSION') {
    impedimentos.push(
      'Una reversión no se revierte: si quedó mal, se corrige con un recuento correctivo.',
    );
  }
  if (op.reversedBy) {
    impedimentos.push('Esta operación ya fue revertida. Una operación se revierte una sola vez.');
  }

  if (merma) {
    if (merma.reversalOperationId) impedimentos.push('Esta merma ya fue revertida.');
    return { clase: 'MERMA', impedimentos, yaRevertida: merma.reversalOperationId !== null };
  }
  if (linea) {
    if (linea.reversalOperationId) impedimentos.push('Este ajuste ya fue revertido.');
    return {
      clase: 'AJUSTE_DE_RECUENTO',
      impedimentos,
      yaRevertida: linea.reversalOperationId !== null,
    };
  }
  if (traslado) {
    if (traslado.status === 'RECIBIDO') {
      impedimentos.push(
        'Este traslado ya fue recibido en el destino: revertir el despacho exigiría compensar las dos sucursales, y eso no es de esta fase. Devolver la mercadería es un traslado nuevo en el otro sentido.',
      );
    } else if (traslado.status !== 'DESPACHADO') {
      impedimentos.push(`Un traslado ${traslado.status.toLowerCase()} no tiene despacho que revertir.`);
    }
    return {
      clase: 'DESPACHO_DE_TRASLADO',
      impedimentos,
      yaRevertida: traslado.status === 'REVERSADO',
    };
  }

  impedimentos.push(
    `Esta operación (${op.kind}) no es reversible en esta fase. Sólo se revierten mermas, ajustes de recuento y despachos de traslado todavía en tránsito.`,
  );
  return { clase: 'MERMA', impedimentos, yaRevertida: false };
}

export async function operacionReversible(
  user: AuthUser,
  operationId: string,
): Promise<OperacionReversible> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_VER, {
    entity: 'StockOperation',
    entityId: operationId,
    detalle: 'mirar una operación reversible',
  });

  const op = await prisma.stockOperation.findUnique({
    where: { id: operationId },
    include: {
      branch: { select: { id: true, name: true } },
      ledger: {
        where: { reversesId: null },
        include: { product: { select: { normalizedName: true, internalCode: true } } },
        orderBy: { seq: 'asc' },
      },
    },
  });
  if (!op) throw new NotFoundError('Esa operación no existe.');

  const { clase, impedimentos, yaRevertida } = await claseDe(operationId);
  const movimientos = op.ledger.map((m) => ({
    id: m.id,
    productId: m.productId,
    articulo: m.product.normalizedName,
    plu: m.product.internalCode,
    tipo: m.type as string,
    direccion: m.direction as string,
    cantidad: m.quantity.toString(),
    unidad: m.unit,
  }));

  if (movimientos.length === 0) {
    impedimentos.push('Esta operación no escribió movimientos: no hay nada que revertir.');
  }

  /*
   * Y la comprobación que sólo se puede hacer mirando el saldo de HOY: revertir
   * una entrada saca mercadería, y si ya se fue por otro camino, el saldo no
   * alcanza. Se avisa acá y se vuelve a comprobar dentro de la transacción.
   */
  for (const m of movimientos) {
    if (m.direccion !== 'IN') continue;
    const saldo = await prisma.stockBalance.findUnique({
      where: { productId_branchId: { productId: m.productId, branchId: op.branchId ?? '' } },
    });
    const hay = saldo ? new Decimal(saldo.quantity.toString()) : new Decimal(0);
    if (hay.lessThan(new Decimal(m.cantidad))) {
      impedimentos.push(
        `Revertir esta operación tendría que sacar ${m.cantidad} ${m.unidad} de ${m.articulo}, y hoy quedan ${hay.toString()}: operaciones posteriores se llevaron esa mercadería. El saldo no puede quedar negativo.`,
      );
    }
  }

  return {
    operationId,
    clase,
    descripcion:
      clase === 'MERMA'
        ? 'Merma registrada'
        : clase === 'AJUSTE_DE_RECUENTO'
          ? 'Ajuste de recuento correctivo'
          : 'Despacho de traslado en tránsito',
    sucursal: op.branch?.name ?? '—',
    branchId: op.branchId ?? '',
    momento: op.receivedAt ?? op.appliedAt,
    movimientos,
    yaRevertida,
    impedimentos,
  };
}

export async function revertirOperacion(
  user: AuthUser,
  input: { operationId: string; motivo: string; confirmado: boolean },
): Promise<ResultadoDeCorreccion> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_REVERSAR, {
    entity: 'StockOperation',
    entityId: input.operationId,
    detalle: 'revertir una operación',
  });
  if (!input.confirmado) {
    throw new ValidationError(
      'Falta la segunda confirmación. Una reversión escribe movimientos inversos en el libro: no se deshace.',
    );
  }
  const motivo = (input.motivo ?? '').trim();
  if (motivo.length < 3) {
    throw new ValidationError(
      'Una reversión exige motivo escrito. Es lo único que explica por qué el libro tiene dos asientos que se cancelan.',
    );
  }

  for (let intento = 1; intento <= 3; intento += 1) {
    try {
      return await aplicarReversion(user, input.operationId, motivo);
    } catch (e) {
      const codigo = e instanceof Prisma.PrismaClientKnownRequestError ? e.code : null;
      if (codigo === 'P2002') return await releerReversion(user, input.operationId);
      const serializacion =
        e instanceof Prisma.PrismaClientUnknownRequestError &&
        /40001|could not serialize/i.test(e.message);
      if (serializacion && intento < 3) continue;
      throw e;
    }
  }
  throw new ConflictError('La reversión no se pudo aplicar después de tres intentos.');
}

async function aplicarReversion(
  user: AuthUser,
  operationId: string,
  motivo: string,
): Promise<ResultadoDeCorreccion> {
  const clave = claveDeReversion(operationId);

  /*
   * **La idempotencia se pregunta ANTES de la elegibilidad.**
   *
   * Y el orden importa: una operación ya revertida deja de ser elegible —lo dice
   * su propio impedimento—, así que preguntar primero por la elegibilidad hacía
   * que el segundo clic contestara «no se puede revertir» en vez de «ya estaba
   * revertida». Lo primero suena a error del usuario; lo segundo es la verdad.
   */
  const existente = await prisma.stockOperation.findUnique({ where: { operationKey: clave } });
  if (existente) return await releerReversion(user, operationId);

  const previa = await operacionReversible(user, operationId);
  if (previa.impedimentos.length > 0) {
    throw new ValidationError(
      `Esta operación no se puede revertir. ${previa.impedimentos.join(' ')} No se escribió nada.`,
    );
  }

  const huella = huellaDeReversion({ operationId, movimientos: previa.movimientos });
  const momento = ahora();

  return await prisma.$transaction(async (tx) => {
    /* Candados en orden canónico por artículo: dos reversiones a la vez no se abrazan. */
    const productos = [...new Set(previa.movimientos.map((m) => m.productId))].sort();
    for (const pid of productos) {
      await tx.$executeRaw`
        SELECT id FROM "stock_balance"
         WHERE "productId" = ${pid} AND "branchId" = ${previa.branchId} FOR UPDATE`;
    }

    /* Revalidación DENTRO: la operación pudo revertirse mientras mirábamos. */
    const yaTiene = await tx.stockOperation.findFirst({
      where: { reversesOperationId: operationId },
      select: { id: true },
    });
    if (yaTiene) {
      throw new ConflictError(
        'Esta operación fue revertida mientras se confirmaba. No se escribió nada: una operación se revierte una sola vez.',
      );
    }

    const inversa = await tx.stockOperation.create({
      data: {
        operationKey: clave,
        kind: 'REVERSION',
        hashVersion: VERSION_DE_LA_HUELLA_DE_CORRECCION,
        contentHash: huella,
        branchId: previa.branchId,
        requestedById: user.id,
        receivedAt: momento,
        reversesOperationId: operationId,
        movementCount: previa.movimientos.length,
      },
    });

    let escritos = 0;
    let ultimoSaldo: string | null = null;
    for (const m of previa.movimientos) {
      const saldo = await tx.stockBalance.findUnique({
        where: { productId_branchId: { productId: m.productId, branchId: previa.branchId } },
      });
      const actual = saldo ? new Decimal(saldo.quantity.toString()) : new Decimal(0);
      const cantidad = new Decimal(m.cantidad);
      /* La reversión invierte la dirección: lo que entró sale, lo que salió entra. */
      const entra = m.direccion === 'OUT';
      const posterior = entra ? actual.plus(cantidad) : actual.minus(cantidad);

      if (posterior.isNegative()) {
        throw new ValidationError(
          `Revertir esta operación dejaría ${m.articulo} en ${posterior.toString()} ${m.unidad}: ` +
            `hoy quedan ${actual.toString()} y habría que sacar ${cantidad.toString()}. ` +
            'Operaciones posteriores se llevaron esa mercadería. No se escribió nada.',
        );
      }

      const original = await tx.stockLedger.findUniqueOrThrow({ where: { id: m.id } });
      const movId = `${inversa.id}-${m.id}`;
      await tx.$executeRaw`
        INSERT INTO "stock_ledger"
          ("id","txId","productId","pluHistorico","branchId","type","direction",
           "quantity","unit","effectiveAt","operationId","userId","idempotencyKey",
           "balanceAfterSeq","reversesId","transferLineId","documentId","documentItemId",
           "reason","createdAt")
        VALUES (${movId}, txid_current(), ${m.productId}, ${original.pluHistorico},
                ${previa.branchId}, ${m.tipo}::"StockMovementType",
                ${entra ? 'IN' : 'OUT'}::"StockDirection", ${cantidad.toString()}::numeric,
                ${m.unidad}::"StockUnit", ${momento}, ${inversa.id}, ${user.id},
                ${`${clave}:${m.id}`}, ${posterior.toString()}::numeric, ${m.id},
                ${original.transferLineId}, ${original.documentId}, ${original.documentItemId},
                ${`Reversión: ${motivo}`}, now())`;

      if (saldo) {
        await tx.stockBalance.update({
          where: { id: saldo.id },
          data: {
            quantity: posterior.toString(),
            lastLedgerId: movId,
            lastOperationId: inversa.id,
            version: { increment: 1 },
          },
        });
      } else {
        await tx.stockBalance.create({
          data: {
            productId: m.productId,
            branchId: previa.branchId,
            quantity: posterior.toString(),
            unit: m.unidad,
            lastLedgerId: movId,
            lastOperationId: inversa.id,
            openingSource: 'POSTERIOR_AL_CORTE',
          },
        });
      }
      ultimoSaldo = posterior.toString();
      escritos += 1;
    }

    /* --- El vínculo con lo que se revirtió ------------------------------- */
    if (previa.clase === 'MERMA') {
      await tx.stockWaste.update({
        where: { operationId },
        data: { reversalOperationId: inversa.id, reversedById: user.id, reversedAt: momento },
      });
    } else if (previa.clase === 'AJUSTE_DE_RECUENTO') {
      await tx.stockCountLine.update({
        where: { operationId },
        data: { reversalOperationId: inversa.id, reversedById: user.id, reversedAt: momento },
      });
    } else {
      /*
       * El traslado pasa a REVERSADO: la salida original queda en el libro con su
       * reversión al lado, el destino nunca recibió nada y el traslado no vuelve a
       * ser un borrador editable.
       */
      await tx.stockTransfer.update({
        where: { operationId },
        data: { status: 'REVERSADO', reason: motivo, version: { increment: 1 } },
      });
    }

    const resultado = {
      revierte: operationId,
      clase: previa.clase,
      sucursal: previa.branchId,
      movimientos: escritos,
      momento: momento.toISOString(),
      saldoResultante: ultimoSaldo,
      detalle: previa.movimientos.map((m) => ({
        original: m.id,
        articulo: m.productId,
        cantidad: m.cantidad,
        unidad: m.unidad,
        tipo: m.tipo,
        direccionOriginal: m.direccion,
      })),
    };
    await tx.stockOperation.update({
      where: { id: inversa.id },
      data: { result: resultado },
    });
    await recordAudit(
      {
        userId: user.id,
        action: AUDIT_ACTIONS.STOCKERP_REVERSION_CONFIRMADA,
        entity: 'StockOperation',
        entityId: operationId,
        before: { operacionRevertida: operationId, clase: previa.clase },
        after: { ...resultado, operacionInversa: inversa.id, huella },
        reason: motivo,
      },
      tx,
    );

    return {
      ok: true as const,
      yaEstabaAplicada: false,
      operationId: inversa.id,
      movimientos: escritos,
      momento: momento.toISOString(),
      saldoResultante: ultimoSaldo,
    };
  });
}

async function releerReversion(
  user: AuthUser,
  operationId: string,
): Promise<ResultadoDeCorreccion> {
  const inversa = await prisma.stockOperation.findUnique({
    where: { operationKey: claveDeReversion(operationId) },
  });
  if (!inversa) {
    throw new ConflictError(
      'La reversión no se pudo releer después del choque. No se escribió nada: volvé a abrir la operación.',
    );
  }
  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.STOCKERP_CORRECCION_DUPLICADA,
    entity: 'StockOperation',
    entityId: operationId,
    after: { detalle: 'la reversión ya estaba aplicada', operacionInversa: inversa.id },
  });
  const guardado = inversa.result as { saldoResultante?: string } | null;
  return {
    ok: true,
    yaEstabaAplicada: true,
    operationId: inversa.id,
    movimientos: inversa.movementCount,
    momento: (inversa.receivedAt ?? inversa.appliedAt).toISOString(),
    saldoResultante: guardado?.saldoResultante ?? null,
  };
}

/** Las operaciones que hoy se pueden revertir, para el listado. */
export async function operacionesReversibles(
  user: AuthUser,
  filtros: { branchId?: string | null; limite?: number } = {},
): Promise<OperacionReversible[]> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_VER, {
    entity: 'StockOperation',
    detalle: 'ver las operaciones reversibles',
  });

  const [mermas, lineas, traslados] = await Promise.all([
    prisma.stockWaste.findMany({
      where: {
        reversalOperationId: null,
        ...(filtros.branchId ? { branchId: filtros.branchId } : {}),
      },
      orderBy: { occurredAt: 'desc' },
      take: Math.min(filtros.limite ?? 50, 200),
      select: { operationId: true },
    }),
    prisma.stockCountLine.findMany({
      where: {
        resolution: 'AJUSTADA',
        reversalOperationId: null,
        ...(filtros.branchId ? { session: { branchId: filtros.branchId } } : {}),
      },
      orderBy: { confirmedAt: 'desc' },
      take: Math.min(filtros.limite ?? 50, 200),
      select: { operationId: true },
    }),
    prisma.stockTransfer.findMany({
      where: {
        status: 'DESPACHADO',
        ...(filtros.branchId ? { fromBranchId: filtros.branchId } : {}),
      },
      orderBy: { dispatchedAt: 'desc' },
      take: Math.min(filtros.limite ?? 50, 200),
      select: { operationId: true },
    }),
  ]);

  const ids = [
    ...mermas.map((m) => m.operationId),
    ...lineas.map((l) => l.operationId),
    ...traslados.map((t) => t.operationId),
  ].filter((x): x is string => x !== null);

  const salida: OperacionReversible[] = [];
  for (const id of ids) salida.push(await operacionReversible(user, id));
  return salida.sort((a, b) => b.momento.getTime() - a.momento.getTime());
}
