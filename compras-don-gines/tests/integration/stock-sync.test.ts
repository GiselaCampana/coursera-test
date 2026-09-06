import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { ForbiddenError } from '@/lib/errors';
import {
  RespuestaDeStockInvalida,
  aplicarSincronizacionDeStock,
  vistaPreviaDeStock,
} from '@/lib/services/stock-sync';
import { normalizeText } from '@/lib/domain/matching';
import { AUDIT_ACTIONS } from '@/lib/services/audit';
import { resolvePricingRule, suggestPricesFor } from '@/lib/services/pricing';
import { limpiarBase, sembrarEscenario, type Escenario } from './ayudas';

/**
 * Sincronizar el catálogo con Control de Stock.
 *
 * Lo que se comprueba acá no es que los nombres se copien —eso lo haría
 * cualquier importador— sino las tres cosas que hacen que esta sincronización
 * se pueda correr sin miedo:
 *
 *  - que la vista previa **no escriba nada** y diga exactamente lo que va a
 *    pasar, separado en los cuatro montones que hay que mirar;
 *  - que confirmar no toque nada de lo que es de Compras: ni una compra, ni un
 *    costo, ni un marcaje, ni un histórico;
 *  - que correrla dos veces seguidas no proponga ningún cambio la segunda vez,
 *    que es la única forma de saber que lo que se aplicó es lo que se miró.
 */

let escenario: Escenario;

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();
});

/** Una respuesta del endpoint, con los artículos que se le pasen. */
function respuestaDeStock(productos: unknown[], cambios: Record<string, unknown> = {}) {
  return JSON.stringify({
    ok: true,
    schemaVersion: '1.0',
    usage: { stableKey: 'plu' },
    branches: [{ id: 'b1', name: 'Devoto' }],
    products: productos,
    ...cambios,
  });
}

/** El catálogo maestro tal como lo devolvería Control de Stock para el escenario. */
function comoEnStock(cambios: Partial<Record<string, unknown>> = {}) {
  return {
    plu: '1211',
    name: 'Cremoso Punta del Agua',
    supplier: { id: 's1', name: 'Distribución Errecalde' },
    type: { id: 't1', name: 'Quesos' },
    subtype: { id: 'st1', name: 'Cremosos' },
    internalUnit: 'kg',
    active: true,
    ...cambios,
  };
}

/** Todo lo que es de Compras y la sincronización no puede tocar. */
async function loQueEsDeCompras() {
  const [productos, movimientos, costos, precios, alias, reglas] = await Promise.all([
    prisma.product.findMany({
      orderBy: { internalCode: 'asc' },
      select: {
        internalCode: true,
        targetMarginPct: true,
        marginBasis: true,
        alCorteHormaDigitalMarginPct: true,
        feteadoQuarterMarginPct: true,
        wholeUnitMarginPct: true,
        cashDiscountPct: true,
        roundingRule: true,
        saleMode: true,
        avgPieceWeightKg: true,
        purchaseUnitWeightKg: true,
        usesPlu: true,
      },
    }),
    prisma.purchaseMovement.count(),
    prisma.costHistory.findMany({ orderBy: { id: 'asc' }, select: { unitCost: true } }),
    prisma.salePriceHistory.count(),
    prisma.productAlias.findMany({
      orderBy: { id: 'asc' },
      select: { productId: true, supplierId: true, supplierCode: true },
    }),
    prisma.pricingRule.findMany({ orderBy: { id: 'asc' }, select: { targetMarginPct: true } }),
  ]);
  return {
    productos: productos.map((p) => JSON.stringify(p)),
    movimientos,
    costos: costos.map((c) => c.unitCost.toString()),
    precios,
    alias: alias.map((a) => JSON.stringify(a)),
    reglas: reglas.map((r) => r.targetMarginPct.toString()),
  };
}

describe('la vista previa no escribe nada', () => {
  it('separa nuevos, modificados con el antes y el después, y sin cambios', async () => {
    const antes = await loQueEsDeCompras();

    const vista = await vistaPreviaDeStock(escenario.admin, {
      contenido: respuestaDeStock([
        // El 1211 ya está en Compras con otro nombre: modificado.
        comoEnStock({ name: 'Cremoso Punta del Agua Premium' }),
        // El 4001 no existe: nuevo.
        comoEnStock({ plu: '4001', name: 'Provolone', subtype: { id: 'st2', name: 'Duros' } }),
      ]),
    });

    expect(vista.nuevos.map((a) => a.plu)).toEqual(['4001']);
    expect(vista.modificados.map((a) => a.plu)).toEqual(['1211']);

    const cambioDeNombre = vista.modificados[0].cambios.find((c) => c.campo === 'Nombre');
    expect(cambioDeNombre).toEqual({
      campo: 'Nombre',
      antes: 'Cremoso Punta del Agua',
      despues: 'Cremoso Punta del Agua Premium',
    });

    // Y ni una fila cambió por haber mirado.
    expect(await loQueEsDeCompras()).toEqual(antes);
    expect(vista.aplicados).toBe(0);
    expect(await prisma.product.count({ where: { internalCode: '4001' } })).toBe(0);
  });

  it('el que no cambia va al montón de los que no cambian', async () => {
    // Primero se aplica, así el catálogo queda igual al maestro.
    await aplicarSincronizacionDeStock(escenario.admin, {
      contenido: respuestaDeStock([comoEnStock()]),
    });

    const vista = await vistaPreviaDeStock(escenario.admin, {
      contenido: respuestaDeStock([comoEnStock()]),
    });
    expect(vista.sinCambios.map((a) => a.plu)).toContain('1211');
    expect(vista.modificados).toEqual([]);
  });

  it('dice qué artículos quedarían inactivos, y por qué', async () => {
    /*
     * Los dos motivos son distintos y conviene verlos separados: uno lo dio de
     * baja Control de Stock, y del otro dejó de hablar. En los dos casos el
     * artículo se conserva entero y sólo deja de estar activo.
     */
    const vista = await vistaPreviaDeStock(escenario.admin, {
      contenido: respuestaDeStock([comoEnStock({ active: false })]),
    });

    const inactivos = new Map(vista.quedarianInactivos.map((a) => [a.plu, a.motivo]));
    expect(inactivos.get('1211')).toBe('Control de Stock lo dio de baja');
    // Los demás artículos del escenario ya no aparecen en el maestro.
    expect(inactivos.get('1001')).toBe('Ya no está en el catálogo de Control de Stock');
    // Y ninguno se borró ni se tocó por mirar.
    expect(await prisma.product.count()).toBeGreaterThan(1);
  });

  it('sin permiso de gestionar productos no se mira ni se aplica', async () => {
    const contenido = respuestaDeStock([comoEnStock()]);
    await expect(
      vistaPreviaDeStock(escenario.operadorDevoto, { contenido }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      aplicarSincronizacionDeStock(escenario.operadorDevoto, { contenido }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('la familia sale del tipo, no del subtipo', () => {
  /*
   * El defecto que apareció contra el catálogo real: la familia se tomaba del
   * subtipo, así que cada subtipo se volvía una familia suelta —«Cremoso»,
   * «Cremosos», «Duros», «Especial», «Especiales»— y el maestro proponía crear
   * veintiocho familias donde hay un puñado de tipos.
   *
   * Familia y tipo son el mismo nivel. El subtipo tiene su propio campo. Que
   * sean tres pruebas y no una es a propósito: cada una falla por un motivo
   * distinto, y confundir los tres es exactamente cómo se llegó acá.
   */
  it('«Quesos / Cremosos» crea la familia «Quesos» y nunca «Cremosos»', async () => {
    const vista = await vistaPreviaDeStock(escenario.admin, {
      contenido: respuestaDeStock([comoEnStock()]),
    });

    expect(vista.familiasNuevas).toContain('Quesos');
    expect(vista.familiasNuevas).not.toContain('Cremosos');

    const familia = vista.modificados[0].cambios.find((c) => c.campo === 'Familia');
    expect(familia?.despues).toBe('Quesos');
  });

  it('dos subtipos del mismo tipo no crean dos familias', async () => {
    const vista = await vistaPreviaDeStock(escenario.admin, {
      contenido: respuestaDeStock([
        comoEnStock({ plu: '5001', name: 'Cremoso', subtype: { id: 'a', name: 'Cremosos' } }),
        comoEnStock({ plu: '5002', name: 'Sardo', subtype: { id: 'b', name: 'Duros' } }),
        comoEnStock({ plu: '5003', name: 'Provolone', subtype: { id: 'c', name: 'Especiales' } }),
      ]),
    });

    /*
     * Tres artículos, tres subtipos, un solo tipo: una sola familia. Si esto
     * diera tres, la familia habría dejado de agrupar y configurar el rubro una
     * vez volvería a ser configurarlo uno por uno.
     */
    expect(vista.familiasNuevas).toEqual(['Quesos']);
  });

  it('el tipo y el subtipo no quedan intercambiados al aplicar', async () => {
    await aplicarSincronizacionDeStock(escenario.admin, {
      contenido: respuestaDeStock([comoEnStock()]),
    });

    const guardado = await prisma.product.findUniqueOrThrow({
      where: { internalCode: '1211' },
      include: { family: true },
    });

    expect(guardado.category).toBe('Quesos');
    expect(guardado.subtype).toBe('Cremosos');
    expect(guardado.family?.name).toBe('Quesos');
    // Y no quedó ninguna familia con nombre de subtipo.
    expect(await prisma.productFamily.count({ where: { name: 'Cremosos' } })).toBe(0);
  });

  it('los tres artículos verificados contra el catálogo real quedan bien', async () => {
    /*
     * Los que la usuaria comprobó uno por uno en Control de Stock. Sirven mejor
     * que un caso inventado por dos motivos: son datos reales, y entre los tres
     * hay dos tipos y tres subtipos, así que la prueba distingue «agrupar por
     * tipo» de «agrupar por subtipo» sin depender de cómo esté escrita.
     */
    const DEL_MAESTRO = [
      { plu: '1211', nombre: 'Cremoso Punta del Agua', tipo: 'Quesos', subtipo: 'Cremosos' },
      { plu: '1603', nombre: 'Goya Melincué', tipo: 'Quesos', subtipo: 'Duros' },
      { plu: '2112', nombre: 'Jamón Cocido Los Calvos 42', tipo: 'Fiambres', subtipo: 'Jamón' },
    ];

    await aplicarSincronizacionDeStock(escenario.admin, {
      contenido: respuestaDeStock(
        DEL_MAESTRO.map((a) =>
          comoEnStock({
            plu: a.plu,
            name: a.nombre,
            type: { id: `t-${a.tipo}`, name: a.tipo },
            subtype: { id: `st-${a.plu}`, name: a.subtipo },
          }),
        ),
      ),
    });

    for (const esperado of DEL_MAESTRO) {
      const guardado = await prisma.product.findUniqueOrThrow({
        where: { internalCode: esperado.plu },
        include: { family: true },
      });
      expect(guardado.normalizedName, esperado.plu).toBe(esperado.nombre);
      expect(guardado.category, `${esperado.plu} tipo`).toBe(esperado.tipo);
      expect(guardado.subtype, `${esperado.plu} subtipo`).toBe(esperado.subtipo);
      expect(guardado.family?.name, `${esperado.plu} familia`).toBe(esperado.tipo);
    }

    // Ni una familia con nombre de subtipo.
    for (const subtipo of ['Cremosos', 'Duros', 'Jamón']) {
      expect(
        await prisma.productFamily.count({ where: { name: subtipo } }),
        `no debería existir la familia «${subtipo}»`,
      ).toBe(0);
    }

    /*
     * Y los dos quesos comparten familia: es lo que hace que configurar el
     * marcaje de «Quesos» una vez alcance para los dos.
     */
    const [cremoso, goya] = await Promise.all([
      prisma.product.findUniqueOrThrow({ where: { internalCode: '1211' } }),
      prisma.product.findUniqueOrThrow({ where: { internalCode: '1603' } }),
    ]);
    expect(cremoso.familyId).toBe(goya.familyId);
  });

  it('sin tipo no se inventa una familia con el subtipo', async () => {
    /*
     * Un artículo sin tipo se queda sin familia, y eso se ve: la pantalla de
     * catálogo cuenta los que no tienen. Caer al subtipo sería volver al mismo
     * error por la puerta de atrás, y un artículo mal clasificado no se nota.
     */
    const vista = await vistaPreviaDeStock(escenario.admin, {
      contenido: respuestaDeStock([comoEnStock({ type: null })]),
    });

    expect(vista.familiasNuevas).toEqual([]);
    expect(vista.modificados[0].cambios.find((c) => c.campo === 'Familia')).toBeUndefined();
  });
});

describe('la aritmética de la vista previa cierra', () => {
  /*
   * La pregunta que se hizo mirando producción: «145 artículos en Compras, 149
   * en el maestro, 134 modificados, 15 nuevos, y cero inactivaciones. ¿Qué pasó
   * con los otros once?». La respuesta era «ya estaban inactivos», pero la
   * pantalla no lo decía, y un número que no cierra obliga a desconfiar de
   * todos los demás.
   */
  it('un artículo activo que el maestro ya no nombra sí aparece como baja', async () => {
    const vista = await vistaPreviaDeStock(escenario.admin, {
      contenido: respuestaDeStock([comoEnStock()]),
    });

    const bajas = vista.quedarianInactivos.map((a) => a.plu);
    expect(bajas).toContain('1001');
    expect(vista.yaEstabanInactivos).toBe(0);
  });

  it('uno que ya estaba inactivo no se informa como baja, pero se cuenta', async () => {
    await prisma.product.update({ where: { internalCode: '1001' }, data: { active: false } });

    const vista = await vistaPreviaDeStock(escenario.admin, {
      contenido: respuestaDeStock([comoEnStock()]),
    });

    // No es una baja: no cambiaría nada.
    expect(vista.quedarianInactivos.map((a) => a.plu)).not.toContain('1001');
    // Pero está contado, para que la cuenta cierre.
    expect(vista.yaEstabanInactivos).toBe(1);
  });

  it('todo artículo de los dos lados queda en exactamente un montón', async () => {
    await prisma.product.update({ where: { internalCode: '1001' }, data: { active: false } });

    const vista = await vistaPreviaDeStock(escenario.admin, {
      contenido: respuestaDeStock([comoEnStock(), comoEnStock({ plu: '9001', name: 'Nuevo' })]),
    });

    const bajasPorAusencia = vista.quedarianInactivos.filter(
      (a) => a.motivo === 'Ya no está en el catálogo de Control de Stock',
    ).length;
    const bajasPorBaja = vista.quedarianInactivos.length - bajasPorAusencia;

    // Lo que trajo el maestro: cada uno es nuevo, o modificado, o igual, o baja.
    expect(vista.leidos).toBe(
      vista.nuevos.length + vista.modificados.length + vista.sinCambios.length + bajasPorBaja,
    );

    /*
     * Y lo que tiene Compras: cada uno coincide con el maestro, o no está y
     * queda inactivo, o no está y ya lo estaba. Esta es la identidad que en
     * producción no se podía verificar desde la pantalla.
     */
    expect(vista.enCompras).toBe(
      vista.modificados.length +
        vista.sinCambios.length +
        bajasPorBaja +
        bajasPorAusencia +
        vista.yaEstabanInactivos,
    );
    expect(vista.enCompras).toBe(await prisma.product.count());
  });
});

describe('un proveedor que no resuelve nunca borra el que ya está', () => {
  /*
   * Control de Stock nombra proveedores con texto libre, y ese texto es muchas
   * veces una marca o un fabricante y no la empresa a la que Compras le compra.
   * De `defaultSupplierId` cuelgan el plazo de pago, la agenda y la cuenta
   * corriente: perderlo por una referencia que no se pudo resolver sería un
   * daño silencioso, y encima en el campo del que más cuesta darse cuenta.
   */
  it('el proveedor habitual se conserva si el nombre entrante es desconocido', async () => {
    const antes = await prisma.product.findUniqueOrThrow({ where: { internalCode: '1211' } });
    expect(antes.defaultSupplierId).not.toBeNull();

    await aplicarSincronizacionDeStock(escenario.admin, {
      contenido: respuestaDeStock([
        comoEnStock({ supplier: { id: 'x', name: 'Lácteos Que No Existen SRL' } }),
      ]),
    });

    const despues = await prisma.product.findUniqueOrThrow({ where: { internalCode: '1211' } });
    expect(despues.defaultSupplierId).toBe(antes.defaultSupplierId);
  });

  it('y también si el maestro no nombra ningún proveedor', async () => {
    const antes = await prisma.product.findUniqueOrThrow({ where: { internalCode: '1211' } });

    await aplicarSincronizacionDeStock(escenario.admin, {
      contenido: respuestaDeStock([comoEnStock({ supplier: null })]),
    });

    const despues = await prisma.product.findUniqueOrThrow({ where: { internalCode: '1211' } });
    expect(despues.defaultSupplierId).toBe(antes.defaultSupplierId);
  });

  it('un nombre que coincide con dos proveedores tampoco se aplica', async () => {
    /*
     * «Reconocido» tiene que querer decir reconocido sin ambigüedad. Elegir uno
     * de dos por el orden en que salieron de la base es reasignarle el
     * proveedor a un artículo por azar.
     */
    const otro = await prisma.supplier.create({
      data: { tradeName: 'Otro Proveedor', legalName: 'Otro S.A.', cuit: '30-99999999-1' },
    });
    await prisma.supplierAlias.create({
      data: {
        supplierId: otro.id,
        alias: 'Distribución Errecalde',
        normalized: normalizeText('Distribución Errecalde'),
      },
    });

    const antes = await prisma.product.findUniqueOrThrow({ where: { internalCode: '1211' } });
    const vista = await vistaPreviaDeStock(escenario.admin, {
      contenido: respuestaDeStock([comoEnStock()]),
    });
    expect(vista.proveedoresAmbiguos).toContain('Distribución Errecalde');

    await aplicarSincronizacionDeStock(escenario.admin, {
      contenido: respuestaDeStock([comoEnStock()]),
    });
    const despues = await prisma.product.findUniqueOrThrow({ where: { internalCode: '1211' } });
    expect(despues.defaultSupplierId).toBe(antes.defaultSupplierId);
    expect(despues.defaultSupplierId).not.toBe(otro.id);
  });

  it('un artículo nuevo con proveedor desconocido se crea sin proveedor, y se avisa', async () => {
    await aplicarSincronizacionDeStock(escenario.admin, {
      contenido: respuestaDeStock([
        comoEnStock({ plu: '8801', name: 'Nuevo', supplier: { id: 'z', name: 'Marca Cualquiera' } }),
      ]),
    });

    const creado = await prisma.product.findUniqueOrThrow({ where: { internalCode: '8801' } });
    expect(creado.defaultSupplierId).toBeNull();
  });

  it('la vista previa distingue «se conserva» de «nuevo sin proveedor»', async () => {
    const vista = await vistaPreviaDeStock(escenario.admin, {
      contenido: respuestaDeStock([
        // Existente con proveedor: se conserva.
        comoEnStock({ supplier: { id: 'x', name: 'Marca Cualquiera' } }),
        // Nuevo: queda sin proveedor.
        comoEnStock({ plu: '8802', name: 'Nuevo', supplier: { id: 'x', name: 'Marca Cualquiera' } }),
      ]),
    });

    const porPlu = new Map(vista.proveedoresSinResolver.map((a) => [a.plu, a]));

    expect(porPlu.get('1211')?.efecto).toBe('Se conserva el proveedor actual');
    expect(porPlu.get('1211')?.actual).toBe('Distribución Errecalde');
    expect(porPlu.get('1211')?.entrante).toBe('Marca Cualquiera');

    expect(porPlu.get('8802')?.efecto).toBe('Artículo nuevo, queda sin proveedor habitual');
    expect(porPlu.get('8802')?.actual).toBeNull();

    // Y el renglón de cambios no propone tocar el proveedor de un existente.
    const cambio = vista.modificados
      .find((m) => m.plu === '1211')
      ?.cambios.find((c) => c.campo === 'Proveedor habitual');
    expect(cambio).toBeUndefined();
  });

  it('un proveedor reconocido sí se aplica, y se ve como antes → después', async () => {
    /*
     * La contracara: conservar no puede significar "no actualizar nunca". Si el
     * maestro nombra un proveedor que Compras sí reconoce, se aplica, y el
     * cambio se ve en la vista previa antes de confirmarlo.
     */
    await prisma.product.update({
      where: { internalCode: '1211' },
      data: { defaultSupplierId: null },
    });

    const vista = await vistaPreviaDeStock(escenario.admin, {
      contenido: respuestaDeStock([comoEnStock()]),
    });
    expect(
      vista.modificados
        .find((m) => m.plu === '1211')
        ?.cambios.find((c) => c.campo === 'Proveedor habitual'),
    ).toEqual({ campo: 'Proveedor habitual', antes: '—', despues: 'Distribución Errecalde' });

    await aplicarSincronizacionDeStock(escenario.admin, {
      contenido: respuestaDeStock([comoEnStock()]),
    });
    const despues = await prisma.product.findUniqueOrThrow({
      where: { internalCode: '1211' },
      include: { defaultSupplier: true },
    });
    expect(despues.defaultSupplier?.tradeName).toBe('Distribución Errecalde');
  });

  it('nunca da de alta un proveedor a partir de un nombre', async () => {
    const antes = await prisma.supplier.count();

    await aplicarSincronizacionDeStock(escenario.admin, {
      contenido: respuestaDeStock([
        comoEnStock({ supplier: { id: 'x', name: 'Fabricante Que No Es Proveedor' } }),
        comoEnStock({ plu: '8803', name: 'Otro', supplier: { id: 'y', name: 'Marca Inventada' } }),
      ]),
    });

    /*
     * Una ficha creada desde un nombre no tiene CUIT, razón social ni
     * condiciones comerciales, y de ahí salen los plazos de pago y la cuenta
     * corriente. Darla de alta sola sería fabricar un acreedor.
     */
    expect(await prisma.supplier.count()).toBe(antes);
  });
});

describe('mirar no escribe', () => {
  it('consultar la vista previa no modifica ningún dato, ni crea familias', async () => {
    const antes = await loQueEsDeCompras();
    const familiasAntes = await prisma.productFamily.count();
    const sincronizadosAntes = await prisma.product.count({
      where: { catalogSyncedAt: { not: null } },
    });

    await vistaPreviaDeStock(escenario.admin, {
      contenido: respuestaDeStock([
        comoEnStock({ name: 'Otro nombre' }),
        comoEnStock({ plu: '7001', name: 'Uno nuevo' }),
        comoEnStock({ plu: '7002', name: 'Otro más', type: { id: 't9', name: 'Embutidos' } }),
      ]),
    });

    expect(await loQueEsDeCompras()).toEqual(antes);
    /*
     * Las familias son el caso fácil de olvidar: se crean antes que los
     * artículos porque los artículos las necesitan, así que es el lugar donde
     * una vista previa escribiría sin darse cuenta.
     */
    expect(await prisma.productFamily.count()).toBe(familiasAntes);
    expect(await prisma.product.count({ where: { catalogSyncedAt: { not: null } } })).toBe(
      sincronizadosAntes,
    );
  });
});

describe('confirmar aplica lo que la vista previa mostró', () => {
  it('crea, actualiza y desactiva, sin borrar ni renumerar', async () => {
    const idAntes = (
      await prisma.product.findUniqueOrThrow({ where: { internalCode: '1211' } })
    ).id;
    const cuantosAntes = await prisma.product.count();

    const vista = await aplicarSincronizacionDeStock(escenario.admin, {
      contenido: respuestaDeStock([
        comoEnStock({ name: 'Cremoso Punta del Agua Premium' }),
        comoEnStock({ plu: '4001', name: 'Provolone' }),
      ]),
    });

    expect(vista.aplicados).toBeGreaterThan(0);

    const actualizado = await prisma.product.findUniqueOrThrow({
      where: { internalCode: '1211' },
    });
    expect(actualizado.normalizedName).toBe('Cremoso Punta del Agua Premium');
    // El mismo artículo, no uno nuevo: el PLU no se renumera nunca.
    expect(actualizado.id).toBe(idAntes);
    expect(actualizado.category).toBe('Quesos');
    expect(actualizado.subtype).toBe('Cremosos');
    // Y quedó clasificado en la familia que sale del **tipo** del maestro.
    expect(actualizado.familyId).not.toBeNull();
    const familia = await prisma.productFamily.findUniqueOrThrow({
      where: { id: actualizado.familyId! },
    });
    expect(familia.name).toBe('Quesos');

    expect(await prisma.product.findUnique({ where: { internalCode: '4001' } })).not.toBeNull();

    /*
     * Nada se borró: los que ya no están en el maestro siguen existiendo, sólo
     * que inactivos. Borrarlos dejaría compras, costos y precios apuntando a
     * un artículo que no existe.
     */
    expect(await prisma.product.count()).toBe(cuantosAntes + 1);
    const viejo = await prisma.product.findUniqueOrThrow({ where: { internalCode: '1001' } });
    expect(viejo.active).toBe(false);
  });

  it('toma la imagen, el proveedor y la unidad del maestro', async () => {
    await aplicarSincronizacionDeStock(escenario.admin, {
      contenido: respuestaDeStock([
        comoEnStock({ internalUnit: 'piece', imageUrl: 'https://stock.example/cremoso.jpg' }),
      ]),
    });
    const p = await prisma.product.findUniqueOrThrow({
      where: { internalCode: '1211' },
      include: { defaultSupplier: true },
    });
    expect(p.purchaseUnit).toBe('UNIT');
    expect(p.imageUrl).toBe('https://stock.example/cremoso.jpg');
    expect(p.defaultSupplier?.tradeName).toBe('Distribución Errecalde');
  });

  it('deja auditoría de la importación', async () => {
    await aplicarSincronizacionDeStock(escenario.admin, {
      contenido: respuestaDeStock([comoEnStock({ name: 'Otro nombre' })]),
    });
    const registro = await prisma.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.STOCK_SYNCED },
      orderBy: { createdAt: 'desc' },
    });
    expect(registro).not.toBeNull();
    expect(registro?.userId).toBe(escenario.admin.id);
    expect(JSON.stringify(registro?.after)).toContain('schemaVersion');
  });
});

describe('correrla dos veces seguidas no propone nada la segunda', () => {
  it('la segunda vista previa no trae ninguna modificación', async () => {
    /*
     * La prueba que dice que lo aplicado es lo que se miró. Si la segunda
     * corrida siguiera proponiendo cambios, sería que algo de lo que la
     * primera escribió no coincide con lo que la comparación espera leer, y
     * cada sincronización estaría reescribiendo las mismas filas para siempre.
     */
    const contenido = respuestaDeStock([
      comoEnStock({ name: 'Cremoso Punta del Agua Premium', imageUrl: 'https://s.example/a.jpg' }),
      comoEnStock({ plu: '4001', name: 'Provolone', internalUnit: 'piece' }),
    ]);

    await aplicarSincronizacionDeStock(escenario.admin, { contenido });

    const segunda = await vistaPreviaDeStock(escenario.admin, { contenido });
    expect(segunda.nuevos).toEqual([]);
    expect(segunda.modificados).toEqual([]);
    expect(segunda.quedarianInactivos).toEqual([]);
    expect(segunda.sinCambios.map((a) => a.plu).sort()).toEqual(['1211', '4001']);
  });

  it('y confirmar de nuevo no escribe una sola fila', async () => {
    const contenido = respuestaDeStock([comoEnStock({ name: 'Cremoso Punta del Agua Premium' })]);
    await aplicarSincronizacionDeStock(escenario.admin, { contenido });

    const despuesDeLaPrimera = await prisma.product.findMany({
      orderBy: { internalCode: 'asc' },
    });
    const auditoriasAntes = await prisma.auditLog.count({
      where: { action: AUDIT_ACTIONS.STOCK_SYNCED },
    });

    const segunda = await aplicarSincronizacionDeStock(escenario.admin, { contenido });
    expect(segunda.aplicados).toBe(0);

    /*
     * Ni siquiera `catalogSyncedAt` se mueve. Si se actualizara, "sin cambios"
     * dejaría igual rastro de escritura y la idempotencia sería sólo aparente.
     */
    expect(await prisma.product.findMany({ orderBy: { internalCode: 'asc' } })).toEqual(
      despuesDeLaPrimera,
    );
    expect(await prisma.auditLog.count({ where: { action: AUDIT_ACTIONS.STOCK_SYNCED } })).toBe(
      auditoriasAntes,
    );
  });
});

describe('lo que es de Compras no se toca', () => {
  it('compras, costos, marcajes, reglas de precio, alias e históricos quedan igual', async () => {
    // Al 1211 se le carga todo lo que es de Compras y nada de Stock.
    const producto = await prisma.product.findUniqueOrThrow({ where: { internalCode: '1211' } });
    await prisma.product.update({
      where: { id: producto.id },
      data: {
        targetMarginPct: '0.33',
        marginBasis: 'SOBRE_VENTA',
        alCorteHormaDigitalMarginPct: '0.21',
        feteadoQuarterMarginPct: '0.66',
        wholeUnitMarginPct: '0.12',
        avgPieceWeightKg: '4.000',
        saleMode: 'AL_CORTE',
      },
    });
    await prisma.costHistory.create({
      data: {
        productId: producto.id,
        supplierId: escenario.proveedorErrecaldeId,
        branchId: escenario.sucursales.devoto,
        date: new Date(),
        unitNetPrice: '1000',
        unitCost: '1000',
      },
    });

    const antes = await loQueEsDeCompras();
    const precioAntes = await suggestPricesFor(producto.id);

    await aplicarSincronizacionDeStock(escenario.admin, {
      contenido: respuestaDeStock([
        comoEnStock({ name: 'Cremoso Punta del Agua Premium', internalUnit: 'kg' }),
      ]),
    });

    const despues = await loQueEsDeCompras();

    // El nombre sí cambió: de eso Control de Stock es la fuente.
    const p = await prisma.product.findUniqueOrThrow({ where: { id: producto.id } });
    expect(p.normalizedName).toBe('Cremoso Punta del Agua Premium');

    // Y nada de lo que es de Compras se movió.
    expect(despues.movimientos).toBe(antes.movimientos);
    expect(despues.costos).toEqual(antes.costos);
    expect(despues.precios).toBe(antes.precios);
    expect(despues.alias).toEqual(antes.alias);
    expect(despues.reglas).toEqual(antes.reglas);
    expect(p.targetMarginPct?.toString()).toBe('0.33');
    expect(p.marginBasis).toBe('SOBRE_VENTA');
    expect(p.alCorteHormaDigitalMarginPct?.toString()).toBe('0.21');
    expect(p.feteadoQuarterMarginPct?.toString()).toBe('0.66');
    expect(p.wholeUnitMarginPct?.toString()).toBe('0.12');
    expect(p.saleMode).toBe('AL_CORTE');

    // Y el precio que sale del cálculo es exactamente el mismo de antes.
    const precioDespues = await suggestPricesFor(producto.id);
    expect(precioDespues.tiers.baseKg?.toFixed(2)).toBe(precioAntes.tiers.baseKg?.toFixed(2));
    const regla = await resolvePricingRule(producto.id);
    expect(regla.marcajes.base.origen).toBe('PRODUCTO');
  });

  it('desactivar un artículo le conserva las compras y el historial', async () => {
    const conCompras = await prisma.product.findUniqueOrThrow({ where: { internalCode: '1001' } });
    const movimientosAntes = await prisma.purchaseMovement.count({
      where: { productId: conCompras.id },
    });

    // El maestro ya no lo nombra.
    await aplicarSincronizacionDeStock(escenario.admin, {
      contenido: respuestaDeStock([comoEnStock()]),
    });

    const despues = await prisma.product.findUniqueOrThrow({ where: { id: conCompras.id } });
    expect(despues.active).toBe(false);
    expect(despues.internalCode).toBe('1001');
    expect(await prisma.purchaseMovement.count({ where: { productId: conCompras.id } })).toBe(
      movimientosAntes,
    );
  });
});

describe('si la validación falla no se aplica nada', () => {
  it('una respuesta inválida deja el catálogo exactamente como estaba', async () => {
    const antes = await loQueEsDeCompras();
    const cuantos = await prisma.product.count();

    for (const malo of [
      respuestaDeStock([comoEnStock()], { ok: false }),
      respuestaDeStock([comoEnStock()], { schemaVersion: '9.9' }),
      respuestaDeStock([comoEnStock()], { usage: { stableKey: 'id' } }),
      respuestaDeStock([comoEnStock(), comoEnStock()]), // PLU repetido
      respuestaDeStock([{ name: 'Sin PLU' }]),
      respuestaDeStock([]),
      'esto no es json',
    ]) {
      await expect(
        aplicarSincronizacionDeStock(escenario.admin, { contenido: malo }),
      ).rejects.toBeInstanceOf(RespuestaDeStockInvalida);
    }

    expect(await prisma.product.count()).toBe(cuantos);
    expect(await loQueEsDeCompras()).toEqual(antes);
  });

  it('la respuesta sin «products» no importa las sucursales', async () => {
    /*
     * El caso concreto que motivó sacar el fallback: la respuesta trae
     * `branches` antes que `products`, y tomar "el primer arreglo" habría dado
     * de alta las tres sucursales como artículos.
     */
    const cuantos = await prisma.product.count();
    const sinProducts = JSON.stringify({
      ok: true,
      schemaVersion: '1.0',
      usage: { stableKey: 'plu' },
      branches: [
        { id: 'b1', name: 'Devoto' },
        { id: 'b2', name: 'Pueyrredón' },
      ],
    });

    await expect(
      aplicarSincronizacionDeStock(escenario.admin, { contenido: sinProducts }),
    ).rejects.toBeInstanceOf(RespuestaDeStockInvalida);

    expect(await prisma.product.count()).toBe(cuantos);
    expect(await prisma.product.findFirst({ where: { normalizedName: 'Devoto' } })).toBeNull();
  });
});
