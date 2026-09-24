'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/session';
import {
  aplicarIngresoDeCompra,
  cambiarInterruptorDeRecepciones,
  type ResultadoDeRecepcion,
} from '@/lib/services/stock-erp-recepcion';
import { AppError, ConflictError } from '@/lib/errors';

/**
 * Las acciones de las pantallas de recepción.
 *
 * Cáscaras finas, igual que en la apertura: leen el formulario, llaman al
 * servicio y traducen el error. **Ninguna regla vive acá.** El permiso, la
 * doble confirmación, el corte, el interruptor y la huella los decide el
 * servicio, que es lo que corre aunque el pedido llegue sin pasar por esta
 * pantalla.
 */

export interface Resultado {
  ok: boolean;
  mensaje: string;
  /**
   * Un conflicto de huella se marca aparte del resto de los errores.
   *
   * No es lo mismo «no se pudo» que «alguien ya decidió esto de otra manera»:
   * el segundo caso hay que poder verlo y entenderlo en la pantalla, no
   * enterarse por un cartel rojo genérico.
   */
  conflicto?: boolean;
  /** Presente cuando la operación devolvió su resultado guardado. */
  detalle?: ResultadoDeRecepcion;
}

function traducir(e: unknown): Resultado {
  if (e instanceof ConflictError) return { ok: false, mensaje: e.message, conflicto: true };
  if (e instanceof AppError) return { ok: false, mensaje: e.message };
  return { ok: false, mensaje: 'No se pudo completar la operación.' };
}

function refrescar(documentId?: string) {
  revalidatePath('/stock-erp/recepciones');
  if (documentId) revalidatePath(`/stock-erp/recepciones/${documentId}`);
}

export async function recibirLaCompra(_p: Resultado | null, f: FormData): Promise<Resultado> {
  const documentId = String(f.get('documentId') ?? '');
  try {
    const user = await requireUser();
    const r = await aplicarIngresoDeCompra(user, {
      documentId,
      /* Fecha y hora ARGENTINAS, cargadas por la persona. Nunca la del papel. */
      fecha: String(f.get('fecha') ?? ''),
      hora: String(f.get('hora') ?? ''),
      confirmado: f.get('confirmado') === 'si',
      motivo: (String(f.get('motivo') ?? '').trim() || null) as string | null,
      excepcionHistorica: f.get('excepcionHistorica') === 'si',
    });
    refrescar(documentId);
    return {
      ok: true,
      detalle: r,
      mensaje: r.yaEstabaAplicada
        ? `Esta recepción ya estaba registrada (${r.resolucion}, ${r.movimientos} movimientos). No se duplicó nada.`
        : r.resolucion === 'APLICADA'
          ? `Recepción aplicada: ${r.movimientos} movimientos de mercadería.`
          : r.resolucion === 'INCLUIDA_EN_APERTURA'
            ? 'Registrado: la mercadería ya estaba comprendida en la apertura. No se generó ningún movimiento.'
            : 'Registrado: el comprobante no tiene mercadería con impacto en existencias.',
    };
  } catch (e) {
    return traducir(e);
  }
}

export async function cambiarElInterruptor(_p: Resultado | null, f: FormData): Promise<Resultado> {
  try {
    const user = await requireUser();
    await cambiarInterruptorDeRecepciones(user, {
      encender: f.get('encender') === 'si',
      motivo: String(f.get('motivo') ?? ''),
    });
    refrescar();
    return { ok: true, mensaje: 'Interruptor de recepciones reales cambiado.' };
  } catch (e) {
    return traducir(e);
  }
}
