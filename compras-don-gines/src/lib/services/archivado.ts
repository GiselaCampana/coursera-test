import 'server-only';
import { prisma } from '@/lib/db';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { hasPermission, type AuthUser } from '@/lib/auth/session';
import { AppError, ForbiddenError, ValidationError } from '@/lib/errors';
import { getStorage } from '@/lib/storage';
import { toISODate } from '@/lib/datetime';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/services/audit';
import { formatearBytes } from '@/lib/services/almacenamiento';

/**
 * Archivado de las imágenes viejas.
 *
 * Es la salida cuando el espacio gratuito se acaba, y está pensada para que
 * nunca se pierda información contable:
 *
 *  - **Los datos se conservan siempre.** Artículos, cantidades, costos,
 *    impuestos, movimientos, historial de precios y pagos quedan en la base
 *    como estaban. Lo único que se borra es la foto.
 *  - **Primero se baja, después se borra.** El ZIP se arma con las imágenes y
 *    un índice en CSV para poder encontrarlas después. Recién cuando el
 *    archivo está en manos del usuario se libera el espacio.
 *  - **Queda asentado.** Cada imagen archivada guarda cuándo y quién, y la
 *    operación va a la auditoría.
 *
 * Un comprobante con la imagen archivada se sigue viendo entero: sus renglones,
 * sus importes y su pago. Donde estaba la foto aparece la explicación de que se
 * archivó y en qué fecha.
 */

export interface CandidatoArchivado {
  documentId: string;
  fullNumber: string;
  proveedor: string;
  sucursal: string;
  fecha: string | null;
  paginas: number;
  bytes: number;
}

export interface ResumenArchivado {
  comprobantes: number;
  paginas: number;
  bytes: number;
  bytesLegible: string;
  desde: string | null;
  hasta: string | null;
}

/** Comprobantes cuya imagen se puede archivar: confirmados y anteriores a la fecha. */
export async function candidatosParaArchivar(
  user: AuthUser,
  anteriorA: Date,
): Promise<CandidatoArchivado[]> {
  exigirPermiso(user);

  const documentos = await prisma.document.findMany({
    where: {
      status: 'VALIDADO',
      issueDate: { lt: anteriorA },
      files: { some: { archivedAt: null } },
    },
    orderBy: { issueDate: 'asc' },
    include: {
      supplier: { select: { tradeName: true } },
      branch: { select: { name: true } },
      files: { where: { archivedAt: null }, select: { sizeBytes: true } },
    },
  });

  return documentos.map((d) => ({
    documentId: d.id,
    fullNumber: d.fullNumber || 'sin número',
    proveedor: d.supplier?.tradeName ?? 'sin proveedor',
    sucursal: d.branch.name,
    fecha: d.issueDate ? toISODate(d.issueDate) : null,
    paginas: d.files.length,
    bytes: d.files.reduce((total, f) => total + f.sizeBytes, 0),
  }));
}

export async function resumenParaArchivar(
  user: AuthUser,
  anteriorA: Date,
): Promise<ResumenArchivado> {
  const candidatos = await candidatosParaArchivar(user, anteriorA);
  const fechas = candidatos.map((c) => c.fecha).filter((f): f is string => f !== null);
  const bytes = candidatos.reduce((total, c) => total + c.bytes, 0);

  return {
    comprobantes: candidatos.length,
    paginas: candidatos.reduce((total, c) => total + c.paginas, 0),
    bytes,
    bytesLegible: formatearBytes(bytes),
    desde: fechas.length > 0 ? fechas[0] : null,
    hasta: fechas.length > 0 ? fechas[fechas.length - 1] : null,
  };
}

/**
 * Arma el ZIP con las imágenes anteriores a la fecha.
 *
 * Adentro va un `indice.csv` con una fila por imagen: comprobante, proveedor,
 * sucursal, fecha, importe y el nombre del archivo. Sin ese índice, un ZIP con
 * cientos de fotos numeradas no le sirve a nadie.
 */
export async function exportarZip(
  user: AuthUser,
  anteriorA: Date,
): Promise<{ zip: Buffer; nombre: string; documentIds: string[] }> {
  exigirPermiso(user);

  const documentos = await prisma.document.findMany({
    where: {
      status: 'VALIDADO',
      issueDate: { lt: anteriorA },
      files: { some: { archivedAt: null } },
    },
    orderBy: { issueDate: 'asc' },
    include: {
      supplier: { select: { tradeName: true } },
      branch: { select: { name: true, code: true } },
      files: { where: { archivedAt: null }, orderBy: { pageOrder: 'asc' } },
    },
  });

  if (documentos.length === 0) {
    throw new ValidationError('No hay comprobantes con imagen para archivar antes de esa fecha.');
  }

  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const storage = await getStorage();

  const filas: string[] = [
    'comprobante;proveedor;sucursal;fecha;total;pagina;archivo',
  ];
  const faltantes: string[] = [];

  for (const documento of documentos) {
    const fecha = documento.issueDate ? toISODate(documento.issueDate) : 'sin-fecha';
    const numero = (documento.fullNumber || documento.id).replace(/[^\w.-]+/g, '_');
    const carpeta = `${fecha}_${documento.branch.code}_${numero}`;

    for (const file of documento.files) {
      const extension = file.mimeType === 'application/pdf' ? 'pdf' : 'jpg';
      const nombre = `${carpeta}/pagina-${String(file.pageOrder).padStart(2, '0')}.${extension}`;
      try {
        zip.file(nombre, await storage.get(file.storageKey));
      } catch {
        // Una imagen que ya no está en el storage no puede frenar la
        // exportación de las demás: se anota y se sigue.
        faltantes.push(nombre);
        continue;
      }
      filas.push(
        [
          documento.fullNumber || documento.id,
          documento.supplier?.tradeName ?? '',
          documento.branch.name,
          fecha,
          documento.total?.toString() ?? '',
          String(file.pageOrder),
          nombre,
        ]
          .map((campo) => `"${String(campo).replace(/"/g, '""')}"`)
          .join(';'),
      );
    }
  }

  // BOM para que Excel abra el CSV con los acentos bien.
  zip.file('indice.csv', `﻿${filas.join('\r\n')}\r\n`);
  if (faltantes.length > 0) {
    zip.file(
      'faltantes.txt',
      `Estas imágenes ya no estaban en el almacenamiento:\n${faltantes.join('\n')}\n`,
    );
  }

  const contenido = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  return {
    zip: contenido,
    nombre: `comprobantes-hasta-${toISODate(anteriorA)}.zip`,
    documentIds: documentos.map((d) => d.id),
  };
}

/**
 * Libera el espacio: borra las imágenes del storage y las marca archivadas.
 *
 * Los datos del comprobante no se tocan. Se pide confirmación explícita de que
 * la exportación ya se descargó, porque después no hay vuelta atrás.
 */
export async function archivarImagenes(
  user: AuthUser,
  opciones: { anteriorA: Date; confirmoDescarga: boolean },
): Promise<{ paginas: number; bytesLiberados: number }> {
  exigirPermiso(user);

  if (!opciones.confirmoDescarga) {
    throw new ValidationError(
      'Antes de borrar las imágenes hay que descargar el ZIP: es la única copia que va a quedar.',
    );
  }

  const archivos = await prisma.documentFile.findMany({
    where: {
      archivedAt: null,
      document: { status: 'VALIDADO', issueDate: { lt: opciones.anteriorA } },
    },
    select: { id: true, storageKey: true, sizeBytes: true, documentId: true },
  });

  if (archivos.length === 0) {
    throw new ValidationError('No quedan imágenes para archivar antes de esa fecha.');
  }

  const storage = await getStorage();
  const ahora = new Date();
  let bytesLiberados = 0;
  let borradas = 0;

  for (const archivo of archivos) {
    try {
      await storage.delete(archivo.storageKey);
    } catch (error) {
      // Si el storage falla se corta: mejor liberar de menos que marcar como
      // archivada una imagen que en realidad sigue ocupando lugar.
      if (borradas === 0) throw error;
      break;
    }
    await prisma.documentFile.update({
      where: { id: archivo.id },
      data: { archivedAt: ahora, archivedById: user.id },
    });
    bytesLiberados += archivo.sizeBytes;
    borradas += 1;
  }

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.IMAGENES_ARCHIVADAS,
    entity: 'DocumentFile',
    entityId: null,
    after: {
      anteriorA: toISODate(opciones.anteriorA),
      paginas: borradas,
      bytesLiberados,
    },
  });

  return { paginas: borradas, bytesLiberados };
}

function exigirPermiso(user: AuthUser): void {
  if (!hasPermission(user, PERMISSIONS.ALMACENAMIENTO_GESTIONAR)) {
    throw new ForbiddenError('Sólo un administrador puede archivar comprobantes.');
  }
}

export { AppError };
