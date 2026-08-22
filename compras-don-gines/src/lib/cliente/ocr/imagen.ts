/**
 * Preprocesamiento de imágenes para el OCR.
 *
 * Todo opera sobre mapas de píxeles planos (`Mapa`), sin tocar el DOM, así que
 * las mismas funciones corren en el navegador sobre un `ImageData` y en las
 * pruebas sobre un buffer común. El puente con `<canvas>` está en `lienzo.ts`.
 *
 * Por qué Canvas y no OpenCV.js: OpenCV.js pesa unos 8 MB de WebAssembly que
 * habría que bajar además de los 4 MB del núcleo de Tesseract y 1,5 MB del
 * idioma. En un teléfono con datos móviles en el mostrador eso es caro, y todo
 * lo que hace falta acá —gris, contraste, ruido, enfoque, binarizado,
 * enderezado y corrección de perspectiva— entra en unas pocas decenas de líneas
 * cada uno. Si en el futuro hace falta detección de bordes más fina, la
 * interfaz de este módulo no cambia.
 */

export interface Mapa {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface Punto {
  x: number;
  y: number;
}

/** Región en coordenadas relativas 0..1. */
export interface Region {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function crearMapa(width: number, height: number): Mapa {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

export function clonarMapa(mapa: Mapa): Mapa {
  return { data: new Uint8ClampedArray(mapa.data), width: mapa.width, height: mapa.height };
}

// ---------------------------------------------------------------------------
// Gris y contraste
// ---------------------------------------------------------------------------

/** Luma perceptual: el rojo del sello y el azul de la lapicera no pesan igual. */
export function aEscalaDeGrises(mapa: Mapa): Mapa {
  const { data } = mapa;
  for (let i = 0; i < data.length; i += 4) {
    const gris = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    data[i] = gris;
    data[i + 1] = gris;
    data[i + 2] = gris;
  }
  return mapa;
}

/**
 * Estira el histograma descartando las colas.
 *
 * Se recorta un 1 % por lado en vez de usar el mínimo y el máximo absolutos:
 * un solo píxel quemado por el flash arruinaría el estiramiento.
 */
export function normalizarContraste(mapa: Mapa, recorte = 0.01): Mapa {
  const { data, width, height } = mapa;
  const total = width * height;
  const histograma = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) histograma[data[i]]++;

  const aDescartar = Math.floor(total * recorte);
  let minimo = 0;
  let maximo = 255;
  let acumulado = 0;
  for (let v = 0; v < 256; v++) {
    acumulado += histograma[v];
    if (acumulado > aDescartar) {
      minimo = v;
      break;
    }
  }
  acumulado = 0;
  for (let v = 255; v >= 0; v--) {
    acumulado += histograma[v];
    if (acumulado > aDescartar) {
      maximo = v;
      break;
    }
  }
  if (maximo <= minimo) return mapa;

  const escala = 255 / (maximo - minimo);
  const tabla = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) tabla[v] = (v - minimo) * escala;

  for (let i = 0; i < data.length; i += 4) {
    const nuevo = tabla[data[i]];
    data[i] = nuevo;
    data[i + 1] = nuevo;
    data[i + 2] = nuevo;
  }
  return mapa;
}

// ---------------------------------------------------------------------------
// Ruido y enfoque
// ---------------------------------------------------------------------------

/**
 * Mediana de 3×3.
 *
 * Contra el grano de las fotos con poca luz es mejor que un desenfoque
 * gaussiano: saca los píxeles sueltos sin comerse el filo de las letras, que es
 * justo lo que el OCR necesita conservar.
 */
export function reducirRuido(mapa: Mapa): Mapa {
  const { data, width, height } = mapa;
  const salida = new Uint8ClampedArray(data);
  const ventana = new Uint8Array(9);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          ventana[n++] = data[((y + dy) * width + (x + dx)) * 4];
        }
      }
      // Ordenamiento por inserción: con nueve elementos es más rápido que sort.
      for (let i = 1; i < 9; i++) {
        const actual = ventana[i];
        let j = i - 1;
        while (j >= 0 && ventana[j] > actual) {
          ventana[j + 1] = ventana[j];
          j--;
        }
        ventana[j + 1] = actual;
      }
      const indice = (y * width + x) * 4;
      salida[indice] = ventana[4];
      salida[indice + 1] = ventana[4];
      salida[indice + 2] = ventana[4];
    }
  }
  mapa.data.set(salida);
  return mapa;
}

/** Máscara de enfoque: devuelve filo a las letras después del suavizado. */
export function enfocar(mapa: Mapa, fuerza = 0.7): Mapa {
  const { data, width, height } = mapa;
  const original = new Uint8ClampedArray(data);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let suma = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          suma += original[((y + dy) * width + (x + dx)) * 4];
        }
      }
      const promedio = suma / 9;
      const indice = (y * width + x) * 4;
      const realzado = original[indice] + (original[indice] - promedio) * fuerza * 3;
      const valor = realzado < 0 ? 0 : realzado > 255 ? 255 : realzado;
      data[indice] = valor;
      data[indice + 1] = valor;
      data[indice + 2] = valor;
    }
  }
  return mapa;
}

// ---------------------------------------------------------------------------
// Binarizado
// ---------------------------------------------------------------------------

/**
 * Binarizado adaptativo de Sauvola.
 *
 * Un umbral global no sirve para la foto de una factura sobre el mostrador:
 * siempre hay una mitad con sombra y otra con el reflejo del tubo. Sauvola
 * decide el umbral píxel por píxel según la media y el desvío de su vecindario,
 * y se calcula en tiempo constante con imágenes integrales.
 */
export function binarizarSauvola(mapa: Mapa, ventana = 25, k = 0.2): Mapa {
  const { data, width, height } = mapa;
  const radio = Math.max(1, Math.floor(ventana / 2));

  // Imágenes integrales de la suma y de la suma de cuadrados.
  const ancho = width + 1;
  const suma = new Float64Array(ancho * (height + 1));
  const suma2 = new Float64Array(ancho * (height + 1));

  for (let y = 0; y < height; y++) {
    let filaSuma = 0;
    let filaSuma2 = 0;
    for (let x = 0; x < width; x++) {
      const valor = data[(y * width + x) * 4];
      filaSuma += valor;
      filaSuma2 += valor * valor;
      suma[(y + 1) * ancho + (x + 1)] = suma[y * ancho + (x + 1)] + filaSuma;
      suma2[(y + 1) * ancho + (x + 1)] = suma2[y * ancho + (x + 1)] + filaSuma2;
    }
  }

  const salida = new Uint8ClampedArray(data);
  const R = 128; // rango dinámico del desvío, el valor clásico de Sauvola

  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radio);
    const y1 = Math.min(height - 1, y + radio);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radio);
      const x1 = Math.min(width - 1, x + radio);
      const n = (x1 - x0 + 1) * (y1 - y0 + 1);

      const a = (y1 + 1) * ancho + (x1 + 1);
      const b = y0 * ancho + (x1 + 1);
      const c = (y1 + 1) * ancho + x0;
      const d = y0 * ancho + x0;

      const total = suma[a] - suma[b] - suma[c] + suma[d];
      const total2 = suma2[a] - suma2[b] - suma2[c] + suma2[d];
      const media = total / n;
      const varianza = Math.max(0, total2 / n - media * media);
      const desvio = Math.sqrt(varianza);
      const umbral = media * (1 + k * (desvio / R - 1));

      const indice = (y * width + x) * 4;
      const valor = data[indice] > umbral ? 255 : 0;
      salida[indice] = valor;
      salida[indice + 1] = valor;
      salida[indice + 2] = valor;
    }
  }
  mapa.data.set(salida);
  return mapa;
}

/** Umbral global por el método de Otsu. Se usa para separar papel de fondo. */
export function umbralOtsu(mapa: Mapa): number {
  const { data, width, height } = mapa;
  const total = width * height;
  const histograma = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) histograma[data[i]]++;

  let sumaTotal = 0;
  for (let v = 0; v < 256; v++) sumaTotal += v * histograma[v];

  let sumaFondo = 0;
  let pesoFondo = 0;
  let mejorVarianza = -1;
  let mejorUmbral = 127;

  for (let v = 0; v < 256; v++) {
    pesoFondo += histograma[v];
    if (pesoFondo === 0) continue;
    const pesoFrente = total - pesoFondo;
    if (pesoFrente === 0) break;

    sumaFondo += v * histograma[v];
    const mediaFondo = sumaFondo / pesoFondo;
    const mediaFrente = (sumaTotal - sumaFondo) / pesoFrente;
    const entreClases = pesoFondo * pesoFrente * (mediaFondo - mediaFrente) ** 2;

    if (entreClases > mejorVarianza) {
      mejorVarianza = entreClases;
      mejorUmbral = v;
    }
  }
  return mejorUmbral;
}

// ---------------------------------------------------------------------------
// Escala, recorte y rotación
// ---------------------------------------------------------------------------

/** Reescala con interpolación bilineal. */
export function escalar(mapa: Mapa, anchoDestino: number, altoDestino: number): Mapa {
  const destino = crearMapa(anchoDestino, altoDestino);
  const escalaX = mapa.width / anchoDestino;
  const escalaY = mapa.height / altoDestino;

  for (let y = 0; y < altoDestino; y++) {
    const origenY = Math.min(mapa.height - 1, (y + 0.5) * escalaY - 0.5);
    const y0 = Math.max(0, Math.floor(origenY));
    const y1 = Math.min(mapa.height - 1, y0 + 1);
    const py = origenY - y0;

    for (let x = 0; x < anchoDestino; x++) {
      const origenX = Math.min(mapa.width - 1, (x + 0.5) * escalaX - 0.5);
      const x0 = Math.max(0, Math.floor(origenX));
      const x1 = Math.min(mapa.width - 1, x0 + 1);
      const px = origenX - x0;

      for (let canal = 0; canal < 3; canal++) {
        const v00 = mapa.data[(y0 * mapa.width + x0) * 4 + canal];
        const v10 = mapa.data[(y0 * mapa.width + x1) * 4 + canal];
        const v01 = mapa.data[(y1 * mapa.width + x0) * 4 + canal];
        const v11 = mapa.data[(y1 * mapa.width + x1) * 4 + canal];
        const arriba = v00 + (v10 - v00) * px;
        const abajo = v01 + (v11 - v01) * px;
        destino.data[(y * anchoDestino + x) * 4 + canal] = arriba + (abajo - arriba) * py;
      }
      destino.data[(y * anchoDestino + x) * 4 + 3] = 255;
    }
  }
  return destino;
}

/** Amplía por un factor. Tesseract lee bastante mejor con las letras grandes. */
export function ampliar(mapa: Mapa, factor: number): Mapa {
  if (factor === 1) return mapa;
  return escalar(mapa, Math.round(mapa.width * factor), Math.round(mapa.height * factor));
}

export function recortar(mapa: Mapa, region: Region): Mapa {
  const limitar = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
  const x0 = Math.round(limitar(region.left, 0, 1) * mapa.width);
  const y0 = Math.round(limitar(region.top, 0, 1) * mapa.height);
  const ancho = Math.max(1, Math.min(mapa.width - x0, Math.round(region.width * mapa.width)));
  const alto = Math.max(1, Math.min(mapa.height - y0, Math.round(region.height * mapa.height)));

  const destino = crearMapa(ancho, alto);
  for (let y = 0; y < alto; y++) {
    const origen = ((y0 + y) * mapa.width + x0) * 4;
    destino.data.set(mapa.data.subarray(origen, origen + ancho * 4), y * ancho * 4);
  }
  return destino;
}

/** Rota un ángulo chico alrededor del centro, rellenando con blanco. */
export function rotar(mapa: Mapa, grados: number): Mapa {
  if (Math.abs(grados) < 0.05) return mapa;
  const radianes = (grados * Math.PI) / 180;
  const cos = Math.cos(radianes);
  const sen = Math.sin(radianes);
  const { width, height } = mapa;
  const destino = crearMapa(width, height);
  destino.data.fill(255);

  const cx = width / 2;
  const cy = height / 2;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Se recorre el destino y se busca en el origen: no quedan huecos.
      const dx = x - cx;
      const dy = y - cy;
      const ox = Math.round(cx + dx * cos + dy * sen);
      const oy = Math.round(cy - dx * sen + dy * cos);
      if (ox < 0 || oy < 0 || ox >= width || oy >= height) continue;

      const origen = (oy * width + ox) * 4;
      const indice = (y * width + x) * 4;
      destino.data[indice] = mapa.data[origen];
      destino.data[indice + 1] = mapa.data[origen + 1];
      destino.data[indice + 2] = mapa.data[origen + 2];
      destino.data[indice + 3] = 255;
    }
  }
  return destino;
}

// ---------------------------------------------------------------------------
// Enderezado
// ---------------------------------------------------------------------------

/**
 * Estima la inclinación del texto.
 *
 * Se prueban varios ángulos y se elige el que hace más "picuda" la proyección
 * horizontal: cuando los renglones quedan derechos, cada uno concentra su tinta
 * en pocas filas y la varianza del perfil se dispara.
 */
export function estimarInclinacion(mapa: Mapa, maximo = 6, paso = 0.25): number {
  // Se trabaja sobre una copia chica: el ángulo no necesita toda la resolución.
  const escala = Math.min(1, 800 / Math.max(mapa.width, mapa.height));
  const chico =
    escala < 1
      ? escalar(mapa, Math.round(mapa.width * escala), Math.round(mapa.height * escala))
      : mapa;

  let mejorAngulo = 0;
  let mejorPuntaje = -1;

  for (let angulo = -maximo; angulo <= maximo; angulo += paso) {
    const rotado = angulo === 0 ? chico : rotar(clonarMapa(chico), angulo);
    const puntaje = varianzaDelPerfil(rotado);
    if (puntaje > mejorPuntaje) {
      mejorPuntaje = puntaje;
      mejorAngulo = angulo;
    }
  }
  return mejorAngulo;
}

function varianzaDelPerfil(mapa: Mapa): number {
  const { data, width, height } = mapa;
  const perfil = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    let tinta = 0;
    for (let x = 0; x < width; x++) {
      // Cuanto más oscuro, más tinta.
      tinta += 255 - data[(y * width + x) * 4];
    }
    perfil[y] = tinta;
  }
  let media = 0;
  for (let y = 0; y < height; y++) media += perfil[y];
  media /= height;

  let varianza = 0;
  for (let y = 0; y < height; y++) varianza += (perfil[y] - media) ** 2;
  return varianza / height;
}

export function enderezar(mapa: Mapa): { mapa: Mapa; angulo: number } {
  const angulo = estimarInclinacion(mapa);
  return { mapa: Math.abs(angulo) < 0.25 ? mapa : rotar(mapa, angulo), angulo };
}

// ---------------------------------------------------------------------------
// Perspectiva
// ---------------------------------------------------------------------------

/**
 * Busca las cuatro esquinas del papel.
 *
 * La foto de una factura sobre el mostrador tiene el papel bastante más claro
 * que lo que lo rodea. Se separa con Otsu, se toma la región clara y se buscan
 * sus cuatro extremos por las diagonales: el mínimo de (x+y) es la esquina
 * superior izquierda, el máximo la inferior derecha, y análogamente con (x−y).
 *
 * Devuelve null si el papel ocupa casi toda la imagen (no hay nada que
 * corregir) o si no se distingue del fondo: más vale no tocar la foto que
 * recortarla mal.
 */
export function detectarEsquinas(mapa: Mapa): [Punto, Punto, Punto, Punto] | null {
  const escala = Math.min(1, 500 / Math.max(mapa.width, mapa.height));
  const chico =
    escala < 1
      ? escalar(clonarMapa(mapa), Math.round(mapa.width * escala), Math.round(mapa.height * escala))
      : clonarMapa(mapa);
  aEscalaDeGrises(chico);

  const umbral = umbralOtsu(chico);
  const { width, height, data } = chico;

  // Del área clara alcanza con su contorno: los píxeles del interior no aportan
  // nada a la envolvente y multiplican el trabajo.
  const contorno: Punto[] = [];
  let claros = 0;

  for (let y = 0; y < height; y++) {
    let primero = -1;
    let ultimo = -1;
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4] <= umbral) continue;
      claros++;
      if (primero < 0) primero = x;
      ultimo = x;
    }
    if (primero >= 0) {
      contorno.push({ x: primero, y });
      if (ultimo !== primero) contorno.push({ x: ultimo, y });
    }
  }

  if (contorno.length < 4) return null;

  const proporcionClara = claros / (width * height);
  // Si el papel casi no se distingue del fondo, o si ya ocupa toda la foto,
  // corregir la perspectiva sólo puede empeorar las cosas.
  if (proporcionClara < 0.2 || proporcionClara > 0.95) return null;

  const hull = envolventeConvexa(contorno);
  if (hull.length < 4) return null;

  const cuadrilatero = cuadrilateroDeAreaMaxima(hull);
  if (!cuadrilatero) return null;

  const factor = 1 / (escala < 1 ? escala : 1);
  const aOriginal = (p: Punto): Punto => ({
    x: Math.min(mapa.width - 1, Math.round(p.x * factor)),
    y: Math.min(mapa.height - 1, Math.round(p.y * factor)),
  });

  const esquinas = ordenarEsquinas(cuadrilatero.map(aOriginal));

  // Un cuadrilátero degenerado no sirve.
  const lado = (a: Punto, b: Punto) => Math.hypot(a.x - b.x, a.y - b.y);
  const minimo = Math.min(
    lado(esquinas[0], esquinas[1]),
    lado(esquinas[1], esquinas[2]),
    lado(esquinas[2], esquinas[3]),
    lado(esquinas[3], esquinas[0]),
  );
  if (minimo < Math.min(mapa.width, mapa.height) * 0.25) return null;

  return esquinas;
}

/** Envolvente convexa por cadena monótona de Andrew. */
export function envolventeConvexa(puntos: Punto[]): Punto[] {
  if (puntos.length < 3) return [...puntos];
  const orden = [...puntos].sort((a, b) => a.x - b.x || a.y - b.y);

  const cruz = (o: Punto, a: Punto, b: Punto) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const inferior: Punto[] = [];
  for (const p of orden) {
    while (inferior.length >= 2 && cruz(inferior[inferior.length - 2], inferior[inferior.length - 1], p) <= 0) {
      inferior.pop();
    }
    inferior.push(p);
  }

  const superior: Punto[] = [];
  for (let i = orden.length - 1; i >= 0; i--) {
    const p = orden[i];
    while (superior.length >= 2 && cruz(superior[superior.length - 2], superior[superior.length - 1], p) <= 0) {
      superior.pop();
    }
    superior.push(p);
  }

  inferior.pop();
  superior.pop();
  return inferior.concat(superior);
}

/**
 * Cuadrilátero de área máxima inscripto en la envolvente.
 *
 * Reemplaza a la heurística de "mínimo y máximo de x+y y de x−y", que colapsa
 * cuando el papel está girado cerca de 45°: ahí los extremos de las dos
 * diagonales caen sobre el mismo vértice y el cuadrilátero se degenera. Buscar
 * el área máxima no depende del ángulo.
 *
 * Para cada diagonal se toma el mejor vértice de cada lado. La envolvente se
 * submuestrea a lo sumo a 120 puntos: con eso el costo queda acotado y la
 * pérdida de precisión es de un píxel sobre una imagen ya reducida.
 */
export function cuadrilateroDeAreaMaxima(hull: Punto[]): Punto[] | null {
  const n0 = hull.length;
  if (n0 < 4) return null;

  const MAXIMO = 120;
  const puntos =
    n0 <= MAXIMO
      ? hull
      : Array.from({ length: MAXIMO }, (_, i) => hull[Math.floor((i * n0) / MAXIMO)]);

  const n = puntos.length;
  const area2 = (a: Punto, b: Punto, c: Punto) =>
    Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));

  let mejorArea = -1;
  let mejor: Punto[] | null = null;

  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      // La diagonal i–j parte la envolvente en dos cadenas.
      let mejorIzq = -1;
      let areaIzq = -1;
      for (let k = i + 1; k < j; k++) {
        const a = area2(puntos[i], puntos[j], puntos[k]);
        if (a > areaIzq) {
          areaIzq = a;
          mejorIzq = k;
        }
      }
      let mejorDer = -1;
      let areaDer = -1;
      for (let k = j + 1; k < n + i; k++) {
        const indice = k % n;
        const a = area2(puntos[i], puntos[j], puntos[indice]);
        if (a > areaDer) {
          areaDer = a;
          mejorDer = indice;
        }
      }
      if (mejorIzq < 0 || mejorDer < 0) continue;

      const total = areaIzq + areaDer;
      if (total > mejorArea) {
        mejorArea = total;
        mejor = [puntos[i], puntos[mejorIzq], puntos[j], puntos[mejorDer]];
      }
    }
  }
  return mejor;
}

/** Ordena cuatro puntos como superior izquierda, superior derecha, inferior derecha, inferior izquierda. */
export function ordenarEsquinas(puntos: Punto[]): [Punto, Punto, Punto, Punto] {
  const centro = {
    x: puntos.reduce((s, p) => s + p.x, 0) / puntos.length,
    y: puntos.reduce((s, p) => s + p.y, 0) / puntos.length,
  };
  // Por ángulo alrededor del centro, empezando arriba a la izquierda.
  const porAngulo = [...puntos].sort(
    (a, b) => Math.atan2(a.y - centro.y, a.x - centro.x) - Math.atan2(b.y - centro.y, b.x - centro.x),
  );
  // atan2 arranca en −π (izquierda) y crece en sentido horario en pantalla.
  let inicio = 0;
  let mejor = Infinity;
  porAngulo.forEach((p, i) => {
    const distancia = p.x - centro.x + (p.y - centro.y);
    if (distancia < mejor) {
      mejor = distancia;
      inicio = i;
    }
  });
  const rotado = [...porAngulo.slice(inicio), ...porAngulo.slice(0, inicio)];
  return [rotado[0], rotado[1], rotado[2], rotado[3]];
}

/**
 * Endereza el cuadrilátero a un rectángulo.
 *
 * Se resuelve la homografía del destino al origen (8 incógnitas, sistema de
 * 8×8 por eliminación gaussiana) y se recorre el destino muestreando el origen,
 * que es la forma de no dejar huecos.
 */
export function corregirPerspectiva(
  mapa: Mapa,
  esquinas: [Punto, Punto, Punto, Punto],
): Mapa {
  const [supIzq, supDer, infDer, infIzq] = esquinas;
  const distancia = (a: Punto, b: Punto) => Math.hypot(a.x - b.x, a.y - b.y);

  const ancho = Math.round(Math.max(distancia(supIzq, supDer), distancia(infIzq, infDer)));
  const alto = Math.round(Math.max(distancia(supIzq, infIzq), distancia(supDer, infDer)));
  if (ancho < 16 || alto < 16) return mapa;

  const destinoPuntos: Punto[] = [
    { x: 0, y: 0 },
    { x: ancho - 1, y: 0 },
    { x: ancho - 1, y: alto - 1 },
    { x: 0, y: alto - 1 },
  ];

  const h = homografia(destinoPuntos, [supIzq, supDer, infDer, infIzq]);
  if (!h) return mapa;

  const salida = crearMapa(ancho, alto);
  salida.data.fill(255);

  for (let y = 0; y < alto; y++) {
    for (let x = 0; x < ancho; x++) {
      const denominador = h[6] * x + h[7] * y + 1;
      if (denominador === 0) continue;
      const ox = Math.round((h[0] * x + h[1] * y + h[2]) / denominador);
      const oy = Math.round((h[3] * x + h[4] * y + h[5]) / denominador);
      if (ox < 0 || oy < 0 || ox >= mapa.width || oy >= mapa.height) continue;

      const origen = (oy * mapa.width + ox) * 4;
      const indice = (y * ancho + x) * 4;
      salida.data[indice] = mapa.data[origen];
      salida.data[indice + 1] = mapa.data[origen + 1];
      salida.data[indice + 2] = mapa.data[origen + 2];
      salida.data[indice + 3] = 255;
    }
  }
  return salida;
}

/** Homografía que lleva `desde` a `hacia`, como los 8 coeficientes de la matriz. */
function homografia(desde: Punto[], hacia: Punto[]): number[] | null {
  const A: number[][] = [];
  const b: number[] = [];

  for (let i = 0; i < 4; i++) {
    const { x, y } = desde[i];
    const { x: u, y: v } = hacia[i];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    b.push(v);
  }

  // Eliminación gaussiana con pivoteo parcial.
  const n = 8;
  for (let columna = 0; columna < n; columna++) {
    let pivote = columna;
    for (let fila = columna + 1; fila < n; fila++) {
      if (Math.abs(A[fila][columna]) > Math.abs(A[pivote][columna])) pivote = fila;
    }
    if (Math.abs(A[pivote][columna]) < 1e-10) return null;
    [A[columna], A[pivote]] = [A[pivote], A[columna]];
    [b[columna], b[pivote]] = [b[pivote], b[columna]];

    for (let fila = columna + 1; fila < n; fila++) {
      const factor = A[fila][columna] / A[columna][columna];
      if (factor === 0) continue;
      for (let k = columna; k < n; k++) A[fila][k] -= factor * A[columna][k];
      b[fila] -= factor * b[columna];
    }
  }

  const h = new Array<number>(n).fill(0);
  for (let fila = n - 1; fila >= 0; fila--) {
    let suma = b[fila];
    for (let k = fila + 1; k < n; k++) suma -= A[fila][k] * h[k];
    h[fila] = suma / A[fila][fila];
  }
  return h;
}
