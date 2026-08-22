/**
 * Catálogo de permisos.
 *
 * Los roles viven en la base y guardan una lista de estos códigos, así que se
 * pueden crear roles nuevos (supervisor, encargado, contador) desde
 * Configuración sin tocar el código. Lo único que exige código nuevo es
 * inventar una capacidad que hoy no existe.
 */
export const PERMISSIONS = {
  COMPROBANTES_CARGAR: 'comprobantes.cargar',
  COMPROBANTES_VER: 'comprobantes.ver',
  COMPROBANTES_VALIDAR: 'comprobantes.validar',
  COMPROBANTES_ANULAR: 'comprobantes.anular',
  PAGOS_VER: 'pagos.ver',
  PAGOS_CONFIRMAR: 'pagos.confirmar',
  PAGOS_REPROGRAMAR: 'pagos.reprogramar',
  PRODUCTOS_GESTIONAR: 'productos.gestionar',
  PROVEEDORES_GESTIONAR: 'proveedores.gestionar',
  SUCURSALES_GESTIONAR: 'sucursales.gestionar',
  USUARIOS_GESTIONAR: 'usuarios.gestionar',
  ROLES_GESTIONAR: 'roles.gestionar',
  PRECIOS_VER: 'precios.ver',
  PRECIOS_GESTIONAR: 'precios.gestionar',
  REPORTES_VER: 'reportes.ver',
  AUDITORIA_VER: 'auditoria.ver',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

export const PERMISSION_LABEL: Record<Permission, string> = {
  'comprobantes.cargar': 'Cargar comprobantes',
  'comprobantes.ver': 'Consultar comprobantes',
  'comprobantes.validar': 'Revisar y confirmar comprobantes',
  'comprobantes.anular': 'Anular comprobantes (con motivo)',
  'pagos.ver': 'Consultar la agenda de pagos',
  'pagos.confirmar': 'Confirmar pagos',
  'pagos.reprogramar': 'Reprogramar o cancelar pagos',
  'productos.gestionar': 'Administrar productos y alias',
  'proveedores.gestionar': 'Administrar proveedores y condiciones',
  'sucursales.gestionar': 'Administrar sucursales',
  'usuarios.gestionar': 'Administrar usuarios',
  'roles.gestionar': 'Administrar roles y permisos',
  'precios.ver': 'Consultar precios y costos',
  'precios.gestionar': 'Definir márgenes y aprobar precios de venta',
  'reportes.ver': 'Ver reportes de compras',
  'auditoria.ver': 'Consultar la auditoría',
};

/** Permisos de los dos roles iniciales. Se siembran; después se editan en la app. */
export const ADMIN_PERMISSIONS: Permission[] = [...ALL_PERMISSIONS];

export const OPERADOR_PERMISSIONS: Permission[] = [
  PERMISSIONS.COMPROBANTES_CARGAR,
  PERMISSIONS.COMPROBANTES_VER,
  PERMISSIONS.COMPROBANTES_VALIDAR,
  PERMISSIONS.PAGOS_VER,
  PERMISSIONS.PRECIOS_VER,
  PERMISSIONS.REPORTES_VER,
];

/** Ejemplo de rol adicional: mira todo pero no toca nada. */
export const SUPERVISOR_PERMISSIONS: Permission[] = [
  PERMISSIONS.COMPROBANTES_VER,
  PERMISSIONS.PAGOS_VER,
  PERMISSIONS.PRECIOS_VER,
  PERMISSIONS.REPORTES_VER,
];

export function isValidPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as string[]).includes(value);
}
