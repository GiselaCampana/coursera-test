import { describe, it, expect } from 'vitest';
import { Decimal } from '@/lib/money';
import { evaluarCierre, intervaloDe, seTocan } from '@/lib/ocr/motor/precision';
import { bloquea, resumir, type Pendiente } from '@/lib/ocr/motor/pendientes';

/**
 * Dos reglas que deciden si una factura se acepta sola, probadas aparte de las
 * fotos.
 *
 * La primera es cómo se cierra un comprobante cuyo pie está impreso con menos
 * decimales que sus renglones. La segunda es qué le impide a una persona
 * aceptar la lectura y qué es apenas una anotación.
 *
 * Las dos existen porque la alternativa fácil era peor. Para la primera, bajar
 * el umbral de confianza hasta que la factura de Ezra pase: eso afloja el
 * control para todos los proveedores, incluido aquel en el que un centavo sí es
 * un renglón mal leído. Para la segunda, contar todo junto: «25 pendientes» no
 * dice si hay que apretar un botón o volver a tipear la factura.
 */

describe('el intervalo que representa un número impreso', () => {
  it('truncado, el valor real está por encima', () => {
    // «221.388,84» truncado a dos decimales puede venir de cualquier valor
    // entre 221.388,84 y 221.388,85.
    const intervalo = intervaloDe(new Decimal('221388.84'), 2, 'truncamiento');
    expect(intervalo.desde.toFixed(2)).toBe('221388.84');
    expect(intervalo.hasta.toFixed(2)).toBe('221388.85');
  });

  it('redondeado, el valor real está a los dos lados', () => {
    const intervalo = intervaloDe(new Decimal('100.00'), 2, 'redondeo');
    expect(intervalo.desde.toFixed(3)).toBe('99.995');
    expect(intervalo.hasta.toFixed(3)).toBe('100.005');
  });

  it('un importe negativo no rompe el truncamiento', () => {
    // Una nota de crédito trae importes negativos, y el truncamiento va hacia
    // el cero: el intervalo se da vuelta.
    const intervalo = intervaloDe(new Decimal('-10.50'), 2, 'truncamiento');
    expect(intervalo.desde.lt(intervalo.hasta)).toBe(true);
    expect(intervalo.hasta.toFixed(2)).toBe('-10.50');
  });

  it('los extremos de arriba están excluidos', () => {
    const a = { desde: new Decimal(0), hasta: new Decimal(1) };
    const b = { desde: new Decimal(1), hasta: new Decimal(2) };
    expect(seTocan(a, b)).toBe(false);
  });
});

describe('cierre compatible por precisión y truncamiento', () => {
  it('los seis renglones de tres decimales cierran contra un pie de dos', () => {
    /*
     * El caso exacto de la factura de Distribuidora Ezra. Los importes suman
     * 221.388,847 y el pie dice 221.388,84: el papel truncó, y no hay ningún
     * error que corregir.
     */
    const renglones = [
      '27081.371',
      '15295.149',
      '60726.232',
      '49525.474',
      '68537.481',
      '223.140',
    ].map((v) => new Decimal(v));

    const cierre = evaluarCierre(renglones, new Decimal('221388.84'));

    expect(cierre.compatible).toBe(true);
    expect(cierre.politica).toBe('truncamiento');
    expect(cierre.ajusteResidual.toNumber()).toBe(0);
    expect(cierre.decimalesDeOrigen).toBe(3);
    expect(cierre.decimalesDelPie).toBe(2);
    expect(cierre.diferencia.toFixed(3)).toBe('0.007');
  });

  it('la explicación dice el valor, la precisión, la regla y lo que queda', () => {
    // Un motor que decide solo tiene que poder explicarse, y acá lo que hay que
    // poder revisar es por qué un centavo no fue un problema.
    const cierre = evaluarCierre(
      [new Decimal('27081.371'), new Decimal('15295.149')],
      new Decimal('42376.52'),
    );
    expect(cierre.explicacion).toContain('3 decimales');
    expect(cierre.explicacion).toContain('2');
    expect(cierre.explicacion).toContain('truncamiento');
  });

  it('un centavo que la precisión NO explica tiene que fallar', () => {
    /*
     * El contraejemplo, y es el que hace que esto no sea una tolerancia
     * disfrazada: un único renglón impreso con dos decimales y un pie con dos
     * decimales que difiere en un centavo. Ninguna regla de redondeo lo
     * explica, así que no cierra.
     *
     * Es exactamente el mismo centavo que en Ezra sí se acepta. Lo que cambia
     * es con cuántos decimales está escrito cada número.
     */
    const cierre = evaluarCierre([new Decimal('71400.01')], new Decimal('71400.00'));

    expect(cierre.compatible).toBe(false);
    expect(cierre.politica).toBeNull();
    expect(cierre.explicacion).toContain('ni el redondeo ni el truncamiento explican');

    /*
     * El residuo da cero y no es una contradicción: los dos intervalos se tocan
     * justo en el borde —el del renglón empieza donde el del pie termina— y ese
     * borde está excluido. Es el límite exacto de lo que la precisión puede
     * explicar, y del lado de afuera.
     */
    expect(cierre.ajusteResidual.toNumber()).toBe(0);

    // Y el mismo centavo, con los renglones impresos a tres decimales, sí cierra.
    const conTresDecimales = evaluarCierre([new Decimal('71400.007')], new Decimal('71400.00'));
    expect(conTresDecimales.compatible).toBe(true);
  });

  it('la incertidumbre se acumula por renglón, no se aplica al total', () => {
    /*
     * Veinte renglones de dos decimales pueden desviarse más que dos, y un
     * comprobante de dos renglones no tiene por qué tolerar lo mismo que uno de
     * veinte. Una tolerancia fija los trata igual; sumar los intervalos, no.
     */
    const veinte = Array.from({ length: 20 }, () => new Decimal('100.00'));
    const dos = [new Decimal('1000.00'), new Decimal('1000.00')];

    // Con veinte renglones, diez centavos de más entran en el margen legítimo.
    expect(evaluarCierre(veinte, new Decimal('1999.90')).compatible).toBe(true);
    // Con dos, la misma diferencia no.
    expect(evaluarCierre(dos, new Decimal('1999.90')).compatible).toBe(false);
  });

  it('una diferencia grande no se explica por más renglones que haya', () => {
    const renglones = Array.from({ length: 10 }, () => new Decimal('100.00'));
    const cierre = evaluarCierre(renglones, new Decimal('900.00'));
    expect(cierre.compatible).toBe(false);
    expect(cierre.ajusteResidual.toNumber()).toBeGreaterThan(99);
  });
});

describe('pendiente bloqueante contra alternativa descartada', () => {
  const bloqueante: Pendiente = {
    categoria: 'BLOCKING_AMBIGUOUS_CELL',
    renglon: 3,
    campo: 'importe',
    columna: 'Importe',
    alternativas: [],
    elegido: null,
    motivo: 'dos lecturas y ninguna cierra',
  };

  const descartada: Pendiente = {
    categoria: 'WARNING_DISCARDED_ALTERNATIVE',
    renglon: 3,
    campo: 'importe',
    columna: 'Importe',
    alternativas: [],
    elegido: '2066.12',
    motivo: 'ganó la que hace cerrar el renglón',
  };

  it('las cinco categorías de bloqueo frenan y las tres advertencias no', () => {
    for (const categoria of [
      'BLOCKING_MISSING_CELL',
      'BLOCKING_AMBIGUOUS_CELL',
      'BLOCKING_UNKNOWN_COLUMN',
      'BLOCKING_UNIT',
      'BLOCKING_PRODUCT',
    ] as const) {
      expect(bloquea(categoria), categoria).toBe(true);
    }
    for (const categoria of [
      'WARNING_DISCARDED_ALTERNATIVE',
      'WARNING_OCR_NOISE',
      'WARNING_OPTIONAL_FIELD',
    ] as const) {
      expect(bloquea(categoria), categoria).toBe(false);
    }
  });

  it('una alternativa descartada no cuenta como corrección manual', () => {
    /*
     * Es la diferencia entre una revisión de un minuto y volver a cargar la
     * factura: cincuenta lecturas que perdieron contra otra no son cincuenta
     * cosas para corregir.
     */
    const resumen = resumir([descartada, descartada, descartada, bloqueante]);
    expect(resumen.correccionesManuales).toBe(1);
    expect(resumen.advertenciasNoBloqueantes).toBe(3);
    expect(resumen.ambiguedadesBloqueantes).toBe(1);
  });

  it('el resumen separa cada clase de decisión, no las suma en un número', () => {
    const resumen = resumir([
      { ...bloqueante, categoria: 'BLOCKING_MISSING_CELL' },
      { ...bloqueante, categoria: 'BLOCKING_UNKNOWN_COLUMN' },
      { ...bloqueante, categoria: 'BLOCKING_UNIT' },
      { ...bloqueante, categoria: 'BLOCKING_PRODUCT' },
      { ...descartada, categoria: 'WARNING_OCR_NOISE' },
    ]);
    expect(resumen.celdasObligatoriasFaltantes).toBe(1);
    expect(resumen.columnasSinReconocer).toBe(1);
    expect(resumen.unidadesPendientes).toBe(1);
    expect(resumen.asociacionesDeProductoPendientes).toBe(1);
    expect(resumen.advertenciasNoBloqueantes).toBe(1);
    expect(resumen.correccionesManuales).toBe(4);
  });
});
