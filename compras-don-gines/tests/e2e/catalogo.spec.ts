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
