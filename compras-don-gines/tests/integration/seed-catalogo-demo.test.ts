import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { prisma } from '@/lib/db';
import { limpiarBase } from './ayudas';
import { exigirBaseDescartable } from '@/lib/base-de-pruebas';
import { normalizeText } from '@/lib/domain/matching';
import { PERMISSIONS } from '@/lib/auth/permissions';

/**
 * **El catálogo de demostración del sembrado productivo, corrido de verdad.**
 *
 * `SEED_CATALOGO_DEMO=1` no arrancaba sobre una base recién migrada. Le ponía el
 * código del proveedor a CADA alias del artículo y `@@unique([supplierId,
 * supplierCode])` rechazaba el segundo, así que el sembrado moría en el tercer
 * artículo con dos alias y dejaba la base a medio hacer: siete productos, sin
 * reglas de precios y sin el resto del arranque.
 *
 * El defecto se descubrió en la fase 5 barriendo variables de entorno, y quedó
 * informado sin corregir hasta que se autorizó arreglarlo. Esta suite es la que
 * impide que vuelva.
 *
 * **Se CORRE el sembrado**, no se lee su texto. Un sembrado que fallara y un
 * sembrado que no escribiera el código se ven igual desde el código fuente, y
 * la pregunta es qué queda en la base.
 *
 * Y se corre DOS VECES, porque la promesa del sembrado productivo es que se
 * puede volver a correr: es lo que hace la demo en cada arranque.
 */

const RAIZ = path.resolve(__dirname, '../..');

/** Lo que el sembrado declara: artículo, código de proveedor y sus alias. */
const ESPERADO = [
  { plu: '1001', codigo: '1001', alias: ['LONGANIZA CORTA'] },
  { plu: '1002', codigo: '1002', alias: ['SALAME CRESPON', 'SALAME CRESPÓN'] },
  { plu: '1003', codigo: '1003', alias: ['SALAME MILAN', 'SALAME MILÁN'] },
  { plu: '1004', codigo: '1004', alias: ['BONDIOLA AL PAPEL'] },
  { plu: '1005', codigo: '1005', alias: ['JAMON CRUDO PARMA', 'JAMÓN CRUDO PARMA'] },
  { plu: '1006', codigo: '1006', alias: ['JAMON COCIDO', 'JAMÓN COCIDO'] },
  {
    plu: '1007',
    codigo: '1007',
    alias: ['JAMON COCIDO MONT-BLANC', 'JAMON COCIDO MONTBLANC'],
  },
  {
    plu: '1008',
    codigo: '1008',
    alias: ['FIAMBRE DE PECHUGA DE POLLO AHUMADO Y HORNEADO', 'PECHUGA DE POLLO AHUMADA'],
  },
  {
    plu: '1009',
    codigo: '1009',
    alias: ['FIAMBRE COCIDO DE PATA ZUR-LINDE', 'PATA ZUR LINDE'],
  },
  { plu: '2001', codigo: null, alias: ['QUESO SARDO'] },
  { plu: '2002', codigo: null, alias: ['QUESO REGGIANITO'] },
] as const;

/**
 * Corre `prisma/seed.ts` con el catálogo de demostración pedido.
 *
 * La guarda va acá adentro, no sólo en el arranque global de las pruebas: esta
 * función es la que escribe. `exigirBaseDescartable` mira el NOMBRE de la base
 * y exige «test» o «e2e»; la demo no alcanza, porque está desplegada.
 */
function correrElSeedConCatalogoDemo(extra: Record<string, string> = {}) {
  exigirBaseDescartable(process.env.DATABASE_URL);

  execFileSync('npx', ['tsx', 'prisma/seed.ts'], {
    cwd: RAIZ,
    stdio: 'pipe',
    env: {
      ...process.env,
      SEED_ADMIN_PASSWORD: 'PruebasDonGines1',
      SEED_OPERATOR_PASSWORD: 'PruebasDonGines1',
      SEED_CATALOGO_DEMO: '1',
      ...extra,
    },
  });
}

/** Los alias de un artículo, por su PLU. */
async function aliasDe(plu: string) {
  return prisma.productAlias.findMany({
    where: { product: { internalCode: plu } },
    orderBy: { alias: 'asc' },
    select: { alias: true, normalized: true, supplierCode: true, supplierId: true },
  });
}

/*
 * Base vaciada antes de cada prueba: equivale a una recién migrada —el esquema
 * de las migraciones, ninguna fila— que es el escenario donde el defecto
 * aparecía. Sobre una base ya sembrada no se veía, porque los alias existían y
 * el bucle los salteaba.
 */
beforeEach(async () => {
  await limpiarBase();
});

describe('el catálogo de demostración del sembrado productivo', () => {
  it('1. la primera ejecución con SEED_CATALOGO_DEMO=1 termina bien', () => {
    expect(() => correrElSeedConCatalogoDemo()).not.toThrow();
  });

  it('2. la segunda ejecución también termina bien y no agrega duplicados', async () => {
    correrElSeedConCatalogoDemo();
    const despuesDeUna = await prisma.productAlias.count();
    const productosDeUna = await prisma.product.count();

    expect(() => correrElSeedConCatalogoDemo()).not.toThrow();

    expect(await prisma.productAlias.count(), 'no se duplican alias').toBe(despuesDeUna);
    expect(await prisma.product.count(), 'no se duplican artículos').toBe(productosDeUna);
  });

  it('3. el producto 1002 conserva las dos formas de escribirlo: con y sin tilde', async () => {
    correrElSeedConCatalogoDemo();
    const filas = await aliasDe('1002');

    /*
     * Las dos grafías se conservan como formas RECONOCIBLES del mismo alias, y
     * eso es lo que el catálogo usa para encontrar el artículo.
     *
     * No son dos filas, y no pueden serlo sin cambiar el esquema: la
     * normalización descarta las tildes a propósito —«jamón» y «jamon» son lo
     * mismo— y `@@unique([productId, supplierId, normalized])` deja una sola
     * fila por forma normalizada. Que sea una fila es la consecuencia de esa
     * decisión de diseño, no una pérdida: cualquiera de las dos grafías, venga
     * del OCR o de un teclado, resuelve a este artículo.
     *
     * Lo que sí se comprueba es que NINGUNA de las dos quede afuera.
     */
    const normalizadas = new Set(filas.map((f) => f.normalized));
    for (const grafia of ['SALAME CRESPON', 'SALAME CRESPÓN']) {
      expect(
        normalizadas.has(normalizeText(grafia)),
        `«${grafia}» tiene que resolver a un alias de 1002`,
      ).toBe(true);
    }

    /* Y la resolución es la del catálogo de verdad, buscando por normalizado. */
    for (const grafia of ['SALAME CRESPON', 'SALAME CRESPÓN']) {
      const encontrado = await prisma.productAlias.findFirst({
        where: { normalized: normalizeText(grafia) },
        select: { product: { select: { internalCode: true } } },
      });
      expect(encontrado?.product.internalCode, `buscando «${grafia}»`).toBe('1002');
    }
  });

  it('4. un solo registro por artículo lleva el código del proveedor', async () => {
    correrElSeedConCatalogoDemo();

    for (const esperado of ESPERADO) {
      const filas = await aliasDe(esperado.plu);
      const conCodigo = filas.filter((f) => f.supplierCode !== null);

      if (esperado.codigo === null) {
        expect(conCodigo, `${esperado.plu} no declara código`).toHaveLength(0);
        continue;
      }

      expect(conCodigo, `${esperado.plu}: exactamente un alias con código`).toHaveLength(1);
      expect(conCodigo[0].supplierCode, `${esperado.plu}: el código declarado`).toBe(
        esperado.codigo,
      );
      /* El principal es el PRIMERO declarado: determinista, no el que salga. */
      expect(conCodigo[0].normalized, `${esperado.plu}: el principal es el primero declarado`).toBe(
        normalizeText(esperado.alias[0]),
      );
      /* Y ningún otro alias del artículo repite ese código. */
      for (const f of filas.filter((f) => f.supplierCode === null)) {
        expect(f.supplierCode, `«${f.alias}» no repite el código`).toBeNull();
      }
    }

    /*
     * Y la invariante global, que es la que el defecto violaba: un par
     * (proveedor, código) no se repite. Es lo que `@@unique` defiende en la
     * base; acá se comprueba que el sembrado no dependa de que la base lo
     * rechace.
     */
    const repetidos = await prisma.$queryRaw<{ supplierCode: string; cuantos: bigint }[]>`
      SELECT "supplierCode", COUNT(*) AS cuantos
        FROM "product_aliases"
       WHERE "supplierCode" IS NOT NULL
       GROUP BY "supplierId", "supplierCode"
      HAVING COUNT(*) > 1`;
    expect(repetidos, 'ningún código de proveedor apunta a dos alias').toHaveLength(0);
  });

  it('5. no se pierde ningún alias: cada uno declarado resuelve a su artículo', async () => {
    correrElSeedConCatalogoDemo();

    for (const esperado of ESPERADO) {
      const filas = await aliasDe(esperado.plu);
      expect(filas.length, `${esperado.plu} tiene alias`).toBeGreaterThan(0);

      /* Cada grafía declarada encuentra SU artículo, ninguna queda huérfana. */
      for (const grafia of esperado.alias) {
        const fila = filas.find((f) => f.normalized === normalizeText(grafia));
        expect(fila, `«${grafia}» de ${esperado.plu} no está`).toBeDefined();
      }

      /*
       * Y hay una fila por forma normalizada distinta: ni menos —sería un alias
       * perdido— ni más —serían duplicados—.
       */
      const formas = new Set(esperado.alias.map((a) => normalizeText(a)));
      expect(filas.length, `${esperado.plu}: una fila por forma normalizada`).toBe(formas.size);
    }

    /* Ninguna fila quedó con el texto vacío ni con el normalizado en blanco. */
    const vacias = await prisma.productAlias.count({
      where: { OR: [{ alias: '' }, { normalized: '' }] },
    });
    expect(vacias, 'ningún alias quedó sin texto').toBe(0);
  });

  it('6. con el catálogo demo TERMINADO, los dos interruptores siguen apagados', async () => {
    /*
     * El orden importa y es el del enunciado: primero el sembrado tiene que
     * TERMINAR, y recién entonces se miran los interruptores.
     *
     * Un sembrado que aborta no prueba nada sobre los interruptores: no llegó a
     * tocarlos. Mientras el defecto existía, ésta era exactamente la trampa
     * —«falló, así que no los encendió»— y no vale como demostración de
     * seguridad.
     */
    expect(() => correrElSeedConCatalogoDemo(), 'el sembrado tiene que terminar').not.toThrow();

    const cuantos = await prisma.product.count();
    expect(cuantos, 'el catálogo demo quedó sembrado entero').toBe(ESPERADO.length);

    const filas = await prisma.$queryRaw<
      { realOpeningEnabled: boolean; realPurchaseReceiptsEnabled: boolean }[]
    >`SELECT "realOpeningEnabled", "realPurchaseReceiptsEnabled" FROM "stock_module_setting"`;
    expect(filas, 'hay una sola fila de configuración').toHaveLength(1);
    expect(filas[0].realOpeningEnabled, 'aperturas reales').toBe(false);
    expect(filas[0].realPurchaseReceiptsEnabled, 'recepciones reales').toBe(false);
  });

  it('7. ningún rol que ya existía recibe permisos nuevos', async () => {
    /*
     * Se crea a mano un rol con el MISMO código que uno del sembrado y una
     * lista mínima. Los upserts del sembrado usan `update: {}`, así que lo tiene
     * que dejar como está: es lo que protege a un rol de producción, al que
     * alguien le sacó permisos a propósito, de que el arranque se los devuelva.
     */
    const rol = await prisma.role.create({
      data: {
        code: 'ADMIN',
        name: 'Administrador recortado a mano',
        permissions: ['comprobantes.ver'],
        scopeAllBranches: true,
        isSystem: true,
      },
    });

    correrElSeedConCatalogoDemo();

    const despues = await prisma.role.findUniqueOrThrow({ where: { id: rol.id } });
    expect(despues.permissions, 'la lista queda intacta').toEqual(['comprobantes.ver']);
    expect(despues.name, 'ni el nombre se toca').toBe('Administrador recortado a mano');
    for (const permiso of [
      PERMISSIONS.STOCKERP_MOVIMIENTOS_VER,
      PERMISSIONS.STOCKERP_INTEGRIDAD_VER,
      PERMISSIONS.STOCKERP_MODULO_CONFIGURAR,
    ]) {
      expect(despues.permissions, `no aparece ${permiso}`).not.toContain(permiso);
    }
  });

  it('8. si todos los alias volvieran a llevar el mismo código, esto queda rojo', async () => {
    /*
     * La rotura del enunciado, hecha CONTRA LA BASE y no contra el texto del
     * sembrado: se le pone a un segundo alias el código que ya lleva el
     * principal, que es exactamente lo que hacía el defecto.
     *
     * Tiene que fallar en la base. Si algún día alguien relajara el `@@unique`,
     * esta prueba se pondría roja y con razón: las pruebas 4 y 5 dependen de
     * que la base lo siga rechazando.
     */
    correrElSeedConCatalogoDemo();

    const filas = await aliasDe('1007');
    const principal = filas.find((f) => f.supplierCode !== null);
    const secundario = filas.find((f) => f.supplierCode === null);
    expect(principal, 'el principal de 1007').toBeDefined();
    expect(secundario, 'el secundario de 1007').toBeDefined();

    await expect(
      prisma.productAlias.updateMany({
        where: { normalized: secundario!.normalized, product: { internalCode: '1007' } },
        data: { supplierCode: principal!.supplierCode },
      }),
      'repetir el código del proveedor tiene que ser imposible',
    ).rejects.toThrow();

    /* Y después del intento fallido, sigue habiendo uno solo con código. */
    const despues = await aliasDe('1007');
    expect(despues.filter((f) => f.supplierCode !== null)).toHaveLength(1);
  });
});
