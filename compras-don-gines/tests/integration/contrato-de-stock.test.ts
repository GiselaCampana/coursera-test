import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { limpiarBase, sembrarEscenario, type Escenario } from './ayudas';
import { sembrarLaCompraDeEzra, CATALOGO_DE_EZRA } from '../fixtures/compra-de-ezra';
import { EZRA_ENCABEZADO, EZRA_PIE } from '../fixtures/ezra';
import { ControlDeStockFalso } from '../fixtures/control-de-stock-falso';
import { aplicarCompra } from '@/lib/services/vista-previa-compra';
import {
  despacharPendientes,
  sincronizacionDe,
  usarTransporteDeStock,
  TRANSPORTE_SIN_CONFIGURAR,
} from '@/lib/services/stock-ingreso';
import { TRANSPORTE_HTTP, interpretarRespuesta } from '@/lib/services/stock-transporte-http';
import { Decimal } from '@/lib/money';

/**
 * **El contrato con Control de Stock, versión 1, mirado carácter por carácter.**
 *
 * Lo que se prueba acá no es que «el envío anduvo»: es el **cuerpo exacto** que
 * sale, porque del otro lado lo va a leer una aplicación que no controlamos y
 * un campo mal escrito no se ve hasta que la mercadería entra al local
 * equivocado, o entra dos veces, o no entra.
 *
 * El transporte real se prueba sin red, contra un `fetch` sustituido: así se
 * puede afirmar la URL, el método y el encabezado sin abrir un socket ni tocar
 * el Control de Stock publicado.
 */

let escenario: Escenario;
let completa: string;
let stock: ControlDeStockFalso;

const PAGO = { forma: 'TRANSFERENCIA', condicion: { tipo: 'DIAS' as const, dias: 30 } };

/** Los kilos del papel, con el PLU que les corresponde en el catálogo. */
const ESPERADOS = [
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
  stock = new ControlDeStockFalso();
  usarTransporteDeStock(stock);
});

afterAll(() => usarTransporteDeStock(TRANSPORTE_SIN_CONFIGURAR));

async function aplicarYDespachar() {
  await aplicarCompra(escenario.admin, completa, PAGO);
  await despacharPendientes({ documentId: completa });
}

/* ========================================================================== */

describe('el cuerpo que viaja', () => {
  it('lleva la versión, el origen y la compra', async () => {
    await aplicarYDespachar();
    const lote = stock.ultimoLote()!;

    expect(lote.contractVersion).toBe(1);
    expect(lote.source).toBe('compras-don-gines');
    expect(lote.purchaseId).toBe(completa);
  });

  it('la sucursal viaja como branches.code de Control de Stock', async () => {
    /*
     * `devoto`, no «Devoto» ni el identificador interno de Compras. El código
     * es lo único estable entre desarrollo, prueba y producción; el nombre
     * tiene acentos y mayúsculas, y el id cambia de base en base.
     */
    await aplicarYDespachar();
    expect(stock.ultimoLote()!.branchCode).toBe('devoto');
  });

  it('Pueyrredón y San Martín también viajan por su código', async () => {
    const sucursales = await prisma.branch.findMany({ orderBy: { code: 'asc' } });
    expect(sucursales.map((s) => [s.code, s.stockKey])).toEqual([
      ['DEVOTO', 'devoto'],
      ['PUEYRREDON', 'pueyrredon'],
      ['SAN_MARTIN', 'san_martin'],
    ]);
  });

  it('el encabezado del comprobante y quién lo confirmó', async () => {
    await aplicarYDespachar();
    const lote = stock.ultimoLote()!;

    expect(lote.document.documentId).toBe(completa);
    expect(lote.document.number).toBe(EZRA_ENCABEZADO.number);
    expect(lote.document.pointOfSale).toBe(EZRA_ENCABEZADO.pointOfSale);
    expect(lote.document.type).toBe(EZRA_ENCABEZADO.letter);
    expect(lote.document.issuedAt).toBe(EZRA_ENCABEZADO.issueDate);
    // El CUIT sin guiones: el identificador, no su presentación.
    expect(lote.document.supplierTaxId).toBe(EZRA_ENCABEZADO.cuit.replace(/\D/g, ''));
    expect(lote.confirmedBy.userId).toBe(escenario.admin.id);
  });

  it('exactamente cinco movimientos, con los kilos como cadenas decimales', async () => {
    await aplicarYDespachar();
    const lote = stock.ultimoLote()!;

    expect(lote.movements).toHaveLength(5);
    for (const esperado of ESPERADOS) {
      const movimiento = lote.movements.find((m) => m.plu === esperado.plu);
      expect(movimiento, `PLU ${esperado.plu}`).toBeDefined();
      /*
       * Cadena, no número: 4,240 pasado por un flotante vuelve como 4.24 y los
       * tres decimales del papel dejan de serlo.
       */
      expect(typeof movimiento!.quantity).toBe('string');
      /*
       * La comparación es LITERAL, no por valor decimal. «4.24» y «4.240» son
       * el mismo peso, pero la idempotencia compara contenido: dos cadenas
       * distintas para el mismo peso producirían un conflicto que no existe.
       */
      expect(movimiento!.quantity, `PLU ${esperado.plu}`).toBe(esperado.kg);
      expect(movimiento!.unit).toBe('KG');
    }
  });

  it('todas las cantidades salen con tres decimales exactos', async () => {
    await aplicarYDespachar();
    for (const movimiento of stock.ultimoLote()!.movements) {
      expect(movimiento.quantity, movimiento.plu).toMatch(/^\d+\.\d{3}$/);
    }
    // Y los cinco, en orden, son los del papel.
    expect(
      stock.ultimoLote()!.movements.map((m) => m.quantity).sort(),
    ).toEqual(['3.985', '4.040', '4.240', '7.345', '7.665']);
  });

  it('un reintento manda exactamente el mismo cuerpo serializado', async () => {
    /*
     * Byte por byte. Si la serialización dependiera de algo que cambia —el
     * reloj, el orden de un Map, la escala de un decimal— el segundo intento
     * sería un contenido distinto bajo la misma clave, que es justamente lo
     * que Control de Stock tiene que rechazar como conflicto.
     */
    await aplicarCompra(escenario.admin, completa, PAGO);
    stock.seComporta({ tipo: 'RECUPERABLE', motivo: '503' });
    await despacharPendientes({ documentId: completa });
    const primero = JSON.stringify(stock.ultimoLote());

    stock.seComporta({ tipo: 'ACEPTAR' });
    await despacharPendientes({ documentId: completa });
    const segundo = JSON.stringify(stock.ultimoLote());

    expect(segundo).toBe(primero);
  });

  it('una cantidad con más de tres decimales frena el lote, sin redondear', async () => {
    await aplicarCompra(escenario.admin, completa, PAGO);
    const fila = await prisma.stockOutbox.findFirstOrThrow({ where: { documentId: completa } });
    await prisma.stockOutbox.update({ where: { id: fila.id }, data: { quantity: '4.2401' } });

    await despacharPendientes({ documentId: completa });

    // No salió nada: el lote es atómico y el motivo nombra el valor.
    expect(stock.llamadas).toBe(0);
    const sync = await sincronizacionDe(completa);
    expect(sync.estado).toBe('FALLIDA');
    expect(sync.motivos.join(' ')).toContain('4.2401');
    expect(sync.motivos.join(' ')).toMatch(/no se redondea/i);
  });

  it('todos van como IN por PURCHASE, y ninguno de otra manera', async () => {
    await aplicarYDespachar();
    for (const movimiento of stock.ultimoLote()!.movements) {
      expect(movimiento.direction).toBe('IN');
      expect(movimiento.reason).toBe('PURCHASE');
    }
  });

  it('la bolsa no viaja: ni como movimiento, ni con PLU, ni en otro lote', async () => {
    await aplicarYDespachar();

    expect(stock.lotes).toHaveLength(1);
    const lote = stock.lotes[0];
    expect(lote.movements).toHaveLength(5);
    expect(lote.movements.some((m) => m.unit === 'UNIT')).toBe(false);
    /*
     * Ni «3.000», que es como la bolsa se ve en pantalla ahora que la escala
     * es fija. Con tres decimales en todos lados, la única manera de saber
     * que la bolsa no viaja es que no esté.
     */
    expect(lote.movements.some((m) => m.quantity === '3.000')).toBe(false);
    expect(lote.movements.some((m) => new Decimal(m.quantity).equals(new Decimal(3)))).toBe(false);
    // Y su importe sigue adentro del egreso.
    const agenda = await prisma.paymentSchedule.findFirstOrThrow({
      where: { documentId: completa },
    });
    expect(new Decimal(agenda.plannedAmount.toString()).toFixed(2)).toBe(
      new Decimal(EZRA_PIE.total).toFixed(2),
    );
  });

  it('el renglón de la bolsa queda sin artículo y clasificado como gasto', async () => {
    /*
     * La regla de más arriba, aislada: al confirmar, un renglón clasificado
     * como gasto **no recibe artículo**. Sin esto, la bolsa quedaría afuera del
     * stock sólo porque no hay ningún artículo parecido en el catálogo, que es
     * una casualidad de estos datos y no una garantía.
     */
    await aplicarYDespachar();
    const bolsa = await prisma.documentItem.findFirstOrThrow({
      where: { documentId: completa, supplierCode: '4249' },
    });

    expect(bolsa.productId).toBeNull();
    expect(bolsa.expenseKind).not.toBeNull();
    expect(bolsa.unit).toBe('UNIT');
    expect(new Decimal(bolsa.quantity.toString()).equals(new Decimal(3))).toBe(true);
    // Y no hay ninguna fila de bandeja para ese renglón.
    expect(await prisma.stockOutbox.count({ where: { documentItemId: bolsa.id } })).toBe(0);
  });

  it('aunque exista un alias que apunte la bolsa a un artículo, sigue sin entrar', async () => {
    /*
     * El caso que esta regla existe para cubrir: alguien asocia el código 4249
     * a un artículo del catálogo, por error o para «que no quede en rojo».
     * Desde ese momento la bolsa tendría artículo, y lo único que la mantiene
     * fuera del stock es que está clasificada como gasto.
     *
     * Sin este alias el renglón no tiene a qué parecerse y la regla no se
     * puede ejercitar: quedaría cubierta por una casualidad de estos datos.
     */
    const proveedor = await prisma.supplier.findFirstOrThrow({
      where: { cuit: EZRA_ENCABEZADO.cuit },
    });
    const otro = await prisma.product.findFirstOrThrow({
      where: { internalCode: CATALOGO_DE_EZRA['47'].plu },
    });
    await prisma.productAlias.create({
      data: {
        productId: otro.id,
        supplierId: proveedor.id,
        supplierCode: '4249',
        alias: 'BOLSA GRANDE',
        normalized: 'bolsa grande',
        origin: 'MANUAL',
      },
    });

    await aplicarYDespachar();

    const bolsa = await prisma.documentItem.findFirstOrThrow({
      where: { documentId: completa, supplierCode: '4249' },
    });
    expect(bolsa.productId).toBeNull();
    expect(stock.ultimoLote()!.movements).toHaveLength(5);
    expect(await prisma.stockOutbox.count({ where: { documentItemId: bolsa.id } })).toBe(0);
  });

  it('cada movimiento se puede rastrear hasta su renglón', async () => {
    await aplicarYDespachar();
    const filas = await prisma.stockOutbox.findMany({ where: { documentId: completa } });
    const lote = stock.ultimoLote()!;

    for (const movimiento of lote.movements) {
      const fila = filas.find((f) => f.documentItemId === movimiento.sourceLineId);
      expect(fila, movimiento.sourceLineId).toBeDefined();
      expect(movimiento.idempotencyKey).toBe(fila!.eventKey);
    }
  });
});

/* ========================================================================== */

describe('cómo se interpreta la respuesta', () => {
  it('APPLIED termina la sincronización', async () => {
    await aplicarYDespachar();
    expect((await sincronizacionDe(completa)).estado).toBe('COMPLETADA');
  });

  it('ALREADY_APPLIED también, y sin sumar existencias', async () => {
    await aplicarYDespachar();
    // Se fuerza un segundo despacho sobre las mismas filas.
    await prisma.stockOutbox.updateMany({
      where: { documentId: completa },
      data: { status: 'PENDIENTE', attempts: 0 },
    });
    await despacharPendientes({ documentId: completa });

    expect(stock.movimientos()).toHaveLength(5);
    expect(stock.lotes).toHaveLength(2);
    expect(
      Object.values(stock.lotes[1].movements).every((m) => m.idempotencyKey.startsWith('compras')),
    ).toBe(true);
    expect((await sincronizacionDe(completa)).estado).toBe('COMPLETADA');
  });

  for (const caso of [
    { nombre: '401/403 queda visible como configuración', tipo: 'SIN_AUTORIZACION' as const },
    { nombre: '409 queda visible como conflicto', tipo: 'CONFLICTO' as const },
    { nombre: '422 queda visible como contenido a corregir', tipo: 'RECHAZAR' as const },
  ]) {
    it(caso.nombre, async () => {
      await aplicarCompra(escenario.admin, completa, PAGO);
      stock.seComporta({ tipo: caso.tipo, motivo: `motivo de ${caso.tipo}` });
      await despacharPendientes({ documentId: completa });

      const sync = await sincronizacionDe(completa);
      expect(sync.estado).toBe('FALLIDA');
      expect(sync.fallidos).toBe(5);
      expect(sync.motivos.join(' ')).toContain(caso.tipo);
      expect(stock.movimientos()).toHaveLength(0);
    });
  }

  it('un 5xx conserva el lote para reintentar, con la misma clave', async () => {
    await aplicarCompra(escenario.admin, completa, PAGO);
    stock.seComporta({ tipo: 'RECUPERABLE', motivo: '503 desde Control de Stock' });
    await despacharPendientes({ documentId: completa });

    const sync = await sincronizacionDe(completa);
    expect(sync.estado).toBe('PENDIENTE');
    expect(sync.motivos.join(' ')).toContain('503');
  });

  it('una respuesta malformada nunca se considera éxito', async () => {
    await aplicarCompra(escenario.admin, completa, PAGO);
    stock.seComporta({ tipo: 'RESPUESTA_INVALIDA', motivo: 'contestó cualquier cosa' });
    await despacharPendientes({ documentId: completa });

    const sync = await sincronizacionDe(completa);
    expect(sync.estado).not.toBe('COMPLETADA');
    expect(sync.completados).toBe(0);
  });

  it('la misma clave con otro contenido es un conflicto', async () => {
    await aplicarYDespachar();

    // Se cambia la cantidad de una fila ya aplicada y se reenvía.
    const fila = await prisma.stockOutbox.findFirstOrThrow({ where: { documentId: completa } });
    await prisma.stockOutbox.update({
      where: { id: fila.id },
      data: { quantity: '99.0000', status: 'PENDIENTE', attempts: 0 },
    });
    await prisma.stockOutbox.updateMany({
      where: { documentId: completa },
      data: { status: 'PENDIENTE', attempts: 0 },
    });
    await despacharPendientes({ documentId: completa });

    const sync = await sincronizacionDe(completa);
    expect(sync.estado).toBe('FALLIDA');
    expect(sync.motivos.join(' ')).toMatch(/otro contenido/i);
    // Y del otro lado sigue habiendo cinco, con las cantidades originales.
    expect(stock.movimientos()).toHaveLength(5);
    expect(stock.movimientos().some((m) => m.quantity.startsWith('99'))).toBe(false);
  });
});

/* ========================================================================== */

describe('el transporte HTTP real', () => {
  const original = { ...process.env };
  let llamadas: { url: string; init: RequestInit }[] = [];

  beforeEach(() => {
    llamadas = [];
    vi.stubGlobal('fetch', async (url: URL | string, init: RequestInit) => {
      llamadas.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          contractVersion: 1,
          purchaseId: 'p1',
          status: 'APPLIED',
          movements: [{ idempotencyKey: 'k1', status: 'APPLIED', movementId: 'cs-1' }],
        }),
        { status: 200 },
      );
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...original };
  });

  const LOTE = {
    contractVersion: 1 as const,
    source: 'compras-don-gines' as const,
    purchaseId: 'p1',
    branchCode: 'devoto',
    document: {
      documentId: 'd1',
      type: 'A',
      pointOfSale: '0002',
      number: '00000185',
      issuedAt: '2026-09-09',
      supplierTaxId: '30719519608',
      supplierName: 'Distribuidora Ezra',
    },
    confirmedBy: { userId: 'u1', name: 'Ana Administradora' },
    movements: [
      {
        sourceLineId: 'l1',
        idempotencyKey: 'k1',
        plu: '3101',
        quantity: '4.240',
        unit: 'KG' as const,
        direction: 'IN' as const,
        reason: 'PURCHASE' as const,
      },
    ],
  };

  it('usa la URL configurada, el método POST y Authorization: Bearer', async () => {
    process.env.STOCK_INTEGRATION_WRITE_URL =
      'https://ejemplo.invalido/api/integrations/stock-movements';
    process.env.STOCK_INTEGRATION_KEY = 'clave-de-prueba';

    const resultado = await TRANSPORTE_HTTP.enviar(LOTE);

    expect(resultado.clase).toBe('APLICADO');
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0].url).toBe('https://ejemplo.invalido/api/integrations/stock-movements');
    expect(llamadas[0].init.method).toBe('POST');
    const encabezados = llamadas[0].init.headers as Record<string, string>;
    expect(encabezados.Authorization).toBe('Bearer clave-de-prueba');
    expect(encabezados['Content-Type']).toBe('application/json');
  });

  it('la URL de escritura no se deriva de la del catálogo', async () => {
    /*
     * Reemplazar texto dentro de una URL —«catalog» por «stock-movements»—
     * funciona hasta el día que el otro lado mueve una ruta, y entonces manda
     * movimientos de stock a un lugar que nadie revisó.
     */
    process.env.STOCK_CATALOG_URL = 'https://ejemplo.invalido/api/integrations/catalog';
    delete process.env.STOCK_INTEGRATION_WRITE_URL;
    process.env.STOCK_INTEGRATION_KEY = 'clave-de-prueba';

    const resultado = await TRANSPORTE_HTTP.enviar(LOTE);
    expect(resultado.clase).toBe('SIN_CONFIGURAR');
    expect(llamadas).toHaveLength(0);
  });

  it('sin URL o sin clave no hay ninguna llamada de red', async () => {
    delete process.env.STOCK_INTEGRATION_WRITE_URL;
    delete process.env.STOCK_INTEGRATION_KEY;

    const resultado = await TRANSPORTE_HTTP.enviar(LOTE);
    expect(resultado.clase).toBe('SIN_CONFIGURAR');
    if (resultado.clase === 'SIN_CONFIGURAR') {
      // Nombra las variables que faltan, nunca su valor.
      expect(resultado.motivo).toContain('STOCK_INTEGRATION_WRITE_URL');
      expect(resultado.motivo).toContain('STOCK_INTEGRATION_KEY');
    }
    expect(llamadas).toHaveLength(0);
  });

  it('el secreto no aparece en ningún motivo', async () => {
    const SECRETO = 'secreto-que-no-tiene-que-salir';
    process.env.STOCK_INTEGRATION_WRITE_URL = 'https://ejemplo.invalido/api/x';
    process.env.STOCK_INTEGRATION_KEY = SECRETO;

    for (const estado of [401, 403, 409, 422, 500, 503, 418]) {
      vi.stubGlobal('fetch', async () => new Response('{}', { status: estado }));
      const resultado = await TRANSPORTE_HTTP.enviar(LOTE);
      expect(JSON.stringify(resultado), `estado ${estado}`).not.toContain(SECRETO);
    }
  });

  it('clasifica cada código de estado como corresponde', async () => {
    process.env.STOCK_INTEGRATION_WRITE_URL = 'https://ejemplo.invalido/api/x';
    process.env.STOCK_INTEGRATION_KEY = 'clave';

    const casos: [number, string][] = [
      [401, 'SIN_AUTORIZACION'],
      [403, 'SIN_AUTORIZACION'],
      [409, 'CONFLICTO'],
      [422, 'RECHAZADO'],
      [429, 'RECUPERABLE'],
      [500, 'RECUPERABLE'],
      [503, 'RECUPERABLE'],
      [418, 'RESPUESTA_INVALIDA'],
    ];
    for (const [estado, clase] of casos) {
      vi.stubGlobal('fetch', async () => new Response('{}', { status: estado }));
      expect((await TRANSPORTE_HTTP.enviar(LOTE)).clase, `estado ${estado}`).toBe(clase);
    }
  });

  it('un 200 que no es este contrato no es un éxito', () => {
    expect(interpretarRespuesta('no es json').clase).toBe('RESPUESTA_INVALIDA');
    expect(interpretarRespuesta('{"ok":true}').clase).toBe('RESPUESTA_INVALIDA');
    expect(
      interpretarRespuesta('{"contractVersion":2,"status":"APPLIED","movements":[]}').clase,
    ).toBe('RESPUESTA_INVALIDA');
    expect(
      interpretarRespuesta('{"contractVersion":1,"status":"REJECTED","movements":[]}').clase,
    ).toBe('RESPUESTA_INVALIDA');
    expect(interpretarRespuesta('{"contractVersion":1,"status":"APPLIED"}').clase).toBe(
      'RESPUESTA_INVALIDA',
    );
    expect(
      interpretarRespuesta('{"contractVersion":1,"status":"APPLIED","movements":[]}').clase,
    ).toBe('RESPUESTA_INVALIDA');
  });

  it('un acuse bien formado se lee, con APPLIED y ALREADY_APPLIED', () => {
    const resultado = interpretarRespuesta(
      JSON.stringify({
        contractVersion: 1,
        purchaseId: 'p1',
        status: 'APPLIED',
        movements: [
          { idempotencyKey: 'k1', status: 'APPLIED', movementId: 'cs-1' },
          { idempotencyKey: 'k2', status: 'ALREADY_APPLIED', movementId: 'cs-0' },
        ],
      }),
    );
    expect(resultado.clase).toBe('APLICADO');
    if (resultado.clase !== 'APLICADO') return;
    expect(resultado.porClave.k1).toEqual({ estado: 'APPLIED', movementId: 'cs-1' });
    expect(resultado.porClave.k2).toEqual({ estado: 'ALREADY_APPLIED', movementId: 'cs-0' });
  });
});
