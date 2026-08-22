import type { Metadata } from 'next';
import { requireUser } from '@/lib/auth/session';
import { env } from '@/lib/env';
import { PanelDiagnostico } from './PanelDiagnostico';

export const metadata: Metadata = { title: 'Diagnóstico de lectura' };
export const dynamic = 'force-dynamic';

/**
 * Pantalla para averiguar por qué un comprobante no se lee bien.
 *
 * Corre exactamente el mismo circuito que la carga real —misma preparación de
 * imagen, mismo Tesseract, mismos analizadores, mismos autocontroles— pero **no
 * guarda nada**: ni comprobante, ni imagen, ni espacio ocupado. Se puede usar en
 * el teléfono, en el local, con la factura que está dando problemas.
 */
export default async function PaginaDiagnostico() {
  const user = await requireUser();
  return <PanelDiagnostico maximoIntentos={env.ocrMaxAttempts} usuario={user.name} />;
}
