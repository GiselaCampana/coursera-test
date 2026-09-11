import { reconocerColumnas, type ColumnaReconocida } from '@/lib/ocr/motor/columnas';
import { ancho, centroX, type Caja } from '@/lib/ocr/reconstruccion/evidencia';
import {
  textoPreferido,
  type Observacion,
  type RenglonVisual,
} from '@/lib/ocr/reconstruccion/agrupar';

/**
 * Dónde están las columnas, según los datos y no según el título.
 *
 * La fila de títulos orienta —dice **qué** es cada columna— pero es una sola
 * línea y está impresa con otro espaciado que los datos. En la factura de
 * Distribuidora Ezra los cuatro títulos de la derecha van pegados y las cuatro
 * columnas de números están separadas y más a la derecha: medir con el título
 * junta el precio de lista con el porcentaje de descuento.
 *
 * Los datos, en cambio, son muchas líneas de acuerdo entre sí. Una columna de
 * una tabla impresa es una franja vertical donde caen valores de casi todos los
 * renglones, y eso se ve sin leer nada: se proyectan todas las cajas sobre el
 * eje horizontal y las columnas aparecen como picos separados por valles.
 *
 * Los dos métodos se usan juntos y **queda registrado cuál mandó**, porque
 * saber que los límites salieron del título y no de los datos es la diferencia
 * entre una lectura confiable y una que conviene mirar.
 */

export type MetodoDeLimites =
  /** Las franjas verticales donde se agrupan los datos. */
  | 'columnas-de-datos'
  /** Sólo la fila de títulos: los datos no formaron columnas. */
  | 'fila-de-titulos'
  /** Las franjas de datos, alineadas con los títulos que las nombran. */
  | 'datos-con-titulos';

export interface ColumnaEspacial {
  desde: number;
  hasta: number;
  /** El título que le corresponde, si alguno cae encima. */
  titulo: string | null;
  campo: ColumnaReconocida | null;
  /** En cuántos renglones aparece un valor de esta columna. */
  apoyos: number;
}

export interface LimitesDetectados {
  columnas: ColumnaEspacial[];
  metodo: MetodoDeLimites;
  /** Qué se probó y por qué se descartó, para poder explicarlo. */
  notas: string[];
}

/**
 * Las franjas verticales que ocupan los datos.
 *
 * Se construye un histograma de ocupación sobre el ancho de la página: cada
 * caja suma en las celdas que cubre. Las franjas con ocupación cero son los
 * corredores entre columnas.
 *
 * La resolución es fina —mil celdas— porque los corredores de una tabla
 * apretada son angostos, y el filtro que evita partir una columna por un hueco
 * casual no es la resolución sino el **ancho mínimo de corredor**: un espacio
 * entre palabras de una descripción es más angosto que el que separa dos
 * columnas.
 */
export function franjasDeDatos(
  renglones: RenglonVisual[],
  alturaTipica: number,
): { desde: number; hasta: number; apoyos: number }[] {
  const CELDAS = 1000;
  const ocupacion = new Array<number>(CELDAS).fill(0);

  for (const renglon of renglones) {
    // Se marca una vez por renglón y por celda: un renglón con una descripción
    // larga no tiene que pesar más que uno corto.
    const tocadas = new Set<number>();
    for (const observacion of renglon.observaciones) {
      const desde = Math.max(0, Math.floor(observacion.caja.x0 * CELDAS));
      const hasta = Math.min(CELDAS - 1, Math.ceil(observacion.caja.x1 * CELDAS));
      for (let i = desde; i <= hasta; i++) tocadas.add(i);
    }
    for (const i of tocadas) ocupacion[i] += 1;
  }

  /*
   * Un corredor es una tanda de celdas **poco ocupadas**, no vacías.
   *
   * Pedir cero ocupación no funciona sobre una foto y es el primer intento que
   * se probó: alcanza con que una sola línea de las sesenta que ve el OCR
   * —el texto del pie, el borde de la tabla, una mancha que salió como «|»—
   * cruce el corredor para taparlo, y entonces la página entera queda como una
   * sola columna. Sobre las cinco facturas del banco eso pasaba en todas.
   *
   * El umbral es una fracción de los renglones: una columna de verdad tiene
   * valores en casi todas las filas, y un corredor tiene algo suelto en unas
   * pocas. Se pide además al menos un piso de dos renglones para que en una
   * tabla de tres filas no se corte por cualquier cosa.
   */
  const umbralDeCorredor = Math.max(1, Math.floor(renglones.length * 0.15));

  /*
   * El ancho mínimo de corredor se mide en altos de renglón, porque el espacio
   * entre columnas de una tabla es, en cualquier impresión, del orden del
   * cuerpo de la letra. Con un umbral absoluto, la misma factura fotografiada
   * más de cerca partiría las columnas en pedazos.
   */
  const corredorMinimo = Math.max(2, Math.round(alturaTipica * 0.45 * CELDAS));

  const franjas: { desde: number; hasta: number; apoyos: number }[] = [];
  let inicio: number | null = null;
  let vacias = 0;

  for (let i = 0; i <= CELDAS; i++) {
    const vacia = i === CELDAS || ocupacion[i] <= umbralDeCorredor;
    if (vacia) {
      vacias += 1;
      if (inicio !== null && (vacias >= corredorMinimo || i === CELDAS)) {
        const hasta = i - vacias + 1;
        franjas.push({
          desde: inicio / CELDAS,
          hasta: hasta / CELDAS,
          apoyos: Math.max(...ocupacion.slice(inicio, Math.max(hasta, inicio + 1))),
        });
        inicio = null;
      }
    } else {
      if (inicio === null) inicio = i;
      vacias = 0;
    }
  }

  return franjas;
}

/**
 * Combina las franjas de datos con la fila de títulos.
 *
 * Cada franja se queda con el título que le cae encima. Los casos que hay que
 * atender, y que son todos reales:
 *
 *  - **una franja sin título**: una columna que el encabezado no nombra, o que
 *    el OCR no leyó. Se conserva como columna anónima en vez de repartirla
 *    entre las vecinas, porque repartirla ensucia dos columnas buenas;
 *  - **un título sin franja**: una columna vacía en todos los renglones
 *    visibles. Se conserva con los límites del título;
 *  - **dos títulos sobre una franja**: los datos de esas dos columnas se tocan.
 *    Se parte la franja por el medio entre los dos títulos.
 */
export function detectarColumnas(
  renglones: RenglonVisual[],
  titulos: RenglonVisual | null,
  alturaTipica: number,
): LimitesDetectados {
  const notas: string[] = [];
  const franjas = franjasDeDatos(renglones, alturaTipica);

  const celdasDeTitulo = titulos ? titulos.observaciones : [];
  const textosDeTitulo = celdasDeTitulo.map((o) => textoPreferido(o));
  const camposDeTitulo = textosDeTitulo.length ? reconocerColumnas(textosDeTitulo) : [];

  if (franjas.length < 2) {
    notas.push(
      `Los datos no se separaron en columnas (${franjas.length} franja/s): ` +
        'se usan los límites de la fila de títulos.',
    );
    return {
      columnas: celdasDeTitulo.map((celda, i) => ({
        desde: celda.caja.x0,
        hasta: celda.caja.x1,
        titulo: textosDeTitulo[i] ?? null,
        campo: camposDeTitulo[i] ?? null,
        apoyos: 0,
      })),
      metodo: 'fila-de-titulos',
      notas,
    };
  }

  /*
   * Cada título se anota en la franja de datos con la que más se solapa.
   *
   * Antes se pedía que el **centro** del título cayera adentro de la franja, y
   * eso deja títulos huérfanos todo el tiempo: una columna alineada a la
   * derecha tiene los datos corridos respecto del encabezado, y sobre la
   * factura de Ezra el título «Codigo» quedaba justo afuera de la franja donde
   * estaban los seis códigos. El resultado era una columna con título y sin
   * datos al lado de una con datos y sin título: las dos mitades de la misma
   * columna, separadas.
   */
  const franjaDeCadaTitulo = celdasDeTitulo.map((celda) => {
    let mejor: number | null = null;
    let mejorSolape = 0;
    franjas.forEach((franja, i) => {
      const solape = Math.min(celda.caja.x1, franja.hasta) - Math.max(celda.caja.x0, franja.desde);
      if (solape > mejorSolape) {
        mejorSolape = solape;
        mejor = i;
      }
    });
    return mejor;
  });

  const columnas: ColumnaEspacial[] = [];

  franjas.forEach((franja, indiceDeFranja) => {
    const encima = celdasDeTitulo
      .map((celda, i) => ({ celda, i }))
      .filter(({ i }) => franjaDeCadaTitulo[i] === indiceDeFranja);

    if (encima.length <= 1) {
      const elegido = encima[0];
      columnas.push({
        desde: franja.desde,
        hasta: franja.hasta,
        titulo: elegido ? textosDeTitulo[elegido.i] : null,
        campo: elegido ? camposDeTitulo[elegido.i] ?? null : null,
        apoyos: franja.apoyos,
      });
      return;
    }

    // Varios títulos sobre la misma franja: se parte entre ellos.
    notas.push(
      `La franja ${franja.desde.toFixed(3)}\u2013${franja.hasta.toFixed(3)} tiene ` +
        `${encima.length} títulos encima (${encima.map(({ i }) => `«${textosDeTitulo[i]}»`).join(', ')}): ` +
        'se dividió por la mitad entre ellos.',
    );
    encima.sort((a, b) => a.celda.caja.x0 - b.celda.caja.x0);
    for (let k = 0; k < encima.length; k++) {
      const actual = encima[k];
      const previo = encima[k - 1];
      const siguiente = encima[k + 1];
      /*
       * Los cortes se ordenan antes de usarlos: dos títulos que se solapan
       * —y se solapan, porque el OCR lee «Codigo Art.» como dos palabras
       * encimadas— dan una columna de ancho negativo en la que no cae nada
       * nunca. No falla: deja una columna muerta y manda sus datos a la vecina.
       */
      const corteIzquierdo = previo
        ? (previo.celda.caja.x1 + actual.celda.caja.x0) / 2
        : franja.desde;
      const corteDerecho = siguiente
        ? (actual.celda.caja.x1 + siguiente.celda.caja.x0) / 2
        : franja.hasta;
      columnas.push({
        desde: Math.max(franja.desde, Math.min(corteIzquierdo, corteDerecho)),
        hasta: Math.min(franja.hasta, Math.max(corteIzquierdo, corteDerecho)),
        titulo: textosDeTitulo[actual.i],
        campo: camposDeTitulo[actual.i] ?? null,
        apoyos: franja.apoyos,
      });
    }
  });

  // Los títulos que no cayeron sobre ninguna franja: columnas vacías.
  celdasDeTitulo.forEach((celda, i) => {
    if (franjaDeCadaTitulo[i] !== null) return;
    notas.push(`El título «${textosDeTitulo[i]}» no tiene datos abajo: la columna queda vacía.`);
    columnas.push({
      desde: celda.caja.x0,
      hasta: celda.caja.x1,
      titulo: textosDeTitulo[i],
      campo: camposDeTitulo[i] ?? null,
      apoyos: 0,
    });
  });

  columnas.sort((a, b) => a.desde - b.desde);

  const anonimas = columnas.filter((c) => c.titulo === null).length;
  if (anonimas > 0) {
    notas.push(`${anonimas} columna/s de datos sin ningún título encima.`);
  }

  return {
    columnas,
    metodo: titulos ? 'datos-con-titulos' : 'columnas-de-datos',
    notas,
  };
}

/**
 * A qué columna pertenece una observación, o null si no cae en ninguna.
 *
 * Se usa el solapamiento y no el centro porque una celda numérica alineada a la
 * derecha se desborda hacia la columna anterior cuando el número es largo. Que
 * pueda devolver null es deliberado: un valor que no cae en ninguna columna es
 * una señal —casi siempre es de otro renglón— y meterlo en la columna más
 * cercana lo esconde.
 */
export function columnaDe(observacion: Observacion, columnas: ColumnaEspacial[]): number | null {
  let mejor: number | null = null;
  let mejorSolape = 0;
  columnas.forEach((columna, i) => {
    const solape =
      Math.min(observacion.caja.x1, columna.hasta) - Math.max(observacion.caja.x0, columna.desde);
    if (solape > mejorSolape) {
      mejorSolape = solape;
      mejor = i;
    }
  });
  // Se pide que al menos un tercio del valor esté adentro de la columna.
  if (mejor === null || mejorSolape < ancho(observacion.caja) / 3) return null;
  return mejor;
}

export type { Caja };
