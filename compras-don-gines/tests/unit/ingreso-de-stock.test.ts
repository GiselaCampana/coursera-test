import { describe, it, expect } from 'vitest';
import {
  planDeIngresos,
  claveDelEvento,
  DIRECCION_DE_COMPRA,
  DIRECCION_DEL_CONTRATO,
  MOTIVO_DEL_CONTRATO,
  VERSION_DEL_CONTRATO,
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
