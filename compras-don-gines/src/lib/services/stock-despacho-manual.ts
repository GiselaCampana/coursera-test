import 'server-only';
import { prisma } from '@/lib/db';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { hasPermission, type AuthUser } from '@/lib/auth/session';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/services/audit';
import {
  despacharPendientes,
  movimientosDe,
  sincronizacionDe,
  type EstadoDeSincronizacion,
  type MovimientoParaMirar,
} from '@/lib/services/stock-ingreso';
import { TRANSPORTE_HTTP, faltaConfigurar } from '@/lib/services/stock-transporte-http';

/**
 * **Mandar a mano los movimientos de UN comprobante.**
 *
 * Es la única puerta por la que la aplicación despacha hoy. No hay envío
 * automático al aplicar la compra, ni tarea periódica, ni nada que recorra la
 * bandeja entera: una persona mira un comprobante, ve qué se va a mandar, y lo
 * manda.
 *
 * **Por qué existe esta función y no se llama a `despacharPendientes` desde la
 * pantalla.** Ahí `documentId` es opcional, y sin él manda *todo lo pendiente*.
 * Eso está bien para una tarea de fondo y es exactamente lo que no puede pasar
 * detrás de un botón: un campo que llega vacío, un `formData` mal leído o un
 * refactor distraído convertirían «reintentar esta factura» en «mandar la
 * bandeja histórica entera». Acá el comprobante es un argumento obligatorio y
 * se valida antes de tocar nada, así que ese modo no se puede alcanzar desde la
 * interfaz ni por accidente.
 *
 * **El transporte se pasa explícito.** No se muta nada global en medio de una
 * solicitud: la composición elige `TRANSPORTE_HTTP` acá, y ese objeto decide
 * solo si hay configuración. Sin `STOCK_INTEGRATION_WRITE_URL` o sin
 * `STOCK_INTEGRATION_KEY` no abre un socket y contesta que falta configurar.
 */

export interface ResultadoDelDespachoManual {
  ok: boolean;
  /** Cómo quedó la sincronización del comprobante después de intentar. */
  estado: EstadoDeSincronizacion;
  /** Cada movimiento con su estado nuevo. Es lo que la pantalla informa. */
  movimientos: MovimientoParaMirar[];
  /** Nombres —nunca valores— de las variables que falten. */
  faltaConfigurar: string[];
  /** Lo que hay que decirle a quien apretó el botón. */
  mensaje: string;
}

/**
 * Lo que se ve **antes** de mandar: qué movimientos hay y si se puede mandar.
 *
 * Separado del envío a propósito. Mirar no escribe nada ni abre ninguna
 * conexión, así que abrir la pantalla mil veces no mueve un gramo de stock.
 */
export async function vistaDelDespacho(
  user: AuthUser,
  documentId: string,
): Promise<{
  puedeDespachar: boolean;
  movimientos: MovimientoParaMirar[];
  estado: EstadoDeSincronizacion;
  faltaConfigurar: string[];
}> {
  const movimientos = await movimientosDe(documentId);
  const { estado } = await sincronizacionDe(documentId);

  return {
    puedeDespachar: hasPermission(user, PERMISSIONS.STOCK_SINCRONIZAR),
    movimientos,
    estado,
    faltaConfigurar: faltaConfigurar(),
  };
}

export async function despacharComprobante(
  user: AuthUser,
  documentId: string,
  opciones?: {
    /**
     * Incluir los que ya salieron una vez y no volvió respuesta.
     *
     * Va aparte del envío normal, y no por prolijidad. Un movimiento
     * EN_PROCESO **puede haber llegado**, así que reintentarlo es una decisión
     * distinta de mandar algo que nunca salió, y quien la toma tiene que
     * saberlo. Además evita que dos clics a la vez manden dos veces: el
     * segundo, por el camino normal, no encuentra nada que reclamar porque el
     * primero ya las pasó a EN_PROCESO.
     */
    incluirInciertas?: boolean;
  },
): Promise<ResultadoDelDespachoManual> {
  /*
   * El permiso se comprueba **acá**, en el servidor, y no alcanza con que la
   * pantalla haya escondido el botón: esconder un control no es una defensa,
   * es una comodidad. Quien llame a la acción directamente encuentra lo mismo.
   */
  if (!hasPermission(user, PERMISSIONS.STOCK_SINCRONIZAR)) {
    throw new ForbiddenError(
      'Tu usuario no puede enviar movimientos de mercadería a Control de Stock.',
    );
  }

  /*
   * Un comprobante, y que exista. Sin esto, una cadena vacía llegaría a
   * `despacharPendientes` como «sin filtro», que es el modo que esta función
   * existe para no poder alcanzar.
   */
  const id = documentId.trim();
  if (!id) throw new ValidationError('Falta el comprobante.');

  const documento = await prisma.document.findUnique({
    where: { id },
    select: { id: true, fullNumber: true },
  });
  if (!documento) throw new NotFoundError('El comprobante no existe.');

  const antes = await movimientosDe(id);
  const faltan = faltaConfigurar();

  if (antes.length === 0) {
    return {
      ok: false,
      estado: 'SIN_MOVIMIENTOS',
      movimientos: [],
      faltaConfigurar: faltan,
      mensaje: 'Este comprobante no tiene movimientos de mercadería que enviar.',
    };
  }

  if (antes.every((m) => m.status === 'COMPLETADO')) {
    /*
     * Nada que hacer, y se dice en vez de mandar igual: reenviar algo ya
     * confirmado sería inofensivo por la clave de idempotencia, pero un pedido
     * que no hacía falta es ruido del otro lado y una pregunta menos clara acá.
     */
    return {
      ok: true,
      estado: 'COMPLETADA',
      movimientos: antes,
      faltaConfigurar: faltan,
      mensaje: 'Control de Stock ya confirmó todos los movimientos de este comprobante.',
    };
  }

  /*
   * Se despacha con el transporte real, pasado explícitamente, y acotado a este
   * comprobante. Cuando el reintento incluye los inciertos, sale **con la misma
   * clave de siempre**: es lo único que hace que volver a mandar algo que quizá
   * ya llegó sea inofensivo.
   */
  await despacharPendientes({
    documentId: id,
    incluirInciertas: opciones?.incluirInciertas === true,
    transporte: TRANSPORTE_HTTP,
  });

  const despues = await movimientosDe(id);
  const { estado } = await sincronizacionDe(id);

  /*
   * Queda registrado quién, cuándo, qué comprobante y cómo salió cada
   * movimiento. La fecha la pone la auditoría. No entra nada de la credencial
   * ni del cuerpo enviado: los motivos que guarda la bandeja nombran el código
   * de estado y nada más.
   */
  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.STOCK_DESPACHADO,
    entity: 'Document',
    entityId: id,
    before: { movimientos: antes.map(resumenAuditable) },
    after: { estado, movimientos: despues.map(resumenAuditable) },
  });

  return {
    ok: estado === 'COMPLETADA',
    estado,
    movimientos: despues,
    faltaConfigurar: faltan,
    mensaje: mensajeDelResultado(estado, faltan),
  };
}

/** Lo que se guarda de cada movimiento en la auditoría. Sin secretos. */
function resumenAuditable(m: MovimientoParaMirar) {
  return {
    eventKey: m.eventKey,
    plu: m.plu,
    quantity: m.quantity,
    unit: m.unit,
    status: m.status,
    attempts: m.attempts,
    externalId: m.externalId,
    lastError: m.lastError,
  };
}

function mensajeDelResultado(estado: EstadoDeSincronizacion, faltan: string[]): string {
  if (faltan.length > 0) {
    return (
      'La integración de escritura no está configurada: falta cargar ' +
      `${faltan.join(' y ')}. No se envió nada y los movimientos quedan anotados.`
    );
  }
  switch (estado) {
    case 'COMPLETADA':
      return 'Control de Stock confirmó todos los movimientos.';
    case 'EN_PROCESO':
      return 'Se envió y no volvió confirmación de todos los movimientos. Puede haber llegado: se reintenta con la misma clave, sin duplicar.';
    case 'FALLIDA':
      return 'Control de Stock no aceptó el envío. El detalle de cada movimiento dice por qué.';
    case 'PENDIENTE':
      return 'No se pudo enviar todavía. Los movimientos quedan pendientes y se pueden reintentar.';
    case 'SIN_MOVIMIENTOS':
      return 'Este comprobante no tiene movimientos de mercadería.';
  }
}
