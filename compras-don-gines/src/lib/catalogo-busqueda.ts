/**
 * Búsqueda dentro del catálogo Don Ginés, tal como se usa mientras se revisa
 * una factura.
 *
 * Vive fuera de la pantalla —y sin `server-only`— porque es la regla de qué
 * encuentra cada búsqueda, no una cuestión de presentación: se puede probar
 * sola y valdría igual si mañana se buscara desde otro lado.
 */

export interface ProductoBuscable {
  id: string;
  /** El PLU, o el código de barras cuando el artículo no usa PLU. */
  codigo: string;
  nombre: string;
  /** Los códigos con que los proveedores facturan este mismo artículo. */
  codigosDeProveedor?: string[];
}

/** Sin tildes, sin mayúsculas y sin puntuación: como se busca de verdad. */
export function paraBuscar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Los productos que quedan al escribir en el buscador de un renglón.
 *
 * Busca en el PLU, en el nombre y en los códigos con que los proveedores
 * facturan el artículo, que son las tres cosas que uno tiene a mano mirando el
 * papel. Cada palabra tiene que aparecer en alguna parte, así "sardo melin"
 * encuentra "Queso Sardo bloque Melincué" sin obligar a escribirlo entero ni a
 * acertarle al orden.
 *
 * El que ya está elegido se deja siempre en la lista. Si se filtrara, escribir
 * en el buscador dejaría el desplegable apuntando a una opción que ya no
 * existe y la asociación se perdería sin que nadie la tocara: el peor error
 * posible en esta pantalla es el que no se ve.
 */
export function filtrarCatalogo<T extends ProductoBuscable>(
  productos: T[],
  busqueda: string | undefined | null,
  elegido?: string | null,
): T[] {
  const palabras = paraBuscar(busqueda ?? '')
    .split(' ')
    .filter(Boolean);
  if (palabras.length === 0) return productos;

  return productos.filter((p) => {
    if (elegido && p.id === elegido) return true;
    const donde = paraBuscar([p.codigo, p.nombre, ...(p.codigosDeProveedor ?? [])].join(' '));
    return palabras.every((palabra) => donde.includes(palabra));
  });
}
