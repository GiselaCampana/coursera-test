import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db';
import { limpiarBase, sembrarEscenario, comoUsuario, type Escenario } from './ayudas';
import {
  registrarMerma,
  vistaPreviaDeMerma,
  mermasRegistradas,
  articulosCorregiblesPorSucursal,
  abrirRecuento,
  guardarCantidadFisica,
  verRecuento,
  confirmarLineaDeRecuento,
  cerrarRecuento,
  operacionReversible,
  operacionesReversibles,
  revertirOperacion,
  interruptorDeCorreccionesReales,
  cambiarInterruptorDeCorrecciones,
  claveDeMerma,
  claveDeReversion,
  CATEGORIAS_DE_MERMA,
} from '@/lib/services/stock-erp-correcciones';
import {
  crearBorrador,
  agregarRenglon,
  despachar,
  recibir,
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
 * **Stock ERP, fase 7: mermas, recuentos correctivos y reversiones acotadas.**
 *
 * Las tres afirmaciones que sostienen el archivo:
 *
 *  1. **No existe una entrada o salida manual genérica.** Cada corrección tiene
 *     forma, causa y explicación: una merma dice por qué se perdió, un recuento
 *     dice qué se contó, una reversión dice qué deshace.
 *  2. **El delta lo calcula el servidor.** La persona escribe la cantidad
 *     FÍSICA; el navegador no puede mandar una diferencia, y si la mandara no se
 *     podría guardar: una CHECK de la base exige que la diferencia sea
 *     contada − esperada.
 *  3. **Una reversión agrega asientos inversos y nunca edita el libro**, y sólo
 *     para lo que esta fase declara reversible.
 *
 * Todo con artículos y sucursales inventados, aperturas ficticias, interruptor
 * apagado, sin red y sin tocar Control de Stock.
 */

let escenario: Escenario;
/** Cuenta y prepara. Nada sensible. */
let contador: ReturnType<typeof comoUsuario>;
/** Además registra mermas. */
let mermador: ReturnType<typeof comoUsuario>;
/** Además confirma ajustes. */
let ajustador: ReturnType<typeof comoUsuario>;
/** Además revierte. */
let reversor: ReturnType<typeof comoUsuario>;
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
  PERMISSIONS.STOCKERP_RECUENTO_PREPARAR,
];

let sucursalId = '';
let otraSucursalId = '';
/** Contador para identificadores de merma estables dentro de una prueba. */
let n = 0;
const proximaMerma = () => `merma-prueba-${Date.now()}-${(n += 1)}`;

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();
  contador = con(BASE_DE_APERTURA);
  mermador = con([...BASE_DE_APERTURA, PERMISSIONS.STOCKERP_MERMA]);
  ajustador = con([...BASE_DE_APERTURA, PERMISSIONS.STOCKERP_MERMA, PERMISSIONS.STOCKERP_AJUSTE]);
  reversor = con([
    ...BASE_DE_APERTURA,
    PERMISSIONS.STOCKERP_MERMA,
    PERMISSIONS.STOCKERP_AJUSTE,
    PERMISSIONS.STOCKERP_REVERSAR,
    PERMISSIONS.STOCKERP_TRASLADO_PREPARAR,
    PERMISSIONS.STOCKERP_TRASLADO_DESPACHAR,
    PERMISSIONS.STOCKERP_TRASLADO_RECIBIR,
  ]);
  jefeDeModulo = con([PERMISSIONS.STOCKERP_MODULO_CONFIGURAR]);
  sucursalId = escenario.sucursales.devoto;
  otraSucursalId = escenario.sucursales.pueyrredon;
});

afterEach(() => vi.restoreAllMocks());

/* ========================================================================== *
 * Ayudas
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
    await aprobarUnidadDeExistencia(contador, { productId: p.id, unidad, confirmado: true });
  }
  return p;
}

async function aperturaDe(branchId: string, contar: { productId: string; cantidad: string }[] = []) {
  const ap = await prepararApertura(contador, { branchId, ficticia: true });
  const vista = await verApertura(contador, ap.sessionId);
  const aContar = new Map(contar.map((c) => [c.productId, c.cantidad]));
  for (const l of vista.lineas) {
    const cantidad = aContar.get(l.productId);
    if (cantidad !== undefined) {
      if (new Decimal(cantidad).isZero()) await contarEnCero(contador, l.activationId);
      else await guardarConteo(contador, { activationId: l.activationId, cantidad });
    } else if (l.estado !== 'NO_SE_MANEJA') {
      await marcarNoSeManeja(contador, {
        activationId: l.activationId,
        motivo: 'Esta sucursal no trabaja este artículo.',
      });
    }
  }
  await fijarCorte(contador, { sessionId: ap.sessionId, ...CORTE });
  const lista = await verApertura(contador, ap.sessionId);
  await confirmarApertura(contador, {
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

async function saldo(productId: string, branchId: string): Promise<string | null> {
  const fila = await prisma.stockBalance.findUnique({
    where: { productId_branchId: { productId, branchId } },
  });
  return fila ? fila.quantity.toString() : null;
}

/** Un artículo con 10 en Devoto, listo para corregir. */
async function escenarioSimple(cantidad = '10') {
  const art = await articulo('C-100');
  await aperturaDe(sucursalId, [{ productId: art.id, cantidad }]);
  return art;
}

/** Una merma ya registrada, para tener qué revertir. */
async function mermaDe(art: { id: string }, cantidad = '2') {
  const mermaId = proximaMerma();
  const r = await registrarMerma(mermador, {
    mermaId,
    branchId: sucursalId,
    productId: art.id,
    cantidad,
    categoria: 'ROTURA',
    motivo: 'Se cayó una horma',
    confirmado: true,
  });
  return { mermaId, operationId: r.operationId };
}

/* ========================================================================== *
 * 1 a 8. La merma
 * ========================================================================== */

describe('la merma sale con su causa', () => {
  it('1. la merma reduce exactamente el saldo', async () => {
    const art = await escenarioSimple('10');
    const r = await registrarMerma(mermador, {
      mermaId: proximaMerma(),
      branchId: sucursalId,
      productId: art.id,
      cantidad: '2.5',
      categoria: 'VENCIMIENTO',
      motivo: 'Tres hormas vencidas el lunes',
      confirmado: true,
    });
    expect(r.movimientos).toBe(1);
    expect(await saldo(art.id, sucursalId)).toBe('7.5');

    const mov = await prisma.stockLedger.findFirstOrThrow({ where: { type: 'WASTE_OUT' } });
    expect(mov.direction).toBe('OUT');
    expect(mov.quantity.toString()).toBe('2.5');
    expect(mov.balanceAfterSeq.toString()).toBe('7.5');
    /* Y el consumo interno NO es una merma: va con su propio tipo. */
    const interno = await registrarMerma(mermador, {
      mermaId: proximaMerma(),
      branchId: sucursalId,
      productId: art.id,
      cantidad: '1',
      categoria: 'CONSUMO_INTERNO',
      motivo: 'Degustación para el mostrador',
      confirmado: true,
    });
    expect(interno.movimientos).toBe(1);
    expect(await prisma.stockLedger.count({ where: { type: 'INTERNAL_USE_OUT' } })).toBe(1);
    expect(await saldo(art.id, sucursalId)).toBe('6.5');
  });

  it('2. una merma mayor que el saldo no escribe nada', async () => {
    const art = await escenarioSimple('2');
    await expect(
      registrarMerma(mermador, {
        mermaId: proximaMerma(),
        branchId: sucursalId,
        productId: art.id,
        cantidad: '5',
        categoria: 'ROTURA',
        motivo: 'Se rompió el cajón entero',
        confirmado: true,
      }),
    ).rejects.toThrow(/no puede quedar negativo/);

    expect(await saldo(art.id, sucursalId)).toBe('2');
    expect(await prisma.stockLedger.count({ where: { type: 'WASTE_OUT' } })).toBe(0);
    expect(await prisma.stockWaste.count()).toBe(0);
    expect(await prisma.stockOperation.count({ where: { kind: 'AJUSTE' } })).toBe(0);

    const auditoria = await prisma.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.STOCKERP_CORRECCION_SIN_SALDO },
    });
    expect(auditoria, 'el bloqueo por saldo queda auditado').not.toBeNull();
  });

  it('3. cantidad cero o negativa se rechaza', async () => {
    const art = await escenarioSimple();
    for (const mala of ['0', '-1', '0.000']) {
      await expect(
        registrarMerma(mermador, {
          mermaId: proximaMerma(),
          branchId: sucursalId,
          productId: art.id,
          cantidad: mala,
          categoria: 'ROTURA',
          motivo: 'Prueba de cantidad',
          confirmado: true,
        }),
        mala,
      ).rejects.toThrow(/mayor que cero|no puede ser negativa/);
    }
    /* Y más decimales de los que el libro guarda, tampoco. */
    await expect(
      registrarMerma(mermador, {
        mermaId: proximaMerma(),
        branchId: sucursalId,
        productId: art.id,
        cantidad: '1.2345',
        categoria: 'ROTURA',
        motivo: 'Prueba de escala',
        confirmado: true,
      }),
    ).rejects.toThrow(/tres decimales/);
    expect(await prisma.stockWaste.count()).toBe(0);
  });

  it('4. una unidad incompatible se rechaza', async () => {
    const art = await articulo('C-100', 'KG');
    await aperturaDe(sucursalId, [{ productId: art.id, cantidad: '10' }]);
    /* Alguien cambia la unidad aprobada después de que el saldo nació en KG. */
    await prisma.productStockConfig.update({
      where: { productId: art.id },
      data: { stockUnit: 'UNIT' },
    });

    await expect(
      registrarMerma(mermador, {
        mermaId: proximaMerma(),
        branchId: sucursalId,
        productId: art.id,
        cantidad: '1',
        categoria: 'ROTURA',
        motivo: 'Prueba de unidad',
        confirmado: true,
      }),
    ).rejects.toThrow(/unidades incompatibles/);
    expect(await saldo(art.id, sucursalId)).toBe('10');
  });

  it('5. un artículo que la sucursal no maneja se bloquea', async () => {
    const art = await articulo('C-100');
    const otro = await articulo('C-200');
    /* Sólo el primero se cuenta: el segundo queda NO_SE_MANEJA. */
    await aperturaDe(sucursalId, [{ productId: art.id, cantidad: '10' }]);

    await expect(
      registrarMerma(mermador, {
        mermaId: proximaMerma(),
        branchId: sucursalId,
        productId: otro.id,
        cantidad: '1',
        categoria: 'ROTURA',
        motivo: 'Prueba de artículo no manejado',
        confirmado: true,
      }),
    ).rejects.toThrow(/no maneja este artículo/);
    expect(await prisma.stockLedger.count({ where: { type: 'WASTE_OUT' } })).toBe(0);
  });

  it('5b. la lista que se ofrece trae sólo lo que la sucursal maneja, con unidad aprobada', async () => {
    /*
     * El pendiente de la fase 7: la pantalla ofrecía el catálogo entero con
     * unidad aprobada, sin mirar si la sucursal elegida manejaba el artículo. El
     * servidor lo rechazaba —lo comprueba la prueba 5, que sigue arriba—, pero
     * ofrecer algo que se va a rechazar hace que la regla se descubra a fuerza
     * de errores.
     *
     * Esta prueba mira la lista. La de arriba mira la defensa. Van las dos:
     * filtrar la lista no autoriza a aflojar el servidor.
     */
    const manejado = await articulo('C-100');
    const noManejado = await articulo('C-200');
    const sinUnidad = await prisma.product.create({
      data: {
        internalCode: 'C-300',
        normalizedName: 'Artículo sin unidad decidida',
        category: 'Pruebas',
        purchaseUnit: 'KG',
        saleMode: 'AL_CORTE',
        targetMarginPct: '0.40',
        marginBasis: 'SOBRE_COSTO',
        cashDiscountPct: '0',
        roundingRule: 'NEAREST_100',
      },
    });
    await aperturaDe(sucursalId, [{ productId: manejado.id, cantidad: '10' }]);

    const porSucursal = await articulosCorregiblesPorSucursal(contador);
    const ofrecidos = (porSucursal[sucursalId] ?? []).map((a) => a.id);

    expect(ofrecidos, 'lo que la sucursal maneja sí').toContain(manejado.id);
    expect(ofrecidos, 'lo que no maneja, no').not.toContain(noManejado.id);
    expect(ofrecidos, 'y lo que no tiene unidad aprobada tampoco').not.toContain(sinUnidad.id);
    expect(porSucursal[sucursalId]![0]!.unidad, 'la unidad viaja con el artículo').toBe('KG');

    /* Una sucursal sin apertura confirmada no ofrece nada: su saldo está sin contar. */
    expect(porSucursal[otraSucursalId], 'sin apertura no hay nada que corregir').toBeUndefined();
  });

  it('6. una sucursal sin apertura confirmada se bloquea', async () => {
    const art = await escenarioSimple('10');
    /* La otra sucursal nunca inauguró. */
    await expect(
      registrarMerma(mermador, {
        mermaId: proximaMerma(),
        branchId: otraSucursalId,
        productId: art.id,
        cantidad: '1',
        categoria: 'ROTURA',
        motivo: 'Prueba sin apertura',
        confirmado: true,
      }),
    ).rejects.toThrow(/apertura confirmada/);
    expect(await prisma.stockLedger.count({ where: { type: 'WASTE_OUT' } })).toBe(0);
  });

  it('7. el motivo es obligatorio, y la doble confirmación también', async () => {
    const art = await escenarioSimple();
    for (const motivo of ['', '   ', 'ok']) {
      await expect(
        registrarMerma(mermador, {
          mermaId: proximaMerma(),
          branchId: sucursalId,
          productId: art.id,
          cantidad: '1',
          categoria: 'ROTURA',
          motivo,
          confirmado: true,
        }),
        `motivo «${motivo}»`,
      ).rejects.toThrow(/motivo escrito/);
    }
    await expect(
      registrarMerma(mermador, {
        mermaId: proximaMerma(),
        branchId: sucursalId,
        productId: art.id,
        cantidad: '1',
        categoria: 'ROTURA',
        motivo: 'Se rompió una horma',
        confirmado: false,
      }),
    ).rejects.toThrow(/segunda confirmación/);
    expect(await prisma.stockWaste.count()).toBe(0);

    /* Y la base rechaza un motivo vacío aunque alguien entre por SQL. */
    const op = await prisma.stockOperation.create({
      data: {
        operationKey: 'merma-sql',
        kind: 'AJUSTE',
        contentHash: 'x',
        branchId: sucursalId,
        requestedById: escenario.admin.id,
      },
    });
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "stock_waste" ("id","branchId","productId","quantity","unit","category","reason","operationId","occurredAt","createdAt")
         VALUES ('m-sql',$1,$2,1,'KG','ROTURA'::"StockWasteCategory",'  ',$3,now(),now())`,
        sucursalId,
        art.id,
        op.id,
      ),
    ).rejects.toThrow(/merma_motivo_escrito/);
  });

  it('8. la categoría OTRO exige detalle', async () => {
    const art = await escenarioSimple();
    await expect(
      registrarMerma(mermador, {
        mermaId: proximaMerma(),
        branchId: sucursalId,
        productId: art.id,
        cantidad: '1',
        categoria: 'OTRO',
        motivo: 'Algo raro pasó',
        confirmado: true,
      }),
    ).rejects.toThrow(/exige detalle/);

    /* Con detalle sí entra. */
    const r = await registrarMerma(mermador, {
      mermaId: proximaMerma(),
      branchId: sucursalId,
      productId: art.id,
      cantidad: '1',
      categoria: 'OTRO',
      motivo: 'Algo raro pasó',
      detalle: 'Un cliente lo abrió en el salón y no se pudo vender',
      confirmado: true,
    });
    expect(r.movimientos).toBe(1);
    const guardada = await prisma.stockWaste.findFirstOrThrow({ where: { category: 'OTRO' } });
    expect(guardada.detail).toMatch(/lo abrió en el salón/);

    /* Y las ocho categorías están declaradas. */
    expect(CATEGORIAS_DE_MERMA).toHaveLength(8);
  });
});

/* ========================================================================== *
 * 9 a 11. Idempotencia y carreras de la merma
 * ========================================================================== */

describe('la merma no se duplica ni deja saldo negativo', () => {
  /**
   * La barrera de la carrera, igual que en la suite de traslados.
   *
   * Está duplicada a propósito y no extraída a las ayudas comunes: la de
   * traslados quedó verificada y documentada en su lugar, y mover código de
   * prueba que ya está probado para ahorrar treinta líneas es cambiar riesgo por
   * prolijidad. Si aparece una tercera, se extrae.
   */
  let barrera: PrismaClient;
  beforeEach(() => {
    barrera = new PrismaClient();
  });
  afterEach(async () => {
    await barrera.$disconnect();
  });

  async function esperarDetenidos(cuantos: number) {
    for (let intento = 0; intento < 200; intento += 1) {
      const filas = await barrera.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock' AND state = 'active'`;
      if (Number(filas[0]!.n) >= cuantos) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(
      `No se llegó al punto de carrera: nunca hubo ${cuantos} procesos esperando el candado.`,
    );
  }

  async function tomarLaBarrera(productId: string, branchId: string) {
    let soltar = () => {};
    const suelta = new Promise<void>((res) => {
      soltar = res;
    });
    let avisar = () => {};
    const tomadaDeVerdad = new Promise<void>((res) => {
      avisar = res;
    });
    const tomada = barrera.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          SELECT id FROM "stock_balance"
           WHERE "productId" = ${productId} AND "branchId" = ${branchId} FOR UPDATE`;
        avisar();
        await suelta;
      },
      { timeout: 60_000 },
    );
    await tomadaDeVerdad;
    return { soltar: () => soltar(), tomada };
  }

  it('9. registrar la misma merma dos veces no duplica', async () => {
    const art = await escenarioSimple('10');
    const mermaId = proximaMerma();
    const entrada = {
      mermaId,
      branchId: sucursalId,
      productId: art.id,
      cantidad: '2',
      categoria: 'ROTURA' as const,
      motivo: 'Se cayó del estante',
      confirmado: true,
    };

    const primero = await registrarMerma(mermador, entrada);
    const segundo = await registrarMerma(mermador, entrada);

    expect(primero.yaEstabaAplicada).toBe(false);
    expect(segundo.yaEstabaAplicada, 'la segunda contesta lo guardado').toBe(true);
    expect(segundo.operationId).toBe(primero.operationId);
    expect(await saldo(art.id, sucursalId)).toBe('8');
    expect(await prisma.stockLedger.count({ where: { type: 'WASTE_OUT' } })).toBe(1);
    expect(await prisma.stockWaste.count()).toBe(1);
    expect(
      await prisma.auditLog.count({ where: { action: AUDIT_ACTIONS.STOCKERP_CORRECCION_DUPLICADA } }),
      'el intento duplicado queda auditado',
    ).toBe(1);
  });

  it('10. dos mermas concurrentes de 7 sobre 10: una pasa, la otra recibe el error de negocio', async () => {
    const art = await escenarioSimple('10');
    const entrada = (id: string) => ({
      mermaId: id,
      branchId: sucursalId,
      productId: art.id,
      cantidad: '7',
      categoria: 'FALTANTE' as const,
      motivo: 'Faltaba al cerrar el turno',
      confirmado: true,
    });
    const una = proximaMerma();
    const otra = proximaMerma();

    /* Las dos parecen posibles antes de competir. */
    for (const id of [una, otra]) {
      const previa = await vistaPreviaDeMerma(mermador, entrada(id));
      expect(previa.impedimentos, `${id} sin impedimentos`).toEqual([]);
    }

    const { soltar, tomada } = await tomarLaBarrera(art.id, sucursalId);
    const carrera = Promise.allSettled([
      registrarMerma(mermador, entrada(una)),
      registrarMerma(mermador, entrada(otra)),
    ]);
    await esperarDetenidos(2);
    soltar();
    await tomada;
    const [a, b] = await carrera;

    const ganadores = [a, b].filter((r) => r.status === 'fulfilled');
    const perdedores = [a, b].filter((r) => r.status === 'rejected');
    expect(ganadores, 'exactamente una se registró').toHaveLength(1);
    expect(perdedores).toHaveLength(1);

    const error = (perdedores[0] as PromiseRejectedResult).reason as Error;
    expect(error.message, 'el mensaje explica el saldo').toMatch(/No hay saldo suficiente/);
    expect(error.message).toMatch(/No se escribió nada/);
    expect(
      error.message,
      'y no es un error crudo de la base',
    ).not.toMatch(/constraint|CHECK|Unique|40001|40P01|serialize|deadlock|P200\d/i);

    expect(await saldo(art.id, sucursalId), 'el saldo final es 3').toBe('3');
    expect(await prisma.stockLedger.count({ where: { type: 'WASTE_OUT' } })).toBe(1);
    expect(await prisma.stockWaste.count()).toBe(1);
  });

  it('11. una merma y un traslado compitiendo por el mismo saldo conservan el saldo', async () => {
    const art = await escenarioSimple('10');
    await aperturaDe(otraSucursalId, [{ productId: art.id, cantidad: '0' }]);

    /* Un traslado de 7 preparado, y una merma de 7: juntos exceden los 10. */
    const { id: trasladoId } = await crearBorrador(reversor, {
      origenId: sucursalId,
      destinoId: otraSucursalId,
    });
    await agregarRenglon(reversor, { trasladoId, productId: art.id, cantidad: '7' });

    const { soltar, tomada } = await tomarLaBarrera(art.id, sucursalId);
    const carrera = Promise.allSettled([
      despachar(reversor, { trasladoId, confirmado: true }),
      registrarMerma(mermador, {
        mermaId: proximaMerma(),
        branchId: sucursalId,
        productId: art.id,
        cantidad: '7',
        categoria: 'ROTURA',
        motivo: 'Se rompió mientras se armaba el pedido',
        confirmado: true,
      }),
    ]);
    await esperarDetenidos(2);
    soltar();
    await tomada;
    const resultados = await carrera;

    const ok = resultados.filter((r) => r.status === 'fulfilled');
    const fallaron = resultados.filter((r) => r.status === 'rejected');
    expect(ok, 'exactamente uno escribió').toHaveLength(1);
    expect(fallaron).toHaveLength(1);
    expect((fallaron[0] as PromiseRejectedResult).reason.message).toMatch(
      /No hay saldo suficiente|no se puede/i,
    );

    /* El saldo quedó en 3 y el libro lo explica con UN solo movimiento de salida. */
    expect(await saldo(art.id, sucursalId)).toBe('3');
    const salidas = await prisma.stockLedger.count({
      where: { branchId: sucursalId, direction: 'OUT' },
    });
    expect(salidas).toBe(1);
    const suma = await prisma.$queryRaw<{ total: string | null }[]>`
      SELECT SUM(CASE WHEN "direction" = 'IN' THEN "quantity" ELSE -"quantity" END)::text AS total
        FROM "stock_ledger" WHERE "productId" = ${art.id} AND "branchId" = ${sucursalId}`;
    expect(new Decimal(suma[0]?.total ?? '0').toString(), 'libro y saldo coinciden').toBe('3');
  });

  it('24. dos reversiones simultáneas de la misma operación permiten una sola', async () => {
    const art = await escenarioSimple('10');
    const { operationId } = await mermaDe(art, '3');
    expect(await saldo(art.id, sucursalId)).toBe('7');

    const { soltar, tomada } = await tomarLaBarrera(art.id, sucursalId);
    const carrera = Promise.allSettled([
      revertirOperacion(reversor, { operationId, motivo: 'estaba mal cargada', confirmado: true }),
      revertirOperacion(reversor, { operationId, motivo: 'estaba mal cargada', confirmado: true }),
    ]);
    await esperarDetenidos(2);
    soltar();
    await tomada;
    const [a, b] = await carrera;

    const aplicaron = [a, b].filter(
      (r) => r.status === 'fulfilled' && r.value.yaEstabaAplicada === false,
    );
    expect(aplicaron, 'sólo una reversión escribió').toHaveLength(1);
    expect(await saldo(art.id, sucursalId), 'el saldo volvió a 10, una sola vez').toBe('10');
    expect(
      await prisma.stockOperation.count({ where: { reversesOperationId: operationId } }),
    ).toBe(1);
    expect(await prisma.stockLedger.count({ where: { reversesId: { not: null } } })).toBe(1);
  });

  it('24b. la reversión toma los candados en orden canónico, y eso está en el código', () => {
    /*
     * La reversión de un despacho puede tocar VARIOS artículos, así que hereda el
     * problema de los traslados: dos reversiones que bloquean los mismos
     * artículos en órdenes distintos se abrazan.
     *
     * Esta afirmación es estructural y mira el mecanismo, no la conducta: que la
     * lista de artículos se ORDENE antes de pedir el primer candado. Va así y no
     * como carrera porque una carrera de reversiones simultáneas ya existe —la 24—
     * y el interbloqueo depende de qué transacción alcanzó a tomar su primer
     * candado: una prueba de conducta podría pasar por suerte.
     */
    const fuente = readFileSync(
      path.resolve(__dirname, '../../src/lib/services/stock-erp-correcciones.ts'),
      'utf8',
    );
    const posiciones = [...fuente.matchAll(/FOR UPDATE/g)].map((m) => m.index ?? 0);
    expect(
      posiciones.length,
      'la merma, la confirmación del recuento y la reversión son las tres que bloquean',
    ).toBe(3);

    /* El único que bloquea VARIOS artículos es el de la reversión. */
    const conOrden = posiciones.filter((donde) =>
      fuente.slice(Math.max(0, donde - 400), donde).includes('.sort()'),
    );
    expect(conOrden, 'el que bloquea varios artículos los ordena antes').toHaveLength(1);
    const antes = fuente.slice(Math.max(0, conOrden[0]! - 400), conOrden[0]!);
    expect(antes, 'y el bloqueo recorre esa lista ordenada').toMatch(/for \(const pid of productos\)/);
  });
});

/* ========================================================================== *
 * 12 a 19. El recuento correctivo
 * ========================================================================== */

describe('el recuento correctivo calcula la diferencia en el servidor', () => {
  it('12. la persona escribe la cantidad física y el servidor calcula el delta', async () => {
    const art = await escenarioSimple('10');
    const { sessionId } = await abrirRecuento(contador, { branchId: sucursalId });
    const { diferencia } = await guardarCantidadFisica(contador, {
      sessionId,
      productId: art.id,
      cantidadFisica: '8',
    });
    expect(diferencia, 'contada − esperada, calculada por el servidor').toBe('-2');

    const linea = await prisma.stockCountLine.findFirstOrThrow({ where: { sessionId } });
    expect(linea.expectedQuantity.toString()).toBe('10');
    expect(linea.countedQuantity.toString()).toBe('8');
    expect(linea.difference.toString()).toBe('-2');

    const vista = await verRecuento(contador, sessionId);
    expect(vista.lineas[0]!.saldoEsperado).toBe('10');
    expect(vista.lineas[0]!.cantidadFisica).toBe('8');
    expect(vista.lineas[0]!.diferencia).toBe('-2');
    expect(vista.conDiferencia).toBe(1);
  });

  it('13. el cliente no puede falsificar el delta: la base no lo acepta', async () => {
    const art = await escenarioSimple('10');
    const { sessionId } = await abrirRecuento(contador, { branchId: sucursalId });
    await guardarCantidadFisica(contador, { sessionId, productId: art.id, cantidadFisica: '8' });
    const linea = await prisma.stockCountLine.findFirstOrThrow({ where: { sessionId } });

    /*
     * Un delta inventado no se puede guardar ni entrando por SQL: la CHECK exige
     * que la diferencia SEA contada − esperada. Es la garantía que hace que el
     * servidor sea la única fuente del número.
     */
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "stock_count_line" SET "difference" = -9 WHERE id = $1`,
        linea.id,
      ),
    ).rejects.toThrow(/recuento_diferencia_derivada/);

    /*
     * Y el servicio no expone ningún camino para MANDAR una diferencia.
     *
     * La primera versión de esta afirmación buscaba «diferencia: string» en todo
     * el archivo y encontraba el tipo de RETORNO de `guardarCantidadFisica`, que
     * es una salida y no una entrada. Una afirmación que se satisface con lo que
     * el servicio devuelve no dice nada sobre lo que acepta. Ahora se mira la
     * firma de entrada, que es donde el número podría colarse.
     */
    const fuente = readFileSync(
      path.resolve(__dirname, '../../src/lib/services/stock-erp-correcciones.ts'),
      'utf8',
    );
    const firma = fuente.slice(
      fuente.indexOf('export async function guardarCantidadFisica'),
      fuente.indexOf('export async function verRecuento'),
    );
    const entrada = firma.slice(firma.indexOf('input: {'), firma.indexOf('}', firma.indexOf('input: {')));
    expect(entrada, 'la entrada pide la cantidad física').toContain('cantidadFisica');
    expect(entrada, 'y no acepta ninguna diferencia ni delta').not.toMatch(/diferencia|delta/i);
  });

  it('14. un recuento que coincide no crea ningún movimiento', async () => {
    const art = await escenarioSimple('10');
    const { sessionId } = await abrirRecuento(contador, { branchId: sucursalId });
    await guardarCantidadFisica(contador, { sessionId, productId: art.id, cantidadFisica: '10' });
    const linea = await prisma.stockCountLine.findFirstOrThrow({ where: { sessionId } });

    const antes = await prisma.stockLedger.count();
    const r = await confirmarLineaDeRecuento(ajustador, {
      lineaId: linea.id,
      confirmado: true,
      motivo: 'Control semanal de góndola',
    });

    expect(r.movimientos).toBe(0);
    expect(await prisma.stockLedger.count(), 'no se escribió ningún asiento').toBe(antes);
    expect(await saldo(art.id, sucursalId)).toBe('10');

    const despues = await prisma.stockCountLine.findUniqueOrThrow({ where: { id: linea.id } });
    expect(despues.resolution).toBe('SIN_DIFERENCIA');
    expect(despues.operationId, 'sin diferencia no hay operación').toBeNull();
    expect(
      await prisma.auditLog.count({
        where: { action: AUDIT_ACTIONS.STOCKERP_RECUENTO_SIN_DIFERENCIA, entityId: linea.id },
      }),
      'pero queda constancia',
    ).toBe(1);

    /* Y el recuento se puede cerrar porque no quedó nada pendiente. */
    await cerrarRecuento(contador, { sessionId });
    const sesion = await prisma.stockCountSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(sesion.status).toBe('CERRADA');
  });

  it('15. contar cero crea el ajuste que lleva el saldo a cero', async () => {
    const art = await escenarioSimple('4');
    const { sessionId } = await abrirRecuento(contador, { branchId: sucursalId });
    await guardarCantidadFisica(contador, { sessionId, productId: art.id, cantidadFisica: '0' });
    const linea = await prisma.stockCountLine.findFirstOrThrow({ where: { sessionId } });

    await confirmarLineaDeRecuento(ajustador, {
      lineaId: linea.id,
      confirmado: true,
      motivo: 'No había nada en la góndola ni en la cámara',
    });

    expect(await saldo(art.id, sucursalId)).toBe('0');
    const mov = await prisma.stockLedger.findFirstOrThrow({ where: { type: 'ADJUSTMENT_OUT' } });
    expect(mov.quantity.toString()).toBe('4');
    expect(mov.balanceAfterSeq.toString()).toBe('0');
  });

  it('16. si el saldo cambia entre el conteo y la confirmación, se bloquea', async () => {
    const art = await escenarioSimple('10');
    const { sessionId } = await abrirRecuento(contador, { branchId: sucursalId });
    await guardarCantidadFisica(contador, { sessionId, productId: art.id, cantidadFisica: '8' });
    const linea = await prisma.stockCountLine.findFirstOrThrow({ where: { sessionId } });

    /* Entre el conteo y la confirmación entra una merma legítima. */
    await mermaDe(art, '1');
    expect(await saldo(art.id, sucursalId)).toBe('9');

    /* La vista ya lo avisa antes de intentar. */
    const vista = await verRecuento(contador, sessionId);
    expect(vista.lineas[0]!.impedimentos.join(' ')).toMatch(/El saldo cambió desde que se contó/);

    await expect(
      confirmarLineaDeRecuento(ajustador, {
        lineaId: linea.id,
        confirmado: true,
        motivo: 'Confirmando el conteo de la mañana',
      }),
    ).rejects.toThrow(/El saldo cambió desde que se contó/);

    /* No se recalculó nada: el saldo sigue en 9 y la línea sin resolución. */
    expect(await saldo(art.id, sucursalId)).toBe('9');
    const despues = await prisma.stockCountLine.findUniqueOrThrow({ where: { id: linea.id } });
    expect(despues.resolution).toBeNull();
    expect(
      await prisma.stockLedger.count({
        where: { type: { in: ['ADJUSTMENT_IN', 'ADJUSTMENT_OUT'] } },
      }),
    ).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { action: AUDIT_ACTIONS.STOCKERP_RECUENTO_SALDO_CAMBIADO, entityId: linea.id },
      }),
    ).toBe(1);
  });

  it('17. un ajuste positivo incrementa exactamente la diferencia', async () => {
    const art = await escenarioSimple('10');
    const { sessionId } = await abrirRecuento(contador, { branchId: sucursalId });
    await guardarCantidadFisica(contador, { sessionId, productId: art.id, cantidadFisica: '12.5' });
    const linea = await prisma.stockCountLine.findFirstOrThrow({ where: { sessionId } });

    await confirmarLineaDeRecuento(ajustador, {
      lineaId: linea.id,
      confirmado: true,
      motivo: 'Había dos hormas sin registrar en la cámara',
    });

    expect(await saldo(art.id, sucursalId)).toBe('12.5');
    const mov = await prisma.stockLedger.findFirstOrThrow({ where: { type: 'ADJUSTMENT_IN' } });
    expect(mov.direction).toBe('IN');
    expect(mov.quantity.toString(), 'sólo la diferencia').toBe('2.5');
  });

  it('18. un ajuste negativo reduce exactamente la diferencia', async () => {
    const art = await escenarioSimple('10');
    const { sessionId } = await abrirRecuento(contador, { branchId: sucursalId });
    await guardarCantidadFisica(contador, { sessionId, productId: art.id, cantidadFisica: '7.25' });
    const linea = await prisma.stockCountLine.findFirstOrThrow({ where: { sessionId } });

    await confirmarLineaDeRecuento(ajustador, {
      lineaId: linea.id,
      confirmado: true,
      motivo: 'Faltaban dos kilos y tres cuartos',
    });

    expect(await saldo(art.id, sucursalId)).toBe('7.25');
    const mov = await prisma.stockLedger.findFirstOrThrow({ where: { type: 'ADJUSTMENT_OUT' } });
    expect(mov.quantity.toString()).toBe('2.75');
  });

  it('19. un ajuste no puede dejar el saldo negativo', async () => {
    const art = await escenarioSimple('10');
    const { sessionId } = await abrirRecuento(contador, { branchId: sucursalId });

    /* Una cantidad física negativa ni se acepta al cargarla. */
    await expect(
      guardarCantidadFisica(contador, { sessionId, productId: art.id, cantidadFisica: '-3' }),
    ).rejects.toThrow(/no puede ser negativa/);

    /* Y la base tampoco acepta una línea con cantidad contada negativa. */
    await guardarCantidadFisica(contador, { sessionId, productId: art.id, cantidadFisica: '1' });
    const linea = await prisma.stockCountLine.findFirstOrThrow({ where: { sessionId } });
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "stock_count_line" SET "countedQuantity" = -1, "difference" = -11 WHERE id = $1`,
        linea.id,
      ),
    ).rejects.toThrow(/recuento_cantidades/);
  });
});

/* ========================================================================== *
 * 20 a 30. La reversión
 * ========================================================================== */

describe('la reversión agrega asientos inversos y no edita el libro', () => {
  it('20. revertir una merma restaura el saldo', async () => {
    const art = await escenarioSimple('10');
    const { operationId } = await mermaDe(art, '2.5');
    expect(await saldo(art.id, sucursalId)).toBe('7.5');

    const r = await revertirOperacion(reversor, {
      operationId,
      motivo: 'La merma se cargó en la sucursal equivocada',
      confirmado: true,
    });
    expect(r.movimientos).toBe(1);
    expect(await saldo(art.id, sucursalId), 'el saldo volvió a 10').toBe('10');

    const inverso = await prisma.stockLedger.findFirstOrThrow({
      where: { reversesId: { not: null } },
    });
    expect(inverso.type, 'el tipo se conserva: así se sabe QUÉ se revirtió').toBe('WASTE_OUT');
    expect(inverso.direction, 'y la dirección se invierte').toBe('IN');
    expect(inverso.quantity.toString()).toBe('2.5');
    expect(inverso.reason).toMatch(/Reversión/);

    const merma = await prisma.stockWaste.findFirstOrThrow({ where: { operationId } });
    expect(merma.reversalOperationId).toBe(r.operationId);
    expect(merma.reversedAt).not.toBeNull();
  });

  it('21. revertir un ajuste crea el inverso exacto', async () => {
    const art = await escenarioSimple('10');
    const { sessionId } = await abrirRecuento(contador, { branchId: sucursalId });
    await guardarCantidadFisica(contador, { sessionId, productId: art.id, cantidadFisica: '12' });
    const linea = await prisma.stockCountLine.findFirstOrThrow({ where: { sessionId } });
    const ajuste = await confirmarLineaDeRecuento(ajustador, {
      lineaId: linea.id,
      confirmado: true,
      motivo: 'Aparecieron dos kilos',
    });
    expect(await saldo(art.id, sucursalId)).toBe('12');

    await revertirOperacion(reversor, {
      operationId: ajuste.operationId,
      motivo: 'El conteo era de otra sucursal',
      confirmado: true,
    });

    expect(await saldo(art.id, sucursalId), 'volvió a 10').toBe('10');
    const inverso = await prisma.stockLedger.findFirstOrThrow({
      where: { reversesId: { not: null } },
    });
    expect(inverso.type).toBe('ADJUSTMENT_IN');
    expect(inverso.direction, 'la entrada se invierte en salida').toBe('OUT');
    expect(inverso.quantity.toString()).toBe('2');
    const despues = await prisma.stockCountLine.findUniqueOrThrow({ where: { id: linea.id } });
    expect(despues.reversalOperationId).not.toBeNull();
  });

  it('22. la reversión conserva el movimiento original intacto', async () => {
    const art = await escenarioSimple('10');
    const { operationId } = await mermaDe(art, '2');
    const original = await prisma.stockLedger.findFirstOrThrow({ where: { type: 'WASTE_OUT' } });
    const antes = {
      quantity: original.quantity.toString(),
      direction: original.direction,
      balanceAfterSeq: original.balanceAfterSeq.toString(),
      seq: original.seq.toString(),
    };

    await revertirOperacion(reversor, {
      operationId,
      motivo: 'Se revierte para probar que el original no se toca',
      confirmado: true,
    });

    const despues = await prisma.stockLedger.findUniqueOrThrow({ where: { id: original.id } });
    expect({
      quantity: despues.quantity.toString(),
      direction: despues.direction,
      balanceAfterSeq: despues.balanceAfterSeq.toString(),
      seq: despues.seq.toString(),
    }).toEqual(antes);
    /* Y son dos asientos, no uno editado. */
    expect(await prisma.stockLedger.count({ where: { type: 'WASTE_OUT' } })).toBe(2);
  });

  it('23. una operación se revierte una sola vez', async () => {
    const art = await escenarioSimple('10');
    const { operationId } = await mermaDe(art, '2');
    await revertirOperacion(reversor, { operationId, motivo: 'primera', confirmado: true });

    const segunda = await revertirOperacion(reversor, {
      operationId,
      motivo: 'segunda',
      confirmado: true,
    });
    expect(segunda.yaEstabaAplicada, 'la segunda contesta lo guardado').toBe(true);
    expect(await saldo(art.id, sucursalId), 'el saldo no se movió de nuevo').toBe('10');
    expect(await prisma.stockLedger.count({ where: { reversesId: { not: null } } })).toBe(1);

    /* Y la reversión tampoco se revierte. */
    const inversa = await prisma.stockOperation.findFirstOrThrow({
      where: { reversesOperationId: operationId },
    });
    await expect(
      revertirOperacion(reversor, {
        operationId: inversa.id,
        motivo: 'revertir la reversión',
        confirmado: true,
      }),
    ).rejects.toThrow(/Una reversión no se revierte/);
  });

  it('25. no se revierte una apertura', async () => {
    const art = await escenarioSimple('10');
    const apertura = await prisma.stockOperation.findFirstOrThrow({ where: { kind: 'ACTIVACION' } });

    const previa = await operacionReversible(reversor, apertura.id);
    expect(previa.impedimentos.join(' ')).toMatch(/no es reversible en esta fase/);
    await expect(
      revertirOperacion(reversor, {
        operationId: apertura.id,
        motivo: 'probar que no se puede',
        confirmado: true,
      }),
    ).rejects.toThrow(/no se puede revertir/);
    expect(await saldo(art.id, sucursalId)).toBe('10');

    /* Y la base lo rechaza aunque alguien escriba el asiento a mano. */
    const mov = await prisma.stockLedger.findFirstOrThrow({ where: { type: 'OPENING_BALANCE' } });
    const op = await prisma.stockOperation.create({
      data: {
        operationKey: 'reversion-apertura-sql',
        kind: 'REVERSION',
        contentHash: 'x',
        branchId: sucursalId,
        requestedById: escenario.admin.id,
      },
    });
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "stock_ledger"
           ("id","txId","productId","pluHistorico","branchId","type","direction","quantity","unit",
            "effectiveAt","operationId","idempotencyKey","balanceAfterSeq","reversesId","reason")
         VALUES ('rev-ap', txid_current(), $1,'PLU',$2,'OPENING_BALANCE'::"StockMovementType",
                 'OUT'::"StockDirection",10,'KG',now(),$3,'rev-ap',0,$4,'a mano')`,
        art.id,
        sucursalId,
        op.id,
        mov.id,
      ),
      /*
       * Acá gana una garantía MÁS VIEJA y más fuerte, y conviene dejarlo escrito:
       * la apertura de un artículo en una sucursal tiene un único en el libro, así
       * que una segunda fila OPENING_BALANCE no se puede escribir de ninguna
       * manera, ni como reversión. El disparador de elegibilidad está detrás para
       * el resto de los tipos, y el servicio se niega antes que los dos.
       */
    ).rejects.toThrow(/no se revierte en esta fase|already exists/);
  });

  it('26. no se revierte una recepción de compra', async () => {
    const art = await escenarioSimple('10');
    /*
     * Se escribe un PURCHASE_IN a mano —la fase 4 tiene su propio camino— para
     * poder pedir su reversión: lo que se prueba es la elegibilidad, no la
     * recepción.
     */
    const op = await prisma.stockOperation.create({
      data: {
        operationKey: 'compra-para-revertir',
        kind: 'RECEPCION_COMPRA',
        contentHash: 'x',
        branchId: sucursalId,
        requestedById: escenario.admin.id,
        movementCount: 1,
      },
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO "stock_ledger"
         ("id","txId","productId","pluHistorico","branchId","type","direction","quantity","unit",
          "effectiveAt","operationId","idempotencyKey","balanceAfterSeq")
       VALUES ('compra-1', txid_current(), $1,'PLU',$2,'PURCHASE_IN'::"StockMovementType",
               'IN'::"StockDirection",1,'KG',now(),$3,'compra-1',11)`,
      art.id,
      sucursalId,
      op.id,
    );

    const previa = await operacionReversible(reversor, op.id);
    expect(previa.impedimentos.join(' ')).toMatch(/no es reversible en esta fase/);
    await expect(
      revertirOperacion(reversor, { operationId: op.id, motivo: 'no debería', confirmado: true }),
    ).rejects.toThrow(/no se puede revertir/);
  });

  it('27. no se revierte un traslado ya recibido', async () => {
    const art = await escenarioSimple('10');
    await aperturaDe(otraSucursalId, [{ productId: art.id, cantidad: '0' }]);
    const { id: trasladoId } = await crearBorrador(reversor, {
      origenId: sucursalId,
      destinoId: otraSucursalId,
    });
    await agregarRenglon(reversor, { trasladoId, productId: art.id, cantidad: '3' });
    const despacho = await despachar(reversor, { trasladoId, confirmado: true });
    await recibir(reversor, { trasladoId, confirmado: true });

    const previa = await operacionReversible(reversor, despacho.operationId);
    expect(previa.impedimentos.join(' ')).toMatch(/ya fue recibido/);
    await expect(
      revertirOperacion(reversor, {
        operationId: despacho.operationId,
        motivo: 'no debería poder',
        confirmado: true,
      }),
    ).rejects.toThrow(/no se puede revertir/);

    expect(await saldo(art.id, sucursalId)).toBe('7');
    expect(await saldo(art.id, otraSucursalId)).toBe('3');
  });

  it('28. y 29. revertir un despacho sin recepción restaura el origen y no toca el destino', async () => {
    const art = await escenarioSimple('10');
    await aperturaDe(otraSucursalId, [{ productId: art.id, cantidad: '0' }]);
    const { id: trasladoId } = await crearBorrador(reversor, {
      origenId: sucursalId,
      destinoId: otraSucursalId,
    });
    await agregarRenglon(reversor, { trasladoId, productId: art.id, cantidad: '3' });
    const despacho = await despachar(reversor, { trasladoId, confirmado: true });
    expect(await saldo(art.id, sucursalId)).toBe('7');

    const previa = await operacionReversible(reversor, despacho.operationId);
    expect(previa.clase).toBe('DESPACHO_DE_TRASLADO');
    expect(previa.impedimentos).toEqual([]);

    const r = await revertirOperacion(reversor, {
      operationId: despacho.operationId,
      motivo: 'El camión no salió: la mercadería no se movió',
      confirmado: true,
    });
    expect(r.movimientos).toBe(1);

    /* 29: el origen vuelve exactamente, el destino no se toca. */
    expect(await saldo(art.id, sucursalId), 'el origen volvió a 10').toBe('10');
    expect(await saldo(art.id, otraSucursalId), 'el destino sigue en cero').toBe('0');
    expect(await prisma.stockLedger.count({ where: { type: 'TRANSFER_IN' } })).toBe(0);

    const traslado = await prisma.stockTransfer.findUniqueOrThrow({ where: { id: trasladoId } });
    expect(traslado.status, 'el traslado queda REVERSADO').toBe('REVERSADO');
    expect(traslado.operationId, 'conserva su operación de despacho').toBe(despacho.operationId);
    expect(traslado.receiptOperationId).toBeNull();

    /* El asiento inverso conserva el vínculo con el renglón y con el original. */
    const inverso = await prisma.stockLedger.findFirstOrThrow({
      where: { reversesId: { not: null } },
      include: { transferLine: true },
    });
    expect(inverso.type).toBe('TRANSFER_OUT');
    expect(inverso.direction).toBe('IN');
    expect(inverso.transferLineId, 'sigue apuntando a su renglón').not.toBeNull();
    expect(inverso.transferLine?.transferId).toBe(trasladoId);
  });

  it('28b. el disparador distingue originales de reversiones: una segunda salida ORIGINAL sigue prohibida', async () => {
    /*
     * **La regresión específica.**
     *
     * La fase 7 enseñó a `stock_traslado_completo` a contar sólo movimientos
     * originales, y ése es el cambio que permite revertir un despacho. Lo que
     * esta prueba fija es que el filtro no aflojó la regla vieja: con la
     * reversión legítima ya escrita, una segunda salida ORIGINAL sigue siendo
     * imposible. Si alguien quitara el filtro, la reversión de arriba dejaría de
     * poder escribirse y esta suite se pondría roja.
     */
    const art = await escenarioSimple('10');
    await aperturaDe(otraSucursalId, [{ productId: art.id, cantidad: '0' }]);
    const { id: trasladoId } = await crearBorrador(reversor, {
      origenId: sucursalId,
      destinoId: otraSucursalId,
    });
    await agregarRenglon(reversor, { trasladoId, productId: art.id, cantidad: '3' });
    const despacho = await despachar(reversor, { trasladoId, confirmado: true });
    await revertirOperacion(reversor, {
      operationId: despacho.operationId,
      motivo: 'El camión no salió',
      confirmado: true,
    });

    const linea = await prisma.stockTransferLine.findFirstOrThrow({
      where: { transferId: trasladoId },
    });
    const movimientos = await prisma.stockLedger.findMany({
      where: { transferLineId: linea.id },
      orderBy: { seq: 'asc' },
    });
    expect(movimientos, 'el original y su reversión, dos asientos').toHaveLength(2);
    expect(movimientos.filter((m) => m.reversesId === null), 'un solo original').toHaveLength(1);
    expect(movimientos.filter((m) => m.reversesId !== null), 'una sola reversión').toHaveLength(1);

    /* Y una segunda salida original sigue siendo imposible. */
    const op = await prisma.stockOperation.create({
      data: {
        operationKey: 'segunda-salida-original',
        kind: 'TRASLADO',
        contentHash: 'x',
        branchId: sucursalId,
        requestedById: escenario.admin.id,
      },
    });
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "stock_ledger"
           ("id","txId","productId","pluHistorico","branchId","type","direction","quantity","unit",
            "effectiveAt","operationId","idempotencyKey","balanceAfterSeq","transferLineId")
         VALUES ('segunda-salida', txid_current(), $1,'PLU',$2,'TRANSFER_OUT'::"StockMovementType",
                 'OUT'::"StockDirection",3,'KG',now(),$3,'segunda-salida',7,$4)`,
        art.id,
        sucursalId,
        op.id,
        linea.id,
      ),
      'dos salidas originales del mismo renglón siguen siendo imposibles',
    ).rejects.toThrow(/dos salidas ni dos entradas|reversado necesita/);
  });

  it('30. si operaciones posteriores se llevaron la mercadería, la reversión se bloquea', async () => {
    const art = await escenarioSimple('10');
    const { sessionId } = await abrirRecuento(contador, { branchId: sucursalId });
    await guardarCantidadFisica(contador, { sessionId, productId: art.id, cantidadFisica: '14' });
    const linea = await prisma.stockCountLine.findFirstOrThrow({ where: { sessionId } });
    const ajuste = await confirmarLineaDeRecuento(ajustador, {
      lineaId: linea.id,
      confirmado: true,
      motivo: 'Aparecieron cuatro kilos',
    });
    expect(await saldo(art.id, sucursalId)).toBe('14');

    /* Después de ese ajuste de +4, una merma se lleva 12: quedan 2. */
    await mermaDe(art, '12');
    expect(await saldo(art.id, sucursalId)).toBe('2');

    /* Revertir el ajuste tendría que sacar 4, y no hay. */
    const previa = await operacionReversible(reversor, ajuste.operationId);
    expect(previa.impedimentos.join(' ')).toMatch(/operaciones posteriores/i);
    await expect(
      revertirOperacion(reversor, {
        operationId: ajuste.operationId,
        motivo: 'querer revertir sin saldo',
        confirmado: true,
      }),
    ).rejects.toThrow(/no se puede revertir/);

    expect(await saldo(art.id, sucursalId), 'nada cambió').toBe('2');
    expect(await prisma.stockLedger.count({ where: { reversesId: { not: null } } })).toBe(0);
  });
});

/* ========================================================================== *
 * 31 a 40. Coherencia, permisos, interruptor y el resto del sistema
 * ========================================================================== */

describe('lo que la fase no rompe', () => {
  it('31. el libro y el saldo quedan coherentes después de todo', async () => {
    const art = await escenarioSimple('10');
    await mermaDe(art, '2');
    const { sessionId } = await abrirRecuento(contador, { branchId: sucursalId });
    await guardarCantidadFisica(contador, { sessionId, productId: art.id, cantidadFisica: '9' });
    const linea = await prisma.stockCountLine.findFirstOrThrow({ where: { sessionId } });
    await confirmarLineaDeRecuento(ajustador, {
      lineaId: linea.id,
      confirmado: true,
      motivo: 'Apareció uno',
    });
    const { operationId } = await mermaDe(art, '3');
    await revertirOperacion(reversor, {
      operationId,
      motivo: 'estaba mal cargada',
      confirmado: true,
    });

    const suma = await prisma.$queryRaw<{ total: string | null }[]>`
      SELECT SUM(CASE WHEN "direction" = 'IN' THEN "quantity" ELSE -"quantity" END)::text AS total
        FROM "stock_ledger" WHERE "productId" = ${art.id} AND "branchId" = ${sucursalId}`;
    const enLibro = new Decimal(suma[0]?.total ?? '0');
    const enSaldo = new Decimal((await saldo(art.id, sucursalId))!);
    expect(enSaldo.equals(enLibro), `saldo ${enSaldo} vs libro ${enLibro}`).toBe(true);
    expect(enSaldo.toString()).toBe('9');

    /* Y cada saldo sigue respaldado por su último movimiento. */
    const balance = await prisma.stockBalance.findUniqueOrThrow({
      where: { productId_branchId: { productId: art.id, branchId: sucursalId } },
    });
    const ultimo = await prisma.stockLedger.findUniqueOrThrow({
      where: { id: balance.lastLedgerId },
    });
    expect(ultimo.balanceAfterSeq.toString()).toBe(balance.quantity.toString());
  });

  it('32. la auditoría registra cada paso, con valores de antes y después', async () => {
    const art = await escenarioSimple('10');
    const { sessionId } = await abrirRecuento(contador, { branchId: sucursalId });
    await guardarCantidadFisica(contador, { sessionId, productId: art.id, cantidadFisica: '8' });
    const linea = await prisma.stockCountLine.findFirstOrThrow({ where: { sessionId } });
    await confirmarLineaDeRecuento(ajustador, {
      lineaId: linea.id,
      confirmado: true,
      motivo: 'Faltaban dos',
    });
    const { operationId } = await mermaDe(art, '1');
    await revertirOperacion(reversor, { operationId, motivo: 'mal cargada', confirmado: true });

    const esperadas = [
      AUDIT_ACTIONS.STOCKERP_RECUENTO_INICIADO,
      AUDIT_ACTIONS.STOCKERP_RECUENTO_CONTADO,
      AUDIT_ACTIONS.STOCKERP_RECUENTO_DIFERENCIA,
      AUDIT_ACTIONS.STOCKERP_RECUENTO_AJUSTADO,
      AUDIT_ACTIONS.STOCKERP_MERMA_CONFIRMADA,
      AUDIT_ACTIONS.STOCKERP_REVERSION_CONFIRMADA,
    ];
    for (const accion of esperadas) {
      expect(
        await prisma.auditLog.count({ where: { action: accion } }),
        `falta la auditoría de ${accion}`,
      ).toBeGreaterThan(0);
    }

    /* Y el asiento del ajuste guarda el antes, el después, el motivo y la operación. */
    const ajuste = await prisma.auditLog.findFirstOrThrow({
      where: { action: AUDIT_ACTIONS.STOCKERP_RECUENTO_AJUSTADO },
    });
    const antes = ajuste.before as Record<string, unknown>;
    const despues = ajuste.after as Record<string, unknown>;
    expect(antes.saldo).toBe('10');
    expect(despues.saldoResultante).toBe('8');
    expect(despues.diferencia).toBe('-2');
    expect(despues.plu).toBeTruthy();
    expect(despues.sucursal).toBe(sucursalId);
    expect(ajuste.reason).toBe('Faltaban dos');
    expect(ajuste.userId).toBe(escenario.admin.id);
  });

  it('33. los permisos sensibles no llegan al administrador ni a los roles existentes', async () => {
    for (const permiso of [
      PERMISSIONS.STOCKERP_MERMA,
      PERMISSIONS.STOCKERP_AJUSTE,
      PERMISSIONS.STOCKERP_REVERSAR,
      PERMISSIONS.STOCKERP_MODULO_CONFIGURAR,
    ]) {
      expect(PERMISOS_SENSIBLES_DE_STOCK_ERP, permiso).toContain(permiso);
      expect(ADMIN_PERMISSIONS, permiso).not.toContain(permiso);
    }
    /* Preparar un recuento sí, porque contar no escribe el libro. */
    expect(ADMIN_PERMISSIONS).toContain(PERMISSIONS.STOCKERP_RECUENTO_PREPARAR);

    for (const code of ['ADMIN', 'OPERADOR', 'SUPERVISOR']) {
      const rol = await prisma.role.findFirst({ where: { code } });
      if (!rol) continue;
      for (const permiso of [
        PERMISSIONS.STOCKERP_MERMA,
        PERMISSIONS.STOCKERP_AJUSTE,
        PERMISSIONS.STOCKERP_REVERSAR,
      ]) {
        expect(rol.permissions, `${code} no recibe ${permiso}`).not.toContain(permiso);
      }
    }

    /* Y sin el permiso, cada camino se niega y queda auditado. */
    const art = await escenarioSimple('10');
    await expect(
      registrarMerma(contador, {
        mermaId: proximaMerma(),
        branchId: sucursalId,
        productId: art.id,
        cantidad: '1',
        categoria: 'ROTURA',
        motivo: 'sin permiso',
        confirmado: true,
      }),
    ).rejects.toThrow(/stockerp\.merma/);
    const { operationId } = await mermaDe(art, '1');
    await expect(
      revertirOperacion(mermador, { operationId, motivo: 'sin permiso', confirmado: true }),
    ).rejects.toThrow(/stockerp\.reversar/);
    expect(
      await prisma.auditLog.count({ where: { action: AUDIT_ACTIONS.STOCKERP_INTENTO_RECHAZADO } }),
    ).toBeGreaterThanOrEqual(2);
  });

  it('33b. «excepción histórica» no saltea el saldo, la unidad ni la auditoría', async () => {
    /*
     * `stockerp.excepcion.historica` existe para DOCUMENTAR una decisión sobre
     * mercadería anterior al corte, sin escribir movimientos. Nada de esta fase
     * lo consulta —se puede comprobar leyendo el servicio—, y eso es lo que
     * garantiza que no abra ninguna puerta. Esta prueba lo afirma desde afuera:
     * con el permiso puesto, cada regla sigue en pie.
     */
    const excepcional = con([
      ...BASE_DE_APERTURA,
      PERMISSIONS.STOCKERP_MERMA,
      PERMISSIONS.STOCKERP_AJUSTE,
      PERMISSIONS.STOCKERP_REVERSAR,
      PERMISSIONS.STOCKERP_EXCEPCION_HISTORICA,
    ]);
    const art = await escenarioSimple('4');

    /* El saldo: no alcanza y sigue sin alcanzar. */
    await expect(
      registrarMerma(excepcional, {
        mermaId: proximaMerma(),
        branchId: sucursalId,
        productId: art.id,
        cantidad: '5',
        categoria: 'FALTANTE',
        motivo: 'Con excepción histórica puesta',
        confirmado: true,
      }),
    ).rejects.toThrow(/saldo|quedan|negativo/i);

    /* La unidad: sigue siendo la aprobada, no la que convenga. */
    const otro = await articulo('C-200');
    await expect(
      registrarMerma(excepcional, {
        mermaId: proximaMerma(),
        branchId: sucursalId,
        productId: otro.id,
        cantidad: '1',
        categoria: 'ROTURA',
        motivo: 'Artículo sin apertura en esta sucursal',
        confirmado: true,
      }),
    ).rejects.toThrow();

    /* Y la auditoría: una merma legítima sigue dejando rastro con su motivo. */
    const antes = await prisma.auditLog.count({
      where: { action: AUDIT_ACTIONS.STOCKERP_MERMA_CONFIRMADA },
    });
    await registrarMerma(excepcional, {
      mermaId: proximaMerma(),
      branchId: sucursalId,
      productId: art.id,
      cantidad: '1',
      categoria: 'FALTANTE',
      motivo: 'Faltó una horma en el recuento de la tarde',
      confirmado: true,
    });
    expect(
      await prisma.auditLog.count({
        where: { action: AUDIT_ACTIONS.STOCKERP_MERMA_CONFIRMADA },
      }),
    ).toBe(antes + 1);

    /* Y el saldo bajó por el camino normal: el permiso no cambió nada. */
    const saldo = await prisma.stockBalance.findFirstOrThrow({
      where: { productId: art.id, branchId: sucursalId },
    });
    expect(saldo.quantity.toString()).toBe('3');
  });

  it('34. el interruptor de correcciones nace apagado y exige permiso y motivo', async () => {
    const estado = await interruptorDeCorreccionesReales();
    expect(estado.encendido).toBe(false);
    expect(estado.cambiadoPor).toBeNull();

    const columna = await prisma.$queryRaw<{ column_default: string }[]>`
      SELECT column_default FROM information_schema.columns
       WHERE table_name = 'stock_module_setting' AND column_name = 'realCorrectionsEnabled'`;
    expect(columna[0]!.column_default).toMatch(/false/);

    await expect(
      cambiarInterruptorDeCorrecciones(mermador, { encender: true, motivo: 'porque sí' }),
    ).rejects.toThrow(/stockerp\.modulo\.configurar/);
    await expect(
      cambiarInterruptorDeCorrecciones(jefeDeModulo, { encender: true, motivo: '  ' }),
    ).rejects.toThrow(/escribir por qué/);
    expect((await interruptorDeCorreccionesReales()).encendido).toBe(false);

    /* Y la base no lo enciende sin autor ni motivo. */
    const fila = await prisma.stockModuleSetting.findFirstOrThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "stock_module_setting" SET "realCorrectionsEnabled" = true WHERE id = $1`,
        fila.id,
      ),
    ).rejects.toThrow(/correcciones_con_motivo/);
  });

  it('35. ningún archivo decide el interruptor mirando el entorno', () => {
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
      const lineas = readFileSync(archivo, 'utf8').split('\n');
      for (const [i, linea] of lineas.entries()) {
        if (!/realCorrectionsEnabled/.test(linea)) continue;
        expect(
          /process\.env/.test(linea),
          `${path.relative(raiz, archivo)}:${i + 1} decide el interruptor con una variable de entorno`,
        ).toBe(false);
      }
    }
    /* Y el sembrado productivo no lo nombra. */
    const seed = readFileSync(path.resolve(__dirname, '../../prisma/seed.ts'), 'utf8');
    expect(seed).not.toContain('realCorrectionsEnabled');
  });

  it('36. ninguna corrección escribe una sola fila en StockOutbox', async () => {
    const art = await escenarioSimple('10');
    const { operationId } = await mermaDe(art, '2');
    const { sessionId } = await abrirRecuento(contador, { branchId: sucursalId });
    await guardarCantidadFisica(contador, { sessionId, productId: art.id, cantidadFisica: '7' });
    const linea = await prisma.stockCountLine.findFirstOrThrow({ where: { sessionId } });
    await confirmarLineaDeRecuento(ajustador, {
      lineaId: linea.id,
      confirmado: true,
      motivo: 'faltaba uno',
    });
    await revertirOperacion(reversor, { operationId, motivo: 'mal cargada', confirmado: true });

    expect(await prisma.stockOutbox.count()).toBe(0);

    /* Y el servicio no nombra el transporte externo. */
    const fuente = readFileSync(
      path.resolve(__dirname, '../../src/lib/services/stock-erp-correcciones.ts'),
      'utf8',
    );
    for (const prohibido of ['stockOutbox', 'STOCK_INTEGRATION', 'stock-transporte-http']) {
      expect(fuente, `el servicio no debería nombrar ${prohibido}`).not.toContain(prohibido);
    }
  });

  it('37. ningún camino de corrección hace HTTP', async () => {
    const llamadas: string[] = [];
    const espia = vi.spyOn(globalThis, 'fetch').mockImplementation((entrada: unknown) => {
      llamadas.push(String(entrada));
      throw new Error('ninguna corrección debería salir a la red');
    });

    const art = await escenarioSimple('10');
    const { operationId } = await mermaDe(art, '2');
    const { sessionId } = await abrirRecuento(contador, { branchId: sucursalId });
    await guardarCantidadFisica(contador, { sessionId, productId: art.id, cantidadFisica: '7' });
    const linea = await prisma.stockCountLine.findFirstOrThrow({ where: { sessionId } });
    await confirmarLineaDeRecuento(ajustador, {
      lineaId: linea.id,
      confirmado: true,
      motivo: 'faltaba uno',
    });
    await revertirOperacion(reversor, { operationId, motivo: 'mal cargada', confirmado: true });
    await mermasRegistradas(reversor, {});
    await operacionesReversibles(reversor, {});

    expect(llamadas, 'nadie salió a la red').toEqual([]);
    espia.mockRestore();

    /* Y el servicio no nombra `fetch` en ninguna parte. */
    const fuente = readFileSync(
      path.resolve(__dirname, '../../src/lib/services/stock-erp-correcciones.ts'),
      'utf8',
    );
    expect(fuente, 'el servicio no debería nombrar fetch(').not.toContain('fetch(');
  });

  it('38. las consultas de la fase 5 muestran los movimientos nuevos', async () => {
    const art = await escenarioSimple('10');
    await mermaDe(art, '2');
    const { sessionId } = await abrirRecuento(contador, { branchId: sucursalId });
    await guardarCantidadFisica(contador, { sessionId, productId: art.id, cantidadFisica: '9' });
    const linea = await prisma.stockCountLine.findFirstOrThrow({ where: { sessionId } });
    await confirmarLineaDeRecuento(ajustador, {
      lineaId: linea.id,
      confirmado: true,
      motivo: 'apareció uno',
    });

    const libro = await movimientosDelLibro(reversor, { branchId: sucursalId });
    const tipos = libro.movimientos.map((m) => m.type);
    expect(tipos).toContain('WASTE_OUT');
    expect(tipos).toContain('ADJUSTMENT_IN');

    const tablero = await tableroDeExistencias(reversor, { branchId: sucursalId });
    const fila = tablero.filas.find((f) => f.productId === art.id);
    expect(fila?.cantidad).toBe('9');
  });

  it('39. los traslados de la fase 6 conservan sus garantías', async () => {
    const art = await escenarioSimple('10');
    await aperturaDe(otraSucursalId, [{ productId: art.id, cantidad: '0' }]);
    const { id: trasladoId } = await crearBorrador(reversor, {
      origenId: sucursalId,
      destinoId: otraSucursalId,
    });
    await agregarRenglon(reversor, { trasladoId, productId: art.id, cantidad: '4' });

    /* El despacho sigue bajando el origen sin tocar el destino. */
    await despachar(reversor, { trasladoId, confirmado: true });
    expect(await saldo(art.id, sucursalId)).toBe('6');
    expect(await saldo(art.id, otraSucursalId)).toBe('0');

    /* La recepción exacta sigue cerrando, y una distinta sigue frenando. */
    const linea = await prisma.stockTransferLine.findFirstOrThrow({
      where: { transferId: trasladoId },
    });
    await expect(
      recibir(reversor, {
        trasladoId,
        confirmado: true,
        contado: { [linea.id]: '3' },
      }),
    ).rejects.toThrow(/SIGUE EN TRÁNSITO/);
    await recibir(reversor, { trasladoId, confirmado: true });
    expect(await saldo(art.id, otraSucursalId)).toBe('4');
  });

  it('40. las garantías viejas del libro siguen vivas', async () => {
    const art = await escenarioSimple('10');
    await mermaDe(art, '1');
    const mov = await prisma.stockLedger.findFirstOrThrow({ where: { type: 'WASTE_OUT' } });

    await expect(
      prisma.$executeRawUnsafe(`UPDATE "stock_ledger" SET "quantity" = 99 WHERE id = $1`, mov.id),
    ).rejects.toThrow(/inmutable/i);
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM "stock_ledger" WHERE id = $1`, mov.id),
    ).rejects.toThrow(/inmutable/i);

    /* Y la merma registrada tampoco se edita ni se borra. */
    const merma = await prisma.stockWaste.findFirstOrThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "stock_waste" SET "quantity" = 99 WHERE id = $1`,
        merma.id,
      ),
    ).rejects.toThrow(/no se edita|merma_cantidad/);
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM "stock_waste" WHERE id = $1`, merma.id),
    ).rejects.toThrow(/no se borra/);
  });
});
