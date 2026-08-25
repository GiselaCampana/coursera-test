import { describe, it, expect } from 'vitest';
import {
  bordeInferiorDeLaTabla,
  columnasNumericas,
  detectarRegiones,
  pareceFilaDeArticulo,
  pareceRenglonDePie,
  type LineaOcr,
  type RegionesDetectadas,
} from '@/lib/cliente/ocr/regiones';

/**
 * Ubicación de las zonas del comprobante.
 *
 * Todo lo que se prueba acá salió de una foto real que fallaba: las líneas son
 * las que devolvió Tesseract sobre la factura de Errecalde, con su basura.
 */

function linea(texto: string, y0 = 0, y1 = 20): LineaOcr {
  return { texto, confianza: 0.9, caja: { x0: 0, y0, x1: 1000, y1 } };
}

describe('cuántos números tiene un renglón', () => {
  it('los cuenta aunque las columnas vengan pegadas por un solo espacio', () => {
    // Así llega una fila en una foto: sin espacios anchos entre las columnas de
    // la derecha y con un guión largo suelto de la línea de la tabla. Partiendo
    // por espacios anchos, todo eso queda en una sola columna que no es número,
    // y el renglón entero pasaba por no numérico.
    const texto = 'ART-00177 CAYFAR LATA BATATA   6   6 $965963 0% 21% — $57957,76';
    expect(columnasNumericas(texto)).toBeGreaterThanOrEqual(4);
    expect(pareceFilaDeArticulo(linea(texto))).toBe(true);
  });

  it('reconoce las filas con separación ancha, como salen de un escaneo', () => {
    const texto = 'ART-00873 BARRA DANBO PUNTA DE AGUA    8    39.2 kg    $8.090,08   0%   21%   $317.131,24';
    expect(pareceFilaDeArticulo(linea(texto))).toBe(true);
  });

  it('no toma por números las cosas del encabezado', () => {
    expect(columnasNumericas('IIBB 30-71780890-4')).toBeLessThan(3);
    expect(columnasNumericas('Inicio Act. 01/01/2023')).toBeLessThan(3);
    expect(pareceFilaDeArticulo(linea('CUIT 30717808904'))).toBe(false);
  });
});

describe('renglones del pie', () => {
  it('reconoce una etiqueta con un solo importe', () => {
    expect(pareceRenglonDePie(linea('Neto Gravado        $3.830.467,37'))).toBe(true);
    expect(pareceRenglonDePie(linea('TOTAL       $4.816.812,73'))).toBe(true);
    expect(pareceRenglonDePie(linea('Percepcion IVA RG 5329    $114.914,02'))).toBe(true);
  });

  it('no toma por pie una fila de artículo con cuatro importes', () => {
    // Si la tomara, la banda del resumen arrancaría en medio de la tabla y los
    // últimos artículos no los leería nadie. Pasó.
    const fila = 'ART-02174 PERNIL TERMOLI  40  156.3 kg $3.847,48 0% 21% $601.361,45';
    expect(pareceRenglonDePie(linea(fila))).toBe(false);
  });
});

describe('reparto de la página en zonas', () => {
  const filas = Array.from({ length: 10 }, (_, i) =>
    linea(
      `ART-0${1000 + i} ARTICULO NUMERO ${i}   3   9 kg $8.800,83 0% 21% $79.207,44`,
      300 + i * 40,
      320 + i * 40,
    ),
  );

  it('deja la tabla y el pie contiguos, sin superponerse ni dejar hueco', () => {
    const conPie = [
      ...filas,
      linea('Neto Gravado   $3.830.467,37', 800, 820),
      linea('TOTAL   $4.816.812,73', 860, 880),
    ];
    const regiones = detectarRegiones(conPie, 1000, 1200);

    expect(regiones.filasDetectadas).toBe(10);
    const finArticulos = regiones.articulos!.top + regiones.articulos!.height;
    // Contiguas: lo que termina la tabla es donde empieza el pie, con el mismo
    // margen para los dos lados.
    expect(finArticulos).toBeGreaterThan(regiones.resumen!.top);
    expect(regiones.resumen!.top).toBeGreaterThan(filas[filas.length - 1].caja.y0 / 1200);
  });

  it('estira la tabla hacia abajo cuando no se llegó a ver el pie', () => {
    // En una foto el recuadro de totales suele salir sin etiquetas, así que no
    // se reconoce ningún renglón de pie. Cortar la tabla en la última fila
    // *reconocida* deja afuera las que el OCR no llegó a entender, que son
    // justamente las que el recorte tiene que recuperar.
    const regiones = detectarRegiones(filas, 1000, 1200);
    const ultimaFila = filas[filas.length - 1].caja.y1 / 1200;
    const finArticulos = regiones.articulos!.top + regiones.articulos!.height;
    expect(finArticulos).toBeGreaterThan(ultimaFila);
  });

  it('sin ninguna fila reconocible cae a bandas por proporción', () => {
    const regiones = detectarRegiones([linea('una hoja en blanco')], 1000, 1200);
    expect(regiones.filasDetectadas).toBe(0);
    expect(regiones.articulos).not.toBeNull();
    expect(regiones.resumen).not.toBeNull();
  });
});

describe('la franja de abajo de la tabla', () => {
  /*
   * Es la que se relee cuando el recorte se cortó antes de terminar y quedó una
   * fila afuera. Todo en coordenadas de 0 a 1 sobre la página.
   */
  const regiones = (parcial: Partial<RegionesDetectadas>): RegionesDetectadas => ({
    encabezado: { left: 0, top: 0, width: 1, height: 0.2 },
    articulos: { left: 0, top: 0.25, width: 1, height: 0.5 },
    resumen: { left: 0, top: 0.8, width: 1, height: 0.2 },
    filasDetectadas: 23,
    ...parcial,
  });

  it('llega hasta donde empieza el pie, y no antes', () => {
    /*
     * El hueco entre la tabla y el pie se incluye a propósito: si el detector
     * cortó la tabla de más, la fila que falta está justo ahí, en tierra de
     * nadie, y ésa es la razón por la que no salió en el recorte original.
     */
    const banda = bordeInferiorDeLaTabla(regiones({}))!;
    expect(banda.top + banda.height).toBeCloseTo(0.8, 5);
  });

  it('abarca las últimas filas de la tabla, no una sola', () => {
    /*
     * Con una sola fila no alcanzaría: la franja tiene que incluir también la
     * última que sí se leyó, porque es lo único que le permite al analizador
     * reconocer dónde empalma lo nuevo con lo que ya tenía.
     */
    const banda = bordeInferiorDeLaTabla(regiones({}))!;
    const altoDeFila = 0.5 / 23;
    // Empieza tres filas antes del final de la tabla (0,25 + 0,5 = 0,75).
    expect(banda.top).toBeCloseTo(0.75 - altoDeFila * 3, 5);
  });

  it('es una fracción chica de la página: por eso vale la pena', () => {
    // Si abarcara media página, releerla costaría lo mismo que releer todo y no
    // tendría sentido preferirla a la relectura normal.
    const banda = bordeInferiorDeLaTabla(regiones({}))!;
    expect(banda.height).toBeLessThan(0.2);
  });

  it('sin pie detectado se estira un poco más allá del final de la tabla', () => {
    // Es lo único que se puede afirmar sin inventar: la fila que falta está
    // pasando el corte, pero no se sabe hasta dónde llega el detalle.
    const banda = bordeInferiorDeLaTabla(regiones({ resumen: null }))!;
    expect(banda.top + banda.height).toBeCloseTo(0.8, 5);
  });

  it('no devuelve nada si no se detectó la tabla', () => {
    // Sin tabla no hay borde de tabla. Releer una franja arbitraria de la foto
    // gastaría una pasada de OCR para nada.
    expect(bordeInferiorDeLaTabla(regiones({ articulos: null }))).toBeNull();
  });

  it('respeta un alto mínimo aunque la tabla se haya detectado diminuta', () => {
    /*
     * Cuando el detector se equivoca por lo chico, la franja calculada puede
     * quedar de dos milésimas de página: recortarla así daría una tira de pocos
     * píxeles donde no se lee nada. El mínimo es lo que hace que la relectura
     * tenga algo que leer.
     */
    const banda = bordeInferiorDeLaTabla(
      regiones({
        articulos: { left: 0, top: 0.5, width: 1, height: 0.01 },
        resumen: { left: 0, top: 0.51, width: 1, height: 0.4 },
      }),
    )!;
    expect(banda.height).toBeGreaterThanOrEqual(0.08);
  });

  it('nunca se sale de la página', () => {
    const banda = bordeInferiorDeLaTabla(
      regiones({ articulos: { left: 0, top: 0.9, width: 1, height: 0.1 }, resumen: null }),
    )!;
    expect(banda.top).toBeGreaterThanOrEqual(0);
    expect(banda.top + banda.height).toBeLessThanOrEqual(1.0000001);
  });
});
