import { describe, it, expect } from 'vitest';
import {
  cajasParecenNormalizadas,
  lineasDeBloques,
  type BloqueDeTesseract,
} from '@/lib/cliente/ocr/tesseract';
import { detectarRegiones } from '@/lib/cliente/ocr/regiones';

/**
 * Contrato de unidades entre el lector y la detección de regiones.
 *
 * Esto existe por un error concreto: el arnés de las fotos reales normalizaba
 * las cajas a 0..1 mientras el módulo real las entrega en píxeles. No fallaba
 * —ese es el problema—. `detectarRegiones` recibía coordenadas mil veces más
 * chicas, devolvía una franja de tabla del 5 % en el borde de la página, el
 * recorte salía vacío y el diagnóstico parecía perfectamente válido: decía que
 * una factura perdía renglones cuando en realidad los veía todos.
 *
 * Un error que no rompe nada y produce un informe creíble es peor que uno que
 * revienta. Por eso el contrato se prueba, y se prueba sin Tesseract: estas
 * pruebas corren siempre.
 */

/** Bloques con la forma que devuelve Tesseract, con las cajas que se le pidan. */
function bloques(
  cajas: { texto: string; x0: number; y0: number; x1: number; y1: number }[],
): BloqueDeTesseract[] {
  return [
    {
      paragraphs: [
        {
          lines: cajas.map((c) => ({
            text: c.texto,
            confidence: 90,
            bbox: { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 },
          })),
        },
      ],
    },
  ];
}

describe('las cajas salen en píxeles', () => {
  it('se devuelven tal como las da Tesseract, sin dividir por nada', () => {
    const lineas = lineasDeBloques(
      bloques([{ texto: 'ART-00873 BARRA DANBO', x0: 40, y0: 300, x1: 1600, y1: 340 }]),
    );

    expect(lineas).toHaveLength(1);
    expect(lineas[0].caja).toEqual({ x0: 40, y0: 300, x1: 1600, y1: 340 });
  });

  it('las coordenadas superan largamente el 1: no están normalizadas', () => {
    const lineas = lineasDeBloques(
      bloques([
        { texto: 'primera', x0: 10, y0: 100, x1: 1200, y1: 140 },
        { texto: 'segunda', x0: 10, y0: 160, x1: 1200, y1: 200 },
      ]),
    );
    expect(cajasParecenNormalizadas(lineas, 1650, 2200)).toBe(false);
    for (const l of lineas) expect(l.caja.y1).toBeGreaterThan(1);
  });

  it('el control detecta unas cajas normalizadas', () => {
    /*
     * La prueba que tiene que fallar si alguien vuelve a normalizar. Se arman a
     * mano unas cajas dentro del cuadrado unitario, que es exactamente lo que
     * produciría dividir por el ancho y el alto.
     */
    const normalizadas = lineasDeBloques(
      bloques([
        { texto: 'primera', x0: 0.01, y0: 0.05, x1: 0.9, y1: 0.07 },
        { texto: 'segunda', x0: 0.01, y0: 0.09, x1: 0.9, y1: 0.11 },
      ]),
    );
    expect(cajasParecenNormalizadas(normalizadas, 1650, 2200)).toBe(true);
  });

  it('sin líneas, o sobre una imagen diminuta, no se afirma nada', () => {
    // Con una imagen de dos píxeles, unas cajas chicas son legítimas.
    expect(cajasParecenNormalizadas([], 1650, 2200)).toBe(false);
    const chicas = lineasDeBloques(bloques([{ texto: 'x', x0: 0, y0: 0, x1: 1, y1: 1 }]));
    expect(cajasParecenNormalizadas(chicas, 2, 2)).toBe(false);
  });

  it('las líneas vacías no entran', () => {
    const lineas = lineasDeBloques(
      bloques([
        { texto: '   ', x0: 0, y0: 0, x1: 10, y1: 10 },
        { texto: 'algo', x0: 0, y0: 20, x1: 10, y1: 30 },
      ]),
    );
    expect(lineas.map((l) => l.texto)).toEqual(['algo']);
  });

  it('sin bloques devuelve una lista vacía, no explota', () => {
    expect(lineasDeBloques(undefined)).toEqual([]);
    expect(lineasDeBloques(null)).toEqual([]);
    expect(lineasDeBloques([])).toEqual([]);
  });
});

describe('el efecto de equivocar las unidades', () => {
  /*
   * Lo que de verdad importa: qué le pasa a la detección de regiones. Con las
   * mismas líneas expresadas de las dos maneras, una da una tabla que ocupa
   * media página y la otra una franja pegada al borde. Es el síntoma exacto que
   * hubo que diagnosticar, y acá queda fijado.
   */
  const ANCHO = 1650;
  const ALTO = 2200;

  /** Filas de artículo repartidas por el medio de la página, en píxeles. */
  const filas = Array.from({ length: 12 }, (_, i) => ({
    texto: `ART-0${100 + i} DESCRIPCION DE PRUEBA 3 kg $1.234,56 0% 21% $3.703,68`,
    x0: 40,
    y0: 600 + i * 90,
    x1: 1600,
    y1: 640 + i * 90,
  }));

  it('en píxeles, la tabla queda donde están las filas', () => {
    const regiones = detectarRegiones(lineasDeBloques(bloques(filas)), ANCHO, ALTO);
    expect(regiones.filasDetectadas).toBe(12);
    expect(regiones.articulos).not.toBeNull();
    // Ocupa una franja ancha en el medio, no un hilo en el borde.
    expect(regiones.articulos!.height).toBeGreaterThan(0.3);
    expect(regiones.articulos!.top).toBeGreaterThan(0.2);
  });

  it('normalizadas, la tabla se desploma contra el borde', () => {
    const encogidas = filas.map((f) => ({
      ...f,
      x0: f.x0 / ANCHO,
      y0: f.y0 / ALTO,
      x1: f.x1 / ANCHO,
      y1: f.y1 / ALTO,
    }));
    const regiones = detectarRegiones(lineasDeBloques(bloques(encogidas)), ANCHO, ALTO);

    // El síntoma: una franja diminuta arriba de todo. Recortar ahí no devuelve
    // ni un renglón, y nada avisa.
    expect(regiones.articulos!.height).toBeLessThan(0.1);
    expect(regiones.articulos!.top).toBeLessThan(0.05);
  });
});
