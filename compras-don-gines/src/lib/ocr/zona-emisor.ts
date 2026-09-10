import type { TextosComprobante } from '@/lib/ocr/parsers/tipos';

/**
 * La zona donde un comprobante dice quién lo emitió.
 *
 * Existe por un error concreto y caro: la factura de Distribuidora Ezra la
 * reconoció el analizador de Los Calvos, con 0,60 de puntaje, porque en la
 * tabla dice «LOS CALVOS»… como **marca del artículo 10**, JAMON COCIDO MINI
 * TRADICIONAL. Los reconocedores buscaban el nombre del proveedor en el
 * encabezado *y en la página completa*, y la página completa incluye la tabla.
 *
 * O sea que una marca se leía como identidad del emisor. No es un problema de
 * Ezra: le pasa a cualquier factura de cualquier proveedor que venda una marca
 * que se llame igual que otro proveedor cargado. Y el resultado es de los
 * peores que puede dar este sistema, porque no se parece a un error: la factura
 * queda atribuida al proveedor equivocado, con su plazo de pago, sus tasas y su
 * cuenta corriente, y la pantalla nunca llega a decir que el proveedor era otro.
 *
 * La regla que impone este módulo: **el emisor se busca arriba de la tabla**.
 * Un comprobante identifica a quien lo emite en la cabecera; de la fila de
 * títulos de columna para abajo empiezan los datos, y ahí un nombre propio es
 * un dato del renglón, no la identidad del que factura.
 */

/**
 * Palabras que sólo aparecen juntas en la fila de títulos de la tabla.
 *
 * Se piden **tres** distintas en la misma línea. Con dos, una línea de datos que
 * mencione «precio» o «cantidad» en la descripción de un artículo cortaría la
 * zona antes de tiempo y dejaría al emisor afuera, que es justamente el efecto
 * contrario al buscado.
 */
const TITULOS_DE_COLUMNA = [
  /\bc[oó]d(?:igo)?\b/i,
  /\bdescripci[oó]n\b|\bdetalle\b/i,
  /\bcantidad\b|\bcant\b|\bunid\b/i,
  /\bprecio\b|\bp\.?\s?unit\b|\bpr\.?\s?unit\b/i,
  /\bimporte\b|\bsubtotal\b/i,
  /\bmarca\b/i,
  /\bbonif|\bdesc\.?%|\bdto\b|\biva\b/i,
];

/** ¿Esta línea es la fila de títulos de columna de la tabla de artículos? */
export function esFilaDeTitulos(linea: string): boolean {
  const cuantos = TITULOS_DE_COLUMNA.filter((t) => t.test(linea)).length;
  return cuantos >= 3;
}

/**
 * El texto del comprobante hasta donde empieza la tabla.
 *
 * Se corta en la fila de títulos. Si no se la encuentra —el OCR puede haberla
 * perdido— se devuelve el texto entero: es preferible que un reconocedor mire
 * de más a que un comprobante legítimo se quede sin analizador por un recorte
 * que salió mal. Lo que se gana igual, y es lo que importa, es que el caso
 * normal —la tabla se leyó, con sus títulos— ya no puede confundir una marca
 * con el emisor.
 */
export function hastaLaTabla(texto: string): string {
  const lineas = texto.split('\n');
  const corte = lineas.findIndex((l) => esFilaDeTitulos(l));
  return corte === -1 ? texto : lineas.slice(0, corte).join('\n');
}

/**
 * Lo que hay que mirar para saber quién emitió el comprobante.
 *
 * Es el recorte del encabezado —que es exactamente esa zona, cuando se pudo
 * hacer— más la parte de la página completa que está arriba de la tabla. Se
 * usan las dos porque cada una falla por su lado: el recorte a veces no se
 * puede hacer, y en la página completa el análisis de disposición de Tesseract
 * mezcla el orden de los bloques.
 *
 * El recorte de artículos y el del pie no entran nunca. Son, por definición, las
 * zonas donde lo que hay son datos.
 */
export function zonaDelEmisor(textos: TextosComprobante): string {
  return [textos.encabezado ?? '', hastaLaTabla(textos.completo)].join('\n');
}

/** La zona del emisor, normalizada para comparar sin acentos ni mayúsculas. */
export function emisorNormalizado(textos: TextosComprobante): string {
  return zonaDelEmisor(textos)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase();
}
