import { Decimal } from '@/lib/money';
import type { Caja, Fragmento } from '@/lib/ocr/reconstruccion/evidencia';
import { parecido } from '@/lib/ocr/motor/semantica-de-columnas';
import { lecturasDeCelda, type LecturaNumerica } from '@/lib/ocr/motor/formato-de-columna';
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
}

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
export function reconciliarPie(fragmentos: Fragmento[], opciones: OpcionesDelPie): PieFiscal {
  const desde = opciones.desdeY ?? 0;
  const lineas = lineasDelPie(
    fragmentos.filter((f) => (f.caja.y0 + f.caja.y1) / 2 >= desde),
    opciones.alturaTipica,
  );

  const candidatas: Candidata[] = [];
  for (const linea of lineas) {
    for (const fragmento of linea.numericos) {
      /*
       * Un número con el signo de porcentaje pegado es una **alícuota**, no un
       * importe. «Perc IIBB CABA 1,50 % 7.098,49» tiene los dos números en la
       * misma línea y con la misma etiqueta, y sin esta distinción el 1,50
       * entraba como una segunda percepción de un peso cincuenta: el total del
       * comprobante dejaba de cerrar por ese peso y medio y quedaba informado
       * como calculado teniéndolo impreso en el papel.
       */
      if (fragmento.texto.includes('%')) continue;
      const lecturas = lecturasDeCelda(fragmento.texto, null);
      if (lecturas.length === 0) continue;
      /*
       * La etiqueta de su propia línea primero; si no dice nada reconocible, se
       * mira una línea más arriba o más abajo. Ese segundo intento es el que
       * recupera el pie de dos columnas —«Neto Gravado» a la izquierda y su
       * importe al margen derecho, a dos alturas de renglón de distancia— sin
       * ensuciar las etiquetas que sí estaban donde tenían que estar.
       */
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
      // Lo que viene detrás de «RG» o de «Res.» es el número de una norma.
      if (esIdentificador(etiqueta)) continue;

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

  const pie: PieFiscal = {
    netoGravado: null,
    noGravado: null,
    iva: [],
    percepciones: [],
    total: null,
    totalCalculado: false,
    asignaciones: [],
    enRevision: [],
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

  // --- 3. Las percepciones: cero, una o varias -----------------------------
  for (const candidata of candidatas) {
    if (candidata.porEtiqueta?.concepto !== 'percepcion') continue;
    if (usadas.has(candidata.fragmento)) continue;
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

  return pie;
}

/** Cuánto tendría que dar el total, con lo que se asignó. */
function totalEsperado(pie: PieFiscal): Decimal | null {
  if (!pie.netoGravado) return null;
  let suma = pie.netoGravado.plus(pie.noGravado ?? 0);
  for (const iva of pie.iva) suma = suma.plus(iva.valor);
  for (const percepcion of pie.percepciones) suma = suma.plus(percepcion.valor);
  return suma.toDecimalPlaces(2);
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
  gana: { lectura: LecturaNumerica; cierra: boolean },
  otra: { lectura: LecturaNumerica; cierra: boolean } | null,
): number {
  if (!otra) return 1;
  let ventaja = 0;
  if (gana.lectura.literal && !otra.lectura.literal) ventaja += 1;
  if (gana.cierra && !otra.cierra) ventaja += 1;
  if (gana.lectura.reparaciones < otra.lectura.reparaciones) ventaja += 1;
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
