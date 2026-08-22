import { z } from 'zod';

/**
 * Esquema de salida del lector.
 *
 * Todo lo numérico es string en formato canónico (punto decimal, sin
 * separadores de miles) para que no se pierda precisión al serializar. Todos
 * los campos son nullable y ninguno es opcional: se le pide al modelo que
 * devuelva null cuando el dato no está impreso, en vez de omitirlo o de
 * completarlo con algo verosímil.
 */

const numeric = z.string().nullable();

export const OcrHeaderSchema = z.object({
  docType: z.enum(['FACTURA', 'REMITO']).nullable(),
  letter: z.string().nullable(),
  pointOfSale: z.string().nullable(),
  number: z.string().nullable(),
  fullNumber: z.string().nullable(),
  issueDate: z.string().nullable(),
  supplierName: z.string().nullable(),
  legalName: z.string().nullable(),
  cuit: z.string().nullable(),
  currency: z.string().nullable(),
});

export const OcrTaxLineSchema = z.object({
  label: z.string(),
  rate: numeric,
  base: numeric,
  amount: z.string(),
});

export const OcrSummarySchema = z.object({
  grossSubtotal: numeric,
  discountTotal: numeric,
  netTotal: numeric,
  ivaLines: z.array(OcrTaxLineSchema),
  perceptionLines: z.array(OcrTaxLineSchema),
  ivaTotal: numeric,
  perceptionsTotal: numeric,
  total: numeric,
  lineCount: z.number().int().nullable(),
  netWeightKg: numeric,
  totalUnits: numeric,
  packageCount: z.number().int().nullable(),
});

export const OcrItemSchema = z.object({
  lineNumber: z.number().int(),
  supplierCode: z.string().nullable(),
  description: z.string(),
  quantity: numeric,
  unit: z.enum(['KG', 'UNIT']).nullable(),
  pieceCount: z.number().int().nullable(),
  totalWeightKg: numeric,
  unitNetPrice: numeric,
  grossSubtotal: numeric,
  discountPct: numeric,
  discountAmount: numeric,
  netAmount: numeric,
  ivaRate: numeric,
});

export const OcrRegionSchema = z.object({
  left: z.number(),
  top: z.number(),
  width: z.number(),
  height: z.number(),
});

export const OcrReadingSchema = z.object({
  header: OcrHeaderSchema.nullable(),
  items: z.array(OcrItemSchema).nullable(),
  summary: OcrSummarySchema.nullable(),
  itemsRegion: OcrRegionSchema.nullable(),
  summaryRegion: OcrRegionSchema.nullable(),
  recognizedText: z.string().nullable(),
  overallConfidence: z.number().nullable(),
  fieldConfidences: z.record(z.string(), z.number()).nullable(),
  notes: z.array(z.string()).nullable(),
});

export type OcrReading = z.infer<typeof OcrReadingSchema>;
