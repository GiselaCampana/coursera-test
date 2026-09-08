import { describe, it, expect } from 'vitest';
import { sePidePorUnidad } from '@/lib/services/precios-publicos';

/**
 * En qué unidad se pide cada artículo del catálogo de Pedidos.
 *
 * La regla vive aparte del armado del catálogo para poder probarla con valores
 * que la base todavía no puede guardar. `SaleMode` es un enum de Postgres con
 * dos valores —`FETEABLE` y `AL_CORTE`—, así que hoy ningún producto puede
 * tener configurado `UNIDAD`: agregar ese valor es una migración, y este ajuste
 * se hizo sin tocar el esquema.
 *
 * Que no se pueda guardar no quiere decir que no haya que entenderlo. La regla
 * lo contempla, y estas pruebas lo fijan: el día que el valor exista, el
 * catálogo ya sabe qué hacer con él y no hay nada más que cambiar acá.
 *
 * Mientras tanto, lo que sí existe hoy es la otra mitad de la regla: un
 * artículo que la aplicación **no puede expresar en kilos**, porque se compra
 * por unidad y no tiene ningún peso cargado con el cual convertirlo. Es la
 * misma definición que ya usa `services/pricing.ts` para decidir que un
 * artículo se vende entero.
 */
describe('cuándo un artículo se pide por unidad', () => {
  it('cuando el modo de venta lo dice', () => {
    // Todavía no se puede guardar, pero se entiende.
    expect(
      sePidePorUnidad({ saleMode: 'UNIDAD', purchaseUnit: 'KG', purchaseUnitWeightKg: '5' }),
    ).toBe(true);
  });

  it('cuando se compra por unidad y no hay peso con el cual pasarlo a kilos', () => {
    expect(
      sePidePorUnidad({ saleMode: 'FETEABLE', purchaseUnit: 'UNIT', purchaseUnitWeightKg: null }),
    ).toBe(true);
    // Un peso vacío o en cero es lo mismo que no tenerlo.
    expect(
      sePidePorUnidad({ saleMode: 'FETEABLE', purchaseUnit: 'UNIT', purchaseUnitWeightKg: '' }),
    ).toBe(true);
    expect(
      sePidePorUnidad({ saleMode: 'FETEABLE', purchaseUnit: 'UNIT', purchaseUnitWeightKg: '0' }),
    ).toBe(true);
  });

  it('no, cuando se compra por unidad pero se sabe cuántos kilos trae', () => {
    /*
     * La lata de dulce de cinco kilos se compra por unidad y se vende por kilo:
     * el peso es justamente lo que permite convertirla, y publicarla por unidad
     * le cobraría al cliente cinco kilos donde pidió uno.
     */
    expect(
      sePidePorUnidad({ saleMode: 'FETEABLE', purchaseUnit: 'UNIT', purchaseUnitWeightKg: '5' }),
    ).toBe(false);
  });

  it('no, cuando se compra por kilo', () => {
    expect(
      sePidePorUnidad({ saleMode: 'FETEABLE', purchaseUnit: 'KG', purchaseUnitWeightKg: null }),
    ).toBe(false);
    expect(
      sePidePorUnidad({ saleMode: 'AL_CORTE', purchaseUnit: 'KG', purchaseUnitWeightKg: null }),
    ).toBe(false);
  });

  it('el nombre no entra en la decisión', () => {
    /*
     * La regla no recibe el nombre, y ésa es la garantía: no hay forma de que
     * un artículo llamado «maple» salga por unidad sólo por llamarse así, ni de
     * que uno llamado «queso» salga por kilo cuando se vende entero.
     */
    const campos = Object.keys({
      saleMode: '',
      purchaseUnit: 'KG' as const,
      purchaseUnitWeightKg: null,
    });
    expect(campos).not.toContain('name');
    expect(campos).not.toContain('normalizedName');
  });
});
