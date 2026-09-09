import { describe, it, expect, beforeEach } from 'vitest';
import JSZip from 'jszip';
import { prisma } from '@/lib/db';
import { limpiarBase, sembrarEscenario, type Escenario } from './ayudas';
import { normalizeText } from '@/lib/domain/matching';
import { approveSalePrice } from '@/lib/services/pricing';
import {
  getPriceExportRows,
  priceRowsToEmployeePdf,
  priceRowsToManagementPdf,
  priceRowsToXlsx,
} from '@/lib/services/price-exports';

/**
 * Un artículo que se vende entero no tiene precio «por kilo».
 *
 * La lista de precios se imprime y se cuelga: lo que dice ahí es lo que se
 * cobra en el mostrador. Un maple figurando bajo «Precio por kilo» no es un
 * detalle cosmético —le dice a quien atiende que ese número es el precio de un
 * kilo de maple, que no existe— y en la planilla es peor todavía, porque una
 * planilla rotula por columna y no por fila: la misma celda pasa a significar
 * dos cosas distintas según qué artículo sea.
 *
 * Se prueban los dos formatos leyendo el archivo de verdad: la hoja del Excel
 * se saca del zip y el texto del PDF se lee del propio buffer. Comprobar que el
 * archivo existe y empieza con «PK» no diría nada sobre lo que dice adentro.
 */

let escenario: Escenario;

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();
});

/** Un artículo que se vende entero, con su compra. */
async function maple(costoUnitario = '1500') {
  const producto = await prisma.product.create({
    data: {
      internalCode: '9101',
      normalizedName: 'Maple de huevos',
      category: 'Almacén',
      subtype: 'Huevos',
      purchaseUnit: 'UNIT',
      purchaseUnitWeightKg: null,
      usesPlu: false,
      barcode: '7790001000019',
      saleMode: 'FETEABLE',
      targetMarginPct: '0.45',
      marginBasis: 'SOBRE_COSTO',
      cashDiscountPct: '0.1',
      roundingRule: 'NEAREST_100',
      aliases: {
        create: { alias: 'Maple', normalized: normalizeText('Maple'), origin: 'MANUAL' },
      },
    },
  });
  await prisma.costHistory.create({
    data: {
      productId: producto.id,
      branchId: escenario.sucursales.devoto,
      date: new Date('2026-02-01T00:00:00Z'),
      unitNetPrice: costoUnitario,
      unitCost: costoUnitario,
    },
  });
  return producto;
}

/** Un artículo que se vende por kilo, para tener las dos cosas en el archivo. */
async function feteable() {
  const producto = await prisma.product.create({
    data: {
      internalCode: '9102',
      normalizedName: 'Queso cremoso',
      category: 'Quesos',
      purchaseUnit: 'KG',
      saleMode: 'FETEABLE',
      targetMarginPct: '0.45',
      marginBasis: 'SOBRE_COSTO',
      cashDiscountPct: '0',
      roundingRule: 'NEAREST_100',
      aliases: {
        create: { alias: 'Cremoso', normalized: normalizeText('Cremoso'), origin: 'MANUAL' },
      },
    },
  });
  await prisma.costHistory.create({
    data: {
      productId: producto.id,
      branchId: escenario.sucursales.devoto,
      date: new Date('2026-02-01T00:00:00Z'),
      unitNetPrice: '7523',
      unitCost: '7523',
    },
  });
  return producto;
}

/** La hoja del Excel, ya desarmada en filas de celdas. */
async function hojaDelExcel(xlsx: Buffer): Promise<{ encabezados: string[]; filas: string[][] }> {
  const zip = await JSZip.loadAsync(xlsx);
  const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
  /*
   * Una celda vacía viene autocerrada —`<c r="B2"/>`— y una con valor trae el
   * texto o el número adentro. Hay que leer las dos, porque lo que se está
   * probando es justamente que ciertas celdas queden vacías: un parser que se
   * saltee las vacías correría las columnas y la prueba miraría otra cosa.
   */
  const filas = [...xml.matchAll(/<row [^>]*>(.*?)<\/row>/gs)].map((m) =>
    [...m[1].matchAll(/<c [^>]*?(?:\/>|>(.*?)<\/c>)/gs)].map((c) => {
      const contenido = c[1] ?? '';
      const texto = /<t[^>]*>(.*?)<\/t>/s.exec(contenido);
      if (texto) return texto[1];
      const numero = /<v>(.*?)<\/v>/s.exec(contenido);
      return numero ? numero[1] : '';
    }),
  );
  return { encabezados: filas[0] ?? [], filas: filas.slice(1) };
}

describe('la exportación de precios de un artículo que se vende entero', () => {
  it('en el Excel, la celda «Precio por kilo» queda vacía y el precio va en «Precio por unidad»', async () => {
    const producto = await maple();
    await approveSalePrice(escenario.admin, {
      productId: producto.id,
      approvedPricePerKg: '2337.04',
    });

    const filas = await getPriceExportRows(escenario.admin);
    const { encabezados, filas: datos } = await hojaDelExcel(await priceRowsToXlsx(filas));

    const fila = datos.find((f) => f.includes('Maple de huevos'));
    expect(fila, 'el maple tiene que estar en la planilla').toBeDefined();

    const celda = (rotulo: string) => fila![encabezados.indexOf(rotulo)];
    expect(encabezados).toContain('Precio por kilo');
    expect(encabezados).toContain('Precio por unidad');

    // El precio va donde dice «por unidad», con sus centavos.
    expect(celda('Precio por unidad')).toBe('2337.04');
    // Y la celda «por kilo» queda vacía: no hay kilos de maple.
    expect(celda('Precio por kilo')).toBe('');
    // La del aprobado por kilo, también: el aprobado ya está arriba, rotulado.
    expect(celda('Precio base aprobado/kg')).toBe('');
  });

  it('el que se vende por kilo sigue con su precio en la columna por kilo', async () => {
    const porKilo = await feteable();
    await approveSalePrice(escenario.admin, {
      productId: porKilo.id,
      approvedPricePerKg: '10900',
    });

    const filas = await getPriceExportRows(escenario.admin);
    const { encabezados, filas: datos } = await hojaDelExcel(await priceRowsToXlsx(filas));

    const fila = datos.find((f) => f.includes('Queso cremoso'))!;
    const celda = (rotulo: string) => fila[encabezados.indexOf(rotulo)];

    expect(celda('Precio por kilo')).toBe('10900');
    expect(celda('Precio base aprobado/kg')).toBe('10900');
    // Y nada en la columna de unidad: no se vende entero.
    expect(celda('Precio por unidad')).toBe('');
  });

  it('los dos conviven en la misma planilla, cada uno en su columna', async () => {
    const unMaple = await maple();
    const unQueso = await feteable();
    await approveSalePrice(escenario.admin, {
      productId: unMaple.id,
      approvedPricePerKg: '2337.04',
    });
    await approveSalePrice(escenario.admin, {
      productId: unQueso.id,
      approvedPricePerKg: '10900',
    });

    const { encabezados, filas } = await hojaDelExcel(
      await priceRowsToXlsx(await getPriceExportRows(escenario.admin)),
    );
    const porKilo = encabezados.indexOf('Precio por kilo');
    const porUnidad = encabezados.indexOf('Precio por unidad');

    const maple9101 = filas.find((f) => f.includes('Maple de huevos'))!;
    const queso9102 = filas.find((f) => f.includes('Queso cremoso'))!;

    expect([maple9101[porKilo], maple9101[porUnidad]]).toEqual(['', '2337.04']);
    expect([queso9102[porKilo], queso9102[porUnidad]]).toEqual(['10900', '']);
  });

  it('en el PDF de empleados dice «Unidad» y muestra el precio aprobado', async () => {
    const producto = await maple();
    await approveSalePrice(escenario.admin, {
      productId: producto.id,
      approvedPricePerKg: '2337.04',
    });

    const pdf = priceRowsToEmployeePdf(await getPriceExportRows(escenario.admin));
    const texto = pdf.toString('latin1');

    expect(texto).toContain('Maple de huevos');
    /*
     * La etiqueta la lleva el encabezado de la columna, no cada renglón: estos
     * artículos van agrupados aparte, bajo «PRECIO UNIDAD».
     */
    expect(texto).toContain('PRECIO UNIDAD');
    expect(texto).toContain('2.337,04');
    // Y en ninguna de las columnas por kilo, que son las de las otras
    // modalidades.
    expect(texto).not.toContain('100 G');
    expect(texto).not.toMatch(/2\.337,04\/kg/);
  });

  it('en el PDF de empleados el aprobado reemplaza al sugerido', async () => {
    /*
     * Antes el listado mostraba siempre el sugerido, que sale del último costo.
     * Un artículo con precio aprobado tiene que figurar con el aprobado: la
     * lista impresa es lo que se cobra, y ahí no puede aparecer un número que
     * nadie confirmó.
     */
    const producto = await maple('1500');
    const antes = priceRowsToEmployeePdf(await getPriceExportRows(escenario.admin)).toString(
      'latin1',
    );
    // Sin aprobar: se ve el sugerido, 1500 × 1,45.
    expect(antes).toContain('2.175,00');

    await approveSalePrice(escenario.admin, {
      productId: producto.id,
      approvedPricePerKg: '2337.04',
    });

    const despues = priceRowsToEmployeePdf(await getPriceExportRows(escenario.admin)).toString(
      'latin1',
    );
    expect(despues).toContain('2.337,04');
    expect(despues).not.toContain('2.175,00');
  });

  it('en el PDF de gestión la venta base es la del precio aprobado por unidad', async () => {
    const producto = await maple();
    await approveSalePrice(escenario.admin, {
      productId: producto.id,
      approvedPricePerKg: '2337.04',
    });

    const texto = priceRowsToManagementPdf(await getPriceExportRows(escenario.admin)).toString(
      'latin1',
    );

    expect(texto).toContain('Maple de huevos');
    expect(texto).toContain('2.337,04');
    // El encabezado de esa columna es genérico —«Venta base»— justamente para
    // no decir «kilo» sobre un artículo que se vende entero.
    expect(texto).toContain('Venta base');
    expect(texto).not.toContain('Venta por kilo');
  });

  it('los importes no cambian: sólo cambia dónde y con qué rótulo se muestran', async () => {
    /*
     * La corrección es de etiquetas. El precio aprobado, el costo y el historial
     * son exactamente los mismos antes y después: lo único que se movió es en
     * qué columna aparece cada número.
     */
    const producto = await maple('1500');
    await approveSalePrice(escenario.admin, {
      productId: producto.id,
      approvedPricePerKg: '2337.04',
    });

    const fila = (await getPriceExportRows(escenario.admin)).find(
      (f) => f.productId === producto.id,
    )!;

    // El aprobado en el historial no se tocó.
    expect(fila.approvedPricePerKg).toBe('2337.04');
    // El costo unitario tampoco.
    expect(fila.purchaseUnitCost).toBe('1500.00');
    // Y el precio efectivo es el aprobado, expresado por unidad.
    expect(fila.salePricePerUnit).toBe('2337.04');
    expect(fila.salePricePerKg).toBeNull();

    const historial = await prisma.salePriceHistory.findMany({
      where: { productId: producto.id },
    });
    expect(historial).toHaveLength(1);
    expect(historial[0].approvedPricePerKg.toString()).toBe('2337.04');
    expect(historial[0].costBasis.toString()).toBe('1500');
  });
});
