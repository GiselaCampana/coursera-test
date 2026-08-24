import { describe, it, expect } from 'vitest';
import { costItems, prorate, summarizeItems, type RawItem } from '@/lib/domain/costing';
import { Decimal } from '@/lib/money';
import { LOS_CALVOS_ITEMS, LOS_CALVOS_PRINTED } from '../fixtures/los-calvos';

const totals = {
  netTotal: LOS_CALVOS_PRINTED.netTotal,
  ivaTotal: LOS_CALVOS_PRINTED.ivaTotal,
  perceptionsTotal: LOS_CALVOS_PRINTED.perceptionsTotal,
};

describe('prorrateo', () => {
  it('reparte proporcionalmente y ajusta el residuo en el último elemento', () => {
    const parts = prorate([new Decimal(1), new Decimal(1), new Decimal(1)], '100');
    expect(parts.map((p) => p.toFixed(2))).toEqual(['33.33', '33.33', '33.34']);
    const sum = parts.reduce((a, b) => a.plus(b), new Decimal(0));
    expect(sum.toFixed(2)).toBe('100.00');
  });

  it('no pierde ni inventa centavos con pesos desparejos', () => {
    const weights = ['222048.30', '41684.54', '133635.74'].map((w) => new Decimal(w));
    const parts = prorate(weights, '12345.67');
    const sum = parts.reduce((a, b) => a.plus(b), new Decimal(0));
    expect(sum.toFixed(2)).toBe('12345.67');
  });
});

describe('cálculo de los artículos de Los Calvos', () => {
  const items = costItems(LOS_CALVOS_ITEMS, totals);
  const sums = summarizeItems(items);

  it('devuelve los nueve artículos', () => {
    expect(items).toHaveLength(9);
  });

  it('los kilos suman 153,70', () => {
    expect(sums.totalQuantityKg.toFixed(2)).toBe('153.70');
  });

  it('el subtotal bruto suma $2.084.594,70', () => {
    expect(sums.grossSubtotal.toFixed(2)).toBe('2084594.70');
  });

  it('el descuento del 14 % suma $291.843,26', () => {
    expect(sums.discountAmount.toFixed(2)).toBe('291843.26');
  });

  it('los netos suman $1.792.751,44', () => {
    expect(sums.netAmount.toFixed(2)).toBe('1792751.44');
  });

  it('el IVA prorrateado suma exactamente el IVA de la factura', () => {
    expect(sums.ivaAmount.toFixed(2)).toBe('376477.81');
  });

  it('el IIBB prorrateado suma exactamente la percepción de la factura', () => {
    expect(sums.perceptionAmount.toFixed(2)).toBe('26891.27');
  });

  it('los costos totales suman el total de la factura', () => {
    expect(sums.totalCost.toFixed(2)).toBe('2196120.52');
  });

  it('el primer renglón queda bien calculado de punta a punta', () => {
    const longaniza = items[0];
    expect(longaniza.grossSubtotal.toFixed(2)).toBe('258195.70');
    expect(longaniza.discountAmount.toFixed(2)).toBe('36147.40');
    expect(longaniza.netAmount.toFixed(2)).toBe('222048.30');
    // Costo unitario = costo total / kilos, con IVA y percepción incluidos.
    expect(longaniza.unitCost.gt(longaniza.unitNetPrice)).toBe(true);
    expect(
      longaniza.totalCost.div(longaniza.quantity).toDecimalPlaces(2).toFixed(2),
    ).toBe(longaniza.unitCost.toFixed(2));
  });

  it('el ajuste de redondeo cae en el último artículo', () => {
    // Sin el ajuste, la suma de los prorrateos redondeados no daría exacto.
    const naive = items
      .slice(0, -1)
      .reduce((acc, i) => acc.plus(i.ivaAmount), new Decimal(0));
    const last = items[items.length - 1];
    expect(naive.plus(last.ivaAmount).toFixed(2)).toBe('376477.81');
  });
});

describe('kilos, piezas y peso promedio', () => {
  it('calcula el peso promedio por pieza cuando hay bultos', () => {
    const raw: RawItem[] = [
      {
        lineNumber: 1,
        description: 'Horma de queso',
        quantity: '12,500',
        unit: 'KG',
        pieceCount: 4,
        unitNetPrice: '9000',
        ivaRate: '0.21',
      },
    ];
    const [item] = costItems(raw, { netTotal: '112500', ivaTotal: '23625', perceptionsTotal: '0' });
    expect(item.totalWeightKg?.toFixed(3)).toBe('12.500');
    expect(item.avgPieceWeightKg?.toFixed(4)).toBe('3.1250');
  });

  it('separa kilos de unidades en los totales', () => {
    const raw: RawItem[] = [
      { lineNumber: 1, description: 'Jamón', quantity: '10', unit: 'KG', unitNetPrice: '100', ivaRate: '0.21' },
      { lineNumber: 2, description: 'Lata de paté', quantity: '24', unit: 'UNIT', unitNetPrice: '50', ivaRate: '0.21' },
    ];
    const sums = summarizeItems(costItems(raw, { netTotal: '2200', ivaTotal: '462', perceptionsTotal: '0' }));
    expect(sums.totalQuantityKg.toFixed(2)).toBe('10.00');
    expect(sums.totalUnits.toFixed(2)).toBe('24.00');
  });
});

describe('el pie impreso manda sobre el costo final', () => {
  /** Dos renglones de $1.000 cada uno, con IVA del 21 % y $50 de percepción. */
  const dosRenglones: RawItem[] = [
    {
      lineNumber: 1,
      description: 'Primero',
      quantity: '10',
      unit: 'KG',
      unitNetPrice: '100',
      grossSubtotal: '1000',
      ivaRate: '0.21',
    },
    {
      lineNumber: 2,
      description: 'Segundo',
      quantity: '10',
      unit: 'KG',
      unitNetPrice: '100',
      grossSubtotal: '1000',
      ivaRate: '0.21',
    },
  ];

  const sumaDeCostos = (items: ReturnType<typeof costItems>) =>
    items.reduce((acc, i) => acc.plus(i.totalCost), new Decimal(0));

  it('los costos finales caen exactamente sobre el total impreso', () => {
    const items = costItems(dosRenglones, {
      netTotal: '2000',
      ivaTotal: '420',
      perceptionsTotal: '50',
    });
    expect(sumaDeCostos(items).toFixed(2)).toBe('2470.00');
  });

  it('absorbe los centavos de redondeo del proveedor sin tocar el neto del renglón', () => {
    /*
     * El papel dice $2.000,05 de neto y los renglones suman $2.000: son los
     * cinco centavos que el proveedor redondea renglón por renglón. El costo
     * final se arma sobre el neto impreso —es lo que hay que pagar— pero el
     * neto de cada renglón queda como está, que es contra lo que se controla.
     */
    const items = costItems(dosRenglones, {
      netTotal: '2000.05',
      ivaTotal: '420.01',
      perceptionsTotal: '50',
    });
    expect(sumaDeCostos(items).toFixed(2)).toBe('2470.06');
    expect(items.map((i) => i.netAmount.toFixed(2))).toEqual(['1000.00', '1000.00']);
    expect(summarizeItems(items).netAmount.toFixed(2)).toBe('2000.00');
    expect(summarizeItems(items).netRounding.toFixed(2)).toBe('0.05');
  });

  it('con una diferencia de un peso o más no estira nada', () => {
    // Un peso ya no es redondeo: falta un renglón o hay uno mal leído. El costo
    // se arma con lo que dicen los renglones y la diferencia queda a la vista
    // para que los autocontroles la marquen.
    const items = costItems(dosRenglones, {
      netTotal: '2001',
      ivaTotal: '420.21',
      perceptionsTotal: '50',
    });
    expect(sumaDeCostos(items).toFixed(2)).toBe('2470.21');
    expect(summarizeItems(items).netRounding.toFixed(2)).toBe('0.00');
  });
});
