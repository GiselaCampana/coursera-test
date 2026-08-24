import { describe, it, expect } from 'vitest';
import { conciliarCentavos } from '@/lib/domain/conciliacion';
import { costItems, type RawItem } from '@/lib/domain/costing';
import { validateDocument, type PrintedSummary } from '@/lib/domain/validation';

/**
 * Conciliación automática de centavos por OCR.
 *
 * La regla existe para un caso muy angosto —el OCR pierde los dos dígitos de
 * los centavos de un subtotal— y lo que hay que probar no es tanto que funcione
 * como que **no se abra**. Por eso la mayoría de estas pruebas son casos que
 * tienen que seguir frenando.
 */

/** Un renglón con cantidad, precio y el importe tal como se leyó de la foto. */
function renglon(
  lineNumber: number,
  cantidad: string,
  precio: string,
  leido: string,
  extra: Partial<RawItem> = {},
): RawItem {
  return {
    lineNumber,
    supplierCode: `ART-0${1000 + lineNumber}`,
    description: `ARTICULO NUMERO ${lineNumber}`,
    quantity: cantidad,
    unit: 'KG',
    unitNetPrice: precio,
    grossSubtotal: leido,
    ivaRate: '0.21',
    ...extra,
  };
}

/** Pie que cierra consigo mismo: neto + IVA + percepciones = total. */
function pie(neto: string, opciones: Partial<PrintedSummary> = {}): PrintedSummary {
  const n = Number(neto);
  const iva = +(n * 0.21).toFixed(2);
  const percepciones = 0;
  return {
    netTotal: neto,
    ivaTotal: iva.toFixed(2),
    perceptionsTotal: percepciones.toFixed(2),
    total: (n + iva + percepciones).toFixed(2),
    ...opciones,
  };
}

describe('el caso que motivó la regla', () => {
  /*
   * Es el de la factura de Errecalde: un renglón de 10 unidades a $2.258,73 que
   * el papel imprime $22.587,34 y el OCR lee $22.587,00. Los pesos coinciden;
   * se perdieron los centavos.
   */
  const items = [
    renglon(1, '10', '1000.00', '10000.00'),
    renglon(2, '10', '2258.73', '22587.00'),
  ];
  // El neto impreso incluye los centavos que el OCR no leyó.
  const printed = pie('32587.30');

  it('concilia la diferencia de centavos y la deja registrada', () => {
    const resultado = conciliarCentavos({ items, printed });

    expect(resultado.conciliacion).not.toBeNull();
    expect(resultado.motivoRechazo).toBeNull();

    const c = resultado.conciliacion!;
    expect(c.renglones).toHaveLength(1);
    expect(c.renglones[0].lineNumber).toBe(2);
    expect(c.renglones[0].leido).toBe('22587.00');
    expect(c.renglones[0].conciliado).toBe('22587.30');
    expect(c.renglones[0].diferencia).toBe('0.30');
    expect(c.renglones[0].supplierCode).toBe('ART-01002');
    expect(c.totalAbsoluto).toBe('0.30');
    expect(c.mensaje).toMatch(/Se conciliaron autom/);

    // Y el renglón quedó con el importe conciliado.
    expect(resultado.items[1].grossSubtotal).toBe('22587.30');
    // El que ya cerraba no se tocó.
    expect(resultado.items[0]).toBe(items[0]);
  });

  it('el comprobante queda en verde, con la advertencia a la vista', () => {
    const resultado = conciliarCentavos({ items, printed });
    const costeados = costItems(resultado.items, {
      netTotal: printed.netTotal!,
      ivaTotal: printed.ivaTotal!,
      perceptionsTotal: printed.perceptionsTotal!,
    });
    const informe = validateDocument({
      items: costeados,
      printed,
      attempts: 1,
      reconciliation: resultado.conciliacion,
    });

    expect(informe.errorCount).toBe(0);
    expect(informe.canSave).toBe(true);
    // Verde, no amarillo: conciliar centavos no es "hizo falta corregir".
    expect(informe.state).toBe('OK');

    // Pero queda escrito qué se cambió, con los tres importes.
    const control = informe.checks.find((c) => c.code === 'CENTAVOS_CONCILIADOS');
    expect(control?.severity).toBe('OK');
    expect(control?.message).toContain('22.587,00');
    expect(control?.message).toContain('22.587,30');
    expect(informe.reconciliation?.totalAbsoluto).toBe('0.30');
  });

  it('sin conciliar, el mismo comprobante frena', () => {
    const costeados = costItems(items, {
      netTotal: printed.netTotal!,
      ivaTotal: printed.ivaTotal!,
      perceptionsTotal: printed.perceptionsTotal!,
    });
    const informe = validateDocument({ items: costeados, printed, attempts: 1 });
    expect(informe.canSave).toBe(false);
    expect(informe.checks.find((c) => c.code === 'ART_ARITMETICA')?.severity).toBe('ERROR');
  });
});

describe('$0,51 repartidos en dos renglones', () => {
  it('se concilian los dos, cada uno con su propia cuenta', () => {
    // Ninguno de los dos se arregla con el sobrante del otro: cada corrección
    // sale de la cantidad y el precio de su propio renglón.
    const items = [
      renglon(1, '10', '1000.00', '10000.00'),
      renglon(2, '10', '2258.73', '22587.00'),
      renglon(3, '3', '1234.07', '3702.00'),
    ];
    const printed = pie('36289.51');

    const resultado = conciliarCentavos({ items, printed });
    expect(resultado.conciliacion?.renglones).toHaveLength(2);
    expect(resultado.conciliacion?.totalAbsoluto).toBe('0.51');
    expect(resultado.items[1].grossSubtotal).toBe('22587.30');
    expect(resultado.items[2].grossSubtotal).toBe('3702.21');
  });
});

describe('el faltante no tiene por qué ser exactamente los centavos corregidos', () => {
  it('concilia aunque al detalle le falte un poco más, por el redondeo del proveedor', () => {
    /*
     * Es el caso de la factura real. Al detalle le faltan $0,51 para el
     * subtotal impreso, pero sólo $0,30 vienen de un importe mal leído: el
     * resto es la diferencia normal entre el importe que imprime el proveedor
     * —redondeado renglón por renglón— y cantidad × precio con el precio ya
     * redondeado a dos decimales.
     *
     * Exigir que la corrección cubriera los $0,51 rechazaría un comprobante que
     * está bien. Lo que se exige es que empuje para el lado correcto y no se
     * pase.
     */
    const items = [
      renglon(1, '40', '3847.48', '153899.41'), // cierra dentro de su redondeo
      renglon(2, '10', '2258.73', '22587.00'), // le faltan 30 centavos
    ];
    const printed = pie('176486.72'); // 0,51 más que la suma leída

    const resultado = conciliarCentavos({ items, printed });
    expect(resultado.conciliacion).not.toBeNull();
    expect(resultado.conciliacion!.renglones).toHaveLength(1);
    expect(resultado.conciliacion!.renglones[0].lineNumber).toBe(2);
    expect(resultado.conciliacion!.totalAbsoluto).toBe('0.30');
  });

  it('no corrige más de lo que al comprobante le falta', () => {
    // Al detalle le faltan 10 centavos y la corrección querría poner 90: eso ya
    // no es leer mejor, es empujar el número.
    const items = [renglon(1, '1', '100.90', '100.00')];
    const printed = pie('100.10');

    const resultado = conciliarCentavos({ items, printed });
    expect(resultado.conciliacion).toBeNull();
    expect(resultado.motivoRechazo).toMatch(/sólo le faltan/);
  });

  it('no corrige para el lado contrario al que falta', () => {
    // Al detalle le sobra plata y la corrección querría agregarle más.
    const items = [renglon(1, '1', '100.30', '100.00')];
    const printed = pie('99.00');

    const resultado = conciliarCentavos({ items, printed });
    expect(resultado.conciliacion).toBeNull();
    expect(resultado.motivoRechazo).toMatch(/van para el otro lado/);
  });
});

describe('lo que tiene que seguir frenando', () => {
  it('una diferencia de $1,00 exactos no se concilia', () => {
    // El tope es duro: con un peso ya no es un problema de centavos.
    const items = [renglon(1, '1', '1001.00', '1000.00')];
    const printed = pie('1001.00');

    const resultado = conciliarCentavos({ items, printed });
    expect(resultado.conciliacion).toBeNull();
    expect(resultado.motivoRechazo).toMatch(/no es una diferencia de centavos/);
    expect(resultado.items[0].grossSubtotal).toBe('1000.00');
  });

  it('tampoco se concilia una diferencia mayor a un peso', () => {
    const items = [renglon(1, '2', '1000.00', '1997.50')];
    const printed = pie('2000.00');
    expect(conciliarCentavos({ items, printed }).conciliacion).toBeNull();
  });

  it('no concilia si cambia la parte entera del importe', () => {
    // 99,80 contra 100,10: la diferencia es de treinta centavos, pero los pesos
    // no coinciden. Un dígito mal leído en los pesos sí cambia la plata.
    const items = [renglon(1, '1', '100.10', '99.80')];
    const printed = pie('100.10');

    const resultado = conciliarCentavos({ items, printed });
    expect(resultado.conciliacion).toBeNull();
    expect(resultado.motivoRechazo).toMatch(/no coincide en los pesos/);
  });

  it('no concilia un renglón sin código de artículo', () => {
    const items = [
      renglon(1, '10', '1000.00', '10000.00'),
      renglon(2, '10', '2258.73', '22587.00', { supplierCode: null }),
    ];
    const printed = pie('32587.30');

    const resultado = conciliarCentavos({ items, printed });
    expect(resultado.conciliacion).toBeNull();
    expect(resultado.motivoRechazo).toMatch(/no tiene código de artículo/);
  });

  it('no concilia si el pie no cierra entre sí', () => {
    const items = [renglon(1, '10', '2258.73', '22587.00')];
    const printed: PrintedSummary = {
      netTotal: '22587.30',
      ivaTotal: '4743.33',
      perceptionsTotal: '0.00',
      // El total impreso no es neto + IVA: alguno de los cuatro se leyó mal.
      total: '30000.00',
    };

    const resultado = conciliarCentavos({ items, printed });
    expect(resultado.conciliacion).toBeNull();
    expect(resultado.motivoRechazo).toMatch(/no cierran entre sí/);
  });

  it('no concilia si falta algún número del pie', () => {
    const items = [renglon(1, '10', '2258.73', '22587.00')];
    const resultado = conciliarCentavos({
      items,
      printed: { netTotal: '22587.30', ivaTotal: null, perceptionsTotal: null, total: '27330.63' },
    });
    expect(resultado.conciliacion).toBeNull();
    expect(resultado.motivoRechazo).toMatch(/no se leyó completo/);
  });

  it('no concilia si falta un renglón respecto de los que declara el comprobante', () => {
    const items = [
      renglon(1, '10', '1000.00', '10000.00'),
      renglon(2, '10', '2258.73', '22587.00'),
    ];
    const printed = { ...pie('32587.30'), lineCount: 3 };

    const resultado = conciliarCentavos({ items, printed });
    expect(resultado.conciliacion).toBeNull();
    expect(resultado.motivoRechazo).toMatch(/declara 3 renglones/);
  });

  it('no concilia si en la imagen se ven más filas de las que se interpretaron', () => {
    const items = Array.from({ length: 9 }, (_, i) => renglon(i + 1, '1', '100.00', '100.00'));
    items[8] = renglon(9, '10', '2258.73', '22587.00');
    const printed = pie('23387.30');

    const resultado = conciliarCentavos({ items, printed, filasEnLaImagen: 12 });
    expect(resultado.conciliacion).toBeNull();
    expect(resultado.motivoRechazo).toMatch(/se ven 12 filas/);
  });

  it('no concilia cuando la cantidad no se pudo leer', () => {
    const items = [renglon(1, '10', '2258.73', '22587.00', { quantity: '' })];
    const resultado = conciliarCentavos({ items, printed: pie('22587.30') });
    expect(resultado.conciliacion).toBeNull();
    expect(resultado.motivoRechazo).toMatch(/cantidad, precio o importe/);
  });

  it('no concilia con una cantidad en cero o negativa', () => {
    const items = [renglon(1, '0', '2258.73', '22587.00')];
    const resultado = conciliarCentavos({ items, printed: pie('22587.30') });
    expect(resultado.conciliacion).toBeNull();
    expect(resultado.motivoRechazo).toMatch(/cantidad que no se puede usar/);
  });

  it('no concilia cuando hay demasiados renglones con diferencias', () => {
    // Si media tabla necesita corrección, lo que falló no son los centavos.
    const items = [1, 2, 3, 4].map((n) => renglon(n, '1', '100.10', '100.00'));
    const printed = pie('400.40');

    const resultado = conciliarCentavos({ items, printed });
    expect(resultado.conciliacion).toBeNull();
    expect(resultado.motivoRechazo).toMatch(/demasiados/);
  });

  it('no concilia si las diferencias juntas llegan al peso', () => {
    // Tres renglones de 35 centavos: cada uno pasaría solo, los tres no.
    const items = [1, 2, 3].map((n) => renglon(n, '1', '100.35', '100.00'));
    const printed = pie('301.05');

    const resultado = conciliarCentavos({ items, printed });
    expect(resultado.conciliacion).toBeNull();
    expect(resultado.motivoRechazo).toMatch(/llega al peso/);
  });

  it('no compensa un renglón de más contra uno de menos', () => {
    /*
     * Esta es la que más importa. Los dos renglones se desvían treinta centavos
     * en direcciones opuestas, así que la suma del detalle da exactamente el
     * neto impreso y "de afuera" el comprobante parece perfecto.
     *
     * Conciliar acá sería taparlo: los dos renglones quedarían "correctos" por
     * construcción sin que nada los haya verificado. Que la suma cerrara antes
     * de corregir no es prueba de nada: son dos errores, no cero.
     */
    const items = [
      renglon(1, '1', '100.30', '100.00'),
      renglon(2, '1', '100.00', '100.30'),
    ];
    const printed = pie('200.30');

    const resultado = conciliarCentavos({ items, printed });
    expect(resultado.conciliacion).toBeNull();
    expect(resultado.motivoRechazo).toMatch(/se compensan entre sí/);
    // Y los importes quedan como se leyeron.
    expect(resultado.items[0].grossSubtotal).toBe('100.00');
    expect(resultado.items[1].grossSubtotal).toBe('100.30');
  });

  it('no toca nada cuando el comprobante ya cierra', () => {
    const items = [renglon(1, '10', '1000.00', '10000.00')];
    const resultado = conciliarCentavos({ items, printed: pie('10000.00') });
    expect(resultado.conciliacion).toBeNull();
    expect(resultado.motivoRechazo).toBeNull();
    expect(resultado.items).toBe(items);
  });
});
