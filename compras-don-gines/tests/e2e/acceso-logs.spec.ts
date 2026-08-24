import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { CREDENCIALES } from './ayudas';

/**
 * Lo que queda escrito en el log del servidor cuando entra alguien sin sesión.
 *
 * Hace falta un servidor propio para esto, y vale la pena explicar por qué.
 *
 * El defecto original no se veía en la respuesta HTTP: el layout redirigía a
 * /ingresar y el visitante terminaba donde tenía que terminar, con su 307. Pero
 * la página hija se renderizaba al mismo tiempo y tiraba un UnauthorizedError,
 * que quedaba en el log. Una prueba que sólo mire códigos de estado pasa
 * igual —lo comprobé: pasa con el defecto puesto—, así que no prueba nada.
 *
 * Y esas excepciones no son ruido inofensivo. En un despliegue que no termina de
 * arrancar, el log es lo primero que se mira, y un 401 ahí manda derecho a
 * buscar un problema de autenticación que no existe.
 *
 * Así que acá se levanta un servidor aparte con su salida capturada, se lo
 * visita sin cookies y después se lee lo que escribió.
 */

const PUERTO = 3110;
const BASE = `http://127.0.0.1:${PUERTO}`;
const raiz = path.resolve(__dirname, '../..');

test.describe.configure({ mode: 'serial', timeout: 180_000 });

/** El entorno de las pruebas, igual que el que usa el servidor de Playwright. */
function entornoE2E(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const ruta = path.join(raiz, '.env.e2e');
  if (existsSync(ruta)) {
    for (const linea of readFileSync(ruta, 'utf8').split('\n')) {
      const limpia = linea.trim();
      if (limpia === '' || limpia.startsWith('#')) continue;
      const corte = limpia.indexOf('=');
      if (corte < 0) continue;
      env[limpia.slice(0, corte).trim()] = limpia
        .slice(corte + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

test('una visita sin sesión no deja ninguna excepción en el log', async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'escritorio',
    'Levanta un servidor y ocupa un puerto: alcanza con correrla en un proyecto.',
  );

  let registro = '';
  let servidor: ChildProcess | null = null;

  try {
    /*
     * `detached` para poder matar el grupo entero al terminar.
     *
     * `next start` es un envoltorio: el que realmente escucha el puerto es un
     * proceso nieto. Una señal al envoltorio no siempre le llega, y el nieto
     * sobrevive ocupando el puerto y haciendo fallar la corrida siguiente por un
     * motivo que no tiene nada que ver.
     */
    servidor = spawn('npx', ['next', 'start', '-p', String(PUERTO), '-H', '127.0.0.1'], {
      cwd: raiz,
      env: entornoE2E(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    servidor.stdout?.on('data', (d) => (registro += d.toString()));
    servidor.stderr?.on('data', (d) => (registro += d.toString()));

    // Se espera con el propio chequeo de salud, que es para lo que existe.
    const limite = Date.now() + 90_000;
    for (;;) {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) break;
      } catch {
        // Todavía no atiende.
      }
      if (Date.now() > limite) throw new Error(`El servidor no arrancó:\n${registro}`);
      await new Promise((r) => setTimeout(r, 500));
    }

    // A partir de acá sólo interesa lo que el servidor escribe, así que se
    // limpia lo del arranque.
    registro = '';

    // 1. El chequeo de salud, sin cookies.
    const salud = await fetch(`${BASE}/api/health`, { redirect: 'manual' });
    expect(salud.status).toBe(200);

    // 2. La pantalla de ingreso, sin cookies.
    const ingreso = await fetch(`${BASE}/ingresar`, { redirect: 'manual' });
    expect(ingreso.status).toBe(200);

    // 3. El inicio, sin cookies: redirect limpio.
    const inicio = await fetch(`${BASE}/`, { redirect: 'manual' });
    expect([302, 303, 307, 308]).toContain(inicio.status);
    expect(inicio.headers.get('location')).toContain('/ingresar');

    /*
     * 4. El inicio con sesión válida: 200.
     *
     * El ingreso es una server action, no un endpoint, así que se hace con el
     * navegador —contra este servidor, no contra el de Playwright— que es además
     * como lo hace una persona.
     */
    await page.goto(`${BASE}/ingresar`);
    await page.getByLabel('Correo').fill(CREDENCIALES.admin.email);
    await page.getByLabel('Contraseña').fill(CREDENCIALES.admin.password);
    await page.getByRole('button', { name: 'Ingresar' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Hola');

    const conSesion = await page.goto(`${BASE}/`);
    expect(conSesion?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Hola');

    // Y el log quedó limpio: ninguna de esas cuatro visitas tiró una excepción.
    expect(registro, `El servidor registró una excepción:\n${registro}`).not.toMatch(
      /UnauthorizedError|NO_AUTENTICADO|ForbiddenError/,
    );
  } finally {
    if (servidor?.pid) {
      try {
        process.kill(-servidor.pid, 'SIGKILL');
      } catch {
        servidor.kill('SIGKILL');
      }
    }
  }
});
