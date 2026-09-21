/**
 * **El envío de movimientos a Control de Stock está retirado.**
 *
 * El diseño de mandar los ingresos de una compra a la aplicación externa quedó
 * cancelado: el stock pasa a ser un módulo adentro de Compras. Mientras ese
 * módulo no esté activado, esta versión no escribe existencias en ningún lado.
 *
 * **Por qué es una constante del código y no una variable de entorno.** Un
 * interruptor por entorno se puede prender sin querer —una variable copiada de
 * otro servicio, un panel de Render con un campo viejo, un `.env` heredado— y
 * lo que volvería a prenderse es justamente lo que se decidió retirar. La
 * pregunta «¿está retirada la escritura?» no depende de la configuración de la
 * máquina, así que no se le pregunta a la máquina. Cargar o borrar
 * `STOCK_INTEGRATION_WRITE_URL` no cambia nada de lo que pasa acá.
 *
 * **Lo que NO hace este archivo.** No borra la bandeja, ni el transporte, ni
 * sus pruebas, ni el permiso `stock.sincronizar`. Eso es una etapa aparte, a
 * propósito: mezclarla con esta entrega haría que un mismo commit retire una
 * función y elimine la evidencia de cómo funcionaba.
 *
 * La lectura del catálogo es otra cosa y sigue viva: usa `STOCK_CATALOG_URL`
 * con `STOCK_INTEGRATION_KEY`, sólo consulta, y no la toca este retiro.
 */

/** Único lugar donde se decide. Ponerlo en `false` revive el camino viejo. */
export const ESCRITURA_A_CONTROL_DE_STOCK_RETIRADA = true;

/** El texto que ve quien llame a la puerta vieja. */
export const MOTIVO_DEL_RETIRO =
  'La integración de escritura con Control de Stock está retirada. ' +
  'Esta versión registra costos, deuda y pagos, y no modifica existencias en ningún sistema.';

/**
 * ¿Hay que anotar el ingreso en la bandeja al aplicar una compra?
 *
 * Se consulta adentro de la transacción de la compra. Con la escritura
 * retirada, aplicar no crea ni una fila de `StockOutbox`: no quedan pendientes
 * que alguien pueda despachar más adelante por otra puerta.
 */
export function seAnotanIngresosEnLaBandeja(): boolean {
  return !ESCRITURA_A_CONTROL_DE_STOCK_RETIRADA;
}

/**
 * ¿Se puede despachar a Control de Stock?
 *
 * Lo consulta la acción vieja **antes de tocar la base y antes de abrir
 * ninguna conexión**. No alcanza con esconder el botón: esconder un control es
 * comodidad, no defensa, y quien llame a la acción directamente tiene que
 * encontrar lo mismo.
 */
export function sePuedeDespacharAControlDeStock(): boolean {
  return !ESCRITURA_A_CONTROL_DE_STOCK_RETIRADA;
}
