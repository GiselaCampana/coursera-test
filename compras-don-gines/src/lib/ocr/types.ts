/**
 * Vocabulario de la lectura de comprobantes.
 *
 * La lectura automática corre entera en el teléfono: Tesseract en un Web Worker
 * produce texto, y el servidor lo interpreta con los analizadores de
 * `@/lib/ocr/parsers`. No interviene ningún servicio pago ni ninguna clave de
 * API: el costo por comprobante es cero.
 *
 * Todo lo numérico viaja como string en formato canónico (punto decimal, sin
 * separadores de miles) para no perder precisión en el camino. La conversión a
 * Decimal la hace el dominio, con parseCanonicalNumber.
 */

/**
 * Qué parte de la imagen conviene volver a mirar.
 *
 * El servidor no sabe dónde cae nada en la foto: sabe qué le faltó al texto. La
 * geometría la tiene el lector, que es el que recortó las zonas. Por eso esto es
 * un nombre de zona y no un rectángulo — el que sabe dónde está el borde de la
 * tabla es el teléfono.
 *
 * `BORDE_INFERIOR_TABLA` es el caso de TOMATE EN BOTELLA: el recorte de la tabla
 * se cortó antes de terminar, quedó un jirón con forma de fila entre el último
 * artículo leído y el pie, y hay más filas vistas que renglones entendidos. Con
 * los tres a la vez, la fila que falta está en la franja de abajo y no hace
 * falta releer nada más.
 *
 * Vive acá y no en el servicio de lectura porque lo usan los dos lados: el
 * servidor lo emite y el lector del navegador lo consume, y el servicio es
 * `server-only`.
 */
export type ZonaAReleer = 'BORDE_INFERIOR_TABLA';

export interface OcrHeader {
  docType?: 'FACTURA' | 'REMITO' | null;
  letter?: string | null;
  pointOfSale?: string | null;
  number?: string | null;
  fullNumber?: string | null;
  /** ISO "YYYY-MM-DD" o la fecha tal como está impresa. */
  issueDate?: string | null;
  supplierName?: string | null;
  legalName?: string | null;
  cuit?: string | null;
  currency?: string | null;
}

export interface OcrTaxLine {
  label: string;
  /** Fracción o porcentaje; el dominio lo normaliza con parseRate. */
  rate?: string | null;
  base?: string | null;
  amount: string;
}

export interface OcrSummary {
  grossSubtotal?: string | null;
  discountTotal?: string | null;
  netTotal?: string | null;
  ivaLines?: OcrTaxLine[];
  perceptionLines?: OcrTaxLine[];
  ivaTotal?: string | null;
  perceptionsTotal?: string | null;
  total?: string | null;
  /** Cantidad de renglones que declara el comprobante. */
  lineCount?: number | null;
  netWeightKg?: string | null;
  totalUnits?: string | null;
  packageCount?: number | null;
}

export interface OcrItem {
  lineNumber: number;
  supplierCode?: string | null;
  description: string;
  quantity?: string | null;
  unit?: 'KG' | 'UNIT' | null;
  pieceCount?: number | null;
  totalWeightKg?: string | null;
  unitNetPrice?: string | null;
  grossSubtotal?: string | null;
  /** Porcentaje de descuento tal como está impreso ("14,00"). */
  discountPct?: string | null;
  discountAmount?: string | null;
  netAmount?: string | null;
  ivaRate?: string | null;
}

/** Zona de la imagen, en coordenadas relativas 0..1. */
export interface OcrRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Punto de extensión, hoy desactivado.
 *
 * La aplicación no lo usa ni lo necesita: la lectura gratuita con Tesseract es
 * el único camino que corre. Queda declarado para que, si algún día se quisiera
 * sumar un lector asistido por IA como *ayuda opcional*, exista un contrato al
 * que enchufarlo sin tocar la contabilidad ni los analizadores. Mientras no se
 * implemente, nada en el código lo invoca.
 */
export interface LectorAsistidoOpcional {
  readonly nombre: string;
  /** Recibe el texto ya reconocido en el teléfono y devuelve una lectura alternativa. */
  interpretar(texto: string): Promise<{
    header?: OcrHeader | null;
    items?: OcrItem[] | null;
    summary?: OcrSummary | null;
  }>;
}
