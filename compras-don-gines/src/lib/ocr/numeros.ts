import { Decimal, parseArNumber } from '@/lib/money';
import { CLASE_DIGITOS_OCR, repararDigitos } from '@/lib/ocr/parsers/tipos';

/**
 * Números leídos de una foto, con todas sus lecturas posibles.
 *
 * Vive aparte porque lo necesitan varios analizadores y porque la regla que
 * implementa no es de ningún proveedor: es de cómo falla el OCR sobre papel.
 * Cada analizador sigue decidiendo por su cuenta qué significa cada número —qué
 * columna es, contra qué tiene que cerrar—; lo único que se comparte es cómo se
 * extraen y en qué se pueden estar equivocando.
 */

/**
 * Todas las lecturas posibles de un número, para que la aritmética elija.
 *
 * Sobre una foto el OCR escribe los puntos de miles como comas: el papel dice
 * «15.295,149» y sale «15,295,149», que leído al pie de la letra es quince
 * millones. Los dígitos están todos y en orden; lo único que se perdió es cuál
 * de los separadores era la coma decimal.
 *
 * Esto **no** es ajustar un número para que la cuenta cierre. Es enumerar
 * lecturas de los mismos dígitos impresos, y la que se acepta tiene que
 * satisfacer una igualdad que no depende de ella. Si ninguna cierra, no se toca
 * nada y el renglón queda marcado.
 */
export function variantesDeNumero(texto: string): Decimal[] {
  const limpio = repararDigitos(texto.trim().replace(/[$%\s]/g, ''));
  const salida: Decimal[] = [];
  const agregar = (v: Decimal | null) => {
    if (v && v.isFinite() && !salida.some((x) => x.eq(v))) salida.push(v);
  };

  agregar(parseArNumber(limpio));

  const separadores = [...limpio.matchAll(/[.,]/g)].map((m) => m.index!);
  if (separadores.length >= 2) {
    // El último separador es la coma decimal y los otros son de miles.
    const ultimo = separadores[separadores.length - 1];
    const enteros = limpio.slice(0, ultimo).replace(/[.,]/g, '');
    const decimales = limpio.slice(ultimo + 1);
    if (/^\d+$/.test(enteros) && /^\d+$/.test(decimales)) {
      agregar(new Decimal(`${enteros}.${decimales}`));
    }
    // Y la lectura en la que todos son de miles: un entero.
    const todoEntero = limpio.replace(/[.,]/g, '');
    if (/^\d+$/.test(todoEntero)) agregar(new Decimal(todoEntero));
  }

  /*
   * El importe al que el OCR le comió todos los separadores.
   *
   * En la factura de Barraza el papel dice «238,234.75» y sale «23823475»: los
   * dígitos están todos y en orden, y lo único que se perdió es el punto. Sin
   * esta variante ese renglón no tiene importe legible y hay que calcularlo,
   * cuando en realidad está impreso.
   *
   * Se ofrece sólo para enteros largos, de seis dígitos para arriba. Por debajo
   * de eso un entero es una cantidad, un porcentaje o un código, y dividirlo
   * por cien inventaría un candidato donde no hay ninguno. Como siempre acá:
   * es una lectura más de los mismos dígitos, y la acepta o la descarta la
   * aritmética del renglón.
   */
  if (/^\d{6,}$/.test(limpio)) {
    agregar(new Decimal(limpio).div(100));
  }

  return salida;
}

/**
 * Los números sueltos que hay en un texto, con todas sus lecturas.
 *
 * La garantía que hay que cuidar acá es que **una letra suelta no es un
 * número**. `CLASE_DIGITOS_OCR` incluye las letras con las que el OCR confunde
 * dígitos —S por 5, B por 8, O por 0— y eso está bien adentro de un número,
 * para reparar «1S3,7O». Aplicado a un texto cualquiera convierte cada letra en
 * una cifra: la S de «SUB-TOTAL» salía como un 5.
 *
 * No era inofensivo. Ese 5 entraba como número del pie del comprobante, y como
 * los del pie se descartan de los candidatos de los renglones, el 5 % de
 * descuento de dos artículos de Ezra quedaba afuera y los dos se cargaban sin
 * descuento. La regresión que lo fija está en `numeros-canonicos.test.ts`.
 */
export function numerosDelTexto(texto: string): Decimal[] {
  const encontrados = [
    ...texto.matchAll(new RegExp(`[${CLASE_DIGITOS_OCR}][${CLASE_DIGITOS_OCR}.,]*`, 'g')),
  ].map((m) => m[0]);

  const salida: Decimal[] = [];
  for (const crudo of encontrados) {
    // Un tramo sin ningún dígito de verdad no es un número.
    if (!/\d/.test(crudo)) continue;
    for (const valor of variantesDeNumero(crudo)) {
      if (valor.gt(0) && !salida.some((x) => x.eq(valor))) salida.push(valor);
    }
  }
  return salida;
}

/** ¿Dos importes que son el mismo, con la tolerancia que se le pase? */
export function casiIgual(a: Decimal, b: Decimal, tolerancia: Decimal): boolean {
  return a.minus(b).abs().lte(tolerancia);
}
