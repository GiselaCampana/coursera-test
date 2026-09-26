import 'server-only';
import { prisma } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { Decimal } from '@/lib/money';
import type { AuthUser } from '@/lib/auth/session';
import { hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { ForbiddenError } from '@/lib/errors';
import { AUDIT_ACTIONS, AUDIT_ACTION_LABEL, recordAudit } from '@/lib/services/audit';

/**
 * **Stock ERP, fase 5: mirar el libro sin tocarlo.**
 *
 * Todo lo de este archivo LEE. Ninguna función escribe una fila de existencias,
 * y la única escritura que hay en todo el módulo es la del rechazo por permiso,
 * que es auditoría y no inventario.
 *
 *
 * LAS DOS LÍNEAS DE TIEMPO, QUE NO SON LA MISMA
 *
 * Un movimiento tiene dos momentos, y confundirlos es el error que este archivo
 * existe para no cometer:
 *
 *   `seq`         ORDEN DE REGISTRACIÓN. Un entero que crece solo, uno por
 *                 movimiento, en el orden en que la base los aceptó. Es el
 *                 orden en que el libro se escribió, y no se puede cambiar.
 *   `createdAt`   el MOMENTO de esa registración, para poder decir «esto se
 *                 cargó el martes».
 *   `effectiveAt` la FECHA EFECTIVA: cuándo pasó en el mundo. La mercadería
 *                 llegó el viernes aunque alguien la haya cargado el lunes.
 *
 * `balanceAfterSeq` es el saldo posterior **según el orden de registración**, y
 * su nombre lo dice a propósito. Si alguien registra hoy un movimiento con
 * fecha efectiva de la semana pasada —un ingreso retroactivo—, el saldo
 * posterior de los movimientos que ya estaban escritos NO cambia, porque el
 * libro es inmutable. Entonces el recorrido por fecha efectiva y el recorrido
 * por secuencia dejan de coincidir.
 *
 * **Eso no se esconde.** No se recalcula la historia para que quede prolija, no
 * se reordena el libro en la pantalla y no se reinterpreta `balanceAfterSeq`.
 * Se marca el movimiento como retroactivo y se explica que el saldo posterior
 * corresponde al orden de registración. Un libro que se reescribe para parecer
 * coherente es un libro que ya no sirve para averiguar qué pasó.
 *
 *
 * QUIÉN MANDA
 *
 * `StockLedger` es la fuente histórica de verdad. `StockBalance` es una
 * proyección materializada: existe para no sumar el libro entero en cada
 * pantalla, y se puede reconstruir desde el libro. Ninguna consulta de acá crea
 * una tercera versión de la verdad ni copia saldos a un modelo de pantalla.
 */

/* ========================================================================== *
 * Permisos
 * ========================================================================== */

async function exigirPermiso(
  user: AuthUser,
  permiso: string,
  contexto: { entity: string; entityId?: string; detalle?: string },
): Promise<void> {
  if (hasPermission(user, permiso)) return;
  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.STOCKERP_INTENTO_RECHAZADO,
    entity: contexto.entity,
    entityId: contexto.entityId,
    after: { permisoQueFaltaba: permiso, detalle: contexto.detalle ?? null },
  });
  throw new ForbiddenError(
    `Tu usuario no tiene el permiso «${permiso}». Se pide a un administrador desde Configuración → Roles.`,
  );
}

/* ========================================================================== *
 * El cursor: estable por (seq, id)
 * ========================================================================== */

/**
 * La posición en el libro, como texto que viaja en la URL.
 *
 * Es `seq` y no un número de página. Una página numerada se corre entera cuando
 * alguien escribe un movimiento mientras otro está mirando: la fila que estaba
 * abajo de la página 1 aparece arriba de la página 2 y se ve dos veces, o no se
 * ve nunca. Con un cursor sobre `seq` eso no puede pasar, porque `seq` no
 * cambia una vez escrito.
 *
 * Se incluye el `id` además del `seq` aunque `seq` ya sea único: es el desempate
 * que hace determinista el orden si alguna vez dos filas compartieran secuencia,
 * y cuesta nada tenerlo.
 */
export interface Cursor {
  seq: bigint;
  id: string;
}

export function cursorATexto(c: Cursor): string {
  return `${c.seq.toString()}:${c.id}`;
}

export function textoACursor(texto: string | null | undefined): Cursor | null {
  if (!texto) return null;
  const corte = texto.indexOf(':');
  if (corte <= 0) return null;
  const seq = texto.slice(0, corte);
  const id = texto.slice(corte + 1);
  if (!/^\d+$/.test(seq) || id === '') return null;
  try {
    return { seq: BigInt(seq), id };
  } catch {
    return null;
  }
}

/* ========================================================================== *
 * Un movimiento, tal como se lee
 * ========================================================================== */

export interface MovimientoDelLibro {
  id: string;
  /** Orden de registración. Texto: un BigInt no sobrevive a JSON. */
  seq: string;
  /** Cuándo pasó en el mundo. */
  effectiveAt: Date;
  /** Cuándo se registró. */
  createdAt: Date;
  branchId: string;
  sucursal: string;
  productId: string;
  producto: string;
  /** El PLU **del momento del movimiento**, no el de hoy. */
  pluHistorico: string;
  pluActual: string | null;
  type: string;
  direction: 'IN' | 'OUT';
  cantidad: string;
  unidad: string;
  /** Saldo posterior **por orden de registración**. */
  balanceAfterSeq: string;
  operationId: string;
  operacionTipo: string | null;
  documentId: string | null;
  documentoNumero: string | null;
  documentItemId: string | null;
  /**
   * El renglón de traslado del que salió este movimiento, y su traslado.
   *
   * Agregado en la fase 6. Un `TRANSFER_OUT` y su `TRANSFER_IN` son dos filas de
   * dos sucursales distintas, y sin este vínculo la pregunta «¿esta salida de
   * Devoto es la entrada de Pueyrredón?» se contesta adivinando por cantidad y
   * hora, que es exactamente lo que no hay que hacer.
   */
  transferLineId: string | null;
  trasladoId: string | null;
  usuario: string | null;
  motivo: string | null;
  /** De dónde salió el saldo de ese artículo en esa sucursal. */
  openingSource: string | null;
  reversesId: string | null;
  reversedById: string | null;
  /* Lo que el papel decía, cuando el movimiento vino de una compra. */
  invoicedQuantity: string | null;
  invoicedUnit: string | null;
  pieceCount: number | null;
  realWeightKg: string | null;
  conversionFactorUsed: string | null;
  /**
   * Se registró DESPUÉS de un movimiento cuya fecha efectiva es posterior.
   *
   * Dicho de otro modo: entró al libro fuera de orden cronológico. No es una
   * corrupción ni un error; es lo que pasa cuando alguien carga el lunes una
   * mercadería que llegó el viernes. Lo que sí implica es que el
   * `balanceAfterSeq` de este movimiento no describe el recorrido cronológico.
   */
  retroactivo: boolean;
}

export interface PaginaDeMovimientos {
  movimientos: MovimientoDelLibro[];
  /** El cursor para pedir la página siguiente. `null` = no hay más. */
  siguiente: string | null;
  /** Cuántos se pidieron por página. */
  tamano: number;
}

export interface FiltroDeMovimientos {
  branchId?: string;
  productId?: string;
  /** Texto: PLU histórico o actual, o nombre del artículo. */
  texto?: string;
  type?: string;
  direction?: 'IN' | 'OUT';
  efectivaDesde?: Date;
  efectivaHasta?: Date;
  registradaDesde?: Date;
  registradaHasta?: Date;
  operationId?: string;
  documentId?: string;
}

const TAMANO_POR_OMISION = 50;
const TAMANO_MAXIMO = 200;

function condiciones(filtro: FiltroDeMovimientos): Prisma.StockLedgerWhereInput {
  const where: Prisma.StockLedgerWhereInput = {};
  if (filtro.branchId) where.branchId = filtro.branchId;
  if (filtro.productId) where.productId = filtro.productId;
  if (filtro.type) where.type = filtro.type as Prisma.StockLedgerWhereInput['type'];
  if (filtro.direction) where.direction = filtro.direction;
  if (filtro.operationId) where.operationId = filtro.operationId;
  if (filtro.documentId) where.documentId = filtro.documentId;

  if (filtro.efectivaDesde || filtro.efectivaHasta) {
    where.effectiveAt = {
      ...(filtro.efectivaDesde ? { gte: filtro.efectivaDesde } : {}),
      ...(filtro.efectivaHasta ? { lte: filtro.efectivaHasta } : {}),
    };
  }
  if (filtro.registradaDesde || filtro.registradaHasta) {
    where.createdAt = {
      ...(filtro.registradaDesde ? { gte: filtro.registradaDesde } : {}),
      ...(filtro.registradaHasta ? { lte: filtro.registradaHasta } : {}),
    };
  }

  const texto = filtro.texto?.trim();
  if (texto) {
    where.OR = [
      /*
       * El PLU HISTÓRICO se busca igual que el actual, y a propósito: si un
       * artículo cambió de código, quien busca el código viejo está buscando
       * justamente los movimientos de aquella época.
       */
      { pluHistorico: { contains: texto, mode: 'insensitive' } },
      { product: { internalCode: { contains: texto, mode: 'insensitive' } } },
      { product: { normalizedName: { contains: texto, mode: 'insensitive' } } },
    ];
  }
  return where;
}

const INCLUIR_MOVIMIENTO = {
  branch: { select: { name: true } },
  product: { select: { internalCode: true, normalizedName: true } },
  operation: { select: { kind: true } },
  document: { select: { fullNumber: true, pointOfSale: true, number: true } },
  user: { select: { name: true } },
  reversedBy: { select: { id: true } },
  transferLine: { select: { id: true, transferId: true } },
} satisfies Prisma.StockLedgerInclude;

/**
 * Una página del libro, en orden de registración descendente.
 *
 * Descendente porque lo último registrado es lo que casi siempre se está
 * buscando, y porque así el cursor avanza hacia el pasado, que es estable: el
 * pasado no crece. Si la página fuera ascendente, cada movimiento nuevo
 * empujaría el final y la última página nunca terminaría.
 */
export async function movimientosDelLibro(
  user: AuthUser,
  filtro: FiltroDeMovimientos = {},
  opciones: { cursor?: string | null; tamano?: number } = {},
): Promise<PaginaDeMovimientos> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_MOVIMIENTOS_VER, { entity: 'StockLedger' });

  const tamano = Math.min(Math.max(opciones.tamano ?? TAMANO_POR_OMISION, 1), TAMANO_MAXIMO);
  const cursor = textoACursor(opciones.cursor);
  const where = condiciones(filtro);

  /*
   * El corte del cursor: `seq < cursor.seq`, o iguales con el `id` por
   * desempate. Se expresa así y no con `skip`/`take` numérico porque `skip`
   * cuenta filas: si alguien escribe un movimiento entre dos páginas, el
   * conteo se corre y una fila se repite o se pierde.
   */
  const conCursor: Prisma.StockLedgerWhereInput = cursor
    ? {
        AND: [
          where,
          {
            OR: [{ seq: { lt: cursor.seq } }, { AND: [{ seq: cursor.seq }, { id: { lt: cursor.id } }] }],
          },
        ],
      }
    : where;

  /* Se pide uno de más: si viene, hay página siguiente. */
  const filas = await prisma.stockLedger.findMany({
    where: conCursor,
    include: INCLUIR_MOVIMIENTO,
    orderBy: [{ seq: 'desc' }, { id: 'desc' }],
    take: tamano + 1,
  });

  const hayMas = filas.length > tamano;
  const pagina = hayMas ? filas.slice(0, tamano) : filas;

  /*
   * Para marcar los retroactivos hace falta saber, por artículo y sucursal, la
   * mayor fecha efectiva registrada ANTES que cada movimiento. Se resuelve con
   * una sola consulta agrupada sobre los pares que aparecen en esta página, en
   * vez de una consulta por fila.
   */
  const retroactivos = await marcarRetroactivos(pagina.map((f) => ({ id: f.id, seq: f.seq, productId: f.productId, branchId: f.branchId, effectiveAt: f.effectiveAt })));

  /* Los saldos, para poder decir de dónde nació el de cada artículo. */
  const pares = [...new Set(pagina.map((f) => `${f.productId}|${f.branchId}`))];
  const saldos = await prisma.stockBalance.findMany({
    where: {
      OR: pares.map((p) => {
        const [productId, branchId] = p.split('|');
        return { productId, branchId };
      }),
    },
    select: { productId: true, branchId: true, openingSource: true },
  });
  const origen = new Map(saldos.map((s) => [`${s.productId}|${s.branchId}`, s.openingSource]));

  return {
    movimientos: pagina.map((f) => ({
      id: f.id,
      seq: f.seq.toString(),
      effectiveAt: f.effectiveAt,
      createdAt: f.createdAt,
      branchId: f.branchId,
      sucursal: f.branch.name,
      productId: f.productId,
      producto: f.product.normalizedName,
      pluHistorico: f.pluHistorico,
      pluActual: f.product.internalCode,
      type: f.type,
      direction: f.direction as 'IN' | 'OUT',
      cantidad: f.quantity.toString(),
      unidad: f.unit,
      balanceAfterSeq: f.balanceAfterSeq.toString(),
      operationId: f.operationId,
      operacionTipo: f.operation?.kind ?? null,
      documentId: f.documentId,
      documentoNumero:
        f.document?.fullNumber ??
        (f.document ? `${f.document.pointOfSale ?? ''}-${f.document.number ?? ''}` : null),
      documentItemId: f.documentItemId,
      transferLineId: f.transferLineId,
      trasladoId: f.transferLine?.transferId ?? null,
      usuario: f.user?.name ?? null,
      motivo: f.reason,
      openingSource: origen.get(`${f.productId}|${f.branchId}`) ?? null,
      reversesId: f.reversesId,
      reversedById: f.reversedBy?.id ?? null,
      invoicedQuantity: f.invoicedQuantity?.toString() ?? null,
      invoicedUnit: f.invoicedUnit,
      pieceCount: f.pieceCount,
      realWeightKg: f.realWeightKg?.toString() ?? null,
      conversionFactorUsed: f.conversionFactorUsed?.toString() ?? null,
      retroactivo: retroactivos.has(f.id),
    })),
    siguiente: hayMas
      ? cursorATexto({ seq: pagina[pagina.length - 1].seq, id: pagina[pagina.length - 1].id })
      : null,
    tamano,
  };
}

/**
 * Cuáles de estos movimientos entraron al libro fuera de orden cronológico.
 *
 * Un movimiento es retroactivo si existe otro del MISMO artículo y sucursal,
 * registrado ANTES que él (menor `seq`), con fecha efectiva POSTERIOR. Es la
 * definición literal de «se cargó después algo que pasó antes».
 *
 * Se resuelve con una sola consulta para toda la página. La alternativa —una
 * consulta por fila— es la que convierte una pantalla de cincuenta
 * movimientos en cincuenta viajes a la base.
 */
async function marcarRetroactivos(
  filas: { id: string; seq: bigint; productId: string; branchId: string; effectiveAt: Date }[],
): Promise<Set<string>> {
  if (filas.length === 0) return new Set();

  const ids = filas.map((f) => f.id);
  const encontrados = await prisma.$queryRaw<{ id: string }[]>`
    SELECT l."id"
      FROM "stock_ledger" l
     WHERE l."id" IN (${Prisma.join(ids)})
       AND EXISTS (
         SELECT 1 FROM "stock_ledger" previo
          WHERE previo."productId" = l."productId"
            AND previo."branchId"  = l."branchId"
            AND previo."seq"       < l."seq"
            AND previo."effectiveAt" > l."effectiveAt"
       )`;
  return new Set(encontrados.map((e) => e.id));
}

/* ========================================================================== *
 * El recorrido cronológico, que es OTRA pregunta
 * ========================================================================== */

export interface PasoCronologico {
  movimiento: MovimientoDelLibro;
  /**
   * El saldo acumulado **siguiendo la fecha efectiva**.
   *
   * No se guarda en ninguna parte y no reemplaza a `balanceAfterSeq`: se
   * calcula al vuelo para contestar «¿cuánto había el 12 de septiembre?», que
   * es una pregunta distinta de «¿qué decía el libro cuando se escribió esta
   * fila?». Las dos son ciertas y responden cosas distintas.
   */
  saldoCronologico: string;
  /** Las dos coinciden mientras nadie cargue nada fuera de orden. */
  coincideConElDeRegistracion: boolean;
}

/**
 * El recorrido de un artículo en una sucursal, ordenado por fecha efectiva.
 *
 * El desempate es determinista y está elegido a propósito: a igual fecha
 * efectiva, manda el orden de registración (`seq`). Sin un desempate, dos
 * movimientos del mismo instante saldrían en el orden que quisiera la base, y
 * el saldo acumulado cambiaría de una consulta a otra sin que nada hubiera
 * cambiado.
 */
export async function recorridoCronologico(
  user: AuthUser,
  entrada: { productId: string; branchId: string; hasta?: Date; limite?: number },
): Promise<PasoCronologico[]> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_MOVIMIENTOS_VER, { entity: 'StockLedger' });

  const filas = await prisma.stockLedger.findMany({
    where: {
      productId: entrada.productId,
      branchId: entrada.branchId,
      ...(entrada.hasta ? { effectiveAt: { lte: entrada.hasta } } : {}),
    },
    include: INCLUIR_MOVIMIENTO,
    orderBy: [{ effectiveAt: 'asc' }, { seq: 'asc' }],
    take: Math.min(entrada.limite ?? 500, 1000),
  });

  const retroactivos = await marcarRetroactivos(
    filas.map((f) => ({ id: f.id, seq: f.seq, productId: f.productId, branchId: f.branchId, effectiveAt: f.effectiveAt })),
  );

  let acumulado = new Decimal(0);
  return filas.map((f) => {
    const cantidad = new Decimal(f.quantity.toString());
    acumulado = f.direction === 'IN' ? acumulado.plus(cantidad) : acumulado.minus(cantidad);
    const porSecuencia = new Decimal(f.balanceAfterSeq.toString());
    return {
      movimiento: {
        id: f.id,
        seq: f.seq.toString(),
        effectiveAt: f.effectiveAt,
        createdAt: f.createdAt,
        branchId: f.branchId,
        sucursal: f.branch.name,
        productId: f.productId,
        producto: f.product.normalizedName,
        pluHistorico: f.pluHistorico,
        pluActual: f.product.internalCode,
        type: f.type,
        direction: f.direction as 'IN' | 'OUT',
        cantidad: f.quantity.toString(),
        unidad: f.unit,
        balanceAfterSeq: f.balanceAfterSeq.toString(),
        operationId: f.operationId,
        operacionTipo: f.operation?.kind ?? null,
        documentId: f.documentId,
        documentoNumero:
          f.document?.fullNumber ??
          (f.document ? `${f.document.pointOfSale ?? ''}-${f.document.number ?? ''}` : null),
        documentItemId: f.documentItemId,
        transferLineId: f.transferLineId,
        trasladoId: f.transferLine?.transferId ?? null,
        usuario: f.user?.name ?? null,
        motivo: f.reason,
        openingSource: null,
        reversesId: f.reversesId,
        reversedById: f.reversedBy?.id ?? null,
        invoicedQuantity: f.invoicedQuantity?.toString() ?? null,
        invoicedUnit: f.invoicedUnit,
        pieceCount: f.pieceCount,
        realWeightKg: f.realWeightKg?.toString() ?? null,
        conversionFactorUsed: f.conversionFactorUsed?.toString() ?? null,
        retroactivo: retroactivos.has(f.id),
      },
      saldoCronologico: acumulado.toString(),
      coincideConElDeRegistracion: acumulado.equals(porSecuencia),
    };
  });
}

/* ========================================================================== *
 * El tablero de existencias
 * ========================================================================== */

/**
 * En qué situación está un artículo en una sucursal.
 *
 * Son estados EXCLUYENTES y ordenados: se evalúan de arriba hacia abajo y el
 * primero que aplica es el que vale. El orden no es casual —lo de afuera manda
 * sobre lo de adentro— y es lo que impide el error que este módulo viene
 * esquivando desde la fase 3: mostrar un cero donde hay una ausencia de dato.
 *
 *   `SUCURSAL_SIN_APERTURA`  la sucursal nunca se inauguró. No hay saldo, y
 *                            tampoco hay cero: sus artículos no están en cero,
 *                            están SIN CONTAR. Gana sobre todo lo demás.
 *   `NO_SE_MANEJA`           la sucursal dijo expresamente que no trabaja este
 *                            artículo. No es un faltante ni un cero: es una
 *                            decisión, con motivo y con autor.
 *   `PENDIENTE_DE_UNIDAD`    nadie aprobó en qué se cuenta. No se puede mover
 *                            ni contar, así que no puede aparentar estar listo.
 *   `CERO_CONFIRMADO`        alguien lo buscó y no había. Es un dato, y de los
 *                            buenos: cuesta el mismo gesto que cualquier otra
 *                            cantidad y por eso se puede creer.
 *   `CON_SALDO`              hay existencia.
 *   `CERO_POR_MOVIMIENTOS`   llegó a cero moviéndose, no contándose.
 *   `SIN_DATO`               está habilitado, la sucursal tiene apertura, y aun
 *                            así no hay ni conteo ni movimiento: entró al
 *                            catálogo después del corte y todavía nadie lo
 *                            recibió. Ausencia de dato, otra vez, no cero.
 */
export type EstadoDeExistencia =
  | 'SUCURSAL_SIN_APERTURA'
  | 'NO_SE_MANEJA'
  | 'PENDIENTE_DE_UNIDAD'
  | 'CERO_CONFIRMADO'
  | 'CON_SALDO'
  | 'CERO_POR_MOVIMIENTOS'
  | 'SIN_DATO';

/** Los estados en los que el número que se muestra es un saldo de verdad. */
export const ESTADOS_CON_NUMERO: EstadoDeExistencia[] = [
  'CERO_CONFIRMADO',
  'CON_SALDO',
  'CERO_POR_MOVIMIENTOS',
];

export interface FilaDelTablero {
  productId: string;
  plu: string;
  nombre: string;
  familia: string | null;
  branchId: string;
  sucursal: string;
  estado: EstadoDeExistencia;
  /** `null` cuando el estado NO es de los que tienen número. Nunca cero. */
  cantidad: string | null;
  /** La unidad del libro. `null` mientras nadie la haya aprobado. */
  unidadDeExistencia: string | null;
  /** De dónde nació el saldo: de un conteo o de un movimiento posterior. */
  origenDelSaldo: string | null;
  /** Motivo, cuando la sucursal dijo que no lo maneja. */
  motivo: string | null;
  /** Cuántos movimientos tiene, sin contar el de apertura. */
  movimientosPosteriores: number;
  /** El corte de la apertura de esa sucursal, si la hay. */
  cutoffAt: Date | null;
}

export interface FiltroDelTablero {
  branchId?: string;
  texto?: string;
  familiaId?: string;
  proveedorId?: string;
  unidad?: 'KG' | 'UNIT';
  estadoDeConfiguracion?: 'PENDIENTE' | 'APROBADA';
  estadoDeActivacion?: string;
  estado?: EstadoDeExistencia;
  limite?: number;
}

export interface Tablero {
  filas: FilaDelTablero[];
  /**
   * Cuántos hay en cada estado. Son CUENTAS, no cantidades.
   *
   * Nunca se suma una cantidad acá, y menos aún entre estados: un kilo y una
   * unidad no se suman, y «tres artículos con saldo» es una frase verdadera
   * mientras no diga tres de qué.
   */
  resumen: Record<EstadoDeExistencia, number>;
  /**
   * El total por UNIDAD, separado.
   *
   * Es la única forma honesta de agregar: `{ KG: '12.500', UNIT: '7.000' }`. Un
   * único número que mezclara los dos sería inventar una equivalencia que nadie
   * aprobó, que es exactamente lo que la fase 2 existe para impedir.
   */
  totalPorUnidad: Record<string, string>;
  /** Sucursales sin apertura confirmada que entraron en el filtro. */
  sucursalesSinApertura: { branchId: string; sucursal: string }[];
  /**
   * **Mercadería en tránsito hacia esta sucursal. NO es saldo.**
   *
   * Agregado en la fase 6, y deliberadamente APARTE de `filas` y de
   * `totalPorUnidad`. Salió del origen —ahí ya se descontó— y todavía no llegó:
   * sumarla al destino diría que hay mercadería en una góndola donde no hay
   * nada, y restarla de los dos lados la haría desaparecer. Se muestra como lo
   * que es: un tercer lugar, temporal y con nombre.
   */
  enTransitoHaciaAca: {
    productId: string;
    articulo: string;
    plu: string;
    cantidad: string;
    unidad: string;
    origen: string;
    trasladoId: string;
    despachadoEl: Date | null;
  }[];
  mirados: number;
  tope: number;
}

const TOPE_DEL_TABLERO = 300;

/**
 * El tablero de existencias, por sucursal y artículo.
 *
 * Lee `StockBalance` —la proyección— para el número, y la activación, la
 * configuración y la apertura para el ESTADO. El número sin el estado miente:
 * un cero puede ser un conteo confirmado o una sucursal que nadie inauguró, y
 * son cosas opuestas.
 */
export async function tableroDeExistencias(
  user: AuthUser,
  filtro: FiltroDelTablero = {},
): Promise<Tablero> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_MOVIMIENTOS_VER, { entity: 'StockBalance' });

  const tope = Math.min(filtro.limite ?? TOPE_DEL_TABLERO, 1000);
  const texto = filtro.texto?.trim();

  /* 1. Las sucursales en juego, y cuáles tienen apertura confirmada. */
  const sucursales = await prisma.branch.findMany({
    where: filtro.branchId ? { id: filtro.branchId } : {},
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  const aperturas = await prisma.stockCountSession.findMany({
    where: { status: 'CONFIRMADA', branchId: { in: sucursales.map((s) => s.id) } },
    select: { branchId: true, cutoffAt: true },
  });
  const corteDe = new Map(aperturas.map((a) => [a.branchId, a.cutoffAt]));

  /* 2. Los artículos que pasan el filtro. */
  const productos = await prisma.product.findMany({
    where: {
      active: true,
      ...(filtro.familiaId ? { familyId: filtro.familiaId } : {}),
      ...(filtro.proveedorId
        ? {
            OR: [
              { defaultSupplierId: filtro.proveedorId },
              { stockPresentations: { some: { supplierId: filtro.proveedorId } } },
            ],
          }
        : {}),
      ...(texto
        ? {
            OR: [
              { internalCode: { contains: texto, mode: 'insensitive' } },
              { normalizedName: { contains: texto, mode: 'insensitive' } },
              { family: { name: { contains: texto, mode: 'insensitive' } } },
            ],
          }
        : {}),
      ...(filtro.unidad ? { stockConfig: { stockUnit: filtro.unidad } } : {}),
      ...(filtro.estadoDeConfiguracion === 'APROBADA'
        ? { stockConfig: { status: 'APROBADA' } }
        : {}),
      ...(filtro.estadoDeConfiguracion === 'PENDIENTE'
        ? { OR: [{ stockConfig: null }, { stockConfig: { status: 'PENDIENTE' } }] }
        : {}),
    },
    select: {
      id: true,
      internalCode: true,
      normalizedName: true,
      family: { select: { name: true } },
      stockConfig: { select: { status: true, stockUnit: true } },
    },
    orderBy: { internalCode: 'asc' },
    take: tope,
  });

  const idsDeProducto = productos.map((p) => p.id);
  const idsDeSucursal = sucursales.map((s) => s.id);

  /* 3. Activaciones y saldos, en dos consultas y no en una por fila. */
  const [activaciones, saldos, conteoDeMovimientos] = await Promise.all([
    prisma.productStockActivation.findMany({
      where: { productId: { in: idsDeProducto }, branchId: { in: idsDeSucursal } },
      select: {
        productId: true,
        branchId: true,
        state: true,
        reason: true,
        countedQuantity: true,
      },
    }),
    prisma.stockBalance.findMany({
      where: { productId: { in: idsDeProducto }, branchId: { in: idsDeSucursal } },
      select: {
        productId: true,
        branchId: true,
        quantity: true,
        unit: true,
        openingSource: true,
      },
    }),
    prisma.stockLedger.groupBy({
      by: ['productId', 'branchId'],
      where: {
        productId: { in: idsDeProducto },
        branchId: { in: idsDeSucursal },
        type: { not: 'OPENING_BALANCE' },
      },
      _count: { _all: true },
    }),
  ]);

  const clave = (p: string, b: string) => `${p}|${b}`;
  const activacionDe = new Map(activaciones.map((a) => [clave(a.productId, a.branchId), a]));
  const saldoDe = new Map(saldos.map((s) => [clave(s.productId, s.branchId), s]));
  const movimientosDe = new Map(
    conteoDeMovimientos.map((m) => [clave(m.productId, m.branchId), m._count._all]),
  );

  /* 4. El estado de cada par, con el orden de prioridad que importa. */
  const filas: FilaDelTablero[] = [];
  for (const sucursal of sucursales) {
    const tieneApertura = corteDe.has(sucursal.id);
    for (const producto of productos) {
      const k = clave(producto.id, sucursal.id);
      const activacion = activacionDe.get(k);
      const saldo = saldoDe.get(k);
      const cfg = producto.stockConfig;
      const unidadAprobada = cfg?.status === 'APROBADA' ? cfg.stockUnit : null;

      let estado: EstadoDeExistencia;
      if (!tieneApertura) {
        /* Gana sobre todo: sin apertura no hay saldo ni cero, hay ausencia. */
        estado = 'SUCURSAL_SIN_APERTURA';
      } else if (activacion?.state === 'NO_SE_MANEJA') {
        estado = 'NO_SE_MANEJA';
      } else if (!unidadAprobada) {
        estado = 'PENDIENTE_DE_UNIDAD';
      } else if (!saldo) {
        estado = 'SIN_DATO';
      } else if (new Decimal(saldo.quantity.toString()).isZero()) {
        /*
         * Un cero se explica por su origen. Si el saldo nació de la apertura y
         * nadie lo movió después, ese cero es el que alguien contó: «lo busqué
         * y no había». Si llegó a cero moviéndose, es otra cosa y se dice.
         */
        const movidos = movimientosDe.get(k) ?? 0;
        estado =
          saldo.openingSource === 'APERTURA' && movidos === 0
            ? 'CERO_CONFIRMADO'
            : 'CERO_POR_MOVIMIENTOS';
      } else {
        estado = 'CON_SALDO';
      }

      if (filtro.estadoDeActivacion && activacion?.state !== filtro.estadoDeActivacion) continue;
      if (filtro.estado && estado !== filtro.estado) continue;

      filas.push({
        productId: producto.id,
        plu: producto.internalCode,
        nombre: producto.normalizedName,
        familia: producto.family?.name ?? null,
        branchId: sucursal.id,
        sucursal: sucursal.name,
        estado,
        /*
         * El número SÓLO donde significa algo. En los demás estados va `null`,
         * nunca cero: un `0` en la pantalla es indistinguible de un cero real,
         * y ésa es precisamente la confusión que no puede pasar.
         */
        cantidad: ESTADOS_CON_NUMERO.includes(estado) ? (saldo?.quantity.toString() ?? null) : null,
        unidadDeExistencia: unidadAprobada,
        origenDelSaldo: ESTADOS_CON_NUMERO.includes(estado) ? (saldo?.openingSource ?? null) : null,
        motivo: activacion?.reason ?? null,
        movimientosPosteriores: movimientosDe.get(k) ?? 0,
        cutoffAt: corteDe.get(sucursal.id) ?? null,
      });
    }
  }

  /* 5. El resumen: cuentas por estado y totales SEPARADOS por unidad. */
  const resumen: Record<EstadoDeExistencia, number> = {
    SUCURSAL_SIN_APERTURA: 0,
    NO_SE_MANEJA: 0,
    PENDIENTE_DE_UNIDAD: 0,
    CERO_CONFIRMADO: 0,
    CON_SALDO: 0,
    CERO_POR_MOVIMIENTOS: 0,
    SIN_DATO: 0,
  };
  const totales = new Map<string, Decimal>();
  for (const f of filas) {
    resumen[f.estado] += 1;
    if (f.cantidad !== null && f.unidadDeExistencia) {
      const previo = totales.get(f.unidadDeExistencia) ?? new Decimal(0);
      totales.set(f.unidadDeExistencia, previo.plus(new Decimal(f.cantidad)));
    }
  }

  /*
   * La mercadería en tránsito hacia las sucursales miradas.
   *
   * Consulta aparte, y a propósito: no entra en `filas`, no entra en el resumen
   * y no entra en los totales por unidad. Es un tercer lugar —ni origen ni
   * destino— y el tablero lo nombra sin sumarlo.
   */
  const enTransito = await prisma.stockTransferLine.findMany({
    where: {
      transfer: {
        status: 'DESPACHADO',
        toBranchId: { in: sucursales.map((s) => s.id) },
      },
    },
    include: {
      transfer: {
        select: {
          id: true,
          dispatchedAt: true,
          fromBranch: { select: { name: true } },
        },
      },
      product: { select: { normalizedName: true, internalCode: true } },
    },
    orderBy: { id: 'asc' },
    take: tope,
  });

  return {
    filas,
    resumen,
    totalPorUnidad: Object.fromEntries([...totales].map(([u, v]) => [u, v.toString()])),
    sucursalesSinApertura: sucursales
      .filter((s) => !corteDe.has(s.id))
      .map((s) => ({ branchId: s.id, sucursal: s.name })),
    enTransitoHaciaAca: enTransito.map((l) => ({
      productId: l.productId,
      articulo: l.product.normalizedName,
      plu: l.product.internalCode,
      cantidad: (l.dispatchedQuantity ?? l.quantity).toString(),
      unidad: l.unit,
      origen: l.transfer.fromBranch.name,
      trasladoId: l.transfer.id,
      despachadoEl: l.transfer.dispatchedAt,
    })),
    mirados: productos.length,
    tope,
  };
}

/* ========================================================================== *
 * La auditoría, sobre el AuditLog que ya existe
 * ========================================================================== */

/**
 * Las acciones de Stock ERP que esta pantalla sabe mostrar.
 *
 * Se listan a mano y no se deducen por prefijo: un prefijo silencioso deja
 * entrar cualquier acción futura sin que nadie decida que corresponde, y deja
 * afuera las que no empiecen como se esperaba. Esta lista es la que hay que
 * tocar cuando llegue una acción nueva, y que haya que tocarla es la idea.
 */
export const ACCIONES_DE_STOCK_ERP: string[] = [
  AUDIT_ACTIONS.STOCKERP_CONFIG_CREADA,
  AUDIT_ACTIONS.STOCKERP_UNIDAD_APROBADA,
  AUDIT_ACTIONS.STOCKERP_UNIDAD_MODIFICADA,
  AUDIT_ACTIONS.STOCKERP_PRESENTACION_GUARDADA,
  AUDIT_ACTIONS.STOCKERP_DISCREPANCIA_RECONOCIDA,
  AUDIT_ACTIONS.STOCKERP_INTENTO_RECHAZADO,
  AUDIT_ACTIONS.STOCKERP_APERTURA_PREPARADA,
  AUDIT_ACTIONS.STOCKERP_APERTURA_SNAPSHOT,
  AUDIT_ACTIONS.STOCKERP_CONTEO_GUARDADO,
  AUDIT_ACTIONS.STOCKERP_CERO_CONFIRMADO,
  AUDIT_ACTIONS.STOCKERP_NO_SE_MANEJA,
  AUDIT_ACTIONS.STOCKERP_APERTURA_CONFIRMADA,
  AUDIT_ACTIONS.STOCKERP_APERTURA_SIMULTANEA,
  AUDIT_ACTIONS.STOCKERP_CONFLICTO_DE_HUELLA,
  AUDIT_ACTIONS.STOCKERP_BLOQUEADO_INTERRUPTOR,
  AUDIT_ACTIONS.STOCKERP_BLOQUEADO_UNIDAD,
  AUDIT_ACTIONS.STOCKERP_INTERRUPTOR_CAMBIADO,
  AUDIT_ACTIONS.STOCKERP_RECEPCION_DECIDIDA,
  AUDIT_ACTIONS.STOCKERP_RECEPCION_APLICADA,
  AUDIT_ACTIONS.STOCKERP_RECEPCION_SIMULTANEA,
  AUDIT_ACTIONS.STOCKERP_RECEPCIONES_INTERRUPTOR,
  /* Fase 6: traslados entre sucursales. */
  AUDIT_ACTIONS.STOCKERP_TRASLADO_CREADO,
  AUDIT_ACTIONS.STOCKERP_TRASLADO_RENGLON,
  AUDIT_ACTIONS.STOCKERP_TRASLADO_CANCELADO,
  AUDIT_ACTIONS.STOCKERP_TRASLADO_DESPACHADO,
  AUDIT_ACTIONS.STOCKERP_TRASLADO_RECIBIDO,
  AUDIT_ACTIONS.STOCKERP_TRASLADO_SIMULTANEO,
  AUDIT_ACTIONS.STOCKERP_TRASLADO_BLOQUEADO_SALDO,
  AUDIT_ACTIONS.STOCKERP_TRASLADO_DIFERENCIA,
  AUDIT_ACTIONS.STOCKERP_TRASLADOS_INTERRUPTOR,
];

export interface AsientoDeAuditoria {
  id: string;
  createdAt: Date;
  accion: string;
  etiqueta: string;
  usuario: string | null;
  usuarioId: string | null;
  entidad: string;
  entidadId: string | null;
  motivo: string | null;
  antes: unknown;
  despues: unknown;
}

export interface FiltroDeAuditoria {
  usuarioId?: string;
  accion?: string;
  /** Busca en entidad, id de entidad y motivo. */
  texto?: string;
  desde?: Date;
  hasta?: Date;
  limite?: number;
}

/**
 * La auditoría de Stock ERP.
 *
 * **Sólo lee.** No hay forma de modificar ni borrar un asiento desde acá: no se
 * exporta ninguna función que lo haga y la pantalla no ofrece ningún control.
 * Una auditoría que se puede editar no es una auditoría.
 *
 * No crea un segundo registro: usa el `AuditLog` que ya escriben todos los
 * servicios del módulo.
 */
export async function auditoriaDeStockErp(
  user: AuthUser,
  filtro: FiltroDeAuditoria = {},
): Promise<AsientoDeAuditoria[]> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_AUDITORIA_VER, { entity: 'AuditLog' });

  const texto = filtro.texto?.trim();
  const asientos = await prisma.auditLog.findMany({
    where: {
      action: filtro.accion ? filtro.accion : { in: ACCIONES_DE_STOCK_ERP },
      ...(filtro.usuarioId ? { userId: filtro.usuarioId } : {}),
      ...(filtro.desde || filtro.hasta
        ? {
            createdAt: {
              ...(filtro.desde ? { gte: filtro.desde } : {}),
              ...(filtro.hasta ? { lte: filtro.hasta } : {}),
            },
          }
        : {}),
      ...(texto
        ? {
            OR: [
              { entity: { contains: texto, mode: 'insensitive' } },
              { entityId: { contains: texto, mode: 'insensitive' } },
              { reason: { contains: texto, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    include: { user: { select: { name: true } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Math.min(filtro.limite ?? 100, 500),
  });

  return asientos.map((a) => ({
    id: a.id,
    createdAt: a.createdAt,
    accion: a.action,
    etiqueta: AUDIT_ACTION_LABEL[a.action] ?? a.action,
    usuario: a.user?.name ?? null,
    usuarioId: a.userId,
    entidad: a.entity,
    entidadId: a.entityId,
    motivo: a.reason,
    antes: a.before,
    despues: a.after,
  }));
}

/* ========================================================================== *
 * Diagnóstico de integridad: DETECTA, no repara
 * ========================================================================== */

export type ClaseDeDivergencia =
  | 'SALDO_NO_COINCIDE'
  | 'SALDO_SIN_LIBRO'
  | 'LIBRO_SIN_SALDO'
  | 'ULTIMO_MOVIMIENTO_AJENO'
  | 'UNIDAD_INCONSISTENTE'
  | 'ACTIVO_SIN_APERTURA'
  | 'APERTURA_SIN_MOVIMIENTO';

export interface Divergencia {
  clase: ClaseDeDivergencia;
  productId: string;
  plu: string;
  branchId: string;
  sucursal: string;
  /** Lo que dice la proyección. */
  segunElSaldo: string | null;
  /** Lo que dice el libro, que es la fuente de verdad. */
  segunElLibro: string | null;
  detalle: string;
}

export interface Diagnostico {
  /** El instante en que se miró. Un diagnóstico sin fecha no dice nada. */
  comprobadoEl: Date;
  paresRevisados: number;
  movimientosRevisados: number;
  divergencias: Divergencia[];
  /** `true` sólo si no hay ni una. */
  coincide: boolean;
}

/**
 * Compara la proyección contra el libro, y **no arregla nada**.
 *
 * No hay botón «reparar», no hay función que repare y no hay camino que lleve a
 * una escritura desde acá. Es deliberado: una diferencia entre el saldo y el
 * libro significa que algo pasó que nadie entiende todavía, y taparla con un
 * recálculo automático destruye la única evidencia de qué fue. Primero se mira,
 * después se decide, y decidir es de una fase que todavía no existe.
 *
 * Cuando coinciden lo dice, con el momento de la comprobación. Cuando no,
 * muestra **los dos números por separado**: nunca uno «corregido».
 */
export async function diagnosticoDeIntegridad(
  user: AuthUser,
  filtro: { branchId?: string; limite?: number } = {},
): Promise<Diagnostico> {
  await exigirPermiso(user, PERMISSIONS.STOCKERP_INTEGRIDAD_VER, { entity: 'StockLedger' });

  const comprobadoEl = new Date();
  const tope = Math.min(filtro.limite ?? 2000, 5000);
  const sucursal = filtro.branchId;

  /*
   * La suma del libro por artículo y sucursal, hecha EN LA BASE.
   *
   * Traer el libro entero para sumarlo en JavaScript sería exactamente lo que
   * la instrucción prohíbe, y además daría mal: `Decimal` de Postgres sumado
   * como `number` pierde exactitud, que es el defecto que este módulo viene
   * esquivando desde la fase 1.
   */
  const sumas = await prisma.$queryRaw<
    { productId: string; branchId: string; suma: string; unidades: number; movimientos: bigint }[]
  >`
    SELECT l."productId",
           l."branchId",
           SUM(CASE WHEN l."direction" = 'IN' THEN l."quantity" ELSE -l."quantity" END)::text AS suma,
           COUNT(DISTINCT l."unit")::int AS unidades,
           COUNT(*) AS movimientos
      FROM "stock_ledger" l
     WHERE (${sucursal ?? null}::text IS NULL OR l."branchId" = ${sucursal ?? null}::text)
     GROUP BY l."productId", l."branchId"
     LIMIT ${tope}`;

  const saldos = await prisma.stockBalance.findMany({
    where: sucursal ? { branchId: sucursal } : {},
    select: {
      productId: true,
      branchId: true,
      quantity: true,
      unit: true,
      lastLedgerId: true,
      lastOperationId: true,
      openingSource: true,
      product: { select: { internalCode: true } },
      branch: { select: { name: true } },
    },
    take: tope,
  });

  const clave = (p: string, b: string) => `${p}|${b}`;
  const sumaDe = new Map(sumas.map((s) => [clave(s.productId, s.branchId), s]));
  const saldoDe = new Map(saldos.map((s) => [clave(s.productId, s.branchId), s]));

  /* Nombres para los pares que están en el libro y no tienen saldo. */
  const huerfanos = sumas.filter((s) => !saldoDe.has(clave(s.productId, s.branchId)));
  const nombres = new Map<string, { plu: string; sucursal: string }>();
  if (huerfanos.length > 0) {
    const productos = await prisma.product.findMany({
      where: { id: { in: [...new Set(huerfanos.map((h) => h.productId))] } },
      select: { id: true, internalCode: true },
    });
    const sucursales = await prisma.branch.findMany({
      where: { id: { in: [...new Set(huerfanos.map((h) => h.branchId))] } },
      select: { id: true, name: true },
    });
    const porProducto = new Map(productos.map((p) => [p.id, p.internalCode]));
    const porSucursal = new Map(sucursales.map((s) => [s.id, s.name]));
    for (const h of huerfanos) {
      nombres.set(clave(h.productId, h.branchId), {
        plu: porProducto.get(h.productId) ?? h.productId,
        sucursal: porSucursal.get(h.branchId) ?? h.branchId,
      });
    }
  }

  const divergencias: Divergencia[] = [];
  let movimientosRevisados = 0;

  /* 1. Cada saldo, contra la suma del libro. */
  for (const saldo of saldos) {
    const k = clave(saldo.productId, saldo.branchId);
    const suma = sumaDe.get(k);
    const comun = {
      productId: saldo.productId,
      plu: saldo.product.internalCode,
      branchId: saldo.branchId,
      sucursal: saldo.branch.name,
    };

    if (!suma) {
      divergencias.push({
        ...comun,
        clase: 'SALDO_SIN_LIBRO',
        segunElSaldo: saldo.quantity.toString(),
        segunElLibro: null,
        detalle:
          'Hay un saldo materializado y el libro no tiene ni un movimiento de ese artículo en esa ' +
          'sucursal. El libro es la fuente de verdad: un saldo sin libro no se puede explicar.',
      });
      continue;
    }

    movimientosRevisados += Number(suma.movimientos);

    const delLibro = new Decimal(suma.suma);
    const deLaProyeccion = new Decimal(saldo.quantity.toString());
    if (!delLibro.equals(deLaProyeccion)) {
      divergencias.push({
        ...comun,
        clase: 'SALDO_NO_COINCIDE',
        segunElSaldo: deLaProyeccion.toString(),
        segunElLibro: delLibro.toString(),
        detalle:
          `La proyección dice ${deLaProyeccion.toString()} y la suma del libro da ` +
          `${delLibro.toString()}. Se muestran los dos por separado, sin corregir ninguno: ` +
          'cuál de los dos está mal es justamente lo que hay que averiguar.',
      });
    }

    if (suma.unidades > 1) {
      divergencias.push({
        ...comun,
        clase: 'UNIDAD_INCONSISTENTE',
        segunElSaldo: saldo.unit,
        segunElLibro: `${suma.unidades} unidades distintas en el libro`,
        detalle:
          'El libro tiene movimientos de este artículo en más de una unidad. La suma de arriba ' +
          'mezcla magnitudes incompatibles y NO se puede leer como un saldo.',
      });
    }
  }

  /* 2. Movimientos sin saldo: el libro dice algo que la proyección no refleja. */
  for (const h of huerfanos) {
    const n = nombres.get(clave(h.productId, h.branchId));
    divergencias.push({
      clase: 'LIBRO_SIN_SALDO',
      productId: h.productId,
      plu: n?.plu ?? h.productId,
      branchId: h.branchId,
      sucursal: n?.sucursal ?? h.branchId,
      segunElSaldo: null,
      segunElLibro: h.suma,
      detalle:
        'El libro tiene movimientos y no hay saldo materializado. La proyección quedó atrás: ' +
        'el libro manda, y el saldo habría que reconstruirlo desde él en una fase que decida hacerlo.',
    });
  }

  /* 3. El último movimiento al que apunta cada saldo existe y es del par. */
  const ultimos = await prisma.stockLedger.findMany({
    where: { id: { in: saldos.map((s) => s.lastLedgerId) } },
    select: { id: true, productId: true, branchId: true, operationId: true, unit: true },
  });
  const ultimoDe = new Map(ultimos.map((u) => [u.id, u]));
  for (const saldo of saldos) {
    const ultimo = ultimoDe.get(saldo.lastLedgerId);
    const comun = {
      productId: saldo.productId,
      plu: saldo.product.internalCode,
      branchId: saldo.branchId,
      sucursal: saldo.branch.name,
    };
    if (!ultimo) {
      divergencias.push({
        ...comun,
        clase: 'ULTIMO_MOVIMIENTO_AJENO',
        segunElSaldo: saldo.lastLedgerId,
        segunElLibro: null,
        detalle: 'El saldo apunta a un movimiento que no está en el libro.',
      });
      continue;
    }
    if (ultimo.productId !== saldo.productId || ultimo.branchId !== saldo.branchId) {
      divergencias.push({
        ...comun,
        clase: 'ULTIMO_MOVIMIENTO_AJENO',
        segunElSaldo: saldo.lastLedgerId,
        segunElLibro: `${ultimo.productId}|${ultimo.branchId}`,
        detalle: 'El saldo apunta a un movimiento de otro artículo o de otra sucursal.',
      });
    }
    if (ultimo.operationId !== saldo.lastOperationId) {
      divergencias.push({
        ...comun,
        clase: 'ULTIMO_MOVIMIENTO_AJENO',
        segunElSaldo: saldo.lastOperationId,
        segunElLibro: ultimo.operationId,
        detalle: 'La operación que el saldo dice tener no es la del movimiento al que apunta.',
      });
    }
    if (ultimo.unit !== saldo.unit) {
      divergencias.push({
        ...comun,
        clase: 'UNIDAD_INCONSISTENTE',
        segunElSaldo: saldo.unit,
        segunElLibro: ultimo.unit,
        detalle: 'El saldo y su último movimiento están en unidades distintas.',
      });
    }
  }

  /* 4. Activación, apertura y libro: que se cuenten la misma historia. */
  const activos = await prisma.productStockActivation.findMany({
    where: {
      state: 'ACTIVO',
      ...(sucursal ? { branchId: sucursal } : {}),
    },
    select: {
      productId: true,
      branchId: true,
      openingLedgerId: true,
      product: { select: { internalCode: true } },
      branch: { select: { name: true } },
    },
    take: tope,
  });
  for (const a of activos) {
    if (!a.openingLedgerId) {
      divergencias.push({
        clase: 'ACTIVO_SIN_APERTURA',
        productId: a.productId,
        plu: a.product.internalCode,
        branchId: a.branchId,
        sucursal: a.branch.name,
        segunElSaldo: 'ACTIVO',
        segunElLibro: null,
        detalle: 'El artículo figura activo y no tiene movimiento de apertura que lo respalde.',
      });
    }
  }

  return {
    comprobadoEl,
    paresRevisados: saldos.length,
    movimientosRevisados,
    divergencias,
    coincide: divergencias.length === 0,
  };
}
