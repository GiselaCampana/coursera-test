/**
 * **Una compra para mirar en el navegador, aislada de producción.**
 *
 * Deja en la base de pruebas dos comprobantes leídos y sin confirmar, hechos
 * para recorrer la pantalla nueva:
 *
 *  1. la factura de Ezra completa, con sus cinco renglones asociados por el
 *     código que el proveedor usa para cada artículo. Ahí la vista previa
 *     muestra el egreso por 267.880,50 y los cinco movimientos de mercadería,
 *     y el botón de aplicar queda habilitado;
 *
 *  2. la misma factura con un renglón que no se puede asociar y el total sin
 *     imprimir. Ahí el botón queda bloqueado y los frenos se leen en pantalla.
 *
 * Los dos casos hacen falta: uno solo mostraría o la pantalla que aplica o la
 * que frena, y lo que hay que poder ver es la diferencia.
 *
 * **No toca producción, y no puede.** Se niega a correr si la base no se llama
 * como una base de pruebas, que es la misma guarda que usa el preparador de las
 * end to end. Los datos son inventados: el CUIT, los PLU y los importes salen
 * del caso de aceptación, no del sistema real.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';
import { normalizeText } from '../src/lib/domain/matching';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Las variables del entorno de pruebas, si están escritas en .env.e2e.
 *
 * Corre **antes** de que exista el cliente de Prisma, y esa precedencia es la
 * mitad de la guarda: al importarse, `@prisma/client` lee el `.env` del
 * proyecto, que en una máquina de trabajo apunta a la base de desarrollo. Si el
 * cliente se cargara primero, `DATABASE_URL` ya estaría tomada y este archivo
 * no podría corregirla; por eso el cliente se importa a mano más abajo.
 *
 * Lo que sí gana es una variable puesta a mano en la línea de comandos: quien
 * la escribe está diciendo contra qué base quiere correr.
 */
function cargarEntornoDePruebas(): void {
  const ruta = path.join(raiz, '.env.e2e');
  if (!existsSync(ruta)) return;
  for (const linea of readFileSync(ruta, 'utf8').split('\n')) {
    const limpia = linea.trim();
    if (limpia === '' || limpia.startsWith('#')) continue;
    const corte = limpia.indexOf('=');
    if (corte < 0) continue;
    const clave = limpia.slice(0, corte).trim();
    if (process.env[clave] !== undefined) continue;
    process.env[clave] = limpia
      .slice(corte + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
}

/**
 * La guarda, que es lo que hace que esto sea seguro de correr.
 *
 * Mira el **nombre de la base**, no la variable entera: una URL puede tener la
 * palabra «test» en el usuario o en el host y seguir apuntando a producción.
 */
function nombreDeLaBase(url: string): string | null {
  try {
    return new URL(url).pathname.replace(/^\//, '') || null;
  } catch {
    return null;
  }
}

function esUnaBaseDePruebas(url: string): boolean {
  const nombre = nombreDeLaBase(url);
  return nombre !== null && /(^|[-_])(e2e|test|demo)([-_]|$)/i.test(nombre);
}

const EPOCH = new Date(Date.UTC(2020, 0, 1));
const EMISION = new Date('2026-09-10T12:00:00Z');

/** Los cinco renglones del caso de aceptación, con el PLU que ya existe. */
const RENGLONES = [
  { codigo: '47', descripcion: 'QUESO CREMOSO LA PAULINA', plu: '3101', kilos: '13.674', total: '85235.09' },
  { codigo: '49', descripcion: 'PERNIL PATA CELESTE MINI 1284', plu: '3102', kilos: '11.428', total: '42876.82' },
  { codigo: '48', descripcion: 'QUESO DE MAQUINA DAMBO LA PAULINA', plu: '3103', kilos: '7.116', total: '60027.53' },
  { codigo: '10', descripcion: 'JAMON COCIDO MINI TRADICIONAL LOS CALVOS', plu: '3104', kilos: '4.512', total: '53194.06' },
  { codigo: '2514', descripcion: 'JAMON COCIDO MINI IL MOLISE', plu: '3105', kilos: '3.180', total: '26547.00' },
];

const NETO_IMPRESO = '221388.84';
const IVA_IMPRESO = '46491.66';
const TOTAL_IMPRESO = '267880.50';

async function main() {
  cargarEntornoDePruebas();

  const url = process.env.DATABASE_URL ?? '';
  if (!esUnaBaseDePruebas(url)) {
    /*
     * Se nombra la base que se vio, y sólo la base: decir «no es de pruebas»
     * sin decir cuál miró deja a quien lo corre adivinando, y la URL entera
     * lleva la contraseña.
     */
    console.error(
      'Esto sólo corre contra una base de pruebas: el nombre de la base tiene que ser\n' +
        '"e2e", "test" o "demo". No se escribió nada.\n' +
        `Base vista: ${nombreDeLaBase(url) ?? '(ninguna: DATABASE_URL no está definida)'}`,
    );
    process.exit(1);
  }

  // Recién ahora, con el entorno ya resuelto y verificado.
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const sucursal = await prisma.branch.findFirst({ orderBy: { code: 'asc' } });
    if (!sucursal) {
      console.error('La base de pruebas está vacía. Corré antes: npm run e2e:seed');
      process.exit(1);
    }

    const autor = await prisma.user.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!autor) {
      console.error('La base de pruebas no tiene usuarios. Corré antes: npm run e2e:seed');
      process.exit(1);
    }

    const ezra = await proveedorEzra(prisma);
    const productos = await productosDeEzra(prisma, ezra.id);

    const completa = await facturaDeEzra(prisma, {
      sucursalId: sucursal.id,
      proveedorId: ezra.id,
      autorId: autor.id,
      numero: '00000185',
      totalImpreso: TOTAL_IMPRESO,
      renglonSinAsociar: false,
    });

    const frenada = await facturaDeEzra(prisma, {
      sucursalId: sucursal.id,
      proveedorId: ezra.id,
      autorId: autor.id,
      numero: '00000186',
      totalImpreso: null,
      renglonSinAsociar: true,
    });

    console.log('');
    console.log('Listo. Dos comprobantes para mirar en el navegador:');
    console.log('');
    console.log(`  Ezra completa   /comprobantes/${completa}`);
    console.log(`                  /comprobantes/${completa}/vista-previa`);
    console.log(`  Ezra frenada    /comprobantes/${frenada}`);
    console.log(`                  /comprobantes/${frenada}/vista-previa`);
    console.log('');
    console.log(`  Productos de Ezra en el catálogo: ${productos.length}`);
    console.log('');
  } finally {
    await prisma.$disconnect();
  }
}

async function proveedorEzra(prisma: PrismaClient) {
  const existente = await prisma.supplier.findFirst({ where: { cuit: '30-71951960-8' } });
  if (existente) return existente;

  return prisma.supplier.create({
    data: {
      tradeName: 'Distribuidora Ezra',
      legalName: 'Cooperativa de Trabajo Ezra Alimentos',
      cuit: '30-71951960-8',
      aliases: {
        create: { alias: 'Distribuidora Ezra', normalized: normalizeText('Distribuidora Ezra') },
      },
      paymentTerms: {
        create: { termType: 'DAYS', days: 30, paymentMethod: 'TRANSFERENCIA', validFrom: EPOCH },
      },
      taxRules: {
        create: { ivaRate: '0.21', iibbRate: '0', otherPerceptions: [], validFrom: EPOCH },
      },
    },
  });
}

/**
 * Los cinco artículos habituales, cada uno con el código que Ezra le pone.
 *
 * El alias con `supplierCode` es lo que hace que la asociación sea por
 * identificación y no por parecido: es el camino que la vista previa acepta
 * como inequívoco.
 */
async function productosDeEzra(prisma: PrismaClient, proveedorId: string) {
  const productos = [];
  for (const renglon of RENGLONES) {
    const existente = await prisma.product.findFirst({ where: { internalCode: renglon.plu } });
    if (existente) {
      productos.push(existente);
      continue;
    }
    productos.push(
      await prisma.product.create({
        data: {
          internalCode: renglon.plu,
          normalizedName: renglon.descripcion,
          purchaseUnit: 'KG',
          active: true,
          aliases: {
            create: {
              supplierId: proveedorId,
              supplierCode: renglon.codigo,
              alias: renglon.descripcion,
              normalized: normalizeText(renglon.descripcion),
              origin: 'MANUAL',
            },
          },
        },
      }),
    );
  }
  return productos;
}

async function facturaDeEzra(
  prisma: PrismaClient,
  opciones: {
    sucursalId: string;
    proveedorId: string;
    autorId: string;
    numero: string;
    totalImpreso: string | null;
    renglonSinAsociar: boolean;
  },
) {
  const anterior = await prisma.document.findFirst({
    where: { number: opciones.numero, supplierId: opciones.proveedorId },
  });
  if (anterior) {
    await prisma.documentItem.deleteMany({ where: { documentId: anterior.id } });
    await prisma.document.delete({ where: { id: anterior.id } });
  }

  const documento = await prisma.document.create({
    data: {
      branchId: opciones.sucursalId,
      supplierId: opciones.proveedorId,
      createdById: opciones.autorId,
      readSupplierName: 'Cooperativa de Trabajo Ezra Alimentos',
      readSupplierCuit: '30-71951960-8',
      docType: 'FACTURA',
      letter: 'A',
      pointOfSale: '0002',
      number: opciones.numero,
      fullNumber: `A 0002-${opciones.numero}`,
      issueDate: EMISION,
      status: 'BORRADOR',
      netTotal: NETO_IMPRESO,
      ivaTotal: IVA_IMPRESO,
      perceptionsTotal: '0',
      total: opciones.totalImpreso,
      appliedTermDays: 30,
    },
  });

  for (const [indice, renglon] of RENGLONES.entries()) {
    const neto = (Number(renglon.total) / 1.21).toFixed(4);
    /*
     * El último renglón de la factura frenada se queda sin código: es el caso
     * que la pantalla tiene que bloquear, porque sin identificación no hay
     * forma de saber a qué artículo cargarle la compra.
     */
    const sinCodigo = opciones.renglonSinAsociar && indice === RENGLONES.length - 1;

    await prisma.documentItem.create({
      data: {
        documentId: documento.id,
        lineNumber: indice + 1,
        supplierCode: sinCodigo ? null : renglon.codigo,
        description: sinCodigo ? `${renglon.descripcion} (sin codigo legible)` : renglon.descripcion,
        quantity: renglon.kilos,
        unit: 'KG',
        unitNetPrice: (Number(neto) / Number(renglon.kilos)).toFixed(4),
        grossSubtotal: neto,
        netAmount: neto,
        ivaRate: '0.21',
        ivaAmount: (Number(renglon.total) - Number(neto)).toFixed(4),
        perceptionAmount: '0',
        totalCost: renglon.total,
        unitCost: (Number(renglon.total) / Number(renglon.kilos)).toFixed(4),
        productId: null,
        matchMethod: 'NONE',
      },
    });
  }

  return documento.id;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
