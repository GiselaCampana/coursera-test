import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import { getDocumentForReview } from '@/lib/services/documents';
import { getStorage } from '@/lib/storage';
import { handle } from '@/lib/api';
import { toISODate } from '@/lib/datetime';
import { prisma } from '@/lib/db';
import { clasificarRenglon, indicePorCodigo } from '@/lib/domain/gastos';
import { versionEnEjecucion } from '@/lib/version';

/** Datos completos del comprobante para la pantalla de revisión. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const user = await requireUser();
    const { id } = await params;
    const document = await getDocumentForReview(user, id);

    /*
     * La clasificación **efectiva** de cada renglón, no sólo la persistida.
     *
     * `item.expenseKind` sólo tiene valor cuando una persona ya lo decidió o
     * cuando una confirmación anterior lo escribió. Hasta entonces la
     * clasificación sale de los códigos de gasto configurados del proveedor, que
     * es lo que hace que la BOLSA GRANDE de Ezra sea un gasto sin que nadie la
     * toque.
     *
     * Devolver sólo lo persistido hacía que el editor mostrara la bolsa como
     * mercadería: la pantalla contradecía a la vista previa, que sí la muestra
     * como gasto. Un editor que miente sobre lo que va a pasar es peor que uno
     * que no muestra el dato.
     */
    const codigosDeGasto = indicePorCodigo(
      document.supplierId
        ? await prisma.supplierExpenseCode.findMany({
            where: { supplierId: document.supplierId },
            select: { supplierCode: true, kind: true, unit: true, label: true },
          })
        : [],
    );
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
      /*
       * Quién firma el comprobante según el papel.
       *
       * Va aparte de `proveedor` porque son dos cosas distintas: éste es lo que
       * se leyó, aquél es a qué ficha se lo pudo enganchar. Cuando hay lectura y
       * no hay ficha, la pantalla tiene con qué ofrecer el alta sin mandar a
       * nadie a mirar la foto de nuevo.
       */
      proveedorLeido:
        document.readSupplierName || document.readSupplierCuit
          ? { nombre: document.readSupplierName, cuit: document.readSupplierCuit }
          : null,
      tipo: document.docType,
      letra: document.letter,
      motivoCredito: document.creditReason,
      comprobanteRelacionadoId: document.relatedDocumentId,
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
      /*
       * El IVA y las percepciones tal como los discrimina el comprobante.
       *
       * La pantalla las necesita para dos cosas: mostrarlas por separado en el
       * resumen —"Percepción IVA RG 5329" y "Percepción IIBB Buenos Aires" son
       * dos números distintos del papel— y repartir cada una contra su propio
       * importe al recalcular, que es como las reparte el servidor.
       */
      impuestos: document.taxLines.map((linea) => ({
        tipo: linea.kind,
        etiqueta: linea.label,
        tasa: linea.rate.toString(),
        importe: linea.amount.toString(),
      })),
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
        brutoImpreso: item.grossFromPrint,
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
        devolucion: item.stockReturn,
        /*
         * Cómo está clasificado el renglón: mercadería o gasto, y de qué clase.
         *
         * Va en el detalle porque el editor tiene que poder mostrarlo y
         * cambiarlo, y porque el servidor lo compara al confirmar para saber si
         * alguien lo reclasificó. `null` es mercadería.
         */
        gasto:
          clasificarRenglon(
            { expenseKind: item.expenseKind, supplierCode: item.supplierCode },
            codigosDeGasto,
          ).kind ?? null,
      })),
      paginas,
      /*
       * Qué versión está corriendo ahora y con cuál se leyó cada intento.
       *
       * Cuando las dos no coinciden, lo que está en pantalla salió de un código
       * anterior al despliegue: la pantalla lo dice y ofrece volver a leer, en
       * vez de dejar que el resultado viejo pase por nuevo.
       */
      version: {
        commitCorto: versionEnEjecucion().commitCorto,
        commit: versionEnEjecucion().commit,
      },
      lecturas: document.ocrAttempts.map((a) => ({
        numero: a.attemptNumber,
        build: a.buildSha,
        buildCorto: a.buildSha ? a.buildSha.slice(0, 7) : null,
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
