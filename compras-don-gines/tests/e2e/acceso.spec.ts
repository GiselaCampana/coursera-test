import { test, expect } from '@playwright/test';
import { CREDENCIALES, ingresar, sinScrollHorizontal, tamanoTactil } from './ayudas';

test.describe('acceso', () => {
  test('sin sesión, cualquier pantalla lleva al ingreso', async ({ page }) => {
    for (const ruta of ['/', '/comprobantes', '/pagos', '/precios', '/configuracion']) {
      await page.goto(ruta);
      await expect(page).toHaveURL(/\/ingresar/);
    }
  });

  test('la contraseña equivocada no dice si el usuario existe', async ({ page }) => {
    await page.goto('/ingresar');
    await page.getByLabel('Correo').fill(CREDENCIALES.admin.email);
    await page.getByLabel('Contraseña').fill('esta-no-es');
    await page.getByRole('button', { name: 'Ingresar' }).click();

    // Se apunta al mensaje del formulario: Next agrega su propio role="alert"
    // vacío para anunciar los cambios de ruta.
    const error = page.locator('.mensaje-error');
    await expect(error).toBeVisible();
    await expect(error).toHaveText('El correo o la contraseña no son correctos.');

    // El mismo mensaje para un usuario que no existe.
    await page.getByLabel('Correo').fill('nadie@e2e.local');
    await page.getByLabel('Contraseña').fill('loquesea123');
    await page.getByRole('button', { name: 'Ingresar' }).click();
    await expect(page.locator('.mensaje-error')).toHaveText(
      'El correo o la contraseña no son correctos.',
    );
  });

  test('se ingresa y se cierra sesión', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/mas');
    await page.getByRole('button', { name: 'Cerrar sesión' }).click();
    await expect(page).toHaveURL(/\/ingresar/);
    // Y la sesión quedó cerrada de verdad.
    await page.goto('/');
    await expect(page).toHaveURL(/\/ingresar/);
  });

  test('la pantalla de ingreso entra bien en el iPhone', async ({ page }) => {
    await page.goto('/ingresar');
    await sinScrollHorizontal(page);
    await tamanoTactil(page, 'button[type="submit"]');
    // 16 px en los campos evita que Safari haga zoom al enfocarlos.
    const tamano = await page
      .getByLabel('Correo')
      .evaluate((el) => getComputedStyle(el).fontSize);
    expect(parseFloat(tamano)).toBeGreaterThanOrEqual(16);
  });
});

test.describe('alcance por sucursal', () => {
  test('el operador no ve la configuración general', async ({ page }) => {
    await ingresar(page, 'operador');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Osvaldo');
    await expect(page.locator('.medio').first()).toContainText('Devoto');

    // La configuración le queda fuera de alcance, y el backend lo hace valer.
    await page.goto('/configuracion');
    await expect(page).toHaveURL(/^(?!.*configuracion).*$/);
  });

  test('el administrador ve las tres sucursales', async ({ page }) => {
    await ingresar(page, 'admin');
    await expect(page.locator('.medio').first()).toContainText('tres sucursales');
    await page.goto('/configuracion');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Configuración');
  });
});
