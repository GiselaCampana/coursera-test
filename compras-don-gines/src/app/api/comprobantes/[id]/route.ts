import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import { getDocumentForReview } from '@/lib/services/documents';
import { getStorage } from '@/lib/storage';
import { handle } from '@/lib/api';
import { toISODate } from '@/lib/datetime';

/** Datos completos del comprobante para la pantalla de revisión. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser();
    const { id } = await params;
    const document = await getDocumentForReview(user, id);
    const storage = await getStorage();

    const paginas = await Promise.all(
      document.files.map(async (file) => ({
        id: file.id,
        orden: file.pageOrder,
        url: await storage.signedUrl(file.storageKey),
        tipo: file.mimeType,
        esPdf: file.mimeType === 'application/pdf',
        tamano: file.sizeBytes,
      })),
    );

    return NextResponse.json({
      id: document.id,
      sucursal: { id: document.branchId, nombre: document.branch.name },
      proveedor: document.supplier
        ? { id: document.supplier.id, nombre: document.supplier.tradeName }
        : null,
      tipo: document.docType,
      letra: document.letter,
      puntoDeVenta: document.pointOfSale,
      numero: document.number,
      fecha: document.issueDate ? toISODate(document.issueDate) : null,
      estado: document.status,
      control: document.checkState,
      informe: document.checkReport,
      resumen: {
        grossSubtotal: document.grossSubtotal?.toString() ?? null,
        discountTotal: document.discountTotal?.toString() ?? null,
        netTotal: document.netTotal?.toString() ?? null,
        ivaTotal: document.ivaTotal?.toString() ?? null,
        perceptionsTotal: document.perceptionsTotal?.toString() ?? null,
        total: document.total?.toString() ?? null,
        lineCount: document.printedLineCount,
        netWeightKg: document.printedNetWeightKg?.toString() ?? null,
        totalUnits: document.printedTotalUnits?.toString() ?? null,
      },
      condiciones: {
        plazo: document.appliedTermType,
        dias: document.appliedTermDays,
        formaDePago: document.appliedPaymentMethod,
        ivaTasa: document.appliedIvaRate?.toString() ?? null,
        iibbTasa: document.appliedIibbRate?.toString() ?? null,
        vencimiento: document.appliedDueDate ? toISODate(document.appliedDueDate) : null,
      },
      articulos: document.items.map((item) => ({
        id: item.id,
        renglon: item.lineNumber,
        codigo: item.supplierCode,
        descripcion: item.description,
        cantidad: item.quantity.toString(),
        unidad: item.unit,
        piezas: item.pieceCount,
        pesoTotal: item.totalWeightKg?.toString() ?? null,
        pesoPorPieza: item.avgPieceWeightKg?.toString() ?? null,
        precioUnitario: item.unitNetPrice.toString(),
        bruto: item.grossSubtotal.toString(),
        descuentoPct: item.discountPct.toString(),
        descuento: item.discountAmount.toString(),
        neto: item.netAmount.toString(),
        ivaTasa: item.ivaRate.toString(),
        iva: item.ivaAmount.toString(),
        percepcion: item.perceptionAmount.toString(),
        costoTotal: item.totalCost.toString(),
        costoUnitario: item.unitCost.toString(),
        productoId: item.productId,
        producto: item.product?.normalizedName ?? null,
        asociacion: item.matchMethod,
      })),
      paginas,
      lecturas: document.ocrAttempts.map((a) => ({
        numero: a.attemptNumber,
        etapa: a.stage,
        estrategia: a.strategy,
        proveedor: a.provider,
        modelo: a.model,
        exito: a.success,
        duracionMs: a.durationMs,
        confianza: a.overallConfidence?.toString() ?? null,
        error: a.error,
      })),
      pago: document.paymentSchedule
        ? {
            id: document.paymentSchedule.id,
            vencimiento: toISODate(document.paymentSchedule.dueDate),
            importe: document.paymentSchedule.plannedAmount.toString(),
            pagado: document.paymentSchedule.paidAmount.toString(),
            formaDePago: document.paymentSchedule.plannedPaymentMethod,
            estado: document.paymentSchedule.status,
          }
        : null,
    });
  });
}
