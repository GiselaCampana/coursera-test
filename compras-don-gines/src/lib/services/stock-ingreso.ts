import 'server-only';
import type { Prisma, PrismaClient, StockOutbox } from '@prisma/client';
import { prisma } from '@/lib/db';
import { AppError } from '@/lib/errors';
import {
  APLICACION,
  DIRECCION_DE_COMPRA,
  claveDelEvento,
  type IngresoPlaneado,
} from '@/lib/domain/ingreso-de-stock';

/**
 * **Mandar a Control de Stock la mercadería que entró, sin perderla ni
 * duplicarla.**
 *
 * El problema es viejo y no tiene solución elegante: dos aplicaciones, dos
 * bases, ninguna transacción que abarque a las dos. Si la compra se aplicara y
 * después se llamara a Control de Stock, una caída en el medio dejaría la
 * mercadería pagada acá y ausente allá. Si se llamara primero, una caída
 * después dejaría existencias que nadie compró.
 *
 * Lo que sí se puede hacer es que el movimiento **no se pierda**: se anota en
 * una bandeja, dentro de la misma transacción que escribe la compra, y desde
 * ahí se manda cuantas veces haga falta. Lo peor que puede pasar es que tarde,
 * y que mientras tanto la pantalla lo diga.
 *
 * **Nada de esto viaja al navegador.** El archivo es `server-only` y la clave
 * vive en el entorno del servidor: no hay ninguna variable NEXT_PUBLIC_ y el
 * navegador nunca ve el destino ni la credencial.
 */

/** Lo que se manda por un movimiento. Es lo que la bandeja guarda. */
export interface EventoDeIngreso {
  eventKey: string;
  aplicacion: string;
  direccion: typeof DIRECCION_DE_COMPRA;
  plu: string;
  quantity: string;
  unit: string;
  /** La sucursal, con la clave que usa Control de Stock. */
  branchKey: string;
  occurredAt: string;
  /** Para la auditoría del otro lado: de qué comprobante salió. */
  origen: {
    documentId: string;
    documentItemId: string;
    fullNumber: string | null;
    supplierCuit: string | null;
  };
}

export type ResultadoDelEnvio =
  /** Aceptado. `externalId` es con qué identificador quedó del otro lado. */
  | { estado: 'ACEPTADO'; externalId: string }
  /**
   * Ya lo tenían. Es la respuesta que hace que un reintento sea inofensivo:
   * Control de Stock reconoce la clave y devuelve lo de la vez anterior sin
   * volver a mover nada.
   */
  | { estado: 'YA_ESTABA'; externalId: string }
  /** Rechazado con motivo. No se reintenta solo: hay algo que corregir. */
  | { estado: 'RECHAZADO'; motivo: string }
  /**
   * No se sabe. Un timeout, un 500, una conexión cortada: puede haber llegado
   * o no. Es el caso peligroso, y por eso tiene nombre propio.
   */
  | { estado: 'INCIERTO'; motivo: string };

/**
 * Cómo se habla con Control de Stock.
 *
 * Es una interfaz y no una llamada directa por una razón concreta: **el
 * contrato de escritura todavía no existe**. La integración que hay hoy es de
 * lectura —se descarga el catálogo— y para escribir movimientos no hay
 * endpoint acordado, ni identificador de sucursal, ni lista de rechazos. Con
 * esto, todo lo que no depende de ese contrato se implementa y se prueba, y el
 * día que el contrato exista se escribe un transporte y nada más cambia.
 */
export interface TransporteDeStock {
  enviar(evento: EventoDeIngreso): Promise<ResultadoDelEnvio>;
}

/**
 * El transporte real, que todavía no se puede escribir.
 *
 * No inventa una URL, ni un encabezado, ni una forma de solicitud. Falla con un
 * motivo explícito, y ese motivo termina visible en la pantalla: la compra
 * queda con la sincronización pendiente y dice por qué, en vez de aparecer
 * como terminada.
 */
export const TRANSPORTE_SIN_CONTRATO: TransporteDeStock = {
  async enviar() {
    return {
      estado: 'RECHAZADO',
      motivo:
        'Todavía no hay un endpoint acordado con Control de Stock para registrar movimientos. ' +
        'El ingreso queda anotado y se envía cuando el contrato exista.',
    };
  },
};

let transporte: TransporteDeStock = TRANSPORTE_SIN_CONTRATO;

/** Cambia el transporte. Lo usan las pruebas con su servidor determinístico. */
export function usarTransporteDeStock(nuevo: TransporteDeStock) {
  transporte = nuevo;
}

export function transporteDeStock(): TransporteDeStock {
  return transporte;
}

/* -------------------------------------------------------------------------- */
/*  Anotar                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Anota los ingresos en la bandeja. **Se llama dentro de la transacción de la
 * compra**, y ahí está todo el punto: si la compra se escribe, los movimientos
 * quedan anotados; si algo falla, no queda ni la compra ni la anotación.
 *
 * Es idempotente por construcción. La clave del evento se arma con el
 * comprobante y el renglón, y la base tiene dos unicidades sobre eso, así que
 * volver a aplicar el mismo comprobante no crea filas nuevas: actualiza las que
 * ya están, conservando el estado y el identificador externo de las que ya se
 * mandaron.
 */
export async function anotarIngresos(
  tx: Prisma.TransactionClient,
  entrada: {
    documentId: string;
    branchId: string;
    supplierId: string | null;
    requestedById: string | null;
    occurredAt: Date;
    ingresos: IngresoPlaneado[];
  },
): Promise<void> {
  for (const ingreso of entrada.ingresos) {
    const eventKey = claveDelEvento({
      documentId: entrada.documentId,
      documentItemId: ingreso.documentItemId,
    });

    /*
     * Upsert y no create.
     *
     * Aplicar una compra rehace sus renglones, así que en un reintento los
     * identificadores de renglón pueden ser otros; lo que no cambia es que el
     * movimiento ya mandado no se puede volver a mandar. Las filas que ya están
     * COMPLETADO no se tocan: se actualiza el dato descriptivo y se deja el
     * estado y el identificador externo donde estaban.
     */
    await tx.stockOutbox.upsert({
      where: { eventKey },
      create: {
        eventKey,
        documentId: entrada.documentId,
        documentItemId: ingreso.documentItemId,
        productId: ingreso.productId,
        branchId: entrada.branchId,
        supplierId: entrada.supplierId,
        requestedById: entrada.requestedById,
        plu: ingreso.plu,
        quantity: ingreso.quantity,
        unit: ingreso.unit,
        direction: DIRECCION_DE_COMPRA,
        occurredAt: entrada.occurredAt,
      },
      update: {
        plu: ingreso.plu,
        quantity: ingreso.quantity,
        unit: ingreso.unit,
        branchId: entrada.branchId,
        supplierId: entrada.supplierId,
        occurredAt: entrada.occurredAt,
      },
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Despachar                                                                  */
/* -------------------------------------------------------------------------- */

/** Cuántas veces se reintenta antes de dejarlo para que alguien lo mire. */
export const INTENTOS_MAXIMOS = 5;

export interface ResumenDelDespacho {
  intentados: number;
  completados: number;
  fallidos: number;
  inciertos: number;
}

/**
 * Manda lo que esté pendiente.
 *
 * **Toma una fila por vez y la marca antes de mandarla.** Ese paso —pasar de
 * PENDIENTE a EN_PROCESO con un `updateMany` condicionado al estado— es lo que
 * impide que dos despachos concurrentes manden el mismo movimiento: el segundo
 * encuentra cero filas afectadas y no la toca. La unicidad de la base lo
 * respalda por si el reclamo fallara.
 *
 * Una fila EN_PROCESO **no se reintenta sola**: quedó sin respuesta y puede
 * haber llegado. Se reintenta a pedido, y ahí la clave de idempotencia hace su
 * trabajo: Control de Stock reconoce la clave y devuelve lo de la vez anterior.
 */
export async function despacharPendientes(opciones?: {
  documentId?: string;
  /** Incluye las que quedaron sin respuesta. Es el reintento explícito. */
  incluirInciertas?: boolean;
  cliente?: PrismaClient;
}): Promise<ResumenDelDespacho> {
  const db = opciones?.cliente ?? prisma;
  const estados: StockOutbox['status'][] = ['PENDIENTE', 'FALLIDO'];
  if (opciones?.incluirInciertas) estados.push('EN_PROCESO');

  const candidatas = await db.stockOutbox.findMany({
    where: {
      status: { in: estados },
      attempts: { lt: INTENTOS_MAXIMOS },
      ...(opciones?.documentId ? { documentId: opciones.documentId } : {}),
    },
    orderBy: { createdAt: 'asc' },
  });

  const resumen: ResumenDelDespacho = {
    intentados: 0,
    completados: 0,
    fallidos: 0,
    inciertos: 0,
  };

  for (const fila of candidatas) {
    /*
     * Reclamar antes de mandar. Si otro despacho ya la tomó, `count` es 0 y
     * ésta se saltea sin haber mandado nada.
     */
    const reclamo = await db.stockOutbox.updateMany({
      where: { id: fila.id, status: fila.status },
      data: {
        status: 'EN_PROCESO',
        attempts: { increment: 1 },
        lastTriedAt: new Date(),
      },
    });
    if (reclamo.count === 0) continue;

    resumen.intentados += 1;
    const resultado = await mandarUna(db, fila);

    if (resultado.estado === 'ACEPTADO' || resultado.estado === 'YA_ESTABA') {
      await db.stockOutbox.update({
        where: { id: fila.id },
        data: {
          status: 'COMPLETADO',
          externalId: resultado.externalId,
          lastError: null,
          completedAt: new Date(),
        },
      });
      resumen.completados += 1;
    } else if (resultado.estado === 'RECHAZADO') {
      await db.stockOutbox.update({
        where: { id: fila.id },
        data: { status: 'FALLIDO', lastError: resultado.motivo },
      });
      resumen.fallidos += 1;
    } else {
      /*
       * Incierto: se queda en EN_PROCESO a propósito.
       *
       * Puede haber llegado. Marcarlo como fallido invitaría a un reenvío
       * automático que duplicaría la mercadería si la primera sí llegó; y
       * marcarlo como completado sería mentir. Queda visible, y el reintento
       * explícito lo resuelve con la misma clave.
       */
      await db.stockOutbox.update({
        where: { id: fila.id },
        data: { lastError: resultado.motivo },
      });
      resumen.inciertos += 1;
    }
  }

  return resumen;
}

async function mandarUna(
  db: PrismaClient,
  fila: StockOutbox,
): Promise<ResultadoDelEnvio> {
  const sucursal = await db.branch.findUnique({ where: { id: fila.branchId } });

  /*
   * Sin la clave de la sucursal no sale nada.
   *
   * Es el bloqueo que falta resolver con Control de Stock: no se acordó con qué
   * identificador conoce a Devoto, Pueyrredón y San Martín. Mandar el nombre, o
   * el código interno de Compras, sería elegir la sucursal por parecido, que es
   * lo mismo que no se hace con los artículos. El movimiento queda anotado y
   * dice exactamente qué falta.
   */
  if (!sucursal) {
    return { estado: 'RECHAZADO', motivo: 'La sucursal del movimiento ya no existe.' };
  }
  if (!sucursal.stockKey) {
    return {
      estado: 'RECHAZADO',
      motivo:
        `La sucursal «${sucursal.name}» no tiene todavía el identificador con el que la ` +
        'conoce Control de Stock. Hasta que esté acordado, el movimiento queda anotado y no ' +
        'se envía: mandarlo con el nombre sería elegir el local por parecido.',
    };
  }

  const documento = await db.document.findUnique({
    where: { id: fila.documentId },
    select: { fullNumber: true, supplier: { select: { cuit: true } } },
  });

  const evento: EventoDeIngreso = {
    eventKey: fila.eventKey,
    aplicacion: APLICACION,
    direccion: DIRECCION_DE_COMPRA,
    plu: fila.plu,
    quantity: fila.quantity.toString(),
    unit: fila.unit,
    branchKey: sucursal.stockKey,
    occurredAt: fila.occurredAt.toISOString().slice(0, 10),
    origen: {
      documentId: fila.documentId,
      documentItemId: fila.documentItemId,
      fullNumber: documento?.fullNumber ?? null,
      supplierCuit: documento?.supplier?.cuit ?? null,
    },
  };

  try {
    return await transporte.enviar(evento);
  } catch (error) {
    /*
     * Una excepción del transporte es incierta, no fallida: se cortó la
     * conexión y no se sabe si el pedido llegó. El motivo se guarda sin nada
     * de lo enviado, para que ninguna credencial termine en la base.
     */
    return {
      estado: 'INCIERTO',
      motivo: error instanceof AppError ? error.message : 'No hubo respuesta de Control de Stock.',
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  Mirar                                                                      */
/* -------------------------------------------------------------------------- */

/** Cómo está la sincronización de un comprobante, en una palabra. */
export type EstadoDeSincronizacion =
  | 'SIN_MOVIMIENTOS'
  | 'PENDIENTE'
  | 'EN_PROCESO'
  | 'COMPLETADA'
  | 'FALLIDA';

export interface SincronizacionDelComprobante {
  estado: EstadoDeSincronizacion;
  total: number;
  completados: number;
  pendientes: number;
  enProceso: number;
  fallidos: number;
  /** Los motivos distintos, para mostrarlos sin repetir. */
  motivos: string[];
}

/**
 * El estado real, sin redondear para arriba.
 *
 * Una compra con movimientos sin confirmar **no está terminada**, y la pantalla
 * no puede decir que sí: el egreso quedó agendado y la mercadería todavía no
 * entró a la otra aplicación. Que se vea la diferencia es la mitad del trabajo.
 */
export async function sincronizacionDe(
  documentId: string,
  cliente?: PrismaClient,
): Promise<SincronizacionDelComprobante> {
  const db = cliente ?? prisma;
  const filas = await db.stockOutbox.findMany({ where: { documentId } });

  const completados = filas.filter((f) => f.status === 'COMPLETADO').length;
  const pendientes = filas.filter((f) => f.status === 'PENDIENTE').length;
  const enProceso = filas.filter((f) => f.status === 'EN_PROCESO').length;
  const fallidos = filas.filter((f) => f.status === 'FALLIDO').length;
  const motivos = [
    ...new Set(filas.map((f) => f.lastError).filter((m): m is string => m !== null)),
  ];

  let estado: EstadoDeSincronizacion;
  if (filas.length === 0) estado = 'SIN_MOVIMIENTOS';
  else if (completados === filas.length) estado = 'COMPLETADA';
  else if (fallidos > 0) estado = 'FALLIDA';
  else if (enProceso > 0) estado = 'EN_PROCESO';
  else estado = 'PENDIENTE';

  return {
    estado,
    total: filas.length,
    completados,
    pendientes,
    enProceso,
    fallidos,
    motivos,
  };
}
