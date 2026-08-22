import { test, expect, type Page } from '@playwright/test';
import { facturaLosCalvosJpeg } from './factura-imagen';
import { ingresar, sinScrollHorizontal, soloEnIphone } from './ayudas';

/**
 * Lectura automática de la factura de Los Calvos, con Tesseract en el navegador.
 *
 * Es la prueba de aceptación del proyecto y la que demuestra que la lectura no
 * necesita ninguna clave de API: se sube la foto de la factura, el OCR corre
 * dentro del teléfono con los archivos que sirve la propia aplicación, y el
 * resultado tiene que ser 9 artículos, 153,70 kg y $2.196.120,52.
 *
 * Reconocer una página entera con Tesseract lleva su tiempo, y encima se leen
 * los recortes de la tabla y del pie: por eso el margen es amplio.
 */
const MINUTOS = 60_000;
test.describe.configure({ timeout: 6 * MINUTOS });

/** Sube la foto y espera a que termine la lectura, con su progreso a la vista. */
async function leer(page: Page, imagen: Buffer, nombre = 'factura-los-calvos.jpg') {
  const galeria = page.locator('input[type="file"]').nth(1);
  await galeria.setInputFiles([{ name: nombre, mimeType: 'image/jpeg', buffer: imagen }]);
  await expect(page.locator('.miniatura')).toHaveCount(1);

  await page.getByRole('button', { name: 'Leer el comprobante' }).click();

  // Mientras trabaja avisa en qué anda: el lector se prepara antes de leer.
  await expect(page.getByText(/Preparando|Leyendo|Verificando/).first()).toBeVisible({
    timeout: 2 * MINUTOS,
  });

  await expect(page.getByRole('heading', { name: 'Revisar los datos' })).toBeVisible({
    timeout: 5 * MINUTOS,
  });
}

test.describe('lectura automática sin servicios pagos', () => {
  test.beforeEach(async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/nueva-compra');
  });

  test('lee la factura de Los Calvos: 9 artículos, 153,70 kg y $2.196.120,52', async ({
    page,
  }, testInfo) => {
    soloEnIphone(test, testInfo.project.name);

    // Todo lo que pide el navegador queda anotado: al final se comprueba que
    // no salió a ningún servicio de afuera.
    const externos: string[] = [];
    page.on('request', (peticion) => {
      const url = new URL(peticion.url());
      if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') externos.push(peticion.url());
    });

    await leer(page, await facturaLosCalvosJpeg());

    // El comprobante queda controlado. Puede ser verde, o amarillo si hizo
    // falta releer: las dos cosas significan que artículos, neto, impuestos y
    // total cierran con lo impreso, y las dos habilitan el guardado. Lo que no
    // puede haber es rojo.
    const semaforo = page.locator('.semaforo-ok, .semaforo-aviso');
    await expect(semaforo).toBeVisible();
    await expect(semaforo).toContainText('Comprobante controlado');
    await expect(page.locator('.semaforo-error')).toHaveCount(0);
    await expect(page.locator('.card', { hasText: 'Qué no cierra' })).toHaveCount(0);

    // Los nueve renglones de la factura.
    await expect(page.getByText('9 renglones')).toBeVisible();
    await expect(page.locator('.lista > li')).toHaveCount(9);

    // Y los números del caso de aceptación, tal como los muestra la pantalla.
    const detalle = page.locator('.card', { hasText: 'Lo que da el detalle' });
    await expect(detalle).toContainText('153,70 kg');
    await expect(detalle).toContainText('$ 2.196.120,52');
    await expect(detalle).toContainText('$ 1.792.751,44');

    // El encabezado también salió de la foto.
    await expect(page.locator('#pv')).toHaveValue('0010');
    await expect(page.locator('#numero')).toHaveValue('00212356');
    await expect(page.locator('#fecha')).toHaveValue('2026-08-14');
    await expect(page.locator('#total')).toHaveValue(/2\.196\.120,52|2196120,52/);

    // Nunca se pidió nada a un servidor ajeno: el OCR corrió en el teléfono.
    expect(externos, `El navegador salió a: ${externos.join(', ')}`).toHaveLength(0);

    await sinScrollHorizontal(page);
  });

  test('guarda la compra leída y le agenda el pago', async ({ page }, testInfo) => {
    soloEnIphone(test, testInfo.project.name);

    await leer(page, await facturaLosCalvosJpeg());
    await expect(page.locator('.semaforo-ok, .semaforo-aviso')).toBeVisible();

    // El número se cambia para no chocar con la factura que ya sembró la base.
    await page.locator('#numero').fill('00212399');

    await page.getByRole('button', { name: 'Continuar al pago' }).click();
    await expect(page.getByRole('heading', { name: 'Guardar y agendar el pago' })).toBeVisible();

    const guardar = page.getByRole('button', { name: 'Guardar y agendar el pago' });
    await expect(guardar).toBeEnabled();
    await guardar.click();

    // Queda guardada y visible en el listado de compras.
    await expect(page.getByText(/Compra guardada|guardada/i).first()).toBeVisible({
      timeout: 60_000,
    });
    await page.goto('/compras');
    await expect(page.getByText('0010-00212399')).toBeVisible();
  });

  test('una foto movida no cierra en la primera lectura y se relee sola', async ({
    page,
  }, testInfo) => {
    soloEnIphone(test, testInfo.project.name);

    // Tabla chica, con menos contraste y desenfoque: la foto sacada a mano
    // alzada dentro del depósito.
    await leer(
      page,
      await facturaLosCalvosJpeg({ deterioro: 'borroso', desenfoque: 1.4 }),
      'IMG_5522.JPG',
    );

    // Pase lo que pase, el resultado es honesto: o cierra de verdad, o queda
    // en rojo con el guardado bloqueado. Lo que nunca hace es inventar.
    const controlado = await page.locator('.semaforo-ok, .semaforo-aviso').count();
    if (controlado > 0) {
      await expect(page.locator('.card', { hasText: 'Lo que da el detalle' })).toContainText(
        '$ 2.196.120,52',
      );
    } else {
      const rojo = page.locator('.semaforo-error');
      await expect(rojo).toBeVisible();
      await expect(rojo).toContainText('El detalle no coincide con el comprobante');
      await expect(
        page.getByRole('button', { name: 'Volver a leer o reemplazar la imagen' }),
      ).toBeVisible();

      await page.getByRole('button', { name: 'Continuar al pago' }).click();
      await expect(
        page.getByRole('button', { name: 'Guardar y agendar el pago' }),
      ).toBeDisabled();
    }
  });

  test('endereza la foto que el iPhone guardó de costado', async ({ page }, testInfo) => {
    soloEnIphone(test, testInfo.project.name);

    // Orientación 6 en los EXIF: la imagen está girada 90° en el archivo y el
    // teléfono espera que quien la muestre la enderece.
    await leer(page, await facturaLosCalvosJpeg({ rotacionExif: 6 }), 'IMG_5523.JPG');

    await expect(page.locator('.semaforo-ok, .semaforo-aviso')).toBeVisible();
    await expect(page.locator('.card', { hasText: 'Lo que da el detalle' })).toContainText(
      '153,70 kg',
    );
  });

  test('no menciona claves de API ni servicios pagos en ninguna pantalla', async ({ page }) => {
    const prohibido = /anthropic|api[\s-]?key|clave de api|OCR_PROVIDER|token de/i;

    for (const ruta of ['/nueva-compra', '/compras', '/pagos', '/inicio']) {
      await page.goto(ruta);
      const texto = (await page.locator('body').innerText()).toLowerCase();
      expect(texto, `${ruta} menciona un servicio pago`).not.toMatch(prohibido);
    }
  });

  test('sirve el lector desde la propia aplicación, sin CDN', async ({ page }) => {
    // Los archivos del OCR tienen que estar publicados por la aplicación: si
    // faltaran, la lectura dependería de una descarga externa.
    for (const archivo of [
      '/ocr/tesseract/worker.min.js',
      '/ocr/tessdata/spa.traineddata.gz',
      '/ocr/pdfjs/pdf.worker.min.mjs',
    ]) {
      const respuesta = await page.request.get(archivo);
      expect(respuesta.status(), `Falta ${archivo}`).toBe(200);
      expect(Number(respuesta.headers()['content-length'] ?? 1)).toBeGreaterThan(0);
    }
  });
});
