/**
 * Genera la imagen de la factura de Los Calvos, para las pruebas de lectura.
 *
 * No es un texto plano disfrazado: es una imagen JPEG con la disposición real
 * del comprobante —encabezado, tabla de artículos y resumen del pie— que se
 * sube a la aplicación como si fuera la foto que sacó el encargado. La lectura
 * la hace Tesseract dentro del navegador, sin ningún servicio externo.
 *
 * Se dibuja con una tipografía de ancho fijo, que es lo que usan las
 * impresoras de comprobantes, y con un contraste alto: así la prueba mide el
 * circuito de lectura y no la caligrafía del generador.
 */
import sharp from 'sharp';

/**
 * Tamaño del comprobante, en unidades del SVG.
 *
 * Una factura A4 impresa y fotografiada a 2200 px de alto deja los dígitos en
 * unos 26 px de alto, que es lo que Tesseract necesita para no confundir un
 * "6" con un "0". El dibujo respeta esa proporción: apretarlo más no probaría
 * el circuito, probaría el límite del OCR con letra chica.
 */
export const ANCHO = 2200;
export const ALTO = 2340;

/** Margen derecho: contra él se alinean las columnas numéricas. */
const DERECHA = ANCHO - 40;
const IZQUIERDA = 80;

/** Tipografía monoespaciada instalada en el sistema, con alternativas. */
const MONO = 'Liberation Mono, DejaVu Sans Mono, monospace';
const SANS = 'Liberation Sans, DejaVu Sans, sans-serif';

interface Renglon {
  codigo: string;
  descripcion: string;
  kg: string;
  precio: string;
  bonificacion: string;
  importe: string;
}

export const RENGLONES: Renglon[] = [
  { codigo: '1001', descripcion: 'LONGANIZA CORTA', kg: '16,10', precio: '16.037,00', bonificacion: '14,00', importe: '258.195,70' },
  { codigo: '1002', descripcion: 'SALAME CRESPON', kg: '3,40', precio: '14.256,00', bonificacion: '14,00', importe: '48.470,40' },
  { codigo: '1003', descripcion: 'SALAME MILAN', kg: '10,90', precio: '14.256,00', bonificacion: '14,00', importe: '155.390,40' },
  { codigo: '1004', descripcion: 'BONDIOLA AL PAPEL', kg: '4,50', precio: '20.621,00', bonificacion: '14,00', importe: '92.794,50' },
  { codigo: '1005', descripcion: 'JAMON CRUDO PARMA', kg: '5,00', precio: '30.327,00', bonificacion: '14,00', importe: '151.635,00' },
  { codigo: '1006', descripcion: 'JAMON COCIDO', kg: '37,60', precio: '12.803,00', bonificacion: '14,00', importe: '481.392,80' },
  { codigo: '1007', descripcion: 'JAMON COCIDO MONT-BLANC', kg: '37,70', precio: '14.828,00', bonificacion: '14,00', importe: '559.015,60' },
  { codigo: '1008', descripcion: 'FIAMBRE DE PECHUGA DE POLLO', kg: '2,10', precio: '11.223,00', bonificacion: '14,00', importe: '23.568,30' },
  { codigo: '1009', descripcion: 'FIAMBRE COCIDO DE PATA ZUR-LINDE', kg: '36,40', precio: '8.630,00', bonificacion: '14,00', importe: '314.132,00' },
];

/** Columnas de la tabla, en píxeles. Las numéricas se alinean a la derecha. */
/**
 * A cuerpo 40 en tipografía de ancho fijo cada carácter mide unos 24 px, así
 * que "258.195,70" ocupa 240 y la descripción más larga —"FIAMBRE COCIDO DE
 * PATA ZUR-LINDE", 32 caracteres— llega hasta los 968.
 *
 * Las posiciones dejan entre 80 y 160 px de aire entre columnas, que son de
 * tres a seis caracteres. Con menos, Tesseract pega la última letra de la
 * descripción al primer dígito de los kilos y "36,40" pasa a ser "136,40": el
 * renglón se lee entero y con la cantidad equivocada, que es peor que no
 * leerlo.
 */
const COLUMNAS = {
  codigo: IZQUIERDA,
  descripcion: 200,
  kg: 1250,
  precio: 1580,
  bonificacion: 1780,
  importe: DERECHA,
};

const escapar = (texto: string): string =>
  texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

interface OpcionesTexto {
  x: number;
  y: number;
  tamano?: number;
  familia?: string;
  peso?: string;
  anclaje?: 'start' | 'end' | 'middle';
  espaciado?: number;
}

function texto(contenido: string, o: OpcionesTexto): string {
  const tamano = o.tamano ?? 30;
  return (
    `<text x="${o.x}" y="${o.y}" font-family="${o.familia ?? MONO}" font-size="${tamano}" ` +
    `font-weight="${o.peso ?? 'normal'}" text-anchor="${o.anclaje ?? 'start'}" ` +
    `letter-spacing="${o.espaciado ?? 0}" fill="#111111" ` +
    `xml:space="preserve">${escapar(contenido)}</text>`
  );
}

/**
 * Arma el SVG del comprobante.
 *
 * `deterioro` sirve para probar la relectura: con 'borroso' la tabla se dibuja
 * más chica y con menos contraste, que es lo que pasa cuando la foto sale
 * movida.
 */
export function svgFactura(
  deterioro: 'nitido' | 'borroso' = 'nitido',
  totalAlterado = false,
): string {
  const partes: string[] = [];
  const chico = deterioro === 'borroso';

  partes.push(`<rect width="${ANCHO}" height="${ALTO}" fill="#ffffff"/>`);

  // --- Encabezado ---------------------------------------------------------
  partes.push(texto('LOS CALVOS S.A.', { x: 90, y: 110, tamano: 46, familia: SANS, peso: 'bold' }));
  partes.push(texto('Fabrica de chacinados', { x: 90, y: 158, tamano: 26, familia: SANS }));
  partes.push(texto('CUIT: 30-61234567-9', { x: 90, y: 200, tamano: 30 }));
  partes.push(texto('Ingresos Brutos: 901-234567-8', { x: 90, y: 240, tamano: 28 }));

  partes.push(texto('FACTURA', { x: DERECHA, y: 110, tamano: 46, familia: SANS, peso: 'bold', anclaje: 'end' }));
  partes.push(texto('A', { x: DERECHA, y: 165, tamano: 46, familia: SANS, peso: 'bold', anclaje: 'end' }));
  partes.push(texto('Punto de Venta: 0010', { x: DERECHA, y: 215, tamano: 30, anclaje: 'end' }));
  partes.push(texto('Comp. Nro: 00212356', { x: DERECHA, y: 255, tamano: 30, anclaje: 'end' }));
  partes.push(texto('Fecha de Emision: 14/08/2026', { x: DERECHA, y: 295, tamano: 30, anclaje: 'end' }));

  partes.push(`<line x1="${IZQUIERDA}" y1="330" x2="${DERECHA}" y2="330" stroke="#111111" stroke-width="3"/>`);

  partes.push(texto('Sr. DON GINES S.R.L.', { x: 90, y: 380, tamano: 30 }));
  partes.push(texto('CUIT: 30-71234567-4    Condicion: Responsable Inscripto', { x: 90, y: 420, tamano: 28 }));
  partes.push(texto('Condicion de venta: Contado', { x: 90, y: 460, tamano: 28 }));

  // --- Tabla de artículos -------------------------------------------------
  const tamanoTabla = chico ? 30 : 40;
  const alturaRenglon = chico ? 54 : 68;
  let y = 560;

  partes.push(`<line x1="${IZQUIERDA}" y1="${y - 42}" x2="${DERECHA}" y2="${y - 42}" stroke="#111111" stroke-width="2"/>`);
  partes.push(texto('Cod', { x: COLUMNAS.codigo, y, tamano: tamanoTabla, peso: 'bold' }));
  partes.push(texto('Descripcion', { x: COLUMNAS.descripcion, y, tamano: tamanoTabla, peso: 'bold' }));
  partes.push(texto('Kg', { x: COLUMNAS.kg, y, tamano: tamanoTabla, peso: 'bold', anclaje: 'end' }));
  partes.push(texto('Precio', { x: COLUMNAS.precio, y, tamano: tamanoTabla, peso: 'bold', anclaje: 'end' }));
  partes.push(texto('Bonif %', { x: COLUMNAS.bonificacion, y, tamano: tamanoTabla, peso: 'bold', anclaje: 'end' }));
  partes.push(texto('Importe', { x: COLUMNAS.importe, y, tamano: tamanoTabla, peso: 'bold', anclaje: 'end' }));
  partes.push(`<line x1="${IZQUIERDA}" y1="${y + 16}" x2="${DERECHA}" y2="${y + 16}" stroke="#111111" stroke-width="2"/>`);

  y += alturaRenglon + 12;
  for (const renglon of RENGLONES) {
    partes.push(texto(renglon.codigo, { x: COLUMNAS.codigo, y, tamano: tamanoTabla }));
    partes.push(texto(renglon.descripcion, { x: COLUMNAS.descripcion, y, tamano: tamanoTabla }));
    partes.push(texto(renglon.kg, { x: COLUMNAS.kg, y, tamano: tamanoTabla, anclaje: 'end' }));
    partes.push(texto(renglon.precio, { x: COLUMNAS.precio, y, tamano: tamanoTabla, anclaje: 'end' }));
    partes.push(texto(renglon.bonificacion, { x: COLUMNAS.bonificacion, y, tamano: tamanoTabla, anclaje: 'end' }));
    partes.push(texto(renglon.importe, { x: COLUMNAS.importe, y, tamano: tamanoTabla, anclaje: 'end' }));
    y += alturaRenglon;
  }

  // --- Resumen del pie ----------------------------------------------------
  y += 40;
  partes.push(`<line x1="${IZQUIERDA}" y1="${y - 40}" x2="${DERECHA}" y2="${y - 40}" stroke="#111111" stroke-width="3"/>`);
  partes.push(texto('Cantidad de renglones: 9', { x: 90, y, tamano: 34 }));
  partes.push(texto('Peso neto: 153,70 kg', { x: 800, y, tamano: 34 }));

  const pie: [string, string][] = [
    ['Subtotal:', '2.084.594,70'],
    ['Descuento 14%:', '291.843,26'],
    ['Neto Gravado:', '1.792.751,44'],
    ['IVA 21%:', '376.477,81'],
    ['Percepcion IIBB 1,5%:', '26.891,27'],
  ];
  y += 70;
  for (const [etiqueta, importe] of pie) {
    partes.push(texto(etiqueta, { x: 1300, y, tamano: 34, anclaje: 'end' }));
    partes.push(texto(importe, { x: DERECHA, y, tamano: 34, anclaje: 'end' }));
    y += 54;
  }

  y += 14;
  partes.push(texto('TOTAL:', { x: 1300, y, tamano: 44, peso: 'bold', anclaje: 'end' }));
  // Con el total alterado el comprobante se lee perfecto pero no cierra: los
  // renglones y el pie no coinciden con el total impreso.
  partes.push(
    texto(totalAlterado ? '2.296.120,52' : '2.196.120,52', {
      x: DERECHA,
      y,
      tamano: 44,
      peso: 'bold',
      anclaje: 'end',
    }),
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ANCHO}" height="${ALTO}">${partes.join('')}</svg>`;
}

/**
 * La factura como la foto que llega desde el teléfono.
 *
 * `rotacion` simula la foto guardada de costado con la orientación en los EXIF,
 * que es lo que hace el iPhone; `desenfoque` la foto movida.
 */
export async function facturaLosCalvosJpeg(
  opciones: {
    deterioro?: 'nitido' | 'borroso';
    desenfoque?: number;
    rotacionExif?: 1 | 6;
    /** Imprime un total que no coincide con el detalle. */
    totalAlterado?: boolean;
  } = {},
): Promise<Buffer> {
  let imagen = sharp(
    Buffer.from(svgFactura(opciones.deterioro ?? 'nitido', opciones.totalAlterado ?? false)),
    { density: 96 },
  );

  if (opciones.desenfoque) imagen = imagen.blur(opciones.desenfoque);

  if (opciones.rotacionExif === 6) {
    // La imagen se guarda girada 90° y los EXIF piden volver a girarla: es
    // exactamente lo que produce un iPhone sostenido en vertical.
    imagen = sharp(await imagen.jpeg({ quality: 94 }).toBuffer())
      .rotate(270)
      .withMetadata({ orientation: 6 });
  }

  return imagen.jpeg({ quality: 94 }).toBuffer();
}
