import { parseDocumentFromText } from '@/lib/ocr/text-parser';
import type { OcrProvider, OcrRequest, OcrResponse } from '@/lib/ocr/types';

/**
 * Lector local, sin servicios externos.
 *
 * Sirve para dos cosas concretas:
 *  - desarrollo y pruebas automáticas: si el archivo cargado es texto (la
 *    transcripción de un comprobante), lo interpreta de verdad con el parser de
 *    texto, así el circuito completo — lectura, control, guardado — se ejercita
 *    sin depender de una API externa;
 *  - simular fallos de lectura: `script` permite encadenar respuestas para
 *    probar la recuperación automática.
 *
 * No es un sustituto del lector real: con una foto devuelve una lectura vacía y
 * lo dice en notes, para que el validador la bloquee en lugar de inventarla.
 */
export class MockOcrProvider implements OcrProvider {
  readonly name = 'mock';
  readonly model = 'texto-local';

  private readonly script: (Partial<OcrResponse> | null)[];
  private callIndex = 0;
  /** Peticiones recibidas, para poder afirmar sobre ellas en las pruebas. */
  readonly calls: OcrRequest[] = [];

  constructor(script: (Partial<OcrResponse> | null)[] = []) {
    this.script = script;
  }

  async read(request: OcrRequest): Promise<OcrResponse> {
    this.calls.push(request);
    const scripted = this.script[this.callIndex];
    this.callIndex += 1;

    const base: OcrResponse = {
      provider: this.name,
      model: this.model,
      stage: request.stage,
      header: null,
      items: null,
      summary: null,
      itemsRegion: null,
      summaryRegion: null,
      text: null,
      overallConfidence: null,
      fieldConfidences: null,
      notes: null,
      raw: null,
    };

    if (scripted) {
      return { ...base, ...scripted, stage: request.stage };
    }

    const text = decodeIfText(request.pages.map((p) => p.buffer));
    if (!text) {
      return {
        ...base,
        overallConfidence: 0,
        notes: [
          'El lector local no interpreta imágenes: configurá ANTHROPIC_API_KEY para usar el lector real.',
        ],
      };
    }

    const parsed = parseDocumentFromText(text);
    const wantsHeader = ['FULL', 'HEADER'].includes(request.stage);
    const wantsItems = ['FULL', 'ITEMS', 'ITEMS_FOCUSED', 'ITEMS_COLUMNS'].includes(request.stage);
    const wantsSummary = ['FULL', 'SUMMARY', 'SUMMARY_FOCUSED'].includes(request.stage);

    return {
      ...base,
      header: wantsHeader ? parsed.header : null,
      items: wantsItems ? parsed.items : null,
      summary: wantsSummary ? parsed.summary : null,
      itemsRegion: { left: 0, top: 0.25, width: 1, height: 0.5 },
      summaryRegion: { left: 0.4, top: 0.7, width: 0.6, height: 0.3 },
      text,
      overallConfidence: 0.9,
      fieldConfidences: { header: 0.9, items: 0.9, summary: 0.9 },
      raw: { source: 'text-parser' },
    };
  }
}

const REPLACEMENT_CHAR = 0xfffd;

/**
 * Bytes de control (fuera de tabulador, salto de línea y retorno) o el carácter
 * de reemplazo de UTF-8: la señal de que el contenido es binario.
 */
function looksBinary(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === REPLACEMENT_CHAR) return true;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
  }
  return false;
}

/** Devuelve el texto si los buffers son UTF-8 legible; si no, null. */
function decodeIfText(buffers: Buffer[]): string | null {
  const parts: string[] = [];
  for (const buffer of buffers) {
    if (buffer.length === 0) return null;
    const text = buffer.toString('utf8');
    if (looksBinary(text)) return null;
    parts.push(text);
  }
  return parts.join('\n');
}
