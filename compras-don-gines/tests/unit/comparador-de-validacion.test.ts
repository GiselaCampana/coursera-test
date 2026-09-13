import { describe, it, expect } from 'vitest';
import { comoNumero, VERSION_DEL_COMPARADOR } from '@/lib/ocr/validacion/comparar';

/**
 * La herramienta de medición, medida.
 *
 * Esto existe porque la primera comparación de un lote le anotó al motor un
 * error que era del comparador: el papel imprime «4.874,380» con tres
 * decimales, la función tiraba todos los puntos como separadores de miles y lo
 * convertía en cuatro millones. El motor había leído bien.
 *
 * Una herramienta de medición equivocada es peor que no medir: produce
 * conclusiones con la misma cara que las verdaderas. Y el error concreto era
 * doblemente grave, porque la misma regla habría declarado **iguales**
 * «10361.45» y «1.036.145» —un factor de cien— que es exactamente la clase de
 * falla que la validación existe para detectar.
 */

describe('las cinco escrituras que aparecen entre el acta y el papel', () => {
  it('con coma, la coma es el decimal y los puntos son de miles', () => {
    expect(comoNumero('4.874,380')).toBeCloseTo(4874.38, 5);
    expect(comoNumero('4.874,38')).toBeCloseTo(4874.38, 5);
    expect(comoNumero('1.036.145,00')).toBeCloseTo(1036145, 5);
    expect(comoNumero('1.862,49')).toBeCloseTo(1862.49, 5);
  });

  it('sin coma y con un solo punto, el punto es el decimal', () => {
    // Son las dos formas en que sale un `Decimal.toString()`.
    expect(comoNumero('4874.380')).toBeCloseTo(4874.38, 5);
    expect(comoNumero('10361.45')).toBeCloseTo(10361.45, 5);
  });

  it('sin coma y con varios puntos, todos son de miles', () => {
    expect(comoNumero('1.036.145')).toBe(1036145);
    expect(comoNumero('3.830.467')).toBe(3830467);
  });

  it('un entero sin separadores es un entero', () => {
    expect(comoNumero('186249')).toBe(186249);
    expect(comoNumero('6')).toBe(6);
  });

  it('el signo y los adornos no cambian el valor', () => {
    expect(comoNumero('$ 1.862,49')).toBeCloseTo(1862.49, 5);
    expect(comoNumero('-1.234,56')).toBeCloseTo(-1234.56, 5);
    expect(comoNumero('20.00%')).toBeCloseTo(20, 5);
  });

  it('lo que no es un número no devuelve un número', () => {
    expect(Number.isNaN(comoNumero('SALAMIN FINO'))).toBe(true);
    expect(Number.isNaN(comoNumero(''))).toBe(true);
    expect(Number.isNaN(comoNumero('—'))).toBe(true);
  });
});

describe('regresiones de escala: lo que nunca puede volver a pasar', () => {
  it('un valor y el mismo cien veces más grande NO son iguales', () => {
    /*
     * La regresión que da nombre a todo esto. Con la regla vieja —tirar todos
     * los puntos— «10361.45» daba 1.036.145 y la comparación no veía ninguna
     * diferencia contra «1.036.145». Un error de escala afirmado por el motor
     * habría pasado por acierto.
     */
    expect(comoNumero('10361.45')).not.toBeCloseTo(comoNumero('1.036.145'), 0);
    expect(comoNumero('1.862,49')).not.toBeCloseTo(comoNumero('186249'), 0);
    expect(comoNumero('27.937,35')).not.toBeCloseTo(comoNumero('2793735'), 0);
  });

  it('el mismo valor escrito de las dos maneras SÍ es igual', () => {
    /*
     * El otro lado, y el que costó un error anotado de más: el acta escribe
     * «4874.38» y el papel «4.874,380». Es el mismo número.
     */
    expect(comoNumero('4874.38')).toBeCloseTo(comoNumero('4.874,380'), 5);
    expect(comoNumero('1862.49')).toBeCloseTo(comoNumero('1.862,49'), 5);
    expect(comoNumero('612017.8')).toBeCloseTo(comoNumero('612.017,80'), 5);
    expect(comoNumero('35793.72')).toBeCloseTo(comoNumero('35.793,72'), 5);
  });

  it('las escalas intermedias tampoco se confunden', () => {
    for (const [escrito, valor] of [
      ['3.493,21', 3493.21],
      ['489.049,40', 489049.4],
      ['1.523.537,99', 1523537.99],
      ['1.866.334,05', 1866334.05],
    ] as const) {
      expect(comoNumero(escrito), escrito).toBeCloseTo(valor, 5);
      // Y ninguno coincide con su versión sin separadores.
      expect(comoNumero(escrito), escrito).not.toBeCloseTo(
        comoNumero(escrito.replace(/[.,]/g, '')),
        0,
      );
    }
  });

  it('el resultado dice con qué versión del comparador se midió', () => {
    expect(VERSION_DEL_COMPARADOR).toBe('v2');
  });
});
