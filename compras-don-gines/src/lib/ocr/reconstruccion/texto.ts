import type { TextosComprobante } from '@/lib/ocr/parsers/tipos';
import { centroY, type EvidenciaDeLectura } from '@/lib/ocr/reconstruccion/evidencia';
import { agruparPorLugar, armarRenglones, textoPreferido } from '@/lib/ocr/reconstruccion/agrupar';
import {
  alturaDeRenglon,
  enderezar,
  medirInclinacion,
  valeLaPenaEnderezar,
} from '@/lib/ocr/reconstruccion/inclinacion';
import { esRuido } from '@/lib/ocr/reconstruccion/reconstruccion';

/**
 * Vuelve a armar el texto de la página desde la evidencia.
 *
 * Hace falta porque hay dos lectores que siguen trabajando sobre texto y está
 * bien que así sea: el del **emisor**, que busca la razón social y el CUIT en la
 * zona de arriba, y el del **pie fiscal**, que busca etiquetas. Los dos leen
 * prosa, no una tabla, y pasarlos a coordenadas no ganaría nada.
 *
 * Lo que sí cambia es de dónde sale ese texto. Antes era la concatenación cruda
 * de todas las pasadas, con cada línea repetida tantas veces como pasadas la
 * vieran y en un orden que no era el de la página. Acá sale de la evidencia ya
 * agrupada: una línea por renglón visual, en el orden en que están impresos, sin
 * duplicados entre pasadas.
 *
 * La separación entre celdas se escribe con espacios proporcionales a la
 * distancia real. Es lo que hace que el pie de una sola línea —«Saldo Ac. $
 * 532.848,64   Subtotal 473.232,44»— conserve la separación que permite
 * distinguir dos etiquetas de una.
 */
export function textoDeLaEvidencia(evidencia: EvidenciaDeLectura): TextosComprobante {
  const utiles = evidencia.fragmentos.filter((f) => !esRuido(f.texto));
  const alturaCruda = alturaDeRenglon(utiles);
  const inclinacion = medirInclinacion(utiles);
  const enderezados = enderezar(
    utiles,
    valeLaPenaEnderezar(inclinacion, alturaCruda) ? inclinacion : { pendiente: 0, apoyos: 0 },
  );

  const observaciones = agruparPorLugar(enderezados);
  const alturaTipica = alturaDeRenglon(enderezados) || alturaCruda;
  const renglones = armarRenglones(observaciones, alturaTipica);

  const lineas = renglones.map((renglon) => {
    let linea = '';
    let x = 0;
    for (const observacion of renglon.observaciones) {
      // Cien caracteres de ancho de página: es la escala con la que los
      // analizadores de texto vienen midiendo las columnas.
      const columna = Math.round(observacion.caja.x0 * 100);
      if (columna > x) linea += ' '.repeat(columna - x);
      else if (linea !== '') linea += ' ';
      linea += textoPreferido(observacion);
      x = Math.round(observacion.caja.x1 * 100);
    }
    return linea;
  });

  const completo = lineas.join('\n');

  /*
   * Las zonas salen por altura y no por pasada.
   *
   * Que un fragmento venga del recorte del encabezado no lo hace del
   * encabezado: los recortes se solapan a propósito para no partir renglones,
   * así que la banda de arriba trae también las primeras filas de la tabla.
   * Lo que ubica un dato es dónde está impreso.
   */
  const porBanda = (desde: number, hasta: number) =>
    renglones
      .filter((r) => centroY(r.caja) >= desde && centroY(r.caja) < hasta)
      .map((r) => lineas[renglones.indexOf(r)])
      .join('\n');

  return {
    completo,
    encabezado: porBanda(0, 0.32),
    articulos: porBanda(0.24, 0.84),
    resumen: porBanda(0.7, 1),
  };
}
