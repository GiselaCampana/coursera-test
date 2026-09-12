import type { Caja } from '@/lib/ocr/reconstruccion/evidencia';
import type { SugerenciaDerivada } from '@/lib/ocr/motor/sugerencias';

/**
 * Qué le queda por resolver a una persona, y qué es apenas una anotación.
 *
 * La distinción es la que decide si esto es una revisión asistida o volver a
 * tipear la factura. Antes había una sola lista de «pendientes» y un número al
 * final: «25 pendientes» no dice si hay que corregir la factura entera o
 * apretar un botón. Peor: mezclaba cosas que **faltan** con cosas que
 * **sobran**, y una lectura alternativa que perdió contra otra bajaba la
 * confianza como si faltara un dato del comprobante.
 *
 * Entonces hay dos familias, y sólo una frena:
 *
 *  - las **bloqueantes** son datos del comprobante que no están o que no se
 *    pueden decidir. Sin resolverlas no se puede cargar la compra;
 *  - las **advertencias** son evidencia que se descartó: una lectura que perdió,
 *    un fragmento de ruido, un campo opcional vacío. Quedan anotadas para poder
 *    auditar la decisión y **no impiden aceptar el comprobante**.
 *
 * Si Mabelherdi tiene sus nueve artículos y la suma da exactamente el neto
 * impreso, veinticinco fragmentos descartados no son motivo para hacer corregir
 * nada.
 */
export type CategoriaPendiente =
  /** Falta un dato obligatorio del renglón. */
  | 'BLOCKING_MISSING_CELL'
  /** Hay dos valores plausibles para la misma celda y ninguno gana. */
  | 'BLOCKING_AMBIGUOUS_CELL'
  /** No se sabe qué significa una columna que hace falta para las cuentas. */
  | 'BLOCKING_UNKNOWN_COLUMN'
  /** No se puede resolver si la cantidad es de kilos, piezas u otra unidad. */
  | 'BLOCKING_UNIT'
  /** El renglón no se puede asociar a un producto del catálogo. */
  | 'BLOCKING_PRODUCT'
  /** Una lectura alternativa perdió contra otra: queda anotada. */
  | 'WARNING_DISCARDED_ALTERNATIVE'
  /** Texto o número que no pertenece a la tabla. */
  | 'WARNING_OCR_NOISE'
  /** Falta un dato que no hace falta para cerrar el comprobante. */
  | 'WARNING_OPTIONAL_FIELD';

/**
 * Las cinco que frenan.
 *
 * Está escrito como un conjunto y no como un prefijo `BLOCKING_` a propósito:
 * que una categoría bloquee es una decisión, no una convención de nombres, y
 * tiene que poder revisarse de un vistazo.
 */
export const CATEGORIAS_BLOQUEANTES: ReadonlySet<CategoriaPendiente> = new Set([
  'BLOCKING_MISSING_CELL',
  'BLOCKING_AMBIGUOUS_CELL',
  'BLOCKING_UNKNOWN_COLUMN',
  'BLOCKING_UNIT',
  'BLOCKING_PRODUCT',
]);

export function bloquea(categoria: CategoriaPendiente): boolean {
  return CATEGORIAS_BLOQUEANTES.has(categoria);
}

/** Una lectura posible, con de dónde salió, para poder mostrarla en la foto. */
export interface AlternativaDePendiente {
  texto: string;
  caja: Caja;
  pasada: string;
  confianza: number;
  /** La propuso el propio OCR como segunda opción de esa misma palabra. */
  delPropioOcr?: boolean;
}

export interface Pendiente {
  /**
   * Un identificador estable dentro del informe, para poder encadenarlos.
   *
   * No es una clave de base de datos: es lo que permite decir «este bloqueo
   * existe **por** aquel otro» sin repetir el texto.
   */
  id: string;
  /**
   * De qué otro bloqueo depende éste, cuando es una consecuencia.
   *
   * Es la corrección que convirtió un informe ilegible en uno accionable.
   * Cuatro cantidades dañadas producían treinta y dos ambigüedades: el precio
   * de ese renglón, su descuento, su subtotal y su cierre **no se pueden
   * decidir hasta resolver la cantidad**, así que no son treinta y dos
   * problemas, son cuatro con sus consecuencias. Contarlas todas le dice a una
   * persona que tiene media hora de trabajo cuando tiene cuatro números que
   * mirar.
   *
   * `null` es un bloqueo **raíz**: algo que una persona puede resolver ahora,
   * mirando el papel, sin depender de nada.
   */
  dependeDe: string | null;
  categoria: CategoriaPendiente;
  /** Contando desde 1, o null cuando es del comprobante entero. */
  renglon: number | null;
  /** El campo semántico —cantidad, importe— cuando corresponde. */
  campo: string | null;
  /** El título de la columna, o su posición cuando no tiene título. */
  columna: string | null;
  /** Todas las lecturas en juego, la elegida primero. */
  alternativas: AlternativaDePendiente[];
  /** El valor que quedó elegido, si hay alguno. */
  elegido: string | null;
  /**
   * Cuánto **daría** el valor que falta, si la aritmética del renglón lo puede
   * calcular.
   *
   * Va acá y no en el renglón a propósito: es una ayuda para quien va a tipear
   * el número, no un dato. El renglón sigue teniendo el agujero, la celda sigue
   * siendo un bloqueo, y la sugerencia dice de qué igualdad salió para que se
   * pueda contrastar contra el papel en vez de aceptarla a ciegas.
   */
  sugerencia?: SugerenciaDerivada;
  /** Por qué frena, o por qué no frena. */
  motivo: string;
}

/**
 * El resumen, con los conteos **disjuntos**.
 *
 * El total y el desglose no pueden sumarse entre sí. Antes el resumen decía
 * «2 correcciones manuales» y «2 columnas sin reconocer», y eso se lee como
 * cuatro problemas cuando son los mismos dos: las dos columnas **son** las dos
 * correcciones. Ahora hay un total de bloqueos únicos y, debajo, en qué se
 * reparte ese mismo total.
 */
export interface ResumenDePendientes {
  /**
   * Cuántas acciones tiene que hacer una persona.
   *
   * Son los bloqueos **raíz** y nada más. Las consecuencias no se suman: se
   * resuelven solas cuando se resuelve su raíz, y contarlas es contar dos veces
   * el mismo problema.
   */
  bloqueosUnicos: number;
  /** En qué se reparte ese total. Las cinco suman `bloqueosUnicos`. */
  desglose: {
    celdasObligatoriasFaltantes: number;
    ambiguedadesBloqueantes: number;
    columnasSinReconocer: number;
    unidadesPendientes: number;
    asociacionesDeProductoPendientes: number;
  };
  /**
   * Cuántos bloqueos dependen de una raíz.
   *
   * Se informa aparte y **no se suma** a los anteriores: es lo que se va a
   * destrabar solo. Sirve para poder decir «cuatro cantidades por confirmar, y
   * con ellas se resuelven veintiocho celdas más».
   */
  consecuencias: number;
  /** Evidencia anotada que no impide aceptar el comprobante. */
  advertenciasNoBloqueantes: number;
}

export function resumir(pendientes: Pendiente[]): ResumenDePendientes {
  const bloqueantes = pendientes.filter((p) => bloquea(p.categoria));
  const raices = bloqueantes.filter((p) => p.dependeDe === null);

  const contar = (categoria: CategoriaPendiente) =>
    raices.filter((p) => p.categoria === categoria).length;

  const desglose = {
    celdasObligatoriasFaltantes: contar('BLOCKING_MISSING_CELL'),
    ambiguedadesBloqueantes: contar('BLOCKING_AMBIGUOUS_CELL'),
    columnasSinReconocer: contar('BLOCKING_UNKNOWN_COLUMN'),
    unidadesPendientes: contar('BLOCKING_UNIT'),
    asociacionesDeProductoPendientes: contar('BLOCKING_PRODUCT'),
  };

  const bloqueosUnicos = Object.values(desglose).reduce((a, b) => a + b, 0);

  return {
    bloqueosUnicos,
    desglose,
    consecuencias: bloqueantes.length - raices.length,
    advertenciasNoBloqueantes: pendientes.length - bloqueantes.length,
  };
}

/** Los bloqueos que una persona puede resolver ahora, sin esperar a otro. */
export function soloRaices(pendientes: Pendiente[]): Pendiente[] {
  return pendientes.filter((p) => bloquea(p.categoria) && p.dependeDe === null);
}

/** Qué se destraba al resolver un bloqueo raíz. */
export function consecuenciasDe(pendientes: Pendiente[], raiz: string): Pendiente[] {
  return pendientes.filter((p) => p.dependeDe === raiz);
}

/** Los que frenan la aceptación. */
export function soloBloqueantes(pendientes: Pendiente[]): Pendiente[] {
  return pendientes.filter((p) => bloquea(p.categoria));
}
