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
  ALMACENAMIENTO_GESTIONAR: 'almacenamiento.gestionar',
  /**
   * Mandar a Control de Stock la mercadería de una compra.
   *
   * Es su propio permiso y no cuelga de «validar comprobantes» a propósito:
   * mueve existencias en OTRA aplicación, que es una consecuencia distinta de
   * la misma compra. Quien revisa facturas no tiene por qué poder tocar el
   * stock del local, y quien lo toca tiene que estar nombrado.
   */
  STOCK_SINCRONIZAR: 'stock.sincronizar',

  /* ---------------------------------------------------------------------- *
   * Stock ERP. Módulo propio de Compras, con sus propias tablas. Nada de
   * esto habla con Control de Stock, que sigue siendo otra aplicación.
   * ---------------------------------------------------------------------- */

  /** Entrar al módulo y mirar. No aprueba ni cambia nada. */
  STOCKERP_VER: 'stockerp.ver',
  /**
   * Aprobar la unidad de existencia de un artículo, y administrar sus
   * presentaciones de compra.
   *
   * Es la decisión que fija qué significa «uno» para ese artículo en el libro
   * de existencias. Una vez que haya movimientos, cambiarla reinterpretaría el
   * pasado, así que no cuelga de «administrar productos»: se otorga a dedo.
   */
  STOCKERP_UNIDADES_CONFIGURAR: 'stockerp.unidades.configurar',
  /** Ver el historial y la auditoría del módulo. */
  STOCKERP_AUDITORIA_VER: 'stockerp.auditoria.ver',

  /**
   * Preparar una apertura y cargar conteos.
   *
   * Separado de confirmarla a propósito: contar es el trabajo de recorrer la
   * góndola con el teléfono, y lo hace quien está ahí. Confirmar es el acto que
   * escribe el libro, y ése lo firma otra persona. Que sean el mismo permiso
   * haría que cualquiera que cuenta pueda también inaugurar el inventario.
   */
  STOCKERP_APERTURA_PREPARAR: 'stockerp.apertura.preparar',

  /**
   * Encender o apagar el interruptor de aperturas reales.
   *
   * Es el permiso más sensible del módulo: gobierna si una apertura con datos
   * de verdad puede asentarse en el libro.
   */
  STOCKERP_MODULO_CONFIGURAR: 'stockerp.modulo.configurar',

  /**
   * Confirmar la apertura de existencias de una sucursal.
   *
   * En la fase 2 era una capacidad declarada y vacía; la fase 3 la implementa.
   * Escribe el libro, fija el corte y deja la sucursal operativa, así que se
   * otorga a dedo y nunca por ser administrador.
   */
  STOCKERP_APERTURA_CONFIRMAR: 'stockerp.apertura.confirmar',

  /** Marcar que una sucursal no maneja un artículo, o habilitarlo. */
  STOCKERP_ACTIVACION_HABILITAR: 'stockerp.activacion.habilitar',

  /*
   * Los tres de abajo siguen nombrando capacidades que TODAVÍA NO EXISTEN: no
   * hay movimientos anteriores al corte, ni ajustes, ni reversiones. Se
   * declaran por una sola razón, y es la que importa: la lista de permisos
   * sensibles que NO entran en el rol administrador tiene que poder nombrarlos,
   * y una prueba tiene que poder comprobar que no entran. Un permiso que no
   * existe no se puede dejar afuera, y el día que la capacidad llegue nadie se
   * acordaría de excluirlo.
   */
  /** Registrar un movimiento con fecha efectiva anterior al corte. */
  STOCKERP_EXCEPCION_HISTORICA: 'stockerp.excepcion.historica',
  /** Ajustar existencias sin un comprobante que lo respalde. */
  STOCKERP_AJUSTE: 'stockerp.ajuste',
  /** Reversar un movimiento ya asentado en el libro. */
  STOCKERP_REVERSAR: 'stockerp.reversar',
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
  'almacenamiento.gestionar': 'Archivar comprobantes y liberar espacio',
  'stock.sincronizar': 'Enviar movimientos de mercadería a Control de Stock',
  'stockerp.ver': 'Ver el módulo Stock ERP',
  'stockerp.unidades.configurar': 'Aprobar unidades de existencia y presentaciones de compra',
  'stockerp.auditoria.ver': 'Ver el historial y la auditoría de Stock ERP',
  'stockerp.apertura.preparar': 'Preparar aperturas de Stock ERP y cargar conteos',
  'stockerp.apertura.confirmar': 'Confirmar la apertura de existencias de una sucursal',
  'stockerp.activacion.habilitar': 'Decidir qué artículos maneja cada sucursal',
  'stockerp.modulo.configurar': 'Encender o apagar las aperturas reales de Stock ERP',
  'stockerp.excepcion.historica': 'Registrar movimientos anteriores a la apertura (todavía no implementado)',
  'stockerp.ajuste': 'Ajustar existencias sin comprobante (todavía no implementado)',
  'stockerp.reversar': 'Reversar movimientos del libro (todavía no implementado)',
};

/**
 * Los permisos que NO entran solos en el rol administrador.
 *
 * HALLAZGO que obligó a escribir esto: `ADMIN_PERMISSIONS` era
 * `[...ALL_PERMISSIONS]`, así que **todo permiso nuevo caía en el rol
 * administrador por el solo hecho de existir**. Para Compras eso era discutible
 * pero inofensivo; para Stock ERP no lo es. Aprobar la unidad de existencia de
 * un artículo fija qué significa «uno» en el libro, y un ajuste o una reversión
 * cambian existencias sin un papel detrás. Capacidades así se otorgan a una
 * persona por su nombre, no se heredan por ser administrador.
 *
 * Quien las necesite las recibe desde Configuración → Roles, que es una
 * decisión con autor y fecha. Lo que se pierde es comodidad; lo que se gana es
 * que nadie pueda reinterpretar un inventario sin que alguien lo haya decidido.
 */
export const PERMISOS_SENSIBLES_DE_STOCK_ERP: Permission[] = [
  PERMISSIONS.STOCKERP_UNIDADES_CONFIGURAR,
  PERMISSIONS.STOCKERP_APERTURA_CONFIRMAR,
  PERMISSIONS.STOCKERP_ACTIVACION_HABILITAR,
  PERMISSIONS.STOCKERP_MODULO_CONFIGURAR,
  PERMISSIONS.STOCKERP_EXCEPCION_HISTORICA,
  PERMISSIONS.STOCKERP_AJUSTE,
  PERMISSIONS.STOCKERP_REVERSAR,
];

/**
 * Permisos de los dos roles iniciales. Se siembran; después se editan en la app.
 *
 * `stock.sincronizar` sigue acá y no se toca: pertenece al transporte externo
 * retirado y queda congelado hasta que ese código se elimine en otra etapa.
 * Sacarlo ahora cambiaría el significado de un permiso que alguien pudo haber
 * asignado, y eso no es asunto de esta ronda.
 */
export const ADMIN_PERMISSIONS: Permission[] = ALL_PERMISSIONS.filter(
  (p) => !PERMISOS_SENSIBLES_DE_STOCK_ERP.includes(p),
);

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
