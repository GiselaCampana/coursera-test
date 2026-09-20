import { describe, it, expect } from 'vitest';
import {
  planDeIngresos,
  claveDelEvento,
  DIRECCION_DE_COMPRA,
  DIRECCION_DEL_CONTRATO,
  MOTIVO_DEL_CONTRATO,
  VERSION_DEL_CONTRATO,
  cantidadDelContrato,
  type RenglonParaStock,
} from '@/lib/domain/ingreso-de-stock';

/**
 * **Las reglas del ingreso, cada una aislada de las demás.**
 *
 * Este archivo existe por un hallazgo concreto: en la factura de Ezra la bolsa
 * queda afuera del stock por **dos** razones a la vez —está clasificada como
 * gasto y además no tiene artículo en el catálogo—, así que romper una sola de
 * las dos no se notaba en ninguna prueba de integración. Una garantía
 * sostenida por dos defensas superpuestas es una garantía que nadie está
 * midiendo: el día que una se caiga, la otra la tapa hasta que deje de taparla.
 *
 * Acá cada regla se prueba con un renglón armado para que sólo esa regla pueda
 * decidir el resultado.
 */

function renglon(parcial: Partial<RenglonParaStock> = {}): RenglonParaStock {
  return {
    documentItemId: 'item-1',
    lineNumber: 1,
    description: 'Queso cremoso',
    quantity: '4.240',
    unit: 'KG',
    producto: { id: 'p1', plu: '3101', purchaseUnit: 'KG' },
    esGasto: false,
    ...parcial,
  };
}

describe('un gasto no mueve stock, y eso no depende de que le falte el artículo', () => {
  it('con artículo asociado y todo, un gasto sigue sin generar movimiento', () => {
    /*
     * Es la prueba que faltaba. En la compra real la bolsa no tiene artículo,
     * así que el camino del gasto nunca se ejercitaba solo: quitarlo no cambiaba
     * nada porque la falta de artículo lo tapaba. Acá el renglón tiene artículo,
     * PLU y unidad correctos, y lo único que lo deja afuera es ser un gasto.
     */
    const plan = planDeIngresos([
      renglon({
        description: 'BOLSA GRANDE',
        quantity: '3.000',
        unit: 'UNIT',
        producto: { id: 'p9', plu: '9999', purchaseUnit: 'UNIT' },
        esGasto: true,
      }),
    ]);

    expect(plan.ingresos).toHaveLength(0);
    expect(plan.sinImpacto).toHaveLength(1);
    expect(plan.sinImpacto[0].porQue).toMatch(/gasto/i);
    expect(plan.impedimentos).toHaveLength(0);
  });

  it('el mismo renglón, sin ser gasto, sí genera movimiento', () => {
    // La simétrica: si esto no pasara, la prueba de arriba no probaría nada.
    const plan = planDeIngresos([
      renglon({
        description: 'BOLSA GRANDE',
        quantity: '3.000',
        unit: 'UNIT',
        producto: { id: 'p9', plu: '9999', purchaseUnit: 'UNIT' },
        esGasto: false,
      }),
    ]);

    expect(plan.ingresos).toHaveLength(1);
    expect(plan.ingresos[0].plu).toBe('9999');
  });
});

describe('lo que frena, cada cosa por separado', () => {
  it('un PLU en blanco frena, y no propone crear nada', () => {
    const plan = planDeIngresos([
      renglon({ producto: { id: 'p1', plu: '   ', purchaseUnit: 'KG' } }),
    ]);

    expect(plan.ingresos).toHaveLength(0);
    expect(plan.impedimentos).toHaveLength(1);
    expect(plan.impedimentos[0].motivo).toMatch(/no se crea uno nuevo/i);
  });

  it('una unidad que no coincide frena, y no se convierte sola', () => {
    const plan = planDeIngresos([
      renglon({ unit: 'KG', producto: { id: 'p1', plu: '3101', purchaseUnit: 'UNIT' } }),
    ]);

    expect(plan.ingresos).toHaveLength(0);
    expect(plan.impedimentos[0].motivo).toMatch(/no se convierte/i);
  });

  it('un renglón de mercadería sin artículo no frena acá, pero tampoco se manda', () => {
    /*
     * Lo frena la vista previa, que es donde se ve. Este camino lo usa también
     * la confirmación general, que desde siempre acepta renglones sin asociar.
     */
    const plan = planDeIngresos([renglon({ producto: null })]);

    expect(plan.ingresos).toHaveLength(0);
    expect(plan.impedimentos).toHaveLength(0);
    expect(plan.sinImpacto[0].porQue).toMatch(/no se sabe a qué existencias/i);
  });
});

describe('las constantes que no se pueden equivocar', () => {
  it('una compra sólo produce ingresos', () => {
    expect(DIRECCION_DE_COMPRA).toBe('INGRESO');
    expect(DIRECCION_DEL_CONTRATO).toBe('IN');
    expect(MOTIVO_DEL_CONTRATO).toBe('PURCHASE');
    expect(VERSION_DEL_CONTRATO).toBe(1);
  });

  it('cada ingreso planeado lleva la dirección puesta', () => {
    const plan = planDeIngresos([renglon()]);
    expect(plan.ingresos[0].direccion).toBe('INGRESO');
  });

  it('la clave no lleva el reloj: dos veces seguidas da lo mismo', () => {
    const origen = { documentId: 'doc-1', documentItemId: 'item-1' };
    const primera = claveDelEvento(origen);
    const segunda = claveDelEvento(origen);

    expect(segunda).toBe(primera);
    expect(primera).toBe('compras-don-gines:compra:doc-1:item-1');
    // Y no contiene nada que cambie entre intentos.
    expect(primera).not.toMatch(/\d{13}/);
  });

  it('dos renglones distintos del mismo comprobante tienen claves distintas', () => {
    expect(claveDelEvento({ documentId: 'd', documentItemId: 'a' })).not.toBe(
      claveDelEvento({ documentId: 'd', documentItemId: 'b' }),
    );
  });
});

describe('la cantidad, como la escribe el contrato: tres decimales siempre', () => {
  it('4.24 sale como «4.240», y 4.04 como «4.040»', () => {
    /*
     * La diferencia parece cosmética y no lo es. La base guarda Decimal(14,4)
     * y al serializarla sin más sale «4.24» donde el papel dice «4,240». Es el
     * mismo peso; el problema aparece cuando algo compara **cadenas**, y la
     * idempotencia compara contenido: «4.24» y «4.240» pasarían a ser dos
     * cosas distintas y habría un conflicto que no existe.
     */
    expect(cantidadDelContrato('4.24')).toEqual({ ok: true, quantity: '4.240' });
    expect(cantidadDelContrato('4.04')).toEqual({ ok: true, quantity: '4.040' });
    expect(cantidadDelContrato('4.2400')).toEqual({ ok: true, quantity: '4.240' });
  });

  it('tres unidades salen como «3.000», no como «3»', () => {
    // La escala es la misma para KG y para UNIT: una sola forma canónica.
    expect(cantidadDelContrato('3')).toEqual({ ok: true, quantity: '3.000' });
    expect(cantidadDelContrato('3.0')).toEqual({ ok: true, quantity: '3.000' });
    expect(cantidadDelContrato('3.0000')).toEqual({ ok: true, quantity: '3.000' });
  });

  it('los cinco pesos de Ezra, tal como los imprime el papel', () => {
    const esperados: [string, string][] = [
      ['4.2400', '4.240'],
      ['3.9850', '3.985'],
      ['7.3450', '7.345'],
      ['4.0400', '4.040'],
      ['7.6650', '7.665'],
    ];
    for (const [guardado, contrato] of esperados) {
      expect(cantidadDelContrato(guardado), guardado).toEqual({ ok: true, quantity: contrato });
    }
  });

  it('un valor con más de tres decimales no se redondea: se rechaza', () => {
    /*
     * Redondear mandaría a Control de Stock una cantidad que no es la de la
     * factura, con una diferencia de gramos que después no se puede rastrear.
     * Un valor así no es algo que haya que acomodar: es un dato que nadie miró.
     */
    const resultado = cantidadDelContrato('4.2401');
    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.motivo).toContain('4.2401');
    expect(resultado.motivo).toMatch(/no se redondea/i);
  });

  it('los ceros a la derecha no cuentan como precisión de más', () => {
    // 4.2400 tiene cuatro decimales escritos y tres significativos: entra.
    expect(cantidadDelContrato('4.2400').ok).toBe(true);
    // 4.2401 tiene cuatro significativos: no entra.
    expect(cantidadDelContrato('4.2401').ok).toBe(false);
  });

  it('lo que no es un número decimal tampoco pasa', () => {
    for (const malo of ['', '   ', 'cuatro', '4,240', '4.2.4', 'NaN', '1e3']) {
      expect(cantidadDelContrato(malo).ok, malo).toBe(false);
    }
  });

  it('normalizar dos veces da lo mismo: un reintento no cambia el cuerpo', () => {
    const primera = cantidadDelContrato('4.2400');
    expect(primera.ok).toBe(true);
    if (!primera.ok) return;
    expect(cantidadDelContrato(primera.quantity)).toEqual(primera);
  });

  it('acepta lo que entrega un Decimal, sin pasar por Number', () => {
    // Lo que llega de la base es un objeto con toString(), no una cadena.
    expect(cantidadDelContrato({ toString: () => '7.6650' })).toEqual({
      ok: true,
      quantity: '7.665',
    });
  });
});
