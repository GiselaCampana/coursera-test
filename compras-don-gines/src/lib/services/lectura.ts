import 'server-only';
import { prisma, type Prisma } from '@/lib/db';
import { ValidationError } from '@/lib/errors';
import { type AuthUser } from '@/lib/auth/session';
import { toDecimal } from '@/lib/money';
import { arToday, parseArDate } from '@/lib/datetime';
import { computeDueDate } from '@/lib/domain/payments';
import {
  consistentPerceptionLines,
  costItems,
  type CostedItem,
  type RawItem,
} from '@/lib/domain/costing';
import {
  validateDocument,
  type PrintedSummary,
  type SupplierTaxExpectation,
  type ValidationReport,
} from '@/lib/domain/validation';
import { conciliarCentavos, type Conciliacion } from '@/lib/domain/conciliacion';
import { mergeHeaders, toPrintedSummary, toRawItems } from '@/lib/ocr/normalize';
import { elegirAnalizador } from '@/lib/ocr/parsers';
import type { AnalisisComprobante, TextosComprobante } from '@/lib/ocr/parsers/tipos';
import type { OcrHeader, OcrSummary } from '@/lib/ocr/types';
import { env } from '@/lib/env';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/services/audit';
import { findSupplierByReading, getSupplierConditions } from '@/lib/services/suppliers';
import {
  createTaxLines,
  itemToColumns,
  loadEditableDocument,
  matchItemsToProducts,
  printedToColumns,
} from '@/lib/services/documents';

/**
 * Recepción de las lecturas que hace el navegador.
 *
 * El OCR corre en el teléfono con Tesseract; de acá para adelante todo pasa en
 * el servidor: elegir el analizador del proveedor, interpretar el texto,
 * calcular los importes y controlar que el comprobante cierre. El navegador
 * manda texto, nunca conclusiones: si mandara "esto cierra", no se le creería.
 *
 * Cada lectura se guarda como un intento. En cada vuelta se reconstruyen todas
 * las combinaciones posibles entre los intentos acumulados y gana la más
 * consistente, no la última.
 */

export interface PaginaLeida {
  numero: number;
  textoCompleto: string;
  textoEncabezado?: string | null;
  textoArticulos?: string | null;
  textoResumen?: string | null;
  confianza?: number | null;
  inclinacion?: number | null;
  perspectivaCorregida?: boolean | null;
  /**
   * Lo que el lector vio en la página antes de interpretar nada.
   *
   * `filasDetectadas` es cuántas filas de la tabla contó sobre la imagen. Sirve
   * para contrastarlo contra cuántos renglones se pudieron entender: son dos
   * medidas independientes, y la diferencia entre ellas es la que delata una
   * lectura incompleta.
   */
  regiones?: { filasDetectadas?: number | null } | null;
}

export interface LecturaEntrante {
  intento: number;
  estrategia: string;
  proveedor: string;
  modelo: string;
  duracionMs: number;
  confianza?: number | null;
  observaciones?: string[];
  paginas: PaginaLeida[];
}

export interface ResultadoLectura {
  documentId: string;
  report: ValidationReport;
  supplierId: string | null;
  analizador: string;
  renglonesAsociados: number;
  renglonesSinAsociar: number;
  intentos: number;
  observaciones: string[];
  /** Cuando la lectura no cerró y todavía quedan vueltas, qué hay que releer. */
  releer: { motivo: string } | null;
}

interface Candidato {
  etiqueta: string;
  header: OcrHeader | null;
  summary: OcrSummary | null;
  items: RawItem[];
  analizador: string;
  observaciones: string[];
  /** Filas que el lector contó en la imagen, sumando todas las páginas. */
  filasEnLaImagen: number | null;
}

interface CandidatoEvaluado extends Candidato {
  printed: PrintedSummary;
  costeados: CostedItem[];
  informe: ValidationReport;
  puntaje: number;
  conciliacion: Conciliacion | null;
}

export async function registrarLectura(
  user: AuthUser,
  documentId: string,
  lectura: LecturaEntrante,
): Promise<ResultadoLectura> {
  const document = await loadEditableDocument(user, documentId);

  if (!Array.isArray(lectura.paginas) || lectura.paginas.length === 0) {
    throw new ValidationError('La lectura llegó sin ninguna página.');
  }
  if (lectura.paginas.every((p) => (p.textoCompleto ?? '').trim() === '')) {
    throw new ValidationError(
      'No se reconoció ningún texto en las imágenes. Probá sacar la foto con más luz y de más cerca.',
    );
  }

  await prisma.document.update({
    where: { id: documentId },
    data: { status: 'PROCESANDO', checkState: 'PENDIENTE' },
  });

  try {
    // --- 1. Se guarda el intento -----------------------------------------
    const intento = Math.max(1, Math.floor(lectura.intento || 1));
    const textoReconocido = lectura.paginas.map((p) => p.textoCompleto ?? '').join('\n\n');

    await prisma.ocrAttempt.deleteMany({ where: { documentId, attemptNumber: intento } });
    await prisma.ocrAttempt.create({
      data: {
        documentId,
        attemptNumber: intento,
        stage: intento === 1 ? 'FULL' : 'ITEMS_FOCUSED',
        strategy: lectura.estrategia,
        provider: lectura.proveedor,
        model: lectura.modelo,
        success: true,
        startedAt: new Date(Date.now() - (lectura.duracionMs || 0)),
        finishedAt: new Date(),
        durationMs: lectura.duracionMs || 0,
        rawResponse: { paginas: lectura.paginas } as unknown as Prisma.InputJsonValue,
        recognizedText: textoReconocido,
        overallConfidence:
          lectura.confianza === null || lectura.confianza === undefined
            ? null
            : lectura.confianza.toFixed(4),
        fieldConfidences: {
          paginas: lectura.paginas.map((p) => ({ numero: p.numero, confianza: p.confianza ?? null })),
        } as unknown as Prisma.InputJsonValue,
      },
    });

    // --- 2. Se recuperan todos los intentos y se arman los candidatos ------
    const intentos = await prisma.ocrAttempt.findMany({
      where: { documentId },
      orderBy: { attemptNumber: 'asc' },
    });

    const candidatos: Candidato[] = [];
    for (const guardado of intentos) {
      const paginas = (guardado.rawResponse as { paginas?: PaginaLeida[] } | null)?.paginas;
      if (!paginas || paginas.length === 0) continue;
      candidatos.push(...analizarIntento(paginas, guardado.attemptNumber));
    }

    if (candidatos.length === 0) {
      throw new ValidationError(
        'No se pudo interpretar el texto reconocido. Probá sacar la foto de nuevo.',
      );
    }

    // --- 3. Proveedor y condiciones ---------------------------------------
    const encabezado = candidatos.map((c) => c.header).reduce((a, b) => mergeHeaders(a, b), null);
    const proveedor = await findSupplierByReading(encabezado ?? {});
    const fechaEmision = parseArDate(encabezado?.issueDate) ?? arToday();
    const condiciones = proveedor.supplierId
      ? await getSupplierConditions(proveedor.supplierId, fechaEmision)
      : { term: null, tax: null };

    const reglas: SupplierTaxExpectation | undefined = condiciones.tax
      ? { ivaRate: condiciones.tax.ivaRate, iibbRate: condiciones.tax.iibbRate }
      : undefined;

    // --- 4. Gana el conjunto más consistente ------------------------------
    const mejor = elegirMejor(candidatos, reglas, intentos.length);
    const vencimiento = condiciones.term ? computeDueDate(fechaEmision, condiciones.term) : null;
    const asociaciones = await matchItemsToProducts(mejor.costeados, proveedor.supplierId);

    // --- 5. Se guarda lo leído -------------------------------------------
    await prisma.$transaction(async (tx) => {
      await tx.documentItem.deleteMany({ where: { documentId } });
      await tx.documentTaxLine.deleteMany({ where: { documentId } });

      await tx.document.update({
        where: { id: documentId },
        data: {
          supplierId: proveedor.supplierId,
          docType: mejor.header?.docType === 'REMITO' ? 'REMITO' : 'FACTURA',
          letter: mejor.header?.letter ?? null,
          pointOfSale: mejor.header?.pointOfSale ?? '',
          number: mejor.header?.number ?? '',
          fullNumber: mejor.header?.fullNumber ?? '',
          issueDate: fechaEmision,
          currency: mejor.header?.currency ?? 'ARS',
          ...printedToColumns(mejor.printed),
          status: 'REQUIERE_REVISION',
          checkState: mejor.informe.state,
          checkReport: mejor.informe as unknown as Prisma.InputJsonValue,
          appliedTermType: condiciones.term?.termType ?? null,
          appliedTermDays: condiciones.term?.days ?? null,
          appliedPaymentMethod: condiciones.term?.paymentMethod ?? null,
          appliedIvaRate: condiciones.tax?.ivaRate ?? null,
          appliedIibbRate: condiciones.tax?.iibbRate ?? null,
          appliedDueDate: vencimiento,
        },
      });

      if (mejor.costeados.length > 0) {
        await tx.documentItem.createMany({
          data: mejor.costeados.map((item, i) => ({
            documentId,
            ...itemToColumns(item),
            productId: asociaciones[i]?.productId ?? null,
            matchMethod: asociaciones[i]?.method ?? 'NONE',
            matchScore: asociaciones[i]?.score?.toString() ?? null,
          })),
        });
      }

      await createTaxLines(tx, documentId, mejor.summary);
    });

    const observaciones = [...new Set([...(lectura.observaciones ?? []), ...mejor.observaciones])];
    if (mejor.conciliacion) observaciones.push(mejor.conciliacion.mensaje);

    await recordAudit({
      userId: user.id,
      action: AUDIT_ACTIONS.DOCUMENT_READ,
      entity: 'Document',
      entityId: documentId,
      after: {
        estado: mejor.informe.state,
        renglones: mejor.costeados.length,
        intentos: intentos.length,
        analizador: mejor.analizador,
        lector: lectura.proveedor,
        estrategia: mejor.etiqueta,
      },
    });

    /*
     * La conciliación de centavos va en su propio asiento de auditoría.
     *
     * Podría ir dentro del anterior, pero es lo único de toda la lectura que
     * *cambia un importe* respecto de lo que se leyó del papel. Merece un
     * renglón propio en la auditoría, buscable por su acción, con el importe
     * que se leyó, el que quedó y la diferencia de cada renglón afectado. El
     * comprobante y su imagen se llegan desde `entityId`.
     */
    if (mejor.conciliacion) {
      await recordAudit({
        userId: user.id,
        action: AUDIT_ACTIONS.CENTAVOS_CONCILIADOS,
        entity: 'Document',
        entityId: documentId,
        reason: mejor.conciliacion.mensaje,
        after: {
          totalConciliado: mejor.conciliacion.totalAbsoluto,
          renglones: mejor.conciliacion.renglones,
          netoImpreso: mejor.printed.netTotal ?? null,
          totalImpreso: mejor.printed.total ?? null,
        },
      });
    }

    const puedeReleer = !mejor.informe.canSave && intentos.length < env.ocrMaxAttempts;

    return {
      documentId,
      report: mejor.informe,
      supplierId: proveedor.supplierId,
      analizador: mejor.analizador,
      renglonesAsociados: asociaciones.filter((a) => a.productId).length,
      renglonesSinAsociar: asociaciones.filter((a) => !a.productId).length,
      intentos: intentos.length,
      observaciones,
      releer: puedeReleer ? { motivo: describirProblema(mejor.informe) } : null,
    };
  } catch (error) {
    await prisma.document
      .update({
        where: { id: documentId },
        data: { status: 'REQUIERE_REVISION', checkState: 'PENDIENTE' },
      })
      .catch(() => {});
    throw error;
  } finally {
    void document;
  }
}

/**
 * Candidatos que salen de un intento.
 *
 * Se generan dos: uno con los recortes por zona, que suele ser el bueno, y otro
 * leyendo todo desde el texto de la página completa, que salva los casos en que
 * un recorte cortó de más.
 */
function analizarIntento(paginas: PaginaLeida[], numeroDeIntento: number): Candidato[] {
  const conRecortes = juntarPaginas(paginas, false);
  const soloCompleto = juntarPaginas(paginas, true);
  const filasEnLaImagen = contarFilasVistas(paginas);

  const candidatos: Candidato[] = [];
  for (const [modo, textos] of [
    ['recortes', conRecortes],
    ['página completa', soloCompleto],
  ] as const) {
    const { analizador } = elegirAnalizador(textos);
    const analisis = analizador.analizar(textos);
    if (analisis.items.length === 0 && !analisis.summary?.total) continue;

    candidatos.push({
      etiqueta: `intento ${numeroDeIntento} · ${modo} · ${analizador.nombre}`,
      header: analisis.header,
      summary: analisis.summary,
      items: toRawItems(analisis.items),
      analizador: analizador.codigo,
      observaciones: analisis.observaciones,
      filasEnLaImagen,
    });
  }
  return candidatos;
}

/** Filas de tabla que el lector contó en la imagen, sumando las páginas. */
function contarFilasVistas(paginas: PaginaLeida[]): number | null {
  let total = 0;
  let alguna = false;
  for (const pagina of paginas) {
    const filas = pagina.regiones?.filasDetectadas;
    if (typeof filas === 'number' && filas > 0) {
      total += filas;
      alguna = true;
    }
  }
  return alguna ? total : null;
}

/** Une las páginas en un solo juego de textos por zona. */
function juntarPaginas(paginas: PaginaLeida[], soloTextoCompleto: boolean): TextosComprobante {
  const ordenadas = [...paginas].sort((a, b) => a.numero - b.numero);
  const unir = (elegir: (p: PaginaLeida) => string | null | undefined) =>
    ordenadas
      .map(elegir)
      .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
      .join('\n');

  const completo = unir((p) => p.textoCompleto);
  if (soloTextoCompleto) {
    return { completo, encabezado: null, articulos: null, resumen: null };
  }

  return {
    completo,
    // El encabezado está en la primera página; el pie, en la última que lo tenga.
    encabezado: ordenadas[0]?.textoEncabezado ?? null,
    articulos: unir((p) => p.textoArticulos) || null,
    resumen:
      [...ordenadas].reverse().find((p) => (p.textoResumen ?? '').trim() !== '')?.textoResumen ??
      null,
  };
}

/**
 * Puntúa cada candidato y devuelve el mejor.
 *
 * Manda la cantidad de errores del control; a igualdad, el que queda más cerca
 * del neto impreso; después, el que trae más renglones, porque un renglón que
 * falta es peor que uno de más, que se ve a simple vista.
 */
function elegirMejor(
  candidatos: Candidato[],
  reglas: SupplierTaxExpectation | undefined,
  intentos: number,
): CandidatoEvaluado {
  const evaluados = candidatos.map((candidato): CandidatoEvaluado => {
    const printed = toPrintedSummary(candidato.summary);

    /*
     * Antes de costear, la conciliación de centavos.
     *
     * Va acá y no en el analizador del proveedor a propósito: es una regla del
     * negocio, no del formato de un comprobante, y tiene que valer igual para
     * cualquier proveedor. Devuelve los renglones sin tocar salvo que se den
     * todas sus condiciones, así que llamarla siempre no cambia nada en los
     * comprobantes que ya cerraban.
     */
    const conciliado = conciliarCentavos({
      items: candidato.items,
      printed,
      filasEnLaImagen: candidato.filasEnLaImagen,
    });

    const costeados = costItems(conciliado.items, {
      netTotal: printed.netTotal ?? '0',
      ivaTotal: printed.ivaTotal ?? '0',
      perceptionsTotal: printed.perceptionsTotal ?? '0',
      // Las percepciones que el comprobante discrimina, para repartir cada una
      // contra su propio importe impreso en vez de repartir el bulto.
      perceptionLines: consistentPerceptionLines(
        candidato.summary?.perceptionLines,
        printed.perceptionsTotal ?? '0',
      ),
    });
    const informe = validateDocument({
      items: costeados,
      printed,
      supplierRules: reglas,
      attempts: intentos,
      filasEnLaImagen: candidato.filasEnLaImagen,
      reconciliation: conciliado.conciliacion,
    });

    const diferencia = printed.netTotal
      ? toDecimal(informe.computed.netAmount).minus(toDecimal(printed.netTotal)).abs()
      : toDecimal('0');
    const relativa = printed.netTotal
      ? diferencia.div(toDecimal(printed.netTotal).abs().plus(1)).toNumber()
      : 1;

    // Un renglón sin su importe impreso no se puede contrastar contra el
    // papel: cantidad × precio le cierra por construcción. Sin este castigo la
    // elección se vuelve perversa, porque la lectura que *perdió* la columna
    // Importe queda libre de errores por no tener con qué contradecirse, y le
    // gana a la que sí la leyó y detectó el problema. Vale más una lectura que
    // se puede verificar que una que no.
    const sinVerificar = costeados.filter((i) => !i.grossFromPrint).length;

    const puntaje =
      informe.errorCount * 1_000_000 +
      sinVerificar * 5_000 +
      informe.warningCount * 1_000 +
      // Un candidato que necesitó conciliar centavos es apenas peor que uno que
      // cerró sin tocar nada: a igualdad de todo lo demás, gana el que se leyó
      // entero. Pesa poco, porque conciliar centavos es una diferencia menor.
      (conciliado.conciliacion ? 50 : 0) +
      Math.min(relativa, 1) * 900 -
      Math.min(candidato.items.length, 200);

    return {
      ...candidato,
      printed,
      costeados,
      informe,
      puntaje,
      conciliacion: conciliado.conciliacion,
    };
  });

  evaluados.sort((a, b) => a.puntaje - b.puntaje);
  return evaluados[0];
}

/**
 * Interpreta una lectura sin tocar la base.
 *
 * Es lo que usa la pantalla de diagnóstico. Corre los mismos analizadores, el
 * mismo cálculo y los mismos autocontroles que `registrarLectura`, pero no
 * guarda el comprobante ni la imagen: no consulta el proveedor en la base, así
 * que las reglas impositivas quedan sin aplicar y los controles de IVA y
 * percepciones se informan como no verificables. Todo lo demás —renglones,
 * neto, peso, total— se controla igual.
 */
export function analizarSinGuardar(paginas: PaginaLeida[]): {
  articulos: number;
  analizador: string | null;
  estado: string | null;
  controles: ValidationReport['checks'];
  observaciones: string[];
  calculado: ValidationReport['computed'] | null;
} {
  const candidatos = analizarIntento(paginas, 1);
  if (candidatos.length === 0) {
    return {
      articulos: 0,
      analizador: null,
      estado: null,
      controles: [],
      observaciones: ['No se reconoció ningún comprobante en el texto leído.'],
      calculado: null,
    };
  }

  const mejor = elegirMejor(candidatos, undefined, 1);
  return {
    articulos: mejor.costeados.length,
    analizador: mejor.analizador,
    estado: mejor.informe.state,
    controles: mejor.informe.checks,
    observaciones: mejor.observaciones,
    calculado: mejor.informe.computed,
  };
}

/** Resume en castellano qué fue lo que no cerró, para pedir la relectura. */
export function describirProblema(informe: ValidationReport): string {
  const fallas = informe.checks.filter((c) => c.severity === 'ERROR');
  if (fallas.length === 0) return 'La lectura anterior no quedó controlada.';
  return fallas.map((c) => `${c.label}: ${c.message}`).join(' ');
}
