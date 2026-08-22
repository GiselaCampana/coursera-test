import { describe, it, expect } from 'vitest';
import { costItems, type RawItem } from '@/lib/domain/costing';
import { validateDocument, type PrintedSummary } from '@/lib/domain/validation';
import {
  LOS_CALVOS_ITEMS,
  LOS_CALVOS_PRINTED,
  LOS_CALVOS_TAX_RULES,
} from '../fixtures/los-calvos';

const totalsOf = (p: PrintedSummary) => ({
  netTotal: p.netTotal,
  ivaTotal: p.ivaTotal,
  perceptionsTotal: p.perceptionsTotal,
});

const run = (items: RawItem[], printed: PrintedSummary, attempts = 1) =>
  validateDocument({
    items: costItems(items, totalsOf(printed)),
    printed,
    supplierRules: LOS_CALVOS_TAX_RULES,
    attempts,
  });

const check = (report: ReturnType<typeof run>, code: string) => {
  const found = report.checks.find((c) => c.code === code);
  if (!found) throw new Error(`No existe el control ${code}`);
  return found;
};

describe('caso de aceptación: factura Los Calvos completa', () => {
  const report = run(LOS_CALVOS_ITEMS, LOS_CALVOS_PRINTED);

  it('queda en verde', () => {
    expect(report.state).toBe('OK');
    expect(report.errorCount).toBe(0);
  });

  it('permite guardar', () => {
    expect(report.canSave).toBe(true);
  });

  it('da por controlados los renglones, el neto, los impuestos y el total', () => {
    for (const code of ['ART_ARITMETICA', 'ART_CANTIDAD', 'ART_NETO', 'PESO_NETO', 'IVA_TASA', 'PERCEPCION_TASA', 'TOTAL_GENERAL']) {
      expect(check(report, code).severity, code).toBe('OK');
    }
  });

  it('tolera el centavo de diferencia entre el IVA impreso y el IVA sobre el neto total', () => {
    // El proveedor redondea el IVA renglón por renglón: 376.477,81 contra
    // 376.477,80 de calcular 21 % sobre el neto. Es un centavo, no un error.
    const iva = check(report, 'IVA_TASA');
    expect(iva.severity).toBe('OK');
    expect(iva.difference).toContain('0,01');
  });
});

describe('caso negativo obligatorio: neto de artículos incompleto', () => {
  // El lector lee mal el precio del renglón 7 ($11.053,94 en lugar de
  // $14.828), así que los renglones suman ~$1.670.389 de neto en lugar de
  // $1.792.751,44. Cada renglón cierra por sí solo y los impuestos calculados
  // sobre esa base darían bien en porcentaje: la factura sigue mal leída.
  const shortItems: RawItem[] = LOS_CALVOS_ITEMS.map((item) =>
    item.lineNumber === 7 ? { ...item, unitNetPrice: '11053.94' } : item,
  );

  const report = run(shortItems, LOS_CALVOS_PRINTED);

  it('detecta la diferencia de neto de aproximadamente $122.362,44', () => {
    const neto = check(report, 'ART_NETO');
    expect(neto.severity).toBe('ERROR');
    const diff = Math.abs(Number(report.computed.netAmount) - 1792751.44);
    expect(diff).toBeGreaterThan(122361);
    expect(diff).toBeLessThan(122364);
  });

  it('cada renglón cierra por separado: el problema es la base, no la aritmética', () => {
    expect(check(report, 'ART_ARITMETICA').severity).toBe('OK');
    expect(check(report, 'PESO_NETO').severity).toBe('OK');
  });

  it('no muestra verde', () => {
    expect(report.state).toBe('DIFERENCIA');
  });

  it('bloquea el guardado', () => {
    expect(report.canSave).toBe(false);
  });

  it('avisa que faltan importes en el detalle', () => {
    expect(check(report, 'ART_NETO').message).toContain('Faltan importes');
  });

  it('no se conforma con que los impuestos den bien en porcentaje', () => {
    // Sobre 1.670.389: IVA 21 % = 350.781,69 y IIBB 1,5 % = 25.055,84.
    const consistentButWrong: PrintedSummary = {
      ...LOS_CALVOS_PRINTED,
      netTotal: '1670389.00',
      ivaTotal: '350781.69',
      perceptionsTotal: '25055.84',
      total: '2046226.53',
    };
    const r = run(shortItems, consistentButWrong);
    // Los controles de tasa cierran sobre la base equivocada…
    expect(check(r, 'IVA_TASA').severity).toBe('OK');
    expect(check(r, 'PERCEPCION_TASA').severity).toBe('OK');
    expect(check(r, 'TOTAL_GENERAL').severity).toBe('OK');
    expect(check(r, 'ART_NETO').severity).toBe('OK');
    // …pero el subtotal bruto impreso delata que la base está incompleta.
    expect(check(r, 'ART_BRUTO').severity).toBe('ERROR');
    expect(r.canSave).toBe(false);
  });
});

describe('caso negativo obligatorio: totales que son de un renglón', () => {
  const lineTotals: PrintedSummary = {
    ...LOS_CALVOS_PRINTED,
    netTotal: undefined,
    grossSubtotal: undefined,
    discountTotal: undefined,
    ivaTotal: '4487.69',
    perceptionsTotal: '320.55',
    total: '26178.19',
  };

  const report = run(LOS_CALVOS_ITEMS, lineTotals);

  it('identifica que los importes leídos como totales son de una línea', () => {
    const sospecha = check(report, 'TOTALES_SOSPECHOSOS');
    expect(sospecha.severity).toBe('ERROR');
    expect(sospecha.message).toContain('renglón');
  });

  it('bloquea el guardado', () => {
    expect(report.canSave).toBe(false);
    expect(report.state).toBe('DIFERENCIA');
  });
});

describe('detección de renglones faltantes', () => {
  it('avisa cuántos renglones faltan', () => {
    const report = run(LOS_CALVOS_ITEMS.slice(0, 8), LOS_CALVOS_PRINTED);
    const cantidad = check(report, 'ART_CANTIDAD');
    expect(cantidad.severity).toBe('ERROR');
    expect(cantidad.message).toContain('Faltan 1');
    expect(report.canSave).toBe(false);
  });

  it('avisa cuántos kilos faltan', () => {
    const report = run(LOS_CALVOS_ITEMS.slice(0, 8), LOS_CALVOS_PRINTED);
    const peso = check(report, 'PESO_NETO');
    expect(peso.severity).toBe('ERROR');
    expect(peso.message).toContain('faltan 36,40 kg');
  });
});

describe('detección de un precio mal leído', () => {
  it('marca el renglón cuyo importe no es cantidad × precio', () => {
    const items = LOS_CALVOS_ITEMS.map((i) =>
      i.lineNumber === 5 ? { ...i, grossSubtotal: '15163.50' } : i,
    );
    const report = run(items, LOS_CALVOS_PRINTED);
    const aritmetica = check(report, 'ART_ARITMETICA');
    expect(aritmetica.severity).toBe('ERROR');
    expect(aritmetica.message).toContain('renglón 5');
    expect(aritmetica.message).toContain('Jamón crudo Parma');
    expect(report.canSave).toBe(false);
  });
});

describe('detección de un total general incorrecto', () => {
  it('marca el total cuando no es neto más impuestos', () => {
    const report = run(LOS_CALVOS_ITEMS, { ...LOS_CALVOS_PRINTED, total: '2096120.52' });
    expect(check(report, 'TOTAL_GENERAL').severity).toBe('ERROR');
    expect(report.canSave).toBe(false);
  });
});

describe('semáforo', () => {
  it('pone amarillo cuando hizo falta más de una lectura pero todo reconcilió', () => {
    const report = run(LOS_CALVOS_ITEMS, LOS_CALVOS_PRINTED, 2);
    expect(report.state).toBe('RECONCILIADO');
    expect(report.canSave).toBe(true);
  });

  it('exige el resumen impreso para dar por controlado el comprobante', () => {
    const report = run(LOS_CALVOS_ITEMS, { ...LOS_CALVOS_PRINTED, netTotal: undefined, total: undefined });
    expect(report.canSave).toBe(false);
    expect(check(report, 'ART_NETO').severity).toBe('ERROR');
    expect(check(report, 'TOTAL_GENERAL').severity).toBe('ERROR');
  });
});
