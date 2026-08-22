import { costItems, type CostedItem, type RawItem } from '@/lib/domain/costing';
import {
  validateDocument,
  type PrintedSummary,
  type SupplierTaxExpectation,
  type ValidationReport,
} from '@/lib/domain/validation';
import { toDecimal } from '@/lib/money';
import { mergeHeaders, mergeSummaries, toPrintedSummary, toRawItems } from '@/lib/ocr/normalize';
import type {
  OcrHeader,
  OcrPage,
  OcrProvider,
  OcrRegion,
  OcrResponse,
  OcrStage,
  OcrSummary,
} from '@/lib/ocr/types';
import { toUserMessage } from '@/lib/errors';

/** Etapas que se le muestran al usuario mientras espera. */
export type ProgressStage =
  | 'PREPARANDO'
  | 'SUBIENDO'
  | 'LEYENDO_ENCABEZADO'
  | 'LEYENDO_ARTICULOS'
  | 'VERIFICANDO_TOTALES'
  | 'RELEYENDO'
  | 'LISTO'
  | 'ERROR';

export const PROGRESS_LABEL: Record<ProgressStage, string> = {
  PREPARANDO: 'Preparando las imágenes',
  SUBIENDO: 'Subiendo el comprobante',
  LEYENDO_ENCABEZADO: 'Leyendo el encabezado',
  LEYENDO_ARTICULOS: 'Leyendo los artículos',
  VERIFICANDO_TOTALES: 'Verificando los totales',
  RELEYENDO: 'La lectura no cerró: releyendo el comprobante',
  LISTO: 'Listo',
  ERROR: 'No se pudo leer el comprobante',
};

export interface AttemptRecord {
  attemptNumber: number;
  stage: OcrStage;
  strategy: string;
  provider: string;
  model: string | null;
  success: boolean;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  raw: unknown;
  text: string | null;
  overallConfidence: number | null;
  fieldConfidences: Record<string, number> | null;
  error: string | null;
}

export interface PipelineInput {
  pages: OcrPage[];
  provider: OcrProvider;
  supplierNames?: string[];
  supplierRules?: SupplierTaxExpectation;
  maxAttempts?: number;
  onProgress?: (stage: ProgressStage, detail?: string) => void;
  /**
   * Recorta y realza una zona de una página. Se inyecta desde afuera para que
   * el pipeline no dependa de sharp y se pueda probar sin imágenes reales.
   */
  cropPage?: (page: OcrPage, region: OcrRegion) => Promise<OcrPage | null>;
}

export interface PipelineResult {
  header: OcrHeader | null;
  summary: OcrSummary | null;
  printed: PrintedSummary;
  rawItems: RawItem[];
  items: CostedItem[];
  report: ValidationReport;
  attempts: AttemptRecord[];
  itemsRegion: OcrRegion | null;
  summaryRegion: OcrRegion | null;
  notes: string[];
  /** Qué combinación de lecturas terminó eligiéndose. */
  chosenStrategy: string;
}

interface Candidate {
  label: string;
  header: OcrHeader | null;
  summary: OcrSummary | null;
  items: ReturnType<typeof toRawItems>;
}

interface ScoredCandidate extends Candidate {
  printed: PrintedSummary;
  costed: CostedItem[];
  report: ValidationReport;
  score: number;
}

/** Zonas por defecto cuando el lector no informó dónde está cada cosa. */
const DEFAULT_ITEMS_REGION: OcrRegion = { left: 0, top: 0.18, width: 1, height: 0.62 };
const DEFAULT_SUMMARY_REGION: OcrRegion = { left: 0.3, top: 0.62, width: 0.7, height: 0.38 };

/**
 * Lee un comprobante en etapas y se recupera solo cuando la lectura no cierra.
 *
 * El circuito es: leer todo → calcular → controlar contra el resumen impreso.
 * Si algo no cierra, no se acepta el resultado: se vuelve sobre la imagen con
 * recortes ampliados de la tabla de artículos y del pie, se leen las columnas
 * por separado y se compara cada combinación de lecturas. Gana la más
 * consistente, no la última.
 *
 * Lo que nunca hace: tocar un importe para forzar que la cuenta cierre. Si
 * después de los reintentos sigue sin cerrar, devuelve el mejor intento con el
 * informe en rojo y los datos parciales para diagnóstico.
 */
export async function readDocument(input: PipelineInput): Promise<PipelineResult> {
  const maxAttempts = Math.max(1, input.maxAttempts ?? 3);
  const attempts: AttemptRecord[] = [];
  const notes: string[] = [];
  const progress = input.onProgress ?? (() => {});

  const headers: OcrHeader[] = [];
  const summaries: { label: string; summary: OcrSummary }[] = [];
  const itemSets: { label: string; items: ReturnType<typeof toRawItems> }[] = [];

  let itemsRegion: OcrRegion | null = null;
  let summaryRegion: OcrRegion | null = null;

  const runStage = async (
    stage: OcrStage,
    pages: OcrPage[],
    strategy: string,
    hints?: PipelineInput['supplierRules'] extends never ? never : Record<string, unknown>,
  ): Promise<OcrResponse | null> => {
    const attemptNumber = attempts.length + 1;
    const startedAt = new Date();
    try {
      const response = await input.provider.read({
        stage,
        pages,
        hints: hints as never,
      });
      const finishedAt = new Date();
      attempts.push({
        attemptNumber,
        stage,
        strategy,
        provider: response.provider,
        model: response.model ?? null,
        success: true,
        startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        raw: response.raw ?? null,
        text: response.text ?? null,
        overallConfidence: response.overallConfidence ?? null,
        fieldConfidences: response.fieldConfidences ?? null,
        error: null,
      });
      if (response.notes?.length) notes.push(...response.notes);
      return response;
    } catch (error) {
      const finishedAt = new Date();
      attempts.push({
        attemptNumber,
        stage,
        strategy,
        provider: input.provider.name,
        model: input.provider.model ?? null,
        success: false,
        startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        raw: null,
        text: null,
        overallConfidence: null,
        fieldConfidences: null,
        error: toUserMessage(error),
      });
      return null;
    }
  };

  const collect = (response: OcrResponse | null, label: string) => {
    if (!response) return;
    if (response.header) headers.push(response.header);
    if (response.summary) summaries.push({ label, summary: response.summary });
    if (response.items?.length) itemSets.push({ label, items: toRawItems(response.items) });
    if (response.itemsRegion) itemsRegion = response.itemsRegion;
    if (response.summaryRegion) summaryRegion = response.summaryRegion;
  };

  // --- Intento 1: lectura completa ---------------------------------------
  progress('LEYENDO_ENCABEZADO');
  const first = await runStage('FULL', input.pages, 'Lectura completa del comprobante', {
    supplierNames: input.supplierNames,
  } as never);
  progress('LEYENDO_ARTICULOS');
  collect(first, 'lectura completa');

  progress('VERIFICANDO_TOTALES');
  let best = pickBest(buildCandidates(headers, summaries, itemSets), input, attempts.length);

  // --- Recuperación automática -------------------------------------------
  let round = 1;
  while (best !== null && !best.report.canSave && round < maxAttempts) {
    round += 1;
    progress('RELEYENDO', describeProblem(best.report));

    const problem = describeProblem(best.report);
    const before = attempts.length;

    // Relectura focalizada del pie: primero hay que estar seguro del resumen,
    // porque es contra lo que se controla todo lo demás.
    const summaryPages = await cropPages(
      input,
      summaryRegion ?? DEFAULT_SUMMARY_REGION,
      'summary',
    );
    if (summaryPages.length > 0) {
      const response = await runStage(
        'SUMMARY_FOCUSED',
        summaryPages,
        'Recorte ampliado del pie del comprobante',
        { previousProblem: problem } as never,
      );
      collect(response, `pie ampliado (intento ${round})`);
    }

    // Relectura focalizada de la tabla de artículos.
    const itemPages = await cropPages(input, itemsRegion ?? DEFAULT_ITEMS_REGION, 'items');
    if (itemPages.length > 0) {
      const stage: OcrStage = round >= 3 ? 'ITEMS_COLUMNS' : 'ITEMS_FOCUSED';
      const response = await runStage(
        stage,
        itemPages,
        round >= 3
          ? 'Lectura por columnas de la tabla de artículos'
          : 'Recorte ampliado y con más contraste de la tabla de artículos',
        {
          previousProblem: problem,
          expectedLineCount: bestPrintedLineCount(best),
        } as never,
      );
      collect(response, `artículos ampliados (intento ${round})`);
    }

    if (attempts.length === before) {
      // No se pudo hacer ninguna relectura (por ejemplo, no hay recorte
      // posible). Insistir sería girar en el vacío.
      notes.push('No se pudo volver a leer el comprobante con más detalle.');
      break;
    }

    progress('VERIFICANDO_TOTALES');
    best = pickBest(buildCandidates(headers, summaries, itemSets), input, attempts.length);
  }

  if (!best) {
    // Ninguna lectura devolvió nada utilizable.
    const printed: PrintedSummary = {};
    const report = validateDocument({
      items: [],
      printed,
      supplierRules: input.supplierRules,
      attempts: attempts.length,
    });
    progress('ERROR');
    return {
      header: headers[0] ?? null,
      summary: null,
      printed,
      rawItems: [],
      items: [],
      report,
      attempts,
      itemsRegion,
      summaryRegion,
      notes: notes.length > 0 ? notes : ['No se pudo interpretar el comprobante.'],
      chosenStrategy: 'ninguna lectura utilizable',
    };
  }

  progress(best.report.canSave ? 'LISTO' : 'ERROR');

  return {
    header: headers.length > 0 ? headers.reduce((a, b) => mergeHeaders(a, b)!) : null,
    summary: best.summary,
    printed: best.printed,
    rawItems: best.items,
    items: best.costed,
    report: best.report,
    attempts,
    itemsRegion,
    summaryRegion,
    notes,
    chosenStrategy: best.label,
  };
}

/**
 * Arma todas las combinaciones de lecturas disponibles: cada conjunto de
 * artículos contra cada resumen. Es lo que permite quedarse con el conjunto
 * más consistente en vez de con el último leído.
 */
function buildCandidates(
  headers: OcrHeader[],
  summaries: { label: string; summary: OcrSummary }[],
  itemSets: { label: string; items: RawItem[] }[],
): Candidate[] {
  const header = headers.length > 0 ? headers.reduce((a, b) => mergeHeaders(a, b)!) : null;
  if (itemSets.length === 0 && summaries.length === 0) return [];

  const itemOptions = itemSets.length > 0 ? itemSets : [{ label: 'sin artículos', items: [] }];
  const summaryOptions =
    summaries.length > 0 ? summaries : [{ label: 'sin resumen', summary: {} as OcrSummary }];

  const candidates: Candidate[] = [];
  for (const items of itemOptions) {
    for (const summary of summaryOptions) {
      candidates.push({
        label: `${items.label} + ${summary.label}`,
        header,
        summary: summary.summary,
        items: items.items,
      });
    }
  }

  // Además, una variante que completa los huecos de cada resumen con los otros:
  // recuperar un campo que otra lectura sí vio no es inventarlo.
  if (summaries.length > 1) {
    const merged = summaries.reduce<OcrSummary | null>(
      (acc, s) => mergeSummaries(acc, s.summary),
      null,
    );
    if (merged) {
      for (const items of itemOptions) {
        candidates.push({
          label: `${items.label} + resumen combinado`,
          header,
          summary: merged,
          items: items.items,
        });
      }
    }
  }

  return candidates;
}

function scoreCandidate(
  candidate: Candidate,
  input: PipelineInput,
  attemptCount: number,
): ScoredCandidate {
  const printed = toPrintedSummary(candidate.summary);
  const costed = costItems(candidate.items, {
    netTotal: printed.netTotal ?? '0',
    ivaTotal: printed.ivaTotal ?? '0',
    perceptionsTotal: printed.perceptionsTotal ?? '0',
  });
  const report = validateDocument({
    items: costed,
    printed,
    supplierRules: input.supplierRules,
    attempts: attemptCount,
  });

  // Manda la cantidad de errores; a igualdad de errores, la lectura cuyo
  // detalle queda más cerca del neto impreso; después, la que trae más
  // renglones (un renglón que falta es peor que uno de más, que se ve).
  const netDiff = printed.netTotal
    ? toDecimal(report.computed.netAmount).minus(toDecimal(printed.netTotal)).abs()
    : toDecimal('0');
  const relativeDiff = printed.netTotal
    ? netDiff.div(toDecimal(printed.netTotal).abs().plus(1)).toNumber()
    : 1;

  const score =
    report.errorCount * 1_000_000 +
    report.warningCount * 1_000 +
    Math.min(relativeDiff, 1) * 900 -
    Math.min(candidate.items.length, 200);

  return { ...candidate, printed, costed, report, score };
}

function pickBest(
  candidates: Candidate[],
  input: PipelineInput,
  attemptCount: number,
): ScoredCandidate | null {
  if (candidates.length === 0) return null;
  const scored = candidates.map((c) => scoreCandidate(c, input, attemptCount));
  scored.sort((a, b) => a.score - b.score);
  return scored[0];
}

function bestPrintedLineCount(best: ScoredCandidate): number | null {
  return best.printed.lineCount ?? null;
}

/** Resume, en castellano, qué fue lo que no cerró. Se le pasa al lector. */
function describeProblem(report: ValidationReport): string {
  const failures = report.checks.filter((c) => c.severity === 'ERROR');
  if (failures.length === 0) return 'La lectura anterior no quedó controlada.';
  return failures.map((c) => `${c.label}: ${c.message}`).join(' ');
}

async function cropPages(
  input: PipelineInput,
  region: OcrRegion,
  kind: 'items' | 'summary',
): Promise<OcrPage[]> {
  if (!input.cropPage) return [];
  const out: OcrPage[] = [];
  for (const page of input.pages) {
    // Un PDF no se recorta: se vuelve a mandar entero con instrucciones
    // focalizadas, que es lo que el lector necesita para revisar esa zona.
    if (page.mimeType === 'application/pdf') {
      out.push(page);
      continue;
    }
    try {
      const cropped = await input.cropPage(page, region);
      if (cropped) out.push(cropped);
    } catch {
      // Si un recorte falla, se sigue con el resto de las páginas.
    }
  }
  if (out.length === 0) return [];
  // El pie suele estar sólo en la última página.
  if (kind === 'summary' && out.length > 1) return [out[out.length - 1]];
  return out;
}
