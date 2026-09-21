import 'server-only';
import type { Prisma, PrismaClient, StockOutbox } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  APLICACION,
  DIRECCION_DE_COMPRA,
  DIRECCION_DEL_CONTRATO,
  MOTIVO_DEL_CONTRATO,
  VERSION_DEL_CONTRATO,
  claveDelEvento,
  cantidadDelContrato,
  type IngresoPlaneado,
  type LoteDeIngreso,
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
 * **Se manda un lote por compra**, no un pedido por renglón. Los cinco
 * movimientos de una factura se aplican del otro lado en una transacción o no
 * se aplica ninguno: media compra ingresada es peor que ninguna, porque la
 * diferencia no se ve en ninguna pantalla y aparece semanas después.
 *
 * **Nada de esto viaja al navegador.** El archivo es `server-only`, la clave
 * vive en el entorno del servidor, y ni la URL privada ni el secreto aparecen
 * en respuestas, mensajes de error o registros.
 */

export type { LoteDeIngreso };

/** Cómo terminó el envío de un lote. */
export type ResultadoDelLote =
  /**
   * El otro lado lo tomó. Trae, por clave de idempotencia, si lo aplicó ahora
   * o si ya lo tenía: las dos cosas terminan la sincronización, y la segunda
   * es la que hace que un reintento sea inofensivo.
   */
  | {
      clase: 'APLICADO';
      porClave: Record<string, { estado: 'APPLIED' | 'ALREADY_APPLIED'; movementId?: string }>;
    }
  /** 401/403. Es configuración, no contenido: no se reintenta a ciegas. */
  | { clase: 'SIN_AUTORIZACION'; motivo: string }
  /** 409: la misma clave con otro contenido. Alguien tiene que mirarlo. */
  | { clase: 'CONFLICTO'; motivo: string }
  /** 422: el contenido está mal y lo va a seguir estando. Hay que corregir. */
  | { clase: 'RECHAZADO'; motivo: string }
  /** 429, 5xx, timeout: puede andar más tarde. Se conserva para reintentar. */
  | { clase: 'RECUPERABLE'; motivo: string }
  /** Contestó algo que no es este contrato. No se asume éxito. */
  | { clase: 'RESPUESTA_INVALIDA'; motivo: string }
  /** Falta la URL o la clave. No sale ningún pedido. */
  | { clase: 'SIN_CONFIGURAR'; motivo: string };

/**
 * Cómo se habla con Control de Stock.
 *
 * Es una interfaz y no una llamada directa para poder probar todo lo de este
 * lado contra un receptor determinístico —sin red, sin reloj, sin azar— en vez
 * de contra existencias reales.
 */
export interface TransporteDeStock {
  enviar(lote: LoteDeIngreso): Promise<ResultadoDelLote>;
}

/** El transporte que no manda nada. Es el de por omisión hasta configurar. */
export const TRANSPORTE_SIN_CONFIGURAR: TransporteDeStock = {
  async enviar() {
    return {
      clase: 'SIN_CONFIGURAR',
      motivo:
        'La integración de escritura con Control de Stock no está configurada. ' +
        'El ingreso queda anotado y no se envía.',
    };
  },
};

let transporte: TransporteDeStock = TRANSPORTE_SIN_CONFIGURAR;

/** Cambia el transporte. Lo usan las pruebas con su receptor determinístico. */
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
/*  Armar el lote                                                              */
/* -------------------------------------------------------------------------- */

export type ArmadoDelLote =
  | { ok: true; lote: LoteDeIngreso }
  | { ok: false; motivo: string };

/**
 * Arma el cuerpo exacto que va a viajar, o dice por qué no se puede.
 *
 * Separado del envío para poder mirarlo sin mandarlo: las pruebas comprueban el
 * JOSN carácter por carácter —las cantidades como cadenas decimales, la
 * dirección, el código de sucursal— sin abrir un socket.
 */
export async function armarLote(
  documentId: string,
  filas: StockOutbox[],
  cliente?: PrismaClient,
): Promise<ArmadoDelLote> {
  const db = cliente ?? prisma;

  const documento = await db.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      letter: true,
      pointOfSale: true,
      number: true,
      issueDate: true,
      branch: { select: { name: true, stockKey: true } },
      supplier: { select: { cuit: true, tradeName: true, legalName: true } },
      validatedBy: { select: { id: true, name: true } },
    },
  });
  if (!documento) return { ok: false, motivo: 'El comprobante ya no existe.' };

  /*
   * Sin la clave canónica de la sucursal no sale nada.
   *
   * `branches.code` de Control de Stock —devoto, pueyrredon, san_martin— es lo
   * único que identifica el local sin ambigüedad entre ambientes. Mandar el
   * nombre sería elegir la sucursal por parecido, que es lo que no se hace con
   * los artículos; mandar un UUID interno sería peor, porque cambia de base en
   * base.
   */
  if (!documento.branch.stockKey) {
    return {
      ok: false,
      motivo:
        `La sucursal «${documento.branch.name}» no tiene cargado su código de Control de ` +
        'Stock. Hasta que lo tenga, el movimiento queda anotado y no se envía: mandarlo con ' +
        'el nombre sería elegir el local por parecido.',
    };
  }

  /*
   * Las cantidades, normalizadas a la escala del contrato.
   *
   * Es el único lugar donde se hace, y a propósito: adentro siguen siendo los
   * mismos decimales de siempre. Un valor con más de tres decimales **no se
   * redondea**: se rechaza el lote entero y el motivo dice cuál era, porque
   * mandar 4,2401 como 4,240 es mandar a Control de Stock una cantidad que no
   * es la de la factura, con una diferencia de gramos que después no se puede
   * rastrear.
   */
  const cantidades = new Map<string, string>();
  for (const fila of filas) {
    const cantidad = cantidadDelContrato(fila.quantity);
    if (!cantidad.ok) {
      return { ok: false, motivo: `Renglón con PLU ${fila.plu}: ${cantidad.motivo}` };
    }
    cantidades.set(fila.id, cantidad.quantity);
  }

  return {
    ok: true,
    lote: {
      contractVersion: VERSION_DEL_CONTRATO,
      source: APLICACION,
      purchaseId: documento.id,
      branchCode: documento.branch.stockKey,
      document: {
        documentId: documento.id,
        type: documento.letter ?? '',
        pointOfSale: documento.pointOfSale,
        number: documento.number,
        issuedAt: documento.issueDate
          ? documento.issueDate.toISOString().slice(0, 10)
          : '',
        /* El CUIT sin guiones: el identificador, no su presentación. */
        supplierTaxId: documento.supplier?.cuit?.replace(/\D/g, '') ?? null,
        supplierName: documento.supplier?.tradeName ?? documento.supplier?.legalName ?? null,
      },
      confirmedBy: {
        userId: documento.validatedBy?.id ?? filas[0]?.requestedById ?? null,
        name: documento.validatedBy?.name ?? null,
      },
      movements: filas.map((fila) => ({
        sourceLineId: fila.documentItemId,
        idempotencyKey: fila.eventKey,
        plu: fila.plu,
        /*
         * Cadena decimal con tres posiciones, siempre.
         *
         * Ni número ni cadena a secas: la base guarda Decimal(14,4) y al
         * serializarla sin más sale «4.24» donde el papel dice «4,240». Es el
         * mismo peso, pero la idempotencia compara contenido, y dos cadenas
         * distintas para el mismo peso producen un conflicto que no existe.
         */
        quantity: cantidades.get(fila.id)!,
        unit: fila.unit,
        direction: DIRECCION_DEL_CONTRATO,
        reason: MOTIVO_DEL_CONTRATO,
      })),
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Despachar                                                                  */
/* -------------------------------------------------------------------------- */

/** Cuántas veces se reintenta antes de dejarlo para que alguien lo mire. */
export const INTENTOS_MAXIMOS = 5;

export interface ResumenDelDespacho {
  lotes: number;
  completados: number;
  pendientes: number;
  fallidos: number;
  inciertos: number;
}

/** El lote es de otro despacho. No es un error: es ceder y volver después. */
class LoteAjeno extends Error {}

/**
 * Toma las filas de una compra, todas o ninguna.
 *
 * Reclamarlas **de a una** parecía equivalente y no lo era. Las cinco filas de
 * una factura se escriben en la misma transacción, así que comparten el
 * `createdAt` al milisegundo; con el orden empatado, dos despachos concurrentes
 * pueden recorrerlas en orden distinto, quedarse cada uno con un pedazo, y
 * —como ninguno junta el lote entero— retirarse los dos. La compra no se pierde
 * (las filas vuelven a PENDIENTE), pero no sale nadie: un bloqueo mutuo que en
 * una máquina rápida no aparece nunca y en una cargada aparece solo.
 *
 * Una sola sentencia lo arregla: el `updateMany` toma las filas de a todas,
 * quien llega segundo se queda esperando y después no encuentra ninguna en el
 * estado que pedía. No hay pedazos que devolver, y si algo sale mal la
 * transacción deshace el reclamo sola, sin un deshacer escrito a mano que
 * también puede fallar por la mitad.
 *
 * El conteo de sobrantes es la otra mitad: un despacho que llegó cuando la
 * compra ya estaba a medio reclamar ve sólo las filas que quedaban sueltas, y
 * sin esta comprobación mandaría ese pedazo creyendo que es la factura entera.
 */
async function reclamarElLote(
  db: PrismaClient,
  documentId: string,
  filas: StockOutbox[],
  estados: StockOutbox['status'][],
): Promise<StockOutbox[]> {
  const ids = filas.map((fila) => fila.id);
  const dispatchables = {
    status: { in: estados },
    attempts: { lt: INTENTOS_MAXIMOS },
  };

  try {
    return await db.$transaction(async (tx) => {
      const reclamo = await tx.stockOutbox.updateMany({
        where: { id: { in: ids }, ...dispatchables },
        data: {
          status: 'EN_PROCESO',
          attempts: { increment: 1 },
          lastTriedAt: new Date(),
        },
      });
      if (reclamo.count !== ids.length) throw new LoteAjeno();

      const sueltas = await tx.stockOutbox.count({
        where: { documentId, id: { notIn: ids }, ...dispatchables },
      });
      if (sueltas > 0) throw new LoteAjeno();

      return filas;
    });
  } catch (error) {
    if (error instanceof LoteAjeno) return [];
    throw error;
  }
}

/**
 * Manda lo que esté pendiente, un lote por compra.
 *
 * **Reclama el lote entero antes de mandarlo**, en una sola sentencia y dentro
 * de una transacción. Ese paso —pasar de PENDIENTE a EN_PROCESO condicionado al
 * estado— es lo que impide que dos despachos concurrentes manden la misma
 * compra: el segundo encuentra cero filas afectadas y no la toca.
 *
 * Una fila EN_PROCESO **no se reintenta sola**: quedó sin respuesta y puede
 * haber llegado. Se reintenta a pedido, y ahí la clave de idempotencia hace su
 * trabajo, porque es la misma de siempre y nunca se genera una nueva.
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
    orderBy: [{ documentId: 'asc' }, { createdAt: 'asc' }],
  });

  const porCompra = new Map<string, StockOutbox[]>();
  for (const fila of candidatas) {
    const lista = porCompra.get(fila.documentId) ?? [];
    lista.push(fila);
    porCompra.set(fila.documentId, lista);
  }

  const resumen: ResumenDelDespacho = {
    lotes: 0,
    completados: 0,
    pendientes: 0,
    fallidos: 0,
    inciertos: 0,
  };

  for (const [documentId, filas] of porCompra) {
    const reclamadas = await reclamarElLote(db, documentId, filas, estados);
    // Otro despacho está con esta compra: no se manda medio lote.
    if (reclamadas.length === 0) continue;

    resumen.lotes += 1;
    const armado = await armarLote(documentId, reclamadas, db);

    if (!armado.ok) {
      await marcarTodas(db, reclamadas, { status: 'FALLIDO', lastError: armado.motivo });
      resumen.fallidos += 1;
      continue;
    }

    let resultado: ResultadoDelLote;
    try {
      resultado = await transporte.enviar(armado.lote);
    } catch {
      /*
       * Una excepción es incierta, no fallida: se cortó la conexión y no se
       * sabe si el lote llegó. El motivo no lleva nada de lo enviado, para que
       * ninguna credencial termine en la base.
       */
      resultado = {
        clase: 'RECUPERABLE',
        motivo: 'No hubo respuesta de Control de Stock.',
      };
    }

    switch (resultado.clase) {
      case 'APLICADO': {
        for (const fila of reclamadas) {
          const suyo = resultado.porClave[fila.eventKey];
          await db.stockOutbox.update({
            where: { id: fila.id },
            data: suyo
              ? {
                  status: 'COMPLETADO',
                  externalId: suyo.movementId ?? null,
                  lastError: null,
                  completedAt: new Date(),
                }
              : {
                  /* Contestó el lote pero no este movimiento: no se asume éxito. */
                  status: 'EN_PROCESO',
                  lastError:
                    'Control de Stock contestó el lote sin decir nada de este movimiento.',
                },
          });
        }
        resumen.completados += 1;
        break;
      }
      case 'SIN_AUTORIZACION':
      case 'CONFLICTO':
      case 'RECHAZADO':
        await marcarTodas(db, reclamadas, { status: 'FALLIDO', lastError: resultado.motivo });
        resumen.fallidos += 1;
        break;
      case 'RECUPERABLE':
      case 'SIN_CONFIGURAR':
        /* Vuelve a la cola con la MISMA clave. Nunca se genera una nueva. */
        await marcarTodas(db, reclamadas, { status: 'PENDIENTE', lastError: resultado.motivo });
        resumen.pendientes += 1;
        break;
      case 'RESPUESTA_INVALIDA':
        /* Queda en EN_PROCESO: no se sabe qué pasó y no se asume éxito. */
        await marcarTodas(db, reclamadas, { lastError: resultado.motivo });
        resumen.inciertos += 1;
        break;
    }
  }

  return resumen;
}

async function marcarTodas(
  db: PrismaClient,
  filas: StockOutbox[],
  datos: { status?: StockOutbox['status']; lastError: string | null },
) {
  for (const fila of filas) {
    await db.stockOutbox.update({ where: { id: fila.id }, data: datos });
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
 * entró a la otra aplicación.
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

  return { estado, total: filas.length, completados, pendientes, enProceso, fallidos, motivos };
}
