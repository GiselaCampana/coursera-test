import 'server-only';
import { prisma } from '@/lib/db';
import { env } from '@/lib/env';
import { AppError } from '@/lib/errors';

/**
 * Control del espacio de almacenamiento.
 *
 * El plan gratuito de Supabase da 1 GB y **no se factura el excedente: se
 * rechaza la subida**. Eso convierte al espacio en un recurso que hay que
 * administrar de verdad, porque el día que se llene, la fiambrería se queda sin
 * poder cargar comprobantes en medio de la mañana.
 *
 * Por eso hay tres escalones:
 *
 *  1. Un indicador permanente en Administración, para que nadie se entere de
 *     casualidad.
 *  2. Un aviso al llegar al 80 %, con tiempo para archivar comprobantes viejos.
 *  3. Un bloqueo preventivo **antes** de tocar el límite, con margen para la
 *     foto que se está por subir. Bloquear a tiempo es preferible a que falle
 *     la subida a mitad de camino y quede un comprobante sin su imagen.
 *
 * Lo que se mide es lo que la aplicación guardó, sumando el peso de cada
 * archivo vigente. No se consulta a Supabase: la cuenta propia es exacta para
 * lo que subimos nosotros, no depende de la red y no gasta llamadas.
 */

/** A partir de acá se avisa. */
export const UMBRAL_AVISO = 0.8;
/**
 * A partir de acá no se aceptan comprobantes nuevos.
 *
 * El 95 % deja unos 50 MB libres en un plan de 1 GB: espacio de sobra para
 * terminar de cargar lo que esté en curso y para exportar antes de borrar.
 */
export const UMBRAL_BLOQUEO = 0.95;

export interface EstadoAlmacenamiento {
  usadoBytes: number;
  limiteBytes: number;
  /** 0 a 1. */
  proporcion: number;
  archivos: number;
  archivosArchivados: number;
  bytesLiberables: number;
  /** true cuando conviene empezar a archivar. */
  enAviso: boolean;
  /** true cuando ya no se aceptan comprobantes nuevos. */
  bloqueado: boolean;
  mensaje: string | null;
}

export function formatearBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const unidades = ['kB', 'MB', 'GB', 'TB'];
  let valor = bytes / 1024;
  let i = 0;
  while (valor >= 1024 && i < unidades.length - 1) {
    valor /= 1024;
    i++;
  }
  const decimales = valor >= 100 ? 0 : valor >= 10 ? 1 : 2;
  return `${valor.toFixed(decimales).replace('.', ',')} ${unidades[i]}`;
}

/** Cuánto espacio hay ocupado hoy. */
export async function estadoAlmacenamiento(): Promise<EstadoAlmacenamiento> {
  const [vigentes, archivados] = await Promise.all([
    prisma.documentFile.aggregate({
      where: { archivedAt: null },
      _sum: { sizeBytes: true },
      _count: true,
    }),
    prisma.documentFile.count({ where: { archivedAt: { not: null } } }),
  ]);

  const usadoBytes = vigentes._sum.sizeBytes ?? 0;
  const limiteBytes = env.storageLimitBytes;
  const proporcion = limiteBytes > 0 ? usadoBytes / limiteBytes : 0;

  // Lo que se podría liberar archivando: los comprobantes ya confirmados de
  // más de un año, que es el plazo en el que dejan de discutirse.
  const haceUnAno = new Date();
  haceUnAno.setFullYear(haceUnAno.getFullYear() - 1);
  const liberables = await prisma.documentFile.aggregate({
    where: { archivedAt: null, document: { issueDate: { lt: haceUnAno }, status: 'VALIDADO' } },
    _sum: { sizeBytes: true },
  });

  const enAviso = proporcion >= UMBRAL_AVISO;
  const bloqueado = proporcion >= UMBRAL_BLOQUEO;

  let mensaje: string | null = null;
  if (bloqueado) {
    mensaje =
      `El almacenamiento está al ${Math.round(proporcion * 100)} % y no se pueden cargar ` +
      'comprobantes nuevos. Descargá y archivá los comprobantes viejos desde Administración ' +
      'para liberar espacio.';
  } else if (enAviso) {
    mensaje =
      `El almacenamiento está al ${Math.round(proporcion * 100)} % de lo que da el plan ` +
      'gratuito. Conviene descargar y archivar los comprobantes viejos antes de que se llene.';
  }

  return {
    usadoBytes,
    limiteBytes,
    proporcion,
    archivos: vigentes._count,
    archivosArchivados: archivados,
    bytesLiberables: liberables._sum.sizeBytes ?? 0,
    enAviso,
    bloqueado,
    mensaje,
  };
}

/**
 * Se llama antes de guardar una imagen.
 *
 * Corta antes de escribir, no después: si se dejara pasar y Supabase rechazara
 * la subida, el comprobante quedaría a medio cargar y el usuario vería un error
 * del proveedor en vez de una explicación.
 */
export async function asegurarEspacio(bytesAAgregar: number): Promise<EstadoAlmacenamiento> {
  const estado = await estadoAlmacenamiento();

  if (estado.bloqueado) {
    throw new AppError(estado.mensaje ?? 'No queda espacio de almacenamiento.', {
      status: 507,
      code: 'SIN_ESPACIO',
      details: { usadoBytes: estado.usadoBytes, limiteBytes: estado.limiteBytes },
    });
  }

  const proyectado = estado.usadoBytes + bytesAAgregar;
  if (proyectado > estado.limiteBytes * UMBRAL_BLOQUEO) {
    throw new AppError(
      'Esta imagen no entra en el espacio que queda del plan gratuito. Descargá y archivá ' +
        'comprobantes viejos desde Administración y volvé a intentar.',
      {
        status: 507,
        code: 'SIN_ESPACIO',
        details: { usadoBytes: estado.usadoBytes, limiteBytes: estado.limiteBytes },
      },
    );
  }

  return estado;
}
