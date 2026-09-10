/**
 * La factura de Distribuidora Ezra, tal como está impresa en el papel.
 *
 * Se transcribe columna por columna, no sólo el importe, porque el error que
 * trajo esta factura al proyecto es exactamente un **corrimiento de columnas**:
 * un fixture que guardara nada más que código, descripción e importe no podría
 * distinguir una lectura correcta de una que puso el precio unitario en el
 * kilaje y el porcentaje de descuento en el precio.
 *
 * Dos particularidades del formato, que son las que hay que respetar:
 *
 *  - la **cantidad va antes de la descripción**, no después, que es donde la
 *    ponen casi todos los proveedores;
 *  - los importes de los renglones se imprimen con **tres** decimales y el pie
 *    con dos, y el neto del pie es la suma *truncada*, no redondeada:
 *    la suma de los seis renglones da 221.388,847 y el papel dice 221.388,84.
 */

export interface ArticuloImpresoEzra {
  codigo: string;
  cantidad: string;
  descripcion: string;
  marca: string | null;
  precioUnitario: string;
  descuentoPct: string;
  precioConDescuento: string;
  /** El importe del renglón, con los tres decimales del papel. */
  subtotal: string;
}

export const EZRA_ARTICULOS_IMPRESOS: ArticuloImpresoEzra[] = [
  {
    codigo: '47',
    cantidad: '4.240',
    descripcion: 'Cremoso LA PAULINA',
    marca: 'La Paulina',
    precioUnitario: '6723.279',
    descuentoPct: '5.000',
    precioConDescuento: '6387.115',
    subtotal: '27081.371',
  },
  {
    codigo: '49',
    cantidad: '3.985',
    descripcion: 'PERNIL PATA CELESTE MINI 1284',
    marca: 'GALAICO',
    precioUnitario: '4040.189',
    descuentoPct: '5.000',
    precioConDescuento: '3838.180',
    subtotal: '15295.149',
  },
  {
    codigo: '48',
    cantidad: '7.345',
    descripcion: 'QUESO DE MAQUINA DAMBO LA PAULINA',
    marca: 'La Paulina',
    precioUnitario: '8612.184',
    descuentoPct: '4.000',
    precioConDescuento: '8267.696',
    subtotal: '60726.232',
  },
  {
    codigo: '10',
    cantidad: '4.040',
    descripcion: 'JAMON COCIDO MINI TRADICIONAL',
    marca: 'LOS CALVOS',
    precioUnitario: '12508.959',
    descuentoPct: '2.000',
    precioConDescuento: '12258.780',
    subtotal: '49525.474',
  },
  {
    codigo: '2514',
    cantidad: '7.665',
    descripcion: 'JAMON COCIDO MINI',
    marca: 'IL MOLISE',
    precioUnitario: '9218.160',
    descuentoPct: '3.000',
    precioConDescuento: '8941.615',
    subtotal: '68537.481',
  },
  {
    /*
     * El único que no se factura por kilo. En el papel no hay nada que lo diga:
     * la columna «Cantidad» imprime 3,000 igual que imprime 4,240 kilos de
     * cremoso. Lo que distingue una bolsa de un kilo de queso no está en este
     * comprobante, y por eso no se puede deducir de acá.
     */
    codigo: '4249',
    cantidad: '3.000',
    descripcion: 'BOLSA GRANDE',
    marca: null,
    precioUnitario: '74.380',
    descuentoPct: '0',
    precioConDescuento: '74.380',
    subtotal: '223.140',
  },
];

/** El encabezado impreso. */
export const EZRA_ENCABEZADO = {
  supplierName: 'Distribuidora Ezra',
  legalName: 'Cooperativa de Trabajo Ezra Alimentos',
  cuit: '30-71951960-8',
  docType: 'FACTURA' as const,
  letter: 'A',
  pointOfSale: '0002',
  number: '00000185',
  fullNumber: '0002-00000185',
  issueDate: '2026-09-09',
};

/**
 * El pie impreso.
 *
 * `netTotal` es el subtotal: esta factura no tiene descuentos al pie —los
 * descuentos son por renglón y ya están dentro de cada importe— y el papel
 * imprime «DESCUENTOS: 0,00» explícitamente.
 */
export const EZRA_PIE = {
  grossSubtotal: '221388.84',
  discountTotal: '0.00',
  netTotal: '221388.84',
  iva21: '46491.66',
  iva105: '0.00',
  total: '267880.50',
};
