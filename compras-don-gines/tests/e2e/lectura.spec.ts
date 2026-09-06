import { test, expect, type Page } from '@playwright/test';
import { facturaLosCalvosJpeg } from './factura-imagen';
import { ingresar, sinScrollHorizontal, soloEnIphone } from './ayudas';
import { limpiarComprobantesLeidos } from './entorno';

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
  // Estas pruebas cargan comprobantes de verdad. Si quedaran en la base, las
  // que miran los listados y el historial contarían de más: esperan el
  // escenario sembrado y nada más.
  test.afterAll(async () => {
    await limpiarComprobantesLeidos();
  });

  test.beforeEach(async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/nueva-compra');
  });

  test('lee la factura de Los Calvos: 9 artículos, 153,70 kg y $2.196.120,52', async ({
    page,
  }, testInfo) => {
    soloEnIphone(test, testInfo.project.name);

    // Todo lo que pide el navegador queda anotado: al final se comprueba que
    // no salió a ningún servicio de afuera. Los blob: y data: no son pedidos de
    // red: son datos que la propia página armó en memoria.
    const externos: string[] = [];
    page.on('request', (peticion) => {
      const url = new URL(peticion.url());
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return;
      externos.push(peticion.url());
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
    await expect(page.getByText('9 renglones', { exact: true })).toBeVisible();
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

    // Queda guardada, con el pago agendado, y se puede consultar después.
    await expect(page.getByText('El comprobante se guardó y el pago quedó agendado.')).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByRole('heading', { level: 1 })).toContainText('0010-00212399');

    await page.goto('/comprobantes');
    await expect(page.getByText('0010-00212399').first()).toBeVisible();
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
    // teléfono espera que quien la muestre la enderece. Si no se respetara, el
    // comprobante llegaría acostado a Tesseract y no se leería absolutamente
    // nada: ni el número, ni la fecha, ni un solo renglón. Que salgan es la
    // prueba de que la orientación se aplicó.
    await leer(page, await facturaLosCalvosJpeg({ rotacionExif: 6 }), 'IMG_5523.JPG');

    await expect(page.locator('#pv')).toHaveValue('0010');
    await expect(page.locator('#numero')).toHaveValue('00212356');
    await expect(page.locator('#fecha')).toHaveValue('2026-08-14');
    await expect(page.locator('.lista > li')).toHaveCount(9);
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


/**
 * Cuando la foto no se leyó, la revisión no se abre.
 *
 * Lo que se prueba acá es el cableado, no la calidad del OCR: que el veredicto
 * del servidor llegue al navegador, frene el paso a «Revisar los datos» y deje
 * a la vista los dos botones para volver a sacar la foto. Por eso la respuesta
 * del control se inyecta en vez de depender de que Tesseract lea mal: una
 * prueba que necesita que el reconocimiento falle se rompería el día que
 * mejore, y ese día no habría ningún defecto que arreglar.
 *
 * Las dos fotos reales que motivaron el control —Los Calvos 0010-00212356 y
 * 0010-00213103 reescalada— se miden en tests/fotos/lectura-real.test.ts, que
 * corre el lector de verdad sobre ellas.
 */
test.describe('una lectura insuficiente frena antes de la revisión', () => {
  test.afterAll(async () => {
    await limpiarComprobantesLeidos();
  });

  test.beforeEach(async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/nueva-compra');
  });

  test('muestra el mensaje, no abre la revisión y deja volver a sacar la foto', async ({
    page,
  }, testInfo) => {
    soloEnIphone(test, testInfo.project.name);

    // El servidor contesta que la lectura no alcanza. Es la misma forma de
    // respuesta que produce la ruta real ante una foto ilegible.
    await page.route('**/api/comprobantes/*/lectura', async (ruta) => {
      await ruta.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          documentId: 'x',
          estado: 'DIFERENCIA',
          puedeGuardar: false,
          controles: [
            {
              code: 'LECTURA_UTILIZABLE',
              label: 'Calidad de la lectura',
              severity: 'ERROR',
              message:
                'No pudimos leer correctamente los renglones de esta factura. Usá la foto ' +
                'original o volvé a sacarla con el papel completo, buena luz y sin movimiento. ' +
                'En la imagen se ven 10 filas y se entendieron 2: falta más de la mitad de la tabla.',
            },
          ],
          calculado: null,
          analizador: 'los-calvos',
          renglonesAsociados: 0,
          renglonesSinAsociar: 0,
          intentos: 1,
          observaciones: [],
          releer: null,
        }),
      });
    });

    const galeria = page.locator('input[type="file"]').nth(1);
    await galeria.setInputFiles([
      { name: 'factura.jpg', mimeType: 'image/jpeg', buffer: await facturaLosCalvosJpeg() },
    ]);
    await expect(page.locator('.miniatura')).toHaveCount(1);
    await page.getByRole('button', { name: 'Leer el comprobante' }).click();

    /*
     * El mensaje, en castellano y diciendo qué hacer con el papel.
     *
     * Se apunta al recuadro de error de la aplicación y no a `role=alert` a
     * secas: Next mete su propio anunciador de rutas con ese rol, vacío, y la
     * consulta engancharía los dos.
     */
    await expect(page.locator('.mensaje-error')).toContainText(
      'volvé a sacarla con el papel completo',
      { timeout: 4 * MINUTOS },
    );

    // Y lo que no tiene que pasar: entrar a revisar dos renglones de diez.
    await expect(page.getByRole('heading', { name: 'Revisar los datos' })).toHaveCount(0);

    // Los dos caminos para arreglarlo siguen a mano.
    await expect(page.getByRole('button', { name: 'Sacar foto' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Elegir del teléfono' })).toBeEnabled();
  });
});
