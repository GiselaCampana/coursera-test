import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '@/lib/db';
import { limpiarBase, sembrarEscenario, type Escenario } from './ayudas';
import { sembrarLaCompraDeEzra, CATALOGO_DE_EZRA } from '../fixtures/compra-de-ezra';
import { EZRA_PIE } from '../fixtures/ezra';
import { ControlDeStockFalso } from '../fixtures/control-de-stock-falso';
import { aplicarCompra, vistaPreviaDeCompra } from '@/lib/services/vista-previa-compra';
import {
  despacharPendientes,
  sincronizacionDe,
  usarTransporteDeStock,
  TRANSPORTE_SIN_CONFIGURAR,
} from '@/lib/services/stock-ingreso';
import { DIRECCION_DE_COMPRA, claveDelEvento } from '@/lib/domain/ingreso-de-stock';
import { Decimal } from '@/lib/money';

/**
 * **La mercadería de una compra entra a Control de Stock, una sola vez.**
 *
 * Entre las dos aplicaciones no hay una transacción, así que lo que se prueba
 * acá no es «el envío anduvo»: es que ninguna de las formas conocidas de que
 * salga mal termine en mercadería perdida o duplicada. Un timeout después de
 * que el otro lado ya aplicó, dos despachos a la vez, aplicar dos veces el
 * mismo comprobante, un rechazo de autenticación.
 *
 * Se prueba contra un Control de Stock de mentira y determinístico —sin red,
 * sin reloj, sin azar— porque el contrato real todavía no está acordado y
 * porque apuntar a existencias reales para «probar» es exactamente lo que no
 * se hace.
 */

let escenario: Escenario;
let completa: string;
let frenada: string;
let stock: ControlDeStockFalso;

/** La forma de pago que Ezra no tiene configurada y hay que elegir. */
const PAGO = { forma: 'TRANSFERENCIA', condicion: { tipo: 'DIAS' as const, dias: 30 } };

/**
 * Las cinco de mercadería, con sus kilos exactos del papel.
 *
 * El PLU sale del catálogo sembrado y no de un número escrito acá: un literal
 * repetido es una copia que algún día deja de coincidir sin que nadie se
 * entere.
 */
const MERCADERIA = [
  { codigo: '47', kg: '4.2400' },
  { codigo: '49', kg: '3.9850' },
  { codigo: '48', kg: '7.3450' },
  { codigo: '10', kg: '4.0400' },
  { codigo: '2514', kg: '7.6650' },
].map((r) => ({ ...r, plu: CATALOGO_DE_EZRA[r.codigo].plu }));

/** Los cinco PLU del catálogo de Ezra, ordenados. */
const PLU_DE_EZRA = Object.values(CATALOGO_DE_EZRA)
  .map((a) => a.plu)
  .sort();

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();
  const sembrada = await sembrarLaCompraDeEzra(prisma, {
    sucursalId: escenario.sucursales.devoto,
    autorId: escenario.admin.id,
  });
  completa = sembrada.completa;
  frenada = sembrada.frenada;

  stock = new ControlDeStockFalso();
  usarTransporteDeStock(stock);
});

afterAll(() => {
  usarTransporteDeStock(TRANSPORTE_SIN_CONFIGURAR);
});

async function aplicar(documentId = completa) {
  return aplicarCompra(escenario.admin, documentId, PAGO);
}

/* ========================================================================== */

describe('lo que entra, y lo que no', () => {
  it('los cinco artículos ingresan con sus kilos exactos', async () => {
    await aplicar();
    await despacharPendientes({ documentId: completa });

    expect(stock.movimientos()).toHaveLength(5);
    for (const esperado of MERCADERIA) {
      const movimientos = stock.movimientosDe(esperado.plu);
      expect(movimientos, `PLU ${esperado.plu}`).toHaveLength(1);
      expect(new Decimal(movimientos[0].quantity).equals(new Decimal(esperado.kg))).toBe(true);
      expect(movimientos[0].unit).toBe('KG');
    }
  });

  it('el movimiento es un INGRESO, nunca un egreso', async () => {
    /*
     * Una compra hace ENTRAR mercadería. Dicho así es obvio, y por eso conviene
     * que sea imposible equivocarlo: mandarla como egreso vacía el depósito de
     * la otra aplicación con números que parecen correctos.
     */
    await aplicar();
    await despacharPendientes({ documentId: completa });

    expect(DIRECCION_DE_COMPRA).toBe('INGRESO');
    for (const movimiento of stock.movimientos()) {
      expect(movimiento.direction).toBe('IN');
      expect(movimiento.reason).toBe('PURCHASE');
      expect(movimiento.direction).not.toMatch(/OUT|EGRESO|VENTA|SALIDA/i);
    }
    const filas = await prisma.stockOutbox.findMany({ where: { documentId: completa } });
    expect(filas.every((f) => f.direction === 'INGRESO')).toBe(true);
  });

  it('la bolsa no genera movimiento y su importe sigue en el total', async () => {
    await aplicar();
    await despacharPendientes({ documentId: completa });

    /*
     * Cinco movimientos, no seis, y ninguno es la bolsa: ni por cantidad —tres
     * exactas, que es lo único que la distingue del pernil de 3,985 kg— ni por
     * unidad, porque las bolsas van en unidades y la mercadería en kilos.
     */
    expect(stock.movimientos()).toHaveLength(5);
    expect(
      stock.movimientos().some((m) => new Decimal(m.quantity).equals(new Decimal(3))),
    ).toBe(false);
    expect(stock.movimientos().every((m) => m.unit === 'KG')).toBe(true);

    // Y el egreso económico cierra en el total impreso, con la bolsa adentro.
    const agenda = await prisma.paymentSchedule.findFirstOrThrow({
      where: { documentId: completa },
    });
    expect(new Decimal(agenda.plannedAmount.toString()).toFixed(2)).toBe(
      new Decimal(EZRA_PIE.total).toFixed(2),
    );
    expect(new Decimal(agenda.plannedAmount.toString()).toFixed(2)).toBe('267880.50');
  });

  it('los artículos se resuelven por PLU y no se crea ninguno nuevo', async () => {
    const antes = await prisma.product.count();
    await aplicar();
    await despacharPendientes({ documentId: completa });

    expect(await prisma.product.count()).toBe(antes);

    // Cada movimiento apunta al PLU del catálogo, no a un nombre parecido.
    expect(stock.movimientos().map((m) => m.plu).sort()).toEqual(PLU_DE_EZRA);
  });

  it('cada fila queda trazable: comprobante, renglón, proveedor, sucursal y usuario', async () => {
    await aplicar();
    const filas = await prisma.stockOutbox.findMany({ where: { documentId: completa } });

    expect(filas).toHaveLength(5);
    for (const fila of filas) {
      expect(fila.documentId).toBe(completa);
      expect(fila.documentItemId).not.toBe('');
      expect(fila.branchId).toBe(escenario.sucursales.devoto);
      expect(fila.supplierId).not.toBeNull();
      expect(fila.requestedById).toBe(escenario.admin.id);
      expect(fila.eventKey).toBe(
        claveDelEvento({ documentId: completa, documentItemId: fila.documentItemId }),
      );
    }
  });
});

/* ========================================================================== */

describe('lo que frena, sin escribir a medias', () => {
  async function loEscrito() {
    return {
      bandeja: await prisma.stockOutbox.count(),
      movimientos: await prisma.purchaseMovement.count(),
      validados: await prisma.document.count({ where: { status: 'VALIDADO' } }),
      productos: await prisma.product.count(),
    };
  }

  it('un PLU vacío frena, y no crea ningún producto', async () => {
    const producto = await prisma.product.findFirstOrThrow({ where: { internalCode: CATALOGO_DE_EZRA['47'].plu } });
    await prisma.product.update({ where: { id: producto.id }, data: { internalCode: '   ' } });

    const antes = await loEscrito();
    await expect(aplicar()).rejects.toThrow(/PLU/i);
    expect(await loEscrito()).toEqual(antes);
    expect(stock.llamadas).toBe(0);
  });

  it('una unidad incompatible frena', async () => {
    // El renglón viene en kilos; el artículo pasa a llevarse por unidad.
    const producto = await prisma.product.findFirstOrThrow({ where: { internalCode: CATALOGO_DE_EZRA['49'].plu } });
    await prisma.product.update({ where: { id: producto.id }, data: { purchaseUnit: 'UNIT' } });

    const antes = await loEscrito();
    await expect(aplicar()).rejects.toThrow(/unidades|kilos/i);
    expect(await loEscrito()).toEqual(antes);
  });

  it('un renglón de mercadería sin artículo frena', async () => {
    // Es la factura 00000186: la bolsa sin código legible y el total sin imprimir.
    const antes = await loEscrito();
    await expect(aplicar(frenada)).rejects.toThrow();
    expect(await loEscrito()).toEqual(antes);
  });

  it('sin la clave de la sucursal el movimiento no sale, y se ve por qué', async () => {
    /*
     * El bloqueo que hay que resolver con Control de Stock: no se acordó con
     * qué identificador conoce a cada local. Mandar el nombre sería elegir la
     * sucursal por parecido, que es lo que no se hace con los artículos.
     */
    await prisma.branch.update({
      where: { id: escenario.sucursales.devoto },
      data: { stockKey: null },
    });

    await aplicar();
    await despacharPendientes({ documentId: completa });

    expect(stock.movimientos()).toHaveLength(0);
    const sync = await sincronizacionDe(completa);
    expect(sync.estado).toBe('FALLIDA');
    expect(sync.motivos.join(' ')).toMatch(/código de Control de Stock/i);
  });
});

/* ========================================================================== */

describe('idempotencia: ni se pierde ni se duplica', () => {
  it('despachar dos veces no duplica el movimiento', async () => {
    await aplicar();
    await despacharPendientes({ documentId: completa });
    await despacharPendientes({ documentId: completa });

    expect(stock.movimientos()).toHaveLength(5);
  });

  it('dos despachos concurrentes tampoco', async () => {
    await aplicar();
    await Promise.all([
      despacharPendientes({ documentId: completa }),
      despacharPendientes({ documentId: completa }),
    ]);

    expect(stock.movimientos()).toHaveLength(5);
    expect(await prisma.stockOutbox.count({ where: { documentId: completa } })).toBe(5);
  });

  it('dos despachos que ven las filas en orden distinto no se trancan entre sí', async () => {
    /*
     * El caso que la prueba de arriba encontraba sólo cuando la máquina estaba
     * cargada, y por eso pasaba en la de desarrollo y fallaba en CI.
     *
     * Las cinco filas se escriben en la misma transacción, así que tienen el
     * mismo `createdAt` al milisegundo. Con el orden empatado, PostgreSQL no
     * promete ninguno: dos despachos pueden recorrerlas al revés uno del otro.
     * Cuando el lote se reclamaba de a una fila, cada uno se quedaba con un
     * pedazo, ninguno juntaba las cinco, y los dos se retiraban dejando la
     * compra sin mandar. Nada se perdía —volvían a PENDIENTE— pero tampoco
     * salía nadie, y eso no se ve hasta que alguien pregunta por qué la
     * mercadería no está del otro lado.
     *
     * Acá el desorden no se espera: se provoca. Un cliente da vuelta lo que
     * devuelve `findMany`, así que los dos despachos recorren exactamente al
     * revés y el empate deja de depender de la suerte de la máquina.
     */
    const alReves = prisma.$extends({
      query: {
        stockOutbox: {
          async findMany({ args, query }) {
            const filas = await query(args);
            return Array.isArray(filas) ? [...filas].reverse() : filas;
          },
        },
      },
    }) as unknown as typeof prisma;

    await aplicar();
    await Promise.all([
      despacharPendientes({ documentId: completa }),
      despacharPendientes({ documentId: completa, cliente: alReves }),
    ]);

    // Uno de los dos se lleva el lote entero. Lo que no puede pasar es que no
    // se lo lleve ninguno.
    expect(stock.movimientos()).toHaveLength(5);
    const sync = await sincronizacionDe(completa);
    expect(sync.estado).toBe('COMPLETADA');
  });

  it('un timeout posterior a que el otro lado aplicó se reintenta sin duplicar', async () => {
    /*
     * El caso peligroso: Control de Stock recibió y aplicó, y la respuesta se
     * perdió. Desde acá es indistinguible de un pedido que nunca llegó, así que
     * el reintento sale igual —es recuperable— y lo único que impide que la
     * mercadería entre dos veces es que lleve la MISMA clave.
     */
    await aplicar();
    stock.seComporta({ tipo: 'PERDER_LA_RESPUESTA' });
    await despacharPendientes({ documentId: completa });

    // Del otro lado ya están los cinco; de este lado no se confirmó ninguno.
    expect(stock.movimientos()).toHaveLength(5);
    const enDuda = await sincronizacionDe(completa);
    expect(enDuda.estado).toBe('PENDIENTE');
    expect(enDuda.completados).toBe(0);

    // El reintento contesta ALREADY_APPLIED y no mueve nada nuevo.
    stock.seComporta({ tipo: 'ACEPTAR' });
    await despacharPendientes({ documentId: completa });

    expect(stock.movimientos()).toHaveLength(5);
    const resuelto = await sincronizacionDe(completa);
    expect(resuelto.estado).toBe('COMPLETADA');
    expect(resuelto.completados).toBe(5);
  });

  it('el reintento lleva exactamente la misma clave, nunca una nueva', async () => {
    /*
     * Es la única razón por la que reintentar es inofensivo. Una clave nueva en
     * el segundo intento haría que Control de Stock lo viera como un movimiento
     * distinto y la mercadería entraría dos veces.
     */
    await aplicar();
    stock.seComporta({ tipo: 'RECUPERABLE', motivo: '503' });
    await despacharPendientes({ documentId: completa });
    const primeras = stock.ultimoLote()!.movements.map((m) => m.idempotencyKey).sort();

    stock.seComporta({ tipo: 'ACEPTAR' });
    await despacharPendientes({ documentId: completa });
    const segundas = stock.ultimoLote()!.movements.map((m) => m.idempotencyKey).sort();

    expect(segundas).toEqual(primeras);
    expect(stock.movimientos()).toHaveLength(5);
  });

  it('el mismo comprobante no se puede aplicar dos veces', async () => {
    await aplicar();
    await despacharPendientes({ documentId: completa });
    await expect(aplicar()).rejects.toThrow();
    expect(stock.movimientos()).toHaveLength(5);
  });
});

/* ========================================================================== */

describe('los errores se ven, y no mueven stock', () => {
  it('un rechazo de autenticación deja la sincronización fallida y recuperable', async () => {
    await aplicar();
    stock.seComporta({ tipo: 'SIN_AUTORIZACION', motivo: '401 INVALID_INTEGRATION_KEY' });
    await despacharPendientes({ documentId: completa });

    expect(stock.movimientos()).toHaveLength(0);
    const sync = await sincronizacionDe(completa);
    expect(sync.estado).toBe('FALLIDA');
    expect(sync.fallidos).toBe(5);
    expect(sync.motivos.join(' ')).toContain('401');

    // Recuperable: corregida la clave, el mismo despacho lo resuelve.
    stock.seComporta({ tipo: 'ACEPTAR' });
    await despacharPendientes({ documentId: completa });
    expect((await sincronizacionDe(completa)).estado).toBe('COMPLETADA');
  });

  it('una caída sin respuesta no se presenta como sincronizada', async () => {
    await aplicar();
    stock.seComporta({ tipo: 'CAERSE', motivo: 'socket hang up' });
    await despacharPendientes({ documentId: completa });

    const sync = await sincronizacionDe(completa);
    expect(sync.estado).not.toBe('COMPLETADA');
    expect(sync.completados).toBe(0);
  });

  it('mientras falte sincronizar, el comprobante no está terminado', async () => {
    await aplicar();
    const reciencita = await sincronizacionDe(completa);
    expect(reciencita.estado).toBe('PENDIENTE');
    expect(reciencita.total).toBe(5);
    expect(reciencita.completados).toBe(0);
  });
});

/* ========================================================================== */

describe('la vista previa sigue sin escribir', () => {
  it('abrirla y recargarla varias veces no anota, no mueve y no crea', async () => {
    const antes = {
      bandeja: await prisma.stockOutbox.count(),
      movimientos: await prisma.purchaseMovement.count(),
      productos: await prisma.product.count(),
      pagos: await prisma.paymentSchedule.count(),
      alias: await prisma.productAlias.count(),
    };

    for (let i = 0; i < 3; i++) await vistaPreviaDeCompra(escenario.admin, completa);

    expect({
      bandeja: await prisma.stockOutbox.count(),
      movimientos: await prisma.purchaseMovement.count(),
      productos: await prisma.product.count(),
      pagos: await prisma.paymentSchedule.count(),
      alias: await prisma.productAlias.count(),
    }).toEqual(antes);
    expect(stock.llamadas).toBe(0);
  });

  it('muestra la sucursal de destino, el PLU y que es un ingreso', async () => {
    const previa = await vistaPreviaDeCompra(escenario.admin, completa);

    expect(previa.stock.sucursal?.nombre).toBe('Devoto');
    expect(previa.stock.direccion).toBe('Ingreso por compra');
    expect(previa.stock.movimientos).toHaveLength(5);
    expect(previa.stock.movimientos.map((m) => m.plu).sort()).toEqual(PLU_DE_EZRA);
    // Y la bolsa, aparte y sin impacto.
    expect(previa.gastos).toHaveLength(1);
  });
});
