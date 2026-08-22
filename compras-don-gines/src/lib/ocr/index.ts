import { env } from '@/lib/env';
import { MockOcrProvider } from '@/lib/ocr/mock';
import type { OcrProvider } from '@/lib/ocr/types';

/**
 * Fábrica del lector.
 *
 * Este es el único lugar donde se elige un proveedor concreto. Todo lo demás
 * depende de la interfaz OcrProvider, así que sumar un OCR documental o
 * Tesseract es agregar una clase acá, sin tocar la lógica del negocio.
 */
export async function getOcrProvider(): Promise<OcrProvider> {
  if (env.ocrProvider === 'anthropic') {
    const { AnthropicOcrProvider } = await import('@/lib/ocr/anthropic');
    return new AnthropicOcrProvider();
  }
  return new MockOcrProvider();
}

export { MockOcrProvider };
export * from '@/lib/ocr/types';
export { readDocument, PROGRESS_LABEL } from '@/lib/ocr/pipeline';
export type { PipelineResult, AttemptRecord, ProgressStage } from '@/lib/ocr/pipeline';
