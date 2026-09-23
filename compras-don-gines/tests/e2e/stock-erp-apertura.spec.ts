import { test, expect, type Page } from '@playwright/test';
import { ingresar, sinScrollHorizontal } from './ayudas';

/**
 * **La apertura de Stock ERP, desde el navegador y en los dos tamaños.**
 *
 * Lo que se prueba acá son las reglas que se ven: que una sucursal sin apertura
 * lo diga con todas las letras y no se confunda con una en cero, que un
 * artículo sin unidad aparezca bloqueado, que «contado en cero» sea un gesto
 * propio, que confirmar pida dos veces y que nada de esto se lea como
 * existencias operativas.
 *
 * CADA PROYECTO TRABAJA SOBRE SU PROPIA SUCURSAL, y no es un detalle de
 * comodidad. HALLAZGO de la primera versión: escritorio e iPhone corren contra
 * la MISMA base, uno después del otro. La corrida de iPhone confirmaba la
 * apertura de Devoto y, cuando llegaba escritorio, la sucursal ya no tenía
 * borrador: nueve pruebas en rojo por interferencia, no por un defecto. Una
 * apertura es irreversible por diseño —ésa es su gracia— así que no alcanza con
 * «limpiar antes»: hace falta que cada proyecto tenga una sucursal propia.
 *
 * Devoto queda para «sucursal sin apertura» y para la prueba de permisos, que
 * corre después y la prepara: por eso el archivo va en modo serial y el caso
 * «sin apertura» está primero.
 *
 * De paso deja las capturas para revisión visual, en `test-results/capturas/`.
 */

const MINUTOS = 60_000;
test.describe.configure({ mode: 'serial', timeout: 5 * MINUTOS });

/** La sucursal de este proyecto. Devoto la usan los casos de sólo lectura. */
function sucursalDe(proyecto: string): string {
  return proyecto === 'iphone' ? 'PUEYRREDON' : 'SAN_MARTIN';
}

function tarjetaDe(page: Page, codigo: string) {
  return page.locator(`[data-prueba="sucursal"][data-sucursal="${codigo}"]`);
}

async function captura(page: Page, nombre: string, proyecto: string) {
  await page.screenshot({ path: `test-results/capturas/${nombre}-${proyecto}.png`, fullPage: true });
}

/** Abre el borrador de la sucursal del proyecto, preparándolo si hace falta. */
async function abrirBorrador(page: Page, proyecto: string) {
  await page.goto('/stock-erp/aperturas');
  const tarjeta = tarjetaDe(page, sucursalDe(proyecto));
  const preparar = tarjeta.locator('[data-prueba="preparar"]');
  if (await preparar.isVisible().catch(() => false)) {
    await preparar.click();
    /*
     * Se espera el ENLACE a la apertura, no el mensaje de «listo».
     *
     * La acción revalida la ruta, así que apenas termina el servidor vuelve a
     * dibujar la tarjeta por la otra rama —la de una sucursal que YA tiene
     * sesión— y el aviso de resultado desaparece con el formulario que lo
     * mostraba. Esperarlo era esperar algo que el éxito mismo borra.
     */
    await expect(tarjeta.locator('[data-prueba="abrir-apertura"]')).toBeVisible();
  }
  await tarjetaDe(page, sucursalDe(proyecto)).locator('[data-prueba="abrir-apertura"]').click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Apertura de');
}

/* ========================================================================== */

test.describe('una sucursal sin apertura lo dice', () => {
  test('el aviso está, y explica por qué eso no es cero', async ({ page }, info) => {
    await ingresar(page, 'admin');
    await page.goto('/stock-erp/aperturas');

    await expect(page.locator('[data-prueba="stock-erp-en-preparacion"]')).toContainText(
      'todavía no incluye ventas',
    );
    const devoto = tarjetaDe(page, 'DEVOTO').locator('[data-prueba="sin-apertura"]');
    await expect(devoto).toBeVisible();
    await expect(devoto).toContainText('Sucursal sin apertura de Stock ERP');
    await expect(devoto).toContainText('no es lo mismo que tener cero');

    await captura(page, 'sucursal-sin-apertura', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('el interruptor de aperturas reales se ve, y está apagado', async ({ page }) => {
    await ingresar(page, 'admin');
    await page.goto('/stock-erp/aperturas');
    const i = page.locator('[data-prueba="interruptor"]');
    await expect(i).toContainText('deshabilitadas');
    await expect(i).toContainText('base de pruebas');
  });

});

test.describe('preparar y contar', () => {
  test('el borrador nace con todo sin contar, y los impedimentos se ven', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    await abrirBorrador(page, info.project.name);

    await expect(page.locator('[data-prueba="linea"]').first()).toBeVisible();
    await expect(page.locator('[data-prueba="impedimentos"]')).toBeVisible();
    await expect(page.locator('[data-prueba="impedimento"]').first()).toContainText(
      /sin contar|unidad|corte/i,
    );

    await captura(page, 'borrador-con-estados', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('el administrador puede contar, pero no confirmar', async ({ page }, info) => {
    /*
     * La línea exacta, que me equivoqué al escribir la primera vez: «preparar»
     * NO es un permiso sensible y sí viene en el rol administrador, porque
     * contar es el trabajo de todos los días. El que no viene —ni se hereda—
     * es «confirmar», que es el acto que escribe el libro.
     *
     * Y la prueba no prepara nada de Devoto: la primera versión lo hacía y
     * rompía el caso «sucursal sin apertura» del OTRO proyecto, que necesita
     * una sucursal que nadie haya tocado. Acá se mira el borrador que ya existe.
     */
    await ingresar(page, 'configurador');
    await abrirBorrador(page, info.project.name);
    const url = page.url();

    /*
     * Se limpia la sesión antes de entrar como otro usuario. Sin esto,
     * `/ingresar` redirige a quien ya tiene sesión y el campo «Correo» no
     * aparece nunca: la prueba se quedaba esperando cinco minutos un formulario
     * que la aplicación tenía razón en no mostrar.
     */
    await page.context().clearCookies();
    await ingresar(page, 'admin');
    await page.goto(url);
    await expect(page.locator('[data-prueba="guardar-conteo"]').first()).toBeVisible();
    await expect(page.locator('[data-prueba="confirmar"]')).toHaveCount(0);
  });

  test('un artículo sin unidad aprobada aparece bloqueado y no ofrece contar', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    await abrirBorrador(page, info.project.name);

    await page.locator('[data-prueba="filtro-BLOQUEADO_UNIDAD"]').click();
    const bloqueada = page.locator('[data-prueba="linea"]').first();
    await expect(bloqueada).toBeVisible();
    await expect(bloqueada.locator('[data-prueba="estado-linea"]')).toHaveText('BLOQUEADO_UNIDAD');
    await expect(bloqueada.locator('[data-prueba="bloqueado-unidad"]')).toContainText(
      'no se sabría en qué',
    );
    await expect(bloqueada.locator('[data-prueba="guardar-conteo"]')).toHaveCount(0);

    await captura(page, 'bloqueado-por-unidad', info.project.name);
  });

  test('«contado en cero» es su propio gesto: escribir 0 no alcanza', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    await abrirBorrador(page, info.project.name);
    await page.locator('[data-prueba="filtro-PENDIENTE"]').click();

    const linea = page.locator('[data-prueba="linea"]').first();
    await expect(linea.locator('[data-prueba="contar-en-cero"]')).toBeVisible();

    await linea.locator('[data-prueba="entrada-cantidad"]').fill('0');
    await linea.locator('[data-prueba="guardar-conteo"]').click();
    await expect(page.locator('[data-prueba="resultado-error"]')).toContainText('Contado en cero');
  });

  test('un cuarto decimal se rechaza en castellano', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    await abrirBorrador(page, info.project.name);
    await page.locator('[data-prueba="filtro-PENDIENTE"]').click();

    const linea = page.locator('[data-prueba="linea"]').first();
    await linea.locator('[data-prueba="entrada-cantidad"]').fill('4.2401');
    await linea.locator('[data-prueba="guardar-conteo"]').click();
    await expect(page.locator('[data-prueba="resultado-error"]')).toContainText('tres decimales');
  });
});

test.describe('la confirmación', () => {
  test('pide dos veces, muestra el resumen y deja la apertura confirmada', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    await abrirBorrador(page, info.project.name);

    /*
     * Se resuelve todo lo que bloquea. Se cuenta uno de verdad y otro en cero
     * —para que la apertura tenga las dos clases de movimiento— y el resto se
     * marca como no manejado, que es lo que haría alguien que inaugura un local
     * con un catálogo más grande que su góndola.
     */
    await page.locator('[data-prueba="filtro-PENDIENTE"]').click();
    const primera = page.locator('[data-prueba="linea"]').first();
    await primera.locator('[data-prueba="entrada-cantidad"]').fill('12.5');
    await primera.locator('[data-prueba="guardar-conteo"]').click();
    await expect(page.locator('[data-prueba="resultado-ok"]')).toBeVisible();

    await page.reload();
    await page.locator('[data-prueba="filtro-PENDIENTE"]').click();
    const segunda = page.locator('[data-prueba="linea"]').first();
    await segunda.locator('[data-prueba="contar-en-cero"]').click();
    await expect(page.locator('[data-prueba="resultado-ok"]')).toBeVisible();

    /* Lo que quede pendiente o bloqueado: no se maneja. */
    for (const filtro of ['PENDIENTE', 'BLOQUEADO_UNIDAD']) {
      for (let vuelta = 0; vuelta < 40; vuelta += 1) {
        await page.reload();
        await page.locator(`[data-prueba="filtro-${filtro}"]`).click();
        const linea = page.locator('[data-prueba="linea"]').first();
        if ((await linea.count()) === 0) break;
        await linea.locator('[data-prueba="no-se-maneja"]').click();
        await linea.locator('[data-prueba="motivo-no-se-maneja"]').fill('Homologación: no se maneja.');
        await linea.getByRole('button', { name: 'Guardar' }).click();
        await expect(page.locator('[data-prueba="resultado-ok"]')).toBeVisible();
      }
    }

    /* El corte, en hora argentina. */
    await page.reload();
    await page.locator('[data-prueba="corte-fecha"]').fill('2026-09-23');
    await page.locator('[data-prueba="corte-hora"]').fill('20:30');
    await page.locator('[data-prueba="fijar-corte"]').click();
    await expect(page.locator('[data-prueba="resultado-ok"]')).toBeVisible();
    await page.reload();
    await expect(page.locator('[data-prueba="corte-actual"]')).toContainText('hora de Argentina');

    /* Primer clic: sólo pregunta. */
    await page.locator('[data-prueba="confirmar"]').click();
    const doble = page.locator('[data-prueba="doble-confirmacion"]');
    await expect(doble).toBeVisible();
    await expect(doble).toContainText('no se deshace');
    await captura(page, 'doble-confirmacion', info.project.name);

    await page.locator('[data-prueba="cancelar-confirmacion"]').click();
    await expect(doble).toHaveCount(0);

    /* Segundo intento, hasta el final. */
    await page.locator('[data-prueba="confirmar"]').click();
    await page.locator('[data-prueba="confirmar-definitivo"]').click();
    await expect(page.locator('[data-prueba="resultado-ok"]')).toContainText('Apertura confirmada');

    await page.reload();
    await expect(page.locator('[data-prueba="apertura-confirmada"]')).toBeVisible();
    /* Y ya no se puede contar: la apertura es irreversible. */
    await expect(page.locator('[data-prueba="guardar-conteo"]')).toHaveCount(0);

    await captura(page, 'apertura-confirmada', info.project.name);
    await sinScrollHorizontal(page);
  });
});

test.describe('la pantalla de unidades de la fase 2 sigue en pie', () => {
  test('se ve y deja su captura', async ({ page }, info) => {
    await ingresar(page, 'admin');
    await page.goto('/stock-erp/unidades');
    await expect(page.locator('[data-prueba="stock-erp-en-preparacion"]')).toBeVisible();
    await captura(page, 'unidades-fase-2', info.project.name);
    await sinScrollHorizontal(page);
  });
});
