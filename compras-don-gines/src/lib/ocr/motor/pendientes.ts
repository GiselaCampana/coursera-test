import type { Caja } from '@/lib/ocr/reconstruccion/evidencia';

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
  /** Cuántas cosas distintas tiene que resolver una persona. */
  bloqueosUnicos: number;
  /** En qué se reparte ese total. Las cinco suman `bloqueosUnicos`. */
  desglose: {
    celdasObligatoriasFaltantes: number;
    ambiguedadesBloqueantes: number;
    columnasSinReconocer: number;
    unidadesPendientes: number;
    asociacionesDeProductoPendientes: number;
  };
  /** Evidencia anotada que no impide aceptar el comprobante. */
  advertenciasNoBloqueantes: number;
}

export function resumir(pendientes: Pendiente[]): ResumenDePendientes {
  const contar = (categoria: CategoriaPendiente) =>
    pendientes.filter((p) => p.categoria === categoria).length;

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
    advertenciasNoBloqueantes: pendientes.length - bloqueosUnicos,
  };
}

/** Los que frenan la aceptación. */
export function soloBloqueantes(pendientes: Pendiente[]): Pendiente[] {
  return pendientes.filter((p) => bloquea(p.categoria));
}
