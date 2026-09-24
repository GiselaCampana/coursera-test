import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { prisma } from '@/lib/db';
import { limpiarBase, sembrarEscenario, comoUsuario, type Escenario } from './ayudas';
import {
  vistaPreviaDeRecepcion,
  recepcionesPendientes,
  listadoDeRecepciones,
  aplicarIngresoDeCompra,
  interruptorDeRecepcionesReales,
  cambiarInterruptorDeRecepciones,
  claveDeRecepcion,
  huellaDeRecepcion,
  VERSION_DE_LA_HUELLA_DE_RECEPCION,
} from '@/lib/services/stock-erp-recepcion';
import {
  prepararApertura,
  verApertura,
  guardarConteo,
  contarEnCero,
  marcarNoSeManeja,
  fijarCorte,
  confirmarApertura,
  cambiarInterruptor,
  laBaseAdmiteHomologacion,
} from '@/lib/services/stock-erp-apertura';
import {
  aprobarUnidadDeExistencia,
  guardarPresentacion,
} from '@/lib/services/stock-erp-unidades';
import { confirmDocument, createDocument } from '@/lib/services/documents';
import { AUDIT_ACTIONS } from '@/lib/services/audit';
import {
  ADMIN_PERMISSIONS,
  PERMISSIONS,
  PERMISOS_SENSIBLES_DE_STOCK_ERP,
} from '@/lib/auth/permissions';
import { instanteDesdeHoraArgentina } from '@/lib/datetime';
import { Decimal } from '@/lib/money';

/**
 * **Stock ERP, fase 4: recibir la mercadería de una compra.**
 *
 * Las dos afirmaciones que sostienen el archivo entero:
 *
 *  1. **Validar una factura no es recibir mercadería.** Son dos hechos, con dos
 *     fechas, dos permisos y dos momentos. Un comprobante validado sin
 *     recepción es información válida, no un pendiente perdido.
 *  2. **Nada entra con fecha anterior o igual al corte.** Esa mercadería ya
 *     está contada en la apertura, y sumarla otra vez la duplicaría sin que el
 *     error se note hasta el siguiente recuento.
 *
 * Todo lo de acá usa artículos y comprobantes INVENTADOS. Ninguna prueba toca
 * Control de Stock, ni sale a la red, ni usa una factura real.
 */

let escenario: Escenario;
/** Quien prepara aperturas, cuenta y aprueba unidades. */
let preparador: ReturnType<typeof comoUsuario>;
/** Quien confirma aperturas y recepciones. */
let receptor: ReturnType<typeof comoUsuario>;
/** Quien puede tocar los interruptores. */
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

const CORTE = { fecha: '2026-09-23', hora: '20:30' };
/** Después del corte: el caso normal. */
const DESPUES = { fecha: '2026-09-24', hora: '09:00' };
/** Antes del corte. */
const ANTES = { fecha: '2026-09-22', hora: '11:00' };

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();
  preparador = con([
    PERMISSIONS.STOCKERP_APERTURA_PREPARAR,
    PERMISSIONS.STOCKERP_ACTIVACION_HABILITAR,
    PERMISSIONS.STOCKERP_UNIDADES_CONFIGURAR,
    PERMISSIONS.STOCKERP_APERTURA_CONFIRMAR,
    PERMISSIONS.STOCKERP_RECEPCION_PREPARAR,
  ]);
  receptor = con([
    PERMISSIONS.STOCKERP_APERTURA_PREPARAR,
    PERMISSIONS.STOCKERP_APERTURA_CONFIRMAR,
    PERMISSIONS.STOCKERP_ACTIVACION_HABILITAR,
    PERMISSIONS.STOCKERP_UNIDADES_CONFIGURAR,
    PERMISSIONS.STOCKERP_RECEPCION_PREPARAR,
    PERMISSIONS.STOCKERP_RECEPCION_CONFIRMAR,
  ]);
  jefeDeModulo = con([PERMISSIONS.STOCKERP_MODULO_CONFIGURAR]);
});

afterEach(() => vi.restoreAllMocks());

/* ========================================================================== *
 * Artículos, aperturas y comprobantes inventados
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

/**
 * Deja la sucursal con apertura ficticia confirmada y el corte puesto.
 *
 * Ficticia porque el interruptor de aperturas reales está apagado y así debe
 * quedarse: lo que se prueba acá es la recepción, no si se puede inaugurar un
 * inventario de verdad.
 */
async function aperturaDe(
  branchId: string,
  corte: { fecha: string; hora: string } = CORTE,
  contar: { productId: string; cantidad: string }[] = [],
) {
  const ap = await prepararApertura(preparador, { branchId, ficticia: true });
  const vista = await verApertura(preparador, ap.sessionId);
  const aContar = new Map(contar.map((c) => [c.productId, c.cantidad]));

  for (const l of vista.lineas) {
    const cantidad = aContar.get(l.productId);
    if (cantidad !== undefined) {
      /*
       * Contar cero es un gesto aparte de escribir un 0, y la fase 3 lo hace
       * cumplir. Acá se respeta: «lo busqué y no había» no es lo mismo que
       * «tipeé cero».
       */
      if (new Decimal(cantidad).isZero()) {
        await contarEnCero(preparador, l.activationId);
      } else {
        await guardarConteo(preparador, { activationId: l.activationId, cantidad });
      }
    } else if (l.estado !== 'NO_SE_MANEJA') {
      await marcarNoSeManeja(preparador, {
        activationId: l.activationId,
        motivo: 'Esta sucursal no trabaja este artículo.',
      });
    }
  }

  await fijarCorte(preparador, { sessionId: ap.sessionId, ...corte });
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

interface RenglonDePrueba {
  productId?: string | null;
  descripcion?: string;
  cantidad: string;
  unidad?: 'KG' | 'UNIT';
  gasto?: 'EMBALAJE' | 'FLETE' | null;
  supplierCode?: string | null;
  piezas?: number | null;
  pesoKg?: string | null;
}

let contadorDeNumero = 0;

/**
 * Un comprobante VALIDADO, escrito directamente.
 *
 * Se arma con Prisma y no con `confirmDocument` porque estas pruebas necesitan
 * renglones que `confirmDocument` no dejaría entrar —una cantidad con cuatro
 * decimales, un artículo inactivo, dos renglones del mismo producto— y el
 * objeto de la prueba es qué hace la RECEPCIÓN con ellos. El camino completo,
 * con `confirmDocument` de verdad, se ejercita aparte más abajo.
 */
async function comprobante(opciones: {
  branchId: string;
  renglones: RenglonDePrueba[];
  issueDate?: string;
  status?: 'VALIDADO' | 'BORRADOR' | 'ANULADO';
  supplierId?: string;
}) {
  contadorDeNumero += 1;
  const numero = String(10000 + contadorDeNumero);
  const doc = await prisma.document.create({
    data: {
      branchId: opciones.branchId,
      supplierId: opciones.supplierId ?? escenario.proveedorId,
      docType: 'FACTURA',
      letter: 'A',
      pointOfSale: '0001',
      number: numero,
      fullNumber: `A 0001-${numero}`,
      issueDate: new Date(`${opciones.issueDate ?? '2026-09-24'}T03:00:00.000Z`),
      status: opciones.status ?? 'VALIDADO',
      total: '1210.00',
      netTotal: '1000.00',
      ivaTotal: '210.00',
      createdById: escenario.admin.id,
      validatedById: escenario.admin.id,
      validatedAt: new Date(),
      items: {
        create: opciones.renglones.map((r, i) => ({
          lineNumber: i + 1,
          supplierCode: r.supplierCode ?? null,
          description: r.descripcion ?? `RENGLON ${i + 1}`,
          quantity: r.cantidad,
          unit: r.unidad ?? 'KG',
          pieceCount: r.piezas ?? null,
          totalWeightKg: r.pesoKg ?? null,
          unitNetPrice: '100',
          grossSubtotal: '100',
          netAmount: '100',
          ivaRate: '0.21',
          ivaAmount: '21',
          totalCost: '121',
          unitCost: '121',
          productId: r.gasto ? null : (r.productId ?? null),
          expenseKind: r.gasto ?? null,
          matchMethod: 'MANUAL',
        })),
      },
    },
    include: { items: { orderBy: { lineNumber: 'asc' } } },
  });
  return doc;
}

/** Recibir con la fecha física dada. */
function recibir(
  documentId: string,
  cuando: { fecha: string; hora: string } = DESPUES,
  extra: { motivo?: string; excepcionHistorica?: boolean; confirmado?: boolean } = {},
  quien = receptor,
) {
  return aplicarIngresoDeCompra(quien, {
    documentId,
    fecha: cuando.fecha,
    hora: cuando.hora,
    confirmado: extra.confirmado ?? true,
    motivo: extra.motivo ?? null,
    excepcionHistorica: extra.excepcionHistorica,
  });
}


/**
 * Una apertura REAL confirmada, encendiendo y volviendo a apagar el interruptor
 * de aperturas de la fase 3.
 *
 * Es el único camino honesto: una apertura ficticia no se convierte en real
 * —el disparador lo impide— y el interruptor de aperturas es una decisión
 * distinta de la de recepciones, que es justamente lo que se quiere comprobar.
 */
async function aperturaRealCon(plu: string) {
  const sucursal = escenario.sucursales.devoto;
  await cambiarInterruptor(jefeDeModulo, {
    encender: true,
    motivo: 'Prueba: se inaugura con datos reales para comprobar el otro interruptor.',
  });
  const p = await articulo(plu);
  const ap = await prepararApertura(preparador, { branchId: sucursal, ficticia: false });
  const vista = await verApertura(preparador, ap.sessionId);
  for (const l of vista.lineas) {
    if (l.productId === p.id) {
      await guardarConteo(preparador, { activationId: l.activationId, cantidad: '10' });
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
  /* Se vuelve a apagar: ninguna base queda con aperturas reales habilitadas. */
  await cambiarInterruptor(jefeDeModulo, { encender: false, motivo: 'Fin de la prueba.' });

  const doc = await comprobante({
    branchId: sucursal,
    renglones: [{ productId: p.id, cantidad: '5' }],
  });
  return { producto: p, doc, sucursal };
}

/** El caso feliz completo: un artículo contado, una apertura y un comprobante. */
async function escenarioSimple(cantidad = '5') {
  const p = await articulo('9001');
  await aperturaDe(escenario.sucursales.devoto, CORTE, [{ productId: p.id, cantidad: '10' }]);
  const doc = await comprobante({
    branchId: escenario.sucursales.devoto,
    renglones: [{ productId: p.id, cantidad }],
  });
  return { producto: p, doc };
}

/* ========================================================================== *
 * 1 y 21. Validar no es recibir
 * ========================================================================== */

describe('validar una factura no ingresa mercadería', () => {
  /** El camino real y completo, con `confirmDocument` de verdad. */
  async function validarDeVerdad() {
    const p = await articulo('9001');
    await aperturaDe(escenario.sucursales.devoto, CORTE, [{ productId: p.id, cantidad: '10' }]);
    const borrador = await createDocument(escenario.admin, escenario.sucursales.devoto);
    const r = await confirmDocument(escenario.admin, {
      documentId: borrador.id,
      supplierId: escenario.proveedorId,
      docType: 'FACTURA',
      letter: 'A',
      pointOfSale: '0001',
      number: '55501',
      issueDate: '2026-09-24',
      printed: { netTotal: '1000.00', ivaTotal: '210.00', total: '1210.00' },
      items: [
        {
          lineNumber: 1,
          supplierCode: 'X1',
          description: 'ARTICULO FICTICIO 9001',
          quantity: '10',
          unit: 'KG' as const,
          unitNetPrice: '100',
          discountPct: '0',
          ivaRate: '0.21',
          productId: p.id,
          matchMethod: 'MANUAL',
          clasificacion: 'MERCADERIA' as const,
          expenseKind: null,
        },
      ],
      payment: { dueDate: '2026-10-24', paymentMethod: 'TRANSFERENCIA', notes: null },
    });
    return { producto: p, documentId: r.documentId };
  }

  it('1. confirmar el comprobante no escribe una sola fila de stock', async () => {
    await validarDeVerdad();
    expect(await prisma.stockLedger.count({ where: { type: 'PURCHASE_IN' } })).toBe(0);
    expect(await prisma.stockReceipt.count()).toBe(0);
    expect(await prisma.stockOperation.count({ where: { kind: 'RECEPCION_COMPRA' } })).toBe(0);
  });

  it('1b. y el saldo del artículo sigue siendo el de la apertura', async () => {
    const { producto } = await validarDeVerdad();
    const saldo = await prisma.stockBalance.findFirstOrThrow({ where: { productId: producto.id } });
    expect(saldo.quantity.toString()).toBe('10');
    expect(saldo.openingSource).toBe('APERTURA');
  });

  it('21. recibir no toca PurchaseMovement: sigue contestando qué se compró', async () => {
    const { documentId } = await validarDeVerdad();
    const antes = await prisma.purchaseMovement.findMany({
      where: { documentId },
      orderBy: { id: 'asc' },
    });
    expect(antes.length).toBeGreaterThan(0);

    await recibir(documentId);

    const despues = await prisma.purchaseMovement.findMany({
      where: { documentId },
      orderBy: { id: 'asc' },
    });
    expect(despues).toEqual(antes);
  });

  it('20. la recepción aplicada queda unida al comprobante y a cada renglón', async () => {
    const { documentId } = await validarDeVerdad();
    await recibir(documentId);

    const mov = await prisma.stockLedger.findFirstOrThrow({ where: { type: 'PURCHASE_IN' } });
    expect(mov.documentId).toBe(documentId);
    expect(mov.documentItemId).toBeTruthy();

    /* Y el renglón existe de verdad: la clave foránea no es decorativa. */
    const renglon = await prisma.documentItem.findUnique({ where: { id: mov.documentItemId! } });
    expect(renglon?.documentId).toBe(documentId);
  });
});

/* ========================================================================== *
 * 2. Los pendientes se calculan, no se guardan
 * ========================================================================== */

describe('la bandeja de pendientes no existe: se calcula', () => {
  it('2. un comprobante validado aparece como pendiente de recepción', async () => {
    const { doc } = await escenarioSimple();
    const pendientes = await recepcionesPendientes(receptor);
    expect(pendientes.map((p) => p.documentId)).toContain(doc.id);
  });

  it('2b. y deja de estar pendiente en cuanto hay una decisión', async () => {
    const { doc } = await escenarioSimple();
    await recibir(doc.id);
    const pendientes = await recepcionesPendientes(receptor);
    expect(pendientes.map((p) => p.documentId)).not.toContain(doc.id);
  });

  it('2c. no hay ninguna tabla de pendientes: sólo filas de DECISIÓN', async () => {
    const { doc } = await escenarioSimple();
    /* Antes de decidir, `stock_receipt` está vacía y el pendiente igual se ve. */
    expect(await prisma.stockReceipt.count()).toBe(0);
    expect((await recepcionesPendientes(receptor)).length).toBeGreaterThan(0);

    await recibir(doc.id);
    expect(await prisma.stockReceipt.count()).toBe(1);
  });

  it('2d. un comprobante en borrador no es un pendiente de recepción', async () => {
    const p = await articulo('9001');
    await aperturaDe(escenario.sucursales.devoto, CORTE, [{ productId: p.id, cantidad: '10' }]);
    const doc = await comprobante({
      branchId: escenario.sucursales.devoto,
      renglones: [{ productId: p.id, cantidad: '5' }],
      status: 'BORRADOR',
    });
    expect((await recepcionesPendientes(receptor)).map((x) => x.documentId)).not.toContain(doc.id);
  });

  it('2e. el listado separa listas, bloqueadas y anteriores al corte', async () => {
    const bueno = await articulo('9001');
    const sinUnidad = await articulo('9002', null);
    await aperturaDe(escenario.sucursales.devoto, CORTE, [
      { productId: bueno.id, cantidad: '10' },
    ]);

    const lista = await comprobante({
      branchId: escenario.sucursales.devoto,
      renglones: [{ productId: bueno.id, cantidad: '5' }],
      issueDate: '2026-09-25',
    });
    const bloqueada = await comprobante({
      branchId: escenario.sucursales.devoto,
      renglones: [{ productId: sinUnidad.id, cantidad: '5' }],
      issueDate: '2026-09-25',
    });
    const vieja = await comprobante({
      branchId: escenario.sucursales.devoto,
      renglones: [{ productId: bueno.id, cantidad: '5' }],
      issueDate: '2026-09-20',
    });

    const l = await listadoDeRecepciones(receptor);
    expect(l.pendientes.map((x) => x.documentId)).toEqual([lista.id]);
    expect(l.bloqueadas.map((x) => x.documentId)).toEqual([bloqueada.id]);
    expect(l.anterioresAlCorte.map((x) => x.documentId)).toEqual([vieja.id]);
    expect(l.bloqueadas[0].motivos.join(' ')).toMatch(/unidad de existencia aprobada/i);
  });
});

/* ========================================================================== *
 * 3 a 5. Las tres barreras
 * ========================================================================== */

describe('las barreras que frenan una recepción', () => {
  it('3. una sucursal sin apertura confirmada bloquea', async () => {
    const p = await articulo('9001');
    /* San Martín queda sin apertura a propósito. */
    const doc = await comprobante({
      branchId: escenario.sucursales.sanMartin,
      renglones: [{ productId: p.id, cantidad: '5' }],
    });
    await expect(recibir(doc.id)).rejects.toThrow(/sin apertura|no tiene apertura/i);
    expect(await prisma.stockLedger.count({ where: { type: 'PURCHASE_IN' } })).toBe(0);
  });

  it('3b. el mensaje dice que no es lo mismo que tener cero', async () => {
    const p = await articulo('9001');
    const doc = await comprobante({
      branchId: escenario.sucursales.sanMartin,
      renglones: [{ productId: p.id, cantidad: '5' }],
    });
    const previa = await vistaPreviaDeRecepcion(receptor, { documentId: doc.id });
    expect(previa.impedimentos.join(' ')).toMatch(/están sin contar/i);
  });

  it('4. con el interruptor de recepciones reales apagado, una real se rechaza', async () => {
    /*
     * Hace falta una apertura REAL, y una apertura no se puede convertir: el
     * disparador de la fase 3 frena el UPDATE que cambie `ficticia`, que fue el
     * primer intento de escribir esta prueba y está bien que no funcione. Así
     * que se enciende el interruptor de APERTURAS —el otro, el de la fase 3—,
     * se inaugura de verdad y se lo vuelve a apagar.
     *
     * Los dos interruptores son dos decisiones distintas, y ésta es la prueba
     * de que lo son: con las aperturas reales habilitadas, las recepciones
     * reales siguen sin estarlo.
     */
    const { doc } = await aperturaRealCon('9001');

    expect((await interruptorDeRecepcionesReales()).encendido).toBe(false);
    await expect(recibir(doc.id)).rejects.toThrow(/interruptor de recepciones reales/i);
    expect(await prisma.stockLedger.count({ where: { type: 'PURCHASE_IN' } })).toBe(0);

    /* Y la negativa queda auditada: dice quién quiso recibir sin permiso. */
    expect(
      await prisma.auditLog.count({
        where: { action: AUDIT_ACTIONS.STOCKERP_BLOQUEADO_INTERRUPTOR },
      }),
    ).toBe(1);
  });

  it('4a. la base rechaza la recepción real aunque se escriba a mano', async () => {
    /* El servicio se puede saltear. El disparador no. */
    const { doc, sucursal } = await aperturaRealCon('9001');

    /*
     * La operación va aunque la fila nunca llegue a existir. Sin ella, la CHECK
     * `recepcion_aplicada_con_operacion` rechaza antes y la prueba pasaría por
     * la razón equivocada: diría que la base se negó, pero no por el
     * interruptor. Las dos defensas están, y cada una tiene que poder
     * comprobarse por separado.
     */
    const op = await prisma.stockOperation.create({
      data: {
        operationKey: 'a-mano',
        kind: 'RECEPCION_COMPRA',
        contentHash: 'x',
        branchId: sucursal,
      },
    });

    await expect(
      prisma.stockReceipt.create({
        data: {
          documentId: doc.id,
          branchId: sucursal,
          receivedAt: new Date(),
          resolution: 'APLICADA',
          operationId: op.id,
          decidedById: escenario.admin.id,
        },
      }),
    ).rejects.toThrow(/interruptor de recepciones reales/i);
    expect(await prisma.stockReceipt.count()).toBe(0);
  });

  it('4e. y la CHECK de la operación es una defensa aparte, que también está', async () => {
    const { doc, sucursal } = await aperturaRealCon('9001');
    await expect(
      prisma.stockReceipt.create({
        data: {
          documentId: doc.id,
          branchId: sucursal,
          receivedAt: new Date(),
          resolution: 'APLICADA',
          /* Sin operación: una recepción aplicada sin el asiento que la prueba. */
          decidedById: escenario.admin.id,
        },
      }),
    ).rejects.toThrow(/recepcion_aplicada_con_operacion/);
  });

  it('4b. el interruptor nace apagado y el seed no lo puede encender', async () => {
    const fila = await prisma.stockModuleSetting.findFirstOrThrow();
    expect(fila.realPurchaseReceiptsEnabled).toBe(false);
    /* Nada del sembrado lo nombra: resembrar no lo cambia. */
    await sembrarEscenario().catch(() => null);
    expect((await prisma.stockModuleSetting.findFirstOrThrow()).realPurchaseReceiptsEnabled).toBe(
      false,
    );
  });

  it('4c. cambiarlo exige el permiso, un motivo, y queda auditado', async () => {
    await expect(
      cambiarInterruptorDeRecepciones(receptor, { encender: true, motivo: 'porque sí' }),
    ).rejects.toThrow(/stockerp\.modulo\.configurar/);

    await expect(
      cambiarInterruptorDeRecepciones(jefeDeModulo, { encender: true, motivo: '   ' }),
    ).rejects.toThrow(/por qué/i);

    await cambiarInterruptorDeRecepciones(jefeDeModulo, {
      encender: true,
      motivo: 'Homologación del módulo, con el jefe de compras presente.',
    });
    const estado = await interruptorDeRecepcionesReales();
    expect(estado.encendido).toBe(true);
    expect(estado.motivo).toMatch(/Homologación/);

    const auditoria = await prisma.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.STOCKERP_RECEPCIONES_INTERRUPTOR },
    });
    expect(auditoria).not.toBeNull();

    /* Y se lo vuelve a dejar apagado: ninguna base queda con esto encendido. */
    await cambiarInterruptorDeRecepciones(jefeDeModulo, {
      encender: false,
      motivo: 'Fin de la homologación.',
    });
    expect((await interruptorDeRecepcionesReales()).encendido).toBe(false);
  });

  it('4d. no existe ninguna variable de entorno que encienda las recepciones', async () => {
    const fuente = await import('node:fs').then((fs) =>
      fs.readFileSync('src/lib/services/stock-erp-recepcion.ts', 'utf8'),
    );
    /* La única de entorno que se consulta es DATABASE_URL, para el nombre. */
    const usadas = [...fuente.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    expect([...new Set(usadas)]).toEqual(['DATABASE_URL']);
  });

  it('5. una base que no admite homologación rechaza la apertura ficticia', async () => {
    /*
     * La base de pruebas SÍ admite homologación, así que se comprueba por el
     * lado del servidor: la función que lo decide mira el nombre de la base, y
     * `prepararApertura` la consulta. Con el nombre cambiado, se niega.
     */
    expect(laBaseAdmiteHomologacion()).toBe(true);

    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/compras_produccion?schema=public';
    try {
      expect(laBaseAdmiteHomologacion()).toBe(false);
      await expect(
        prepararApertura(preparador, { branchId: escenario.sucursales.sanMartin, ficticia: true }),
      ).rejects.toThrow(/homologación/i);
    } finally {
      process.env.DATABASE_URL = original;
    }
  });

  it('5b. la casilla escondida no es la defensa: el servidor la rechaza igual', async () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/compras_produccion?schema=public';
    try {
      /* El pedido llega sin pasar por React, como lo mandaría cualquiera. */
      await expect(
        prepararApertura(preparador, { branchId: escenario.sucursales.sanMartin, ficticia: true }),
      ).rejects.toThrow();
      expect(
        await prisma.stockCountSession.count({ where: { branchId: escenario.sucursales.sanMartin } }),
      ).toBe(0);
    } finally {
      process.env.DATABASE_URL = original;
    }
  });
});

/* ========================================================================== *
 * 6 a 10. La fecha física y el corte
 * ========================================================================== */

describe('la fecha de recepción es la física, y el corte no se cruza', () => {
  it('6. receivedAt no se copia de la fecha del comprobante', async () => {
    const p = await articulo('9001');
    await aperturaDe(escenario.sucursales.devoto, CORTE, [{ productId: p.id, cantidad: '10' }]);
    const doc = await comprobante({
      branchId: escenario.sucursales.devoto,
      renglones: [{ productId: p.id, cantidad: '5' }],
      issueDate: '2026-09-25',
    });

    await recibir(doc.id, { fecha: '2026-09-28', hora: '07:15' });

    const recibo = await prisma.stockReceipt.findUniqueOrThrow({ where: { documentId: doc.id } });
    const esperado = instanteDesdeHoraArgentina('2026-09-28', '07:15');
    expect(recibo.receivedAt.toISOString()).toBe(esperado.toISOString());

    const documento = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(recibo.receivedAt.toISOString()).not.toBe(documento.issueDate?.toISOString());
  });

  it('7. comprobante anterior al corte, recibido después: ingresa', async () => {
    const p = await articulo('9001');
    await aperturaDe(escenario.sucursales.devoto, CORTE, [{ productId: p.id, cantidad: '10' }]);
    const doc = await comprobante({
      branchId: escenario.sucursales.devoto,
      renglones: [{ productId: p.id, cantidad: '5' }],
      issueDate: '2026-09-20',
    });

    const r = await recibir(doc.id, DESPUES);
    expect(r.resolucion).toBe('APLICADA');
    expect(r.movimientos).toBe(1);
  });

  it('8. comprobante posterior al corte, recibido antes: NO ingresa', async () => {
    const p = await articulo('9001');
    await aperturaDe(escenario.sucursales.devoto, CORTE, [{ productId: p.id, cantidad: '10' }]);
    const doc = await comprobante({
      branchId: escenario.sucursales.devoto,
      renglones: [{ productId: p.id, cantidad: '5' }],
      issueDate: '2026-09-30',
    });

    const r = await recibir(doc.id, ANTES);
    expect(r.resolucion).toBe('INCLUIDA_EN_APERTURA');
    expect(r.movimientos).toBe(0);
    expect(await prisma.stockLedger.count({ where: { type: 'PURCHASE_IN' } })).toBe(0);
  });

  it('9. exactamente en el corte es INCLUIDA_EN_APERTURA, no APLICADA', async () => {
    const { doc } = await escenarioSimple();
    /* El mismo instante del corte, al minuto. */
    const r = await recibir(doc.id, CORTE);
    expect(r.resolucion).toBe('INCLUIDA_EN_APERTURA');
    expect(r.movimientos).toBe(0);
  });

  it('9b. un minuto después del corte sí aplica: el límite es exacto', async () => {
    const { doc } = await escenarioSimple();
    const r = await recibir(doc.id, { fecha: CORTE.fecha, hora: '20:31' });
    expect(r.resolucion).toBe('APLICADA');
  });

  it('9c. la decisión queda registrada, con su motivo, y no se repite', async () => {
    const { doc } = await escenarioSimple();
    await recibir(doc.id, ANTES);
    const recibo = await prisma.stockReceipt.findUniqueOrThrow({ where: { documentId: doc.id } });
    expect(recibo.resolution).toBe('INCLUIDA_EN_APERTURA');
    expect(recibo.reason).toMatch(/ya está contada en la apertura/i);
    expect(recibo.operationId).not.toBeNull();
  });

  it('10. ninguna excepción histórica escribe un movimiento antes del corte', async () => {
    const conExcepcion = con([
      PERMISSIONS.STOCKERP_RECEPCION_PREPARAR,
      PERMISSIONS.STOCKERP_RECEPCION_CONFIRMAR,
      PERMISSIONS.STOCKERP_EXCEPCION_HISTORICA,
      PERMISSIONS.STOCKERP_APERTURA_PREPARAR,
      PERMISSIONS.STOCKERP_APERTURA_CONFIRMAR,
      PERMISSIONS.STOCKERP_ACTIVACION_HABILITAR,
      PERMISSIONS.STOCKERP_UNIDADES_CONFIGURAR,
    ]);
    const { doc } = await escenarioSimple();

    const r = await recibir(
      doc.id,
      ANTES,
      { excepcionHistorica: true, motivo: 'El encargado sostiene que no estaba en la góndola.' },
      conExcepcion,
    );
    expect(r.resolucion).toBe('INCLUIDA_EN_APERTURA');
    expect(r.movimientos).toBe(0);
    expect(await prisma.stockLedger.count({ where: { type: 'PURCHASE_IN' } })).toBe(0);

    const recibo = await prisma.stockReceipt.findUniqueOrThrow({ where: { documentId: doc.id } });
    expect(recibo.manualOverride, 'queda marcada como decisión forzada').toBe(true);
    expect(recibo.reason).toMatch(/no estaba en la góndola/);
  });

  it('10b. la base rechaza un ingreso anterior al corte aunque se escriba a mano', async () => {
    /*
     * El servicio se puede saltear con una consulta. Ésta es la defensa que no:
     * se intenta el INSERT directo, que es lo que haría alguien con acceso a la
     * base, y el disparador lo frena.
     */
    const p = await articulo('9001');
    await aperturaDe(escenario.sucursales.devoto, CORTE, [{ productId: p.id, cantidad: '10' }]);
    const antesDelCorte = instanteDesdeHoraArgentina(ANTES.fecha, ANTES.hora);
    const op = await prisma.stockOperation.create({
      data: {
        operationKey: 'a-mano',
        kind: 'RECEPCION_COMPRA',
        contentHash: 'x',
        branchId: escenario.sucursales.devoto,
      },
    });

    await expect(
      prisma.$executeRaw`
        INSERT INTO "stock_ledger"
          ("id","txId","productId","pluHistorico","branchId","type","direction",
           "quantity","unit","effectiveAt","operationId","idempotencyKey",
           "balanceAfterSeq","createdAt")
        VALUES ('a-mano-1', txid_current(), ${p.id}, '9001',
                ${escenario.sucursales.devoto},
                'PURCHASE_IN'::"StockMovementType", 'IN'::"StockDirection",
                5::numeric, 'KG'::"StockUnit", ${antesDelCorte}, ${op.id},
                'a-mano-1', 15::numeric, now())`,
    ).rejects.toThrow(/anterior o igual al corte/i);
  });
});

/* ========================================================================== *
 * 11 a 18. Qué entra y qué no, renglón por renglón
 * ========================================================================== */

describe('la clasificación de cada renglón', () => {
  it('11. un comprobante de sólo gastos queda EXCLUIDA, sin movimientos', async () => {
    await articulo('9001');
    await aperturaDe(escenario.sucursales.devoto);
    const doc = await comprobante({
      branchId: escenario.sucursales.devoto,
      renglones: [
        { cantidad: '1', gasto: 'FLETE', descripcion: 'FLETE' },
        { cantidad: '1', gasto: 'EMBALAJE', descripcion: 'CAJONES' },
      ],
    });

    const r = await recibir(doc.id);
    expect(r.resolucion).toBe('EXCLUIDA');
    expect(r.movimientos).toBe(0);
    expect(await prisma.stockLedger.count({ where: { type: 'PURCHASE_IN' } })).toBe(0);
  });

  it('12. en un comprobante mixto, el gasto no genera movimiento y la mercadería sí', async () => {
    const p = await articulo('9001');
    await aperturaDe(escenario.sucursales.devoto, CORTE, [{ productId: p.id, cantidad: '10' }]);
    const doc = await comprobante({
      branchId: escenario.sucursales.devoto,
      renglones: [
        { productId: p.id, cantidad: '5' },
        { cantidad: '1', gasto: 'FLETE', descripcion: 'FLETE' },
      ],
    });

    const previa = await vistaPreviaDeRecepcion(receptor, { documentId: doc.id });
    expect(previa.renglones.map((x) => x.clase)).toEqual(['MERCADERIA', 'GASTO_SIN_IMPACTO']);

    const r = await recibir(doc.id);
    expect(r.movimientos).toBe(1);
    const movs = await prisma.stockLedger.findMany({ where: { type: 'PURCHASE_IN' } });
    expect(movs).toHaveLength(1);
    expect(movs[0].productId).toBe(p.id);
  });

  it('13. un renglón sin artículo bloquea, y no se crea ningún producto', async () => {
    await articulo('9001');
    await aperturaDe(escenario.sucursales.devoto);
    const cuantos = await prisma.product.count();
    const doc = await comprobante({
      branchId: escenario.sucursales.devoto,
      renglones: [{ productId: null, cantidad: '5', descripcion: 'ALGO QUE NADIE RECONOCIÓ' }],
    });

    await expect(recibir(doc.id)).rejects.toThrow(/no tiene artículo asociado/i);
    expect(await prisma.product.count(), 'no se dio de alta nada').toBe(cuantos);
  });

  it('14. un artículo inactivo bloquea', async () => {
    const p = await articulo('9001', 'KG', false);
    await aperturaDe(escenario.sucursales.devoto);
    const doc = await comprobante({
      branchId: escenario.sucursales.devoto,
      renglones: [{ productId: p.id, cantidad: '5' }],
    });
    await expect(recibir(doc.id)).rejects.toThrow(/inactivo/i);
  });

  it('15. un artículo con la unidad de existencia pendiente bloquea', async () => {
    const p = await articulo('9002', null);
    await aperturaDe(escenario.sucursales.devoto);
    const doc = await comprobante({
      branchId: escenario.sucursales.devoto,
      renglones: [{ productId: p.id, cantidad: '5' }],
    });
    await expect(recibir(doc.id)).rejects.toThrow(/unidad de existencia aprobada/i);
  });

  it('16. la factura dice UNIT, la existencia es KG y no hay conversión: bloquea', async () => {
    const p = await articulo('9001', 'KG');
    await aperturaDe(escenario.sucursales.devoto, CORTE, [{ productId: p.id, cantidad: '10' }]);
    const doc = await comprobante({
      branchId: escenario.sucursales.devoto,
      renglones: [{ productId: p.id, cantidad: '3', unidad: 'UNIT' }],
    });
    await expect(recibir(doc.id)).rejects.toThrow(/conversión aprobada/i);
    expect(await prisma.stockLedger.count({ where: { type: 'PURCHASE_IN' } })).toBe(0);
  });

  it('17. con la presentación aprobada, la conversión es exacta y usa Decimal', async () => {
    const p = await articulo('9001', 'KG');
    await aperturaDe(escenario.sucursales.devoto, CORTE, [{ productId: p.id, cantidad: '0' }]);
    /* Una caja de 0,1 kg: el factor que en binario deja de ser 0,1. */
    await guardarPresentacion(preparador, {
      productId: p.id,
      unidadDeCompra: 'UNIT',
      factor: '0.1',
      aprobar: true,
      confirmado: true,
    });
    const doc = await comprobante({
      branchId: escenario.sucursales.devoto,
      renglones: [{ productId: p.id, cantidad: '3', unidad: 'UNIT' }],
    });

    const r = await recibir(doc.id);
    expect(r.movimientos).toBe(1);
    const mov = await prisma.stockLedger.findFirstOrThrow({ where: { type: 'PURCHASE_IN' } });
    /*
     * 3 × 0,1. Con `Number` daría 0.30000000000000004; con Decimal da 0,3
     * exacto, y así queda escrito en el libro.
     */
    expect(new Decimal(mov.quantity.toString()).equals(new Decimal('0.3'))).toBe(true);
    expect(mov.conversionFactorUsed?.toString()).toBe('0.1');
    expect(mov.invoicedUnit).toBe('UNIT');
    expect(new Decimal(mov.invoicedQuantity!.toString()).equals(new Decimal('3'))).toBe(true);
  });

  it('18. 4.2401 se rechaza ANTES de cualquier cast o redondeo', async () => {
    const p = await articulo('9001');
    await aperturaDe(escenario.sucursales.devoto, CORTE, [{ productId: p.id, cantidad: '10' }]);
    const doc = await comprobante({
      branchId: escenario.sucursales.devoto,
      renglones: [{ productId: p.id, cantidad: '4.2401' }],
    });

    const previa = await vistaPreviaDeRecepcion(receptor, { documentId: doc.id });
    expect(previa.renglones[0].clase).toBe('BLOQUEADO');
    expect(previa.renglones[0].motivo).toMatch(/tres decimales/i);

    await expect(recibir(doc.id)).rejects.toThrow(/tres decimales/i);
    /* Y no quedó ningún 4,240 escrito en ningún lado. */
    expect(await prisma.stockLedger.count()).toBe(1); // sólo la apertura del 9001
    expect(await prisma.stockReceipt.count()).toBe(0);
  });

  it('18b. 4.240 sí entra: el rechazo es por la escala, no por el número', async () => {
    const p = await articulo('9001');
    await aperturaDe(escenario.sucursales.devoto, CORTE, [{ productId: p.id, cantidad: '10' }]);
    const doc = await comprobante({
      branchId: escenario.sucursales.devoto,
      renglones: [{ productId: p.id, cantidad: '4.2400' }],
    });
    const r = await recibir(doc.id);
    expect(r.movimientos).toBe(1);
    const mov = await prisma.stockLedger.findFirstOrThrow({ where: { type: 'PURCHASE_IN' } });
    expect(new Decimal(mov.quantity.toString()).equals(new Decimal('4.24'))).toBe(true);
  });

  it('no se asocia un producto por parecido de nombre', async () => {
    const p = await articulo('9001');
    await aperturaDe(escenario.sucursales.devoto, CORTE, [{ productId: p.id, cantidad: '10' }]);
    const doc = await comprobante({
      branchId: escenario.sucursales.devoto,
      /* La descripción es EXACTAMENTE el nombre del artículo, y aun así no basta. */
      renglones: [{ productId: null, cantidad: '5', descripcion: 'ARTICULO FICTICIO 9001' }],
    });
    await expect(recibir(doc.id)).rejects.toThrow(/no tiene artículo asociado/i);
  });
});

/* ========================================================================== *
 * 19. Dos renglones del mismo artículo
 * ========================================================================== */

describe('dos renglones del mismo artículo', () => {
  it('19. generan DOS movimientos, cada uno con su renglón, y el saldo encadena', async () => {
    const p = await articulo('9001');
    await aperturaDe(escenario.sucursales.devoto, CORTE, [{ productId: p.id, cantidad: '10' }]);
    const doc = await comprobante({
      branchId: escenario.sucursales.devoto,
      renglones: [
        { productId: p.id, cantidad: '2.5', descripcion: 'PRIMERA HORMA' },
        { productId: p.id, cantidad: '3.25', descripcion: 'SEGUNDA HORMA' },
      ],
    });

    const r = await recibir(doc.id);
    expect(r.movimientos).toBe(2);

    const movs = await prisma.stockLedger.findMany({
      where: { type: 'PURCHASE_IN' },
      orderBy: { documentItemId: 'asc' },
    });
    expect(movs).toHaveLength(2);

    /* Cada uno conserva SU renglón: no se agruparon. */
    const renglones = new Set(movs.map((m) => m.documentItemId));
    expect(renglones.size).toBe(2);

    /* Y el saldo posterior de cada uno refleja el saldo real en ese punto. */
    const saldos = movs.map((m) => new Decimal(m.balanceAfterSeq.toString()).toString());
    expect(saldos).toEqual(['12.5', '15.75']);

    const balance = await prisma.stockBalance.findFirstOrThrow({ where: { productId: p.id } });
    expect(new Decimal(balance.quantity.toString()).equals(new Decimal('15.75'))).toBe(true);
    expect(balance.lastLedgerId, 'termina en el último renglón').toBe(movs[1].id);
  });

  it('19b. el orden es estable por documentItemId, no por azar', async () => {
    const p = await articulo('9001');
    await aperturaDe(escenario.sucursales.devoto, CORTE, [{ productId: p.id, cantidad: '0' }]);
    const doc = await comprobante({
      branchId: escenario.sucursales.devoto,
      renglones: [
        { productId: p.id, cantidad: '1' },
        { productId: p.id, cantidad: '2' },
        { productId: p.id, cantidad: '4' },
      ],
    });
    await recibir(doc.id);

    const movs = await prisma.stockLedger.findMany({
      where: { type: 'PURCHASE_IN' },
      orderBy: { documentItemId: 'asc' },
    });
    const acumulados = movs.map((m) => new Decimal(m.balanceAfterSeq.toString()));
    /* Sean cuales sean los ids, cada saldo es el anterior más su cantidad. */
    for (let i = 1; i < acumulados.length; i += 1) {
      expect(acumulados[i].greaterThan(acumulados[i - 1])).toBe(true);
    }
    expect(acumulados[acumulados.length - 1].equals(new Decimal('7'))).toBe(true);
  });
});

/* ========================================================================== *
 * 22 a 28. Idempotencia
 * ========================================================================== */

describe('idempotencia: la misma recepción dos veces no duplica', () => {
  it('22. misma clave y misma huella devuelven ALREADY_APPLIED', async () => {
    const { doc } = await escenarioSimple();
    const primera = await recibir(doc.id);
    expect(primera.yaEstabaAplicada).toBe(false);

    const segunda = await recibir(doc.id);
    expect(segunda.yaEstabaAplicada).toBe(true);
    expect(segunda.operationId).toBe(primera.operationId);
    expect(segunda.movimientos).toBe(primera.movimientos);

    expect(await prisma.stockLedger.count({ where: { type: 'PURCHASE_IN' } })).toBe(1);
    expect(await prisma.stockReceipt.count()).toBe(1);
  });

  it('23. misma clave con otra fecha de recepción es un CONFLICTO, y no escribe', async () => {
    const { doc } = await escenarioSimple();
    await recibir(doc.id, DESPUES);

    const antes = await prisma.stockLedger.count();
    await expect(recibir(doc.id, { fecha: '2026-09-26', hora: '10:00' })).rejects.toThrow(
      /contenido distinto/i,
    );
    expect(await prisma.stockLedger.count()).toBe(antes);

    /* La fecha guardada no se movió. */
    const recibo = await prisma.stockReceipt.findUniqueOrThrow({ where: { documentId: doc.id } });
    expect(recibo.receivedAt.toISOString()).toBe(
      instanteDesdeHoraArgentina(DESPUES.fecha, DESPUES.hora).toISOString(),
    );
  });

  it('23b. una violación de unicidad NO alcanza para decir «ya aplicado»', async () => {
    /*
     * Es la trampa del asunto. Chocar con la unicidad sólo dice que hubo un
     * choque; contestar «ya estaba» sin comparar la huella haría pasar por
     * atendida una confirmación con otro contenido.
     */
    const { doc } = await escenarioSimple();
    await recibir(doc.id);

    /* Otra confirmación, con otra fecha: choca y NO se la trata como repetida. */
    const r = await recibir(doc.id, { fecha: '2026-09-27', hora: '08:00' }).catch((e) => e);
    expect(r).toBeInstanceOf(Error);
    expect(String(r.message)).toMatch(/contenido distinto/i);
  });

  it('24. si la respuesta se pierde después del commit, el reintento devuelve lo guardado', async () => {
    const { doc } = await escenarioSimple();
    const primera = await recibir(doc.id);

    /* El reintento llega con exactamente lo mismo, como lo mandaría el botón. */
    const reintento = await recibir(doc.id);
    expect(reintento.operationId).toBe(primera.operationId);
    expect(reintento.receivedAt).toBe(primera.receivedAt);
    expect(reintento.yaEstabaAplicada).toBe(true);
    expect(await prisma.stockLedger.count({ where: { type: 'PURCHASE_IN' } })).toBe(1);
  });

  it('28. al volver a abrir la pantalla, el resultado guardado está ahí', async () => {
    /*
     * El lado servidor de «se cortó el teléfono y volví a entrar». La vista
     * previa no recalcula una decisión: lee la que se tomó, con su fecha y con
     * quién la tomó, y la devuelve. Si esto no estuviera, la pantalla al
     * reabrirse ofrecería recibir otra vez algo ya recibido.
     */
    const { doc } = await escenarioSimple();
    const aplicada = await recibir(doc.id, { fecha: '2026-09-26', hora: '14:45' });

    const alVolver = await vistaPreviaDeRecepcion(receptor, { documentId: doc.id });
    expect(alVolver.yaDecidida).not.toBeNull();
    expect(alVolver.yaDecidida!.resolucion).toBe('APLICADA');
    expect(alVolver.yaDecidida!.receivedAt.toISOString()).toBe(aplicada.receivedAt);
    expect(alVolver.yaDecidida!.decididaPor).toBe(escenario.admin.name);

    /* Y el resultado completo sigue guardado en la operación, no recalculado. */
    const op = await prisma.stockOperation.findUniqueOrThrow({
      where: { operationKey: claveDeRecepcion(doc.id) },
    });
    const guardado = op.result as { movimientos: number; renglones: unknown[] };
    expect(guardado.movimientos).toBe(1);
    expect(guardado.renglones).toHaveLength(1);
  });

  it('25. dos confirmaciones simultáneas: una aplica y la otra no duplica', async () => {
    const { doc } = await escenarioSimple();
    const resultados = await Promise.allSettled([recibir(doc.id), recibir(doc.id)]);

    const cumplidas = resultados.filter((r) => r.status === 'fulfilled');
    expect(cumplidas.length, 'al menos una contesta bien').toBeGreaterThanOrEqual(1);

    /* Lo que importa, sea cual sea el orden: una sola vez escrito. */
    expect(await prisma.stockLedger.count({ where: { type: 'PURCHASE_IN' } })).toBe(1);
    expect(await prisma.stockReceipt.count()).toBe(1);
    expect(await prisma.stockOperation.count({ where: { kind: 'RECEPCION_COMPRA' } })).toBe(1);
  });

  it('26. un fallo en el medio no deja nada escrito', async () => {
    const p = await articulo('9001');
    await aperturaDe(escenario.sucursales.devoto, CORTE, [{ productId: p.id, cantidad: '10' }]);
    const doc = await comprobante({
      branchId: escenario.sucursales.devoto,
      renglones: [
        { productId: p.id, cantidad: '2' },
        { productId: p.id, cantidad: '3' },
      ],
    });

    /*
     * La caída se provoca DESDE LA BASE, con un disparador que revienta en el
     * segundo renglón. Un espía sobre el cliente de Prisma no serviría: adentro
     * de la transacción el servicio usa `tx`, que es otro objeto, así que la
     * prueba pasaría sin haber interrumpido nada.
     *
     * Si la transacción no fuera todo o nada, quedaría el primer movimiento
     * escrito y el segundo no: media recepción, que es peor que ninguna.
     */
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION caida_simulada() RETURNS trigger AS $fn$
      BEGIN
        IF NEW."quantity" = 3 THEN
          RAISE EXCEPTION 'caída simulada a mitad de la recepción';
        END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "caida_simulada" BEFORE INSERT ON "stock_ledger"
      FOR EACH ROW EXECUTE FUNCTION caida_simulada()`);

    try {
      await expect(recibir(doc.id)).rejects.toThrow(/caída simulada/);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER "caida_simulada" ON "stock_ledger"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION caida_simulada()`);
    }

    expect(await prisma.stockLedger.count({ where: { type: 'PURCHASE_IN' } })).toBe(0);
    expect(await prisma.stockReceipt.count()).toBe(0);
    expect(await prisma.stockOperation.count({ where: { kind: 'RECEPCION_COMPRA' } })).toBe(0);
    const saldo = await prisma.stockBalance.findFirstOrThrow({ where: { productId: p.id } });
    expect(new Decimal(saldo.quantity.toString()).equals(new Decimal('10'))).toBe(true);
  });

  it('26b. y después del fallo la misma recepción se puede volver a intentar', async () => {
    const { doc } = await escenarioSimple();
    const r = await recibir(doc.id);
    expect(r.resolucion).toBe('APLICADA');
  });

  it('27. la base impide dos recepciones del mismo comprobante', async () => {
    const { doc } = await escenarioSimple();
    await recibir(doc.id);
    const recibo = await prisma.stockReceipt.findUniqueOrThrow({ where: { documentId: doc.id } });

    await expect(
      prisma.stockReceipt.create({
        data: {
          documentId: doc.id,
          branchId: escenario.sucursales.devoto,
          receivedAt: new Date(),
          resolution: 'EXCLUIDA',
          decidedById: escenario.admin.id,
        },
      }),
    ).rejects.toThrow();

    expect(await prisma.stockReceipt.count({ where: { documentId: doc.id } })).toBe(1);
    expect((await prisma.stockReceipt.findUniqueOrThrow({ where: { documentId: doc.id } })).id).toBe(
      recibo.id,
    );
  });

  it('27b. y la fecha de una recepción decidida no se cambia ni por SQL', async () => {
    const { doc } = await escenarioSimple();
    await recibir(doc.id);
    await expect(
      prisma.$executeRaw`UPDATE "stock_receipt" SET "receivedAt" = now() WHERE "documentId" = ${doc.id}`,
    ).rejects.toThrow(/no se cambia después de decidida/i);
  });

  it('22b. la clave y la huella no dependen del reloj', async () => {
    const { doc } = await escenarioSimple();
    expect(claveDeRecepcion(doc.id)).toBe(`recepcion:${doc.id}`);

    const previa = await vistaPreviaDeRecepcion(receptor, { documentId: doc.id });
    const datos = {
      documentId: doc.id,
      branchId: previa.branchId,
      receivedAt: instanteDesdeHoraArgentina(DESPUES.fecha, DESPUES.hora),
      resolucion: 'APLICADA' as const,
      renglones: previa.renglones,
    };
    const a = huellaDeRecepcion(datos);
    await new Promise((r) => setTimeout(r, 30));
    expect(huellaDeRecepcion(datos), 'dos veces, con el reloj corrido').toBe(a);

    /* Y el orden de los renglones no la cambia: se ordenan antes de firmar. */
    expect(huellaDeRecepcion({ ...datos, renglones: [...previa.renglones].reverse() })).toBe(a);
  });

  it('22c. la huella cambia si cambia cualquier cosa que importa', async () => {
    const { doc } = await escenarioSimple();
    const previa = await vistaPreviaDeRecepcion(receptor, { documentId: doc.id });
    const base = {
      documentId: doc.id,
      branchId: previa.branchId,
      receivedAt: instanteDesdeHoraArgentina(DESPUES.fecha, DESPUES.hora),
      resolucion: 'APLICADA' as const,
      renglones: previa.renglones,
    };
    const original = huellaDeRecepcion(base);

    expect(
      huellaDeRecepcion({ ...base, receivedAt: instanteDesdeHoraArgentina('2026-09-25', '09:00') }),
      'otra fecha física',
    ).not.toBe(original);
    expect(
      huellaDeRecepcion({ ...base, resolucion: 'INCLUIDA_EN_APERTURA' }),
      'otra resolución',
    ).not.toBe(original);
    expect(
      huellaDeRecepcion({
        ...base,
        renglones: previa.renglones.map((r) => ({ ...r, cantidadDeExistencia: '99' })),
      }),
      'otra cantidad',
    ).not.toBe(original);
  });

  it('22d. la huella incluye los renglones excluidos y su motivo', async () => {
    const p = await articulo('9001');
    await aperturaDe(escenario.sucursales.devoto, CORTE, [{ productId: p.id, cantidad: '10' }]);
    const doc = await comprobante({
      branchId: escenario.sucursales.devoto,
      renglones: [
        { productId: p.id, cantidad: '5' },
        { cantidad: '1', gasto: 'FLETE', descripcion: 'FLETE' },
      ],
    });
    const previa = await vistaPreviaDeRecepcion(receptor, { documentId: doc.id });
    const base = {
      documentId: doc.id,
      branchId: previa.branchId,
      receivedAt: instanteDesdeHoraArgentina(DESPUES.fecha, DESPUES.hora),
      resolucion: 'APLICADA' as const,
      renglones: previa.renglones,
    };
    /* Sin el gasto, la huella es otra: el gasto forma parte de lo firmado. */
    expect(
      huellaDeRecepcion({ ...base, renglones: previa.renglones.filter((r) => r.clase !== 'GASTO_SIN_IMPACTO') }),
    ).not.toBe(huellaDeRecepcion(base));
    /* Y cambiar el motivo del excluido también la cambia. */
    expect(
      huellaDeRecepcion({
        ...base,
        renglones: previa.renglones.map((r) =>
          r.clase === 'GASTO_SIN_IMPACTO' ? { ...r, motivo: 'otro motivo' } : r,
        ),
      }),
    ).not.toBe(huellaDeRecepcion(base));
  });

  it('la versión de la huella viaja con la operación', async () => {
    const { doc } = await escenarioSimple();
    const r = await recibir(doc.id);
    const op = await prisma.stockOperation.findUniqueOrThrow({ where: { id: r.operationId! } });
    expect(op.hashVersion).toBe(VERSION_DE_LA_HUELLA_DE_RECEPCION);
    expect(op.operationKey).toBe(claveDeRecepcion(doc.id));
    expect(op.result).not.toBeNull();
  });
});

/* ========================================================================== *
 * 29 a 32. Lo que esta fase NO hace
 * ========================================================================== */

describe('el receptor es el libro local, y nada más', () => {
  it('29. mirar la vista previa no escribe absolutamente nada', async () => {
    const { doc } = await escenarioSimple();
    const contar = async () => ({
      ledger: await prisma.stockLedger.count(),
      recibos: await prisma.stockReceipt.count(),
      operaciones: await prisma.stockOperation.count(),
      saldos: await prisma.stockBalance.count(),
      auditoria: await prisma.auditLog.count(),
      bandeja: await prisma.stockOutbox.count(),
    });

    const antes = await contar();
    await vistaPreviaDeRecepcion(receptor, { documentId: doc.id });
    await vistaPreviaDeRecepcion(receptor, { documentId: doc.id, receivedAt: new Date() });
    await listadoDeRecepciones(receptor);
    expect(await contar()).toEqual(antes);
  });

  it('30. ni validar ni recibir escriben una fila de StockOutbox', async () => {
    /*
     * HALLAZGO de una rotura deliberada. La primera versión de esta prueba
     * armaba el comprobante con Prisma y sólo miraba la recepción, así que
     * volver a encender la anotación en la bandeja —`confirmDocument` llamando
     * a `anotarIngresos`— no ponía NADA en rojo acá. El camino que hay que
     * recorrer es el completo: validar de verdad y después recibir.
     */
    const p = await articulo('9001');
    await aperturaDe(escenario.sucursales.devoto, CORTE, [{ productId: p.id, cantidad: '10' }]);
    const borrador = await createDocument(escenario.admin, escenario.sucursales.devoto);
    const validado = await confirmDocument(escenario.admin, {
      documentId: borrador.id,
      supplierId: escenario.proveedorId,
      docType: 'FACTURA',
      letter: 'A',
      pointOfSale: '0001',
      number: '77701',
      issueDate: '2026-09-24',
      printed: { netTotal: '1000.00', ivaTotal: '210.00', total: '1210.00' },
      items: [
        {
          lineNumber: 1,
          supplierCode: 'X1',
          description: 'ARTICULO FICTICIO 9001',
          /* 10 × 100 = 1.000, que es el neto impreso: el comprobante cierra. */
          quantity: '10',
          unit: 'KG' as const,
          unitNetPrice: '100',
          discountPct: '0',
          ivaRate: '0.21',
          productId: p.id,
          matchMethod: 'MANUAL',
          clasificacion: 'MERCADERIA' as const,
          expenseKind: null,
        },
      ],
      payment: { dueDate: '2026-10-24', paymentMethod: 'TRANSFERENCIA', notes: null },
    });

    expect(await prisma.stockOutbox.count(), 'validar no anota la bandeja').toBe(0);
    await recibir(validado.documentId);
    expect(await prisma.stockOutbox.count(), 'recibir tampoco').toBe(0);
    /* Y la mercadería sí entró: el cero de la bandeja no es porque no pasó nada. */
    expect(await prisma.stockLedger.count({ where: { type: 'PURCHASE_IN' } })).toBe(1);
  });

  it('31. el servicio no hace una sola llamada HTTP', async () => {
    const { doc } = await escenarioSimple();
    const fetchFalso = vi.fn(async () => {
      throw new Error('Esta fase no sale a la red.');
    });
    vi.stubGlobal('fetch', fetchFalso);
    try {
      await recibir(doc.id);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it('32. no se le manda ni un movimiento a Control de Stock', async () => {
    const { doc } = await escenarioSimple();
    await recibir(doc.id);
    /*
     * La bandeja es el único camino que existía hacia la otra aplicación, y
     * quedó vacía. El código de la recepción tampoco la nombra.
     */
    expect(await prisma.stockOutbox.count()).toBe(0);
    const fuente = await import('node:fs').then((fs) =>
      fs.readFileSync('src/lib/services/stock-erp-recepcion.ts', 'utf8'),
    );
    expect(fuente).not.toMatch(/stockOutbox\s*\./);
    expect(fuente).not.toMatch(/despachar|STOCK_INTEGRATION_WRITE_URL/);
  });

  it('no se implementaron ventas, devoluciones, traslados ni ajustes', async () => {
    const { doc } = await escenarioSimple();
    await recibir(doc.id);
    const tipos = await prisma.stockLedger.groupBy({ by: ['type'], _count: true });
    expect(tipos.map((t) => t.type).sort()).toEqual(['OPENING_BALANCE', 'PURCHASE_IN']);
  });
});

/* ========================================================================== *
 * 33 a 35. Permisos
 * ========================================================================== */

describe('los permisos no se ensanchan solos', () => {
  it('33. resembrar no le agrega permisos a ningún rol', async () => {
    const antes = await prisma.role.findMany({ orderBy: { code: 'asc' } });
    await sembrarEscenario().catch(() => null);
    const despues = await prisma.role.findMany({
      where: { id: { in: antes.map((r) => r.id) } },
      orderBy: { code: 'asc' },
    });
    expect(despues.map((r) => r.permissions)).toEqual(antes.map((r) => r.permissions));
  });

  it('34. una base nueva no le da los permisos sensibles al administrador', async () => {
    for (const sensible of PERMISOS_SENSIBLES_DE_STOCK_ERP) {
      expect(ADMIN_PERMISSIONS, `${sensible} no se hereda`).not.toContain(sensible);
    }
    expect(PERMISOS_SENSIBLES_DE_STOCK_ERP).toContain(PERMISSIONS.STOCKERP_RECEPCION_CONFIRMAR);
    expect(PERMISOS_SENSIBLES_DE_STOCK_ERP).toContain(PERMISSIONS.STOCKERP_EXCEPCION_HISTORICA);
    expect(PERMISOS_SENSIBLES_DE_STOCK_ERP).toContain(PERMISSIONS.STOCKERP_MODULO_CONFIGURAR);

    /* Y preparar NO es sensible: mirar antes de confirmar tiene que ser fácil. */
    expect(PERMISOS_SENSIBLES_DE_STOCK_ERP).not.toContain(PERMISSIONS.STOCKERP_RECEPCION_PREPARAR);
    expect(ADMIN_PERMISSIONS).toContain(PERMISSIONS.STOCKERP_RECEPCION_PREPARAR);

    /* El rol administrador sembrado, en la base, tampoco los tiene. */
    const admin = await prisma.role.findFirstOrThrow({ where: { code: 'ADMIN' } });
    for (const sensible of PERMISOS_SENSIBLES_DE_STOCK_ERP) {
      expect(admin.permissions).not.toContain(sensible);
    }
  });

  it('34b. sin el permiso de confirmar, la recepción se rechaza y queda auditada', async () => {
    const { doc } = await escenarioSimple();
    await expect(recibir(doc.id, DESPUES, {}, preparador)).rejects.toThrow(
      /stockerp\.recepcion\.confirmar/,
    );
    const rechazo = await prisma.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.STOCKERP_INTENTO_RECHAZADO, entityId: doc.id },
    });
    expect(rechazo).not.toBeNull();
    expect(await prisma.stockReceipt.count()).toBe(0);
  });

  it('35. stock.sincronizar sigue significando lo mismo y no se reasignó', async () => {
    expect(PERMISSIONS.STOCK_SINCRONIZAR).toBe('stock.sincronizar');
    const fuente = await import('node:fs').then((fs) =>
      fs.readFileSync('src/lib/services/stock-erp-recepcion.ts', 'utf8'),
    );
    expect(fuente, 'la recepción no usa el permiso del transporte externo').not.toMatch(
      /STOCK_SINCRONIZAR/,
    );
  });

  it('la excepción histórica exige su propio permiso y un motivo', async () => {
    const { doc } = await escenarioSimple();
    await expect(
      recibir(doc.id, ANTES, { excepcionHistorica: true, motivo: 'algo' }),
    ).rejects.toThrow(/stockerp\.excepcion\.historica/);

    const conExcepcion = con([
      PERMISSIONS.STOCKERP_RECEPCION_CONFIRMAR,
      PERMISSIONS.STOCKERP_EXCEPCION_HISTORICA,
    ]);
    await expect(
      recibir(doc.id, ANTES, { excepcionHistorica: true, motivo: '  ' }, conExcepcion),
    ).rejects.toThrow(/escribir por qué/i);
  });

  it('la excepción histórica no sirve para nada después del corte', async () => {
    const conExcepcion = con([
      PERMISSIONS.STOCKERP_RECEPCION_CONFIRMAR,
      PERMISSIONS.STOCKERP_EXCEPCION_HISTORICA,
    ]);
    const { doc } = await escenarioSimple();
    await expect(
      recibir(doc.id, DESPUES, { excepcionHistorica: true, motivo: 'no hace falta' }, conExcepcion),
    ).rejects.toThrow(/entra por el camino normal/i);
  });
});

/* ========================================================================== *
 * La doble confirmación y la auditoría
 * ========================================================================== */

describe('la confirmación y su rastro', () => {
  it('sin la segunda confirmación no se aplica, aunque el pedido llegue directo', async () => {
    const { doc } = await escenarioSimple();
    await expect(recibir(doc.id, DESPUES, { confirmado: false })).rejects.toThrow(
      /segunda confirmación/i,
    );
    expect(await prisma.stockReceipt.count()).toBe(0);
  });

  it('cada resolución deja su propia entrada de auditoría', async () => {
    const { doc: aplicable } = await escenarioSimple();
    await recibir(aplicable.id);
    expect(
      await prisma.auditLog.count({ where: { action: AUDIT_ACTIONS.STOCKERP_RECEPCION_APLICADA } }),
    ).toBe(1);

    const doc2 = await comprobante({
      branchId: escenario.sucursales.devoto,
      renglones: [{ cantidad: '1', gasto: 'FLETE', descripcion: 'FLETE' }],
    });
    await recibir(doc2.id);
    expect(
      await prisma.auditLog.count({ where: { action: AUDIT_ACTIONS.STOCKERP_RECEPCION_DECIDIDA } }),
    ).toBe(1);
  });

  it('la auditoría guarda la huella, para poder contestar qué se firmó', async () => {
    const { doc } = await escenarioSimple();
    await recibir(doc.id);
    const entrada = await prisma.auditLog.findFirstOrThrow({
      where: { action: AUDIT_ACTIONS.STOCKERP_RECEPCION_APLICADA },
    });
    const despues = entrada.after as Record<string, unknown>;
    expect(typeof despues.huella).toBe('string');
    expect((despues.huella as string).length).toBe(64);
  });
});

/* ========================================================================== *
 * 36 y 37. Los dos escenarios determinísticos
 * ========================================================================== */

describe('escenarios completos', () => {
  it('36. una recepción de varios artículos entra entera y con sus cantidades', async () => {
    const a = await articulo('9001', 'KG');
    const b = await articulo('9002', 'KG');
    const c = await articulo('9003', 'UNIT');
    await aperturaDe(escenario.sucursales.devoto, CORTE, [
      { productId: a.id, cantidad: '10' },
      { productId: b.id, cantidad: '0' },
      { productId: c.id, cantidad: '4' },
    ]);

    const doc = await comprobante({
      branchId: escenario.sucursales.devoto,
      renglones: [
        { productId: a.id, cantidad: '2.5', piezas: 2, pesoKg: '2.5' },
        { productId: b.id, cantidad: '7.125' },
        { productId: c.id, cantidad: '6', unidad: 'UNIT' },
        { cantidad: '1', gasto: 'FLETE', descripcion: 'FLETE DEL CAMIÓN' },
      ],
    });

    const r = await recibir(doc.id);
    expect(r.resolucion).toBe('APLICADA');
    expect(r.movimientos, 'tres de mercadería, el flete no').toBe(3);

    const esperado: Record<string, string> = { [a.id]: '12.5', [b.id]: '7.125', [c.id]: '10' };
    for (const [productId, cantidad] of Object.entries(esperado)) {
      const saldo = await prisma.stockBalance.findFirstOrThrow({ where: { productId } });
      expect(
        new Decimal(saldo.quantity.toString()).equals(new Decimal(cantidad)),
        `saldo de ${productId}`,
      ).toBe(true);
    }

    /* Las piezas y el peso real del renglón viajan al movimiento. */
    const conPiezas = await prisma.stockLedger.findFirstOrThrow({
      where: { productId: a.id, type: 'PURCHASE_IN' },
    });
    expect(conPiezas.pieceCount).toBe(2);
    expect(new Decimal(conPiezas.realWeightKg!.toString()).equals(new Decimal('2.5'))).toBe(true);
  });

  it('37. BOLSA GRANDE, código 4249, 3 UNIT: gasto sin impacto', async () => {
    /*
     * El caso que motivó separar gastos de mercadería. Una bolsa de embalaje
     * facturada como cualquier otro renglón: si entrara al libro, la sucursal
     * tendría tres bolsas de existencia que nadie va a vender ni descontar.
     *
     * Entra como EMBALAJE y por eso no impacta. Y la decisión queda registrada:
     * el comprobante no se queda pendiente para siempre.
     */
    const mercaderia = await articulo('9001');
    await aperturaDe(escenario.sucursales.devoto, CORTE, [
      { productId: mercaderia.id, cantidad: '10' },
    ]);
    const doc = await comprobante({
      branchId: escenario.sucursales.devoto,
      renglones: [
        {
          cantidad: '3.000',
          unidad: 'UNIT',
          gasto: 'EMBALAJE',
          descripcion: 'BOLSA GRANDE',
          supplierCode: '4249',
        },
      ],
    });

    const previa = await vistaPreviaDeRecepcion(receptor, { documentId: doc.id });
    expect(previa.renglones).toHaveLength(1);
    expect(previa.renglones[0].clase).toBe('GASTO_SIN_IMPACTO');
    expect(previa.renglones[0].cantidadDeExistencia).toBeNull();

    const r = await recibir(doc.id);
    expect(r.resolucion).toBe('EXCLUIDA');
    expect(r.movimientos).toBe(0);
    expect(await prisma.stockLedger.count({ where: { type: 'PURCHASE_IN' } })).toBe(0);
  });

  it('un artículo que apareció después del corte nace con saldo POSTERIOR_AL_CORTE', async () => {
    const viejo = await articulo('9001');
    await aperturaDe(escenario.sucursales.devoto, CORTE, [{ productId: viejo.id, cantidad: '10' }]);
    /* Éste entra al catálogo DESPUÉS: nunca tuvo apertura. */
    const nuevo = await articulo('9500');
    const doc = await comprobante({
      branchId: escenario.sucursales.devoto,
      renglones: [{ productId: nuevo.id, cantidad: '3' }],
    });

    await recibir(doc.id);
    const saldo = await prisma.stockBalance.findFirstOrThrow({ where: { productId: nuevo.id } });
    expect(saldo.openingSource).toBe('POSTERIOR_AL_CORTE');
    expect(new Decimal(saldo.quantity.toString()).equals(new Decimal('3'))).toBe(true);
  });
});

/* ========================================================================== *
 * El corte con zona horaria (corrección previa a la fase 4)
 * ========================================================================== */

describe('las dos fechas de corte son del mismo tipo y se comparan exacto', () => {
  it('las dos columnas de corte son TIMESTAMPTZ', async () => {
    const columnas = await prisma.$queryRaw<{ table_name: string; data_type: string }[]>`
      SELECT table_name, data_type FROM information_schema.columns
       WHERE column_name = 'cutoffAt'
       ORDER BY table_name`;
    expect(columnas.length).toBe(2);
    for (const c of columnas) {
      expect(c.data_type, `${c.table_name}.cutoffAt`).toBe('timestamp with time zone');
    }
  });

  it('el corte se guarda como el instante argentino que se cargó', async () => {
    await articulo('9001');
    const sessionId = await aperturaDe(escenario.sucursales.devoto, {
      fecha: '2026-09-23',
      hora: '20:30',
    });
    const sesion = await prisma.stockCountSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(sesion.cutoffAt!.toISOString()).toBe(
      instanteDesdeHoraArgentina('2026-09-23', '20:30').toISOString(),
    );
    /* Las 20:30 de Argentina son las 23:30 UTC del mismo día. */
    expect(sesion.cutoffAt!.toISOString()).toBe('2026-09-23T23:30:00.000Z');
  });

  it('la activación guarda el MISMO instante que la sesión', async () => {
    const p = await articulo('9001');
    const sessionId = await aperturaDe(escenario.sucursales.devoto, CORTE, [
      { productId: p.id, cantidad: '1' },
    ]);
    const sesion = await prisma.stockCountSession.findUniqueOrThrow({ where: { id: sessionId } });
    const activacion = await prisma.productStockActivation.findFirstOrThrow({
      where: { productId: p.id },
    });
    expect(activacion.cutoffAt!.toISOString()).toBe(sesion.cutoffAt!.toISOString());
  });

  it('la comparación con el corte es por instante, no por texto de fecha', async () => {
    const p = await articulo('9001');
    /* Corte a las 20:30 del 23. Una recepción a las 21:00 del MISMO día entra. */
    await aperturaDe(escenario.sucursales.devoto, CORTE, [{ productId: p.id, cantidad: '0' }]);
    const doc = await comprobante({
      branchId: escenario.sucursales.devoto,
      renglones: [{ productId: p.id, cantidad: '1' }],
    });
    const r = await recibir(doc.id, { fecha: '2026-09-23', hora: '21:00' });
    expect(r.resolucion, 'mismo día, hora posterior').toBe('APLICADA');
  });

  it('y a las 20:29 del mismo día no entra', async () => {
    const p = await articulo('9001');
    await aperturaDe(escenario.sucursales.devoto, CORTE, [{ productId: p.id, cantidad: '0' }]);
    const doc = await comprobante({
      branchId: escenario.sucursales.devoto,
      renglones: [{ productId: p.id, cantidad: '1' }],
    });
    const r = await recibir(doc.id, { fecha: '2026-09-23', hora: '20:29' });
    expect(r.resolucion).toBe('INCLUIDA_EN_APERTURA');
  });

  it('el instante se interpreta en hora argentina, no en UTC', async () => {
    /*
     * Si el servidor leyera «20:30» como UTC, el corte quedaría tres horas
     * antes y una recepción de las 22:00 argentinas (01:00 UTC del día
     * siguiente) seguiría entrando igual, así que ese caso no distingue nada.
     * El que sí distingue es una recepción ENTRE las dos lecturas: 18:00
     * argentinas es posterior a un corte leído como UTC (17:30 AR) y anterior
     * al corte de verdad (20:30 AR).
     */
    const p = await articulo('9001');
    await aperturaDe(escenario.sucursales.devoto, CORTE, [{ productId: p.id, cantidad: '0' }]);
    const doc = await comprobante({
      branchId: escenario.sucursales.devoto,
      renglones: [{ productId: p.id, cantidad: '1' }],
    });
    const r = await recibir(doc.id, { fecha: '2026-09-23', hora: '18:00' });
    expect(r.resolucion, 'si esto diera APLICADA, el corte se leyó como UTC').toBe(
      'INCLUIDA_EN_APERTURA',
    );
  });
});
