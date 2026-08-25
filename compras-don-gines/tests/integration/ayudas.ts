import { prisma } from '@/lib/db';
import { hashPassword } from '@/lib/auth/password';
import {
  ADMIN_PERMISSIONS,
  OPERADOR_PERMISSIONS,
  SUPERVISOR_PERMISSIONS,
} from '@/lib/auth/permissions';
import { normalizeText } from '@/lib/domain/matching';
import type { AuthUser } from '@/lib/auth/session';

const EPOCH = new Date(Date.UTC(2020, 0, 1));

/** Vacía todas las tablas respetando las claves foráneas. */
export async function limpiarBase() {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      audit_logs, payment_events, payment_schedules, cost_history, purchase_movements,
      sale_price_history, pricing_rules, sales_movements,
      document_items, document_tax_lines, ocr_attempts, document_files, documents,
      product_aliases, products,
      supplier_tax_rules, supplier_payment_terms, supplier_aliases, suppliers,
      sessions, users, roles, branches
    RESTART IDENTITY CASCADE;
  `);
}

/**
 * Construye el AuthUser que reciben los servicios.
 * Es la misma forma que arma la sesión real a partir de la cookie.
 */
export function comoUsuario(datos: {
  id: string;
  email: string;
  name: string;
  branchId: string | null;
  branchName?: string | null;
  roleId: string;
  roleCode: string;
  roleName: string;
  permissions: string[];
  scopeAllBranches: boolean;
}): AuthUser {
  return {
    ...datos,
    branchName: datos.branchName ?? null,
    mustChangePassword: false,
  };
}

export interface Escenario {
  admin: AuthUser;
  operadorDevoto: AuthUser;
  operadorPueyrredon: AuthUser;
  supervisor: AuthUser;
  sucursales: { devoto: string; pueyrredon: string; sanMartin: string };
  proveedorId: string;
  /**
   * Distribución Errecalde, el segundo proveedor.
   *
   * Hace falta porque las pruebas que corren sobre la foto real de Errecalde
   * llegan hasta el guardado, y un comprobante no se puede validar sin
   * proveedor. Sin él, esas pruebas fallaban por una razón que no era la que
   * estaban probando.
   */
  proveedorErrecaldeId: string;
  productos: Record<string, string>;
}

/**
 * Escenario base: los tres locales de Don Ginés, un administrador, dos
 * operadores, un supervisor y el proveedor Los Calvos con sus condiciones.
 */
export async function sembrarEscenario(): Promise<Escenario> {
  const [rolAdmin, rolOperador, rolSupervisor] = await Promise.all([
    prisma.role.create({
      data: {
        code: 'ADMIN',
        name: 'Administrador',
        permissions: ADMIN_PERMISSIONS,
        scopeAllBranches: true,
        isSystem: true,
      },
    }),
    prisma.role.create({
      data: {
        code: 'OPERADOR',
        name: 'Operador de sucursal',
        permissions: OPERADOR_PERMISSIONS,
        scopeAllBranches: false,
        isSystem: true,
      },
    }),
    prisma.role.create({
      data: {
        code: 'SUPERVISOR',
        name: 'Supervisor',
        permissions: SUPERVISOR_PERMISSIONS,
        scopeAllBranches: true,
      },
    }),
  ]);

  const [devoto, pueyrredon, sanMartin] = await Promise.all([
    prisma.branch.create({ data: { code: 'DEVOTO', name: 'Devoto' } }),
    prisma.branch.create({ data: { code: 'PUEYRREDON', name: 'Pueyrredón' } }),
    prisma.branch.create({ data: { code: 'SAN_MARTIN', name: 'San Martín' } }),
  ]);

  const hash = await hashPassword('PruebasDonGines1');

  const [admin, opDevoto, opPueyrredon, supervisor] = await Promise.all([
    prisma.user.create({
      data: { email: 'admin@test.local', name: 'Admin', passwordHash: hash, roleId: rolAdmin.id },
    }),
    prisma.user.create({
      data: {
        email: 'devoto@test.local',
        name: 'Operador Devoto',
        passwordHash: hash,
        roleId: rolOperador.id,
        branchId: devoto.id,
      },
    }),
    prisma.user.create({
      data: {
        email: 'pueyrredon@test.local',
        name: 'Operador Pueyrredón',
        passwordHash: hash,
        roleId: rolOperador.id,
        branchId: pueyrredon.id,
      },
    }),
    prisma.user.create({
      data: {
        email: 'supervisor@test.local',
        name: 'Supervisor',
        passwordHash: hash,
        roleId: rolSupervisor.id,
      },
    }),
  ]);

  const proveedor = await prisma.supplier.create({
    data: {
      tradeName: 'Los Calvos',
      legalName: 'Los Calvos S.A.',
      cuit: '30-61234567-9',
      aliases: {
        create: ['Los Calvos', 'LOS CALVOS S.A.'].map((alias) => ({
          alias,
          normalized: normalizeText(alias),
        })),
      },
      paymentTerms: {
        create: {
          termType: 'SAME_DAY',
          days: 0,
          paymentMethod: 'TRANSFERENCIA',
          validFrom: EPOCH,
        },
      },
      taxRules: {
        create: { ivaRate: '0.21', iibbRate: '0.015', otherPerceptions: [], validFrom: EPOCH },
      },
    },
  });

  const errecalde = await prisma.supplier.create({
    data: {
      tradeName: 'Distribución Errecalde',
      legalName: 'Distribución Errecalde S.A.',
      cuit: '30-71780890-4',
      aliases: {
        create: ['Distribución Errecalde', 'DISTRIBUCION ERRECALDE S.A.'].map((alias) => ({
          alias,
          normalized: normalizeText(alias),
        })),
      },
      paymentTerms: {
        create: {
          termType: 'SAME_DAY',
          days: 0,
          paymentMethod: 'TRANSFERENCIA',
          validFrom: EPOCH,
        },
      },
      // Errecalde discrimina las percepciones en el comprobante, así que acá no
      // se configura una tasa: el control las contrasta contra lo impreso.
      taxRules: {
        create: { ivaRate: '0.21', iibbRate: '0', otherPerceptions: [], validFrom: EPOCH },
      },
    },
  });

  const definiciones = [
    ['1001', 'Longaniza corta', 'LONGANIZA CORTA'],
    ['1002', 'Salame Crespón', 'SALAME CRESPON'],
    ['1003', 'Salame Milán', 'SALAME MILAN'],
    ['1004', 'Bondiola al papel', 'BONDIOLA AL PAPEL'],
    ['1005', 'Jamón crudo Parma', 'JAMON CRUDO PARMA'],
    ['1006', 'Jamón cocido', 'JAMON COCIDO'],
    ['1007', 'Jamón cocido Mont-Blanc', 'JAMON COCIDO MONT-BLANC'],
    ['1008', 'Fiambre de pechuga de pollo ahumado y horneado', 'FIAMBRE DE PECHUGA DE POLLO AHUMADO Y HORNEADO'],
    ['1009', 'Fiambre cocido de pata Zur-Linde', 'FIAMBRE COCIDO DE PATA ZUR-LINDE'],
    /*
     * Los dos quesos de la factura de Errecalde.
     *
     * Están en el catálogo con el nombre que usa el negocio y con el alias que
     * imprime el proveedor, que es como se los reconoce. Sin ellos la prueba de
     * regresión del reporte por producto no tendría contra qué asociar y pasaría
     * por la razón equivocada.
     */
    ['2001', 'Queso Sardo bloque Melincué', 'SARDO BLOQUE MELINCUE'],
    ['2002', 'Queso Sardo Don Alfonso', 'SARDO DON ALFONSO'],
    /*
     * El caso de la vinculación código de proveedor ↔ PLU interno.
     *
     * En Don Ginés es el PLU 1211; Errecalde lo factura como ART-00228. Se
     * siembra **sin** el código a propósito: el punto de las pruebas es que la
     * aplicación lo aprenda al confirmar la primera factura y lo use sola en la
     * segunda.
     */
    ['1211', 'Cremoso Punta del Agua', 'CREMOSO PUNTA DEL AGUA'],
  ];

  const productos: Record<string, string> = {};
  for (const [codigo, nombre, alias] of definiciones) {
    // Los códigos 2xxx son los quesos de Errecalde; el resto, de Los Calvos. El
    // alias tiene que colgar del proveedor que lo imprime: un alias de otro
    // proveedor no reconoce nada.
    const deQuien = codigo.startsWith('2') || codigo === '1211' ? errecalde.id : proveedor.id;
    const producto = await prisma.product.create({
      data: {
        internalCode: codigo,
        normalizedName: nombre,
        category: 'Fiambres',
        purchaseUnit: 'KG',
        saleMode: 'FETEABLE',
        avgPieceWeightKg: '3.000',
        defaultSupplierId: deQuien,
        targetMarginPct: '0.45',
        marginBasis: 'SOBRE_COSTO',
        cashDiscountPct: '0.10',
        roundingRule: 'NEAREST_100',
        aliases: {
          create: {
            supplierId: deQuien,
            // El cremoso arranca sin código: la aplicación lo tiene que aprender.
            supplierCode: codigo === '1211' ? null : codigo,
            alias,
            normalized: normalizeText(alias),
            origin: 'MANUAL',
          },
        },
      },
    });
    productos[codigo] = producto.id;
  }

  const usuario = (
    u: { id: string; email: string; name: string; branchId: string | null; roleId: string },
    rol: { code: string; name: string; permissions: string[]; scopeAllBranches: boolean },
  ) =>
    comoUsuario({
      id: u.id,
      email: u.email,
      name: u.name,
      branchId: u.branchId,
      roleId: u.roleId,
      roleCode: rol.code,
      roleName: rol.name,
      permissions: rol.permissions,
      scopeAllBranches: rol.scopeAllBranches,
    });

  return {
    admin: usuario(admin, rolAdmin),
    operadorDevoto: usuario(opDevoto, rolOperador),
    operadorPueyrredon: usuario(opPueyrredon, rolOperador),
    supervisor: usuario(supervisor, rolSupervisor),
    sucursales: { devoto: devoto.id, pueyrredon: pueyrredon.id, sanMartin: sanMartin.id },
    proveedorId: proveedor.id,
    proveedorErrecaldeId: errecalde.id,
    productos,
  };
}
