/**
 * Los tipos de la captura, que vive en JavaScript para poder correrse con node
 * sin compilar nada.
 */
import type { EvidenciaDeLectura } from '@/lib/ocr/reconstruccion/evidencia';

export interface WorkerDeOcr {
  setParameters(parametros: Record<string, string | number>): Promise<unknown>;
  recognize(imagen: unknown, opciones?: unknown, salida?: unknown): Promise<{ data: unknown }>;
  terminate(): Promise<unknown>;
}

export function abrirWorker(): Promise<WorkerDeOcr>;

export function capturarEvidencia(
  worker: WorkerDeOcr,
  rutaDeImagen: string,
  avisar?: boolean,
): Promise<{ evidencia: EvidenciaDeLectura; ms: number }>;

export const LADO_PAGINA: number;
export const LADO_RECORTE: number;
export const ZONAS: { zona: string; region: { x0: number; y0: number; x1: number; y1: number } }[];
export const VARIANTES: { variante: string; receta: (img: unknown) => unknown }[];
