/**
 * La factura de Lácteos Barraza, tal como está impresa en el papel.
 *
 * Se transcribe columna por columna, y en este formato eso importa más que en
 * ningún otro: la tabla tiene **kilos y piezas a la vez**, y los dos son
 * cantidades. Un fixture que guardara una sola cantidad no podría distinguir
 * una lectura correcta de una que las intercambió, que es exactamente el error
 * que trajo esta factura al proyecto («27.00 9.00 | CIL MUZZA BARRAZA X 3 KG»).
 *
 * La regla del negocio, que es lo que decide cuál se usa para qué:
 *
 *     neto = kilos × precio/kg × (1 − bonificación)
 *
 * El costo sale **de los kilos**, nunca de las piezas. Las piezas se conservan
 * en paralelo porque son el movimiento físico: nueve cilindros de tres kilos y
 * tres planchas de diez.
 */

export interface ArticuloImpresoBarraza {
  codigo: string;
  kilos: string;
  piezas: number;
  descripcion: string;
  precioPorKg: string;
  /** Fracción: 0.16 = 16 %. */
  bonificacion: string;
  /** El importe neto del renglón, ya con la bonificación aplicada. */
  neto: string;
}

export const BARRAZA_ARTICULOS_IMPRESOS: ArticuloImpresoBarraza[] = [
  {
    codigo: '03',
    kilos: '27.00',
    piezas: 9,
    descripcion: 'CIL MUZZA BARRAZA X 3 KG',
    precioPorKg: '10361.45',
    bonificacion: '0.16',
    // 27 × 10.361,45 × 0,84 = 234.997,686
    neto: '234997.69',
  },
  {
    codigo: '30',
    kilos: '30.00',
    piezas: 3,
    descripcion: 'PLAN MUZZA BARRAZA X 10 KG',
    precioPorKg: '9453.76',
    bonificacion: '0.16',
    // 30 × 9.453,76 × 0,84 = 238.234,752
    neto: '238234.75',
  },
];

/**
 * El encabezado impreso.
 *
 * `cuit` es el del **emisor**. El 27-33342291-9 que también aparece en el papel
 * es el del receptor —Don Ginés— y no identifica al proveedor: usarlo para eso
 * haría que todas las facturas de todos los proveedores se atribuyeran a la
 * misma ficha.
 */
export const BARRAZA_ENCABEZADO = {
  supplierName: 'Barraza',
  legalName: 'Lácteos Barraza S.A.',
  cuit: '30-66138303-4',
  cuitDelReceptor: '27-33342291-9',
  docType: 'FACTURA' as const,
  letter: 'A',
  pointOfSale: '0041',
  number: '00196670',
  fullNumber: '0041-00196670',
  issueDate: '2026-09-08',
  condicionDePago: 'CONTADO ANTICIPADO',
};

/**
 * El pie impreso.
 *
 * Dos cosas de este pie que no se pueden tomar al pie de la letra:
 *
 *  - **el subtotal aparece dos veces** y es un único valor. Sumarlo dos veces
 *    da un neto del doble y una deuda del doble;
 *  - **«Saldo Ac. $532.848,64» es un saldo acumulado previo** de la cuenta
 *    corriente. No es de esta factura, no entra en el total, ni en la deuda
 *    nueva, ni en ningún prorrateo. Es, además, un número más grande que el
 *    neto, así que colarse entre los candidatos a importe lo haría ganar.
 */
export const BARRAZA_PIE = {
  netTotal: '473232.44',
  iva21: '99378.81',
  percepcionIibbCaba: '7098.49',
  percepcionRate: '0.015',
  total: '579709.74',
  /** No pertenece a esta factura. Está acá para poder afirmar que se ignora. */
  saldoAcumuladoPrevio: '532848.64',
};

/** Los totales de control que imprime el papel. */
export const BARRAZA_TOTALES = {
  kilos: '57',
  piezas: 12,
};
