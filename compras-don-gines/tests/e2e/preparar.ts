/**
 * globalSetup de Playwright: siembra la base antes de cada corrida.
 *
 * Sin esto las pruebas quedarían acopladas entre sí, porque una que confirma un
 * pago cambia lo que ven las siguientes. Con la siembra en cada corrida, cada
 * `playwright test` arranca de un estado conocido.
 *
 * Carga `.env.e2e` antes de que se construya el cliente de Prisma (que sembrar()
 * crea recién al ejecutarse), y se niega a seguir si la
 * base no parece de pruebas: la siembra empieza por un TRUNCATE, y ese comando
 * apuntado a la base equivocada borra el trabajo de la fiambrería.
 */
import { cargarEntornoE2E } from './entorno';
import { sembrar } from './sembrar';

export default async function globalSetup() {
  // Carga .env.e2e y verifica contra qué base apunta antes de truncar nada.
  cargarEntornoE2E();
  await sembrar();
}
