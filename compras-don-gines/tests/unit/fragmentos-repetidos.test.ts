import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  apoyo,
  cajaRobusta,
  repartirCelda,
  type Lectura,
  type Observacion,
} from '@/lib/ocr/reconstruccion/agrupar';
import { armarCelda, reconstruirTabla } from '@/lib/ocr/reconstruccion/reconstruccion';
import type { Caja, EvidenciaDeLectura } from '@/lib/ocr/reconstruccion/evidencia';

/**
 * Un fragmento repetido entre pasadas no es un pedazo más de la celda.
 *
 * Es el defecto más transversal que dejó la primera validación ciega: varias
 * pasadas leen la misma zona del papel, la celda las pega todas y sale texto que
 * no existe en ningún comprobante —«27.937,3527937,35», «MANI SAL SAL PELADO»,
 * «300052820300052820», «CHEETOS QUESO QUESO 856X24X1»—. Lo que corresponde es
 * que compitan: son alternativas de lo mismo, y hay que elegir una y conservar
 * las otras.
 *
 * La geometría de estas pruebas está tomada de las fotos reales, pero el texto
 * es inventado: las facturas nuevas y sus transcripciones no entran al
 * repositorio.
 */

const ALTO = 0.008;

function caja(x0: number, x1: number, y0 = 0.3, alto = ALTO): Caja {
  return { x0, x1, y0, y1: y0 + alto };
}

function lectura(texto: string, pasada: string, confianza: number, donde: Caja): Lectura {
  return { texto, pasada, confianza, caja: donde, cajaEnLaFoto: donde, alternativas: [] };
}

/** Una observación leída por varias pasadas, todas con la misma caja. */
function vista(
  texto: string,
  donde: Caja,
  pasadas: { pasada: string; confianza: number; texto?: string; caja?: Caja }[],
): Observacion {
  return {
    caja: donde,
    lecturas: pasadas.map((p) =>
      lectura(p.texto ?? texto, p.pasada, p.confianza, p.caja ?? donde),
    ),
  };
}

/** Lo que veía una pasada sola. */
function unaSola(texto: string, donde: Caja, confianza = 0.5, pasada = 'articulos:limpieza-fuerte') {
  return vista(texto, donde, [{ pasada, confianza }]);
}

const CINCO = ['completo:directo', 'encabezado:directo', 'encabezado:limpieza-fuerte', 'articulos:directo', 'articulos:limpieza-fuerte'];
function variasPasadas(cuantas: number, confianza = 0.9) {
  return CINCO.slice(0, cuantas).map((pasada) => ({ pasada, confianza }));
}

describe('qué es un pedazo de la celda y qué es la misma cosa leída dos veces', () => {
  it('dos lecturas del mismo lugar compiten: una es la celda y la otra su alternativa', () => {
    const entera = vista('27.937,35', caja(0.8448, 0.8903), variasPasadas(3, 0.6));
    const pedazo = unaSola('937,35', caja(0.8604, 0.8900), 0.5);

    const reparto = repartirCelda([entera, pedazo]);

    expect(reparto.partes).toEqual([entera]);
    expect(reparto.alternativas).toEqual([pedazo]);
  });

  it('dos pedazos que van uno al lado del otro son las dos partes de la celda', () => {
    // El OCR parte los importes por la coma: «22.800» y «,00» no se pisan.
    const izquierda = vista('22.800', caja(0.80, 0.85), variasPasadas(3));
    const derecha = vista(',00', caja(0.851, 0.87), variasPasadas(3));

    const reparto = repartirCelda([izquierda, derecha]);

    expect(reparto.partes).toEqual([izquierda, derecha]);
    expect(reparto.alternativas).toHaveLength(0);
  });

  it('dos valores de renglones distintos no son el mismo lugar aunque compartan la columna', () => {
    /*
     * Es la corrección que costó una medición entera. Con el solapamiento
     * horizontal solo, los dos importes de la factura de Barraza —que la
     * agrupación por altura había metido en la misma línea— se pisaban de lado
     * a lado y uno de los dos se perdía: un renglón entero.
     */
    const deArriba = vista('238.234,75', caja(0.855, 0.911, 0.3349), variasPasadas(3));
    const deAbajo = vista('234.997,69', caja(0.855, 0.906, 0.3440), variasPasadas(2));

    const reparto = repartirCelda([deArriba, deAbajo]);

    expect(reparto.partes).toHaveLength(2);
    expect(reparto.alternativas).toHaveLength(0);
  });

  it('la fusión de dos palabras pierde contra las dos palabras', () => {
    /*
     * Cuatro pasadas leen cada palabra por separado, con poca confianza; una
     * sola las lee pegadas y muy segura. Gana el par: lo que decide es cuántas
     * pasadas lo vieron, no cuánto declaró la que más declaró.
     */
    const primera = vista('PRIMERA', caja(0.1951, 0.2261), variasPasadas(4, 0.4));
    const segunda = vista('SEGUNDA', caja(0.2303, 0.2545), variasPasadas(4, 0.4));
    const pegadas = unaSola('PRIMERASEGUNDA', caja(0.1942, 0.2550), 0.98);

    const reparto = repartirCelda([primera, segunda, pegadas]);

    expect(reparto.partes).toEqual([primera, segunda]);
    expect(reparto.alternativas).toEqual([pegadas]);
  });

  it('y el número entero le gana al corte, que es el caso simétrico', () => {
    /*
     * La misma forma geométrica con el resultado opuesto, y lo único que los
     * distingue es el apoyo. Si se decidiera por el tamaño de la caja, o por
     * cuántos pedazos hay, uno de los dos casos saldría mal seguro.
     */
    const entera = vista('27.937,35', caja(0.8448, 0.8903), variasPasadas(3, 0.6));
    const izquierda = unaSola('27', caja(0.8454, 0.8569), 0.5);
    const derecha = unaSola('937,35', caja(0.8604, 0.8900), 0.5);

    const reparto = repartirCelda([entera, izquierda, derecha]);

    expect(reparto.partes).toEqual([entera]);
    expect(reparto.alternativas).toHaveLength(2);
  });

  it('el apoyo cuenta las pasadas, no la confianza de la mejor', () => {
    const cuatroFlojas = vista('X', caja(0.1, 0.2), variasPasadas(4, 0.3));
    const unaSegura = unaSola('Y', caja(0.1, 0.2), 0.95);
    expect(apoyo(cuatroFlojas)).toBeGreaterThan(apoyo(unaSegura));

    // Y una palabra que el OCR devolvió con confianza cero sigue siendo evidencia.
    const enCero = vista('Z', caja(0.1, 0.2), variasPasadas(3, 0));
    expect(apoyo(enCero)).toBeGreaterThan(0);
  });
});

describe('la celda que sale de todo eso', () => {
  it('no pega dos lecturas del mismo lugar, y conserva la descartada con su procedencia', () => {
    const entera = vista('27.937,35', caja(0.8448, 0.8903), variasPasadas(3, 0.6));
    const pedazo = unaSola('937,35', caja(0.8604, 0.8900), 0.5, 'encabezado:limpieza-fuerte');

    const celda = armarCelda(7, [entera, pedazo]);

    expect(celda.texto).toBe('27.937,35');
    expect(celda.texto).not.toContain('27.937,35937,35');
    expect(celda.alternativas.map((a) => a.texto)).toContain('937,35');
    const descartada = celda.alternativas.find((a) => a.texto === '937,35')!;
    expect(descartada.pasada).toBe('encabezado:limpieza-fuerte');
    expect(descartada.caja).toEqual(caja(0.8604, 0.8900));
    expect(celda.estado).toBe('ambigua');
  });

  it('sí pega los pedazos de un número, sin espacio, que es lo que hay que conservar', () => {
    const izquierda = vista('22.800', caja(0.80, 0.85), variasPasadas(3));
    const derecha = vista(',00', caja(0.851, 0.87), variasPasadas(3));

    expect(armarCelda(9, [izquierda, derecha]).texto).toBe('22.800,00');
  });

  it('y las palabras de una descripción, con espacio', () => {
    const una = vista('PRIMERA', caja(0.1951, 0.2261), variasPasadas(4));
    const otra = vista('SEGUNDA', caja(0.2303, 0.2545), variasPasadas(4));

    expect(armarCelda(2, [una, otra]).texto).toBe('PRIMERA SEGUNDA');
  });
});

describe('la caja que se usa para decidir si dos observaciones ocupan el mismo lugar', () => {
  it('no la decide la pasada que se fue de ancho', () => {
    /*
     * En la factura de Errecalde las cinco pasadas leen «PUNTA»; cuatro le dan
     * su ancho y la quinta se lo estira hasta tapar «DE AGUA». Con esa caja,
     * dos palabras del papel pasan a ocupar el mismo lugar y una sobra: la
     * descripción salía «BARRA DANBO DE AGUA».
     */
    const angosta = caja(0.2269, 0.2760);
    const ancha = caja(0.2269, 0.3046);
    const palabra: Observacion = {
      caja: ancha,
      lecturas: [
        lectura('PUNTA', 'completo:directo', 0.9, ancha),
        lectura('PUNTA', 'encabezado:directo', 0.9, angosta),
        lectura('PUNTA', 'articulos:directo', 0.9, angosta),
        lectura('PUNTA', 'articulos:limpieza-fuerte', 0.9, angosta),
      ],
    };

    expect(cajaRobusta(palabra).x1).toBeCloseTo(angosta.x1, 6);

    const vecina = vista('AGUA', caja(0.2800, 0.3046), variasPasadas(4));
    expect(repartirCelda([palabra, vecina]).partes).toHaveLength(2);
  });

  it('sólo promedia las cajas de las pasadas que leyeron lo mismo', () => {
    const suya = caja(0.10, 0.15);
    const ajena = caja(0.10, 0.40);
    const observacion: Observacion = {
      caja: suya,
      lecturas: [
        lectura('CODIGO', 'completo:directo', 0.9, suya),
        lectura('CODIGO', 'articulos:directo', 0.9, suya),
        lectura('CODIGOYALGOMAS', 'encabezado:directo', 0.4, ajena),
      ],
    };

    expect(cajaRobusta(observacion).x1).toBeCloseTo(suya.x1, 6);
  });
});

describe('sobre las fotos del banco, que es donde se vio el defecto', () => {
  const leer = (nombre: string): EvidenciaDeLectura =>
    JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'tests/fixtures/evidencia', `${nombre}.json`),
        'utf8',
      ),
    );

  const FOTOS = [
    'barraza',
    'errecalde',
    'ezra',
    'los-calvos-212356',
    'los-calvos-213103',
    'mabelherdi',
  ];

  it('ninguna celda repite una palabra pegada a sí misma', () => {
    /*
     * Es la prueba que rompe si se vuelve atrás. Con el motor congelado, la
     * foto de Barraza deja «CIL CIL M», «PLAN MUZZA MUZZA» y «BARRAZA BARRAZA X
     * 10»: la misma palabra que leyeron dos pasadas, escrita dos veces.
     *
     * Se miran repeticiones **pegadas** y no cualquier repetición: «F. DE
     * PECHUGA DE POLLO» dice «DE» dos veces y está bien escrito.
     */
    const repetidas: string[] = [];
    for (const nombre of FOTOS) {
      for (const renglon of reconstruirTabla(leer(nombre)).renglones) {
        for (const celda of renglon.celdas) {
          if (!celda?.texto) continue;
          const palabras = celda.texto.split(/\s+/).filter((p) => p.length > 0);
          if (palabras.some((p, i) => i > 0 && p === palabras[i - 1])) {
            repetidas.push(`${nombre}: ${celda.texto}`);
          }
        }
      }
    }
    expect(repetidas).toEqual([]);
  });

  it('y no se pierde ninguna palabra por tratarla como repetida', () => {
    // La otra mitad de la garantía: dejar de pegar no puede costar contenido.
    const errecalde = reconstruirTabla(leer('errecalde'));
    const textos = errecalde.renglones.flatMap((r) =>
      r.celdas.map((c) => c?.texto ?? ''),
    );
    expect(textos).toContain('BARRA DANBO PUNTA DE AGUA');
    expect(textos).toContain('392kg');
    expect(textos).not.toContain('392kg kg');
  });
});
