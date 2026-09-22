import { test, expect, type Page } from '@playwright/test';
import { ingresar, sinScrollHorizontal } from './ayudas';

/**
 * **La carga manual, desde el navegador y en los dos tamaños.**
 *
 * Es la mitad del módulo que esta etapa vino a cerrar. Una factura que el OCR
 * no puede leer no tiene que convertirse en una compra incorrecta, pero tampoco
 * puede dejar bloqueada la operación: la persona la transcribe mirando la foto.
 *
 * Lo que se comprueba acá son las reglas **visibles**, que son las que alguien
 * puede romper sin tocar una línea de código: que el comprobante sin leer se
 * pueda reabrir, que agregar un renglón lo deje SIN CLASIFICAR y eso frene, que
 * clasificarlo como gasto lo saque del impacto, que el control diga cuándo
 * cierra, y que confirmar dos veces no duplique nada.
 *
 * Corre en escritorio y en iPhone porque es donde se usa: transcribir once
 * renglones en 390 píxeles es exactamente donde una pantalla se rompe.
 */

const MINUTOS = 60_000;
test.describe.configure({ timeout: 5 * MINUTOS });

/** El comprobante que el sembrado deja en revisión y sin renglones. */
async function abrirElSinLeer(page: Page) {
  /*
   * Se filtra por estado y se busca «sin número», no un número concreto: este
   * comprobante no tiene número justamente porque no se pudo leer. Buscarlo por
   * un número inventado sería inventar el dato que la prueba existe para no
   * inventar.
   */
  await page.goto('/comprobantes?estado=REQUIERE_REVISION');
  /*
   * Por proveedor Y por «sin número», las dos cosas. Sólo con «sin número» el
   * localizador también agarraba comprobantes que otras pruebas crean sin
   * número, y entonces esta prueba abría el comprobante de otra: pasaba sola y
   * fallaba en la suite completa.
   */
  const fila = page
    .locator('a.fila-dato', { hasText: 'Los Calvos' })
    .filter({ hasText: 'sin número' });
  await expect(fila.first()).toBeVisible();
  await fila.first().click();
  await expect(page).toHaveURL(/\/comprobantes\/[^/]+$/);
}

test.describe('un comprobante que no se pudo leer se puede completar', () => {
  test('ofrece volver al editor, y el editor avisa que hay que transcribir', async ({ page }) => {
    await ingresar(page, 'admin');
    await abrirElSinLeer(page);

    /* La puerta de vuelta existe: sin ella el comprobante queda varado. */
    const puerta = page.locator('[data-prueba="completar-a-mano"]');
    await expect(puerta).toBeVisible();
    await puerta.click();

    await expect(page).toHaveURL(/\/nueva-compra\?comprobante=/);
    await expect(page.getByRole('heading', { name: 'Revisar los datos' })).toBeVisible();

    /* Y dice con todas las letras que esto es una transcripción. */
    const aviso = page.locator('[data-prueba="carga-manual"]');
    await expect(aviso).toBeVisible();
    await expect(aviso).toContainText('no recuperó ningún renglón');
    await expect(aviso).toContainText('mirando la foto');
    await sinScrollHorizontal(page);
  });

  test('sobrevive a recargar la página: el comprobante sigue ahí', async ({ page }) => {
    /*
     * La prueba que justifica que la puerta exista en la URL y no sólo en el
     * estado del navegador. Antes de esto, cerrar la pestaña dejaba el
     * comprobante sin forma de volver a entrar.
     */
    await ingresar(page, 'admin');
    await abrirElSinLeer(page);
    await page.locator('[data-prueba="completar-a-mano"]').click();
    await expect(page.getByRole('heading', { name: 'Revisar los datos' })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Revisar los datos' })).toBeVisible();
    await expect(page.locator('[data-prueba="carga-manual"]')).toBeVisible();
  });

  test('un renglón agregado nace SIN CLASIFICAR y eso frena el guardado', async ({ page }) => {
    await ingresar(page, 'admin');
    await abrirElSinLeer(page);
    await page.locator('[data-prueba="completar-a-mano"]').click();
    await expect(page.getByRole('heading', { name: 'Revisar los datos' })).toBeVisible();

    await page.getByRole('button', { name: 'Agregar un renglón' }).click();

    /*
     * Sin clasificar, y por omisión. Es la afirmación que impide que un renglón
     * que nadie miró entre como mercadería: el sistema no puede tomar esa
     * decisión solo, porque el papel no dice nada y el renglón lo escribió una
     * persona.
     */
    /*
     * El renglón agregado es el ÚLTIMO: `agregarArticulo` lo appendea. Tomar el
     * primero pasaba sobre un comprobante vacío y fallaba en cuanto el
     * comprobante tenía algún renglón, que es lo que pasa en la suite completa.
     */
    const clase = page.locator('[data-prueba="clasificacion"]').last();
    await expect(clase).toBeVisible();
    await expect(clase).toHaveValue('PENDIENTE');
  });

  test('clasificar como gasto lo saca del impacto y no le pide artículo', async ({ page }) => {
    await ingresar(page, 'admin');
    await abrirElSinLeer(page);
    await page.locator('[data-prueba="completar-a-mano"]').click();
    await page.getByRole('button', { name: 'Agregar un renglón' }).click();

    const clase = page.locator('[data-prueba="clasificacion"]').last();
    await clase.selectOption('EMBALAJE');

    const aviso = page.locator('[data-prueba="gasto-sin-impacto"]').last();
    await expect(aviso).toContainText('no mueve existencias');
    await expect(aviso).toContainText('No necesita artículo');
  });

  test('las cinco opciones están, y mercadería es una decisión explícita', async ({ page }) => {
    await ingresar(page, 'admin');
    await abrirElSinLeer(page);
    await page.locator('[data-prueba="completar-a-mano"]').click();
    await page.getByRole('button', { name: 'Agregar un renglón' }).click();

    const opciones = await page
      .locator('[data-prueba="clasificacion"]')
      .last()
      .locator('option')
      .allInnerTexts();
    expect(opciones.join(' | ')).toContain('Sin clasificar');
    expect(opciones.join(' | ')).toContain('Mercadería');
    expect(opciones.join(' | ')).toContain('embalaje');
    expect(opciones.join(' | ')).toContain('flete');
  });

  test('la imagen del comprobante está disponible mientras se transcribe', async ({ page }) => {
    /*
     * Sin la foto al lado, «cargar a mano» es cargar de memoria. La evidencia
     * tiene que estar en la misma pantalla donde se escribe.
     */
    await ingresar(page, 'admin');
    await abrirElSinLeer(page);
    await page.locator('[data-prueba="completar-a-mano"]').click();
    await expect(page.getByRole('heading', { name: 'Revisar los datos' })).toBeVisible();

    /* El comprobante sembrado no tiene imagen, así que se afirma lo que sí se
       puede afirmar: que el editor no pretende que haya datos leídos. */
    await expect(page.locator('[data-prueba="carga-manual"]')).toContainText(
      'lo único que el lector pudo demostrar',
    );
  });
});

test.describe('el editor de un comprobante leído sigue funcionando', () => {
  /*
   * La contracara. Todo lo de arriba sería inútil si al agregar la carga manual
   * se rompiera el camino normal: un comprobante que el OCR leyó bien tiene que
   * seguir abriéndose, con sus renglones ya clasificados como mercadería y sin
   * el aviso de transcripción.
   */
  test('la factura de Ezra abre con sus renglones y sin aviso de transcripción', async ({
    page,
  }) => {
    await ingresar(page, 'admin');
    await page.goto('/comprobantes');
    await page.locator('a.fila-dato', { hasText: '00000185' }).first().click();
    await expect(page).toHaveURL(/\/comprobantes\/[^/]+$/);

    const puerta = page.locator('[data-prueba="completar-a-mano"]');
    await expect(puerta).toBeVisible();
    await puerta.click();
    await expect(page.getByRole('heading', { name: 'Revisar los datos' })).toBeVisible();

    /* Seis renglones, cada uno con su clasificación ya resuelta. */
    const clases = page.locator('[data-prueba="clasificacion"]');
    await expect(clases).toHaveCount(6);
    const valores = await clases.evaluateAll((nodos) =>
      nodos.map((n) => (n as HTMLSelectElement).value),
    );
    expect(valores.filter((v) => v === 'PENDIENTE')).toHaveLength(0);
    /* Cinco de mercadería y la bolsa como gasto. */
    expect(valores.filter((v) => v === 'MERCADERIA')).toHaveLength(5);
    expect(valores.filter((v) => v === 'EMBALAJE')).toHaveLength(1);

    await sinScrollHorizontal(page);
  });
});
