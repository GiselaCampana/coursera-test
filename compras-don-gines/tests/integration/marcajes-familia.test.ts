import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { ForbiddenError, ValidationError } from '@/lib/errors';
import {
  familiasConMarcajes,
  guardarMarcajesDeFamilia,
  guardarReglaGeneralDeMarcajes,
  reglaGeneralDeMarcajes,
} from '@/lib/services/catalogo';
import {
  resolvePricingRule,
  suggestPricesFor,
  updateProductPriceConfig,
} from '@/lib/services/pricing';
import { limpiarBase, sembrarEscenario, type Escenario } from './ayudas';

/**
 * Marcajes por familia.
 *
 * Lo que importa acá no es que los números se guarden, sino que **el precio se
 * mueva donde tiene que moverse y no donde no**. Un artículo que definió su
 * marcaje no puede cambiar porque alguien tocó la familia; uno que lo dejó
 * vacío tiene que seguirla. Y guardar la configuración de un artículo no puede
 * romper esa herencia por el solo hecho de haber abierto la pantalla.
 */

let escenario: Escenario;
let familiaId: string;

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();

  const familia = await prisma.productFamily.create({
    data: { name: 'Quesos duros', normalized: 'quesos duros' },
  });
  familiaId = familia.id;
});

/** Un artículo de la familia, con un costo cargado para que tenga precio. */
async function articulo(opciones: {
  plu: string;
  marcajePropio?: string | null;
  conFamilia?: boolean;
}) {
  const producto = await prisma.product.create({
    data: {
      internalCode: opciones.plu,
      normalizedName: `Artículo ${opciones.plu}`,
      purchaseUnit: 'KG',
      saleMode: 'AL_CORTE',
      targetMarginPct: opciones.marcajePropio ?? null,
      marginBasis: opciones.marcajePropio ? 'SOBRE_COSTO' : null,
      cashDiscountPct: '0',
      roundingRule: 'NONE',
      usesPlu: true,
      active: true,
      familyId: opciones.conFamilia === false ? null : familiaId,
    },
  });
  await prisma.costHistory.create({
    data: {
      productId: producto.id,
      supplierId: escenario.proveedorId,
      branchId: escenario.sucursales.devoto,
      date: new Date(),
      unitNetPrice: '1000',
      unitCost: '1000',
    },
  });
  return producto.id;
}

describe('el marcaje de la familia rige donde el artículo no dice nada', () => {
  it('un artículo sin marcaje propio toma el de su familia', async () => {
    const id = await articulo({ plu: '9001' });
    await guardarMarcajesDeFamilia(escenario.admin, familiaId, { targetMarginPct: '50' });

    const regla = await resolvePricingRule(id);
    expect(regla.targetMarginPct).toBe('0.5');
    expect(regla.marcajes.base.origen).toBe('FAMILIA');

    // Y el precio sale de ahí: costo 1000 con 50 % sobre costo son 1500.
    const precio = await suggestPricesFor(id);
    expect(precio.tiers.baseKg?.toFixed(2)).toBe('1500.00');
  });

  it('un artículo con marcaje propio no se mueve', async () => {
    /*
     * La otra mitad, y la que más importa: el que alguien configuró a mano
     * tiene que quedarse como está. Si la familia lo pisara, cambiar el marcaje
     * de un rubro rompería en silencio todas las excepciones que se habían
     * decidido una por una.
     */
    const id = await articulo({ plu: '9002', marcajePropio: '0.20' });
    await guardarMarcajesDeFamilia(escenario.admin, familiaId, { targetMarginPct: '50' });

    const regla = await resolvePricingRule(id);
    expect(regla.targetMarginPct).toBe('0.2');
    expect(regla.marcajes.base.origen).toBe('PRODUCTO');
    const precio = await suggestPricesFor(id);
    expect(precio.tiers.baseKg?.toFixed(2)).toBe('1200.00');
  });

  it('un marcaje específico de la familia le gana al base del artículo', async () => {
    const id = await articulo({ plu: '9003', marcajePropio: '0.20' });
    await guardarMarcajesDeFamilia(escenario.admin, familiaId, {
      alCorteHormaDigitalMarginPct: '60',
    });

    const precio = await suggestPricesFor(id);
    // El base sigue siendo el del artículo…
    expect(precio.tiers.baseKg?.toFixed(2)).toBe('1200.00');
    // …y la horma digital, la de la familia.
    expect(precio.tiers.alCorteHormaDigitalKg?.toFixed(2)).toBe('1600.00');
  });

  it('sin familia y sin marcaje propio, el general de la casa', async () => {
    const id = await articulo({ plu: '9004', conFamilia: false });
    const regla = await resolvePricingRule(id);
    expect(regla.targetMarginPct).toBe('0.45');
    expect(regla.marcajes.base.origen).toBe('GENERAL');
  });
});

describe('guardar no rompe la herencia', () => {
  it('guardar la configuración de un artículo sin tocar los marcajes lo deja heredando', async () => {
    /*
     * El defecto que esto impide: el formulario mostraba el valor heredado
     * escrito en el campo, así que guardar sin cambiar nada lo grababa dentro
     * del artículo. A partir de ahí el artículo dejaba de seguir a su familia,
     * y nadie se enteraba hasta que cambiar el marcaje del rubro no movía ese
     * precio.
     */
    const id = await articulo({ plu: '9005' });
    await guardarMarcajesDeFamilia(escenario.admin, familiaId, { targetMarginPct: '50' });

    await updateProductPriceConfig(escenario.admin, {
      productId: id,
      // Vacío: el operador no escribió nada en ningún marcaje.
      targetMarginPct: '',
      marginBasis: 'SOBRE_COSTO',
      alCorteHormaDigitalMarginPct: null,
      alCorteHormaCashMarginPct: null,
      alCorteCajaCashMarginPct: null,
      feteado100gMarginPct: null,
      feteadoQuarterMarginPct: null,
      feteadoPieceDigitalMarginPct: null,
      feteadoPieceCashMarginPct: null,
      wholeUnitMarginPct: null,
      roundingRule: 'NONE',
      saleMode: 'AL_CORTE',
      purchaseUnit: 'KG',
      purchaseUnitWeightKg: null,
    });

    const guardado = await prisma.product.findUniqueOrThrow({ where: { id } });
    expect(guardado.targetMarginPct).toBeNull();

    // Sigue heredando: cambiar la familia lo mueve.
    await guardarMarcajesDeFamilia(escenario.admin, familiaId, { targetMarginPct: '70' });
    const precio = await suggestPricesFor(id);
    expect(precio.tiers.baseKg?.toFixed(2)).toBe('1700.00');
  });

  it('la base del marcaje también se puede dejar heredando', async () => {
    /*
     * Sobre costo o sobre venta sigue la misma cadena que los porcentajes. Si
     * el formulario mandara siempre un valor, abrir y guardar el artículo se lo
     * grabaría encima y dejaría de seguir a su familia sin que nadie lo pidiera:
     * el mismo defecto que ya había con el marcaje base, en el campo de al lado.
     */
    const id = await articulo({ plu: '9012' });
    await guardarMarcajesDeFamilia(escenario.admin, familiaId, {
      targetMarginPct: '50',
      marginBasis: 'SOBRE_VENTA',
    });

    await updateProductPriceConfig(escenario.admin, {
      productId: id,
      targetMarginPct: '',
      marginBasis: '',
      alCorteHormaDigitalMarginPct: null,
      alCorteHormaCashMarginPct: null,
      alCorteCajaCashMarginPct: null,
      feteado100gMarginPct: null,
      feteadoQuarterMarginPct: null,
      feteadoPieceDigitalMarginPct: null,
      feteadoPieceCashMarginPct: null,
      wholeUnitMarginPct: null,
      roundingRule: 'NONE',
      saleMode: 'AL_CORTE',
      purchaseUnit: 'KG',
      purchaseUnitWeightKg: null,
    });

    const guardado = await prisma.product.findUniqueOrThrow({ where: { id } });
    expect(guardado.marginBasis).toBeNull();

    const regla = await resolvePricingRule(id);
    expect(regla.marginBasis).toBe('SOBRE_VENTA');
    expect(regla.marcajes.marginBasis.origen).toBe('FAMILIA');
  });

  it('escribir un marcaje en el artículo lo desengancha, y eso es lo que se pidió', async () => {
    const id = await articulo({ plu: '9006' });
    await guardarMarcajesDeFamilia(escenario.admin, familiaId, { targetMarginPct: '50' });

    await updateProductPriceConfig(escenario.admin, {
      productId: id,
      // 30 % sobre 1000 da 1300, que ya es múltiplo de 100: así la prueba
      // habla de la herencia y no del redondeo.
      targetMarginPct: '30',
      marginBasis: 'SOBRE_COSTO',
      alCorteHormaDigitalMarginPct: null,
      alCorteHormaCashMarginPct: null,
      alCorteCajaCashMarginPct: null,
      feteado100gMarginPct: null,
      feteadoQuarterMarginPct: null,
      feteadoPieceDigitalMarginPct: null,
      feteadoPieceCashMarginPct: null,
      wholeUnitMarginPct: null,
      roundingRule: 'NONE',
      saleMode: 'AL_CORTE',
      purchaseUnit: 'KG',
      purchaseUnitWeightKg: null,
    });

    // La familia se mueve y este artículo ya no la sigue.
    await guardarMarcajesDeFamilia(escenario.admin, familiaId, { targetMarginPct: '70' });
    const precio = await suggestPricesFor(id);
    expect(precio.tiers.baseKg?.toFixed(2)).toBe('1300.00');
  });
});

describe('configurar la familia no toca ningún artículo', () => {
  it('los artículos quedan exactamente como estaban', async () => {
    const conPropio = await articulo({ plu: '9007', marcajePropio: '0.20' });
    const heredando = await articulo({ plu: '9008' });

    const antes = await prisma.product.findMany({
      where: { id: { in: [conPropio, heredando] } },
      orderBy: { internalCode: 'asc' },
    });

    await guardarMarcajesDeFamilia(escenario.admin, familiaId, {
      targetMarginPct: '50',
      feteadoQuarterMarginPct: '65',
    });

    const despues = await prisma.product.findMany({
      where: { id: { in: [conPropio, heredando] } },
      orderBy: { internalCode: 'asc' },
    });
    /*
     * Ni una fila de producto cambia. Escribir el marcaje de la familia dentro
     * de cada artículo sería lo contrario de lo que la familia viene a
     * resolver, y además haría irreversible el cambio: no habría manera de
     * volver a saber cuáles lo tenían propio.
     */
    expect(despues).toEqual(antes);
  });

  it('dice cuántos artículos dependen de la familia antes de tocarla', async () => {
    await articulo({ plu: '9009', marcajePropio: '0.20' });
    await articulo({ plu: '9010' });
    await articulo({ plu: '9011' });

    const familias = await familiasConMarcajes(escenario.admin);
    const quesos = familias.find((f) => f.id === familiaId)!;
    expect(quesos.articulos).toBe(3);
    // Dos heredan el base: son los que se van a mover.
    expect(quesos.heredanElBase).toBe(2);
  });
});

describe('cada forma de venta se guarda y se aplica sola', () => {
  /** La configuración completa de un artículo, para escribir sólo lo que cambia. */
  function config(id: string, cambios: Record<string, string | null> = {}) {
    return {
      productId: id,
      targetMarginPct: '',
      marginBasis: 'SOBRE_COSTO' as const,
      alCorteHormaDigitalMarginPct: null,
      alCorteHormaCashMarginPct: null,
      alCorteCajaCashMarginPct: null,
      feteado100gMarginPct: null,
      feteadoQuarterMarginPct: null,
      feteadoPieceDigitalMarginPct: null,
      feteadoPieceCashMarginPct: null,
      wholeUnitMarginPct: null,
      roundingRule: 'NONE' as const,
      saleMode: 'AL_CORTE' as const,
      purchaseUnit: 'KG' as const,
      purchaseUnitWeightKg: null,
      ...cambios,
    };
  }

  it('cambiar el marcaje de horma no modifica el de kilo', async () => {
    /*
     * Ocho campos que se pisan entre sí no son ocho campos. Acá el recorrido es
     * el real: se guarda por el servicio y se vuelve a calcular el precio.
     *
     * Costo 1000 y 40 % de base: el kilo vale 1400 antes y después. La horma
     * pasa a 1250, que es su propio marcaje y no toca a nadie más.
     */
    const id = await articulo({ plu: '9020', marcajePropio: '0.40' });

    const antes = await suggestPricesFor(id);
    expect(antes.tiers.baseKg?.toFixed(2)).toBe('1400.00');
    expect(antes.tiers.alCorteHormaDigitalKg?.toFixed(2)).toBe('1400.00');

    await updateProductPriceConfig(
      escenario.admin,
      config(id, { targetMarginPct: '40', alCorteHormaDigitalMarginPct: '25' }),
    );

    const despues = await suggestPricesFor(id);
    expect(despues.tiers.alCorteHormaDigitalKg?.toFixed(2)).toBe('1250.00');
    // El kilo, intacto.
    expect(despues.tiers.baseKg?.toFixed(2)).toBe('1400.00');
    // Y la otra forma de venta al corte que nadie tocó, también.
    expect(despues.tiers.alCorteCajaCashKg?.toFixed(2)).toBe('1400.00');

    const guardado = await prisma.product.findUniqueOrThrow({ where: { id } });
    expect(guardado.targetMarginPct?.toString()).toBe('0.4');
    expect(guardado.alCorteHormaDigitalMarginPct?.toString()).toBe('0.25');
    expect(guardado.alCorteCajaCashMarginPct).toBeNull();
  });

  it('cambiar el marcaje de pieza no modifica el de 100 g ni el de 1/4', async () => {
    const id = await articulo({ plu: '9021', marcajePropio: '0.40' });
    await updateProductPriceConfig(
      escenario.admin,
      config(id, {
        targetMarginPct: '40',
        saleMode: 'FETEABLE',
        feteadoPieceDigitalMarginPct: '25',
        feteadoPieceCashMarginPct: '22',
      }),
    );

    const precio = await suggestPricesFor(id);
    expect(precio.tiers.feteadoPieceDigitalKg?.toFixed(2)).toBe('1250.00');
    expect(precio.tiers.feteadoPieceCashKg?.toFixed(2)).toBe('1220.00');
    // Los dos que se ven en la etiqueta del mostrador siguen en el base.
    expect(precio.tiers.feteado100gKg?.toFixed(2)).toBe('1400.00');
    expect(precio.tiers.feteadoQuarterKg?.toFixed(2)).toBe('1400.00');

    const guardado = await prisma.product.findUniqueOrThrow({ where: { id } });
    expect(guardado.feteado100gMarginPct).toBeNull();
    expect(guardado.feteadoQuarterMarginPct).toBeNull();
  });

  it('editar una modalidad no borra los marcajes de la otra', async () => {
    /*
     * El formulario muestra sólo la modalidad del artículo, y la otra viaja en
     * campos ocultos. Si esos ocultos llegaran vacíos, cambiar un artículo de
     * feteable a al corte le borraría en silencio los cuatro marcajes que ya
     * tenía cargados para volver.
     */
    const id = await articulo({ plu: '9022', marcajePropio: '0.40' });
    await updateProductPriceConfig(
      escenario.admin,
      config(id, {
        targetMarginPct: '40',
        saleMode: 'FETEABLE',
        feteadoQuarterMarginPct: '55',
        alCorteHormaCashMarginPct: '18',
      }),
    );

    // Ahora se lo pasa a al corte, tocando sólo lo que se ve en esa pantalla.
    await updateProductPriceConfig(
      escenario.admin,
      config(id, {
        targetMarginPct: '40',
        saleMode: 'AL_CORTE',
        alCorteHormaCashMarginPct: '30',
        // Lo feteado viaja tal como estaba, que es lo que hacen los ocultos.
        feteadoQuarterMarginPct: '55',
      }),
    );

    const guardado = await prisma.product.findUniqueOrThrow({ where: { id } });
    expect(guardado.alCorteHormaCashMarginPct?.toString()).toBe('0.3');
    expect(guardado.feteadoQuarterMarginPct?.toString()).toBe('0.55');
  });

  it('el redondeo depende de la forma de venta y no de lo que se configure', async () => {
    /*
     * Kilo y 1/4 al $100; pieza exacta. Con un costo que no da redondo se ve la
     * diferencia: 1000 con 45 % son 1450, que el kilo lleva a 1500 y la pieza
     * deja en 1450.
     */
    const id = await articulo({ plu: '9023', marcajePropio: '0.45' });
    await updateProductPriceConfig(
      escenario.admin,
      config(id, { targetMarginPct: '45', saleMode: 'FETEABLE' }),
    );

    const precio = await suggestPricesFor(id);
    expect(precio.tiers.feteado100gKg?.toFixed(2)).toBe('1500.00');
    expect(precio.tiers.feteadoQuarterKg?.toFixed(2)).toBe('1500.00');
    expect(precio.tiers.feteadoPieceDigitalKg?.toFixed(2)).toBe('1450.00');
    expect(precio.tiers.feteadoPieceCashKg?.toFixed(2)).toBe('1450.00');
  });
});

describe('la venta por unidad es exacta y no se redondea nunca', () => {
  /**
   * Un artículo que se compra por unidad, con el costo que se le quiera poner.
   *
   * Los dos caminos que forman un precio de unidad entera se prueban por
   * separado: el de código de barras que además **se vende** por unidad, y el
   * que se compra por lata o cajón y se vende al peso.
   */
  async function porUnidad(opciones: {
    plu: string;
    costoPorUnidad: string;
    kilosPorUnidad?: string;
    usaPlu?: boolean;
    marcaje: string;
  }) {
    const producto = await prisma.product.create({
      data: {
        internalCode: opciones.plu,
        normalizedName: `Artículo ${opciones.plu}`,
        purchaseUnit: 'UNIT',
        purchaseUnitWeightKg: opciones.kilosPorUnidad ?? null,
        saleMode: 'AL_CORTE',
        targetMarginPct: opciones.marcaje,
        marginBasis: 'SOBRE_COSTO',
        cashDiscountPct: '0',
        // A propósito la más agresiva: si el redondeo se colara desde acá, el
        // importe saltaría al $100 y la prueba lo vería.
        roundingRule: 'NEAREST_100',
        usesPlu: opciones.usaPlu ?? true,
        active: true,
        familyId: null,
      },
    });
    await prisma.costHistory.create({
      data: {
        productId: producto.id,
        supplierId: escenario.proveedorId,
        branchId: escenario.sucursales.devoto,
        date: new Date(),
        unitNetPrice: opciones.costoPorUnidad,
        unitCost: opciones.costoPorUnidad,
      },
    });
    return producto.id;
  }

  it('el precio de la lata entera sale con los centavos que da el marcaje', async () => {
    /*
     * 1837 el cajón con 23 % sobre el costo son 2259,51. Si se redondeara al
     * $100 —la regla que el artículo tiene guardada— darían 2300: casi
     * cuarenta y un pesos de más por cajón que nadie decidió.
     */
    const id = await porUnidad({
      plu: '9050',
      costoPorUnidad: '1837',
      kilosPorUnidad: '5',
      marcaje: '0.23',
    });

    const precio = await suggestPricesFor(id);
    expect(precio.tiers.wholeUnitTotal?.toFixed(2)).toBe('2259.51');
  });

  it('lo mismo para el artículo de código de barras que se vende por unidad', async () => {
    // 733,45 la botella con 17 % son 858,14. Con redondeo daría 900.
    const id = await porUnidad({
      plu: '9051',
      costoPorUnidad: '733.45',
      usaPlu: false,
      marcaje: '0.17',
    });

    const precio = await suggestPricesFor(id);
    expect(precio.tiers.wholeUnitTotal?.toFixed(2)).toBe('858.14');
  });

  it('el marcaje propio de unidad entera tampoco arrastra redondeo', async () => {
    /*
     * Y con su marcaje específico, que es el que la usuaria configura en el
     * grupo "venta por unidad": 1837 con 31 % son 2406,47.
     */
    const id = await porUnidad({
      plu: '9052',
      costoPorUnidad: '1837',
      kilosPorUnidad: '5',
      marcaje: '0.23',
    });
    await prisma.product.update({
      where: { id },
      data: { wholeUnitMarginPct: '0.31' },
    });

    const precio = await suggestPricesFor(id);
    expect(precio.tiers.wholeUnitTotal?.toFixed(2)).toBe('2406.47');
  });

  it('el marcaje de unidad entera no toca los precios por kilo del mismo artículo', async () => {
    /*
     * La unidad va aparte de la modalidad: cambiar su marcaje no puede mover
     * el precio por kilo, que sí se redondea al $100.
     *
     * Costo 1837 el cajón de 5 kg son 367,40 el kilo; con 23 % dan 451,90, que
     * al corte se redondean a 500.
     */
    const id = await porUnidad({
      plu: '9053',
      costoPorUnidad: '1837',
      kilosPorUnidad: '5',
      marcaje: '0.23',
    });
    const antes = await suggestPricesFor(id);
    expect(antes.tiers.baseKg?.toFixed(2)).toBe('500.00');

    await prisma.product.update({
      where: { id },
      data: { wholeUnitMarginPct: '0.31' },
    });

    const despues = await suggestPricesFor(id);
    expect(despues.tiers.wholeUnitTotal?.toFixed(2)).toBe('2406.47');
    expect(despues.tiers.baseKg?.toFixed(2)).toBe('500.00');
  });

  it('la unidad entera no redondea ni siquiera cuando el resto sí', async () => {
    /*
     * La comprobación general: el mismo artículo, en la misma consulta, con el
     * kilo redondeado al $100 y la unidad con sus centavos. Si alguien alguna
     * vez le pasara NEAREST_100 al importe de unidad, este número terminaría
     * en dos ceros.
     */
    const id = await porUnidad({
      plu: '9054',
      costoPorUnidad: '1837',
      kilosPorUnidad: '5',
      marcaje: '0.23',
    });
    const precio = await suggestPricesFor(id);
    const unidad = precio.tiers.wholeUnitTotal!;
    expect(unidad.toFixed(2)).toBe('2259.51');
    expect(unidad.mod(100).isZero()).toBe(false);
    // Y el por kilo del mismo artículo sí es múltiplo de 100.
    expect(precio.tiers.baseKg!.mod(100).isZero()).toBe(true);
  });
});

describe('la regla general es el tercer nivel de verdad', () => {
  it('rige donde el artículo y la familia no dicen nada', async () => {
    const id = await articulo({ plu: '9030' });
    await guardarReglaGeneralDeMarcajes(escenario.admin, {
      targetMarginPct: '45',
      feteadoQuarterMarginPct: '80',
    });

    const regla = await resolvePricingRule(id);
    expect(regla.marcajes.especificos.feteadoQuarter.valor).toBe('0.8');
    expect(regla.marcajes.especificos.feteadoQuarter.origen).toBe('GENERAL');
    // Y la forma de venta que la regla general tampoco define, con el base.
    expect(regla.marcajes.especificos.feteado100g.origen).toBe('BASE');
  });

  it('la familia le gana a la regla general, y el artículo a las dos', async () => {
    const heredaTodo = await articulo({ plu: '9031' });
    const conFamilia = await articulo({ plu: '9032' });
    const conPropio = await articulo({ plu: '9033' });

    await guardarReglaGeneralDeMarcajes(escenario.admin, {
      targetMarginPct: '45',
      feteadoQuarterMarginPct: '80',
    });
    await guardarMarcajesDeFamilia(escenario.admin, familiaId, { feteadoQuarterMarginPct: '60' });
    await prisma.product.update({
      where: { id: conPropio },
      data: { feteadoQuarterMarginPct: '0.10' },
    });
    // El primero se saca de la familia para que muestre el nivel general puro.
    await prisma.product.update({ where: { id: heredaTodo }, data: { familyId: null } });

    const general = await resolvePricingRule(heredaTodo);
    expect(general.marcajes.especificos.feteadoQuarter.origen).toBe('GENERAL');
    expect(general.marcajes.especificos.feteadoQuarter.valor).toBe('0.8');

    const familia = await resolvePricingRule(conFamilia);
    expect(familia.marcajes.especificos.feteadoQuarter.origen).toBe('FAMILIA');
    expect(familia.marcajes.especificos.feteadoQuarter.valor).toBe('0.6');

    const propio = await resolvePricingRule(conPropio);
    expect(propio.marcajes.especificos.feteadoQuarter.origen).toBe('PRODUCTO');
    expect(propio.marcajes.especificos.feteadoQuarter.valor).toBe('0.1');
  });

  it('guardarla no toca ningún artículo ni ninguna familia', async () => {
    const conPropio = await articulo({ plu: '9034', marcajePropio: '0.20' });
    const heredando = await articulo({ plu: '9035' });
    await guardarMarcajesDeFamilia(escenario.admin, familiaId, { targetMarginPct: '50' });

    const productosAntes = await prisma.product.findMany({
      where: { id: { in: [conPropio, heredando] } },
      orderBy: { internalCode: 'asc' },
    });
    const familiaAntes = await prisma.productFamily.findUniqueOrThrow({ where: { id: familiaId } });

    await guardarReglaGeneralDeMarcajes(escenario.admin, {
      targetMarginPct: '70',
      alCorteCajaCashMarginPct: '15',
    });

    expect(
      await prisma.product.findMany({
        where: { id: { in: [conPropio, heredando] } },
        orderBy: { internalCode: 'asc' },
      }),
    ).toEqual(productosAntes);
    expect(await prisma.productFamily.findUniqueOrThrow({ where: { id: familiaId } })).toEqual(
      familiaAntes,
    );
  });

  it('no crea una segunda regla general: siempre actualiza la que hay', async () => {
    /*
     * "No debe existir otra configuración global paralela". Dos filas activas
     * sin producto serían exactamente eso, y cuál de las dos rige dependería de
     * un orden por fecha que nadie mira.
     */
    await guardarReglaGeneralDeMarcajes(escenario.admin, { targetMarginPct: '50' });
    await guardarReglaGeneralDeMarcajes(escenario.admin, { targetMarginPct: '60' });

    const activas = await prisma.pricingRule.findMany({
      where: { productId: null, active: true },
    });
    expect(activas).toHaveLength(1);
    expect(activas[0].targetMarginPct.toString()).toBe('0.6');
  });

  it('el marcaje base de la regla general es obligatorio', async () => {
    // Es el piso de la cadena: vacío acá no significa heredar, significa que
    // nadie decidió el precio.
    await expect(
      guardarReglaGeneralDeMarcajes(escenario.admin, { targetMarginPct: '' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('sin permiso de gestionar productos no se configura la regla general', async () => {
    await expect(
      guardarReglaGeneralDeMarcajes(escenario.operadorDevoto, { targetMarginPct: '50' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('dice a cuántos artículos les llega de verdad', async () => {
    /*
     * Sólo a los que no tienen base propio y cuya familia tampoco lo define.
     * Decir "afecta a todos" cuando afecta a dos haría que nadie se anime a
     * tocarla.
     */
    await articulo({ plu: '9036', marcajePropio: '0.20' });
    await articulo({ plu: '9037' });
    await articulo({ plu: '9038', conFamilia: false });

    const sinFamiliaQueDefina = await reglaGeneralDeMarcajes(escenario.admin);
    expect(sinFamiliaQueDefina.dependenDeElla).toBe(2);

    // Al definir el base de la familia, el suyo deja de depender de la general.
    await guardarMarcajesDeFamilia(escenario.admin, familiaId, { targetMarginPct: '50' });
    const conFamiliaQueDefine = await reglaGeneralDeMarcajes(escenario.admin);
    expect(conFamiliaQueDefine.dependenDeElla).toBe(1);
  });
});

describe('activar la regla general no cambia ningún precio', () => {
  it('el precio es el mismo antes y después de que exista la fila', async () => {
    /*
     * La condición que puso la usuaria para la migración: no puede alterar los
     * precios efectivos actuales. Se prueba en el único sentido que importa,
     * que es el del número que sale.
     */
    const id = await articulo({ plu: '9040' });

    // Sin ninguna regla general cargada: el último recurso del código.
    await prisma.pricingRule.deleteMany({ where: { productId: null } });
    const sinRegla = await resolvePricingRule(id);
    const precioSinRegla = await suggestPricesFor(id);
    expect(sinRegla.marcajes.base.origen).toBe('SIN_CONFIGURAR');

    // Con la regla general que crea la migración, con el mismo valor.
    await guardarReglaGeneralDeMarcajes(escenario.admin, { targetMarginPct: '45' });
    const conRegla = await resolvePricingRule(id);
    const precioConRegla = await suggestPricesFor(id);

    expect(conRegla.marcajes.base.origen).toBe('GENERAL');
    expect(conRegla.targetMarginPct).toBe(sinRegla.targetMarginPct);
    expect(precioConRegla.tiers.baseKg?.toFixed(2)).toBe(
      precioSinRegla.tiers.baseKg?.toFixed(2),
    );
    for (const forma of [
      'alCorteHormaDigitalKg',
      'alCorteHormaCashKg',
      'alCorteCajaCashKg',
      'feteado100gKg',
      'feteadoQuarterKg',
      'feteadoPieceDigitalKg',
      'feteadoPieceCashKg',
    ] as const) {
      expect(precioConRegla.tiers[forma]?.toFixed(2), forma).toBe(
        precioSinRegla.tiers[forma]?.toFixed(2),
      );
    }
  });

  it('no pisa lo que ya tenían el artículo ni la familia', async () => {
    const conPropio = await articulo({ plu: '9041', marcajePropio: '0.20' });
    await guardarMarcajesDeFamilia(escenario.admin, familiaId, { feteadoQuarterMarginPct: '60' });

    await guardarReglaGeneralDeMarcajes(escenario.admin, {
      targetMarginPct: '70',
      feteadoQuarterMarginPct: '80',
    });

    const regla = await resolvePricingRule(conPropio);
    expect(regla.marcajes.base.valor).toBe('0.2');
    expect(regla.marcajes.base.origen).toBe('PRODUCTO');
    expect(regla.marcajes.especificos.feteadoQuarter.valor).toBe('0.6');
    expect(regla.marcajes.especificos.feteadoQuarter.origen).toBe('FAMILIA');
  });
});

describe('lo que la familia no acepta', () => {
  it('un marcaje fuera de rango se rechaza y no se guarda nada', async () => {
    await expect(
      guardarMarcajesDeFamilia(escenario.admin, familiaId, { targetMarginPct: '150' }),
    ).rejects.toBeInstanceOf(ValidationError);

    const familia = await prisma.productFamily.findUniqueOrThrow({ where: { id: familiaId } });
    expect(familia.targetMarginPct).toBeNull();
  });

  it('vacío se guarda como vacío, no como cero', async () => {
    /*
     * Cero por ciento es vender al costo. Si un campo en blanco se guardara
     * como cero, toda la familia pasaría a venderse sin ganancia y el error
     * recién aparecería mirando la caja.
     */
    await guardarMarcajesDeFamilia(escenario.admin, familiaId, {
      targetMarginPct: '50',
      feteadoQuarterMarginPct: '',
    });
    const familia = await prisma.productFamily.findUniqueOrThrow({ where: { id: familiaId } });
    expect(familia.targetMarginPct?.toString()).toBe('0.5');
    expect(familia.feteadoQuarterMarginPct).toBeNull();
  });

  it('sin permiso de gestionar productos no se configura ninguna familia', async () => {
    await expect(
      guardarMarcajesDeFamilia(escenario.operadorDevoto, familiaId, { targetMarginPct: '50' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
