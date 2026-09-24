import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { prisma } from '@/lib/db';
import { limpiarBase, sembrarEscenario, comoUsuario, type Escenario } from './ayudas';
import {
  movimientosDelLibro,
  recorridoCronologico,
  tableroDeExistencias,
  auditoriaDeStockErp,
  diagnosticoDeIntegridad,
  cursorATexto,
  textoACursor,
  ACCIONES_DE_STOCK_ERP,
} from '@/lib/services/stock-erp-consultas';
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
import { aplicarIngresoDeCompra } from '@/lib/services/stock-erp-recepcion';
import { confirmDocument, createDocument } from '@/lib/services/documents';
import { AUDIT_ACTIONS } from '@/lib/services/audit';
import { PERMISSIONS, ADMIN_PERMISSIONS } from '@/lib/auth/permissions';
import { Decimal } from '@/lib/money';

/**
 * **Stock ERP, fase 5: mirar el libro sin tocarlo.**
 *
 * Las dos afirmaciones que sostienen el archivo:
 *
 *  1. **Una ausencia de dato no es un cero.** Una sucursal sin apertura, un
 *     artículo que la sucursal no maneja y un artículo sin unidad aprobada son
 *     tres cosas distintas, y ninguna de las tres es «cero». Un conteo
 *     confirmado en cero SÍ es cero, y se dice.
 *  2. **El libro manda y no se reescribe.** `StockBalance` es una proyección;
 *     `StockLedger` es la historia. Si un movimiento entró fuera de orden
 *     cronológico, se avisa: no se recalcula la historia para que quede linda.
 *
 * Nada de acá escribe existencias.
 */

let escenario: Escenario;
let operario: ReturnType<typeof comoUsuario>;
let mirón: ReturnType<typeof comoUsuario>;
let sinPermiso: ReturnType<typeof comoUsuario>;

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

/** Un usuario con SÓLO los permisos que se le nombran. */
function sólo(permisos: string[]): ReturnType<typeof comoUsuario> {
  return comoUsuario({
    id: escenario.admin.id,
    email: escenario.admin.email,
    name: escenario.admin.name,
    branchId: null,
    roleId: escenario.admin.roleId,
    roleCode: 'LIMITADO',
    roleName: 'Limitado',
    permissions: permisos,
    scopeAllBranches: true,
  });
}

const CORTE = { fecha: '2026-09-23', hora: '20:30' };
const DESPUES = { fecha: '2026-09-24', hora: '09:00' };

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();
  operario = con([
    PERMISSIONS.STOCKERP_APERTURA_PREPARAR,
    PERMISSIONS.STOCKERP_APERTURA_CONFIRMAR,
    PERMISSIONS.STOCKERP_ACTIVACION_HABILITAR,
    PERMISSIONS.STOCKERP_UNIDADES_CONFIGURAR,
    PERMISSIONS.STOCKERP_RECEPCION_CONFIRMAR,
    PERMISSIONS.STOCKERP_MOVIMIENTOS_VER,
    PERMISSIONS.STOCKERP_INTEGRIDAD_VER,
  ]);
  mirón = con([PERMISSIONS.STOCKERP_MOVIMIENTOS_VER, PERMISSIONS.STOCKERP_INTEGRIDAD_VER]);
  sinPermiso = sólo([PERMISSIONS.STOCKERP_VER]);
});

afterEach(() => vi.restoreAllMocks());

/* ========================================================================== *
 * Escenario: artículos, apertura y una recepción
 * ========================================================================== */

async function articulo(plu: string, unidad: 'KG' | 'UNIT' | null = 'KG') {
  const p = await prisma.product.create({
    data: {
      internalCode: plu,
      normalizedName: `ARTICULO ${plu}`,
      purchaseUnit: 'KG',
      saleMode: 'AL_CORTE',
      active: true,
      targetMarginPct: '0.45',
      marginBasis: 'SOBRE_COSTO',
      cashDiscountPct: '0',
      roundingRule: 'NEAREST_100',
    },
  });
  if (unidad) {
    await aprobarUnidadDeExistencia(operario, { productId: p.id, unidad, confirmado: true });
  }
  return p;
}

/**
 * Inaugura Devoto contando lo que se le pida.
 *
 * `cantidad: '0'` pasa por «contado en cero», que es un gesto distinto de
 * escribir un cero y la fase 3 lo hace cumplir.
 */
async function aperturaDeDevoto(contar: { productId: string; cantidad: string }[] = []) {
  const branchId = escenario.sucursales.devoto;
  const ap = await prepararApertura(operario, { branchId, ficticia: true });
  const vista = await verApertura(operario, ap.sessionId);
  const pedido = new Map(contar.map((c) => [c.productId, c.cantidad]));

  for (const l of vista.lineas) {
    const cantidad = pedido.get(l.productId);
    if (cantidad !== undefined) {
      if (new Decimal(cantidad).isZero()) await contarEnCero(operario, l.activationId);
      else await guardarConteo(operario, { activationId: l.activationId, cantidad });
    } else if (l.estado !== 'NO_SE_MANEJA') {
      await marcarNoSeManeja(operario, {
        activationId: l.activationId,
        motivo: 'Esta sucursal no trabaja este artículo.',
      });
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
  return ap.sessionId;
}

let numero = 0;
async function comprobanteValidado(renglones: { productId: string; cantidad: string }[]) {
  numero += 1;
  return prisma.document.create({
    data: {
      branchId: escenario.sucursales.devoto,
      supplierId: escenario.proveedorId,
      docType: 'FACTURA',
      letter: 'A',
      pointOfSale: '0001',
      number: String(70000 + numero),
      fullNumber: `A 0001-${70000 + numero}`,
      issueDate: new Date('2026-09-24T12:00:00Z'),
      status: 'VALIDADO',
      netTotal: '1000.00',
      ivaTotal: '210.00',
      total: '1210.00',
      createdById: escenario.admin.id,
      validatedById: escenario.admin.id,
      validatedAt: new Date(),
      items: {
        create: renglones.map((r, i) => ({
          lineNumber: i + 1,
          description: `RENGLON ${i + 1}`,
          quantity: r.cantidad,
          unit: 'KG' as const,
          unitNetPrice: '100',
          grossSubtotal: '100',
          netAmount: '100',
          ivaRate: '0.21',
          ivaAmount: '21',
          totalCost: '121',
          unitCost: '121',
          productId: r.productId,
          matchMethod: 'MANUAL',
        })),
      },
    },
  });
}

function recibir(documentId: string, cuando = DESPUES) {
  return aplicarIngresoDeCompra(operario, {
    documentId,
    fecha: cuando.fecha,
    hora: cuando.hora,
    confirmado: true,
  });
}

/* ========================================================================== *
 * 1 a 4. Una ausencia de dato no es un cero
 * ========================================================================== */

describe('el tablero no convierte ausencias en ceros', () => {
  it('1. una sucursal sin apertura no aparece como saldo cero', async () => {
    const p = await articulo('9001');
    await aperturaDeDevoto([{ productId: p.id, cantidad: '10' }]);

    /* San Martín queda sin inaugurar a propósito. */
    const tablero = await tableroDeExistencias(mirón, {
      branchId: escenario.sucursales.sanMartin,
    });
    const fila = tablero.filas.find((f) => f.productId === p.id);
    expect(fila?.estado).toBe('SUCURSAL_SIN_APERTURA');
    expect(fila?.cantidad, 'null, jamás "0"').toBeNull();
    expect(tablero.resumen.CERO_CONFIRMADO).toBe(0);
    expect(tablero.sucursalesSinApertura.map((s) => s.branchId)).toContain(
      escenario.sucursales.sanMartin,
    );
  });

  it('2. un artículo contado expresamente en cero aparece como cero confirmado', async () => {
    const p = await articulo('9001');
    await aperturaDeDevoto([{ productId: p.id, cantidad: '0' }]);

    const tablero = await tableroDeExistencias(mirón, { branchId: escenario.sucursales.devoto });
    const fila = tablero.filas.find((f) => f.productId === p.id);
    expect(fila?.estado).toBe('CERO_CONFIRMADO');
    expect(fila?.cantidad, 'acá SÍ hay un cero, y es un dato').toBe('0');
    expect(fila?.origenDelSaldo).toBe('APERTURA');
  });

  it('3. NO_SE_MANEJA se distingue de cero y de pendiente', async () => {
    const manejado = await articulo('9001');
    const noManejado = await articulo('9002');
    await aperturaDeDevoto([{ productId: manejado.id, cantidad: '5' }]);

    const tablero = await tableroDeExistencias(mirón, { branchId: escenario.sucursales.devoto });
    const fila = tablero.filas.find((f) => f.productId === noManejado.id);
    expect(fila?.estado).toBe('NO_SE_MANEJA');
    expect(fila?.cantidad, 'ni cero ni faltante').toBeNull();
    expect(fila?.motivo).toMatch(/no trabaja este artículo/i);

    /* Y los tres estados son distintos entre sí. */
    const estados = new Set(tablero.filas.map((f) => f.estado));
    expect(estados.has('NO_SE_MANEJA')).toBe(true);
    expect(estados.has('CON_SALDO')).toBe(true);
  });

  it('4. un artículo pendiente de unidad no aparenta tener existencias', async () => {
    const conUnidad = await articulo('9001');
    await aperturaDeDevoto([{ productId: conUnidad.id, cantidad: '5' }]);
    /*
     * El artículo sin unidad entra al catálogo DESPUÉS de la apertura, y no
     * antes. Si entrara antes, el conteo lo dejaría marcado «no se maneja» —que
     * es una de las salidas válidas de la fase 3 para un artículo bloqueado— y
     * ese estado gana sobre «pendiente de unidad», con razón: es una decisión
     * con autor, no un hueco de configuración. Escribí la prueba al revés la
     * primera vez y me lo dijo.
     */
    const sinUnidad = await articulo('9002', null);

    const tablero = await tableroDeExistencias(mirón, { branchId: escenario.sucursales.devoto });
    const fila = tablero.filas.find((f) => f.productId === sinUnidad.id);
    expect(fila?.estado).toBe('PENDIENTE_DE_UNIDAD');
    expect(fila?.cantidad).toBeNull();
    expect(fila?.unidadDeExistencia, 'no hay unidad porque nadie la aprobó').toBeNull();
  });

  it('un artículo incorporado después del corte queda SIN_DATO hasta que algo lo mueva', async () => {
    const viejo = await articulo('9001');
    await aperturaDeDevoto([{ productId: viejo.id, cantidad: '10' }]);
    const nuevo = await articulo('9500');

    const tablero = await tableroDeExistencias(mirón, { branchId: escenario.sucursales.devoto });
    const fila = tablero.filas.find((f) => f.productId === nuevo.id);
    expect(fila?.estado, 'nunca se contó ni se movió').toBe('SIN_DATO');
    expect(fila?.cantidad).toBeNull();
  });

  it('y cuando lo reciben, pasa a CON_SALDO con origen posterior al corte', async () => {
    const viejo = await articulo('9001');
    await aperturaDeDevoto([{ productId: viejo.id, cantidad: '10' }]);
    const nuevo = await articulo('9500');
    const doc = await comprobanteValidado([{ productId: nuevo.id, cantidad: '3' }]);
    await recibir(doc.id);

    const tablero = await tableroDeExistencias(mirón, { branchId: escenario.sucursales.devoto });
    const fila = tablero.filas.find((f) => f.productId === nuevo.id);
    expect(fila?.estado).toBe('CON_SALDO');
    expect(fila?.cantidad).toBe('3');
    expect(fila?.origenDelSaldo).toBe('POSTERIOR_AL_CORTE');
  });

  it('20. el tablero no suma unidades incompatibles', async () => {
    const enKilos = await articulo('9001', 'KG');
    const enUnidades = await articulo('9003', 'UNIT');
    await aperturaDeDevoto([
      { productId: enKilos.id, cantidad: '12.5' },
      { productId: enUnidades.id, cantidad: '7' },
    ]);

    const tablero = await tableroDeExistencias(mirón, { branchId: escenario.sucursales.devoto });
    /* Dos totales, uno por unidad. Nunca uno solo. */
    expect(Object.keys(tablero.totalPorUnidad).sort()).toEqual(['KG', 'UNIT']);
    expect(tablero.totalPorUnidad.KG).toBe('12.5');
    expect(tablero.totalPorUnidad.UNIT).toBe('7');
    expect(
      (tablero as unknown as { total?: unknown }).total,
      'no existe un total único que los mezcle',
    ).toBeUndefined();
  });
});

/* ========================================================================== *
 * 5 a 7. El diagnóstico detecta y no repara
 * ========================================================================== */

describe('el diagnóstico de integridad', () => {
  it('5. el saldo materializado coincide con la suma del libro', async () => {
    const p = await articulo('9001');
    await aperturaDeDevoto([{ productId: p.id, cantidad: '10' }]);
    const doc = await comprobanteValidado([{ productId: p.id, cantidad: '2.5' }]);
    await recibir(doc.id);

    const d = await diagnosticoDeIntegridad(mirón);
    expect(d.coincide, JSON.stringify(d.divergencias)).toBe(true);
    expect(d.divergencias).toEqual([]);
    expect(d.comprobadoEl, 'un diagnóstico sin fecha no dice nada').toBeInstanceOf(Date);
    expect(d.paresRevisados).toBeGreaterThan(0);
    expect(d.movimientosRevisados).toBeGreaterThan(0);
  });

  it('6. una alteración deliberada del saldo es detectada', async () => {
    const p = await articulo('9001');
    await aperturaDeDevoto([{ productId: p.id, cantidad: '10' }]);

    /*
     * Se altera el saldo por debajo, salteando los disparadores. Es lo que
     * haría un script de corrección corrido a las once de la noche, y es
     * exactamente lo que el diagnóstico tiene que poder ver.
     */
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "stock_balance" DISABLE TRIGGER "stock_balance_respaldado"`,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE "stock_balance" SET "quantity" = 99 WHERE "productId" = $1`,
      p.id,
    );
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "stock_balance" ENABLE TRIGGER "stock_balance_respaldado"`,
    );

    const d = await diagnosticoDeIntegridad(mirón);
    expect(d.coincide).toBe(false);
    const div = d.divergencias.find((x) => x.clase === 'SALDO_NO_COINCIDE');
    expect(div).toBeDefined();
    /* Los dos números, por separado, sin corregir ninguno. */
    expect(div!.segunElSaldo).toBe('99');
    expect(div!.segunElLibro).toBe('10');
  });

  it('7. ejecutar el diagnóstico no escribe absolutamente nada', async () => {
    const p = await articulo('9001');
    await aperturaDeDevoto([{ productId: p.id, cantidad: '10' }]);
    const doc = await comprobanteValidado([{ productId: p.id, cantidad: '2' }]);
    await recibir(doc.id);

    const contar = async () => ({
      ledger: await prisma.stockLedger.count(),
      saldos: await prisma.stockBalance.count(),
      operaciones: await prisma.stockOperation.count(),
      recibos: await prisma.stockReceipt.count(),
      activaciones: await prisma.productStockActivation.count(),
      auditoria: await prisma.auditLog.count(),
      bandeja: await prisma.stockOutbox.count(),
    });

    const antes = await contar();
    await diagnosticoDeIntegridad(mirón);
    await diagnosticoDeIntegridad(mirón, { branchId: escenario.sucursales.devoto });
    expect(await contar()).toEqual(antes);
  });

  it('7b. y tampoco repara: después de detectar, el saldo sigue mal', async () => {
    const p = await articulo('9001');
    await aperturaDeDevoto([{ productId: p.id, cantidad: '10' }]);
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "stock_balance" DISABLE TRIGGER "stock_balance_respaldado"`,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE "stock_balance" SET "quantity" = 99 WHERE "productId" = $1`,
      p.id,
    );
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "stock_balance" ENABLE TRIGGER "stock_balance_respaldado"`,
    );

    await diagnosticoDeIntegridad(mirón);
    await diagnosticoDeIntegridad(mirón);

    const saldo = await prisma.stockBalance.findFirstOrThrow({ where: { productId: p.id } });
    expect(
      saldo.quantity.toString(),
      'el diagnóstico mira; arreglar es de otra fase que todavía no existe',
    ).toBe('99');
  });

  it('el servicio no exporta ninguna función que repare', async () => {
    const consultas = await import('@/lib/services/stock-erp-consultas');
    const sospechosas = Object.keys(consultas).filter((n) =>
      /reparar|corregir|recalcular|arreglar|sincronizar|rebuild|fix/i.test(n),
    );
    expect(sospechosas).toEqual([]);
  });
});

/* ========================================================================== *
 * 8 a 11. El libro y sus dos líneas de tiempo
 * ========================================================================== */

describe('el libro, y qué significa cada fecha', () => {
  it('8. dos movimientos del mismo artículo aparecen por separado', async () => {
    const p = await articulo('9001');
    await aperturaDeDevoto([{ productId: p.id, cantidad: '10' }]);
    const doc = await comprobanteValidado([
      { productId: p.id, cantidad: '2.5' },
      { productId: p.id, cantidad: '3.25' },
    ]);
    await recibir(doc.id);

    const pagina = await movimientosDelLibro(mirón, { productId: p.id, type: 'PURCHASE_IN' });
    expect(pagina.movimientos).toHaveLength(2);
    /* Cada uno con su renglón: no se agruparon. */
    const renglones = new Set(pagina.movimientos.map((m) => m.documentItemId));
    expect(renglones.size).toBe(2);
  });

  it('8b. un movimiento de cantidad CERO se ve: es la prueba de que alguien contó', async () => {
    /*
     * HALLAZGO de una rotura deliberada. Filtrar `quantity != 0` en la consulta
     * del libro no ponía nada en rojo, y es de las roturas que más caro salen:
     * el movimiento de un «contado en cero» tiene cantidad cero, y es
     * exactamente la evidencia de que alguien recorrió la góndola y no había.
     * Esconderlo borra la diferencia entre «se contó y no había» y «nadie lo
     * contó», que es la distinción que sostiene todo el módulo.
     */
    const enCero = await articulo('9002');
    const conSaldo = await articulo('9001');
    await aperturaDeDevoto([
      { productId: enCero.id, cantidad: '0' },
      { productId: conSaldo.id, cantidad: '5' },
    ]);

    const pagina = await movimientosDelLibro(mirón, { productId: enCero.id });
    expect(pagina.movimientos, 'el movimiento de cero está en el libro').toHaveLength(1);
    expect(pagina.movimientos[0].cantidad).toBe('0');
    expect(pagina.movimientos[0].type).toBe('OPENING_BALANCE');
  });

  it('9b. el orden es por SECUENCIA, no por el momento de registración', async () => {
    /*
     * HALLAZGO de otra rotura. Ordenar por `createdAt` en vez de por `seq` no
     * ponía nada en rojo, porque en las pruebas los dos órdenes coinciden casi
     * siempre. Casi.
     *
     * Acá se los hace diferir a propósito. Los dos movimientos de una apertura
     * se escriben en la MISMA transacción, así que comparten `createdAt` al
     * milisegundo —`now()` es el instante de la transacción, no el de la fila—
     * y ordenar por fecha deja el desempate en manos del `id`. Creando los
     * artículos en orden inverso al de su PLU, el orden de los `id` queda al
     * revés del de la secuencia, y las dos respuestas dejan de coincidir.
     *
     * La secuencia es la única que dice en qué orden se escribió el libro.
     */
    const segundo = await articulo('9002');
    const primero = await articulo('9001');
    await aperturaDeDevoto([
      { productId: primero.id, cantidad: '1' },
      { productId: segundo.id, cantidad: '2' },
    ]);

    const pagina = await movimientosDelLibro(mirón, { type: 'OPENING_BALANCE' });
    expect(pagina.movimientos.length).toBeGreaterThanOrEqual(2);

    /* Comparten el instante de registración: el desempate no puede ser la fecha. */
    const momentos = new Set(pagina.movimientos.map((m) => m.createdAt.getTime()));
    expect(momentos.size, 'misma transacción, mismo createdAt').toBe(1);

    /* Y aun así el orden es estrictamente descendente por secuencia. */
    const seqs = pagina.movimientos.map((m) => BigInt(m.seq));
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i] < seqs[i - 1], `posición ${i}: ${seqs[i]} tiene que ser menor`).toBe(true);
    }
  });

  it('9. balanceAfterSeq sigue el orden de registración', async () => {
    const p = await articulo('9001');
    await aperturaDeDevoto([{ productId: p.id, cantidad: '10' }]);
    const doc = await comprobanteValidado([
      { productId: p.id, cantidad: '2.5' },
      { productId: p.id, cantidad: '3.25' },
    ]);
    await recibir(doc.id);

    const pagina = await movimientosDelLibro(mirón, { productId: p.id });
    /* Viene en orden de registración descendente. */
    const seqs = pagina.movimientos.map((m) => BigInt(m.seq));
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i] < seqs[i - 1]).toBe(true);

    /* Y de menor a mayor secuencia, el saldo posterior crece con la apertura. */
    const ascendentes = [...pagina.movimientos].reverse();
    expect(ascendentes.map((m) => m.balanceAfterSeq)).toEqual(['10', '12.5', '15.75']);
  });

  it('10. un movimiento retroactivo conserva su fecha efectiva y se marca', async () => {
    const p = await articulo('9001');
    await aperturaDeDevoto([{ productId: p.id, cantidad: '10' }]);

    /* Primero uno del 26, después uno del 25: el segundo es retroactivo. */
    const tarde = await comprobanteValidado([{ productId: p.id, cantidad: '1' }]);
    await recibir(tarde.id, { fecha: '2026-09-26', hora: '10:00' });
    const temprano = await comprobanteValidado([{ productId: p.id, cantidad: '2' }]);
    await recibir(temprano.id, { fecha: '2026-09-25', hora: '10:00' });

    const pagina = await movimientosDelLibro(mirón, { productId: p.id, type: 'PURCHASE_IN' });
    const elRetroactivo = pagina.movimientos.find((m) => m.documentId === temprano.id);
    const elNormal = pagina.movimientos.find((m) => m.documentId === tarde.id);

    expect(elRetroactivo?.retroactivo, 'se registró después de algo posterior').toBe(true);
    expect(elNormal?.retroactivo).toBe(false);

    /* La fecha efectiva NO se tocó: sigue siendo la que se cargó. */
    expect(elRetroactivo!.effectiveAt.toISOString()).toContain('2026-09-25');
    /* Y su saldo posterior es el del orden de REGISTRACIÓN, no el cronológico. */
    expect(elRetroactivo!.balanceAfterSeq, '10 + 1 + 2').toBe('13');
  });

  it('11. el recorrido cronológico usa fecha efectiva y desempata por secuencia', async () => {
    const p = await articulo('9001');
    await aperturaDeDevoto([{ productId: p.id, cantidad: '10' }]);
    const tarde = await comprobanteValidado([{ productId: p.id, cantidad: '1' }]);
    await recibir(tarde.id, { fecha: '2026-09-26', hora: '10:00' });
    const temprano = await comprobanteValidado([{ productId: p.id, cantidad: '2' }]);
    await recibir(temprano.id, { fecha: '2026-09-25', hora: '10:00' });

    const pasos = await recorridoCronologico(mirón, {
      productId: p.id,
      branchId: escenario.sucursales.devoto,
    });

    /* Ordenado por fecha efectiva: apertura, el del 25, el del 26. */
    expect(pasos.map((x) => x.movimiento.documentId)).toEqual([null, temprano.id, tarde.id]);
    expect(pasos.map((x) => x.saldoCronologico)).toEqual(['10', '12', '13']);

    /*
     * El del 25 NO coincide con su saldo por registración: cronológicamente
     * deja 12, pero cuando se escribió el libro ya decía 11. Las dos son
     * ciertas y contestan preguntas distintas.
     */
    const elDel25 = pasos.find((x) => x.movimiento.documentId === temprano.id)!;
    expect(elDel25.saldoCronologico).toBe('12');
    expect(elDel25.movimiento.balanceAfterSeq).toBe('13');
    expect(elDel25.coincideConElDeRegistracion).toBe(false);
  });

  it('11b. sin movimientos retroactivos, las dos líneas de tiempo coinciden', async () => {
    const p = await articulo('9001');
    await aperturaDeDevoto([{ productId: p.id, cantidad: '10' }]);
    const doc = await comprobanteValidado([{ productId: p.id, cantidad: '2' }]);
    await recibir(doc.id, { fecha: '2026-09-25', hora: '10:00' });

    const pasos = await recorridoCronologico(mirón, {
      productId: p.id,
      branchId: escenario.sucursales.devoto,
    });
    expect(pasos.every((x) => x.coincideConElDeRegistracion)).toBe(true);
    expect(pasos.every((x) => !x.movimiento.retroactivo)).toBe(true);
  });

  it('el movimiento conserva el PLU histórico además del actual', async () => {
    const p = await articulo('9001');
    await aperturaDeDevoto([{ productId: p.id, cantidad: '10' }]);
    await prisma.product.update({ where: { id: p.id }, data: { internalCode: '9999' } });

    const pagina = await movimientosDelLibro(mirón, { productId: p.id });
    const mov = pagina.movimientos[0];
    expect(mov.pluHistorico, 'el de cuando pasó').toBe('9001');
    expect(mov.pluActual, 'el de hoy').toBe('9999');
  });

  it('se puede buscar por el PLU viejo, que es lo que alguien recuerda', async () => {
    const p = await articulo('9001');
    await aperturaDeDevoto([{ productId: p.id, cantidad: '10' }]);
    await prisma.product.update({ where: { id: p.id }, data: { internalCode: '9999' } });

    const pagina = await movimientosDelLibro(mirón, { texto: '9001' });
    expect(pagina.movimientos.length).toBeGreaterThan(0);
  });
});

/* ========================================================================== *
 * 12 a 14. Paginación y filtros
 * ========================================================================== */

describe('la paginación es estable', () => {
  /** Siembra una apertura con `n` artículos contados: `n` movimientos. */
  async function nMovimientos(n: number) {
    const productos = [];
    for (let i = 0; i < n; i += 1) productos.push(await articulo(`90${String(i).padStart(2, '0')}`));
    await aperturaDeDevoto(productos.map((p, i) => ({ productId: p.id, cantidad: String(i + 1) })));
    return productos;
  }

  it('12. paginar no duplica ni omite movimientos', async () => {
    await nMovimientos(12);
    const total = await prisma.stockLedger.count();
    expect(total).toBe(12);

    const vistos: string[] = [];
    let cursor: string | null = null;
    let vueltas = 0;
    do {
      const pagina = await movimientosDelLibro(mirón, {}, { cursor, tamano: 5 });
      vistos.push(...pagina.movimientos.map((m) => m.id));
      cursor = pagina.siguiente;
      vueltas += 1;
      expect(vueltas, 'no puede ciclar').toBeLessThan(20);
    } while (cursor);

    expect(vistos, 'ninguno se perdió').toHaveLength(total);
    expect(new Set(vistos).size, 'ninguno se repitió').toBe(total);
  });

  it('12b. y sigue sin duplicar si alguien escribe entre página y página', async () => {
    /*
     * El caso que rompe una paginación por `skip`/`take`. Se lee la primera
     * página, se agrega un movimiento NUEVO —que por ser nuevo tiene la
     * secuencia más alta— y se pide la segunda. Con un cursor sobre `seq` el
     * movimiento nuevo simplemente no aparece: quedó por encima del corte.
     * Con `skip` numérico, todo se correría una fila y una se vería dos veces.
     */
    const productos = await nMovimientos(10);
    const primera = await movimientosDelLibro(mirón, {}, { tamano: 4 });

    const doc = await comprobanteValidado([{ productId: productos[0].id, cantidad: '1' }]);
    await recibir(doc.id);

    const vistos = [...primera.movimientos.map((m) => m.id)];
    let cursor = primera.siguiente;
    while (cursor) {
      const pagina = await movimientosDelLibro(mirón, {}, { cursor, tamano: 4 });
      vistos.push(...pagina.movimientos.map((m) => m.id));
      cursor = pagina.siguiente;
    }
    expect(new Set(vistos).size, 'ninguno repetido').toBe(vistos.length);
    expect(vistos).toHaveLength(10);
  });

  it('el cursor va y vuelve de texto sin perder nada', () => {
    const c = { seq: 123456789012345n, id: 'cmuf-abc' };
    expect(textoACursor(cursorATexto(c))).toEqual(c);
    expect(textoACursor('')).toBeNull();
    expect(textoACursor('basura')).toBeNull();
    expect(textoACursor(':sin-seq')).toBeNull();
    expect(textoACursor('12:')).toBeNull();
  });

  it('13. los filtros de sucursal, artículo, tipo y fechas funcionan', async () => {
    const p = await articulo('9001');
    const otro = await articulo('9002');
    await aperturaDeDevoto([
      { productId: p.id, cantidad: '10' },
      { productId: otro.id, cantidad: '4' },
    ]);
    const doc = await comprobanteValidado([{ productId: p.id, cantidad: '2' }]);
    await recibir(doc.id, { fecha: '2026-09-25', hora: '10:00' });

    const porSucursal = await movimientosDelLibro(mirón, {
      branchId: escenario.sucursales.sanMartin,
    });
    expect(porSucursal.movimientos, 'San Martín no tiene nada').toHaveLength(0);

    const porArticulo = await movimientosDelLibro(mirón, { productId: otro.id });
    expect(porArticulo.movimientos).toHaveLength(1);

    const porTipo = await movimientosDelLibro(mirón, { type: 'PURCHASE_IN' });
    expect(porTipo.movimientos).toHaveLength(1);

    const porDireccion = await movimientosDelLibro(mirón, { direction: 'OUT' });
    expect(porDireccion.movimientos, 'todavía no hay egresos').toHaveLength(0);

    const porFechaEfectiva = await movimientosDelLibro(mirón, {
      efectivaDesde: new Date('2026-09-25T00:00:00Z'),
    });
    expect(porFechaEfectiva.movimientos).toHaveLength(1);

    const porDocumento = await movimientosDelLibro(mirón, { documentId: doc.id });
    expect(porDocumento.movimientos).toHaveLength(1);
  });

  it('13b. la fecha efectiva y la de registración son filtros DISTINTOS', async () => {
    const p = await articulo('9001');
    await aperturaDeDevoto([{ productId: p.id, cantidad: '10' }]);
    const doc = await comprobanteValidado([{ productId: p.id, cantidad: '2' }]);
    await recibir(doc.id, { fecha: '2026-09-25', hora: '10:00' });

    /* Por fecha efectiva del 25 aparece; por registración de ese día, no. */
    const efectiva = await movimientosDelLibro(mirón, {
      efectivaDesde: new Date('2026-09-25T00:00:00Z'),
      efectivaHasta: new Date('2026-09-25T23:59:59Z'),
    });
    expect(efectiva.movimientos).toHaveLength(1);

    const registrada = await movimientosDelLibro(mirón, {
      registradaDesde: new Date('2026-09-25T00:00:00Z'),
      registradaHasta: new Date('2026-09-25T23:59:59Z'),
    });
    expect(registrada.movimientos, 'se registró hoy, no el 25').toHaveLength(0);
  });

  it('14. los enlaces al comprobante y a la operación apuntan al origen correcto', async () => {
    const p = await articulo('9001');
    await aperturaDeDevoto([{ productId: p.id, cantidad: '10' }]);
    const doc = await comprobanteValidado([{ productId: p.id, cantidad: '2' }]);
    const r = await recibir(doc.id);

    const pagina = await movimientosDelLibro(mirón, { type: 'PURCHASE_IN' });
    const mov = pagina.movimientos[0];
    expect(mov.documentId).toBe(doc.id);
    expect(mov.operationId).toBe(r.operationId);
    expect(mov.documentoNumero).toBe(doc.fullNumber);
    expect(mov.operacionTipo).toBe('RECEPCION_COMPRA');

    /* Y los destinos existen de verdad. */
    expect(await prisma.document.count({ where: { id: mov.documentId! } })).toBe(1);
    expect(await prisma.stockOperation.count({ where: { id: mov.operationId } })).toBe(1);
  });
});

/* ========================================================================== *
 * 15 a 16. Permisos y auditoría
 * ========================================================================== */

describe('permisos y auditoría', () => {
  it('15. sin permiso no se accede ni a movimientos ni a auditoría ni al diagnóstico', async () => {
    await expect(movimientosDelLibro(sinPermiso, {})).rejects.toThrow(
      /stockerp\.movimientos\.ver/,
    );
    await expect(tableroDeExistencias(sinPermiso, {})).rejects.toThrow(
      /stockerp\.movimientos\.ver/,
    );
    await expect(auditoriaDeStockErp(sinPermiso, {})).rejects.toThrow(/stockerp\.auditoria\.ver/);
    await expect(diagnosticoDeIntegridad(sinPermiso, {})).rejects.toThrow(
      /stockerp\.integridad\.ver/,
    );
  });

  it('15b. el rechazo queda auditado', async () => {
    await movimientosDelLibro(sinPermiso, {}).catch(() => null);
    const rechazo = await prisma.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.STOCKERP_INTENTO_RECHAZADO },
      orderBy: { createdAt: 'desc' },
    });
    expect((rechazo!.after as Record<string, unknown>).permisoQueFaltaba).toBe(
      PERMISSIONS.STOCKERP_MOVIMIENTOS_VER,
    );
  });

  it('15c. los permisos de lectura NO otorgan ninguna capacidad de modificación', async () => {
    const p = await articulo('9001');
    await aperturaDeDevoto([{ productId: p.id, cantidad: '10' }]);
    const doc = await comprobanteValidado([{ productId: p.id, cantidad: '2' }]);

    /*
     * `mirón` tiene los dos permisos de lectura y ninguno de escritura. Que no
     * pueda recibir es la prueba de que «ver» no abrió ninguna puerta.
     */
    const soloLectura = sólo([
      PERMISSIONS.STOCKERP_VER,
      PERMISSIONS.STOCKERP_MOVIMIENTOS_VER,
      PERMISSIONS.STOCKERP_INTEGRIDAD_VER,
      PERMISSIONS.STOCKERP_AUDITORIA_VER,
    ]);
    await expect(
      aplicarIngresoDeCompra(soloLectura, {
        documentId: doc.id,
        fecha: DESPUES.fecha,
        hora: DESPUES.hora,
        confirmado: true,
      }),
    ).rejects.toThrow(/stockerp\.recepcion\.confirmar/);

    /* Pero sí puede mirar. */
    expect((await movimientosDelLibro(soloLectura, {})).movimientos.length).toBeGreaterThan(0);
    expect((await diagnosticoDeIntegridad(soloLectura, {})).coincide).toBe(true);
  });

  it('los permisos de lectura no son sensibles, pero el seed no los agrega a roles ya creados', async () => {
    expect(ADMIN_PERMISSIONS).toContain(PERMISSIONS.STOCKERP_MOVIMIENTOS_VER);
    expect(ADMIN_PERMISSIONS).toContain(PERMISSIONS.STOCKERP_INTEGRIDAD_VER);

    /*
     * El seed usa `update: {}` en el upsert de roles, así que un rol que ya
     * existe conserva su lista. Los permisos nuevos sólo aparecen en un rol
     * recién creado, que es lo que corresponde: nadie amplía por sorpresa un
     * rol que alguien ya ajustó a mano.
     */
    const seed = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../prisma/seed.ts', import.meta.url), 'utf8'),
    );
    const upserts = seed.match(/role\.upsert\(\{[\s\S]*?\}\)/g) ?? [];
    expect(upserts.length).toBeGreaterThan(0);
    for (const u of upserts) {
      expect(u, 'ningún upsert de rol modifica permisos existentes').toMatch(/update:\s*\{\s*\}/);
    }
  });

  it('16. los filtros de auditoría devuelven los asientos correctos', async () => {
    const p = await articulo('9001');
    await aperturaDeDevoto([{ productId: p.id, cantidad: '10' }]);

    const todos = await auditoriaDeStockErp(mirón, {});
    expect(todos.length).toBeGreaterThan(0);
    /* Sólo acciones del módulo: no se cuela la auditoría de Compras. */
    for (const a of todos) expect(ACCIONES_DE_STOCK_ERP).toContain(a.accion);

    const porAccion = await auditoriaDeStockErp(mirón, {
      accion: AUDIT_ACTIONS.STOCKERP_APERTURA_CONFIRMADA,
    });
    expect(porAccion).toHaveLength(1);
    expect(porAccion[0].etiqueta).toMatch(/apertura confirmada/i);

    const porUsuario = await auditoriaDeStockErp(mirón, { usuarioId: escenario.admin.id });
    expect(porUsuario.length).toBeGreaterThan(0);

    const porUsuarioAjeno = await auditoriaDeStockErp(mirón, { usuarioId: 'nadie' });
    expect(porUsuarioAjeno).toHaveLength(0);

    const futuro = await auditoriaDeStockErp(mirón, { desde: new Date('2100-01-01') });
    expect(futuro).toHaveLength(0);
  });

  it('16b. la auditoría cubre unidades, aperturas, recepciones y rechazos', async () => {
    const p = await articulo('9001');
    await aperturaDeDevoto([{ productId: p.id, cantidad: '10' }]);
    const doc = await comprobanteValidado([{ productId: p.id, cantidad: '2' }]);
    await recibir(doc.id);
    await movimientosDelLibro(sinPermiso, {}).catch(() => null);

    const acciones = new Set((await auditoriaDeStockErp(mirón, { limite: 500 })).map((a) => a.accion));
    /*
     * La primera aprobación de un artículo registra `configuracion_creada`, no
     * `unidad_aprobada`: no había fila que aprobar, se creó. La distinción es
     * de la fase 2 y está bien; lo que la pantalla tiene que cubrir es que
     * ALGUNA de las dos aparezca.
     */
    expect(
      acciones.has(AUDIT_ACTIONS.STOCKERP_CONFIG_CREADA) ||
        acciones.has(AUDIT_ACTIONS.STOCKERP_UNIDAD_APROBADA),
      'unidades',
    ).toBe(true);
    expect(acciones.has(AUDIT_ACTIONS.STOCKERP_APERTURA_CONFIRMADA), 'aperturas').toBe(true);
    expect(acciones.has(AUDIT_ACTIONS.STOCKERP_RECEPCION_APLICADA), 'recepciones').toBe(true);
    expect(acciones.has(AUDIT_ACTIONS.STOCKERP_INTENTO_RECHAZADO), 'rechazos').toBe(true);
  });

  it('16c. desde la consulta de auditoría no se puede modificar ni borrar', async () => {
    const consultas = await import('@/lib/services/stock-erp-consultas');
    const sospechosas = Object.keys(consultas).filter((n) =>
      /borrar|eliminar|modificar|editar|delete|update/i.test(n),
    );
    expect(sospechosas).toEqual([]);
  });
});

/* ========================================================================== *
 * 17 a 19, 22 y 23. Lo que sigue apagado
 * ========================================================================== */

describe('las consultas no despiertan nada', () => {
  it('17. StockOutbox sigue en cero después de mirar todo', async () => {
    const p = await articulo('9001');
    await aperturaDeDevoto([{ productId: p.id, cantidad: '10' }]);
    const doc = await comprobanteValidado([{ productId: p.id, cantidad: '2' }]);
    await recibir(doc.id);

    await movimientosDelLibro(mirón, {});
    await tableroDeExistencias(mirón, {});
    await auditoriaDeStockErp(mirón, {});
    await diagnosticoDeIntegridad(mirón, {});
    await recorridoCronologico(mirón, {
      productId: p.id,
      branchId: escenario.sucursales.devoto,
    });

    expect(await prisma.stockOutbox.count()).toBe(0);
  });

  it('18. ningún recorrido de consulta hace HTTP', async () => {
    const p = await articulo('9001');
    await aperturaDeDevoto([{ productId: p.id, cantidad: '10' }]);

    const fetchFalso = vi.fn(async () => {
      throw new Error('Las consultas no salen a la red.');
    });
    vi.stubGlobal('fetch', fetchFalso);
    try {
      await movimientosDelLibro(mirón, {});
      await tableroDeExistencias(mirón, {});
      await auditoriaDeStockErp(mirón, {});
      await diagnosticoDeIntegridad(mirón, {});
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it('19. los dos interruptores reales siguen apagados', async () => {
    const fila = await prisma.stockModuleSetting.findFirstOrThrow();
    expect(fila.realOpeningEnabled).toBe(false);
    expect(fila.realPurchaseReceiptsEnabled).toBe(false);
  });

  it('22. confirmar un comprobante sigue sin recibir stock', async () => {
    const p = await articulo('9001');
    await aperturaDeDevoto([{ productId: p.id, cantidad: '10' }]);
    const antes = await prisma.stockLedger.count({ where: { type: 'PURCHASE_IN' } });

    const borrador = await createDocument(escenario.admin, escenario.sucursales.devoto);
    await confirmDocument(escenario.admin, {
      documentId: borrador.id,
      supplierId: escenario.proveedorId,
      docType: 'FACTURA',
      letter: 'A',
      pointOfSale: '0001',
      number: '88801',
      issueDate: '2026-09-24',
      printed: { netTotal: '1000.00', ivaTotal: '210.00', total: '1210.00' },
      items: [
        {
          lineNumber: 1,
          supplierCode: 'X1',
          description: 'ARTICULO 9001',
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

    expect(await prisma.stockLedger.count({ where: { type: 'PURCHASE_IN' } })).toBe(antes);
    expect(await prisma.stockReceipt.count()).toBe(0);
  });

  it('23. recibir sigue siendo explícito e idempotente', async () => {
    const p = await articulo('9001');
    await aperturaDeDevoto([{ productId: p.id, cantidad: '10' }]);
    const doc = await comprobanteValidado([{ productId: p.id, cantidad: '2' }]);

    const primera = await recibir(doc.id);
    expect(primera.yaEstabaAplicada).toBe(false);
    const segunda = await recibir(doc.id);
    expect(segunda.yaEstabaAplicada, 'la misma, otra vez, no duplica').toBe(true);
    expect(await prisma.stockLedger.count({ where: { type: 'PURCHASE_IN' } })).toBe(1);

    /* Y sin confirmar, no pasa nada. */
    const otro = await comprobanteValidado([{ productId: p.id, cantidad: '1' }]);
    await expect(
      aplicarIngresoDeCompra(operario, {
        documentId: otro.id,
        fecha: DESPUES.fecha,
        hora: DESPUES.hora,
        confirmado: false,
      }),
    ).rejects.toThrow(/segunda confirmación/i);
  });

  it('todas las consultas juntas no escriben una sola fila de existencias', async () => {
    const p = await articulo('9001');
    await aperturaDeDevoto([{ productId: p.id, cantidad: '10' }]);
    const doc = await comprobanteValidado([{ productId: p.id, cantidad: '2' }]);
    await recibir(doc.id);

    const contar = async () => ({
      ledger: await prisma.stockLedger.count(),
      saldos: await prisma.stockBalance.count(),
      operaciones: await prisma.stockOperation.count(),
      recibos: await prisma.stockReceipt.count(),
      bandeja: await prisma.stockOutbox.count(),
    });
    const antes = await contar();

    await movimientosDelLibro(mirón, {}, { tamano: 5 });
    await tableroDeExistencias(mirón, {});
    await auditoriaDeStockErp(mirón, {});
    await diagnosticoDeIntegridad(mirón, {});
    await recorridoCronologico(mirón, { productId: p.id, branchId: escenario.sucursales.devoto });

    expect(await contar()).toEqual(antes);
  });
});
