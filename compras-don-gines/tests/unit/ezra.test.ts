import { describe, it, expect } from 'vitest';
import { elegirAnalizador, analizadorEzra, analizadorLosCalvos } from '@/lib/ocr/parsers';
import { EZRA_FOTO } from '../fixtures/ezra-foto';
import { EZRA_ARTICULOS_IMPRESOS, EZRA_ENCABEZADO, EZRA_PIE } from '../fixtures/ezra';
import { Decimal } from '@/lib/money';

/**
 * La factura de Distribuidora Ezra, sobre el texto real de la foto.
 *
 * Todo lo que se afirma acá se afirma contra `EZRA_FOTO`, que es lo que salió
 * de Tesseract sobre la foto que sacó la usuaria, sin retocar. Probar el
 * analizador con una transcripción prolija no habría encontrado nada: el
 * corrimiento de columnas se reproduce igual con una transcripción perfecta,
 * pero el resto de los defectos —la marca leída como proveedor, la columna de
 * códigos cortada, la tabla desarmada en bloques— sólo existen en la foto.
 */

const analisis = analizadorEzra.analizar(EZRA_FOTO);

describe('a quién se le atribuye la factura de Ezra', () => {
  it('la toma el analizador de Ezra, no el de Los Calvos', () => {
    expect(elegirAnalizador(EZRA_FOTO).analizador.codigo).toBe('ezra');
  });

  it('«LOS CALVOS» dentro de la tabla ya no alcanza para reconocer al proveedor', () => {
    /*
     * Éste es el defecto que trajo la factura al proyecto. «LOS CALVOS» está en
     * el texto —es la marca del artículo 10, JAMON COCIDO MINI TRADICIONAL— y
     * antes eso bastaba para que el analizador de Los Calvos se quedara con el
     * comprobante, con 0,60 de puntaje. La factura quedaba atribuida al
     * proveedor equivocado, con su plazo de pago y sus tasas.
     */
    expect(EZRA_FOTO.completo).toContain('LOS CALVOS');
    expect(analizadorLosCalvos.reconoce(EZRA_FOTO)).toBe(0);
  });

  it('no reconoce a Ezra en una factura que sólo la nombra como marca', () => {
    // La simétrica: nadie puede quedarse con un comprobante ajeno por una marca.
    const ajena = {
      completo:
        'DISTRIBUCION ERRECALDE S.A.\nCUIT 30-71780890-4\n' +
        'Código Descripción Unid. Cantidad Precio Dto. IVA Subtotal\n' +
        'ART-00873 QUESO EZRA 8 39.2 kg $8.090,08 0% 21% $317.131,24\n',
      encabezado: 'DISTRIBUCION ERRECALDE S.A.\nCUIT 30-71780890-4',
      articulos: null,
      resumen: null,
    };
    expect(analizadorEzra.reconoce(ajena)).toBe(0);
  });
});

describe('el encabezado de la factura de Ezra', () => {
  it('recupera proveedor, CUIT, número y fecha', () => {
    expect(analisis.header?.supplierName).toBe(EZRA_ENCABEZADO.supplierName);
    expect(analisis.header?.cuit).toBe(EZRA_ENCABEZADO.cuit);
    expect(analisis.header?.letter).toBe('A');
    expect(analisis.header?.docType).toBe('FACTURA');
    expect(analisis.header?.issueDate).toBe(EZRA_ENCABEZADO.issueDate);
  });

  it('elige el número de ocho dígitos y no el de nueve', () => {
    /*
     * El recorte del encabezado da «00002-00000185» y la página completa
     * «00002-000001435», con un dígito de más. Un comprobante electrónico se
     * numera con ocho: quedarse con el de nueve haría que la próxima carga de
     * esta misma factura no se detectara como duplicada.
     */
    expect(EZRA_FOTO.completo).toContain('000001435');
    expect(analisis.header?.fullNumber).toBe(EZRA_ENCABEZADO.fullNumber);
  });
});

describe('los seis renglones de la factura de Ezra', () => {
  it('son seis, ni más ni menos', () => {
    expect(analisis.items).toHaveLength(6);
  });

  it('conserva los seis códigos de proveedor', () => {
    expect(analisis.items.map((i) => i.supplierCode)).toEqual([
      '47',
      '49',
      '48',
      '10',
      '2514',
      '4249',
    ]);
  });

  it('el kilaje no queda adentro del nombre', () => {
    /*
     * La marca del corrimiento. En este formato la cantidad va **antes** de la
     * descripción, y un analizador que la espera después se la come como parte
     * del texto: «4,240 Cremoso LA PAULINA La Paulina».
     */
    for (const item of analisis.items) {
      expect(item.description, `el renglón ${item.lineNumber}`).not.toMatch(/^\s*\d+[.,]\d{3}\s/);
    }
  });

  it('no repite la marca cuando la descripción ya la dice', () => {
    const cremoso = analisis.items.find((i) => i.supplierCode === '47')!;
    // «Cremoso LA PAULINA» con marca «La Paulina»: la marca no se agrega.
    expect(cremoso.description.toUpperCase()).toBe('CREMOSO LA PAULINA');
  });

  it('conserva la marca cuando es lo único que distingue dos artículos', () => {
    /*
     * En esta factura conviven JAMON COCIDO MINI TRADICIONAL de Los Calvos y
     * JAMON COCIDO MINI de Il Molise. Borrar la marca siempre dejaría dos
     * artículos de dos fabricantes con nombres casi iguales, y quien tenga que
     * asociarlos a su PLU no tendría con qué distinguirlos.
     */
    const losCalvos = analisis.items.find((i) => i.supplierCode === '10')!;
    const ilMolise = analisis.items.find((i) => i.supplierCode === '2514')!;
    expect(losCalvos.description.toUpperCase()).toContain('LOS CALVOS');
    expect(ilMolise.description.toUpperCase()).toContain('IL MOLISE');
    expect(losCalvos.description).not.toBe(ilMolise.description);
  });

  it.each(EZRA_ARTICULOS_IMPRESOS.map((a) => [a.codigo, a] as const))(
    'el renglón %s tiene cada columna en su lugar',
    (codigo, papel) => {
      const leido = analisis.items.find((i) => i.supplierCode === codigo);
      expect(leido, `falta el renglón ${codigo}`).toBeDefined();

      // Cantidad: la columna que antes se perdía adentro del nombre.
      expect(new Decimal(leido!.quantity!).toString()).toBe(new Decimal(papel.cantidad).toString());
      /*
       * Precio: el CON descuento, que es el que se pagó, no el de lista.
       *
       * Se admite una milésima de diferencia, y hay exactamente un renglón que
       * la usa: el 48. El papel dice 8.267,696 y el OCR lo perdió en las dos
       * pasadas —«8.267,596» en una y «8.267,69», truncado, en la otra—, así
       * que ese número no se puede recuperar de esta foto. Lo que se guarda es
       * el cociente importe ÷ cantidad, que sale de dos columnas que sí se
       * leyeron y reproduce el importe impreso exacto. Los otros cinco salen
       * idénticos al papel, y eso se afirma aparte.
       */
      expect(
        new Decimal(leido!.unitNetPrice!).minus(papel.precioConDescuento).abs().lte('0.001'),
        `precio ${leido!.unitNetPrice} contra ${papel.precioConDescuento} del papel`,
      ).toBe(true);
      // Importe: con los tres decimales del papel.
      expect(new Decimal(leido!.grossSubtotal!).toString()).toBe(
        new Decimal(papel.subtotal).toString(),
      );
      /*
       * Descuento: cero en el renglón que va al costeo, a propósito.
       *
       * En este formato el descuento ya está aplicado —P.U.Desc. es P.Unit
       * menos el porcentaje, y el importe es cantidad × P.U.Desc.—, así que
       * cargarlo otra vez lo restaría dos veces. Que se haya leído bien se
       * comprueba en «el descuento leído explica el precio», más abajo.
       */
      expect(leido!.discountPct).toBe('0');
    },
  );

  it('cinco de los seis precios salen idénticos al papel, y el sexto es el que rompió el OCR', () => {
    /*
     * Deja constancia de cuál es la excepción y por qué, para que se note si
     * mañana son dos. El precio del 48 no está mal leído por el analizador: no
     * está en el texto. Que el renglón entre igual, con el importe impreso
     * exacto y el precio a una milésima, es lo que evita perder $60.726,232 de
     * mercadería por un dígito.
     */
    const exactos = EZRA_ARTICULOS_IMPRESOS.filter((papel) => {
      const leido = analisis.items.find((i) => i.supplierCode === papel.codigo)!;
      return new Decimal(leido.unitNetPrice!).eq(papel.precioConDescuento);
    });
    expect(exactos.map((a) => a.codigo)).toEqual(['47', '49', '10', '2514', '4249']);

    expect(EZRA_FOTO.articulos).toContain('8.267,69');
    expect(EZRA_FOTO.completo).toContain('8.267,596');
    expect(EZRA_FOTO.completo).not.toContain('8.267,696');
  });

  it('en cada renglón, cantidad × precio con descuento da el importe', () => {
    for (const item of analisis.items) {
      const cantidad = new Decimal(item.quantity!);
      const precio = new Decimal(item.unitNetPrice!);
      const importe = new Decimal(item.grossSubtotal!);
      expect(
        cantidad.times(precio).minus(importe).abs().lte('0.01'),
        `${item.description}: ${cantidad} × ${precio} = ${cantidad.times(precio)} contra ${importe}`,
      ).toBe(true);
    }
  });

  it('el precio de lista nunca entra como costo', () => {
    /*
     * P.Unit es el precio de lista y P.U.Desc. el que se pagó. Cargar el de
     * lista como costo infla el costo de cada artículo entre un 2 % y un 5 %, y
     * de ahí sale el precio de venta.
     */
    for (const papel of EZRA_ARTICULOS_IMPRESOS) {
      const leido = analisis.items.find((i) => i.supplierCode === papel.codigo)!;
      if (papel.precioUnitario === papel.precioConDescuento) continue;
      expect(new Decimal(leido.unitNetPrice!).toString()).not.toBe(
        new Decimal(papel.precioUnitario).toString(),
      );
    }
  });

  it('no supone la unidad de ningún renglón', () => {
    /*
     * La columna «Cantidad» imprime «3,000» para tres bolsas igual que imprime
     * «4,240» para cuatro kilos y pico de cremoso: el papel no los distingue.
     * La unidad la sabe el catálogo, a través del producto asociado, y hasta
     * que el renglón se asocie queda sin resolver.
     */
    expect(analisis.items.every((i) => i.unit === null)).toBe(true);
  });
});

describe('el pie de la factura de Ezra', () => {
  it('recupera neto, IVA y total', () => {
    expect(analisis.summary?.netTotal).toBe(new Decimal(EZRA_PIE.netTotal).toString());
    expect(analisis.summary?.ivaTotal).toBe(new Decimal(EZRA_PIE.iva21).toString());
    expect(analisis.summary?.total).toBe(new Decimal(EZRA_PIE.total).toString());
  });

  it('lee el IVA aunque el OCR escriba el punto donde va la coma', () => {
    // El papel dice «46.491,66» y la foto salió «46.491.66».
    expect(EZRA_FOTO.resumen).toContain('46.491.66');
    expect(new Decimal(analisis.summary!.ivaTotal!).toFixed(2)).toBe('46491.66');
  });

  it('el neto más el IVA dan el total impreso', () => {
    const neto = new Decimal(analisis.summary!.netTotal!);
    const iva = new Decimal(analisis.summary!.ivaTotal!);
    expect(neto.plus(iva).toFixed(2)).toBe(new Decimal(EZRA_PIE.total).toFixed(2));
  });
});

describe('la factura cierra contra el papel', () => {
  it('los seis importes suman el neto impreso, truncado a dos decimales', () => {
    /*
     * Los importes se imprimen con tres decimales y el pie con dos, y el neto
     * es la suma **truncada**: 221.388,847 → 221.388,84. Redondeada daría
     * 221.388,85 y cada factura de este proveedor quedaría con un centavo de
     * diferencia.
     */
    const suma = analisis.items.reduce(
      (acc, i) => acc.plus(new Decimal(i.grossSubtotal!)),
      new Decimal(0),
    );
    expect(suma.toFixed(3)).toBe('221388.847');
    expect(suma.toDecimalPlaces(2, Decimal.ROUND_DOWN).toFixed(2)).toBe('221388.84');
    expect(analisis.summary!.netTotal).toBe(new Decimal(EZRA_PIE.netTotal).toString());
  });

  it('no deja ninguna observación de renglones que falten o sobren', () => {
    const sobreLaSuma = analisis.observaciones.filter((o) => /faltan o sobran renglones/.test(o));
    expect(sobreLaSuma).toEqual([]);
  });
});

describe('el descuento por renglón', () => {
  it('se lee, y explica el precio con descuento a partir del de lista', () => {
    /*
     * No entra al costeo —el importe ya viene neto— pero sí se lee, y es una de
     * las dos identidades que anclan la fila: si el porcentaje no explicara la
     * diferencia entre las dos columnas de precio, sería que los números no
     * cayeron donde se cree.
     */
    for (const papel of EZRA_ARTICULOS_IMPRESOS) {
      const lista = new Decimal(papel.precioUnitario);
      const pct = new Decimal(papel.descuentoPct);
      const conDescuento = new Decimal(papel.precioConDescuento);
      expect(
        lista.times(new Decimal(1).minus(pct.div(100))).minus(conDescuento).abs().lte('0.001'),
        `${papel.codigo}: ${lista} − ${pct}% no da ${conDescuento}`,
      ).toBe(true);
    }
  });

  it('el pie no imprime descuento porque ya está dentro de cada importe', () => {
    expect(new Decimal(EZRA_PIE.discountTotal).isZero()).toBe(true);
    const suma = analisis.items.reduce(
      (acc, i) => acc.plus(new Decimal(i.grossSubtotal!)),
      new Decimal(0),
    );
    // La suma de los importes, ya con los descuentos adentro, es el neto.
    expect(suma.toDecimalPlaces(2, Decimal.ROUND_DOWN).toFixed(2)).toBe(
      new Decimal(EZRA_PIE.netTotal).toFixed(2),
    );
  });
});
