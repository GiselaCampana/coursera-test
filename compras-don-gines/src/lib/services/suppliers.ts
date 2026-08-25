import 'server-only';
import { prisma } from '@/lib/db';
import { normalizeText, similarity } from '@/lib/domain/matching';
import type { TermType } from '@/lib/domain/payments';

/**
 * Condiciones vigentes de un proveedor a una fecha.
 *
 * Se busca por fecha y no "la última", porque las facturas viejas tienen que
 * conservar el plazo y las tasas que regían cuando se cargaron. Cambiar hoy el
 * plazo de un proveedor no puede mover el vencimiento de una factura de marzo.
 */
export interface SupplierConditions {
  term: { termType: TermType; days: number; paymentMethod: string } | null;
  tax: { ivaRate: string; iibbRate: string } | null;
  /** Cuándo se espera la próxima factura o visita. Sólo lo usa NEXT_INVOICE. */
  proximaFactura: Date | null;
}

export async function getSupplierConditions(
  supplierId: string,
  atDate: Date,
): Promise<SupplierConditions> {
  const [term, tax, proveedor] = await Promise.all([
    prisma.supplierPaymentTerm.findFirst({
      where: {
        supplierId,
        validFrom: { lte: atDate },
        OR: [{ validTo: null }, { validTo: { gte: atDate } }],
      },
      orderBy: { validFrom: 'desc' },
    }),
    prisma.supplierTaxRule.findFirst({
      where: {
        supplierId,
        validFrom: { lte: atDate },
        OR: [{ validTo: null }, { validTo: { gte: atDate } }],
      },
      orderBy: { validFrom: 'desc' },
    }),
    prisma.supplier.findUnique({
      where: { id: supplierId },
      select: { nextInvoiceDate: true },
    }),
  ]);

  return {
    term: term
      ? {
          termType: term.termType as TermType,
          days: term.days,
          paymentMethod: term.paymentMethod,
        }
      : null,
    tax: tax
      ? { ivaRate: tax.ivaRate.toString(), iibbRate: tax.iibbRate.toString() }
      : null,
    /*
     * Cuándo se espera la próxima factura del proveedor.
     *
     * Va acá, con el resto de las condiciones, porque es lo que le falta al
     * plazo "factura contra factura" para poder dar una fecha. No es un dato del
     * comprobante sino del vínculo con el proveedor, y por eso vive en su ficha
     * y no en la factura.
     */
    proximaFactura: proveedor?.nextInvoiceDate ?? null,
  };
}

/**
 * Reconoce al proveedor a partir del nombre impreso o del CUIT.
 *
 * El CUIT manda: es un identificador. El nombre se compara contra los alias
 * guardados y sólo se acepta con un parecido alto, porque asignarle una factura
 * al proveedor equivocado arrastra el plazo de pago y las tasas equivocadas.
 */
export async function findSupplierByReading(reading: {
  supplierName?: string | null;
  legalName?: string | null;
  cuit?: string | null;
}): Promise<{ supplierId: string | null; score: number | null; method: string }> {
  if (reading.cuit) {
    const digits = reading.cuit.replace(/\D/g, '');
    if (digits.length === 11) {
      const suppliers = await prisma.supplier.findMany({
        where: { cuit: { not: null } },
        select: { id: true, cuit: true },
      });
      const hit = suppliers.find((s) => (s.cuit ?? '').replace(/\D/g, '') === digits);
      if (hit) return { supplierId: hit.id, score: 1, method: 'CUIT' };
    }
  }

  const names = [reading.supplierName, reading.legalName].filter(
    (n): n is string => typeof n === 'string' && n.trim() !== '',
  );
  if (names.length === 0) return { supplierId: null, score: null, method: 'NONE' };

  const suppliers = await prisma.supplier.findMany({
    where: { active: true },
    select: { id: true, tradeName: true, legalName: true, aliases: { select: { normalized: true } } },
  });

  let best: { supplierId: string; score: number } | null = null;
  for (const supplier of suppliers) {
    const options = [
      normalizeText(supplier.tradeName),
      supplier.legalName ? normalizeText(supplier.legalName) : '',
      ...supplier.aliases.map((a) => a.normalized),
    ].filter(Boolean);

    for (const name of names) {
      const normalized = normalizeText(name);
      for (const option of options) {
        const score = option === normalized ? 1 : similarity(normalized, option);
        if (!best || score > best.score) best = { supplierId: supplier.id, score };
      }
    }
  }

  if (!best || best.score < 0.82) {
    return { supplierId: null, score: best?.score ?? null, method: 'NONE' };
  }
  return { supplierId: best.supplierId, score: best.score, method: best.score === 1 ? 'ALIAS' : 'FUZZY' };
}
