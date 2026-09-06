import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  clasificarCuadrilatero,
  crearMapa,
  detectarEsquinas,
  medirCuadrilatero,
  recortarAlRectangulo,
  type Mapa,
  type Punto,
} from '@/lib/cliente/ocr/imagen';
import { prepararPagina } from '@/lib/cliente/ocr/preproceso';

/**
 * Qué se le hace al papel, decidido por su geometría.
 *
 * Estas reglas son las que deciden si una foto se lee o no, así que corren
 * siempre: no dependen de Tesseract, ni de las fotos reales, ni de cuánto tarde
 * nada. Las fotos reales se miden aparte, con OCR_FOTOS_REALES=1.
 *
 * La decisión se toma sobre tres propiedades medibles —ángulos, paralelismo de
 * los lados opuestos y diferencia de escala entre ellos— y sobre nada más. No
 * hay nombres de proveedor ni valores ajustados a una factura en particular: un
 * papel plano y torcido se endereza, uno con escorzo marcado se corrige, y una
 * forma que no es ninguna de las dos no se toca.
 */

/** Una hoja clara sobre fondo oscuro, con las esquinas que se le indiquen. */
function hoja(ancho: number, alto: number, esquinas: Punto[]): Mapa {
  const mapa = crearMapa(ancho, alto);
  const dentro = (x: number, y: number) => {
    let signo = 0;
    for (let i = 0; i < esquinas.length; i++) {
      const a = esquinas[i];
      const b = esquinas[(i + 1) % esquinas.length];
      const cruz = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      if (cruz === 0) continue;
      const s = cruz > 0 ? 1 : -1;
      if (signo === 0) signo = s;
      else if (signo !== s) return false;
    }
    return true;
  };
  for (let y = 0; y < alto; y++) {
    for (let x = 0; x < ancho; x++) {
      const i = (y * ancho + x) * 4;
      const v = dentro(x, y) ? 245 : 30;
      mapa.data[i] = v;
      mapa.data[i + 1] = v;
      mapa.data[i + 2] = v;
      mapa.data[i + 3] = 255;
    }
  }
  return mapa;
}

/** Rectángulo girado `grados` alrededor del centro de un lienzo. */
function rectanguloRotado(
  ancho: number,
  alto: number,
  margen: number,
  grados: number,
): [Punto, Punto, Punto, Punto] {
  const cx = ancho / 2;
  const cy = alto / 2;
  const r = (grados * Math.PI) / 180;
  const girar = (p: Punto): Punto => ({
    x: Math.round(cx + (p.x - cx) * Math.cos(r) - (p.y - cy) * Math.sin(r)),
    y: Math.round(cy + (p.x - cx) * Math.sin(r) + (p.y - cy) * Math.cos(r)),
  });
  return [
    girar({ x: margen, y: margen }),
    girar({ x: ancho - margen, y: margen }),
    girar({ x: ancho - margen, y: alto - margen }),
    girar({ x: margen, y: alto - margen }),
  ];
}

describe('medir el cuadrilátero', () => {
  it('un rectángulo alineado no se desvía en nada', () => {
    const m = medirCuadrilatero([
      { x: 0, y: 0 },
      { x: 400, y: 0 },
      { x: 400, y: 600 },
      { x: 0, y: 600 },
    ]);
    expect(m.desviacionAngular).toBeCloseTo(0, 5);
    expect(m.desviacionParalelismo).toBeCloseTo(0, 5);
    expect(m.razonDeEscala).toBeCloseTo(1, 5);
  });

  it('rotarlo no cambia ninguna de las tres medidas', () => {
    /*
     * Es la propiedad que sostiene todo lo demás: las tres medidas son
     * invariantes a la rotación, así que un papel torcido no se puede confundir
     * con uno en perspectiva por estar torcido.
     */
    for (const grados of [3, 12, 30, 45, 87]) {
      const m = medirCuadrilatero(rectanguloRotado(1000, 1400, 100, grados));
      expect(m.desviacionAngular, `${grados}°`).toBeLessThan(1);
      expect(m.desviacionParalelismo, `${grados}°`).toBeLessThan(1);
      expect(m.razonDeEscala, `${grados}°`).toBeLessThan(1.02);
    }
  });

  it('un trapecio de perspectiva se desvía en escala y en ángulo', () => {
    // Borde de arriba más corto que el de abajo: el papel se aleja arriba.
    const m = medirCuadrilatero([
      { x: 300, y: 0 },
      { x: 700, y: 0 },
      { x: 1000, y: 1400 },
      { x: 0, y: 1400 },
    ]);
    // La escala es la que delata el escorzo; el ángulo acompaña. Un trapecio
    // simétrico mantiene las esquinas más cerca de 90° de lo que uno esperaría,
    // y por eso la clasificación mira las dos cosas y no sólo los ángulos.
    expect(m.razonDeEscala).toBeGreaterThan(2);
    expect(m.desviacionAngular).toBeGreaterThan(10);
  });
});

describe('clasificar qué hacer con el papel', () => {
  it('un rectángulo rotado se endereza, no se deforma', () => {
    for (const grados of [0, 2, 8, 25, 44]) {
      expect(clasificarCuadrilatero(rectanguloRotado(1000, 1400, 80, grados)), `${grados}°`).toBe(
        'RECTANGULO_ROTADO',
      );
    }
  });

  it('un escorzo marcado sí se corrige', () => {
    expect(
      clasificarCuadrilatero([
        { x: 300, y: 0 },
        { x: 700, y: 0 },
        { x: 1000, y: 1400 },
        { x: 0, y: 1400 },
      ]),
    ).toBe('PERSPECTIVA');
  });

  it('la zona intermedia no se toca', () => {
    /*
     * El caso cercano al umbral, que es el que importa: hay algo de escorzo
     * pero no el suficiente como para que deformar la imagen salga a cuenta.
     * Ante la duda no se deforma, porque el warp es la operación que puede
     * arruinar una lectura que hoy funciona.
     */
    const casi = clasificarCuadrilatero([
      { x: 60, y: 0 },
      { x: 940, y: 0 },
      { x: 1000, y: 1400 },
      { x: 0, y: 1400 },
    ]);
    expect(casi).toBe('NO_CONFIABLE');
  });

  it('una forma degenerada tampoco', () => {
    expect(
      clasificarCuadrilatero([
        { x: 0, y: 0 },
        { x: 1000, y: 0 },
        { x: 500, y: 10 },
        { x: 0, y: 0 },
      ]),
    ).not.toBe('RECTANGULO_ROTADO');
  });
});

describe('recortar al rectángulo', () => {
  it('saca el fondo y conserva el papel entero', () => {
    const esquinas = rectanguloRotado(600, 800, 100, 0);
    const mapa = hoja(600, 800, esquinas);
    const recortado = recortarAlRectangulo(mapa, esquinas);

    // Quedó la hoja con su margen, no la mesa.
    expect(recortado.width).toBeLessThan(600);
    expect(recortado.height).toBeLessThan(800);
    expect(recortado.width).toBeGreaterThan(380);
    expect(recortado.height).toBeGreaterThan(580);
  });

  it('no inventa píxeles: los que quedan son los mismos', () => {
    /*
     * Es la diferencia con la corrección de perspectiva y la razón de ser de
     * este camino: acá no hay interpolación, así que los trazos finos llegan al
     * OCR como estaban.
     */
    const esquinas: [Punto, Punto, Punto, Punto] = [
      { x: 100, y: 200 },
      { x: 500, y: 200 },
      { x: 500, y: 700 },
      { x: 100, y: 700 },
    ];
    const mapa = hoja(600, 800, esquinas);
    const recortado = recortarAlRectangulo(mapa, esquinas, 0);

    for (let y = 0; y < recortado.height; y++) {
      for (let x = 0; x < recortado.width; x++) {
        const a = (y * recortado.width + x) * 4;
        const b = ((y + 200) * mapa.width + (x + 100)) * 4;
        if (recortado.data[a] !== mapa.data[b]) {
          throw new Error(`el píxel (${x},${y}) cambió al recortar`);
        }
      }
    }
  });

  it('si la caja es toda la imagen, devuelve la misma imagen', () => {
    const esquinas: [Punto, Punto, Punto, Punto] = [
      { x: 0, y: 0 },
      { x: 599, y: 0 },
      { x: 599, y: 799 },
      { x: 0, y: 799 },
    ];
    const mapa = hoja(600, 800, esquinas);
    expect(recortarAlRectangulo(mapa, esquinas)).toBe(mapa);
  });
});

describe('preparar la página', () => {
  it('un papel torcido no se corrige por perspectiva', () => {
    const mapa = hoja(900, 1200, rectanguloRotado(900, 1200, 120, 7));
    const { perspectivaCorregida } = prepararPagina(mapa);
    expect(perspectivaCorregida).toBe(false);
  });

  it('un papel con escorzo marcado sí', () => {
    /*
     * El escorzo llega hasta acá y no más: por encima de 1,6 entre lados
     * opuestos, `pareceHojaDePapel` descarta el cuadrilátero por inverosímil
     * —una foto sacada de costado no pasa de 1,4— y se prefiere no tocar la
     * imagen. La ventana en la que se corrige es angosta a propósito.
     */
    const mapa = hoja(900, 1200, [
      { x: 160, y: 60 },
      { x: 740, y: 60 },
      { x: 880, y: 1140 },
      { x: 20, y: 1140 },
    ]);
    const { perspectivaCorregida } = prepararPagina(mapa);
    expect(perspectivaCorregida).toBe(true);
  });

  it('sin papel reconocible se sigue con la imagen como vino', () => {
    // Todo del mismo tono: no hay hoja que separar del fondo.
    const mapa = crearMapa(800, 1000);
    mapa.data.fill(200);
    expect(detectarEsquinas(mapa)).toBeNull();

    const { mapa: salida, perspectivaCorregida } = prepararPagina(mapa);
    expect(perspectivaCorregida).toBe(false);
    // Proporción intacta: ni se recortó ni se deformó.
    expect(salida.width / salida.height).toBeCloseTo(800 / 1000, 2);
  });

  it('no transpone la página: lo vertical sigue vertical', () => {
    /*
     * La otra mitad de la orientación. El navegador entrega la imagen ya
     * girada según el EXIF; lo que le toca a este código es no volver a
     * girarla. Una página que entra vertical tiene que salir vertical.
     */
    const mapa = hoja(900, 1400, rectanguloRotado(900, 1400, 100, 3));
    const { mapa: salida } = prepararPagina(mapa);
    expect(salida.height).toBeGreaterThan(salida.width);
  });

  it('conserva resolución suficiente para leer', () => {
    const mapa = hoja(3000, 4000, rectanguloRotado(3000, 4000, 200, 4));
    const { mapa: salida } = prepararPagina(mapa);
    // Se baja a la resolución de trabajo, pero no por debajo.
    expect(Math.max(salida.width, salida.height)).toBeGreaterThanOrEqual(2000);
  });
});

describe('la orientación de las fotos reales', () => {
  const FOTOS = path.resolve(__dirname, '../fixtures/imagenes');

  for (const archivo of [
    'errecalde-00008-00002647.jpg',
    'los-calvos-0010-00212356.jpg',
    'mabelherdi-0007-00348491.jpg',
  ]) {
    it(`${archivo}: los píxeles vienen apaisados y el papel es vertical`, async () => {
      const bytes = readFileSync(path.join(FOTOS, archivo));
      const meta = await sharp(bytes).metadata();

      // Orientación 6: hay que girar para verla derecha. Es lo que entrega el
      // iPhone y lo que el navegador aplica al decodificar.
      expect(meta.orientation).toBe(6);

      const sinGirar = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
      const girada = await sharp(bytes).rotate().raw().toBuffer({ resolveWithObject: true });

      // Apaisada en el archivo, vertical una vez aplicada la orientación. Si
      // alguien girara de más, esto dejaría de cumplirse.
      expect(sinGirar.info.width).toBeGreaterThan(sinGirar.info.height);
      expect(girada.info.height).toBeGreaterThan(girada.info.width);
      expect(girada.info.width).toBe(sinGirar.info.height);
    });
  }
});
