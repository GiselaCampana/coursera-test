import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { ingresar, sinScrollHorizontal, tamanoTactil } from './ayudas';
import { facturaLosCalvosJpeg } from './factura-imagen';

/** Reconocer una página con Tesseract lleva su tiempo: el margen es amplio. */
test.describe.configure({ timeout: 300_000 });

/** Una "foto" de comprobante, con peso parecido al de una del iPhone. */
async function foto(semilla: number, ancho = 2400, alto = 1800): Promise<Buffer> {
  const pixeles = Buffer.alloc(ancho * alto * 3);
  for (let i = 0; i < pixeles.length; i++) pixeles[i] = (i * (semilla + 7)) % 256;
  return sharp(pixeles, { raw: { width: ancho, height: alto, channels: 3 } })
    .jpeg({ quality: 92 })
    .toBuffer();
}

test.describe('nueva compra desde el teléfono', () => {
  test.beforeEach(async ({ page }) => {
    await ingresar(page, 'operador');
    await page.goto('/nueva-compra');
  });

  test('ofrece sacar foto y elegir del teléfono como dos opciones separadas', async ({ page }) => {
    const sacarFoto = page.getByRole('button', { name: 'Sacar foto' });
    const elegir = page.getByRole('button', { name: 'Elegir del teléfono' });

    await expect(sacarFoto).toBeVisible();
    await expect(elegir).toBeVisible();
    await tamanoTactil(page, 'button:has-text("Sacar foto")');
    await tamanoTactil(page, 'button:has-text("Elegir del teléfono")');

    // El de la cámara pide la trasera; el otro abre la galería y acepta varias.
    const inputs = page.locator('input[type="file"]');
    await expect(inputs).toHaveCount(2);

    const camara = inputs.nth(0);
    await expect(camara).toHaveAttribute('capture', 'environment');
    await expect(camara).toHaveAttribute('accept', /image/);

    const galeria = inputs.nth(1);
    await expect(galeria).not.toHaveAttribute('capture', /.*/);
    await expect(galeria).toHaveAttribute('multiple', '');
    // Extensiones además de los tipos MIME: Safari en iPhone las necesita.
    const accept = await galeria.getAttribute('accept');
    expect(accept).toContain('image/heic');
    expect(accept).toContain('.heic');
    expect(accept).toContain('application/pdf');
  });

  test('agrega páginas, las numera, las reordena y las quita', async ({ page }) => {
    const galeria = page.locator('input[type="file"]').nth(1);
    await galeria.setInputFiles([
      { name: 'pagina1.jpg', mimeType: 'image/jpeg', buffer: await foto(1) },
      { name: 'pagina2.jpg', mimeType: 'image/jpeg', buffer: await foto(2) },
      { name: 'pagina3.jpg', mimeType: 'image/jpeg', buffer: await foto(3) },
    ]);

    const miniaturas = page.locator('.miniatura');
    await expect(miniaturas).toHaveCount(3);
    await expect(page.getByText('3 de 10 páginas')).toBeVisible();

    // Reordenar: la tercera pasa al segundo lugar.
    await page.getByRole('button', { name: 'Mover la página 3 hacia atrás' }).click();
    await expect(miniaturas).toHaveCount(3);

    // Quitar una.
    await page.getByRole('button', { name: 'Quitar la página 1' }).click();
    await expect(miniaturas).toHaveCount(2);
    await expect(page.getByText('2 de 10 páginas')).toBeVisible();

    await sinScrollHorizontal(page);
  });

  test('no agrega dos veces la misma foto', async ({ page }) => {
    const galeria = page.locator('input[type="file"]').nth(1);
    const imagen = await foto(9);

    await galeria.setInputFiles([{ name: 'factura.jpg', mimeType: 'image/jpeg', buffer: imagen }]);
    await expect(page.locator('.miniatura')).toHaveCount(1);

    // La misma foto otra vez, incluso con otro nombre.
    await galeria.setInputFiles([{ name: 'otra.jpg', mimeType: 'image/jpeg', buffer: imagen }]);
    await expect(page.locator('.miniatura')).toHaveCount(1);
    await expect(page.getByText(/ya estaba agregada/)).toBeVisible();
  });

  test('optimiza sola una foto pesada sin pedir que la elijan de nuevo', async ({ page }) => {
    const grande = await foto(4, 4032, 3024);
    expect(grande.length).toBeGreaterThan(2 * 1024 * 1024);

    const galeria = page.locator('input[type="file"]').nth(1);
    await galeria.setInputFiles([
      { name: 'IMG_5522.JPG', mimeType: 'image/jpeg', buffer: grande },
    ]);

    await expect(page.locator('.miniatura')).toHaveCount(1);
    await expect(page.getByText(/se optimizó de/)).toBeVisible();
    // Y nunca le pide al usuario que vuelva a elegir la foto.
    await expect(page.getByText(/eleg[ií] otra foto|volv[ée] a seleccionar/i)).toHaveCount(0);
  });

  test('cuando la lectura no cierra, avisa en castellano y bloquea el guardado', async ({
    page,
  }) => {
    // El comprobante se lee bien, pero el total impreso no coincide con el
    // detalle: es el caso que tiene que quedar en rojo y con el guardado
    // bloqueado. Una foto ilegible no serviría para esto, porque ahí la
    // aplicación avisa antes de llegar a la revisión.
    const galeria = page.locator('input[type="file"]').nth(1);
    await galeria.setInputFiles([
      {
        name: 'factura.jpg',
        mimeType: 'image/jpeg',
        buffer: await facturaLosCalvosJpeg({ totalAlterado: true }),
      },
    ]);

    await page.getByRole('button', { name: 'Leer el comprobante' }).click();

    // Muestra el progreso mientras trabaja.
    await expect(page.getByText(/Preparando|Leyendo|Verificando/).first()).toBeVisible({
      timeout: 120_000,
    });

    // Y termina en la revisión, en rojo.
    await expect(page.getByRole('heading', { name: 'Revisar los datos' })).toBeVisible({
      timeout: 240_000,
    });
    const semaforo = page.locator('.semaforo-error');
    await expect(semaforo).toBeVisible();
    await expect(semaforo).toContainText('El detalle no coincide con el comprobante');

    // Nada de verde ni de "controlado".
    await expect(page.locator('.semaforo-ok')).toHaveCount(0);

    // Y ofrece las dos salidas, que no son la misma: volver a leer la foto que
    // ya está guardada, o cambiarla por otra.
    await expect(page.getByRole('button', { name: 'Volver a leer esta imagen' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reemplazar la imagen' })).toBeVisible();

    // En el paso del pago, el botón de guardar queda deshabilitado.
    await page.getByRole('button', { name: 'Continuar al pago' }).click();
    await expect(page.getByRole('heading', { name: 'Guardar y agendar el pago' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Guardar y agendar el pago' }),
    ).toBeDisabled();

    // El operador no puede forzarlo.
    await expect(page.getByText('Sólo un administrador puede guardar')).toBeVisible();

    await sinScrollHorizontal(page);
  });

  test('no muestra errores técnicos en inglés', async ({ page }) => {
    const galeria = page.locator('input[type="file"]').nth(1);
    // Un archivo que no es una imagen ni un PDF.
    await galeria.setInputFiles([
      { name: 'facturas.zip', mimeType: 'application/zip', buffer: Buffer.from('PK\x03\x04algo') },
    ]);
    await page.getByRole('button', { name: 'Leer el comprobante' }).click();

    const alerta = page.locator('.mensaje-error');
    await expect(alerta).toBeVisible({ timeout: 120_000 });
    const texto = (await alerta.textContent()) ?? '';
    expect(texto).toMatch(/Aceptamos fotos|no se puede usar|No pudimos/i);
    expect(texto).not.toMatch(/did not match the expected pattern|Error:|undefined|null/i);
  });
});
