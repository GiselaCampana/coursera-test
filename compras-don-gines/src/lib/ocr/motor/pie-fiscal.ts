import { Decimal } from '@/lib/money';
import type { Caja, Fragmento } from '@/lib/ocr/reconstruccion/evidencia';
import {
  asignarRegion,
  gobernadosPorUnVeto,
  type AsignacionDeRegion,
} from '@/lib/ocr/motor/asignacion-del-pie';
import {
  centavosPartidos,
  desdeLaPalabra,
  dondeTerminaElVeto,
  esAlicuotaEscrita,
  lecturasPisadas,
  noPuedenSerImportes,
  pareceImporte,
  nombraOtraCosa,
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
  /**
   * Una **base imponible**: sobre qué importe se calculó una alícuota de IVA.
   *
   * No es un sinónimo del neto gravado y modelarlo así pierde información. Un
   * comprobante con artículos al 21 % y al 10,5 % imprime **dos** bases, cada
   * una con su alícuota y su IVA, y el neto gravado es su suma. Meterlas las dos
   * en un solo campo obliga a elegir una y tirar la otra.
   *
   * La distinción además resuelve una confusión medida: un papel que imprime
   * «Subtotal» y «Base Imponible IVA 21 %» tiene dos números distintos y los dos
   * son legítimos. El subtotal se parece más a la suma del detalle —por eso
   * ganaba— y la base es la que cumple la relación que importa: base × alícuota
   * da el IVA impreso. Esa igualdad es evidencia independiente del detalle, y
   * vale más que una cercanía.
   */
  | 'baseImponible'
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
  /*
   * «Base imponible» va **antes** que el neto y sólo como frase completa: ni
   * «base» ni «imponible» por separado nombran nada. «Base» sola aparece en
   * media docena de leyendas de una factura —base de cálculo, base de datos del
   * sistema de facturación— y reconocerla sería inventar un concepto fiscal
   * donde hay una palabra suelta.
   */
  ['baseImponible', ['base imponible']],
  ['netoGravado', ['subtotal', 'neto gravado', 'importe neto', 'neto', 'gravado']],
  ['percepcion', ['percepcion', 'percepciones', 'perc', 'retencion']],
  ['iva', ['iva']],
  ['total', ['total', 'son pesos']],
];

/**
 * Qué tan parecida tiene que ser una etiqueta para contar como degradada.
 *
 * Seis décimos, **y además** que las letras de la etiqueta aparezcan en orden
 * dentro de la canónica. El umbral solo no alcanza y se midió: «recepción» se
 * parece a «percepción» en ocho décimos, así que la línea del conforme de
 * recepción de una factura entraba como una percepción de cuatro mil pesos, y
 * subir el umbral lo bastante como para excluirla dejaba afuera «ubtota», que
 * es «subtotal» con la primera letra comida.
 */
const PARECIDO_DE_ETIQUETA = 0.6;

/**
 * Los conceptos que **sólo** se reconocen por su frase exacta.
 *
 * El parecido de una frase de dos palabras es mucho más frágil que el de una:
 * hay más letras que perder, y un umbral que admite «ubtota» por «subtotal»
 * admite también «bas impon» por cualquier cosa que empiece parecido. Una base
 * imponible además decide contra qué importe se calculó un impuesto, así que
 * afirmarla por parecido es afirmarla por nada.
 *
 * Lo que sí puede recuperar una etiqueta comida es la **relación fiscal**: base
 * × alícuota tiene que dar el IVA impreso. Eso lo hace `elegirBasesImponibles`,
 * que pide las dos cosas juntas —geometría coherente e igualdad— y nunca el
 * parecido solo.
 */
const SOLO_FRASE_EXACTA: ReadonlySet<ConceptoFiscal> = new Set<ConceptoFiscal>(['baseImponible']);

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
  /**
   * Las bases imponibles impresas, una por alícuota.
   *
   * Se conservan **separadas** y con su alícuota, aunque el neto agregado salga
   * de su suma. Un comprobante con artículos al 21 % y al 10,5 % tiene dos
   * bases, cada una con su IVA, y colapsarlas en un solo número pierde
   * exactamente la información que las hace útiles: contra qué se calculó cada
   * impuesto.
   */
  basesImponibles: { alicuota: Decimal | null; valor: Decimal }[];
  /**
   * ¿El neto gravado salió de sumar las bases en vez de estar impreso?
   *
   * Cuando hay una sola base, el neto **es** esa base: el mismo número del
   * papel, con su procedencia. Cuando hay varias, el agregado no está impreso
   * en ninguna parte y eso queda dicho, igual que con el total calculado.
   */
  netoDerivadoDeLasBases: boolean;
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
  /** Contra qué otra región compitió, para poder auditar la elección. */
  segundaRegion?: string | null;
  /**
   * Los importes que se leyeron dentro de la región y no se pudieron asignar.
   *
   * **Es un estado propio, distinto de faltar.** Un concepto ausente es un
   * número que no está en la foto; esto es un número que sí está, que se leyó,
   * y del que no se pudo probar qué concepto es. Mezclarlos oculta lo único que
   * el motor averiguó y convierte una pregunta contestable —«¿qué es este
   * número?»— en un campo vacío que nadie sabe de dónde llenar.
   *
   * Conserva todo lo que hace falta para contestarla mirando la foto: el texto
   * tal como salió, su caja, su lectura, sus alternativas y de qué región es.
   */
  sinAsignar: ImporteSinAsignar[];
}

/**
 * Un importe fiscal leído y sin concepto: `UNASSIGNED_FISCAL_AMOUNT`.
 *
 * Produce **una** acción humana —«¿qué es este número?»— y no una por cada
 * campo que quedó vacío. La diferencia importa: cuatro campos sin llenar por un
 * número sin asignar son un problema, no cuatro.
 */
export interface ImporteSinAsignar {
  texto: string;
  caja: Caja;
  pasada: string;
  confianza: number;
  /** La lectura preferida del número, que es lo que el motor sí sabe. */
  valor: Decimal | null;
  /** Las demás lecturas del mismo fragmento. */
  alternativas: string[];
  /** De qué región salió. */
  region: string;
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
        /*
         * La alícuota impresa es **parte del rótulo**, no un número que lo corte.
         * «Base Imponible IVA 21 %» nombra el concepto y dice contra qué se
         * calculó el impuesto, y sacarle el «21 %» deja una base sin alícuota.
         */
        (!/\d/.test(f.texto) || esAlicuotaEscrita(f.texto)) &&
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
  const nombrados = new Set<ConceptoFiscal>();
  for (const [concepto, canonicas] of ETIQUETAS) {
    for (const canonica of canonicas) {
      const cuanto = cuantoSeParece(palabras, canonica);
      if (cuanto.parecido < PARECIDO_DE_ETIQUETA) continue;
      if (!cuanto.exacta && SOLO_FRASE_EXACTA.has(concepto)) continue;
      if (cuanto.exacta) nombrados.add(concepto);
      if (!mejor || cuanto.parecido > mejor.parecido) {
        mejor = { concepto, parecido: cuanto.parecido, exacta: cuanto.exacta };
      }
    }
  }

  /*
   * Una etiqueta que nombra **dos conceptos** no nombra ninguno exactamente.
   *
   * El texto que el OCR junta a la izquierda de un importe es a veces media
   * línea: «Neto — IVA — $» trae las dos palabras y no dice cuál de los dos
   * números de esa fila es cuál. Tratarla como un rótulo exacto le daba al
   * primer candidato la fuerza de una etiqueta impresa entera, y con eso se
   * afirmaba un neto de seis mil donde el papel decía treinta mil.
   *
   * Sigue valiendo como parecido —la etiqueta dice algo— pero deja de ser la
   * evidencia que cierra la discusión, así que el empate vuelve a decidir.
   */
  if (mejor && nombrados.size > 1) mejor = { ...mejor, exacta: false };

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
    /*
     * El parecido cuenta sólo si la ventana es una **lectura degradada** de la
     * canónica: sus letras aparecen en orden dentro de ella, aunque falten. El
     * OCR pierde caracteres y los rompe; no los reordena ni agrega palabras
     * nuevas. «ubtota» y «ercepcio» pasan —son «subtotal» y «percepción» con
     * letras comidas— y «recepción» no, porque para llegar a «percepción» hay
     * que mover la erre de lugar. Son dos palabras distintas del castellano, no
     * una lectura dañada de la otra.
     */
    if (!esUnaVersionComida(ventana, canonica)) continue;
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
 * ¿Son las letras de `leida` las de `canonica`, en orden y sin agregar?
 *
 * Es la forma que tiene una palabra a la que el OCR le comió caracteres. Se
 * admite **una** letra suelta que no encaje, porque el reconocedor también
 * cambia una por otra —una ene por una eme, una ce por una e— y una sola
 * sustitución no convierte una palabra en otra.
 */
function esUnaVersionComida(leida: string, canonica: string): boolean {
  if (leida.length > canonica.length) return false;
  let i = 0;
  let sobran = 0;
  for (const letra of leida) {
    const donde = canonica.indexOf(letra, i);
    if (donde === -1) sobran += 1;
    else i = donde + 1;
  }
  return sobran <= 1;
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
   * Y los centavos que el OCR dejó en una caja aparte vuelven a su número.
   *
   * Dos dígitos pegados a la derecha de un importe sin decimales, de la misma
   * pasada y la misma fila, son la cola de ese importe: «1.523.537» «99» es
   * «1.523.537,99». Se ofrece como **otra lectura** del mismo lugar —no se
   * afirma— y la pieza suelta deja de competir como importe propio, porque un
   * concepto fiscal de noventa y nueve pesos al lado de uno de un millón y
   * medio es el mismo número contado dos veces.
   */
  const { pegados: centavos, piezas } = centavosPartidos(delPie, opciones.alturaTipica);
  for (const pieza of piezas) descartados.add(pieza);

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

  /*
   * Qué números tienen, **en la grilla**, una etiqueta que los explica como otra
   * cosa.
   *
   * Vale para las dos lecturas. La de líneas busca la etiqueta dentro de una
   * ventana y a veces la corta: en un comprobante del banco el «Saldo Ac.» le
   * queda afuera y su importe terminaba preguntado como si nadie supiera qué
   * es, teniéndolo escrito al lado. Lo que el papel explica no se pregunta.
   */
  const vetadosPorLaGrilla = new Set<string>();
  for (const region of regiones) {
    for (const fragmento of gobernadosPorUnVeto(region, nombraOtraCosa, opciones.alturaTipica)) {
      vetadosPorLaGrilla.add(`${fragmento.texto}@${fragmento.caja.x0.toFixed(4)}`);
    }
  }


  const juegos: {
    origen: string;
    candidatas: Candidata[];
    asignacion: AsignacionDeRegion | null;
  }[] = [
    {
      origen: 'líneas',
      candidatas: candidatasPorLineas(delPie, opciones, descartados, escalaDeImportes, centavos),
      asignacion: null,
    },
  ];

  for (const region of regiones) {
    const { candidatas, asignacion } = candidatasPorCasillas(
      region,
      opciones,
      descartados,
      escalaDeImportes,
      centavos,
    );
    juegos.push({ origen: region.origen, candidatas, asignacion });
  }

  let mejor: PieFiscal | null = null;
  let origenElegido = 'ninguna';
  let segundoOrigen: string | null = null;
  let mejorEsGlobal = false;
  for (const juego of juegos) {
    if (juego.candidatas.length === 0) continue;
    const pie = reconciliarConCandidatas(juego.candidatas, opciones);
    /*
     * Los importes que la región leyó y **el pie no asignó** viajan con él.
     *
     * Se calculan contra el resultado y no contra la asignación geométrica, y
     * por dos razones. Una, que después de la geometría todavía puede
     * identificarlos una igualdad fiscal, y un número que la aritmética ubicó
     * tiene concepto. La otra, que así vale para las dos lecturas: la de líneas
     * no arma una grilla y sin esto sus importes huérfanos desaparecían en
     * silencio, que es exactamente lo que no puede pasar.
     *
     * No son un `null` ni una omisión: el número está en la foto, se leyó, y lo
     * único que falta es saber qué concepto es.
     */
    const asignados = new Set(
      pie.asignaciones.map((a) => `${a.origen.texto}@${a.origen.caja.x0.toFixed(4)}`),
    );

    /*
     * Y se pregunta **sólo por los del pie**, no por los de la tabla.
     *
     * La región de líneas empieza donde empieza el detalle, así que abarca los
     * precios y los subtotales de cada artículo. Ésos no son importes fiscales
     * sin asignar: son las celdas de la tabla, que tienen su propio circuito de
     * revisión. Lo que califica es estar debajo del último artículo **y** en la
     * banda donde el recuadro alinea sus montos, que es la definición de «un
     * importe del pie».
     */
    const enElPie = (fragmento: Fragmento) => {
      const centro = (fragmento.caja.y0 + fragmento.caja.y1) / 2;
      if (opciones.finDelDetalle !== undefined && centro < opciones.finDelDetalle) return false;
      return regiones.some((r) => r.esImporte(fragmento));
    };
    /*
     * Y el valor ya asignado tampoco vuelve a preguntarse.
     *
     * El mismo número lo leen varias pasadas y cada una deja su fragmento en un
     * lugar apenas distinto, así que comparar por posición no alcanza: el neto
     * aparecía asignado y, un milímetro más allá, preguntado.
     */
    const valoresAsignados = new Set(pie.asignaciones.map((a) => a.valor.toString()));
    /*
     * El largo máximo sale de los importes **ya asignados**, no de la banda.
     *
     * Sacarlo de la banda es circular: el token de cuarenta y un dígitos está
     * en la banda, así que él mismo subía el techo y se dejaba pasar. Los
     * asignados son los que tienen un concepto probado, y son la única
     * referencia de cuántas cifras imprime este comprobante.
     */
    const digitosDeLaBanda = Math.max(
      ...pie.asignaciones.map((a) => digitos(a.origen.texto)),
      0,
    );

    const vistos = new Set<string>();
    pie.sinAsignar = [];
    for (const candidata of juego.candidatas) {
      const clave = `${candidata.fragmento.texto}@${candidata.fragmento.caja.x0.toFixed(4)}`;
      if (asignados.has(clave) || vistos.has(clave)) continue;
      const valor = candidata.lecturas[0]?.valor ?? null;
      if (valor !== null && valoresAsignados.has(valor.toString())) continue;
      // Sólo lo que tiene forma de plata: un resto de la grilla no es una
      // pregunta que alguien pueda contestar.
      if (!pareceImporte(candidata.fragmento.texto)) continue;
      if (!enElPie(candidata.fragmento)) continue;
      /*
       * Lo que el papel **ya explica** no se pregunta. Un saldo de cuenta
       * corriente no está sin asignar: está asignado a otra cosa, y el papel lo
       * dice. Preguntarlo sería pedirle a una persona que confirme lo que ya
       * leímos.
       */
      if (vetada(candidata.etiqueta) || vetadosPorLaGrilla.has(clave)) continue;
      /*
       * Y tampoco lo que la banda de importes desmiente. Un blob de cuarenta
       * cifras en un recuadro donde los montos llevan su coma y sus dos
       * decimales no es un importe sin concepto: no es un importe.
       */
      if (candidata.lecturas[0]?.ajenaALaEscala) continue;
      /*
       * Ni lo que tiene **más cifras que cualquier importe de la banda**. El
       * largo sale del propio comprobante, no de una constante: si el recuadro
       * alinea montos de hasta nueve dígitos, un token de cuarenta y uno no es
       * uno de ellos leído mal.
       */
      if (digitos(candidata.fragmento.texto) > digitosDeLaBanda) continue;
      vistos.add(clave);
      pie.sinAsignar.push({
        texto: candidata.fragmento.texto,
        caja: candidata.fragmento.caja,
        pasada: candidata.fragmento.pasada,
        confianza: candidata.fragmento.confianza,
        valor,
        alternativas: candidata.lecturas.slice(1).map((l) => l.valor.toString()),
        region: juego.origen,
      });
    }

    /*
     * A igualdad de todo lo demás gana la que **resolvió la correspondencia
     * entera**.
     *
     * No es una preferencia por la novedad. La lectura por líneas empareja cada
     * número con el texto que tiene más cerca, una decisión por vez; la de la
     * grilla elige la asignación completa de menor costo, donde una etiqueta
     * toma un solo importe, un importe toma una sola etiqueta y las
     * asociaciones no se cruzan. La segunda está comprobada contra
     * restricciones que la primera ni siquiera mira, así que cuando las dos
     * explican el papel igual de bien, la comprobada vale más.
     *
     * Se midió: sobre una foto del lote las dos lecturas daban exactamente un
     * concepto con exactamente el mismo apoyo, y el empate lo resolvía el orden
     * en que se habían probado. Una tenía la percepción verdadera y la otra el
     * total del comprobante puesto en su lugar.
     */
    const comparacion = compararPies(pie, mejor ?? pie, opciones.sumaDelDetalle);
    const desempata = comparacion === 0 && juego.asignacion !== null && !mejorEsGlobal;
    if (mejor === null || comparacion < 0 || desempata) {
      mejor = pie;
      origenElegido = juego.origen;
      mejorEsGlobal = juego.asignacion !== null;
      segundoOrigen = mejor === pie ? segundoOrigen : segundoOrigen;
    }
  }

  if (mejor === null) return reconciliarConCandidatas([], opciones);

  /*
   * **Una igualdad perfecta no convierte cualquier número sin etiqueta en el
   * concepto que falta.**
   *
   * La aritmética del pie es potentísima y por eso hay que acotarla: con cuatro
   * conceptos y un total, siempre hay algún número de la hoja que hace cerrar
   * la cuenta, y tomarlo es fabricar un dato. Una asignación inferida sólo se
   * conserva cuando las cinco cosas se cumplen a la vez:
   *
   *  1. es la **única** que satisface el grafo —si hay dos, no hay una;
   *  2. usa un fragmento realmente leído del papel;
   *  3. la escala de ese fragmento está respaldada por la banda de importes;
   *  4. el resto de los conceptos tiene asignaciones independientes, así que la
   *     igualdad comprueba y no sostiene sola todo el pie;
   *  5. la segunda solución queda por debajo del margen.
   *
   * Lo que no cumple las cinco no se descarta ni se inventa: vuelve a ser un
   * importe leído sin concepto, que es lo que honestamente es.
   */
  /*
   * **Dos asignaciones con el mismo apoyo no son una respuesta: son dos.**
   *
   * Cuando el margen contra la segunda es cero y las dos dicen valores
   * distintos, el papel no alcanzó para elegir. Quedarse con la primera es
   * tirar una moneda y escribirla como si fuera un dato leído; sobre el lote
   * eso producía tres conceptos afirmados mal, y en los tres casos **la segunda
   * era la correcta**, que es la prueba de que no había nada que sostuviera a la
   * primera.
   *
   * Así que el número vuelve a lo que honestamente es: un importe leído del que
   * no se pudo probar qué concepto es, y el pie queda parcial.
   */
  const empatadas = mejor.asignaciones.filter(
    (a) =>
      a.segunda !== null &&
      a.margen === 0 &&
      /*
       * **Dos conceptos**, no dos lecturas del mismo número. La segunda mejor
       * de una celda suele ser ella misma cien veces más grande, y eso no es un
       * empate entre conceptos: es la misma asignación con una lectura peor, que
       * ya perdió donde tenía que perder.
       */
      !a.segunda.valor.eq(a.valor) &&
      /*
       * Y sólo cuando la etiqueta **no lo nombra exactamente**.
       *
       * Un rótulo impreso entero es evidencia fuerte y no se tira por un empate
       * de costo: «Total 121.000,00» dice lo que dice. El empate importa donde
       * la etiqueta salió dañada o no dice nada, que es donde la elección entre
       * dos candidatas es realmente una moneda al aire, y es el caso que se
       * midió: tres conceptos afirmados con etiquetas ilegibles y, en los tres,
       * la segunda opción era la correcta.
       */
      a.etiqueta?.exacta !== true &&
      /*
       * Ni cuando **cumple una igualdad fiscal**. Ahí el cierre no está
       * eligiendo entre dos candidatas parecidas: está confirmando una, que es
       * para lo único que sirve. El total de un comprobante cuya etiqueta salió
       * ilegible pero que da exactamente neto + IVA + percepciones está
       * identificado, y desasignarlo por un empate de costo geométrico sería
       * tirar la evidencia más fuerte que tiene el pie.
       */
      a.igualdad === null &&
      /*
       * Y **dos números distintos**, no el mismo leído en otra escala. La
       * segunda mejor de una celda suele ser ella misma cien veces más grande,
       * y eso no es un empate entre dos respuestas: es la misma asignación con
       * una lectura peor, que ya perdió donde tenía que perder.
       */
      !esLaMismaEnOtraEscala(a.valor, a.segunda.valor),
  );
  for (const empatada of empatadas) desasignar(mejor, empatada, origenElegido);

  const inferidas = mejor.asignaciones.filter(
    (a) => a.procedencia === 'INFERRED_FROM_DOCUMENT_RELATIONS',
  );
  const conEtiquetaPropia = mejor.asignaciones.filter(
    (a) => a.procedencia === 'READ_FROM_DOCUMENT',
  ).length;

  for (const inferida of inferidas) {
    const unica = inferida.segunda === null || inferida.margen > 0;
    const independientes = conEtiquetaPropia >= 1;
    const respaldada = escalaDeImportes === null || inferida.lecturaLiteral !== null;
    if (unica && independientes && respaldada) continue;

    desasignar(mejor, inferida, origenElegido);
  }

  /*
   * Y con qué compitió, para poder auditar la decisión: dos regiones del mismo
   * comprobante dan dos pies distintos y quien revise tiene que poder ver cuál
   * ganó, contra cuál, y buscarlas en la foto.
   */
  segundoOrigen =
    juegos
      .filter((j) => j.origen !== origenElegido)
      .map((j) => j.origen)
      .find(() => true) ?? null;

  return { ...mejor, region: origenElegido, segundaRegion: segundoOrigen };
}

/**
 * ¿Son estos dos valores el mismo número leído con la coma en otro lugar?
 *
 * Uno es el otro multiplicado o dividido por una potencia de diez. No es un
 * desempate entre dos conceptos: es una celda con dos lecturas, y de ésas se
 * ocupa la escala de la columna.
 */
function esLaMismaEnOtraEscala(a: Decimal, b: Decimal): boolean {
  if (a.lte(0) || b.lte(0)) return false;
  const mayor = Decimal.max(a, b);
  const menor = Decimal.min(a, b);
  const veces = mayor.div(menor);
  for (const potencia of [10, 100, 1000, 10000]) {
    if (veces.minus(potencia).abs().lt('0.0001')) return true;
  }
  return false;
}

/** Cuántas cifras tiene un texto, sin separadores ni nada más. */
function digitos(texto: string): number {
  return texto.replace(/\D/g, '').length;
}

/**
 * Devuelve un concepto asignado a su estado honesto: un importe sin asignar.
 *
 * El número sigue estando en la foto y sigue leído; lo que se retira es la
 * afirmación de qué concepto es. Conserva su texto, su caja, su lectura y sus
 * alternativas, porque con eso una persona lo encuentra y lo contesta.
 */
function desasignar(pie: PieFiscal, asignacion: AsignacionFiscal, region: string): void {
  pie.asignaciones = pie.asignaciones.filter((a) => a !== asignacion);
  pie.sinAsignar = [
    ...pie.sinAsignar,
    {
      texto: asignacion.origen.texto,
      caja: asignacion.origen.caja,
      pasada: asignacion.origen.pasada,
      confianza: asignacion.origen.confianza,
      valor: asignacion.valor,
      alternativas: asignacion.alternativas.map((x) => x.valor.toString()),
      region,
    },
  ];
  quitarDelPie(pie, asignacion);
  if (pie.estado === 'completo') pie.estado = 'parcial';
}

/**
 * Saca del resumen un concepto que dejó de estar asignado.
 *
 * El pie tiene los valores por duplicado —en los campos que consume el resto de
 * la aplicación y en la lista de asignaciones que explica de dónde salió cada
 * uno— y desasignar uno tiene que limpiar los dos lados. Dejarlo a medias
 * mostraría un neto en la pantalla y ninguna procedencia detrás.
 */
function quitarDelPie(pie: PieFiscal, asignacion: AsignacionFiscal): void {
  if (asignacion.concepto === 'netoGravado') pie.netoGravado = null;
  if (asignacion.concepto === 'noGravado') pie.noGravado = null;
  if (asignacion.concepto === 'total') {
    pie.total = null;
    pie.totalCalculado = false;
  }
  if (asignacion.concepto === 'iva') {
    pie.iva = pie.iva.filter((x) => !x.valor.eq(asignacion.valor));
  }
  if (asignacion.concepto === 'percepcion') {
    pie.percepciones = pie.percepciones.filter((x) => !x.valor.eq(asignacion.valor));
  }
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
  centavos: ReadonlyMap<Fragmento, Fragmento>,
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
      const lecturas = lecturasDelFragmento(fragmento, escala, centavos);
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
  centavos: ReadonlyMap<Fragmento, Fragmento>,
): { candidatas: Candidata[]; asignacion: AsignacionDeRegion } {
  const lineas = lineasDelPie(
    region.casillas.map((c) => c.fragmento),
    opciones.alturaTipica,
  );
  const lineaDe = (fragmento: Fragmento): LineaFiscal =>
    lineas.find((l) => l.numericos.includes(fragmento)) ?? lineas[0];

  /*
   * Qué casillas de la región pueden ser un importe.
   *
   * Se filtra **antes** de asignar, y ése es el orden correcto: una alícuota,
   * un identificador o una lectura pisada no entran al problema de
   * correspondencia, porque no son candidatos a nada. Meterlos y confiar en que
   * la asignación los descarte sería pedirle a la geometría que conteste una
   * pregunta que ya contestó el formato.
   */
  const numeros = region.casillas.filter((casilla) => {
    if (!casilla.esNumero) return false;
    if (descartados.has(casilla.fragmento)) return false;
    if (casilla.fragmento.texto.includes('%')) return false;
    const lecturas = lecturasDelFragmento(casilla.fragmento, escalaDeImportes, centavos);
    if (lecturas.length === 0) return false;
    const linea = lineaDe(casilla.fragmento);
    if (linea && linea.esIdentificadorDe(casilla.fragmento)) return false;
    return true;
  });

  /*
   * Y la correspondencia se resuelve **entera**, no número por número.
   *
   * Lo codicioso se equivoca siempre de la misma manera: dos etiquetas y dos
   * importes un poco corridos se emparejan cruzados, cada uno con el que tiene
   * más cerca, y sale una lectura coherente y falsa. Acá se elige la asignación
   * completa de menor costo, donde cada etiqueta toma a lo sumo un importe y
   * cada importe a lo sumo una etiqueta.
   */
  const asignacion = asignarRegion(region, numeros, {
    alturaTipica: opciones.alturaTipica,
    nombraConcepto: (etiqueta) => conceptoSegunEtiqueta(etiqueta)?.concepto ?? null,
  });

  const candidatas: Candidata[] = [];
  for (const par of asignacion.pares) {
    const fragmento = par.numero.fragmento;
    const etiqueta = etiquetaEfectiva(par.etiqueta.texto);
    candidatas.push({
      linea: lineaDe(fragmento),
      fragmento,
      etiqueta,
      lecturas: lecturasDelFragmento(fragmento, escalaDeImportes, centavos),
      porEtiqueta: conceptoSegunEtiqueta(etiqueta),
      alicuota: alicuotaDeLaEtiqueta(par.etiqueta.texto),
    });
  }

  /*
   * Los importes que quedaron sin etiqueta entran igual, **sin** ella: son los
   * que después puede identificar una igualdad fiscal, y los que si no se
   * identifican quedan explícitamente sin asignar. Perderlos acá sería perder
   * justamente los que el papel imprimió sin rótulo legible.
   */
  for (const casilla of asignacion.sinAsignar) {
    candidatas.push({
      linea: lineaDe(casilla.fragmento),
      fragmento: casilla.fragmento,
      etiqueta: '',
      lecturas: lecturasDelFragmento(casilla.fragmento, escalaDeImportes, centavos),
      porEtiqueta: null,
      alicuota: null,
    });
  }

  return { candidatas, asignacion };
}

/**
 * Las lecturas de un fragmento, con los centavos partidos ofrecidos como una más.
 *
 * La lectura pegada va **detrás** de las propias y cuesta una reparación: es
 * una suposición sobre el papel —que el OCR cortó el número en la coma— y como
 * toda suposición no gana por estar, gana si alguna relación fiscal la elige.
 * Ésa es la misma regla que usa el IVA para elegir entre dos lecturas de su
 * línea, y la que impide que un número se agrande porque sí.
 */
function lecturasDelFragmento(
  fragmento: Fragmento,
  escala: FormatoDeColumna | null,
  centavos: ReadonlyMap<Fragmento, Fragmento>,
): LecturaNumerica[] {
  const propias = lecturasDeCelda(fragmento.texto, escala);
  const pieza = centavos.get(fragmento);
  if (!pieza) return propias;

  const juntas = lecturasDeCelda(`${fragmento.texto},${pieza.texto.trim()}`, escala).map(
    (lectura) => ({
      ...lectura,
      literal: false,
      reparaciones: lectura.reparaciones + 1,
      comoSeLeyo: `${lectura.comoSeLeyo}; con los centavos «${pieza.texto.trim()}» de la caja de al lado`,
    }),
  );

  const yaEstan = new Set(propias.map((l) => l.valor.toString()));
  return [...propias, ...juntas.filter((l) => !yaEstan.has(l.valor.toString()))];
}

/**
 * La etiqueta que hay que usar, con el veto ya aplicado sobre la frase.
 *
 * Un veto se come lo que hay **hasta** él y deja lo que sigue: la frase entera
 * decide su alcance primero y su significado después. Si después del veto no
 * queda nada, la etiqueta no nombra nada y el importe queda sin asignar, que es
 * distinto de desaparecer.
 */
function etiquetaEfectiva(texto: string): string {
  const fin = dondeTerminaElVeto(texto);
  return fin === null ? texto : desdeLaPalabra(texto, fin);
}

/**
 * Las bases imponibles impresas, una por alícuota.
 *
 * Se piden **las dos cosas**: que la etiqueta diga «base imponible» como frase
 * completa, y que el valor esté leído. Una base no se deduce de una igualdad
 * —ése es el camino por el que cualquier número que multiplique bien se
 * convierte en la base que falta— así que sin su rótulo no hay base.
 *
 * La alícuota sale de la misma etiqueta cuando está impresa: «Base Imponible
 * IVA 21 %» trae las dos cosas. Sin ella la base queda con `alicuota: null`, que
 * es distinto de inventarle una.
 */
function elegirBasesImponibles(
  candidatas: Candidata[],
  usadas: Set<Fragmento>,
  renglones: number,
): AsignacionFiscal[] {
  const salida: AsignacionFiscal[] = [];
  const vistas = new Set<string>();

  for (const candidata of candidatas) {
    if (usadas.has(candidata.fragmento)) continue;

    if (candidata.lecturas.length === 0) continue;

    /*
     * Dos maneras de llegar a ser una base, y una sola de ellas alcanza sola.
     *
     * Con la frase completa impresa, la etiqueta basta. Con la frase mutilada
     * hacen falta **las dos cosas**: que el rótulo que la geometría le asignó a
     * este importe sea una lectura degradada de «base imponible», y que la
     * igualdad se cumpla contra un IVA impreso. El parecido solo nunca alcanza,
     * y la igualdad sola tampoco —ése es el camino por el que cualquier número
     * que multiplique bien se convierte en la base que falta—.
     *
     * La pregunta por la etiqueta va primero, y no es un detalle de orden: la
     * igualdad se busca contra todas las demás candidatas y sale cara, así que
     * se la hace sólo por los números que **dicen** ser una base.
     */
    const porLaFrase = candidata.porEtiqueta?.concepto === 'baseImponible';
    if (!porLaFrase && parecidoABaseImponible(candidata.etiqueta).parecido < PARECIDO_DE_ETIQUETA) {
      continue;
    }

    /*
     * Entre las lecturas del mismo lugar decide **la igualdad**, no el orden.
     *
     * Es la misma regla que usa el IVA con su línea: cuando dos lecturas del
     * mismo número compiten, la que multiplica bien contra un IVA impreso es la
     * que el papel tiene. Sobre una foto del lote el OCR partió la base en dos
     * cajas y la lectura de arriba quedó sin centavos: contra el IVA impreso no
     * cerraba por veintidós centavos, y con los centavos cierra.
     */
    let lectura = candidata.lecturas[0];
    let porLaIgualdad: Decimal | null = null;
    for (const otra of candidata.lecturas) {
      const alicuota = alicuotaQueConfirmaLaBase(candidata, otra.valor, candidatas, renglones);
      if (alicuota === null) continue;
      lectura = otra;
      porLaIgualdad = alicuota;
      break;
    }

    // Sin la frase entera, la igualdad es la otra mitad de la prueba.
    if (!porLaFrase && porLaIgualdad === null) continue;

    /*
     * Una base leída dos veces por dos pasadas es una base. Se distinguen por
     * su valor y su alícuota, que es lo que separa dos bases verdaderas —una al
     * 21 % y otra al 10,5 %— de dos lecturas del mismo renglón.
     */
    const alicuota = candidata.alicuota ?? porLaIgualdad;
    const clave = `${lectura.valor.toString()}|${alicuota?.toString() ?? ''}`;
    if (vistas.has(clave)) continue;
    vistas.add(clave);

    salida.push({
      concepto: 'baseImponible',
      valor: lectura.valor,
      origen: origenDe(candidata.fragmento),
      lecturaLiteral: candidata.lecturas.find((l) => l.literal)?.valor ?? null,
      alternativas: alternativasDe(candidata.lecturas, lectura.valor),
      alicuota,
      /*
       * La igualdad se anota **acá**, cuando hay un IVA impreso que la
       * confirma, y no sólo en la etapa del IVA: es lo que distingue una base
       * probada de una base que nada más está rotulada, y con eso decide
       * después quién ocupa el lugar del neto gravado.
       */
      igualdad:
        porLaIgualdad === null
          ? null
          : `base imponible × ${porLaIgualdad.times(100)} % = IVA`,
      costoDeReparacion: lectura.reparaciones,
      etiqueta: {
        texto: candidata.etiqueta,
        exacta: porLaFrase ? (candidata.porEtiqueta?.exacta ?? false) : false,
        parecido: porLaFrase
          ? (candidata.porEtiqueta?.parecido ?? 1)
          : parecidoABaseImponible(candidata.etiqueta).parecido,
      },
      segunda: null,
      margen: 1,
      /*
       * Una base recuperada de un rótulo comido es un concepto que puso la
       * **relación**, no la etiqueta, y el informe tiene que poder decirlo: el
       * número está leído del papel, pero lo que lo nombra es la igualdad.
       */
      procedencia: porLaFrase ? 'READ_FROM_DOCUMENT' : 'INFERRED_FROM_DOCUMENT_RELATIONS',
    });
    /*
     * Y el fragmento queda tomado. Una base es un concepto fiscal más, y sin
     * esto el mismo número volvía a competir como neto dos etapas después.
     */
    usadas.add(candidata.fragmento);
  }

  return salida;
}

/**
 * Cuánto se parece una etiqueta a la frase «base imponible».
 *
 * Se pregunta aparte porque `conceptoSegunEtiqueta` no reconoce la base
 * mutilada a propósito: el parecido de una frase de dos palabras no puede
 * afirmar sola contra qué se calculó un impuesto. Acá el parecido es sólo la
 * mitad de la evidencia; la otra mitad es la igualdad, y las dos se piden
 * juntas.
 */
function parecidoABaseImponible(etiqueta: string): { parecido: number; exacta: boolean } {
  const palabras = enPalabras(etiqueta);
  if (palabras.length === 0) return { parecido: 0, exacta: false };
  const junto = palabras.join(' ');
  for (const ajena of AJENAS) {
    if (junto.includes(ajena)) return { parecido: 0, exacta: false };
  }
  return cuantoSeParece(palabras, 'base imponible');
}

/**
 * Qué alícuota confirma que este importe es una base, si alguna lo confirma.
 *
 * La prueba es la igualdad impresa: base × alícuota tiene que dar un IVA que
 * esté **en el papel**, y ese IVA no puede estar rotulado como otra cosa. La
 * igualdad se comprueba contra los dos importes impresos y **no depende del
 * detalle**: sesenta centavos de desfase en la suma de los artículos no tienen
 * por qué costar la relación entre una base y su impuesto.
 *
 * Si la alícuota está impresa se prueba esa sola. Si no, se prueban todas las
 * que existen y hace falta que **una sola** cierre: dos alícuotas que dan el
 * mismo número no confirman nada, confirman que hay una ambigüedad.
 */
function alicuotaQueConfirmaLaBase(
  base: Candidata,
  valor: Decimal,
  candidatas: Candidata[],
  renglones: number,
): Decimal | null {
  const posibles = base.alicuota ? [base.alicuota] : ALICUOTAS;
  const confirman: Decimal[] = [];

  for (const alicuota of posibles) {
    const esperado = valor.times(alicuota);
    const hay = candidatas.some((otra) => {
      if (otra.fragmento === base.fragmento) return false;
      // Un número rotulado como otra cosa no es el IVA de nadie.
      if (otra.porEtiqueta !== null && otra.porEtiqueta.concepto !== 'iva') return false;
      if (otra.alicuota !== null && !otra.alicuota.eq(alicuota)) return false;
      return otra.lecturas.some((l) => dentroDeLaPrecision(l.valor, esperado, renglones));
    });
    if (hay) confirman.push(alicuota);
  }

  return confirman.length === 1 ? confirman[0] : null;
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
    sinAsignar: [],
    basesImponibles: [],
    netoDerivadoDeLasBases: false,
  };

  const usadas = new Set<Fragmento>();

  /*
   * --- 0. Las bases imponibles, que van **antes** que el neto ---------------
   *
   * Una base imponible dice sobre qué importe se calculó una alícuota, y ésa es
   * la relación más comprobable del pie: base × alícuota tiene que dar el IVA
   * impreso, y esa igualdad **no depende del detalle**. Por eso se resuelve
   * primero, aunque el neto sea el concepto que el resto de la aplicación
   * consume.
   *
   * El orden importaba de verdad: sobre una foto del lote el papel imprime
   * «Subtotal» y «Base Imponible IVA 21 %», los dos son números legítimos y
   * distintos, y el subtotal se parece más a la suma del detalle. Con el neto
   * resuelto primero ganaba el subtotal, y el número que alimenta el IVA
   * quedaba afuera. La cercanía a una suma es más débil que una igualdad.
   */
  const bases = elegirBasesImponibles(candidatas, usadas, opciones.renglonesDelDetalle ?? 1);
  for (const base of bases) {
    pie.asignaciones.push(base);
  }

  // --- 1. El neto, contra la suma del detalle ------------------------------
  let neto = elegirNeto(
    candidatas,
    opciones.sumaDelDetalle,
    opciones.renglonesDelDetalle ?? 1,
    pie,
    usadas,
  );

  /*
   * Y una base **probada** le gana el lugar del neto a un subtotal que no
   * prueba nada.
   *
   * Es el caso medido: el papel imprime «Subtotal 1.771.555,80» y «Base
   * Imponible IVA 21 % 1.523.537,99», los dos números son legítimos y el
   * subtotal ni siquiera cierra contra el detalle. Lo que sostiene a la base es
   * una igualdad independiente contra el IVA impreso, y eso vale más que una
   * etiqueta compatible. El subtotal no se borra: queda como un importe leído
   * sin concepto probado, que es exactamente lo que es.
   *
   * Con dos bases no se hace: ahí el neto es la suma, y de eso se ocupa la
   * derivación de más abajo. Y si el neto elegido trae su propia relación
   * —cierra contra la suma del detalle— no lo desplaza nadie.
   */
  const probada = bases.length === 1 && bases[0].igualdad !== null ? bases[0] : null;
  if (neto && probada && neto.igualdad === null && !neto.valor.eq(probada.valor)) {
    neto = null;
  }

  if (neto) {
    pie.netoGravado = neto.valor;
    pie.asignaciones.push(neto);
    usadas.add(neto.origen as unknown as Fragmento);
  }

  /*
   * Y si no hubo neto impreso pero sí bases, el neto **se deriva de su suma**.
   *
   * Se deriva y se dice: la procedencia queda en `DERIVED_SUGGESTION` cuando
   * son varias, porque ese número no está impreso en ninguna parte de la hoja.
   * Con una sola base el neto es esa base —el mismo número, leído del papel— y
   * conserva su procedencia original.
   *
   * Lo que no se hace nunca es reemplazar las bases: siguen estando, separadas
   * y con su alícuota, porque son lo que el comprobante dice y el agregado es
   * una cuenta.
   */
  if (pie.netoGravado === null && bases.length > 0) {
    const suma = bases.reduce((acumulado: Decimal, b) => acumulado.plus(b.valor), new Decimal(0));
    pie.netoGravado = suma;
    pie.netoDerivadoDeLasBases = bases.length > 1;
    if (bases.length === 1) {
      pie.asignaciones.push({
        ...bases[0],
        concepto: 'netoGravado',
        // Un neto no tiene alícuota: la que tiene es la de la base.
        alicuota: null,
        igualdad: 'la única base imponible es el neto gravado',
      });
    } else {
      pie.asignaciones.push({
        concepto: 'netoGravado',
        valor: suma,
        origen: bases[0].origen,
        lecturaLiteral: null,
        alternativas: [],
        alicuota: null,
        igualdad: `suma de ${bases.length} bases imponibles = neto gravado`,
        costoDeReparacion: 0,
        etiqueta: null,
        segunda: null,
        margen: 1,
        procedencia: 'DERIVED_SUGGESTION',
      });
    }
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

    /*
     * Contra **su base**, cuando hay bases impresas.
     *
     * Cada base se relaciona con el IVA de su misma alícuota, que es lo que
     * permite leer un comprobante con artículos al 21 % y al 10,5 %: los dos
     * IVAs cumplen su igualdad contra bases distintas, y comprobar los dos
     * contra un único neto agregado no cierra ninguno.
     *
     * Y cuando no hay bases, contra el neto, como siempre.
     */
    let asignacion: AsignacionFiscal | null = null;
    let suBase: AsignacionFiscal | null = null;
    for (const base of bases) {
      /*
       * Una alícuota impresa en los dos lados tiene que coincidir: el IVA del
       * 10,5 % no se comprueba contra la base del 21 %. Y cuando falta de un
       * lado —el OCR se come el porcentaje la mitad de las veces— manda la que
       * esté, que es reconocer la alícuota por la relación y no inventarla.
       */
      if (
        base.alicuota !== null &&
        candidata.alicuota !== null &&
        !base.alicuota.eq(candidata.alicuota)
      ) {
        continue;
      }
      const alicuota = base.alicuota ?? candidata.alicuota;
      const prueba = asignarIva(
        { ...candidata, alicuota },
        base.valor,
        opciones.renglonesDelDetalle ?? 1,
      );
      if (!prueba) continue;
      asignacion = prueba;
      suBase = base;
      break;
    }
    /*
     * Y si ninguna base lo explica, contra el neto, como siempre. El orden es
     * el que importa: comprobar los dos IVAs de un comprobante con artículos al
     * 21 % y al 10,5 % contra el **neto agregado** no cierra ninguno de los
     * dos, y los dos desaparecen del pie teniéndolos impresos.
     */
    if (!asignacion) {
      asignacion = asignarIva(candidata, pie.netoGravado, opciones.renglonesDelDetalle ?? 1);
    }
    if (!asignacion) continue;
    if (suBase) {
      /*
       * Y la alícuota que **cerró** la igualdad queda en la base, cuando el
       * papel no la imprimió a su lado o el OCR se comió el porcentaje. No es
       * inventarla: es reconocerla por la relación, que es lo mismo que hace el
       * IVA cuando su propia etiqueta sale mutilada.
       */
      if (suBase.alicuota === null) suBase.alicuota = asignacion.alicuota;
      asignacion.igualdad =
        suBase.alicuota !== null
          ? `base imponible × ${suBase.alicuota.times(100)} % = IVA`
          : 'base imponible × su alícuota = IVA';
      suBase.igualdad = asignacion.igualdad;
    }
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
    /*
     * Contra su base, si la tiene: es el importe sobre el que ese IVA se
     * calculó, y el neto agregado de un comprobante con dos alícuotas no lo es.
     */
    const suBase = bases.find(
      (b) =>
        b.alicuota !== null &&
        cada.asignacion.alicuota !== null &&
        b.alicuota.eq(cada.asignacion.alicuota),
    );
    const exacto = cada.asignacion.alicuota
      ? (suBase?.valor ?? pie.netoGravado ?? new Decimal(0)).times(cada.asignacion.alicuota)
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
   * Y recién acá se publican las bases, **con la alícuota que les quedó**:
   * impresa a su lado, o reconocida por la igualdad contra su IVA. Publicarlas
   * antes de resolver los IVAs las dejaba sin porcentaje en los papeles donde
   * el OCR se come el signo, que son la mitad.
   */
  for (const base of bases) {
    pie.basesImponibles.push({ alicuota: base.alicuota, valor: base.valor });
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
  /**
   * Los fragmentos que ya ocupó otro concepto.
   *
   * Una base imponible se resuelve antes que el neto, y sin esto el mismo
   * número volvía a entrar como neto: el pie mostraba dos veces el mismo
   * importe, una como base leída y otra como neto «deducido» de sí mismo.
   */
  usadas: ReadonlySet<Fragmento>,
): AsignacionFiscal | null {
  const posibles: {
    candidata: Candidata;
    lectura: LecturaNumerica;
    cierra: boolean;
    conIva: boolean;
  }[] = [];

  for (const candidata of candidatas) {
    if (usadas.has(candidata.fragmento)) continue;
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
