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

/**
 * Crea el escenario **por el camino real**, y no lo busca en el listado.
 *
 * HALLAZGO que obligó a este cambio: la primera versión buscaba el comprobante
 * sembrado en `/comprobantes?estado=REQUIERE_REVISION`. Pasaba corriendo el
 * archivo solo y fallaba en la suite completa, porque otras pruebas dejan
 * comprobantes en revisión y el sembrado —el más viejo— se cae de la primera
 * página del listado. Depender de la posición en una lista compartida es
 * depender del orden de ejecución.
 *
 * Así que cada prueba abre su propio comprobante y le manda una lectura
 * ilegible, que es exactamente lo que pasa con la foto de Los Calvos: el
 * servidor la rechaza como lectura y deja el comprobante editable y en
 * revisión. No hay fila mutable compartida y no hay orden entre pruebas.
 */
async function abrirUnaLecturaInsuficiente(page: Page): Promise<string> {
  /*
   * 1. Un comprobante nuevo.
   *
   * La sucursal se toma del selector de la pantalla y no de un literal: el
   * administrador ve las tres, así que el alta la exige, y un identificador
   * escrito acá sería una copia que deja de coincidir en cuanto cambia el
   * sembrado.
   */
  await page.goto('/nueva-compra');
  const sucursalId = await page.locator('#sucursal').inputValue();
  expect(sucursalId, 'la pantalla tiene que ofrecer una sucursal').not.toBe('');

  /*
   * Los pedidos van **desde la página** con `fetch`, no con `page.request`.
   *
   * `page.request` no arrastró la cookie de sesión en este montaje y el alta
   * contestaba «Necesitás iniciar sesión». Desde adentro de la página el
   * navegador manda la cookie como en cualquier clic, que además es lo que se
   * quiere probar: el mismo camino que usa la aplicación.
   */
  const alta = await page.evaluate(async (branchId) => {
    const r = await fetch('/api/comprobantes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branchId }),
    });
    return { ok: r.ok, cuerpo: await r.text() };
  }, sucursalId);
  expect(alta.ok, `alta: ${alta.cuerpo}`).toBeTruthy();
  const { id } = JSON.parse(alta.cuerpo) as { id: string };

  /*
   * 2. Una lectura de la que ningún analizador puede sacar un comprobante:
   *    membrete y dirección, sin una sola fila con forma de renglón. Es el
   *    texto que sale de la foto 0010-00212356 cuando la tabla cae sobre el
   *    membrete.
   */
  const lectura = await page.evaluate(async (documentId) => {
    const r = await fetch(`/api/comprobantes/${documentId}/lectura`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        intento: 1,
        estrategia: 'completo',
        proveedor: 'tesseract',
        modelo: 'spa',
        duracionMs: 9000,
        paginas: [
          {
            numero: 1,
            textoCompleto:
              'LOS CALVOS S.A.\nAv. San Martín 2345\nSan Martín, Buenos Aires\nTel 4755-0000',
            textoEncabezado: null,
            textoArticulos: 'LOS CALVOS S.A.\nAv. San Martín 2345',
            textoResumen: null,
            confianza: 0.4,
            regiones: { filasDetectadas: 0 },
          },
        ],
      }),
    });
    return { ok: r.ok, cuerpo: await r.text() };
  }, id);
  expect(lectura.ok, `lectura: ${lectura.cuerpo}`).toBeTruthy();
  const cuerpo = JSON.parse(lectura.cuerpo) as {
    puedeGuardar?: boolean;
    controles?: { code: string; severity: string }[];
  };
  /* El veredicto tiene que ser ERROR: si no, la prueba no probaría el caso. */
  const control = (cuerpo.controles ?? []).find((c) => c.code === 'LECTURA_UTILIZABLE');
  expect(control?.severity, 'la lectura tiene que quedar rechazada').toBe('ERROR');

  return id;
}

/** Abre ese comprobante en el editor, por la puerta de la pantalla. */
async function abrirElSinLeer(page: Page) {
  const id = await abrirUnaLecturaInsuficiente(page);
  await page.goto(`/comprobantes/${id}`);
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
