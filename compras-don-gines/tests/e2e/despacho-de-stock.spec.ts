import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { CREDENCIALES, sinScrollHorizontal } from './ayudas';
import { cargarEntornoE2E } from './entorno';
import {
  sembrarEscenarioDeDespacho,
  limpiarEscenarioDeDespacho,
  ARTICULOS_DEL_DESPACHO,
  GASTO_DEL_DESPACHO,
  type EscenarioDeDespacho,
} from './escenario-despacho';

/**
 * **El botón que manda mercadería a Control de Stock, desde el navegador.**
 *
 * Es la operación más sensible de la aplicación: mueve existencias reales en
 * otro sistema. Las pruebas de integración fijan las reglas del servicio; ésta
 * fija las reglas **visibles**, que son las que una persona puede romper sin
 * tocar una línea de código: quién ve el botón, qué muestra antes de mandar,
 * que un solo clic no manda nada, y que cancelar no deja rastro.
 *
 * **Nada sale de la máquina.** El receptor es un servidor HTTP que levanta esta
 * misma prueba en 127.0.0.1 y que guarda lo que recibe para poder mirarlo. La
 * clave es inventada y vive sólo en el entorno del proceso que se lanza acá.
 *
 * **Datos propios.** El escenario se siembra aparte —mirá `escenario-despacho.ts`—
 * con un sufijo por proyecto, así que iPhone y escritorio no comparten ninguna
 * fila mutable y no hay orden entre ellos. La factura de Ezra de la demo no se
 * toca.
 */

const raiz = path.resolve(__dirname, '../..');

/** Puertos propios de cada proyecto, para que nunca se pisen entre sí. */
const PUERTOS: Record<string, { app: number; receptor: number; sinClave: number }> = {
  iphone: { app: 3140, receptor: 3141, sinClave: 3142 },
  escritorio: { app: 3150, receptor: 3151, sinClave: 3152 },
};

/** La clave del receptor de mentira. No es un secreto y no sale de acá. */
const CLAVE_FALSA = 'clave-de-navegador-no-es-un-secreto';

test.describe.configure({ mode: 'serial', timeout: 180_000 });

/* -------------------------------------------------------------------------- */

/** El entorno de las pruebas, como el que usa el servidor de Playwright. */
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

/**
 * Levanta un servidor con el entorno que se le pida y espera a que atienda.
 *
 * `detached` para poder matar el grupo entero: `next start` es un envoltorio y
 * el que escucha es un nieto, que si sobrevive ocupa el puerto y hace fallar la
 * corrida siguiente por un motivo que no tiene nada que ver.
 */
async function levantarServidor(
  puerto: number,
  extra: Record<string, string | undefined>,
): Promise<ChildProcess> {
  const env = entornoE2E();
  for (const [clave, valor] of Object.entries(extra)) {
    if (valor === undefined) delete env[clave];
    else env[clave] = valor;
  }

  const proceso = spawn('npx', ['next', 'start', '-p', String(puerto), '-H', '127.0.0.1'], {
    cwd: raiz,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let registro = '';
  proceso.stdout?.on('data', (d) => (registro += d.toString()));
  proceso.stderr?.on('data', (d) => (registro += d.toString()));

  const limite = Date.now() + 90_000;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${puerto}/api/health`);
      if (r.ok) break;
    } catch {
      // Todavía no atiende.
    }
    if (Date.now() > limite) throw new Error(`El servidor no arrancó:\n${registro}`);
    await new Promise((r) => setTimeout(r, 400));
  }
  return proceso;
}

function bajarServidor(proceso: ChildProcess | null) {
  if (!proceso?.pid) return;
  try {
    process.kill(-proceso.pid, 'SIGKILL');
  } catch {
    // Ya no estaba.
  }
}

/**
 * Aprieta un control, centrándolo primero.
 *
 * En la pantalla del iPhone el encabezado queda fijo arriba y tapa lo que
 * Playwright deja justo debajo al desplazarse. Centrar el control evita un
 * fallo que no tiene nada que ver con lo que se está probando.
 */
async function apretar(page: Page, prueba: string) {
  const control = page.locator(`[data-prueba="${prueba}"]`);
  await control.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await control.click();
}

/**
 * Los movimientos de un lote, ordenados por su clave.
 *
 * El orden dentro del lote **no** es parte del contrato: cada movimiento lleva
 * su propia clave de idempotencia y el receptor deduplica por ella. Y tampoco
 * es estable: las cinco filas de una compra comparten el `createdAt` al
 * milisegundo, así que PostgreSQL las devuelve en cualquier orden. Comparar los
 * cuerpos como cadena hacía fallar un reintento que mandaba exactamente lo
 * mismo, sólo que acomodado distinto.
 */
function porClave(movimientos: any[]): string {
  return JSON.stringify(
    [...movimientos].sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey)),
  );
}

async function ingresarEn(page: Page, base: string, quien: 'admin' | 'operador' = 'admin') {
  const { email, password } = CREDENCIALES[quien];
  await page.goto(`${base}/ingresar`);
  await page.getByLabel('Correo').fill(email);
  await page.getByLabel('Contraseña').fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Hola');
}

/** Los movimientos de un comprobante, leídos de la base. */
async function movimientosEnLaBase(documentId: string) {
  cargarEntornoE2E();
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    return await prisma.stockOutbox.findMany({
      where: { documentId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { eventKey: true, status: true, plu: true, attempts: true },
    });
  } finally {
    await prisma.$disconnect();
  }
}

/* -------------------------------------------------------------------------- */
/*  Lo que se ve sin que la integración esté configurada                       */
/* -------------------------------------------------------------------------- */

test.describe('el despacho de stock, con la integración dormida', () => {
  let escenario: EscenarioDeDespacho;

  test.beforeEach(async ({}, testInfo) => {
    escenario = await sembrarEscenarioDeDespacho(testInfo.project.name);
  });

  test('el administrador ve la tarjeta y la acción', async ({ page, baseURL }) => {
    await ingresarEn(page, baseURL!);
    await page.goto(`${baseURL}/comprobantes/${escenario.objetivo.id}`);

    await expect(page.locator('[data-prueba="despacho-de-stock"]')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Enviar la mercadería a Control de Stock' })).toBeVisible();
  });

  test('un usuario sin el permiso no la ve', async ({ page, baseURL }) => {
    /*
     * El operador llega al comprobante —es de su sucursal— pero no puede mover
     * existencias en otra aplicación. Esconder el botón no es la defensa; la
     * defensa está en el servidor y se prueba más abajo. Acá se comprueba que
     * además no se le ofrezca algo que va a ser rechazado.
     */
    await ingresarEn(page, baseURL!, 'operador');
    await page.goto(`${baseURL}/comprobantes/${escenario.objetivo.id}`);

    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      escenario.objetivo.fullNumber,
    );
    await expect(page.locator('[data-prueba="despacho-de-stock"]')).toHaveCount(0);
    await expect(page.locator('[data-prueba="pedir-despacho"]')).toHaveCount(0);
  });

  test('sin STOCK_INTEGRATION_WRITE_URL el botón está bloqueado y dice qué falta', async ({
    page,
    baseURL,
  }) => {
    await ingresarEn(page, baseURL!);
    await page.goto(`${baseURL}/comprobantes/${escenario.objetivo.id}`);

    const aviso = page.locator('[data-prueba="sin-configurar"]');
    await expect(aviso).toBeVisible();
    await expect(aviso).toContainText('STOCK_INTEGRATION_WRITE_URL');
    await expect(page.locator('[data-prueba="pedir-despacho"]')).toBeDisabled();
  });

  test('el aviso nombra la variable y no muestra ningún valor', async ({ page, baseURL }) => {
    await ingresarEn(page, baseURL!);
    await page.goto(`${baseURL}/comprobantes/${escenario.objetivo.id}`);

    const html = await page.content();
    expect(html).toContain('STOCK_INTEGRATION_WRITE_URL');
    /*
     * Y ni la clave del catálogo —que este servidor sí tiene cargada— ni la
     * cadena de conexión aparecen en la página. Un nombre de variable no es un
     * secreto; su valor sí.
     */
    const env = entornoE2E();
    expect(html).not.toContain(env.STOCK_INTEGRATION_KEY ?? '###');
    expect(html).not.toContain('postgresql://');
  });

  test('la vista previa muestra este comprobante, sus cinco movimientos y nada más', async ({
    page,
    baseURL,
  }) => {
    await ingresarEn(page, baseURL!);
    await page.goto(`${baseURL}/comprobantes/${escenario.objetivo.id}`);

    const sufijo = test.info().project.name;
    const filas = page.locator('[data-prueba="movimiento"]');
    await expect(filas).toHaveCount(5);

    for (const articulo of ARTICULOS_DEL_DESPACHO) {
      const fila = filas.filter({
        has: page.locator(`[data-prueba="plu"]:text-is("${articulo.plu}${sufijo}")`),
      });
      await expect(fila, `PLU ${articulo.plu}`).toHaveCount(1);
      await expect(fila.locator('[data-prueba="unidad"]')).toHaveText('KG');
      await expect(fila.locator('[data-prueba="cantidad"]')).toHaveText(articulo.mostrado);
    }

    // La sucursal, con su código canónico a la vista.
    await expect(page.locator('[data-prueba="movimiento"]').first()).toContainText('Devoto');
    await expect(page.locator('[data-prueba="movimiento"]').first()).toContainText('devoto');

    /*
     * Y la tarjeta entra en la pantalla. La tabla tiene un ancho mínimo de
     * 560px contra los 390 del teléfono: sin envolverla se desborda y termina
     * tapando el botón de enviar. Pasó, y por eso esto se afirma.
     */
    await sinScrollHorizontal(page);
  });

  test('la bolsa figura sin impacto en stock y no está entre los movimientos', async ({
    page,
    baseURL,
  }) => {
    await ingresarEn(page, baseURL!);
    await page.goto(`${baseURL}/comprobantes/${escenario.objetivo.id}`);

    const sinImpacto = page.locator('[data-prueba="sin-impacto"]');
    await expect(sinImpacto).toContainText(GASTO_DEL_DESPACHO);
    await expect(sinImpacto).toContainText('gasto, no mercadería');

    // Y no aparece en la tabla de lo que se va a mandar.
    const tabla = page.locator('[data-prueba="movimientos-de-stock"]');
    await expect(tabla).not.toContainText(GASTO_DEL_DESPACHO);
  });

  test('recargar muestra lo que dice la base, no lo que quedó en pantalla', async ({
    page,
    baseURL,
  }) => {
    await ingresarEn(page, baseURL!);
    await page.goto(`${baseURL}/comprobantes/${escenario.objetivo.id}`);
    await expect(page.locator('[data-prueba="movimiento"]')).toHaveCount(5);

    await page.reload();

    const filas = page.locator('[data-prueba="movimiento"]');
    await expect(filas).toHaveCount(5);
    for (let i = 0; i < 5; i += 1) {
      await expect(filas.nth(i)).toHaveAttribute('data-estado', 'PENDIENTE');
    }
    const enLaBase = await movimientosEnLaBase(escenario.objetivo.id);
    expect(enLaBase.every((m) => m.status === 'PENDIENTE')).toBe(true);
  });

  test('la llamada directa de un usuario sin permiso la rechaza el servidor', async ({
    page,
    baseURL,
  }) => {
    /*
     * El camino que usaría cualquiera que mire la red: entrar como operador y
     * llamar a la acción del servidor a mano. Que el botón no esté en la
     * pantalla no alcanza como defensa, y esto lo comprueba.
     */
    await ingresarEn(page, baseURL!, 'operador');

    const respuesta = await page.request.post(
      `${baseURL}/comprobantes/${escenario.objetivo.id}`,
      {
        headers: {
          'Next-Action': 'despacho-de-prueba',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        data: `documentId=${escenario.objetivo.id}`,
        failOnStatusCode: false,
      },
    );
    /* No importa cómo lo rechace, sí que no lo aplique. */
    expect(respuesta.status()).toBeGreaterThanOrEqual(400);

    const enLaBase = await movimientosEnLaBase(escenario.objetivo.id);
    expect(enLaBase.every((m) => m.status === 'PENDIENTE')).toBe(true);
    expect(enLaBase.every((m) => m.attempts === 0)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  Lo que pasa contra un receptor de mentira, en la máquina                    */
/* -------------------------------------------------------------------------- */

test.describe('el despacho de stock, contra un receptor local', () => {
  let escenario: EscenarioDeDespacho;
  let servidor: ChildProcess | null = null;
  let receptor: Server;
  let base: string;
  let puertos: { app: number; receptor: number; sinClave: number };

  /** Lo que el receptor recibió, para poder mirarlo. */
  let recibidos: { autorizacion: string | undefined; url: string; cuerpo: any }[] = [];
  let respuesta: 'APLICA' | 'RECUPERABLE' | 'RARO' = 'APLICA';

  test.beforeAll(async ({}, testInfo) => {
    puertos = PUERTOS[testInfo.project.name]!;
    base = `http://127.0.0.1:${puertos.app}`;

    receptor = createServer((pedido, salida) => {
      let crudo = '';
      pedido.on('data', (t) => (crudo += t));
      pedido.on('end', () => {
        recibidos.push({
          autorizacion: pedido.headers.authorization,
          url: pedido.url ?? '',
          cuerpo: JSON.parse(crudo || '{}'),
        });

        if (respuesta === 'RECUPERABLE') {
          salida.writeHead(503, { 'content-type': 'application/json' });
          salida.end(JSON.stringify({ ok: false }));
          return;
        }
        if (respuesta === 'RARO') {
          /* 200 que no habla este contrato: no puede leerse como un éxito. */
          salida.writeHead(200, { 'content-type': 'application/json' });
          salida.end(JSON.stringify({ ok: true, mensaje: 'listo' }));
          return;
        }
        const cuerpo = recibidos[recibidos.length - 1]!.cuerpo as {
          movements: { idempotencyKey: string }[];
        };
        salida.writeHead(201, { 'content-type': 'application/json' });
        salida.end(
          JSON.stringify({
            contractVersion: 1,
            status: 'APPLIED',
            movements: cuerpo.movements.map((m, i) => ({
              idempotencyKey: m.idempotencyKey,
              status: 'APPLIED',
              movementId: `mov-${i + 1}`,
            })),
          }),
        );
      });
    });
    await new Promise<void>((listo) => receptor.listen(puertos.receptor, '127.0.0.1', listo));

    servidor = await levantarServidor(puertos.app, {
      STOCK_INTEGRATION_WRITE_URL: `http://127.0.0.1:${puertos.receptor}/api/integrations/purchases`,
      STOCK_INTEGRATION_KEY: CLAVE_FALSA,
    });
  });

  test.afterAll(async ({}, testInfo) => {
    bajarServidor(servidor);
    await new Promise<void>((listo) => receptor.close(() => listo()));
    await limpiarEscenarioDeDespacho(testInfo.project.name);
  });

  test.beforeEach(async ({}, testInfo) => {
    escenario = await sembrarEscenarioDeDespacho(testInfo.project.name);
    recibidos = [];
    respuesta = 'APLICA';
  });

  async function abrir(page: Page, documentId: string) {
    await ingresarEn(page, base);
    await page.goto(`${base}/comprobantes/${documentId}`);
    await expect(page.locator('[data-prueba="despacho-de-stock"]')).toBeVisible();
  }

  test('el primer clic sólo abre la confirmación: no manda nada', async ({ page }) => {
    await abrir(page, escenario.objetivo.id);

    await apretar(page, 'pedir-despacho');

    await expect(page.locator('[data-prueba="confirmar-despacho"]')).toBeVisible();
    expect(recibidos).toHaveLength(0);
    const enLaBase = await movimientosEnLaBase(escenario.objetivo.id);
    expect(enLaBase.every((m) => m.status === 'PENDIENTE')).toBe(true);
    expect(enLaBase.every((m) => m.attempts === 0)).toBe(true);
  });

  test('cancelar no manda ni cambia nada', async ({ page }) => {
    await abrir(page, escenario.objetivo.id);
    await apretar(page, 'pedir-despacho');
    await expect(page.locator('[data-prueba="confirmar-despacho"]')).toBeVisible();

    await apretar(page, 'cancelar-despacho');

    await expect(page.locator('[data-prueba="confirmar-despacho"]')).toHaveCount(0);
    await expect(page.locator('[data-prueba="pedir-despacho"]')).toBeVisible();
    expect(recibidos).toHaveLength(0);
    const enLaBase = await movimientosEnLaBase(escenario.objetivo.id);
    expect(enLaBase.every((m) => m.status === 'PENDIENTE')).toBe(true);
    expect(enLaBase.every((m) => m.attempts === 0)).toBe(true);
  });

  test('confirmar manda exactamente este comprobante, y el contrato es el acordado', async ({
    page,
  }, testInfo) => {
    const antes = await movimientosEnLaBase(escenario.objetivo.id);

    await abrir(page, escenario.objetivo.id);
    await apretar(page, 'pedir-despacho');
    await apretar(page, 'confirmar-despacho');
    await expect(page.locator('[data-prueba="resultado-del-despacho"]')).toHaveAttribute(
      'data-estado',
      'COMPLETADA',
    );

    /* Un solo pedido, y el cuerpo, carácter por carácter. */
    expect(recibidos).toHaveLength(1);
    const lote = recibidos[0]!.cuerpo;
    expect(lote.contractVersion).toBe(1);
    expect(lote.branchCode).toBe('devoto');
    expect(lote.purchaseId).toBe(escenario.objetivo.id);
    expect(lote.movements).toHaveLength(5);

    const sufijo = testInfo.project.name;
    for (const articulo of ARTICULOS_DEL_DESPACHO) {
      const suyo = lote.movements.filter((m: any) => m.plu === `${articulo.plu}${sufijo}`);
      expect(suyo, `PLU ${articulo.plu}`).toHaveLength(1);
      /* Tres decimales, como cadena: «4.240» y no «4.24». */
      expect(suyo[0].quantity).toBe(articulo.contrato);
      expect(suyo[0].unit).toBe('KG');
      expect(suyo[0].direction).toBe('IN');
      expect(suyo[0].reason).toBe('PURCHASE');
    }

    // La bolsa no viaja.
    expect(JSON.stringify(lote)).not.toContain('BOLSA');

    // Las claves son las que ya estaban: no se generó ninguna nueva.
    const claves = lote.movements.map((m: any) => m.idempotencyKey).sort();
    expect(claves).toEqual(antes.map((m) => m.eventKey).sort());

    // El secreto viaja en el encabezado y en ningún otro lado.
    expect(recibidos[0]!.autorizacion).toBe(`Bearer ${CLAVE_FALSA}`);
    expect(recibidos[0]!.url).not.toContain(CLAVE_FALSA);
    expect(JSON.stringify(lote)).not.toContain(CLAVE_FALSA);

    // Y la clave tampoco quedó en la página.
    expect(await page.content()).not.toContain(CLAVE_FALSA);
  });

  test('el otro comprobante pendiente queda intacto', async ({ page }) => {
    await abrir(page, escenario.objetivo.id);
    await apretar(page, 'pedir-despacho');
    await apretar(page, 'confirmar-despacho');
    await expect(page.locator('[data-prueba="resultado-del-despacho"]')).toBeVisible();

    expect(recibidos).toHaveLength(1);
    expect(recibidos[0]!.cuerpo.purchaseId).toBe(escenario.objetivo.id);

    const ajeno = await movimientosEnLaBase(escenario.ajeno.id);
    expect(ajeno).toHaveLength(5);
    expect(ajeno.every((m) => m.status === 'PENDIENTE')).toBe(true);
    expect(ajeno.every((m) => m.attempts === 0)).toBe(true);
  });

  test('dos confirmaciones a la vez producen un solo pedido', async ({ browser }) => {
    const uno = await browser.newContext();
    const dos = await browser.newContext();
    try {
      const p1 = await uno.newPage();
      const p2 = await dos.newPage();
      await abrir(p1, escenario.objetivo.id);
      await abrir(p2, escenario.objetivo.id);
      await apretar(p1, 'pedir-despacho');
      await apretar(p2, 'pedir-despacho');

      await Promise.all([
        p1.locator('[data-prueba="confirmar-despacho"]').click(),
        p2.locator('[data-prueba="confirmar-despacho"]').click(),
      ]);
      await expect(p1.locator('[data-prueba="resultado-del-despacho"]')).toBeVisible();
      await expect(p2.locator('[data-prueba="resultado-del-despacho"]')).toBeVisible();

      expect(recibidos).toHaveLength(1);
      const enLaBase = await movimientosEnLaBase(escenario.objetivo.id);
      expect(enLaBase).toHaveLength(5);
      expect(enLaBase.every((m) => m.status === 'COMPLETADO')).toBe(true);
    } finally {
      await uno.close();
      await dos.close();
    }
  });

  test('después de APPLIED la pantalla lo da por completado y no deja reenviarlo', async ({
    page,
  }) => {
    await abrir(page, escenario.objetivo.id);
    await apretar(page, 'pedir-despacho');
    await apretar(page, 'confirmar-despacho');
    await expect(page.locator('[data-prueba="resultado-del-despacho"]')).toBeVisible();

    await page.reload();

    const filas = page.locator('[data-prueba="movimiento"]');
    await expect(filas).toHaveCount(5);
    for (let i = 0; i < 5; i += 1) {
      await expect(filas.nth(i)).toHaveAttribute('data-estado', 'COMPLETADO');
    }
    await expect(page.locator('[data-prueba="ya-completados"]')).toContainText('5');
    await expect(page.locator('[data-prueba="nada-para-enviar"]')).toBeVisible();
    await expect(page.locator('[data-prueba="pedir-despacho"]')).toHaveCount(0);
    expect(recibidos).toHaveLength(1);
  });

  test('un resultado reintentable deja la acción disponible, con la misma clave', async ({
    page,
  }) => {
    const antes = await movimientosEnLaBase(escenario.objetivo.id);
    respuesta = 'RECUPERABLE';

    await abrir(page, escenario.objetivo.id);
    await apretar(page, 'pedir-despacho');
    await apretar(page, 'confirmar-despacho');
    await expect(page.locator('[data-prueba="resultado-del-despacho"]')).toHaveAttribute(
      'data-estado',
      'PENDIENTE',
    );

    await page.reload();
    // Vuelve a ofrecerse, porque se puede reintentar.
    await expect(page.locator('[data-prueba="pedir-despacho"]')).toBeEnabled();

    const despues = await movimientosEnLaBase(escenario.objetivo.id);
    expect(despues.every((m) => m.status === 'PENDIENTE')).toBe(true);
    /* La clave no cambia: es lo único que impide que entre dos veces. */
    expect(despues.map((m) => m.eventKey).sort()).toEqual(antes.map((m) => m.eventKey).sort());

    // Y el reintento manda el mismo cuerpo.
    respuesta = 'APLICA';
    await apretar(page, 'pedir-despacho');
    await apretar(page, 'confirmar-despacho');
    await expect(page.locator('[data-prueba="resultado-del-despacho"]')).toHaveAttribute(
      'data-estado',
      'COMPLETADA',
    );
    expect(recibidos).toHaveLength(2);
    expect(porClave(recibidos[1]!.cuerpo.movements)).toBe(
      porClave(recibidos[0]!.cuerpo.movements),
    );
  });

  test('lo que quedó sin confirmación no entra en el envío normal', async ({ page }) => {
    /*
     * Un movimiento que salió y volvió con algo que no se entiende puede haber
     * aplicado del otro lado. Volver a mandarlo es otra decisión, y la pantalla
     * la pide aparte en vez de meterla en el botón de siempre.
     */
    respuesta = 'RARO';
    await abrir(page, escenario.objetivo.id);
    await apretar(page, 'pedir-despacho');
    await apretar(page, 'confirmar-despacho');
    await expect(page.locator('[data-prueba="resultado-del-despacho"]')).toBeVisible();
    expect(recibidos).toHaveLength(1);

    await page.reload();

    // Quedaron inciertos, y el botón normal ya no tiene nada que mandar.
    await expect(page.locator('[data-prueba="inciertos"]')).toBeVisible();
    await expect(page.locator('[data-prueba="nada-para-enviar"]')).toBeVisible();
    await expect(page.locator('[data-prueba="pedir-despacho"]')).toHaveCount(0);

    // La decisión aparte sí los manda, y con la misma clave.
    respuesta = 'APLICA';
    await apretar(page, 'reintentar-inciertos');
    await expect(page.locator('[data-prueba="resultado-del-despacho"]')).toHaveAttribute(
      'data-estado',
      'COMPLETADA',
    );
    expect(recibidos).toHaveLength(2);
    expect(porClave(recibidos[1]!.cuerpo.movements)).toBe(
      porClave(recibidos[0]!.cuerpo.movements),
    );
  });
});

/* -------------------------------------------------------------------------- */

test.describe('sin la clave tampoco se puede', () => {
  let escenario: EscenarioDeDespacho;
  let servidor: ChildProcess | null = null;

  test.beforeAll(async ({}, testInfo) => {
    servidor = await levantarServidor(PUERTOS[testInfo.project.name]!.sinClave, {
      STOCK_INTEGRATION_WRITE_URL: 'https://ejemplo.invalido/api/integrations/purchases',
      STOCK_INTEGRATION_KEY: undefined,
    });
  });

  test.afterAll(async ({}, testInfo) => {
    bajarServidor(servidor);
    await limpiarEscenarioDeDespacho(testInfo.project.name);
  });

  test('con la URL cargada pero sin clave, el botón sigue bloqueado', async ({ page }, testInfo) => {
    /*
     * La dirección de arriba no existe y no se resuelve: si algo intentara
     * salir, fallaría. Lo que se comprueba es que **no se intente**, y que la
     * pantalla diga cuál de las dos variables falta.
     */
    escenario = await sembrarEscenarioDeDespacho(testInfo.project.name);
    const base = `http://127.0.0.1:${PUERTOS[testInfo.project.name]!.sinClave}`;

    await ingresarEn(page, base);
    await page.goto(`${base}/comprobantes/${escenario.objetivo.id}`);

    const aviso = page.locator('[data-prueba="sin-configurar"]');
    await expect(aviso).toBeVisible();
    await expect(aviso).toContainText('STOCK_INTEGRATION_KEY');
    await expect(aviso).not.toContainText('STOCK_INTEGRATION_WRITE_URL');
    await expect(page.locator('[data-prueba="pedir-despacho"]')).toBeDisabled();

    const enLaBase = await movimientosEnLaBase(escenario.objetivo.id);
    expect(enLaBase.every((m) => m.attempts === 0)).toBe(true);
  });
});
