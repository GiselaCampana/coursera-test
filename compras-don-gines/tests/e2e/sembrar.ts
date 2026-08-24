/**
 * Datos para las pruebas end to end.
 *
 * Deja la base en un estado conocido: los tres locales, un administrador, un
 * operador de Devoto, el proveedor Los Calvos y una factura ya confirmada con
 * su pago agendado, para poder ejercitar la confirmación del pago desde la
 * interfaz.
 */
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../../src/lib/auth/password';
import { ADMIN_PERMISSIONS, OPERADOR_PERMISSIONS } from '../../src/lib/auth/permissions';
import { normalizeText } from '../../src/lib/domain/matching';
import { costItems } from '../../src/lib/domain/costing';
import { validateDocument } from '../../src/lib/domain/validation';
import { addDays, arToday } from '../../src/lib/datetime';

const EPOCH = new Date(Date.UTC(2020, 0, 1));

export const CREDENCIALES = {
  admin: { email: 'admin@e2e.local', password: 'PruebasDonGines1' },
  operador: { email: 'devoto@e2e.local', password: 'PruebasDonGines1' },
};

export async function sembrar() {
  // El cliente se construye acá adentro, no al importar el módulo: quien llama
  // necesita poder cargar antes las variables de entorno de las pruebas.
  const prisma = new PrismaClient();
  try {
    await sembrarCon(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

async function sembrarCon(prisma: PrismaClient) {
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

  const [rolAdmin, rolOperador] = await Promise.all([
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
  ]);

  const [devoto] = await Promise.all([
    prisma.branch.create({ data: { code: 'DEVOTO', name: 'Devoto' } }),
    prisma.branch.create({ data: { code: 'PUEYRREDON', name: 'Pueyrredón' } }),
    prisma.branch.create({ data: { code: 'SAN_MARTIN', name: 'San Martín' } }),
  ]);

  const hash = await hashPassword(CREDENCIALES.admin.password);
  const admin = await prisma.user.create({
    data: {
      email: CREDENCIALES.admin.email,
      name: 'Ana Administradora',
      passwordHash: hash,
      roleId: rolAdmin.id,
    },
  });
  await prisma.user.create({
    data: {
      email: CREDENCIALES.operador.email,
      name: 'Osvaldo Operador',
      passwordHash: hash,
      roleId: rolOperador.id,
      branchId: devoto.id,
    },
  });

  const proveedor = await prisma.supplier.create({
    data: {
      tradeName: 'Los Calvos',
      legalName: 'Los Calvos S.A.',
      cuit: '30-61234567-9',
      aliases: {
        create: { alias: 'Los Calvos', normalized: normalizeText('Los Calvos') },
      },
      paymentTerms: {
        create: { termType: 'SAME_DAY', days: 0, paymentMethod: 'TRANSFERENCIA', validFrom: EPOCH },
      },
      taxRules: {
        create: { ivaRate: '0.21', iibbRate: '0.015', otherPerceptions: [], validFrom: EPOCH },
      },
    },
  });

  // Distribución Errecalde, para la prueba de aceptación con la foto real. Se
  // lo da de alta con su CUIT, que es por donde lo reconoce la lectura.
  await prisma.supplier.create({
    data: {
      tradeName: 'Distribución Errecalde',
      legalName: 'Distribución Errecalde S.A.',
      cuit: '30-71780890-4',
      aliases: {
        create: {
          alias: 'Distribución Errecalde',
          normalized: normalizeText('Distribución Errecalde'),
        },
      },
      paymentTerms: {
        create: { termType: 'DAYS', days: 30, paymentMethod: 'TRANSFERENCIA', validFrom: EPOCH },
      },
      taxRules: {
        // Las percepciones de este proveedor son montos por comprobante, no una
        // alícuota: se toman de lo impreso.
        create: { ivaRate: '0.21', iibbRate: '0', otherPerceptions: [], validFrom: EPOCH },
      },
    },
  });

  const producto = await prisma.product.create({
    data: {
      internalCode: '1001',
      normalizedName: 'Longaniza corta',
      category: 'Embutidos',
      purchaseUnit: 'KG',
      saleMode: 'FETEABLE',
      avgPieceWeightKg: '0.350',
      defaultSupplierId: proveedor.id,
      targetMarginPct: '0.45',
      marginBasis: 'SOBRE_COSTO',
      cashDiscountPct: '0.10',
      roundingRule: 'NEAREST_100',
    },
  });

  /**
   * Crea un comprobante confirmado con su informe de control, su movimiento de
   * compra y su pago agendado. El informe se calcula con las mismas funciones
   * que usa la aplicación, así que el semáforo de la pantalla es el real.
   */
  async function crearComprobante(opciones: {
    numero: string;
    fecha: Date;
    kilos: string;
    precio: string;
  }) {
    const bruto = Number(opciones.kilos) * Number(opciones.precio);
    const printed = {
      grossSubtotal: bruto.toFixed(2),
      discountTotal: (bruto * 0.14).toFixed(2),
      netTotal: (bruto - Number((bruto * 0.14).toFixed(2))).toFixed(2),
      ivaTotal: ((bruto - Number((bruto * 0.14).toFixed(2))) * 0.21).toFixed(2),
      perceptionsTotal: ((bruto - Number((bruto * 0.14).toFixed(2))) * 0.015).toFixed(2),
      total: '0',
      lineCount: 1,
      netWeightKg: opciones.kilos,
    };
    printed.total = (
      Number(printed.netTotal) +
      Number(printed.ivaTotal) +
      Number(printed.perceptionsTotal)
    ).toFixed(2);

    const items = costItems(
      [
        {
          lineNumber: 1,
          supplierCode: '1001',
          description: 'LONGANIZA CORTA',
          quantity: opciones.kilos,
          unit: 'KG',
          unitNetPrice: opciones.precio,
          // El importe del renglón va impreso en el comprobante, como en
          // cualquier factura: es contra ese número que el control verifica la
          // cantidad. Sin él, el renglón no queda controlado y el semáforo no
          // puede ponerse en verde.
          grossSubtotal: bruto.toFixed(2),
          discountPct: '0.14',
          ivaRate: '0.21',
        },
      ],
      {
        netTotal: printed.netTotal,
        ivaTotal: printed.ivaTotal,
        perceptionsTotal: printed.perceptionsTotal,
      },
    );

    const informe = validateDocument({
      items,
      printed,
      supplierRules: { ivaRate: '0.21', iibbRate: '0.015' },
      attempts: 1,
    });

    const item = items[0];
    const documento = await prisma.document.create({
      data: {
        branchId: devoto.id,
        supplierId: proveedor.id,
        docType: 'FACTURA',
        letter: 'A',
        pointOfSale: '0010',
        number: opciones.numero,
        fullNumber: `0010-${opciones.numero}`,
        issueDate: opciones.fecha,
        grossSubtotal: printed.grossSubtotal,
        discountTotal: printed.discountTotal,
        netTotal: printed.netTotal,
        ivaTotal: printed.ivaTotal,
        perceptionsTotal: printed.perceptionsTotal,
        total: printed.total,
        printedLineCount: 1,
        printedNetWeightKg: opciones.kilos,
        status: 'VALIDADO',
        checkState: informe.state,
        checkReport: informe as unknown as object,
        dedupeKey: 'ACTIVE',
        appliedTermType: 'SAME_DAY',
        appliedTermDays: 0,
        appliedPaymentMethod: 'TRANSFERENCIA',
        appliedIvaRate: '0.21',
        appliedIibbRate: '0.015',
        appliedDueDate: opciones.fecha,
        createdById: admin.id,
        validatedById: admin.id,
        validatedAt: new Date(),
        items: {
          create: {
            lineNumber: 1,
            supplierCode: '1001',
            description: 'LONGANIZA CORTA',
            quantity: item.quantity.toString(),
            unit: 'KG',
            unitNetPrice: item.unitNetPrice.toString(),
            grossSubtotal: item.grossSubtotal.toString(),
            discountPct: item.discountPct.toString(),
            discountAmount: item.discountAmount.toString(),
            netAmount: item.netAmount.toString(),
            ivaRate: '0.21',
            ivaAmount: item.ivaAmount.toString(),
            perceptionAmount: item.perceptionAmount.toString(),
            totalCost: item.totalCost.toString(),
            unitCost: item.unitCost.toString(),
            productId: producto.id,
            matchMethod: 'ALIAS',
          },
        },
        taxLines: {
          create: [
            {
              kind: 'IVA',
              label: 'IVA 21 %',
              rate: '0.21',
              base: printed.netTotal,
              amount: printed.ivaTotal,
            },
            {
              kind: 'PERCEPCION',
              label: 'Percepción IIBB 1,5 %',
              rate: '0.015',
              base: printed.netTotal,
              amount: printed.perceptionsTotal,
            },
          ],
        },
        paymentSchedule: {
          create: {
            dueDate: opciones.fecha,
            plannedAmount: printed.total,
            plannedPaymentMethod: 'TRANSFERENCIA',
            paidAmount: '0',
            // El estado real lo recalcula la aplicación al consultar la agenda.
            status: 'AGENDADO',
          },
        },
      },
      include: { items: true },
    });

    await prisma.purchaseMovement.create({
      data: {
        documentId: documento.id,
        documentItemId: documento.items[0].id,
        productId: producto.id,
        supplierId: proveedor.id,
        branchId: devoto.id,
        date: opciones.fecha,
        description: 'LONGANIZA CORTA',
        quantity: item.quantity.toString(),
        unit: 'KG',
        unitNetPrice: item.unitNetPrice.toString(),
        discountAmount: item.discountAmount.toString(),
        netAmount: item.netAmount.toString(),
        ivaAmount: item.ivaAmount.toString(),
        perceptionAmount: item.perceptionAmount.toString(),
        totalCost: item.totalCost.toString(),
        unitCost: item.unitCost.toString(),
      },
    });

    await prisma.costHistory.create({
      data: {
        productId: producto.id,
        supplierId: proveedor.id,
        branchId: devoto.id,
        documentId: documento.id,
        date: opciones.fecha,
        unitNetPrice: item.unitNetPrice.toString(),
        unitCost: item.unitCost.toString(),
      },
    });

    return documento;
  }

  // Una factura vencida, para confirmarle el pago desde la pantalla de Pagos…
  await crearComprobante({
    numero: '00212356',
    fecha: new Date(Date.UTC(2026, 7, 14)),
    kilos: '16.10',
    precio: '16037',
  });

  // …y otra agendada para dentro de unos días, para que las pruebas que sólo
  // miran la agenda no dependan de si otra prueba ya confirmó la primera.
  await crearComprobante({
    numero: '00212400',
    fecha: addDays(arToday(), 4),
    kilos: '8.50',
    precio: '16037',
  });

  console.log('Datos de prueba listos.');
}

// Al invocarlo como script (npm run e2e:seed) se ejecuta directamente.
if (process.argv[1] && process.argv[1].includes('sembrar')) {
  sembrar().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
