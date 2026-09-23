import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { prisma } from '@/lib/db';
import { limpiarBase, sembrarEscenario, comoUsuario, type Escenario } from './ayudas';
import {
  prepararApertura,
  verApertura,
  actualizarSnapshot,
  guardarConteo,
  contarEnCero,
  marcarNoSeManeja,
  fijarCorte,
  confirmarApertura,
  cambiarInterruptor,
  interruptorDeAperturasReales,
  esAnteriorAlCorte,
  sucursalConApertura,
  estadoDeLinea,
  huellaDeApertura,
  claveDeApertura,
} from '@/lib/services/stock-erp-apertura';
import { aprobarUnidadDeExistencia } from '@/lib/services/stock-erp-unidades';
import { AUDIT_ACTIONS } from '@/lib/services/audit';
import { ADMIN_PERMISSIONS, PERMISSIONS, PERMISOS_SENSIBLES_DE_STOCK_ERP } from '@/lib/auth/permissions';
import { instanteDesdeHoraArgentina } from '@/lib/datetime';
import { Decimal } from '@/lib/money';

/**
 * **Stock ERP, fase 3: la apertura que inaugura una sucursal.**
 *
 * La afirmación que sostiene todo lo demás: **una sucursal sin apertura no
 * tiene saldo cero, tiene ausencia de dato.** Todo lo que se prueba acá
 * defiende esa frase desde un ángulo distinto.
 *
 * Nada de acá toca Control de Stock, ni sale a la red, ni usa un comprobante
 * real. Los artículos y las cantidades son inventados.
 */

let escenario: Escenario;
/** Quien prepara y cuenta. */
let preparador: ReturnType<typeof comoUsuario>;
/** Quien confirma: otro permiso, y a propósito otra persona. */
let confirmador: ReturnType<typeof comoUsuario>;
/** Quien puede tocar el interruptor. */
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

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();
  preparador = con([
    PERMISSIONS.STOCKERP_APERTURA_PREPARAR,
    PERMISSIONS.STOCKERP_ACTIVACION_HABILITAR,
    PERMISSIONS.STOCKERP_UNIDADES_CONFIGURAR,
  ]);
  confirmador = con([
    PERMISSIONS.STOCKERP_APERTURA_PREPARAR,
    PERMISSIONS.STOCKERP_APERTURA_CONFIRMAR,
    PERMISSIONS.STOCKERP_ACTIVACION_HABILITAR,
    PERMISSIONS.STOCKERP_UNIDADES_CONFIGURAR,
  ]);
  jefeDeModulo = con([PERMISSIONS.STOCKERP_MODULO_CONFIGURAR]);
});

afterEach(() => vi.restoreAllMocks());

/* ========================================================================== *
 * Artículos inventados
 * ========================================================================== */

async function articulo(plu: string, unidad: 'KG' | 'UNIT' | null = 'KG', activo = true) {
  const p = await prisma.product.create({
    data: {
      internalCode: plu,
      normalizedName: `ARTICULO FICTICIO ${plu}`,
      purchaseUnit: 'KG',
      saleMode: 'AL_CORTE',
      active: activo,
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

/** Prepara un borrador ficticio con los artículos que se le pasen. */
async function borradorCon(plus: { plu: string; unidad?: 'KG' | 'UNIT' | null }[]) {
  for (const a of plus) await articulo(a.plu, a.unidad === undefined ? 'KG' : a.unidad);
  return prepararApertura(preparador, { branchId: escenario.sucursales.devoto, ficticia: true });
}

async function lineaDe(sessionId: string, plu: string) {
  const a = await verApertura(preparador, sessionId);
  const l = a.lineas.find((x) => x.plu === plu);
  if (!l) throw new Error(`No hay línea para el PLU ${plu}`);
  return l;
}

/**
 * Deja todo listo: 9001 contado, 9002 en cero, corte puesto, sin impedimentos.
 *
 * El escenario sembrado trae sus propios artículos —del catálogo de Compras—
 * que entran al borrador como cualquier otro. Se los marca NO_SE_MANEJA con
 * motivo, que es exactamente lo que haría alguien que inaugura Devoto y no
 * trabaja esos productos. Así la prueba habla de 9001 y 9002 sin ignorar al
 * resto, que es lo que pasaría en un local de verdad.
 */
async function listaParaConfirmar() {
  const ap = await borradorCon([{ plu: '9001' }, { plu: '9002' }]);
  await guardarConteo(preparador, { activationId: (await lineaDe(ap.sessionId, '9001')).activationId, cantidad: '12.5' });
  await contarEnCero(preparador, (await lineaDe(ap.sessionId, '9002')).activationId);
  await resolverElResto(ap.sessionId, ['9001', '9002']);
  await fijarCorte(preparador, { sessionId: ap.sessionId, fecha: '2026-09-23', hora: '20:30' });
  return verApertura(preparador, ap.sessionId);
}

/** Marca NO_SE_MANEJA todo lo que la prueba no nombra. */
async function resolverElResto(sessionId: string, propios: string[]) {
  const ap = await verApertura(preparador, sessionId);
  for (const l of ap.lineas) {
    if (propios.includes(l.plu)) continue;
    if (l.estado === 'NO_SE_MANEJA') continue;
    await marcarNoSeManeja(preparador, {
      activationId: l.activationId,
      motivo: 'Esta sucursal no trabaja este artículo.',
    });
  }
}

/** El resumen real, para confirmar con lo que de verdad hay. */
function esperadoDe(ap: Awaited<ReturnType<typeof verApertura>>) {
  return {
    contados: ap.resumen.CONTADO,
    ceros: ap.resumen.CONTADO_CERO,
    noSeManeja: ap.resumen.NO_SE_MANEJA,
  };
}

/* ========================================================================== */

describe('una sucursal sin apertura no tiene saldo cero', () => {
  it('no tiene apertura, y eso no es un saldo', async () => {
    expect(await sucursalConApertura(escenario.sucursales.devoto)).toBe(false);
    /* Y no hay ninguna fila de saldo que pueda leerse como cero. */
    expect(await prisma.stockBalance.count({ where: { branchId: escenario.sucursales.devoto } })).toBe(0);
    expect(await prisma.stockLedger.count()).toBe(0);
  });

  it('una línea sin contar es PENDIENTE, nunca CONTADO_CERO', async () => {
    const ap = await borradorCon([{ plu: '9001' }]);
    const l = await lineaDe(ap.sessionId, '9001');
    expect(l.estado).toBe('PENDIENTE');
    expect(l.cantidad, 'nula, no "0"').toBeNull();
    /* La función que las distingue, directamente. */
    expect(estadoDeLinea({ state: 'LISTO_PARA_CONTAR', countedQuantity: null })).toBe('PENDIENTE');
    expect(
      estadoDeLinea({ state: 'LISTO_PARA_CONTAR', countedQuantity: new Decimal('0') as never }),
    ).toBe('CONTADO_CERO');
  });
});

describe('el borrador', () => {
  it('incluye todos los artículos activos del catálogo', async () => {
    await articulo('9001');
    await articulo('9002');
    await articulo('9003', 'KG', false); // inactivo
    const ap = await prepararApertura(preparador, {
      branchId: escenario.sucursales.devoto,
      ficticia: true,
    });
    const plus = ap.lineas.map((l) => l.plu);
    expect(plus).toContain('9001');
    expect(plus).toContain('9002');
    expect(plus, 'los inactivos no son obligatorios').not.toContain('9003');
    expect(ap.catalogSnapshotAt, 'se guarda cuándo se sacó la foto').toBeInstanceOf(Date);
  });

  it('un artículo sin unidad aprobada nace BLOQUEADO_UNIDAD', async () => {
    const ap = await borradorCon([{ plu: '9001', unidad: null }]);
    expect((await lineaDe(ap.sessionId, '9001')).estado).toBe('BLOQUEADO_UNIDAD');
  });

  it('no trae ninguna cantidad de ningún lado', async () => {
    const ap = await borradorCon([{ plu: '9001' }]);
    expect(ap.lineas.every((l) => l.cantidad === null)).toBe(true);
    expect(await prisma.stockOutbox.count()).toBe(0);
  });

  it('un artículo activo nuevo después del snapshot obliga a actualizar antes de confirmar', async () => {
    const ap = await listaParaConfirmar();
    /* Entra uno nuevo al catálogo. */
    await articulo('9009');

    const conNuevo = await verApertura(preparador, ap.sessionId);
    expect(conNuevo.impedimentos.join(' ')).toMatch(/entraron 1 artículo/i);

    await expect(
      confirmarApertura(confirmador, {
        sessionId: ap.sessionId,
        confirmado: true,
        esperado: esperadoDe(ap),
      }),
    ).rejects.toThrow(/actualizá el borrador/i);

    /* Al actualizar, los conteos ya cargados NO se pierden. */
    const actualizada = await actualizarSnapshot(preparador, ap.sessionId);
    expect(actualizada.lineas.find((l) => l.plu === '9001')!.cantidad).toBe('12.5');
    expect(actualizada.lineas.find((l) => l.plu === '9009')!.estado).toBe('PENDIENTE');
  });

  it('no deja preparar dos aperturas confirmadas, ni borradores en paralelo confusos', async () => {
    const ap = await borradorCon([{ plu: '9001' }]);
    const otra = await prepararApertura(preparador, {
      branchId: escenario.sucursales.devoto,
      ficticia: true,
    });
    expect(otra.sessionId, 'reusa el borrador que ya existía').toBe(ap.sessionId);
  });
});

describe('los cinco estados y lo que bloquea', () => {
  it('un conteo pendiente bloquea la confirmación', async () => {
    const ap = await borradorCon([{ plu: '9001' }, { plu: '9002' }]);
    await guardarConteo(preparador, {
      activationId: (await lineaDe(ap.sessionId, '9001')).activationId,
      cantidad: '3',
    });
    await fijarCorte(preparador, { sessionId: ap.sessionId, fecha: '2026-09-23', hora: '20:30' });

    await expect(
      confirmarApertura(confirmador, {
        sessionId: ap.sessionId,
        confirmado: true,
        esperado: { contados: 1, ceros: 0, noSeManeja: 0 },
      }),
    ).rejects.toThrow(/PENDIENTE|sin contar/i);
    expect(await prisma.stockLedger.count()).toBe(0);
  });

  it('una unidad bloqueada impide confirmar', async () => {
    const ap = await borradorCon([{ plu: '9001' }, { plu: '9002', unidad: null }]);
    await guardarConteo(preparador, {
      activationId: (await lineaDe(ap.sessionId, '9001')).activationId,
      cantidad: '3',
    });
    await fijarCorte(preparador, { sessionId: ap.sessionId, fecha: '2026-09-23', hora: '20:30' });

    await expect(
      confirmarApertura(confirmador, {
        sessionId: ap.sessionId,
        confirmado: true,
        esperado: { contados: 1, ceros: 0, noSeManeja: 0 },
      }),
    ).rejects.toThrow(/BLOQUEADO_UNIDAD/i);
  });

  it('NO_SE_MANEJA exige motivo', async () => {
    const ap = await borradorCon([{ plu: '9001' }]);
    const l = await lineaDe(ap.sessionId, '9001');
    await expect(
      marcarNoSeManeja(preparador, { activationId: l.activationId, motivo: '   ' }),
    ).rejects.toThrow(/motivo/i);
  });

  it('CONTADO exige cantidad positiva; el cero va por su propia puerta', async () => {
    const ap = await borradorCon([{ plu: '9001' }]);
    const l = await lineaDe(ap.sessionId, '9001');
    await expect(
      guardarConteo(preparador, { activationId: l.activationId, cantidad: '-1' }),
    ).rejects.toThrow(/negativa/i);
    await expect(
      guardarConteo(preparador, { activationId: l.activationId, cantidad: '0' }),
    ).rejects.toThrow(/Contado en cero/i);
  });

  it('acepta hasta tres decimales y rechaza el cuarto antes del cast', async () => {
    const ap = await borradorCon([{ plu: '9001' }]);
    const l = await lineaDe(ap.sessionId, '9001');

    await expect(
      guardarConteo(preparador, { activationId: l.activationId, cantidad: '4.2401' }),
    ).rejects.toThrow(/tres decimales/i);

    await guardarConteo(preparador, { activationId: l.activationId, cantidad: '4.240' });
    expect((await lineaDe(ap.sessionId, '9001')).cantidad).toBe('4.24');

    /* Y la base tampoco lo acepta si alguien se saltea el servicio. */
    await expect(
      prisma.productStockActivation.update({
        where: { id: l.activationId },
        data: { countedQuantity: '4.2401' },
      }),
    ).rejects.toThrow();
  });
});

describe('el corte', () => {
  it('se interpreta en hora argentina', async () => {
    const ap = await borradorCon([{ plu: '9001' }]);
    const instante = await fijarCorte(preparador, {
      sessionId: ap.sessionId,
      fecha: '2026-09-23',
      hora: '20:30',
    });
    /* Argentina está en UTC−3: las 20:30 de allá son las 23:30 UTC. */
    expect(instante.toISOString()).toBe('2026-09-23T23:30:00.000Z');
    expect(instanteDesdeHoraArgentina('2026-01-15', '00:00').toISOString()).toBe(
      '2026-01-15T03:00:00.000Z',
    );
  });

  it('queda inmutable una vez confirmada la apertura, y lo impide la base', async () => {
    const ap = await listaParaConfirmar();
    await confirmarApertura(confirmador, {
      sessionId: ap.sessionId,
      confirmado: true,
      esperado: esperadoDe(ap),
    });

    await expect(
      fijarCorte(preparador, { sessionId: ap.sessionId, fecha: '2026-09-24', hora: '10:00' }),
    ).rejects.toThrow(/inmutable|confirmada/i);

    /* Saltándose el servicio, el disparador tampoco deja. */
    await expect(
      prisma.stockCountSession.update({
        where: { id: ap.sessionId },
        data: { cutoffAt: new Date('2026-10-01T00:00:00Z') },
      }),
    ).rejects.toThrow(/corte/i);
  });

  it('la función que la fase 4 va a necesitar distingue antes y después del corte', async () => {
    const ap = await listaParaConfirmar();
    await confirmarApertura(confirmador, {
      sessionId: ap.sessionId,
      confirmado: true,
      esperado: esperadoDe(ap),
    });
    const sucursal = escenario.sucursales.devoto;
    expect(await esAnteriorAlCorte(sucursal, new Date('2026-09-23T22:00:00Z'))).toBe(true);
    expect(await esAnteriorAlCorte(sucursal, new Date('2026-09-24T00:00:00Z'))).toBe(false);
    /* Una sucursal sin apertura no tiene corte, así que nada le es anterior. */
    expect(await esAnteriorAlCorte(escenario.sucursales.pueyrredon, new Date('2020-01-01'))).toBe(false);
  });
});

describe('la confirmación escribe todo junto o nada', () => {
  it('crea libro, saldo, activación y operación en una sola transacción', async () => {
    const ap = await listaParaConfirmar();
    const r = await confirmarApertura(confirmador, {
      sessionId: ap.sessionId,
      confirmado: true,
      esperado: esperadoDe(ap),
    });

    expect(r.yaEstabaAplicada).toBe(false);
    expect(r.movimientos).toBe(2);

    const movs = await prisma.stockLedger.findMany({ orderBy: { pluHistorico: 'asc' } });
    expect(movs).toHaveLength(2);
    expect(movs.every((m) => m.type === 'OPENING_BALANCE')).toBe(true);
    expect(movs.every((m) => m.operationId === r.operationId)).toBe(true);

    const saldos = await prisma.stockBalance.findMany({ orderBy: { quantity: 'asc' } });
    expect(saldos).toHaveLength(2);
    expect(saldos.every((s) => s.openingSource === 'APERTURA')).toBe(true);
    expect(saldos.map((s) => s.quantity.toString())).toEqual(['0', '12.5']);

    const activas = await prisma.productStockActivation.findMany({ where: { state: 'ACTIVO' } });
    expect(activas).toHaveLength(2);
    expect(activas.every((a) => a.openingLedgerId && a.cutoffAt && a.activatedById)).toBe(true);

    const op = await prisma.stockOperation.findUniqueOrThrow({ where: { id: r.operationId } });
    expect(op.movementCount).toBe(2);
    expect(op.result).not.toBeNull();

    const asiento = await prisma.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.STOCKERP_APERTURA_CONFIRMADA },
    });
    expect(asiento!.userId).toBe(confirmador.id);
  });

  it('el cero escribe su movimiento y su saldo: se contó y no había', async () => {
    const ap = await listaParaConfirmar();
    const r = await confirmarApertura(confirmador, {
      sessionId: ap.sessionId,
      confirmado: true,
      esperado: esperadoDe(ap),
    });
    const cero = await prisma.product.findUniqueOrThrow({ where: { internalCode: '9002' } });
    const mov = await prisma.stockLedger.findFirstOrThrow({ where: { productId: cero.id } });
    expect(mov.quantity.toString()).toBe('0');
    expect(mov.type).toBe('OPENING_BALANCE');
    const saldo = await prisma.stockBalance.findFirstOrThrow({ where: { productId: cero.id } });
    expect(saldo.quantity.toString()).toBe('0');
    expect(saldo.openingSource).toBe('APERTURA');
    void r;
  });

  it('NO_SE_MANEJA no escribe movimiento ni saldo, pero conserva su decisión', async () => {
    const ap = await borradorCon([{ plu: '9001' }, { plu: '9002' }]);
    await guardarConteo(preparador, {
      activationId: (await lineaDe(ap.sessionId, '9001')).activationId,
      cantidad: '5',
    });
    await marcarNoSeManeja(preparador, {
      activationId: (await lineaDe(ap.sessionId, '9002')).activationId,
      motivo: 'Devoto no vende este artículo.',
    });
    await resolverElResto(ap.sessionId, ['9001', '9002']);
    await fijarCorte(preparador, { sessionId: ap.sessionId, fecha: '2026-09-23', hora: '20:30' });

    const listo = await verApertura(preparador, ap.sessionId);
    await confirmarApertura(confirmador, {
      sessionId: ap.sessionId,
      confirmado: true,
      esperado: esperadoDe(listo),
    });

    const noManejado = await prisma.product.findUniqueOrThrow({ where: { internalCode: '9002' } });
    expect(await prisma.stockLedger.count({ where: { productId: noManejado.id } })).toBe(0);
    expect(await prisma.stockBalance.count({ where: { productId: noManejado.id } })).toBe(0);
    const act = await prisma.productStockActivation.findFirstOrThrow({
      where: { productId: noManejado.id },
    });
    expect(act.state).toBe('NO_SE_MANEJA');
    expect(act.reason).toMatch(/no vende/i);
  });

  it('un fallo intermedio deja cero escrituras', async () => {
    const ap = await listaParaConfirmar();

    /*
     * El fallo se provoca con un choque REAL, no con un doble: se planta de
     * antemano un movimiento cuya clave de idempotencia es la que va a usar la
     * SEGUNDA línea. Así la primera línea escribe bien, la segunda choca, y lo
     * que se comprueba es que la primera tampoco sobrevivió.
     *
     * Un `vi.spyOn` sobre `prisma` no habría servido: adentro de
     * `$transaction` el cliente es otro (`tx`), y el doble no lo alcanza. La
     * primera versión de esta prueba pasaba sin romper nada.
     */
    const segundo = ap.lineas.find((l) => l.estado === 'CONTADO_CERO')!;
    const clave = claveDeApertura(ap.sessionId, escenario.sucursales.devoto);
    const opAjena = await prisma.stockOperation.create({
      data: {
        operationKey: 'operacion-ajena-para-chocar',
        kind: 'AJUSTE',
        contentHash: 'ajena',
        branchId: escenario.sucursales.devoto,
      },
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO "stock_ledger"
         ("id","txId","productId","pluHistorico","branchId","type","direction",
          "quantity","unit","effectiveAt","operationId","idempotencyKey","balanceAfterSeq")
       VALUES ('mov-plantado', txid_current(), $1, $2, $3,
               'OPENING_BALANCE'::"StockMovementType", 'IN'::"StockDirection",
               1::numeric, 'KG'::"StockUnit", now(), $4, $5, 1::numeric)`,
      segundo.productId,
      segundo.plu,
      escenario.sucursales.devoto,
      opAjena.id,
      `${clave}:${segundo.productId}`,
    );
    const antesDelIntento = await prisma.stockLedger.count();

    await expect(
      confirmarApertura(confirmador, {
        sessionId: ap.sessionId,
        confirmado: true,
        esperado: esperadoDe(ap),
      }),
    ).rejects.toThrow();

    expect(await prisma.stockLedger.count(), 'no quedó ningún movimiento nuevo').toBe(
      antesDelIntento,
    );
    expect(await prisma.stockBalance.count(), 'ni un saldo').toBe(0);
    expect(
      await prisma.stockOperation.count({ where: { operationKey: clave } }),
      'ni la operación de la apertura',
    ).toBe(0);
    const sesion = await prisma.stockCountSession.findUniqueOrThrow({ where: { id: ap.sessionId } });
    expect(sesion.status, 'la sesión sigue en borrador').toBe('BORRADOR');
  });

  it('exige la segunda confirmación, también en el servidor', async () => {
    const ap = await listaParaConfirmar();
    await expect(
      confirmarApertura(confirmador, {
        sessionId: ap.sessionId,
        confirmado: false,
        esperado: esperadoDe(ap),
      }),
    ).rejects.toThrow(/segunda confirmación/i);
    expect(await prisma.stockLedger.count()).toBe(0);
  });

  it('si el resumen que se confirmó no coincide con lo que hay, no aplica', async () => {
    const ap = await listaParaConfirmar();
    await expect(
      confirmarApertura(confirmador, {
        sessionId: ap.sessionId,
        confirmado: true,
        esperado: { contados: 99, ceros: 0, noSeManeja: 0 },
      }),
    ).rejects.toThrow(/no coincide/i);
    expect(await prisma.stockLedger.count()).toBe(0);
  });

  it('exige el permiso de confirmar, que es distinto del de preparar', async () => {
    const ap = await listaParaConfirmar();
    await expect(
      confirmarApertura(preparador, {
        sessionId: ap.sessionId,
        confirmado: true,
        esperado: esperadoDe(ap),
      }),
    ).rejects.toThrow(/stockerp\.apertura\.confirmar/);
    expect(await prisma.stockLedger.count()).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { action: AUDIT_ACTIONS.STOCKERP_INTENTO_RECHAZADO } }),
    ).toBeGreaterThan(0);
  });
});

describe('idempotencia y concurrencia', () => {
  it('la misma clave y la misma huella devuelve ALREADY_APPLIED sin duplicar', async () => {
    const ap = await listaParaConfirmar();
    const entrada = {
      sessionId: ap.sessionId,
      confirmado: true,
      esperado: esperadoDe(ap),
    };
    const primera = await confirmarApertura(confirmador, entrada);
    const segunda = await confirmarApertura(confirmador, entrada);

    expect(primera.yaEstabaAplicada).toBe(false);
    expect(segunda.yaEstabaAplicada, 'la segunda dice que ya estaba').toBe(true);
    expect(segunda.operationId).toBe(primera.operationId);
    expect(await prisma.stockLedger.count(), 'sin duplicar movimientos').toBe(2);
    expect(await prisma.stockBalance.count()).toBe(2);
  });

  it('la clave no lleva reloj: dos cálculos dan lo mismo', () => {
    const a = claveDeApertura('s1', 'b1');
    const b = claveDeApertura('s1', 'b1');
    expect(a).toBe(b);
    expect(a).not.toMatch(/\d{13}/);
  });

  it('la huella no depende del orden de las líneas, y sí del contenido', () => {
    const base = {
      branchId: 'b1',
      cutoffAt: new Date('2026-09-23T23:30:00Z'),
      lineas: [
        { productId: 'p2', pluHistorico: '9002', estado: 'CONTADO_CERO' as const, cantidad: '0', unidad: 'KG', motivo: null },
        { productId: 'p1', pluHistorico: '9001', estado: 'CONTADO' as const, cantidad: '12.5', unidad: 'KG', motivo: null },
      ],
    };
    const alReves = { ...base, lineas: [...base.lineas].reverse() };
    expect(huellaDeApertura(base)).toBe(huellaDeApertura(alReves));

    /* «0» y «0.000» son la misma cantidad: la huella lo canoniza. */
    const conCeros = {
      ...base,
      lineas: base.lineas.map((l) => (l.cantidad === '0' ? { ...l, cantidad: '0.000' } : l)),
    };
    expect(huellaDeApertura(conCeros)).toBe(huellaDeApertura(base));

    const distinta = {
      ...base,
      lineas: base.lineas.map((l) => (l.cantidad === '12.5' ? { ...l, cantidad: '12.6' } : l)),
    };
    expect(huellaDeApertura(distinta)).not.toBe(huellaDeApertura(base));
  });

  it('la misma clave con contenido distinto es conflicto y no escribe', async () => {
    const ap = await listaParaConfirmar();

    /*
     * Se planta una operación con LA MISMA clave y otra huella, antes de
     * confirmar. Es el caso real: alguien ya aplicó algo bajo esa clave y lo
     * que llega ahora no es lo mismo.
     *
     * No se puede simular cambiándole la huella a una operación ya aplicada:
     * las operaciones son inmutables por disparador, y el UPDATE se rechaza
     * —bien—. Lo descubrí intentándolo.
     */
    const clave = claveDeApertura(ap.sessionId, escenario.sucursales.devoto);
    await prisma.stockOperation.create({
      data: {
        operationKey: clave,
        kind: 'ACTIVACION',
        contentHash: 'una-huella-que-no-es-la-de-este-conteo',
        branchId: escenario.sucursales.devoto,
      },
    });

    await expect(
      confirmarApertura(confirmador, {
        sessionId: ap.sessionId,
        confirmado: true,
        esperado: esperadoDe(ap),
      }),
    ).rejects.toThrow(/contenido distinto/i);

    expect(await prisma.stockLedger.count(), 'no escribió nada').toBe(0);
    expect(await prisma.stockBalance.count()).toBe(0);
  });

  it('dos confirmaciones simultáneas dejan un solo juego de movimientos', async () => {
    const ap = await listaParaConfirmar();
    const entrada = {
      sessionId: ap.sessionId,
      confirmado: true,
      esperado: esperadoDe(ap),
    };
    const [a, b] = await Promise.allSettled([
      confirmarApertura(confirmador, entrada),
      confirmarApertura(confirmador, entrada),
    ]);
    const exitosas = [a, b].filter((r) => r.status === 'fulfilled');
    expect(exitosas.length, 'al menos una aplica').toBeGreaterThanOrEqual(1);
    expect(await prisma.stockLedger.count(), 'un solo juego').toBe(2);
    expect(await prisma.stockBalance.count()).toBe(2);
    expect(await prisma.stockOperation.count()).toBe(1);
  });

  it('una segunda apertura confirmada para la misma sucursal falla en la base', async () => {
    const ap = await listaParaConfirmar();
    await confirmarApertura(confirmador, {
      sessionId: ap.sessionId,
      confirmado: true,
      esperado: esperadoDe(ap),
    });
    /* Saltándose el servicio: el índice parcial no deja. */
    await expect(
      prisma.stockCountSession.create({
        data: {
          branchId: escenario.sucursales.devoto,
          name: 'Segunda apertura',
          status: 'CONFIRMADA',
          ficticia: true,
          cutoffAt: new Date('2026-09-24T00:00:00Z'),
          confirmedById: confirmador.id,
          confirmedAt: new Date(),
          operationId: (await prisma.stockOperation.findFirstOrThrow()).id,
        },
      }),
    ).rejects.toThrow();
  });
});

describe('el interruptor de aperturas reales', () => {
  it('nace apagado y sin autor', async () => {
    const i = await interruptorDeAperturasReales();
    expect(i.encendido).toBe(false);
    expect(i.cambiadoPor).toBeNull();
  });

  it('una apertura REAL no se confirma con el interruptor apagado', async () => {
    await articulo('9001');
    const ap = await prepararApertura(preparador, {
      branchId: escenario.sucursales.devoto,
      ficticia: false, // datos reales
    });
    await guardarConteo(preparador, {
      activationId: (await lineaDe(ap.sessionId, '9001')).activationId,
      cantidad: '5',
    });
    await fijarCorte(preparador, { sessionId: ap.sessionId, fecha: '2026-09-23', hora: '20:30' });

    await expect(
      confirmarApertura(confirmador, {
        sessionId: ap.sessionId,
        confirmado: true,
        esperado: { contados: 1, ceros: 0, noSeManeja: 0 },
      }),
    ).rejects.toThrow(/interruptor/i);
    expect(await prisma.stockLedger.count()).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { action: AUDIT_ACTIONS.STOCKERP_BLOQUEADO_INTERRUPTOR } }),
    ).toBe(1);
  });

  it('cambiarlo exige permiso sensible, motivo, y queda auditado', async () => {
    await expect(
      cambiarInterruptor(preparador, { encender: true, motivo: 'porque sí' }),
    ).rejects.toThrow(/stockerp\.modulo\.configurar/);

    await expect(
      cambiarInterruptor(jefeDeModulo, { encender: true, motivo: '  ' }),
    ).rejects.toThrow(/por qué/i);

    await cambiarInterruptor(jefeDeModulo, {
      encender: true,
      motivo: 'Homologación terminada; se inauguran las sucursales.',
    });
    const i = await interruptorDeAperturasReales();
    expect(i.encendido).toBe(true);
    expect(i.motivo).toMatch(/homologación/i);
    const asiento = await prisma.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.STOCKERP_INTERRUPTOR_CAMBIADO },
    });
    expect(asiento!.userId).toBe(jefeDeModulo.id);
  });

  it('la base tampoco deja encenderlo sin decir quién y por qué', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "stock_module_setting" SET "realOpeningEnabled" = true`,
      ),
    ).rejects.toThrow();
  });

  it('el seed no lo enciende: no lo nombra siquiera', async () => {
    const seed = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../prisma/seed.ts', import.meta.url), 'utf8'),
    );
    expect(seed).not.toContain('realOpeningEnabled');
    expect(seed).not.toContain('stockModuleSetting');
    expect(seed).not.toContain('stock_module_setting');
  });
});

describe('Stock ERP no habla con nadie, y lo demás sigue apagado', () => {
  it('no realiza ninguna llamada externa', async () => {
    const espia = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('NADIE SALE A LA RED');
    });
    const ap = await listaParaConfirmar();
    await confirmarApertura(confirmador, {
      sessionId: ap.sessionId,
      confirmado: true,
      esperado: esperadoDe(ap),
    });
    expect(espia).not.toHaveBeenCalled();
  });

  it('StockOutbox sigue en cero: Control de Stock no recibe movimientos', async () => {
    const ap = await listaParaConfirmar();
    await confirmarApertura(confirmador, {
      sessionId: ap.sessionId,
      confirmado: true,
      esperado: esperadoDe(ap),
    });
    expect(await prisma.stockOutbox.count()).toBe(0);
  });

  it('no hay recepciones de compra: el libro sólo tiene aperturas', async () => {
    const ap = await listaParaConfirmar();
    await confirmarApertura(confirmador, {
      sessionId: ap.sessionId,
      confirmado: true,
      esperado: esperadoDe(ap),
    });
    const tipos = await prisma.stockLedger.findMany({ select: { type: true }, distinct: ['type'] });
    expect(tipos.map((t) => t.type)).toEqual(['OPENING_BALANCE']);
    expect(await prisma.stockOperation.count({ where: { kind: 'RECEPCION_COMPRA' } })).toBe(0);
  });
});

describe('los permisos siguen sin repartirse solos', () => {
  it('una base nueva no entrega los permisos sensibles al administrador', () => {
    for (const s of PERMISOS_SENSIBLES_DE_STOCK_ERP) {
      expect(ADMIN_PERMISSIONS.includes(s), `«${s}» no puede venir de fábrica`).toBe(false);
    }
    expect(PERMISOS_SENSIBLES_DE_STOCK_ERP).toContain(PERMISSIONS.STOCKERP_APERTURA_CONFIRMAR);
    expect(PERMISOS_SENSIBLES_DE_STOCK_ERP).toContain(PERMISSIONS.STOCKERP_ACTIVACION_HABILITAR);
    expect(PERMISOS_SENSIBLES_DE_STOCK_ERP).toContain(PERMISSIONS.STOCKERP_MODULO_CONFIGURAR);
    /* Preparar NO es sensible: contar es el trabajo de todos los días. */
    expect(ADMIN_PERMISSIONS).toContain(PERMISSIONS.STOCKERP_APERTURA_PREPARAR);
  });

  it('resembrar no le agrega permisos a un rol que ya existe', async () => {
    const antes = await prisma.role.findFirstOrThrow({ where: { code: 'OPERADOR' } });
    const permisosAntes = [...(antes.permissions as string[])];
    await prisma.role.upsert({
      where: { code: 'OPERADOR' },
      update: {},
      create: {
        code: 'OPERADOR',
        name: 'Operador',
        permissions: ADMIN_PERMISSIONS,
        scopeAllBranches: true,
        isSystem: true,
      },
    });
    const despues = await prisma.role.findFirstOrThrow({ where: { code: 'OPERADOR' } });
    expect(despues.permissions).toEqual(permisosAntes);
  });
});
