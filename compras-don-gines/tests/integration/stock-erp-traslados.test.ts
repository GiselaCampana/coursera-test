import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db';
import { limpiarBase, sembrarEscenario, comoUsuario, type Escenario } from './ayudas';
import {
  crearBorrador,
  agregarRenglon,
  modificarRenglon,
  retirarRenglon,
  cancelarBorrador,
  detalleDeTraslado,
  despachar,
  recibir,
  listadoDeTraslados,
  mercaderiaEnTransito,
  interruptorDeTrasladosReales,
  cambiarInterruptorDeTraslados,
  claveDeDespacho,
  claveDeRecepcionDeTraslado,
  huellaDeTraslado,
  VERSION_DE_LA_HUELLA_DE_TRASLADO,
} from '@/lib/services/stock-erp-traslados';
import {
  prepararApertura,
  verApertura,
  guardarConteo,
  contarEnCero,
  marcarNoSeManeja,
  fijarCorte,
  confirmarApertura,
} from '@/lib/services/stock-erp-apertura';
import { aprobarUnidadDeExistencia } from '@/lib/services/stock-erp-unidades';
import { tableroDeExistencias, movimientosDelLibro } from '@/lib/services/stock-erp-consultas';
import { AUDIT_ACTIONS } from '@/lib/services/audit';
import {
  ADMIN_PERMISSIONS,
  PERMISSIONS,
  PERMISOS_SENSIBLES_DE_STOCK_ERP,
} from '@/lib/auth/permissions';
import { Decimal } from '@/lib/money';

/**
 * **Stock ERP, fase 6: el traslado entre sucursales.**
 *
 * Las tres afirmaciones que sostienen el archivo:
 *
 *  1. **El despacho y la recepción son dos hechos físicos.** Cada uno con su
 *     operación, su instante, su clave idempotente y su transacción completa.
 *  2. **En el medio la mercadería está en tránsito**: ya no está en el origen y
 *     todavía no está en el destino. No es saldo de nadie.
 *  3. **La recepción es exacta.** Si lo que llegó no coincide con lo que salió,
 *     no se confirma nada: el traslado se queda en tránsito. Esta fase no
 *     resuelve diferencias físicas y no inventa una merma para taparlas.
 *
 * Todo lo de acá usa artículos y sucursales INVENTADOS, con aperturas
 * ficticias. Ninguna prueba sale a la red, ninguna toca Control de Stock y el
 * interruptor de traslados reales queda apagado de principio a fin.
 */

let escenario: Escenario;
/** Prepara aperturas, aprueba unidades y arma borradores. Nada sensible. */
let preparador: ReturnType<typeof comoUsuario>;
/** Además despacha. */
let despachador: ReturnType<typeof comoUsuario>;
/** Además recibe. */
let receptor: ReturnType<typeof comoUsuario>;
/** Toca interruptores. */
let jefeDeModulo: ReturnType<typeof comoUsuario>;

function con(permisos: string[]): ReturnType<typeof comoUsuario> {
  return comoUsuario({
    id: escenario.admin.id,
    email: escenario.admin.email,
    name: escenario.admin.name,
    branchId: null,
    roleId: escenario.admin.roleId,
    roleCode: escenario.admin.roleCode,
    roleName: escenario.admin.roleName,
    permissions: [...escenario.admin.permissions, ...permisos],
    scopeAllBranches: true,
  });
}

const CORTE = { fecha: '2026-09-01', hora: '20:30' };

const BASE_DE_APERTURA = [
  PERMISSIONS.STOCKERP_APERTURA_PREPARAR,
  PERMISSIONS.STOCKERP_APERTURA_CONFIRMAR,
  PERMISSIONS.STOCKERP_ACTIVACION_HABILITAR,
  PERMISSIONS.STOCKERP_UNIDADES_CONFIGURAR,
];

let origenId = '';
let destinoId = '';

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();
  preparador = con([...BASE_DE_APERTURA, PERMISSIONS.STOCKERP_TRASLADO_PREPARAR]);
  despachador = con([
    ...BASE_DE_APERTURA,
    PERMISSIONS.STOCKERP_TRASLADO_PREPARAR,
    PERMISSIONS.STOCKERP_TRASLADO_DESPACHAR,
  ]);
  receptor = con([
    ...BASE_DE_APERTURA,
    PERMISSIONS.STOCKERP_TRASLADO_PREPARAR,
    PERMISSIONS.STOCKERP_TRASLADO_DESPACHAR,
    PERMISSIONS.STOCKERP_TRASLADO_RECIBIR,
  ]);
  jefeDeModulo = con([PERMISSIONS.STOCKERP_MODULO_CONFIGURAR]);
  origenId = escenario.sucursales.devoto;
  destinoId = escenario.sucursales.pueyrredon;
});

afterEach(() => vi.restoreAllMocks());

/* ========================================================================== *
 * Ayudas: artículos, aperturas y borradores inventados
 * ========================================================================== */

async function articulo(plu: string, unidad: 'KG' | 'UNIT' | null = 'KG') {
  const p = await prisma.product.create({
    data: {
      internalCode: plu,
      normalizedName: `ARTICULO FICTICIO ${plu}`,
      purchaseUnit: unidad === 'UNIT' ? 'UNIT' : 'KG',
      saleMode: 'AL_CORTE',
      targetMarginPct: '0.45',
      marginBasis: 'SOBRE_COSTO',
      cashDiscountPct: '0',
      roundingRule: 'NEAREST_100',
    },
  });
  if (unidad) {
    await aprobarUnidadDeExistencia(preparador, { productId: p.id, unidad, confirmado: true });
  }
  return p;
}

/** Apertura ficticia confirmada, con lo que haya que contar. */
async function aperturaDe(
  branchId: string,
  contar: { productId: string; cantidad: string }[] = [],
) {
  const ap = await prepararApertura(preparador, { branchId, ficticia: true });
  const vista = await verApertura(preparador, ap.sessionId);
  const aContar = new Map(contar.map((c) => [c.productId, c.cantidad]));

  for (const l of vista.lineas) {
    const cantidad = aContar.get(l.productId);
    if (cantidad !== undefined) {
      if (new Decimal(cantidad).isZero()) await contarEnCero(preparador, l.activationId);
      else await guardarConteo(preparador, { activationId: l.activationId, cantidad });
    } else if (l.estado !== 'NO_SE_MANEJA') {
      await marcarNoSeManeja(preparador, {
        activationId: l.activationId,
        motivo: 'Esta sucursal no trabaja este artículo.',
      });
    }
  }

  await fijarCorte(preparador, { sessionId: ap.sessionId, ...CORTE });
  const lista = await verApertura(preparador, ap.sessionId);
  await confirmarApertura(preparador, {
    sessionId: ap.sessionId,
    confirmado: true,
    esperado: {
      contados: lista.resumen.CONTADO,
      ceros: lista.resumen.CONTADO_CERO,
      noSeManeja: lista.resumen.NO_SE_MANEJA,
    },
  });
  return ap.sessionId;
}

/** Un borrador con los renglones pedidos, listo para despachar. */
async function borradorCon(
  renglones: { productId: string; cantidad: string }[],
  quien = preparador,
): Promise<string> {
  const { id } = await crearBorrador(quien, { origenId, destinoId });
  for (const r of renglones) {
    await agregarRenglon(quien, { trasladoId: id, productId: r.productId, cantidad: r.cantidad });
  }
  return id;
}

/** El saldo de un artículo en una sucursal, o null si no tiene. */
async function saldo(productId: string, branchId: string): Promise<string | null> {
  const fila = await prisma.stockBalance.findUnique({
    where: { productId_branchId: { productId, branchId } },
  });
  return fila ? fila.quantity.toString() : null;
}

/** El escenario más usado: un artículo con 10 en el origen y nada en destino. */
async function escenarioSimple(cantidadEnOrigen = '10') {
  const art = await articulo('T-100');
  await aperturaDe(origenId, [{ productId: art.id, cantidad: cantidadEnOrigen }]);
  await aperturaDe(destinoId, [{ productId: art.id, cantidad: '0' }]);
  return art;
}

/* ========================================================================== *
 * 1 a 3. El borrador no mueve nada
 * ========================================================================== */

describe('el borrador no toca existencias', () => {
  it('1. crear un borrador no cambia ningún saldo', async () => {
    const art = await escenarioSimple();
    const antes = await prisma.stockBalance.findMany({ orderBy: { id: 'asc' } });

    const { id } = await crearBorrador(preparador, { origenId, destinoId });
    await agregarRenglon(preparador, { trasladoId: id, productId: art.id, cantidad: '2' });

    const despues = await prisma.stockBalance.findMany({ orderBy: { id: 'asc' } });
    expect(despues.map((s) => s.quantity.toString())).toEqual(
      antes.map((s) => s.quantity.toString()),
    );
    expect(await prisma.stockLedger.count({ where: { type: { in: ['TRANSFER_OUT', 'TRANSFER_IN'] } } })).toBe(0);
  });

  it('2. editar un borrador no cambia ningún saldo', async () => {
    const art = await escenarioSimple();
    const id = await borradorCon([{ productId: art.id, cantidad: '2' }]);
    const linea = (await detalleDeTraslado(preparador, id)).renglones[0]!;

    await modificarRenglon(preparador, { lineaId: linea.lineaId, cantidad: '3.5' });
    expect(await saldo(art.id, origenId)).toBe('10');
    expect(await saldo(art.id, destinoId)).toBe('0');

    await retirarRenglon(preparador, { lineaId: linea.lineaId });
    expect(await saldo(art.id, origenId)).toBe('10');
    expect(await prisma.stockLedger.count({ where: { type: 'TRANSFER_OUT' } })).toBe(0);
  });

  it('3. cancelar un borrador no escribe en el libro', async () => {
    const art = await escenarioSimple();
    const id = await borradorCon([{ productId: art.id, cantidad: '2' }]);

    await cancelarBorrador(preparador, { trasladoId: id, motivo: 'Se pidió de más' });

    const t = await prisma.stockTransfer.findUniqueOrThrow({ where: { id } });
    expect(t.status).toBe('CANCELADO');
    expect(t.operationId, 'un cancelado no tiene operación').toBeNull();
    expect(await saldo(art.id, origenId)).toBe('10');
    expect(await prisma.stockLedger.count({ where: { type: { in: ['TRANSFER_OUT', 'TRANSFER_IN'] } } })).toBe(0);

    const auditoria = await prisma.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.STOCKERP_TRASLADO_CANCELADO, entityId: id },
    });
    expect(auditoria?.reason).toBe('Se pidió de más');
  });
});

/* ========================================================================== *
 * 4 a 6. Lo que no se acepta ni como borrador
 * ========================================================================== */

describe('lo que el borrador rechaza de entrada', () => {
  it('4. origen y destino iguales se rechazan', async () => {
    await expect(
      crearBorrador(preparador, { origenId, destinoId: origenId }),
    ).rejects.toThrow(/tienen que ser distintos/);
    expect(await prisma.stockTransfer.count()).toBe(0);
  });

  it('5. una cantidad cero o negativa se rechaza', async () => {
    const art = await escenarioSimple();
    const { id } = await crearBorrador(preparador, { origenId, destinoId });
    for (const mala of ['0', '-1', '0.000']) {
      await expect(
        agregarRenglon(preparador, { trasladoId: id, productId: art.id, cantidad: mala }),
        mala,
      ).rejects.toThrow(/mayor que cero/);
    }
    expect(await prisma.stockTransferLine.count()).toBe(0);
  });

  it('6. más decimales que los permitidos se rechazan', async () => {
    const art = await escenarioSimple();
    const { id } = await crearBorrador(preparador, { origenId, destinoId });
    await expect(
      agregarRenglon(preparador, { trasladoId: id, productId: art.id, cantidad: '1.2345' }),
    ).rejects.toThrow(/tres decimales/);

    /* Y la base rechaza lo mismo, para que no dependa del servicio. */
    await agregarRenglon(preparador, { trasladoId: id, productId: art.id, cantidad: '1.234' });
    const linea = await prisma.stockTransferLine.findFirstOrThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "stock_transfer_line" SET "quantity" = 1.2345 WHERE id = $1`,
        linea.id,
      ),
    ).rejects.toThrow();
  });
});

/* ========================================================================== *
 * 7 a 11. Lo que frena el despacho
 * ========================================================================== */

describe('lo que frena el despacho', () => {
  it('7. un artículo sin unidad aprobada se bloquea', async () => {
    const conUnidad = await escenarioSimple();
    const sinUnidad = await articulo('T-SIN', null);

    const { id } = await crearBorrador(preparador, { origenId, destinoId });
    await expect(
      agregarRenglon(preparador, { trasladoId: id, productId: sinUnidad.id, cantidad: '1' }),
    ).rejects.toThrow(/unidad de existencia aprobada/);

    /* Y el traslado sigue vacío y despachable a cero, es decir: bloqueado. */
    await agregarRenglon(preparador, { trasladoId: id, productId: conUnidad.id, cantidad: '1' });
    const previa = await detalleDeTraslado(preparador, id);
    expect(previa.renglones).toHaveLength(1);
  });

  it('8. un artículo que la sucursal no maneja se bloquea', async () => {
    const art = await articulo('T-100');
    const otro = await articulo('T-200');
    /* El destino cuenta el primero y marca el segundo como no manejado. */
    await aperturaDe(origenId, [
      { productId: art.id, cantidad: '10' },
      { productId: otro.id, cantidad: '10' },
    ]);
    await aperturaDe(destinoId, [{ productId: art.id, cantidad: '0' }]);

    const id = await borradorCon([{ productId: otro.id, cantidad: '1' }]);
    const previa = await detalleDeTraslado(preparador, id);
    expect(previa.renglones[0]!.clase).toBe('BLOQUEADO');
    expect(previa.renglones[0]!.motivo).toMatch(/no maneja este artículo/);

    await expect(despachar(despachador, { trasladoId: id, confirmado: true })).rejects.toThrow(
      /no se puede despachar/,
    );
    expect(await prisma.stockLedger.count({ where: { type: 'TRANSFER_OUT' } })).toBe(0);
  });

  it('9. un origen sin apertura confirmada se bloquea', async () => {
    const art = await articulo('T-100');
    await aperturaDe(destinoId, [{ productId: art.id, cantidad: '0' }]);
    /* El origen nunca inauguró. */
    const id = await borradorCon([{ productId: art.id, cantidad: '1' }]);

    const previa = await detalleDeTraslado(preparador, id);
    expect(previa.impedimentos.join(' ')).toMatch(/no tiene apertura confirmada/);
    await expect(despachar(despachador, { trasladoId: id, confirmado: true })).rejects.toThrow(
      /apertura confirmada/,
    );
    expect(await prisma.stockLedger.count({ where: { type: 'TRANSFER_OUT' } })).toBe(0);
  });

  it('10. un destino sin apertura confirmada se bloquea', async () => {
    const art = await articulo('T-100');
    await aperturaDe(origenId, [{ productId: art.id, cantidad: '10' }]);
    const id = await borradorCon([{ productId: art.id, cantidad: '1' }]);

    const previa = await detalleDeTraslado(preparador, id);
    expect(previa.impedimentos.join(' ')).toMatch(/no tiene apertura confirmada/);
    await expect(despachar(despachador, { trasladoId: id, confirmado: true })).rejects.toThrow(
      /apertura confirmada/,
    );
    expect(await prisma.stockLedger.count()).toBe(1); /* sólo la apertura del origen */
  });

  it('11. saldo insuficiente bloquea sin escribir nada', async () => {
    const art = await escenarioSimple('2');
    const id = await borradorCon([{ productId: art.id, cantidad: '5' }]);

    const previa = await detalleDeTraslado(preparador, id);
    expect(previa.renglones[0]!.motivo).toMatch(/hay 2 KG y se quieren despachar 5/);

    await expect(despachar(despachador, { trasladoId: id, confirmado: true })).rejects.toThrow(
      /no se puede despachar/,
    );
    expect(await saldo(art.id, origenId)).toBe('2');
    expect(await prisma.stockOperation.count({ where: { kind: 'TRASLADO' } })).toBe(0);

    const auditoria = await prisma.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.STOCKERP_TRASLADO_BLOQUEADO_SALDO, entityId: id },
    });
    expect(auditoria, 'el bloqueo por saldo queda auditado').not.toBeNull();
  });

  it('11b. un saldo negativo es imposible EN LA BASE, no sólo en el servicio', async () => {
    /*
     * HALLAZGO de una rotura deliberada. Quitar la revalidación de saldo que el
     * despacho hace DENTRO de la transacción no puso nada en rojo: la revisión
     * previa frena antes, así que esa línea no se alcanza desde ninguna prueba.
     *
     * Lo que sí sostiene la garantía es la base, y eso no estaba afirmado en
     * ninguna parte. Queda afirmado acá: ni el libro ni el saldo aceptan un
     * número negativo, venga del servicio, de un script de madrugada o de una
     * consulta suelta.
     *
     * La revalidación del servicio no se quita: existe para la carrera —que el
     * saldo baje entre la revisión y la escritura— y para contestar con una
     * frase en castellano en vez de con el nombre de una restricción. Pero la
     * que impide el desastre es la de abajo.
     */
    const art = await escenarioSimple('2');
    const balance = await prisma.stockBalance.findUniqueOrThrow({
      where: { productId_branchId: { productId: art.id, branchId: origenId } },
    });
    const operacion = await prisma.stockOperation.create({
      data: {
        operationKey: `negativo-${art.id}`,
        kind: 'RECEPCION_COMPRA',
        contentHash: 'negativo',
        branchId: origenId,
        requestedById: escenario.admin.id,
      },
    });

    /**
     * Un movimiento válido, con el `balanceAfterSeq` que se le indique.
     *
     * Se usa `PURCHASE_IN` y no un traslado a propósito: un movimiento de
     * traslado exige su renglón y su estado, y entonces el rechazo podría venir
     * de ahí. Lo que se quiere ejercitar es la restricción del SALDO, no otra.
     */
    const movimiento = (id: string, saldo: string) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "stock_ledger"
           ("id","txId","productId","pluHistorico","branchId","type","direction",
            "quantity","unit","effectiveAt","operationId","idempotencyKey","balanceAfterSeq")
         VALUES ($1, txid_current(), $2, 'PLU', $3, 'PURCHASE_IN'::"StockMovementType",
                 'IN'::"StockDirection", 1, 'KG', now(), $4, $5, $6::numeric)`,
        id,
        art.id,
        origenId,
        operacion.id,
        id,
        saldo,
      );

    /*
     * **Cada afirmación nombra la restricción que dice probar.**
     *
     * HALLAZGO de repetir la rotura: la primera versión de esta prueba pasaba
     * igual con la CHECK de saldo negativo QUITADA de la base, porque lo que
     * rechazaba era otro disparador —el que exige que un saldo se mueva junto
     * con un movimiento—. Una prueba que pasa por el camino equivocado afirma
     * algo que no comprobó. Por eso ahora se exige el nombre.
     */
    await expect(movimiento(`neg-libro-${art.id}`, '-3'), 'el libro, con saldo negativo')
      .rejects.toThrow(/stock_ledger_saldo_no_negativo/);

    /*
     * Y el saldo materializado. Acá hay algo que vale la pena dejar escrito,
     * porque lo descubrió esta misma prueba: **la CHECK `stock_balance_no_negativo`
     * no se puede alcanzar por ningún camino legítimo.**
     *
     * El disparador `stock_balance_respaldado` exige que el saldo sea IGUAL al
     * `balanceAfterSeq` del movimiento que lo acompaña, y el libro no acepta un
     * `balanceAfterSeq` negativo. Así que para dejar un saldo en −1 habría que
     * violar antes la restricción del libro. La CHECK del saldo es el segundo
     * cinturón, y está bien que exista; lo que no corresponde es afirmar que
     * ella es la que frena, porque no llega a hacerlo.
     *
     * Lo que sigue comprueba eso: el intento se rechaza, y quien lo rechaza es
     * la coherencia entre el saldo y su movimiento.
     */
    await expect(
      prisma.$transaction(async (tx) => {
        const id = `neg-saldo-${art.id}`;
        await tx.$executeRawUnsafe(
          `INSERT INTO "stock_ledger"
             ("id","txId","productId","pluHistorico","branchId","type","direction",
              "quantity","unit","effectiveAt","operationId","idempotencyKey","balanceAfterSeq")
           VALUES ($1, txid_current(), $2, 'PLU', $3, 'PURCHASE_IN'::"StockMovementType",
                   'IN'::"StockDirection", 1, 'KG', now(), $4, $5, 0)`,
          id,
          art.id,
          origenId,
          operacion.id,
          id,
        );
        await tx.$executeRawUnsafe(
          `UPDATE "stock_balance"
              SET "quantity" = -1, "lastLedgerId" = $2, "lastOperationId" = $3
            WHERE id = $1`,
          balance.id,
          id,
          operacion.id,
        );
      }),
      'el saldo materializado, en negativo',
    ).rejects.toThrow(/no coincide con el saldo posterior/);
  });
});

/* ========================================================================== *
 * La carrera por el mismo saldo, con el punto de carrera CONTROLADO
 * ========================================================================== */

describe('dos traslados que compiten por el mismo saldo', () => {
  /**
   * **La barrera: un candado de PostgreSQL tomado por la prueba.**
   *
   * El problema que resuelve es real y es la razón por la que esta prueba
   * existe. Lanzar dos despachos con `Promise.all` no garantiza nada: si el
   * primero alcanza a confirmar antes de que el segundo calcule su revisión, el
   * segundo se frena en la revisión previa y la revalidación que ocurre DENTRO
   * de la transacción —la que interesa— no se ejercita nunca. Esperar unos
   * milisegundos tampoco sirve: eso es confiar en el azar con más pasos.
   *
   * Acá el punto de carrera lo fija la prueba. Desde una CONEXIÓN APARTE se
   * toma `FOR UPDATE` sobre la fila de saldo del origen y se deja la
   * transacción abierta. Los dos despachos calculan su revisión sin candados
   * —los dos ven 10, los dos parecen posibles— y después quedan detenidos en el
   * `FOR UPDATE` del servicio. Cuando los dos están detenidos, la prueba suelta
   * la barrera: recién ahí PostgreSQL los serializa, uno descuenta y el otro
   * vuelve a leer el saldo ya bajado.
   *
   * No hay nada habilitable en producción: el servicio no sabe que esto existe.
   * La barrera es una transacción como cualquier otra, tomada por el mismo SQL
   * que usaría cualquier consulta.
   */
  let barrera: PrismaClient;

  beforeEach(() => {
    barrera = new PrismaClient();
  });
  afterEach(async () => {
    await barrera.$disconnect();
  });

  /**
   * Espera a que haya `cuantos` procesos detenidos esperando un candado.
   *
   * Es una espera por CONDICIÓN observada en `pg_stat_activity`, no un plazo
   * fijo: si la condición no se cumple, la prueba falla diciendo que los
   * despachos no llegaron al punto de carrera, en vez de seguir y afirmar algo
   * sobre una carrera que no ocurrió.
   */
  async function esperarDetenidos(cuantos: number) {
    for (let intento = 0; intento < 200; intento += 1) {
      const filas = await barrera.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock'
           AND state = 'active'`;
      if (Number(filas[0]!.n) >= cuantos) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(
      `Los despachos no llegaron al punto de carrera: nunca hubo ${cuantos} procesos esperando el candado.`,
    );
  }

  /**
   * Toma el candado de las filas de saldo y lo suelta cuando se le pide.
   *
   * **Devuelve recién cuando el candado está TOMADO**, y eso no es un detalle:
   * la primera versión devolvía apenas lanzada la transacción, sin esperar a que
   * el `FOR UPDATE` se hubiera ejecutado. Los despachos arrancaban antes de que
   * la barrera existiera, uno ganaba, el otro se frenaba en la revisión previa y
   * la prueba fallaba diciendo que nunca hubo dos procesos esperando. La falla
   * era correcta: no había carrera que observar.
   */
  async function tomarLaBarrera(productIds: string[], branchId: string) {
    let soltar = () => {};
    const suelta = new Promise<void>((res) => {
      soltar = res;
    });
    let avisarQueEstaTomada = () => {};
    const tomadaDeVerdad = new Promise<void>((res) => {
      avisarQueEstaTomada = res;
    });

    const tomada = barrera.$transaction(
      async (tx) => {
        for (const pid of [...productIds].sort()) {
          await tx.$executeRaw`
            SELECT id FROM "stock_balance"
             WHERE "productId" = ${pid} AND "branchId" = ${branchId} FOR UPDATE`;
        }
        avisarQueEstaTomada();
        await suelta;
      },
      { timeout: 60_000 },
    );

    await tomadaDeVerdad;
    return { soltar: () => soltar(), tomada };
  }

  it('11c. dos despachos de 7 sobre un saldo de 10: uno pasa, el otro recibe el error de negocio', async () => {
    const art = await escenarioSimple('10');
    const unoId = await borradorCon([{ productId: art.id, cantidad: '7' }]);
    const dosId = await borradorCon([{ productId: art.id, cantidad: '7' }]);

    /* Antes de competir, los dos parecen posibles: es el requisito del escenario. */
    for (const id of [unoId, dosId]) {
      const previa = await detalleDeTraslado(despachador, id);
      expect(previa.impedimentos, `${id} sin impedimentos antes de competir`).toEqual([]);
      expect(previa.renglones[0]!.clase).toBe('LISTO');
    }

    const { soltar, tomada } = await tomarLaBarrera([art.id], origenId);

    /* Los dos despachos arrancan y quedan detenidos en el candado del servicio. */
    const carrera = Promise.allSettled([
      despachar(despachador, { trasladoId: unoId, confirmado: true }),
      despachar(despachador, { trasladoId: dosId, confirmado: true }),
    ]);
    await esperarDetenidos(2);
    soltar();
    await tomada;
    const [a, b] = await carrera;

    /* --- Exactamente uno despachó ------------------------------------- */
    const ganadores = [a, b].filter((r) => r.status === 'fulfilled');
    const perdedores = [a, b].filter((r) => r.status === 'rejected');
    expect(ganadores, 'exactamente uno despachó').toHaveLength(1);
    expect(perdedores, 'exactamente uno fue rechazado').toHaveLength(1);

    /* --- Y el rechazo es de NEGOCIO, no crudo -------------------------- */
    const error = (perdedores[0] as PromiseRejectedResult).reason as Error;
    expect(error.message, 'el mensaje explica el saldo').toMatch(/No hay saldo suficiente/);
    expect(error.message, 'y dice que no se escribió nada').toMatch(/No se escribió nada/);
    expect(
      error.message,
      'no es un error crudo de la base: ni CHECK, ni unicidad, ni serialización',
    ).not.toMatch(/constraint|CHECK|Unique|40001|40P01|serialize|deadlock|P200\d/i);

    /* --- El libro y el saldo ------------------------------------------- */
    const operaciones = await prisma.stockOperation.findMany({
      where: { operationKey: { in: [claveDeDespacho(unoId), claveDeDespacho(dosId)] } },
    });
    expect(operaciones, 'una sola operación de despacho').toHaveLength(1);

    const salidas = await prisma.stockLedger.findMany({ where: { type: 'TRANSFER_OUT' } });
    expect(salidas, 'un solo movimiento de salida').toHaveLength(1);
    expect(salidas[0]!.balanceAfterSeq.toString()).toBe('3');

    expect(await saldo(art.id, origenId), 'el saldo final es 3').toBe('3');
    const balance = await prisma.stockBalance.findUniqueOrThrow({
      where: { productId_branchId: { productId: art.id, branchId: origenId } },
    });
    expect(new Decimal(balance.quantity.toString()).isNegative(), 'nunca negativo').toBe(false);

    /* --- El perdedor no dejó NADA -------------------------------------- */
    const estados = await prisma.stockTransfer.findMany({
      where: { id: { in: [unoId, dosId] } },
      select: { id: true, status: true, operationId: true },
    });
    const despachados = estados.filter((t) => t.status === 'DESPACHADO');
    const borradores = estados.filter((t) => t.status === 'BORRADOR');
    expect(despachados, 'uno quedó DESPACHADO').toHaveLength(1);
    expect(borradores, 'el otro sigue en BORRADOR').toHaveLength(1);
    expect(borradores[0]!.operationId, 'el perdedor no tiene operación').toBeNull();

    const perdedorId = borradores[0]!.id;
    const lineasDelPerdedor = await prisma.stockTransferLine.findMany({
      where: { transferId: perdedorId },
    });
    for (const l of lineasDelPerdedor) {
      expect(l.dispatchedQuantity, 'el perdedor no registró cantidad despachada').toBeNull();
      expect(
        await prisma.stockLedger.count({ where: { transferLineId: l.id } }),
        'el perdedor no escribió en el libro',
      ).toBe(0);
    }
    expect(
      await prisma.auditLog.count({
        where: { action: AUDIT_ACTIONS.STOCKERP_TRASLADO_DESPACHADO, entityId: perdedorId },
      }),
      'y no dejó auditoría de éxito',
    ).toBe(0);
    /* Que quede auditado el rechazo sí está permitido, y no se exige. */
  });

  it('11d. dos traslados con los mismos dos artículos en orden inverso: sin interbloqueo', async () => {
    const uno = await articulo('T-100');
    const otro = await articulo('T-200');
    await aperturaDe(origenId, [
      { productId: uno.id, cantidad: '10' },
      { productId: otro.id, cantidad: '10' },
    ]);
    await aperturaDe(destinoId, [
      { productId: uno.id, cantidad: '0' },
      { productId: otro.id, cantidad: '0' },
    ]);

    /* Los renglones se cargan en ORDEN INVERSO en cada traslado. */
    const primero = await borradorCon([
      { productId: uno.id, cantidad: '2' },
      { productId: otro.id, cantidad: '3' },
    ]);
    const segundo = await borradorCon([
      { productId: otro.id, cantidad: '1' },
      { productId: uno.id, cantidad: '4' },
    ]);

    const { soltar, tomada } = await tomarLaBarrera([uno.id, otro.id], origenId);
    const carrera = Promise.allSettled([
      despachar(despachador, { trasladoId: primero, confirmado: true }),
      despachar(despachador, { trasladoId: segundo, confirmado: true }),
    ]);
    await esperarDetenidos(2);
    soltar();
    await tomada;
    const resultados = await carrera;

    /* --- Ni un interbloqueo, ni una escritura a medias ------------------ */
    for (const r of resultados) {
      if (r.status === 'rejected') {
        const mensaje = (r.reason as Error).message;
        expect(mensaje, 'ningún interbloqueo').not.toMatch(/deadlock|40P01/i);
        throw new Error(`Un despacho falló sin motivo de negocio: ${mensaje}`);
      }
    }

    const estados = await prisma.stockTransfer.findMany({
      where: { id: { in: [primero, segundo] } },
      select: { status: true },
    });
    expect(estados.every((t) => t.status === 'DESPACHADO'), 'los dos despacharon').toBe(true);

    /* Saldos: 10 − 2 − 4 = 4 y 10 − 3 − 1 = 6, y el libro tiene que coincidir. */
    expect(await saldo(uno.id, origenId)).toBe('4');
    expect(await saldo(otro.id, origenId)).toBe('6');
    for (const p of [uno, otro]) {
      const suma = await prisma.$queryRaw<{ total: string | null }[]>`
        SELECT SUM(CASE WHEN "direction" = 'IN' THEN "quantity" ELSE -"quantity" END)::text AS total
          FROM "stock_ledger" WHERE "productId" = ${p.id} AND "branchId" = ${origenId}`;
      expect(new Decimal(suma[0]?.total ?? '0').toString(), `libro de ${p.internalCode}`).toBe(
        (await saldo(p.id, origenId))!,
      );
    }
    /* Cuatro salidas en total: dos por traslado, ninguna de más ni de menos. */
    expect(await prisma.stockLedger.count({ where: { type: 'TRANSFER_OUT' } })).toBe(4);
  });

  it('11e. el servicio toma los candados en un orden canónico, y eso está en el código', () => {
    /*
     * La prueba de arriba comprueba la CONDUCTA —no hay interbloqueo—, y esta
     * comprueba el MECANISMO que la sostiene: los candados se piden en un orden
     * que no depende de cómo cargó los renglones cada traslado.
     *
     * Van las dos porque cada una tapa un agujero de la otra: sin el orden
     * canónico, el interbloqueo depende de qué transacción alcanzó a tomar su
     * primer candado, y una prueba de conducta podría pasar por suerte. Sin la
     * de conducta, un orden canónico mal implementado pasaría por leerse bien.
     */
    const fuente = readFileSync(
      path.resolve(__dirname, '../../src/lib/services/stock-erp-traslados.ts'),
      'utf8',
    );
    /*
     * Se buscan los `FOR UPDATE` y se mira lo que viene ANTES de cada uno. La
     * primera versión intentaba capturar la declaración con una expresión que
     * cortaba en el primer paréntesis y encontraba cero coincidencias: una
     * afirmación estructural que no encuentra nada no afirma nada, y por suerte
     * falló en vez de pasar en silencio.
     */
    const posiciones = [...fuente.matchAll(/FOR UPDATE/g)].map((m) => m.index ?? 0);
    expect(posiciones.length, 'el despacho y la recepción son los dos que bloquean').toBe(2);
    for (const donde of posiciones) {
      const antes = fuente.slice(Math.max(0, donde - 400), donde);
      expect(antes, 'la lista de artículos se ORDENA antes de bloquear').toContain('.sort()');
      expect(antes, 'y el bloqueo recorre esa lista, no los renglones').toMatch(
        /for \(const pid of productos\)/,
      );
    }
  });
});

/* ========================================================================== *
 * 12 a 16. El despacho, el tránsito y la recepción
 * ========================================================================== */

describe('el despacho saca del origen y el destino no sube hasta recibir', () => {
  it('12. el despacho reduce exactamente el origen', async () => {
    const art = await escenarioSimple('10');
    const id = await borradorCon([{ productId: art.id, cantidad: '2.5' }]);

    const r = await despachar(despachador, { trasladoId: id, confirmado: true });
    expect(r.estado).toBe('DESPACHADO');
    expect(r.movimientos).toBe(1);
    expect(await saldo(art.id, origenId)).toBe('7.5');
  });

  it('13. el despacho no aumenta el destino', async () => {
    const art = await escenarioSimple('10');
    const id = await borradorCon([{ productId: art.id, cantidad: '2.5' }]);
    await despachar(despachador, { trasladoId: id, confirmado: true });

    expect(await saldo(art.id, destinoId), 'el destino no recibió nada todavía').toBe('0');
    expect(await prisma.stockLedger.count({ where: { type: 'TRANSFER_IN' } })).toBe(0);
  });

  it('14. un traslado despachado aparece en tránsito, y no como saldo del destino', async () => {
    const art = await escenarioSimple('10');
    const id = await borradorCon([{ productId: art.id, cantidad: '2.5' }]);
    await despachar(despachador, { trasladoId: id, confirmado: true });

    const transito = await mercaderiaEnTransito({ destinoId });
    expect(transito).toHaveLength(1);
    expect(transito[0]!.cantidad).toBe('2.5');
    expect(transito[0]!.trasladoId).toBe(id);

    const listado = await listadoDeTraslados(preparador, {});
    expect(listado.enTransito.map((f) => f.id)).toContain(id);
    expect(listado.borradores).toHaveLength(0);

    /* Y el tablero del destino sigue diciendo cero, que es la verdad. */
    const tablero = await tableroDeExistencias(receptor, { branchId: destinoId });
    const fila = tablero.filas.find((f) => f.productId === art.id);
    expect(fila?.cantidad).toBe('0');
  });

  it('15. la recepción exacta aumenta el destino', async () => {
    const art = await escenarioSimple('10');
    const id = await borradorCon([{ productId: art.id, cantidad: '2.5' }]);
    await despachar(despachador, { trasladoId: id, confirmado: true });

    const r = await recibir(receptor, { trasladoId: id, confirmado: true });
    expect(r.estado).toBe('RECIBIDO');
    expect(await saldo(art.id, destinoId)).toBe('2.5');

    const t = await prisma.stockTransfer.findUniqueOrThrow({ where: { id } });
    expect(t.receiptOperationId).not.toBeNull();
    expect(t.operationId).not.toBe(t.receiptOperationId);
    expect(await mercaderiaEnTransito({ destinoId })).toHaveLength(0);
  });

  it('16. la recepción no vuelve a reducir el origen', async () => {
    const art = await escenarioSimple('10');
    const id = await borradorCon([{ productId: art.id, cantidad: '2.5' }]);
    await despachar(despachador, { trasladoId: id, confirmado: true });
    expect(await saldo(art.id, origenId)).toBe('7.5');

    await recibir(receptor, { trasladoId: id, confirmado: true });
    expect(await saldo(art.id, origenId), 'el origen ya había bajado: no baja dos veces').toBe('7.5');
    expect(
      await prisma.stockLedger.count({ where: { branchId: origenId, type: 'TRANSFER_OUT' } }),
    ).toBe(1);
  });

  it('17. una recepción con cantidad distinta se bloquea y el traslado sigue en tránsito', async () => {
    const art = await escenarioSimple('10');
    const id = await borradorCon([{ productId: art.id, cantidad: '2.5' }]);
    await despachar(despachador, { trasladoId: id, confirmado: true });
    const linea = (await detalleDeTraslado(receptor, id)).renglones[0]!;

    await expect(
      recibir(receptor, {
        trasladoId: id,
        confirmado: true,
        contado: { [linea.lineaId]: '2' },
      }),
    ).rejects.toThrow(/SIGUE EN TRÁNSITO/);

    const t = await prisma.stockTransfer.findUniqueOrThrow({ where: { id } });
    expect(t.status, 'sigue despachado').toBe('DESPACHADO');
    expect(await saldo(art.id, destinoId), 'el destino no recibió nada').toBe('0');
    expect(await prisma.stockLedger.count({ where: { type: 'TRANSFER_IN' } })).toBe(0);

    /* Ni se inventó una merma ni se ajustó el origen. */
    expect(await saldo(art.id, origenId)).toBe('7.5');
    expect(
      await prisma.stockLedger.count({ where: { type: { in: ['WASTE_OUT', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT'] } } }),
      'no se inventa ninguna merma ni ajuste',
    ).toBe(0);

    const auditoria = await prisma.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.STOCKERP_TRASLADO_DIFERENCIA, entityId: id },
    });
    expect(auditoria, 'la diferencia queda auditada').not.toBeNull();

    /* Y contando lo que de verdad salió, se recibe. */
    await recibir(receptor, {
      trasladoId: id,
      confirmado: true,
      contado: { [linea.lineaId]: '2.5' },
    });
    expect(await saldo(art.id, destinoId)).toBe('2.5');
  });
});

/* ========================================================================== *
 * 18 y 19. Activación del destino y unidades
 * ========================================================================== */

describe('la activación del destino y las unidades', () => {
  it('18. un artículo nuevo en el destino se activa como posterior al corte', async () => {
    const art = await articulo('T-100');
    await aperturaDe(origenId, [{ productId: art.id, cantidad: '10' }]);
    /* En el destino el artículo queda SIN contar: nadie lo tenía. */
    await aperturaDe(destinoId, []);
    await prisma.productStockActivation.deleteMany({
      where: { productId: art.id, branchId: destinoId },
    });

    const id = await borradorCon([{ productId: art.id, cantidad: '3' }]);
    await despachar(despachador, { trasladoId: id, confirmado: true });
    await recibir(receptor, { trasladoId: id, confirmado: true });

    const balance = await prisma.stockBalance.findUniqueOrThrow({
      where: { productId_branchId: { productId: art.id, branchId: destinoId } },
    });
    expect(balance.openingSource, 'nadie lo contó en el destino').toBe('POSTERIOR_AL_CORTE');
    expect(balance.quantity.toString()).toBe('3');

    /*
     * HALLAZGO, y lo encontró la base. La primera versión del servicio marcaba
     * la activación del destino como ACTIVO, y la CHECK
     * `activacion_activo_exige_apertura` de la fase 1 lo rechazó: ACTIVO
     * significa «contado y confirmado, con su corte y su apertura», y este
     * artículo no se contó en el destino. Ponerlo ACTIVO habría sido inventarle
     * una apertura.
     *
     * Lo que queda es lo mismo que hace la recepción de compras: el saldo nace
     * POSTERIOR_AL_CORTE y a la activación no se la toca.
     */
    const activacion = await prisma.productStockActivation.findUnique({
      where: { productId_branchId: { productId: art.id, branchId: destinoId } },
    });
    expect(
      activacion === null || activacion.state !== 'ACTIVO',
      'no se le inventa una apertura al destino',
    ).toBe(true);
    if (activacion) {
      expect(activacion.openingLedgerId, 'sin apertura, porque nadie lo contó').toBeNull();
    }
  });

  it('19. no se reinterpreta la unidad de un renglón ya preparado', async () => {
    const art = await articulo('T-100', 'KG');
    await aperturaDe(origenId, [{ productId: art.id, cantidad: '10' }]);
    await aperturaDe(destinoId, [{ productId: art.id, cantidad: '0' }]);
    const id = await borradorCon([{ productId: art.id, cantidad: '2' }]);

    /* Alguien cambia la unidad aprobada DESPUÉS de preparar el renglón. */
    await prisma.productStockConfig.update({
      where: { productId: art.id },
      data: { stockUnit: 'UNIT' },
    });

    const previa = await detalleDeTraslado(preparador, id);
    expect(previa.renglones[0]!.clase).toBe('BLOQUEADO');
    expect(previa.renglones[0]!.motivo).toMatch(/no se reinterpreta/);
    await expect(despachar(despachador, { trasladoId: id, confirmado: true })).rejects.toThrow(
      /no se puede despachar/,
    );
    expect(await prisma.stockLedger.count({ where: { type: 'TRANSFER_OUT' } })).toBe(0);
  });
});

/* ========================================================================== *
 * 20 a 25. Idempotencia, concurrencia y todo o nada
 * ========================================================================== */

describe('idempotencia y concurrencia', () => {
  it('20. despachar dos veces no duplica', async () => {
    const art = await escenarioSimple('10');
    const id = await borradorCon([{ productId: art.id, cantidad: '2' }]);

    const primero = await despachar(despachador, { trasladoId: id, confirmado: true });
    const segundo = await despachar(despachador, { trasladoId: id, confirmado: true });

    expect(primero.yaEstabaAplicado).toBe(false);
    expect(segundo.yaEstabaAplicado, 'la segunda contesta que ya estaba').toBe(true);
    expect(segundo.operationId).toBe(primero.operationId);
    expect(await saldo(art.id, origenId)).toBe('8');
    expect(await prisma.stockLedger.count({ where: { type: 'TRANSFER_OUT' } })).toBe(1);
  });

  it('21. recibir dos veces no duplica', async () => {
    const art = await escenarioSimple('10');
    const id = await borradorCon([{ productId: art.id, cantidad: '2' }]);
    await despachar(despachador, { trasladoId: id, confirmado: true });

    const primero = await recibir(receptor, { trasladoId: id, confirmado: true });
    const segundo = await recibir(receptor, { trasladoId: id, confirmado: true });

    expect(primero.yaEstabaAplicado).toBe(false);
    expect(segundo.yaEstabaAplicado).toBe(true);
    expect(await saldo(art.id, destinoId)).toBe('2');
    expect(await prisma.stockLedger.count({ where: { type: 'TRANSFER_IN' } })).toBe(1);
  });

  it('22. dos despachos concurrentes permiten uno solo', async () => {
    const art = await escenarioSimple('10');
    const id = await borradorCon([{ productId: art.id, cantidad: '2' }]);

    const [a, b] = await Promise.allSettled([
      despachar(despachador, { trasladoId: id, confirmado: true }),
      despachar(despachador, { trasladoId: id, confirmado: true }),
    ]);

    const aplicaron = [a, b].filter(
      (r) => r.status === 'fulfilled' && r.value.yaEstabaAplicado === false,
    );
    expect(aplicaron, 'exactamente uno escribió').toHaveLength(1);
    expect(await prisma.stockLedger.count({ where: { type: 'TRANSFER_OUT' } })).toBe(1);
    expect(await saldo(art.id, origenId)).toBe('8');
    expect(await prisma.stockOperation.count({ where: { operationKey: claveDeDespacho(id) } })).toBe(1);
  });

  it('23. dos recepciones concurrentes permiten una sola', async () => {
    const art = await escenarioSimple('10');
    const id = await borradorCon([{ productId: art.id, cantidad: '2' }]);
    await despachar(despachador, { trasladoId: id, confirmado: true });

    const [a, b] = await Promise.allSettled([
      recibir(receptor, { trasladoId: id, confirmado: true }),
      recibir(receptor, { trasladoId: id, confirmado: true }),
    ]);

    const aplicaron = [a, b].filter(
      (r) => r.status === 'fulfilled' && r.value.yaEstabaAplicado === false,
    );
    expect(aplicaron).toHaveLength(1);
    expect(await prisma.stockLedger.count({ where: { type: 'TRANSFER_IN' } })).toBe(1);
    expect(await saldo(art.id, destinoId)).toBe('2');
    expect(
      await prisma.stockOperation.count({ where: { operationKey: claveDeRecepcionDeTraslado(id) } }),
    ).toBe(1);
  });

  it('24. la misma clave con otra huella da conflicto, no un falso «ya estaba»', async () => {
    const art = await escenarioSimple('10');
    const id = await borradorCon([{ productId: art.id, cantidad: '2' }]);

    /* Una operación con la clave del despacho pero otro contenido. */
    await prisma.stockOperation.create({
      data: {
        operationKey: claveDeDespacho(id),
        kind: 'TRASLADO',
        hashVersion: VERSION_DE_LA_HUELLA_DE_TRASLADO,
        contentHash: 'huella-de-otra-cosa',
        branchId: origenId,
        requestedById: escenario.admin.id,
      },
    });

    await expect(despachar(despachador, { trasladoId: id, confirmado: true })).rejects.toThrow(
      /contenido distinto/,
    );
    expect(await saldo(art.id, origenId), 'no se escribió nada').toBe('10');
    expect(await prisma.stockLedger.count({ where: { type: 'TRANSFER_OUT' } })).toBe(0);
  });

  it('25. un fallo en el medio revierte toda la transacción', async () => {
    const art = await articulo('T-100');
    const otro = await articulo('T-200');
    await aperturaDe(origenId, [
      { productId: art.id, cantidad: '10' },
      { productId: otro.id, cantidad: '10' },
    ]);
    await aperturaDe(destinoId, [
      { productId: art.id, cantidad: '0' },
      { productId: otro.id, cantidad: '0' },
    ]);
    const id = await borradorCon([
      { productId: art.id, cantidad: '2' },
      { productId: otro.id, cantidad: '3' },
    ]);

    const detalle = await detalleDeTraslado(preparador, id);
    expect(detalle.impedimentos).toEqual([]);
    const lineas = detalle.renglones.map((r) => r.lineaId).sort();

    /*
     * **El fallo se provoca en la BASE, no espiando al cliente.**
     *
     * La clave idempotente de cada movimiento es determinística:
     * `traslado:<id>:despacho:<renglón>`. Se ocupa de antemano la del SEGUNDO
     * renglón con un movimiento ajeno, así que el despacho escribe la salida del
     * primero y revienta contra la unicidad al llegar al segundo. Es un fallo en
     * el medio de la transacción, con la mitad del trabajo ya hecho.
     *
     * Espiar `prisma.stockBalance.findUnique` no servía, y de paso dejó una
     * lección: el cliente de la transacción es otro objeto, así que el espía no
     * se aplicaba adentro, y encima rompía el cliente para las pruebas
     * siguientes. La rotura tiene que ocurrir donde ocurre de verdad.
     */
    const opAjena = await prisma.stockOperation.create({
      data: {
        operationKey: `ajena-${id}`,
        kind: 'ACTIVACION',
        contentHash: 'ajena',
        branchId: origenId,
        requestedById: escenario.admin.id,
      },
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO "stock_ledger"
         ("id","txId","productId","pluHistorico","branchId","type","direction",
          "quantity","unit","effectiveAt","operationId","idempotencyKey","balanceAfterSeq")
       VALUES ($1, txid_current(), $2, 'OCUPADA', $3, 'OPENING_BALANCE'::"StockMovementType",
               'IN'::"StockDirection", 0, 'KG', now(), $4, $5, 0)`,
      `ocupa-${id}`,
      otro.id,
      escenario.sucursales.sanMartin,
      opAjena.id,
      `${claveDeDespacho(id)}:${lineas[1]}`,
    );

    await expect(despachar(despachador, { trasladoId: id, confirmado: true })).rejects.toThrow();

    expect(await saldo(art.id, origenId), 'el primero no quedó descontado').toBe('10');
    expect(await saldo(otro.id, origenId)).toBe('10');
    expect(await prisma.stockLedger.count({ where: { type: 'TRANSFER_OUT' } })).toBe(0);
    const t = await prisma.stockTransfer.findUniqueOrThrow({ where: { id } });
    expect(t.status, 'sigue siendo un borrador').toBe('BORRADOR');
  });
});

/* ========================================================================== *
 * 26 y 27. Inmutabilidad
 * ========================================================================== */

describe('lo que ya pasó no se edita', () => {
  it('26. los renglones quedan inmutables después del despacho', async () => {
    const art = await escenarioSimple('10');
    const id = await borradorCon([{ productId: art.id, cantidad: '2' }]);
    await despachar(despachador, { trasladoId: id, confirmado: true });
    const linea = (await detalleDeTraslado(receptor, id)).renglones[0]!;

    await expect(
      modificarRenglon(preparador, { lineaId: linea.lineaId, cantidad: '5' }),
    ).rejects.toThrow(/ya no se edita/);
    await expect(retirarRenglon(preparador, { lineaId: linea.lineaId })).rejects.toThrow(
      /ya no se edita/,
    );

    /* Y la base lo rechaza aunque alguien entre por SQL. */
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "stock_transfer_line" SET "quantity" = 5 WHERE id = $1`,
        linea.lineaId,
      ),
      /*
       * Cualquiera de las dos defensas alcanza, y de hecho gana la CHECK:
       * cambiar la cantidad preparada la deja distinta de la despachada, que es
       * lo que `traslado_renglon_despacha_lo_preparado` no admite. El disparador
       * de inmutabilidad está detrás para todo lo demás.
       */
    ).rejects.toThrow(/no se edita|despacha_lo_preparado|recepcion_exacta/);
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM "stock_transfer_line" WHERE id = $1`, linea.lineaId),
      /*
       * Acá gana una defensa que no es la de esta fase, y conviene dejarlo
       * escrito: borrar el renglón obligaría a poner en nulo el `transferLineId`
       * del movimiento que salió de él, y el libro es INMUTABLE, así que el
       * disparador de la fase 1 lo rechaza antes. Dos capas que dicen lo mismo
       * desde ángulos distintos: el renglón despachado no se va a ninguna parte.
       */
    ).rejects.toThrow(/no se borran|inmutable/i);
  });

  it('27. un traslado cerrado no se edita ni se cancela', async () => {
    const art = await escenarioSimple('10');
    const id = await borradorCon([{ productId: art.id, cantidad: '2' }]);
    await despachar(despachador, { trasladoId: id, confirmado: true });
    await recibir(receptor, { trasladoId: id, confirmado: true });

    await expect(
      cancelarBorrador(preparador, { trasladoId: id, motivo: 'me arrepentí' }),
    ).rejects.toThrow(/ya no se edita/);
    await expect(
      agregarRenglon(preparador, { trasladoId: id, productId: art.id, cantidad: '1' }),
    ).rejects.toThrow(/ya no se edita/);

    /* Ni volver atrás por SQL: los estados terminales son definitivos. */
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "stock_transfer" SET "status" = 'BORRADOR'::"StockTransferStatus" WHERE id = $1`,
        id,
      ),
      /*
       * Gana la CHECK `traslado_borrador_sin_efectos`: un borrador no puede
       * llevar operaciones, y este traslado tiene dos. El disparador de
       * transiciones dice lo mismo con otras palabras y queda detrás.
       */
    ).rejects.toThrow(/definitivo|borrador_sin_efectos/);
  });
});

/* ========================================================================== *
 * 28 a 31. El libro y el saldo
 * ========================================================================== */

describe('el libro guarda las dos mitades y el saldo las sigue', () => {
  it('28. el libro conserva la salida y la entrada por separado', async () => {
    const art = await escenarioSimple('10');
    const id = await borradorCon([{ productId: art.id, cantidad: '2' }]);
    await despachar(despachador, { trasladoId: id, confirmado: true });
    await recibir(receptor, { trasladoId: id, confirmado: true });

    const movs = await prisma.stockLedger.findMany({
      where: { type: { in: ['TRANSFER_OUT', 'TRANSFER_IN'] } },
      orderBy: { seq: 'asc' },
    });
    expect(movs).toHaveLength(2);
    expect(movs[0]!.type).toBe('TRANSFER_OUT');
    expect(movs[0]!.direction).toBe('OUT');
    expect(movs[0]!.branchId).toBe(origenId);
    expect(movs[1]!.type).toBe('TRANSFER_IN');
    expect(movs[1]!.direction).toBe('IN');
    expect(movs[1]!.branchId).toBe(destinoId);
    /* Dos operaciones distintas: dos hechos físicos. */
    expect(movs[0]!.operationId).not.toBe(movs[1]!.operationId);
    /* Y dos momentos efectivos, cada uno decidido por el servidor. */
    expect(movs[1]!.effectiveAt.getTime()).toBeGreaterThanOrEqual(movs[0]!.effectiveAt.getTime());
  });

  it('29. cada movimiento referencia su renglón de traslado', async () => {
    const art = await articulo('T-100');
    const otro = await articulo('T-200');
    await aperturaDe(origenId, [
      { productId: art.id, cantidad: '10' },
      { productId: otro.id, cantidad: '10' },
    ]);
    await aperturaDe(destinoId, [
      { productId: art.id, cantidad: '0' },
      { productId: otro.id, cantidad: '0' },
    ]);
    const id = await borradorCon([
      { productId: art.id, cantidad: '2' },
      { productId: otro.id, cantidad: '3' },
    ]);
    await despachar(despachador, { trasladoId: id, confirmado: true });
    await recibir(receptor, { trasladoId: id, confirmado: true });

    const movs = await prisma.stockLedger.findMany({
      where: { type: { in: ['TRANSFER_OUT', 'TRANSFER_IN'] } },
      include: { transferLine: true },
    });
    expect(movs).toHaveLength(4);
    for (const m of movs) {
      expect(m.transferLineId, 'ningún movimiento de traslado sin renglón').not.toBeNull();
      expect(m.transferLine?.transferId).toBe(id);
      expect(m.transferLine?.productId).toBe(m.productId);
    }
  });

  it('30. StockBalance coincide con la suma del libro en las dos sucursales', async () => {
    const art = await escenarioSimple('10');
    const id = await borradorCon([{ productId: art.id, cantidad: '2.5' }]);
    await despachar(despachador, { trasladoId: id, confirmado: true });
    await recibir(receptor, { trasladoId: id, confirmado: true });

    for (const branchId of [origenId, destinoId]) {
      const suma = await prisma.$queryRaw<{ total: string | null }[]>`
        SELECT SUM(CASE WHEN "direction" = 'IN' THEN "quantity" ELSE -"quantity" END)::text AS total
          FROM "stock_ledger" WHERE "productId" = ${art.id} AND "branchId" = ${branchId}`;
      const enLibro = new Decimal(suma[0]?.total ?? '0');
      const enSaldo = new Decimal((await saldo(art.id, branchId)) ?? '0');
      expect(enSaldo.equals(enLibro), `${branchId}: saldo ${enSaldo} vs libro ${enLibro}`).toBe(true);
    }
  });

  it('31. balanceAfterSeq sigue el orden de registración', async () => {
    const art = await escenarioSimple('10');
    const uno = await borradorCon([{ productId: art.id, cantidad: '2' }]);
    await despachar(despachador, { trasladoId: uno, confirmado: true });
    const dos = await borradorCon([{ productId: art.id, cantidad: '3' }]);
    await despachar(despachador, { trasladoId: dos, confirmado: true });

    const salidas = await prisma.stockLedger.findMany({
      where: { productId: art.id, branchId: origenId, type: 'TRANSFER_OUT' },
      orderBy: { seq: 'asc' },
    });
    expect(salidas.map((m) => m.balanceAfterSeq.toString())).toEqual(['8', '5']);
    expect(await saldo(art.id, origenId)).toBe('5');
  });
});

/* ========================================================================== *
 * 32 a 35. Permisos e interruptor
 * ========================================================================== */

describe('permisos e interruptor', () => {
  it('32. el permiso de preparar no deja despachar ni recibir', async () => {
    const art = await escenarioSimple('10');
    const id = await borradorCon([{ productId: art.id, cantidad: '2' }]);

    await expect(despachar(preparador, { trasladoId: id, confirmado: true })).rejects.toThrow(
      /stockerp\.traslado\.despachar/,
    );
    await expect(recibir(preparador, { trasladoId: id, confirmado: true })).rejects.toThrow(
      /stockerp\.traslado\.recibir/,
    );
    expect(await saldo(art.id, origenId)).toBe('10');

    /* Y el rechazo queda auditado, con el permiso que faltaba. */
    const rechazos = await prisma.auditLog.findMany({
      where: { action: AUDIT_ACTIONS.STOCKERP_INTENTO_RECHAZADO, entityId: id },
    });
    expect(rechazos.length).toBeGreaterThanOrEqual(2);
  });

  it('33. los permisos sensibles de traslado no llegan al rol administrador', async () => {
    for (const permiso of [
      PERMISSIONS.STOCKERP_TRASLADO_DESPACHAR,
      PERMISSIONS.STOCKERP_TRASLADO_RECIBIR,
    ]) {
      expect(PERMISOS_SENSIBLES_DE_STOCK_ERP, permiso).toContain(permiso);
      expect(ADMIN_PERMISSIONS, permiso).not.toContain(permiso);
    }
    /* Preparar sí, porque no escribe el libro. */
    expect(ADMIN_PERMISSIONS).toContain(PERMISSIONS.STOCKERP_TRASLADO_PREPARAR);

    /* Y un rol que ya existía no los recibe por resembrar. */
    const rol = await prisma.role.findFirstOrThrow({ where: { code: 'OPERADOR' } });
    expect(rol.permissions).not.toContain(PERMISSIONS.STOCKERP_TRASLADO_DESPACHAR);
    expect(rol.permissions).not.toContain(PERMISSIONS.STOCKERP_TRASLADO_RECIBIR);
  });

  it('34. el interruptor de traslados reales nace apagado', async () => {
    const estado = await interruptorDeTrasladosReales();
    expect(estado.encendido).toBe(false);
    expect(estado.cambiadoPor).toBeNull();
    expect(estado.motivo).toBeNull();

    const columna = await prisma.$queryRaw<{ column_default: string }[]>`
      SELECT column_default FROM information_schema.columns
       WHERE table_name = 'stock_module_setting' AND column_name = 'realTransfersEnabled'`;
    expect(columna[0]!.column_default).toMatch(/false/);

    /* Y encenderlo exige permiso y motivo. */
    await expect(
      cambiarInterruptorDeTraslados(preparador, { encender: true, motivo: 'porque sí' }),
    ).rejects.toThrow(/stockerp\.modulo\.configurar/);
    await expect(
      cambiarInterruptorDeTraslados(jefeDeModulo, { encender: true, motivo: '   ' }),
    ).rejects.toThrow(/escribir por qué/);
    expect((await interruptorDeTrasladosReales()).encendido).toBe(false);
  });

  it('35. ningún archivo decide el estado del interruptor mirando el entorno', async () => {
    /*
     * La misma comprobación que protege a los otros dos interruptores: un
     * servicio que leyera `process.env` para decidir si los traslados reales
     * están habilitados convertiría una decisión auditada en una variable de
     * despliegue.
     */
    const raiz = path.resolve(__dirname, '../../src');
    const archivos: string[] = [];
    const recorrer = (dir: string) => {
      for (const nombre of readdirSync(dir)) {
        const completo = path.join(dir, nombre);
        if (statSync(completo).isDirectory()) recorrer(completo);
        else if (/\.tsx?$/.test(nombre)) archivos.push(completo);
      }
    };
    recorrer(raiz);

    for (const archivo of archivos) {
      const fuente = readFileSync(archivo, 'utf8');
      const lineas = fuente.split('\n');
      for (const [i, linea] of lineas.entries()) {
        if (!/realTransfersEnabled/.test(linea)) continue;
        expect(
          /process\.env/.test(linea),
          `${path.relative(raiz, archivo)}:${i + 1} decide el interruptor con una variable de entorno`,
        ).toBe(false);
      }
    }

    /* Y la base rechaza encenderlo sin autor ni motivo. */
    const fila = await prisma.stockModuleSetting.findFirstOrThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "stock_module_setting" SET "realTransfersEnabled" = true WHERE id = $1`,
        fila.id,
      ),
    ).rejects.toThrow();
  });
});

/* ========================================================================== *
 * 36 a 39. Nada se despierta, y la fase 5 lo muestra
 * ========================================================================== */

describe('los traslados no despiertan nada de afuera', () => {
  it('36. no se escribe una sola fila en StockOutbox', async () => {
    const art = await escenarioSimple('10');
    const id = await borradorCon([{ productId: art.id, cantidad: '2' }]);
    await despachar(despachador, { trasladoId: id, confirmado: true });
    await recibir(receptor, { trasladoId: id, confirmado: true });

    expect(await prisma.stockOutbox.count()).toBe(0);
  });

  it('37. ningún camino del traslado hace HTTP', async () => {
    const llamadas: string[] = [];
    const espia = vi.spyOn(globalThis, 'fetch').mockImplementation((entrada: unknown) => {
      llamadas.push(String(entrada));
      throw new Error('ninguna prueba de traslados debería salir a la red');
    });

    const art = await escenarioSimple('10');
    const id = await borradorCon([{ productId: art.id, cantidad: '2' }]);
    await despachar(despachador, { trasladoId: id, confirmado: true });
    await recibir(receptor, { trasladoId: id, confirmado: true });
    await detalleDeTraslado(receptor, id);
    await listadoDeTraslados(receptor, {});
    await mercaderiaEnTransito({ destinoId });

    expect(llamadas, 'nadie salió a la red').toEqual([]);
    espia.mockRestore();
  });

  it('38. el servicio de traslados no nombra el transporte externo', () => {
    const fuente = readFileSync(
      path.resolve(__dirname, '../../src/lib/services/stock-erp-traslados.ts'),
      'utf8',
    );
    for (const prohibido of [
      'stockOutbox',
      'STOCK_INTEGRATION',
      'stock-transporte-http',
      'stock-despacho-manual',
      'fetch(',
    ]) {
      expect(fuente, `el servicio no debería nombrar ${prohibido}`).not.toContain(prohibido);
    }
  });

  it('39. las consultas de la fase 5 muestran el traslado en el libro y en los saldos', async () => {
    const art = await escenarioSimple('10');
    const id = await borradorCon([{ productId: art.id, cantidad: '2.5' }]);
    await despachar(despachador, { trasladoId: id, confirmado: true });

    /* En tránsito: el origen ya bajó, el destino sigue en cero confirmado. */
    const tableroOrigen = await tableroDeExistencias(receptor, { branchId: origenId });
    expect(tableroOrigen.filas.find((f) => f.productId === art.id)?.cantidad).toBe('7.5');
    const tableroDestino = await tableroDeExistencias(receptor, { branchId: destinoId });
    expect(tableroDestino.filas.find((f) => f.productId === art.id)?.cantidad).toBe('0');

    const libro = await movimientosDelLibro(receptor, { branchId: origenId });
    const salida = libro.movimientos.find((m) => m.type === 'TRANSFER_OUT');
    expect(salida, 'la salida aparece en el historial').toBeDefined();
    expect(salida!.cantidad).toBe('2.5');
    expect(salida!.trasladoId, 'el movimiento apunta a su traslado').toBe(id);
    expect(salida!.transferLineId, 'y a su renglón').not.toBeNull();

    await recibir(receptor, { trasladoId: id, confirmado: true });
    const libroDestino = await movimientosDelLibro(receptor, { branchId: destinoId });
    expect(libroDestino.movimientos.some((m) => m.type === 'TRANSFER_IN')).toBe(true);
  });

  it('40. las garantías de las fases anteriores siguen vivas', async () => {
    /*
     * Esta fase reemplazó un disparador de la fase 1 y agregó columnas a tablas
     * que usan las fases 3, 4 y 5. Lo que se comprueba acá es que las reglas
     * viejas siguen rechazando lo que rechazaban: el libro sigue siendo
     * inmutable, el saldo sigue necesitando su movimiento y una apertura no se
     * reabre.
     */
    const art = await escenarioSimple('10');

    const mov = await prisma.stockLedger.findFirstOrThrow({ where: { type: 'OPENING_BALANCE' } });
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "stock_ledger" SET "quantity" = 99 WHERE id = $1`, mov.id),
    ).rejects.toThrow(/inmutable/i);
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM "stock_ledger" WHERE id = $1`, mov.id),
    ).rejects.toThrow(/inmutable/i);

    const balance = await prisma.stockBalance.findFirstOrThrow({
      where: { productId: art.id, branchId: origenId },
    });
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "stock_balance" SET "quantity" = 42 WHERE id = $1`,
        balance.id,
      ),
      'el saldo no se mueve sin un movimiento de la misma transacción',
    ).rejects.toThrow();

    /* Y una segunda apertura de la misma sucursal sigue siendo imposible. */
    await expect(
      prepararApertura(preparador, { branchId: origenId, ficticia: true }),
    ).rejects.toThrow();
  });
});
