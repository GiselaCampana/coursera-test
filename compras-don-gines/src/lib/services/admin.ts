import 'server-only';
import { prisma } from '@/lib/db';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  isValidPermission,
  type Permission,
} from '@/lib/auth/permissions';
import { hasPermission, type AuthUser } from '@/lib/auth/session';
import { checkPasswordStrength } from '@/lib/auth/password';
import { cambiarCredenciales, crearCredenciales } from '@/lib/auth/proveedor';
import { normalizeText } from '@/lib/domain/matching';
import { toDecimal } from '@/lib/money';
import { arToday, parseArDate } from '@/lib/datetime';
import { ROUNDING_RULES, type RoundingRule } from '@/lib/domain/pricing';
import type { TermType } from '@/lib/domain/payments';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/services/audit';

function assert(user: AuthUser, permission: Permission) {
  if (!hasPermission(user, permission)) {
    throw new ForbiddenError('Tu usuario no tiene permiso para hacer esto.');
  }
}

const texto = (v: FormDataEntryValue | null): string => String(v ?? '').trim();
const numero = (v: FormDataEntryValue | null): number => Number(String(v ?? '0'));

// ---------------------------------------------------------------------------
// Sucursales
// ---------------------------------------------------------------------------

export async function saveBranch(user: AuthUser, form: FormData) {
  assert(user, PERMISSIONS.SUCURSALES_GESTIONAR);

  const id = texto(form.get('id'));
  const code = texto(form.get('code')).toUpperCase().replace(/\s+/g, '_');
  const name = texto(form.get('name'));
  if (!code || !name) throw new ValidationError('La sucursal necesita un código y un nombre.');

  const data = {
    code,
    name,
    address: texto(form.get('address')) || null,
    phone: texto(form.get('phone')) || null,
    active: form.get('active') === 'on',
  };

  const duplicado = await prisma.branch.findFirst({
    where: { code, ...(id ? { id: { not: id } } : {}) },
  });
  if (duplicado) throw new ConflictError(`Ya existe una sucursal con el código ${code}.`);

  const branch = id
    ? await prisma.branch.update({ where: { id }, data })
    : await prisma.branch.create({ data });

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.BRANCH_UPDATED,
    entity: 'Branch',
    entityId: branch.id,
    after: data,
  });
  return branch;
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export async function saveRole(user: AuthUser, form: FormData) {
  assert(user, PERMISSIONS.ROLES_GESTIONAR);

  const id = texto(form.get('id'));
  const code = texto(form.get('code')).toUpperCase().replace(/\s+/g, '_');
  const name = texto(form.get('name'));
  if (!code || !name) throw new ValidationError('El rol necesita un código y un nombre.');

  const permissions = form
    .getAll('permissions')
    .map((p) => String(p))
    .filter(isValidPermission);

  if (permissions.length === 0) {
    throw new ValidationError('Elegí al menos un permiso para el rol.');
  }

  const previo = id ? await prisma.role.findUnique({ where: { id } }) : null;

  // No se puede dejar el sistema sin nadie que administre usuarios y roles.
  if (previo?.code === 'ADMIN') {
    const conservaLlaves =
      permissions.includes(PERMISSIONS.USUARIOS_GESTIONAR) &&
      permissions.includes(PERMISSIONS.ROLES_GESTIONAR);
    if (!conservaLlaves) {
      throw new ValidationError(
        'El rol Administrador tiene que conservar los permisos de administrar usuarios y roles: si no, nadie podría volver a entrar a la configuración.',
      );
    }
  }

  const data = {
    code,
    name,
    description: texto(form.get('description')) || null,
    permissions,
    scopeAllBranches: form.get('scopeAllBranches') === 'on',
    active: form.get('active') === 'on',
  };

  const duplicado = await prisma.role.findFirst({
    where: { code, ...(id ? { id: { not: id } } : {}) },
  });
  if (duplicado) throw new ConflictError(`Ya existe un rol con el código ${code}.`);

  const role = id
    ? await prisma.role.update({ where: { id }, data })
    : await prisma.role.create({ data: { ...data, isSystem: false } });

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.ROLE_UPDATED,
    entity: 'Role',
    entityId: role.id,
    before: previo ? { permisos: previo.permissions, activo: previo.active } : undefined,
    after: { permisos: permissions, activo: data.active },
  });
  return role;
}

export function allPermissions() {
  return ALL_PERMISSIONS;
}

// ---------------------------------------------------------------------------
// Usuarios
// ---------------------------------------------------------------------------

export async function saveUser(user: AuthUser, form: FormData) {
  assert(user, PERMISSIONS.USUARIOS_GESTIONAR);

  const id = texto(form.get('id'));
  const email = texto(form.get('email')).toLowerCase();
  const name = texto(form.get('name'));
  const roleId = texto(form.get('roleId'));
  const branchId = texto(form.get('branchId')) || null;
  const password = String(form.get('password') ?? '');
  const active = form.get('active') === 'on';

  if (!email || !name || !roleId) {
    throw new ValidationError('El usuario necesita nombre, correo y rol.');
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new ValidationError('El correo no tiene un formato válido.');
  }

  const role = await prisma.role.findUnique({ where: { id: roleId } });
  if (!role) throw new ValidationError('Elegí un rol válido.');
  // Un rol acotado a una sucursal necesita saber cuál.
  if (!role.scopeAllBranches && !branchId) {
    throw new ValidationError(
      `El rol ${role.name} trabaja sobre una sucursal, así que hay que asignarle una.`,
    );
  }

  const duplicado = await prisma.user.findFirst({
    where: { email, ...(id ? { id: { not: id } } : {}) },
  });
  if (duplicado) throw new ConflictError('Ya hay un usuario con ese correo.');

  if (!id && password === '') {
    throw new ValidationError('Poné una contraseña inicial para el usuario nuevo.');
  }
  if (password !== '') {
    const fuerza = checkPasswordStrength(password);
    if (!fuerza.ok) throw new ValidationError(fuerza.message!);
  }

  // No dejar el sistema sin ningún administrador activo.
  if (id) {
    const previo = await prisma.user.findUnique({ where: { id }, include: { role: true } });
    if (previo && (!active || previo.roleId !== roleId)) {
      const perdiaAdmin =
        previo.role.permissions.includes(PERMISSIONS.USUARIOS_GESTIONAR) &&
        (!role.permissions.includes(PERMISSIONS.USUARIOS_GESTIONAR) || !active);
      if (perdiaAdmin) {
        const otrosAdmins = await prisma.user.count({
          where: {
            id: { not: id },
            active: true,
            role: { active: true, permissions: { has: PERMISSIONS.USUARIOS_GESTIONAR } },
          },
        });
        if (otrosAdmins === 0) {
          throw new ValidationError(
            'Es el único usuario que puede administrar usuarios: dejalo activo o creá otro administrador antes.',
          );
        }
      }
    }
  }

  /*
   * La contraseña la guarda quien corresponda según el proveedor configurado:
   * con Supabase Auth el alta se hace allá y acá sólo queda el vínculo; en modo
   * local se guarda el hash scrypt. Ver src/lib/auth/proveedor.ts.
   */
  const existente = id
    ? await prisma.user.findUnique({ where: { id }, select: { supabaseUserId: true } })
    : null;

  let credenciales: { passwordHash: string; supabaseUserId?: string | null } | null = null;
  if (password !== '') {
    credenciales = id
      ? await cambiarCredenciales(existente?.supabaseUserId ?? null, password)
      : await crearCredenciales(email, password);
  }

  const data = {
    email,
    name,
    roleId,
    branchId,
    active,
    ...(credenciales
      ? {
          passwordHash: credenciales.passwordHash,
          mustChangePassword: !id,
          ...(credenciales.supabaseUserId
            ? { supabaseUserId: credenciales.supabaseUserId }
            : {}),
        }
      : {}),
  };

  const saved = id
    ? await prisma.user.update({ where: { id }, data })
    : await prisma.user.create({
        data: { ...data, passwordHash: credenciales?.passwordHash ?? '' },
      });

  await recordAudit({
    userId: user.id,
    action: id ? AUDIT_ACTIONS.USER_UPDATED : AUDIT_ACTIONS.USER_CREATED,
    entity: 'User',
    entityId: saved.id,
    after: { email, nombre: name, rol: role.name, activo: active, cambioContrasena: password !== '' },
  });
  return saved;
}

// ---------------------------------------------------------------------------
// Proveedores
// ---------------------------------------------------------------------------

export async function saveSupplier(user: AuthUser, form: FormData) {
  assert(user, PERMISSIONS.PROVEEDORES_GESTIONAR);

  const id = texto(form.get('id'));
  const tradeName = texto(form.get('tradeName'));
  if (!tradeName) throw new ValidationError('El proveedor necesita un nombre comercial.');

  const data = {
    tradeName,
    legalName: texto(form.get('legalName')) || null,
    cuit: texto(form.get('cuit')) || null,
    currency: texto(form.get('currency')) || 'ARS',
    active: form.get('active') === 'on',
    notes: texto(form.get('notes')) || null,
  };

  const supplier = id
    ? await prisma.supplier.update({ where: { id }, data })
    : await prisma.supplier.create({ data });

  // Alias de reconocimiento, uno por línea.
  const aliasTexto = texto(form.get('aliases'));
  if (aliasTexto !== '') {
    const alias = aliasTexto
      .split('\n')
      .map((a) => a.trim())
      .filter(Boolean);
    for (const a of alias) {
      const normalized = normalizeText(a);
      if (normalized === '') continue;
      await prisma.supplierAlias.upsert({
        where: { supplierId_normalized: { supplierId: supplier.id, normalized } },
        update: { alias: a },
        create: { supplierId: supplier.id, alias: a, normalized },
      });
    }
  }

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.SUPPLIER_UPDATED,
    entity: 'Supplier',
    entityId: supplier.id,
    after: data,
  });
  return supplier;
}

/**
 * Nueva condición de pago del proveedor.
 *
 * No pisa la anterior: la cierra poniéndole fecha de fin y crea una nueva. Así
 * las facturas viejas conservan el plazo que regía cuando se cargaron.
 */
export async function saveSupplierTerm(user: AuthUser, form: FormData) {
  assert(user, PERMISSIONS.PROVEEDORES_GESTIONAR);

  const supplierId = texto(form.get('supplierId'));
  const termType = texto(form.get('termType')) as TermType;
  if (!['SAME_DAY', 'DAYS', 'MANUAL', 'NEXT_INVOICE'].includes(termType)) {
    throw new ValidationError('Elegí un tipo de plazo válido.');
  }
  const days = termType === 'DAYS' ? numero(form.get('days')) : 0;
  if (termType === 'DAYS' && (!Number.isInteger(days) || days < 0)) {
    throw new ValidationError('La cantidad de días tiene que ser un número entero.');
  }

  const validFrom = parseArDate(texto(form.get('validFrom'))) ?? arToday();

  /*
   * La fecha de la próxima factura, para "factura contra factura".
   *
   * Es lo que le falta a esa condición para poder dar una fecha de pago: no hay
   * plazo en días que la reemplace, porque el reparto no tiene periodicidad
   * fija. Se puede dejar vacía, y entonces cada factura pedirá la fecha al
   * cargarse en vez de inventar una.
   */
  const proximaFactura = parseArDate(texto(form.get('nextInvoiceDate')));

  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
  if (!supplier) throw new NotFoundError('No encontramos ese proveedor.');

  await prisma.$transaction(async (tx) => {
    await tx.supplierPaymentTerm.updateMany({
      where: { supplierId, validTo: null, validFrom: { lt: validFrom } },
      data: { validTo: new Date(validFrom.getTime() - 86_400_000) },
    });
    await tx.supplierPaymentTerm.create({
      data: {
        supplierId,
        termType,
        days,
        paymentMethod: texto(form.get('paymentMethod')) || 'TRANSFERENCIA',
        validFrom,
        notes: texto(form.get('notes')) || null,
      },
    });

    // Sólo se toca cuando el formulario la trae: no se borra una fecha buena
    // por guardar una condición sin completar ese campo.
    if (proximaFactura || termType !== 'NEXT_INVOICE') {
      await tx.supplier.update({
        where: { id: supplierId },
        data: {
          nextInvoiceDate:
            termType === 'NEXT_INVOICE' ? proximaFactura : supplier.nextInvoiceDate,
        },
      });
    }
  });

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.SUPPLIER_UPDATED,
    entity: 'SupplierPaymentTerm',
    entityId: supplierId,
    after: {
      plazo: termType,
      dias: days,
      desde: validFrom.toISOString().slice(0, 10),
      proximaFactura: proximaFactura ? proximaFactura.toISOString().slice(0, 10) : null,
    },
  });
}

/** Nueva regla impositiva del proveedor, con la misma lógica de vigencia. */
export async function saveSupplierTaxRule(user: AuthUser, form: FormData) {
  assert(user, PERMISSIONS.PROVEEDORES_GESTIONAR);

  const supplierId = texto(form.get('supplierId'));
  const ivaRate = parseTasa(texto(form.get('ivaRate')), 'IVA');
  const iibbRate = parseTasa(texto(form.get('iibbRate')) || '0', 'IIBB');
  const validFrom = parseArDate(texto(form.get('validFrom'))) ?? arToday();

  /*
   * La fecha de la próxima factura, para "factura contra factura".
   *
   * Es lo que le falta a esa condición para poder dar una fecha de pago: no hay
   * plazo en días que la reemplace, porque el reparto no tiene periodicidad
   * fija. Se puede dejar vacía, y entonces cada factura pedirá la fecha al
   * cargarse en vez de inventar una.
   */
  const proximaFactura = parseArDate(texto(form.get('nextInvoiceDate')));

  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
  if (!supplier) throw new NotFoundError('No encontramos ese proveedor.');

  await prisma.$transaction(async (tx) => {
    await tx.supplierTaxRule.updateMany({
      where: { supplierId, validTo: null, validFrom: { lt: validFrom } },
      data: { validTo: new Date(validFrom.getTime() - 86_400_000) },
    });
    await tx.supplierTaxRule.create({
      data: {
        supplierId,
        ivaRate: ivaRate.toString(),
        iibbRate: iibbRate.toString(),
        otherPerceptions: [],
        validFrom,
        notes: texto(form.get('notes')) || null,
      },
    });
  });

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.SUPPLIER_UPDATED,
    entity: 'SupplierTaxRule',
    entityId: supplierId,
    after: { iva: ivaRate.toString(), iibb: iibbRate.toString() },
  });
}

function parseTasa(valor: string, etiqueta: string) {
  const tasa = toDecimal(valor, toDecimal('-1'));
  const normalizada = tasa.gt(1) ? tasa.div(100) : tasa;
  if (normalizada.isNegative() || normalizada.gte(1)) {
    throw new ValidationError(
      `La tasa de ${etiqueta} tiene que ser un porcentaje entre 0 y 100 (por ejemplo 21 o 1,5).`,
    );
  }
  return normalizada;
}

// ---------------------------------------------------------------------------
// Productos
// ---------------------------------------------------------------------------

export async function saveProduct(user: AuthUser, form: FormData) {
  assert(user, PERMISSIONS.PRODUCTOS_GESTIONAR);

  const id = texto(form.get('id'));
  const internalCode = texto(form.get('internalCode'));
  const normalizedName = texto(form.get('normalizedName'));
  if (!internalCode || !normalizedName) {
    throw new ValidationError('El producto necesita un código interno y un nombre.');
  }

  const roundingRule = texto(form.get('roundingRule')) as RoundingRule;
  if (!ROUNDING_RULES.includes(roundingRule)) {
    throw new ValidationError('Elegí una regla de redondeo válida.');
  }

  const margen = parseTasa(texto(form.get('targetMarginPct')), 'margen');
  const descuentoEfectivo = parseTasa(
    texto(form.get('cashDiscountPct')) || '0',
    'descuento por efectivo',
  );
  const marginBasis = texto(form.get('marginBasis')) as 'SOBRE_COSTO' | 'SOBRE_VENTA';
  if (!['SOBRE_COSTO', 'SOBRE_VENTA'].includes(marginBasis)) {
    throw new ValidationError('Elegí si el margen es sobre el costo o sobre la venta.');
  }
  if (marginBasis === 'SOBRE_VENTA' && margen.gte(1)) {
    throw new ValidationError('Un margen sobre la venta del 100 % o más no da un precio posible.');
  }

  const pesoPieza = texto(form.get('avgPieceWeightKg'));

  const duplicado = await prisma.product.findFirst({
    where: { internalCode, ...(id ? { id: { not: id } } : {}) },
  });
  if (duplicado) throw new ConflictError(`Ya existe un producto con el código ${internalCode}.`);

  const data = {
    internalCode,
    normalizedName,
    category: texto(form.get('category')) || null,
    purchaseUnit: texto(form.get('purchaseUnit')) === 'UNIT' ? ('UNIT' as const) : ('KG' as const),
    saleMode: texto(form.get('saleMode')) === 'AL_CORTE' ? ('AL_CORTE' as const) : ('FETEABLE' as const),
    avgPieceWeightKg: pesoPieza ? toDecimal(pesoPieza).toString() : null,
    defaultSupplierId: texto(form.get('defaultSupplierId')) || null,
    targetMarginPct: margen.toString(),
    marginBasis,
    cashDiscountPct: descuentoEfectivo.toString(),
    roundingRule,
    active: form.get('active') === 'on',
  };

  const product = id
    ? await prisma.product.update({ where: { id }, data })
    : await prisma.product.create({ data });

  // Alias del producto, uno por línea.
  const aliasTexto = texto(form.get('aliases'));
  if (aliasTexto !== '') {
    for (const alias of aliasTexto.split('\n').map((a) => a.trim()).filter(Boolean)) {
      const normalized = normalizeText(alias);
      if (normalized === '') continue;
      const existente = await prisma.productAlias.findFirst({
        where: { productId: product.id, supplierId: data.defaultSupplierId, normalized },
      });
      if (existente) continue;
      await prisma.productAlias.create({
        data: {
          productId: product.id,
          supplierId: data.defaultSupplierId,
          alias,
          normalized,
          origin: 'MANUAL',
        },
      });
    }
  }

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.PRODUCT_UPDATED,
    entity: 'Product',
    entityId: product.id,
    after: data,
  });
  return product;
}
