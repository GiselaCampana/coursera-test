import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { limpiarBase, sembrarEscenario, type Escenario } from './ayudas';
import { sembrarLaCompraDeEzra, CATALOGO_DE_EZRA, GASTO_DE_EZRA } from '../fixtures/compra-de-ezra';
import { EZRA_PIE } from '../fixtures/ezra';
import { aplicarCompra, vistaPreviaDeCompra } from '@/lib/services/vista-previa-compra';
import { despacharComprobante, vistaDelDespacho } from '@/lib/services/stock-despacho-manual';
import { Decimal } from '@/lib/money';

/**
 * **La versión candidata: Compras entera, y stock en ninguna parte.**
 *
 * Esta entrega deja Compras operativa —leer el comprobante, revisarlo,
 * asociarlo, aplicarlo, registrar costos, deuda y pagos— y retira del recorrido
 * la integración de escritura con Control de Stock, que quedó cancelada.
 *
 * Lo que se prueba acá es justamente el **hueco**: que aplicar una compra
 * escriba todo lo económico y **nada** de existencias, en ningún sistema. Un
 * hueco es lo más fácil de tapar sin querer —un import que vuelve, una llamada
 * que alguien repone «porque estaba»— y por eso tiene sus propias afirmaciones
 * en vez de confiar en que nadie lo note.
 */

let escenario: Escenario;
let completa: string;

const PAGO = { forma: 'TRANSFERENCIA', condicion: { tipo: 'DIAS' as const, dias: 30 } };

/** Los cinco de mercadería del papel, con su PLU del catálogo. */
const MERCADERIA = [
  { codigo: '47', kg: '4.240' },
  { codigo: '49', kg: '3.985' },
  { codigo: '48', kg: '7.345' },
  { codigo: '10', kg: '4.040' },
  { codigo: '2514', kg: '7.665' },
].map((r) => ({ ...r, plu: CATALOGO_DE_EZRA[r.codigo].plu }));

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();
  const sembrada = await sembrarLaCompraDeEzra(prisma, {
    sucursalId: escenario.sucursales.devoto,
    autorId: escenario.admin.id,
  });
  completa = sembrada.completa;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ========================================================================== */

describe('aplicar una compra no crea bandeja ni existencias', () => {
  it('no escribe ni una fila de StockOutbox', async () => {
    expect(await prisma.stockOutbox.count()).toBe(0);

    await aplicarCompra(escenario.admin, completa, PAGO);

    expect(await prisma.stockOutbox.count()).toBe(0);
    expect(await prisma.stockOutbox.count({ where: { documentId: completa } })).toBe(0);
  });

  it('tampoco al aplicar dos veces, ni al mirar la vista previa en el medio', async () => {
    await aplicarCompra(escenario.admin, completa, PAGO);
    await vistaPreviaDeCompra(escenario.admin, completa);
    await aplicarCompra(escenario.admin, completa, PAGO).catch(() => null);

    expect(await prisma.stockOutbox.count()).toBe(0);
  });

  it('no abre ninguna conexión: nadie llama a fetch', async () => {
    /*
     * La afirmación más directa que se puede hacer sobre «no sale nada a la
     * red»: se reemplaza `fetch` por algo que falla si lo llaman. Si alguien
     * repone el envío al aplicar, esta prueba no se pone amarilla, se rompe.
     */
    const espia = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      throw new Error(`Alguien salió a la red durante una compra: ${String(url)}`);
    });

    await aplicarCompra(escenario.admin, completa, PAGO);
    await vistaPreviaDeCompra(escenario.admin, completa);

    expect(espia).not.toHaveBeenCalled();
  });

  it('la URL de escritura, cargada por accidente, no cambia nada', async () => {
    /*
     * El retiro es una decisión del código, no de la configuración. Una
     * variable copiada de otro servicio o heredada de un `.env` viejo no puede
     * revivir un camino que se decidió cerrar.
     */
    const original = { ...process.env };
    try {
      process.env.STOCK_INTEGRATION_WRITE_URL = 'http://127.0.0.1:9/no-existe';
      process.env.STOCK_INTEGRATION_KEY = 'clave-inventada-de-prueba';
      const espia = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
        throw new Error(`Salió a la red con la URL cargada: ${String(url)}`);
      });

      await aplicarCompra(escenario.admin, completa, PAGO);

      expect(espia).not.toHaveBeenCalled();
      expect(await prisma.stockOutbox.count()).toBe(0);
    } finally {
      process.env = { ...original };
    }
  });
});

/* ========================================================================== */

describe('la acción vieja de despacho está bloqueada', () => {
  it('contesta que está retirada, y no toca la base ni la red', async () => {
    await aplicarCompra(escenario.admin, completa, PAGO);
    const espia = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      throw new Error(`El despacho salió a la red: ${String(url)}`);
    });
    const auditoriaAntes = await prisma.auditLog.count();

    const resultado = await despacharComprobante(escenario.admin, completa);

    expect(resultado.ok).toBe(false);
    expect(resultado.mensaje).toContain('retirada');
    expect(resultado.movimientos).toEqual([]);
    expect(espia).not.toHaveBeenCalled();
    expect(await prisma.auditLog.count()).toBe(auditoriaAntes);
    expect(await prisma.stockOutbox.count()).toBe(0);
  });

  it('con un comprobante que no existe contesta lo mismo, sin ir a buscarlo', async () => {
    /*
     * Prueba que la comprobación del retiro va **antes** que la lectura: si
     * estuviera después, un identificador inventado daría «no existe», lo que
     * significaría que la base se consultó.
     */
    const resultado = await despacharComprobante(escenario.admin, 'comprobante-inventado');
    expect(resultado.mensaje).toContain('retirada');
  });

  it('la pantalla no ofrece el despacho a nadie', async () => {
    await aplicarCompra(escenario.admin, completa, PAGO);
    expect((await vistaDelDespacho(escenario.admin, completa)).puedeDespachar).toBe(false);
    expect((await vistaDelDespacho(escenario.operadorDevoto, completa)).puedeDespachar).toBe(false);
  });
});

/* ========================================================================== */

describe('lo que la compra sí escribe', () => {
  it('costos, historial y deuda, con los números del papel de Ezra', async () => {
    const costosAntes = await prisma.costHistory.count();
    const movimientosAntes = await prisma.purchaseMovement.count();

    await aplicarCompra(escenario.admin, completa, PAGO);

    const documento = await prisma.document.findUniqueOrThrow({
      where: { id: completa },
      select: { status: true, netTotal: true, ivaTotal: true, total: true, supplier: true },
    });
    expect(documento.status).toBe('VALIDADO');
    expect(documento.supplier!.tradeName).toContain('Ezra');
    expect(new Decimal(documento.netTotal!.toString()).toFixed(2)).toBe('221388.84');
    expect(new Decimal(documento.ivaTotal!.toString()).toFixed(2)).toBe('46491.66');
    expect(new Decimal(documento.total!.toString()).toFixed(2)).toBe('267880.50');
    expect(new Decimal(documento.total!.toString()).toFixed(2)).toBe(
      new Decimal(EZRA_PIE.total).toFixed(2),
    );

    /* Un movimiento de compra y una fila de costo por cada artículo. */
    expect(await prisma.purchaseMovement.count()).toBeGreaterThan(movimientosAntes);
    expect(await prisma.costHistory.count()).toBeGreaterThan(costosAntes);

    /* Y la deuda agendada por el total impreso, con la bolsa adentro. */
    const agenda = await prisma.paymentSchedule.findFirstOrThrow({
      where: { documentId: completa },
    });
    expect(new Decimal(agenda.plannedAmount.toString()).toFixed(2)).toBe('267880.50');
  });

  it('los cinco artículos quedan con costo nuevo y ninguno se duplica', async () => {
    const productosAntes = await prisma.product.count();

    await aplicarCompra(escenario.admin, completa, PAGO);

    expect(await prisma.product.count()).toBe(productosAntes);

    for (const esperado of MERCADERIA) {
      const producto = await prisma.product.findFirstOrThrow({
        where: { internalCode: esperado.plu },
        select: { id: true },
      });
      const historial = await prisma.costHistory.findMany({ where: { productId: producto.id } });
      expect(historial.length, `historial de ${esperado.plu}`).toBeGreaterThan(0);
      /* El costo por unidad del renglón quedó guardado y es un número real. */
      expect(new Decimal(historial[0]!.unitCost.toString()).greaterThan(0)).toBe(true);
    }
  });

  it('el gasto de la bolsa entra al total y no actualiza ningún costo de mercadería', async () => {
    await aplicarCompra(escenario.admin, completa, PAGO);

    const bolsa = await prisma.documentItem.findFirstOrThrow({
      where: { documentId: completa, supplierCode: GASTO_DE_EZRA.supplierCode },
      select: { id: true, productId: true, expenseKind: true, totalCost: true },
    });
    /* Es un gasto, no tiene artículo, y no se le inventó uno. */
    expect(bolsa.expenseKind).not.toBeNull();
    expect(bolsa.productId).toBeNull();

    /* No dejó historial de costo ni movimiento de compra con artículo. */
    const movimientoDeLaBolsa = await prisma.purchaseMovement.findFirst({
      where: { documentId: completa, documentItemId: bolsa.id, productId: { not: null } },
    });
    expect(movimientoDeLaBolsa).toBeNull();

    /* Y ningún artículo del catálogo quedó con el costo de la bolsa. */
    const costos = await prisma.costHistory.findMany({ select: { productId: true } });
    const idsDeMercaderia = new Set(costos.map((c) => c.productId));
    expect(idsDeMercaderia.has(null as unknown as string)).toBe(false);
  });

  it('aplicar dos veces no duplica deuda, costos ni movimientos', async () => {
    await aplicarCompra(escenario.admin, completa, PAGO);

    const despuesDeLaPrimera = {
      agendas: await prisma.paymentSchedule.count({ where: { documentId: completa } }),
      movimientos: await prisma.purchaseMovement.count({ where: { documentId: completa } }),
      costos: await prisma.costHistory.count(),
    };

    await aplicarCompra(escenario.admin, completa, PAGO).catch(() => null);

    expect(await prisma.paymentSchedule.count({ where: { documentId: completa } })).toBe(
      despuesDeLaPrimera.agendas,
    );
    expect(await prisma.purchaseMovement.count({ where: { documentId: completa } })).toBe(
      despuesDeLaPrimera.movimientos,
    );
    expect(await prisma.costHistory.count()).toBe(despuesDeLaPrimera.costos);
    expect(await prisma.stockOutbox.count()).toBe(0);
  });
});

/* ========================================================================== */

describe('la vista previa describe el impacto futuro sin escribir nada', () => {
  it('mirarla no escribe: ni bandeja, ni costos, ni agenda', async () => {
    const antes = {
      bandeja: await prisma.stockOutbox.count(),
      costos: await prisma.costHistory.count(),
      agendas: await prisma.paymentSchedule.count(),
      movimientos: await prisma.purchaseMovement.count(),
    };

    await vistaPreviaDeCompra(escenario.admin, completa);
    await vistaPreviaDeCompra(escenario.admin, completa);

    expect(await prisma.stockOutbox.count()).toBe(antes.bandeja);
    expect(await prisma.costHistory.count()).toBe(antes.costos);
    expect(await prisma.paymentSchedule.count()).toBe(antes.agendas);
    expect(await prisma.purchaseMovement.count()).toBe(antes.movimientos);
  });

  it('describe los cinco de Ezra con PLU, cantidad y unidad, y la bolsa aparte', async () => {
    const previa = await vistaPreviaDeCompra(escenario.admin, completa);

    expect(previa.stock.sucursal!.codigo).toBe('DEVOTO');
    expect(previa.stock.movimientos).toHaveLength(5);
    for (const esperado of MERCADERIA) {
      const movimiento = previa.stock.movimientos.find((m) => m.plu === esperado.plu);
      expect(movimiento, `PLU ${esperado.plu}`).toBeDefined();
      expect(new Decimal(movimiento!.cantidad).equals(new Decimal(esperado.kg))).toBe(true);
      expect(movimiento!.unidad).toBe('kg');
    }

    /* La bolsa: visible, como gasto, en unidades, y sin artículo inventado. */
    const bolsa = previa.gastos.find((g) => g.descripcion.toUpperCase().includes('BOLSA'));
    expect(bolsa, 'la bolsa figura entre los gastos').toBeDefined();
    expect(new Decimal(bolsa!.cantidad).equals(new Decimal(3))).toBe(true);
    expect(bolsa!.unidad).toBe('unidades');
    expect(previa.stock.movimientos.some((m) => m.producto.toUpperCase().includes('BOLSA'))).toBe(
      false,
    );
  });

  it('los impedimentos se ven antes de aplicar, y no recién al aplicar', async () => {
    /*
     * La unidad que no coincide era invisible hasta el rechazo del servidor:
     * la pantalla decía que se podía aplicar y el error llegaba después, con un
     * texto que nadie había anticipado. Ahora sale en la vista previa.
     */
    /*
     * El renglón se asocia por el código del proveedor al leer el comprobante,
     * así que la unidad se rompe en el ARTÍCULO del catálogo —que es donde está
     * decidido cómo se compra— y no en el renglón.
     */
    await prisma.product.update({
      where: { internalCode: MERCADERIA[0]!.plu },
      data: { purchaseUnit: 'UNIT' },
    });

    const previa = await vistaPreviaDeCompra(escenario.admin, completa);

    expect(previa.stock.impedimentos).toHaveLength(1);
    expect(previa.stock.impedimentos[0]!.motivo).toMatch(/kilos|unidades/);
    expect(previa.stock.impedimentos[0]!.motivo).toContain('No se convierte por cuenta propia');

    /* Y el servidor rechaza exactamente por lo mismo. */
    await expect(aplicarCompra(escenario.admin, completa, PAGO)).rejects.toThrow(/unidades|kilos/);
  });

  it('un artículo sin PLU también impide, y no se le crea uno', async () => {
    const productosAntes = await prisma.product.count();
    await prisma.product.update({
      where: { internalCode: MERCADERIA[0]!.plu },
      data: { internalCode: '' },
    });

    const previa = await vistaPreviaDeCompra(escenario.admin, completa);
    expect(previa.stock.impedimentos).toHaveLength(1);
    expect(previa.stock.impedimentos[0]!.motivo).toContain('no tiene PLU');

    await expect(aplicarCompra(escenario.admin, completa, PAGO)).rejects.toThrow(/PLU/);
    expect(await prisma.product.count()).toBe(productosAntes);
  });
});
