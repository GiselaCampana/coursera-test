import { describe, it, expect } from 'vitest';
import {
  columnasNumericas,
  detectarRegiones,
  pareceFilaDeArticulo,
  pareceRenglonDePie,
  type LineaOcr,
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
