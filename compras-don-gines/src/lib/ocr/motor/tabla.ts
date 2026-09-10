import {
  esFilaDeEncabezados,
  reconocerColumnas,
  type ColumnaReconocida,
} from '@/lib/ocr/motor/columnas';

/**
 * Dónde empieza y termina cada columna de la tabla.
 *
 * El motor general no puede contar columnas: en cuanto el OCR mete un tramo de
 * basura entre dos celdas, el conteo se corre y todo lo que sigue queda mal.
 * Lo que sí se conserva sobre una foto es **la posición horizontal**, porque el
 * lector corre Tesseract con `preserve_interword_spaces`, y eso hace que la
 * cantidad de espacios de cada línea sea proporcional a lo que hay impreso.
 *
 * Así que las columnas se delimitan por **desplazamiento de caracteres** dentro
 * de la línea, tomando la fila de títulos como regla. Es la reconstrucción
 * espacial que el motor necesita, con el dato que hoy llega del lector: no hace
 * falta cambiar el contrato con el navegador para tenerla.
 *
 * Lo que esto NO resuelve, y conviene tenerlo escrito: cuando el OCR pone un
 * número en la **fila** equivocada —como pasa en la factura de Lácteos Barraza,
 * donde el precio del segundo renglón aparece al final de la línea del
 * primero— ninguna delimitación horizontal lo arregla. Eso lo resuelve la
 * aritmética, más adelante en la cadena.
 */

/** Una celda, con el tramo de línea del que salió. */
export interface Celda {
  texto: string;
  /** Desplazamiento donde empieza, en caracteres de la línea. */
  desde: number;
  /** Desplazamiento donde termina. */
  hasta: number;
}

/**
 * Un tramo de texto con su posición dentro de la línea.
 *
 * El separador natural de columnas es una tanda de dos o más espacios: es lo que
 * mantiene junta una descripción de varias palabras. Con `finos`, en cambio,
 * cada palabra es un tramo.
 *
 * Hacen falta los dos porque **la fila de títulos y las de datos se separan
 * distinto**. En la factura de Distribuidora Ezra los títulos van con un solo
 * espacio entre ellos —«P.Unit Desc.% P.U.Desc. Importe»— y con la partición
 * ancha quedan los cuatro en una sola celda; los renglones, en cambio, tienen
 * descripciones de varias palabras que la partición fina rompería.
 */
function tramos(linea: string, finos = false): Celda[] {
  if (finos) {
    const salida: Celda[] = [];
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(linea)) !== null) {
      salida.push({ texto: m[0], desde: m.index, hasta: m.index + m[0].length });
    }
    return salida;
  }
  return tramosAnchos(linea);
}

function tramosAnchos(linea: string): Celda[] {
  const salida: Celda[] = [];
  const re = /\S+(?:[ ]\S+)*?(?=[ ]{2,}|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(linea)) !== null) {
    if (m[0].trim() === '') continue;
    salida.push({ texto: m[0], desde: m.index, hasta: m.index + m[0].length });
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return salida;
}

export interface FilaDeTitulos {
  /** El índice de la línea dentro del texto. */
  linea: number;
  /** Los títulos, con su posición. */
  celdas: Celda[];
  /** Qué campo es cada uno. */
  columnas: (ColumnaReconocida | null)[];
}

/**
 * Encuentra la fila de títulos de la tabla.
 *
 * Se recorre el texto buscando la primera línea que reconozca al menos tres
 * campos distintos. Tres y no dos: con dos, un artículo que se llame «CAJA
 * PRECIO ESPECIAL» se haría pasar por encabezado y la tabla arrancaría en el
 * lugar equivocado.
 *
 * Devuelve null cuando no la encuentra, y eso no es un fallo del motor sino un
 * resultado: sin fila de títulos no hay forma de saber qué es cada columna, y
 * el comprobante va a revisión de estructura en vez de interpretarse a ciegas.
 */
export function encontrarFilaDeTitulos(texto: string): FilaDeTitulos | null {
  const lineas = texto.split('\n');

  for (let i = 0; i < lineas.length; i++) {
    /*
     * Se prueban las dos particiones y gana la que entienda más.
     *
     * Es la primera aparición de la idea que atraviesa todo el motor: cuando el
     * texto admite más de una lectura, se generan las dos y decide un criterio
     * objetivo, en vez de elegir una convención y esperar que todos los
     * proveedores la respeten.
     *
     * El criterio acá es cuántos campos distintos se reconocen; a igualdad,
     * gana la que deje menos celdas sin reconocer. Sobre las cinco facturas del
     * banco eso elige la partición fina para Ezra —ocho campos contra cuatro— y
     * la ancha para Barraza, donde las dos reconocen siete pero la fina parte
     * «Pr Unit» al medio.
     */
    let mejor: FilaDeTitulos | null = null;
    let mejorPuntaje = -1;

    for (const finos of [false, true]) {
      const celdas = tramos(lineas[i], finos);
      if (celdas.length < 3) continue;
      const textos = celdas.map((c) => c.texto);
      if (!esFilaDeEncabezados(textos)) continue;

      const columnas = reconocerColumnas(textos);
      const reconocidos = new Set(
        columnas.filter((c) => c && c.campo !== 'ignorada').map((c) => c!.campo),
      ).size;
      const sinReconocer = columnas.filter((c) => c === null).length;
      // Campos entendidos primero; a igualdad, menos celdas sueltas.
      const puntaje = reconocidos * 100 - sinReconocer;

      if (puntaje > mejorPuntaje) {
        mejorPuntaje = puntaje;
        mejor = { linea: i, celdas, columnas };
      }
    }

    if (mejor) return mejor;
  }
  return null;
}

export interface Limite {
  desde: number;
  hasta: number;
}

/**
 * Los límites de cada columna.
 *
 * Con la fila de títulos sola, cada columna se queda con el espacio que va
 * desde la mitad del hueco anterior hasta la mitad del hueco siguiente.
 * Repartir el hueco por la mitad —en vez de cortar en el borde del título—
 * tolera que las celdas estén corridas unos caracteres respecto del título, que
 * es lo normal cuando la columna se alinea a la derecha.
 *
 * Pero **la fila de títulos no es una buena regla para medir los datos**, y
 * ésta es una de las cosas que rompió la factura de Distribuidora Ezra: los
 * cuatro títulos de la derecha van pegados —«P.Unit Desc.% P.U.Desc. Importe»,
 * con un espacio entre cada uno— mientras las cuatro columnas de números están
 * bien separadas y más a la derecha. Medido con el título, el precio de lista y
 * el porcentaje de descuento caen en la misma columna y se leen como un solo
 * número: «6.000,000 5,000» sale 60000005.
 *
 * Cuando se le pasan las líneas de datos, entonces, los límites salen de
 * **ellas**: los canales verticales que están en blanco en todas las líneas a la
 * vez son los separadores reales de la tabla, y el título sólo dice cómo se
 * llama cada uno. Es más confiable porque son varias líneas de acuerdo entre
 * sí, contra una sola del encabezado.
 */
export function limitesDeColumnas(celdas: Celda[], lineas: string[] = []): Limite[] {
  const porElTitulo = limitesPorMitades(celdas);
  const bloques = bloquesDeDatos(lineas);
  if (bloques.length === 0 || celdas.length === 0) return porElTitulo;

  /*
   * Cada bloque de datos se anota en la columna cuyo título tiene más cerca.
   *
   * Se reparten los bloques entre las columnas y no al revés para que ninguno
   * quede afuera: un bloque de más —una descripción que por casualidad dejó un
   * canal en el medio— se suma al de al lado en vez de perderse, y un bloque de
   * menos simplemente deja a esa columna con los límites del título.
   */
  const territorios: Limite[][] = celdas.map(() => []);
  for (const bloque of bloques) {
    territorios[columnaMasCercana(celdas, bloque)].push(bloque);
  }

  const salida = celdas.map((_, i) => {
    const mios = territorios[i];
    if (mios.length === 0) return porElTitulo[i];
    return {
      desde: Math.min(...mios.map((b) => b.desde)),
      hasta: Math.max(...mios.map((b) => b.hasta)),
    };
  });

  // Los bordes se abren: lo que quede a la izquierda de la primera columna o a
  // la derecha de la última es de ellas, no un sobrante.
  if (salida.length > 0) {
    salida[0] = { desde: 0, hasta: salida[0].hasta };
    salida[salida.length - 1] = {
      desde: salida[salida.length - 1].desde,
      hasta: Number.MAX_SAFE_INTEGER,
    };
  }
  return salida;
}

function limitesPorMitades(celdas: Celda[]): Limite[] {
  return celdas.map((celda, i) => {
    const anterior = celdas[i - 1];
    const siguiente = celdas[i + 1];
    const desde = anterior ? Math.ceil((anterior.hasta + celda.desde) / 2) : 0;
    const hasta = siguiente
      ? Math.floor((celda.hasta + siguiente.desde) / 2)
      : Number.MAX_SAFE_INTEGER;
    return { desde, hasta };
  });
}

/**
 * Los tramos de ancho que ocupan los datos, separados por canales verticales.
 *
 * Un canal es un desplazamiento que está en blanco en **todas** las líneas de
 * datos a la vez. Se piden dos caracteres seguidos: con uno solo, el espacio
 * que separa dos palabras de una descripción cortaría la columna en dos si por
 * casualidad cae en el mismo lugar en todas las filas.
 */
function bloquesDeDatos(lineas: string[]): Limite[] {
  const utiles = lineas.filter((l) => l.trim() !== '');
  if (utiles.length === 0) return [];

  const ancho = Math.max(...utiles.map((l) => l.length));
  const bloques: Limite[] = [];
  let inicio: number | null = null;
  let blancosSeguidos = 0;

  for (let x = 0; x <= ancho; x++) {
    const blanco = x === ancho || utiles.every((l) => (l[x] ?? ' ') === ' ');
    if (blanco) {
      blancosSeguidos += 1;
      if (inicio !== null && (blancosSeguidos >= 2 || x === ancho)) {
        bloques.push({ desde: inicio, hasta: x - blancosSeguidos + 1 });
        inicio = null;
      }
    } else {
      if (inicio === null) inicio = x;
      blancosSeguidos = 0;
    }
  }

  return bloques;
}

/** La columna cuyo título está más cerca de un tramo de datos. */
function columnaMasCercana(celdas: Celda[], bloque: Limite): number {
  let mejor = 0;
  let mejorSolape = -1;
  let mejorDistancia = Infinity;

  celdas.forEach((celda, i) => {
    const solape = Math.min(celda.hasta, bloque.hasta) - Math.max(celda.desde, bloque.desde);
    const distancia = Math.abs(
      (celda.desde + celda.hasta) / 2 - (bloque.desde + bloque.hasta) / 2,
    );
    // Primero el que se solapa más; sin solapamiento, el de centro más cercano.
    if (solape > mejorSolape || (solape === mejorSolape && distancia < mejorDistancia)) {
      mejorSolape = solape;
      mejorDistancia = distancia;
      mejor = i;
    }
  });

  return mejor;
}

/**
 * Reparte los tramos de una línea entre las columnas.
 *
 * Cada tramo va a la columna con la que **más se solapa**. Se usa el solapamiento
 * y no el punto de inicio porque una celda numérica alineada a la derecha puede
 * empezar dentro del territorio de la columna anterior y aun así ser
 * claramente de la suya.
 *
 * Un tramo que no cae en ninguna columna se devuelve aparte: es lo que sobra, y
 * saber que sobró vale más que repartirlo. En la factura de Barraza, ese
 * sobrante es el precio del renglón siguiente.
 */
export function repartirEnColumnas(
  linea: string,
  limites: { desde: number; hasta: number }[],
): { celdas: (Celda | null)[]; sobrantes: Celda[] } {
  const celdas: (Celda | null)[] = limites.map(() => null);
  const sobrantes: Celda[] = [];

  for (const tramo of tramos(linea)) {
    let mejor = -1;
    let mejorSolape = 0;
    limites.forEach((limite, i) => {
      const solape =
        Math.min(tramo.hasta, limite.hasta) - Math.max(tramo.desde, limite.desde);
      if (solape > mejorSolape) {
        mejorSolape = solape;
        mejor = i;
      }
    });

    if (mejor === -1) {
      sobrantes.push(tramo);
      continue;
    }
    /*
     * Dos tramos en la misma columna se juntan.
     *
     * Pasa con las descripciones de varias palabras separadas por dos espacios,
     * que el OCR parte: «QUESO DE MAQUINA DAMBO   LA PAULINA» son dos tramos y
     * una sola celda.
     */
    const actual = celdas[mejor];
    celdas[mejor] = actual
      ? { texto: `${actual.texto} ${tramo.texto}`, desde: actual.desde, hasta: tramo.hasta }
      : tramo;
  }

  return { celdas, sobrantes };
}

export interface FilaDeDatos {
  /** El índice de la línea dentro del texto. */
  linea: number;
  /** El texto de la línea, tal cual. */
  cruda: string;
  /** Una celda por columna de la tabla, con null donde no había nada. */
  celdas: (Celda | null)[];
  /** Lo que no entró en ninguna columna. */
  sobrantes: Celda[];
}

/**
 * Las filas de datos que hay debajo de la fila de títulos.
 *
 * Se corta al llegar al pie: el pie tiene números grandes y creíbles, y una
 * línea de subtotal repartida entre columnas se parece bastante a un renglón.
 */
const EMPIEZA_EL_PIE =
  /^\s*(sub\s?-?\s?total|total\b|neto\b|i\.?\s?v\.?\s?a\.?\b|percep|perc\b|descuentos?\s*:|saldo|total\s+kgs?|son\s+pesos|pesos\s*:)/i;

export function filasDeDatos(texto: string, titulos: FilaDeTitulos): FilaDeDatos[] {
  const lineas = texto.split('\n');

  // Primero se juntan las líneas de la tabla, porque los límites de las
  // columnas salen de ellas y no del encabezado.
  const candidatas: { linea: number; cruda: string }[] = [];
  for (let i = titulos.linea + 1; i < lineas.length; i++) {
    const linea = lineas[i];
    if (linea.trim() === '') continue;
    if (EMPIEZA_EL_PIE.test(linea)) break;
    candidatas.push({ linea: i, cruda: linea });
  }

  const limites = limitesDeColumnas(
    titulos.celdas,
    candidatas.map((c) => c.cruda),
  );

  const salida: FilaDeDatos[] = [];
  for (const { linea, cruda } of candidatas) {
    const { celdas, sobrantes } = repartirEnColumnas(cruda, limites);
    // Una línea que no llena ni dos columnas no es una fila de la tabla.
    if (celdas.filter((c) => c !== null).length < 2) continue;
    salida.push({ linea, cruda, celdas, sobrantes });
  }

  return salida;
}

/**
 * La huella de la estructura de un comprobante.
 *
 * Es lo que después va a permitir reconocer «este formato ya lo configuramos» y
 * aplicar un perfil guardado, sin volver a preguntar.
 *
 * **No lleva nada del contenido.** Ni razón social, ni CUIT, ni nombres de
 * artículos, ni cantidades, ni importes, ni resolución, ni coordenadas
 * absolutas. Sólo los encabezados normalizados, en orden, y las posiciones
 * **relativas** de las columnas expresadas como fracción del ancho de la línea.
 *
 * Que no lleve nada del contenido es lo que hace que la huella sea del
 * **formato** y no del proveedor: el mismo sistema de facturación usado por dos
 * empresas distintas produce la misma huella, y una empresa que cambia de
 * sistema produce una distinta. Es exactamente el comportamiento que hace
 * falta, y es la prueba de que esto no es un analizador específico disfrazado.
 */
export function huellaDeEstructura(titulos: FilaDeTitulos): string {
  const ancho = Math.max(...titulos.celdas.map((c) => c.hasta), 1);

  const partes = titulos.celdas.map((celda, i) => {
    const columna = titulos.columnas[i];
    // El campo reconocido, o el encabezado normalizado cuando no se reconoció:
    // un formato con una columna ambigua tiene su propia huella.
    const etiqueta = columna ? columna.campo : `?${normalizarParaHuella(celda.texto)}`;
    // La posición relativa, en décimos. Suficiente para distinguir un orden de
    // otro y tosco a propósito, para que un par de caracteres de corrimiento
    // entre dos fotos de la misma factura no cambien la huella.
    const decimo = Math.round((celda.desde / ancho) * 10);
    return `${etiqueta}@${decimo}`;
  });

  return partes.join('|');
}

/** Para la huella: sin acentos, sin puntuación, en minúsculas. */
function normalizarParaHuella(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}
