import { CAMPOS_NUMERICOS, type CampoDeColumna } from '@/lib/ocr/motor/columnas';
import { alto, centroY, type Caja } from '@/lib/ocr/reconstruccion/evidencia';
import { textoPreferido, type Observacion, type RenglonVisual } from '@/lib/ocr/reconstruccion/agrupar';
import type { ColumnaEspacial } from '@/lib/ocr/reconstruccion/columnas-espaciales';

/**
 * Dónde está cada renglón, según distintas maneras de mirarlo.
 *
 * El esqueleto es la lista de alturas donde hay un renglón. Todo lo demás
 * —qué celda va en cuál— se cuelga de él, así que si el esqueleto está mal, la
 * tabla está mal por más que cada celda se lea perfecto.
 *
 * Y elegirlo no es obvio. Sobre la foto de Lácteos Barraza el código «03» viene
 * en una caja del doble de alto que el resto de su renglón, así que su centro
 * cae casi un renglón más abajo: tomarlo como referencia corre la fila entera.
 * La descripción, en cambio, son cinco palabras de altura pareja que coinciden
 * entre sí.
 *
 * Entonces **no se elige de antemano qué columna manda**. Se arma un esqueleto
 * con cada columna que pueda sostenerlo, y la que gane la decide después el
 * comprobante entero: cuántos renglones sostienen las demás columnas, si las
 * cuentas cierran y si la suma da el neto impreso.
 *
 * Lo que esta capa no hace es elegir. Devuelve hipótesis.
 */

export interface Esqueleto {
  /** De dónde salió: la columna que lo sostiene, o el consenso. */
  origen: string;
  /** Las alturas de los renglones, de arriba hacia abajo. */
  alturas: number[];
  /** Cuántas columnas distintas apoyan esta cantidad de renglones. */
  apoyos: number;
  /** Por qué puede ser buena o mala, para el informe. */
  nota: string;
}

/**
 * La altura de referencia de un grupo de palabras, resistente a una caja rara.
 *
 * Es la **mediana** de los centros de las palabras cuya caja tiene una altura
 * parecida a la de sus vecinas. Las dos cosas hacen falta: la mediana aguanta
 * que una palabra esté fuera de lugar, y descartar las cajas de altura atípica
 * evita justo el caso de Barraza, donde el OCR devuelve el código en una caja
 * del doble de alto y su centro miente casi un renglón.
 *
 * La caja original no se toca: esto es una referencia para agrupar, no una
 * corrección de la evidencia.
 */
export function referenciaRobusta(cajas: Caja[], alturaTipica: number): number {
  if (cajas.length === 0) return 0;

  const parejas = cajas.filter((caja) => {
    if (alturaTipica <= 0) return true;
    const suya = alto(caja);
    return suya <= alturaTipica * 1.4 && suya >= alturaTipica * 0.5;
  });

  const usables = parejas.length > 0 ? parejas : cajas;
  const centros = usables.map(centroY).sort((a, b) => a - b);
  const medio = Math.floor(centros.length / 2);
  return centros.length % 2 === 1
    ? centros[medio]
    : (centros[medio - 1] + centros[medio]) / 2;
}

/**
 * Agrupa las observaciones de **una** columna en renglones.
 *
 * Una columna sola es la mejor referencia posible para el orden vertical: sus
 * valores no se pisan entre sí, así que dos que están a distinta altura son de
 * renglones distintos y punto.
 */
function renglonesDeUnaColumna(
  observaciones: Observacion[],
  alturaTipica: number,
): number[] {
  const ordenadas = [...observaciones].sort((a, b) => centroY(a.caja) - centroY(b.caja));
  const grupos: Caja[][] = [];

  for (const observacion of ordenadas) {
    const ultimo = grupos[grupos.length - 1];
    const referencia = ultimo ? referenciaRobusta(ultimo, alturaTipica) : null;
    if (referencia !== null && Math.abs(centroY(observacion.caja) - referencia) <= alturaTipica * 0.7) {
      ultimo.push(observacion.caja);
      continue;
    }
    grupos.push([observacion.caja]);
  }

  return grupos.map((grupo) => referenciaRobusta(grupo, alturaTipica));
}

/**
 * Todas las hipótesis de esqueleto que la evidencia sostiene.
 *
 * Una por columna que pueda anclar renglones, más una de consenso. Se devuelven
 * ordenadas por cuántas columnas coinciden con su cantidad de renglones: no es
 * la decisión final —ésa la toma la aritmética— pero sí el orden en que conviene
 * probarlas.
 */
export function hipotesisDeEsqueleto(
  cuerpo: RenglonVisual[],
  columnas: ColumnaEspacial[],
  alturaTipica: number,
): Esqueleto[] {
  /*
   * Se juntan las observaciones por columna, sin pasar por los renglones que ya
   * se habían formado: justamente lo que se está poniendo en duda es esa
   * agrupación.
   */
  const porColumna = new Map<number, Observacion[]>();
  for (const renglon of cuerpo) {
    for (const observacion of renglon.observaciones) {
      const indice = columnas.findIndex(
        (columna) =>
          Math.min(observacion.caja.x1, columna.hasta) -
            Math.max(observacion.caja.x0, columna.desde) >
          (observacion.caja.x1 - observacion.caja.x0) / 3,
      );
      if (indice === -1) continue;
      if (!porColumna.has(indice)) porColumna.set(indice, []);
      porColumna.get(indice)!.push(observacion);
    }
  }

  const hipotesis: Esqueleto[] = [];

  for (const [indice, observaciones] of porColumna) {
    const columna = columnas[indice];
    const campo = columna?.campo?.campo;
    if (!campo || campo === 'ignorada') continue;
    // Una columna con menos de dos valores no sostiene un esqueleto.
    if (observaciones.length < 2) continue;

    const alturas = renglonesDeUnaColumna(observaciones, alturaTipica);
    if (alturas.length === 0) continue;

    const atipicas = observaciones.filter(
      (o) => alto(o.caja) > alturaTipica * 1.4 || alto(o.caja) < alturaTipica * 0.5,
    ).length;

    hipotesis.push({
      origen: columna.titulo ?? campo,
      alturas,
      apoyos: 0,
      nota:
        `${alturas.length} renglones según la columna «${columna.titulo ?? campo}»` +
        (atipicas > 0 ? `, con ${atipicas} caja/s de altura atípica descartadas` : ''),
    });
  }

  // El consenso: cuántas columnas coinciden con cada cantidad de renglones.
  const votos = new Map<number, number>();
  for (const una of hipotesis) {
    votos.set(una.alturas.length, (votos.get(una.alturas.length) ?? 0) + 1);
  }
  for (const una of hipotesis) {
    una.apoyos = votos.get(una.alturas.length) ?? 0;
  }

  /*
   * El esqueleto de consenso: las alturas promediadas entre las columnas que
   * coinciden en cuántos renglones hay.
   *
   * Es el que suele ganar, porque promediar varias columnas cancela el error de
   * cualquiera de ellas. Pero no se impone: si una columna sola describe mejor
   * la tabla, la aritmética lo va a mostrar.
   */
  const masVotada = [...votos.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
  if (masVotada && masVotada[1] >= 2) {
    const deAcuerdo = hipotesis.filter((h) => h.alturas.length === masVotada[0]);
    const promediadas = Array.from({ length: masVotada[0] }, (_, i) => {
      const alturas = deAcuerdo.map((h) => h.alturas[i]).sort((a, b) => a - b);
      return alturas[Math.floor(alturas.length / 2)];
    });
    hipotesis.unshift({
      origen: 'consenso',
      alturas: promediadas,
      apoyos: masVotada[1],
      nota:
        `${masVotada[0]} renglones, sostenidos por ${masVotada[1]} columnas ` +
        `(${deAcuerdo.map((h) => `«${h.origen}»`).join(', ')})`,
    });
  }

  return hipotesis.sort((a, b) => b.apoyos - a.apoyos);
}

/**
 * Cuántos renglones espera el comprobante, según evidencia independiente.
 *
 * La cuenta no puede salir de una sola fuente. Si tres columnas sostienen dos
 * filas y una sostiene una porque el OCR perdió un valor, hay dos; y si aparece
 * una línea numérica suelta que ninguna otra columna acompaña, no hay que
 * inventar una fila por ella.
 *
 * Devuelve el consenso y las discrepancias, para poder informarlas en vez de
 * resolverlas en silencio.
 */
export interface ConsensoDeFilas {
  esperadas: number;
  porFuente: { fuente: string; filas: number }[];
  discrepancias: string[];
}

export function consensoDeFilas(hipotesis: Esqueleto[]): ConsensoDeFilas {
  const porFuente = hipotesis
    .filter((h) => h.origen !== 'consenso')
    .map((h) => ({ fuente: h.origen, filas: h.alturas.length }));

  if (porFuente.length === 0) {
    return { esperadas: 0, porFuente, discrepancias: ['Ninguna columna sostiene renglones.'] };
  }

  const votos = new Map<number, number>();
  for (const { filas } of porFuente) votos.set(filas, (votos.get(filas) ?? 0) + 1);

  // Gana la cantidad más votada; a igualdad, la mayor, porque perder un renglón
  // es peor que arrastrar uno de más: el de más se ve, el que falta no.
  const [esperadas] = [...votos.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];

  const discrepancias = porFuente
    .filter((f) => f.filas !== esperadas)
    .map(
      (f) =>
        `«${f.fuente}» sostiene ${f.filas} renglón/es y el consenso dice ${esperadas}: ` +
        (f.filas < esperadas
          ? 'probablemente el OCR perdió un valor de esa columna.'
          : 'probablemente entró ruido como si fuera un renglón.'),
    );

  return { esperadas, porFuente, discrepancias };
}

export { CAMPOS_NUMERICOS, type CampoDeColumna, textoPreferido };
