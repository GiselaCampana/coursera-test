import { test, expect } from '@playwright/test';
import { ingresar, sinScrollHorizontal, soloEnIphone } from './ayudas';

/**
 * El catálogo interno de Don Ginés.
 *
 * Lo que se controla acá es el flujo: que se llegue desde Configuración, que la
 * búsqueda encuentre por las tres claves, y sobre todo que la importación sea
 * en dos pasos —mirar primero, escribir después—. Los números de qué entra y
 * qué no se prueban en la integración, que es donde se puede armar el caso.
 */
test.describe('configuración de marcajes por producto', () => {
  /*
   * Cada modalidad de venta puede tener su propio marcaje.
   *
   * No es lo mismo lo que se le carga a una horma entera que a 100 g feteados,
   * y hasta hace poco la ficha sólo dejaba tocar el marcaje base. Lo que se
   * controla acá es que los específicos se vean, se puedan escribir y —sobre
   * todo— que queden guardados: un campo que se muestra y no persiste es peor
   * que uno que no está, porque hace creer que el precio se ajustó.
   */

  /** Abre la ficha del cremoso, que es el artículo con PLU confirmado. */
  async function abrirFichaDelCremoso(page: import('@playwright/test').Page) {
    await page.goto('/configuracion/productos?q=1211');
    const fila = page.locator('li').filter({ hasText: 'Cremoso Punta del Agua' }).first();
    await expect(fila, 'no se encontró el artículo 1211 en el catálogo').toBeVisible();
    // El botón se llama «Editar» a secas: el nombre del artículo está en el
    // título del formulario que abre, no en el botón.
    await fila.getByRole('button', { name: 'Editar', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Editar Cremoso Punta del Agua' })).toBeVisible();
  }

  test('muestra los marcajes específicos además del base', async ({ page }) => {
    await ingresar(page, 'admin');
    await abrirFichaDelCremoso(page);

    for (const etiqueta of [
      'Marcaje base (%)',
      'Horma digital (%)',
      'Horma efectivo (%)',
      'Caja efectivo (%)',
      'Venta 100 g (%)',
      'Venta 1/4 kg (%)',
    ]) {
      const campo = page.getByLabel(etiqueta);
      await expect(campo, `no se ve «${etiqueta}»`).toBeVisible();
      // Visible no alcanza: tiene que poder escribirse.
      await expect(campo, `«${etiqueta}» no se puede editar`).toBeEditable();
    }
  });

  test('guarda un marcaje de horma y uno de 1/4 kg, y quedan', async ({ page }, testInfo) => {
    // Escribe en la base compartida, así que corre en un solo proyecto. El
    // iPhone es además el que importa: es donde se carga de verdad.
    soloEnIphone(test, testInfo.project.name);
    await ingresar(page, 'admin');
    await abrirFichaDelCremoso(page);

    await page.getByLabel('Horma digital (%)').fill('62');
    await page.getByLabel('Venta 1/4 kg (%)').fill('81');
    // «Editar» despliega el formulario; el que lo envía es «Guardar».
    await page.getByRole('button', { name: 'Guardar', exact: true }).click();
    await expect(page.getByText('Guardado.').first()).toBeVisible();

    // Y al volver a entrar siguen ahí: es lo único que prueba que se guardaron.
    await abrirFichaDelCremoso(page);
    await expect(page.getByLabel('Horma digital (%)')).toHaveValue('62');
    await expect(page.getByLabel('Venta 1/4 kg (%)')).toHaveValue('81');
    // El marcaje base no se tocó al guardar los específicos.
    await expect(page.getByLabel('Marcaje base (%)')).toHaveValue('45');
  });

  test('un marcaje vacío hereda el base', async ({ page }) => {
    await ingresar(page, 'admin');
    await abrirFichaDelCremoso(page);
    // El campo vacío lo dice en su marca de agua, que es la regla de negocio
    // hecha visible: sin valor propio, manda el base.
    await expect(page.getByLabel('Caja efectivo (%)')).toHaveAttribute(
      'placeholder',
      'Usa marcaje base',
    );
  });
});

test.describe('catálogo Don Ginés', () => {
  test('se llega desde Configuración y muestra PLU, familia y códigos', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/configuracion');

    await page.getByRole('link', { name: 'Catálogo Don Ginés' }).click();
    await expect(page.getByRole('heading', { name: 'Catálogo Don Ginés', level: 1 })).toBeVisible();

    const encabezados = page.locator('table thead th');
    for (const titulo of ['PLU', 'Nombre', 'Familia', 'Códigos por proveedor', 'Activo']) {
      await expect(encabezados.filter({ hasText: titulo }).first()).toBeVisible();
    }
  });

  test('encuentra el mismo artículo por PLU, por nombre y por código de proveedor', async ({
    page,
  }) => {
    await ingresar(page, 'admin');

    // El queso sembrado: PLU 2001, y Errecalde lo factura como ART-00758.
    for (const termino of ['2001', 'sardo', 'ART-00758']) {
      await page.goto(`/configuracion/catalogo?q=${encodeURIComponent(termino)}`);
      await expect(
        page.locator('table tbody tr', { hasText: 'Queso Sardo bloque Melincué' }),
        `no se encontró buscando «${termino}»`,
      ).toHaveCount(1);
    }
  });

  test('la vista previa de la importación no escribe nada', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/configuracion/catalogo');

    const antes = await page.locator('table tbody tr').count();

    await page.locator('#texto').fill('PLU;Nombre;Familia\n7777;Artículo de prueba;Pruebas');
    await page.getByRole('button', { name: 'Ver qué cambiaría' }).click();

    // Dice que entraría uno nuevo…
    await expect(page.getByText('Lo que va a pasar')).toBeVisible();
    await expect(page.locator('summary', { hasText: 'Nuevos' })).toContainText('1');

    // …y ofrece confirmar aparte, que es el único paso que escribe.
    await expect(page.getByRole('button', { name: 'Sí, importar el catálogo' })).toBeVisible();

    // Nada cambió todavía: la tabla del catálogo sigue igual.
    await page.goto('/configuracion/catalogo');
    await expect(page.locator('table tbody tr')).toHaveCount(antes);
  });

  test('avisa si el archivo de Stock no trae Tipo y Subtipo', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/configuracion/catalogo');

    await page.locator('#texto').fill(
      'PLU;Artículo;Proveedor;Sucursal;Cantidad\n1211;Cremoso Punta del Agua;Errecalde;General;0',
    );
    await page.getByRole('button', { name: 'Ver qué cambiaría' }).click();

    await expect(page.getByText('La clasificación está incompleta.')).toBeVisible();
    await expect(page.getByText(/no trae Tipo de Artículo ni Subtipo de Artículo/)).toBeVisible();
  });

  test('confirma cuando Hoja 1 trae Tipo y Subtipo', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/configuracion/catalogo');

    await page.locator('#texto').fill(
      [
        'PLU;Artículo;Proveedor;Tipo de Artículo;Subtipo de Artículo',
        '1211;Cremoso Punta del Agua;Errecalde;Quesos;Cremosos',
      ].join('\n'),
    );
    await page.getByRole('button', { name: 'Ver qué cambiaría' }).click();

    await expect(
      page.getByText(/El archivo trae Tipo de Artículo y Subtipo de Artículo/),
    ).toBeVisible();
  });

  test('avisa cuando el archivo no trae las columnas que hacen falta', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/configuracion/catalogo');

    await page.locator('#texto').fill('Cosa,Otra\na,b');
    await page.getByRole('button', { name: 'Ver qué cambiaría' }).click();

    await expect(page.getByText('Filas que no se pueden importar')).toBeVisible();
    await expect(page.getByText(/columnas del PLU y del nombre/)).toBeVisible();
  });

  test('un operador no llega a esta pantalla', async ({ page }) => {
    await ingresar(page, 'operador');
    await page.goto('/configuracion/catalogo');
    await expect(page.getByRole('heading', { name: 'Catálogo Don Ginés', level: 1 })).toHaveCount(0);
  });

  test('entra en la pantalla del teléfono sin desbordarse', async ({ page }, testInfo) => {
    soloEnIphone(test, testInfo.project.name);
    await ingresar(page, 'admin');
    await page.goto('/configuracion/catalogo');
    await expect(page.locator('.resumen-mes')).toBeVisible();
    await sinScrollHorizontal(page);
  });
});

test.describe('familias en el reporte de compras', () => {
  test('el filtro por familia está y explica qué hace', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/compras');

    await expect(page.locator('#familia')).toBeVisible();
    await expect(page.getByText(/Suma todos los artículos del rubro/)).toBeVisible();

    // Y el filtro por artículo muestra el PLU, que es como se lo identifica.
    await expect(page.locator('#producto option').nth(1)).toContainText('·');
  });
});
