import Decimal from 'decimal.js';
import type { CandidataDeTabla, RenglonCandidato } from '@/lib/ocr/motor/candidatas';

/**
 * En qué orden se prefiere una lectura sobre otra.
 *
 * Hasta acá esto era una **suma de puntajes**: cada cosa que no cerraba restaba
 * unos décimos y ganaba el número más alto. Suena razonable y es exactamente el
 * mecanismo por el cual una lectura cien veces más grande le gana a la
 * verdadera. Una suma deja que las cosas se compensen, y hay compensaciones que
 * no existen: que el comprobante cierre contra el pie **no paga** haber supuesto
 * que el OCR perdió el separador decimal de dieciocho números, ni haber tirado
 * un renglón que estaba impreso en el papel.
 *
 * Así que las preferencias se aplican **en orden**, y cada una sólo se mira
 * cuando la anterior empató:
 *
 *  1. **conservar todos los renglones reales.** Un artículo impreso que se
 *     pierde es un artículo que la persona no ve y no carga. Ninguna cuenta que
 *     cierre lo compensa;
 *  2. **no leer en una escala que el papel desmiente.** Los separadores que la
 *     celda tiene impresos, y las anclas de su columna, deciden el orden de
 *     magnitud antes que cualquier cuenta;
 *  3. **maximizar los renglones comprobados solos.** Cantidad × precio =
 *     importe es la única verificación que no depende de nada más;
 *  4. **minimizar la cantidad y la severidad de las reparaciones.** Suponer que
 *     el papel dice algo distinto de lo que se leyó es legítimo, y es lo último
 *     que hay que hacer;
 *  5. **preferir las lecturas literales**, contadas una por una;
 *  6. **respetar un formato coherente por columna.** Una columna de precios
 *     donde diecinueve valores tienen dos decimales y uno tiene cero no es una
 *     columna con un valor raro: es un valor mal leído;
 *  7. **cerrar contra el pie**;
 *  8. y recién al final **la confianza del OCR y la geometría**.
 *
 * El punto de que el cierre esté sexto y no primero es el que arregla el error
 * que dio origen a todo esto. El cierre es una comprobación potentísima —usarla
 * es lo que permite elegir entre dos lecturas—, pero es una comprobación de
 * **consistencia**, no de verdad: una tabla entera leída sin separadores
 * decimales cumple las mismas igualdades que la buena, con todos los números
 * cien veces más grandes. Cerrar no puede hacer ganar a la candidata que
 * necesitó más suposiciones.
 *
 * No hay ningún umbral acá, y no hay ninguna suma. Lo que hay es un orden.
 */

export interface RasgosDeCandidata {
  /** Nivel 1: cuántos renglones reales conserva. */
  renglones: number;
  /**
   * Nivel 2: cuántos números leyó en una escala que el papel desmiente.
   *
   * Va **antes** que la aritmética y ése es todo el punto. Cuando una columna
   * pierde sus separadores, el precio y el importe se corren juntos: la cuenta
   * del renglón cierra igual de bien cien veces más grande, porque la
   * proporción se mantiene. Dejar que el cierre decidiera entre las dos escalas
   * era dejar que la aritmética creara evidencia que no tiene. La escala la
   * decide lo que está impreso —los separadores de la celda, las anclas de su
   * columna— y la aritmética la confirma o la deja en duda, nunca la inventa.
   */
  escalasAjenas: number;
  /** Nivel 3: cuántos se comprueban contra su propia aritmética. */
  comprobados: number;
  /** Nivel 4: cuántos números no se leyeron tal como están impresos. */
  reparaciones: number;
  /** Nivel 4: cuán grave es la peor suposición, de 0 a 3. */
  severidadMaxima: number;
  /** Nivel 5: cuántos renglones se leyeron enteros al pie de la letra. */
  literales: number;
  /** Nivel 6: cuánto se aparta en total del formato de sus columnas. */
  incoherencia: number;
  /** Nivel 7: si la suma cierra contra el pie impreso. */
  cierra: boolean;
  /** Nivel 8: lo que queda, que es confianza y geometría. */
  puntaje: number;
}

/** ¿Se comprueba solo? Al menos un control hecho y ninguno fallado. */
function seComprueba(renglon: RenglonCandidato): boolean {
  return renglon.controles.length > 0 && renglon.controles.every((c) => c.paso);
}

/**
 * ¿Es éste un renglón que estaba impreso en el papel?
 *
 * Un renglón real tiene **algo que lo nombra** —una descripción o un código— y
 * **algo de plata**: un importe, un precio, o un precio con descuento. No se le
 * pide que cierre: un artículo cuyo subtotal salió ilegible sigue siendo un
 * artículo si se leyó su precio, y perderlo es justamente lo que el primer
 * nivel del orden existe para impedir.
 *
 * Lo que **no** alcanza es tener un número cualquiera, y eso fue un error
 * medido. Con «nombre más algún número» la continuación de una descripción
 * —una línea que sigue el nombre del artículo de arriba y a la que le cayó
 * encima un valor de la columna de cantidades— cuenta como artículo, y una
 * reconstrucción con veinticuatro renglones le gana en el primer nivel a la de
 * veintitrés, que es la correcta. Una continuación de descripción no se vuelve
 * un artículo nuevo por contener una unidad o un número.
 */
function esReal(renglon: RenglonCandidato): boolean {
  const nombrado = renglon.descripcion.trim() !== '' || renglon.codigo !== null;
  const conMonto =
    renglon.importe !== null ||
    renglon.precioUnitario !== null ||
    renglon.precioConDescuento !== null;

  /*
   * Y la plata tiene que ser plata que el papel sostenga.
   *
   * Un renglón cuya peor suposición es un salto de escala —un valor que su
   * columna dice que no puede estar ahí— no demuestra nada por tener un número:
   * ese número es la lectura mala, no la evidencia. Cuenta igual si **se
   * comprueba solo**, porque cantidad × precio = importe no depende de ninguna
   * columna y es mejor evidencia que cualquier sospecha de escala.
   *
   * Sin esta condición, el primer nivel del orden se podía comprar con basura, y
   * se midió así: seis fragmentos de ocho nueves tirados encima de la columna de
   * precios le daban importe a una fila que no lo tenía, subían el conteo de
   * renglones reales y ganaban el primer nivel, que no lo compensa nada. El
   * nivel existe para no **perder** un artículo impreso, no para premiar al que
   * le inventa un número a una fila incompleta.
   */
  const plataCreible = renglon.severidad < 3 || seComprueba(renglon);

  return nombrado && conMonto && plataCreible;
}

export function rasgosDe(candidata: CandidataDeTabla): RasgosDeCandidata {
  const renglones = candidata.renglones;
  return {
    renglones: renglones.filter(esReal).length,
    escalasAjenas: renglones.reduce((n, r) => n + r.escalasAjenas, 0),
    comprobados: renglones.filter(seComprueba).length,
    reparaciones: renglones.reduce((n, r) => n + r.reparaciones, 0),
    severidadMaxima: renglones.reduce((n, r) => Math.max(n, r.severidad), 0),
    literales: renglones.filter((r) => r.reparaciones === 0).length,
    /*
     * La incoherencia se **suma** aunque la severidad se tome como máximo, y
     * son dos preguntas distintas: el nivel 3 pregunta cuán grave es la peor
     * suposición de la candidata, y el nivel 5, cuántas celdas se leyeron de
     * una manera que ninguno de sus vecinos de columna sostiene. Una candidata
     * con una celda escrita a contramano y otra con seis tienen la misma peor
     * suposición y no son igual de creíbles.
     */
    incoherencia: renglones.reduce((n, r) => n + r.incoherentes, 0),
    cierra: candidata.cierre?.compatible === true,
    puntaje: candidata.puntaje,
  };
}

/**
 * Compara dos candidatas. Negativo si gana `a`, igual que un comparador de
 * `sort`: ordenar con esto pone primera a la que hay que mostrar.
 */
export function compararLexicografico(a: RasgosDeCandidata, b: RasgosDeCandidata): number {
  return (
    // 1. Conservar todos los renglones reales.
    b.renglones - a.renglones ||
    // 2. No leer en una escala que el papel desmiente.
    a.escalasAjenas - b.escalasAjenas ||
    // 3. Maximizar los renglones comprobados solos.
    b.comprobados - a.comprobados ||
    // 4. Minimizar la cantidad y la severidad de las reparaciones.
    a.reparaciones - b.reparaciones ||
    a.severidadMaxima - b.severidadMaxima ||
    // 5. Preferir las lecturas literales.
    b.literales - a.literales ||
    // 6. Respetar un formato coherente por columna.
    a.incoherencia - b.incoherencia ||
    // 7. Cerrar contra el pie.
    Number(b.cierra) - Number(a.cierra) ||
    // 7. Confianza del OCR y geometría, que es lo que quedó en el puntaje.
    b.puntaje - a.puntaje
  );
}

export function compararCandidatas(a: CandidataDeTabla, b: CandidataDeTabla): number {
  return compararLexicografico(rasgosDe(a), rasgosDe(b));
}

/**
 * Cuánto más grande es una lectura que la otra, mirando la suma de los renglones.
 *
 * Un factor cercano a cien —o a mil— entre dos lecturas del **mismo** papel no
 * es una diferencia de criterio: es el separador decimal, y una de las dos está
 * mal. Se usa para no dejar pasar sola una elección de escala.
 */
export function factorDeEscala(a: CandidataDeTabla, b: CandidataDeTabla): number {
  const x = a.sumaDeRenglones;
  const y = b.sumaDeRenglones;
  if (x.lte(0) || y.lte(0)) return 1;
  const mayor = Decimal.max(x, y);
  const menor = Decimal.min(x, y);
  return mayor.div(menor).toNumber();
}

/**
 * ¿Quedan dos escalas completas posibles y nada literal para elegir entre ellas?
 *
 * Éste es el caso que **tiene que ir a revisión** en vez de resolverse. Las dos
 * lecturas cierran consigo mismas, una es cien veces la otra, y ninguna tiene
 * más evidencia literal que la otra: el papel no alcanza para decidir, y elegir
 * por magnitud —la más grande, la más chica, la que se parece al total— es
 * tirar una moneda con el costo de cada artículo.
 *
 * No se mira el total impreso para desempatar, a propósito: si el total se leyó
 * con la misma convención equivocada, cierra igual de bien con la escala
 * equivocada.
 */
export const FACTOR_DE_ESCALA_SOSPECHOSO = 50;

export function escalaIndecidible(a: CandidataDeTabla, b: CandidataDeTabla): boolean {
  if (factorDeEscala(a, b) < FACTOR_DE_ESCALA_SOSPECHOSO) return false;

  const ra = rasgosDe(a);
  const rb = rasgosDe(b);

  // Las dos tienen que estar completas: una lectura a medias no es una escala
  // posible, es una lectura peor.
  if (ra.renglones !== rb.renglones) return false;
  if (ra.comprobados !== rb.comprobados) return false;

  /*
   * Y ninguna tiene que tener más evidencia literal que la otra. Cuando una se
   * lee al pie de la letra y la otra necesita suponer separadores perdidos, el
   * nivel 4 del orden ya decide y no hay nada que revisar: eso es justamente lo
   * que pasa con la lectura cien veces más grande de la mayoría de los
   * comprobantes, y mandarla a revisión sería pedirle a una persona que
   * confirme lo que el papel ya dice.
   */
  return ra.literales === rb.literales && ra.reparaciones === rb.reparaciones;
}
