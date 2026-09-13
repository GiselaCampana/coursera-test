import type { Decimal } from '@/lib/money';
import { esFilaDeEncabezados, llevaNumeros } from '@/lib/ocr/motor/columnas';
import {
  alto,
  centroY,
  unir as unirCajas,
  type Caja,
  type EvidenciaDeLectura,
  type Fragmento,
} from '@/lib/ocr/reconstruccion/evidencia';
import {
  alturaDeRenglon,
  enderezar,
  enGrados,
  medirInclinacion,
  valeLaPenaEnderezar,
  type Inclinacion,
} from '@/lib/ocr/reconstruccion/inclinacion';
import {
  agruparPorLugar,
  armarRenglones,
  esNumerico,
  mejorLectura,
  repartirCelda,
  textoPreferido,
  lecturasAlternativas,
  unirPartidas,
  type LecturaDeCelda,
  type Observacion,
  type RenglonVisual,
} from '@/lib/ocr/reconstruccion/agrupar';

export type { LecturaDeCelda } from '@/lib/ocr/reconstruccion/agrupar';
import {
  columnaDe,
  detectarColumnas,
  type ColumnaEspacial,
  type MetodoDeLimites,
} from '@/lib/ocr/reconstruccion/columnas-espaciales';

/**
 * Reconstruir la tabla de un comprobante a partir de la evidencia del OCR.
 *
 * Es la capa que faltaba. El motor semántico sabe qué hacer con una tabla —qué
 * es cada columna, qué cuentas tienen que cerrar, cuándo no creerle a una
 * lectura— pero hasta ahora recibía **texto ya aplanado**, y sobre una foto de
 * teléfono ese texto llega con los renglones partidos y las columnas cruzadas.
 * Ningún perfil guardado arregla eso: una persona puede decir qué significa una
 * columna, no puede recuperar veinte renglones que se perdieron antes.
 *
 * Acá se trabaja con coordenadas, con todas las pasadas juntas, y el resultado
 * no es «la tabla» sino **la tabla con su procedencia**: de qué pasada salió
 * cada valor, qué alternativas tenía, qué celdas quedaron sin leer y cuáles
 * quedaron ambiguas. Eso es lo que después permite pedirle a una persona lo
 * único que hace falta, en vez de la tabla entera.
 */

export type EstadoDeCelda =
  /** Se leyó y hay una sola lectura con apoyo. */
  | 'leida'
  /** Hay más de una lectura posible y ninguna manda. */
  | 'ambigua'
  /** No hay nada en esa posición del renglón. */
  | 'no-leida'
  /**
   * Una persona la leyó del papel y la dio por buena.
   *
   * No vuelve a competir con lo que el OCR había leído: eso ya se decidió, y
   * mirando el original, que es más de lo que el motor puede hacer. Lo que sí
   * se recalcula es todo lo que **dependía** de ella.
   */
  | 'confirmada';

export interface Procedencia {
  pasada: string;
  confianza: number;
  /** Dónde está en la foto original, sin enderezar: para poder señalarlo. */
  caja: Caja;
}

export interface CeldaReconstruida {
  columna: number;
  texto: string | null;
  /** Todas las lecturas posibles, la elegida primero, cada una con su origen. */
  alternativas: LecturaDeCelda[];
  estado: EstadoDeCelda;
  procedencia: Procedencia | null;
}

export type EstadoDeRenglon =
  | 'completo'
  | 'incompleto'
  /** Tiene valores que no caen en ninguna columna: casi siempre son de otra fila. */
  | 'contaminado';

export interface RenglonReconstruido {
  /** Altura en la página, para poder ordenarlos y señalarlos. */
  y: number;
  caja: Caja;
  celdas: (CeldaReconstruida | null)[];
  /** Lo que no entró en ninguna columna. */
  sobrantes: { texto: string; caja: Caja }[];
  estado: EstadoDeRenglon;
}

export interface TablaReconstruida {
  columnas: ColumnaEspacial[];
  metodo: MetodoDeLimites;
  /** Los títulos tal como se leyeron. */
  encabezados: string[];
  renglones: RenglonReconstruido[];
  /** Cuántas líneas de texto se vieron entre la tabla, antes de interpretarlas. */
  filasVisibles: number;
  inclinacionGrados: number;
  seEnderezo: boolean;
  alturaTipica: number;
  notas: string[];
  /** Cuántos valores salieron de una pasada distinta de la principal. */
  valoresDeOtraPasada: number;
  ms: number;
}

export interface OpcionesDeReconstruccion {
  /** Sólo se reconstruye lo que esté entre estas alturas de la página. */
  desdeY?: number;
  hastaY?: number;
  /**
   * Los netos que se leyeron en el pie, con cualquiera de las dos convenciones.
   *
   * Es una evidencia más para saber qué es cada columna: la columna de montos
   * cuya suma da el neto impreso es el importe del renglón, y eso lo dice el
   * comprobante entero sin depender de ningún encabezado. Es opcional porque la
   * reconstrucción tiene que funcionar igual sin el pie.
   */
  netosPosibles?: Decimal[];
}

/**
 * La pasada que se considera principal, para poder contar de dónde vino cada valor.
 *
 * Es la de la página completa: la que existiría si no hubiera relectura. Contar
 * cuántos valores vinieron de otra es la medida de cuánto aporta leer varias
 * veces, y hasta ahora no se podía saber porque los textos se pegaban.
 */
const PASADA_PRINCIPAL = 'completo:directo';

/**
 * Lo que la reconstrucción tiene listo antes de decidir dónde va cada celda.
 *
 * Se expone para poder armar **varias** candidatas de tabla sobre la misma
 * evidencia sin volver a leer, enderezar y delimitar columnas tres veces.
 */
export interface ContextoDeTabla {
  cuerpo: RenglonVisual[];
  columnas: ColumnaEspacial[];
  metodo: MetodoDeLimites;
  encabezados: string[];
  alturaTipica: number;
  inclinacionGrados: number;
  seEnderezo: boolean;
  notas: string[];
  hayColumnasNumericas: boolean;
}

export function reconstruirTabla(
  evidencia: EvidenciaDeLectura,
  opciones: OpcionesDeReconstruccion = {},
): TablaReconstruida {
  const { tabla } = reconstruirConContexto(evidencia, opciones);
  return tabla;
}

export function reconstruirConContexto(
  evidencia: EvidenciaDeLectura,
  opciones: OpcionesDeReconstruccion = {},
): { tabla: TablaReconstruida; contexto: ContextoDeTabla } {
  const comienzo = Date.now();
  const notas: string[] = [];

  const desdeY = opciones.desdeY ?? 0;
  const hastaY = opciones.hastaY ?? 1;
  const enRango = evidencia.fragmentos.filter((f) => {
    const y = centroY(f.caja);
    return y >= desdeY && y <= hastaY && !esRuido(f.texto);
  });
  const descartados = evidencia.fragmentos.length - enRango.length;
  if (descartados > 0) notas.push(`${descartados} fragmentos descartados por no tener ningún carácter legible.`);

  // --- Enderezar -----------------------------------------------------------
  const alturaCruda = alturaDeRenglon(enRango);
  const inclinacion: Inclinacion = medirInclinacion(enRango);
  const corregir = valeLaPenaEnderezar(inclinacion, alturaCruda);
  const enderezados = enderezar(enRango, corregir ? inclinacion : { pendiente: 0, apoyos: 0 });
  if (corregir) {
    notas.push(
      `Se corrigió una inclinación de ${enGrados(inclinacion).toFixed(2)}° ` +
        `(${inclinacion.apoyos} apoyos).`,
    );
  }

  // --- Juntar lo que dijeron todas las pasadas -----------------------------
  const observaciones = agruparPorLugar(enderezados);
  const alturaTipica = alturaDeRenglon(enderezados) || alturaCruda;

  // --- Renglones visuales --------------------------------------------------
  const visuales = armarRenglones(observaciones, alturaTipica).map((renglon) => ({
    ...renglon,
    observaciones: unirPartidas(renglon, alturaTipica),
  }));

  // --- La fila de títulos --------------------------------------------------
  const titulos = encontrarTitulos(visuales);
  if (!titulos) notas.push('No se encontró una fila de títulos entre los renglones visibles.');

  const cuerpo = cortarEnElPie(
    titulos ? visuales.filter((r) => r.y > titulos.y) : visuales,
    notas,
  );

  // --- Columnas ------------------------------------------------------------
  const limites = detectarColumnas(cuerpo, titulos, alturaTipica, opciones.netosPosibles ?? []);
  notas.push(...limites.notas);

  // --- Celdas --------------------------------------------------------------
  const hayColumnasNumericas = limites.columnas.some((c) => llevaNumeros(c.campo?.campo));
  const renglones: RenglonReconstruido[] = [];
  let valoresDeOtraPasada = 0;

  for (const visual of cuerpo) {
    const celdas: (CeldaReconstruida | null)[] = limites.columnas.map(() => null);
    const sobrantes: { texto: string; caja: Caja }[] = [];
    const enConflicto: Observacion[][] = limites.columnas.map(() => []);

    for (const observacion of visual.observaciones) {
      const indice = columnaDe(observacion, limites.columnas);
      if (indice === null) {
        sobrantes.push({ texto: textoPreferido(observacion), caja: observacion.caja });
        continue;
      }
      enConflicto[indice].push(observacion);
    }

    enConflicto.forEach((competidoras, i) => {
      if (competidoras.length === 0) return;
      celdas[i] = armarCelda(i, competidoras);
      const procedencia = celdas[i]!.procedencia;
      if (procedencia && procedencia.pasada !== PASADA_PRINCIPAL) valoresDeOtraPasada += 1;
    });

    const llenas = celdas.filter((c) => c !== null).length;
    // Una línea con una sola celda no es un renglón de la tabla: es un
    // comentario, un pie de página o basura del borde.
    if (llenas < 2) continue;

    /*
     * Y un renglón de una tabla de precios tiene **algún número**.
     *
     * Sobre la foto de Mabelherdi el OCR produce cuatro líneas de basura entre
     * los artículos —«LENIN NAL | UR EE ERE», «MI | eN»— que llenan dos celdas
     * y pasan por renglones. No son inofensivas: cuentan como filas sin
     * importe, y con eso el control de integridad concluye que a la factura le
     * faltan renglones. Los nueve artículos buenos, que suman exactamente el
     * neto impreso, quedaban sin confirmar por culpa de cuatro líneas que no
     * dicen nada.
     *
     * Se pide un dígito en alguna columna que entre en las cuentas. No alcanza
     * con que haya un dígito en cualquier lado: «956X30X1» está en la
     * descripción de un artículo y no lo vuelve un renglón.
     */
    const tieneAlgunNumero = celdas.some((celda, i) => {
      if (celda === null || !/\d/.test(celda.texto ?? '')) return false;
      // Cuando ninguna columna se reconoció no hay dónde mirar, así que sirve
      // un número en cualquier celda. Con columnas reconocidas, en cambio, se
      // exige que el número esté en una **columna de números**: «956X30X1» está
      // en la descripción de un artículo y no vuelve renglón a una línea.
      //
      // Que la columna todavía no tenga semántica confirmada no importa acá: la
      // pregunta es si ahí van números, no cuáles. Una columna de montos sin
      // encabezado legible sigue siendo la prueba de que la línea es un artículo.
      if (!hayColumnasNumericas) return true;
      return llevaNumeros(limites.columnas[i]?.campo?.campo);
    });
    if (!tieneAlgunNumero) continue;

    renglones.push({
      y: visual.y,
      caja: visual.caja,
      celdas,
      sobrantes,
      estado:
        sobrantes.length > 0
          ? 'contaminado'
          : llenas === limites.columnas.length
            ? 'completo'
            : 'incompleto',
    });
  }

  const contexto: ContextoDeTabla = {
    cuerpo,
    columnas: limites.columnas,
    metodo: limites.metodo,
    encabezados: titulos ? titulos.observaciones.map((o) => textoPreferido(o)) : [],
    alturaTipica,
    inclinacionGrados: enGrados(inclinacion),
    seEnderezo: corregir,
    notas,
    hayColumnasNumericas,
  };

  return {
    contexto,
    tabla: {
      columnas: limites.columnas,
      metodo: limites.metodo,
      encabezados: contexto.encabezados,
      renglones,
      filasVisibles: cuerpo.length,
      inclinacionGrados: enGrados(inclinacion),
      seEnderezo: corregir,
      alturaTipica,
      notas,
      valoresDeOtraPasada,
      ms: Date.now() - comienzo,
    },
  };
}

/**
 * Arma una celda con las observaciones que compiten por ella.
 *
 * Cuando hay una sola, es la celda. Cuando hay varias, **no se elige**: se deja
 * la de más apoyo adelante y las otras como alternativas, y la celda queda
 * marcada como ambigua. Elegir acá sería elegir sin haber hecho ninguna cuenta,
 * y la cuenta es lo único que puede distinguir un importe real de uno que el
 * OCR partió al medio.
 */
export function armarCelda(columna: number, competidoras: Observacion[]): CeldaReconstruida {
  if (competidoras.length === 1) {
    const observacion = competidoras[0];
    const alternativas = lecturasAlternativas(observacion);
    const lectura = mejorLectura(observacion);
    return {
      columna,
      texto: alternativas[0].texto,
      alternativas,
      // Que el propio OCR haya dudado también es ambigüedad, no ruido.
      estado: alternativas.length > 1 ? 'ambigua' : 'leida',
      procedencia: { pasada: lectura.pasada, confianza: lectura.confianza, caja: lectura.caja },
    };
  }

  /*
   * Varias observaciones en la misma columna del mismo renglón.
   *
   * Antes de juntar nada hay que decidir **qué es cada una**: los pedazos de una
   * descripción van uno al lado del otro y se juntan; las lecturas que ocupan el
   * mismo lugar son la misma cosa vista por pasadas distintas y no se juntan
   * nunca, compiten. Pegar las dos cosas es lo que producía celdas que no
   * existen en ningún papel, como «27.937,3527937,35».
   */
  const reparto = repartirCelda(competidoras);
  const partes = reparto.partes.map((o) => textoPreferido(o));

  /*
   * Los pedazos de un número se pegan sin espacio; las palabras, con.
   *
   * El OCR parte los importes por la coma —«22.800» y «,00»— y los dos pedazos
   * caen en la misma columna. Unirlos con un espacio da «22.800 ,00», que no es
   * un número y deja el renglón sin importe. Una descripción de dos palabras,
   * en cambio, necesita el espacio.
   */
  const juntas = partes.join(partes.every(esNumerico) ? '' : ' ');
  const lectura = mejorLectura(reparto.partes[0]);
  const cajaDeTodas = reparto.partes.map((o) => mejorLectura(o).caja).reduce(unirCajas);

  /*
   * Lo descartado no se pierde: queda como alternativa de la celda, con su
   * pasada y su caja. Si el reparto elegido no hace cerrar el renglón, la otra
   * manera de leerlo sigue estando, y una persona puede verla señalada en la
   * foto en vez de tener que volver al papel.
   */
  const deLasQueCompetian = reparto.alternativas.flatMap((o) => lecturasAlternativas(o));

  const alternativas: LecturaDeCelda[] =
    reparto.partes.length === 1
      ? [...lecturasAlternativas(reparto.partes[0]), ...deLasQueCompetian]
      : [
          { texto: juntas, caja: cajaDeTodas, pasada: lectura.pasada, confianza: lectura.confianza },
          ...reparto.partes.map((o) => {
            const suya = mejorLectura(o);
            return {
              texto: suya.texto,
              caja: suya.caja,
              pasada: suya.pasada,
              confianza: suya.confianza,
            };
          }),
          ...deLasQueCompetian,
        ];

  const sinRepetidas = alternativas.filter(
    (a, i) => alternativas.findIndex((b) => b.texto === a.texto) === i,
  );

  return {
    columna,
    texto: juntas,
    alternativas: sinRepetidas,
    estado: sinRepetidas.length > 1 ? 'ambigua' : 'leida',
    procedencia: { pasada: lectura.pasada, confianza: lectura.confianza, caja: lectura.caja },
  };
}

/**
 * Lo que nunca es un dato: un fragmento sin una sola letra ni un solo dígito.
 *
 * El borde de la tabla sale como «|», las líneas de separación como «—», y una
 * mancha del papel como «]». Son decenas por factura y no son inofensivos: al
 * proyectar los datos sobre el ancho de la página tapan los corredores entre
 * columnas, y una tabla de ocho columnas termina siendo una sola.
 *
 * Se descarta por **no tener contenido**, no por ser corto: «3» es un código de
 * artículo válido y «6» una cantidad, y las dos tienen un carácter.
 */
export function esRuido(texto: string): boolean {
  return !/[\p{L}\p{N}]/u.test(texto);
}

/**
 * Corta la tabla donde empieza el pie.
 *
 * El pie tiene números grandes y creíbles repartidos en columnas, así que sus
 * líneas pasan por renglones perfectamente: sobre la factura de Mabelherdi, la
 * línea «Neto $32998.85 IVA 21.00% $6929.76» entraba como un artículo más.
 *
 * Se corta en la primera línea que **empieza** con una etiqueta de pie. Que sea
 * al principio importa: «BONIFICACION ESPECIAL» es un nombre de artículo
 * legítimo en el medio de una descripción, y cortar ahí perdería la mitad de la
 * tabla.
 */
const EMPIEZA_EL_PIE =
  /^(sub\s?-?\s?total|total\b|neto\b|i\.?\s?v\.?\s?a\.?\b|percep|perc\b|descuentos?\b|saldo|son\s+pesos|pesos\b|comentario|transporte)/i;

/**
 * Las etiquetas del pie que **no pueden estar en el medio de una tabla**.
 *
 * La lista de arriba se prueba al principio de la línea, y ahí tiene que ser
 * generosa: «IVA», «Neto» o «Total» pegados al margen izquierdo son del pie.
 * Ésta se prueba en **cualquier posición**, así que tiene que ser mucho más
 * corta: «IVA» aparece en la columna de alícuotas de cada artículo, y cortar la
 * tabla ahí la dejaría vacía.
 *
 * Lo que queda son las que nombran un concepto fiscal completo. Ninguna puede
 * aparecer adentro del nombre de un artículo.
 */
const ETIQUETA_FISCAL =
  /^(neto\s*(gravado|no\s*gravado)?|no\s*gravado|totales?|percep\w*|sub\s?-?\s?totales?|son\s+pesos)$/i;

/**
 * Corta la tabla donde empieza el pie.
 *
 * El pie tiene números grandes y creíbles repartidos en columnas, así que sus
 * líneas pasan por renglones perfectamente: sobre la factura de Mabelherdi, la
 * línea «Neto $32998.85 IVA 21.00% $6929.76» entraba como un artículo más.
 *
 * Se busca de dos maneras, y las dos hacen falta:
 *
 *  - una etiqueta de pie **al principio** de la línea, con la lista larga. Que
 *    sea al principio importa: «BONIFICACION ESPECIAL» es un nombre de artículo
 *    legítimo en el medio de una descripción, y cortar ahí perdería media tabla;
 *
 *  - una etiqueta fiscal **en cualquier posición**, con la lista corta. Hace
 *    falta porque el pie no siempre arranca pegado al margen: sobre la factura
 *    de Errecalde el «Neto Gravado» cae a un tercio del ancho, debajo de las
 *    columnas de unidad y cantidad, y con la primera regla sola trece líneas de
 *    pie —el neto, el IVA, las dos percepciones, el total y la leyenda— seguían
 *    adentro del cuerpo. No eran inofensivas: ensuciaban el perfil de todas las
 *    columnas, inventaban renglones y dejaban el conteo de artículos en cualquier
 *    cosa menos en el que tiene el papel.
 */
function cortarEnElPie(renglones: RenglonVisual[], notas: string[]): RenglonVisual[] {
  for (let i = 0; i < renglones.length; i++) {
    const textos = renglones[i].observaciones.map((o) => textoPreferido(o).trim());
    const primeras = textos.slice(0, 2).join(' ').trim();

    const porElPrincipio = EMPIEZA_EL_PIE.test(primeras);
    const fiscal = textos.find((t) => ETIQUETA_FISCAL.test(t));
    if (!porElPrincipio && fiscal === undefined) continue;

    const donde = porElPrincipio ? primeras : fiscal!;
    notas.push(`La tabla se cortó en «${donde.slice(0, 40)}», que es del pie.`);
    return renglones.slice(0, i);
  }
  return renglones;
}

/**
 * La fila de títulos, buscada entre los renglones visuales.
 *
 * Se elige el renglón **más alto de la página** que reconozca al menos tres
 * campos distintos. Más alto y no el que más reconozca: en un comprobante con
 * la tabla repetida —una segunda página, o un total por sección— el que vale es
 * el primero, y el criterio de «el que más reconoce» elegiría cualquiera de los
 * dos según cómo salió la foto.
 */
function encontrarTitulos(renglones: RenglonVisual[]): RenglonVisual | null {
  for (const renglon of renglones) {
    const textos = renglon.observaciones.map((o) => textoPreferido(o));
    if (textos.length < 3) continue;
    if (esFilaDeEncabezados(textos)) return renglon;
  }
  return null;
}

export { alto, type Fragmento };
