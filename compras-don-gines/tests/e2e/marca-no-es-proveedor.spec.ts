import { test, expect, type Page } from '@playwright/test';
import { ingresar, soloEnIphone } from './ayudas';
import { cargarEntornoE2E, limpiarComprobantesLeidos } from './entorno';
import { facturaLosCalvosJpeg, PROVEEDOR_DESCONOCIDO, type Renglon } from './factura-imagen';

/**
 * La marca de un artículo no es quien emite la factura.
 *
 * Esto es lo que trajo la factura de Distribuidora Ezra al proyecto: en su
 * renglón 10 la marca es «LOS CALVOS», y con eso el analizador de Los Calvos se
 * quedaba con el comprobante. La factura quedaba atribuida al proveedor
 * equivocado, con su plazo de pago, sus tasas y su cuenta corriente, y la
 * pantalla nunca llegaba a decir que el proveedor era otro.
 *
 * Las unidades y la integración lo prueban sobre el texto real de la foto. Acá
 * se prueba el mismo caso **por el navegador y de punta a punta**: se fabrica la
 * imagen de una factura de un proveedor que la base no tiene, con la marca de
 * otro proveedor escrita en las descripciones, se la lee con Tesseract adentro
 * del navegador y se mira a quién se la atribuye la pantalla.
 */

const MINUTOS = 60_000;
test.describe.configure({ timeout: 6 * MINUTOS });

/** Los renglones, con la marca de otro proveedor pegada a la descripción. */
const CON_MARCA_AJENA: Renglon[] = [
  { codigo: '1001', descripcion: 'JAMON COCIDO MINI LOS CALVOS', kg: '16,10', precio: '16.037,00', bonificacion: '14,00', importe: '258.195,70' },
  { codigo: '1002', descripcion: 'SALAME CRESPON LOS CALVOS', kg: '3,40', precio: '14.256,00', bonificacion: '14,00', importe: '48.470,40' },
  { codigo: '1003', descripcion: 'SALAME MILAN LA PAULINA', kg: '10,90', precio: '14.256,00', bonificacion: '14,00', importe: '155.390,40' },
];

/** Sube la foto y espera a que termine la lectura. */
async function leer(page: Page, imagen: Buffer) {
  const galeria = page.locator('input[type="file"]').nth(1);
  await galeria.setInputFiles([
    { name: 'factura-ajena.jpg', mimeType: 'image/jpeg', buffer: imagen },
  ]);
  await expect(page.locator('.miniatura')).toHaveCount(1);

  await page.getByRole('button', { name: 'Leer el comprobante' }).click();
  await expect(page.getByRole('heading', { name: 'Revisar los datos' })).toBeVisible({
    timeout: 5 * MINUTOS,
  });
}

test.describe('la marca de un artículo no es el proveedor', () => {
  test.afterAll(async () => {
    cargarEntornoE2E();
    await limpiarComprobantesLeidos();
  });

  test('una factura ajena que nombra a Los Calvos en la tabla no se le atribuye', async ({
    page,
  }, testInfo) => {
    // Una sola pasada: leer una factura de verdad son minutos de Tesseract, y
    // lo que se mide acá no cambia entre el teléfono y el escritorio.
    soloEnIphone(test, testInfo.project.name);

    await ingresar(page, 'admin');
    await page.goto('/nueva-compra');

    await leer(
      page,
      await facturaLosCalvosJpeg({
        numero: '00931001',
        emisor: PROVEEDOR_DESCONOCIDO,
        renglones: CON_MARCA_AJENA,
      }),
    );

    /*
     * Lo que se afirma: el proveedor **elegido** no es Los Calvos.
     *
     * Se mira el valor del selector y no el texto de la página, que es el error
     * que tenía este caso antes: «LOS CALVOS» aparece igual en las
     * descripciones de los renglones, así que buscarlo en el texto no distingue
     * la marca del emisor —que es exactamente lo que hay que distinguir— y la
     * prueba pasaba con el reconocedor roto.
     *
     * No se afirma que el elegido sea «Fiambres del Oeste»: eso depende de que
     * el OCR lea bien el membrete, que es otra cosa y se prueba en
     * `proveedor-nuevo`. Lo que no puede pasar es que una marca escrita en la
     * tabla decida de quién es la factura.
     */
    const seleccionado = await page
      .locator('#proveedor')
      .evaluate((s) => (s as HTMLSelectElement).selectedOptions[0]?.text ?? '');
    expect(seleccionado).not.toMatch(/Los Calvos/i);

    // Y el aviso de proveedor nuevo tiene que estar: el emisor no está cargado.
    await expect(
      page.locator('.card', { hasText: 'Proveedor nuevo' }).getByRole('heading'),
    ).toBeVisible();
  });
});
