/**
 * El banco de comprobantes con el que se prueba el motor general.
 *
 * **Ninguno de estos emisores existe.** Las razones sociales y los CUIT son
 * inventados, y están inventados a propósito: lo que se prueba es que el motor
 * interpreta una factura por **cómo está armada**, no por de quién es. Si
 * alguna de estas piezas dependiera de reconocer a Ezra o a Barraza, cambiarles
 * el nombre la rompería, y esa es exactamente la prueba.
 *
 * Las estructuras, en cambio, sí son las reales: son las que están impresas en
 * las fotos del banco y las que hasta ahora necesitaron un analizador propio en
 * el repositorio.
 *
 * Todos los números cierran por construcción, y están escritos acá arriba para
 * que se pueda comprobar a mano:
 *
 *   - `ESTRUCTURA_CANTIDAD_ADELANTE`: 22.800 + 19.200 + 29.400 = 71.400 neto,
 *     IVA 21 % = 14.994, total 86.394.
 *   - `ESTRUCTURA_KILOS_Y_PIEZAS`: 168.000 + 226.800 = 394.800 neto, IVA 21 % =
 *     82.908, percepción 1,5 % = 5.922, total 483.630.
 *   - `ESTRUCTURA_IMPORTE_BRUTO`: los importes impresos son **brutos** y suman
 *     100.000; con el 14 % de bonificación el neto es 86.000, IVA 18.060,
 *     total 104.060.
 */

import type { TextosComprobante } from '@/lib/ocr/parsers/tipos';

/** El CUIT de Don Ginés, que está impreso en todas las facturas que recibe. */
export const CUIT_DEL_RECEPTOR = '27-33342291-9';

/** Lo que toda factura trae arriba: el emisor, y el receptor que no lo es. */
function encabezadoDe(razonSocial: string, cuit: string): string {
  return `${razonSocial}
DOCTOR RICARDO BALBIN 2919 - Buenos Aires
C.U.I.T.: ${cuit}
Responsable Inscripto
FACTURA A                 N* 00003-00004521
Fecha : 09/09/2026

Sr. : GISELA CAMPANA
Dir. : ARTIGAS 4920 (7301)
CUIT : ${CUIT_DEL_RECEPTOR}    IVA : Responsable Inscripto
Condición de Pago : Transf.`;
}

/** Arma las cuatro zonas como las entrega el lector. */
function comprobante(encabezado: string, articulos: string, resumen: string): TextosComprobante {
  return {
    completo: `${encabezado}\n${articulos}\n${resumen}`,
    encabezado,
    articulos: `${encabezado.split('\n').slice(6).join('\n')}\n${articulos}`,
    resumen,
  };
}

// ---------------------------------------------------------------------------
// 1. La cantidad delante de la descripción, con dos precios impresos
// ---------------------------------------------------------------------------

/**
 * La estructura que rompió el analizador genérico: la cantidad va **antes** del
 * nombre del artículo, y hay dos columnas de precio —el de lista y el ya
 * descontado—. Cargar el de lista como costo lo infla entre un 2 % y un 5 %.
 *
 * El importe impreso sale del precio con descuento, así que es neto y no hay
 * nada que decidir sobre él.
 */
const ARTICULOS_CANTIDAD_ADELANTE = `Codigo  Cantidad  Descripción               Marca              P.Unit  Desc.%  P.U.Desc.     Importe
    47     4,000  Cremoso                   La Paulina      6.000,000   5,000  5.700,000  22.800,000
    48     2,500  Queso de maquina Dambo    La Serenisima   8.000,000   4,000  7.680,000  19.200,000
    10     3,000  Jamon cocido tradicional  Il Molise      10.000,000   2,000  9.800,000  29.400,000`;

const RESUMEN_CANTIDAD_ADELANTE = `PESOS : OCHENTA Y SEIS MIL TRESCIENTOS NOVENTA Y CUATRO CON 00/100
SUB-TOTAL :       71.400,00
DESCUENTOS:            0,00
IVA 21,00         14.994,00
IVA 10,50              0,00
Total             86.394,00`;

export const ESTRUCTURA_CANTIDAD_ADELANTE = comprobante(
  encabezadoDe('ALIMENTOS DEL SUR S.R.L.', '30-99887766-1'),
  ARTICULOS_CANTIDAD_ADELANTE,
  RESUMEN_CANTIDAD_ADELANTE,
);

export const ESPERADO_CANTIDAD_ADELANTE = {
  cuit: '30-99887766-1',
  renglones: 3,
  netTotal: '71400',
  ivaTotal: '14994',
  total: '86394',
};

// ---------------------------------------------------------------------------
// 2. Kilos y piezas en columnas separadas, y los números a la norteamericana
// ---------------------------------------------------------------------------

/**
 * La estructura con **dos cantidades a la vez**: los kilos, que son los que
 * cuestan, y las piezas, que son el movimiento físico. El costo sale de los
 * kilos; leerlo de las piezas multiplicaría el precio por tres.
 *
 * Los números van con coma de miles y punto decimal, y el importe impreso ya
 * tiene la bonificación adentro: 20 × 10.000 × 0,84 = 168.000.
 */
const ARTICULOS_KILOS_Y_PIEZAS = `Cod  Cantidad  Unidades  Descripcion           Pr Unit  Bonifi     Importe
 03     20.00      5.00  CIL MUZZA X 4 KG    10,000.00   16.00  168,000.00
 07     30.00      3.00  PLAN MUZZA X 10 KG   9,000.00   16.00  226,800.00`;

const RESUMEN_KILOS_Y_PIEZAS = `Total Kgs.   50.00
Subtotal          394,800.00
IVA 21%            82,908.00
Percepcion IIBB     5,922.00
Total             483,630.00`;

export const ESTRUCTURA_KILOS_Y_PIEZAS = comprobante(
  encabezadoDe('LACTEOS DEL NORTE S.A.', '30-55443322-7'),
  ARTICULOS_KILOS_Y_PIEZAS,
  RESUMEN_KILOS_Y_PIEZAS,
);

export const ESPERADO_KILOS_Y_PIEZAS = {
  cuit: '30-55443322-7',
  renglones: 2,
  netTotal: '394800',
  ivaTotal: '82908',
  percepciones: '5922',
  total: '483630',
  kilos: ['20', '30'],
  piezas: [5, 3],
};

// ---------------------------------------------------------------------------
// 3. La misma información, en otro orden y con una columna de más
// ---------------------------------------------------------------------------

/**
 * Una variante compatible: los mismos campos que la primera estructura, pero
 * con la marca al final, el código de artículo con otro nombre y una columna
 * «Sugerido» —el precio de venta que sugiere el proveedor— que no es del costo.
 *
 * Tiene que resolverse igual y sin configurar nada. Es la prueba de que lo que
 * el motor usa es **qué es cada columna** y no dónde está.
 */
const ARTICULOS_OTRO_ORDEN = `Codigo Art.  Descripcion               Cantidad   Sugerido      P.Unit  Desc.%  P.U.Desc.     Importe  Marca
         47  Cremoso                      4,000   9.500,00   6.000,000   5,000  5.700,000  22.800,000  La Paulina
         48  Queso de maquina Dambo       2,500  12.000,00   8.000,000   4,000  7.680,000  19.200,000  La Serenisima
         10  Jamon cocido tradicional     3,000  15.000,00  10.000,000   2,000  9.800,000  29.400,000  Il Molise`;

export const ESTRUCTURA_OTRO_ORDEN = comprobante(
  encabezadoDe('DISTRIBUIDORA LA ESQUINA S.A.S.', '30-11223344-5'),
  ARTICULOS_OTRO_ORDEN,
  RESUMEN_CANTIDAD_ADELANTE,
);

// ---------------------------------------------------------------------------
// 4. Un encabezado ambiguo
// ---------------------------------------------------------------------------

/**
 * «Desc» a secas puede ser descripción o descuento, y las dos aparecen en
 * comprobantes reales. Acá es el porcentaje de descuento; en otro formato sería
 * el nombre del artículo.
 *
 * El motor **no tiene que adivinar**: tiene que decir que no sabe y frenar para
 * que lo resuelva una persona. Adivinar por mayoría estadística cargaría el
 * porcentaje como nombre —o al revés— en el formato en que la mayoría se
 * equivoca, y eso pasa en silencio.
 */
const ARTICULOS_AMBIGUOS = `Codigo Art.  Descripcion                Desc  Cantidad     Pr Unit     Importe
         47  Cremoso                   5,000     4,000   6.000,000  22.800,000
         48  Queso de maquina Dambo    4,000     2,500   8.000,000  19.200,000
         10  Jamon cocido tradicional  2,000     3,000  10.000,000  29.400,000`;

export const ESTRUCTURA_AMBIGUA = comprobante(
  encabezadoDe('PROVEEDORA CENTRAL S.R.L.', '30-22334455-6'),
  ARTICULOS_AMBIGUOS,
  RESUMEN_CANTIDAD_ADELANTE,
);

// ---------------------------------------------------------------------------
// 5. Una lectura que no cierra por ningún lado
// ---------------------------------------------------------------------------

/**
 * La tabla se entiende —los encabezados están, las columnas se reconocen— pero
 * los números no cierran ni consigo mismos ni contra el pie. Es el caso de una
 * foto movida, o de un comprobante que el OCR leyó mal en varias celdas a la
 * vez.
 *
 * Tiene que quedar rechazado. Un motor que devolviera «lo mejor que encontré»
 * cargaría estos importes en el historial de costos, y de ahí sale el precio de
 * venta.
 */
const ARTICULOS_QUE_NO_CIERRAN = `Codigo  Cantidad  Descripción               Marca              P.Unit  Desc.%  P.U.Desc.  Importe
    47     4,000  Cremoso                   La Paulina      6.000,000   5,000  1.234,000   91,000
    48     2,500  Queso de maquina Dambo    La Serenisima   8.000,000   4,000    777,000   18,000
    10     3,000  Jamon cocido tradicional  Il Molise      10.000,000   2,000    512,000    7,000`;

export const ESTRUCTURA_QUE_NO_CIERRA = comprobante(
  encabezadoDe('COMERCIAL RIVADAVIA S.A.', '30-66778899-0'),
  ARTICULOS_QUE_NO_CIERRAN,
  RESUMEN_CANTIDAD_ADELANTE,
);

// ---------------------------------------------------------------------------
// 6. Dos lecturas que cierran igual de bien
// ---------------------------------------------------------------------------

/**
 * Los precios y los importes tienen **un solo separador y tres cifras detrás**,
 * las cantidades no tienen ninguno, y no hay un solo número que desempate.
 * Leído a la argentina el punto es de miles y la factura es de setenta y un mil
 * cuatrocientos pesos; leído a la norteamericana el punto es la coma decimal y
 * la factura es de setenta y un pesos con cuarenta.
 *
 * Las cantidades sin separador son la clave: 4 × 5.700 = 22.800 es cierto de las
 * dos maneras, porque el precio y el importe se escalan por mil los dos juntos.
 *
 * Las dos lecturas cierran **perfectamente**: cada renglón contra sí mismo y la
 * suma contra el pie. No hay una respuesta, hay dos, y la aritmética no puede
 * elegir porque las dos son aritméticamente impecables.
 *
 * Esto no es un caso de laboratorio: es lo que pasa con un proveedor extranjero
 * o con un sistema de facturación configurado en otra plaza. Lo correcto es
 * frenar y preguntar, no tirar una moneda con el costo de cada artículo.
 */
const ARTICULOS_AMBIDIESTROS = `Codigo  Cantidad  Descripcion               Pr Unit  Importe
    47         4  Cremoso                     5.700   22.800
    48         2  Queso de maquina Dambo      9.600   19.200
    10         3  Jamon cocido tradicional    9.800   29.400`;

const RESUMEN_AMBIDIESTRO = `Subtotal    71.400
Total       71.400`;

export const ESTRUCTURA_AMBIDIESTRA = comprobante(
  encabezadoDe('IMPORTADORA DEL PLATA S.A.', '30-33445566-2'),
  ARTICULOS_AMBIDIESTROS,
  RESUMEN_AMBIDIESTRO,
);

// ---------------------------------------------------------------------------
// 7. Un pie lleno de números que no son del pie
// ---------------------------------------------------------------------------

/**
 * El pie de una factura real está rodeado de números grandes, creíbles y con
 * etiqueta propia que **no pertenecen al comprobante**:
 *
 *   - el saldo acumulado de la cuenta corriente, que acá es más grande que el
 *     total y que si se cuela como neto gana por tamaño;
 *   - el CAE, de catorce dígitos;
 *   - el CUIT del emisor y el del receptor;
 *   - el número de ingresos brutos;
 *   - el total de kilos, que es una cantidad y no un importe;
 *   - el código de barras.
 *
 * El pie fiscal de esta factura es el mismo de la primera estructura: 71.400 de
 * neto, 14.994 de IVA, 86.394 de total. Todo lo demás tiene que quedar afuera y
 * quedar **anotado** como descartado, para poder revisar la decisión.
 */
const RESUMEN_CON_RUIDO = `Total Kgs.        9,500
Saldo Ac. $   532.848,64
SUB-TOTAL :    71.400,00
IVA 21,00      14.994,00
Percepciones :      0,00
Total          86.394,00
C.A.E.: 86362260109330    Vto. CAE: 19/09/2026
C.U.I.T.: 30-99887766-1   Ingresos Brutos: 901-234567-8
86362260109330199202600003000045218`;

export const ESTRUCTURA_CON_RUIDO_EN_EL_PIE = comprobante(
  encabezadoDe('ALIMENTOS DEL SUR S.R.L.', '30-99887766-1'),
  ARTICULOS_CANTIDAD_ADELANTE,
  RESUMEN_CON_RUIDO,
);

/** No es de esta factura: está acá para poder afirmar que se ignora. */
export const SALDO_ACUMULADO_AJENO = '532848.64';

/** El CAE, que tiene catorce dígitos y tampoco es un importe. */
export const CAE_AJENO = '86362260109330';

/**
 * La misma factura, pero el OCR se comió el CUIT del emisor.
 *
 * Queda uno solo en la página: el de Don Ginés, que está impreso en **todas**
 * las facturas de **todos** los proveedores. Es el número más disponible del
 * comprobante y el que un motor que agarre «el primer CUIT que encuentre» va a
 * usar, atribuyéndole medio archivo al mismo emisor.
 *
 * Lo correcto es quedarse sin CUIT y decirlo. Un dato que falta se completa en
 * la revisión; uno que está mal no se nota.
 */
export const ESTRUCTURA_SIN_CUIT_DEL_EMISOR = comprobante(
  encabezadoDe('ALIMENTOS DEL SUR S.R.L.', '30-99887766-1').replace(
    'C.U.I.T.: 30-99887766-1',
    'C.U.I.T.: ~~ilegible~~',
  ),
  ARTICULOS_CANTIDAD_ADELANTE,
  RESUMEN_CANTIDAD_ADELANTE,
);

// ---------------------------------------------------------------------------
// 8. Una marca conocida adentro de los artículos
// ---------------------------------------------------------------------------

/**
 * El artículo lo fabrica una empresa que **también es proveedora de la casa**, y
 * su nombre está impreso en la columna de marca, en el medio de la tabla.
 *
 * Es lo que hacía que la factura de Distribuidora Ezra se la quedara el
 * analizador de Los Calvos: «LOS CALVOS» aparecía en el texto y alcanzaba para
 * reclamarla. El emisor tiene que salir de la zona del emisor y de ningún otro
 * lado, y la huella del formato no puede cambiar porque cambie una marca.
 */
const ARTICULOS_CON_MARCA_CONOCIDA = `Codigo  Cantidad  Descripción               Marca              P.Unit  Desc.%  P.U.Desc.     Importe
    47     4,000  Cremoso                   LOS CALVOS      6.000,000   5,000  5.700,000  22.800,000
    48     2,500  Queso de maquina Dambo    LOS CALVOS      8.000,000   4,000  7.680,000  19.200,000
    10     3,000  Jamon cocido tradicional  BARRAZA        10.000,000   2,000  9.800,000  29.400,000`;

export const ESTRUCTURA_CON_MARCA_CONOCIDA = comprobante(
  encabezadoDe('ALIMENTOS DEL SUR S.R.L.', '30-99887766-1'),
  ARTICULOS_CON_MARCA_CONOCIDA,
  RESUMEN_CANTIDAD_ADELANTE,
);

// ---------------------------------------------------------------------------
// El importe impreso en bruto
// ---------------------------------------------------------------------------

/**
 * La otra forma de imprimir un descuento, y la que obliga al motor a decidir.
 *
 * Acá el importe del renglón es el **bruto** —cantidad × precio de lista, sin
 * tocar— y la bonificación se descuenta recién al pie. En la estructura de
 * kilos y piezas es al revés: el importe ya viene neto. Los dos papeles tienen
 * una columna de porcentaje y una de importe y se ven iguales.
 *
 * 10 × 4.000 = 40.000 y 20 × 3.000 = 60.000: cien mil de bruto. Con el 14 % de
 * bonificación quedan 86.000 de neto, 18.060 de IVA y 104.060 de total.
 */
const ARTICULOS_IMPORTE_BRUTO = ` Cod  Descripción         Kg    Precio  Bonif %    Importe
1001  Longaniza corta  10,00  4.000,00    14,00  40.000,00
1002  Salame Milan     20,00  3.000,00    14,00  60.000,00`;

const RESUMEN_IMPORTE_BRUTO = `Subtotal:            100.000,00
Descuento 14%:        14.000,00
Neto Gravado:         86.000,00
IVA 21%:              18.060,00
TOTAL:               104.060,00`;

export const ESTRUCTURA_IMPORTE_BRUTO = comprobante(
  encabezadoDe('CHACINADOS EL ROBLE S.A.', '30-77889900-3'),
  ARTICULOS_IMPORTE_BRUTO,
  RESUMEN_IMPORTE_BRUTO,
);
