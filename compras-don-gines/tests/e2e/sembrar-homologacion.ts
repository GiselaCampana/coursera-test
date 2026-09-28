/**
 * **El sembrado de la vista previa hospedada.**
 *
 * La demo vuelve al estado conocido en cada arranque: es una demostración, y
 * conviene que después de que alguien aplique la compra de ejemplo vuelva sola a
 * tener esa compra sin aplicar. Para eso su `startCommand` corre este archivo.
 *
 * Es una entrada de dos líneas y existe por una razón concreta: los datos son los
 * mismos que usan las pruebas, pero la base NO. El sembrado de las pruebas exige
 * una base descartable —«test» o «e2e»— y rechaza la demo a propósito, porque la
 * demo está desplegada y vaciarla no es un accidente de laboratorio. Esta entrada
 * exige lo contrario: una base cuyo nombre contenga «demo», y ninguna otra.
 *
 * Así el comando que corre el servicio dice contra qué base corre, y ninguna
 * variable de entorno puede hacer que uno haga el trabajo del otro.
 *
 * **No lleva ningún dato real**, igual que el de las pruebas: sucursales y
 * artículos inventados, aperturas ficticias y los cuatro interruptores reales
 * apagados.
 */
import { sembrarParaHomologacion } from './sembrar';

sembrarParaHomologacion().catch((error) => {
  console.error(error);
  process.exit(1);
});
