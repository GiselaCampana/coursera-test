import {
  alto,
  ancho,
  centroX,
  centroY,
  solapeHorizontal,
  solapeVertical,
  unir,
  type Caja,
} from '@/lib/ocr/reconstruccion/evidencia';
import type { FragmentoEnderezado } from '@/lib/ocr/reconstruccion/inclinacion';

/**
 * Juntar lo que dicen varias pasadas del OCR sobre el mismo pedazo de papel.
 *
 * Cada pasada lee la página entera o una franja, con una preparación distinta,
 * y todas leen cosas que las otras no. La tentación es quedarse con la mejor
 * pasada; el problema es que **no hay una mejor**: sobre la misma factura, la
 * pasada sin limpiar trae las filas tenues y la limpiada trae las que tenían
 * ruido alrededor. Lo que hace falta es poder armar un renglón con una celda de
 * una y otra celda de otra.
 *
 * Entonces acá no se elige: se **agrupa por lugar**. Dos fragmentos que ocupan
 * el mismo pedazo de página son el mismo dato leído dos veces. Si dicen lo
 * mismo, se refuerzan; si dicen distinto, quedan los dos como alternativas y
 * decide después la aritmética.
 */

/**
 * Un dato del papel, con todas las lecturas que hizo el OCR de él.
 *
 * Es lo que reemplaza al fragmento suelto: una posición en la página y las
 * versiones que trajo cada pasada.
 */
export interface Observacion {
  /** La caja de consenso, que es la de la lectura más confiable. */
  caja: Caja;
  lecturas: Lectura[];
}

export interface Lectura {
  texto: string;
  confianza: number;
  pasada: string;
  caja: Caja;
  /** Las otras lecturas que el propio OCR consideró para esta palabra. */
  alternativas: string[];
}

/** El texto que gana por ahora: el de mayor confianza, reforzado por acuerdo. */
export function textoPreferido(observacion: Observacion): string {
  return mejorLectura(observacion).texto;
}

export function mejorLectura(observacion: Observacion): Lectura {
  /*
   * Gana la lectura con más apoyo, y el apoyo es confianza más acuerdo.
   *
   * Que dos pasadas distintas lean lo mismo vale más que una sola pasada muy
   * confiada: son dos preparaciones distintas de la imagen coincidiendo, y eso
   * es evidencia independiente. Un 0,90 apoyado por otra pasada le gana a un
   * 0,95 solo.
   */
  const puntajes = new Map<string, number>();
  for (const lectura of observacion.lecturas) {
    puntajes.set(lectura.texto, (puntajes.get(lectura.texto) ?? 0) + lectura.confianza);
  }
  let mejor = observacion.lecturas[0];
  let mejorPuntaje = -1;
  for (const lectura of observacion.lecturas) {
    const puntaje = puntajes.get(lectura.texto)!;
    if (puntaje > mejorPuntaje) {
      mejorPuntaje = puntaje;
      mejor = lectura;
    }
  }
  return mejor;
}

/** Todas las lecturas distintas de una observación, la ganadora primero. */
export function textosAlternativos(observacion: Observacion): string[] {
  const ganador = textoPreferido(observacion);
  const otros = new Set<string>();
  for (const lectura of observacion.lecturas) {
    if (lectura.texto !== ganador) otros.add(lectura.texto);
    for (const alternativa of lectura.alternativas) {
      if (alternativa !== ganador) otros.add(alternativa);
    }
  }
  return [ganador, ...otros];
}

/**
 * Agrupa fragmentos de distintas pasadas que ocupan el mismo lugar.
 *
 * Dos fragmentos son el mismo dato cuando sus cajas se solapan lo bastante en
 * las dos direcciones. El umbral es en fracción del tamaño del fragmento más
 * chico y no en unidades absolutas: un recorte ampliado da cajas apenas
 * distintas de las de la página entera, y pedir coincidencia exacta dejaría
 * todo duplicado.
 *
 * Lo que **no** hace es juntar dos fragmentos que sólo se rozan. Dos columnas
 * numéricas pegadas se tocan por unos píxeles, y fundirlas sería perder una de
 * las dos: por eso se pide que el solapamiento sea la mayor parte del fragmento
 * chico, no una esquina.
 */
export function agruparPorLugar(fragmentos: FragmentoEnderezado[]): Observacion[] {
  const ordenados = [...fragmentos].sort((a, b) => a.caja.y0 - b.caja.y0 || a.caja.x0 - b.caja.x0);
  const observaciones: Observacion[] = [];

  for (const fragmento of ordenados) {
    const lectura: Lectura = {
      texto: fragmento.texto,
      confianza: fragmento.confianza,
      pasada: fragmento.pasada,
      caja: fragmento.cajaOriginal,
      alternativas: fragmento.alternativas ?? [],
    };

    const candidata = observaciones.find(
      (o) => esElMismoDato(o.caja, fragmento.caja) && !o.lecturas.some((l) => l.pasada === fragmento.pasada),
    );

    if (candidata) {
      candidata.lecturas.push(lectura);
      // La caja de consenso se queda con la de la lectura que manda.
      candidata.caja = mejorLectura(candidata).caja;
    } else {
      observaciones.push({ caja: fragmento.caja, lecturas: [lectura] });
    }
  }

  return observaciones;
}

/**
 * ¿Son dos lecturas del mismo dato?
 *
 * Se pide que se solapen en más de la mitad del más chico, en los dos ejes. La
 * condición «una sola lectura por pasada» que se aplica arriba es la otra mitad
 * de la regla: dos palabras vecinas de la **misma** pasada nunca son el mismo
 * dato, por mucho que se toquen, porque el OCR ya decidió que eran dos.
 */
function esElMismoDato(a: Caja, b: Caja): boolean {
  const anchoMinimo = Math.min(ancho(a), ancho(b));
  const altoMinimo = Math.min(alto(a), alto(b));
  if (anchoMinimo <= 0 || altoMinimo <= 0) return false;
  return (
    solapeHorizontal(a, b) > anchoMinimo * 0.5 && solapeVertical(a, b) > altoMinimo * 0.5
  );
}

// ---------------------------------------------------------------------------
// Renglones
// ---------------------------------------------------------------------------

/**
 * Una hipótesis de renglón: las observaciones que están a la misma altura.
 */
export interface RenglonVisual {
  observaciones: Observacion[];
  caja: Caja;
  /** El centro vertical, que es por lo que se ordenan. */
  y: number;
}

/**
 * Arma renglones por cercanía vertical.
 *
 * Se recorre de arriba hacia abajo y cada observación entra al renglón abierto
 * si comparte altura con él. «Compartir altura» se mide con el solapamiento
 * vertical y no con la distancia entre centros: en una misma línea conviven un
 * código en versalitas y una descripción en mayúsculas, y sus centros no
 * coinciden aunque las cajas se pisen casi enteras.
 *
 * El corte es por **fracción del alto típico de renglón**, que sale de la
 * propia evidencia. Con un umbral absoluto, la misma factura fotografiada más
 * de cerca partiría cada renglón en varios.
 */
export function armarRenglones(
  observaciones: Observacion[],
  alturaTipica: number,
): RenglonVisual[] {
  const ordenadas = [...observaciones].sort((a, b) => centroY(a.caja) - centroY(b.caja));
  const renglones: RenglonVisual[] = [];
  /*
   * La referencia de cada renglón es el **promedio de los centros** de lo que
   * ya entró, no el centro de la caja que los contiene a todos.
   *
   * Es una diferencia que parece de detalle y no lo es. La caja que contiene
   * crece con cada celda, y con ella se mueve su centro: sobre la foto de Ezra,
   * un renglón con ocho celdas terminaba con el centro medio renglón más abajo
   * del que tenía al empezar, alcanzaba la fila siguiente y se la comía. Los
   * seis artículos salían fundidos de a dos, con los textos concatenados y los
   * importes multiplicados por mil millones.
   *
   * El promedio, en cambio, no se corre: cada celda nueva lo mueve menos que la
   * anterior, porque son todas del mismo renglón y están a la misma altura.
   */
  const centros: number[][] = [];

  for (const observacion of ordenadas) {
    const y = centroY(observacion.caja);
    const ultimo = renglones.length - 1;
    if (ultimo >= 0 && comparteAltura(renglones[ultimo].y, observacion.caja, alturaTipica)) {
      renglones[ultimo].observaciones.push(observacion);
      renglones[ultimo].caja = unir(renglones[ultimo].caja, observacion.caja);
      centros[ultimo].push(y);
      renglones[ultimo].y = centros[ultimo].reduce((a, b) => a + b, 0) / centros[ultimo].length;
      continue;
    }
    renglones.push({ observaciones: [observacion], caja: observacion.caja, y });
    centros.push([y]);
  }

  for (const renglon of renglones) {
    renglon.observaciones.sort((a, b) => a.caja.x0 - b.caja.x0);
  }
  return renglones;
}

/**
 * ¿Está la observación a la altura del renglón que se viene armando?
 *
 * Se compara contra la altura de referencia del renglón —el promedio de los
 * centros de sus celdas— y no contra su caja, por lo dicho arriba.
 */
function comparteAltura(yDelRenglon: number, observacion: Caja, alturaTipica: number): boolean {
  return Math.abs(yDelRenglon - centroY(observacion)) <= alturaTipica * 0.6;
}

/**
 * Junta observaciones contiguas que son pedazos de una misma palabra.
 *
 * El OCR parte palabras: «22.800,00» sale «22.800» y «,00», y una descripción
 * larga sale en tres tramos. Se pegan cuando están pegadas de verdad —menos de
 * un cuarto de letra de separación— y no cuando hay un espacio de columna en el
 * medio.
 *
 * Sólo se pegan pedazos **compatibles**: dos tramos numéricos, o dos tramos de
 * texto. Pegar un número con una palabra es lo que produce «4,240 Cremoso» en
 * una sola celda y arranca el corrimiento de columnas.
 */
export function unirPartidas(renglon: RenglonVisual, alturaTipica: number): Observacion[] {
  const salida: Observacion[] = [];
  const separacionMaxima = alturaTipica * 0.25;

  for (const observacion of renglon.observaciones) {
    const previa = salida[salida.length - 1];
    if (
      previa &&
      observacion.caja.x0 - previa.caja.x1 >= 0 &&
      observacion.caja.x0 - previa.caja.x1 < separacionMaxima &&
      mismaClase(textoPreferido(previa), textoPreferido(observacion))
    ) {
      salida[salida.length - 1] = {
        caja: unir(previa.caja, observacion.caja),
        lecturas: [
          {
            texto: `${textoPreferido(previa)}${textoPreferido(observacion)}`,
            confianza: Math.min(
              mejorLectura(previa).confianza,
              mejorLectura(observacion).confianza,
            ),
            pasada: mejorLectura(previa).pasada,
            caja: unir(mejorLectura(previa).caja, mejorLectura(observacion).caja),
            alternativas: [],
          },
        ],
      };
      continue;
    }
    salida.push(observacion);
  }

  return salida;
}

/** ¿Los dos tramos son de la misma naturaleza? */
function mismaClase(a: string, b: string): boolean {
  const numerico = (t: string) => /^[\d.,%$-]+$/.test(t);
  return numerico(a) === numerico(b);
}

export { centroX, centroY };
