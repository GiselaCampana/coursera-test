import { describe, it, expect } from 'vitest';
import {
  encontrarFilaDeTitulos,
  filasDeDatos,
  huellaDeEstructura,
  limitesDeColumnas,
  repartirEnColumnas,
} from '@/lib/ocr/motor/tabla';

/**
 * La reconstrucción espacial de la tabla.
 *
 * El motor general no puede contar columnas: en cuanto el OCR mete basura entre
 * dos celdas, el conteo se corre y todo lo que sigue queda mal. Lo que sí se
 * conserva es la **posición horizontal**, porque el lector corre Tesseract con
 * `preserve_interword_spaces`.
 *
 * Las dos estructuras que se usan acá son las de Ezra y Barraza, y están para
 * probar lo contrario de lo que parece: que el motor las resuelve **sin saber de
 * quién son**. Ninguna prueba mira el nombre del proveedor.
 */

/** Ezra: la cantidad va antes de la descripción, y hay dos precios. */
const ESTRUCTURA_A = `Codigo Cantidad               Descripción           Marca      P.Unit Desc.% P.U.Desc. Importe
47      4,240  Cremoso    LA PAULINA          La Paulina    6.723,279  5,000   6.387,115  27.081,371
49      3,985  PERNIL PATA CELESTE MINI 1284  GALAICO       4.040,189  5,000   3.838,180  15.295,149
PESOS : DOSCIENTOS       SUB-TOTAL : 221.388,84`;

/** Barraza: kilos y piezas en columnas separadas, las dos antes del nombre. */
const ESTRUCTURA_B = `Cod    Cantidad  Unidades  Descripcion                  Pr Unit    Bonifi   Importe
03        27.00      9.00  CIL MUZZA BARRAZA X 3 KG    10,361.45   16.00  234,997.69
30        30.00      3.00  PLAN MUZZA BARRAZA X 10 KG   9,453.76   16.00  238,234.75
Total Kgs.   57.00`;

describe('encontrar la fila de títulos', () => {
  it('resuelve las ocho columnas de una estructura con la cantidad adelante', () => {
    const titulos = encontrarFilaDeTitulos(ESTRUCTURA_A);
    expect(titulos).not.toBeNull();
    expect(titulos!.columnas.map((c) => c?.campo ?? null)).toEqual([
      'codigo',
      'cantidad',
      'descripcion',
      'marca',
      'precioUnitario',
      'descuentoPct',
      'precioConDescuento',
      'importe',
    ]);
  });

  it('resuelve las siete de una estructura con kilos y piezas separados', () => {
    const titulos = encontrarFilaDeTitulos(ESTRUCTURA_B);
    expect(titulos!.columnas.map((c) => c?.campo ?? null)).toEqual([
      'codigo',
      'cantidad',
      'piezas',
      'descripcion',
      'precioUnitario',
      'descuentoPct',
      'importe',
    ]);
  });

  it('elige la partición que entiende más, no una convención fija', () => {
    /*
     * En la estructura A los títulos van con **un solo espacio** entre ellos
     * —«P.Unit Desc.% P.U.Desc. Importe»— y la partición ancha los deja a los
     * cuatro en una celda. En la B, la partición fina rompería «Pr Unit» al
     * medio. Ninguna convención sirve para las dos: se generan las dos lecturas
     * y decide cuántos campos reconoce cada una.
     */
    expect(encontrarFilaDeTitulos(ESTRUCTURA_A)!.celdas).toHaveLength(8);
    expect(encontrarFilaDeTitulos(ESTRUCTURA_B)!.celdas).toHaveLength(7);
  });

  it('devuelve null cuando no hay tabla, en vez de inventar una', () => {
    const sinTabla = 'ACME S.A.\nCUIT 30-11111111-1\nGracias por su compra\n';
    expect(encontrarFilaDeTitulos(sinTabla)).toBeNull();
  });

  it('no toma una fila de datos por encabezado', () => {
    const empiezaConDatos = '03  27.00  9.00  CIL MUZZA X 3 KG  10,361.45\nCod Cantidad Descripcion Importe\n';
    expect(encontrarFilaDeTitulos(empiezaConDatos)!.linea).toBe(1);
  });
});

describe('repartir una fila entre las columnas', () => {
  it('cada celda cae en su columna, con el orden que tenga la tabla', () => {
    const titulos = encontrarFilaDeTitulos(ESTRUCTURA_B)!;
    const filas = filasDeDatos(ESTRUCTURA_B, titulos);

    expect(filas).toHaveLength(2);
    expect(filas[0].celdas.map((c) => c?.texto ?? null)).toEqual([
      '03',
      '27.00',
      '9.00',
      'CIL MUZZA BARRAZA X 3 KG',
      '10,361.45',
      '16.00',
      '234,997.69',
    ]);
  });

  it('corta al llegar al pie', () => {
    // «Total Kgs.» y «PESOS :» son del pie: sus números son grandes y creíbles,
    // y repartidos entre columnas se parecen a un renglón.
    expect(filasDeDatos(ESTRUCTURA_B, encontrarFilaDeTitulos(ESTRUCTURA_B)!)).toHaveLength(2);
    expect(filasDeDatos(ESTRUCTURA_A, encontrarFilaDeTitulos(ESTRUCTURA_A)!)).toHaveLength(2);
  });

  it('lo que no cae en ninguna columna se devuelve aparte y no se reparte', () => {
    /*
     * Guardar el sobrante en vez de meterlo en la columna más cercana es lo que
     * después permite darse cuenta de que ese número era de otra fila. En la
     * factura de Lácteos Barraza, el precio del segundo renglón aparece al final
     * de la línea del primero.
     */
    const limites = limitesDeColumnas(encontrarFilaDeTitulos(ESTRUCTURA_B)!.celdas);
    const { sobrantes } = repartirEnColumnas(
      '03        27.00      9.00  CIL MUZZA BARRAZA X 3 KG    10,361.45   16.00  234,997.69      9453.76',
      limites.slice(0, -1).concat([{ desde: limites[6].desde, hasta: limites[6].desde + 12 }]),
    );
    expect(sobrantes.map((s) => s.texto)).toContain('9453.76');
  });

  it('junta los tramos que caen en la misma columna', () => {
    // Una descripción de varias palabras separada por dos espacios es una sola
    // celda, no tres.
    const titulos = encontrarFilaDeTitulos(ESTRUCTURA_A)!;
    const filas = filasDeDatos(ESTRUCTURA_A, titulos);
    const descripcion = filas[1].celdas[2]?.texto ?? '';
    expect(descripcion).toBe('PERNIL PATA CELESTE MINI 1284');
  });
});

describe('la huella de la estructura', () => {
  it('describe el formato y nada del contenido', () => {
    /*
     * Ésta es la prueba de que el motor no es un analizador específico
     * disfrazado. La huella no puede llevar razón social, CUIT, nombres de
     * artículos, cantidades ni importes: sólo los campos reconocidos y sus
     * posiciones relativas.
     */
    const huella = huellaDeEstructura(encontrarFilaDeTitulos(ESTRUCTURA_A)!);

    expect(huella).toContain('codigo@');
    expect(huella).toContain('cantidad@');
    expect(huella).toContain('precioConDescuento@');

    for (const contenido of [
      'Cremoso',
      'PAULINA',
      'PERNIL',
      '4,240',
      '6.723',
      '27.081',
      '221.388',
      'GALAICO',
    ]) {
      expect(huella, `la huella no puede contener «${contenido}»`).not.toContain(contenido);
    }
  });

  it('dos estructuras distintas tienen huellas distintas', () => {
    expect(huellaDeEstructura(encontrarFilaDeTitulos(ESTRUCTURA_A)!)).not.toBe(
      huellaDeEstructura(encontrarFilaDeTitulos(ESTRUCTURA_B)!),
    );
  });

  it('la misma estructura con otro contenido tiene la misma huella', () => {
    /*
     * Lo que hace que un perfil guardado sirva para la factura siguiente: dos
     * comprobantes del mismo formato, con artículos, importes y hasta emisor
     * distintos, tienen que dar la misma huella.
     */
    const otroContenido = ESTRUCTURA_A.replace(
      /47      4,240  Cremoso    LA PAULINA          La Paulina    6\.723,279  5,000   6\.387,115  27\.081,371/,
      '88      1,500  Provolone  OTRA MARCA          Otra Marca    2.000,000  3,000   1.940,000   2.910,000',
    );
    expect(huellaDeEstructura(encontrarFilaDeTitulos(otroContenido)!)).toBe(
      huellaDeEstructura(encontrarFilaDeTitulos(ESTRUCTURA_A)!),
    );
  });

  it('tolera un corrimiento chico de la impresión', () => {
    // Las posiciones van en décimos del ancho a propósito: dos fotos de la
    // misma factura no dan exactamente los mismos desplazamientos.
    const corrida = ESTRUCTURA_A.split('\n')
      .map((l, i) => (i === 0 ? l.replace('Codigo', ' Codigo') : l))
      .join('\n');
    expect(huellaDeEstructura(encontrarFilaDeTitulos(corrida)!)).toBe(
      huellaDeEstructura(encontrarFilaDeTitulos(ESTRUCTURA_A)!),
    );
  });
});
