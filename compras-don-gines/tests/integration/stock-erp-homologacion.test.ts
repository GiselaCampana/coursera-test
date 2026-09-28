import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@/lib/db';
import { limpiarBase, sembrarEscenario, comoUsuario, type Escenario } from './ayudas';
import { esUnaBaseDescartable } from '@/lib/base-de-pruebas';
import { aprobarUnidadDeExistencia } from '@/lib/services/stock-erp-unidades';
import {
  prepararApertura,
  verApertura,
  guardarConteo,
  contarEnCero,
  marcarNoSeManeja,
  fijarCorte,
  confirmarApertura,
  interruptorDeAperturasReales,
} from '@/lib/services/stock-erp-apertura';
import {
  aplicarIngresoDeCompra,
  interruptorDeRecepcionesReales,
} from '@/lib/services/stock-erp-recepcion';
import {
  crearBorrador,
  agregarRenglon,
  despachar,
  recibir,
  interruptorDeTrasladosReales,
} from '@/lib/services/stock-erp-traslados';
import {
  registrarMerma,
  abrirRecuento,
  guardarCantidadFisica,
  confirmarLineaDeRecuento,
  cerrarRecuento,
  revertirOperacion,
  operacionReversible,
  interruptorDeCorreccionesReales,
} from '@/lib/services/stock-erp-correcciones';
import {
  tableroDeExistencias,
  movimientosDelLibro,
  diagnosticoDeIntegridad,
} from '@/lib/services/stock-erp-consultas';
import { AUDIT_ACTIONS } from '@/lib/services/audit';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { Decimal } from '@/lib/money';

/**
 * **El ensayo de homologación: las siete fases, una sola vez, en orden.**
 *
 * Las suites por fase comprueban cada regla por separado y son irremplazables.
 * Ésta comprueba algo que ninguna de ellas puede: que el recorrido COMPLETO
 * funciona seguido, sobre los mismos artículos y las mismas sucursales, sin que
 * una fase le deje el piso torcido a la siguiente.
 *
 * Es el mismo recorrido que una persona haría en el navegador:
 *
 *   1. aprobar unidades;
 *   2. preparar y confirmar una apertura ficticia;
 *   3. recibir una compra;
 *   4. consultar existencias y libro;
 *   5. preparar, despachar y recibir un traslado;
 *   6. registrar una merma;
 *   7. hacer un recuento correctivo;
 *   8. revertir una operación elegible;
 *   9. comprobar auditoría e integridad;
 *  10. confirmar cero StockOutbox y cero HTTP de escritura.
 *
 * **Cada paso deja escrito el saldo de antes, lo que se movió y el saldo de
 * después.** No es decoración: un ensayo que sólo dice «pasó» no sirve para
 * homologar, porque lo que hay que poder mirar es si los números encajan.
 *
 * Todo con datos inventados, aperturas ficticias y los cuatro interruptores
 * reales APAGADOS. Corre en una base descartable —lo comprueba antes de
 * empezar— y no toca Control de Stock ni la red.
 */

let escenario: Escenario;
let operario: ReturnType<typeof comoUsuario>;
let sucursalA = '';
let sucursalB = '';

/** El acta del ensayo: lo que se pueda leer después sin volver a correrlo. */
const acta: string[] = [];
function anotar(paso: string, detalle: string) {
  acta.push(`${paso.padEnd(34)} ${detalle}`);
}

const CORTE = { fecha: '2026-09-20', hora: '20:30' };
const DESPUES = { fecha: '2026-09-21', hora: '09:00' };

function con(permisos: string[]) {
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

async function saldoDe(productId: string, branchId: string): Promise<string> {
  const fila = await prisma.stockBalance.findUnique({
    where: { productId_branchId: { productId, branchId } },
  });
  return fila ? fila.quantity.toString() : '—';
}

beforeAll(async () => {
  /*
   * La primera comprobación del ensayo es contra qué base corre. Un ensayo de
   * homologación que se ejecutara contra algo que no se puede tirar sería el
   * accidente que las guardas existen para evitar.
   */
  expect(
    esUnaBaseDescartable(process.env.DATABASE_URL),
    'el ensayo sólo corre contra una base descartable',
  ).toBe(true);

  await limpiarBase();
  escenario = await sembrarEscenario();
  /*
   * Un solo usuario con TODOS los permisos sensibles otorgados a mano. Es lo que
   * habrá que hacer en la homologación de verdad: el administrador de fábrica no
   * los trae, y la matriz del informe dice quién recibe cada uno.
   */
  operario = con([
    PERMISSIONS.STOCKERP_UNIDADES_CONFIGURAR,
    PERMISSIONS.STOCKERP_APERTURA_PREPARAR,
    PERMISSIONS.STOCKERP_APERTURA_CONFIRMAR,
    PERMISSIONS.STOCKERP_ACTIVACION_HABILITAR,
    PERMISSIONS.STOCKERP_RECEPCION_CONFIRMAR,
    PERMISSIONS.STOCKERP_TRASLADO_PREPARAR,
    PERMISSIONS.STOCKERP_TRASLADO_DESPACHAR,
    PERMISSIONS.STOCKERP_TRASLADO_RECIBIR,
    PERMISSIONS.STOCKERP_RECUENTO_PREPARAR,
    PERMISSIONS.STOCKERP_MERMA,
    PERMISSIONS.STOCKERP_AJUSTE,
    PERMISSIONS.STOCKERP_REVERSAR,
  ]);
  sucursalA = escenario.sucursales.devoto;
  sucursalB = escenario.sucursales.pueyrredon;
});

afterAll(() => {
  /* El acta se imprime al final, en un bloque, para poder pegarla en el informe. */
  console.log('\n===== ACTA DEL ENSAYO DE HOMOLOGACIÓN =====');
  for (const linea of acta) console.log(linea);
  console.log('===========================================\n');
});

describe('el ensayo de homologación recorre las siete fases seguidas', () => {
  /* Se comparten entre pasos: es un recorrido, no pruebas independientes. */
  const estado: {
    quesoId?: string;
    conservaId?: string;
    sesionA?: string;
    operacionMerma?: string;
    operacionDespacho?: string;
  } = {};

  it('0. los cuatro interruptores reales están apagados antes de empezar', async () => {
    const [ap, re, tr, co] = await Promise.all([
      interruptorDeAperturasReales(),
      interruptorDeRecepcionesReales(),
      interruptorDeTrasladosReales(),
      interruptorDeCorreccionesReales(),
    ]);
    expect(ap.encendido).toBe(false);
    expect(re.encendido).toBe(false);
    expect(tr.encendido).toBe(false);
    expect(co.encendido).toBe(false);
    anotar('0. interruptores', 'aperturas OFF · recepciones OFF · traslados OFF · correcciones OFF');
  });

  it('1. aprobar las unidades de existencia de dos artículos', async () => {
    const queso = await prisma.product.create({
      data: {
        internalCode: 'H-9001',
        normalizedName: 'QUESO DE HOMOLOGACION',
        category: 'Quesos',
        purchaseUnit: 'KG',
        saleMode: 'AL_CORTE',
        targetMarginPct: '0.45',
        marginBasis: 'SOBRE_COSTO',
        cashDiscountPct: '0',
        roundingRule: 'NEAREST_100',
      },
    });
    const conserva = await prisma.product.create({
      data: {
        internalCode: 'H-9002',
        normalizedName: 'CONSERVA DE HOMOLOGACION',
        category: 'Conservas',
        purchaseUnit: 'UNIT',
        saleMode: 'AL_CORTE',
        targetMarginPct: '0.35',
        marginBasis: 'SOBRE_COSTO',
        cashDiscountPct: '0',
        roundingRule: 'NEAREST_100',
      },
    });

    await aprobarUnidadDeExistencia(operario, {
      productId: queso.id,
      unidad: 'KG',
      confirmado: true,
    });
    await aprobarUnidadDeExistencia(operario, {
      productId: conserva.id,
      unidad: 'UNIT',
      confirmado: true,
    });

    const cfgs = await prisma.productStockConfig.findMany({
      where: { productId: { in: [queso.id, conserva.id] } },
      select: { productId: true, stockUnit: true, status: true, approvedById: true },
    });
    expect(cfgs).toHaveLength(2);
    for (const c of cfgs) {
      expect(c.status).toBe('APROBADA');
      expect(c.approvedById, 'una unidad aprobada tiene autor').not.toBeNull();
    }

    estado.quesoId = queso.id;
    estado.conservaId = conserva.id;
    anotar('1. unidades aprobadas', 'H-9001 en KG · H-9002 en UNIT · con autor y fecha');
  });

  it('2. preparar y confirmar la apertura ficticia de las dos sucursales', async () => {
    for (const [branchId, cantidadQueso, cantidadConserva] of [
      [sucursalA, '30', '12'],
      [sucursalB, '0', '0'],
    ] as const) {
      const ap = await prepararApertura(operario, { branchId, ficticia: true });
      const vista = await verApertura(operario, ap.sessionId);
      for (const l of vista.lineas) {
        const cantidad =
          l.productId === estado.quesoId
            ? cantidadQueso
            : l.productId === estado.conservaId
              ? cantidadConserva
              : null;
        if (cantidad === null) {
          if (l.estado !== 'NO_SE_MANEJA') {
            await marcarNoSeManeja(operario, {
              activationId: l.activationId,
              motivo: 'Esta sucursal no trabaja este artículo.',
            });
          }
        } else if (new Decimal(cantidad).isZero()) {
          await contarEnCero(operario, l.activationId);
        } else {
          await guardarConteo(operario, { activationId: l.activationId, cantidad });
        }
      }
      await fijarCorte(operario, { sessionId: ap.sessionId, ...CORTE });
      const lista = await verApertura(operario, ap.sessionId);
      await confirmarApertura(operario, {
        sessionId: ap.sessionId,
        confirmado: true,
        esperado: {
          contados: lista.resumen.CONTADO,
          ceros: lista.resumen.CONTADO_CERO,
          noSeManeja: lista.resumen.NO_SE_MANEJA,
        },
      });
      if (branchId === sucursalA) estado.sesionA = ap.sessionId;
    }

    expect(await saldoDe(estado.quesoId!, sucursalA)).toBe('30');
    expect(await saldoDe(estado.conservaId!, sucursalA)).toBe('12');
    /* Contado en CERO no es lo mismo que no tener saldo: la fila existe y vale 0. */
    expect(await saldoDe(estado.quesoId!, sucursalB)).toBe('0');

    const sesiones = await prisma.stockCountSession.findMany({
      where: { kind: 'APERTURA', status: 'CONFIRMADA' },
      select: { ficticia: true, cutoffAt: true, confirmedById: true },
    });
    expect(sesiones).toHaveLength(2);
    for (const s of sesiones) {
      expect(s.ficticia, 'la apertura del ensayo es ficticia').toBe(true);
      expect(s.cutoffAt, 'con corte fijado').not.toBeNull();
      expect(s.confirmedById, 'y con responsable').not.toBeNull();
    }
    anotar(
      '2. aperturas confirmadas',
      `A: queso 0→30 KG, conserva 0→12 UNIT · B: queso contado en 0 · corte ${CORTE.fecha} ${CORTE.hora}`,
    );
  });

  it('3. recibir una compra ficticia suma exactamente lo recibido', async () => {
    const antes = await saldoDe(estado.quesoId!, sucursalA);

    const doc = await prisma.document.create({
      data: {
        branchId: sucursalA,
        supplierId: escenario.proveedorId,
        docType: 'FACTURA',
        letter: 'A',
        pointOfSale: '0001',
        number: '80001',
        fullNumber: 'A 0001-80001',
        issueDate: new Date('2026-09-21T12:00:00Z'),
        status: 'VALIDADO',
        netTotal: '1000.00',
        ivaTotal: '210.00',
        total: '1210.00',
        createdById: escenario.admin.id,
        validatedById: escenario.admin.id,
        validatedAt: new Date(),
        items: {
          create: [
            {
              lineNumber: 1,
              description: 'QUESO DE HOMOLOGACION',
              quantity: '5.500',
              unit: 'KG',
              unitNetPrice: '100',
              grossSubtotal: '550',
              netAmount: '550',
              ivaRate: '0.21',
              ivaAmount: '115.50',
              totalCost: '665.50',
              unitCost: '121',
              productId: estado.quesoId!,
              matchMethod: 'MANUAL',
            },
          ],
        },
      },
    });

    const r = await aplicarIngresoDeCompra(operario, {
      documentId: doc.id,
      fecha: DESPUES.fecha,
      hora: DESPUES.hora,
      confirmado: true,
    });
    const despues = await saldoDe(estado.quesoId!, sucursalA);
    expect(despues).toBe('35.5');
    expect(r.movimientos).toBe(1);

    /* Y el reintento contesta lo mismo sin escribir de nuevo. */
    const otraVez = await aplicarIngresoDeCompra(operario, {
      documentId: doc.id,
      fecha: DESPUES.fecha,
      hora: DESPUES.hora,
      confirmado: true,
    });
    expect(otraVez.yaEstabaAplicada, 'el segundo intento es idempotente').toBe(true);
    expect(await saldoDe(estado.quesoId!, sucursalA)).toBe('35.5');

    const mov = await prisma.stockLedger.findFirstOrThrow({
      where: { type: 'PURCHASE_IN' },
      select: { quantity: true, unit: true, userId: true, effectiveAt: true, operationId: true },
    });
    expect(mov.unit).toBe('KG');
    expect(mov.userId, 'el movimiento tiene responsable').not.toBeNull();
    anotar(
      '3. recepción de compra',
      `queso ${antes} → ${despues} KG (+5.5) · operación ${(r.operationId ?? '—').slice(-8)} · reintento idempotente`,
    );
  });

  it('4. las consultas muestran ese saldo y ese movimiento', async () => {
    const tablero = await tableroDeExistencias(operario, { branchId: sucursalA });
    const fila = tablero.filas.find((f) => f.productId === estado.quesoId);
    expect(fila, 'el artículo aparece en el tablero').toBeDefined();
    expect(fila!.cantidad).toBe('35.5');
    expect(fila!.unidadDeExistencia).toBe('KG');

    const libro = await movimientosDelLibro(operario, { branchId: sucursalA });
    const tipos = libro.movimientos.map((m) => m.type);
    expect(tipos, 'la apertura está en el libro').toContain('OPENING_BALANCE');
    expect(tipos, 'y la compra también').toContain('PURCHASE_IN');
    anotar(
      '4. consultas',
      `tablero: queso 35.5 KG · libro: ${libro.movimientos.length} movimiento(s) en la sucursal A`,
    );
  });

  it('5. preparar, despachar y recibir un traslado mueve el saldo de A a B', async () => {
    const antesA = await saldoDe(estado.quesoId!, sucursalA);
    const antesB = await saldoDe(estado.quesoId!, sucursalB);

    const { id: trasladoId } = await crearBorrador(operario, {
      origenId: sucursalA,
      destinoId: sucursalB,
    });
    await agregarRenglon(operario, { trasladoId, productId: estado.quesoId!, cantidad: '4.5' });

    const despacho = await despachar(operario, { trasladoId, confirmado: true });
    expect(despacho.estado).toBe('DESPACHADO');
    const enTransitoA = await saldoDe(estado.quesoId!, sucursalA);
    expect(enTransitoA).toBe('31');
    /* En tránsito: salió del origen y todavía NO está en el destino. */
    expect(await saldoDe(estado.quesoId!, sucursalB)).toBe('0');

    const recepcion = await recibir(operario, { trasladoId, confirmado: true });
    expect(recepcion.estado).toBe('RECIBIDO');
    const despuesB = await saldoDe(estado.quesoId!, sucursalB);
    expect(despuesB).toBe('4.5');
    expect(despacho.operationId).not.toBe(recepcion.operationId);

    estado.operacionDespacho = despacho.operationId;
    anotar(
      '5. traslado A→B',
      `A ${antesA} → ${enTransitoA} → ${enTransitoA} KG · B ${antesB} → ${despuesB} KG · dos operaciones distintas`,
    );
  });

  it('6. registrar una merma baja el saldo por lo perdido, y sólo por eso', async () => {
    const antes = await saldoDe(estado.conservaId!, sucursalA);
    const r = await registrarMerma(operario, {
      mermaId: 'homologacion-merma-1',
      branchId: sucursalA,
      productId: estado.conservaId!,
      cantidad: '2',
      categoria: 'ROTURA',
      motivo: 'Dos frascos rotos al descargar',
      confirmado: true,
    });
    const despues = await saldoDe(estado.conservaId!, sucursalA);
    expect(antes).toBe('12');
    expect(despues).toBe('10');
    expect(r.movimientos).toBe(1);

    /* Doble clic: misma clave, misma respuesta, nada nuevo escrito. */
    const otraVez = await registrarMerma(operario, {
      mermaId: 'homologacion-merma-1',
      branchId: sucursalA,
      productId: estado.conservaId!,
      cantidad: '2',
      categoria: 'ROTURA',
      motivo: 'Dos frascos rotos al descargar',
      confirmado: true,
    });
    expect(otraVez.yaEstabaAplicada).toBe(true);
    expect(await saldoDe(estado.conservaId!, sucursalA)).toBe('10');

    const merma = await prisma.stockWaste.findFirstOrThrow({
      select: { unit: true, reason: true, createdById: true, occurredAt: true, operationId: true },
    });
    expect(merma.unit).toBe('UNIT');
    expect(merma.reason).toContain('frascos rotos');
    expect(merma.createdById, 'la merma tiene responsable').not.toBeNull();

    estado.operacionMerma = r.operationId;
    anotar(
      '6. merma',
      `conserva ${antes} → ${despues} UNIT (−2, ROTURA) · operación ${r.operationId.slice(-8)} · doble clic idempotente`,
    );
  });

  it('7. el recuento correctivo asienta sólo la diferencia que calcula el servidor', async () => {
    const antes = await saldoDe(estado.conservaId!, sucursalA);
    const { sessionId } = await abrirRecuento(operario, {
      branchId: sucursalA,
      nombre: 'Recuento de homologación',
    });
    const { diferencia } = await guardarCantidadFisica(operario, {
      sessionId,
      productId: estado.conservaId!,
      cantidadFisica: '9',
    });
    expect(diferencia, 'contado 9 contra saldo 10').toBe('-1');
    /* Contar no escribe: el saldo no se movió todavía. */
    expect(await saldoDe(estado.conservaId!, sucursalA)).toBe('10');

    const linea = await prisma.stockCountLine.findFirstOrThrow({ where: { sessionId } });
    const r = await confirmarLineaDeRecuento(operario, {
      lineaId: linea.id,
      motivo: 'Se contó con el encargado presente',
      confirmado: true,
    });
    const despues = await saldoDe(estado.conservaId!, sucursalA);
    expect(despues).toBe('9');
    expect(r.movimientos, 'un solo movimiento: la diferencia').toBe(1);

    const asiento = await prisma.stockLedger.findFirstOrThrow({
      where: { type: 'ADJUSTMENT_OUT' },
      select: { quantity: true, unit: true, userId: true, reason: true },
    });
    expect(asiento.quantity.toString(), 'se asentó 1, no 9').toBe('1');
    expect(asiento.unit).toBe('UNIT');
    expect(asiento.reason).toContain('encargado');

    await cerrarRecuento(operario, { sessionId });
    const sesion = await prisma.stockCountSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(sesion.status).toBe('CERRADA');
    anotar(
      '7. recuento correctivo',
      `conserva ${antes} → ${despues} UNIT · contado 9, diferencia −1 calculada por el servidor · sesión cerrada`,
    );
  });

  it('8. revertir la merma devuelve el saldo por el libro, y sólo una vez', async () => {
    const antes = await saldoDe(estado.conservaId!, sucursalA);
    const r = await revertirOperacion(operario, {
      operationId: estado.operacionMerma!,
      motivo: 'La merma se cargó en la sucursal equivocada',
      confirmado: true,
    });
    const despues = await saldoDe(estado.conservaId!, sucursalA);
    expect(antes).toBe('9');
    expect(despues).toBe('11');
    expect(r.movimientos).toBe(1);

    /* El original sigue en el libro, con su inverso al lado. */
    const asientos = await prisma.stockLedger.findMany({
      where: { type: 'WASTE_OUT' },
      select: { id: true, reversesId: true, direction: true },
    });
    expect(asientos.filter((a) => a.reversesId === null), 'el original intacto').toHaveLength(1);
    expect(asientos.filter((a) => a.reversesId !== null), 'y su reversión').toHaveLength(1);

    /* Una segunda vez contesta lo guardado y no duplica. */
    const otraVez = await revertirOperacion(operario, {
      operationId: estado.operacionMerma!,
      motivo: 'La merma se cargó en la sucursal equivocada',
      confirmado: true,
    });
    expect(otraVez.yaEstabaAplicada).toBe(true);
    expect(await saldoDe(estado.conservaId!, sucursalA)).toBe('11');

    /* Y el traslado YA RECIBIDO no es elegible: no es de esta etapa. */
    const previa = await operacionReversible(operario, estado.operacionDespacho!);
    expect(previa.impedimentos.join(' ')).toMatch(/ya fue recibido/);
    anotar(
      '8. reversión',
      `conserva ${antes} → ${despues} UNIT (+2 por el libro) · original intacto · segundo intento idempotente · traslado recibido NO elegible`,
    );
  });

  it('9. la auditoría registró cada paso y el diagnóstico de integridad está limpio', async () => {
    const esperadas = [
      /*
       * La PRIMERA aprobación de una unidad registra `config_creada`, no
       * `unidad_aprobada`: ésa es la de un artículo que ya tenía configuración.
       * La distinción importa y la encontró este ensayo: la afirmación pedía la
       * segunda y el recorrido hace la primera.
       */
      AUDIT_ACTIONS.STOCKERP_CONFIG_CREADA,
      AUDIT_ACTIONS.STOCKERP_APERTURA_CONFIRMADA,
      AUDIT_ACTIONS.STOCKERP_RECEPCION_APLICADA,
      AUDIT_ACTIONS.STOCKERP_TRASLADO_DESPACHADO,
      AUDIT_ACTIONS.STOCKERP_TRASLADO_RECIBIDO,
      AUDIT_ACTIONS.STOCKERP_MERMA_CONFIRMADA,
      AUDIT_ACTIONS.STOCKERP_RECUENTO_AJUSTADO,
      AUDIT_ACTIONS.STOCKERP_REVERSION_CONFIRMADA,
    ];
    const presentes = new Set(
      (
        await prisma.auditLog.findMany({
          where: { action: { in: esperadas } },
          select: { action: true },
        })
      ).map((a) => a.action),
    );
    for (const accion of esperadas) {
      expect(presentes.has(accion), `falta la auditoría de ${accion}`).toBe(true);
    }

    /* Y todas con usuario: una auditoría sin autor no sirve para auditar. */
    const sinAutor = await prisma.auditLog.count({
      where: { action: { in: esperadas }, userId: null },
    });
    expect(sinAutor, 'toda auditoría del recorrido tiene autor').toBe(0);

    const diag = await diagnosticoDeIntegridad(operario, {});
    expect(diag.divergencias, 'el libro y los saldos coinciden').toHaveLength(0);
    anotar(
      '9. auditoría e integridad',
      `${presentes.size}/${esperadas.length} acciones registradas, todas con autor · 0 divergencias`,
    );
  });

  it('10. ni una fila en StockOutbox, ni una petición HTTP de escritura', async () => {
    expect(await prisma.stockOutbox.count(), 'StockOutbox sigue en cero').toBe(0);

    /*
     * El HTTP se comprueba mirando el CÓDIGO de los servicios del módulo y no
     * espiando `fetch`: espiar sólo prueba que este recorrido no llamó, y lo que
     * hay que poder afirmar es que no hay ningún camino que llame.
     */
    const { readFileSync, readdirSync } = await import('node:fs');
    const path = await import('node:path');
    const dir = path.resolve(__dirname, '../../src/lib/services');
    const delModulo = readdirSync(dir).filter((f) => f.startsWith('stock-erp-'));
    expect(delModulo.length, 'hay servicios del módulo que revisar').toBeGreaterThan(4);
    for (const archivo of delModulo) {
      const fuente = readFileSync(path.join(dir, archivo), 'utf8');
      expect(fuente, `${archivo} no hace HTTP`).not.toMatch(
        /\bfetch\s*\(|\baxios\b|node-fetch|https?:\/\/(?!\/)/,
      );
    }
    anotar('10. sin salidas', 'StockOutbox 0 filas · ningún servicio del módulo hace HTTP');
  });

  it('al terminar el recorrido, los cuatro interruptores siguen apagados', async () => {
    const filas = await prisma.$queryRaw<
      {
        realOpeningEnabled: boolean;
        realPurchaseReceiptsEnabled: boolean;
        realTransfersEnabled: boolean;
        realCorrectionsEnabled: boolean;
      }[]
    >`SELECT "realOpeningEnabled", "realPurchaseReceiptsEnabled",
             "realTransfersEnabled", "realCorrectionsEnabled"
        FROM "stock_module_setting"`;
    expect(filas).toHaveLength(1);
    expect(filas[0]!.realOpeningEnabled).toBe(false);
    expect(filas[0]!.realPurchaseReceiptsEnabled).toBe(false);
    expect(filas[0]!.realTransfersEnabled).toBe(false);
    expect(filas[0]!.realCorrectionsEnabled).toBe(false);
    anotar('cierre', 'los cuatro interruptores siguen apagados después de todo el recorrido');
  });
});
