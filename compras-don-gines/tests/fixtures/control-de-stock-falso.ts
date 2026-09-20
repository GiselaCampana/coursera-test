import type {
  LoteDeIngreso,
  ResultadoDelLote,
  TransporteDeStock,
} from '@/lib/services/stock-ingreso';

/**
 * **Un Control de Stock de mentira, determinístico, para probar el envío.**
 *
 * Habla el contrato versión 1 y se comporta como se le va a pedir al real:
 * aplica el lote entero o ninguno, y **deduplica por la clave de
 * idempotencia**, devolviendo `ALREADY_APPLIED` sin volver a mover nada.
 *
 * No hace red, no tiene reloj y no tiene azar. Guarda lo recibido en memoria,
 * así que una prueba puede mirar exactamente qué habría entrado a cada PLU.
 */

export interface MovimientoRecibido {
  idempotencyKey: string;
  sourceLineId: string;
  plu: string;
  quantity: string;
  unit: string;
  direction: string;
  reason: string;
  branchCode: string;
  movementId: string;
}

export type Comportamiento =
  | { tipo: 'ACEPTAR' }
  | { tipo: 'SIN_AUTORIZACION'; motivo: string }
  | { tipo: 'CONFLICTO'; motivo: string }
  | { tipo: 'RECHAZAR'; motivo: string }
  | { tipo: 'RECUPERABLE'; motivo: string }
  | { tipo: 'RESPUESTA_INVALIDA'; motivo: string }
  /**
   * **Aplica el lote, pero la respuesta se pierde.**
   *
   * Es el caso peligroso y el que hay que poder reproducir: desde Compras es
   * indistinguible de un pedido que nunca llegó, y si el reintento no llevara
   * la misma clave, la mercadería entraría dos veces.
   */
  | { tipo: 'PERDER_LA_RESPUESTA' }
  /** Se cae sin contestar, sin haber aplicado nada. */
  | { tipo: 'CAERSE'; motivo: string };

export class ControlDeStockFalso implements TransporteDeStock {
  /** Lo aplicado, por clave de idempotencia. Es «el stock» de este falso. */
  private readonly aplicados = new Map<string, MovimientoRecibido>();
  /** El contenido con el que se aplicó cada clave, para detectar conflictos. */
  private readonly huella = new Map<string, string>();
  /** Los lotes recibidos, tal cual llegaron. Para mirar el JSON exacto. */
  public readonly lotes: LoteDeIngreso[] = [];
  /** Cuántas veces se llamó, hayan entrado o no. Para contar reintentos. */
  public llamadas = 0;
  private comportamiento: Comportamiento = { tipo: 'ACEPTAR' };
  private siguiente = 1;

  public seComporta(comportamiento: Comportamiento) {
    this.comportamiento = comportamiento;
  }

  public movimientos(): MovimientoRecibido[] {
    return [...this.aplicados.values()];
  }

  public movimientosDe(plu: string): MovimientoRecibido[] {
    return this.movimientos().filter((m) => m.plu === plu);
  }

  /** El último lote recibido, para comprobar el cuerpo exacto. */
  public ultimoLote(): LoteDeIngreso | undefined {
    return this.lotes[this.lotes.length - 1];
  }

  async enviar(lote: LoteDeIngreso): Promise<ResultadoDelLote> {
    this.llamadas += 1;
    this.lotes.push(lote);

    if (this.comportamiento.tipo === 'CAERSE') throw new Error(this.comportamiento.motivo);
    if (this.comportamiento.tipo === 'SIN_AUTORIZACION') {
      return { clase: 'SIN_AUTORIZACION', motivo: this.comportamiento.motivo };
    }
    if (this.comportamiento.tipo === 'RECHAZAR') {
      return { clase: 'RECHAZADO', motivo: this.comportamiento.motivo };
    }
    if (this.comportamiento.tipo === 'RECUPERABLE') {
      return { clase: 'RECUPERABLE', motivo: this.comportamiento.motivo };
    }
    if (this.comportamiento.tipo === 'RESPUESTA_INVALIDA') {
      return { clase: 'RESPUESTA_INVALIDA', motivo: this.comportamiento.motivo };
    }
    if (this.comportamiento.tipo === 'CONFLICTO') {
      return { clase: 'CONFLICTO', motivo: this.comportamiento.motivo };
    }

    /*
     * La misma clave con otro contenido es un conflicto, no una repetición.
     * Aceptarla sería dejar que una corrección silenciosa se cuele como si
     * fuera el movimiento original.
     */
    for (const movimiento of lote.movements) {
      const huella = `${movimiento.plu}|${movimiento.quantity}|${movimiento.unit}|${lote.branchCode}`;
      const anterior = this.huella.get(movimiento.idempotencyKey);
      if (anterior !== undefined && anterior !== huella) {
        return {
          clase: 'CONFLICTO',
          motivo: `La clave ${movimiento.idempotencyKey} ya existe con otro contenido.`,
        };
      }
    }

    const porClave: Record<
      string,
      { estado: 'APPLIED' | 'ALREADY_APPLIED'; movementId?: string }
    > = {};

    for (const movimiento of lote.movements) {
      const ya = this.aplicados.get(movimiento.idempotencyKey);
      if (ya) {
        porClave[movimiento.idempotencyKey] = {
          estado: 'ALREADY_APPLIED',
          movementId: ya.movementId,
        };
        continue;
      }
      const movementId = `cs-${this.siguiente++}`;
      this.aplicados.set(movimiento.idempotencyKey, {
        idempotencyKey: movimiento.idempotencyKey,
        sourceLineId: movimiento.sourceLineId,
        plu: movimiento.plu,
        quantity: movimiento.quantity,
        unit: movimiento.unit,
        direction: movimiento.direction,
        reason: movimiento.reason,
        branchCode: lote.branchCode,
        movementId,
      });
      this.huella.set(
        movimiento.idempotencyKey,
        `${movimiento.plu}|${movimiento.quantity}|${movimiento.unit}|${lote.branchCode}`,
      );
      porClave[movimiento.idempotencyKey] = { estado: 'APPLIED', movementId };
    }

    if (this.comportamiento.tipo === 'PERDER_LA_RESPUESTA') {
      // Aplicado del otro lado, sin respuesta de este. Lo peor de los dos.
      throw new Error('La respuesta de Control de Stock no llegó.');
    }

    return { clase: 'APLICADO', porClave };
  }
}
