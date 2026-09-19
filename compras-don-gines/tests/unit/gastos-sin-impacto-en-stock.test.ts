import { describe, it, expect } from 'vitest';
import { clasificarRenglon, indicePorCodigo, type CodigoDeGasto } from '@/lib/domain/gastos';

/**
 * **Qué puede convertir un renglón en gasto, y qué no.**
 *
 * La factura de Ezra cobra tres bolsas para transportar la compra. Son plata
 * que se le debe y no son mercadería: no entran al stock, no tienen artículo.
 * Pero decidir eso mirando la palabra «BOLSA» sería atar el inventario a lo que
 * haya leído el OCR esa vez.
 *
 * Por eso lo único que clasifica es el **código** —una identificación que el
 * proveedor no cambia— o la decisión de una persona. Estas pruebas fijan las
 * dos cosas: que esos dos caminos funcionan, y que el texto no alcanza.
 */

const BOLSAS: CodigoDeGasto = {
  supplierCode: '4249',
  kind: 'EMBALAJE',
  unit: 'UNIT',
  label: 'Bolsas del transporte',
};
const CONFIGURADOS = indicePorCodigo([BOLSAS]);

describe('la descripción no clasifica', () => {
  it('un renglón que dice BOLSA GRANDE sin código configurado sigue siendo mercadería', () => {
    /*
     * La prueba negativa que sostiene todo lo demás. Si alguna vez alguien
     * agrega un `descripcion.includes('BOLSA')`, esto falla.
     */
    const clasificacion = clasificarRenglon(
      { description: 'BOLSA GRANDE', supplierCode: '7777' },
      CONFIGURADOS,
    );

    expect(clasificacion.kind).toBeNull();
    expect(clasificacion.origen).toBe('MERCADERIA');
  });

  it('tampoco clasifica sin ningún código, por más que el texto sea el mismo', () => {
    const clasificacion = clasificarRenglon(
      { description: 'BOLSA GRANDE', supplierCode: null },
      CONFIGURADOS,
    );

    expect(clasificacion.kind).toBeNull();
    expect(clasificacion.origen).toBe('MERCADERIA');
  });

  it('y un artículo de verdad que se llame parecido no se convierte en gasto', () => {
    /*
     * Existen bolsas que se compran para revender. Son mercadería, entran al
     * stock y tienen PLU. La diferencia con las del transporte no está en el
     * nombre: está en el código.
     */
    const clasificacion = clasificarRenglon(
      { description: 'BOLSAS DE POLIETILENO X 100 - PARA REVENTA', supplierCode: '1234' },
      CONFIGURADOS,
    );

    expect(clasificacion.kind).toBeNull();
  });
});

describe('lo que sí clasifica', () => {
  it('el código configurado, con su clase y su unidad', () => {
    const clasificacion = clasificarRenglon(
      { description: 'BOLSA GRANDE', supplierCode: '4249' },
      CONFIGURADOS,
    );

    expect(clasificacion.kind).toBe('EMBALAJE');
    expect(clasificacion.unit).toBe('UNIT');
    expect(clasificacion.label).toBe('Bolsas del transporte');
    expect(clasificacion.origen).toBe('CODIGO_CONFIGURADO');
  });

  it('el mismo código aunque la lectura lo separe distinto', () => {
    /*
     * Espacios, guiones y puntos son la forma de imprimirlo, no el código:
     * «ART-00228», «art 00228» y «ART00228» son el mismo artículo.
     */
    for (const leido of [' 4249', '4249 ', '4-249', '4.249']) {
      const clasificacion = clasificarRenglon({ supplierCode: leido }, CONFIGURADOS);
      expect(clasificacion.kind, leido).toBe('EMBALAJE');
    }
  });

  it('pero un dígito de más no es el mismo código, ni siquiera un cero', () => {
    /*
     * «04249» no se acepta como «4249», y está bien que no: los dígitos son la
     * identificación. Cualquier tolerancia ahí es un gasto clasificado —o una
     * compra cargada— contra algo que no es.
     */
    for (const otro of ['04249', '42490', '4248']) {
      const clasificacion = clasificarRenglon({ supplierCode: otro }, CONFIGURADOS);
      expect(clasificacion.kind, otro).toBeNull();
    }
  });

  it('y la decisión de una persona, que gana sobre la configuración', () => {
    /*
     * Una factura puede traer una excepción —el proveedor mandó bolsas para
     * revender con el mismo código— y quien la está mirando la ve.
     */
    const clasificacion = clasificarRenglon(
      { expenseKind: 'FLETE', supplierCode: '4249' },
      CONFIGURADOS,
    );

    expect(clasificacion.kind).toBe('FLETE');
    expect(clasificacion.origen).toBe('ELEGIDO_A_MANO');
  });

  it('sin configuración ni decisión, todo es mercadería', () => {
    const clasificacion = clasificarRenglon({ supplierCode: '47' }, new Map());
    expect(clasificacion.kind).toBeNull();
    expect(clasificacion.origen).toBe('MERCADERIA');
  });
});
