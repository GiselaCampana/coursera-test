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
import {
  instanteDesdeHoraArgentina,
  formatCorteAr,
  arTodayISO,
  horaArgentinaISO,
} from '@/lib/datetime';
import { esUnaBaseDePruebas } from '@/lib/base-de-pruebas';
import { convertirAUnidadDeExistencia } from '@/lib/services/stock-erp-unidades';

/**
 * **Stock ERP, fase 4: recibir la mercadería de una compra.**
 *
 * Validar una factura y recibir la mercadería son dos hechos distintos, y esta
 * fase existe para separarlos. `confirmDocument` sigue haciendo lo suyo —valida,
 * registra `PurchaseMovement`, actualiza costos, agenda la deuda— y **no ingresa
 * una sola unidad**. La recepción es un acto posterior, con su fecha física, su
 * permiso y su doble confirmación.
 *
 * Una factura validada sin recepción no es un error: es información. Significa
 * que el papel llegó y la mercadería todavía no, o que nadie la contó.
 *
 * SIN BANDEJA NUEVA. Los pendientes se calculan —VALIDADO, con mercadería, sin
 * fila en `stock_receipt`—. Lo que la base guarda es la decisión.
 *
 * EL RECEPTOR ES EL LIBRO LOCAL. Nunca `StockOutbox`, nunca HTTP. Control de
 * Stock sigue siendo otra aplicación y esta fase no le manda nada.
 */

export const VERSION_DE_LA_HUELLA_DE_RECEPCION = 1;

export type Resolucion = 'APLICADA' | 'INCLUIDA_EN_APERTURA' | 'EXCLUIDA';

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
 * El interruptor de recepciones reales
 * ========================================================================== */

export async function interruptorDeRecepcionesReales(): Promise<{
  encendido: boolean;
  cambiadoPor: string | null;
  cambiadoEl: Date | null;
  motivo: string | null;
}> {
  const fila = await prisma.stockModuleSetting.findFirst({
    include: { receiptsChangedBy: { select: { name: true } } },
  });
  return {
    encendido: fila?.realPurchaseReceiptsEnabled ?? false,
    cambiadoPor: fila?.receiptsChangedBy?.name ?? null,
    cambiadoEl: fila?.receiptsChangedAt ?? null,
    motivo: fila?.receiptsReason ?? null,
  };
}

export async function cambiarInterruptorDeRecepciones(
  user: AuthUser,
  input: { encender: boolean; motivo: string },
): Promise<void> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_MODULO_CONFIGURAR, {
    entity: 'StockModuleSetting',
    detalle: input.encender ? 'encender recepciones reales' : 'apagar recepciones reales',
  });
  if (!input.motivo?.trim()) {
    throw new ValidationError('Cambiar el interruptor exige escribir por qué. Queda en la auditoría.');
  }
  const antes = await prisma.stockModuleSetting.findFirst();
  const fila = await prisma.stockModuleSetting.upsert({
    where: { unica: true },
    create: {
      unica: true,
      realPurchaseReceiptsEnabled: input.encender,
      receiptsChangedById: user.id,
      receiptsChangedAt: new Date(),
      receiptsReason: input.motivo.trim(),
    },
    update: {
      realPurchaseReceiptsEnabled: input.encender,
      receiptsChangedById: user.id,
      receiptsChangedAt: new Date(),
      receiptsReason: input.motivo.trim(),
    },
  });
  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.STOCKERP_RECEPCIONES_INTERRUPTOR,
    entity: 'StockModuleSetting',
    entityId: fila.id,
    before: { realPurchaseReceiptsEnabled: antes?.realPurchaseReceiptsEnabled ?? false },
    after: { realPurchaseReceiptsEnabled: input.encender, motivo: input.motivo.trim() },
  });
}

/* ========================================================================== *
 * La vista previa: dice qué pasaría y NO escribe nada
 * ========================================================================== */

export type ClaseDeRenglon = 'MERCADERIA' | 'GASTO_SIN_IMPACTO' | 'BLOQUEADO' | 'EXCLUIDO';

export interface RenglonDeRecepcion {
  documentItemId: string;
  lineNumber: number;
  descripcion: string;
  plu: string | null;
  productId: string | null;
  clase: ClaseDeRenglon;
  motivo: string | null;
  /** Lo que dice el papel. Texto exacto, nunca `number`. */
  cantidadFacturada: string;
  unidadFacturada: string;
  /** Lo que entra al libro, ya convertido. */
  cantidadDeExistencia: string | null;
  unidadDeExistencia: string | null;
  factorUsado: string | null;
  piezas: number | null;
  pesoRealKg: string | null;
  saldoAnterior: string | null;
  saldoPrevisto: string | null;
}

export interface VistaPreviaDeRecepcion {
  documentId: string;
  numero: string;
  proveedor: string;
  branchId: string;
  sucursal: string;
  /** Si ya se decidió, esto es lo que se decidió. */
  yaDecidida: { resolucion: Resolucion; receivedAt: Date; decididaPor: string | null } | null;
  cutoffAt: Date | null;
  /**
   * El corte como hora de pared argentina, `YYYY-MM-DDTHH:MM`.
   *
   * Existe para que la pantalla pueda comparar contra lo que la persona escribe
   * en los campos de fecha y hora sin suponer ningún desfase horario. La
   * comparación que vale es la del servidor, sobre instantes; ésta es para que
   * el resumen diga lo mismo antes de confirmar.
   */
  corteLocal: string | null;
  sucursalConApertura: boolean;
  aperturaFicticia: boolean | null;
  renglones: RenglonDeRecepcion[];
  /** Lo que impide aplicar. Vacío = se puede. */
  impedimentos: string[];
  /** La resolución que corresponde con la fecha de recepción propuesta. */
  resolucionPrevista: Resolucion | null;
}

/**
 * Qué pasaría si se recibiera este comprobante en esa fecha.
 *
 * **No escribe nada.** Ni una fila, ni un contador, ni una marca de «visto».
 * Mirar no puede cambiar el estado de nada: si lo hiciera, dos personas
 * consultando la misma pantalla producirían resultados distintos.
 */
export async function vistaPreviaDeRecepcion(
  user: AuthUser,
  input: { documentId: string; receivedAt?: Date | null },
): Promise<VistaPreviaDeRecepcion> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_VER, {
    entity: 'StockReceipt',
    entityId: input.documentId,
  });

  const doc = await prisma.document.findUnique({
    where: { id: input.documentId },
    include: {
      supplier: { select: { tradeName: true } },
      branch: { select: { id: true, name: true } },
      stockReceipt: { include: { decidedBy: { select: { name: true } } } },
      items: {
        orderBy: { id: 'asc' },
        include: {
          product: {
            select: {
              id: true,
              internalCode: true,
              active: true,
              stockConfig: { select: { status: true, stockUnit: true } },
            },
          },
        },
      },
    },
  });
  if (!doc) throw new NotFoundError('No existe ese comprobante.');

  const apertura = await prisma.stockCountSession.findFirst({
    where: { branchId: doc.branchId, status: 'CONFIRMADA' },
    select: { cutoffAt: true, ficticia: true },
  });

  const impedimentos: string[] = [];
  if (doc.status !== 'VALIDADO') {
    impedimentos.push(
      `El comprobante está en ${doc.status}. Sólo se recibe la mercadería de un comprobante validado.`,
    );
  }
  if (!apertura) {
    impedimentos.push(
      'La sucursal no tiene apertura de Stock ERP confirmada. Sin apertura no hay saldo sobre el cual recibir: sus artículos no están en cero, están sin contar.',
    );
  }

  const renglones: RenglonDeRecepcion[] = [];
  /* El saldo previsto se acumula por producto: dos renglones del mismo
     artículo tienen que verse encadenados, no cada uno desde el mismo saldo. */
  const saldoAcumulado = new Map<string, Decimal>();

  for (const it of doc.items) {
    const base = {
      documentItemId: it.id,
      lineNumber: it.lineNumber,
      descripcion: it.description,
      plu: it.product?.internalCode ?? null,
      productId: it.productId,
      cantidadFacturada: it.quantity.toString(),
      unidadFacturada: it.unit,
      cantidadDeExistencia: null as string | null,
      unidadDeExistencia: null as string | null,
      factorUsado: null as string | null,
      piezas: it.pieceCount,
      pesoRealKg: it.totalWeightKg?.toString() ?? null,
      saldoAnterior: null as string | null,
      saldoPrevisto: null as string | null,
    };

    /* Los gastos salen primero y sin condiciones: no son mercadería. */
    if (it.expenseKind) {
      renglones.push({
        ...base,
        clase: 'GASTO_SIN_IMPACTO',
        motivo: `Gasto del comprobante (${it.expenseKind}): se paga con la factura y no mueve existencias.`,
      });
      continue;
    }

    if (!it.productId || !it.product) {
      renglones.push({
        ...base,
        clase: 'BLOQUEADO',
        motivo:
          'El renglón no tiene artículo asociado. No se crea ninguno acá: el alta del catálogo pasa por su sincronización.',
      });
      continue;
    }
    if (!it.product.active) {
      renglones.push({ ...base, clase: 'BLOQUEADO', motivo: 'El artículo está inactivo en el catálogo.' });
      continue;
    }
    const cfg = it.product.stockConfig;
    if (cfg?.status !== 'APROBADA' || !cfg.stockUnit) {
      renglones.push({
        ...base,
        clase: 'BLOQUEADO',
        motivo:
          'El artículo no tiene unidad de existencia aprobada. Hasta que alguien la apruebe no se puede recibir: no se sabría en qué contar lo que entra.',
      });
      continue;
    }

    const conv = await convertirAUnidadDeExistencia({
      productId: it.productId,
      /*
       * La unidad del papel se pasa tal cual. El ternario que había acá
       * —`=== 'UNIT' ? 'UNIT' : 'KG'`— mandaba a KG cualquier valor inesperado,
       * y un valor por omisión silencioso en la unidad es justo lo que no puede
       * haber: convertiría una caja en un kilo sin que nadie se entere.
       * `PurchaseUnit` y `StockUnit` son KG|UNIT las dos, así que no hay nada
       * que traducir.
       */
      unidadFacturada: it.unit,
      cantidad: it.quantity.toString(),
      proveedorId: doc.supplierId,
      codigoDelProveedor: it.supplierCode,
    });
    if (!conv.ok) {
      renglones.push({ ...base, clase: 'BLOQUEADO', motivo: conv.motivo });
      continue;
    }

    const cantidad = conv.cantidadEnUnidadDeExistencia;
    if (!cantidad.equals(cantidad.toDecimalPlaces(3))) {
      renglones.push({
        ...base,
        clase: 'BLOQUEADO',
        motivo: `La cantidad convertida (${cantidad.toString()}) tiene más de tres decimales. Redondearla en silencio sería inventar existencias.`,
      });
      continue;
    }

    const saldo = await prisma.stockBalance.findUnique({
      where: { productId_branchId: { productId: it.productId, branchId: doc.branchId } },
    });
    const anterior =
      saldoAcumulado.get(it.productId) ?? new Decimal(saldo?.quantity?.toString() ?? '0');
    const previsto = anterior.plus(cantidad);
    saldoAcumulado.set(it.productId, previsto);

    renglones.push({
      ...base,
      clase: 'MERCADERIA',
      motivo: null,
      cantidadDeExistencia: cantidad.toString(),
      unidadDeExistencia: conv.unidad,
      factorUsado: conv.factor,
      saldoAnterior: anterior.toString(),
      saldoPrevisto: previsto.toString(),
    });
  }

  const bloqueados = renglones.filter((r) => r.clase === 'BLOQUEADO');
  for (const b of bloqueados) {
    impedimentos.push(`Renglón ${b.lineNumber} (${b.descripcion}): ${b.motivo}`);
  }

  const conMercaderia = renglones.some((r) => r.clase === 'MERCADERIA');
  const receivedAt = input.receivedAt ?? null;

  let resolucionPrevista: Resolucion | null = null;
  if (!conMercaderia && bloqueados.length === 0) {
    resolucionPrevista = 'EXCLUIDA';
  } else if (receivedAt && apertura?.cutoffAt) {
    resolucionPrevista =
      receivedAt.getTime() <= apertura.cutoffAt.getTime() ? 'INCLUIDA_EN_APERTURA' : 'APLICADA';
  }

  if (conMercaderia && !receivedAt) {
    impedimentos.push(
      'Falta la fecha y hora en que llegó físicamente la mercadería. No se toma de la fecha del comprobante: son dos cosas distintas.',
    );
  }

  return {
    documentId: doc.id,
    numero: doc.fullNumber ?? `${doc.pointOfSale ?? ''}-${doc.number ?? ''}`,
    proveedor: doc.supplier?.tradeName ?? '—',
    branchId: doc.branchId,
    sucursal: doc.branch.name,
    yaDecidida: doc.stockReceipt
      ? {
          resolucion: doc.stockReceipt.resolution as Resolucion,
          receivedAt: doc.stockReceipt.receivedAt,
          decididaPor: doc.stockReceipt.decidedBy?.name ?? null,
        }
      : null,
    cutoffAt: apertura?.cutoffAt ?? null,
    corteLocal: apertura?.cutoffAt
      ? `${arTodayISO(apertura.cutoffAt)}T${horaArgentinaISO(apertura.cutoffAt)}`
      : null,
    sucursalConApertura: !!apertura,
    aperturaFicticia: apertura?.ficticia ?? null,
    renglones,
    impedimentos,
    resolucionPrevista,
  };
}

/* ========================================================================== *
 * Los pendientes, calculados
 * ========================================================================== */

export interface RecepcionPendiente {
  documentId: string;
  numero: string;
  proveedor: string;
  sucursal: string;
  branchId: string;
  issueDate: Date | null;
  renglonesDeMercaderia: number;
}

export async function recepcionesPendientes(
  user: AuthUser,
  filtro: { texto?: string; branchId?: string; limite?: number } = {},
): Promise<RecepcionPendiente[]> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_VER, { entity: 'StockReceipt' });

  const texto = filtro.texto?.trim();
  const docs = await prisma.document.findMany({
    where: {
      status: 'VALIDADO',
      /* Sin decisión registrada: eso, y no una cola, es «pendiente». */
      stockReceipt: null,
      /* Con al menos un renglón que podría ser mercadería. */
      items: { some: { expenseKind: null } },
      ...(filtro.branchId ? { branchId: filtro.branchId } : {}),
      ...(texto
        ? {
            OR: [
              { fullNumber: { contains: texto, mode: 'insensitive' } },
              { number: { contains: texto, mode: 'insensitive' } },
              { supplier: { tradeName: { contains: texto, mode: 'insensitive' } } },
              { branch: { name: { contains: texto, mode: 'insensitive' } } },
              { items: { some: { description: { contains: texto, mode: 'insensitive' } } } },
              { items: { some: { product: { internalCode: { contains: texto } } } } },
            ],
          }
        : {}),
    },
    include: {
      supplier: { select: { tradeName: true } },
      branch: { select: { name: true } },
      items: { where: { expenseKind: null }, select: { id: true } },
    },
    orderBy: { issueDate: 'desc' },
    take: filtro.limite ?? 100,
  });

  return docs.map((d) => ({
    documentId: d.id,
    numero: d.fullNumber ?? `${d.pointOfSale ?? ''}-${d.number ?? ''}`,
    proveedor: d.supplier?.tradeName ?? '—',
    sucursal: d.branch.name,
    branchId: d.branchId,
    issueDate: d.issueDate,
    renglonesDeMercaderia: d.items.length,
  }));
}

/** Las decisiones ya tomadas, para el listado. */
export async function recepcionesDecididas(user: AuthUser, limite = 100) {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_VER, { entity: 'StockReceipt' });
  return prisma.stockReceipt.findMany({
    include: {
      document: { select: { fullNumber: true, supplier: { select: { tradeName: true } } } },
      branch: { select: { name: true } },
      decidedBy: { select: { name: true } },
      operation: { select: { movementCount: true } },
    },
    orderBy: { decidedAt: 'desc' },
    take: limite,
  });
}

/* ========================================================================== *
 * El listado, en sus seis grupos
 * ========================================================================== */

export interface FilaPendiente extends RecepcionPendiente {
  /** Vacío si no hay nada que lo frene. */
  motivos: string[];
  cutoffAt: Date | null;
}

export interface ListadoDeRecepciones {
  /** Listas para recibir: nada las frena. */
  pendientes: FilaPendiente[];
  /** Algo las frena, y el motivo está a la vista. */
  bloqueadas: FilaPendiente[];
  /** El comprobante es anterior o igual al corte de su sucursal. */
  anterioresAlCorte: FilaPendiente[];
  decididas: Awaited<ReturnType<typeof recepcionesDecididas>>;
  /** Cuántos pendientes se miraron. Si se llegó al tope, hay más. */
  mirados: number;
  tope: number;
}

/**
 * Los seis grupos de la pantalla.
 *
 * Los tres primeros se calculan **con la misma vista previa** que después se
 * muestra al abrir el comprobante, y no con una versión resumida. Tener dos
 * clasificadores distintos es cómo se llega a que el listado diga «lista para
 * recibir» y la pantalla siguiente diga «bloqueada»: se pagan más consultas a
 * cambio de que no puedan contradecirse.
 *
 * El grupo «anteriores al corte» usa la fecha del COMPROBANTE, y es sólo un
 * aviso. La decisión la toma la fecha en que llegó físicamente la mercadería,
 * que la carga una persona en la pantalla siguiente y puede ser posterior.
 */
export async function listadoDeRecepciones(
  user: AuthUser,
  filtro: { texto?: string; branchId?: string; tope?: number } = {},
): Promise<ListadoDeRecepciones> {
  const tope = filtro.tope ?? 40;
  const pendientes = await recepcionesPendientes(user, { ...filtro, limite: tope });

  const listas: FilaPendiente[] = [];
  const bloqueadas: FilaPendiente[] = [];
  const anteriores: FilaPendiente[] = [];

  for (const p of pendientes) {
    const previa = await vistaPreviaDeRecepcion(user, { documentId: p.documentId });
    /*
     * La falta de fecha física NO es un impedimento del comprobante: es lo que
     * la persona va a cargar. Se saca de la lista de motivos para que no
     * aparezcan todos los pendientes marcados como bloqueados.
     */
    const motivos = previa.impedimentos.filter((m) => !m.startsWith('Falta la fecha y hora'));
    const fila: FilaPendiente = { ...p, motivos, cutoffAt: previa.cutoffAt };

    if (motivos.length > 0) bloqueadas.push(fila);
    else if (previa.cutoffAt && p.issueDate && p.issueDate.getTime() <= previa.cutoffAt.getTime())
      anteriores.push(fila);
    else listas.push(fila);
  }

  return {
    pendientes: listas,
    bloqueadas,
    anterioresAlCorte: anteriores,
    decididas: await recepcionesDecididas(user, 100),
    mirados: pendientes.length,
    tope,
  };
}

/* ========================================================================== *
 * La huella
 * ========================================================================== */

export function claveDeRecepcion(documentId: string): string {
  return `recepcion:${documentId}`;
}

export function huellaDeRecepcion(datos: {
  documentId: string;
  branchId: string;
  receivedAt: Date;
  resolucion: Resolucion;
  renglones: RenglonDeRecepcion[];
}): string {
  const ordenadas = [...datos.renglones].sort((a, b) =>
    a.documentItemId.localeCompare(b.documentItemId),
  );
  const texto = [
    `v${VERSION_DE_LA_HUELLA_DE_RECEPCION}`,
    'tipo:RECEPCION_COMPRA',
    `documento:${datos.documentId}`,
    `sucursal:${datos.branchId}`,
    `recibido:${datos.receivedAt.toISOString()}`,
    `resolucion:${datos.resolucion}`,
    ...ordenadas.map((r) =>
      [
        r.documentItemId,
        r.productId ?? 'sin-producto',
        r.plu ?? 'sin-plu',
        datos.branchId,
        r.clase,
        r.motivo ?? 'sin-motivo',
        r.clase === 'MERCADERIA' ? 'PURCHASE_IN' : 'sin-tipo',
        r.clase === 'MERCADERIA' ? 'IN' : 'sin-direccion',
        /* Canónica a tres decimales: «3» y «3.000» son la misma cantidad. */
        r.cantidadDeExistencia === null
          ? 'sin-cantidad'
          : new Decimal(r.cantidadDeExistencia).toDecimalPlaces(3).toString(),
        r.unidadDeExistencia ?? 'sin-unidad',
        new Decimal(r.cantidadFacturada).toString(),
        r.unidadFacturada,
        r.piezas === null ? 'sin-piezas' : String(r.piezas),
        r.pesoRealKg === null ? 'sin-peso' : new Decimal(r.pesoRealKg).toString(),
        r.factorUsado ?? 'sin-presentacion',
        datos.receivedAt.toISOString(),
      ].join('|'),
    ),
  ].join('\n');
  return createHash('sha256').update(texto).digest('hex');
}

/* ========================================================================== *
 * Aplicar: todo o nada
 * ========================================================================== */

export interface ResultadoDeRecepcion {
  ok: true;
  yaEstabaAplicada: boolean;
  operationId: string | null;
  documentId: string;
  resolucion: Resolucion;
  movimientos: number;
  receivedAt: string;
}

export interface RecibirInput {
  documentId: string;
  /** Fecha y hora **argentinas** en que llegó la mercadería. */
  fecha: string;
  hora: string;
  confirmado: boolean;
  /** Motivo, obligatorio si la resolución no escribe libro. */
  motivo?: string | null;
  /**
   * Dejar constancia de que la mercadería anterior al corte está discutida:
   * alguien sostiene que no se contó en la apertura.
   *
   * Exige `stockerp.excepcion.historica` y **no cambia lo que se escribe**: la
   * resolución sigue siendo `INCLUIDA_EN_APERTURA`, con cero movimientos. Lo
   * único que agrega es el motivo, la marca de decisión forzada y la auditoría.
   * La diferencia de existencias que eso implique se arregla con un
   * `INVENTORY_CORRECTION`, que es de una fase futura y todavía no existe.
   */
  excepcionHistorica?: boolean;
}

/**
 * Un comprobante que ya tiene decisión: comparar y contestar.
 *
 * Una sola función para las dos veces que hace falta —antes de abrir la
 * transacción y adentro, después de bloquear— porque si las dos comparaciones
 * no dijeran exactamente lo mismo, el resultado dependería de quién llegó
 * primero.
 *
 * Nunca escribe. Un conflicto es una respuesta, no un asiento.
 */
async function compararConLoGuardado(
  cliente: Pick<typeof prisma, 'stockReceipt' | 'stockOperation'>,
  documentId: string,
  huellaEsperada: string,
  receivedAt: Date,
): Promise<ResultadoDeRecepcion> {
  const recibo = await cliente.stockReceipt.findUnique({
    where: { documentId },
    include: { operation: true },
  });
  if (!recibo) {
    /* Se decidió y desapareció entre dos lecturas: no se inventa un resultado. */
    throw new ConflictError(
      'La decisión de recepción cambió mientras se confirmaba. No se escribió nada: volvé a mirar la vista previa.',
    );
  }
  const op = recibo.operation;
  if (
    op &&
    op.hashVersion === VERSION_DE_LA_HUELLA_DE_RECEPCION &&
    op.contentHash === huellaEsperada
  ) {
    return {
      ok: true,
      yaEstabaAplicada: true,
      operationId: op.id,
      documentId,
      resolucion: recibo.resolution as Resolucion,
      movimientos: op.movementCount,
      receivedAt: recibo.receivedAt.toISOString(),
    };
  }
  throw new ConflictError(
    `Este comprobante ya tiene una recepción registrada (${recibo.resolution}, recibida el ` +
      `${formatCorteAr(recibo.receivedAt)}) con un contenido distinto del que estás confirmando ` +
      `(${formatCorteAr(receivedAt)}). No se escribió nada. La fecha de recepción no se cambia ` +
      `después de decidida.`,
  );
}

export async function aplicarIngresoDeCompra(
  user: AuthUser,
  input: RecibirInput,
): Promise<ResultadoDeRecepcion> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_RECEPCION_CONFIRMAR, {
    entity: 'StockReceipt',
    entityId: input.documentId,
    detalle: 'confirmar recepción',
  });
  if (input.excepcionHistorica) {
    await exigirPermiso(user, PERMISSIONS.STOCKERP_EXCEPCION_HISTORICA, {
      entity: 'StockReceipt',
      entityId: input.documentId,
      detalle: 'documentar una excepción histórica',
    });
    if (!input.motivo?.trim()) {
      throw new ValidationError(
        'Documentar una excepción histórica exige escribir por qué. Es lo único que la excepción produce: una constancia.',
      );
    }
  }
  if (!input.confirmado) {
    throw new ValidationError(
      'Falta la segunda confirmación. Recibir mercadería escribe el libro de existencias y no se deshace.',
    );
  }

  const receivedAt = instanteDesdeHoraArgentina(input.fecha, input.hora);

  /*
   * Ante un fallo de serialización se reintenta la operación entera, con la
   * MISMA clave: es lo que hace que el reintento sea inofensivo. Tres veces y
   * después se rinde, porque un cuarto intento que falla igual ya no es una
   * carrera sino un problema.
   */
  for (let intento = 1; intento <= 3; intento += 1) {
    try {
      return await aplicar(user, input, receivedAt);
    } catch (e) {
      const codigo = e instanceof Prisma.PrismaClientKnownRequestError ? e.code : null;
      if (codigo === 'P2002') return await resolverCarrera(user, input, receivedAt);
      const serializacion =
        e instanceof Prisma.PrismaClientUnknownRequestError &&
        /40001|could not serialize/i.test(e.message);
      if (serializacion && intento < 3) continue;
      throw e;
    }
  }
  throw new ConflictError('La recepción no se pudo aplicar después de tres intentos.');
}

async function aplicar(
  user: AuthUser,
  input: RecibirInput,
  receivedAt: Date,
): Promise<ResultadoDeRecepcion> {
  /* La vista previa se calcula FUERA de la transacción y se revalida adentro. */
  const previa = await vistaPreviaDeRecepcion(user, {
    documentId: input.documentId,
    receivedAt,
  });

  /*
   * YA DECIDIDA: antes de contestar «ya estaba aplicada» hay que COMPARAR.
   *
   * Contestar que ya estaba aplicada sin mirar el contenido es lo que hace que
   * una segunda confirmación con otra fecha de recepción parezca haber sido
   * atendida cuando en realidad se ignoró. El reintento legítimo manda la misma
   * fecha y hora, así que da la misma huella; cualquier otra cosa es un
   * conflicto y se contesta como tal, sin escribir nada.
   *
   * Va antes del control del interruptor a propósito: si alguien lo apagó
   * después de aplicar, el reintento tiene que seguir devolviendo lo que ya
   * pasó, no un rechazo.
   */
  if (previa.yaDecidida) {
    if (!previa.resolucionPrevista) {
      throw new ConflictError(
        'Este comprobante ya tiene una recepción decidida y no se pudo recalcular para compararla. No se escribió nada.',
      );
    }
    return await compararConLoGuardado(
      prisma,
      input.documentId,
      huellaDeRecepcion({
        documentId: input.documentId,
        branchId: previa.branchId,
        receivedAt,
        resolucion: previa.resolucionPrevista,
        renglones: previa.renglones,
      }),
      receivedAt,
    );
  }

  if (previa.impedimentos.length > 0) {
    throw new ValidationError(`No se puede recibir: ${previa.impedimentos.join(' · ')}`);
  }
  if (!previa.resolucionPrevista) {
    throw new ValidationError('No se pudo determinar qué corresponde hacer con este comprobante.');
  }

  const resolucion = previa.resolucionPrevista;

  /*
   * La excepción histórica NO es una llave que abra el corte.
   *
   * Si la mercadería llegó después del corte, no hay nada histórico que
   * documentar: entra por la puerta normal. Y si llegó antes, lo único que la
   * excepción hace es dejar constancia de una decisión SIN movimientos. En
   * ninguno de los dos casos escribe un asiento con fecha anterior al corte:
   * eso sumaría historia vieja sobre un saldo que ya la contiene.
   */
  if (input.excepcionHistorica && resolucion !== 'INCLUIDA_EN_APERTURA') {
    throw new ValidationError(
      'La excepción histórica sólo aplica a mercadería que llegó en la fecha del corte o antes. ' +
        'Esta recepción es posterior al corte y entra por el camino normal.',
    );
  }

  /* El interruptor, antes de tocar nada. La base lo vuelve a comprobar. */
  if (resolucion === 'APLICADA') {
    if (previa.aperturaFicticia) {
      if (!esUnaBaseDePruebas(process.env.DATABASE_URL)) {
        throw new ForbiddenError(
          'Esta base no admite datos de homologación, y la apertura de la sucursal es ficticia.',
        );
      }
    } else {
      const { encendido } = await interruptorDeRecepcionesReales();
      if (!encendido) {
        await recordAudit({
          userId: user.id,
          action: AUDIT_ACTIONS.STOCKERP_BLOQUEADO_INTERRUPTOR,
          entity: 'StockReceipt',
          entityId: input.documentId,
          after: { motivo: 'El interruptor de recepciones reales está apagado.' },
        });
        throw new ForbiddenError(
          'El interruptor de recepciones reales de Stock ERP está apagado. Los saldos todavía no incluyen ventas, así que recibir mercadería real haría crecer un inventario que nada descuenta.',
        );
      }
    }
  }

  const clave = claveDeRecepcion(input.documentId);
  const huella = huellaDeRecepcion({
    documentId: input.documentId,
    branchId: previa.branchId,
    receivedAt,
    resolucion,
    renglones: previa.renglones,
  });

  return prisma.$transaction(async (tx) => {
    /* 1. Bloquear y releer el comprobante. */
    await tx.$executeRaw`SELECT id FROM "documents" WHERE id = ${input.documentId} FOR UPDATE`;
    const doc = await tx.document.findUnique({
      where: { id: input.documentId },
      include: { stockReceipt: true },
    });
    if (!doc) throw new NotFoundError('No existe ese comprobante.');

    /* 2. Sigue validado. */
    if (doc.status !== 'VALIDADO') {
      throw new ValidationError(`El comprobante cambió a ${doc.status} mientras se confirmaba.`);
    }
    /*
     * Alguien decidió entre que se calculó la vista previa y que se tomó el
     * bloqueo. Misma comparación que afuera: la huella decide, no el hecho de
     * que exista una fila.
     */
    if (doc.stockReceipt) {
      return await compararConLoGuardado(tx, doc.id, huella, receivedAt);
    }

    /* 3. La operación con la misma clave, si ya existe. */
    const opPrevia = await tx.stockOperation.findUnique({ where: { operationKey: clave } });
    if (opPrevia) {
      if (
        opPrevia.hashVersion === VERSION_DE_LA_HUELLA_DE_RECEPCION &&
        opPrevia.contentHash === huella
      ) {
        return {
          ok: true as const,
          yaEstabaAplicada: true,
          operationId: opPrevia.id,
          documentId: doc.id,
          resolucion,
          movimientos: opPrevia.movementCount,
          receivedAt: receivedAt.toISOString(),
        };
      }
      throw new ConflictError(
        'Ya se aplicó una recepción para este comprobante con un contenido distinto. No se escribe nada: revisá qué cambió.',
      );
    }

    /*
     * Las resoluciones que NO escriben libro se registran igual, con su
     * operación y su huella. Que no muevan existencias no las hace menos
     * decisiones: «esto ya estaba en la apertura» es exactamente lo que impide
     * que alguien lo reciba después por las dudas.
     */
    if (resolucion !== 'APLICADA') {
      const operacion = await tx.stockOperation.create({
        data: {
          operationKey: clave,
          kind: 'RECEPCION_COMPRA',
          hashVersion: VERSION_DE_LA_HUELLA_DE_RECEPCION,
          contentHash: huella,
          documentId: doc.id,
          branchId: doc.branchId,
          requestedById: user.id,
          receivedAt,
          movementCount: 0,
          result: { resolucion, movimientos: 0, receivedAt: receivedAt.toISOString() },
        },
      });
      await tx.stockReceipt.create({
        data: {
          documentId: doc.id,
          branchId: doc.branchId,
          receivedAt,
          resolution: resolucion,
          operationId: operacion.id,
          decidedById: user.id,
          reason:
            input.motivo?.trim() ||
            (resolucion === 'INCLUIDA_EN_APERTURA'
              ? 'La mercadería llegó en la fecha del corte o antes: ya está contada en la apertura.'
              : 'El comprobante no tiene mercadería con impacto en existencias.'),
          manualOverride: input.excepcionHistorica === true,
        },
      });
      await recordAudit(
        {
          userId: user.id,
          action: AUDIT_ACTIONS.STOCKERP_RECEPCION_DECIDIDA,
          entity: 'StockReceipt',
          entityId: doc.id,
          after: {
            resolucion,
            receivedAt: receivedAt.toISOString(),
            movimientos: 0,
            huella,
            excepcionHistorica: input.excepcionHistorica === true,
            motivo: input.motivo?.trim() ?? null,
          },
        },
        tx,
      );
      return {
        ok: true as const,
        yaEstabaAplicada: false,
        operationId: operacion.id,
        documentId: doc.id,
        resolucion,
        movimientos: 0,
        receivedAt: receivedAt.toISOString(),
      };
    }

    /* --- APLICADA: acá sí se escribe el libro --------------------------- */

    const operacion = await tx.stockOperation.create({
      data: {
        operationKey: clave,
        kind: 'RECEPCION_COMPRA',
        hashVersion: VERSION_DE_LA_HUELLA_DE_RECEPCION,
        contentHash: huella,
        documentId: doc.id,
        branchId: doc.branchId,
        requestedById: user.id,
        receivedAt,
      },
    });

    /*
     * Orden determinístico por `documentItemId`.
     *
     * Dos renglones del MISMO producto generan dos movimientos, cada uno con su
     * `documentItemId`, y el saldo se encadena: el `balanceAfterSeq` del
     * segundo parte del primero. Agruparlos en uno solo perdería de qué renglón
     * salió cada cosa, que es justo lo que después nadie puede reconstruir.
     */
    const aEscribir = previa.renglones
      .filter((r) => r.clase === 'MERCADERIA')
      .sort((a, b) => a.documentItemId.localeCompare(b.documentItemId));

    /* Bloqueo de saldos en orden determinístico, para no abrazarse. */
    const productos = [...new Set(aEscribir.map((r) => r.productId!))].sort();
    for (const pid of productos) {
      await tx.$executeRaw`SELECT id FROM "stock_balance" WHERE "productId" = ${pid} AND "branchId" = ${doc.branchId} FOR UPDATE`;
    }

    const saldoVivo = new Map<string, Decimal>();
    let movimientos = 0;

    for (const r of aEscribir) {
      const pid = r.productId!;
      const cantidad = new Decimal(r.cantidadDeExistencia!);
      const saldoActual = await tx.stockBalance.findUnique({
        where: { productId_branchId: { productId: pid, branchId: doc.branchId } },
      });
      const anterior =
        saldoVivo.get(pid) ?? new Decimal(saldoActual?.quantity?.toString() ?? '0');
      const posterior = anterior.plus(cantidad);
      saldoVivo.set(pid, posterior);

      const movId = `${operacion.id}-${r.documentItemId}`;
      await tx.$executeRaw`
        INSERT INTO "stock_ledger"
          ("id","txId","productId","pluHistorico","branchId","type","direction",
           "quantity","unit","effectiveAt","operationId","userId","idempotencyKey",
           "balanceAfterSeq","documentId","documentItemId","invoicedQuantity",
           "invoicedUnit","pieceCount","realWeightKg","conversionFactorUsed",
           "reason","createdAt")
        VALUES (${movId}, txid_current(), ${pid}, ${r.plu ?? ''}, ${doc.branchId},
                'PURCHASE_IN'::"StockMovementType", 'IN'::"StockDirection",
                ${cantidad.toString()}::numeric, ${r.unidadDeExistencia!}::"StockUnit",
                ${receivedAt}, ${operacion.id}, ${user.id},
                ${`${clave}:${r.documentItemId}`}, ${posterior.toString()}::numeric,
                ${doc.id}, ${r.documentItemId},
                ${r.cantidadFacturada}::numeric, ${r.unidadFacturada}::"StockUnit",
                ${r.piezas}, ${r.pesoRealKg}::numeric, ${r.factorUsado}::numeric,
                'Recepción de compra', now())`;

      if (saldoActual) {
        await tx.stockBalance.update({
          where: { id: saldoActual.id },
          data: {
            quantity: posterior.toString(),
            lastLedgerId: movId,
            lastOperationId: operacion.id,
            version: { increment: 1 },
          },
        });
      } else {
        /*
         * Un artículo que entró al catálogo después del corte nunca tuvo
         * apertura. Su saldo nace acá, y se marca como tal: mezclarlo con los
         * que vienen de un conteo borraría la diferencia entre «se contó» y
         * «apareció después».
         */
        await tx.stockBalance.create({
          data: {
            productId: pid,
            branchId: doc.branchId,
            quantity: posterior.toString(),
            unit: r.unidadDeExistencia! as 'KG' | 'UNIT',
            lastLedgerId: movId,
            lastOperationId: operacion.id,
            openingSource: 'POSTERIOR_AL_CORTE',
          },
        });
      }
      movimientos += 1;
    }

    const resultado = {
      resolucion,
      movimientos,
      receivedAt: receivedAt.toISOString(),
      documentId: doc.id,
      renglones: aEscribir.map((r) => ({
        documentItemId: r.documentItemId,
        plu: r.plu,
        cantidad: r.cantidadDeExistencia,
        unidad: r.unidadDeExistencia,
      })),
    };
    await tx.stockOperation.update({
      where: { id: operacion.id },
      data: { movementCount: movimientos, result: resultado },
    });
    await tx.stockReceipt.create({
      data: {
        documentId: doc.id,
        branchId: doc.branchId,
        receivedAt,
        resolution: 'APLICADA',
        operationId: operacion.id,
        decidedById: user.id,
        reason: input.motivo?.trim() || null,
      },
    });
    await recordAudit(
      {
        userId: user.id,
        action: AUDIT_ACTIONS.STOCKERP_RECEPCION_APLICADA,
        entity: 'StockReceipt',
        entityId: doc.id,
        after: { ...resultado, huella },
      },
      tx,
    );

    return {
      ok: true as const,
      yaEstabaAplicada: false,
      operationId: operacion.id,
      documentId: doc.id,
      resolucion,
      movimientos,
      receivedAt: receivedAt.toISOString(),
    };
  });
}

/**
 * Dos confirmaciones a la vez: una ganó y la otra chocó con la unicidad.
 *
 * Una violación de unicidad **no demuestra** idempotencia por sí sola: sólo
 * dice que hubo un choque. Hay que releer en una transacción NUEVA —la anterior
 * abortó— y comparar versión y huella.
 */
async function resolverCarrera(
  user: AuthUser,
  input: RecibirInput,
  receivedAt: Date,
): Promise<ResultadoDeRecepcion> {
  const clave = claveDeRecepcion(input.documentId);
  const op = await prisma.stockOperation.findUnique({ where: { operationKey: clave } });
  const recibo = await prisma.stockReceipt.findUnique({ where: { documentId: input.documentId } });

  const previa = await vistaPreviaDeRecepcion(user, { documentId: input.documentId, receivedAt });
  const resolucion = previa.yaDecidida?.resolucion ?? previa.resolucionPrevista;
  if (!resolucion) {
    throw new ConflictError('Otra confirmación se adelantó y no se pudo resolver el estado.');
  }
  const huella = huellaDeRecepcion({
    documentId: input.documentId,
    branchId: previa.branchId,
    receivedAt: recibo?.receivedAt ?? receivedAt,
    resolucion,
    renglones: previa.renglones,
  });

  if (op && op.hashVersion === VERSION_DE_LA_HUELLA_DE_RECEPCION && op.contentHash === huella) {
    await recordAudit({
      userId: user.id,
      action: AUDIT_ACTIONS.STOCKERP_RECEPCION_SIMULTANEA,
      entity: 'StockReceipt',
      entityId: input.documentId,
      after: { resuelto: 'ALREADY_APPLIED', operationId: op.id },
    });
    return {
      ok: true,
      yaEstabaAplicada: true,
      operationId: op.id,
      documentId: input.documentId,
      resolucion,
      movimientos: op.movementCount,
      receivedAt: (recibo?.receivedAt ?? receivedAt).toISOString(),
    };
  }

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.STOCKERP_CONFLICTO_DE_HUELLA,
    entity: 'StockReceipt',
    entityId: input.documentId,
    after: { huellaEsperada: huella, huellaGuardada: op?.contentHash ?? null },
  });
  throw new ConflictError(
    'Otra confirmación se adelantó con un contenido distinto. No se escribió nada: mirá la vista previa antes de volver a intentar.',
  );
}
