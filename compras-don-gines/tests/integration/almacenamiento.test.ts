import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '@/lib/db';
import { getStorage, buildDocumentKey } from '@/lib/storage';
import { ForbiddenError, ValidationError } from '@/lib/errors';
import {
  estadoAlmacenamiento,
  asegurarEspacio,
  formatearBytes,
  UMBRAL_AVISO,
} from '@/lib/services/almacenamiento';
import { archivarImagenes, exportarZip, resumenParaArchivar } from '@/lib/services/archivado';
import { limpiarBase, sembrarEscenario, type Escenario } from './ayudas';

let escenario: Escenario;
const limiteOriginal = process.env.STORAGE_LIMIT_BYTES;

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();
});

afterEach(() => {
  if (limiteOriginal === undefined) delete process.env.STORAGE_LIMIT_BYTES;
  else process.env.STORAGE_LIMIT_BYTES = limiteOriginal;
});

/** Crea un comprobante confirmado con una imagen de un peso dado. */
async function comprobanteConImagen(opciones: {
  numero: string;
  fecha: string;
  bytes: number;
}): Promise<string> {
  const documento = await prisma.document.create({
    data: {
      branchId: escenario.sucursales.devoto,
      createdById: escenario.admin.id,
      supplierId: escenario.proveedorId,
      status: 'VALIDADO',
      checkState: 'OK',
      docType: 'FACTURA',
      letter: 'A',
      pointOfSale: '0010',
      number: opciones.numero,
      fullNumber: `0010-${opciones.numero}`,
      issueDate: new Date(`${opciones.fecha}T00:00:00`),
      dedupeKey: 'ACTIVE',
      total: '1000.00',
    },
  });

  const storage = await getStorage();
  const key = buildDocumentKey({
    documentId: documento.id,
    pageOrder: 1,
    variant: 'work',
    extension: 'jpg',
  });
  await storage.put(key, Buffer.alloc(opciones.bytes, 7), 'image/jpeg');

  await prisma.documentFile.create({
    data: {
      documentId: documento.id,
      pageOrder: 1,
      storageKey: key,
      mimeType: 'image/jpeg',
      originalMimeType: 'image/heic',
      sizeBytes: opciones.bytes,
      originalSizeBytes: opciones.bytes * 8,
      sha256: `prueba-${documento.id}`,
      width: 2200,
      height: 2068,
    },
  });

  return documento.id;
}

describe('cuánto espacio hay usado', () => {
  it('suma lo que ocupan las imágenes vigentes', async () => {
    await comprobanteConImagen({ numero: '00000001', fecha: '2026-08-01', bytes: 400_000 });
    await comprobanteConImagen({ numero: '00000002', fecha: '2026-08-02', bytes: 350_000 });

    const estado = await estadoAlmacenamiento();
    expect(estado.usadoBytes).toBe(750_000);
    expect(estado.archivos).toBe(2);
    expect(estado.enAviso).toBe(false);
    expect(estado.bloqueado).toBe(false);
    expect(estado.mensaje).toBeNull();
  });

  it('avisa al llegar al 80 % del plan gratuito', async () => {
    process.env.STORAGE_LIMIT_BYTES = String(1_000_000);
    await comprobanteConImagen({ numero: '00000003', fecha: '2026-08-03', bytes: 850_000 });

    const estado = await estadoAlmacenamiento();
    expect(estado.proporcion).toBeGreaterThanOrEqual(UMBRAL_AVISO);
    expect(estado.enAviso).toBe(true);
    expect(estado.bloqueado).toBe(false);
    expect(estado.mensaje).toContain('85 %');
    // El aviso dice qué hacer, no sólo que hay un problema.
    expect(estado.mensaje).toContain('archivar');
  });

  it('bloquea antes de llegar al límite, sin generar cargos', async () => {
    process.env.STORAGE_LIMIT_BYTES = String(1_000_000);
    await comprobanteConImagen({ numero: '00000004', fecha: '2026-08-04', bytes: 960_000 });

    const estado = await estadoAlmacenamiento();
    expect(estado.bloqueado).toBe(true);
    await expect(asegurarEspacio(1_000)).rejects.toThrow(/no se pueden cargar/i);
  });

  it('rechaza la imagen que no entraría, aunque todavía haya lugar', async () => {
    process.env.STORAGE_LIMIT_BYTES = String(1_000_000);
    await comprobanteConImagen({ numero: '00000005', fecha: '2026-08-05', bytes: 900_000 });

    // Queda espacio, pero no el suficiente para esta imagen: se corta antes de
    // escribir, no después de que el proveedor rechace la subida.
    await expect(asegurarEspacio(200_000)).rejects.toThrow(/no entra en el espacio/i);
    // Una chica sí entra.
    await expect(asegurarEspacio(10_000)).resolves.toBeTruthy();
  });

  it('muestra los tamaños en unidades que se entienden', () => {
    expect(formatearBytes(512)).toBe('512 B');
    // Con tres cifras no hacen falta decimales: "488 kB" se lee de un vistazo.
    expect(formatearBytes(500_000)).toBe('488 kB');
    expect(formatearBytes(52_428_800)).toBe('50,0 MB');
    expect(formatearBytes(1024 * 1024 * 1024)).toBe('1,00 GB');
  });
});

describe('archivar comprobantes viejos', () => {
  it('exporta un ZIP con las imágenes y un índice antes de borrar nada', async () => {
    await comprobanteConImagen({ numero: '00000010', fecha: '2024-03-15', bytes: 120_000 });
    await comprobanteConImagen({ numero: '00000011', fecha: '2026-08-01', bytes: 130_000 });

    const corte = new Date('2025-01-01T00:00:00');
    const resumen = await resumenParaArchivar(escenario.admin, corte);
    expect(resumen.comprobantes).toBe(1);
    expect(resumen.paginas).toBe(1);
    expect(resumen.bytes).toBe(120_000);

    const { zip, nombre } = await exportarZip(escenario.admin, corte);
    expect(nombre).toBe('comprobantes-hasta-2025-01-01.zip');

    const { default: JSZip } = await import('jszip');
    const abierto = await JSZip.loadAsync(zip);
    const nombres = Object.keys(abierto.files);
    expect(nombres).toContain('indice.csv');
    expect(nombres.some((n) => n.endsWith('.jpg'))).toBe(true);

    const indice = await abierto.file('indice.csv')!.async('string');
    expect(indice).toContain('0010-00000010');
    expect(indice).toContain('Los Calvos');
    // El comprobante nuevo no entra en la exportación.
    expect(indice).not.toContain('0010-00000011');
  });

  it('no borra nada si antes no se descargó la exportación', async () => {
    await comprobanteConImagen({ numero: '00000012', fecha: '2024-03-15', bytes: 120_000 });
    await expect(
      archivarImagenes(escenario.admin, {
        anteriorA: new Date('2025-01-01T00:00:00'),
        confirmoDescarga: false,
      }),
    ).rejects.toThrow(ValidationError);

    expect(await prisma.documentFile.count({ where: { archivedAt: null } })).toBe(1);
  });

  it('libera el espacio y conserva todos los datos del comprobante', async () => {
    const documentId = await comprobanteConImagen({
      numero: '00000013',
      fecha: '2024-03-15',
      bytes: 120_000,
    });
    // Un renglón y un pago, que son los datos que no se pueden perder.
    await prisma.documentItem.create({
      data: {
        documentId,
        lineNumber: 1,
        description: 'LONGANIZA CORTA',
        quantity: '16.10',
        unit: 'KG',
        unitNetPrice: '16037',
        grossSubtotal: '258195.70',
        netAmount: '222048.30',
        totalCost: '272009.16',
        unitCost: '16894.98',
      },
    });

    const storage = await getStorage();
    const archivo = await prisma.documentFile.findFirstOrThrow({ where: { documentId } });
    expect(await storage.exists(archivo.storageKey)).toBe(true);

    const resultado = await archivarImagenes(escenario.admin, {
      anteriorA: new Date('2025-01-01T00:00:00'),
      confirmoDescarga: true,
    });

    expect(resultado.paginas).toBe(1);
    expect(resultado.bytesLiberados).toBe(120_000);

    // La imagen ya no está y no ocupa lugar.
    expect(await storage.exists(archivo.storageKey)).toBe(false);
    expect((await estadoAlmacenamiento()).usadoBytes).toBe(0);

    // Pero el comprobante sigue completo: sus renglones, su total y su rastro.
    const guardado = await prisma.document.findUniqueOrThrow({
      where: { id: documentId },
      include: { items: true, files: true },
    });
    expect(guardado.status).toBe('VALIDADO');
    expect(guardado.total?.toString()).toBe('1000');
    expect(guardado.items).toHaveLength(1);
    expect(guardado.items[0].description).toBe('LONGANIZA CORTA');
    // Y queda registrado que la imagen se archivó, con quién y cuándo.
    expect(guardado.files).toHaveLength(1);
    expect(guardado.files[0].archivedAt).not.toBeNull();
    expect(guardado.files[0].archivedById).toBe(escenario.admin.id);
  });

  it('un operador no puede archivar', async () => {
    await comprobanteConImagen({ numero: '00000014', fecha: '2024-03-15', bytes: 120_000 });
    await expect(
      resumenParaArchivar(escenario.operadorDevoto, new Date('2025-01-01T00:00:00')),
    ).rejects.toThrow(ForbiddenError);
  });

  it('no archiva comprobantes que todavía no se confirmaron', async () => {
    const documento = await prisma.document.create({
      data: {
        branchId: escenario.sucursales.devoto,
        createdById: escenario.admin.id,
        status: 'REQUIERE_REVISION',
        issueDate: new Date('2024-03-15T00:00:00'),
      },
    });
    await prisma.documentFile.create({
      data: {
        documentId: documento.id,
        pageOrder: 1,
        storageKey: 'comprobantes/pendiente/01-work.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 90_000,
        sha256: 'pendiente',
      },
    });

    const resumen = await resumenParaArchivar(escenario.admin, new Date('2025-01-01T00:00:00'));
    expect(resumen.comprobantes).toBe(0);
  });
});
