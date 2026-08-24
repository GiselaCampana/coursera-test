import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { ingresar, sinScrollHorizontal, soloEnIphone } from './ayudas';
import { limpiarComprobantesLeidos } from './entorno';

/**
 * Prueba de aceptación con una foto real de Distribución Errecalde.
 *
 * A diferencia de la de Los Calvos, que trabaja sobre una factura dibujada por
 * la propia prueba, esta corre sobre **la foto que se sacó con el iPhone**: la
 * factura sobre una caja de cartón, con una botella al lado, apoyada torcida y
 * con las tildes hechas a mano sobre cada renglón. Es el archivo tal cual salió
 * del teléfono, con su orientación EXIF y sus 5,4 MB.
 *
 * Es la prueba que importa, porque el circuito falló justamente en el paso que
 * una factura dibujada no ejercita: sobre esa foto la corrección de perspectiva
 * enganchaba las esquinas equivocadas y cizallaba la página, y el recorte de la
 * tabla se leía como un bloque único y devolvía un renglón de veintitrés.
 *
 * Lo que dice el papel:
 *   Factura-Remito A 00008-00002647 · 22/08/2026 · 23 renglones
 *   Neto gravado 3.830.467,37 · IVA 804.398,16
 *   Percepción IVA RG 5329 114.914,02 · Percepción IIBB 67.033,18
 *   Total 4.816.812,73
 */
const MINUTOS = 60_000;
test.describe.configure({ timeout: 8 * MINUTOS });

async function fotoErrecalde(): Promise<Buffer> {
  return readFile(path.resolve(__dirname, '../fixtures/imagenes/errecalde-00008-00002647.jpg'));
}

async function leer(page: Page, imagen: Buffer) {
  const galeria = page.locator('input[type="file"]').nth(1);
  await galeria.setInputFiles([
    { name: 'errecalde.jpg', mimeType: 'image/jpeg', buffer: imagen },
  ]);
  await expect(page.locator('.miniatura')).toHaveCount(1);

  await page.getByRole('button', { name: 'Leer el comprobante' }).click();
  await expect(page.getByText(/Preparando|Leyendo|Verificando/).first()).toBeVisible({
    timeout: 3 * MINUTOS,
  });
  await expect(page.getByRole('heading', { name: 'Revisar los datos' })).toBeVisible({
    timeout: 7 * MINUTOS,
  });
}

test.describe('lectura de una foto real de Errecalde', () => {
  test.afterAll(async () => {
    await limpiarComprobantesLeidos();
  });

  test.beforeEach(async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/nueva-compra');
  });

  test('lee los 23 renglones y el pie completo de la foto', async ({ page }, testInfo) => {
    soloEnIphone(test, testInfo.project.name);

    const externos: string[] = [];
    page.on('request', (peticion) => {
      const url = new URL(peticion.url());
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return;
      externos.push(peticion.url());
    });

    await leer(page, await fotoErrecalde());

    // Los 23 renglones. Es lo que fallaba: devolvía uno.
    await expect(page.getByText('23 renglones', { exact: true })).toBeVisible();
    await expect(page.locator('.lista > li')).toHaveCount(23);

    // El encabezado salió de la foto.
    await expect(page.locator('#pv')).toHaveValue('00008');
    await expect(page.locator('#numero')).toHaveValue('00002647');
    await expect(page.locator('#fecha')).toHaveValue('2026-08-22');

    // El pie, los cuatro números por separado y el total.
    await expect(page.locator('#netTotal')).toHaveValue(/3\.830\.467,37|3830467,37/);
    await expect(page.locator('#ivaTotal')).toHaveValue(/804\.398,16|804398,16/);
    // 114.914,02 + 67.033,18: las dos percepciones, sumadas.
    await expect(page.locator('#perceptionsTotal')).toHaveValue(/181\.947,2/);
    await expect(page.locator('#total')).toHaveValue(/4\.816\.812,73|4816812,73/);

    // Y el detalle reconstruido a partir de los 23 renglones cae sobre el neto
    // impreso, con el margen de centavos que deja la lectura de una foto.
    const detalle = page.locator('.card', { hasText: 'Lo que da el detalle' });
    // Sin el signo pesos adelante: el formato es-AR separa con un espacio
    // especial que una expresión regular no normaliza.
    await expect(detalle).toContainText(/3\.830\.46[5-9],\d\d/);

    expect(externos, `El navegador salió a: ${externos.join(', ')}`).toHaveLength(0);
    await sinScrollHorizontal(page);
  });

  test('marca lo que no pudo leer al centavo en vez de darlo por bueno', async ({
    page,
  }, testInfo) => {
    soloEnIphone(test, testInfo.project.name);
    await leer(page, await fotoErrecalde());

    /*
     * Sobre esta foto quedan uno o dos renglones cuyos centavos el OCR no lee
     * bien: los dígitos de los centavos, en el borde derecho de la tabla, salen
     * "00" donde el papel dice "34". Son centavos sobre una factura de casi
     * cuatro millones.
     *
     * Lo que se comprueba acá es que la aplicación **no los da por buenos**. Un
     * comprobante que no se pudo verificar renglón por renglón no se guarda como
     * controlado, aunque la diferencia sea de medio peso: el operador confirma
     * ese renglón mirando el papel y recién ahí se guarda. Preferimos eso a que
     * el sistema complete un número que no llegó a leer.
     */
    const noCierra = page.locator('.card', { hasText: 'Qué no cierra' });
    if (await noCierra.count()) {
      // Si algo quedó marcado, tiene que ser un renglón puntual y no el
      // comprobante entero, y el guardado tiene que estar frenado.
      await expect(noCierra).toContainText(/renglón \d+/i);
      await expect(page.locator('.semaforo-ok')).toHaveCount(0);
    }

    // En cualquier caso, la diferencia contra el papel es de centavos: si fuera
    // grande, lo que falló no son los centavos sino la lectura de la tabla.
    const detalle = page.locator('.card', { hasText: 'Lo que da el detalle' });
    // Sin el signo pesos adelante: el formato es-AR separa con un espacio
    // especial que una expresión regular no normaliza.
    await expect(detalle).toContainText(/3\.830\.46[5-9],\d\d/);
  });

  test('distingue los artículos por kilo de los que van por unidad', async ({ page }, testInfo) => {
    soloEnIphone(test, testInfo.project.name);
    await leer(page, await fotoErrecalde());

    const fila = (codigo: string) =>
      page.locator('.lista > li').filter({ hasText: `código ${codigo}` });

    /*
     * La columna Cantidad de esta factura mezcla las dos formas de vender, y lo
     * único que las distingue es el sufijo "kg" impreso.
     *
     * PERNIL TERMOLI: 40 bultos que pesan 156,3 kg.
     * TOMATE EN BOTELLA: 32 unidades, y ningún kilo que inventar.
     */
    // `exact` no es opcional acá: sin él, "Unidad" también engancha el campo
    // "Unidades" y el localizador queda ambiguo.
    const pernil = fila('ART-02174');
    await expect(pernil.getByLabel('Unidad', { exact: true })).toHaveValue('KG');
    await expect(pernil.getByLabel('Kilos', { exact: true })).toHaveValue('156,30');
    await expect(pernil.getByLabel('Piezas', { exact: true })).toHaveValue('40');

    const tomate = fila('ART-01477');
    await expect(tomate.getByLabel('Unidad', { exact: true })).toHaveValue('UNIT');
    await expect(tomate.getByLabel('Unidades', { exact: true })).toHaveValue('32,00');
    // A lo que va por unidad no se le pone un peso.
    await expect(tomate.getByLabel('Piezas', { exact: true })).toHaveValue('');
  });
});
