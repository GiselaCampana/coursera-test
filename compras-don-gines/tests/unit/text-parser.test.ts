import { describe, it, expect } from 'vitest';
import { parseDocumentFromText, splitColumns } from '@/lib/ocr/text-parser';
import { LOS_CALVOS_TEXT } from '../fixtures/los-calvos';

describe('separación en columnas', () => {
  it('no fusiona dos importes contiguos en un solo número', () => {
    const columns = splitColumns(
      '1001  LONGANIZA CORTA          16,10   16.037,00     14,00    258.195,70',
    );
    expect(columns).toEqual([
      '1001',
      'LONGANIZA CORTA',
      '16,10',
      '16.037,00',
      '14,00',
      '258.195,70',
    ]);
  });

  it('separa los importes que la foto apretada dejó pegados por un solo espacio', () => {
    // Así devuelve Tesseract un renglón cuando la tabla salió angosta.
    expect(
      splitColumns('1001  LONGANIZA CORTA             16,10 16.037,00 14,00 258.195,70'),
    ).toEqual(['1001', 'LONGANIZA CORTA', '16,10', '16.037,00', '14,00', '258.195,70']);

    // Y también cuando sólo se pegaron las dos últimas.
    expect(
      splitColumns('1009   FIAMBRE COCIDO DE PATA ZUR-LINDE   36,40   8.630,00   14,00 314.132,00'),
    ).toEqual(['1009', 'FIAMBRE COCIDO DE PATA ZUR-LINDE', '36,40', '8.630,00', '14,00', '314.132,00']);
  });

  it('no parte un importe cuyos miles están separados con espacios', () => {
    expect(splitColumns('TOTAL:                2 196 120,52')).toEqual(['TOTAL:', '2 196 120,52']);
  });

  it('separa igual cuando el OCR confundió ceros con letras', () => {
    expect(
      splitColumns('1001  LONGANIZA CORTA             l6,1O 16.O37,OO 14,OO 258.195,7O'),
    ).toEqual(['1001', 'LONGANIZA CORTA', 'l6,1O', '16.O37,OO', '14,OO', '258.195,7O']);
  });

  it('no toca las descripciones, que llevan espacios de verdad', () => {
    expect(
      splitColumns('1008  FIAMBRE DE PECHUGA DE POLLO   2,10   11.223,00   14,00   23.568,30'),
    ).toEqual(['1008', 'FIAMBRE DE PECHUGA DE POLLO', '2,10', '11.223,00', '14,00', '23.568,30']);
  });
});

describe('lectura de texto de la factura Los Calvos', () => {
  const parsed = parseDocumentFromText(LOS_CALVOS_TEXT);

  it('lee el encabezado', () => {
    expect(parsed.header.docType).toBe('FACTURA');
    expect(parsed.header.letter).toBe('A');
    expect(parsed.header.pointOfSale).toBe('0010');
    expect(parsed.header.number).toBe('00212356');
    expect(parsed.header.fullNumber).toBe('0010-00212356');
    expect(parsed.header.issueDate).toBe('2026-08-14');
    expect(parsed.header.cuit).toBe('30-61234567-9');
  });

  it('lee los nueve artículos con sus kilos y precios', () => {
    expect(parsed.items).toHaveLength(9);
    expect(parsed.items[0].description).toBe('LONGANIZA CORTA');
    expect(parsed.items[0].supplierCode).toBe('1001');
    expect(parsed.items[0].quantity).toBe('16.1');
    expect(parsed.items[0].unitNetPrice).toBe('16037');
    expect(parsed.items[0].discountPct).toBe('0.14');
    expect(parsed.items[0].grossSubtotal).toBe('258195.7');
    expect(parsed.items[8].description).toBe('FIAMBRE COCIDO DE PATA ZUR-LINDE');
    expect(parsed.items[8].quantity).toBe('36.4');
  });

  it('lee el resumen del pie', () => {
    expect(parsed.summary.grossSubtotal).toBe('2084594.7');
    expect(parsed.summary.discountTotal).toBe('291843.26');
    expect(parsed.summary.netTotal).toBe('1792751.44');
    expect(parsed.summary.ivaTotal).toBe('376477.81');
    expect(parsed.summary.perceptionsTotal).toBe('26891.27');
    expect(parsed.summary.total).toBe('2196120.52');
    expect(parsed.summary.lineCount).toBe(9);
    expect(parsed.summary.netWeightKg).toBe('153.7');
  });

  it('discrimina el IVA y la percepción por tasa', () => {
    expect(parsed.summary.ivaLines).toHaveLength(1);
    expect(parsed.summary.ivaLines![0].rate).toBe('0.21');
    expect(parsed.summary.perceptionLines).toHaveLength(1);
    expect(parsed.summary.perceptionLines![0].rate).toBe('0.015');
  });
});
