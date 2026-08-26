/**
 * Datos iniciales de Compras Don Ginés.
 *
 * Es idempotente: se puede correr sobre una base vacía o sobre una que ya tiene
 * datos, y no pisa lo que el usuario haya editado desde la aplicación.
 *
 * Las contraseñas se toman de SEED_ADMIN_PASSWORD / SEED_OPERATOR_PASSWORD; si
 * no están definidas se generan al azar y se imprimen una sola vez.
 *
 * En los dos casos el usuario queda con `mustChangePassword`. Una contraseña
 * escrita en una variable de entorno del panel de despliegue la ve cualquiera
 * que entre a ese panel, y una impresa en el log del build queda escrita ahí:
 * ninguna de las dos es la contraseña personal de nadie, sino la llave para
 * entrar una vez y elegir la propia.
 */
import { randomBytes } from 'node:crypto';
import { PrismaClient, type PurchaseUnit, type SaleMode } from '@prisma/client';
import { checkPasswordStrength, hashPassword } from '../src/lib/auth/password';
import {
  ADMIN_PERMISSIONS,
  OPERADOR_PERMISSIONS,
  SUPERVISOR_PERMISSIONS,
} from '../src/lib/auth/permissions';
import { normalizeText } from '../src/lib/domain/matching';

const prisma = new PrismaClient();

const EPOCH = new Date(Date.UTC(2020, 0, 1));

function randomPassword(): string {
  return `${randomBytes(9).toString('base64url')}9a`;
}

async function main() {
  console.log('Sembrando datos iniciales de Compras Don Ginés…\n');

  // --- Roles --------------------------------------------------------------
  const [adminRole, operatorRole] = await Promise.all([
    prisma.role.upsert({
      where: { code: 'ADMIN' },
      update: {},
      create: {
        code: 'ADMIN',
        name: 'Administrador',
        description: 'Acceso total: todas las sucursales, configuración, pagos y auditoría.',
        permissions: ADMIN_PERMISSIONS,
        scopeAllBranches: true,
        isSystem: true,
      },
    }),
    prisma.role.upsert({
      where: { code: 'OPERADOR' },
      update: {},
      create: {
        code: 'OPERADOR',
        name: 'Operador de sucursal',
        description:
          'Carga y revisa comprobantes de su sucursal. No confirma pagos ni toca la configuración.',
        permissions: OPERADOR_PERMISSIONS,
        scopeAllBranches: false,
        isSystem: true,
      },
    }),
    // Rol de ejemplo para mostrar que se pueden sumar roles sin tocar código.
    prisma.role.upsert({
      where: { code: 'SUPERVISOR' },
      update: {},
      create: {
        code: 'SUPERVISOR',
        name: 'Supervisor',
        description: 'Consulta todas las sucursales, sin poder modificar nada.',
        permissions: SUPERVISOR_PERMISSIONS,
        scopeAllBranches: true,
        isSystem: false,
      },
    }),
  ]);

  // --- Sucursales ---------------------------------------------------------
  const branchData = [
    { code: 'DEVOTO', name: 'Devoto' },
    { code: 'PUEYRREDON', name: 'Pueyrredón' },
    { code: 'SAN_MARTIN', name: 'San Martín' },
  ];
  const branches = [];
  for (const b of branchData) {
    branches.push(
      await prisma.branch.upsert({
        where: { code: b.code },
        update: {},
        create: b,
      }),
    );
  }

  // --- Usuarios -----------------------------------------------------------
  // En minúsculas, como en el ingreso y en el alta desde la aplicación. Sin
  // esto, un SEED_ADMIN_EMAIL escrito con mayúsculas crea un usuario que
  // después nadie encuentra: el ingreso busca por el correo ya normalizado y no
  // hay forma de escribirlo "bien" desde el formulario.
  const adminEmail = (process.env.SEED_ADMIN_EMAIL || 'admin@dongines.local').trim().toLowerCase();
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || randomPassword();
  const operatorPassword = process.env.SEED_OPERATOR_PASSWORD || randomPassword();
  const adminDeVariable = Boolean(process.env.SEED_ADMIN_PASSWORD);
  const operadorDeVariable = Boolean(process.env.SEED_OPERATOR_PASSWORD);

  // Una contraseña que la aplicación después no aceptaría al cambiarla tampoco
  // sirve para entrar la primera vez. Mejor que el seed falle acá, con el
  // motivo escrito, que descubrirlo en el primer intento de ingreso.
  for (const [variable, valor] of [
    ['SEED_ADMIN_PASSWORD', adminDeVariable ? adminPassword : null],
    ['SEED_OPERATOR_PASSWORD', operadorDeVariable ? operatorPassword : null],
  ] as const) {
    if (valor === null) continue;
    const problema = checkPasswordStrength(valor);
    if (!problema.ok) {
      throw new Error(`${variable}: ${problema.message}`);
    }
  }
  const createdCredentials: {
    email: string;
    password: string;
    role: string;
    deVariable: boolean;
  }[] = [];

  const existingAdmin = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!existingAdmin) {
    await prisma.user.create({
      data: {
        email: adminEmail,
        name: 'Administrador',
        passwordHash: await hashPassword(adminPassword),
        roleId: adminRole.id,
        // El administrador ve todas las sucursales: no se le asigna ninguna.
        branchId: null,
        // Siempre, incluso con la contraseña puesta a mano en una variable:
        // esa contraseña la vio quien cargó la variable y la guarda el panel.
        mustChangePassword: true,
      },
    });
    createdCredentials.push({
      email: adminEmail,
      password: adminPassword,
      role: 'Administrador',
      deVariable: adminDeVariable,
    });
  }

  for (const branch of branches) {
    const email = `${branch.code.toLowerCase().replace(/_/g, '')}@dongines.local`;
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) continue;
    await prisma.user.create({
      data: {
        email,
        name: `Operador ${branch.name}`,
        passwordHash: await hashPassword(operatorPassword),
        roleId: operatorRole.id,
        branchId: branch.id,
        mustChangePassword: true,
      },
    });
    createdCredentials.push({
      email,
      password: operatorPassword,
      role: `Operador ${branch.name}`,
      deVariable: operadorDeVariable,
    });
  }

  // --- Proveedor Los Calvos ----------------------------------------------
  let losCalvos = await prisma.supplier.findFirst({ where: { tradeName: 'Los Calvos' } });
  if (!losCalvos) {
    losCalvos = await prisma.supplier.create({
      data: {
        tradeName: 'Los Calvos',
        legalName: 'Los Calvos S.A.',
        cuit: '30-61234567-9',
        currency: 'ARS',
        active: true,
        notes: 'Fiambres y embutidos. Se le paga el mismo día de la factura.',
        aliases: {
          create: ['Los Calvos', 'LOS CALVOS S.A.', 'LOSCALVOS'].map((alias) => ({
            alias,
            normalized: normalizeText(alias),
          })),
        },
        paymentTerms: {
          create: {
            // Plazo "en el día": la fecha prevista de pago es la de la factura.
            // El comprobante queda agendado y venciendo hoy, nunca pagado solo.
            termType: 'SAME_DAY',
            days: 0,
            paymentMethod: 'TRANSFERENCIA',
            validFrom: EPOCH,
            notes: 'Condición vigente desde el alta del proveedor.',
          },
        },
        taxRules: {
          create: {
            ivaRate: '0.21',
            iibbRate: '0.015',
            otherPerceptions: [],
            validFrom: EPOCH,
            notes: 'IVA 21 % y percepción de IIBB 1,5 %.',
          },
        },
      },
    });
  }

  // --- Proveedor Distribución Errecalde -----------------------------------
  // Se lo da de alta con su CUIT para que la lectura lo reconozca sola: el
  // analizador saca el CUIT del encabezado y el proveedor se ubica por ahí,
  // que es más confiable que por el nombre.
  let errecalde = await prisma.supplier.findFirst({
    where: { tradeName: 'Distribución Errecalde' },
  });
  if (!errecalde) {
    errecalde = await prisma.supplier.create({
      data: {
        tradeName: 'Distribución Errecalde',
        legalName: 'Distribución Errecalde S.A.',
        cuit: '30-71780890-4',
        currency: 'ARS',
        active: true,
        notes: 'Quesos, fiambres y conservas. Factura-remito A, con percepciones.',
        aliases: {
          create: [
            'Distribución Errecalde',
            'DISTRIBUCION ERRECALDE S. A.',
            'ERRECALDE',
          ].map((alias) => ({ alias, normalized: normalizeText(alias) })),
        },
        paymentTerms: {
          create: {
            termType: 'DAYS',
            days: 30,
            paymentMethod: 'TRANSFERENCIA',
            validFrom: EPOCH,
            notes: 'Cuenta corriente. Revisar el plazo real con el proveedor.',
          },
        },
        taxRules: {
          create: {
            ivaRate: '0.21',
            // Las percepciones de esta factura son montos fijos por comprobante,
            // no una alícuota sobre el neto: la de IVA sale de la RG 5329 y la
            // de IIBB del padrón de Buenos Aires. Se dejan en cero para que el
            // control use las que vienen impresas y no una tasa inventada.
            iibbRate: '0',
            otherPerceptions: [],
            validFrom: EPOCH,
            notes:
              'IVA 21 %. Las percepciones (IVA RG 5329 e IIBB Buenos Aires) se toman de lo ' +
              'impreso en cada comprobante.',
          },
        },
      },
    });
  }

  /*
   * --- Catálogo de productos -----------------------------------------------
   *
   * El catálogo de Don Ginés **no** se siembra. Los PLU son de Control de
   * Stock, que es la fuente, y entran por Configuración → Catálogo Don Ginés.
   *
   * Los artículos de acá abajo son de demostración y tienen números inventados.
   * Sembrarlos en una base real significa ocupar PLU que en Control de Stock
   * pertenecen a otro artículo: cuando después se importa el catálogo de
   * verdad, ese PLU ya está tomado y lo que entra por el importador se lee como
   * un cambio de nombre de un artículo que quizá ya tiene compras cargadas.
   *
   * Por eso hay que pedirlos explícitamente con SEED_CATALOGO_DEMO=1. Sin esa
   * variable la aplicación arranca con el catálogo vacío, que es lo correcto:
   * está esperando el de Stock.
   */
  const sembrarCatalogoDemo = process.env.SEED_CATALOGO_DEMO === '1';

  const products: {
    internalCode: string;
    name: string;
    category: string;
    saleMode: SaleMode;
    unit: PurchaseUnit;
    pieceKg: string;
    margin: string;
    supplierCode?: string;
    aliases: string[];
  }[] = [
    { internalCode: '1001', name: 'Longaniza corta', category: 'Embutidos', saleMode: 'FETEABLE', unit: 'KG', pieceKg: '0.350', margin: '0.45', supplierCode: '1001', aliases: ['LONGANIZA CORTA'] },
    { internalCode: '1002', name: 'Salame Crespón', category: 'Embutidos', saleMode: 'FETEABLE', unit: 'KG', pieceKg: '1.200', margin: '0.45', supplierCode: '1002', aliases: ['SALAME CRESPON', 'SALAME CRESPÓN'] },
    { internalCode: '1003', name: 'Salame Milán', category: 'Embutidos', saleMode: 'FETEABLE', unit: 'KG', pieceKg: '1.000', margin: '0.45', supplierCode: '1003', aliases: ['SALAME MILAN', 'SALAME MILÁN'] },
    { internalCode: '1004', name: 'Bondiola al papel', category: 'Fiambres', saleMode: 'FETEABLE', unit: 'KG', pieceKg: '2.500', margin: '0.45', supplierCode: '1004', aliases: ['BONDIOLA AL PAPEL'] },
    { internalCode: '1005', name: 'Jamón crudo Parma', category: 'Fiambres', saleMode: 'FETEABLE', unit: 'KG', pieceKg: '6.000', margin: '0.50', supplierCode: '1005', aliases: ['JAMON CRUDO PARMA', 'JAMÓN CRUDO PARMA'] },
    { internalCode: '1006', name: 'Jamón cocido', category: 'Fiambres', saleMode: 'FETEABLE', unit: 'KG', pieceKg: '4.000', margin: '0.42', supplierCode: '1006', aliases: ['JAMON COCIDO', 'JAMÓN COCIDO'] },
    { internalCode: '1007', name: 'Jamón cocido Mont-Blanc', category: 'Fiambres', saleMode: 'FETEABLE', unit: 'KG', pieceKg: '4.000', margin: '0.42', supplierCode: '1007', aliases: ['JAMON COCIDO MONT-BLANC', 'JAMON COCIDO MONTBLANC'] },
    { internalCode: '1008', name: 'Fiambre de pechuga de pollo ahumado y horneado', category: 'Fiambres', saleMode: 'FETEABLE', unit: 'KG', pieceKg: '2.200', margin: '0.45', supplierCode: '1008', aliases: ['FIAMBRE DE PECHUGA DE POLLO AHUMADO Y HORNEADO', 'PECHUGA DE POLLO AHUMADA'] },
    { internalCode: '1009', name: 'Fiambre cocido de pata Zur-Linde', category: 'Fiambres', saleMode: 'FETEABLE', unit: 'KG', pieceKg: '3.500', margin: '0.45', supplierCode: '1009', aliases: ['FIAMBRE COCIDO DE PATA ZUR-LINDE', 'PATA ZUR LINDE'] },
    // Dos quesos al corte, para ejercitar el otro modo de venta.
    { internalCode: '2001', name: 'Queso Sardo', category: 'Quesos', saleMode: 'AL_CORTE', unit: 'KG', pieceKg: '3.500', margin: '0.48', aliases: ['QUESO SARDO'] },
    { internalCode: '2002', name: 'Queso Reggianito', category: 'Quesos', saleMode: 'AL_CORTE', unit: 'KG', pieceKg: '4.000', margin: '0.48', aliases: ['QUESO REGGIANITO'] },
  ];

  if (!sembrarCatalogoDemo) {
    console.log(
      'Catálogo: no se siembra ningún artículo. Los PLU vienen de Control de Stock ' +
        '(Configuración → Catálogo Don Ginés). Para los datos de demostración, ' +
        'SEED_CATALOGO_DEMO=1.',
    );
  }

  for (const p of sembrarCatalogoDemo ? products : []) {
    const product = await prisma.product.upsert({
      where: { internalCode: p.internalCode },
      update: {},
      create: {
        internalCode: p.internalCode,
        normalizedName: p.name,
        category: p.category,
        purchaseUnit: p.unit,
        saleMode: p.saleMode,
        avgPieceWeightKg: p.pieceKg,
        defaultSupplierId: p.category === 'Quesos' ? null : losCalvos.id,
        targetMarginPct: p.margin,
        marginBasis: 'SOBRE_COSTO',
        cashDiscountPct: '0.10',
        roundingRule: 'NEAREST_100',
      },
    });

    const supplierId = p.category === 'Quesos' ? null : losCalvos.id;
    for (const alias of p.aliases) {
      const normalized = normalizeText(alias);
      const exists = await prisma.productAlias.findFirst({
        where: { productId: product.id, supplierId, normalized },
      });
      if (exists) continue;
      await prisma.productAlias.create({
        data: {
          productId: product.id,
          supplierId,
          supplierCode: p.supplierCode ?? null,
          alias,
          normalized,
          origin: 'MANUAL',
        },
      });
    }
  }

  // --- Regla de precios global -------------------------------------------
  const globalRule = await prisma.pricingRule.findFirst({ where: { productId: null } });
  if (!globalRule) {
    await prisma.pricingRule.create({
      data: {
        productId: null,
        name: 'Regla general',
        marginBasis: 'SOBRE_COSTO',
        targetMarginPct: '0.45',
        cashDiscountPct: '0.10',
        roundingRule: 'NEAREST_100',
        validFrom: EPOCH,
        active: true,
      },
    });
  }

  // --- Resumen ------------------------------------------------------------
  const counts = {
    roles: await prisma.role.count(),
    sucursales: await prisma.branch.count(),
    usuarios: await prisma.user.count(),
    proveedores: await prisma.supplier.count(),
    productos: await prisma.product.count(),
  };
  console.log('Listo:', counts, '\n');

  if (createdCredentials.length > 0) {
    console.log('Usuarios creados:\n');
    for (const c of createdCredentials) {
      // La contraseña sólo se imprime si la generamos nosotros: la que vino en
      // una variable ya la conoce quien la cargó, y repetirla acá la deja
      // escrita en el log del despliegue, que no se puede borrar.
      const clave = c.deVariable ? '(la de la variable de entorno)' : c.password;
      console.log(`  ${c.role.padEnd(24)} ${c.email.padEnd(32)} ${clave}`);
    }
    console.log(
      '\nTodos entran una sola vez con esa contraseña: la aplicación les pide cambiarla\n' +
        'antes de dejarlos usar ninguna pantalla.\n',
    );
  } else {
    console.log('Los usuarios ya existían: no se creó ninguno ni se cambió ninguna contraseña.\n');
  }
}

main()
  .catch((error) => {
    console.error('El seed falló:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
