import type {
  EventoDeIngreso,
  ResultadoDelEnvio,
  TransporteDeStock,
} from '@/lib/services/stock-ingreso';

/**
 * **Un Control de Stock de mentira, determinístico, para probar el envío.**
 *
 * Existe porque el contrato de escritura todavía no está acordado: no hay
 * endpoint, ni identificador de sucursal confirmado, ni lista de rechazos. Lo
 * que sí se puede probar —y es la parte que se rompe sola en producción— es
 * todo lo de este lado: que la mercadería entre y no salga, que un reintento no
 * duplique, que un timeout no se presente como éxito.
 *
 * No hace red, no tiene reloj y no tiene azar. Guarda lo recibido en memoria y
 * **deduplica por la clave del evento**, que es exactamente lo que se le va a
 * pedir al Control de Stock real: recibir dos veces la misma clave y contestar
 * lo mismo sin volver a mover nada.
 */

export interface MovimientoRecibido {
  eventKey: string;
  direccion: string;
  plu: string;
  quantity: string;
  unit: string;
  branchKey: string;
  externalId: string;
  documentItemId: string;
}

export type Comportamiento =
  | { tipo: 'ACEPTAR' }
  /** Contesta un error con nombre: 401, 403, 409, 422, 500… */
  | { tipo: 'RECHAZAR'; motivo: string }
  /**
   * **Recibe y aplica el movimiento, pero la respuesta se pierde.**
   *
   * Es el caso peligroso y el que hay que poder reproducir: del lado de
   * Compras es indistinguible de un pedido que nunca llegó, y si el reintento
   * no dedujera por clave, la mercadería entraría dos veces.
   */
  | { tipo: 'PERDER_LA_RESPUESTA' }
  /** Se cae sin contestar, sin haber aplicado nada. */
  | { tipo: 'CAERSE'; motivo: string };

export class ControlDeStockFalso implements TransporteDeStock {
  /** Lo aplicado, por clave de evento. Es «el stock» de este Control falso. */
  private readonly aplicados = new Map<string, MovimientoRecibido>();
  /** Cuántas veces se llamó, hayan entrado o no. Para contar reintentos. */
  public llamadas = 0;
  private comportamiento: Comportamiento = { tipo: 'ACEPTAR' };
  private siguiente = 1;

  public seComporta(comportamiento: Comportamiento) {
    this.comportamiento = comportamiento;
  }

  /** Los movimientos efectivamente aplicados, en orden de llegada. */
  public movimientos(): MovimientoRecibido[] {
    return [...this.aplicados.values()];
  }

  public movimientosDe(plu: string): MovimientoRecibido[] {
    return this.movimientos().filter((m) => m.plu === plu);
  }

  async enviar(evento: EventoDeIngreso): Promise<ResultadoDelEnvio> {
    this.llamadas += 1;

    if (this.comportamiento.tipo === 'CAERSE') {
      throw new Error(this.comportamiento.motivo);
    }
    if (this.comportamiento.tipo === 'RECHAZAR') {
      return { estado: 'RECHAZADO', motivo: this.comportamiento.motivo };
    }

    /*
     * La deduplicación, que es lo que se está probando.
     *
     * Si la clave ya está, no se aplica de nuevo: se devuelve el identificador
     * de la vez anterior. Un Control de Stock que no hiciera esto duplicaría la
     * mercadería en cada reintento, y por eso es la pregunta 4 de las que hay
     * que acordar con ellos.
     */
    const anterior = this.aplicados.get(evento.eventKey);
    if (anterior) {
      return { estado: 'YA_ESTABA', externalId: anterior.externalId };
    }

    const externalId = `cs-${this.siguiente++}`;
    this.aplicados.set(evento.eventKey, {
      eventKey: evento.eventKey,
      direccion: evento.direccion,
      plu: evento.plu,
      quantity: evento.quantity,
      unit: evento.unit,
      branchKey: evento.branchKey,
      externalId,
      documentItemId: evento.origen.documentItemId,
    });

    if (this.comportamiento.tipo === 'PERDER_LA_RESPUESTA') {
      // Aplicado del otro lado, sin respuesta de este. Lo peor de los dos.
      throw new Error('La respuesta de Control de Stock no llegó.');
    }

    return { estado: 'ACEPTADO', externalId };
  }
}
