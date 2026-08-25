import { describe, it, expect } from 'vitest';
import { Decimal } from '@/lib/money';
import { analizadorErrecalde } from '@/lib/ocr/parsers/errecalde';
import { elegirAnalizador } from '@/lib/ocr/parsers';
import { toRawItems, toPrintedSummary } from '@/lib/ocr/normalize';
import { costItems, summarizeItems, consistentPerceptionLines } from '@/lib/domain/costing';
import { SAFARI_TEXTOS, SAFARI_ESPERADO } from '../fixtures/errecalde-safari';

/**
 * La prueba de aceptación sobre la salida real de Safari.
 *
 * `errecalde.test.ts` corre sobre el texto que la misma foto produce en
 * Chromium. Éste corre sobre el que produce el teléfono, que es distinto y
 * rompe cosas que el otro no ejercita: el pie repartido entre dos lecturas, dos
 * renglones que el recorte cortó antes del importe, tres renglones con los
 * separadores comidos y códigos que cambian de dígito entre pasadas.
 *
 * Lo que se exige es lo que dice el papel.
 */

const analisis = analizadorErrecalde.analizar(SAFARI_TEXTOS);
const printed = toPrintedSummary(analisis.summary);
const costeados = costItems(toRawItems(analisis.items), {
  netTotal: printed.netTotal ?? '0',
  ivaTotal: printed.ivaTotal ?? '0',
  perceptionsTotal: printed.perceptionsTotal ?? '0',
  perceptionLines: consistentPerceptionLines(
    analisis.summary?.perceptionLines,
    printed.perceptionsTotal ?? '0',
  ),
});
const resumen = summarizeItems(costeados);

describe('reconocimiento', () => {
  it('elige el analizador de Errecalde sobre el texto del teléfono', () => {
    expect(elegirAnalizador(SAFARI_TEXTOS).analizador.codigo).toBe('errecalde');
  });
});

describe('los 23 renglones', () => {
  it('interpreta los 23, ni uno más ni uno menos', () => {
    expect(analisis.items).toHaveLength(SAFARI_ESPERADO.renglones);
  });

  it('no funde PLANCHA BARRAZA X5KG con PLANCHA BARRAZA X10KG', () => {
    /*
     * Se llaman casi igual y sólo los distingue la medida. Encima el recorte
     * cortó la descripción del de 10 kg en "PLANCHA BARRAZA", que así es
     * principio de los dos: fundirlos era elegir a cara o cruz, y costaba
     * $123.154,88.
     */
    const planchas = analisis.items.filter((i) => /PLANCHA/i.test(i.description));
    expect(planchas).toHaveLength(2);
    expect(planchas.map((p) => new Decimal(p.grossSubtotal ?? '0').toFixed(2)).sort()).toEqual([
      '123154.88',
      '243385.16',
    ]);
  });

  it('funde las dos lecturas de SARDO BLOQUE, que quedaron con distinto nombre', () => {
    // "SARDO BLOQUE MELINCUE" y "SARDO MELINCUE": la franja se llevó BLOQUE a la
    // línea siguiente. Comparadas letra a letra no se parecen; comparten todas
    // sus palabras, y lo que falta no es una medida.
    const sardos = analisis.items.filter((i) => /SARDO/i.test(i.description));
    expect(sardos).toHaveLength(2);
    expect(sardos.some((s) => /ALFONSO/i.test(s.description))).toBe(true);
  });

  it('recupera los dos renglones que el recorte cortó antes del importe', () => {
    // PERNIL TERMOLI y PLANCHA BARRAZA X10KG salieron de la tabla sin subtotal.
    // Son $844.746 de una factura de $3.830.467.
    const pernil = analisis.items.find((i) => /PERNIL/i.test(i.description));
    expect(pernil).toBeDefined();
    expect(new Decimal(pernil!.quantity!).toFixed(2)).toBe('156.30');
    expect(new Decimal(pernil!.unitNetPrice!).toFixed(2)).toBe('3847.48');
  });

  it('resuelve los tres renglones con los separadores comidos', () => {
    const porNombre = (texto: RegExp) => analisis.items.find((i) => texto.test(i.description))!;

    const roquefort = porNombre(/ROQUEFORT AZUL/i);
    expect(new Decimal(roquefort.quantity!).toFixed(2)).toBe('19.21');
    expect(new Decimal(roquefort.unitNetPrice!).toFixed(2)).toBe('10452.08');
    expect(new Decimal(roquefort.grossSubtotal!).toFixed(2)).toBe('200784.37');

    const ricota = porNombre(/RICOTA/i);
    expect(new Decimal(ricota.grossSubtotal!).toFixed(2)).toBe('45655.74');

    const sardo = porNombre(/SARDO (BLOQUE )?MELINCUE/i);
    expect(new Decimal(sardo.quantity!).toFixed(2)).toBe('4.75');
    expect(new Decimal(sardo.grossSubtotal!).toFixed(2)).toBe('63152.43');
  });
});

describe('el pie, repartido entre el recorte y la página completa', () => {
  it('arma los cinco importes del papel', () => {
    expect(analisis.summary?.netTotal).toBe(SAFARI_ESPERADO.netTotal);
    expect(analisis.summary?.ivaTotal).toBe(SAFARI_ESPERADO.ivaTotal);
    expect(analisis.summary?.perceptionLines?.map((p) => p.amount)).toEqual([
      SAFARI_ESPERADO.percepcionIva,
      SAFARI_ESPERADO.percepcionIibb,
    ]);
    expect(analisis.summary?.total).toBe(SAFARI_ESPERADO.total);
  });

  it('no se queda con el IVA cortado del recorte', () => {
    // El recorte trajo $804.398,1, sin el último dígito. El entero está en la
    // página completa, y es el único que hace cerrar el pie.
    expect(analisis.summary?.ivaTotal).not.toBe('804398.1');
  });
});

describe('los cálculos posteriores', () => {
  it('separa 480,34 kg entre 16 artículos y 71 unidades entre 7', () => {
    expect(resumen.totalQuantityKg.toFixed(2)).toBe(
      new Decimal(SAFARI_ESPERADO.kilos).toFixed(2),
    );
    expect(resumen.kgItemCount).toBe(SAFARI_ESPERADO.articulosPorKilo);
    expect(resumen.totalUnits.toFixed(2)).toBe(new Decimal(SAFARI_ESPERADO.unidades).toFixed(2));
    expect(resumen.unitItemCount).toBe(SAFARI_ESPERADO.articulosPorUnidad);
  });

  it('el IVA y las dos percepciones dan lo impreso', () => {
    expect(resumen.ivaAmount.toFixed(2)).toBe(new Decimal(SAFARI_ESPERADO.ivaTotal).toFixed(2));
    expect(resumen.perceptionsByLabel.map((p) => p.amount.toFixed(2))).toEqual([
      new Decimal(SAFARI_ESPERADO.percepcionIva).toFixed(2),
      new Decimal(SAFARI_ESPERADO.percepcionIibb).toFixed(2),
    ]);
  });

  it('el costo total cae exactamente en $4.816.812,73', () => {
    expect(resumen.totalCost.toFixed(2)).toBe(new Decimal(SAFARI_ESPERADO.total).toFixed(2));
    const suma = costeados.reduce((acc, i) => acc.plus(i.totalCost), new Decimal(0));
    expect(suma.toFixed(2)).toBe(new Decimal(SAFARI_ESPERADO.total).toFixed(2));
  });

  it('los 33 centavos que separan la suma del neto impreso quedan a la vista', () => {
    /*
     * PERNIL TERMOLI es el único renglón cuyo importe no entró en ningún
     * recorte: se calculó como 156,3 × 3.847,48 = $601.361,12, y el papel dice
     * $601.361,45. Treinta y tres centavos del redondeo del propio proveedor.
     *
     * No se tapan. La suma de los renglones queda en $3.830.467,04 contra el
     * neto impreso de $3.830.467,37, y esa diferencia aparece en el resumen como
     * "Redondeo contra el neto impreso". El costo final igual cae exacto en el
     * total del papel, porque se reparte sobre los importes del pie.
     */
    expect(resumen.netAmount.toFixed(2)).toBe('3830467.04');
    expect(resumen.netRounding.toFixed(2)).toBe('0.33');
    expect(new Decimal(SAFARI_ESPERADO.netTotal).minus(resumen.netAmount).toFixed(2)).toBe('0.33');
  });
});
