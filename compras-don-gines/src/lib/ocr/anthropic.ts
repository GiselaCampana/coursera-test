import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { env } from '@/lib/env';
import { AppError } from '@/lib/errors';
import { OcrReadingSchema } from '@/lib/ocr/schema';
import { OCR_SYSTEM_PROMPT, buildStagePrompt } from '@/lib/ocr/prompts';
import type { OcrProvider, OcrRequest, OcrResponse } from '@/lib/ocr/types';

/**
 * Lector basado en el modelo multimodal de Anthropic.
 *
 * Implementa OcrProvider, así que el resto de la aplicación no sabe que existe:
 * cambiar de proveedor es cambiar la fábrica de src/lib/ocr/index.ts.
 */
export class AnthropicOcrProvider implements OcrProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;

  constructor(apiKey: string = env.anthropicApiKey, model: string = env.anthropicModel) {
    this.model = model;
    this.client = new Anthropic({
      apiKey,
      // Leer una factura con varias páginas puede tardar; el default de 10
      // minutos del SDK es suficiente, pero conviene reintentar los 429/5xx.
      maxRetries: 3,
    });
  }

  async read(request: OcrRequest): Promise<OcrResponse> {
    if (request.pages.length === 0) {
      throw new AppError('No hay ninguna imagen para leer.', { code: 'SIN_PAGINAS' });
    }

    const content: Anthropic.ContentBlockParam[] = [];
    for (const page of request.pages) {
      const data = page.buffer.toString('base64');
      if (page.mimeType === 'application/pdf') {
        content.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data },
        });
      } else {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: normalizeImageMedia(page.mimeType),
            data,
          },
        });
      }
    }
    content.push({ type: 'text', text: buildStagePrompt(request) });

    let response;
    try {
      response = await this.client.messages.parse({
        model: this.model,
        max_tokens: 16000,
        system: OCR_SYSTEM_PROMPT,
        output_config: {
          effort: env.anthropicEffort as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
          format: zodOutputFormat(OcrReadingSchema),
        },
        messages: [{ role: 'user', content }],
      });
    } catch (error) {
      throw translateProviderError(error);
    }

    if (response.stop_reason === 'refusal') {
      throw new AppError(
        'El servicio de lectura no pudo procesar esta imagen. Probá con otra foto del comprobante.',
        { code: 'LECTURA_RECHAZADA' },
      );
    }

    const parsed = response.parsed_output;
    if (!parsed) {
      throw new AppError(
        'El servicio de lectura devolvió una respuesta que no pudimos interpretar. Volvé a intentar.',
        { code: 'RESPUESTA_ILEGIBLE' },
      );
    }

    return {
      provider: this.name,
      model: this.model,
      stage: request.stage,
      header: parsed.header,
      items: parsed.items,
      summary: parsed.summary,
      itemsRegion: parsed.itemsRegion,
      summaryRegion: parsed.summaryRegion,
      text: parsed.recognizedText,
      overallConfidence: parsed.overallConfidence,
      fieldConfidences: parsed.fieldConfidences,
      notes: parsed.notes,
      // Se guarda la respuesta cruda para poder auditar y diagnosticar después.
      raw: {
        id: response.id,
        model: response.model,
        stopReason: response.stop_reason,
        usage: response.usage,
        output: parsed,
      },
    };
  }
}

function normalizeImageMedia(mime: string): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
  switch (mime) {
    case 'image/png':
      return 'image/png';
    case 'image/webp':
      return 'image/webp';
    case 'image/gif':
      return 'image/gif';
    default:
      // Las imágenes de trabajo siempre se normalizan a JPEG antes de llegar acá.
      return 'image/jpeg';
  }
}

function translateProviderError(error: unknown): AppError {
  if (error instanceof Anthropic.AuthenticationError) {
    return new AppError(
      'El servicio de lectura rechazó las credenciales. Hay que revisar la configuración del sistema.',
      { status: 500, code: 'OCR_CREDENCIALES' },
    );
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new AppError(
      'El servicio de lectura está saturado en este momento. Esperá unos segundos y volvé a intentar.',
      { status: 503, code: 'OCR_SATURADO' },
    );
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new AppError(
      'No pudimos conectarnos con el servicio de lectura. Revisá la conexión y volvé a intentar.',
      { status: 503, code: 'OCR_SIN_CONEXION' },
    );
  }
  if (error instanceof Anthropic.BadRequestError) {
    return new AppError(
      'El servicio de lectura no aceptó la imagen. Puede ser demasiado grande o estar dañada.',
      { status: 400, code: 'OCR_IMAGEN_RECHAZADA' },
    );
  }
  if (error instanceof Anthropic.APIError) {
    return new AppError('El servicio de lectura falló. Volvé a intentar en un momento.', {
      status: 502,
      code: 'OCR_ERROR',
    });
  }
  return new AppError('No pudimos leer el comprobante. Volvé a intentar.', {
    status: 500,
    code: 'OCR_ERROR',
  });
}
