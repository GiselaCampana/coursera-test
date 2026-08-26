import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { elegirOpcion, ingresar, sinScrollHorizontal, soloEnIphone } from './ayudas';
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

  test('cierra sin conciliar centavos: el detalle cae sobre el neto impreso', async ({
    page,
  }, testInfo) => {
    soloEnIphone(test, testInfo.project.name);
    await leer(page, await fotoErrecalde());

    /*
     * Esta prueba pedía la conciliación de centavos, porque sobre esta foto
     * quedaban renglones cuyos centavos el OCR no leía: los dígitos más chicos
     * de la tabla, contra el borde derecho de la columna, salían "00" donde el
     * papel dice "34".
     *
     * Ya no pasa. El analizador de Errecalde elige entre las variantes que le
     * ofrecen las pasadas la que cierra contra el propio renglón —cantidad ×
     * precio— y contra el neto impreso, así que el importe llega bien leído en
     * vez de llegar mal y corregirse después. Corregir en la lectura, con los
     * dígitos a la vista, es mejor que corregir en el dominio con una cuenta.
     *
     * Así que acá lo que se controla es que **no haga falta** conciliar nada, y
     * la conciliación en sí se prueba donde se la puede provocar a voluntad:
     * en `lectura.spec.ts`, sobre la factura dibujada de Los Calvos, a la que
     * se le comen los centavos de un renglón a propósito.
     */
    await expect(page.locator('.semaforo-error')).toHaveCount(0);
    await expect(page.locator('.card', { hasText: 'Qué no cierra' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Continuar al pago' })).toBeEnabled();

    // Ningún renglón necesitó corrección.
    await expect(page.locator('.controles li', { hasText: 'Centavos conciliados' })).toHaveCount(0);

    // Cada importe se pudo contrastar contra el papel, y la cuenta de cada
    // renglón cierra: es lo que hace que no quede nada que conciliar.
    const controles = page.locator('.controles li');
    await expect(controles.filter({ hasText: 'Importe impreso de cada renglón' })).toContainText(
      'Todos los renglones se controlaron contra el importe impreso',
    );
    await expect(controles.filter({ hasText: 'Aritmética de los renglones' })).toContainText(
      'cierran en todos los renglones',
    );

    // Y el detalle cae sobre el neto impreso, dentro del peso: lo que queda son
    // los centavos de redondeo del propio proveedor, no un error de lectura.
    const detalle = page.locator('.card', { hasText: 'Lo que da el detalle' });
    // Sin el signo pesos adelante: el formato es-AR separa con un espacio
    // especial que una expresión regular no normaliza.
    await expect(detalle).toContainText(/3\.830\.467,\d\d/);
    await expect(controles.filter({ hasText: 'Neto de los artículos' })).toContainText(
      'coincide con el neto impreso',
    );
  });

  test('el resumen muestra los kilos, las unidades y los impuestos por separado', async ({
    page,
  }, testInfo) => {
    soloEnIphone(test, testInfo.project.name);
    await leer(page, await fotoErrecalde());

    /*
     * Lo que se controla acá es el recálculo posterior a la lectura, que es
     * donde la pantalla mostraba 550,59 kg —los 479,59 kg de fiambre más las
     * 71 latas, sumados como si fueran lo mismo— y un "costo total" que en
     * realidad era el neto.
     *
     * Los importes van sin el signo pesos: el formato es-AR lo separa con un
     * espacio angosto que una expresión regular no normaliza.
     */
    const detalle = page.locator('.card', { hasText: 'Lo que da el detalle' });
    // La etiqueta se busca contra el <dt> y anclada al principio: "IVA" no
    // puede engancharse con "Percepción IVA RG 5329", que es otro número.
    const dato = (etiqueta: string) =>
      detalle
        .locator('.dato')
        .filter({ has: page.locator('dt', { hasText: new RegExp(`^${etiqueta}`) }) })
        .locator('dd');

    await expect(dato('Renglones')).toHaveText('23');

    // Los kilos son sólo de los 16 artículos que se venden por peso.
    await expect(dato('Kilos')).toContainText('480,34 kg');
    await expect(dato('Kilos')).toContainText('16 artículos');

    // Y las 71 unidades van aparte, con los 7 artículos que las componen.
    await expect(dato('Unidades')).toContainText('71');
    await expect(dato('Unidades')).toContainText('7 artículos');

    // Del neto al total, impuesto por impuesto, como los imprime el pie.
    await expect(dato('Neto')).toContainText(/3\.830\.467,\d\d/);
    await expect(dato('IVA')).toContainText(/804\.398,1\d/);
    await expect(dato('Percepción IVA')).toContainText(/114\.914,0\d/);
    await expect(dato('Percepción IIBB')).toContainText(/67\.033,1\d/);

    // El total es el costo real de la compra, no el neto otra vez.
    await expect(dato('Total del comprobante')).toContainText(/4\.816\.812,73/);
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

test.describe('aceptar desde el detalle un comprobante ya leído', () => {
  test.afterAll(async () => {
    await limpiarComprobantesLeidos();
  });

  test.beforeEach(async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/nueva-compra');
  });

  test('se valida sin volver a leer la imagen, y la advertencia queda', async ({
    page,
  }, testInfo) => {
    soloEnIphone(test, testInfo.project.name);

    /*
     * El callejón sin salida que motivó esto.
     *
     * Un comprobante leído queda esperando confirmación. Si la pantalla de carga
     * se cierra —se cambió de pantalla, se cortó la conexión, se dejó para
     * después— la única forma de volver a él era el detalle, y ahí sólo había
     * "rechazar" y "volver". Un comprobante correcto no puede tener como única
     * salida tirarlo y sacar la foto de nuevo.
     *
     * Se usa esta factura y no la dibujada porque es la que se lee entera y sin
     * errores, con una advertencia: el importe de PERNIL TERMOLI no entra en el
     * recorte y se calcula como cantidad × precio, así que queda sin contrastar
     * contra el papel. Una advertencia no impide pagar la factura.
     */
    await leer(page, await fotoErrecalde());

    await expect(page.locator('.semaforo-ok, .semaforo-aviso')).toBeVisible();
    await expect(page.locator('.semaforo-error')).toHaveCount(0);
    // Hay al menos una advertencia: es la situación que hay que poder resolver.
    await expect(page.locator('.controles li').filter({ hasText: 'Importe impreso' })).toBeVisible();

    // Y ahora se abandona la carga a mitad de camino, sin guardar.
    await page.goto('/comprobantes');
    await page.getByText('00008-00002647').first().click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('00008-00002647');

    // La advertencia está a la vista antes de aceptar.
    const advertencia = page.locator('.controles li').filter({ hasText: 'Importe impreso' });
    await expect(advertencia).toBeVisible();

    // La acción principal existe y se puede usar.
    const aceptar = page.getByRole('button', { name: 'Aceptar y validar comprobante' });
    await expect(aceptar).toBeEnabled();
    await aceptar.click();

    /*
     * El backend revalidó con los datos guardados y el comprobante quedó
     * validado. El aviso es el mismo que da el asistente al terminar de
     * guardar, a propósito: es el mismo hecho, y conviene que se vea igual
     * entre por donde entre.
     */
    await expect(page.getByText('El comprobante se guardó y el pago quedó agendado.')).toBeVisible({
      timeout: 30_000,
    });

    // Al recargar, el estado persiste y ya no se ofrece aceptar de nuevo.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Aceptar y validar comprobante' })).toHaveCount(0);

    // Los números del papel siguen ahí, y la advertencia también: validar no la
    // borra, que es lo que uno quiere poder revisar a fin de mes.
    await expect(page.locator('.controles li').filter({ hasText: 'Importe impreso' })).toBeVisible();
    await expect(page.getByText('$ 4.816.812,73').first()).toBeVisible();

    // Y aparece entre los validados.
    await page.goto('/comprobantes?estado=VALIDADO');
    await expect(page.getByText('00008-00002647').first()).toBeVisible();

    /*
     * Y —lo que faltaba— el resto de la aplicación puede usarlo.
     *
     * Que quede VALIDADO no es lo mismo que quede usable: por este camino la
     * factura se aceptaba, quedaba bien, y Compras daba cero kilos, Precios
     * decía que no había ningún costo cargado y la agenda no la mostraba.
     *
     * Acá se comprueba el circuito entero desde este segundo camino de
     * validación, que es el que se probaba sólo hasta el estado. Lo que sí
     * discrimina el defecto puntual —que revalidar los importes desclasificaba
     * los productos ya asociados— es la prueba de integración, porque necesita
     * una asociación hecha a mano que sobreviva a abandonar el asistente, y eso
     * el navegador no lo puede montar.
     */
    await page.goto('/compras?proveedor=');
    await elegirOpcion(page, '#proveedor', 'Distribución Errecalde');
    await page.getByRole('button', { name: 'Filtrar' }).click();
    await expect(page.locator('table tbody tr')).toHaveCount(23);

    // El queso viene asociado por el código del proveedor: sus kilos tienen
    // que estar, no cero.
    await elegirOpcion(page, '#producto', 'Queso Sardo bloque Melincué');
    await page.getByRole('button', { name: 'Filtrar' }).click();
    const kilos = page
      .locator('.card', { hasText: 'Totales del período' })
      .locator('.dato')
      .filter({ has: page.locator('dt', { hasText: /^Kilos$/ }) })
      .locator('dd');
    await expect(kilos).toContainText('4,75 kg');

    // Precios tiene el costo, y la agenda el pago.
    await page.goto('/precios');
    await expect(page.getByText('Todavía no hay costos cargados')).toHaveCount(0);
    await expect(page.getByText('Queso Sardo bloque Melincué').first()).toBeVisible();

    await page.goto('/pagos?grupo=proximos');
    await expect(page.getByText('00008-00002647').first()).toBeVisible();
  });
});

test.describe('lo que queda usable después de validar la factura real', () => {
  test.afterAll(async () => {
    await limpiarComprobantesLeidos();
  });

  /*
   * La prueba que faltaba.
   *
   * Hasta acá se verificaba que el comprobante quedara VALIDADO. Eso no es lo
   * mismo que verificar que el resto de la aplicación pueda usarlo: la factura
   * se validó, quedó bien, se pagó, y Compras daba cero kilos, Precios decía
   * que no había ningún costo cargado y el calendario de agosto mostraba cero.
   *
   * Compras, Precios y Pagos leen tres estructuras distintas, pero las tres
   * salen del mismo momento: la confirmación. Por eso se prueban juntas y de
   * una sola pasada, sin ningún mantenimiento por el medio: si hiciera falta
   * pasar por Asociaciones históricas para que los números aparezcan, la
   * confirmación no habría hecho su trabajo.
   */
  test('de la foto a Compras, Precios y Pagos sin ningún arreglo por el medio', async ({
    page,
  }, testInfo) => {
    soloEnIphone(test, testInfo.project.name);

    await ingresar(page, 'admin');
    await page.goto('/nueva-compra');
    await leer(page, await fotoErrecalde());

    // --- Revisión: se asocia a mano lo que no se reconoció solo -----------
    const tomate = page.locator('.lista > li').filter({ hasText: 'código ART-01477' });
    const elegirPlu = tomate.locator('select[id^="prod-"]');
    await expect(elegirPlu).toBeVisible();
    await elegirOpcion(page, `#${await elegirPlu.getAttribute('id')}`, 'Tomate en botella');

    /*
     * El queso ya viene asociado, por el código que el proveedor imprime. Son
     * las dos maneras de llegar a lo mismo —la que reconoce la aplicación y la
     * que elige una persona— y las dos tienen que dejar lo mismo del otro lado.
     */
    const sardo = page.locator('.lista > li').filter({ hasText: 'código ART-00758' }).first();
    await expect(sardo.locator('select[id^="prod-"]')).not.toHaveValue('');

    // --- Guardar y agendar ------------------------------------------------
    await page.getByRole('button', { name: 'Continuar al pago' }).click();
    await expect(page.getByRole('heading', { name: 'Guardar y agendar el pago' })).toBeVisible();
    await page.getByRole('button', { name: 'Guardar y agendar el pago' }).click();

    await expect(page.getByText('El comprobante se guardó y el pago quedó agendado.')).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.locator('.estado-ok', { hasText: 'Confirmado' }).first()).toBeVisible();

    /*
     * Y acá está el punto: a partir de este momento no se toca nada más. No se
     * pasa por Asociaciones históricas, no se repara nada, no se vuelve a
     * confirmar. Lo que sigue tiene que estar por haber validado, y por nada
     * más.
     */
    await expect(
      page.getByRole('button', { name: 'Reparar derivados del comprobante' }),
      'el comprobante recién validado quedó incompleto',
    ).toHaveCount(0);

    // --- Compras ----------------------------------------------------------
    await page.goto('/compras');
    const totales = page.locator('.card', { hasText: 'Totales del período' });
    const total = (etiqueta: string) =>
      totales
        .locator('.dato')
        .filter({ has: page.locator('dt', { hasText: new RegExp(`^${etiqueta}$`) }) })
        .locator('dd');

    /*
     * Acotado a este proveedor: la base de pruebas tiene otras compras, y lo
     * que se está comprobando es que **esta** factura llegó entera.
     */
    await elegirOpcion(page, '#proveedor', 'Distribución Errecalde');
    await page.getByRole('button', { name: 'Filtrar' }).click();

    // Los 23 renglones de la factura, con su costo real.
    await expect(total('Costo total')).toContainText('4.816.812,73');
    await expect(total('Kilos')).toContainText('480,34');
    await expect(total('Unidades')).toContainText('71');
    await expect(page.locator('table tbody tr')).toHaveCount(23);

    // Y por artículo: el queso reconocido solo tiene sus kilos, no cero.
    await elegirOpcion(page, '#producto', 'Queso Sardo bloque Melincué');
    await page.getByRole('button', { name: 'Filtrar' }).click();
    await expect(total('Kilos')).toContainText('4,75 kg');
    await expect(page.locator('table tbody tr')).toHaveCount(1);

    // Y el que se eligió a mano, también.
    await elegirOpcion(page, '#producto', 'Tomate en botella');
    await page.getByRole('button', { name: 'Filtrar' }).click();
    await expect(total('Unidades')).toContainText('32');

    // --- Precios ----------------------------------------------------------
    await page.goto('/precios');
    await expect(page.getByText('Todavía no hay costos cargados')).toHaveCount(0);
    // Los dos artículos de la factura, el reconocido y el elegido a mano.
    await expect(page.getByText('Queso Sardo bloque Melincué').first()).toBeVisible();
    await expect(page.getByText('Tomate en botella').first()).toBeVisible();

    // --- Pagos ------------------------------------------------------------
    /*
     * En "Próximos" y no en la pestaña por omisión: la condición cargada para
     * este proveedor es a 30 días, así que la factura del 22/08 vence más
     * adelante. Lo que se comprueba acá es que el pago exista y por cuánto; en
     * qué fecha cae depende de la condición del proveedor, que es otra cosa y
     * se corrige desde Pagos sin tocar la compra.
     */
    await page.goto('/pagos?grupo=proximos');
    await expect(page.getByText('00008-00002647').first()).toBeVisible();
    await expect(page.getByText('$ 4.816.812,73').first()).toBeVisible();

    await sinScrollHorizontal(page);
  });
});
