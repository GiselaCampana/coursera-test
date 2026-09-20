import 'server-only';
import type {
  LoteDeIngreso,
  ResultadoDelLote,
  TransporteDeStock,
} from '@/lib/services/stock-ingreso';

/**
 * **El transporte real hacia Control de Stock.**
 *
 * Habla el contrato versión 1 que acordamos: un POST por compra, con los
 * movimientos adentro, y una clave de idempotencia por movimiento que no
 * cambia entre reintentos.
 *
 * **Dos cosas que este archivo no hace, y son deliberadas.**
 *
 * La primera: no deriva la URL de escritura de la del catálogo. Reemplazar
 * texto dentro de una URL —cambiar «catalog» por «stock-movements»— funciona
 * hasta el día que el otro lado mueve una ruta, y entonces manda movimientos de
 * stock a un lugar que nadie revisó. La dirección de escritura se configura
 * entera, aparte, en su propia variable.
 *
 * La segunda: no inventa nada cuando falta configuración. Sin URL o sin clave
 * **no abre un socket**: contesta que no está configurado, la bandeja queda
 * pendiente y la pantalla lo dice. Un pedido a medias contra un destino
 * adivinado es peor que ningún pedido.
 *
 * **El secreto no sale de acá.** Va en el encabezado saliente y en ningún otro
 * lugar: no se registra, no entra en el motivo de un rechazo, no vuelve en una
 * respuesta. Los motivos que este archivo produce nombran el código de estado y
 * nada más.
 */

/** La dirección completa del receptor. No se deriva de ninguna otra. */
const NOMBRE_URL = 'STOCK_INTEGRATION_WRITE_URL';
/** La misma clave que ya usa la lectura del catálogo. */
const NOMBRE_CLAVE = 'STOCK_INTEGRATION_KEY';

/**
 * El encabezado es `Authorization`, y es el de Control de Stock.
 *
 * Quedó confirmado contra su endpoint: sin encabezado contesta
 * «INTEGRATION_KEY_REQUIRED», y con `Authorization: Bearer <lo que sea>`
 * contesta «INVALID_INTEGRATION_KEY». No hay nada que elegir ni que configurar.
 */
const ENCABEZADO = 'Authorization';

/** Cuánto se espera antes de darse por vencido. */
const TIEMPO_LIMITE_MS = 15_000;
/** Cuánto se acepta leer de la respuesta. Un acuse no llega ni cerca. */
const RESPUESTA_LIMITE_BYTES = 200_000;

/**
 * Arma el valor del encabezado: el esquema lo pone el código, no la variable.
 *
 * Mandar la clave cruda en `Authorization` es exactamente el error que Control
 * de Stock contesta con 401, así que el «Bearer » no puede quedar librado a que
 * quien carga el secreto se acuerde de escribirlo. Y si ya viene con él, no se
 * duplica.
 */
function conEsquema(clave: string): string {
  const limpia = clave.trim();
  return /^Bearer\s/i.test(limpia) ? limpia : `Bearer ${limpia}`;
}

export const TRANSPORTE_HTTP: TransporteDeStock = {
  async enviar(lote: LoteDeIngreso): Promise<ResultadoDelLote> {
    const url = process.env[NOMBRE_URL]?.trim();
    const clave = process.env[NOMBRE_CLAVE]?.trim();

    if (!url || !clave) {
      /*
       * Sin configuración no hay pedido. Se nombra la variable que falta
       * —el nombre, nunca el valor— para que quien administra el servidor sepa
       * qué cargar sin tener que adivinar.
       */
      const faltan = [!url ? NOMBRE_URL : null, !clave ? NOMBRE_CLAVE : null].filter(Boolean);
      return {
        clase: 'SIN_CONFIGURAR',
        motivo:
          `La integración de escritura con Control de Stock no está configurada: falta ` +
          `${faltan.join(' y ')}. El ingreso queda anotado y no se envía.`,
      };
    }

    let destino: URL;
    try {
      destino = new URL(url);
    } catch {
      return { clase: 'SIN_CONFIGURAR', motivo: `${NOMBRE_URL} no es una dirección válida.` };
    }
    /*
     * Sólo https, salvo contra la máquina local, que es lo que hace falta para
     * las pruebas. Un destino en http es mandar el secreto en claro sin que
     * nada lo advierta.
     */
    const esLocal = ['localhost', '127.0.0.1', '::1'].includes(destino.hostname);
    if (destino.protocol !== 'https:' && !(destino.protocol === 'http:' && esLocal)) {
      return {
        clase: 'SIN_CONFIGURAR',
        motivo: `${NOMBRE_URL} tiene que ser https (o http contra la máquina local).`,
      };
    }

    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), TIEMPO_LIMITE_MS);

    let respuesta: Response;
    try {
      respuesta = await fetch(destino, {
        method: 'POST',
        headers: {
          [ENCABEZADO]: conEsquema(clave),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(lote),
        signal: control.signal,
        cache: 'no-store',
      });
    } catch {
      /*
       * Timeout o conexión cortada. Es recuperable y **no** es un éxito: puede
       * haber llegado, y por eso el reintento va con la misma clave.
       */
      return {
        clase: 'RECUPERABLE',
        motivo: 'Control de Stock no respondió a tiempo. Se reintenta con la misma clave.',
      };
    } finally {
      clearTimeout(reloj);
    }

    const estado = respuesta.status;

    if (estado === 401 || estado === 403) {
      return {
        clase: 'SIN_AUTORIZACION',
        motivo: `Control de Stock rechazó la credencial (${estado}). Hay que revisar la configuración.`,
      };
    }
    if (estado === 409) {
      return {
        clase: 'CONFLICTO',
        motivo:
          'Control de Stock ya tiene esa clave de idempotencia con otro contenido (409). ' +
          'Hay que revisarlo a mano: no se reenvía.',
      };
    }
    if (estado === 422) {
      return {
        clase: 'RECHAZADO',
        motivo: `Control de Stock rechazó el contenido del lote (422). Hay que corregirlo.`,
      };
    }
    if (estado === 429 || estado >= 500) {
      return {
        clase: 'RECUPERABLE',
        motivo: `Control de Stock contestó ${estado}. Se reintenta con la misma clave.`,
      };
    }
    if (estado !== 200 && estado !== 201) {
      return { clase: 'RESPUESTA_INVALIDA', motivo: `Control de Stock contestó ${estado}.` };
    }

    const texto = (await respuesta.text()).slice(0, RESPUESTA_LIMITE_BYTES);
    return interpretarRespuesta(texto);
  },
};

/**
 * Lee el acuse, y **no asume éxito** cuando no lo entiende.
 *
 * Un 200 con un cuerpo que no es este contrato no es una compra sincronizada:
 * es un intermediario contestando, una ruta equivocada, o una versión nueva que
 * todavía no sabemos leer. Marcarlo como aplicado escondería mercadería que
 * nunca entró.
 */
export function interpretarRespuesta(texto: string): ResultadoDelLote {
  let cuerpo: unknown;
  try {
    cuerpo = JSON.parse(texto);
  } catch {
    return { clase: 'RESPUESTA_INVALIDA', motivo: 'Control de Stock contestó algo que no es JSON.' };
  }

  if (typeof cuerpo !== 'object' || cuerpo === null) {
    return { clase: 'RESPUESTA_INVALIDA', motivo: 'La respuesta no tiene la forma acordada.' };
  }
  const raiz = cuerpo as Record<string, unknown>;

  if (raiz.contractVersion !== 1) {
    return {
      clase: 'RESPUESTA_INVALIDA',
      motivo: `La respuesta dice contractVersion ${String(raiz.contractVersion)}, y sabemos leer 1.`,
    };
  }

  const estadoDelLote = raiz.status;
  if (estadoDelLote !== 'APPLIED' && estadoDelLote !== 'ALREADY_APPLIED') {
    return {
      clase: 'RESPUESTA_INVALIDA',
      motivo: `La respuesta dice status «${String(estadoDelLote)}», que no es APPLIED.`,
    };
  }

  const movimientos = raiz.movements;
  if (!Array.isArray(movimientos)) {
    return { clase: 'RESPUESTA_INVALIDA', motivo: 'La respuesta no trae la lista «movements».' };
  }

  const porClave: Record<string, { estado: 'APPLIED' | 'ALREADY_APPLIED'; movementId?: string }> =
    {};
  for (const crudo of movimientos) {
    if (typeof crudo !== 'object' || crudo === null) continue;
    const m = crudo as Record<string, unknown>;
    const clave = typeof m.idempotencyKey === 'string' ? m.idempotencyKey : null;
    const estado = m.status;
    if (!clave) continue;
    if (estado !== 'APPLIED' && estado !== 'ALREADY_APPLIED') {
      return {
        clase: 'RESPUESTA_INVALIDA',
        motivo: `Un movimiento volvió con status «${String(estado)}».`,
      };
    }
    porClave[clave] = {
      estado,
      movementId: typeof m.movementId === 'string' ? m.movementId : undefined,
    };
  }

  if (Object.keys(porClave).length === 0) {
    return { clase: 'RESPUESTA_INVALIDA', motivo: 'La respuesta no confirmó ningún movimiento.' };
  }

  return { clase: 'APLICADO', porClave };
}
