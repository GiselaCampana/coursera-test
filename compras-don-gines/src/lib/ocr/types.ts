/**
 * Contrato del servicio de lectura.
 *
 * Todo lo numérico viaja como string en formato canónico (punto decimal, sin
 * separadores de miles) para no perder precisión en el camino ni depender de
 * cómo serializa números cada proveedor. La conversión a Decimal la hace el
 * dominio, con parseCanonicalNumber.
 *
 * Ningún módulo de negocio importa un proveedor concreto: hablan con
 * OcrProvider, así que cambiar de Claude a otro servicio de visión no toca la
 * lógica contable.
 */

export type OcrStage =
  /** Todo el comprobante de una: encabezado, artículos y resumen. */
  | 'FULL'
  /** Sólo el encabezado: tipo, proveedor, número, fecha. */
  | 'HEADER'
  /** Sólo la tabla de artículos. */
  | 'ITEMS'
  /** Sólo el resumen del pie. */
  | 'SUMMARY'
  /** Relectura de la tabla de artículos ya recortada y ampliada. */
  | 'ITEMS_FOCUSED'
  /** Relectura del pie ya recortado y ampliado. */
  | 'SUMMARY_FOCUSED'
  /** Lectura por columnas, para reconstruir renglones que no cerraron. */
  | 'ITEMS_COLUMNS';

export interface OcrPage {
  buffer: Buffer;
  mimeType: string;
  /** Número de página dentro del comprobante, empezando en 1. */
  pageNumber: number;
}

export interface OcrRequest {
  stage: OcrStage;
  pages: OcrPage[];
  /** Contexto que ayuda a leer mejor sin condicionar el resultado. */
  hints?: {
    supplierNames?: string[];
    expectedLineCount?: number | null;
    knownTotals?: Partial<OcrSummary>;
    previousProblem?: string;
  };
}

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

export interface OcrResponse {
  provider: string;
  model?: string | null;
  stage: OcrStage;
  header?: OcrHeader | null;
  items?: OcrItem[] | null;
  summary?: OcrSummary | null;
  /** Dónde está la tabla de artículos, para poder recortarla y releerla. */
  itemsRegion?: OcrRegion | null;
  /** Dónde está el resumen del pie. */
  summaryRegion?: OcrRegion | null;
  /** Texto reconocido, se guarda siempre para poder diagnosticar. */
  text?: string | null;
  /** 0..1 */
  overallConfidence?: number | null;
  /** { campo: 0..1 } */
  fieldConfidences?: Record<string, number> | null;
  /** Respuesta cruda del proveedor, tal cual llegó. */
  raw?: unknown;
  /** Lo que el lector no pudo resolver. Nunca se completa inventando. */
  notes?: string[] | null;
}

export interface OcrProvider {
  readonly name: string;
  readonly model?: string;
  read(request: OcrRequest): Promise<OcrResponse>;
}
