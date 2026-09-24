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
   * Consultar el libro de existencias: movimientos, saldos y su recorrido.
   *
   * Separado de `stockerp.ver` porque son dos cosas distintas. `stockerp.ver`
   * deja entrar al módulo y mirar configuración; esto deja leer CUÁNTO hay y
   * cuánto hubo, que en una fiambrería es información comercial: revela
   * volúmenes de compra, qué se mueve y qué no.
   *
   * Es de LECTURA y no otorga ninguna capacidad de modificación. Eso no es una
   * promesa del nombre: ninguna función que lo exige escribe una fila de
   * existencias, y hay una prueba que lo comprueba.
   */
  STOCKERP_MOVIMIENTOS_VER: 'stockerp.movimientos.ver',

  /**
   * Ver el diagnóstico de integridad.
   *
   * Aparte de los movimientos porque contesta otra pregunta y la contesta de
   * otra manera: compara la proyección contra el libro y expone divergencias.
   * Una divergencia es información delicada —dice que algo no cierra— y
   * conviene que quien la mire sepa qué está mirando.
   *
   * También de lectura. El diagnóstico DETECTA y jamás repara: no hay botón, no
   * hay función y no hay camino.
   */
  STOCKERP_INTEGRIDAD_VER: 'stockerp.integridad.ver',

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

  /**
   * Preparar la recepción de una compra: abrir la vista previa, ver qué
   * renglones impactarían y con qué conversiones, cargar la fecha y hora en que
   * llegó la mercadería.
   *
   * NO es sensible, y la razón es la misma que en la apertura: mirar y preparar
   * no escribe el libro. Quien recibe el camión tiene que poder ver qué va a
   * entrar antes de que entre; si eso exigiera el permiso sensible, en la
   * práctica nadie revisaría nada y se confirmaría a ciegas.
   */
  STOCKERP_RECEPCION_PREPARAR: 'stockerp.recepcion.preparar',

  /**
   * Confirmar la recepción: el acto que asienta los movimientos de mercadería,
   * o que registra que el comprobante ya estaba comprendido en la apertura.
   *
   * Sensible. Es la única puerta por la que entra mercadería al libro, y una
   * recepción de más no se ve hasta el siguiente recuento.
   */
  STOCKERP_RECEPCION_CONFIRMAR: 'stockerp.recepcion.confirmar',

  /**
   * Documentar una decisión sobre mercadería anterior o igual al corte.
   *
   * ES LO QUE **NO** HABILITA lo que su nombre sugiere. No deja registrar un
   * movimiento con fecha efectiva anterior al corte: eso sumaría historia vieja
   * sobre un saldo de apertura que ya la contiene, y duplicaría existencias. El
   * disparador `stock_ingreso_posterior_al_corte` lo frena en la base y no
   * tiene puerta de escape, ni para quien tenga este permiso.
   *
   * Lo único que habilita es dejar constancia auditada de la decisión —con
   * motivo, sin movimientos— sobre un comprobante que llegó antes del corte.
   * Si alguien sostiene que esa mercadería no se contó, la recepción se bloquea
   * y se resuelve con un `INVENTORY_CORRECTION` en una fase futura, que todavía
   * no existe.
   */
  STOCKERP_EXCEPCION_HISTORICA: 'stockerp.excepcion.historica',

  /*
   * Los dos de abajo siguen nombrando capacidades que TODAVÍA NO EXISTEN: no
   * hay ajustes ni reversiones. Se declaran por una sola razón, y es la que
   * importa: la lista de permisos sensibles que NO entran en el rol
   * administrador tiene que poder nombrarlos, y una prueba tiene que poder
   * comprobar que no entran. Un permiso que no existe no se puede dejar afuera,
   * y el día que la capacidad llegue nadie se acordaría de excluirlo.
   */
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
  'stockerp.movimientos.ver': 'Consultar saldos y movimientos del libro de existencias',
  'stockerp.integridad.ver': 'Ver el diagnóstico de integridad del libro (sólo lectura)',
  'stockerp.apertura.preparar': 'Preparar aperturas de Stock ERP y cargar conteos',
  'stockerp.apertura.confirmar': 'Confirmar la apertura de existencias de una sucursal',
  'stockerp.activacion.habilitar': 'Decidir qué artículos maneja cada sucursal',
  'stockerp.modulo.configurar':
    'Encender o apagar las aperturas y recepciones reales de Stock ERP',
  'stockerp.recepcion.preparar': 'Preparar recepciones de compras y ver su vista previa',
  'stockerp.recepcion.confirmar': 'Confirmar la recepción de mercadería de una compra',
  'stockerp.excepcion.historica':
    'Documentar una decisión sobre mercadería anterior al corte (sin movimientos)',
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
  PERMISSIONS.STOCKERP_RECEPCION_CONFIRMAR,
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
