import { parseArNumber } from '@/lib/money';
import type { OcrHeader, OcrItem, OcrSummary } from '@/lib/ocr/types';

/**
 * Textos que llegan del lector para un comprobante.
 *
 * `completo` es la página entera; los otros tres son los recortes ampliados de
 * cada zona. Cuando un recorte no se pudo hacer, viene en null y el analizador
 * cae al texto completo.
 */
export interface TextosComprobante {
  completo: string;
  encabezado?: string | null;
  articulos?: string | null;
  resumen?: string | null;
}

export interface AnalisisComprobante {
  header: OcrHeader | null;
  items: OcrItem[];
  summary: OcrSummary | null;
  /** Lo que el analizador no pudo resolver. Nunca se completa inventando. */
  observaciones: string[];
  /**
   * Jirones con forma de renglón que quedaron sin identificar.
   *
   * Son tramos del texto que tienen la forma de una fila de la tabla —una
   * cantidad, el par de porcentajes, un importe que cabe en el comprobante— pero
   * a los que no se les pudo leer ni el código ni la descripción, y cuyo importe
   * no coincide con el de ningún renglón ya interpretado.
   *
   * Existe por un modo de fallar que ningún otro control ve: cuando el detector
   * de filas y el analizador **se pierden la misma fila**, el comprobante queda
   * en "22 interpretados / 22 filas vistas" y el semáforo se pone en verde con
   * un artículo de menos. Este número es una tercera señal, independiente de las
   * otras dos, y lo que hace es impedir ese verde.
   */
  filasSinResolver?: number;
  /**
   * ¿Alguno de esos jirones está en el borde de abajo de la tabla?
   *
   * Cuando lo está, la fila que falta se puede recuperar releyendo esa franja
   * sola, sin volver a pasar por la página entera.
   */
  faltaElFinalDeLaTabla?: boolean;
}

/**
 * Analizador de un formato de comprobante.
 *
 * Cada proveedor imprime distinto: cambia el orden de las columnas, cómo se
 * llama cada total y hasta si el descuento va por renglón o al pie. En vez de
 * un analizador universal que adivine, hay uno por formato y un genérico que
 * cubre el caso común.
 */
export interface AnalizadorComprobante {
  /** Identificador estable, se guarda junto con la lectura. */
  readonly codigo: string;
  readonly nombre: string;
  /**
   * Qué tan bien reconoce este texto, de 0 a 1. El registro se queda con el
   * analizador de mayor puntaje; por debajo de 0,5 se usa el genérico.
   */
  reconoce(textos: TextosComprobante): number;
  analizar(textos: TextosComprobante): AnalisisComprobante;
}

/**
 * Corrige las confusiones típicas del OCR dentro de una columna que se sabe
 * numérica.
 *
 * Esto es transcripción, no invención: no se toca ningún importe para que una
 * cuenta cierre, sólo se traduce el carácter que Tesseract eligió mal entre
 * formas idénticas. Sólo se aplica a columnas cuyo encabezado dice que son
 * números, nunca a las descripciones.
 */
export function repararDigitos(texto: string): string {
  return texto
    .replace(/[OoQ]/g, '0')
    .replace(/[lI|]/g, '1')
    .replace(/[Ss]/g, '5')
    .replace(/[Bb]/g, '8')
    .replace(/[Zz]/g, '2')
    .replace(/[gq]/g, '9')
    .replace(/[·•]/g, '.');
}

/**
 * Caracteres que el OCR puede devolver donde había un dígito.
 *
 * Se usa para armar las expresiones regulares que capturan números en el texto
 * reconocido: si la clase sólo aceptara `\d`, un "1S3,7O" no llegaría siquiera
 * a repararDigitos.
 */
export const CLASE_DIGITOS_OCR = '\\dOoQlI|SsBbZzgq';

/**
 * ¿La columna es un número, aun con la basura habitual del OCR?
 *
 * Se exige al menos un dígito de verdad —si no, una palabra como "SOS" pasaría
 * por número— y que todo lo demás sea o un dígito, o uno de los caracteres con
 * los que el OCR los confunde, o un separador. Recién entonces se repara y se
 * comprueba que el resultado se pueda interpretar.
 */
export function esColumnaNumerica(texto: string): boolean {
  const limpio = texto.trim();
  if (limpio === '') return false;
  if (!/\d/.test(limpio)) return false;
  if (!/^[$\s]*-?[\dOoQlI|SsBbZzgq.,·•\s]+%?$/.test(limpio)) return false;
  return parseArNumber(repararDigitos(limpio)) !== null;
}
