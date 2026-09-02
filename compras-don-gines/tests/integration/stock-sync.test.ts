import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { ForbiddenError } from '@/lib/errors';
import {
  RespuestaDeStockInvalida,
  aplicarSincronizacionDeStock,
  vistaPreviaDeStock,
} from '@/lib/services/stock-sync';
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
    // Y quedó clasificado en la familia que sale del subtipo del maestro.
    expect(actualizado.familyId).not.toBeNull();
    const familia = await prisma.productFamily.findUniqueOrThrow({
      where: { id: actualizado.familyId! },
    });
    expect(familia.name).toBe('Cremosos');

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
