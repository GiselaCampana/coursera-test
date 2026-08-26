import { describe, it, expect } from 'vitest';
import { matchProduct, normalizeText, type ProductCandidate } from '@/lib/domain/matching';

/**
 * El orden en que un renglón de factura encuentra su PLU.
 *
 * Es una escalera del dato más confiable al menos confiable, y cada escalón
 * existe porque el anterior no siempre está:
 *
 *   1. El código de ESE proveedor, ya asociado a un PLU. Es una identificación.
 *   2. El alias o nombre ya aprendido.
 *   3. La descripción, y sólo si se parece mucho y a un solo artículo.
 *
 * Y cuando nada de eso alcanza, el renglón queda **sin asociar**. Asociarlo por
 * las dudas ensucia el costo de un artículo que nadie compró, y eso se arrastra
 * al precio de venta.
 *
 * Lo que estas pruebas fijan es el orden: que un escalón no le gane a otro más
 * confiable. Sin eso, una descripción parecida podría contradecir a un código
 * que el proveedor ya confirmó.
 */

const CREMOSO = 'cmt-cremoso';
const SARDO = 'cmt-sardo';
const ERRECALDE = 'sup-errecalde';
const OTRO_PROVEEDOR = 'sup-otro';

function catalogo(): ProductCandidate[] {
  return [
    {
      id: CREMOSO,
      internalCode: '1211',
      normalizedName: normalizeText('Cremoso Punta del Agua'),
      aliases: [
        {
          normalized: normalizeText('CREMOSO PUNTA DEL AGUA'),
          supplierId: ERRECALDE,
          supplierCode: 'ART-00228',
        },
      ],
    },
    {
      id: SARDO,
      internalCode: '2001',
      normalizedName: normalizeText('Queso Sardo bloque Melincué'),
      aliases: [
        {
          normalized: normalizeText('SARDO BLOQUE MELINCUE'),
          supplierId: ERRECALDE,
          supplierCode: 'ART-00758',
        },
      ],
    },
  ];
}

describe('cómo un renglón encuentra su PLU', () => {
  it('el código del proveedor gana, aunque la descripción diga otra cosa', () => {
    /*
     * El escalón más importante. Si Errecalde ya dijo que su ART-00228 es el
     * PLU 1211, no hay descripción que pueda contradecirlo: el OCR puede leer
     * cualquier cosa, y el código sigue siendo el código.
     */
    const resultado = matchProduct(
      {
        description: 'SARDO BLOQUE MELINCUE',
        supplierCode: 'ART-00228',
        supplierId: ERRECALDE,
      },
      catalogo(),
    );
    expect(resultado.method).toBe('SUPPLIER_CODE');
    expect(resultado.productId).toBe(CREMOSO);
  });

  it('el código se compara sin importar cómo lo separe cada sistema', () => {
    // "ART-00228", "art 00228" y "ART00228" son el mismo código.
    for (const escrito of ['art 00228', 'ART00228', 'Art.00228']) {
      const resultado = matchProduct(
        { description: 'lo que sea', supplierCode: escrito, supplierId: ERRECALDE },
        catalogo(),
      );
      expect(resultado.productId, `no reconoció «${escrito}»`).toBe(CREMOSO);
    }
  });

  it('pero los dígitos no se tocan: ART-00229 no es ART-00228', () => {
    const resultado = matchProduct(
      { description: 'algo', supplierCode: 'ART-00229', supplierId: ERRECALDE },
      catalogo(),
    );
    expect(resultado.method).not.toBe('SUPPLIER_CODE');
  });

  it('un código de otro proveedor no sirve', () => {
    /*
     * El mismo número puede ser el cremoso en un proveedor y una lata en otro.
     * Aceptarlo por el código suelto es exactamente cómo se cargaría la compra
     * al artículo equivocado.
     */
    const resultado = matchProduct(
      { description: 'algo que no se parece', supplierCode: 'ART-00228', supplierId: OTRO_PROVEEDOR },
      catalogo(),
    );
    expect(resultado.method).not.toBe('SUPPLIER_CODE');
    expect(resultado.productId).toBeNull();
  });

  it('sin código, entra por el alias exacto ya aprendido', () => {
    const resultado = matchProduct(
      { description: 'SARDO BLOQUE MELINCUE', supplierCode: null, supplierId: ERRECALDE },
      catalogo(),
    );
    expect(resultado.method).toBe('ALIAS');
    expect(resultado.productId).toBe(SARDO);
  });

  it('sin alias, entra por la descripción sólo si se parece mucho', () => {
    // Las mismas palabras en otro orden: el proveedor escribe el nombre al
    // revés, pero es el mismo artículo y no falta ni sobra nada.
    const resultado = matchProduct(
      { description: 'PUNTA DEL AGUA CREMOSO', supplierCode: null, supplierId: ERRECALDE },
      catalogo(),
    );
    expect(resultado.method).toBe('FUZZY');
    expect(resultado.productId).toBe(CREMOSO);
  });

  it('una palabra distinta ya no alcanza, y queda sin asociar', () => {
    /*
     * El umbral es deliberadamente exigente con las palabras completas. Es lo
     * que evita unir «jamón cocido» con «jamón crudo», que comparten casi todos
     * los caracteres y son dos artículos con dos precios.
     *
     * El costo de esta severidad es que un error de OCR adentro de una palabra
     * deja el renglón sin asociar y hay que elegirle el PLU a mano. Es el lado
     * barato de equivocarse: se ve y se corrige en la revisión, mientras que
     * una asociación equivocada ensucia el costo de un artículo sin avisar.
     */
    const resultado = matchProduct(
      { description: 'CREMOSO PUNTA DEL AGVA', supplierCode: null, supplierId: ERRECALDE },
      catalogo(),
    );
    expect(resultado.productId).toBeNull();
    // Pero se lo ofrece como candidato, que es lo que hace corta la corrección.
    expect(resultado.suggestions?.[0]?.productId).toBe(CREMOSO);
  });

  it('si no es inequívoco, queda sin asociar', () => {
    // Dos artículos que se parecen por igual: no lo resuelve la aplicación.
    const empatados: ProductCandidate[] = [
      { id: 'a', internalCode: '1', normalizedName: normalizeText('Sardo Melincue Bloque') },
      { id: 'b', internalCode: '2', normalizedName: normalizeText('Bloque Melincue Sardo') },
    ];
    const resultado = matchProduct(
      { description: 'MELINCUE BLOQUE SARDO', supplierCode: null, supplierId: ERRECALDE },
      empatados,
    );
    expect(resultado.productId).toBeNull();
    expect(resultado.reason).toContain('más de un producto');
    // Y se ofrecen los dos, para que los elija una persona.
    expect(resultado.suggestions?.length).toBeGreaterThanOrEqual(2);
  });

  it('lo que no se parece a nada queda sin asociar, no en el más cercano', () => {
    const resultado = matchProduct(
      { description: 'PAPEL FILM 30 CM', supplierCode: null, supplierId: ERRECALDE },
      catalogo(),
    );
    expect(resultado.productId).toBeNull();
    expect(resultado.method).toBe('NONE');
  });

  it('con el catálogo vacío no inventa ningún artículo', () => {
    /*
     * Compras no crea PLU a partir de una factura. Si el catálogo no está
     * cargado, el renglón queda sin asociar y se ve como tal.
     */
    const resultado = matchProduct(
      { description: 'CREMOSO PUNTA DEL AGUA', supplierCode: 'ART-00228', supplierId: ERRECALDE },
      [],
    );
    expect(resultado.productId).toBeNull();
    expect(resultado.reason).toContain('No hay productos cargados');
  });
});
