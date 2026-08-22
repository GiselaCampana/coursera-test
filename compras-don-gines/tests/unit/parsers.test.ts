import { describe, it, expect } from 'vitest';
import { elegirAnalizador, analizadorLosCalvos, analizadorGenerico } from '@/lib/ocr/parsers';
import { repararDigitos, esColumnaNumerica } from '@/lib/ocr/parsers/tipos';
import { costItems, summarizeItems } from '@/lib/domain/costing';
import { validateDocument } from '@/lib/domain/validation';
import { toRawItems, toPrintedSummary } from '@/lib/ocr/normalize';
import {
  LOS_CALVOS_TEXT,
  LOS_CALVOS_TAX_RULES,
  LOS_CALVOS_ENCABEZADO_OCR,
  LOS_CALVOS_ARTICULOS_OCR,
  LOS_CALVOS_RESUMEN_OCR,
} from '../fixtures/los-calvos';

const textosLimpios = {
  completo: LOS_CALVOS_TEXT,
  encabezado: null,
  articulos: null,
  resumen: null,
};

const textosOcr = {
  completo: `${LOS_CALVOS_ENCABEZADO_OCR}\n${LOS_CALVOS_ARTICULOS_OCR}\n${LOS_CALVOS_RESUMEN_OCR}`,
  encabezado: LOS_CALVOS_ENCABEZADO_OCR,
  articulos: LOS_CALVOS_ARTICULOS_OCR,
  resumen: LOS_CALVOS_RESUMEN_OCR,
};

describe('reparación de dígitos', () => {
  it('traduce las confusiones de forma del OCR', () => {
    expect(repararDigitos('16.O37,OO')).toBe('16.037,00');
    expect(repararDigitos('1S3,7O')).toBe('153,70');
    expect(repararDigitos('B5')).toBe('85');
    expect(repararDigitos('l6,1O')).toBe('16,10');
  });

  it('reconoce qué columna es numérica y cuál no', () => {
    expect(esColumnaNumerica('16.O37,OO')).toBe(true);
    expect(esColumnaNumerica('14,00')).toBe(true);
    expect(esColumnaNumerica('LONGANIZA CORTA')).toBe(false);
    expect(esColumnaNumerica('SALAME MILAN')).toBe(false);
    expect(esColumnaNumerica('')).toBe(false);
  });
});

describe('elección del analizador', () => {
  it('reconoce una factura de Los Calvos', () => {
    const { analizador, puntaje } = elegirAnalizador(textosOcr);
    expect(analizador.codigo).toBe('los-calvos');
    expect(puntaje).toBeGreaterThan(0.5);
  });

  it('cae al genérico con un comprobante de otro proveedor', () => {
    const otro = {
      completo: [
        'DISTRIBUIDORA SAN JORGE S.R.L.',
        'FACTURA B   Punto de Venta: 0003   Comp. Nro: 00009912',
        'Fecha de Emisión: 02/07/2026',
        '',
        'Cod   Detalle                       Cant    Precio      Importe',
        '55    QUESO CREMOSO                  8,50   9.100,00    77.350,00',
        '56    MUZZARELLA                    12,00   8.400,00   100.800,00',
        '',
        'Subtotal:      178.150,00',
        'IVA 21%:        37.411,50',
        'TOTAL:         215.561,50',
      ].join('\n'),
    };
    const { analizador } = elegirAnalizador(otro);
    expect(analizador.codigo).toBe('generico');

    const analisis = analizador.analizar(otro);
    expect(analisis.items).toHaveLength(2);
    expect(analisis.summary?.total).toBe('215561.5');
  });
});

describe('analizador de Los Calvos sobre texto limpio', () => {
  const analisis = analizadorLosCalvos.analizar(textosLimpios);

  it('lee el encabezado', () => {
    expect(analisis.header?.docType).toBe('FACTURA');
    expect(analisis.header?.letter).toBe('A');
    expect(analisis.header?.pointOfSale).toBe('0010');
    expect(analisis.header?.number).toBe('00212356');
    expect(analisis.header?.issueDate).toBe('2026-08-14');
    expect(analisis.header?.supplierName).toBe('Los Calvos');
  });

  it('lee los nueve artículos con kilos, precio y bonificación', () => {
    expect(analisis.items).toHaveLength(9);
    expect(analisis.items[0].description).toBe('LONGANIZA CORTA');
    expect(analisis.items[0].supplierCode).toBe('1001');
    expect(analisis.items[0].quantity).toBe('16.1');
    expect(analisis.items[0].unitNetPrice).toBe('16037');
    expect(analisis.items[0].discountPct).toBe('0.14');
    expect(analisis.items[0].grossSubtotal).toBe('258195.7');
    expect(analisis.items[0].unit).toBe('KG');
    expect(analisis.items[0].ivaRate).toBe('0.21');
    expect(analisis.items[8].description).toBe('FIAMBRE COCIDO DE PATA ZUR-LINDE');
  });

  it('lee el pie con los totales y el IVA discriminado', () => {
    expect(analisis.summary?.grossSubtotal).toBe('2084594.7');
    expect(analisis.summary?.discountTotal).toBe('291843.26');
    expect(analisis.summary?.netTotal).toBe('1792751.44');
    expect(analisis.summary?.ivaTotal).toBe('376477.81');
    expect(analisis.summary?.perceptionsTotal).toBe('26891.27');
    expect(analisis.summary?.total).toBe('2196120.52');
    expect(analisis.summary?.lineCount).toBe(9);
    expect(analisis.summary?.netWeightKg).toBe('153.7');
    expect(analisis.summary?.ivaLines?.[0].rate).toBe('0.21');
    expect(analisis.summary?.perceptionLines?.[0].rate).toBe('0.015');
  });

  it('no deja observaciones cuando todo cierra', () => {
    expect(analisis.observaciones).toHaveLength(0);
  });
});

describe('analizador de Los Calvos sobre texto con ruido de OCR', () => {
  const analisis = analizadorLosCalvos.analizar(textosOcr);

  it('recupera los nueve artículos pese a las confusiones de dígitos', () => {
    expect(analisis.items).toHaveLength(9);
    expect(analisis.items[0].quantity).toBe('16.1');
    expect(analisis.items[0].unitNetPrice).toBe('16037');
    expect(analisis.items[5].quantity).toBe('37.6');
    expect(analisis.items[5].unitNetPrice).toBe('12803');
  });

  it('recupera los totales', () => {
    expect(analisis.summary?.netTotal).toBe('1792751.44');
    expect(analisis.summary?.ivaTotal).toBe('376477.81');
    expect(analisis.summary?.perceptionsTotal).toBe('26891.27');
    expect(analisis.summary?.total).toBe('2196120.52');
    expect(analisis.summary?.netWeightKg).toBe('153.7');
  });

  it('el comprobante leído con ruido igual pasa todos los controles', () => {
    const items = costItems(toRawItems(analisis.items), {
      netTotal: analisis.summary!.netTotal!,
      ivaTotal: analisis.summary!.ivaTotal!,
      perceptionsTotal: analisis.summary!.perceptionsTotal!,
    });
    const sumas = summarizeItems(items);

    expect(sumas.totalQuantityKg.toFixed(2)).toBe('153.70');
    expect(sumas.grossSubtotal.toFixed(2)).toBe('2084594.70');
    expect(sumas.netAmount.toFixed(2)).toBe('1792751.44');
    expect(sumas.ivaAmount.toFixed(2)).toBe('376477.81');
    expect(sumas.perceptionAmount.toFixed(2)).toBe('26891.27');
    expect(sumas.totalCost.toFixed(2)).toBe('2196120.52');

    const informe = validateDocument({
      items,
      printed: toPrintedSummary(analisis.summary),
      supplierRules: LOS_CALVOS_TAX_RULES,
      attempts: 1,
    });
    expect(informe.state).toBe('OK');
    expect(informe.canSave).toBe(true);
  });
});

describe('control renglón por renglón', () => {
  it('avisa cuál renglón no cierra, sin corregirlo', () => {
    // El importe del renglón 3 quedó mal leído: 155.390,40 pasó a 165.390,40.
    const conError = LOS_CALVOS_ARTICULOS_OCR.replace('155.39O,4O', '165.39O,4O');
    const analisis = analizadorLosCalvos.analizar({
      completo: conError,
      articulos: conError,
      resumen: LOS_CALVOS_RESUMEN_OCR,
    });

    expect(analisis.observaciones.some((o) => o.includes('Renglón 3'))).toBe(true);
    expect(analisis.observaciones.some((o) => o.includes('SALAME MILAN'))).toBe(true);
    // El importe queda como se leyó: no se lo ajusta para que cierre.
    expect(analisis.items[2].grossSubtotal).toBe('165390.4');
  });

  it('avisa cuando faltan renglones respecto de los que declara el comprobante', () => {
    const sinUno = LOS_CALVOS_ARTICULOS_OCR.split('\n')
      .filter((l) => !l.includes('BONDIOLA'))
      .join('\n');
    const analisis = analizadorLosCalvos.analizar({
      completo: sinUno,
      articulos: sinUno,
      resumen: LOS_CALVOS_RESUMEN_OCR,
    });

    expect(analisis.items).toHaveLength(8);
    expect(analisis.observaciones.some((o) => o.includes('declara 9 renglones'))).toBe(true);
  });
});

describe('analizador genérico', () => {
  it('también resuelve la factura de Los Calvos, aunque sin sus atajos', () => {
    const analisis = analizadorGenerico.analizar(textosLimpios);
    expect(analisis.items).toHaveLength(9);
    expect(analisis.summary?.total).toBe('2196120.52');
  });

  it('cae al texto completo cuando el recorte de la tabla no dio nada', () => {
    const analisis = analizadorGenerico.analizar({
      completo: LOS_CALVOS_TEXT,
      articulos: '   \n  \n',
      resumen: null,
    });
    expect(analisis.items).toHaveLength(9);
    expect(analisis.observaciones.some((o) => o.includes('recorte'))).toBe(true);
  });
});
