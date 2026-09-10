import { test, expect } from '@playwright/test';
import { ingresar } from './ayudas';
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
 * se prueba el mismo caso **por el navegador**: se fabrica la imagen de una
 * factura de un proveedor que la base no tiene, con la marca de otro proveedor
 * escrita en las descripciones, se la lee con Tesseract adentro del navegador y
 * se mira a quién se la atribuye la pantalla.
 */

/** Los renglones, con la marca de otro proveedor pegada a la descripción. */
const CON_MARCA_AJENA: Renglon[] = [
  { codigo: '1001', descripcion: 'JAMON COCIDO MINI LOS CALVOS', kg: '16,10', precio: '16.037,00', bonificacion: '14,00', importe: '258.195,70' },
  { codigo: '1002', descripcion: 'SALAME CRESPON LOS CALVOS', kg: '3,40', precio: '14.256,00', bonificacion: '14,00', importe: '48.470,40' },
  { codigo: '1003', descripcion: 'SALAME MILAN LA PAULINA', kg: '10,90', precio: '14.256,00', bonificacion: '14,00', importe: '155.390,40' },
];

test.describe('la marca de un artículo no es el proveedor', () => {
  test.beforeEach(async () => {
    cargarEntornoE2E();
    await limpiarComprobantesLeidos();
  });

  test('una factura ajena que nombra a Los Calvos en la tabla no se le atribuye', async ({
    page,
  }) => {
    await ingresar(page, 'admin');

    const imagen = await facturaLosCalvosJpeg({
      numero: '00931001',
      emisor: PROVEEDOR_DESCONOCIDO,
      renglones: CON_MARCA_AJENA,
    });

    await page.goto('/comprobantes/nuevo');
    await page.setInputFiles('input[type="file"]', {
      name: 'factura.jpg',
      mimeType: 'image/jpeg',
      buffer: imagen,
    });

    await page.getByRole('button', { name: /Leer|Procesar/i }).click();
    // La lectura corre entera en el teléfono y tarda.
    await expect(page.getByText(/Revisar|Artículos/i).first()).toBeVisible({ timeout: 240_000 });

    /*
     * Lo que se afirma: el proveedor propuesto no es Los Calvos.
     *
     * No se afirma que sea «Fiambres del Oeste» —eso depende de que el OCR lea
     * bien el membrete, que es otra cosa y ya se prueba aparte—. Lo que no
     * puede pasar, y es lo que este caso vigila, es que una marca escrita en la
     * tabla decida de quién es la factura.
     */
    const cuerpo = await page.locator('body').innerText();
    expect(cuerpo).not.toMatch(/Proveedor[^\n]*Los Calvos/i);

    // Y en la base, el comprobante leído no puede haber quedado con ese
    // proveedor.
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    try {
      const losCalvos = await prisma.supplier.findFirst({
        where: { tradeName: { contains: 'Calvos', mode: 'insensitive' } },
      });
      const atribuidos = await prisma.document.count({
        where: { supplierId: losCalvos?.id, fullNumber: { contains: '00931001' } },
      });
      expect(atribuidos).toBe(0);
    } finally {
      await prisma.$disconnect();
    }
  });
});
