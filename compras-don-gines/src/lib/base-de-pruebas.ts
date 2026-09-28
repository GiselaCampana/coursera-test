/**
 * **La guarda que separa una base de pruebas de una de verdad.**
 *
 * El sembrado empieza con un TRUNCATE de casi todas las tablas. Eso está bien
 * en una base de pruebas y es una catástrofe en cualquier otra, y desde que la
 * vista previa hospedada lo corre en cada arranque, el comando ya no lo
 * escribe una persona mirando contra qué base apunta: lo ejecuta un servicio
 * con la variable que tenga cargada.
 *
 * Por eso la condición se comprueba acá, antes de escribir, y no se confía en
 * que el entorno esté bien configurado.
 *
 * Mira el **nombre de la base**, no la URL entera: una URL puede tener la
 * palabra «test» en el usuario, en el host o en el nombre del proyecto y
 * apuntar igual a producción.
 */

const NOMBRES_DE_PRUEBA = /(^|[-_])(e2e|test|demo)([-_]|$)/i;

export function nombreDeLaBase(url: string): string | null {
  try {
    return new URL(url).pathname.replace(/^\//, '') || null;
  } catch {
    return null;
  }
}

export function esUnaBaseDePruebas(url: string | undefined): boolean {
  const nombre = nombreDeLaBase(url ?? '');
  return nombre !== null && NOMBRES_DE_PRUEBA.test(nombre);
}

/**
 * **Descartable** es más estrecho que «de pruebas»: excluye la demo.
 *
 * `esUnaBaseDePruebas` acepta «demo» porque hay cosas que la demo sí puede
 * hacer: mostrar datos de homologación, aceptar una apertura ficticia. Pero la
 * demo es un entorno DESPLEGADO, con gente mirándolo, y hay operaciones que no
 * se corren ahí ni por error: correr el sembrado productivo, por ejemplo, que
 * empieza borrando tablas.
 *
 * Una base descartable es la que se puede tirar y volver a crear sin que nadie
 * se entere: la de pruebas de integración y la de end to end. Nada más.
 */
const NOMBRES_DESCARTABLES = /(^|[-_])(e2e|test)([-_]|$)/i;

export function esUnaBaseDescartable(url: string | undefined): boolean {
  const nombre = nombreDeLaBase(url ?? '');
  return nombre !== null && NOMBRES_DESCARTABLES.test(nombre);
}

/**
 * **Homologación** es la tercera categoría, y es exactamente una base: la demo.
 *
 * Existe porque la vista previa hospedada vuelve al estado conocido en cada
 * arranque, y para eso corre un sembrado que empieza con un TRUNCATE. Eso es
 * legítimo ahí —la demo no tiene un solo dato real y su gracia es volver sola al
 * punto de partida— y es inaceptable en cualquier otro lado.
 *
 * No acepta «test» ni «e2e» a propósito, aunque truncarlas sería inofensivo: así
 * cada punto de entrada nombra **una** clase de base, y leer el comando dice
 * contra qué corre. Para ensayar el sembrado sin la demo está la entrada de las
 * end to end, que hace lo mismo contra una base descartable.
 */
const NOMBRES_DE_HOMOLOGACION = /(^|[-_])demo([-_]|$)/i;

export function esUnaBaseDeHomologacion(url: string | undefined): boolean {
  const nombre = nombreDeLaBase(url ?? '');
  return nombre !== null && NOMBRES_DE_HOMOLOGACION.test(nombre);
}

export function exigirBaseDeHomologacion(url = process.env.DATABASE_URL): void {
  if (esUnaBaseDeHomologacion(url)) return;
  throw new Error(
    'Esto corre el sembrado de homologación y borra tablas: sólo se permite contra la base de ' +
      'la DEMO, cuyo nombre tiene que contener "demo". Para una base descartable de pruebas está ' +
      'la entrada de las end to end. No se escribió nada. ' +
      `Base vista: ${nombreDeLaBase(url ?? '') ?? '(ninguna: DATABASE_URL no está definida)'}`,
  );
}

/**
 * Corta la ejecución si la base no es descartable.
 *
 * La usa lo que destruye de verdad: correr el sembrado productivo dentro de una
 * prueba, por ejemplo. Mira el NOMBRE de la base, igual que su hermana, porque
 * una URL puede llevar la palabra «test» en el usuario, en el host o en el
 * nombre del proyecto y apuntar a producción lo mismo.
 */
export function exigirBaseDescartable(url = process.env.DATABASE_URL): void {
  if (esUnaBaseDescartable(url)) return;
  throw new Error(
    'Esto corre el sembrado y borra tablas: sólo se permite contra una base DESCARTABLE, ' +
      'cuyo nombre contenga "test" o "e2e". La demo no cuenta: está desplegada. ' +
      'No se escribió nada. ' +
      `Base vista: ${nombreDeLaBase(url ?? '') ?? '(ninguna: DATABASE_URL no está definida)'}`,
  );
}

/**
 * Corta la ejecución si la base no es de pruebas.
 *
 * Lanza en vez de avisar: lo que sigue borra tablas, y un aviso que nadie lee
 * no evita nada.
 */
export function exigirBaseDePruebas(url = process.env.DATABASE_URL): void {
  if (esUnaBaseDePruebas(url)) return;

  /*
   * Se nombra la base que se vio, y sólo la base: decir «no es de pruebas» sin
   * decir cuál miró deja a quien lo corre adivinando, y la URL entera lleva la
   * contraseña.
   */
  throw new Error(
    'Esto borra tablas y sólo corre contra una base de pruebas: el nombre tiene que ' +
      'contener "e2e", "test" o "demo". No se escribió nada. ' +
      `Base vista: ${nombreDeLaBase(url ?? '') ?? '(ninguna: DATABASE_URL no está definida)'}`,
  );
}
