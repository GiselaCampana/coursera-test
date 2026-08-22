import { describe, it, expect } from 'vitest';
import {
  formatARS,
  formatRate,
  parseArNumber,
  parseCanonicalNumber,
  parseRate,
  roundingTolerance,
} from '@/lib/money';

const n = (raw: unknown) => parseArNumber(raw)?.toString() ?? null;

describe('separadores argentinos', () => {
  it('interpreta igual las cuatro formas de escribir el total de la factura', () => {
    for (const variant of ['2.196.120,52', '2 196 120,52', '$ 2.196.120,52', '2196120,52']) {
      expect(n(variant), variant).toBe('2196120.52');
    }
  });

  it('resuelve espacios que mete el OCR dentro del número', () => {
    expect(n('1 792 751,44')).toBe('1792751.44');
    expect(n('2. 084. 594,70')).toBe('2084594.7');
    expect(n('$  26.891, 27')).toBe('26891.27');
  });

  it('trata el punto que agrupa de a tres como separador de miles', () => {
    expect(n('16.037')).toBe('16037');
    expect(n('2.084.594,70')).toBe('2084594.7');
  });

  it('trata el punto con otra cantidad de decimales como coma decimal', () => {
    expect(n('153.70')).toBe('153.7');
    expect(n('1.5')).toBe('1.5');
    expect(n('1234.5678')).toBe('1234.5678');
  });

  it('acepta el formato inglés con comas de miles', () => {
    expect(n('1,234,567.89')).toBe('1234567.89');
  });

  it('no confunde una fracción con un grupo de miles', () => {
    // "0.015" es una fracción: el grupo de miles nunca empieza en cero.
    expect(n('0.015')).toBe('0.015');
    // "1234.567" tampoco agrupa miles: el primer grupo sería de cuatro dígitos.
    expect(n('1234.567')).toBe('1234.567');
    // En cambio "16.037" sí es la forma argentina de escribir dieciséis mil.
    expect(n('16.037')).toBe('16037');
  });

  it('lee los números canónicos del OCR con punto decimal', () => {
    // En el JSON del lector "153.700" son 153,7 kg, no ciento cincuenta y tres mil.
    expect(parseCanonicalNumber('153.700')?.toString()).toBe('153.7');
    expect(parseCanonicalNumber('1792751.44')?.toString()).toBe('1792751.44');
    // Si el modelo desobedece el formato, se cae a las reglas argentinas.
    expect(parseCanonicalNumber('2.196.120,52')?.toString()).toBe('2196120.52');
  });

  it('resuelve negativos y paréntesis contables', () => {
    expect(n('-291.843,26')).toBe('-291843.26');
    expect(n('(291.843,26)')).toBe('-291843.26');
  });

  it('devuelve null cuando no hay número, en vez de inventar un cero', () => {
    expect(n('')).toBeNull();
    expect(n('   ')).toBeNull();
    expect(n('S/D')).toBeNull();
    expect(n(null)).toBeNull();
    expect(n(undefined)).toBeNull();
    expect(n('---')).toBeNull();
  });
});

describe('tasas contra importes', () => {
  it('distingue una tasa del 1,5 % de un importe de $1,50', () => {
    expect(parseRate('1,5 %')?.toString()).toBe('0.015');
    expect(parseRate('1,5')?.toString()).toBe('0.015');
    expect(parseArNumber('$ 1,50')?.toString()).toBe('1.5');
  });

  it('acepta la tasa escrita como porcentaje o como fracción', () => {
    expect(parseRate('21%')?.toString()).toBe('0.21');
    expect(parseRate('21')?.toString()).toBe('0.21');
    expect(parseRate('0,21')?.toString()).toBe('0.21');
    expect(parseRate(0.21)?.toString()).toBe('0.21');
  });

  it('interpreta 14 % de bonificación', () => {
    expect(parseRate('14,00')?.toString()).toBe('0.14');
  });
});

describe('formato es-AR', () => {
  it('escribe los importes en pesos argentinos', () => {
    expect(formatARS('2196120.52').replace(/ /g, ' ')).toBe('$ 2.196.120,52');
  });

  it('escribe las tasas como porcentaje', () => {
    expect(formatRate('0.015')).toBe('1,5 %');
    expect(formatRate('0.21')).toBe('21 %');
  });
});

describe('tolerancia de redondeo', () => {
  it('usa el mayor entre $1 y el 0,5 % del importe de referencia', () => {
    expect(roundingTolerance(100).toString()).toBe('1');
    expect(roundingTolerance(1792751.44).toString()).toBe('8963.7572');
  });
});
