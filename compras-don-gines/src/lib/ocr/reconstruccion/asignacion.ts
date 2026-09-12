import { centroY, type Caja } from '@/lib/ocr/reconstruccion/evidencia';

/**
 * Repartir los valores de una columna entre los renglones, todos a la vez.
 *
 * Hasta acá cada valor buscaba su renglón por su cuenta: se lo daba al que
 * tuviera más cerca. Eso falla justo donde más duele, porque **las decisiones no
 * son independientes**. En la factura de Lácteos Barraza los dos importes de la
 * columna están impresos casi a la misma altura que el primer renglón, y
 * eligiendo por separado los dos se van al primero: el renglón uno queda con dos
 * importes fundidos y el dos, sin ninguno. Cada decisión, mirada sola, era la
 * mejor.
 *
 * Mirados juntos, el problema tiene una respuesta clara: los valores de una
 * columna vienen **en el mismo orden** que los renglones. El segundo importe no
 * puede ir arriba del primero por mucho que la foto esté torcida. Esa sola
 * restricción —el orden— resuelve el cruce, y es general: no sabe de Barraza ni
 * de ningún proveedor.
 *
 * Lo que se busca es la asignación de costo mínimo que cumpla las tres reglas:
 *
 *  - **monótona**: si un valor va al renglón tres, el siguiente va al tres o más
 *    abajo, nunca al dos;
 *  - **sin repetir**: un fragmento se usa en una celda o en ninguna, nunca en dos;
 *  - **uno por celda**: cada renglón se lleva a lo sumo un valor de la columna.
 *
 * Se resuelve con programación dinámica sobre (renglón, valor), que para las
 * cantidades de una factura es instantáneo y **encuentra el óptimo**, no una
 * aproximación. Y como devuelve el costo, dos asignaciones que compiten se
 * pueden comparar: si la mejor no le saca ventaja a la segunda, el comprobante
 * tiene que ir a revisión en vez de elegir una.
 */

export interface ValorPosicionado {
  texto: string;
  caja: Caja;
  pasada: string;
  confianza: number;
}

/**
 * Junta los pedazos de un mismo valor antes de repartirlo.
 *
 * La unidad que se reparte entre los renglones **no es la palabra**: es el
 * número. El OCR parte los importes —«234.997» y «69» son un solo
 * 234.997,69— y repartir los pedazos por separado manda uno a cada renglón, que
 * es peor que el problema que se venía a resolver.
 *
 * Dos pedazos son del mismo valor cuando están pegados horizontalmente y se
 * pisan en vertical. Las dos condiciones hacen falta: sin la vertical, el
 * importe de un renglón se pegaría con el del siguiente cuando la columna es
 * angosta; sin la horizontal, dos valores distintos de la misma fila se
 * fundirían.
 *
 * «Pegados» es hasta cuatro quintos de un renglón de separación. Medido sobre
 * la foto de Barraza, entre «234.997» y «69» hay medio carácter de hueco, que
 * es más de lo que uno esperaría: el OCR no corta los números donde está la
 * coma sino donde se le borronea un trazo. Con menos margen no se juntan; con
 * mucho más, la bonificación se pegaría con el importe, que están a seis
 * renglones de distancia horizontal.
 */
export function agruparPedazos<T extends ValorPosicionado>(
  valores: T[],
  alturaTipica: number,
): { texto: string; caja: Caja; partes: T[] }[] {
  const ordenados = [...valores].sort(
    (a, b) => centroY(a.caja) - centroY(b.caja) || a.caja.x0 - b.caja.x0,
  );
  const grupos: { texto: string; caja: Caja; partes: T[] }[] = [];

  for (const valor of ordenados) {
    const pegado = grupos.find((grupo) => {
      // Se pide que se pisen **la mitad** de lo alto, no que se toquen: dos
      // renglones consecutivos de una tabla apretada se rozan por los bordes.
      const solape =
        Math.min(grupo.caja.y1, valor.caja.y1) - Math.max(grupo.caja.y0, valor.caja.y0);
      const masBajo = Math.min(grupo.caja.y1 - grupo.caja.y0, valor.caja.y1 - valor.caja.y0);
      const seSuperponenEnAltura = masBajo > 0 && solape > masBajo * 0.5;
      /*
       * Tienen que estar **uno al lado del otro**, no uno encima del otro.
       *
       * Si se pisan en horizontal no son dos pedazos de un número: son dos
       * valores apilados de renglones distintos, que es justamente lo que pasa
       * cuando una columna de importes se lee como bloque vertical. Sin esta
       * condición, los dos importes de Barraza —que ocupan casi el mismo ancho—
       * se fundían en uno solo.
       */
      const separacion = Math.max(
        valor.caja.x0 - grupo.caja.x1,
        grupo.caja.x0 - valor.caja.x1,
      );
      const estanAlLado = separacion > -alturaTipica * 0.1 && separacion < alturaTipica * 0.8;
      return seSuperponenEnAltura && estanAlLado;
    });

    if (!pegado) {
      grupos.push({ texto: valor.texto, caja: { ...valor.caja }, partes: [valor] });
      continue;
    }

    pegado.partes.push(valor);
    pegado.partes.sort((a, b) => a.caja.x0 - b.caja.x0);
    const numericos = pegado.partes.every((p) => /^[\d.,%$-]+$/.test(p.texto));
    pegado.texto = pegado.partes.map((p) => p.texto).join(numericos ? '' : ' ');
    pegado.caja = {
      x0: Math.min(pegado.caja.x0, valor.caja.x0),
      y0: Math.min(pegado.caja.y0, valor.caja.y0),
      x1: Math.max(pegado.caja.x1, valor.caja.x1),
      y1: Math.max(pegado.caja.y1, valor.caja.y1),
    };
  }

  return grupos;
}

export interface FilaObjetivo {
  /** La altura de referencia del renglón, ya enderezada. */
  y: number;
}

export interface Asignacion<T> {
  /** Un valor por renglón, o null cuando ese renglón se queda sin ninguno. */
  porFila: (T | null)[];
  /** Los que no se usaron. */
  sobrantes: T[];
  /** Cuánto costó: más bajo es mejor. Sirve para comparar asignaciones. */
  costo: number;
}

/**
 * Lo que cuesta dejar un renglón sin valor, en alturas de renglón.
 *
 * Tiene que ser caro —más que cualquier distancia razonable— porque el caso que
 * esto existe para arreglar es exactamente ése: dejar el segundo renglón vacío
 * y meterle los dos importes al primero. Pero no infinito: una columna
 * legítimamente vacía en un renglón existe, y forzar un valor ahí sería peor.
 */
const COSTO_DE_FILA_VACIA = 6;

/**
 * Lo que cuesta descartar un valor.
 *
 * Más barato que dejar un renglón vacío, porque una columna junta basura del
 * OCR todo el tiempo y descartarla es lo normal. Pero no gratis: si no, la
 * asignación preferiría tirar todo.
 */
const COSTO_DE_DESCARTE = 1.5;

/**
 * Cuánto puede alejarse un valor de su renglón antes de que deje de ser suyo.
 *
 * Dos renglones y medio. Sobre una foto torcida un valor del borde derecho
 * queda casi un renglón arriba del suyo, y con un margen más chico no habría
 * manera de devolvérselo; con uno mucho más grande, un valor del pie entraría
 * como si fuera del último artículo.
 */
export const ALEJAMIENTO_MAXIMO = 2.5;

export function asignarMonotonicamente<T extends ValorPosicionado>(
  valores: T[],
  filas: FilaObjetivo[],
  alturaTipica: number,
): Asignacion<T> {
  if (filas.length === 0) return { porFila: [], sobrantes: [...valores], costo: 0 };
  if (alturaTipica <= 0) alturaTipica = 1;

  const ordenados = [...valores].sort((a, b) => centroY(a.caja) - centroY(b.caja));
  const n = filas.length;
  const m = ordenados.length;

  const distancia = (fila: number, valor: number): number =>
    Math.abs(filas[fila].y - centroY(ordenados[valor].caja)) / alturaTipica;

  /*
   * `costo[i][j]` es lo mínimo que cuesta resolver los renglones desde `i` con
   * los valores desde `j`. Se calcula de atrás hacia adelante para que cada
   * casilla dependa sólo de las ya resueltas.
   */
  const costo: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const decision: ('asignar' | 'vaciar' | 'descartar')[][] = Array.from({ length: n + 1 }, () =>
    new Array<'asignar' | 'vaciar' | 'descartar'>(m + 1).fill('vaciar'),
  );

  for (let i = n; i >= 0; i--) {
    for (let j = m; j >= 0; j--) {
      if (i === n) {
        // No quedan renglones: lo que sobre se descarta.
        costo[i][j] = (m - j) * COSTO_DE_DESCARTE;
        decision[i][j] = 'descartar';
        continue;
      }
      if (j === m) {
        // No quedan valores: los renglones que faltan quedan vacíos.
        costo[i][j] = (n - i) * COSTO_DE_FILA_VACIA;
        decision[i][j] = 'vaciar';
        continue;
      }

      const dejarVacio = COSTO_DE_FILA_VACIA + costo[i + 1][j];
      const descartar = COSTO_DE_DESCARTE + costo[i][j + 1];

      const cerca = distancia(i, j);
      const asignar =
        cerca <= ALEJAMIENTO_MAXIMO ? cerca + costo[i + 1][j + 1] : Number.POSITIVE_INFINITY;

      const mejor = Math.min(asignar, dejarVacio, descartar);
      costo[i][j] = mejor;
      decision[i][j] =
        mejor === asignar ? 'asignar' : mejor === dejarVacio ? 'vaciar' : 'descartar';
    }
  }

  // Se reconstruye el camino elegido.
  const porFila: (T | null)[] = new Array<T | null>(n).fill(null);
  const sobrantes: T[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    const que = decision[i][j];
    if (i === n) {
      sobrantes.push(ordenados[j]);
      j += 1;
      continue;
    }
    if (j === m) {
      i += 1;
      continue;
    }
    if (que === 'asignar') {
      porFila[i] = ordenados[j];
      i += 1;
      j += 1;
    } else if (que === 'vaciar') {
      i += 1;
    } else {
      sobrantes.push(ordenados[j]);
      j += 1;
    }
  }

  return { porFila, sobrantes, costo: costo[0][0] };
}

/**
 * La segunda mejor asignación, para saber si la primera gana por algo.
 *
 * Se obtiene prohibiendo, de a una, cada pareja que eligió la ganadora y
 * quedándose con la mejor de las asignaciones que resultan. Es una respuesta
 * honesta a «¿había otra manera de repartir esto?»: si la segunda cuesta casi
 * lo mismo, la evidencia no alcanza para elegir y corresponde revisión.
 */
/**
 * Las mejores maneras de repartir una columna, no sólo la mejor.
 *
 * La asignación de costo mínimo es la respuesta correcta **cuando la geometría
 * alcanza**, y muchas veces no alcanza. Sobre la foto de Lácteos Barraza los dos
 * «16,00» de bonificación están impresos casi a la misma altura y una mala
 * lectura de la segunda —«42»— cae un poco más cerca del segundo renglón: por
 * distancia gana el «42», y con él el renglón no cierra.
 *
 * Elegir columna por columna, cada una por su cuenta, no puede resolver eso:
 * mirando sólo la columna de bonificaciones, el «42» es la mejor respuesta. Lo
 * que lo resuelve es la cuenta del renglón, que necesita el precio y el importe
 * a la vez. Así que acá no se elige: se devuelven las alternativas para que la
 * aritmética las combine y decida.
 *
 * Se obtienen prohibiendo de a una las parejas que eligió la ganadora, que es lo
 * mismo que hace `segundaMejorAsignacion`, repetido. Vienen ordenadas por costo
 * y sin repetir: dos exclusiones distintas suelen llevar al mismo reparto.
 */
export function mejoresAsignaciones<T extends ValorPosicionado>(
  valores: T[],
  filas: FilaObjetivo[],
  alturaTipica: number,
  cuantas: number,
): Asignacion<T>[] {
  const primera = asignarMonotonicamente(valores, filas, alturaTipica);
  const salida: Asignacion<T>[] = [primera];
  if (cuantas <= 1) return salida;

  const firmas = new Set([firmaDeAsignacion(primera)]);

  for (const excluido of primera.porFila) {
    if (!excluido) continue;
    const otra = asignarMonotonicamente(
      valores.filter((v) => v !== excluido),
      filas,
      alturaTipica,
    );
    const firma = firmaDeAsignacion(otra);
    if (firmas.has(firma)) continue;
    firmas.add(firma);
    /*
     * El valor excluido **sobra**; no desaparece. Sacarlo sin más lo borraría de
     * la evidencia, y la regla de esta capa es que nada se descarta en silencio:
     * si esta alternativa gana, ese valor tiene que seguir estando disponible
     * como sobrante del renglón.
     */
    otra.sobrantes.push(excluido);
    /*
     * Y su costo se paga igual, porque si no **los costos no son comparables**.
     *
     * La alternativa se calcula sobre un valor menos, así que se ahorra de arriba
     * el precio de descartarlo: una asignación peor sobre menos valores da un
     * número más chico que la mejor sobre todos. Sin este ajuste la lista salía
     * ordenada al revés, y sobre la foto de Lácteos Barraza el mejor reparto de
     * la columna de precios —10.361,45 arriba y 9.453,76 abajo— quedaba segundo
     * detrás de uno que ponía una mancha del papel en el primer renglón y tiraba
     * el precio. Los dos precios estaban bien leídos y bien ubicados; los
     * perdía la comparación.
     */
    otra.costo += COSTO_DE_DESCARTE;
    salida.push(otra);
  }

  return salida.sort((a, b) => a.costo - b.costo).slice(0, cuantas);
}

/**
 * Qué quedó en cada fila, para no ofrecer dos veces el mismo reparto.
 *
 * Se compara por **texto** y no por fragmento. Dos repartos que dejan los mismos
 * números en las mismas filas son la misma respuesta, por más que uno haya usado
 * la lectura de una pasada y el otro la de otra, y ofrecerlos como dos gasta el
 * cupo de alternativas sin agregar nada.
 *
 * Sobre la foto de Lácteos Barraza eso era exactamente lo que pasaba: la columna
 * de bonificaciones tiene dos «16,00» y un «42», y las dos primeras alternativas
 * dejaban «16,00 y 42» —las dos, con distintos fragmentos—, así que el reparto
 * que pone los dos «16,00» quedaba tercero y nunca se probaba. Es el que hace
 * cerrar el segundo renglón.
 */
function firmaDeAsignacion<T extends ValorPosicionado>(asignacion: Asignacion<T>): string {
  return asignacion.porFila.map((v) => v?.texto ?? '').join('|');
}

export function segundaMejorAsignacion<T extends ValorPosicionado>(
  valores: T[],
  filas: FilaObjetivo[],
  alturaTipica: number,
  ganadora: Asignacion<T>,
): Asignacion<T> | null {
  let mejor: Asignacion<T> | null = null;

  for (let fila = 0; fila < ganadora.porFila.length; fila++) {
    const elegido = ganadora.porFila[fila];
    if (!elegido) continue;
    // Sin ese valor, ¿cómo se repartiría el resto?
    const sinEse = valores.filter((v) => v !== elegido);
    const otra = asignarMonotonicamente(sinEse, filas, alturaTipica);
    /*
     * PENDIENTE MEDIDO: el valor excluido **no** vuelve como sobrante.
     *
     * Debería, porque la regla de toda esta capa es que nada se descarta en
     * silencio, y acá un valor que el OCR leyó desaparece de la candidata.
     * Devolverlo se probó y mide peor: sobre la foto de Lácteos Barraza vuelve
     * esta candidata idéntica a la del esqueleto base —los dos valores en
     * disputa son el mismo «16,00»— y el comprobante pasa de 0,85 a 0,70,
     * perdiendo el precio unitario que el renglón había recuperado.
     *
     * Que empeore no lo vuelve correcto: lo que muestra es que la elección de
     * lectura del renglón es sensible a cuántos sobrantes hay, y eso es lo que
     * hay que arreglar antes. Queda anotado acá y no escondido en un cambio que
     * degrada el resultado medido.
     */
    if (!mejor || otra.costo < mejor.costo) mejor = otra;
  }

  return mejor;
}
