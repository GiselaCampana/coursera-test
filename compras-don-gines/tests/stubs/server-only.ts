/**
 * Reemplazo de `server-only` para las pruebas.
 *
 * El paquete real tira una excepción al importarse fuera de un entorno de
 * servidor de React, que es justamente lo que queremos que pase en el build de
 * Next. En vitest los servicios corren directamente en Node, así que acá no
 * tiene nada que hacer.
 */
export {};
