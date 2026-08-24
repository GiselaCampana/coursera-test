import { describe, it, expect } from 'vitest';
import { Decimal } from '@/lib/money';
import { analizadorErrecalde } from '@/lib/ocr/parsers/errecalde';
import {
  consistentPerceptionLines,
  costItems,
  summarizeItems,
  type CostedItem,
} from '@/lib/domain/costing';
import { validateDocument } from '@/lib/domain/validation';
import { toPrintedSummary, toRawItems } from '@/lib/ocr/normalize';
import { ERRECALDE_TEXTOS, ERRECALDE_ARTICULOS_IMPRESOS } from '../fixtures/errecalde-ocr';

/**
 * Prueba de regresión de los cálculos posteriores al OCR.
 *
 * `errecalde.test.ts` controla que el analizador lea bien el papel. Ésta
 * controla lo que pasa después: el costeo, el prorrateo de IVA y percepciones,
 * y las sumas del resumen que ve el usuario en la pantalla de revisión.
 *
 * Son dos etapas distintas y fallan por motivos distintos. La factura puede
 * leerse perfecta y el resumen mostrar igual 550,59 kg —si alguien vuelve a
 * sumar las unidades a los kilos— o un "costo total" que en realidad es el
 * neto. Ninguna prueba del analizador atajaría eso.
 *
 * Los números que se exigen acá son los que están impresos en la foto real:
 * 23 renglones, 480,34 kg entre 16 artículos por peso, 71 unidades entre los
 * otros 7, neto $3.830.467,37 y costo total $4.816.812,73.
 */

const IMPRESO = {
  renglones: 23,
  articulosPorKilo: 16,
  kilos: '480.34',
  articulosPorUnidad: 7,
  unidades: '71',
  brutoSubtotal: '3830467.37',
  descuentos: '0',
  neto: '3830467.37',
  iva: '804398.16',
  percepcionIva: '114914.02',
  percepcionIibb: '67033.18',
  percepciones: '181947.20',
  total: '4816812.73',
} as const;

/** Recorre el camino completo: texto del lector → artículos costeados. */
function costear(): { items: CostedItem[]; printed: ReturnType<typeof toPrintedSummary> } {
  const analisis = analizadorErrecalde.analizar(ERRECALDE_TEXTOS);
  const printed = toPrintedSummary(analisis.summary);
  const items = costItems(toRawItems(analisis.items), {
    netTotal: printed.netTotal ?? '0',
    ivaTotal: printed.ivaTotal ?? '0',
    perceptionsTotal: printed.perceptionsTotal ?? '0',
    perceptionLines: consistentPerceptionLines(
      analisis.summary?.perceptionLines,
      printed.perceptionsTotal ?? '0',
    ),
  });
  return { items, printed };
}

const { items, printed } = costear();
const resumen = summarizeItems(items);

describe('cantidades: los kilos y las unidades no se mezclan', () => {
  it('cuenta los 23 renglones', () => {
    expect(resumen.count).toBe(IMPRESO.renglones);
  });

  it('suma 480,34 kg entre los 16 artículos que se venden por peso', () => {
    // Si esto da 550,59 es que las unidades se sumaron a los kilos: 479,59 kg
    // más 71 unidades. Son magnitudes distintas y no se suman nunca.
    expect(resumen.kgItemCount).toBe(IMPRESO.articulosPorKilo);
    expect(resumen.totalQuantityKg.toFixed(2)).toBe(new Decimal(IMPRESO.kilos).toFixed(2));
  });

  it('suma 71 unidades entre los 7 artículos que se venden por unidad', () => {
    expect(resumen.unitItemCount).toBe(IMPRESO.articulosPorUnidad);
    expect(resumen.totalUnits.toFixed(2)).toBe(new Decimal(IMPRESO.unidades).toFixed(2));
  });

  it('los kilos salen de la columna Cantidad, no del número de piezas', () => {
    /*
     * El renglón de PERNIL TERMOLI viene con 40 piezas y 156,3 kg. Multiplicar
     * una cosa por la otra da 6.252 kg y un importe de 24 millones: es
     * exactamente la clase de error que buscamos. Las piezas se guardan como
     * dato del renglón, pero no entran en ninguna cuenta.
     */
    const pernil = items.find((i) => /PERNIL/i.test(i.description));
    expect(pernil).toBeDefined();
    expect(pernil!.quantity.toFixed(2)).toBe('156.30');
    expect(pernil!.pieceCount).toBe(40);
    expect(pernil!.netAmount.toFixed(2)).toBe('601361.45');
  });
});

describe('importes de cada renglón', () => {
  it('el neto de un renglón por kilo es kilos × precio por kilo', () => {
    for (const item of items.filter((i) => i.unit === 'KG')) {
      const esperado = item.quantity.times(item.unitNetPrice);
      // Hasta un peso de diferencia: el papel redondea cada renglón a centavos.
      expect(
        item.grossSubtotal.minus(esperado).abs().lte('1'),
        `${item.description}: ${item.grossSubtotal.toFixed(2)} contra ${esperado.toFixed(2)}`,
      ).toBe(true);
    }
  });

  it('el importe de un renglón por unidad es unidades × precio unitario', () => {
    for (const item of items.filter((i) => i.unit === 'UNIT')) {
      const esperado = item.quantity.times(item.unitNetPrice);
      expect(
        item.grossSubtotal.minus(esperado).abs().lte('1'),
        `${item.description}: ${item.grossSubtotal.toFixed(2)} contra ${esperado.toFixed(2)}`,
      ).toBe(true);
    }
  });

  it('respeta el importe impreso de los 23 renglones', () => {
    const porDescripcion = (texto: string) =>
      texto
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');

    for (const impreso of ERRECALDE_ARTICULOS_IMPRESOS) {
      const buscado = porDescripcion(impreso.descripcion);
      const item = items.find((i) => {
        const leida = porDescripcion(i.description);
        return buscado.includes(leida) || leida.includes(buscado);
      });
      expect(item, `falta el renglón ${impreso.descripcion}`).toBeDefined();
      expect(item!.netAmount.toFixed(2), impreso.descripcion).toBe(
        new Decimal(impreso.subtotal).toFixed(2),
      );
    }
  });
});

describe('costo final de cada renglón', () => {
  it('es neto + IVA + percepción de IVA + percepción de IIBB', () => {
    for (const item of items) {
      const percepciones = item.perceptionBreakdown.reduce<Decimal>(
        (acc, p) => acc.plus(p.amount),
        new Decimal(0),
      );
      const esperado = item.netAmount.plus(item.ivaAmount).plus(percepciones);
      expect(item.totalCost.toFixed(2), item.description).toBe(esperado.toFixed(2));
      // Y el costo final es siempre mayor que el neto: los impuestos son parte
      // de lo que la sucursal termina pagando.
      expect(item.totalCost.gt(item.netAmount), item.description).toBe(true);
    }
  });

  it('abre las dos percepciones impresas en cada renglón', () => {
    for (const item of items) {
      expect(item.perceptionBreakdown.map((p) => p.label)).toEqual([
        'Percepción IVA RG 5329',
        'Percepción IIBB Buenos Aires',
      ]);
    }
  });

  it('el costo unitario es el costo final dividido por la cantidad del renglón', () => {
    for (const item of items) {
      const esperado = item.totalCost.div(item.quantity);
      expect(item.unitCost.minus(esperado).abs().lte('0.01'), item.description).toBe(true);
    }
  });
});

describe('el resumen que ve el usuario', () => {
  it('el subtotal bruto y el neto dan $3.830.467,37', () => {
    expect(resumen.grossSubtotal.toFixed(2)).toBe(new Decimal(IMPRESO.brutoSubtotal).toFixed(2));
    expect(resumen.discountAmount.toFixed(2)).toBe(new Decimal(IMPRESO.descuentos).toFixed(2));
    expect(resumen.netAmount.toFixed(2)).toBe(new Decimal(IMPRESO.neto).toFixed(2));
  });

  it('el IVA repartido da $804.398,16', () => {
    expect(resumen.ivaAmount.toFixed(2)).toBe(new Decimal(IMPRESO.iva).toFixed(2));
  });

  it('cada percepción repartida da exactamente su importe impreso', () => {
    // No alcanza con que cierre el conjunto: el papel imprime dos números
    // distintos y cada uno se reparte contra el suyo.
    expect(resumen.perceptionsByLabel.map((p) => [p.label, p.amount.toFixed(2)])).toEqual([
      ['Percepción IVA RG 5329', new Decimal(IMPRESO.percepcionIva).toFixed(2)],
      ['Percepción IIBB Buenos Aires', new Decimal(IMPRESO.percepcionIibb).toFixed(2)],
    ]);
    expect(resumen.perceptionAmount.toFixed(2)).toBe(new Decimal(IMPRESO.percepciones).toFixed(2));
  });

  it('el costo total es $4.816.812,73 y no el neto', () => {
    expect(resumen.totalCost.toFixed(2)).toBe(new Decimal(IMPRESO.total).toFixed(2));
    expect(resumen.totalCost.gt(resumen.netAmount)).toBe(true);
  });

  it('el costo total es la suma exacta de los costos finales de los 23 renglones', () => {
    // Al centavo: el residuo del prorrateo se asigna de forma determinista, así
    // que repartir y volver a sumar tiene que caer justo en el total impreso.
    const suma = items.reduce<Decimal>((acc, i) => acc.plus(i.totalCost), new Decimal(0));
    expect(suma.toFixed(2)).toBe(new Decimal(IMPRESO.total).toFixed(2));
  });

  it('neto + IVA + percepciones da el costo total', () => {
    const suma = resumen.netAmount.plus(resumen.ivaAmount).plus(resumen.perceptionAmount);
    expect(suma.toFixed(2)).toBe(new Decimal(IMPRESO.total).toFixed(2));
  });
});

describe('los autocontroles con los importes calculados', () => {
  const informe = validateDocument({
    items,
    printed,
    supplierRules: { ivaRate: '0.21' },
    attempts: 1,
    filasEnLaImagen: 23,
  });

  it('no encuentra ninguna diferencia contra el pie impreso', () => {
    const errores = informe.checks.filter((c) => c.severity === 'ERROR');
    expect(errores.map((e) => `${e.code}: ${e.message}`)).toEqual([]);
    expect(informe.canSave).toBe(true);
  });

  it('informa los kilos, las unidades y las percepciones por separado', () => {
    // El informe publica las cantidades con tres decimales, porque las balanzas
    // pesan al gramo; lo que se compara es el número, no cómo se escribe.
    expect(new Decimal(informe.computed.totalQuantityKg).toFixed(2)).toBe(
      new Decimal(IMPRESO.kilos).toFixed(2),
    );
    expect(new Decimal(informe.computed.totalUnits).toFixed(2)).toBe(
      new Decimal(IMPRESO.unidades).toFixed(2),
    );
    expect(informe.computed.kgItemCount).toBe(IMPRESO.articulosPorKilo);
    expect(informe.computed.unitItemCount).toBe(IMPRESO.articulosPorUnidad);
    expect(informe.computed.perceptionsByLabel).toEqual([
      { label: 'Percepción IVA RG 5329', amount: new Decimal(IMPRESO.percepcionIva).toFixed(2) },
      { label: 'Percepción IIBB Buenos Aires', amount: new Decimal(IMPRESO.percepcionIibb).toFixed(2) },
    ]);
    expect(informe.computed.netAmount).toBe(new Decimal(IMPRESO.neto).toFixed(2));
    expect(informe.computed.totalCost).toBe(new Decimal(IMPRESO.total).toFixed(2));
  });
});
