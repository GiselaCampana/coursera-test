import { alto, ancho, centroX, centroY, type Caja, type Fragmento } from '@/lib/ocr/reconstruccion/evidencia';

/**
 * Enderezar la evidencia antes de agruparla en renglones.
 *
 * Una foto sacada a mano nunca está derecha. Sobre una página apaisada, medio
 * grado de inclinación mueve el borde derecho casi un uno por ciento del alto:
 * más que el alto de un renglón. Agrupar por «misma y» sin corregir eso hace
 * que el código de artículo de una fila se junte con el importe de la de
 * arriba, que es exactamente el error que trajo la factura de Lácteos Barraza
 * al proyecto.
 *
 * No se rota la imagen: se corrige **la coordenada vertical de cada caja**,
 * restándole la altura que le agrega la inclinación en su posición horizontal.
 * Es más barato que volver a leer, y sobre todo es reversible: la caja original
 * se conserva, así que lo que se le muestra a una persona sigue estando donde
 * está en la foto.
 */

/** La inclinación medida, en pendiente (alto sobre ancho) y no en grados. */
export interface Inclinacion {
  /** Cuánto baja la línea por cada unidad de ancho. Positivo = cae a la derecha. */
  pendiente: number;
  /** Cuántas parejas de fragmentos la sostienen. */
  apoyos: number;
}

/**
 * Mide la inclinación con la mediana de las pendientes entre vecinos.
 *
 * Se toman pares de fragmentos que están **a la misma altura y separados
 * horizontalmente**, y se mira cuánto sube o baja el segundo respecto del
 * primero. Sobre un texto derecho esas pendientes se reparten alrededor de
 * cero; sobre uno inclinado se agrupan alrededor de la inclinación real.
 *
 * La mediana y no el promedio: alcanza con que un par de fragmentos de renglones
 * distintos se cuelen como vecinos —y se cuelan— para que un promedio se vaya a
 * cualquier lado. La mediana aguanta hasta la mitad de pares equivocados.
 */
export function medirInclinacion(fragmentos: Fragmento[]): Inclinacion {
  const alturaTipica = alturaDeRenglon(fragmentos);
  if (alturaTipica === 0) return { pendiente: 0, apoyos: 0 };

  const ordenados = [...fragmentos].sort((a, b) => a.caja.x0 - b.caja.x0);
  const pendientes: number[] = [];

  for (let i = 0; i < ordenados.length; i++) {
    const a = ordenados[i];
    for (let j = i + 1; j < ordenados.length; j++) {
      const b = ordenados[j];
      const dx = centroX(b.caja) - centroX(a.caja);
      // Demasiado cerca: la pendiente entre dos palabras pegadas es ruido puro.
      if (dx < 0.05) continue;
      // Demasiado lejos no, pero sí hace falta que sean del mismo renglón, y
      // eso es justamente lo que todavía no se sabe. Se pide que la diferencia
      // de altura sea chica comparada con el alto de un renglón: los pares de
      // renglones distintos quedan afuera casi siempre, y los pocos que entran
      // los absorbe la mediana.
      const dy = centroY(b.caja) - centroY(a.caja);
      if (Math.abs(dy) > alturaTipica) continue;
      pendientes.push(dy / dx);
      // Un solo vecino por fragmento: si no, las líneas largas pesan de más.
      break;
    }
  }

  if (pendientes.length < 8) return { pendiente: 0, apoyos: pendientes.length };
  pendientes.sort((a, b) => a - b);
  const mediana = pendientes[Math.floor(pendientes.length / 2)];
  return { pendiente: mediana, apoyos: pendientes.length };
}

/**
 * El alto típico de un renglón, por la mediana de los altos de los fragmentos.
 *
 * Es la unidad con la que se mide todo lo demás: qué tan cerca es «cerca» en
 * vertical, cuánta inclinación es mucha, cuándo dos fragmentos son del mismo
 * renglón. Que salga de la propia evidencia y no de una constante es lo que
 * hace que funcione igual en una foto de 1080 y en una de 4032.
 */
export function alturaDeRenglon(fragmentos: Fragmento[]): number {
  const altos = fragmentos
    .map((f) => alto(f.caja))
    .filter((h) => h > 0)
    .sort((a, b) => a - b);
  if (altos.length === 0) return 0;
  return altos[Math.floor(altos.length / 2)];
}

/**
 * Devuelve los fragmentos con la vertical corregida.
 *
 * La caja original queda en `cajaOriginal`, sin excepción: es lo que permite
 * mostrarle a una persona dónde está el dato en la foto, y es lo que permite
 * revisar la corrección si algo sale raro.
 */
export interface FragmentoEnderezado extends Fragmento {
  cajaOriginal: Caja;
}

export function enderezar(
  fragmentos: Fragmento[],
  inclinacion: Inclinacion,
): FragmentoEnderezado[] {
  return fragmentos.map((f) => {
    if (inclinacion.pendiente === 0) {
      return { ...f, cajaOriginal: f.caja };
    }
    // Se corrige respecto del centro horizontal de la página: así la corrección
    // reparte el movimiento a los dos lados en vez de arrastrar todo hacia uno.
    const correccion = (centroX(f.caja) - 0.5) * inclinacion.pendiente;
    return {
      ...f,
      cajaOriginal: f.caja,
      caja: {
        x0: f.caja.x0,
        y0: f.caja.y0 - correccion,
        x1: f.caja.x1,
        y1: f.caja.y1 - correccion,
      },
    };
  });
}

/**
 * ¿Vale la pena corregir?
 *
 * Por debajo de un cuarto de renglón de desvío entre los dos bordes de la
 * página, la corrección no cambia ninguna agrupación y sólo agrega una
 * transformación que explicar. El umbral está en la unidad que importa —altos
 * de renglón— y no en grados, porque lo que decide si dos fragmentos se
 * confunden es cuánto se movieron comparado con lo alto que es un renglón.
 */
export function valeLaPenaEnderezar(inclinacion: Inclinacion, alturaTipica: number): boolean {
  if (alturaTipica <= 0) return false;
  const desvioDePuntaAPunta = Math.abs(inclinacion.pendiente);
  return desvioDePuntaAPunta > alturaTipica * 0.25;
}

/** Para el informe: la inclinación en grados, que es como la lee una persona. */
export function enGrados(inclinacion: Inclinacion): number {
  return (Math.atan(inclinacion.pendiente) * 180) / Math.PI;
}

export { ancho, alto };
