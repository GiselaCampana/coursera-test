import type { Fragmento } from '@/lib/ocr/reconstruccion/evidencia';
import type { CasillaDelPie, RegionDelPie } from '@/lib/ocr/motor/region-del-pie';
import { desdeLaPalabra, dondeTerminaElVeto, enPalabras } from '@/lib/ocr/motor/region-del-pie';

/**
 * **Qué etiqueta nombra a cada importe, resuelto de una vez para toda la región.**
 *
 * Hasta acá cada número buscaba su etiqueta por su cuenta: el texto más cercano
 * a la izquierda, o el de arriba en su columna, y ganaba el que estuviera más
 * pegado. Es una decisión codiciosa, y lo codicioso se equivoca de la misma
 * manera siempre: dos etiquetas y dos importes que quedaron un poco corridos se
 * emparejan **cruzados**, cada uno con el que tiene más cerca, y la lectura
 * resultante es coherente y falsa.
 *
 * Acá el problema se plantea entero. Se arman los candidatos —las etiquetas
 * completas por un lado, los importes por el otro— y las aristas posibles entre
 * ellos, y se elige la asignación **completa** de menor costo con estas
 * restricciones:
 *
 *  - un fragmento físico no ocupa dos conceptos;
 *  - un importe no se asigna a dos etiquetas;
 *  - una etiqueta a la izquierda gobierna el importe de su fila; una encima,
 *    el de su columna;
 *  - las asociaciones **no se cruzan**: una etiqueta sólo puede alcanzar el
 *    primer importe que le corresponde, así que una solución cruzada no se
 *    puede ni escribir;
 *  - la cercanía sola no alcanza. Una arista existe únicamente si la etiqueta
 *    **nombra un concepto**; lo que está cerca y no dice nada no asocia nada.
 *
 * Y el alcance de la etiqueta se determina **antes** que su significado. Una
 * etiqueta son todas las palabras seguidas que el papel imprimió juntas, aunque
 * el OCR las haya devuelto en cuatro cajas: primero se reconstruye la frase y
 * recién después se pregunta qué dice. Al revés, «TOTAL» adentro de «DESCUENTO
 * TOTAL» parece el total del comprobante, y «NETO» adentro de «PESO NETO»
 * parece el neto gravado.
 */

export type RelacionDeAsignacion = 'a la izquierda' | 'encima';

/** Lo que sostiene una asociación, contado por familias independientes. */
export type FamiliaDeApoyoFiscal = 'texto' | 'fila' | 'columna' | 'proximidad';

export interface EtiquetaCandidata {
  /** Las cajas que el papel imprimió juntas y el OCR partió. */
  fragmentos: Fragmento[];
  /** La frase completa, reconstruida antes de mirar qué dice. */
  texto: string;
  fila: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface AristaDelPie {
  etiqueta: number;
  numero: number;
  relacion: RelacionDeAsignacion;
  /** Cuánto cuesta sostener esta asociación. Menos es mejor. */
  costo: number;
  apoyos: FamiliaDeApoyoFiscal[];
}

export interface ParAsignado {
  etiqueta: EtiquetaCandidata;
  numero: CasillaDelPie;
  relacion: RelacionDeAsignacion;
  apoyos: FamiliaDeApoyoFiscal[];
  costo: number;
}

export interface AsignacionDeRegion {
  pares: ParAsignado[];
  /**
   * Los importes que se leyeron y no se pudieron asociar a ningún concepto.
   *
   * **No son un `null`.** El número está en la foto, se leyó, y lo que falta es
   * saber qué concepto es. Convertirlo en un campo vacío pierde la única cosa
   * que el motor sí averiguó, y convertirlo en un campo cualquiera es peor.
   */
  sinAsignar: CasillaDelPie[];
  costo: number;
  /** El costo de la segunda mejor asignación completa, si hay otra. */
  segunda: number | null;
  etiquetas: EtiquetaCandidata[];
}

export interface OpcionesDeAsignacion {
  alturaTipica: number;
  /** Qué concepto nombra una etiqueta, o `null`. Lo pone quien llama. */
  nombraConcepto: (etiqueta: string) => string | null;
}

// ---------------------------------------------------------------------------
// Los candidatos
// ---------------------------------------------------------------------------

/**
 * Las etiquetas de una región: **frases completas**, no palabras sueltas.
 *
 * Una etiqueta son todas las cajas de texto seguidas de una misma fila, sin un
 * número en el medio. El OCR parte «Percepción IIBB CABA» en tres cajas y a
 * veces en cinco; pegarlas antes de preguntar qué dicen es lo que permite leer
 * la frase entera, que es la única unidad que tiene significado.
 *
 * El corte es el número: lo que hay entre dos importes de la misma fila es la
 * etiqueta del segundo, y lo que hay después del último es de nadie.
 */
export function etiquetasDe(
  region: RegionDelPie,
  alturaTipica = 0.008,
): EtiquetaCandidata[] {
  const porFila = new Map<number, CasillaDelPie[]>();
  for (const casilla of region.casillas) {
    porFila.set(casilla.fila, [...(porFila.get(casilla.fila) ?? []), casilla]);
  }

  const salida: EtiquetaCandidata[] = [];
  for (const [fila, casillas] of porFila) {
    const enOrden = [...casillas].sort((a, b) => a.fragmento.caja.x0 - b.fragmento.caja.x0);
    let corrida: CasillaDelPie[] = [];

    const cerrar = () => {
      if (corrida.length === 0) return;
      salida.push({
        fragmentos: corrida.map((c) => c.fragmento),
        texto: corrida.map((c) => c.fragmento.texto).join(' '),
        fila,
        x0: Math.min(...corrida.map((c) => c.fragmento.caja.x0)),
        x1: Math.max(...corrida.map((c) => c.fragmento.caja.x1)),
        y0: Math.min(...corrida.map((c) => c.fragmento.caja.y0)),
        y1: Math.max(...corrida.map((c) => c.fragmento.caja.y1)),
      });
      corrida = [];
    };

    /*
     * La frase se corta por dos cosas: un número en el medio, y **un hueco**.
     *
     * Lo segundo hace falta y se midió: un recuadro con «NETO   IVA   TOTAL» de
     * encabezados tiene tres palabras seguidas sin ningún número entre ellas, y
     * pegarlas produce una sola etiqueta de tres conceptos que no nombra
     * ninguno. Las palabras de una misma frase están pegadas; entre dos
     * encabezados de columnas distintas hay el blanco de la columna.
     */
    const hueco = Math.max(alturaTipica * 2, 0.02);
    let ultimo: CasillaDelPie | null = null;
    for (const casilla of enOrden) {
      if (casilla.esNumero) {
        cerrar();
        ultimo = casilla;
        continue;
      }
      if (ultimo && !ultimo.esNumero && casilla.fragmento.caja.x0 - ultimo.fragmento.caja.x1 > hueco) {
        cerrar();
      }
      corrida.push(casilla);
      ultimo = casilla;
    }
    cerrar();
  }
  return salida;
}

/**
 * Qué concepto nombra una etiqueta, con el veto aplicado sobre la frase entera.
 *
 * El orden importa y es todo el punto: **primero el alcance, después el
 * significado**. Se mira la frase completa, se busca dónde termina el veto que
 * está más cerca del número, y se pregunta qué dice lo que queda después. Así
 * «DESCUENTO TOTAL» no es el total —el veto se come la frase entera— y
 * «C.U.I.T. 30-… I.V.A. 21 %» sí es el IVA, porque después del veto todavía
 * hay un concepto y está pegado al importe.
 */
export function conceptoDeLaEtiqueta(
  texto: string,
  nombraConcepto: (etiqueta: string) => string | null,
): string | null {
  const fin = dondeTerminaElVeto(texto);
  if (fin === null) return nombraConcepto(texto);
  const cola = desdeLaPalabra(texto, fin);
  return cola === '' ? null : nombraConcepto(cola);
}

// ---------------------------------------------------------------------------
// Las aristas
// ---------------------------------------------------------------------------

/**
 * Las asociaciones posibles entre una etiqueta y un importe.
 *
 * Son pocas a propósito, y ésa es la manera de impedir que se crucen: una
 * etiqueta sólo alcanza **el primer importe que le corresponde** en cada
 * dirección. A la izquierda, el primero a su derecha en su fila; encima, el
 * primero debajo en su columna. Una solución cruzada no se puede ni escribir,
 * así que no hace falta penalizarla después.
 */
export function aristasDe(
  region: RegionDelPie,
  etiquetas: EtiquetaCandidata[],
  numeros: CasillaDelPie[],
  opciones: OpcionesDeAsignacion,
): AristaDelPie[] {
  const aristas: AristaDelPie[] = [];

  etiquetas.forEach((etiqueta, i) => {
    // La cercanía sola no alcanza: sin concepto no hay arista.
    if (conceptoDeLaEtiqueta(etiqueta.texto, opciones.nombraConcepto) === null) return;

    /*
     * A la izquierda: el primer importe a su derecha, en su misma fila. Si
     * entre la etiqueta y ese importe hay otra etiqueta, la de más a la derecha
     * es la que lo nombra y ésta no lo alcanza.
     */
    const enSuFila = numeros
      .map((n, j) => ({ n, j }))
      .filter(({ n }) => n.fila === etiqueta.fila && n.fragmento.caja.x0 >= etiqueta.x1 - 0.002)
      .sort((a, b) => a.n.fragmento.caja.x0 - b.n.fragmento.caja.x0);

    const primeroALaDerecha = enSuFila[0];
    if (primeroALaDerecha) {
      /*
       * Tapa sólo lo que **nombra algo**. Entre una etiqueta y su importe el
       * papel imprime signos de pesos, barras de la grilla y guiones de relleno,
       * y ninguno es otra etiqueta: tratarlos como tal dejaba sin arista a la
       * percepción de un comprobante donde el papel escribe «Perc IIBB  1,50  $
       * 22.853,07».
       */
      const tapada = etiquetas.some(
        (otra, k) =>
          k !== i &&
          etiquetaLegible(otra.texto) &&
          otra.fila === etiqueta.fila &&
          otra.x0 >= etiqueta.x1 &&
          otra.x1 <= primeroALaDerecha.n.fragmento.caja.x0,
      );
      if (!tapada) {
        const hueco = primeroALaDerecha.n.fragmento.caja.x0 - etiqueta.x1;
        aristas.push({
          etiqueta: i,
          numero: primeroALaDerecha.j,
          relacion: 'a la izquierda',
          costo: Math.max(hueco, 0),
          apoyos: apoyos('fila', hueco, opciones.alturaTipica),
        });
      }
    }

    /*
     * Encima: el primer importe debajo cuya caja se solapa con la de la
     * etiqueta en horizontal. Compartir columna de la grilla es lo que
     * distingue un encabezado de un número que casualmente quedó debajo de una
     * palabra: un valor situado bajo «TOTAL» no pertenece a esa etiqueta si la
     * grilla lo ubica en otra casilla.
     */
    const debajo = numeros
      .map((n, j) => ({ n, j }))
      .filter(
        ({ n }) =>
          n.fila > etiqueta.fila &&
          n.fragmento.caja.x1 > etiqueta.x0 &&
          n.fragmento.caja.x0 < etiqueta.x1,
      )
      .sort((a, b) => a.n.fila - b.n.fila);

    const primeroDebajo = debajo[0];
    if (primeroDebajo) {
      const hueco = primeroDebajo.n.fragmento.caja.y0 - etiqueta.y1;
      // Una etiqueta a más de tres renglones de altura no encabeza nada.
      if (hueco <= opciones.alturaTipica * 3) {
        aristas.push({
          etiqueta: i,
          numero: primeroDebajo.j,
          relacion: 'encima',
          costo: Math.max(hueco, 0),
          apoyos: apoyos('columna', hueco, opciones.alturaTipica),
        });
      }
    }
  });

  return aristas;
}

function apoyos(
  geometria: 'fila' | 'columna',
  hueco: number,
  alturaTipica: number,
): FamiliaDeApoyoFiscal[] {
  const lista: FamiliaDeApoyoFiscal[] = ['texto', geometria];
  if (hueco <= Math.max(alturaTipica * 2, 0.02)) lista.push('proximidad');
  return lista;
}

// ---------------------------------------------------------------------------
// La asignación global
// ---------------------------------------------------------------------------

/**
 * La asignación completa de menor costo, y la segunda.
 *
 * Es un emparejamiento exacto: cada etiqueta toma a lo sumo un importe y cada
 * importe a lo sumo una etiqueta. Se resuelve por búsqueda con memoria sobre
 * qué etiquetas quedaron usadas, que sobre un pie —donde hay unas pocas
 * etiquetas y unos pocos importes— es instantáneo y **exacto**: no hay ningún
 * orden de exploración que pueda dejar afuera la mejor solución, que es
 * justamente lo que le pasaba a la versión codiciosa.
 *
 * Dejar un importe sin asignar tiene un costo, y a propósito es mayor que
 * cualquier hueco geométrico: entre explicar un número y no explicarlo, se
 * explica. Lo que no se puede es explicarlo con una etiqueta que no lo nombra,
 * y eso ya lo impidió la generación de aristas.
 */
const COSTO_DE_NO_ASIGNAR = 10;

/**
 * Tope de seguridad: un pie con más etiquetas que esto no es un pie.
 *
 * La búsqueda lleva memoria sobre qué etiquetas quedaron usadas, así que el
 * costo crece con dos elevado a este número. Dieciséis es holgado para un
 * recuadro de totales —el más cargado del banco tiene siete— y mantiene el
 * trabajo acotado cuando una región agarra media hoja de leyendas.
 */
const ETIQUETAS_MAXIMAS = 16;

export function asignarRegion(
  region: RegionDelPie,
  numeros: CasillaDelPie[],
  opciones: OpcionesDeAsignacion,
): AsignacionDeRegion {
  const etiquetas = etiquetasDe(region, opciones.alturaTipica).slice(0, ETIQUETAS_MAXIMAS);
  const aristas = aristasDe(region, etiquetas, numeros, opciones);

  const porNumero = new Map<number, AristaDelPie[]>();
  for (const arista of aristas) {
    porNumero.set(arista.numero, [...(porNumero.get(arista.numero) ?? []), arista]);
  }

  const indices = [...porNumero.keys()].sort((a, b) => a - b);
  const memo = new Map<string, { costo: number; elegidas: (AristaDelPie | null)[] }>();

  const resolver = (
    i: number,
    usadas: number,
  ): { costo: number; elegidas: (AristaDelPie | null)[] } => {
    if (i >= indices.length) return { costo: 0, elegidas: [] };
    const clave = `${i}|${usadas}`;
    const guardado = memo.get(clave);
    if (guardado) return guardado;

    // No asignar este importe: cuesta, y a veces es lo correcto.
    let mejor: { costo: number; elegidas: (AristaDelPie | null)[] } = (() => {
      const resto = resolver(i + 1, usadas);
      return { costo: COSTO_DE_NO_ASIGNAR + resto.costo, elegidas: [null, ...resto.elegidas] };
    })();

    for (const arista of porNumero.get(indices[i]) ?? []) {
      const bit = 1 << arista.etiqueta;
      if ((usadas & bit) !== 0) continue;
      const resto = resolver(i + 1, usadas | bit);
      const costo = arista.costo + resto.costo;
      if (costo < mejor.costo) mejor = { costo, elegidas: [arista, ...resto.elegidas] };
    }

    memo.set(clave, mejor);
    return mejor;
  };

  const mejor = resolver(0, 0);

  const pares: ParAsignado[] = [];
  const asignados = new Set<CasillaDelPie>();
  mejor.elegidas.forEach((arista, k) => {
    if (!arista) return;
    const numero = numeros[indices[k]];
    pares.push({
      etiqueta: etiquetas[arista.etiqueta],
      numero,
      relacion: arista.relacion,
      apoyos: arista.apoyos,
      costo: arista.costo,
    });
    asignados.add(numero);
  });

  return {
    pares,
    sinAsignar: numeros.filter((n) => !asignados.has(n)),
    costo: mejor.costo,
    segunda: segundoCosto(indices, porNumero, mejor),
    etiquetas,
  };
}

/**
 * El costo de la mejor asignación **distinta** de la elegida.
 *
 * Sirve para el margen: si la segunda cuesta lo mismo, no hay una respuesta,
 * hay dos, y el pie tiene que decirlo en vez de quedarse con la primera.
 * Se calcula prohibiendo, de a una, cada decisión de la ganadora.
 */
function segundoCosto(
  indices: number[],
  porNumero: Map<number, AristaDelPie[]>,
  ganadora: { costo: number; elegidas: (AristaDelPie | null)[] },
): number | null {
  let mejor: number | null = null;
  for (let k = 0; k < indices.length; k += 1) {
    const elegida = ganadora.elegidas[k];
    const alternativas = (porNumero.get(indices[k]) ?? []).filter((a) => a !== elegida);
    const sinAsignar = elegida === null ? [] : [COSTO_DE_NO_ASIGNAR];
    const costos = [...alternativas.map((a) => a.costo), ...sinAsignar];
    if (costos.length === 0) continue;
    const cambio = Math.min(...costos) - (elegida?.costo ?? COSTO_DE_NO_ASIGNAR);
    const total = ganadora.costo + cambio;
    if (mejor === null || total < mejor) mejor = total;
  }
  return mejor;
}

/**
 * ¿Están las palabras de esta etiqueta lo bastante enteras como para creerle?
 *
 * El parecido con una etiqueta canónica tiene que ser **acotado y sobre la
 * frase**, no sobre cualquier pedazo: si alcanzara con que una subcadena se
 * parezca, «descuento total» se parecería a «total» y el veto no serviría de
 * nada. Se pide que la frase tenga al menos una palabra de tres letras, que es
 * lo mínimo que el OCR deja de una etiqueta legible.
 */
export function etiquetaLegible(texto: string): boolean {
  return enPalabras(texto).some((p) => p.length >= 3);
}

/**
 * Qué números están gobernados por una etiqueta que los explica como otra cosa.
 *
 * Es una pregunta más barata que la asignación completa y no necesita
 * resolverla: para saber si el papel ya dice qué es un número alcanza con mirar
 * la frase que tiene pegada a su izquierda en su fila. Resolver el
 * emparejamiento global para esto duplicaba el trabajo más caro del pie sobre un
 * comprobante largo.
 */
export function gobernadosPorUnVeto(
  region: RegionDelPie,
  vetada: (etiqueta: string) => boolean,
  alturaTipica = 0.008,
): Set<Fragmento> {
  const etiquetas = etiquetasDe(region, alturaTipica);
  const salida = new Set<Fragmento>();

  for (const casilla of region.casillas) {
    if (!casilla.esNumero) continue;
    const suya = etiquetas
      .filter((e) => e.fila === casilla.fila && e.x1 <= casilla.fragmento.caja.x0 + 0.002)
      .sort((a, b) => b.x1 - a.x1)[0];
    if (suya && vetada(suya.texto)) salida.add(casilla.fragmento);
  }
  return salida;
}
