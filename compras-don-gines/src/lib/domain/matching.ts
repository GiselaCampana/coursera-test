/**
 * Reconocimiento de productos a partir de la descripción impresa.
 *
 * El mismo fiambre se escribe distinto en cada factura ("JAMON COCIDO
 * MONT-BLANC", "J. COCIDO MONTBLANC"). El orden de búsqueda es del dato más
 * confiable al menos confiable, y la coincidencia difusa sólo se acepta con un
 * umbral alto y sin empates: unir mal dos productos ensucia el historial de
 * precios de forma difícil de revertir.
 */

export type MatchMethod = 'SUPPLIER_CODE' | 'ALIAS' | 'FUZZY' | 'MANUAL' | 'NONE';

/** Por debajo de esto no se asocia nada y queda para que lo resuelva un humano. */
export const FUZZY_THRESHOLD = 0.86;
/** Si el segundo candidato está así de cerca del primero, la elección es dudosa. */
export const AMBIGUITY_MARGIN = 0.05;

export interface AliasCandidate {
  normalized: string;
  supplierId?: string | null;
  supplierCode?: string | null;
}

export interface ProductCandidate {
  id: string;
  internalCode: string;
  normalizedName: string;
  aliases?: AliasCandidate[];
}

export interface MatchInput {
  description: string;
  supplierCode?: string | null;
  supplierId?: string | null;
}

export interface MatchResult {
  productId: string | null;
  method: MatchMethod;
  score: number | null;
  /** Por qué no se asoció, cuando no se asoció. */
  reason?: string;
  /** Candidatos cercanos, para ofrecerlos en la revisión manual. */
  suggestions?: { productId: string; score: number }[];
}

/**
 * Un código de proveedor, listo para comparar.
 *
 * Se ignoran mayúsculas y los separadores con que cada sistema lo imprime:
 * "ART-00228", "art 00228" y "ART00228" son el mismo código. Lo que **no** se
 * toca son los dígitos ni las letras: "ART-00228" y "ART-00229" son artículos
 * distintos, y cualquier tolerancia ahí es una compra cargada al producto
 * equivocado.
 */
export function normalizarCodigo(codigo: string): string {
  return codigo.trim().toLowerCase().replace(/[\s._/-]+/g, '');
}

/** Minúsculas, sin acentos, sin puntuación y con los espacios colapsados. */
export function normalizeText(input: string): string {
  return input
    .normalize('NFD')
    // Descompone y descarta los diacríticos: "jamón" y "jamon" son lo mismo.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bigrams(s: string): Map<string, number> {
  const counts = new Map<string, number>();
  const clean = s.replace(/ /g, '');
  for (let i = 0; i < clean.length - 1; i++) {
    const g = clean.slice(i, i + 2);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return counts;
}

/** Coeficiente de Dice sobre bigramas de caracteres. */
function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const ba = bigrams(a);
  const bb = bigrams(b);
  let overlap = 0;
  let totalA = 0;
  let totalB = 0;
  for (const n of ba.values()) totalA += n;
  for (const n of bb.values()) totalB += n;
  for (const [g, n] of ba) {
    const m = bb.get(g);
    if (m) overlap += Math.min(n, m);
  }
  return (2 * overlap) / (totalA + totalB);
}

/** Jaccard sobre palabras: castiga que falte o sobre una palabra entera. */
function tokenJaccard(a: string, b: string): number {
  const ta = new Set(a.split(' ').filter(Boolean));
  const tb = new Set(b.split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/**
 * Parecido entre dos descripciones, de 0 a 1. Combina bigramas (tolera errores
 * de tipeo y del OCR) con palabras completas (evita unir "jamón cocido" con
 * "jamón crudo", que comparten casi todos los bigramas).
 */
export function similarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return 1;
  return 0.6 * diceCoefficient(na, nb) + 0.4 * tokenJaccard(na, nb);
}

export function matchProduct(input: MatchInput, candidates: ProductCandidate[]): MatchResult {
  const description = normalizeText(input.description);
  if (candidates.length === 0) {
    return { productId: null, method: 'NONE', score: null, reason: 'No hay productos cargados.' };
  }

  /*
   * 1. El código de ESTE proveedor, que es el dato más confiable que hay.
   *
   * Es una identificación, no un parecido: si Errecalde ya dijo alguna vez que
   * su ART-00228 es el PLU 1211, no hay descripción que pueda contradecirlo.
   * Por eso va antes que todo lo demás y no compite con nada.
   *
   * La coincidencia se exige **exacta en los dos campos**. Un alias con código
   * pero sin proveedor no sirve acá: el mismo "4587" puede ser el cremoso en un
   * proveedor y una lata de tomate en otro, y aceptarlo por el código suelto es
   * justamente cómo se cargaría la compra al artículo equivocado.
   */
  if (input.supplierCode && input.supplierId) {
    const code = normalizarCodigo(input.supplierCode);
    for (const c of candidates) {
      const hit = c.aliases?.find(
        (a) =>
          a.supplierCode &&
          normalizarCodigo(a.supplierCode) === code &&
          a.supplierId === input.supplierId,
      );
      if (hit) return { productId: c.id, method: 'SUPPLIER_CODE', score: 1 };
    }
  }

  // 2. Alias exacto ya normalizado (aprendido de facturas anteriores).
  for (const c of candidates) {
    if (c.normalizedName === description) {
      return { productId: c.id, method: 'ALIAS', score: 1 };
    }
    const hit = c.aliases?.find(
      (a) =>
        a.normalized === description &&
        (!input.supplierId || !a.supplierId || a.supplierId === input.supplierId),
    );
    if (hit) return { productId: c.id, method: 'ALIAS', score: 1 };
  }

  // 3. Coincidencia difusa, sólo con umbral alto y sin empate.
  const scored = candidates
    .map((c) => {
      const options = [c.normalizedName, ...(c.aliases ?? []).map((a) => a.normalized)];
      const best = Math.max(...options.map((o) => similarity(description, o)));
      return { productId: c.id, score: best };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const runnerUp = scored[1];
  const suggestions = scored.filter((s) => s.score >= 0.5).slice(0, 5);

  if (best.score < FUZZY_THRESHOLD) {
    return {
      productId: null,
      method: 'NONE',
      score: best.score,
      reason: 'Ninguna descripción se parece lo suficiente a un producto del catálogo.',
      suggestions,
    };
  }

  if (runnerUp && best.score - runnerUp.score < AMBIGUITY_MARGIN) {
    return {
      productId: null,
      method: 'NONE',
      score: best.score,
      reason:
        'Hay más de un producto que se parece por igual: hace falta que lo resuelva una persona.',
      suggestions,
    };
  }

  return { productId: best.productId, method: 'FUZZY', score: best.score, suggestions };
}
