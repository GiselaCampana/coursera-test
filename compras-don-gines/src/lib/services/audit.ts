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
  LOGIN_FAILED: 'sesion.ingreso_fallido',
  LOGOUT: 'sesion.salida',
  DOCUMENT_CREATED: 'comprobante.creado',
  DOCUMENT_READ: 'comprobante.leido',
  CENTAVOS_CONCILIADOS: 'comprobante.centavos_conciliados',
  DOCUMENT_CONFIRMED: 'comprobante.confirmado',
  DOCUMENT_OVERRIDDEN: 'comprobante.forzado',
  DOCUMENT_VOIDED: 'comprobante.anulado',
  DOCUMENT_REJECTED: 'comprobante.rechazado',
  PAYMENT_CONFIRMED: 'pago.confirmado',
  PAYMENT_RESCHEDULED: 'pago.reprogramado',
  PAYMENT_CANCELLED: 'pago.cancelado',
  PRICE_APPROVED: 'precio.aprobado',
  USER_CREATED: 'usuario.creado',
  USER_UPDATED: 'usuario.modificado',
  PASSWORD_CHANGED: 'usuario.contrasena_cambiada',
  PASSWORD_CHANGE_FAILED: 'usuario.contrasena_cambio_fallido',
  ROLE_UPDATED: 'rol.modificado',
  BRANCH_UPDATED: 'sucursal.modificada',
  SUPPLIER_UPDATED: 'proveedor.modificado',
  PRODUCT_UPDATED: 'producto.modificado',
  PRODUCT_ALIAS_LEARNED: 'producto.alias_aprendido',
  IMAGENES_ARCHIVADAS: 'imagenes.archivadas',
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
  'pago.confirmado': 'Pago confirmado',
  'pago.reprogramado': 'Pago reprogramado',
  'pago.cancelado': 'Pago cancelado',
  'precio.aprobado': 'Precio de venta aprobado',
  'usuario.creado': 'Usuario creado',
  'usuario.modificado': 'Usuario modificado',
  'usuario.contrasena_cambiada': 'Contraseña cambiada por el propio usuario',
  'usuario.contrasena_cambio_fallido': 'Intento fallido de cambio de contraseña',
  'rol.modificado': 'Rol modificado',
  'sucursal.modificada': 'Sucursal modificada',
  'proveedor.modificado': 'Proveedor modificado',
  'producto.modificado': 'Producto modificado',
  'imagenes.archivadas': 'Imágenes de comprobantes archivadas',
  'producto.alias_aprendido': 'Alias de producto aprendido',
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
