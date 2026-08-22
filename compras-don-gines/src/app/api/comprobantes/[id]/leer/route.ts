import { requireUser } from '@/lib/auth/session';
import { toUserMessage } from '@/lib/errors';
import { processDocument } from '@/lib/services/documents';
import { PROGRESS_LABEL, type ProgressStage } from '@/lib/ocr/pipeline';

// Leer una factura con varias páginas y relecturas focalizadas puede tardar.
export const maxDuration = 300;

/**
 * Lectura del comprobante, con el progreso en vivo.
 *
 * Va emitiendo eventos a medida que avanza (preparando, leyendo el encabezado,
 * leyendo los artículos, verificando los totales) para que quien está en el
 * mostrador vea que la aplicación está trabajando y no una ruedita muda.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (evento: string, datos: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${evento}\ndata: ${JSON.stringify(datos)}\n\n`),
        );
      };

      try {
        const user = await requireUser();
        send('progreso', { etapa: 'PREPARANDO', texto: PROGRESS_LABEL.PREPARANDO });

        const result = await processDocument(user, id, (etapa: ProgressStage, detalle?: string) => {
          send('progreso', { etapa, texto: PROGRESS_LABEL[etapa], detalle: detalle ?? null });
        });

        send('listo', {
          documentId: result.documentId,
          estado: result.report.state,
          puedeGuardar: result.report.canSave,
          controles: result.report.checks,
          calculado: result.report.computed,
          renglonesAsociados: result.matchedItems,
          renglonesSinAsociar: result.unmatchedItems,
          intentos: result.attempts,
          observaciones: result.notes,
        });
      } catch (error) {
        send('error', { mensaje: toUserMessage(error) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Evita que un proxy con buffer retenga los eventos hasta el final.
      'X-Accel-Buffering': 'no',
    },
  });
}
