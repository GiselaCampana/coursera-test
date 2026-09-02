import { test, expect, type Page } from '@playwright/test';
import { ingresar, sinScrollHorizontal, soloEnIphone } from './ayudas';
import { cargarEntornoE2E } from './entorno';

/**
 * Los marcajes específicos por modalidad de venta, tal como se ven y se editan.
 *
 * Lo que se controla acá es que cada forma de venta sea de verdad un campo
 * aparte: que la pantalla muestre los de la modalidad del artículo y ninguno de
 * la otra, que cada uno diga su valor propio, el efectivo y de dónde sale, y
 * —sobre todo— que tocar uno no mueva a los demás.
 */

/** Abre el formulario de marcajes de un artículo de la lista de Precios. */
async function abrirMarcajes(page: Page, articulo: string) {
  await page.goto('/precios');
  const ficha = page.locator('li.fila-dato').filter({ hasText: articulo }).first();
  await ficha.getByRole('button', { name: 'Configurar marcajes y venta' }).click();
  return ficha;
}

/** Lo que quedó guardado en el artículo. */
async function marcajesGuardados(plu: string) {
  cargarEntornoE2E();
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const p = await prisma.product.findUniqueOrThrow({
      where: { internalCode: plu },
      select: {
        targetMarginPct: true,
        alCorteHormaDigitalMarginPct: true,
        alCorteHormaCashMarginPct: true,
        alCorteCajaCashMarginPct: true,
        feteado100gMarginPct: true,
        feteadoQuarterMarginPct: true,
        feteadoPieceDigitalMarginPct: true,
        feteadoPieceCashMarginPct: true,
      },
    });
    return Object.fromEntries(
      Object.entries(p).map(([k, v]) => [k, v === null ? null : v.toString()]),
    );
  } finally {
    await prisma.$disconnect();
  }
}

/** Deja los marcajes específicos como estaban, para poder repetir la prueba. */
async function limpiarEspecificos(plu: string) {
  cargarEntornoE2E();
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    await prisma.product.update({
      where: { internalCode: plu },
      data: {
        alCorteHormaDigitalMarginPct: null,
        alCorteHormaCashMarginPct: null,
        alCorteCajaCashMarginPct: null,
        feteado100gMarginPct: null,
        feteadoQuarterMarginPct: null,
        feteadoPieceDigitalMarginPct: null,
        feteadoPieceCashMarginPct: null,
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}

test.describe('marcajes por modalidad de venta', () => {
  test('un artículo al corte muestra kilo, horma digital, horma efectivo y caja efectivo', async ({
    page,
  }) => {
    await ingresar(page, 'admin');
    // El cremoso es AL_CORTE.
    await abrirMarcajes(page, 'Cremoso Punta del Agua');

    await expect(page.getByRole('heading', { name: 'Marcajes · venta al corte' })).toBeVisible();
    await expect(page.getByLabel('Por kilo (%)')).toBeVisible();
    await expect(page.getByLabel('Horma digital (%)')).toBeVisible();
    await expect(page.getByLabel('Horma efectivo (%)')).toBeVisible();
    await expect(page.getByLabel('Caja efectivo (%)')).toBeVisible();

    // Y ninguno de los feteables: no se configura lo que no corresponde.
    await expect(page.getByLabel('100 g (%)')).toHaveCount(0);
    await expect(page.getByLabel('1/4 kg (%)')).toHaveCount(0);
    await expect(page.getByLabel('Pieza digital (%)')).toHaveCount(0);
    await expect(page.getByLabel('Pieza efectivo (%)')).toHaveCount(0);
  });

  test('un artículo feteable muestra 100 g, 1/4 kg, pieza digital y pieza efectivo', async ({
    page,
  }) => {
    await ingresar(page, 'admin');
    await abrirMarcajes(page, 'Longaniza corta');

    await expect(page.getByRole('heading', { name: 'Marcajes · venta feteada' })).toBeVisible();
    await expect(page.getByLabel('100 g (%)')).toBeVisible();
    await expect(page.getByLabel('1/4 kg (%)')).toBeVisible();
    await expect(page.getByLabel('Pieza digital (%)')).toBeVisible();
    await expect(page.getByLabel('Pieza efectivo (%)')).toBeVisible();
    // El base sigue estando, porque es de donde salen los que queden vacíos.
    await expect(page.getByLabel('Por kilo · marcaje base (%)')).toBeVisible();

    await expect(page.getByLabel('Horma digital (%)')).toHaveCount(0);
    await expect(page.getByLabel('Caja efectivo (%)')).toHaveCount(0);
  });

  test('cada campo dice el valor efectivo y de dónde sale', async ({ page }) => {
    /*
     * Los tres datos que pidió la usuaria: el valor propio editable, el
     * efectivo y el origen. Sin el origen, un 45 % no distingue el que alguien
     * eligió para este artículo del que le llega de la familia, y son cosas que
     * se comportan distinto cuando se toca el rubro.
     */
    await ingresar(page, 'admin');
    const ficha = await abrirMarcajes(page, 'Cremoso Punta del Agua');

    // El cremoso tiene su 45 % propio, así que el kilo lo dice.
    await expect(ficha.getByText('45 % · propio del artículo').first()).toBeVisible();
    // Y la horma, que nadie configuró, toma ese mismo marcaje por kilo.
    await expect(ficha.getByText('45 % · toma el marcaje por kilo').first()).toBeVisible();
    // La cadena completa, escrita arriba del formulario.
    await expect(ficha.getByText(/este artículo.*familia Quesos.*regla general/s)).toBeVisible();
  });

  test('cambiar el marcaje de horma no modifica el de kilo', async ({ page }) => {
    /*
     * La prueba que pidió la usuaria, hecha por la pantalla: se toca un solo
     * campo, se guarda, y se mira lo que quedó en la base. Ocho campos que se
     * pisan entre sí no son ocho campos.
     */
    await limpiarEspecificos('1211');
    await ingresar(page, 'admin');
    const ficha = await abrirMarcajes(page, 'Cremoso Punta del Agua');

    await page.getByLabel('Horma digital (%)').fill('25');
    await ficha.getByRole('button', { name: 'Guardar configuración' }).click();
    await expect(ficha.getByText('Configuración actualizada.')).toBeVisible();

    const guardado = await marcajesGuardados('1211');
    expect(guardado.alCorteHormaDigitalMarginPct).toBe('0.25');
    // El kilo queda donde estaba…
    expect(guardado.targetMarginPct).toBe('0.45');
    // …y las otras formas de venta siguen heredando, sin materializarse.
    expect(guardado.alCorteHormaCashMarginPct).toBeNull();
    expect(guardado.alCorteCajaCashMarginPct).toBeNull();
    expect(guardado.feteadoQuarterMarginPct).toBeNull();

    await limpiarEspecificos('1211');
  });

  test('cambiar el marcaje de pieza no modifica el de 100 g ni el de 1/4', async ({ page }) => {
    await limpiarEspecificos('1001');
    await ingresar(page, 'admin');
    const ficha = await abrirMarcajes(page, 'Longaniza corta');

    await page.getByLabel('Pieza digital (%)').fill('25');
    await page.getByLabel('Pieza efectivo (%)').fill('22');
    await ficha.getByRole('button', { name: 'Guardar configuración' }).click();
    await expect(ficha.getByText('Configuración actualizada.')).toBeVisible();

    const guardado = await marcajesGuardados('1001');
    expect(guardado.feteadoPieceDigitalMarginPct).toBe('0.25');
    expect(guardado.feteadoPieceCashMarginPct).toBe('0.22');
    // Los dos que se ven en la etiqueta del mostrador, intactos.
    expect(guardado.feteado100gMarginPct).toBeNull();
    expect(guardado.feteadoQuarterMarginPct).toBeNull();
    expect(guardado.targetMarginPct).toBe('0.45');

    await limpiarEspecificos('1001');
  });

  test('el redondeo de cada forma de venta se dice en su campo', async ({ page }) => {
    await ingresar(page, 'admin');
    const ficha = await abrirMarcajes(page, 'Longaniza corta');
    // 100 g y 1/4 van al $100; la pieza queda exacta.
    await expect(ficha.getByText(/redondea al \$100/).first()).toBeVisible();
    await expect(ficha.getByText(/importe exacto/).first()).toBeVisible();
  });

  test('entra en la pantalla del teléfono sin desbordarse', async ({ page }, testInfo) => {
    soloEnIphone(test, testInfo.project.name);
    await ingresar(page, 'admin');
    await abrirMarcajes(page, 'Longaniza corta');
    await sinScrollHorizontal(page);
  });
});

test.describe('la regla general', () => {
  test('se configura desde el catálogo y dice a cuántos artículos les llega', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/configuracion/catalogo');

    await expect(page.getByRole('heading', { name: 'Regla general de marcajes' })).toBeVisible();
    // Es el tercer nivel, no una configuración paralela.
    await expect(page.getByText(/artículo → familia → regla general/)).toBeVisible();
    await expect(
      page.getByText(/artículos? dependen de ella|Ningún artículo depende hoy/),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Configurar la regla general' }).click();
    await expect(page.getByLabel('Marcaje base general (%)')).toBeVisible();
    await expect(page.getByLabel('Horma digital (%)')).toBeVisible();
    await expect(page.getByLabel('1/4 kg (%)')).toBeVisible();
    await expect(page.getByLabel('Unidad entera (%)')).toBeVisible();
  });

  test('un operador no configura la regla general', async ({ page }) => {
    await ingresar(page, 'operador');
    await page.goto('/configuracion/catalogo');
    await expect(page.getByRole('heading', { name: 'Regla general de marcajes' })).toHaveCount(0);
  });
});
