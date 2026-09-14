import { Decimal } from '@/lib/money';
import type { Caja, Fragmento } from '@/lib/ocr/reconstruccion/evidencia';
import {
  desdeLaPalabra,
  dondeTerminaElVeto,
  lecturasPisadas,
  noPuedenSerImportes,
  regionesDelPie,
  textosDeLaBanda,
  type RegionDelPie,
} from '@/lib/ocr/motor/region-del-pie';
import { parecido } from '@/lib/ocr/motor/semantica-de-columnas';
import {
  bienEscrito,
  formatoDeColumna,
  lecturasDeCelda,
  type FormatoDeColumna,
  type LecturaNumerica,
} from '@/lib/ocr/motor/formato-de-columna';
import { repararDigitos } from '@/lib/ocr/parsers/tipos';
import { DERIVED_SUGGESTION } from '@/lib/ocr/motor/sugerencias';
import { decimalesDe } from '@/lib/ocr/motor/precision';

/**
 * El pie fiscal como un grafo de relaciones, no como una lista de etiquetas.
 *
 * Hasta acá el pie se leía buscando palabras: «Neto», «IVA», «Percep», «Total»,
 * cada una con su expresión regular, y el número que venía después. Funciona en
 * cuatro de las seis facturas del banco y falla entero en la quinta, donde el
 * OCR devolvió las etiquetas mutiladas —«UBTOTA», «I.V.A 2», «ercep»— y no hay
 * ninguna palabra que reconocer. Ahí el pie salía en `null` y con él se perdía
 * el control más fuerte que tiene el motor.
 *
 * Y el problema de fondo es peor que las etiquetas. Un pie fiscal **no es** una
 * lista de campos: es un sistema de igualdades. La suma del detalle es el neto
 * gravado; el IVA de cada alícuota es el neto por esa alícuota; el total es el
 * neto más los IVAs más las percepciones. Cada número del pie participa de por
 * lo menos una de esas igualdades, y ahí está la información que las etiquetas
 * no tienen: un número que cumple «neto × 0,21» es el IVA **aunque su etiqueta
 * sea ilegible**, y un número que no cumple ninguna igualdad no es parte del pie
 * por más que diga «Total» al lado —el saldo acumulado de cuenta corriente de
 * una de las facturas dice exactamente eso—.
 *
 * ## Las preferencias, en orden
 *
 * Igual que en el resto del motor, no hay suma de puntajes: hay un orden.
 *
 *  1. **la lectura literal**, los separadores como están impresos;
 *  2. **la etiqueta y la posición compatibles** con el concepto;
 *  3. **la relación fiscal exacta** dentro de la precisión impresa;
 *  4. **menos reparaciones**;
 *  5. y **margen suficiente** contra la segunda mejor asignación: sin margen no
 *     hay una respuesta, hay dos, y eso va a revisión.
 *
 * ## Lo que no se hace
 *
 * No se inventa el total. Si ninguna evidencia lo trae, se informa **calculado**
 * y queda dicho que no se leyó del papel. No se fija la cantidad de
 * percepciones: admite cero, una o varias, porque los papeles traen las tres
 * cosas. Y no se elige por magnitud: que un número se parezca a lo que falta
 * para cerrar no lo convierte en ese concepto.
 */

/**
 * De dónde salió un dato del pie. Son cuatro y **no se mezclan**.
 *
 * La distinción existe porque las cuatro se ven iguales en una pantalla y no
 * valen lo mismo. Un total calculado ayuda a revisar; presentarlo como el
 * importe impreso es decirle a alguien que el papel dice algo que no dice, y
 * ése es el número contra el que se paga.
 *
 *  - `READ_FROM_DOCUMENT`: el número está en la foto y su etiqueta lo nombra.
 *    Es el único caso en que el dato se puede tratar como impreso;
 *  - `INFERRED_FROM_DOCUMENT_RELATIONS`: el número está en la foto pero lo que
 *    lo identifica es una igualdad fiscal, porque su etiqueta salió ilegible o
 *    no existe. El **valor** es del papel; el **concepto** lo puso el motor;
 *  - `DERIVED_SUGGESTION`: el número no está en la foto y sale de una cuenta.
 *    No es un dato: es una ayuda para revisar;
 *  - `MISSING`: no está y no se puede calcular.
 */
export type ProcedenciaFiscal =
  | 'READ_FROM_DOCUMENT'
  | 'INFERRED_FROM_DOCUMENT_RELATIONS'
  | 'DERIVED_SUGGESTION'
  | 'MISSING';

/**
 * Cuán completo está el pie.
 *
 * `completo` quiere decir algo muy preciso: **todo lo que hace falta está leído
 * del papel y el sistema cierra**. No alcanza con tener un número para cada
 * concepto, y no alcanza con que la cuenta dé: un pie donde el total se calculó
 * está parcial, y un pie donde la suma de los conceptos no llega al total
 * impreso también, porque esa diferencia es un concepto que no se leyó.
 */
export type EstadoDelPie = 'completo' | 'parcial' | 'ausente';

export type ConceptoFiscal =
  /** El neto gravado, que es lo que totaliza el detalle. */
  | 'netoGravado'
  /** Lo que no lleva IVA: envases, impuestos internos ya incluidos. */
  | 'noGravado'
  /** El IVA de una alícuota. */
  | 'iva'
  /** Una percepción: IVA, IIBB, municipal. Puede haber cero, una o varias. */
  | 'percepcion'
  /** El total del comprobante. */
  | 'total';

/** Las alícuotas de IVA que existen en Argentina. No hay otras. */
export const ALICUOTAS = [
  new Decimal('0.21'),
  new Decimal('0.105'),
  new Decimal('0.27'),
  new Decimal('0.025'),
  new Decimal('0.05'),
];

/**
 * Las etiquetas de cada concepto, en su forma canónica.
 *
 * Se comparan por **parecido** y no por coincidencia exacta, así que «UBTOTA»
 * encuentra «subtotal» y «ercepcion» encuentra «percepcion». Lo que no hacen es
 * decidir solas: una etiqueta parecida es el segundo nivel de preferencia, y la
 * igualdad fiscal es el tercero.
 */
const ETIQUETAS: [ConceptoFiscal, string[]][] = [
  /*
   * El orden importa en un solo lugar: «no gravado» tiene que probarse antes
   * que «gravado», porque la segunda está contenida en la primera y a igual
   * parecido gana la que se probó primero. Son conceptos opuestos y
   * confundirlos mete en el neto gravado lo que justamente no lo está.
   */
  ['noGravado', ['no gravado', 'exento', 'impuestos internos']],
  ['netoGravado', ['subtotal', 'neto gravado', 'importe neto', 'neto', 'gravado']],
  ['percepcion', ['percepcion', 'percepciones', 'perc', 'retencion']],
  ['iva', ['iva']],
  ['total', ['total', 'son pesos']],
];

/** Qué tan parecida tiene que ser una etiqueta para contar como degradada. */
const PARECIDO_DE_ETIQUETA = 0.6;

/**
 * Palabras que anuncian un **identificador**, no un importe.
 *
 * «Percepción IVA RG 5329» trae la palabra que importa y después el número de
 * la resolución general que la crea, y sin esta lista ese 5329 entraba como una
 * percepción de cinco mil trescientos veintinueve pesos. Es una distinción de
 * lenguaje y no de magnitud: lo que viene detrás de «RG», de «Res.» o de «Nro.»
 * nombra una norma o un comprobante, no dice cuánta plata es.
 */
const ANTES_DE_UN_IDENTIFICADOR = new Set([
  'rg',
  'res',
  'resol',
  'resolucion',
  'nro',
  'no',
  'num',
  'ley',
  'art',
  'cuit',
  'cae',
  'caea',
]);

/**
 * Con cuántos decimales está **escrito** un número, no cuántos tiene su valor.
 *
 * La diferencia importa: «1,00» y «1» valen lo mismo y no están escritos igual,
 * y el valor `Decimal` de los dos pierde el cero. Lo que hace falta para
 * comparar formatos es lo que dice el papel.
 */
export function decimalesEscritos(texto: string): number {
  const limpio = repararDigitos(texto).replace(/[^\d.,]/g, '').trim();
  const forma = bienEscrito(limpio);
  return forma.si ? forma.decimales : -1;
}

/** ¿Es este número el identificador que anuncia la última palabra de su etiqueta? */
export function esIdentificador(etiqueta: string): boolean {
  const palabras = enPalabras(etiqueta);
  const ultima = palabras[palabras.length - 1];
  return ultima !== undefined && ANTES_DE_UN_IDENTIFICADOR.has(ultima);
}

/**
 * Etiquetas que **no** son del pie fiscal aunque se parezcan.
 *
 * El saldo acumulado de cuenta corriente de una de las facturas del banco es
 * más grande que el total de la factura y está impreso al lado, con la palabra
 * «Total» a la vista. Lo que lo descarta no es su magnitud: es que no cumple
 * ninguna igualdad del pie y que su propia etiqueta dice otra cosa.
 */
const AJENAS = [
  'saldo anterior',
  'saldo acumulado',
  'saldo ac',
  'cuenta corriente',
  'vencimiento',
  /*
   * Y los totales que **no son de plata**. Casi todas las facturas de
   * fiambrería traen un «Total Kgs.» o un «Total Bultos» al pie del detalle,
   * que dice la misma palabra y cuenta otra cosa: sobre una del banco, el pie
   * salía con un total de 57 —los kilos— en vez del importe.
   */
  'total kgs',
  'total kg',
  'total kilos',
  'total bultos',
  'total unidades',
  'total items',
  'total articulos',
  'cantidad total',
];

export interface OrigenFiscal {
  texto: string;
  caja: Caja;
  pasada: string;
  confianza: number;
}

export interface AsignacionFiscal {
  concepto: ConceptoFiscal;
  valor: Decimal;
  /** De qué fragmento del papel salió. */
  origen: OrigenFiscal;
  /** La lectura literal, cuando el texto admite una. */
  lecturaLiteral: Decimal | null;
  /** Las demás lecturas del mismo fragmento, con lo que cuesta cada una. */
  alternativas: { valor: Decimal; reparaciones: number; comoSeLeyo: string }[];
  /** La alícuota asociada, si está impresa junto a la etiqueta. */
  alicuota: Decimal | null;
  /** Qué igualdad cumple, en castellano. Null cuando no cumple ninguna. */
  igualdad: string | null;
  /** Cuántos separadores hubo que suponer para leer el valor elegido. */
  costoDeReparacion: number;
  /** La etiqueta que lo sostiene, y si estaba entera. */
  etiqueta: { texto: string; exacta: boolean; parecido: number } | null;
  /** La segunda mejor asignación del mismo fragmento. */
  segunda: { concepto: ConceptoFiscal; valor: Decimal; porQue: string } | null;
  /** Cuánta ventaja tiene la elegida sobre la segunda, de 0 a 1. */
  margen: number;
  /**
   * De dónde salió este dato.
   *
   * `READ_FROM_DOCUMENT` cuando el número está en la foto **y** su etiqueta lo
   * nombra; `INFERRED_FROM_DOCUMENT_RELATIONS` cuando está en la foto y lo que
   * lo identifica es una igualdad. Las dos son datos del papel y la segunda es
   * más frágil: si la igualdad se sostenía en un neto mal leído, el concepto
   * está mal asignado aunque el número sea correcto.
   */
  procedencia: ProcedenciaFiscal;
}

export interface PieFiscal {
  netoGravado: Decimal | null;
  noGravado: Decimal | null;
  /** Un renglón por alícuota. Vacío si el comprobante no discrimina IVA. */
  iva: { alicuota: Decimal | null; valor: Decimal }[];
  /** Cero, una o varias. */
  percepciones: { etiqueta: string; valor: Decimal }[];
  total: Decimal | null;
  /**
   * ¿El total salió de una cuenta en vez de del papel?
   *
   * Cuando ninguna evidencia lo trae se informa calculado, y queda dicho. Lo que
   * no puede pasar es presentarlo como leído.
   */
  totalCalculado: boolean;
  /** Todo lo asignado, con su procedencia y su margen. */
  asignaciones: AsignacionFiscal[];
  /** Qué quedó sin decidir y necesita que lo mire una persona. */
  enRevision: string[];
  /**
   * Cuán completo está: leído entero y cerrando, o parcial, o ausente.
   *
   * No se informa `completo` por tener un número en cada casillero. Un total
   * calculado no completa el pie.
   */
  estado: EstadoDelPie;
  /**
   * Qué falta, en castellano y sin inventarlo.
   *
   * Cuando el total impreso no coincide con la suma de los conceptos, la
   * diferencia **permite sospechar** que falta un concepto y no autoriza a
   * crearlo: acá se dice de cuánto es el hueco y nada más. Asignarle un nombre
   * y un importe sería cerrar el pie con un dato inventado.
   */
  faltantes: string[];
  /**
   * La diferencia entre el total leído y la suma de los conceptos.
   *
   * Null cuando no hay total leído o cuando cierra. Distinto de cero es la
   * medida exacta de lo que no se leyó.
   */
  residuo: Decimal | null;
  /**
   * De qué región del papel salió esta lectura del pie.
   *
   * Va en el informe porque es lo que permite auditar la decisión: dos regiones
   * del mismo comprobante dan dos pies distintos, compiten, y quien revise tiene
   * que poder ver cuál ganó y buscarla en la foto.
   */
  region?: string;
}

// ---------------------------------------------------------------------------
// Armar las líneas del pie
// ---------------------------------------------------------------------------

interface LineaFiscal {
  /** El texto de la línea, en orden de izquierda a derecha. */
  texto: string;
  y: number;
  /** Los fragmentos con algún dígito, que son los candidatos a valor. */
  numericos: Fragmento[];
  /** El texto que está a la izquierda de un número, en su propia línea. */
  etiquetaDe: (numero: Fragmento) => string;
  /**
   * Lo mismo, pero admitiendo una línea de distancia.
   *
   * Es el recurso para los pies de dos columnas, donde las etiquetas van a la
   * izquierda y los importes al margen derecho y sobre una foto de teléfono las
   * dos columnas no quedan a la misma altura. Se usa **sólo** cuando la
   * etiqueta de la propia línea no dice nada reconocible: aplicada siempre, se
   * lleva también las palabras de las líneas vecinas y con ellas el saldo
   * acumulado de cuenta corriente pasa a competir como total del comprobante.
   */
  etiquetaCercaDe: (numero: Fragmento) => string;
  /**
   * ¿Es este número el identificador que anuncia la palabra pegada a su
   * izquierda?
   *
   * Se pregunta por la palabra **pegada** y no por la etiqueta entera, y la
   * diferencia se midió: «Percepción IVA RG» termina en «RG» y el importe de
   * esa percepción está a media pulgada a la derecha, así que mirando la última
   * palabra de la etiqueta el importe verdadero se descartaba junto con el
   * número de la resolución. Lo que hace a un número un identificador es estar
   * inmediatamente después del marcador, no compartir línea con él.
   */
  esIdentificadorDe: (numero: Fragmento) => boolean;
}

/** Qué tan cerca tiene que estar el marcador para que el número sea su identificador. */
const PEGADO = 0.03;

/**
 * Hasta dónde se busca la etiqueta de un número, hacia la izquierda.
 *
 * Un tercio del ancho de la página. La etiqueta de un renglón fiscal está del
 * mismo lado que su valor —«Subtotal    473.232,44»— y lo que hay más a la
 * izquierda es otra cosa: en estas fotos, el texto del encabezado de la
 * imprenta, el «Comprobante Autorizado» del pie de página y la leyenda de la
 * AFIP caen a la misma altura que los renglones del resumen.
 *
 * No menos de un tercio, porque entre la etiqueta y el importe puede haber una
 * columna: «Perc IIBB CABA   1,50 %   7.098,49» pone la alícuota en el medio y
 * con una ventana más angosta el importe se queda sin etiqueta.
 *
 * Sin esta ventana, la «etiqueta» de cada número era una tira de sesenta
 * palabras de toda la franja de la hoja, con las cuatro palabras fiscales
 * adentro a la vez: todo se parecía a todo y el pie salía cualquier cosa.
 */
const VENTANA_DE_ETIQUETA = 0.35;

/**
 * Quita los fragmentos repetidos entre pasadas.
 *
 * El mismo número lo leen hasta siete pasadas de OCR, y cada una deja su
 * fragmento. Para la evidencia eso es lo correcto —tres lecturas iguales valen
 * más que una—, pero para el pie produce cuatro IVAs idénticos y un informe
 * ilegible. Se quedan una vez cada texto por lugar, con la de mayor confianza.
 */
function sinRepetidos(fragmentos: Fragmento[]): Fragmento[] {
  const porLugar = new Map<string, Fragmento>();
  for (const fragmento of fragmentos) {
    const clave = [
      fragmento.texto.trim(),
      fragmento.caja.x0.toFixed(2),
      fragmento.caja.y0.toFixed(2),
    ].join('|');
    const ya = porLugar.get(clave);
    if (!ya || fragmento.confianza > ya.confianza) porLugar.set(clave, fragmento);
  }
  return [...porLugar.values()];
}

/**
 * Agrupa los fragmentos en líneas por su altura.
 *
 * El pie se lee en líneas y no en columnas porque su estructura es «etiqueta a
 * la izquierda, valor a la derecha», y eso vale igual en un pie de cuatro
 * renglones al margen derecho y en uno de una sola línea con tres conceptos
 * seguidos.
 */
export function lineasDelPie(fragmentos: Fragmento[], alturaTipica: number): LineaFiscal[] {
  const tolerancia = Math.max(alturaTipica * 0.5, 0.003);
  /*
   * La etiqueta puede estar **una línea más arriba o más abajo** que su valor.
   *
   * Pasa en los pies de dos columnas, que son mayoría: las etiquetas van
   * alineadas a la izquierda y los importes al margen derecho, y sobre una foto
   * de teléfono las dos columnas no quedan a la misma altura. En una factura
   * del banco «Neto Gravado» y su importe están a siete milésimos de página de
   * distancia —casi dos alturas de renglón— y cada uno cae en un grupo
   * distinto. Sin esta holgura el pie de ese formato queda sin una sola
   * etiqueta reconocida.
   */
  const holguraVertical = Math.max(alturaTipica * 1.6, 0.01);
  const centroDe = (f: Fragmento) => (f.caja.y0 + f.caja.y1) / 2;
  const ordenados = sinRepetidos(fragmentos).sort((a, b) => centroDe(a) - centroDe(b));

  /*
   * Se agrupa en una sola pasada, comparando contra el promedio del grupo
   * abierto. Se puede porque los fragmentos vienen ordenados por altura: una
   * vez que uno queda más abajo de la tolerancia, ninguno de los siguientes va
   * a caer en ese grupo. Buscar entre todos los grupos abiertos por cada
   * fragmento cuesta cuadrático y esto corre sobre mil quinientos fragmentos.
   */
  const grupos: Fragmento[][] = [];
  let sumaDelGrupo = 0;
  for (const fragmento of ordenados) {
    const centro = centroDe(fragmento);
    const abierto = grupos[grupos.length - 1];
    if (abierto && Math.abs(sumaDelGrupo / abierto.length - centro) <= tolerancia) {
      abierto.push(fragmento);
      sumaDelGrupo += centro;
    } else {
      grupos.push([fragmento]);
      sumaDelGrupo = centro;
    }
  }

  return grupos.map((grupo) => {
    const enOrden = [...grupo].sort((a, b) => a.caja.x0 - b.caja.x0);
    const numericos = enOrden.filter((f) => /\d/.test(f.texto));
    return {
      texto: enOrden.map((f) => f.texto).join(' '),
      y: enOrden.reduce((s, f) => s + centroDe(f), 0) / enOrden.length,
      numericos,
      /*
       * La etiqueta de un número es el texto que tiene **inmediatamente a su
       * izquierda**, dentro de la ventana. Se toma por número y no por línea
       * porque un pie de una sola línea trae varios conceptos seguidos —«Saldo
       * Ac. 532.848,64  Subtotal 473.232,44»— y el valor de cada uno es el que
       * está junto a *su* etiqueta.
       */
      etiquetaDe: (numero: Fragmento) => etiquetaEntre(enOrden, numero, Infinity),
      etiquetaCercaDe: (numero: Fragmento) =>
        etiquetaEntre(ordenados, numero, holguraVertical),
      esIdentificadorDe: (numero: Fragmento) => {
        const aLaIzquierda = enOrden.filter(
          (f) => !/\d/.test(f.texto) && f.caja.x1 <= numero.caja.x0 + 0.001,
        );
        const pegada = aLaIzquierda[aLaIzquierda.length - 1];
        if (!pegada || numero.caja.x0 - pegada.caja.x1 > PEGADO) return false;
        return esIdentificador(pegada.texto);
      },
    };
  });
}

/**
 * El texto que está a la izquierda de un número, dentro de la ventana.
 *
 * Se toma por número y no por línea porque un pie de una sola línea trae varios
 * conceptos seguidos —«Saldo Ac. 532.848,64  Subtotal 473.232,44»— y el valor
 * de cada uno es el que está junto a *su* etiqueta.
 */
function etiquetaEntre(
  fragmentos: Fragmento[],
  numero: Fragmento,
  holguraVertical: number,
): string {
  const centro = (f: Fragmento) => (f.caja.y0 + f.caja.y1) / 2;
  const suCentro = centro(numero);
  return fragmentos
    .filter(
      (f) =>
        !/\d/.test(f.texto) &&
        Math.abs(centro(f) - suCentro) <= holguraVertical &&
        f.caja.x1 <= numero.caja.x0 + 0.001 &&
        numero.caja.x0 - f.caja.x1 <= VENTANA_DE_ETIQUETA,
    )
    .sort((a, b) => a.caja.x0 - b.caja.x0)
    .map((f) => f.texto)
    .join(' ')
    .trim();
}

/**
 * Qué concepto sugiere una etiqueta, aunque esté mutilada.
 *
 * Devuelve el mejor parecido por concepto, para que la decisión no dependa de
 * una sola palabra: «I.V.A 2» y «UBTOTA» tienen que poder competir.
 */
export function conceptoSegunEtiqueta(
  etiqueta: string,
): { concepto: ConceptoFiscal; parecido: number; exacta: boolean } | null {
  const palabras = enPalabras(etiqueta);
  if (palabras.length === 0) return null;

  const junto = palabras.join(' ');
  for (const ajena of AJENAS) {
    if (junto.includes(ajena)) return null;
  }

  let mejor: { concepto: ConceptoFiscal; parecido: number; exacta: boolean } | null = null;
  for (const [concepto, canonicas] of ETIQUETAS) {
    for (const canonica of canonicas) {
      const cuanto = cuantoSeParece(palabras, canonica);
      if (cuanto.parecido < PARECIDO_DE_ETIQUETA) continue;
      if (!mejor || cuanto.parecido > mejor.parecido) {
        mejor = { concepto, parecido: cuanto.parecido, exacta: cuanto.exacta };
      }
    }
  }
  return mejor;
}

/**
 * Parte una etiqueta leída en palabras utilizables.
 *
 * Dos limpiezas, y las dos hacen falta. Se saca lo que no es letra, y se
 * **colapsan las repeticiones**: el pie lo leen hasta siete pasadas de OCR y la
 * etiqueta de una línea llega como «IVA IVA IVA21.00%| IVA», que no es más
 * información que «IVA» pero diluye cualquier comparación contra el texto
 * completo.
 */
function enPalabras(etiqueta: string): string[] {
  const crudas = etiqueta
    .toLowerCase()
    .replace(/[^a-záéíóúñ.]+/g, ' ')
    .split(/\s+/)
    /*
     * Los puntos de las abreviaturas se sacan: «I.V.A.» es «iva» y «C.U.I.T.»
     * es «cuit». Dejarlos hace que la sigla más común del pie no se parezca a
     * su propia palabra.
     */
    .map((p) => p.replace(/\./g, ''))
    .filter((p) => p.length >= 2);

  const salida: string[] = [];
  for (const palabra of crudas) {
    if (salida[salida.length - 1] !== palabra) salida.push(palabra);
  }
  return salida;
}

/**
 * Cuánto se parece una etiqueta a un concepto, mirando **ventanas de palabras**.
 *
 * Comparar la etiqueta entera contra la palabra canónica es lo que no funciona,
 * y fue un error medido: la línea de la percepción de una de las facturas llega
 * como «recia Perc lIBB IIBB CABA CA]», donde la palabra que importa está, y
 * contra «perc iibb» el parecido del texto completo da 0,3 porque las otras
 * cinco palabras lo hunden. Lo que hay que preguntar es si **alguna parte** de
 * la etiqueta es la palabra buscada.
 *
 * Así que se recorre la etiqueta en ventanas del mismo largo que la canónica y
 * se toma el mejor parecido. Y se acepta además el **prefijo**: «perc» es
 * «percepción» abreviada en la mitad de los papeles, y «ercepcio» es
 * «percepción» con la primera y la última letra comidas por el OCR.
 */
function cuantoSeParece(
  palabras: string[],
  canonica: string,
): { parecido: number; exacta: boolean } {
  const partes = canonica.split(' ');
  let mejor = 0;
  let exacta = false;

  for (let i = 0; i + partes.length <= palabras.length; i += 1) {
    const ventana = palabras.slice(i, i + partes.length).join(' ');
    if (ventana === canonica) return { parecido: 1, exacta: true };
    const cuanto = parecido(ventana, canonica);
    if (cuanto > mejor) mejor = cuanto;
  }

  /*
   * Y el prefijo, sólo para una canónica de una palabra: una etiqueta abreviada
   * es un prefijo, no un parecido. Cuenta como exacta cuando son al menos
   * cuatro letras, que es lo que distingue «perc» de «pe».
   */
  if (partes.length === 1) {
    for (const palabra of palabras) {
      if (palabra.length >= 4 && canonica.startsWith(palabra)) {
        mejor = Math.max(mejor, 1);
        exacta = true;
      }
    }
  }

  return { parecido: mejor, exacta };
}

/**
 * La alícuota impresa junto a una etiqueta de IVA, si la hay.
 *
 * «IVA 21%», «I.V.A. 10,5», «IVA21,00» son las tres formas del banco. Se busca
 * sólo entre las alícuotas que existen: un 2 suelto de «I.V.A 2» no se
 * convierte en el 2 % porque no hay ningún 2 % en la ley, y queda sin alícuota
 * —que es distinto de inventarle una—.
 */
export function alicuotaDeLaEtiqueta(etiqueta: string): Decimal | null {
  const numeros = etiqueta.match(/\d+(?:[.,]\d+)?/g) ?? [];
  for (const crudo of numeros) {
    const valor = new Decimal(crudo.replace(',', '.')).div(100);
    if (ALICUOTAS.some((a) => a.eq(valor))) return valor;
  }
  return null;
}

// ---------------------------------------------------------------------------
// La reconciliación
// ---------------------------------------------------------------------------

interface Candidata {
  linea: LineaFiscal;
  fragmento: Fragmento;
  /** El texto que está a la izquierda de este número. */
  etiqueta: string;
  lecturas: LecturaNumerica[];
  porEtiqueta: { concepto: ConceptoFiscal; parecido: number; exacta: boolean } | null;
  alicuota: Decimal | null;
}

export interface OpcionesDelPie {
  /** La suma de los importes del detalle, que es lo que el neto tiene que dar. */
  sumaDelDetalle: Decimal | null;
  /** La altura típica de un renglón, para agrupar en líneas. */
  alturaTipica: number;
  /**
   * Cuántos renglones tiene el detalle.
   *
   * Hace falta para la holgura del IVA: un IVA calculado renglón por renglón y
   * redondeado en cada uno no da exactamente el neto por la alícuota, y la
   * diferencia crece con la cantidad de renglones. Con veintitrés artículos, un
   * centavo de holgura deja afuera el IVA verdadero por trece milésimos.
   */
  renglonesDelDetalle?: number;
  /**
   * Desde qué altura de la página puede haber pie, en fracción.
   *
   * Se pasa el comienzo de la **tabla**, no el final: un renglón fiscal puede
   * estar en el tercio central de la hoja y sigue siendo del pie. Pasa en los
   * formatos que imprimen el detalle arriba y el resumen a media página, y
   * también cuando la foto sale con la mitad de abajo en sombra y el OCR ubica
   * las líneas más arriba de lo que están. Lo único que se excluye es el
   * encabezado, donde vive el CUIT, el número de comprobante y la fecha, que
   * son números grandes sin ninguna relación fiscal.
   */
  desdeY?: number;
  /**
   * Dónde termina el último artículo del detalle, en fracción de página.
   *
   * Sirve para proponer la región «debajo del último artículo», que es donde
   * casi todos los papeles imprimen el recuadro de totales. Es opcional porque
   * hay comprobantes donde el detalle no se pudo ubicar, y ahí la región se
   * propone igual desde el encabezado.
   */
  finDelDetalle?: number;
}

/**
 * Reconcilia el pie fiscal contra el detalle y contra sí mismo.
 *
 * El orden en que se resuelve sigue la fuerza de la evidencia: primero el neto,
 * que es el único concepto con una relación **externa** —tiene que dar la suma
 * del detalle— y por eso el más comprobable; después los IVAs, que se verifican
 * contra el neto y su alícuota; después las percepciones, que no tienen relación
 * propia y dependen de la etiqueta y de la posición; y al final el total, que
 * cierra el sistema.
 */
/**
 * Reconcilia el pie fiscal contra el detalle y contra sí mismo.
 *
 * El orden en que se resuelve sigue la fuerza de la evidencia: primero el neto,
 * que es el único concepto con una relación **externa** —tiene que dar la suma
 * del detalle— y por eso el más comprobable; después los IVAs, que se verifican
 * contra el neto y su alícuota; después las percepciones, que no tienen relación
 * propia y dependen de la etiqueta y de la posición; y al final el total, que
 * cierra el sistema.
 *
 * Eso se hace **una vez por región candidata** y las regiones compiten enteras.
 * Ninguna corrige a la otra: la lectura por líneas de siempre es una región
 * más, y si es la que mejor explica el papel, gana.
 */
export function reconciliarPie(fragmentos: Fragmento[], opciones: OpcionesDelPie): PieFiscal {
  const desde = opciones.desdeY ?? 0;
  const delPie = fragmentos.filter((f) => (f.caja.y0 + f.caja.y1) / 2 >= desde);

  const regiones = regionesDelPie(delPie, {
    alturaTipica: opciones.alturaTipica,
    desdeY: desde,
    finDelDetalle: opciones.finDelDetalle,
  });

  /*
   * Lo que la geometría descarta vale para **todas** las lecturas.
   *
   * Que un número esté fuera de la columna de los importes, o que sea otra
   * lectura del mismo lugar del papel, son hechos del comprobante y no
   * opiniones de un lector. Se calculan una vez sobre la región más amplia y
   * después ninguna lectura —ni la de líneas, ni las de la grilla— puede
   * proponerlos como importes.
   */
  const descartados = new Set<Fragmento>(lecturasPisadas(delPie, opciones.alturaTipica));
  for (const region of regiones) {
    for (const fragmento of noPuedenSerImportes(region)) descartados.add(fragmento);
  }

  /*
   * Y la escala de los importes también vale para todas las lecturas.
   *
   * Cómo escribe los números este pie —con coma y dos decimales, con punto, sin
   * separadores— es un hecho del papel, y sale de los importes que están
   * alineados en la banda. Es lo que descarta el CAE sin mirar su magnitud:
   * catorce cifras seguidas no es un importe en un recuadro donde todos los
   * importes llevan su separador.
   */
  const escalaDeImportes = formatoDeColumna(regiones.flatMap((r) => textosDeLaBanda(r)));

  const juegos: { origen: string; candidatas: Candidata[] }[] = [
    {
      origen: 'líneas',
      candidatas: candidatasPorLineas(delPie, opciones, descartados, escalaDeImportes),
    },
  ];

  for (const region of regiones) {
    juegos.push({
      origen: region.origen,
      candidatas: candidatasPorCasillas(region, opciones, descartados, escalaDeImportes),
    });
  }

  let mejor: PieFiscal | null = null;
  let origenElegido = 'ninguna';
  for (const juego of juegos) {
    if (juego.candidatas.length === 0) continue;
    const pie = reconciliarConCandidatas(juego.candidatas, opciones);
    if (mejor === null || compararPies(pie, mejor, opciones.sumaDelDetalle) < 0) {
      mejor = pie;
      origenElegido = juego.origen;
    }
  }

  if (mejor === null) return reconciliarConCandidatas([], opciones);
  return { ...mejor, region: origenElegido };
}

/**
 * Cuál de dos lecturas del pie explica mejor el papel. Negativo si gana `a`.
 *
 * Un orden, no una suma, por la misma razón que en el resto del motor: un pie
 * que cierra con conceptos inventados no vale más que uno incompleto y honesto.
 *
 *  1. **cuántas asignaciones cumplen una igualdad fiscal.** Es la evidencia que
 *     no depende de haber leído bien ninguna etiqueta;
 *  2. **cuántas salieron de su propia etiqueta impresa.** Un concepto que el
 *     papel nombra vale más que uno deducido;
 *  3. **cuánto queda sin explicar.** El residuo es la medida exacta de lo que
 *     no se leyó;
 *  4. y recién al final, **cuántos conceptos se pudieron asignar**. Va último a
 *     propósito: una región que asigna ocho conceptos sin que ninguno cumpla
 *     una igualdad no leyó mejor, adivinó más.
 */
function compararPies(a: PieFiscal, b: PieFiscal, detalle: Decimal | null): number {
  /*
   * Nivel 1: que el neto dé la suma del detalle.
   *
   * Es la única comprobación del pie que no depende del pie. Todo lo demás
   * —que el IVA sea el neto por la alícuota, que el total sea la suma de los
   * conceptos— se verifica contra números del mismo recuadro, así que un
   * recuadro leído entero al revés puede cumplirlas todas. Que el neto coincida
   * con lo que suman los artículos viene de otra parte de la hoja.
   */
  const cierraConElDetalle = (pie: PieFiscal) =>
    detalle !== null && pie.netoGravado !== null && dentroDeLaPrecision(pie.netoGravado, detalle);

  const conIgualdad = (pie: PieFiscal) =>
    pie.asignaciones.filter((x) => x.igualdad !== null).length;
  const leidas = (pie: PieFiscal) =>
    pie.asignaciones.filter((x) => x.procedencia === 'READ_FROM_DOCUMENT').length;

  /*
   * Y el residuo se mide **en proporción**, no en pesos. Un pie que deja
   * ochenta y seis mil millones sin explicar sobre un detalle de un millón y
   * medio no está un poco peor que otro: está leyendo cualquier cosa.
   */
  const sinExplicar = (pie: PieFiscal) => {
    /*
     * Cuidado con el residuo en `null`, que quiere decir **dos cosas**: que el
     * pie cierra, y que no hay total con qué compararlo. Tratarlas igual fue un
     * error medido: un pie que cerraba perfecto quedaba en el peor casillero y
     * perdía contra otro que dejaba el veintiuno por ciento del comprobante sin
     * explicar.
     */
    if (pie.total === null) return 1;
    if (pie.residuo === null) return 0;
    const escala = detalle && detalle.gt(0) ? detalle : pie.netoGravado;
    if (!escala || escala.lte(0)) return 1;
    return Math.min(1, pie.residuo.abs().div(escala).toNumber());
  };

  /*
   * El residuo va **antes** que las igualdades, y eso fue un error medido. Una
   * región que leyó cualquier cosa puede cumplir una igualdad por casualidad
   * —un «22» que por el 5 % da «1»— y con las igualdades primero le ganaba a la
   * lectura que traía el total del comprobante bien leído y cuadrando al cuatro
   * por ciento. Una igualdad entre dos números inventados no es evidencia de
   * nada; lo que no se puede fingir es cuánto del papel queda sin explicar.
   */
  /*
   * Y antes que nada, que el pie sea **posible**.
   *
   * El total de un comprobante nunca es menor que lo que suman sus artículos:
   * los impuestos y las percepciones se suman, no se restan. Es una relación
   * fiscal, no un umbral ni un rango comercial, y descarta de un saque las
   * lecturas degeneradas: una región que encontró un «4» suelto y lo llamó
   * total cierra perfecto consigo misma —un concepto, un total, cero residuo—
   * y con cualquier medida de consistencia interna le gana a la región que
   * traía los treinta y siete mil quinientos que dice el papel.
   */
  const posible = (pie: PieFiscal) => {
    if (pie.total === null || detalle === null || detalle.lte(0)) return true;
    return pie.total.gte(detalle) || dentroDeLaPrecision(pie.total, detalle);
  };

  return (
    Number(posible(b)) - Number(posible(a)) ||
    Number(cierraConElDetalle(b)) - Number(cierraConElDetalle(a)) ||
    sinExplicar(a) - sinExplicar(b) ||
    conIgualdad(b) - conIgualdad(a) ||
    leidas(b) - leidas(a) ||
    b.asignaciones.length - a.asignaciones.length
  );
}

/**
 * ¿Queda vetada esta etiqueta, mirando lo que tiene más cerca del número?
 *
 * Un veto descarta lo que hay **hasta** él. Si después del veto la etiqueta
 * todavía nombra un concepto, ese concepto es el que está pegado al número y es
 * el que vale: «C.U.I.T. 30-71596337-6  I.V.A. 21 %» tiene el CUIT adelante y
 * el IVA al lado del importe.
 */
function vetada(etiqueta: string): boolean {
  const fin = dondeTerminaElVeto(etiqueta);
  if (fin === null) return false;
  return conceptoSegunEtiqueta(desdeLaPalabra(etiqueta, fin)) === null;
}

/**
 * Las candidatas de siempre: un número por línea, con el texto de su izquierda.
 *
 * Se conserva entera y compitiendo. Hay pies de una sola columna donde es la
 * lectura correcta, y reemplazarla por la grilla sin dejarla competir sería
 * cambiar un error por otro.
 */
function candidatasPorLineas(
  fragmentos: Fragmento[],
  opciones: OpcionesDelPie,
  descartados: ReadonlySet<Fragmento>,
  escala: FormatoDeColumna | null,
): Candidata[] {
  const lineas = lineasDelPie(fragmentos, opciones.alturaTipica);

  const candidatas: Candidata[] = [];
  for (const linea of lineas) {
    for (const fragmento of linea.numericos) {
      if (descartados.has(fragmento)) continue;
      /*
       * Un número con el signo de porcentaje pegado es una **alícuota**, no un
       * importe. «Perc IIBB CABA 1,50 % 7.098,49» tiene los dos números en la
       * misma línea y con la misma etiqueta, y sin esta distinción el 1,50
       * entraba como una segunda percepción de un peso cincuenta.
       */
      if (fragmento.texto.includes('%')) continue;
      /*
       * La escala de la banda de importes se usa para **leer** el número, no
       * para descartarlo.
       *
       * Descartar con ella acá costó una medición: la banda de un comprobante
       * quedó armada con importes de dos decimales y su IVA, impreso con otra
       * precisión, salió marcado como ajeno a la escala y desapareció del pie
       * teniéndolo en el papel. La banda dice cómo se escriben los importes de
       * ese recuadro, que es una guía para interpretar un número mutilado, y no
       * una prueba de que un número no sea plata. Lo que sí prueba eso es la
       * forma de un identificador —catorce dígitos corridos— y de eso se ocupa
       * `pareceImporte`.
       */
      const lecturas = lecturasDeCelda(fragmento.texto, escala);
      if (lecturas.length === 0) continue;

      let etiqueta = linea.etiquetaDe(fragmento);
      let porEtiqueta = conceptoSegunEtiqueta(etiqueta);
      if (!porEtiqueta) {
        const cerca = linea.etiquetaCercaDe(fragmento);
        const deCerca = conceptoSegunEtiqueta(cerca);
        if (deCerca) {
          etiqueta = cerca;
          porEtiqueta = deCerca;
        }
      }
      // Lo que viene pegado detrás de «RG» o de «Res.» es el número de una norma.
      if (linea.esIdentificadorDe(fragmento)) continue;

      /*
       * Y lo que la etiqueta **desmiente** tampoco entra, venga de la lectura
       * por líneas o de la grilla. Que una frase diga otra cosa es una
       * propiedad del papel, no del lector que la encontró: «PESO NETO» no es
       * el neto gravado en ninguna de las dos lecturas.
       */
      if (vetada(etiqueta)) continue;

      candidatas.push({
        linea,
        fragmento,
        etiqueta,
        lecturas,
        porEtiqueta,
        alicuota: alicuotaDeLaEtiqueta(etiqueta),
      });
    }
  }
  return candidatas;
}

/**
 * Las candidatas de una región, armadas con la grilla.
 *
 * Cada fragmento numérico entra **una sola vez**, con la mejor de sus
 * asociaciones: la que más familias independientes sostienen y, a igualdad,
 * la que tiene su etiqueta más cerca. Las demás quedan disponibles como
 * alternativas pero no producen una segunda candidata, porque una misma caja
 * física no puede ocupar dos conceptos fiscales.
 */
function candidatasPorCasillas(
  region: RegionDelPie,
  opciones: OpcionesDelPie,
  descartados: ReadonlySet<Fragmento>,
  escalaDeImportes: FormatoDeColumna | null,
): Candidata[] {
  const lineas = lineasDelPie(
    region.casillas.map((c) => c.fragmento),
    opciones.alturaTipica,
  );
  const lineaDe = (fragmento: Fragmento): LineaFiscal =>
    lineas.find((l) => l.numericos.includes(fragmento)) ?? lineas[0];

  /*
   * La columna de importes tiene una escala, igual que cualquier columna de la
   * tabla, y se decide igual: con lo que está impreso en ella.
   *
   * Es lo que descarta el CAE. Un número de catorce cifras seguidas, en una
   * columna donde todos los importes llevan su coma y sus dos decimales, no es
   * un importe mal escrito: es otra cosa. La misma cuenta que impide leer un
   * precio cien veces más grande impide leer un identificador como plata.
   */
  const candidatas: Candidata[] = [];
  const usados = new Set<Fragmento>();

  /*
   * Qué números de la región **no** son importes por estar en otra columna.
   *
   * «Perc IIBB CABA   1,50   22.853,07» tiene dos números en la misma fila y
   * con la misma etiqueta. El de la izquierda es el porcentaje y el de la
   * derecha es la plata, y sin el signo de porcentaje impreso —que el OCR se
   * come la mitad de las veces— el 1,50 entraba como una percepción de un peso
   * cincuenta. No los distingue su magnitud: los distingue **en qué columna
   * están**. Lo que está fuera de la columna de importes, en una fila que sí
   * tiene un importe, es una alícuota, una cantidad o un código.
   */
  const enOtraColumna = descartados;

  for (const asociacion of region.asociaciones) {
    const fragmento = asociacion.numero;
    if (usados.has(fragmento)) continue;
    if (enOtraColumna.has(fragmento)) continue;

    // Una alícuota no es un importe, venga de donde venga.
    if (fragmento.texto.includes('%')) continue;

    const lecturas = lecturasDeCelda(fragmento.texto, escalaDeImportes);
    if (lecturas.length === 0) continue;
    if (lecturas[0].ajenaALaEscala) continue;

    /*
     * Y lo que la etiqueta desmiente no entra. «PESO NETO» no es el neto
     * gravado y «DESCUENTO TOTAL» no es el total: son frases que **contienen**
     * la palabra buscada y dicen otra cosa. Acá se descarta la asociación, no el
     * número: el mismo fragmento puede entrar por otra de sus asociaciones si
     * alguna lo nombra de verdad.
     */
    if (vetada(asociacion.etiqueta)) continue;

    const linea = lineaDe(fragmento);
    if (linea && linea.esIdentificadorDe(fragmento)) continue;

    usados.add(fragmento);
    candidatas.push({
      linea,
      fragmento,
      etiqueta: asociacion.etiqueta,
      lecturas,
      porEtiqueta: conceptoSegunEtiqueta(asociacion.etiqueta),
      alicuota: alicuotaDeLaEtiqueta(asociacion.etiqueta),
    });
  }

  /*
   * Los números que ninguna asociación nombró entran igual, sin etiqueta: son
   * los que después identifica una igualdad fiscal. Perderlos sería perder
   * justamente los que el papel imprimió sin rótulo legible.
   */
  for (const casilla of region.casillas) {
    if (!casilla.esNumero || usados.has(casilla.fragmento)) continue;
    if (enOtraColumna.has(casilla.fragmento)) continue;
    if (casilla.fragmento.texto.includes('%')) continue;
    const lecturas = lecturasDeCelda(casilla.fragmento.texto, escalaDeImportes);
    if (lecturas.length === 0) continue;
    if (lecturas[0].ajenaALaEscala) continue;
    const linea = lineaDe(casilla.fragmento);
    if (linea && linea.esIdentificadorDe(casilla.fragmento)) continue;
    usados.add(casilla.fragmento);
    candidatas.push({
      linea,
      fragmento: casilla.fragmento,
      etiqueta: '',
      lecturas,
      porEtiqueta: null,
      alicuota: null,
    });
  }

  return candidatas;
}

/**
 * Reconcilia el pie **de una región**, con las candidatas que esa región ofrece.
 *
 * Es el cuerpo de siempre. Lo que cambió es quién arma las candidatas: antes
 * había una sola manera de asociar cada número con su etiqueta —el texto de su
 * izquierda dentro de una ventana— y ahora hay varias, porque un pie es un
 * recuadro con casillas y no una lista de líneas.
 */
function reconciliarConCandidatas(
  candidatas: Candidata[],
  opciones: OpcionesDelPie,
): PieFiscal {
  const pie: PieFiscal = {
    netoGravado: null,
    noGravado: null,
    iva: [],
    percepciones: [],
    total: null,
    totalCalculado: false,
    asignaciones: [],
    enRevision: [],
    estado: 'ausente',
    faltantes: [],
    residuo: null,
  };

  const usadas = new Set<Fragmento>();

  // --- 1. El neto, contra la suma del detalle ------------------------------
  const neto = elegirNeto(
    candidatas,
    opciones.sumaDelDetalle,
    opciones.renglonesDelDetalle ?? 1,
    pie,
  );
  if (neto) {
    pie.netoGravado = neto.valor;
    pie.asignaciones.push(neto);
    usadas.add(neto.origen as unknown as Fragmento);
  }

  /*
   * Un renglón fiscal leído por siete pasadas es **un** renglón fiscal.
   *
   * Cada pasada de OCR deja su propio fragmento, y para la evidencia eso es lo
   * correcto: tres lecturas iguales del mismo número valen más que una. Para el
   * pie, no: cuatro fragmentos de «99.378,81» junto a la palabra IVA no son
   * cuatro IVAs de cien mil pesos cada uno. Se colapsan por valor, que es lo
   * único que los distingue de dos percepciones distintas que casualmente
   * valgan lo mismo —y si valen lo mismo y están en líneas distintas, siguen
   * siendo dos, porque el valor y la línea son la clave.
   */
  const yaVisto = new Set<string>();
  const primeraVez = (concepto: string, valor: Decimal, y: number) => {
    const clave = `${concepto}|${valor.toString()}|${y.toFixed(2)}`;
    if (yaVisto.has(clave)) return false;
    yaVisto.add(clave);
    return true;
  };

  // --- 2. Los IVAs, contra el neto y su alícuota ---------------------------
  const ivas: { asignacion: AsignacionFiscal; candidata: Candidata }[] = [];
  for (const candidata of candidatas) {
    /*
     * Acá **no** se pide que la etiqueta diga IVA, y es el punto de todo el
     * módulo: un número que cumple «neto gravado × 21 %» es el IVA aunque su
     * etiqueta haya salido ilegible. Lo que sí se pide es que su etiqueta no
     * diga **otra cosa**: un subtotal o una percepción que casualmente cumplan
     * la relación no son el IVA, y la etiqueta compatible sigue siendo el
     * segundo nivel de preferencia.
     */
    const etiquetaAjena =
      candidata.porEtiqueta !== null && candidata.porEtiqueta.concepto !== 'iva';
    if (etiquetaAjena) continue;
    if (!pie.netoGravado && candidata.porEtiqueta?.concepto !== 'iva') continue;
    if (usadas.has(candidata.fragmento)) continue;
    const asignacion = asignarIva(candidata, pie.netoGravado, opciones.renglonesDelDetalle ?? 1);
    if (!asignacion) continue;
    usadas.add(candidata.fragmento);
    if (!primeraVez('iva', asignacion.valor, candidata.linea.y)) continue;
    ivas.push({ asignacion, candidata });
  }

  /*
   * De cada alícuota hay **un** IVA, y eso desempata las lecturas casi iguales.
   *
   * Dos pasadas de OCR leen la misma línea «46.491,65» y «46.491,66», las dos
   * cumplen neto × 21 % dentro de la precisión impresa, y sumarlas duplica el
   * IVA del comprobante: el total deja de cerrar por noventa y tres mil pesos.
   * No son dos alícuotas: es una línea leída dos veces. Se queda la lectura más
   * cerca de la igualdad exacta, que es la que el papel tiene impresa.
   */
  const porAlicuota = new Map<string, { asignacion: AsignacionFiscal; candidata: Candidata }>();
  for (const cada of ivas) {
    const clave = cada.asignacion.alicuota?.toString() ?? `sin-alicuota:${cada.candidata.linea.y.toFixed(2)}`;
    const ya = porAlicuota.get(clave);
    if (!ya) {
      porAlicuota.set(clave, cada);
      continue;
    }
    const exacto = cada.asignacion.alicuota
      ? (pie.netoGravado ?? new Decimal(0)).times(cada.asignacion.alicuota)
      : null;
    if (!exacto) continue;
    if (
      cada.asignacion.valor.minus(exacto).abs().lt(ya.asignacion.valor.minus(exacto).abs())
    ) {
      porAlicuota.set(clave, cada);
    }
  }
  for (const { asignacion } of porAlicuota.values()) {
    pie.iva.push({ alicuota: asignacion.alicuota, valor: asignacion.valor });
    pie.asignaciones.push(asignacion);
  }

  /*
   * Cómo escribe **este papel** los importes del pie.
   *
   * Se toma del neto, que es el concepto mejor comprobado de todos, y sirve
   * para lo mismo que la hipótesis de formato de una columna del detalle: un
   * número escrito de otra manera que sus vecinos es un número mal leído.
   *
   * Hace falta justo donde la evidencia es más débil. Una percepción no tiene
   * igualdad propia que la verifique, así que si además se acepta con cualquier
   * formato, cualquier cifra suelta que caiga cerca de la palabra «percepción»
   * entra al pie: sobre una de las fotos malas del banco entraban ocho, de un
   * peso, de dos y de setenta y siete, y sobre una buena entraba un «1» que era
   * parte de otra cosa. Un pie que imprime «3.830.467,37» no imprime «1».
   */
  const decimalesDelPie = neto ? decimalesEscritos(neto.origen.texto) : -1;
  const comoElPie = (candidata: Candidata) =>
    decimalesDelPie < 0 || decimalesEscritos(candidata.fragmento.texto) === decimalesDelPie;

  // --- 3. Las percepciones: cero, una o varias -----------------------------
  for (const candidata of candidatas) {
    if (candidata.porEtiqueta?.concepto !== 'percepcion') continue;
    if (usadas.has(candidata.fragmento)) continue;
    if (!comoElPie(candidata)) continue;
    const asignacion = asignarSimple(candidata, 'percepcion');
    if (!asignacion) continue;
    usadas.add(candidata.fragmento);
    if (!primeraVez('percepcion', asignacion.valor, candidata.linea.y)) continue;
    pie.percepciones.push({ etiqueta: candidata.etiqueta, valor: asignacion.valor });
    pie.asignaciones.push(asignacion);
  }

  // --- 4. Lo no gravado ----------------------------------------------------
  for (const candidata of candidatas) {
    if (candidata.porEtiqueta?.concepto !== 'noGravado') continue;
    if (usadas.has(candidata.fragmento)) continue;
    if (!comoElPie(candidata)) continue;
    const asignacion = asignarSimple(candidata, 'noGravado');
    if (!asignacion) continue;
    usadas.add(candidata.fragmento);
    if (!primeraVez('noGravado', asignacion.valor, candidata.linea.y)) continue;
    pie.noGravado = (pie.noGravado ?? new Decimal(0)).plus(asignacion.valor);
    pie.asignaciones.push(asignacion);
  }

  // --- 5. El total, que cierra el sistema ----------------------------------
  const esperado = totalEsperado(pie);
  const total = elegirTotal(candidatas, usadas, esperado, pie);
  if (total) {
    pie.total = total.valor;
    pie.asignaciones.push(total);
  } else if (esperado) {
    /*
     * El total no está en la evidencia. Se informa **calculado**, y queda
     * dicho: un total que no se leyó del papel no puede presentarse como leído,
     * porque es el número contra el que se paga.
     */
    pie.total = esperado;
    pie.totalCalculado = true;
    pie.enRevision.push(
      `El total no aparece en la evidencia. La suma de los conceptos da ` +
        `${esperado.toFixed(2)}, pero es un valor calculado y no leído del comprobante.`,
    );
  }

  calificar(pie, opciones.renglonesDelDetalle ?? 1);
  return pie;
}

/**
 * Decide si el pie está completo, y **qué falta** cuando no lo está.
 *
 * La regla es la que importa de todo el módulo: `completo` quiere decir que
 * todo lo que hace falta está **leído del papel** y que el sistema cierra. No
 * alcanza con tener un número por casillero.
 *
 * Los tres motivos por los que un pie queda parcial:
 *
 *  - el total se **calculó**. Ayuda a revisar y no completa nada: el papel no
 *    lo dice;
 *  - el total está leído y la suma de los conceptos **no llega**. Esa
 *    diferencia es un concepto que no se leyó, y acá se informa de cuánto es y
 *    nada más. Ponerle nombre e importe sería cerrar el pie inventando el dato
 *    que falta, que es exactamente lo que este motor no hace;
 *  - falta el neto, el total o el IVA de un comprobante que discrimina.
 */
function calificar(pie: PieFiscal, renglones: number): void {
  if (!pie.netoGravado) {
    pie.faltantes.push('No se identificó el neto gravado.');
  }

  const leido = pie.asignaciones.find((a) => a.concepto === 'total');
  if (!leido) {
    pie.faltantes.push(
      pie.totalCalculado
        ? `El total no está impreso en la evidencia: el que se muestra sale de sumar los ` +
          `conceptos (${DERIVED_SUGGESTION}).`
        : 'No se identificó el total del comprobante.',
    );
  }

  /*
   * El residuo: la diferencia entre el total leído y la suma de lo asignado.
   *
   * Se calcula sólo contra un total **leído**; contra un total calculado da
   * cero por construcción y no diría nada.
   */
  if (leido && pie.netoGravado) {
    const suma = sumaDeLosConceptos(pie);
    const residuo = leido.valor.minus(suma);
    if (!dentroDeLaPrecision(leido.valor, suma, renglones)) {
      pie.residuo = residuo;
      pie.faltantes.push(
        `La suma de los conceptos da ${suma.toFixed(2)} y el total impreso dice ` +
          `${leido.valor.toFixed(2)}: hay ${residuo.abs().toFixed(2)} sin explicar. ` +
          'Permite sospechar que falta un concepto del pie —una percepción, un no gravado— ' +
          'y no alcanza para crearlo: no se le puede asignar concepto ni importe sin leerlo.',
      );
    }
  }

  if (pie.asignaciones.length === 0) {
    pie.estado = 'ausente';
    return;
  }
  pie.estado = pie.faltantes.length === 0 ? 'completo' : 'parcial';
}

function sumaDeLosConceptos(pie: PieFiscal): Decimal {
  let suma = (pie.netoGravado ?? new Decimal(0)).plus(pie.noGravado ?? 0);
  for (const iva of pie.iva) suma = suma.plus(iva.valor);
  for (const percepcion of pie.percepciones) suma = suma.plus(percepcion.valor);
  return suma.toDecimalPlaces(2);
}

/** Cuánto tendría que dar el total, con lo que se asignó. */
function totalEsperado(pie: PieFiscal): Decimal | null {
  if (!pie.netoGravado) return null;
  return sumaDeLosConceptos(pie);
}

function origenDe(fragmento: Fragmento): OrigenFiscal {
  return {
    texto: fragmento.texto,
    caja: fragmento.caja,
    pasada: fragmento.pasada,
    confianza: fragmento.confianza,
  };
}

function alternativasDe(lecturas: LecturaNumerica[], elegida: Decimal) {
  return lecturas
    .filter((l) => !l.valor.eq(elegida))
    .map((l) => ({ valor: l.valor, reparaciones: l.reparaciones, comoSeLeyo: l.comoSeLeyo }));
}

/**
 * Elige el neto gravado.
 *
 * Es el único concepto con una relación externa: tiene que dar la suma del
 * detalle, dentro de la precisión con la que están impresos los dos. Eso lo
 * hace el más comprobable de todos y por eso se resuelve primero: con el neto
 * puesto, los IVAs se verifican contra él.
 *
 * Cuando no hay suma del detalle —o ninguna lectura la alcanza— se cae en la
 * etiqueta y la posición, que es más débil y se informa como tal.
 */
function elegirNeto(
  candidatas: Candidata[],
  sumaDelDetalle: Decimal | null,
  renglones: number,
  pie: PieFiscal,
): AsignacionFiscal | null {
  const posibles: {
    candidata: Candidata;
    lectura: LecturaNumerica;
    cierra: boolean;
    conIva: boolean;
  }[] = [];

  for (const candidata of candidatas) {
    const etiquetaCompatible =
      candidata.porEtiqueta?.concepto === 'netoGravado' || candidata.porEtiqueta === null;
    for (const lectura of candidata.lecturas) {
      const cierra = sumaDelDetalle !== null && dentroDeLaPrecision(lectura.valor, sumaDelDetalle);
      if (!cierra && !etiquetaCompatible) continue;
      if (!cierra && candidata.porEtiqueta === null) continue;
      posibles.push({
        candidata,
        lectura,
        cierra,
        conIva: tieneIvaEnLaPagina(lectura.valor, candidatas, renglones),
      });
    }
  }
  if (posibles.length === 0) return null;

  /*
   * El orden de preferencias, aplicado: literal, etiqueta compatible, relación
   * exacta, menos reparaciones. Y el margen sale de comparar la primera con la
   * segunda: si las dos cierran y son valores distintos, no hay una respuesta.
   */
  posibles.sort(
    (a, b) =>
      Number(b.lectura.literal) - Number(a.lectura.literal) ||
      Number(b.candidata.porEtiqueta?.concepto === 'netoGravado') -
        Number(a.candidata.porEtiqueta?.concepto === 'netoGravado') ||
      Number(b.candidata.porEtiqueta?.exacta === true) -
        Number(a.candidata.porEtiqueta?.exacta === true) ||
      Number(b.cierra) - Number(a.cierra) ||
      /*
       * Y cuando ninguna cierra contra el detalle —porque el detalle todavía
       * tiene celdas ilegibles—, decide **otra relación del grafo**: que en la
       * página exista un número que sea el IVA de esta candidata. Es lo que
       * distingue el neto verdadero de cualquier otro número con una etiqueta
       * parecida: un 74 suelto no tiene su 15,54 al lado, y un neto de tres
       * millones y medio tiene sus ochocientos mil.
       *
       * No es elegir por magnitud: es pedirle a la candidata que participe de
       * una igualdad, que es lo único que el pie sabe comprobar.
       */
      Number(b.conIva) - Number(a.conIva) ||
      a.lectura.reparaciones - b.lectura.reparaciones,
  );

  const gana = posibles[0];
  const otra = posibles.find((p) => !p.lectura.valor.eq(gana.lectura.valor)) ?? null;
  const margen = margenEntre(gana, otra);

  if (otra && margen === 0) {
    pie.enRevision.push(
      `Hay dos lecturas del neto gravado que valen lo mismo como evidencia: ` +
        `${gana.lectura.valor.toFixed(2)} y ${otra.lectura.valor.toFixed(2)}. ` +
        'No hay una respuesta, hay dos.',
    );
  }

  return {
    concepto: 'netoGravado',
    valor: gana.lectura.valor,
    origen: origenDe(gana.candidata.fragmento),
    lecturaLiteral: gana.candidata.lecturas.find((l) => l.literal)?.valor ?? null,
    alternativas: alternativasDe(gana.candidata.lecturas, gana.lectura.valor),
    alicuota: null,
    igualdad: gana.cierra ? 'suma del detalle = neto gravado, dentro de la precisión impresa' : null,
    costoDeReparacion: gana.lectura.reparaciones,
    etiqueta: gana.candidata.porEtiqueta
      ? {
          texto: gana.candidata.etiqueta,
          exacta: gana.candidata.porEtiqueta.exacta,
          parecido: gana.candidata.porEtiqueta.parecido,
        }
      : null,
    segunda: otra
      ? {
          concepto: 'netoGravado',
          valor: otra.lectura.valor,
          porQue: otra.cierra
            ? 'también cierra contra la suma del detalle'
            : 'su etiqueta también es compatible',
        }
      : null,
    margen,
    procedencia:
      gana.candidata.porEtiqueta?.concepto === 'netoGravado'
        ? 'READ_FROM_DOCUMENT'
        : 'INFERRED_FROM_DOCUMENT_RELATIONS',
  };
}

/**
 * ¿Hay en la página un número que sea el IVA de este neto?
 *
 * Es la corroboración que reemplaza al cierre contra el detalle cuando el
 * detalle todavía tiene celdas ilegibles. Se prueban las alícuotas que existen
 * y alcanza con que alguna dé: la igualdad es del papel, no de la lectura.
 */
function tieneIvaEnLaPagina(neto: Decimal, candidatas: Candidata[], renglones: number): boolean {
  if (neto.lte(0)) return false;
  for (const alicuota of ALICUOTAS) {
    const esperado = neto.times(alicuota);
    for (const candidata of candidatas) {
      if (candidata.porEtiqueta && candidata.porEtiqueta.concepto !== 'iva') continue;
      for (const lectura of candidata.lecturas) {
        if (dentroDeLaPrecision(lectura.valor, esperado, renglones)) return true;
      }
    }
  }
  return false;
}

/**
 * Cuánta ventaja tiene la elegida sobre la segunda.
 *
 * Se cuenta en apoyos discretos y no en décimas: cuántas de las cosas que
 * importan tiene una y no tiene la otra. Cero significa que las dos valen lo
 * mismo como evidencia, y eso es lo que manda a revisión.
 */
function margenEntre(
  gana: { lectura: LecturaNumerica; cierra: boolean; conIva?: boolean },
  otra: { lectura: LecturaNumerica; cierra: boolean; conIva?: boolean } | null,
): number {
  if (!otra) return 1;
  let ventaja = 0;
  if (gana.lectura.literal && !otra.lectura.literal) ventaja += 1;
  if (gana.cierra && !otra.cierra) ventaja += 1;
  if (gana.lectura.reparaciones < otra.lectura.reparaciones) ventaja += 1;
  /*
   * Y la corroboración por otra relación del grafo cuenta como apoyo, igual
   * que cuenta para elegir. Si no contara, el neto de una factura cuyo detalle
   * todavía tiene celdas ilegibles iría a revisión contra cualquier número con
   * una etiqueta parecida —un «74» suelto— teniendo su IVA impreso al lado.
   */
  if (gana.conIva && !otra.conIva) ventaja += 1;
  return Math.min(1, ventaja / 3);
}

/**
 * Asigna un IVA, verificándolo contra el neto y su alícuota.
 *
 * Cuando la alícuota está impresa, la igualdad es una sola y se comprueba.
 * Cuando no está —porque la etiqueta salió mutilada— se prueban las alícuotas
 * que existen y se toma la que cierre: eso **no** es inventar la alícuota, es
 * reconocerla por la relación, y queda informado de qué igualdad salió.
 */
function asignarIva(
  candidata: Candidata,
  neto: Decimal | null,
  renglones: number,
): AsignacionFiscal | null {
  let mejor: { lectura: LecturaNumerica; alicuota: Decimal | null; igualdad: string | null } | null =
    null;

  for (const lectura of candidata.lecturas) {
    if (neto && neto.gt(0)) {
      const alicuotas = candidata.alicuota ? [candidata.alicuota] : ALICUOTAS;
      for (const alicuota of alicuotas) {
        if (!dentroDeLaPrecision(lectura.valor, neto.times(alicuota), renglones)) continue;
        const igualdad = `neto gravado × ${alicuota.times(100).toString()} % = IVA`;
        if (!mejor || (lectura.literal && !mejor.lectura.literal)) {
          mejor = { lectura, alicuota, igualdad };
        }
      }
    }
    /*
     * La etiqueta sola alcanza **sólo cuando no hay neto** contra el que
     * comprobar. Con neto, el IVA tiene que cumplir su igualdad, y exigirlo es
     * lo que saca del pie los números que están al lado de la palabra IVA sin
     * ser el IVA: la alícuota impresa. «IVA 21 %  99.378,81» tiene dos números
     * pegados a la misma etiqueta, y sin la igualdad los dos entraban como IVA
     * —21 pesos de IVA y 99.378,81 de IVA— y el total se iba de cauce.
     */
    if (!mejor && !(neto && neto.gt(0)) && candidata.porEtiqueta?.exacta) {
      mejor = { lectura, alicuota: candidata.alicuota, igualdad: null };
    }
  }
  if (!mejor) return null;

  const otras = candidata.lecturas.filter((l) => !l.valor.eq(mejor!.lectura.valor));
  return {
    concepto: 'iva',
    valor: mejor.lectura.valor,
    origen: origenDe(candidata.fragmento),
    lecturaLiteral: candidata.lecturas.find((l) => l.literal)?.valor ?? null,
    alternativas: alternativasDe(candidata.lecturas, mejor.lectura.valor),
    alicuota: mejor.alicuota,
    igualdad: mejor.igualdad,
    costoDeReparacion: mejor.lectura.reparaciones,
    etiqueta: candidata.porEtiqueta
      ? {
          texto: candidata.etiqueta,
          exacta: candidata.porEtiqueta.exacta,
          parecido: candidata.porEtiqueta.parecido,
        }
      : null,
    segunda: otras.length
      ? { concepto: 'iva', valor: otras[0].valor, porQue: otras[0].comoSeLeyo }
      : null,
    margen: mejor.igualdad ? 1 : otras.length ? 0 : 1,
    /*
     * Un IVA sin etiqueta es del papel en su valor y del motor en su concepto:
     * lo que dice que ese número es el IVA es la igualdad, no una palabra
     * impresa. Se informa distinto a propósito.
     */
    procedencia: candidata.porEtiqueta
      ? 'READ_FROM_DOCUMENT'
      : 'INFERRED_FROM_DOCUMENT_RELATIONS',
  };
}

/** Un concepto que no tiene relación propia: lo sostienen la etiqueta y la posición. */
function asignarSimple(candidata: Candidata, concepto: ConceptoFiscal): AsignacionFiscal | null {
  /*
   * Acá la lectura **tiene que ser literal**, y es la única parte del pie donde
   * eso es un requisito y no una preferencia.
   *
   * El motivo es que una percepción no tiene igualdad propia contra la que
   * comprobarse: su base y su alícuota las fija cada jurisdicción y no se
   * derivan del neto. Sin relación que la verifique, lo único que la sostiene
   * es la etiqueta y el papel, así que una lectura que necesita suponer un
   * separador perdido no alcanza: sobre una factura del banco eso metía un
   * «033,» recortado como una percepción de treinta y tres pesos.
   */
  const literal = candidata.lecturas.find((l) => l.literal);
  if (!literal) return null;
  const elegida = literal;

  const otras = candidata.lecturas.filter((l) => !l.valor.eq(elegida.valor));
  return {
    concepto,
    valor: elegida.valor,
    origen: origenDe(candidata.fragmento),
    lecturaLiteral: literal?.valor ?? null,
    alternativas: alternativasDe(candidata.lecturas, elegida.valor),
    alicuota: null,
    /*
     * Una percepción no tiene igualdad propia: no se calcula a partir del neto
     * —su base y su alícuota las fija cada jurisdicción— así que lo único que la
     * sostiene es su etiqueta y su lugar. Se informa como tal, sin fingir una
     * relación que no existe.
     */
    igualdad: null,
    costoDeReparacion: elegida.reparaciones,
    etiqueta: {
      texto: candidata.etiqueta,
      exacta: candidata.porEtiqueta!.exacta,
      parecido: candidata.porEtiqueta!.parecido,
    },
    segunda: otras.length
      ? { concepto, valor: otras[0].valor, porQue: otras[0].comoSeLeyo }
      : null,
    margen: literal && otras.length ? 1 / 3 : otras.length ? 0 : 1,
    // Acá siempre hay etiqueta: es lo único que sostiene estos conceptos.
    procedencia: 'READ_FROM_DOCUMENT',
  };
}

function elegirTotal(
  candidatas: Candidata[],
  usadas: Set<Fragmento>,
  esperado: Decimal | null,
  pie: PieFiscal,
): AsignacionFiscal | null {
  const posibles: { candidata: Candidata; lectura: LecturaNumerica; cierra: boolean }[] = [];

  for (const candidata of candidatas) {
    if (usadas.has(candidata.fragmento)) continue;
    const etiquetaCompatible = candidata.porEtiqueta?.concepto === 'total';
    for (const lectura of candidata.lecturas) {
      const cierra = esperado !== null && dentroDeLaPrecision(lectura.valor, esperado);
      if (!cierra && !etiquetaCompatible) continue;
      /*
       * Y una relación que vale siempre: **el total no puede ser menor que el
       * neto gravado**. El IVA y las percepciones sólo suman, así que un número
       * por debajo del neto no es el total de este comprobante por más que diga
       * «Total» al lado. Es la que descarta los totales de kilos y de bultos
       * que se salvan de la lista de etiquetas ajenas.
       */
      if (pie.netoGravado && lectura.valor.lt(pie.netoGravado)) continue;
      posibles.push({ candidata, lectura, cierra });
    }
  }
  if (posibles.length === 0) return null;

  posibles.sort(
    (a, b) =>
      Number(b.lectura.literal) - Number(a.lectura.literal) ||
      Number(b.candidata.porEtiqueta?.concepto === 'total') -
        Number(a.candidata.porEtiqueta?.concepto === 'total') ||
      Number(b.cierra) - Number(a.cierra) ||
      a.lectura.reparaciones - b.lectura.reparaciones,
  );

  const gana = posibles[0];
  const otra = posibles.find((p) => !p.lectura.valor.eq(gana.lectura.valor)) ?? null;
  const margen = margenEntre(gana, otra);

  if (otra && margen === 0) {
    pie.enRevision.push(
      `Hay dos asignaciones del total con el mismo apoyo: ${gana.lectura.valor.toFixed(2)} y ` +
        `${otra.lectura.valor.toFixed(2)}. Hay que elegir mirando el comprobante.`,
    );
  }

  return {
    concepto: 'total',
    valor: gana.lectura.valor,
    origen: origenDe(gana.candidata.fragmento),
    lecturaLiteral: gana.candidata.lecturas.find((l) => l.literal)?.valor ?? null,
    alternativas: alternativasDe(gana.candidata.lecturas, gana.lectura.valor),
    alicuota: null,
    igualdad: gana.cierra
      ? 'neto gravado + no gravado + IVA + percepciones = total'
      : null,
    costoDeReparacion: gana.lectura.reparaciones,
    etiqueta: gana.candidata.porEtiqueta
      ? {
          texto: gana.candidata.etiqueta,
          exacta: gana.candidata.porEtiqueta.exacta,
          parecido: gana.candidata.porEtiqueta.parecido,
        }
      : null,
    segunda: otra
      ? {
          concepto: 'total',
          valor: otra.lectura.valor,
          porQue: otra.cierra ? 'también cierra el sistema' : 'su etiqueta también dice total',
        }
      : null,
    margen,
    procedencia:
      gana.candidata.porEtiqueta?.concepto === 'total'
        ? 'READ_FROM_DOCUMENT'
        : 'INFERRED_FROM_DOCUMENT_RELATIONS',
  };
}

/**
 * ¿Pueden estos dos números ser el mismo, dados los decimales con que están
 * escritos?
 *
 * La misma idea que ya usa el cierre del detalle: no una tolerancia elegida a
 * ojo, sino la precisión impresa. Un pie a dos decimales y una suma de importes
 * a tres pueden diferir en un centavo por truncamiento, y eso no es un error;
 * dos números a dos decimales que difieren en un centavo sí.
 */
export function dentroDeLaPrecision(
  leido: Decimal,
  esperado: Decimal,
  /**
   * Cuántos redondeos independientes puede arrastrar la diferencia.
   *
   * Uno, por defecto. Para el IVA son los renglones del detalle: el papel lo
   * calcula por renglón y redondea en cada uno, así que la suma se aparta del
   * neto por la alícuota hasta medio centavo por renglón. Con veintitrés
   * artículos eso son once centavos, y exigir uno solo deja afuera el IVA que
   * el comprobante tiene impreso.
   */
  redondeos = 1,
): boolean {
  const decimales = Math.min(decimalesDe(leido), decimalesDe(esperado));
  /*
   * Una unidad de la precisión más gruesa de las dos, y no media.
   *
   * La factura de Ezra imprime los importes del detalle con tres decimales y el
   * pie con dos: la suma da 221.388,847 y el papel dice 221.388,84, que es la
   * misma cosa truncada. Con media unidad de holgura esos siete milésimos no
   * entran y el neto de un comprobante perfectamente leído queda sin reconocer.
   */
  const holgura = new Decimal(10)
    .pow(-decimales)
    .times(Math.max(1, redondeos))
    .times(1.0001);
  return leido.minus(esperado).abs().lte(holgura);
}
