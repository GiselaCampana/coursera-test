import 'server-only';
import { prisma } from '@/lib/db';
import { ForbiddenError, ValidationError } from '@/lib/errors';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { hasPermission, type AuthUser } from '@/lib/auth/session';
import { normalizeText, similarity } from '@/lib/domain/matching';
import type { TermType } from '@/lib/domain/payments';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/services/audit';

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
      /*
       * La más reciente que ya estaba vigente, y ante empate la última cargada.
       *
       * El desempate por `createdAt` no es decorativo: sin él, dos condiciones
       * que empiezan el mismo día dejan la elección librada al orden en que la
       * base devuelva las filas, y el proveedor tendría un plazo distinto según
       * el día. Guardar una condición ya reemplaza a la del mismo día, así que
       * esto cubre lo que haya quedado cargado antes de esa regla.
       */
      orderBy: [{ validFrom: 'desc' }, { createdAt: 'desc' }],
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
 * Los once dígitos del CUIT, o null si lo que se leyó no llega a serlo.
 *
 * Todo lo que compara CUITs pasa por acá. El mismo número aparece escrito de
 * tres formas distintas —con guiones, sin guiones, con espacios— según venga de
 * la ficha del proveedor, del OCR o de lo que alguien tipeó, y compararlos como
 * texto haría que un proveedor no se reconozca a sí mismo.
 */
export function cuitDigits(valor: string | null | undefined): string | null {
  const digits = (valor ?? '').replace(/\D/g, '');
  return digits.length === 11 ? digits : null;
}

/** "30678043067" → "30-67804306-7", que es como se lee en el papel. */
export function formatCuit(valor: string | null | undefined): string | null {
  const digits = cuitDigits(valor);
  if (!digits) return null;
  return `${digits.slice(0, 2)}-${digits.slice(2, 10)}-${digits.slice(10)}`;
}

/**
 * El proveedor que tiene ese CUIT, activo o no.
 *
 * Los dados de baja cuentan igual: un proveedor inactivo con el mismo CUIT
 * sigue siendo el mismo contribuyente, y crear otro al lado dejaría la cuenta
 * corriente partida en dos fichas que la AFIP considera una sola.
 */
async function buscarPorCuit(digits: string) {
  const suppliers = await prisma.supplier.findMany({
    where: { cuit: { not: null } },
    select: { id: true, cuit: true, tradeName: true, active: true },
  });
  return suppliers.find((s) => cuitDigits(s.cuit) === digits) ?? null;
}

/**
 * Alta de un proveedor desde la revisión de una factura suya.
 *
 * Existe para no obligar a abandonar el comprobante: la foto ya está sacada, el
 * OCR ya corrió y los renglones ya se asociaron a mano. Mandar a la persona a
 * Configuración → Proveedores en ese punto significa perder todo eso.
 *
 * **Nunca crea un proveedor con un CUIT que ya está cargado.** Si el CUIT
 * coincide devuelve el que existe, y quien llame se limita a asignarlo: es la
 * única forma de que dos personas cargando facturas del mismo proveedor nuevo
 * al mismo tiempo no terminen con dos fichas, dos cuentas corrientes y dos
 * historiales de costos del mismo negocio.
 *
 * Guarda el nombre leído como alias aunque el proveedor ya existiera, así la
 * próxima factura lo reconoce sola.
 */
export async function crearProveedorDesdeLectura(
  user: AuthUser,
  datos: { nombre: string; razonSocial?: string | null; cuit?: string | null },
): Promise<{ id: string; nombre: string; creado: boolean; motivo: 'CUIT' | 'NOMBRE' | null }> {
  if (!hasPermission(user, PERMISSIONS.PROVEEDORES_GESTIONAR)) {
    throw new ForbiddenError('Tu usuario no tiene permiso para dar de alta proveedores.');
  }

  const nombre = (datos.nombre ?? '').trim();
  if (nombre === '') throw new ValidationError('El proveedor necesita un nombre comercial.');

  const razonSocial = (datos.razonSocial ?? '').trim() || null;
  const crudo = (datos.cuit ?? '').trim();
  const digits = cuitDigits(crudo);
  if (crudo !== '' && !digits) {
    throw new ValidationError('El CUIT tiene que tener once dígitos.');
  }
  const cuit = formatCuit(digits);

  const existentePorCuit = digits ? await buscarPorCuit(digits) : null;
  if (existentePorCuit) {
    await aprenderAlias(existentePorCuit.id, [nombre, razonSocial]);
    return {
      id: existentePorCuit.id,
      nombre: existentePorCuit.tradeName,
      creado: false,
      motivo: 'CUIT',
    };
  }

  /*
   * Sin CUIT que compare, el nombre exacto es el único reparo que queda.
   *
   * Se reutiliza sólo si el proveedor que ya está cargado **no tiene CUIT**: dos
   * fichas con el mismo nombre y CUITs distintos son dos contribuyentes
   * distintos —pasa con las razones sociales de familia—, y fusionarlas sería
   * peor que tener dos. Cuando la que está no tiene CUIT y la lectura sí, se le
   * completa: es el dato que faltaba, no un cambio de proveedor.
   */
  const porNombre = await buscarPorNombreExacto([nombre, razonSocial]);
  if (porNombre && !porNombre.cuit) {
    if (cuit) await prisma.supplier.update({ where: { id: porNombre.id }, data: { cuit } });
    await aprenderAlias(porNombre.id, [nombre, razonSocial]);
    return { id: porNombre.id, nombre: porNombre.tradeName, creado: false, motivo: 'NOMBRE' };
  }

  const supplier = await prisma.supplier.create({
    data: { tradeName: nombre, legalName: razonSocial, cuit, currency: 'ARS', active: true },
  });
  await aprenderAlias(supplier.id, [nombre, razonSocial]);

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.SUPPLIER_CREATED_FROM_READING,
    entity: 'Supplier',
    entityId: supplier.id,
    after: { nombre, razonSocial, cuit },
  });

  return { id: supplier.id, nombre: supplier.tradeName, creado: true, motivo: null };
}

/** Guarda los nombres leídos como alias del proveedor, sin repetirlos. */
async function aprenderAlias(supplierId: string, nombres: (string | null)[]) {
  for (const nombre of nombres) {
    const alias = (nombre ?? '').trim();
    const normalized = normalizeText(alias);
    if (alias === '' || normalized === '') continue;
    await prisma.supplierAlias.upsert({
      where: { supplierId_normalized: { supplierId, normalized } },
      update: {},
      create: { supplierId, alias, normalized },
    });
  }
}

/** Proveedor cuyo nombre, razón social o alias coincide exactamente. */
async function buscarPorNombreExacto(nombres: (string | null)[]) {
  const buscados = nombres
    .map((n) => normalizeText((n ?? '').trim()))
    .filter((n) => n !== '');
  if (buscados.length === 0) return null;

  const suppliers = await prisma.supplier.findMany({
    select: {
      id: true,
      tradeName: true,
      legalName: true,
      cuit: true,
      aliases: { select: { normalized: true } },
    },
  });
  return (
    suppliers.find((s) => {
      const propios = [
        normalizeText(s.tradeName),
        s.legalName ? normalizeText(s.legalName) : '',
        ...s.aliases.map((a) => a.normalized),
      ].filter(Boolean);
      return propios.some((p) => buscados.includes(p));
    }) ?? null
  );
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
  const digits = cuitDigits(reading.cuit);
  if (digits) {
    const hit = await buscarPorCuit(digits);
    if (hit) return { supplierId: hit.id, score: 1, method: 'CUIT' };
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
