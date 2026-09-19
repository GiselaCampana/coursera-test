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
