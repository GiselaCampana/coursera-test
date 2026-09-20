import { test, expect, type Page } from '@playwright/test';
import { ingresar, sinScrollHorizontal, tamanoTactil } from './ayudas';

/**
 * La vista previa de la compra, abierta como la abre una persona.
 *
 * Lo que se comprueba acá no es el cálculo —de eso se ocupan las pruebas de
 * integración— sino que la pantalla exista, se llegue desde el comprobante y
 * muestre separadas las dos cosas que se van a escribir: el egreso que se paga
 * y la mercadería que entra.
 *
 * Se mira la compra de Ezra, que es la que tiene los seis renglones del papel,
 * en sus dos versiones: la que se puede aplicar y la que está frenada porque
 * un renglón no se pudo asociar. Sin las dos no se ve lo único que importa de
 * esta pantalla, que es la diferencia entre poder y no poder.
 *
 * Y se mira en el teléfono, porque es donde se usa: una tabla de seis renglones
 * y cuatro importes en 390 píxeles de ancho es exactamente donde una pantalla
 * se rompe.
 */
const MINUTOS = 60_000;
test.describe.configure({ timeout: 4 * MINUTOS });

/** La factura completa: seis renglones asociados, total impreso. */
const COMPLETA = '00000185';
/** La frenada: la bolsa sin código legible y el total sin imprimir. */
const FRENADA = '00000186';

/**
 * Abre el comprobante desde el listado y de ahí la vista previa.
 *
 * Se entra por donde entra una persona —el listado, el comprobante, el
 * enlace— y no por la URL directa: el enlace es parte de lo que hay que
 * comprobar que existe.
 */
async function abrirLaVistaPrevia(page: Page, numero: string) {
  await page.goto('/comprobantes');
  await page.locator('a.fila-dato', { hasText: numero }).first().click();
  await expect(page).toHaveURL(/\/comprobantes\/[^/]+$/);

  await page.getByRole('link', { name: /Ver la vista previa de la compra/ }).click();
  await expect(page).toHaveURL(/\/vista-previa$/);
  await expect(page.getByRole('heading', { name: 'Vista previa de la compra' })).toBeVisible();
}

test.describe('la vista previa de la compra', () => {
  test('se abre desde el comprobante y separa el egreso del stock', async ({ page }) => {
    await ingresar(page, 'admin');
    await abrirLaVistaPrevia(page, COMPLETA);

    await expect(page.getByText('Nada de lo que se ve acá está guardado')).toBeVisible();

    // Las dos escrituras, cada una en su recuadro.
    await expect(page.getByRole('heading', { name: 'Egreso' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Movimiento de stock' })).toBeVisible();

    // Y el emisor, los renglones y el pie.
    await expect(page.getByRole('heading', { name: 'Emisor' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Renglones' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Pie fiscal' })).toBeVisible();
  });

  test('la factura de Ezra muestra sus seis renglones y el egreso impreso', async ({ page }) => {
    await ingresar(page, 'admin');
    await abrirLaVistaPrevia(page, COMPLETA);

    await expect(page.getByText('Distribuidora Ezra').first()).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(6);

    /*
     * El sexto renglón: tres bolsas que Ezra cobra para transportar la compra.
     * Se pagan con la factura y no entran al stock, así que tienen que verse
     * —en unidades, no en kilos— y verse APARTE de la mercadería.
     */
    // En la tabla: el renglón está, en unidades, y dicho que no mueve stock.
    const renglonDeLaBolsa = page.locator('tbody tr', { hasText: 'BOLSA GRANDE' });
    await expect(renglonDeLaBolsa).toHaveCount(1);
    await expect(renglonDeLaBolsa).toContainText('3,000 unidades');
    await expect(renglonDeLaBolsa).toContainText('sin impacto en stock');

    // Y en el recuadro del stock, en su propia lista y no entre la mercadería.
    const recuadroDeStock = page.locator('section.card', { hasText: 'Movimiento de stock' }).last();
    await expect(
      recuadroDeStock.getByRole('heading', { name: 'Sin impacto en stock' }),
    ).toBeVisible();
    const gastos = recuadroDeStock.locator('ul.lista-simple').last();
    await expect(gastos.locator('li')).toHaveCount(1);
    await expect(gastos).toContainText('3,000 unidades');
    await expect(gastos).toContainText('Bolsas del transporte');

    // La mercadería son cinco, no seis: la bolsa no entra a la heladera.
    await expect(recuadroDeStock.locator('ul.lista-simple').first().locator('li')).toHaveCount(5);

    // El egreso, por el total que dice el papel.
    await expect(page.getByText('$ 267.880,50').first()).toBeVisible();

    // Y la condición, que Ezra no tiene configurada.
    await expect(page.getByText('a definir al aplicar').first()).toBeVisible();

    /*
     * Y por eso no se puede aplicar todavía: hay que elegir cómo se paga.
     * Antes el botón estaba habilitado y al apretarlo la compra se agendaba
     * sola, con el vencimiento en la fecha de emisión y «Transferencia».
     */
    await expect(page.getByRole('heading', { name: 'Cómo se paga' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Aplicar la compra' })).toBeDisabled();
  });

  test('hay que elegir cómo se paga, y nada viene marcado', async ({ page }) => {
    await ingresar(page, 'admin');
    await abrirLaVistaPrevia(page, COMPLETA);

    const forma = page.getByLabel('Forma de pago');
    const condicion = page.getByLabel('Condición');
    const boton = page.getByRole('button', { name: 'Aplicar la compra' });

    // Nada preseleccionado: ni la forma ni la condición.
    await expect(forma).toHaveValue('');
    await expect(condicion).toHaveValue('');
    await expect(boton).toBeDisabled();

    // Con la forma sola tampoco alcanza.
    await forma.selectOption('EFECTIVO');
    await expect(boton).toBeDisabled();

    // Y a los días hay que decirle cuántos.
    await condicion.selectOption('DIAS');
    await expect(boton).toBeDisabled();
    await page.getByLabel('Días').fill('30');
    await expect(boton).toBeEnabled();

    /*
     * Y dice qué día cae, antes de aplicar. La factura se emitió el 09/09/2026,
     * así que a 30 días vence el 09/10/2026. Sin este eco se elige el plazo a
     * ciegas: lo que después se mira en Pagos es la fecha, no el plazo.
     */
    const calculado = page.locator('[data-prueba="vencimiento-calculado"]');
    await expect(calculado).toContainText('09/10/2026');

    // Una fecha anterior a la emisión se rechaza en la pantalla, no recién al
    // aplicar, y con la misma cuenta que usa el servidor.
    await condicion.selectOption('FECHA');
    await page.getByLabel('Fecha de vencimiento').fill('2026-09-08');
    await expect(page.getByText(/no puede ser anterior a la emisión/)).toBeVisible();
    await expect(boton).toBeDisabled();
  });

  test('la llamada directa al POST también se rechaza', async ({ page }) => {
    /*
     * Que la pantalla frene no alcanza: el endpoint se puede llamar solo. Sin
     * decisión de pago tiene que contestar un error y no escribir nada.
     */
    await ingresar(page, 'admin');
    await page.goto('/comprobantes');
    await page.locator('a.fila-dato', { hasText: COMPLETA }).first().click();
    await expect(page).toHaveURL(/\/comprobantes\/[^/]+$/);
    const id = page.url().split('/').pop();

    /*
     * Se llama desde adentro de la página para que viaje la sesión: es el
     * escenario que importa, alguien con sesión válida saltándose la pantalla.
     */
    const respuesta = await page.evaluate(async (documentId) => {
      const r = await fetch(`/api/comprobantes/${documentId}/vista-previa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      return { ok: r.ok, estado: r.status, cuerpo: await r.text() };
    }, id);

    expect(respuesta.ok).toBe(false);
    expect(respuesta.cuerpo).toMatch(/condición de pago|forma de pago/i);

    // Y el comprobante sigue sin validar: la pantalla lo diría.
    await page.reload();
    await expect(page.getByRole('link', { name: /Ver la vista previa de la compra/ })).toBeVisible();
  });

  test('la factura frenada dice por qué, y no deja aplicar', async ({ page }) => {
    await ingresar(page, 'admin');
    await abrirLaVistaPrevia(page, FRENADA);

    await expect(page.getByText('Todavía no se puede aplicar:')).toBeVisible();
    await expect(page.getByText(/BOLSA GRANDE.*no está asociado/)).toBeVisible();
    await expect(page.getByText(/El total no está impreso/)).toBeVisible();

    // El renglón no desapareció por no poder asociarse.
    await expect(page.locator('tbody tr')).toHaveCount(6);

    await expect(page.getByRole('button', { name: 'Aplicar la compra' })).toBeDisabled();
  });

  /* ----------------------------------------------------------------------- */

  test('entra en la pantalla del teléfono, con la tabla desplazable', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone', 'Es la comprobación del teléfono.');
    await ingresar(page, 'admin');
    await abrirLaVistaPrevia(page, COMPLETA);

    // Nada se desborda a lo ancho: es el defecto que arruina una pantalla en
    // el teléfono, porque empuja todo el cuerpo y aparece el scroll lateral.
    await sinScrollHorizontal(page);

    /*
     * La tabla de renglones no cabe en 390 píxeles y no tiene por qué caber:
     * lo que tiene que pasar es que se desplace **ella**, dentro de su caja, en
     * vez de estirar la página. Se comprueba que el contenido es más ancho que
     * la caja y que la caja está preparada para desplazarlo.
     */
    const tabla = page.locator('.tabla-scroll').first();
    const desplazable = await tabla.evaluate((caja) => ({
      contenido: caja.scrollWidth,
      visible: caja.clientWidth,
      overflow: getComputedStyle(caja).overflowX,
    }));
    expect(desplazable.contenido).toBeGreaterThan(desplazable.visible);
    expect(['auto', 'scroll']).toContain(desplazable.overflow);

    // El egreso y la mercadería quedan usables: los dos visibles y enteros.
    for (const titulo of ['Egreso', 'Movimiento de stock']) {
      const seccion = page.locator('section.card', { hasText: titulo }).last();
      await expect(seccion).toBeVisible();
      const caja = await seccion.boundingBox();
      expect(caja!.width).toBeLessThanOrEqual(testInfo.project.use.viewport!.width);
    }

    // El gasto sin impacto en stock también se lee entero en la pantalla angosta.
    const gastos = page
      .locator('section.card', { hasText: 'Movimiento de stock' })
      .last()
      .locator('ul.lista-simple')
      .last();
    await expect(gastos.getByText('3,000 unidades')).toBeVisible();
    const cortado = await gastos
      .locator('li')
      .first()
      .evaluate((li) => li.scrollWidth > li.clientWidth + 1);
    expect(cortado).toBe(false);

    // El formulario de cómo se paga entra en la pantalla angosta y es usable.
    await expect(page.getByRole('heading', { name: 'Cómo se paga' })).toBeVisible();
    await expect(page.getByLabel('Forma de pago')).toHaveValue('');
    await tamanoTactil(page, 'select#forma-de-pago');

    // Y el botón se puede tocar con el pulgar.
    await expect(page.getByRole('button', { name: 'Aplicar la compra' })).toBeVisible();
    await tamanoTactil(page, 'button.boton');
  });

  test('en el teléfono los frenos se leen enteros y el botón queda bloqueado', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone', 'Es la comprobación del teléfono.');
    await ingresar(page, 'admin');
    await abrirLaVistaPrevia(page, FRENADA);

    await sinScrollHorizontal(page);

    /*
     * Los frenos son texto largo en una pantalla angosta: lo que hay que
     * comprobar es que se vean completos, envueltos, y no cortados por el
     * costado. Un freno que se lee a medias no explica nada.
     */
    const frenos = page.locator('.mensaje-aviso .lista-simple li');
    // Tres: la bolsa sin asociar, el total sin imprimir y cómo se paga.
    await expect(frenos).toHaveCount(3);
    for (const freno of await frenos.all()) {
      await expect(freno).toBeVisible();
      const cortado = await freno.evaluate((li) => li.scrollWidth > li.clientWidth + 1);
      expect(cortado).toBe(false);
    }

    const boton = page.getByRole('button', { name: 'Aplicar la compra' });
    await expect(boton).toBeVisible();
    await expect(boton).toBeDisabled();
  });
});
