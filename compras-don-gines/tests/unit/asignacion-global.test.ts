import { describe, it, expect } from 'vitest';
import {
  agruparPedazos,
  asignarMonotonicamente,
  segundaMejorAsignacion,
  type ValorPosicionado,
} from '@/lib/ocr/reconstruccion/asignacion';

/**
 * Repartir una columna entre los renglones mirándola entera.
 *
 * El caso que obliga a esto es la factura de Lácteos Barraza: los dos importes
 * están impresos casi a la misma altura que el primer renglón, así que
 * eligiendo uno por uno **los dos eligen bien** y los dos se van al primero. El
 * renglón uno queda con dos importes fundidos y el dos, sin ninguno.
 *
 * Lo que lo resuelve no es un umbral más fino sino una restricción que vale
 * para cualquier tabla: los valores de una columna vienen en el mismo orden que
 * los renglones. El segundo importe no puede estar arriba del primero por mucho
 * que la foto esté torcida.
 *
 * Acá se prueba la primitiva sola, con coordenadas escritas a mano, para poder
 * saber qué la rompe. La medición sobre las fotos está aparte.
 */

const ALTO = 0.009;

/** Un valor en la columna, a la altura `y`. */
function valor(texto: string, y: number, x = 0.85, ancho = 0.05): ValorPosicionado {
  return {
    texto,
    caja: { x0: x, y0: y, x1: x + ancho, y1: y + ALTO },
    pasada: 'completo:directo',
    confianza: 0.9,
  };
}

/** Los renglones, a alturas de un renglón y medio de distancia. */
const FILAS = [{ y: 0.300 + ALTO / 2 }, { y: 0.300 + ALTO * 1.5 }, { y: 0.300 + ALTO * 3 }];

function textos(asignada: { porFila: (ValorPosicionado | null)[] }): (string | null)[] {
  return asignada.porFila.map((v) => v?.texto ?? null);
}

describe('el reparto conserva el orden vertical', () => {
  it('dos valores casi a la misma altura van a renglones distintos, en orden', () => {
    /*
     * El caso de Barraza, con las distancias reales: los dos importes están
     * más cerca del primer renglón que del segundo. Elegidos por cercanía, los
     * dos van al primero. Mirando la columna entera, el orden decide.
     */
    const importes = [valor('234.997,69', 0.3005), valor('238.234,75', 0.3018)];
    const asignada = asignarMonotonicamente(importes, FILAS.slice(0, 2), ALTO);

    expect(textos(asignada)).toEqual(['234.997,69', '238.234,75']);
    expect(asignada.sobrantes).toHaveLength(0);
  });

  it('el segundo valor nunca se adelanta al primero', () => {
    // Aunque el segundo esté geométricamente más cerca del primer renglón.
    const importes = [valor('primero', 0.3002), valor('segundo', 0.3004)];
    const asignada = asignarMonotonicamente(importes, FILAS.slice(0, 2), ALTO);
    expect(textos(asignada)).toEqual(['primero', 'segundo']);
  });

  it('un renglón sin valor queda vacío y no se le roba al de al lado', () => {
    const asignada = asignarMonotonicamente([valor('único', 0.3005)], FILAS.slice(0, 2), ALTO);
    expect(textos(asignada)).toEqual(['único', null]);
  });
});

describe('ningún fragmento se usa dos veces', () => {
  it('un solo valor no puede llenar dos renglones', () => {
    /*
     * Sería la manera fácil de hacer cerrar una factura: repetir el mismo
     * importe en los dos renglones. La restricción lo impide por construcción.
     */
    const asignada = asignarMonotonicamente([valor('9.453,76', 0.3005)], FILAS.slice(0, 2), ALTO);
    const usados = asignada.porFila.filter((v) => v !== null);
    expect(usados).toHaveLength(1);
    expect(new Set(usados).size).toBe(1);
  });

  it('cada valor aparece a lo sumo una vez entre celdas y sobrantes', () => {
    const valores = [
      valor('a', 0.3002),
      valor('b', 0.3010),
      valor('c', 0.3019),
      valor('d', 0.3028),
    ];
    const asignada = asignarMonotonicamente(valores, FILAS, ALTO);
    const todos = [...asignada.porFila.filter((v) => v !== null), ...asignada.sobrantes];
    expect(todos).toHaveLength(valores.length);
    expect(new Set(todos).size).toBe(valores.length);
  });
});

describe('lo que está demasiado lejos no es de ningún renglón', () => {
  it('un valor a cuatro renglones de distancia no se asigna', () => {
    /*
     * El límite tiene que ser más chico que lo que ya cuesta dejar un renglón
     * vacío. Sin él, un valor a cuatro renglones —más lejos que cualquier
     * desajuste de una foto torcida, pero más barato que dejar la celda
     * vacía— entraría igual, y ahí se cuela el importe de otra fila.
     */
    const aCuatroRenglones = valor('9.453,76', 0.300 + ALTO * 4);
    const asignada = asignarMonotonicamente([aCuatroRenglones], [FILAS[0]], ALTO);
    expect(textos(asignada)).toEqual([null]);
    expect(asignada.sobrantes).toHaveLength(1);
  });

  it('un valor del pie no entra como si fuera del último artículo', () => {
    /*
     * El pie está unos renglones más abajo que el último artículo. Sin un
     * límite, la asignación se lo daría igual porque un renglón vacío cuesta
     * caro, y el neto del comprobante entraría como el importe de un artículo.
     */
    const lejano = valor('473.232,44', 0.300 + ALTO * 12);
    const asignada = asignarMonotonicamente([lejano], FILAS, ALTO);
    expect(asignada.porFila.every((v) => v === null)).toBe(true);
    expect(asignada.sobrantes).toHaveLength(1);
  });
});

describe('los pedazos de un número se juntan antes de repartirse', () => {
  it('«234.997» y «69» son un importe, no dos', () => {
    /*
     * La unidad que se reparte es el número, no la palabra. El OCR parte los
     * importes por la coma, y repartir los pedazos por separado manda uno a
     * cada renglón: peor que el problema que se venía a resolver.
     */
    const pedazos = [
      valor('234.997', 0.3005, 0.855, 0.051),
      valor('69', 0.3005, 0.911, 0.015),
      valor('238.234.', 0.3018, 0.856, 0.055),
      valor('75', 0.3018, 0.913, 0.015),
    ];
    const grupos = agruparPedazos(pedazos, ALTO);

    expect(grupos).toHaveLength(2);
    expect(grupos[0].texto).toBe('234.99769');
    expect(grupos[1].texto).toBe('238.234.75');
  });

  it('dos valores de la misma fila separados por un hueco NO se juntan', () => {
    // La bonificación y el importe están en la misma línea y son dos cosas.
    const separados = [
      valor('16.00', 0.3005, 0.764, 0.036),
      valor('234.997,69', 0.3005, 0.855, 0.071),
    ];
    expect(agruparPedazos(separados, ALTO)).toHaveLength(2);
  });

  it('dos pedazos pegados pero de renglones distintos NO se juntan', () => {
    // Sin la condición vertical, el importe de un renglón se pegaría con el del
    // siguiente en cuanto la columna es angosta.
    const deDistintasFilas = [
      valor('234.997', 0.3005, 0.855, 0.051),
      valor('69', 0.3005 + ALTO * 1.5, 0.911, 0.015),
    ];
    expect(agruparPedazos(deDistintasFilas, ALTO)).toHaveLength(2);
  });

  it('juntos y repartidos, cada importe vuelve a su renglón', () => {
    const pedazos = [
      valor('234.997', 0.3005, 0.855, 0.051),
      valor('69', 0.3005, 0.911, 0.015),
      valor('238.234.', 0.3018, 0.856, 0.055),
      valor('75', 0.3018, 0.913, 0.015),
    ];
    const grupos = agruparPedazos(pedazos, ALTO).map((g) => ({
      texto: g.texto,
      caja: g.caja,
      pasada: g.partes[0].pasada,
      confianza: g.partes[0].confianza,
    }));

    const asignada = asignarMonotonicamente(grupos, FILAS.slice(0, 2), ALTO);
    expect(textos(asignada)).toEqual(['234.99769', '238.234.75']);
  });
});

describe('cuándo el reparto no es concluyente', () => {
  it('devuelve un costo, para poder comparar dos repartos', () => {
    const asignada = asignarMonotonicamente(
      [valor('a', 0.3005), valor('b', 0.3018)],
      FILAS.slice(0, 2),
      ALTO,
    );
    expect(asignada.costo).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(asignada.costo)).toBe(true);
  });

  it('cuando hay un valor de más, la segunda opción cuesta parecido', () => {
    /*
     * Tres valores para dos renglones: cuál sobra no está decidido por la
     * geometría. La segunda mejor asignación cuesta casi lo mismo que la
     * primera, y eso es lo que después permite mandar el comprobante a revisión
     * en vez de elegir una.
     */
    const valores = [valor('a', 0.3004), valor('b', 0.3010), valor('c', 0.3016)];
    const filas = FILAS.slice(0, 2);
    const ganadora = asignarMonotonicamente(valores, filas, ALTO);
    const segunda = segundaMejorAsignacion(valores, filas, ALTO, ganadora);

    expect(segunda).not.toBeNull();
    expect(segunda!.costo - ganadora.costo).toBeLessThan(2);
  });

  it('cuando el reparto es claro, la segunda cuesta mucho más', () => {
    // Dos valores, dos renglones, cada uno en su lugar: sacar cualquiera deja
    // un renglón vacío, que es caro.
    const valores = [valor('a', 0.3005), valor('b', 0.3018)];
    const filas = FILAS.slice(0, 2);
    const ganadora = asignarMonotonicamente(valores, filas, ALTO);
    const segunda = segundaMejorAsignacion(valores, filas, ALTO, ganadora);

    expect(segunda!.costo - ganadora.costo).toBeGreaterThan(2);
  });
});

describe('la escala no cambia el reparto', () => {
  it('la misma columna en otra resolución da el mismo resultado', () => {
    /*
     * Todo está en fracción de página, así que una foto de 1080 y una de 4032
     * tienen que repartir igual. Acá se simula encogiendo las coordenadas.
     */
    const original = [valor('234.997,69', 0.3005), valor('238.234,75', 0.3018)];
    const encogido = original.map((v) => ({
      ...v,
      caja: {
        x0: v.caja.x0 * 0.5 + 0.2,
        y0: v.caja.y0 * 0.5 + 0.1,
        x1: v.caja.x1 * 0.5 + 0.2,
        y1: v.caja.y1 * 0.5 + 0.1,
      },
    }));
    const filasEncogidas = FILAS.slice(0, 2).map((f) => ({ y: f.y * 0.5 + 0.1 }));

    expect(textos(asignarMonotonicamente(encogido, filasEncogidas, ALTO * 0.5))).toEqual(
      textos(asignarMonotonicamente(original, FILAS.slice(0, 2), ALTO)),
    );
  });

  it('el orden en que llegan los valores no cambia el reparto', () => {
    const valores = [valor('a', 0.3005), valor('b', 0.3018), valor('c', 0.3031)];
    const alReves = [...valores].reverse();
    expect(textos(asignarMonotonicamente(alReves, FILAS, ALTO))).toEqual(
      textos(asignarMonotonicamente(valores, FILAS, ALTO)),
    );
  });
});
