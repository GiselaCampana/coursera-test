import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import { registrarLectura, type LecturaEntrante } from '@/lib/services/lectura';
import { handle, readJson } from '@/lib/api';

// Interpretar y controlar una factura de nueve renglones es cuestión de
// milisegundos: el trabajo pesado, el OCR, ya lo hizo el teléfono.
export const maxDuration = 60;

/**
 * Recibe el texto que el navegador reconoció y devuelve el informe de control.
 *
 * El navegador manda texto; interpretar, calcular y decidir si el comprobante
 * cierra es tarea del servidor. Si no cierra y todavía quedan vueltas, la
 * respuesta trae `releer` con el motivo, y el teléfono vuelve a leer las zonas
 * que hicieron falta.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser();
    const { id } = await params;
    const lectura = await readJson<LecturaEntrante>(request);

    const resultado = await registrarLectura(user, id, lectura);

    return NextResponse.json({
      documentId: resultado.documentId,
      estado: resultado.report.state,
      puedeGuardar: resultado.report.canSave,
      controles: resultado.report.checks,
      calculado: resultado.report.computed,
      analizador: resultado.analizador,
      renglonesAsociados: resultado.renglonesAsociados,
      renglonesSinAsociar: resultado.renglonesSinAsociar,
      intentos: resultado.intentos,
      observaciones: resultado.observaciones,
      releer: resultado.releer,
    });
  });
}
