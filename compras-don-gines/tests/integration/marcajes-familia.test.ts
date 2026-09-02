import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { ForbiddenError, ValidationError } from '@/lib/errors';
import {
  familiasConMarcajes,
  guardarMarcajesDeFamilia,
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
