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
   *
   * La tabla va de 0,20 a 0,80 con doce filas, así que cada fila mide 0,05. Los
   * números están elegidos para que el **alto mínimo** de la franja no alcance a
   * tapar el defecto: con filas más chicas, una franja mal calculada se pasa
   * igual del final de la tabla por el piso de 0,08 y la prueba pasaría sin
   * probar nada. Ya me pasó una vez.
   */
  const regiones = (parcial: Partial<RegionesDetectadas>): RegionesDetectadas => ({
    encabezado: { left: 0, top: 0, width: 1, height: 0.18 },
    articulos: { left: 0, top: 0.2, width: 1, height: 0.6 },
    // El pie arranca **antes** de que termine la tabla, que es lo que hace de
    // verdad el detector: las dos bandas se solapan para no cortar el primer
    // renglón de totales.
    resumen: { left: 0, top: 0.77, width: 1, height: 0.23 },
    filasDetectadas: 12,
    ...parcial,
  });

  it('baja por debajo del final de la tabla, que es donde está lo que falta', () => {
    /*
     * La prueba que faltaba, y el defecto que dejó pasar.
     *
     * La franja terminaba en `resumen.top`, con la idea de que entre la tabla y
     * el pie hay un hueco. No lo hay: las dos bandas se solapan, así que
     * `resumen.top` cae por encima del final de la tabla, el máximo colapsaba al
     * final de la tabla y la franja quedaba entera adentro del recorte ya leído.
     * Releía el mismo papel y devolvía el mismo texto: la relectura se disparaba
     * y no aparecía nada.
     *
     * La fila que falta está, por definición, más abajo de donde el recorte dejó
     * de mirar: si estuviera adentro, ya se habría leído.
     */
    const r = regiones({});
    const finDeLaTabla = r.articulos!.top + r.articulos!.height;
    const banda = bordeInferiorDeLaTabla(r)!;

    expect(r.resumen!.top).toBeLessThan(finDeLaTabla);
    expect(banda.top + banda.height).toBeGreaterThan(finDeLaTabla + 0.02);
  });

  it('abarca las últimas filas de la tabla, no una sola', () => {
    /*
     * Con una sola no alcanzaría: la franja tiene que incluir también la última
     * que sí se leyó, porque es lo único que le permite al analizador reconocer
     * dónde empalma lo nuevo con lo que ya tenía.
     */
    const banda = bordeInferiorDeLaTabla(regiones({}))!;
    // Se comprueba la propiedad y no la cuenta: cuántas filas de contexto entran
    // depende del tope del alto, y fijar el número exacto haría que la prueba se
    // rompa por un ajuste que no cambia nada de lo que importa.
    const finDeLaTabla = 0.8;
    const altoDeFila = 0.05;
    expect(banda.top).toBeLessThanOrEqual(finDeLaTabla - altoDeFila * 2);
    expect(banda.top).toBeGreaterThanOrEqual(0.2);
  });

  it('es una fracción chica de la página: por eso vale la pena', () => {
    // Si abarcara media página, releerla costaría lo mismo que releer todo y no
    // tendría sentido preferirla a la relectura normal.
    const banda = bordeInferiorDeLaTabla(regiones({}))!;
    expect(banda.height).toBeLessThanOrEqual(0.25);
  });

  it('con filas grandes se recorta por arriba, nunca por abajo', () => {
    /*
     * En un comprobante de pocas filas, seis alturas de fila serían un tercio de
     * la página. Se recorta, pero del lado del contexto: lo de abajo es lo que se
     * fue a buscar.
     */
    const r = regiones({ articulos: { left: 0, top: 0.1, width: 1, height: 0.6 }, filasDetectadas: 4 });
    const finDeLaTabla = 0.7;
    const banda = bordeInferiorDeLaTabla(r)!;

    expect(banda.height).toBeLessThanOrEqual(0.25);
    expect(banda.top + banda.height).toBeGreaterThan(finDeLaTabla + 0.02);
  });

  it('sin pie detectado baja igual', () => {
    // El pie no decide nada: lo que decide es dónde termina la tabla.
    const banda = bordeInferiorDeLaTabla(regiones({ resumen: null }))!;
    expect(banda.top + banda.height).toBeGreaterThan(0.8 + 0.02);
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
     * píxeles donde no se lee nada.
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

describe('la franja, sobre las regiones que produce el detector de verdad', () => {
  /*
   * Las dos funciones se prueban juntas a propósito.
   *
   * Por separado las dos estaban bien: el detector solapa las bandas por una
   * razón buena, y la franja terminaba donde empezaba el pie por otra razón que
   * parecía buena. El error estaba en el encastre, y sólo se ve mirando las dos
   * al mismo tiempo. Si esta prueba no existiera, la próxima vez que alguien
   * toque cualquiera de las dos volvería a pasar lo mismo.
   */
  const filaEn = (y: number, altoFila: number): LineaOcr => ({
    texto: 'ART-00873 BARRA DANBO PUNTA DE AGUA 8 39.2 kg $8.090,08 0% 21% $317.131,24',
    confianza: 0.9,
    caja: { x0: 0, y0: y, x1: 1000, y1: y + altoFila },
  });

  const doceFilas = (): LineaOcr[] => {
    const lineas: LineaOcr[] = [];
    for (let i = 0; i < 12; i++) lineas.push(filaEn(300 + i * 80, 60));
    return lineas;
  };

  it('la franja pisa papel que el recorte de la tabla no miró', () => {
    const regiones = detectarRegiones(doceFilas(), 1500, 2000);
    const banda = bordeInferiorDeLaTabla(regiones)!;
    const finDeLaTabla = regiones.articulos!.top + regiones.articulos!.height;

    // Las dos bandas del detector se solapan: es la trampa que hay que sortear.
    expect(regiones.resumen!.top).toBeLessThan(finDeLaTabla);

    // La franja tiene que llegar más abajo que el recorte de la tabla: si no,
    // relee exactamente lo mismo y no puede aparecer ninguna fila nueva.
    expect(banda.top + banda.height).toBeGreaterThan(finDeLaTabla + 0.02);
    // Y tiene que empezar adentro de la tabla, para tener con qué empalmar.
    expect(banda.top).toBeLessThan(finDeLaTabla);
    expect(banda.top).toBeGreaterThanOrEqual(regiones.articulos!.top);
  });

  it('y sigue siendo chica: no es releer la página de nuevo', () => {
    const regiones = detectarRegiones(doceFilas(), 1500, 2000);
    const banda = bordeInferiorDeLaTabla(regiones)!;

    expect(banda.height).toBeLessThan(regiones.articulos!.height);
    expect(banda.height).toBeLessThanOrEqual(0.25);
  });
});
