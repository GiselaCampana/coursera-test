'use client';

/**
 * Pedidos al servidor, tolerantes al arranque en frío.
 *
 * En el plan gratuito de Render la aplicación se apaga después de un rato sin
 * visitas y tarda hasta un minuto en volver. Eso no es un error: es cómo
 * funciona el plan. Pero para quien está del otro lado se ve igual que una
 * falla, así que hay que explicarlo y esperar, no mostrar "Failed to fetch".
 *
 * Lo que se reintenta es sólo lo que tiene sentido reintentar: un pedido que
 * no llegó a destino, o al que el servidor contestó que todavía no está listo
 * (502, 503, 504). Un 400 o un 422 son respuestas legítimas —el comprobante
 * está mal, el usuario no tiene permiso— y reintentarlas sería insistir con
 * algo que ya se contestó.
 *
 * Importa además que los reintentos sean seguros. Sólo se reintenta
 * automáticamente lo que se puede repetir sin consecuencias: leer datos. Un
 * pedido que crea o confirma algo se reintenta una sola vez y únicamente si la
 * conexión falló antes de salir, porque repetir un guardado que en realidad
 * llegó duplicaría el comprobante.
 */

export const MENSAJE_DESPERTANDO =
  'Estamos iniciando el sistema. El primer acceso puede demorar hasta un minuto.';

/** Códigos con los que un servidor dice "todavía no estoy listo". */
const CODIGOS_REINTENTABLES = [502, 503, 504, 522, 523, 524];

export interface OpcionesPedido extends RequestInit {
  /**
   * true cuando repetir el pedido no cambia nada (una consulta). Los pedidos
   * que escriben quedan en false, que es el valor por defecto.
   */
  repetible?: boolean;
  /** Cuántas vueltas como mucho. Con 5 se cubre el minuto de arranque. */
  intentos?: number;
  /** Se avisa cuando hay que esperar, para poder mostrarlo en pantalla. */
  alEsperar?: (mensaje: string | null) => void;
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Espera creciente entre intentos: 1 s, 3 s, 6 s, 10 s, 15 s. */
const ESPERAS_MS = [1_000, 3_000, 6_000, 10_000, 15_000];

export async function pedir(url: string, opciones: OpcionesPedido = {}): Promise<Response> {
  const { repetible = false, intentos = 5, alEsperar, ...init } = opciones;
  const maximo = repetible ? intentos : 2;

  let ultimoError: unknown = null;

  for (let intento = 0; intento < maximo; intento++) {
    try {
      const respuesta = await fetch(url, init);

      if (!CODIGOS_REINTENTABLES.includes(respuesta.status)) {
        alEsperar?.(null);
        return respuesta;
      }

      // El servidor está arrancando. Sólo se insiste con lo que se puede
      // repetir sin consecuencias.
      if (!repetible) {
        alEsperar?.(null);
        return respuesta;
      }
      ultimoError = new Error(`El servidor respondió ${respuesta.status}.`);
    } catch (error) {
      // No llegó a destino: la aplicación está durmiendo, o no hay señal. Un
      // pedido que escribe se puede reintentar acá con tranquilidad, porque si
      // nunca salió no llegó a hacer nada.
      ultimoError = error;
    }

    if (intento === maximo - 1) break;
    alEsperar?.(MENSAJE_DESPERTANDO);
    await dormir(ESPERAS_MS[Math.min(intento, ESPERAS_MS.length - 1)]);
  }

  alEsperar?.(null);
  throw ultimoError instanceof Error
    ? ultimoError
    : new Error('No pudimos conectarnos con el servidor.');
}

/** Atajo para consultas, que siempre se pueden repetir. */
export function consultar(url: string, opciones: OpcionesPedido = {}): Promise<Response> {
  return pedir(url, { ...opciones, repetible: true });
}
