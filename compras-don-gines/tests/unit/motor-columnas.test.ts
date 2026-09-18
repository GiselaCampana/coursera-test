import { describe, it, expect } from 'vitest';
import {
  esFilaDeEncabezados,
  faltanCamposEsenciales,
  normalizarEncabezado,
  reconocerColumna,
  reconocerColumnas,
  type CampoDeColumna,
} from '@/lib/ocr/motor/columnas';

/**
 * El vocabulario semántico de columnas, contra las cinco facturas reales.
 *
 * Lo que se prueba acá es la premisa del motor general: que **el orden de las
 * columnas no importa** si se sabe qué es cada una. Las cinco facturas del
 * banco imprimen la misma información en cinco órdenes distintos, y hasta ahora
 * cada una necesitó un analizador propio en el repositorio.
 *
 * Ninguna de estas pruebas menciona un proveedor para decidir nada: los nombres
 * están sólo para saber de dónde salió cada encabezado.
 */

/** Los campos reconocidos de una fila, en orden, con `—` donde no se reconoció. */
function campos(encabezados: string[]): string[] {
  return reconocerColumnas(encabezados).map((c) => c?.campo ?? '—');
}

describe('reconocer una columna por su encabezado', () => {
  it.each([
    ['Código', 'codigo'],
    ['Cod', 'codigo'],
    ['Codigo Art.', 'codigo'],
    ['Descripcion', 'descripcion'],
    ['Detalle', 'descripcion'],
    ['Marca', 'marca'],
    ['Cantidad', 'cantidad'],
    ['Cant', 'cantidad'],
    ['Kilos', 'kilos'],
    ['Kg', 'kilos'],
    ['Unidades', 'piezas'],
    ['Unid.', 'piezas'],
    ['Piezas', 'piezas'],
    ['Pza.', 'piezas'],
    ['Importe', 'importe'],
    ['Subtotal', 'importe'],
  ] as [string, CampoDeColumna][])('«%s» es %s', (encabezado, esperado) => {
    expect(reconocerColumna(encabezado)?.campo).toBe(esperado);
  });

  it('distingue los tres precios que un comprobante puede imprimir', () => {
    /*
     * Es la distinción que rompió la factura de Ezra: tiene «P.Unit» y
     * «P.U.Desc.», y cargar el primero como costo infla el costo de cada
     * artículo entre un 2 % y un 5 %.
     */
    expect(reconocerColumna('P.Unit')?.campo).toBe('precioUnitario');
    expect(reconocerColumna('Pr Unit')?.campo).toBe('precioUnitario');
    expect(reconocerColumna('Precio')?.campo).toBe('precioUnitario');
    expect(reconocerColumna('P.U.Desc.')?.campo).toBe('precioConDescuento');
    expect(reconocerColumna('Precio c/Desc')?.campo).toBe('precioConDescuento');
    expect(reconocerColumna('Desc.%')?.campo).toBe('descuentoPct');
    expect(reconocerColumna('Bonifi')?.campo).toBe('descuentoPct');
    expect(reconocerColumna('Dto.')?.campo).toBe('descuentoPct');
  });

  it('reconoce para descartar lo que no es del costo', () => {
    /*
     * «Sugerido» es el precio de venta que sugiere el proveedor. No es el costo
     * ni el importe. Reconocerlo y descartarlo es mejor que ignorarlo: una
     * columna sin reconocer baja la confianza de la tabla, y ésta sí se
     * entiende —lo que pasa es que no se usa—.
     */
    expect(reconocerColumna('Sugerido')?.campo).toBe('ignorada');
  });

  it('no reconoce lo que no sabe, en vez de adivinar', () => {
    expect(reconocerColumna('Zona')).toBeNull();
    expect(reconocerColumna('')).toBeNull();
    expect(reconocerColumna('xyz')).toBeNull();
  });

  it('lee igual con las tildes y la puntuación que el OCR se come', () => {
    expect(normalizarEncabezado('Descripción')).toBe('descripcion');
    expect(normalizarEncabezado('P.U.Desc.')).toBe('p u desc');
    expect(reconocerColumna('Descripcion')?.campo).toBe('descripcion');
    expect(reconocerColumna('DESCRIPCION')?.campo).toBe('descripcion');
  });
});

describe('las cinco facturas del banco, con sus cinco órdenes distintos', () => {
  it('Errecalde: la cantidad va después de la descripción', () => {
    expect(campos(['Código', 'Descripción', 'Unid.', 'Cantidad', 'Precio', 'Dto.', 'IVA', 'Subtotal'])).toEqual([
      'codigo', 'descripcion', 'piezas', 'cantidad', 'precioUnitario', 'descuentoPct', 'ivaPct', 'importe',
    ]);
  });

  it('Mabelherdi: trae una columna que hay que descartar y otra ambigua', () => {
    /*
     * «Sugerido» se reconoce para descartarlo. «Desc», en cambio, queda sin
     * reconocer **a propósito**: a secas puede ser descripción o descuento, y
     * las dos aparecen en comprobantes reales. Acá es descuento; en otro
     * formato sería el nombre del artículo.
     *
     * No adivinar es la conducta correcta y es exactamente el caso que la
     * revisión de estructura existe para resolver: la primera factura la mira
     * una persona, elige qué es esa columna, y el perfil guardado hace que la
     * siguiente entre sola. Adivinar por mayoría estadística cargaría el
     * porcentaje de descuento como nombre —o al revés— en el formato en que la
     * mayoría se equivoca.
     */
    expect(campos(['Codigo Art.', 'Descripcion', 'Desc', 'Cantidad', 'Sugerido', 'Pr Unit', 'Importe'])).toEqual([
      'codigo', 'descripcion', '—', 'cantidad', 'ignorada', 'precioUnitario', 'importe',
    ]);
  });

  it('una columna sin reconocer no impide interpretar si no es esencial', () => {
    // La de Mabelherdi tiene descripción, cantidad e importe: alcanza para
    // interpretar, con la columna ambigua señalada para que la resuelva una
    // persona.
    const columnas = reconocerColumnas([
      'Codigo Art.', 'Descripcion', 'Desc', 'Cantidad', 'Sugerido', 'Pr Unit', 'Importe',
    ]);
    expect(faltanCamposEsenciales(columnas)).toEqual([]);
    expect(columnas.filter((c) => c === null)).toHaveLength(1);
  });

  it('Los Calvos: la cantidad son kilos y lo dice', () => {
    expect(campos(['Cod', 'Descripción', 'Kg', 'Precio', 'Bonif %', 'Importe'])).toEqual([
      'codigo', 'descripcion', 'kilos', 'precioUnitario', 'descuentoPct', 'importe',
    ]);
  });

  it('Ezra: la cantidad va ANTES de la descripción, y hay dos precios', () => {
    /*
     * Éste es el orden que rompió el analizador genérico: al buscar las
     * columnas numéricas al final de la línea, la cantidad quedaba pegada al
     * nombre y las otras cuatro se corrían un lugar.
     */
    expect(campos(['Codigo', 'Cantidad', 'Descripción', 'Marca', 'P.Unit', 'Desc.%', 'P.U.Desc.', 'Importe'])).toEqual([
      'codigo', 'cantidad', 'descripcion', 'marca', 'precioUnitario', 'descuentoPct', 'precioConDescuento', 'importe',
    ]);
  });

  it('Barraza: kilos y piezas en columnas separadas, las dos antes del nombre', () => {
    expect(campos(['Cod', 'Cantidad', 'Unidades', 'Descripcion', 'Pr Unit', 'Bonifi', 'Importe'])).toEqual([
      'codigo', 'cantidad', 'piezas', 'descripcion', 'precioUnitario', 'descuentoPct', 'importe',
    ]);
  });

  it('el mismo campo no puede reclamarse dos veces', () => {
    /*
     * Si dos columnas reclaman el mismo campo, se queda la de mayor confianza y
     * la otra queda sin reconocer. Eso baja la confianza de la tabla y la manda
     * a revisión, que es lo correcto: elegir en silencio dejaría dos columnas
     * distintas cargadas en el mismo lugar.
     */
    const leidos = campos(['Kilos', 'Kg', 'Descripcion', 'Importe']);
    expect(leidos.filter((c) => c === 'kilos')).toHaveLength(1);
    expect(leidos).toContain('—');
  });
});

describe('encontrar la fila de títulos', () => {
  it('la reconoce con tres campos o más', () => {
    expect(esFilaDeEncabezados(['Cod', 'Descripcion', 'Cantidad', 'Importe'])).toBe(true);
    expect(esFilaDeEncabezados(['Codigo', 'Cantidad', 'Descripción', 'Marca', 'P.Unit'])).toBe(true);
  });

  it('no confunde una fila de datos con el encabezado', () => {
    /*
     * Con un umbral de dos, un artículo que se llame «CAJA PRECIO ESPECIAL» se
     * haría pasar por fila de títulos y la tabla empezaría en el lugar
     * equivocado.
     */
    expect(esFilaDeEncabezados(['03', '27.00', '9.00', 'CIL MUZZA BARRAZA X 3 KG'])).toBe(false);
    expect(esFilaDeEncabezados(['1001', 'CAJA PRECIO ESPECIAL', '16,10'])).toBe(false);
  });

  it('no toma por encabezado una línea del pie', () => {
    expect(esFilaDeEncabezados(['Subtotal', '473.232,44'])).toBe(false);
    expect(esFilaDeEncabezados(['Total Kgs.', '57.00'])).toBe(false);
  });
});

describe('los campos mínimos para no adivinar', () => {
  it('sin descripción, sin cantidad o sin importe, la tabla no alcanza', () => {
    expect(faltanCamposEsenciales(reconocerColumnas(['Cod', 'Cantidad', 'Importe']))).toEqual([
      'descripcion',
    ]);
    expect(faltanCamposEsenciales(reconocerColumnas(['Cod', 'Descripcion', 'Importe']))).toEqual([
      'cantidad',
    ]);
    expect(faltanCamposEsenciales(reconocerColumnas(['Cod', 'Descripcion', 'Cantidad']))).toEqual([
      'importe',
    ]);
  });

  it('cualquiera de las tres cantidades alcanza', () => {
    // Kilos, piezas o una cantidad sin especificar: las tres sirven.
    for (const cantidad of ['Cantidad', 'Kilos', 'Unidades']) {
      expect(
        faltanCamposEsenciales(reconocerColumnas(['Descripcion', cantidad, 'Importe'])),
      ).toEqual([]);
    }
  });

  it('el precio no es esencial: se deduce del importe y la cantidad', () => {
    expect(
      faltanCamposEsenciales(reconocerColumnas(['Cod', 'Descripcion', 'Cantidad', 'Importe'])),
    ).toEqual([]);
  });
});
