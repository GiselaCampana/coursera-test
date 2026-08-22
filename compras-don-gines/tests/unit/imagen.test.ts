import { describe, it, expect } from 'vitest';
import {
  aEscalaDeGrises,
  ampliar,
  binarizarSauvola,
  clonarMapa,
  corregirPerspectiva,
  crearMapa,
  detectarEsquinas,
  enderezar,
  enfocar,
  escalar,
  estimarInclinacion,
  normalizarContraste,
  recortar,
  reducirRuido,
  rotar,
  umbralOtsu,
  type Mapa,
} from '@/lib/cliente/ocr/imagen';

/** Mapa de color plano. */
function lienzo(width: number, height: number, r = 255, g = 255, b = 255): Mapa {
  const mapa = crearMapa(width, height);
  for (let i = 0; i < mapa.data.length; i += 4) {
    mapa.data[i] = r;
    mapa.data[i + 1] = g;
    mapa.data[i + 2] = b;
    mapa.data[i + 3] = 255;
  }
  return mapa;
}

function pintar(mapa: Mapa, x: number, y: number, valor: number) {
  const i = (y * mapa.width + x) * 4;
  mapa.data[i] = valor;
  mapa.data[i + 1] = valor;
  mapa.data[i + 2] = valor;
  mapa.data[i + 3] = 255;
}

function leer(mapa: Mapa, x: number, y: number): number {
  return mapa.data[(y * mapa.width + x) * 4];
}

/** Rectángulo relleno. */
function rectangulo(mapa: Mapa, x0: number, y0: number, ancho: number, alto: number, valor: number) {
  for (let y = y0; y < y0 + alto; y++) {
    for (let x = x0; x < x0 + ancho; x++) {
      if (x >= 0 && y >= 0 && x < mapa.width && y < mapa.height) pintar(mapa, x, y, valor);
    }
  }
}

/** Renglones de texto simulados: bandas oscuras separadas por blanco. */
function conRenglones(ancho: number, alto: number, cantidad: number): Mapa {
  const mapa = lienzo(ancho, alto);
  const separacion = Math.floor(alto / (cantidad + 1));
  for (let i = 1; i <= cantidad; i++) {
    rectangulo(mapa, Math.floor(ancho * 0.1), i * separacion, Math.floor(ancho * 0.8), 3, 30);
  }
  return mapa;
}

describe('escala de grises', () => {
  it('usa luma perceptual, no el promedio de los canales', () => {
    const mapa = lienzo(2, 1, 255, 0, 0); // rojo puro
    aEscalaDeGrises(mapa);
    // Luma del rojo: 0,299 × 255 ≈ 76. El promedio daría 85.
    expect(leer(mapa, 0, 0)).toBe(76);
  });

  it('deja igual lo que ya era gris', () => {
    const mapa = lienzo(2, 1, 120, 120, 120);
    aEscalaDeGrises(mapa);
    expect(leer(mapa, 0, 0)).toBe(120);
  });
});

describe('contraste', () => {
  it('estira una imagen apagada a todo el rango', () => {
    const mapa = lienzo(20, 20, 100, 100, 100);
    // Una zona apenas más clara: sin estirar, el OCR no la distingue.
    rectangulo(mapa, 5, 5, 10, 10, 140);
    normalizarContraste(mapa, 0);

    const valores = new Set<number>();
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) valores.add(leer(mapa, x, y));
    expect(Math.min(...valores)).toBe(0);
    expect(Math.max(...valores)).toBe(255);
  });

  it('no se deja arruinar por un píxel quemado por el flash', () => {
    const mapa = lienzo(30, 30, 100, 100, 100);
    rectangulo(mapa, 5, 5, 20, 20, 150);
    pintar(mapa, 0, 0, 255); // el reflejo

    normalizarContraste(mapa, 0.01);
    // El bloque llega igual al blanco: el píxel suelto quedó descartado.
    expect(leer(mapa, 10, 10)).toBe(255);
  });
});

describe('ruido', () => {
  it('borra los píxeles sueltos del grano', () => {
    const mapa = lienzo(9, 9, 200, 200, 200);
    pintar(mapa, 4, 4, 0); // un grano negro aislado
    reducirRuido(mapa);
    expect(leer(mapa, 4, 4)).toBe(200);
  });

  it('no se come el filo de una letra', () => {
    const mapa = lienzo(11, 11, 255, 255, 255);
    // Un trazo vertical grueso: tiene que sobrevivir a la mediana.
    rectangulo(mapa, 4, 1, 3, 9, 0);
    reducirRuido(mapa);
    expect(leer(mapa, 5, 5)).toBe(0);
  });
});

describe('enfoque', () => {
  it('aumenta el salto entre la tinta y el papel', () => {
    const mapa = lienzo(11, 11, 255, 255, 255);
    rectangulo(mapa, 0, 0, 6, 11, 120);
    const antes = leer(mapa, 5, 5) - leer(mapa, 6, 5);
    enfocar(mapa, 0.8);
    const despues = leer(mapa, 5, 5) - leer(mapa, 6, 5);
    expect(Math.abs(despues)).toBeGreaterThan(Math.abs(antes));
  });
});

describe('binarizado adaptativo', () => {
  it('rescata el texto de la mitad en sombra, donde un umbral global falla', () => {
    const mapa = lienzo(120, 60, 240, 240, 240);
    // Mitad derecha en sombra.
    rectangulo(mapa, 60, 0, 60, 60, 90);
    // Texto: oscuro sobre el papel claro, y oscuro sobre la sombra.
    rectangulo(mapa, 10, 25, 20, 6, 40);
    rectangulo(mapa, 75, 25, 20, 6, 20);

    // Con un umbral global, la sombra (90) no supera el umbral, así que toda
    // esa zona se clasificaría como tinta: la mitad de la factura se perdería.
    const umbral = umbralOtsu(clonarMapa(mapa));
    expect(90).toBeLessThanOrEqual(umbral);

    binarizarSauvola(mapa, 21, 0.2);
    // El texto queda negro en las dos zonas…
    expect(leer(mapa, 20, 27)).toBe(0);
    expect(leer(mapa, 85, 27)).toBe(0);
    // …y el papel queda blanco en las dos, incluida la sombra.
    expect(leer(mapa, 45, 10)).toBe(255);
    expect(leer(mapa, 110, 10)).toBe(255);
  });
});

describe('escala y recorte', () => {
  it('amplía manteniendo la proporción', () => {
    const mapa = lienzo(40, 20);
    const grande = ampliar(mapa, 2.5);
    expect(grande.width).toBe(100);
    expect(grande.height).toBe(50);
  });

  it('interpola en vez de repetir píxeles', () => {
    const mapa = lienzo(2, 1, 0, 0, 0);
    pintar(mapa, 1, 0, 255);
    const grande = escalar(mapa, 8, 1);
    const valores = [];
    for (let x = 0; x < 8; x++) valores.push(leer(grande, x, 0));
    // Hay valores intermedios: no es vecino más cercano.
    expect(valores.some((v) => v > 10 && v < 245)).toBe(true);
  });

  it('recorta la región pedida en coordenadas relativas', () => {
    const mapa = lienzo(100, 100, 255, 255, 255);
    rectangulo(mapa, 50, 0, 50, 100, 0);
    const derecha = recortar(mapa, { left: 0.5, top: 0, width: 0.5, height: 1 });
    expect(derecha.width).toBe(50);
    expect(leer(derecha, 10, 10)).toBe(0);
  });

  it('no se pasa de los bordes aunque le pidan una región imposible', () => {
    const mapa = lienzo(50, 50);
    const recorte = recortar(mapa, { left: 0.9, top: 0.9, width: 5, height: 5 });
    expect(recorte.width).toBeLessThanOrEqual(50);
    expect(recorte.height).toBeLessThanOrEqual(50);
    expect(recorte.width).toBeGreaterThan(0);
  });
});

describe('enderezado', () => {
  it('detecta la inclinación de un texto torcido', () => {
    const derecho = conRenglones(400, 300, 8);
    const torcido = rotar(derecho, 3);

    const angulo = estimarInclinacion(torcido);
    // Para volver a enderezarlo hay que rotar en sentido contrario.
    expect(angulo).toBeLessThan(-1.5);
    expect(angulo).toBeGreaterThan(-4.5);
  });

  it('no toca una imagen que ya está derecha', () => {
    const derecho = conRenglones(400, 300, 8);
    const { angulo } = enderezar(derecho);
    expect(Math.abs(angulo)).toBeLessThan(1);
  });

  it('enderezar deja los renglones más definidos que antes', () => {
    const derecho = conRenglones(400, 300, 8);
    const torcido = rotar(derecho, 3.5);
    const { mapa: corregido } = enderezar(clonarMapa(torcido));

    const nitidez = (m: Mapa) => {
      let varianza = 0;
      const perfil: number[] = [];
      for (let y = 0; y < m.height; y++) {
        let tinta = 0;
        for (let x = 0; x < m.width; x++) tinta += 255 - leer(m, x, y);
        perfil.push(tinta);
      }
      const media = perfil.reduce((a, b) => a + b, 0) / perfil.length;
      for (const v of perfil) varianza += (v - media) ** 2;
      return varianza / perfil.length;
    };

    expect(nitidez(corregido)).toBeGreaterThan(nitidez(torcido));
  });
});

describe('perspectiva', () => {
  it('encuentra las esquinas de un papel girado 45°, donde las diagonales empatan', () => {
    // Fondo oscuro (el mostrador) con un papel claro girado adentro.
    const mapa = lienzo(200, 200, 40, 40, 40);
    // Rombo claro: sus extremos son las cuatro esquinas del papel.
    for (let y = 0; y < 200; y++) {
      for (let x = 0; x < 200; x++) {
        if (Math.abs(x - 100) + Math.abs(y - 100) < 70) pintar(mapa, x, y, 235);
      }
    }

    const esquinas = detectarEsquinas(mapa);
    expect(esquinas).not.toBeNull();
    const [supIzq, supDer, infDer, infIzq] = esquinas!;
    // Arriba, derecha, abajo e izquierda del rombo.
    expect(supIzq.y).toBeLessThan(60);
    expect(supDer.x).toBeGreaterThan(140);
    expect(infDer.y).toBeGreaterThan(140);
    expect(infIzq.x).toBeLessThan(60);
  });

  it('no corrige cuando el papel ya ocupa toda la foto', () => {
    const mapa = lienzo(120, 120, 250, 250, 250);
    expect(detectarEsquinas(mapa)).toBeNull();
  });

  it('no corrige cuando el papel no se distingue del fondo', () => {
    const mapa = lienzo(120, 120, 30, 30, 30);
    rectangulo(mapa, 50, 50, 12, 12, 60);
    expect(detectarEsquinas(mapa)).toBeNull();
  });

  it('endereza el cuadrilátero a un rectángulo', () => {
    const mapa = lienzo(200, 200, 30, 30, 30);
    // Papel en trapecio, como sale al fotografiar desde arriba en ángulo.
    const esquinas: [
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
      { x: number; y: number },
    ] = [
      { x: 40, y: 20 },
      { x: 160, y: 40 },
      { x: 150, y: 180 },
      { x: 30, y: 160 },
    ];
    // Se pinta el interior del trapecio de claro, con una marca reconocible.
    for (let y = 0; y < 200; y++) {
      for (let x = 0; x < 200; x++) {
        if (dentroDelCuadrilatero(x, y, esquinas)) pintar(mapa, x, y, 240);
      }
    }

    const corregido = corregirPerspectiva(mapa, esquinas);
    // El resultado es un rectángulo del tamaño de los lados del trapecio…
    expect(corregido.width).toBeGreaterThan(100);
    expect(corregido.height).toBeGreaterThan(100);
    // …y su centro cae dentro del papel, no en el mostrador.
    expect(leer(corregido, corregido.width >> 1, corregido.height >> 1)).toBeGreaterThan(200);
  });
});

function dentroDelCuadrilatero(
  x: number,
  y: number,
  puntos: { x: number; y: number }[],
): boolean {
  let dentro = false;
  for (let i = 0, j = puntos.length - 1; i < puntos.length; j = i++) {
    const xi = puntos[i].x;
    const yi = puntos[i].y;
    const xj = puntos[j].x;
    const yj = puntos[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}
