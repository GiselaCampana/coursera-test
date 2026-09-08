import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '@/lib/db';
import { limpiarBase, sembrarEscenario, type Escenario } from './ayudas';
import { normalizeText } from '@/lib/domain/matching';
import { approveSalePrice, getPriceBoard, suggestPricesFor } from '@/lib/services/pricing';
import { reiniciarLimiteDeFrecuencia } from '@/lib/services/precios-publicos';
import { ValidationError } from '@/lib/errors';

/**
 * Fijarle precio a un artículo que se vende entero.
 *
 * Un maple de huevos, una lata de dulce, un pack: se compran por unidad, se
 * venden por unidad, y no hay ningún peso cargado con el cual pasarlos a kilos.
 * Hasta acá la aprobación de precios les pedía un costo por kilo, que es
 * pedirles que dejen de ser lo que son: la única forma de cumplirlo habría sido
 * inventarles un peso, y entonces el precio de la góndola saldría de un número
 * que nadie midió. El resultado era que no se les podía aprobar ningún precio,
 * la pantalla ni siquiera les mostraba el formulario, y por lo tanto nunca
 * llegaban al catálogo de Pedidos.
 *
 * Quién es uno de éstos lo decide `suggestPricesFor` y nadie más. Es la misma
 * definición que usan la pantalla de Precios para mostrarlos y el catálogo
 * público para publicarlos: tres lugares, una sola regla. No se deduce del
 * nombre —maple, lata, pack, caja y tira son todos «unidad»— ni hizo falta un
 * modo de venta nuevo en la base.
 */

let escenario: Escenario;
const CLAVE = 'clave-de-prueba-que-no-es-un-secreto-real';

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();
  process.env.PRICES_INTEGRATION_KEY = CLAVE;
  reiniciarLimiteDeFrecuencia();
});

afterEach(() => {
  delete process.env.PRICES_INTEGRATION_KEY;
});

/**
 * Un artículo que se vende entero, con una compra que le deja costo unitario.
 *
 * El costo entra por el historial de costos, que es de donde lo lee la
 * formación de precios. Se escribe directo y no confirmando una factura porque
 * lo que se prueba acá es la aprobación del precio, no la carga del comprobante:
 * hacerla depender de media aplicación haría que estas pruebas fallaran por
 * razones que no son la suya.
 */
async function articuloPorUnidad(
  datos: {
    internalCode?: string;
    nombre?: string;
    costoUnitario?: string;
    marcaje?: string;
    activo?: boolean;
  } = {},
) {
  const nombre = datos.nombre ?? 'Maple de huevos';
  const producto = await prisma.product.create({
    data: {
      internalCode: datos.internalCode ?? '9101',
      normalizedName: nombre,
      category: 'Almacén',
      // Las tres condiciones que hacen que se venda entero: se compra por
      // unidad, no tiene peso con el cual pasarlo a kilos, y no usa PLU de
      // balanza sino código de barras.
      purchaseUnit: 'UNIT',
      purchaseUnitWeightKg: null,
      usesPlu: false,
      saleMode: 'FETEABLE',
      active: datos.activo ?? true,
      targetMarginPct: datos.marcaje ?? '0.45',
      marginBasis: 'SOBRE_COSTO',
      cashDiscountPct: '0.1',
      // Redondeo al $100 configurado a propósito: no tiene que aplicarse.
      roundingRule: 'NEAREST_100',
      aliases: {
        create: { alias: nombre, normalized: normalizeText(nombre), origin: 'MANUAL' },
      },
    },
  });

  await prisma.costHistory.create({
    data: {
      productId: producto.id,
      branchId: escenario.sucursales.devoto,
      date: new Date('2026-02-01T00:00:00Z'),
      unitNetPrice: datos.costoUnitario ?? '1500',
      unitCost: datos.costoUnitario ?? '1500',
      kind: 'COMPRA',
    },
  });

  return producto;
}

async function catalogoPublico() {
  const { GET } = await import('@/app/api/integrations/public-prices/route');
  const respuesta = await GET(
    new Request('http://localhost/api/integrations/public-prices?branch=devoto', {
      headers: { Authorization: `Bearer ${CLAVE}`, Accept: 'application/json' },
    }),
  );
  return respuesta.json();
}

// ---------------------------------------------------------------------------
// 1 a 5: la aprobación
// ---------------------------------------------------------------------------

describe('la aprobación de un precio por unidad', () => {
  it('reconoce el artículo por unidad y le calcula el precio con su costo unitario', async () => {
    const producto = await articuloPorUnidad({ costoUnitario: '1500', marcaje: '0.45' });

    const sugerencia = await suggestPricesFor(producto.id);
    expect(sugerencia.soldByUnit).toBe(true);
    // El costo unitario real, el de la compra: $1.500 por maple.
    expect(sugerencia.cost.unitCost?.toFixed(2)).toBe('1500.00');
    // Y no hay costo por kilo, porque no hay kilos.
    expect(sugerencia.costPerKg).toBeNull();
    // El precio sale de la misma configuración vigente: 1500 × 1,45.
    expect(sugerencia.tiers.wholeUnitTotal?.toFixed(2)).toBe('2175.00');
  });

  it('se aprueba sin pedir costo por kilo, y queda el importe exacto', async () => {
    const producto = await articuloPorUnidad({ costoUnitario: '1500' });

    const aprobado = await approveSalePrice(escenario.admin, {
      productId: producto.id,
      approvedPricePerKg: '2175.00',
    });

    expect(aprobado.approvedPricePerKg.toString()).toBe('2175');
    // El costo que originó el precio es el unitario, no uno por kilo inventado.
    expect(aprobado.costBasis.toString()).toBe('1500');
  });

  it('no redondea al $100 aunque el artículo lo tenga configurado', async () => {
    /*
     * El redondeo al $100 existe porque un precio por kilo se cobra así en el
     * mostrador. Un maple se cobra por lo que vale: redondearlo sería cambiar el
     * precio después de que alguien lo aprobó.
     */
    const producto = await articuloPorUnidad({ costoUnitario: '1611.75', marcaje: '0.45' });

    const aprobado = await approveSalePrice(escenario.admin, {
      productId: producto.id,
      approvedPricePerKg: '2337.04',
    });

    expect(aprobado.approvedPricePerKg.toString()).toBe('2337.04');
  });

  it('no usa el descuento en efectivo', async () => {
    /*
     * El artículo tiene un 10 % de descuento en efectivo configurado. El precio
     * normal no lo lleva: es el precio para todos los medios de pago.
     */
    const producto = await articuloPorUnidad({ costoUnitario: '1500' });

    const aprobado = await approveSalePrice(escenario.admin, {
      productId: producto.id,
      approvedPricePerKg: '2175.00',
    });

    expect(aprobado.approvedPricePerKg.toString()).toBe('2175');
    // $1.957,50 sería el precio con el 10 % descontado: no aparece en ningún lado.
    expect(aprobado.pricePerPieceCash).toBeNull();
    expect(aprobado.pricePerPieceDigital).toBeNull();
  });

  it('el que se vende por kilo sin peso cargado sigue exigiéndolo', async () => {
    /*
     * La otra mitad. Una lata de dulce de cinco kilos se compra por unidad y se
     * vende por kilo: ahí el peso sí hace falta, porque sin él no hay forma de
     * saber cuánto vale el kilo. Aflojar eso habría dejado pasar un precio
     * calculado sobre un costo que no es el que corresponde.
     */
    const producto = await prisma.product.create({
      data: {
        internalCode: '9201',
        normalizedName: 'Lata de dulce de batata',
        category: 'Almacén',
        purchaseUnit: 'UNIT',
        purchaseUnitWeightKg: null,
        // Usa PLU de balanza: se vende por kilo, no entero.
        usesPlu: true,
        saleMode: 'FETEABLE',
        targetMarginPct: '0.45',
        marginBasis: 'SOBRE_COSTO',
        cashDiscountPct: '0',
        roundingRule: 'NEAREST_100',
        aliases: {
          create: { alias: 'Lata', normalized: normalizeText('Lata'), origin: 'MANUAL' },
        },
      },
    });
    await prisma.costHistory.create({
      data: {
        productId: producto.id,
        branchId: escenario.sucursales.devoto,
        date: new Date('2026-02-01T00:00:00Z'),
        unitNetPrice: '9000',
        unitCost: '9000',
        kind: 'COMPRA',
      },
    });

    await expect(
      approveSalePrice(escenario.admin, { productId: producto.id, approvedPricePerKg: '13050' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// 6: la pantalla de Precios
// ---------------------------------------------------------------------------

describe('la pantalla de Precios', () => {
  it('lo muestra con su precio por unidad y su costo, listo para revisar', async () => {
    const producto = await articuloPorUnidad({ costoUnitario: '1500' });

    const tablero = await getPriceBoard(escenario.admin);
    const fila = tablero.find((f) => f.productId === producto.id);

    expect(fila, 'el artículo tiene que aparecer en el tablero').toBeDefined();
    // Marcado como que se vende entero: es lo que hace que la pantalla le
    // muestre el precio por unidad y el formulario de aprobación.
    expect(fila!.soldByUnit).toBe(true);
    expect(fila!.wholeUnitTotal).toBe('2175.00');
    expect(fila!.purchaseUnitCost).toBe('1500.00');
    // Todavía sin aprobar: el sugerido está a la vista y nadie lo confirmó.
    expect(fila!.approvedPricePerKg).toBeNull();
  });

  it('el precio no se aprueba solo: hace falta que alguien lo apruebe', async () => {
    const producto = await articuloPorUnidad({ costoUnitario: '1500' });

    // Con la sugerencia a la vista, el historial sigue vacío.
    await suggestPricesFor(producto.id);
    await getPriceBoard(escenario.admin);
    expect(await prisma.salePriceHistory.count({ where: { productId: producto.id } })).toBe(0);

    // Y el catálogo público todavía no lo tiene.
    const antes = await catalogoPublico();
    expect(antes.items.map((i: { plu: string }) => i.plu)).not.toContain('9101');
  });

  it('después de aprobar, el tablero muestra el aprobado', async () => {
    const producto = await articuloPorUnidad({ costoUnitario: '1500' });
    await approveSalePrice(escenario.admin, {
      productId: producto.id,
      approvedPricePerKg: '2200.50',
    });

    const fila = (await getPriceBoard(escenario.admin)).find((f) => f.productId === producto.id);
    // El tablero devuelve el decimal tal cual, sin rellenar el centavo: la
    // pantalla lo formatea después. Lo que importa es el valor, no su escritura.
    expect(Number(fila!.approvedPricePerKg)).toBe(2200.5);
  });
});

// ---------------------------------------------------------------------------
// 7 y 8: antes y después, en el catálogo público
// ---------------------------------------------------------------------------

describe('el catálogo de Pedidos, antes y después de aprobar', () => {
  it('antes de aprobar queda afuera; después sale como unidad', async () => {
    const producto = await articuloPorUnidad({ costoUnitario: '1500' });

    const antes = await catalogoPublico();
    expect(antes.items).toHaveLength(0);

    await approveSalePrice(escenario.admin, {
      productId: producto.id,
      approvedPricePerKg: '2175.00',
    });
    reiniciarLimiteDeFrecuencia();

    const despues = await catalogoPublico();
    expect(despues.items).toHaveLength(1);
    expect(despues.items[0]).toEqual({
      plu: '9101',
      name: 'Maple de huevos',
      description: '',
      category: 'Almacén',
      unit: 'unidad',
      unitPrice: 2175,
      step: 1,
      defaultQuantity: 1,
      image: null,
      featured: false,
    });
  });

  it('conserva los centavos del precio aprobado', async () => {
    const producto = await articuloPorUnidad({ costoUnitario: '1611.75' });
    await approveSalePrice(escenario.admin, {
      productId: producto.id,
      approvedPricePerKg: '2337.04',
    });

    const catalogo = await catalogoPublico();
    expect(catalogo.items[0].unitPrice).toBe(2337.04);
  });
});

// ---------------------------------------------------------------------------
// 9, 10 y 11: lo que no tiene que cambiar
// ---------------------------------------------------------------------------

describe('lo que la aprobación por unidad no toca', () => {
  it('los artículos al corte y feteables siguen igual', async () => {
    /*
     * Ni se convierten a otra modalidad ni cambia cómo se les forma el precio:
     * el que se corta sigue redondeando al $100 y el feteable sigue exacto.
     */
    const alCorte = await prisma.product.create({
      data: {
        internalCode: '9301',
        normalizedName: 'Queso al corte',
        category: 'Quesos',
        purchaseUnit: 'KG',
        saleMode: 'AL_CORTE',
        targetMarginPct: '0.45',
        marginBasis: 'SOBRE_COSTO',
        cashDiscountPct: '0',
        roundingRule: 'NEAREST_100',
        aliases: {
          create: { alias: 'Corte', normalized: normalizeText('Corte'), origin: 'MANUAL' },
        },
      },
    });
    const feteable = await prisma.product.create({
      data: {
        internalCode: '9302',
        normalizedName: 'Fiambre feteable',
        category: 'Fiambres',
        purchaseUnit: 'KG',
        saleMode: 'FETEABLE',
        targetMarginPct: '0.45',
        marginBasis: 'SOBRE_COSTO',
        cashDiscountPct: '0',
        roundingRule: 'NEAREST_100',
        aliases: {
          create: { alias: 'Fete', normalized: normalizeText('Fete'), origin: 'MANUAL' },
        },
      },
    });
    for (const p of [alCorte, feteable]) {
      await prisma.costHistory.create({
        data: {
          productId: p.id,
          branchId: escenario.sucursales.devoto,
          date: new Date('2026-02-01T00:00:00Z'),
          unitNetPrice: '7523',
          unitCost: '7523',
          kind: 'COMPRA',
        },
      });
    }

    const corte = await suggestPricesFor(alCorte.id);
    const fete = await suggestPricesFor(feteable.id);

    expect(corte.soldByUnit).toBe(false);
    expect(fete.soldByUnit).toBe(false);
    // 7.523 × 1,45 = 10.908,35. Al corte redondea al $100; feteable queda exacto.
    expect(corte.tiers.baseKg?.toFixed(2)).toBe('10900.00');
    expect(fete.tiers.baseKg?.toFixed(2)).toBe('10908.35');

    // Y el modo de venta guardado no lo tocó nadie.
    const despues = await prisma.product.findMany({
      where: { id: { in: [alCorte.id, feteable.id] } },
      orderBy: { internalCode: 'asc' },
      select: { saleMode: true, purchaseUnit: true },
    });
    expect(despues).toEqual([
      { saleMode: 'AL_CORTE', purchaseUnit: 'KG' },
      { saleMode: 'FETEABLE', purchaseUnit: 'KG' },
    ]);
  });

  it('aprobar no toca costos históricos, compras ni catálogo', async () => {
    const producto = await articuloPorUnidad({ costoUnitario: '1500' });

    const foto = async () => ({
      productos: await prisma.product.findMany({ orderBy: { id: 'asc' } }),
      costos: await prisma.costHistory.findMany({ orderBy: { id: 'asc' } }),
      compras: await prisma.purchaseMovement.count(),
      comprobantes: await prisma.document.count(),
      alias: await prisma.productAlias.findMany({ orderBy: { id: 'asc' } }),
    });

    const antes = await foto();
    await approveSalePrice(escenario.admin, {
      productId: producto.id,
      approvedPricePerKg: '2175.00',
    });
    const despues = await foto();

    expect(JSON.stringify(despues)).toBe(JSON.stringify(antes));
  });

  it('aprobar dos veces deja dos renglones de historial y un solo precio vigente', async () => {
    /*
     * El historial acumula a propósito: cada precio aprobado es un hecho con su
     * fecha, y borrar el anterior perdería con qué precio se vendió el mes
     * pasado. Lo que no puede pasar es que el artículo salga dos veces en el
     * catálogo, o que salga con el precio viejo.
     */
    const producto = await articuloPorUnidad({ costoUnitario: '1500' });

    await approveSalePrice(escenario.admin, {
      productId: producto.id,
      approvedPricePerKg: '2175.00',
      validFrom: '01/02/2026',
    });
    await approveSalePrice(escenario.admin, {
      productId: producto.id,
      approvedPricePerKg: '2400.00',
      validFrom: '01/03/2026',
    });

    expect(await prisma.salePriceHistory.count({ where: { productId: producto.id } })).toBe(2);

    reiniciarLimiteDeFrecuencia();
    const catalogo = await catalogoPublico();
    expect(catalogo.items).toHaveLength(1);
    expect(catalogo.items[0].unitPrice).toBe(2400);
  });

  it('reintentar la misma aprobación no rompe nada ni cambia el precio publicado', async () => {
    const producto = await articuloPorUnidad({ costoUnitario: '1500' });

    for (let i = 0; i < 3; i++) {
      await approveSalePrice(escenario.admin, {
        productId: producto.id,
        approvedPricePerKg: '2175.00',
        validFrom: '01/02/2026',
      });
    }

    reiniciarLimiteDeFrecuencia();
    const catalogo = await catalogoPublico();
    expect(catalogo.items).toHaveLength(1);
    expect(catalogo.items[0].unitPrice).toBe(2175);
  });

  it('un operador no puede aprobar precios', async () => {
    const producto = await articuloPorUnidad({ costoUnitario: '1500' });
    await expect(
      approveSalePrice(escenario.operadorDevoto, {
        productId: producto.id,
        approvedPricePerKg: '2175.00',
      }),
    ).rejects.toThrow();
  });
});
