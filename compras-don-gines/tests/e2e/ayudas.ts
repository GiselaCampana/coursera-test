import { expect, type Page } from '@playwright/test';

export const CREDENCIALES = {
  admin: { email: 'admin@e2e.local', password: 'PruebasDonGines1' },
  operador: { email: 'devoto@e2e.local', password: 'PruebasDonGines1' },
};

export async function ingresar(page: Page, quien: 'admin' | 'operador' = 'admin') {
  const { email, password } = CREDENCIALES[quien];
  await page.goto('/ingresar');
  await page.getByLabel('Correo').fill(email);
  await page.getByLabel('Contraseña').fill(password);
  await page.getByRole('button', { name: 'Ingresar' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Hola');
}

/**
 * Comprueba que la página no se desborda a lo ancho.
 *
 * Es el defecto más común en móvil: una tabla o un número largo empujan el
 * cuerpo y aparece el scroll horizontal.
 */
export async function sinScrollHorizontal(page: Page) {
  const desborde = await page.evaluate(() => {
    const doc = document.documentElement;
    return {
      scroll: doc.scrollWidth,
      cliente: doc.clientWidth,
    };
  });
  expect(
    desborde.scroll,
    `La página se desborda a lo ancho: ${desborde.scroll}px contra ${desborde.cliente}px de pantalla.`,
  ).toBeLessThanOrEqual(desborde.cliente + 1);
}

/** Verifica que un control se pueda tocar cómodamente con el pulgar. */
export async function tamanoTactil(page: Page, selector: string, minimo = 44) {
  const caja = await page.locator(selector).first().boundingBox();
  expect(caja, `No se encontró ${selector}`).not.toBeNull();
  expect(caja!.height, `${selector} mide ${caja!.height}px de alto`).toBeGreaterThanOrEqual(minimo);
}

/**
 * Marca una prueba que modifica datos para que corra en un solo proyecto.
 *
 * Los dos proyectos (iPhone y escritorio) comparten la misma base, y la siembra
 * ocurre una vez por corrida. Si una prueba que confirma un pago corriera en
 * los dos, la segunda encontraría el pago ya confirmado.
 */
export function soloEnIphone(test: { skip: (condicion: boolean, motivo: string) => void }, nombreProyecto: string) {
  test.skip(
    nombreProyecto !== 'iphone',
    'Modifica datos compartidos: corre sólo en el proyecto iphone.',
  );
}

/**
 * Elige una opción de un `<select>` por una parte de su texto.
 *
 * `selectOption({ label })` exige el texto completo y exacto, así que cualquier
 * cambio de presentación —agregarle el PLU adelante al nombre del artículo, por
 * ejemplo— rompe la prueba sin que haya cambiado nada de lo que la prueba
 * quiere comprobar. Acá se busca por lo que identifica a la opción y se
 * selecciona por su valor, que es lo que el formulario manda de verdad.
 */
export async function elegirOpcion(page: Page, selector: string, texto: string | RegExp) {
  const opcion = page.locator(`${selector} option`).filter({ hasText: texto }).first();
  await expect(opcion, `No hay ninguna opción con «${texto}» en ${selector}`).toHaveCount(1);
  const valor = await opcion.getAttribute('value');
  await page.locator(selector).selectOption(valor ?? '');
}
