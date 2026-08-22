import { defineConfig, devices } from '@playwright/test';

/**
 * Pruebas end to end.
 *
 * El destino real de esta aplicación es Safari en iPhone, así que el proyecto
 * principal usa el perfil del iPhone 13: viewport de 390 × 844, densidad 3,
 * eventos táctiles y user agent móvil.
 *
 * Aviso: el motor es Chromium, no WebKit, porque este entorno no tiene WebKit
 * instalado. Sirve para verificar el diseño móvil, los tamaños de los
 * controles y el flujo completo, pero no reemplaza una prueba en un iPhone de
 * verdad. Para correrlas contra WebKit: `npx playwright install webkit` y
 * descomentar el proyecto "safari-iphone" de abajo.
 */
/**
 * Chromium se niega a arrancar como root con su sandbox activo, que es lo
 * normal dentro de un contenedor de integración continua. En una máquina de
 * trabajo el sandbox queda como viene.
 *
 * El navegador sale de PLAYWRIGHT_BROWSERS_PATH si el entorno ya lo trae; si
 * no, del directorio que usa Playwright por defecto. La versión de
 * @playwright/test está fijada para que coincida con el Chromium instalado:
 * subirla exige volver a bajar el navegador.
 */
const comoRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const launchOptions = comoRoot
  ? { args: ['--no-sandbox', '--disable-dev-shm-usage'] }
  : {};

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  globalSetup: './tests/e2e/preparar.ts',

  use: {
    baseURL: 'http://127.0.0.1:3100',
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'iphone',
      use: {
        ...devices['iPhone 13'],
        // El descriptor del iPhone trae WebKit por defecto. Acá se fuerza
        // Chromium porque este entorno no tiene WebKit instalado: se verifica
        // el diseño móvil, no el motor de Safari. Ver el aviso de arriba.
        browserName: 'chromium',
        launchOptions,
      },
    },
    {
      name: 'escritorio',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 },
        launchOptions,
      },
    },
    // {
    //   name: 'safari-iphone',
    //   use: { ...devices['iPhone 13'] }, // requiere WebKit instalado
    // },
  ],

  webServer: {
    command: 'npm run e2e:server',
    url: 'http://127.0.0.1:3100/ingresar',
    // Nunca se reutiliza un servidor ya levantado: serviría el build anterior
    // y las pruebas pasarían o fallarían sobre código que ya no existe.
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
