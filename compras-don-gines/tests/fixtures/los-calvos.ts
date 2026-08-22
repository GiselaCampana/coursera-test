import type { RawItem } from '@/lib/domain/costing';
import type { PrintedSummary } from '@/lib/domain/validation';

/**
 * Factura A 0010-00212356 de Los Calvos, 14/08/2026.
 * Es el caso obligatorio de aceptación del proyecto.
 */
export const LOS_CALVOS_HEADER = {
  supplier: 'Los Calvos',
  docType: 'FACTURA' as const,
  letter: 'A',
  pointOfSale: '0010',
  number: '00212356',
  fullNumber: '0010-00212356',
  issueDate: '2026-08-14',
  currency: 'ARS',
};

export const LOS_CALVOS_PRINTED: PrintedSummary = {
  grossSubtotal: '2084594.70',
  discountTotal: '291843.26',
  netTotal: '1792751.44',
  ivaTotal: '376477.81',
  perceptionsTotal: '26891.27',
  total: '2196120.52',
  lineCount: 9,
  netWeightKg: '153.70',
};

const DISCOUNT = '0.14';

export const LOS_CALVOS_ITEMS: RawItem[] = [
  { lineNumber: 1, description: 'Longaniza corta', quantity: '16.10', unitNetPrice: '16037', unit: 'KG', discountPct: DISCOUNT, ivaRate: '0.21' },
  { lineNumber: 2, description: 'Salame Crespón', quantity: '3.40', unitNetPrice: '14256', unit: 'KG', discountPct: DISCOUNT, ivaRate: '0.21' },
  { lineNumber: 3, description: 'Salame Milán', quantity: '10.90', unitNetPrice: '14256', unit: 'KG', discountPct: DISCOUNT, ivaRate: '0.21' },
  { lineNumber: 4, description: 'Bondiola al papel', quantity: '4.50', unitNetPrice: '20621', unit: 'KG', discountPct: DISCOUNT, ivaRate: '0.21' },
  { lineNumber: 5, description: 'Jamón crudo Parma', quantity: '5.00', unitNetPrice: '30327', unit: 'KG', discountPct: DISCOUNT, ivaRate: '0.21' },
  { lineNumber: 6, description: 'Jamón cocido', quantity: '37.60', unitNetPrice: '12803', unit: 'KG', discountPct: DISCOUNT, ivaRate: '0.21' },
  { lineNumber: 7, description: 'Jamón cocido Mont-Blanc', quantity: '37.70', unitNetPrice: '14828', unit: 'KG', discountPct: DISCOUNT, ivaRate: '0.21' },
  { lineNumber: 8, description: 'Fiambre de pechuga de pollo ahumado y horneado', quantity: '2.10', unitNetPrice: '11223', unit: 'KG', discountPct: DISCOUNT, ivaRate: '0.21' },
  { lineNumber: 9, description: 'Fiambre cocido de pata Zur-Linde', quantity: '36.40', unitNetPrice: '8630', unit: 'KG', discountPct: DISCOUNT, ivaRate: '0.21' },
];

export const LOS_CALVOS_TAX_RULES = { ivaRate: '0.21', iibbRate: '0.015' };

/** Texto plano equivalente, para el lector de respaldo y las pruebas de OCR. */
export const LOS_CALVOS_TEXT = `
LOS CALVOS S.A.
FACTURA A                  Punto de Venta: 0010   Comp. Nro: 00212356
Fecha de Emisión: 14/08/2026
CUIT: 30-61234567-9

Cod   Descripción                                          Kg      Precio       Bonif %      Importe
1001  LONGANIZA CORTA                                    16,10   16.037,00        14,00    258.195,70
1002  SALAME CRESPON                                      3,40   14.256,00        14,00     48.470,40
1003  SALAME MILAN                                       10,90   14.256,00        14,00    155.390,40
1004  BONDIOLA AL PAPEL                                   4,50   20.621,00        14,00     92.794,50
1005  JAMON CRUDO PARMA                                   5,00   30.327,00        14,00    151.635,00
1006  JAMON COCIDO                                       37,60   12.803,00        14,00    481.392,80
1007  JAMON COCIDO MONT-BLANC                            37,70   14.828,00        14,00    559.015,60
1008  FIAMBRE DE PECHUGA DE POLLO AHUMADO Y HORNEADO      2,10   11.223,00        14,00     23.568,30
1009  FIAMBRE COCIDO DE PATA ZUR-LINDE                   36,40    8.630,00        14,00    314.132,00

Cantidad de renglones: 9          Peso neto: 153,70 kg
Subtotal:                     2.084.594,70
Descuento 14%:                  291.843,26
Neto Gravado:                 1.792.751,44
IVA 21%:                        376.477,81
Percepción IIBB 1,5%:            26.891,27
TOTAL:                        2.196.120,52
`.trim();

/**
 * El mismo comprobante tal como sale de Tesseract, por zonas.
 *
 * Incluye las confusiones típicas del OCR sobre una foto: la O por el cero, la
 * l por el uno, la S por el cinco. Sirve para verificar que el analizador de
 * Los Calvos las corrige en las columnas numéricas sin tocar las descripciones,
 * y que el comprobante igual cierra.
 */
export const LOS_CALVOS_ENCABEZADO_OCR = `
LOS CALVOS S.A.
FACTURA A                  Punto de Venta: OO1O   Comp. Nro: OO212356
Fecha de Emisión: l4/O8/2O26
CUIT: 3O-61234567-9
`.trim();

export const LOS_CALVOS_ARTICULOS_OCR = `
Cod   Descripción                                          Kg      Precio       Bonif %      Importe
1001  LONGANIZA CORTA                                    l6,1O   16.O37,OO        14,OO    258.195,7O
1002  SALAME CRESPON                                      3,4O   14.256,OO        14,OO     48.47O,4O
1003  SALAME MILAN                                       1O,9O   14.256,OO        14,OO    155.39O,4O
1004  BONDIOLA AL PAPEL                                   4,5O   2O.621,OO        14,OO     92.794,5O
1005  JAMON CRUDO PARMA                                   5,OO   3O.327,OO        14,OO    151.635,OO
1006  JAMON COCIDO                                       37,6O   12.8O3,OO        14,OO    481.392,8O
1007  JAMON COCIDO MONT-BLANC                            37,7O   14.828,OO        14,OO    559.O15,6O
1008  FIAMBRE DE PECHUGA DE POLLO AHUMADO Y HORNEADO      2,1O   11.223,OO        14,OO     23.568,3O
1009  FIAMBRE COCIDO DE PATA ZUR-LINDE                   36,4O    8.63O,OO        14,OO    314.132,OO
`.trim();

export const LOS_CALVOS_RESUMEN_OCR = `
Cantidad de renglones: 9          Peso neto: 1S3,7O kg
Subtotal:                     2.O84.594,7O
Descuento 14%:                  291.843,26
Neto Gravado:                 1.792.751,44
IVA 21%:                        376.477,81
Percepción IIBB 1,5%:            26.891,27
TOTAL:                        2.196.12O,52
`.trim();
