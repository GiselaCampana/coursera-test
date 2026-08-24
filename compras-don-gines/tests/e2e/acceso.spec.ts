import { test, expect, request as playwrightRequest } from '@playwright/test';
import { CREDENCIALES, ingresar } from './ayudas';

/**
 * Quién entra a dónde, y qué pasa con quien no tiene sesión.
 *
 * Estas pruebas nacen de un despliegue que se quedó en "Waiting for internal
 * health check…" con `UnauthorizedError: 401` en el log. El chequeo de la
 * plataforma apuntaba a una pantalla, y las pantallas protegidas tiraban una
 * excepción cuando las visitaba alguien sin sesión: dos cosas que no se ven al
 * usar la aplicación con el navegador ya logueado, y que sólo aparecen cuando la
 * pide un programa sin cookies. Que es exactamente lo que hace un health check.
 */

/** Un contexto limpio: sin cookies, sin sesión, sin nada guardado. */
async function sinSesion() {
  return playwrightRequest.newContext({
    baseURL: test.info().project.use.baseURL,
    storageState: { cookies: [], origins: [] },
  });
}

test.describe('acceso sin sesión', () => {
  test('el chequeo de salud contesta 200 sin cookies ni sesión', async () => {
    const anonimo = await sinSesion();
    const respuesta = await anonimo.get('/api/health');

    expect(respuesta.status()).toBe(200);
    expect(await respuesta.json()).toEqual({ estado: 'ok' });

    /*
     * Y contesta directo, sin mandar a ninguna parte.
     *
     * Un health check que redirige no sirve: la plataforma sigue el redirect o
     * lo cuenta como fallo según cómo esté configurada, y en cualquiera de los
     * dos casos el resultado depende de una pantalla en vez del proceso.
     */
    expect(respuesta.url()).toContain('/api/health');

    await anonimo.dispose();
  });

  test('la pantalla de ingreso se abre sin sesión', async () => {
    const anonimo = await sinSesion();
    const respuesta = await anonimo.get('/ingresar');
    expect(respuesta.status()).toBe(200);
    expect(await respuesta.text()).toContain('Compras Don Ginés');
    await anonimo.dispose();
  });

  test('el inicio manda a ingresar, sin lanzar ninguna excepción', async () => {
    const anonimo = await sinSesion();

    // Sin seguir el redirect: lo que importa es qué contesta la aplicación.
    const directa = await anonimo.get('/', { maxRedirects: 0 });

    /*
     * Un redirect, no un error.
     *
     * Acá está la prueba de que ninguna página tiró un UnauthorizedError: si lo
     * hiciera, Next devolvería 500 y su página de error, no un 307 a /ingresar.
     * El layout redirige y la página también, en vez de que una redirija
     * mientras la otra falla.
     */
    expect([302, 303, 307, 308]).toContain(directa.status());
    expect(directa.headers()['location']).toContain('/ingresar');

    // Y siguiéndolo se termina en la pantalla de ingreso, con 200.
    const seguida = await anonimo.get('/');
    expect(seguida.status()).toBe(200);
    expect(seguida.url()).toContain('/ingresar');

    await anonimo.dispose();
  });

  test('ninguna pantalla protegida contesta 401 ni 500 sin sesión', async () => {
    // Todas las de la aplicación, no sólo el inicio: el defecto era el mismo en
    // todas, porque todas llamaban al mismo ayudante.
    const pantallas = [
      '/',
      '/comprobantes',
      '/nueva-compra',
      '/pagos',
      '/precios',
      '/compras',
      '/mas',
      '/diagnostico',
      '/configuracion',
    ];

    const anonimo = await sinSesion();
    for (const pantalla of pantallas) {
      const respuesta = await anonimo.get(pantalla, { maxRedirects: 0 });
      expect(
        [302, 303, 307, 308],
        `${pantalla} contestó ${respuesta.status()} en vez de redirigir a /ingresar`,
      ).toContain(respuesta.status());
      expect(respuesta.headers()['location'], `${pantalla} redirigió a otro lado`).toContain(
        '/ingresar',
      );
    }
    await anonimo.dispose();
  });
});

test.describe('acceso con sesión', () => {
  test('el inicio se abre con 200', async ({ page }) => {
    await ingresar(page, 'admin');

    const respuesta = await page.goto('/');
    expect(respuesta?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Hola');
  });

  test('la pantalla de ingreso, ya con sesión, lleva al inicio', async ({ page }) => {
    // El reverso del caso anterior, y por el mismo motivo: tampoco acá tiene que
    // haber una excepción de por medio.
    await ingresar(page, 'admin');
    await page.goto('/ingresar');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Hola');
  });

  test('una sesión inválida no rompe: manda a ingresar', async ({ page, context }) => {
    // Una cookie vieja, de una sesión que ya no existe en la base. Es lo que
    // queda después de un despliegue que limpió sesiones, y tiene que tratarse
    // igual que no tener ninguna.
    await context.addCookies([
      {
        name: 'dg_session',
        value: 'una-sesion-que-no-existe',
        url: test.info().project.use.baseURL!,
      },
    ]);

    await page.goto('/');
    await expect(page).toHaveURL(/\/ingresar/);
    await expect(page.getByLabel('Correo')).toBeVisible();

    // Y desde ahí se entra normalmente.
    await page.getByLabel('Correo').fill(CREDENCIALES.admin.email);
    await page.getByLabel('Contraseña').fill(CREDENCIALES.admin.password);
    await page.getByRole('button', { name: 'Ingresar' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Hola');
  });
});
