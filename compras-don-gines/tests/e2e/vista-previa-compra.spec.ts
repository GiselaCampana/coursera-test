import { test, expect, type Page } from '@playwright/test';
import { ingresar, sinScrollHorizontal, tamanoTactil } from './ayudas';
import { EZRA_ENCABEZADO } from '../fixtures/ezra';

/**
 * La vista previa de la compra, abierta como la abre una persona.
 *
 * Lo que se comprueba acá no es el cálculo —de eso se ocupan las pruebas de
 * integración— sino que la pantalla exista, se llegue desde el comprobante y
 * muestre separadas las dos cosas que se van a escribir: el egreso que se paga
 * y la mercadería que entra.
 *
 * Se mira la compra de Ezra, que es la que tiene los seis renglones del papel,
 * en sus dos versiones: la que se puede aplicar y la que está frenada porque
 * un renglón no se pudo asociar. Sin las dos no se ve lo único que importa de
 * esta pantalla, que es la diferencia entre poder y no poder.
 *
 * Y se mira en el teléfono, porque es donde se usa: una tabla de seis renglones
 * y cuatro importes en 390 píxeles de ancho es exactamente donde una pantalla
 * se rompe.
 */
const MINUTOS = 60_000;
test.describe.configure({ timeout: 4 * MINUTOS });

/** La factura completa: seis renglones asociados, total impreso. */
const COMPLETA = '00000185';

/*
 * Las fechas se derivan de la emisión del encabezado leído, no se escriben a
 * mano: un literal acá es una copia más de la fecha, y una copia que puede
 * dejar de coincidir sin que la prueba lo note.
 */
const EMISION = EZRA_ENCABEZADO.issueDate;

/** Suma días a una fecha ISO sin pasar por el huso local. */
function sumarDias(iso: string, dias: number): string {
  const [anio, mes, dia] = iso.split('-').map(Number);
  const d = new Date(Date.UTC(anio, mes - 1, dia));
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** "2026-09-09" => "09/09/2026", como lo escribe la pantalla. */
function comoSeLee(iso: string): string {
  const [anio, mes, dia] = iso.split('-');
  return `${dia}/${mes}/${anio}`;
}
/** La frenada: la bolsa sin código legible y el total sin imprimir. */
const FRENADA = '00000186';

/**
 * Abre el comprobante desde el listado y de ahí la vista previa.
 *
 * Se entra por donde entra una persona —el listado, el comprobante, el
 * enlace— y no por la URL directa: el enlace es parte de lo que hay que
 * comprobar que existe.
 */
async function abrirLaVistaPrevia(page: Page, numero: string) {
  await page.goto('/comprobantes');
  await page.locator('a.fila-dato', { hasText: numero }).first().click();
  await expect(page).toHaveURL(/\/comprobantes\/[^/]+$/);

  await page.getByRole('link', { name: /Ver la vista previa de la compra/ }).click();
  await expect(page).toHaveURL(/\/vista-previa$/);
  await expect(page.getByRole('heading', { name: 'Vista previa de la compra' })).toBeVisible();
}

test.describe('la vista previa de la compra', () => {
  test('se abre desde el comprobante y separa el egreso del stock', async ({ page }) => {
    await ingresar(page, 'admin');
    await abrirLaVistaPrevia(page, COMPLETA);

    await expect(page.getByText('Nada de lo que se ve acá está guardado')).toBeVisible();

    // Las dos escrituras, cada una en su recuadro.
    await expect(page.getByRole('heading', { name: 'Egreso' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Impacto previsto en Stock ERP — módulo todavía no activado' })).toBeVisible();

    // Y el emisor, los renglones y el pie.
    await expect(page.getByRole('heading', { name: 'Emisor' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Renglones' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Pie fiscal' })).toBeVisible();
  });

  test('la factura de Ezra muestra sus seis renglones y el egreso impreso', async ({ page }) => {
    await ingresar(page, 'admin');
    await abrirLaVistaPrevia(page, COMPLETA);

    await expect(page.getByText('Distribuidora Ezra').first()).toBeVisible();
    await expect(page.locator('tbody tr')).toHaveCount(6);

    /*
     * El sexto renglón: tres bolsas que Ezra cobra para transportar la compra.
     * Se pagan con la factura y no entran al stock, así que tienen que verse
     * —en unidades, no en kilos— y verse APARTE de la mercadería.
     */
    // En la tabla: el renglón está, en unidades, y dicho que no mueve stock.
    const renglonDeLaBolsa = page.locator('tbody tr', { hasText: 'BOLSA GRANDE' });
    await expect(renglonDeLaBolsa).toHaveCount(1);
    await expect(renglonDeLaBolsa).toContainText('3,000 unidades');
    await expect(renglonDeLaBolsa).toContainText('sin impacto en stock');

    // Y en el recuadro del stock, en su propia lista y no entre la mercadería.
    const recuadroDeStock = page.locator('section.card', { hasText: 'Impacto previsto en Stock ERP — módulo todavía no activado' }).last();
    await expect(
      recuadroDeStock.getByRole('heading', { name: 'Sin impacto en stock' }),
    ).toBeVisible();
    const gastos = recuadroDeStock.locator('ul.lista-simple').last();
    await expect(gastos.locator('li')).toHaveCount(1);
    await expect(gastos).toContainText('3,000 unidades');
    await expect(gastos).toContainText('Bolsas del transporte');

    // La mercadería son cinco, no seis: la bolsa no entra a la heladera.
    await expect(recuadroDeStock.locator('ul.lista-simple').first().locator('li')).toHaveCount(5);

    // El egreso, por el total que dice el papel.
    await expect(page.getByText('$ 267.880,50').first()).toBeVisible();

    // Y la condición, que Ezra no tiene configurada.
    await expect(page.getByText('a definir al aplicar').first()).toBeVisible();

    /*
     * Y por eso no se puede aplicar todavía: hay que elegir cómo se paga.
     * Antes el botón estaba habilitado y al apretarlo la compra se agendaba
     * sola, con el vencimiento en la fecha de emisión y «Transferencia».
     */
    await expect(page.getByRole('heading', { name: 'Cómo se paga' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Aplicar la compra' })).toBeDisabled();
  });

  test('hay que elegir cómo se paga, y nada viene marcado', async ({ page }) => {
    await ingresar(page, 'admin');
    await abrirLaVistaPrevia(page, COMPLETA);

    const forma = page.getByLabel('Forma de pago');
    const condicion = page.getByLabel('Condición');
    const boton = page.getByRole('button', { name: 'Aplicar la compra' });

    // Nada preseleccionado: ni la forma ni la condición.
    await expect(forma).toHaveValue('');
    await expect(condicion).toHaveValue('');
    await expect(boton).toBeDisabled();

    // Con la forma sola tampoco alcanza.
    await forma.selectOption('EFECTIVO');
    await expect(boton).toBeDisabled();

    // Y a los días hay que decirle cuántos.
    await condicion.selectOption('DIAS');
    await expect(boton).toBeDisabled();
    await page.getByLabel('Días').fill('30');
    await expect(boton).toBeEnabled();

    /*
     * Y dice qué día cae, antes de aplicar: a 30 días de la emisión. Sin este
     * eco se elige el plazo a ciegas, y lo que después se mira en Pagos es la
     * fecha, no el plazo.
     */
    const calculado = page.locator('[data-prueba="vencimiento-calculado"]');
    await expect(calculado).toContainText(comoSeLee(sumarDias(EMISION, 30)));

    // El encabezado y el cálculo hablan de la misma emisión: si la pantalla
    // mostrara un día y calculara sobre otro, esto lo agarra.
    await expect(page.getByText(comoSeLee(EMISION)).first()).toBeVisible();

    // El día anterior a la emisión se rechaza en la pantalla, no recién al
    // aplicar, y con la misma cuenta que usa el servidor.
    await condicion.selectOption('FECHA');
    await page.getByLabel('Fecha de vencimiento').fill(sumarDias(EMISION, -1));
    await expect(page.getByText(/no puede ser anterior a la emisión/)).toBeVisible();
    await expect(boton).toBeDisabled();

    // El mismo día de emisión sí se acepta: una factura puede vencer el día
    // que se emite, y medir contra hoy rechazaría facturas viejas legítimas.
    await page.getByLabel('Fecha de vencimiento').fill(EMISION);
    await expect(calculado).toContainText(comoSeLee(EMISION));
    await expect(boton).toBeEnabled();
  });

  /* ----------------------------------------------------------------------- */

  test('los avisos dicen lo que falta ahora, no lo que faltaba al abrir', async ({ page }) => {
    /*
     * Los dos avisos se armaban en el servidor y quedaban congelados en el
     * estado inicial: el recuadro amarillo seguía diciendo «todavía no se puede
     * aplicar» con el botón ya habilitado, y el texto de abajo seguía pidiendo
     * la forma y la condición cuando las dos estaban elegidas y lo único mal
     * era la fecha. Un aviso que no corresponde al estado enseña a no leer los
     * avisos, y después no se lee el que sí importa.
     */
    await ingresar(page, 'admin');
    await abrirLaVistaPrevia(page, COMPLETA);

    const forma = page.getByLabel('Forma de pago');
    const condicion = page.getByLabel('Condición');
    const boton = page.getByRole('button', { name: 'Aplicar la compra' });
    const frenos = page.locator('[data-prueba="frenos"]');
    const falta = page.locator('[data-prueba="lo-que-falta"]');

    // Al abrir: faltan las dos, y el aviso las nombra a las dos.
    await expect(frenos).toBeVisible();
    await expect(falta).toHaveText('Elegí la forma de pago y la condición para poder aplicar.');

    // Sólo la condición elegida: el aviso pide sólo la forma.
    await condicion.selectOption('CONTADO');
    await expect(falta).toHaveText('Elegí la forma de pago para poder aplicar.');
    await expect(boton).toBeDisabled();

    // Sólo la forma elegida: el aviso pide sólo la condición.
    await condicion.selectOption('');
    await forma.selectOption('EFECTIVO');
    await expect(falta).toHaveText('Elegí la condición para poder aplicar.');
    await expect(boton).toBeDisabled();

    // Faltan los días, y lo dice con ese nombre.
    await condicion.selectOption('DIAS');
    await expect(falta).toHaveText('Escribí a cuántos días vence para poder aplicar.');

    // Faltan la fecha puntual, ídem.
    await condicion.selectOption('FECHA');
    await expect(falta).toHaveText('Elegí la fecha de vencimiento para poder aplicar.');

    /*
     * Fecha inválida: el error rojo del dominio queda tal cual, el de abajo
     * nombra el impedimento real, y en ningún lado se afirma que falten
     * selecciones que ya están hechas.
     */
    await page.getByLabel('Fecha de vencimiento').fill(sumarDias(EMISION, -1));
    await expect(page.locator('[data-prueba="decision-invalida"]')).toContainText(
      /no puede ser anterior a la emisión/,
    );
    await expect(falta).toHaveText('Corregí el vencimiento antes de aplicar.');
    await expect(page.getByText('Elegí la forma de pago y la condición')).toHaveCount(0);
    await expect(boton).toBeDisabled();
    // El freno sigue en pie mientras el pago no esté resuelto.
    await expect(frenos).toBeVisible();

    /*
     * Y con todo válido no queda ningún aviso de bloqueo. Ni el amarillo, ni
     * el de abajo: el botón habilitado ya lo dice.
     */
    await page.getByLabel('Fecha de vencimiento').fill(EMISION);
    await expect(boton).toBeEnabled();
    await expect(frenos).toHaveCount(0);
    await expect(page.getByText('Todavía no se puede aplicar')).toHaveCount(0);
    await expect(falta).toHaveCount(0);

    /*
     * Volver atrás a una opción incompleta tiene que revivir los avisos en el
     * acto: si sólo aparecieran al abrir la pantalla, el botón quedaría
     * habilitado sobre una decisión que ya no existe.
     */
    await condicion.selectOption('');
    await expect(boton).toBeDisabled();
    await expect(frenos).toBeVisible();
    await expect(falta).toHaveText('Elegí la condición para poder aplicar.');
  });

  test('un plazo imposible se nombra como plazo, no como vencimiento', async ({ page }) => {
    await ingresar(page, 'admin');
    await abrirLaVistaPrevia(page, COMPLETA);

    await page.getByLabel('Forma de pago').selectOption('CHEQUE');
    await page.getByLabel('Condición').selectOption('DIAS');
    await page.getByLabel('Días').fill('400');

    await expect(page.locator('[data-prueba="decision-invalida"]')).toContainText(/entre 1 y 365/);
    await expect(page.locator('[data-prueba="lo-que-falta"]')).toHaveText(
      'Corregí el plazo antes de aplicar.',
    );
    await expect(page.getByRole('button', { name: 'Aplicar la compra' })).toBeDisabled();
  });

  test('en la factura frenada, elegir cómo se paga no alcanza', async ({ page }) => {
    /*
     * El freno del pago se levanta eligiendo; los otros dos no. Si la pantalla
     * los tratara a todos igual, una decisión de pago válida habilitaría el
     * botón sobre un comprobante con un renglón sin asociar y el total sin
     * imprimir, y el rechazo llegaría recién del servidor.
     */
    await ingresar(page, 'admin');
    await abrirLaVistaPrevia(page, FRENADA);

    await page.getByLabel('Forma de pago').selectOption('EFECTIVO');
    await page.getByLabel('Condición').selectOption('CONTADO');

    // El cálculo del vencimiento sí se muestra: esa parte está resuelta.
    await expect(page.locator('[data-prueba="vencimiento-calculado"]')).toBeVisible();

    // Pero el botón sigue bloqueado y los otros dos frenos siguen a la vista.
    await expect(page.getByRole('button', { name: 'Aplicar la compra' })).toBeDisabled();
    const frenos = page.locator('[data-prueba="frenos"] li');
    await expect(frenos).toHaveCount(2);
    await expect(page.getByText(/BOLSA GRANDE.*no está asociado/)).toBeVisible();
    await expect(page.getByText(/El total no está impreso/)).toBeVisible();
    await expect(page.locator('[data-prueba="lo-que-falta"]')).toHaveText(
      'Resolvé lo de arriba y volvé a abrir esta pantalla.',
    );
  });

  test('el stock dice que es un ingreso, a qué sucursal y con qué PLU', async ({ page }) => {
    /*
     * Una compra hace ENTRAR mercadería. La pantalla lo dice con todas las
     * letras porque el error que hay que hacer imposible es el contrario:
     * mandarla como egreso vacía el depósito de Control de Stock con números
     * que parecen correctos, y nadie lo nota hasta que falta la mercadería.
     */
    await ingresar(page, 'admin');
    await abrirLaVistaPrevia(page, COMPLETA);

    const recuadro = page.locator('section.card', { hasText: 'Impacto previsto en Stock ERP — módulo todavía no activado' }).last();
    await expect(recuadro).toContainText('Ingreso por compra');
    await expect(recuadro).not.toContainText(/Egreso por compra|Salida|Venta/);

    // La sucursal de destino, nombrada: no hay ninguna por omisión.
    await expect(recuadro).toContainText('Devoto');

    /*
     * Y el PLU de cada artículo, que es la identidad por la que se resuelve.
     * Nunca el nombre: dos artículos del catálogo pueden llamarse casi igual y
     * costar la mitad uno del otro.
     */
    const mercaderia = recuadro.locator('ul.lista-simple').first();
    await expect(mercaderia.locator('li')).toHaveCount(5);
    for (const li of await mercaderia.locator('li').all()) {
      await expect(li).toContainText(/PLU \d+/);
    }

    // La bolsa sigue aparte, en unidades y sin impacto.
    const gastos = recuadro.locator('ul.lista-simple').last();
    await expect(gastos.locator('li')).toHaveCount(1);
    await expect(gastos).toContainText('3,000 unidades');
    await expect(gastos).not.toContainText('PLU');
  });

  test('la llamada directa al POST también se rechaza', async ({ page }) => {
    /*
     * Que la pantalla frene no alcanza: el endpoint se puede llamar solo. Sin
     * decisión de pago tiene que contestar un error y no escribir nada.
     */
    await ingresar(page, 'admin');
    await page.goto('/comprobantes');
    await page.locator('a.fila-dato', { hasText: COMPLETA }).first().click();
    await expect(page).toHaveURL(/\/comprobantes\/[^/]+$/);
    const id = page.url().split('/').pop();

    /*
     * Se llama desde adentro de la página para que viaje la sesión: es el
     * escenario que importa, alguien con sesión válida saltándose la pantalla.
     */
    const respuesta = await page.evaluate(async (documentId) => {
      const r = await fetch(`/api/comprobantes/${documentId}/vista-previa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      return { ok: r.ok, estado: r.status, cuerpo: await r.text() };
    }, id);

    expect(respuesta.ok).toBe(false);
    expect(respuesta.cuerpo).toMatch(/condición de pago|forma de pago/i);

    // Y el comprobante sigue sin validar: la pantalla lo diría.
    await page.reload();
    await expect(page.getByRole('link', { name: /Ver la vista previa de la compra/ })).toBeVisible();
  });

  test('la factura frenada dice por qué, y no deja aplicar', async ({ page }) => {
    await ingresar(page, 'admin');
    await abrirLaVistaPrevia(page, FRENADA);

    await expect(page.getByText('Todavía no se puede aplicar:')).toBeVisible();
    await expect(page.getByText(/BOLSA GRANDE.*no está asociado/)).toBeVisible();
    await expect(page.getByText(/El total no está impreso/)).toBeVisible();

    // El renglón no desapareció por no poder asociarse.
    await expect(page.locator('tbody tr')).toHaveCount(6);

    await expect(page.getByRole('button', { name: 'Aplicar la compra' })).toBeDisabled();
  });

  /* ----------------------------------------------------------------------- */

  test('entra en la pantalla del teléfono, con la tabla desplazable', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone', 'Es la comprobación del teléfono.');
    await ingresar(page, 'admin');
    await abrirLaVistaPrevia(page, COMPLETA);

    // Nada se desborda a lo ancho: es el defecto que arruina una pantalla en
    // el teléfono, porque empuja todo el cuerpo y aparece el scroll lateral.
    await sinScrollHorizontal(page);

    /*
     * La tabla de renglones no cabe en 390 píxeles y no tiene por qué caber:
     * lo que tiene que pasar es que se desplace **ella**, dentro de su caja, en
     * vez de estirar la página. Se comprueba que el contenido es más ancho que
     * la caja y que la caja está preparada para desplazarlo.
     */
    const tabla = page.locator('.tabla-scroll').first();
    const desplazable = await tabla.evaluate((caja) => ({
      contenido: caja.scrollWidth,
      visible: caja.clientWidth,
      overflow: getComputedStyle(caja).overflowX,
    }));
    expect(desplazable.contenido).toBeGreaterThan(desplazable.visible);
    expect(['auto', 'scroll']).toContain(desplazable.overflow);

    // El egreso y la mercadería quedan usables: los dos visibles y enteros.
    for (const titulo of ['Egreso', 'Impacto previsto en Stock ERP — módulo todavía no activado']) {
      const seccion = page.locator('section.card', { hasText: titulo }).last();
      await expect(seccion).toBeVisible();
      const caja = await seccion.boundingBox();
      expect(caja!.width).toBeLessThanOrEqual(testInfo.project.use.viewport!.width);
    }

    // El gasto sin impacto en stock también se lee entero en la pantalla angosta.
    const gastos = page
      .locator('section.card', { hasText: 'Impacto previsto en Stock ERP — módulo todavía no activado' })
      .last()
      .locator('ul.lista-simple')
      .last();
    await expect(gastos.getByText('3,000 unidades')).toBeVisible();
    const cortado = await gastos
      .locator('li')
      .first()
      .evaluate((li) => li.scrollWidth > li.clientWidth + 1);
    expect(cortado).toBe(false);

    // El formulario de cómo se paga entra en la pantalla angosta y es usable.
    await expect(page.getByRole('heading', { name: 'Cómo se paga' })).toBeVisible();
    await expect(page.getByLabel('Forma de pago')).toHaveValue('');
    await tamanoTactil(page, 'select#forma-de-pago');

    // Y el botón se puede tocar con el pulgar.
    await expect(page.getByRole('button', { name: 'Aplicar la compra' })).toBeVisible();
    await tamanoTactil(page, 'button.boton');
  });

  test('en el teléfono los frenos se leen enteros y el botón queda bloqueado', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone', 'Es la comprobación del teléfono.');
    await ingresar(page, 'admin');
    await abrirLaVistaPrevia(page, FRENADA);

    await sinScrollHorizontal(page);

    /*
     * Los frenos son texto largo en una pantalla angosta: lo que hay que
     * comprobar es que se vean completos, envueltos, y no cortados por el
     * costado. Un freno que se lee a medias no explica nada.
     */
    const frenos = page.locator('.mensaje-aviso .lista-simple li');
    // Tres: la bolsa sin asociar, el total sin imprimir y cómo se paga.
    await expect(frenos).toHaveCount(3);
    for (const freno of await frenos.all()) {
      await expect(freno).toBeVisible();
      const cortado = await freno.evaluate((li) => li.scrollWidth > li.clientWidth + 1);
      expect(cortado).toBe(false);
    }

    const boton = page.getByRole('button', { name: 'Aplicar la compra' });
    await expect(boton).toBeVisible();
    await expect(boton).toBeDisabled();
  });
});
