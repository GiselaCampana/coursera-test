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

    // El sexto renglón es el que no se factura por kilo.
    await expect(page.getByText('BOLSA GRANDE').first()).toBeVisible();
    await expect(page.getByText('3,000 unidades')).toBeVisible();

    // El egreso, por el total que dice el papel.
    await expect(page.getByText('$ 267.880,50').first()).toBeVisible();

    // Y la condición, que Ezra no tiene configurada.
    await expect(page.getByText('a definir al aplicar').first()).toBeVisible();

    await expect(page.getByRole('button', { name: 'Aplicar la compra' })).toBeEnabled();
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
    await expect(frenos).toHaveCount(2);
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
