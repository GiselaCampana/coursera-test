import { describe, it, expect } from 'vitest';
import { Decimal, parseArNumber } from '@/lib/money';
import { analizadorMabelherdi } from '@/lib/ocr/parsers/mabelherdi';
import { elegirAnalizador } from '@/lib/ocr/parsers';
import { MABELHERDI_COMPLETO } from '../fixtures/mabelherdi';
import { SAFARI_COMPLETO } from '../fixtures/errecalde-safari';
import { LOS_CALVOS_TEXT } from '../fixtures/los-calvos';

/**
 * Prueba de aceptación de la factura real de MABELHERDI S.A.
 *
 * El texto contra el que corre es la salida literal de Tesseract sobre la foto
 * del teléfono, con sus errores adentro. No es una transcripción: si el
 * analizador sólo funcionara sobre texto limpio, esta prueba pasaría y la
 * factura seguiría sin poder cargarse.
 *
 * Lo que dice el papel:
 *   Factura A 0007-00348491 · 20/08/2026 · 9 renglones
 *   Neto 21 % 32.998,85 · IVA 21 % 6.929,76 · Percepción IIBB 577,48
 *   Total 40.506,09
 */

const analisis = analizadorMabelherdi.analizar({ completo: MABELHERDI_COMPLETO });

describe('reconocer que la factura es de Mabelherdi', () => {
  it('la toma su propio analizador y no el genérico', () => {
    const elegido = elegirAnalizador({ completo: MABELHERDI_COMPLETO });
    expect(elegido.analizador.codigo).toBe('mabelherdi');
    expect(elegido.puntaje).toBeGreaterThan(0.8);
  });

  it('no se queda con comprobantes de otros proveedores', () => {
    /*
     * Un analizador hecho para un formato no puede agarrar el de otro sólo
     * porque comparta alguna forma. Sin nombre ni CUIT no es de Mabelherdi.
     */
    expect(
      analizadorMabelherdi.reconoce({
        completo: 'DISTRIBUCION ERRECALDE S. A.\nCUIT 30717808904\nART-00228 CREMOSO',
      }),
    ).toBe(0);
    expect(
      analizadorMabelherdi.reconoce({ completo: 'Los Calvos S.R.L.\nLONGANIZA CORTA 16,10' }),
    ).toBe(0);
  });

  it('las facturas de los otros dos proveedores siguen yendo a su analizador', () => {
    /*
     * La regresión que importa al sumar un formato: el analizador nuevo no
     * puede robarle comprobantes a los que ya funcionaban. Se prueba con las
     * lecturas reales, no con texto inventado.
     */
    expect(elegirAnalizador({ completo: SAFARI_COMPLETO }).analizador.codigo).toBe('errecalde');
    expect(elegirAnalizador({ completo: LOS_CALVOS_TEXT }).analizador.codigo).toBe('los-calvos');
    expect(analizadorMabelherdi.reconoce({ completo: SAFARI_COMPLETO })).toBe(0);
    expect(analizadorMabelherdi.reconoce({ completo: LOS_CALVOS_TEXT })).toBe(0);
  });

  it('el CUIT alcanza aunque el nombre salga mordido', () => {
    // Once dígitos o están o no están; el nombre tiene letras que el OCR
    // confunde, y no puede ser la única llave.
    expect(
      analizadorMabelherdi.reconoce({ completo: 'M4BELHERO1 S.A.\nCUIT: 30-67804306-7' }),
    ).toBeGreaterThan(0.8);
  });
});

describe('el encabezado de la factura real', () => {
  it('lee el comprobante, la fecha y el CUIT', () => {
    expect(analisis.header?.pointOfSale).toBe('0007');
    expect(analisis.header?.number).toBe('00348491');
    expect(analisis.header?.fullNumber).toBe('0007-00348491');
    expect(analisis.header?.cuit).toBe('30-67804306-7');
    expect(analisis.header?.docType).toBe('FACTURA');
    expect(analisis.header?.letter).toBe('A');
  });

  it('toma la fecha de emisión y no la de entrega', () => {
    /*
     * El comprobante trae las dos: emisión 20/08 y entrega 22/08. Con la de
     * entrega se calcularía mal el vencimiento del pago.
     */
    expect(analisis.header?.issueDate).toBe('2026-08-20');
  });
});

describe('los nueve renglones de la factura real', () => {
  it('los lee todos', () => {
    expect(analisis.items).toHaveLength(9);
  });

  it('lee el código de artículo de cada uno', () => {
    // Nueve dígitos, que es lo que va a servir para asociarlos a un PLU.
    for (const item of analisis.items) {
      expect(item.supplierCode, `${item.description} vino sin código`).toMatch(/^\d{9}$/);
    }
  });

  it('todo va por unidad: en este proveedor no hay kilos', () => {
    for (const item of analisis.items) {
      expect(item.unit).toBe('UNIT');
      expect(item.totalWeightKg).toBeNull();
    }
  });

  it('las cantidades son las del papel', () => {
    expect(analisis.items.map((i) => Number(i.quantity))).toEqual([1, 1, 1, 2, 1, 2, 3, 2, 3]);
  });

  it('los importes son los del papel', () => {
    expect(analisis.items.map((i) => Number(i.grossSubtotal))).toEqual([
      2066.12, 2066.12, 2125.15, 4132.24, 2066.12, 4132.24, 9740.25, 2951.6, 3719.01,
    ]);
  });

  it('el precio unitario sale de la división y no de la columna rota', () => {
    /*
     * Los nueve unitarios del papel. Cuatro de ellos el OCR los leyó sin punto
     * decimal («$206812») y en dos se comió el signo pesos: leerlos daría un
     * costo diez veces mayor. Salen de importe ÷ cantidad, que es exacto.
     */
    expect(analisis.items.map((i) => Number(i.unitNetPrice))).toEqual([
      2066.12, 2066.12, 2125.15, 2066.12, 2066.12, 2066.12, 3246.75, 1475.8, 1239.67,
    ]);
  });

  it('el «Sugerido» no se cuela en ningún importe', () => {
    /*
     * El control que importa: los sugeridos son 3500, 3500, 3600, 3500, 3500,
     * 3500, 5500, 2500 y 2100. Si alguno se hubiera tomado por el unitario o
     * por el importe, esta factura de $40.506 costaría más de $100.000.
     */
    const sugeridos = [3500, 3600, 5500, 2500, 2100];
    for (const item of analisis.items) {
      expect(sugeridos, `${item.description}: el sugerido entró como unitario`).not.toContain(
        Number(item.unitNetPrice),
      );
      expect(sugeridos, `${item.description}: el sugerido entró como importe`).not.toContain(
        Number(item.grossSubtotal),
      );
    }
  });

  it('cantidad × unitario da el importe en los nueve', () => {
    for (const item of analisis.items) {
      const cantidad = parseArNumber(item.quantity!)!;
      const unitario = parseArNumber(item.unitNetPrice!)!;
      const importe = parseArNumber(item.grossSubtotal!)!;
      expect(
        cantidad.times(unitario).minus(importe).abs().lte(new Decimal('0.01')),
        `${item.description}: ${cantidad} × ${unitario} ≠ ${importe}`,
      ).toBe(true);
    }
  });

  it('las descripciones son legibles y no arrastran la cola numérica', () => {
    expect(analisis.items[0].description).toMatch(/PEP\s?COMUN/i);
    expect(analisis.items[6].description).toMatch(/LAYS CLASICAS/i);
    for (const item of analisis.items) {
      expect(item.description, `«${item.description}» trae el % pegado`).not.toMatch(/%/);
      expect(item.description, `«${item.description}» trae un importe pegado`).not.toMatch(/\$/);
    }
  });

  it('el descuento es cero en todos, como está impreso', () => {
    for (const item of analisis.items) expect(Number(item.discountPct)).toBe(0);
  });
});

describe('el pie de la factura real', () => {
  it('lee neto, IVA, percepción y total', () => {
    expect(Number(analisis.summary?.netTotal)).toBe(32998.85);
    expect(Number(analisis.summary?.ivaTotal)).toBe(6929.76);
    expect(Number(analisis.summary?.perceptionsTotal)).toBe(577.48);
    expect(Number(analisis.summary?.total)).toBe(40506.09);
  });

  it('la percepción de IIBB queda discriminada', () => {
    expect(analisis.summary?.perceptionLines).toHaveLength(1);
    expect(analisis.summary?.perceptionLines?.[0].label).toMatch(/IIBB/i);
  });

  it('el pie cierra: neto + IVA + percepciones = total', () => {
    const neto = parseArNumber(analisis.summary!.netTotal!)!;
    const iva = parseArNumber(analisis.summary!.ivaTotal!)!;
    const percepciones = parseArNumber(analisis.summary!.perceptionsTotal!)!;
    const total = parseArNumber(analisis.summary!.total!)!;
    expect(neto.plus(iva).plus(percepciones).toFixed(2)).toBe(total.toFixed(2));
  });
});

describe('el detalle contra el pie', () => {
  it('la suma de los nueve importes da el neto impreso', () => {
    /*
     * Es el control que decide si la lectura sirve: si faltara un renglón o
     * sobrara uno, esta suma no daría. Los $32.998,85 del pie tienen que salir
     * de sumar la columna Importe, no de creerle al pie.
     */
    const suma = analisis.items.reduce(
      (acc, i) => acc.plus(parseArNumber(i.grossSubtotal!)!),
      new Decimal(0),
    );
    expect(suma.toFixed(2)).toBe('32998.85');
  });

  it('el IVA del pie es el 21 % del neto', () => {
    const neto = parseArNumber(analisis.summary!.netTotal!)!;
    const iva = parseArNumber(analisis.summary!.ivaTotal!)!;
    expect(neto.times('0.21').minus(iva).abs().lte(new Decimal('0.01'))).toBe(true);
  });

  it('no quedan observaciones: la lectura cierra sola', () => {
    expect(analisis.observaciones).toEqual([]);
  });
});
