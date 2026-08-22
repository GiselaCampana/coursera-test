import { analizadorGenerico } from '@/lib/ocr/parsers/generico';
import { analizadorLosCalvos } from '@/lib/ocr/parsers/los-calvos';
import type { AnalizadorComprobante, TextosComprobante } from '@/lib/ocr/parsers/tipos';

/**
 * Registro de analizadores.
 *
 * Sumar un proveedor nuevo es escribir su analizador y agregarlo a esta lista.
 * El genérico queda siempre al final como red de contención.
 */
export const ANALIZADORES: AnalizadorComprobante[] = [analizadorLosCalvos, analizadorGenerico];

export interface AnalizadorElegido {
  analizador: AnalizadorComprobante;
  puntaje: number;
}

/** Elige el analizador que mejor reconoce el comprobante. */
export function elegirAnalizador(textos: TextosComprobante): AnalizadorElegido {
  let mejor: AnalizadorElegido = { analizador: analizadorGenerico, puntaje: 0 };
  for (const analizador of ANALIZADORES) {
    const puntaje = analizador.reconoce(textos);
    if (puntaje > mejor.puntaje) mejor = { analizador, puntaje };
  }
  return mejor;
}

export { analizadorGenerico, analizadorLosCalvos };
export * from '@/lib/ocr/parsers/tipos';
