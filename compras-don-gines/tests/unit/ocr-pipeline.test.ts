import { describe, it, expect } from 'vitest';
import { MockOcrProvider } from '@/lib/ocr/mock';
import { readDocument } from '@/lib/ocr/pipeline';
import { parseDocumentFromText, splitColumns } from '@/lib/ocr/text-parser';
import type { OcrPage, OcrRegion, OcrResponse } from '@/lib/ocr/types';
import {
  LOS_CALVOS_TAX_RULES,
  LOS_CALVOS_TEXT,
} from '../fixtures/los-calvos';

const page = (text: string, pageNumber = 1): OcrPage => ({
  buffer: Buffer.from(text, 'utf8'),
  mimeType: 'text/plain',
  pageNumber,
});

/** Recorte simulado: devuelve la misma "página", que es lo que necesita el test. */
const cropPage = async (p: OcrPage, _region: OcrRegion) => p;

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

describe('pipeline completo', () => {
  it('lee, calcula y controla la factura en un solo intento', async () => {
    const provider = new MockOcrProvider();
    const result = await readDocument({
      pages: [page(LOS_CALVOS_TEXT)],
      provider,
      supplierRules: LOS_CALVOS_TAX_RULES,
      cropPage,
    });

    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].stage).toBe('FULL');
    expect(result.items).toHaveLength(9);
    expect(result.report.state).toBe('OK');
    expect(result.report.canSave).toBe(true);
    expect(result.report.computed.netAmount).toBe('1792751.44');
    expect(result.report.computed.totalQuantityKg).toBe('153.700');
  });

  it('guarda el rastro de cada intento: proveedor, duración y confianza', async () => {
    const provider = new MockOcrProvider();
    const result = await readDocument({
      pages: [page(LOS_CALVOS_TEXT)],
      provider,
      supplierRules: LOS_CALVOS_TAX_RULES,
      cropPage,
    });
    const attempt = result.attempts[0];
    expect(attempt.provider).toBe('mock');
    expect(attempt.model).toBe('texto-local');
    expect(attempt.success).toBe(true);
    expect(attempt.durationMs).toBeGreaterThanOrEqual(0);
    expect(attempt.overallConfidence).toBe(0.9);
    expect(attempt.text).toContain('LONGANIZA');
    expect(attempt.raw).not.toBeNull();
  });

  it('recorre las etapas de progreso en orden', async () => {
    const stages: string[] = [];
    await readDocument({
      pages: [page(LOS_CALVOS_TEXT)],
      provider: new MockOcrProvider(),
      supplierRules: LOS_CALVOS_TAX_RULES,
      cropPage,
      onProgress: (stage) => stages.push(stage),
    });
    expect(stages).toEqual([
      'LEYENDO_ENCABEZADO',
      'LEYENDO_ARTICULOS',
      'VERIFICANDO_TOTALES',
      'LISTO',
    ]);
  });

  it('lee un comprobante de varias páginas', async () => {
    const [head, tail] = splitInvoiceInTwo(LOS_CALVOS_TEXT);
    const provider = new MockOcrProvider();
    const result = await readDocument({
      pages: [page(head, 1), page(tail, 2)],
      provider,
      supplierRules: LOS_CALVOS_TAX_RULES,
      cropPage,
    });
    expect(provider.calls[0].pages).toHaveLength(2);
    expect(result.items).toHaveLength(9);
    expect(result.report.canSave).toBe(true);
  });
});

describe('recuperación automática', () => {
  // Primera lectura: se saltea el renglón 7 y el detalle no cierra contra el
  // neto impreso. Segunda lectura focalizada: aparece el renglón que faltaba.
  const complete = parseDocumentFromText(LOS_CALVOS_TEXT);
  const incompleteItems = complete.items.filter((i) => i.lineNumber !== 7);

  const firstReading: Partial<OcrResponse> = {
    header: complete.header,
    items: incompleteItems,
    summary: complete.summary,
    itemsRegion: { left: 0, top: 0.2, width: 1, height: 0.6 },
    summaryRegion: { left: 0.4, top: 0.7, width: 0.6, height: 0.3 },
    text: 'lectura incompleta',
    overallConfidence: 0.55,
  };

  it('no acepta la primera lectura si el detalle no cierra y vuelve a leer sola', async () => {
    const provider = new MockOcrProvider([
      firstReading,
      { summary: complete.summary, text: 'pie ampliado' },
      { items: complete.items, text: 'artículos ampliados' },
    ]);

    const stages: string[] = [];
    const result = await readDocument({
      pages: [page(LOS_CALVOS_TEXT)],
      provider,
      supplierRules: LOS_CALVOS_TAX_RULES,
      cropPage,
      onProgress: (stage) => stages.push(stage),
    });

    expect(result.attempts.length).toBeGreaterThan(1);
    expect(stages).toContain('RELEYENDO');
    // La segunda vuelta pide el pie y los artículos ya recortados.
    expect(provider.calls.map((c) => c.stage)).toEqual([
      'FULL',
      'SUMMARY_FOCUSED',
      'ITEMS_FOCUSED',
    ]);
    // Y termina eligiendo la lectura consistente, con los nueve renglones.
    expect(result.items).toHaveLength(9);
    expect(result.report.errorCount).toBe(0);
    expect(result.report.canSave).toBe(true);
    // Amarillo, no verde: hizo falta más de una lectura.
    expect(result.report.state).toBe('RECONCILIADO');
  });

  it('le cuenta al lector qué fue lo que no cerró', async () => {
    const provider = new MockOcrProvider([firstReading, null, null]);
    await readDocument({
      pages: [page(LOS_CALVOS_TEXT)],
      provider,
      supplierRules: LOS_CALVOS_TAX_RULES,
      cropPage,
    });
    const retry = provider.calls[1];
    expect(retry.hints?.previousProblem).toContain('Neto de los artículos');
  });

  it('si después de los reintentos sigue sin cerrar, queda en rojo y bloquea el guardado', async () => {
    // Todas las lecturas devuelven el mismo detalle incompleto. Con
    // maxAttempts 3 el pipeline hace 5 llamadas: la completa más el pie y los
    // artículos de cada una de las dos vueltas de recuperación.
    const provider = new MockOcrProvider(Array(5).fill(firstReading));
    const result = await readDocument({
      pages: [page(LOS_CALVOS_TEXT)],
      provider,
      supplierRules: LOS_CALVOS_TAX_RULES,
      cropPage,
      maxAttempts: 3,
    });

    expect(result.report.state).toBe('DIFERENCIA');
    expect(result.report.canSave).toBe(false);
    // Conserva los datos parciales para diagnóstico.
    expect(result.items.length).toBe(8);
    expect(result.attempts.length).toBeGreaterThan(1);
    const netCheck = result.report.checks.find((c) => c.code === 'ART_NETO');
    expect(netCheck?.severity).toBe('ERROR');
  });

  it('elige el conjunto más consistente aunque no sea el último leído', async () => {
    const provider = new MockOcrProvider([
      firstReading,
      { summary: complete.summary },
      { items: complete.items },
      // Una tercera lectura peor todavía: no debería ganar.
      { items: complete.items.slice(0, 5) },
    ]);
    const result = await readDocument({
      pages: [page(LOS_CALVOS_TEXT)],
      provider,
      supplierRules: LOS_CALVOS_TAX_RULES,
      cropPage,
      maxAttempts: 3,
    });
    expect(result.items).toHaveLength(9);
    expect(result.report.canSave).toBe(true);
  });

  it('no inventa datos para hacer cerrar la cuenta', async () => {
    const provider = new MockOcrProvider(Array(5).fill(firstReading));
    const result = await readDocument({
      pages: [page(LOS_CALVOS_TEXT)],
      provider,
      supplierRules: LOS_CALVOS_TAX_RULES,
      cropPage,
      maxAttempts: 3,
    });
    // Sigue faltando el renglón: no se completó con uno fabricado, ni se
    // estiraron los importes de los otros ocho para llegar al neto impreso.
    expect(result.items).toHaveLength(8);
    expect(result.items.map((i) => i.description)).not.toContain('JAMON COCIDO MONT-BLANC');
    expect(result.report.computed.netAmount).toBe('1311998.02');
    expect(result.report.canSave).toBe(false);
  });
});

function splitInvoiceInTwo(text: string): [string, string] {
  const lines = text.split('\n');
  const cut = lines.findIndex((l) => /^1006/.test(l.trim()));
  return [lines.slice(0, cut).join('\n'), lines.slice(cut).join('\n')];
}
