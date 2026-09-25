import { test, expect, type Page } from '@playwright/test';
import { ingresar, sinScrollHorizontal } from './ayudas';
import { prisma } from '../../src/lib/db';

/**
 * **Las pantallas de consulta de Stock ERP, en los dos tamaños.**
 *
 * Lo que se prueba acá son las reglas que se VEN, y todas dicen lo mismo desde
 * ángulos distintos: **una ausencia de dato no es un cero**. Una sucursal sin
 * apertura, un artículo que la sucursal no maneja y un artículo sin unidad
 * aprobada son tres cosas distintas, y ninguna es cero. Un conteo confirmado en
 * cero sí es cero, y se dice.
 *
 * También: que el libro no se reescriba para quedar prolijo. Un movimiento
 * retroactivo se marca y se explica; no se reordena ni se recalcula.
 *
 * CADA PROYECTO TRABAJA SOBRE SU PROPIA SUCURSAL, igual que en las fases 3 y 4.
 * Acá casi todo es de lectura y no habría interferencia, pero la vista de
 * divergencia altera un saldo a propósito, y eso sí se pisaría entre proyectos.
 *
 * Deja capturas en `test-results/capturas/`.
 */

const MINUTOS = 60_000;
test.describe.configure({ mode: 'serial', timeout: 5 * MINUTOS });

function sucursalDe(proyecto: string): string {
  return proyecto === 'iphone' ? 'Recepciones (teléfono)' : 'Recepciones (escritorio)';
}
function codigoDe(proyecto: string): string {
  return proyecto === 'iphone' ? 'RECEP_IPHONE' : 'RECEP_ESCRITORIO';
}

async function captura(page: Page, nombre: string, proyecto: string) {
  await page.screenshot({ path: `test-results/capturas/${nombre}-${proyecto}.png`, fullPage: true });
}

/** Abre una pantalla filtrada por la sucursal del proyecto. */
async function abrir(page: Page, ruta: string, proyecto: string, extra = '') {
  const sucursal = await prisma.branch.findFirstOrThrow({
    where: { code: codigoDe(proyecto) },
    select: { id: true },
  });
  await page.goto(`${ruta}?sucursal=${sucursal.id}${extra}`);
  return sucursal.id;
}

/* ========================================================================== */

test.describe('el tablero de existencias', () => {
  test('cada situación se explica, y ninguna ausencia se muestra como cero', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    await abrir(page, '/stock-erp/existencias', info.project.name);

    await expect(page.locator('[data-prueba="stock-erp-en-preparacion"]')).toContainText(
      'los saldos todavía no incluyen ventas',
    );
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Existencias');

    /* Hay artículos con saldo y al menos uno en cero confirmado. */
    await expect(page.locator('[data-prueba="fila"][data-estado="CON_SALDO"]').first()).toBeVisible();
    const cero = page.locator('[data-prueba="fila"][data-estado="CERO_CONFIRMADO"]').first();
    await expect(cero).toBeVisible();
    await expect(cero.locator('[data-prueba="cantidad"]')).toHaveText('0');
    await expect(cero.locator('[data-prueba="explicacion"]')).toContainText('no había');

    /* Y los que no tienen saldo dicen eso, sin escribir un cero. */
    const noManejado = page.locator('[data-prueba="fila"][data-estado="NO_SE_MANEJA"]').first();
    await expect(noManejado).toBeVisible();
    await expect(noManejado.locator('[data-prueba="sin-numero"]')).toContainText(
      'sin saldo que mostrar',
    );
    await expect(noManejado.locator('[data-prueba="cantidad"]')).toHaveCount(0);

    await captura(page, 'existencias-tablero', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('los totales van separados por unidad y no hay un total único', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    await abrir(page, '/stock-erp/existencias', info.project.name);

    await expect(page.locator('[data-prueba="aviso-unidades"]')).toContainText(
      'separados por unidad',
    );
    const totales = page.locator('[data-prueba="total-unidad"]');
    await expect(totales.first()).toBeVisible();
    /* Cada total dice de qué unidad es. */
    for (const t of await totales.all()) {
      const unidad = await t.getAttribute('data-unidad');
      expect(unidad, 'todo total dice su unidad').toBeTruthy();
    }
  });

  test('una sucursal sin apertura lo dice, y no aparece en cero', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    const devoto = await prisma.branch.findFirstOrThrow({ where: { code: 'DEVOTO' } });
    await page.goto(`/stock-erp/existencias?sucursal=${devoto.id}`);

    await expect(page.locator('[data-prueba="aviso-sin-apertura"]')).toContainText(
      'no están en cero',
    );
    const filas = page.locator('[data-prueba="fila"][data-estado="SUCURSAL_SIN_APERTURA"]');
    await expect(filas.first()).toBeVisible();
    await expect(filas.first().locator('[data-prueba="explicacion"]')).toContainText('sin contar');
    /* Ni una fila de Devoto muestra un número. */
    await expect(
      page.locator('[data-prueba="fila"] [data-prueba="cantidad"]'),
      'sin apertura no hay ningún número',
    ).toHaveCount(0);
    /* Y el resumen no cuenta ningún cero confirmado. */
    await expect(page.locator('[data-prueba="resumen-estado"][data-estado="CERO_CONFIRMADO"]')).toHaveCount(0);

    await captura(page, 'existencias-sin-apertura', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('el cero confirmado se puede aislar con el filtro', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    await abrir(page, '/stock-erp/existencias', info.project.name, '&estado=CERO_CONFIRMADO');

    const filas = page.locator('[data-prueba="fila"]');
    await expect(filas.first()).toBeVisible();
    for (const f of await filas.all()) {
      expect(await f.getAttribute('data-estado')).toBe('CERO_CONFIRMADO');
    }
    await captura(page, 'existencias-cero-confirmado', info.project.name);
    await sinScrollHorizontal(page);
  });
});

test.describe('el historial del libro', () => {
  test('explica las dos líneas de tiempo y muestra el saldo por registración', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    await abrir(page, '/stock-erp/movimientos', info.project.name);

    await expect(page.locator('[data-prueba="explica-tiempos"]')).toContainText('dos momentos');
    await expect(page.locator('[data-prueba="explica-tiempos"]')).toContainText(
      'orden de registración',
    );

    const movimientos = page.locator('[data-prueba="movimiento"]');
    await expect(movimientos.first()).toBeVisible();
    const primero = movimientos.first();
    await expect(primero.locator('[data-prueba="seq"]')).toContainText('#');
    await expect(primero.locator('[data-prueba="efectiva"]')).toContainText('hora de Argentina');
    await expect(primero.locator('[data-prueba="registrado"]')).toContainText('hora de Argentina');
    await expect(primero.locator('[data-prueba="saldo-posterior"]')).toBeVisible();

    await captura(page, 'movimientos-historial', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('un movimiento retroactivo se marca y se explica, sin reordenar el libro', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    await abrir(page, '/stock-erp/movimientos', info.project.name, '&tipo=PURCHASE_IN');

    /* El aviso general de la pantalla. */
    await expect(page.locator('[data-prueba="aviso-retroactivo"]')).toContainText('retroactivos');

    const retro = page.locator('[data-prueba="movimiento"][data-retroactivo="si"]').first();
    await expect(retro).toBeVisible();
    await expect(retro.locator('[data-prueba="marca-retroactivo"]')).toContainText(
      'orden de registración',
    );

    /*
     * La prueba de que NO se reordenó: el libro sigue en orden de secuencia
     * descendente, así que el retroactivo —que tiene la secuencia más alta—
     * aparece ARRIBA del que pasó después que él.
     */
    const seqs = await page.locator('[data-prueba="movimiento"]').evaluateAll((nodos) =>
      nodos.map((n) => Number(n.getAttribute('data-seq'))),
    );
    const ordenado = [...seqs].sort((a, b) => b - a);
    expect(seqs, 'el libro se muestra en su orden de registración').toEqual(ordenado);

    await captura(page, 'movimientos-retroactivo', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('el recorrido cronológico es otra pregunta, y lo dice', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    const sucursalId = await prisma.branch
      .findFirstOrThrow({ where: { code: codigoDe(info.project.name) }, select: { id: true } })
      .then((b) => b.id);
    /* El artículo que tiene los dos ingresos. */
    const mov = await prisma.stockLedger.findFirstOrThrow({
      where: { branchId: sucursalId, type: 'PURCHASE_IN' },
      select: { productId: true },
    });

    await page.goto(
      `/stock-erp/movimientos?sucursal=${sucursalId}&producto=${mov.productId}&cronologico=si`,
    );

    const bloque = page.locator('[data-prueba="bloque-cronologico"]');
    await expect(bloque).toContainText('fecha efectiva');
    await expect(bloque).toContainText('desempate');
    await expect(bloque.locator('[data-prueba="paso-cronologico"]').first()).toBeVisible();

    /* Y donde las dos líneas difieren, lo dice en vez de esconderlo. */
    await expect(bloque.locator('[data-prueba="no-coincide"]').first()).toContainText(
      'orden de registración',
    );
    await sinScrollHorizontal(page);
  });

  test('los enlaces al comprobante y a la operación llevan a algún lado', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    await abrir(page, '/stock-erp/movimientos', info.project.name, '&tipo=PURCHASE_IN');

    const enlace = page.locator('[data-prueba="enlace-comprobante"]').first();
    await expect(enlace).toBeVisible();
    await enlace.click();

    /*
     * Se espera la URL, no un encabezado.
     *
     * La primera versión esperaba `h1` y después miraba la URL, y pasaba sin
     * probar nada: la pantalla de movimientos TAMBIÉN tiene un `h1`, así que la
     * espera se cumplía al instante y la URL todavía era la de origen. Una
     * espera que se satisface con lo que ya estaba en pantalla no espera nada.
     */
    await page.waitForURL(/\/comprobantes\/.+/);
    /* Y llega al comprobante de verdad, no a un 404. */
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Factura');
  });
});

test.describe('la auditoría', () => {
  test('muestra los asientos del módulo y no ofrece modificarlos', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    await page.goto('/stock-erp/auditoria');

    await expect(page.locator('[data-prueba="solo-lectura"]')).toContainText('sólo lee');
    await expect(page.locator('[data-prueba="asiento"]').first()).toBeVisible();

    /* Ningún control de escritura en toda la pantalla. */
    await expect(page.locator('main button[type="submit"]:not([data-prueba="aplicar"])')).toHaveCount(0);
    await expect(page.locator('main form[method="post"]')).toHaveCount(0);

    await captura(page, 'auditoria', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('el filtro por acción acota los asientos', async ({ page }) => {
    await ingresar(page, 'configurador');
    await page.goto('/stock-erp/auditoria?accion=stockerp.apertura_confirmada');

    const asientos = page.locator('[data-prueba="asiento"]');
    await expect(asientos.first()).toBeVisible();
    for (const a of await asientos.all()) {
      expect(await a.getAttribute('data-accion')).toBe('stockerp.apertura_confirmada');
    }
  });
});

test.describe('el diagnóstico de integridad', () => {
  test('cuando coincide lo dice, con el momento de la comprobación', async ({ page }, info) => {
    await ingresar(page, 'configurador');
    await abrir(page, '/stock-erp/integridad', info.project.name);

    await expect(page.locator('[data-prueba="detecta-no-repara"]')).toContainText(
      'Detecta y no repara',
    );
    const ok = page.locator('[data-prueba="coincide"]');
    await expect(ok).toContainText('coincide con el libro');
    await expect(ok.locator('[data-prueba="comprobado-el"]')).toContainText('hora de Argentina');
    await expect(page.locator('[data-prueba="divergencia"]')).toHaveCount(0);

    await captura(page, 'integridad-correcta', info.project.name);
    await sinScrollHorizontal(page);
  });

  test('una divergencia se muestra con los dos números por separado, y no se repara', async ({
    page,
  }, info) => {
    await ingresar(page, 'configurador');
    const sucursalId = await prisma.branch
      .findFirstOrThrow({ where: { code: codigoDe(info.project.name) }, select: { id: true } })
      .then((b) => b.id);

    /*
     * Se altera un saldo por debajo, salteando el disparador, que es lo que
     * haría un script de corrección corrido de madrugada. Después se repone: una
     * prueba que deja la base torcida arruina a las que siguen.
     */
    const saldo = await prisma.stockBalance.findFirstOrThrow({
      where: { branchId: sucursalId, quantity: { gt: 0 } },
      select: { id: true, quantity: true },
    });
    const original = saldo.quantity.toString();

    await prisma.$executeRawUnsafe(
      `ALTER TABLE "stock_balance" DISABLE TRIGGER "stock_balance_respaldado"`,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE "stock_balance" SET "quantity" = 999 WHERE "id" = $1`,
      saldo.id,
    );
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "stock_balance" ENABLE TRIGGER "stock_balance_respaldado"`,
    );

    try {
      await page.goto(`/stock-erp/integridad?sucursal=${sucursalId}`);

      await expect(page.locator('[data-prueba="no-coincide"]')).toContainText('No se corrigió nada');
      const div = page.locator('[data-prueba="divergencia"][data-clase="SALDO_NO_COINCIDE"]').first();
      await expect(div).toBeVisible();
      /* Los dos valores, nombrados y separados. */
      await expect(div.locator('[data-prueba="segun-saldo"]')).toHaveText('999');
      await expect(div.locator('[data-prueba="segun-libro"]')).toHaveText(original);
      await expect(page.locator('[data-prueba="sin-boton-reparar"]')).toContainText(
        'no ofrece ninguna acción',
      );

      await captura(page, 'integridad-divergencia', info.project.name);
      await sinScrollHorizontal(page);

      /* Recargar no la arregla: la pantalla mira y no toca. */
      await page.reload();
      await expect(
        page.locator('[data-prueba="divergencia"][data-clase="SALDO_NO_COINCIDE"]').first(),
      ).toBeVisible();
      const despues = await prisma.stockBalance.findUniqueOrThrow({ where: { id: saldo.id } });
      expect(despues.quantity.toString(), 'nadie la reparó').toBe('999');
    } finally {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "stock_balance" DISABLE TRIGGER "stock_balance_respaldado"`,
      );
      await prisma.$executeRawUnsafe(
        `UPDATE "stock_balance" SET "quantity" = $1::numeric WHERE "id" = $2`,
        original,
        saldo.id,
      );
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "stock_balance" ENABLE TRIGGER "stock_balance_respaldado"`,
      );
    }
  });
});

test.describe('los permisos de lectura', () => {
  test('el administrador de fábrica sí puede consultar: son permisos no sensibles', async ({
    page,
    context,
  }, info) => {
    await context.clearCookies();
    await ingresar(page, 'admin');
    await abrir(page, '/stock-erp/existencias', info.project.name);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Existencias');
    await expect(page.locator('[data-prueba="sin-permiso"]')).toHaveCount(0);
  });

  test('y las pantallas de consulta no ofrecen ninguna acción de escritura', async ({ page }, info) => {
    await ingresar(page, 'admin');
    for (const ruta of [
      '/stock-erp/existencias',
      '/stock-erp/movimientos',
      '/stock-erp/auditoria',
      '/stock-erp/integridad',
    ]) {
      await abrir(page, ruta, info.project.name);
      /* Los únicos formularios son de filtro, y van por GET. */
      const formularios = page.locator('main form');
      for (const f of await formularios.all()) {
        const metodo = (await f.getAttribute('method')) ?? 'get';
        expect(metodo.toLowerCase(), `${ruta}: todo formulario es GET`).toBe('get');
      }
      await sinScrollHorizontal(page);
    }
  });
});
