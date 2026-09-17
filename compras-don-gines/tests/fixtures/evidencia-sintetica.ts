import type {
  EvidenciaDeLectura,
  Fragmento,
  Pasada,
} from '@/lib/ocr/reconstruccion/evidencia';
import type { AsociacionDeProductoConfirmada } from '@/lib/ocr/motor/desde-reconstruccion';
import type { UnidadComercial } from '@/lib/ocr/motor/candidatas';

/**
 * Evidencia armada a mano, para probar la reconstrucción caso por caso.
 *
 * Las fotos reales sirven para medir; no sirven para probar **un** mecanismo,
 * porque en una foto fallan seis cosas a la vez y no se puede saber cuál arregló
 * un cambio. Acá cada pieza de evidencia se escribe con las coordenadas
 * exactas que hacen falta para provocar un solo problema.
 *
 * Todo va en fracción de página, igual que la evidencia de verdad: si estas
 * ayudas trabajaran en píxeles, probarían algo que el sistema no hace.
 */

/** Alto de una palabra, en fracción de página. Un renglón de una factura real. */
export const ALTO = 0.008;

/** Ancho por carácter, para que las cajas tengan un tamaño verosímil. */
const ANCHO_POR_LETRA = 0.011;

export interface OpcionesDePalabra {
  pasada?: string;
  confianza?: number;
  alternativas?: string[];
  /** Para simular una fila inclinada: cuánto baja por unidad de ancho. */
  pendiente?: number;
  alto?: number;
  /** Ancho explícito, cuando importa que dos cajas se solapen o no. */
  ancho?: number;
}

/**
 * Una palabra en (x, y), con la caja que le corresponde por su largo.
 *
 * `y` es el borde de arriba. Con `pendiente`, la caja baja según dónde esté en
 * el ancho de la página: es como se escribe una fila inclinada.
 */
export function palabra(
  texto: string,
  x: number,
  y: number,
  opciones: OpcionesDePalabra = {},
): Fragmento {
  const altoCaja = opciones.alto ?? ALTO;
  const anchoCaja = opciones.ancho ?? Math.max(texto.length * ANCHO_POR_LETRA, ANCHO_POR_LETRA);
  const caida = (opciones.pendiente ?? 0) * (x + anchoCaja / 2 - 0.5);
  return {
    texto,
    caja: { x0: x, y0: y + caida, x1: x + anchoCaja, y1: y + caida + altoCaja },
    pasada: opciones.pasada ?? 'completo:directo',
    confianza: opciones.confianza ?? 0.95,
    ...(opciones.alternativas ? { alternativas: opciones.alternativas } : {}),
  };
}

/** Una fila: cada celda con su posición horizontal. */
export function fila(
  y: number,
  celdas: [texto: string, x: number][],
  opciones: OpcionesDePalabra = {},
): Fragmento[] {
  return celdas.map(([texto, x]) => palabra(texto, x, y, opciones));
}

export function pasada(id: string, extra: Partial<Pasada> = {}): Pasada {
  return {
    id,
    zona: 'completo',
    variante: 'directo',
    psm: '3',
    region: { x0: 0, y0: 0, x1: 1, y1: 1 },
    confianza: 0.9,
    ms: 1000,
    ...extra,
  };
}

export function evidencia(
  fragmentos: Fragmento[],
  opciones: { anchoPx?: number; altoPx?: number; pasadas?: Pasada[] } = {},
): EvidenciaDeLectura {
  const ids = [...new Set(fragmentos.map((f) => f.pasada))];
  return {
    anchoPx: opciones.anchoPx ?? 1449,
    altoPx: opciones.altoPx ?? 2576,
    pasadas: opciones.pasadas ?? ids.map((id) => pasada(id)),
    fragmentos,
  };
}

/**
 * Una tabla de tres columnas que cierra, como base de los casos.
 *
 * Cantidad × precio = importe en los tres renglones, y los tres suman 71.400.
 * Sirve para que cada prueba cambie **una** cosa y se vea qué se rompe.
 */
export const TITULOS: [string, number][] = [
  ['Codigo', 0.05],
  ['Descripcion', 0.20],
  ['Cantidad', 0.50],
  ['Precio', 0.65],
  ['Importe', 0.82],
];

export const RENGLONES: [string, number][][] = [
  [
    ['47', 0.05],
    ['Cremoso', 0.20],
    ['4', 0.52],
    ['5.700,00', 0.65],
    ['22.800,00', 0.82],
  ],
  [
    ['48', 0.05],
    ['Provolone', 0.20],
    ['2', 0.52],
    ['9.600,00', 0.65],
    ['19.200,00', 0.82],
  ],
  [
    ['10', 0.05],
    ['Jamon', 0.20],
    ['3', 0.52],
    ['9.800,00', 0.65],
    ['29.400,00', 0.82],
  ],
];

export const Y_TITULOS = 0.30;
export const SALTO = 0.02;

/**
 * Asociaciones inequívocas para pruebas que miden sólo OCR/estructura.
 *
 * La corrección de cantidades hace que, por defecto, una factura bien leída
 * siga en revisión hasta que sus renglones tengan destino de stock. Las pruebas
 * de otras capas pueden declarar ese dato resuelto sin meter nombres de
 * proveedores ni una búsqueda ficticia por descripción.
 */
export function asociacionesDePrueba(
  unidades: readonly (UnidadComercial | null)[] | number,
  unidadComun: UnidadComercial = 'KG',
): AsociacionDeProductoConfirmada[] {
  const lista =
    typeof unidades === 'number'
      ? Array.from({ length: unidades }, () => unidadComun)
      : [...unidades];
  return lista.map((unidadDeStock, i) => ({
    renglon: i + 1,
    productoId: `producto-${i + 1}`,
    unidadDeStock,
  }));
}

/** La tabla base, con un fragmento por celda y una sola pasada. */
export function tablaBase(opciones: OpcionesDePalabra = {}): Fragmento[] {
  return [
    ...fila(Y_TITULOS, TITULOS, opciones),
    ...RENGLONES.flatMap((celdas, i) => fila(Y_TITULOS + SALTO * (i + 1), celdas, opciones)),
  ];
}
