import {
  parseHeaderFromText,
  parseItemsFromText,
  parseSummaryFromText,
} from '@/lib/ocr/text-parser';
import type {
  AnalisisComprobante,
  AnalizadorComprobante,
  TextosComprobante,
} from '@/lib/ocr/parsers/tipos';

/**
 * Analizador genérico.
 *
 * Cubre el formato común de los comprobantes argentinos de mercadería:
 * [código] descripción, cantidad, precio unitario, [bonificación %], importe,
 * y un pie con subtotal, descuento, neto gravado, IVA, percepciones y total.
 *
 * Es el que se usa cuando ningún analizador específico reconoce el comprobante.
 * Prefiere el texto de cada recorte, que viene ampliado y limpio, y cae al
 * texto de la página entera cuando el recorte no se pudo hacer.
 */
export const analizadorGenerico: AnalizadorComprobante = {
  codigo: 'generico',
  nombre: 'Formato general',

  reconoce(): number {
    // Siempre acepta, con el puntaje mínimo: gana cualquier analizador
    // específico que reconozca el comprobante.
    return 0.3;
  },

  analizar(textos: TextosComprobante): AnalisisComprobante {
    const observaciones: string[] = [];

    const header = parseHeaderFromText(textos.encabezado || textos.completo);

    // Los artículos salen del recorte si lo hay; si el recorte no dio ningún
    // renglón se reintenta con la página entera antes de darse por vencido.
    let items = parseItemsFromText(textos.articulos || textos.completo);
    if (items.length === 0 && textos.articulos) {
      items = parseItemsFromText(textos.completo);
      if (items.length > 0) {
        observaciones.push(
          'No se reconoció ningún renglón en el recorte de la tabla: se usaron los de la página completa.',
        );
      }
    }

    const summary = parseSummaryFromText(textos.resumen || textos.completo);

    if (items.length === 0) {
      observaciones.push('No se reconoció ningún artículo en el comprobante.');
    }
    if (summary.total === null && summary.netTotal === null) {
      observaciones.push('No se reconocieron los totales del pie del comprobante.');
    }

    return { header, items, summary, observaciones };
  },
};
