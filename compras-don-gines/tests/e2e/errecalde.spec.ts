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
    // impreso, con los centavos ya conciliados.
    const detalle = page.locator('.card', { hasText: 'Lo que da el detalle' });
    // Sin el signo pesos adelante: el formato es-AR separa con un espacio
    // especial que una expresión regular no normaliza.
    await expect(detalle).toContainText(/3\.830\.467,\d\d/);

    expect(externos, `El navegador salió a: ${externos.join(', ')}`).toHaveLength(0);
    await sinScrollHorizontal(page);
  });

  test('no frena por centavos de OCR, y avisa los que concilió', async ({ page }, testInfo) => {
    soloEnIphone(test, testInfo.project.name);
    await leer(page, await fotoErrecalde());

    /*
     * Sobre esta foto quedan uno o dos renglones cuyos centavos el OCR no lee:
     * los dígitos más chicos de la tabla, contra el borde derecho de la
     * columna, salen "00" donde el papel dice "34".
     *
     * La conciliación de centavos los corrige con la cantidad y el precio del
     * propio renglón, y sólo porque acá se dan todas sus condiciones: el pie
     * cierra consigo mismo, están los 23 renglones, los pesos de cada importe
     * coinciden y las correcciones empujan hacia lo que al detalle le falta para
     * el subtotal impreso, sin pasarse.
     *
     * Así que el comprobante se puede guardar, pero lo dice.
     */
    // Nada de rojo y el guardado habilitado: los centavos ya no frenan.
    await expect(page.locator('.semaforo-error')).toHaveCount(0);
    await expect(page.locator('.card', { hasText: 'Qué no cierra' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Continuar al pago' })).toBeEnabled();

    /*
     * El semáforo puede quedar verde o amarillo, y las dos cosas están bien: si
     * además hizo falta releer la foto, el amarillo lo dice y eso no tiene que
     * ver con los centavos. Lo que no puede pasar es que la conciliación quede
     * escondida, así que la advertencia se pide en el estado que sea.
     */
    const semaforo = page.locator('.semaforo-ok, .semaforo-aviso');
    await expect(semaforo).toBeVisible();
    await expect(semaforo).toContainText(/Se conciliaron autom[áa]ticamente/);
    await expect(semaforo).toContainText(/centavos de OCR/);

    // Y en la lista de controles queda el detalle de qué se cambió.
    const control = page.locator('.controles li', { hasText: 'Centavos conciliados' });
    await expect(control).toContainText(/Rengl[óo]n \d+/);
    await expect(control).toContainText(/se leyó .* y quedó/);

    // Y el detalle cae sobre el neto impreso, dentro del peso: lo que queda son
    // los centavos de redondeo del propio proveedor, no un error de lectura.
    const detalle = page.locator('.card', { hasText: 'Lo que da el detalle' });
    // Sin el signo pesos adelante: el formato es-AR separa con un espacio
    // especial que una expresión regular no normaliza.
    await expect(detalle).toContainText(/3\.830\.467,\d\d/);
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
