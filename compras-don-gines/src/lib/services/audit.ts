import 'server-only';
import { headers } from 'next/headers';
import { prisma, type Prisma } from '@/lib/db';

/**
 * Auditoría de operaciones sensibles.
 *
 * Nunca hace fallar la operación que está auditando: si el registro no se puede
 * escribir, se deja constancia en el log del servidor y la operación sigue. Un
 * problema al auditar no puede convertirse en una factura que no se guarda.
 */

export const AUDIT_ACTIONS = {
  LOGIN: 'sesion.ingreso',
  PRODUCT_BACKFILL: 'productos.reasignados',
  CATALOG_IMPORTED: 'catalogo.importado',
  DOCUMENT_REPAIRED: 'comprobante.derivados_reparados',
  LOGIN_FAILED: 'sesion.ingreso_fallido',
  LOGOUT: 'sesion.salida',
  DOCUMENT_CREATED: 'comprobante.creado',
  DOCUMENT_READ: 'comprobante.leido',
  CENTAVOS_CONCILIADOS: 'comprobante.centavos_conciliados',
  DOCUMENT_CONFIRMED: 'comprobante.confirmado',
  /**
   * Lo que una persona corrigió a mano sobre lo que había leído el OCR.
   *
   * Es un asiento aparte del de confirmación a propósito: «se confirmó el
   * comprobante» y «se cambiaron estos siete valores respecto de lo leído» son
   * dos preguntas distintas, y la segunda es la que hay que poder contestar
   * meses después, cuando alguien discute un costo.
   */
  DOCUMENT_CORRECTED: 'comprobante.corregido_a_mano',
  DOCUMENT_OVERRIDDEN: 'comprobante.forzado',
  DOCUMENT_VOIDED: 'comprobante.anulado',
  DOCUMENT_REJECTED: 'comprobante.rechazado',
  CREDIT_NOTE_CONFIRMED: 'nota_credito.confirmada',
  PAYMENT_CONFIRMED: 'pago.confirmado',
  PAYMENT_RESCHEDULED: 'pago.reprogramado',
  PAYMENT_CANCELLED: 'pago.cancelado',
  PRICE_APPROVED: 'precio.aprobado',
  USER_CREATED: 'usuario.creado',
  USER_UPDATED: 'usuario.modificado',
  PASSWORD_CHANGED: 'usuario.contrasena_cambiada',
  PASSWORD_CHANGE_FAILED: 'usuario.contrasena_cambio_fallido',
  PASSWORD_RECOVERED_BY_SEED: 'usuario.contrasena_restablecida_seed',
  ROLE_UPDATED: 'rol.modificado',
  BRANCH_UPDATED: 'sucursal.modificada',
  SUPPLIER_UPDATED: 'proveedor.modificado',
  SUPPLIER_CREATED_FROM_READING: 'proveedor.creado_desde_lectura',
  PRODUCT_UPDATED: 'producto.modificado',
  PRODUCT_ALIAS_LEARNED: 'producto.alias_aprendido',
  FAMILY_MARKUPS_UPDATED: 'familia.marcajes_modificados',
  GENERAL_MARKUPS_UPDATED: 'regla_general.marcajes_modificados',
  STOCK_SYNCED: 'catalogo.sincronizado_con_stock',
  IMAGENES_ARCHIVADAS: 'imagenes.archivadas',
  STOCK_DESPACHADO: 'stock.movimientos_despachados',

  /* --- Stock ERP, fase 2: unidades y presentaciones --------------------- */
  STOCKERP_CONFIG_CREADA: 'stockerp.configuracion_creada',
  STOCKERP_UNIDAD_APROBADA: 'stockerp.unidad_aprobada',
  STOCKERP_UNIDAD_MODIFICADA: 'stockerp.unidad_modificada',
  STOCKERP_PRESENTACION_GUARDADA: 'stockerp.presentacion_guardada',
  /**
   * Alguien miró una diferencia entre el catálogo y la unidad aprobada y dijo
   * «ya sé, está bien así».
   *
   * Se audita porque es una decisión, no un descarte: la advertencia deja de
   * mostrarse y queda constancia de quién se hizo cargo de que las dos
   * unidades no coincidan.
   */
  STOCKERP_DISCREPANCIA_RECONOCIDA: 'stockerp.discrepancia_reconocida',
  /**
   * Un intento que el permiso frenó.
   *
   * Un rechazo por falta de permiso es justamente lo que hay que poder mirar
   * después: dice quién quiso tocar la unidad de existencia de un artículo.
   */
  STOCKERP_INTENTO_RECHAZADO: 'stockerp.intento_rechazado',

  /* --- Stock ERP, fase 3: la apertura --------------------------------- */
  STOCKERP_APERTURA_PREPARADA: 'stockerp.apertura_preparada',
  STOCKERP_APERTURA_SNAPSHOT: 'stockerp.apertura_snapshot_actualizado',
  STOCKERP_CONTEO_GUARDADO: 'stockerp.conteo_guardado',
  STOCKERP_CERO_CONFIRMADO: 'stockerp.cero_confirmado',
  STOCKERP_NO_SE_MANEJA: 'stockerp.no_se_maneja',
  STOCKERP_APERTURA_CONFIRMADA: 'stockerp.apertura_confirmada',
  STOCKERP_APERTURA_SIMULTANEA: 'stockerp.apertura_simultanea',
  STOCKERP_CONFLICTO_DE_HUELLA: 'stockerp.conflicto_de_huella',
  STOCKERP_BLOQUEADO_INTERRUPTOR: 'stockerp.bloqueado_por_interruptor',
  STOCKERP_BLOQUEADO_UNIDAD: 'stockerp.bloqueado_por_unidad',
  STOCKERP_INTERRUPTOR_CAMBIADO: 'stockerp.interruptor_cambiado',

  /* --- Stock ERP, fase 4: la recepción de una compra ------------------- */
  /**
   * Se decidió qué pasa con la mercadería de un comprobante.
   *
   * Cubre las tres resoluciones, incluidas las dos que NO escriben libro:
   * «ya estaba en la apertura» y «no tiene mercadería con impacto». Auditar una
   * decisión sin movimiento es justamente lo que hace falta, porque después
   * nadie puede deducirla mirando el libro: ahí no hay nada que mirar.
   */
  STOCKERP_RECEPCION_DECIDIDA: 'stockerp.recepcion_decidida',
  /** La recepción asentó movimientos de mercadería en el libro. */
  STOCKERP_RECEPCION_APLICADA: 'stockerp.recepcion_aplicada',
  /**
   * Dos confirmaciones de la misma recepción al mismo tiempo.
   *
   * Una aplicó y la otra no. Se audita después del rollback, en una transacción
   * nueva, porque la que aborta no puede dejar rastro dentro de la suya.
   */
  STOCKERP_RECEPCION_SIMULTANEA: 'stockerp.recepcion_simultanea',
  /** El interruptor de recepciones reales se encendió o apagó. */
  STOCKERP_RECEPCIONES_INTERRUPTOR: 'stockerp.recepciones_interruptor_cambiado',

  /* --- Fase 6: traslados entre sucursales ------------------------------- */

  /** Se creó un borrador de traslado. Todavía no mueve nada. */
  STOCKERP_TRASLADO_CREADO: 'stockerp.traslado_creado',
  /**
   * Cambió un renglón del borrador: se agregó, se modificó o se retiró.
   *
   * Uno por cambio y con los valores de antes y de después. Sin esto, la
   * pregunta «quién puso tres kilos donde había uno» no tiene respuesta: el
   * borrador no deja rastro en el libro porque no escribe en el libro.
   */
  STOCKERP_TRASLADO_RENGLON: 'stockerp.traslado_renglon_cambiado',
  /** El borrador se descartó. No tocó el libro. */
  STOCKERP_TRASLADO_CANCELADO: 'stockerp.traslado_cancelado',
  /** El despacho asentó las salidas: la mercadería salió del origen. */
  STOCKERP_TRASLADO_DESPACHADO: 'stockerp.traslado_despachado',
  /** La recepción asentó las entradas y cerró el traslado. */
  STOCKERP_TRASLADO_RECIBIDO: 'stockerp.traslado_recibido',
  /**
   * Dos despachos —o dos recepciones— del mismo traslado al mismo tiempo.
   *
   * Uno aplicó y el otro no. Se audita después del rollback, en una transacción
   * nueva, porque la que aborta no puede dejar rastro dentro de la suya.
   */
  STOCKERP_TRASLADO_SIMULTANEO: 'stockerp.traslado_simultaneo',
  /** Se quiso despachar más de lo que hay en origen. No se escribió nada. */
  STOCKERP_TRASLADO_BLOQUEADO_SALDO: 'stockerp.traslado_bloqueado_por_saldo',
  /** La recepción no coincidía con lo despachado: sigue en tránsito. */
  STOCKERP_TRASLADO_DIFERENCIA: 'stockerp.traslado_diferencia_fisica',
  /** El interruptor de traslados reales se encendió o apagó. */
  STOCKERP_TRASLADOS_INTERRUPTOR: 'stockerp.traslados_interruptor_cambiado',
} as const;

export const AUDIT_ACTION_LABEL: Record<string, string> = {
  'sesion.ingreso': 'Inicio de sesión',
  'sesion.ingreso_fallido': 'Intento de ingreso fallido',
  'sesion.salida': 'Cierre de sesión',
  'comprobante.creado': 'Comprobante creado',
  'comprobante.leido': 'Comprobante leído',
  'comprobante.centavos_conciliados': 'Centavos conciliados automáticamente por OCR',
  'comprobante.confirmado': 'Comprobante confirmado',
  'comprobante.forzado': 'Comprobante forzado por un administrador',
  'comprobante.anulado': 'Comprobante anulado',
  'comprobante.rechazado': 'Comprobante rechazado',
  'nota_credito.confirmada': 'Nota de crédito confirmada',
  'pago.confirmado': 'Pago confirmado',
  'pago.reprogramado': 'Pago reprogramado',
  'pago.cancelado': 'Pago cancelado',
  'precio.aprobado': 'Precio de venta aprobado',
  'usuario.creado': 'Usuario creado',
  'usuario.modificado': 'Usuario modificado',
  'usuario.contrasena_cambiada': 'Contraseña cambiada por el propio usuario',
  'usuario.contrasena_cambio_fallido': 'Intento fallido de cambio de contraseña',
  'usuario.contrasena_restablecida_seed': 'Contraseña administrativa restablecida por recuperación',
  'stockerp.configuracion_creada': 'Stock ERP: configuración de unidad creada',
  'stockerp.unidad_aprobada': 'Stock ERP: unidad de existencia aprobada',
  'stockerp.unidad_modificada': 'Stock ERP: unidad de existencia modificada',
  'stockerp.presentacion_guardada': 'Stock ERP: presentación de compra guardada',
  'stockerp.discrepancia_reconocida': 'Stock ERP: discrepancia de unidad reconocida',
  'stockerp.intento_rechazado': 'Stock ERP: intento rechazado por falta de permiso',
  'stockerp.apertura_preparada': 'Stock ERP: apertura preparada',
  'stockerp.apertura_snapshot_actualizado': 'Stock ERP: catálogo del borrador actualizado',
  'stockerp.conteo_guardado': 'Stock ERP: conteo guardado',
  'stockerp.cero_confirmado': 'Stock ERP: artículo contado en cero',
  'stockerp.no_se_maneja': 'Stock ERP: artículo marcado como no manejado en la sucursal',
  'stockerp.apertura_confirmada': 'Stock ERP: apertura confirmada',
  'stockerp.apertura_simultanea': 'Stock ERP: confirmación simultánea resuelta',
  'stockerp.conflicto_de_huella': 'Stock ERP: conflicto de huella en la apertura',
  'stockerp.bloqueado_por_interruptor': 'Stock ERP: apertura bloqueada por el interruptor',
  'stockerp.bloqueado_por_unidad': 'Stock ERP: intento bloqueado por falta de unidad',
  'stockerp.interruptor_cambiado': 'Stock ERP: interruptor de aperturas reales cambiado',
  'stockerp.recepcion_decidida': 'Stock ERP: recepción de una compra decidida',
  'stockerp.recepcion_aplicada': 'Stock ERP: recepción aplicada al libro de existencias',
  'stockerp.recepcion_simultanea': 'Stock ERP: recepción simultánea resuelta',
  'stockerp.recepciones_interruptor_cambiado':
    'Stock ERP: interruptor de recepciones reales cambiado',
  'stockerp.traslado_creado': 'Stock ERP: borrador de traslado creado',
  'stockerp.traslado_renglon_cambiado': 'Stock ERP: renglón de un traslado cambiado',
  'stockerp.traslado_cancelado': 'Stock ERP: borrador de traslado cancelado',
  'stockerp.traslado_despachado': 'Stock ERP: traslado despachado (salida del origen)',
  'stockerp.traslado_recibido': 'Stock ERP: traslado recibido y cerrado',
  'stockerp.traslado_simultaneo': 'Stock ERP: traslado simultáneo resuelto',
  'stockerp.traslado_bloqueado_por_saldo': 'Stock ERP: traslado bloqueado por saldo insuficiente',
  'stockerp.traslado_diferencia_fisica':
    'Stock ERP: recepción de traslado con diferencia física, sigue en tránsito',
  'stockerp.traslados_interruptor_cambiado':
    'Stock ERP: interruptor de traslados reales cambiado',
  'rol.modificado': 'Rol modificado',
  'sucursal.modificada': 'Sucursal modificada',
  'proveedor.modificado': 'Proveedor modificado',
  'proveedor.creado_desde_lectura': 'Proveedor dado de alta desde una factura',
  'producto.modificado': 'Producto modificado',
  'imagenes.archivadas': 'Imágenes de comprobantes archivadas',
  'stock.movimientos_despachados': 'Movimientos de mercadería enviados a Control de Stock',
  'producto.alias_aprendido': 'Alias de producto aprendido',
  'familia.marcajes_modificados': 'Marcajes de una familia modificados',
  'regla_general.marcajes_modificados': 'Marcajes de la regla general modificados',
  'catalogo.sincronizado_con_stock': 'Catálogo sincronizado con Control de Stock',
};

export interface AuditInput {
  userId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/** Dirección y navegador de la request actual, para el registro. */
export async function requestMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  try {
    const h = await headers();
    const forwarded = h.get('x-forwarded-for');
    return {
      ip: forwarded ? forwarded.split(',')[0]!.trim() : (h.get('x-real-ip') ?? null),
      userAgent: h.get('user-agent')?.slice(0, 500) ?? null,
    };
  } catch {
    return { ip: null, userAgent: null };
  }
}

export async function recordAudit(
  input: AuditInput,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  try {
    const meta = await requestMeta();
    await tx.auditLog.create({
      data: {
        userId: input.userId ?? null,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        before: (input.before ?? undefined) as Prisma.InputJsonValue | undefined,
        after: (input.after ?? undefined) as Prisma.InputJsonValue | undefined,
        reason: input.reason ?? null,
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
    });
  } catch (error) {
    console.error('[auditoría] no se pudo registrar la operación', {
      action: input.action,
      entity: input.entity,
      entityId: input.entityId,
      error,
    });
  }
}
