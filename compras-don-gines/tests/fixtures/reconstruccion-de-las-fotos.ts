import { readFileSync } from 'node:fs';
import path from 'node:path';
import { interpretarReconstruccion } from '@/lib/ocr/motor/desde-reconstruccion';
import type { InformeReconstruido } from '@/lib/ocr/motor/desde-reconstruccion';
import type { EvidenciaDeLectura } from '@/lib/ocr/reconstruccion/evidencia';
import { asociacionesDePrueba } from './evidencia-sintetica';

/**
 * La reconstrucción de las seis fotos reales, armada una sola vez.
 *
 * Vive acá porque la miran dos suites que preguntan cosas distintas: la
 * funcional, que afirma **qué** se leyó y no depende de ningún reloj, y la de
 * rendimiento, que mide **cuánto tardó** y sí depende de la máquina. Tenerlas
 * en el mismo archivo hacía que la segunda decidiera si la primera contaba,
 * que es como una fluctuación de reloj terminaba tapando una lectura correcta.
 *
 * La evidencia está capturada de las fotos de verdad con
 * `scripts/capturar-evidencia.mjs` y guardada como fixture, así que esto es
 * determinístico: la misma foto da siempre la misma tabla.
 */

const DIRECTORIO = path.resolve(__dirname, 'evidencia');

/** El CUIT de Don Ginés, que nunca identifica al emisor de una factura. */
export const CUIT_DEL_RECEPTOR = '27-33342291-9';

/** La evidencia capturada de una foto, tal como quedó guardada. */
export function leerEvidencia(nombre: string): EvidenciaDeLectura {
  return JSON.parse(readFileSync(path.join(DIRECTORIO, `${nombre}.json`), 'utf8'));
}

/**
 * Las unidades de compra de cada renglón, que el papel no dice.
 *
 * Vienen del catálogo, no del comprobante: en Ezra los cinco primeros son
 * kilos y BOLSA GRANDE se compra por unidad, y no hay nada impreso que lo
 * distinga.
 */
function unidadesDe(nombre: string): readonly ('KG' | 'UNIT')[] {
  switch (nombre) {
    case 'ezra':
      return ['KG', 'KG', 'KG', 'KG', 'KG', 'UNIT'] as const;
    case 'mabelherdi':
      return Array.from({ length: 9 }, () => 'UNIT' as const);
    case 'barraza':
      return Array.from({ length: 2 }, () => 'KG' as const);
    case 'errecalde':
      return Array.from({ length: 23 }, () => 'KG' as const);
    case 'los-calvos-212356':
      return Array.from({ length: 1 }, () => 'KG' as const);
    default:
      return Array.from({ length: 11 }, () => 'KG' as const);
  }
}

export function interpretarFoto(nombre: string): InformeReconstruido {
  return interpretarReconstruccion(leerEvidencia(nombre), {
    cuitDelReceptor: CUIT_DEL_RECEPTOR,
    asociacionesDeProducto: asociacionesDePrueba(unidadesDe(nombre)),
  });
}

export const ERRECALDE = interpretarFoto('errecalde');
export const MABELHERDI = interpretarFoto('mabelherdi');
export const EZRA = interpretarFoto('ezra');
export const BARRAZA = interpretarFoto('barraza');
export const CALVOS_212356 = interpretarFoto('los-calvos-212356');
export const CALVOS_213103 = interpretarFoto('los-calvos-213103');

export const TODAS = [
  ['Errecalde', ERRECALDE],
  ['Mabelherdi', MABELHERDI],
  ['Ezra', EZRA],
  ['Barraza', BARRAZA],
  ['Los Calvos 212356', CALVOS_212356],
  ['Los Calvos 213103', CALVOS_213103],
] as const;
