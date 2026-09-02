/**
 * Direcciones a las que la aplicación no se conecta, pase lo que pase.
 *
 * Existe por el camino de respaldo con DNS-over-HTTPS. Ese camino resuelve un
 * nombre por su cuenta y después abre TLS contra la IP que le contestaron, y
 * ahí está el riesgo: quien controle esa respuesta —o un dominio que apunte a
 * donde quiera— puede hacer que el servidor de Compras se conecte a una
 * dirección de la red interna de Render y traiga de vuelta lo que encuentre.
 *
 * Es la contracara del arreglo: resolver a mano el nombre saltea la protección
 * que da resolverlo normalmente, así que hay que reponerla a mano.
 */

/** Rangos que nunca son un servicio público de internet. */
export function esDireccionPrivada(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if ([a, Number(v4[2]), Number(v4[3]), Number(v4[4])].some((n) => n > 255)) return true;
    if (a === 10) return true; // 10.0.0.0/8, privada
    if (a === 127) return true; // bucle local
    if (a === 0) return true; // "esta red"
    if (a === 169 && b === 254) return true; // enlace local, y los metadatos de la nube
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10, CGNAT
    if (a === 192 && b === 0) return true; // 192.0.0.0/24 y 192.0.2.0/24
    if (a >= 224) return true; // multicast y reservadas
    return false;
  }

  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  if (v6.startsWith('fe80')) return true; // enlace local
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // única local
  if (v6.startsWith('ff')) return true; // multicast
  // ::ffff:10.0.0.1 y demás direcciones v4 disfrazadas de v6.
  const embebida = v6.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (embebida) return esDireccionPrivada(embebida[1]);
  return false;
}

/** Una IPv4 con forma de tal. Lo que no lo sea no se usa para conectarse. */
export function pareceIpv4(valor: string): boolean {
  const partes = valor.split('.');
  if (partes.length !== 4) return false;
  return partes.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}
