import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { prisma } from '@/lib/db';
import { limpiarBase, sembrarEscenario, comoUsuario, type Escenario } from './ayudas';
import {
  aprobarUnidadDeExistencia,
  guardarPresentacion,
  convertirAUnidadDeExistencia,
  listarUnidades,
  reconocerDiscrepancia,
  historialDeUnidad,
} from '@/lib/services/stock-erp-unidades';
import { aplicarSincronizacionDeStock } from '@/lib/services/stock-sync';
import { AUDIT_ACTIONS } from '@/lib/services/audit';
import { ADMIN_PERMISSIONS, ALL_PERMISSIONS, PERMISSIONS, PERMISOS_SENSIBLES_DE_STOCK_ERP } from '@/lib/auth/permissions';
import { Decimal } from '@/lib/money';

/**
 * **Stock ERP, fase 2: las unidades y quién las decide.**
 *
 * Lo que se prueba acá no es que el código corra: es que las cuatro unidades
 * sigan siendo cuatro cosas distintas, y que ninguna de las tres externas pueda
 * convertirse sola en la del libro.
 *
 * La sincronización del catálogo NO se ejecuta contra Control de Stock. Se usa
 * un doble del transporte: lo que se prueba es qué escribe el servicio cuando
 * recibe un catálogo, no que se pueda llegar a otra aplicación.
 */

let escenario: Escenario;
/**
 * Un usuario al que se le OTORGÓ el permiso sensible.
 *
 * El administrador de fábrica ya no lo trae —ésa es justamente la garantía que
 * se prueba más abajo—, así que las pruebas que aprueban unidades usan a
 * alguien nombrado, igual que en la vida real.
 */
let configurador: ReturnType<typeof comoUsuario>;

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();
  configurador = comoUsuario({
    id: escenario.admin.id,
    email: escenario.admin.email,
    name: escenario.admin.name,
    branchId: null,
    roleId: escenario.admin.roleId,
    roleCode: escenario.admin.roleCode,
    roleName: escenario.admin.roleName,
    permissions: [...escenario.admin.permissions, PERMISSIONS.STOCKERP_UNIDADES_CONFIGURAR],
    scopeAllBranches: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ========================================================================== *
 * Un catálogo de mentira, que nunca sale a la red.
 * ========================================================================== */

/** El catálogo tal como lo devolvería Control de Stock, como TEXTO. */
function respuestaDeStock(productos: unknown[]) {
  return JSON.stringify({
    ok: true,
    schemaVersion: '1.0',
    usage: { stableKey: 'plu' },
    branches: [{ id: 'b1', name: 'Devoto' }],
    products: productos,
  });
}

const CATALOGO_FALSO = [
  { plu: '7001', name: 'QUESO DE PRUEBA', type: { id: 't1', name: 'Quesos' }, internalUnit: 'kg', active: true },
  { plu: '7002', name: 'LATA DE PRUEBA', type: { id: 't2', name: 'Conservas' }, internalUnit: 'unidad', active: true },
  /* Sin `internalUnit`: el catálogo no siempre la trae, y ese caso importa. */
  { plu: '7003', name: 'SIN UNIDAD DECLARADA', type: { id: 't3', name: 'Varios' }, active: true },
];

/**
 * Sincroniza **sin red**, y no por un doble sino por el camino que el propio
 * servicio ofrece: `contenido` recibe el catálogo ya descargado.
 *
 * Es mejor que espiar el transporte. Un espía se puede quitar sin que nadie se
 * entere; acá, sencillamente, no hay ninguna llamada que hacer. La prueba de
 * que nadie sale a la red no depende de recordar poner el espía.
 */
async function sincronizarConDoble(articulos: unknown[]) {
  return aplicarSincronizacionDeStock(escenario.admin, { contenido: respuestaDeStock(articulos) });
}

async function productoDePrueba(plu = '7001', unidadCatalogo: 'KG' | 'UNIT' | null = 'KG') {
  return prisma.product.create({
    data: {
      internalCode: plu,
      normalizedName: `ARTICULO ${plu}`,
      purchaseUnit: 'KG',
      ...(unidadCatalogo ? { catalogUnit: unidadCatalogo } : {}),
      saleMode: 'AL_CORTE',
      targetMarginPct: '0.45',
      marginBasis: 'SOBRE_COSTO',
      cashDiscountPct: '0',
      roundingRule: 'NEAREST_100',
    },
  });
}

/* ========================================================================== */

describe('la sincronización informa, pero no decide', () => {
  it('escribe catalogUnit y conserva el comportamiento legado de purchaseUnit', async () => {
    await sincronizarConDoble(CATALOGO_FALSO);

    const queso = await prisma.product.findUniqueOrThrow({ where: { internalCode: '7001' } });
    const lata = await prisma.product.findUniqueOrThrow({ where: { internalCode: '7002' } });

    /* La columna nueva guarda el dato externo… */
    expect(queso.catalogUnit).toBe('KG');
    expect(lata.catalogUnit).toBe('UNIT');
    /* …y la vieja sigue haciendo exactamente lo que hacía. */
    expect(queso.purchaseUnit).toBe('KG');
    expect(lata.purchaseUnit).toBe('UNIT');
  });

  it('si el catálogo no trae unidad, no inventa ninguna', async () => {
    await sincronizarConDoble(CATALOGO_FALSO);
    const sinUnidad = await prisma.product.findUniqueOrThrow({ where: { internalCode: '7003' } });
    /*
     * Nulo, no 'KG'. Un nulo se lee como «no lo sé todavía»; un KG por omisión
     * se leería como un dato del catálogo que nadie puede demostrar.
     */
    expect(sinUnidad.catalogUnit).toBeNull();
  });

  it('no crea ni modifica configuraciones de existencia ni presentaciones', async () => {
    await sincronizarConDoble(CATALOGO_FALSO);
    expect(await prisma.productStockConfig.count()).toBe(0);
    expect(await prisma.productPurchasePresentation.count()).toBe(0);
  });

  it('no pisa una unidad de existencia ya aprobada', async () => {
    const p = await productoDePrueba('7001', 'KG');
    await aprobarUnidadDeExistencia(configurador, {
      productId: p.id,
      unidad: 'UNIT',
      confirmado: true,
    });

    /* El catálogo ahora dice KG. La existencia aprobada dice UNIT. */
    await sincronizarConDoble(CATALOGO_FALSO);

    const cfg = await prisma.productStockConfig.findUniqueOrThrow({ where: { productId: p.id } });
    expect(cfg.stockUnit, 'la sincronización no gobierna la unidad de existencia').toBe('UNIT');
    expect(cfg.status).toBe('APROBADA');
  });

  it('un producto nuevo del catálogo queda pendiente y bloqueado', async () => {
    await sincronizarConDoble(CATALOGO_FALSO);
    const lista = await listarUnidades(escenario.admin, {});
    const nuevo = lista.find((x) => x.plu === '7001');
    expect(nuevo, 'el artículo nuevo tiene que aparecer en el circuito').toBeDefined();
    expect(nuevo!.estado).toBe('PENDIENTE');
    expect(nuevo!.bloqueado, 'sin unidad aprobada no se puede mover').toBe(true);
    expect(nuevo!.unidadDeExistencia).toBeNull();
  });

  it('una unidad del catálogo distinta de la aprobada se muestra como advertencia, sin cambiar nada', async () => {
    const p = await productoDePrueba('7002', 'UNIT');
    await aprobarUnidadDeExistencia(configurador, { productId: p.id, unidad: 'KG', confirmado: true });

    const estado = (await listarUnidades(escenario.admin, {})).find((x) => x.plu === '7002')!;
    expect(estado.discrepancia, 'la diferencia se informa').toBe(true);
    expect(estado.unidadDelCatalogo).toBe('UNIT');
    expect(estado.unidadDeExistencia, 'y no se corrige sola').toBe('KG');
  });

  it('no normaliza en silencio: la discrepancia se reconoce a mano y queda registrada', async () => {
    const p = await productoDePrueba('7002', 'UNIT');
    await aprobarUnidadDeExistencia(configurador, { productId: p.id, unidad: 'KG', confirmado: true });
    await reconocerDiscrepancia(configurador, {
      productId: p.id,
      motivo: 'El proveedor factura cajas y el local cuenta kilos.',
    });

    const asiento = await prisma.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.STOCKERP_DISCREPANCIA_RECONOCIDA },
    });
    expect(asiento).not.toBeNull();
    expect(asiento!.userId).toBe(escenario.admin.id);

    /* Y la unidad sigue siendo la que se aprobó: reconocer no es corregir. */
    const cfg = await prisma.productStockConfig.findUniqueOrThrow({ where: { productId: p.id } });
    expect(cfg.stockUnit).toBe('KG');
  });

  it('no realiza ninguna llamada externa', async () => {
    const espia = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('NADIE PUEDE SALIR A LA RED EN ESTA RONDA');
    });
    const p = await productoDePrueba('7010', 'KG');
    await aprobarUnidadDeExistencia(configurador, { productId: p.id, unidad: 'KG', confirmado: true });
    await guardarPresentacion(configurador, {
      productId: p.id,
      unidadDeCompra: 'UNIT',
      factor: '12',
      aprobar: true,
      confirmado: true,
    });
    await convertirAUnidadDeExistencia({ productId: p.id, unidadFacturada: 'UNIT', cantidad: '3' });
    expect(espia).not.toHaveBeenCalled();
  });
});

describe('aprobar una unidad es una decisión con nombre', () => {
  it('exige el permiso, y el rechazo queda auditado', async () => {
    const p = await productoDePrueba();
    const sinPermiso = comoUsuario({
      id: escenario.operadorDevoto.id,
      email: 'op@dongines.local',
      name: 'Operador',
      branchId: escenario.sucursales.devoto,
      roleId: escenario.operadorDevoto.roleId,
      roleCode: 'OPERADOR',
      roleName: 'Operador',
      permissions: [PERMISSIONS.STOCKERP_VER],
      scopeAllBranches: false,
    });

    await expect(
      aprobarUnidadDeExistencia(sinPermiso, { productId: p.id, unidad: 'KG', confirmado: true }),
    ).rejects.toThrow(/permiso/i);

    const rechazo = await prisma.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.STOCKERP_INTENTO_RECHAZADO },
    });
    expect(rechazo, 'el intento rechazado se audita').not.toBeNull();
    expect(await prisma.productStockConfig.count(), 'y no escribe nada').toBe(0);
  });

  it('exige la doble confirmación, también del lado del servidor', async () => {
    const p = await productoDePrueba();
    await expect(
      aprobarUnidadDeExistencia(configurador, { productId: p.id, unidad: 'KG', confirmado: false }),
    ).rejects.toThrow(/confirmar/i);
    expect(await prisma.productStockConfig.count()).toBe(0);
  });

  it('guarda aprobador, fecha y el asiento de auditoría', async () => {
    const p = await productoDePrueba();
    await aprobarUnidadDeExistencia(configurador, {
      productId: p.id,
      unidad: 'KG',
      confirmado: true,
      notas: 'Se cuenta por kilo.',
    });
    const cfg = await prisma.productStockConfig.findUniqueOrThrow({ where: { productId: p.id } });
    expect(cfg.status).toBe('APROBADA');
    expect(cfg.stockUnit).toBe('KG');
    expect(cfg.approvedById).toBe(escenario.admin.id);
    expect(cfg.approvedAt).toBeInstanceOf(Date);
    expect(cfg.notes).toBe('Se cuenta por kilo.');

    const asiento = await prisma.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.STOCKERP_CONFIG_CREADA },
    });
    expect(asiento!.userId).toBe(escenario.admin.id);
  });

  it('cambiar una unidad ya aprobada exige motivo, y queda en el historial', async () => {
    const p = await productoDePrueba();
    await aprobarUnidadDeExistencia(configurador, { productId: p.id, unidad: 'KG', confirmado: true });

    await expect(
      aprobarUnidadDeExistencia(configurador, { productId: p.id, unidad: 'UNIT', confirmado: true }),
    ).rejects.toThrow(/motivo/i);

    await aprobarUnidadDeExistencia(configurador, {
      productId: p.id,
      unidad: 'UNIT',
      confirmado: true,
      motivo: 'El proveedor pasó a entregar por unidad.',
    });

    const historial = await historialDeUnidad(escenario.admin, p.id);
    const cambio = historial.find((h) => h.antes === 'KG' && h.despues === 'UNIT');
    expect(cambio, 'el cambio queda con su valor anterior').toBeDefined();
    expect(cambio!.reason).toMatch(/proveedor/i);
    expect(cambio!.userId).toBe(escenario.admin.id);
  });

  it('un artículo CON movimientos no se puede reinterpretar', async () => {
    const p = await productoDePrueba();
    await aprobarUnidadDeExistencia(configurador, { productId: p.id, unidad: 'KG', confirmado: true });

    /*
     * Se planta una fila en el libro. Es la única prueba de esta ronda que
     * escribe en `stock_ledger`, y lo hace para comprobar que la barrera
     * existe ANTES de que haya movimientos de verdad. Se limpia al final por
     * el `limpiarBase` del siguiente caso.
     */
    /*
     * Un movimiento de verdad en el libro, escrito con SQL directo como en las
     * garantías de la fase 1: el libro exige una operación, una clave de
     * idempotencia y el saldo por orden de registración, y los disparadores no
     * dejan escribir de otra forma. Se planta para comprobar que la barrera ya
     * está puesta ANTES de que existan movimientos de verdad.
     */
    const operacionId = 'op-barrera-1';
    await prisma.$executeRawUnsafe(
      `INSERT INTO "stock_operation" ("id","operationKey","kind","contentHash","branchId","requestedById")
       VALUES ($1,$2,'ACTIVACION'::"StockOperationKind",$3,$4,$5)`,
      operacionId,
      'clave-barrera-1',
      'huella-barrera-1',
      escenario.sucursales.devoto,
      escenario.admin.id,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "stock_ledger"
         ("id","txId","productId","pluHistorico","branchId","type","direction",
          "quantity","unit","effectiveAt","operationId","idempotencyKey","balanceAfterSeq")
       VALUES ($1, txid_current(), $2, $3, $4, 'OPENING_BALANCE'::"StockMovementType",
               'IN'::"StockDirection", 10::numeric, 'KG'::"StockUnit",
               '2026-09-21T12:00:00Z', $5, $6, 10::numeric)`,
      'mov-barrera-1',
      p.id,
      p.internalCode,
      escenario.sucursales.devoto,
      operacionId,
      'idem-barrera-1',
    );

    await expect(
      aprobarUnidadDeExistencia(configurador, {
        productId: p.id,
        unidad: 'UNIT',
        confirmado: true,
        motivo: 'Quiero cambiarla igual.',
      }),
    ).rejects.toThrow(/movimientos|reinterpretar/i);

    const cfg = await prisma.productStockConfig.findUniqueOrThrow({ where: { productId: p.id } });
    expect(cfg.stockUnit, 'la unidad no se movió').toBe('KG');
  });
});

describe('las presentaciones de compra no inventan equivalencias', () => {
  it('sin conversión aprobada, una unidad incompatible queda bloqueada', async () => {
    const p = await productoDePrueba();
    await aprobarUnidadDeExistencia(configurador, { productId: p.id, unidad: 'KG', confirmado: true });

    const r = await convertirAUnidadDeExistencia({
      productId: p.id,
      unidadFacturada: 'UNIT',
      cantidad: '3',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toMatch(/no hay una conversión aprobada/i);
  });

  it('sin unidad aprobada, tampoco convierte', async () => {
    const p = await productoDePrueba();
    const r = await convertirAUnidadDeExistencia({ productId: p.id, unidadFacturada: 'KG', cantidad: '1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toMatch(/unidad de existencia aprobada/i);
  });

  it('con conversión aprobada usa decimal exacto', async () => {
    const p = await productoDePrueba();
    await aprobarUnidadDeExistencia(configurador, { productId: p.id, unidad: 'KG', confirmado: true });
    await guardarPresentacion(configurador, {
      productId: p.id,
      unidadDeCompra: 'UNIT',
      /* Una horma de 4,250 kg: el caso donde el binario se nota. */
      factor: '4.250',
      descripcion: 'Horma entera',
      aprobar: true,
      confirmado: true,
    });

    const r = await convertirAUnidadDeExistencia({
      productId: p.id,
      unidadFacturada: 'UNIT',
      cantidad: '3',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      /* 3 × 4,250 = 12,750 exacto. Con Number daría 12.749999999999998. */
      expect(r.cantidadEnUnidadDeExistencia.equals(new Decimal('12.750'))).toBe(true);
      expect(r.unidad).toBe('KG');
    }
  });

  it('el factor tiene que ser positivo, y lo exige también la base', async () => {
    const p = await productoDePrueba();
    await expect(
      guardarPresentacion(configurador, {
        productId: p.id,
        unidadDeCompra: 'UNIT',
        factor: '0',
        aprobar: false,
        confirmado: true,
      }),
    ).rejects.toThrow(/mayor que cero/i);

    /* Y saltándose el servicio, la base tampoco lo acepta. */
    await expect(
      prisma.productPurchasePresentation.create({
        data: { productId: p.id, purchaseUnit: 'UNIT', conversionFactor: '-1' },
      }),
    ).rejects.toThrow();
  });

  it('una presentación por artículo, proveedor y código', async () => {
    const p = await productoDePrueba();
    await guardarPresentacion(configurador, {
      productId: p.id,
      proveedorId: escenario.proveedorId,
      codigoDelProveedor: 'A1',
      unidadDeCompra: 'UNIT',
      factor: '12',
      aprobar: true,
      confirmado: true,
    });
    /* El servicio actualiza la existente en vez de duplicar. */
    await guardarPresentacion(configurador, {
      productId: p.id,
      proveedorId: escenario.proveedorId,
      codigoDelProveedor: 'A1',
      unidadDeCompra: 'UNIT',
      factor: '24',
      aprobar: true,
      confirmado: true,
    });
    const filas = await prisma.productPurchasePresentation.findMany({ where: { productId: p.id } });
    expect(filas).toHaveLength(1);
    expect(filas[0].conversionFactor.toString()).toBe('24');

    /* Y la base rechaza el duplicado si alguien lo intenta por abajo. */
    await expect(
      prisma.productPurchasePresentation.create({
        data: {
          productId: p.id,
          supplierId: escenario.proveedorId,
          supplierCode: 'A1',
          purchaseUnit: 'UNIT',
          conversionFactor: '99',
        },
      }),
    ).rejects.toThrow();
  });

  it('prefiere la presentación del proveedor y código antes que la genérica', async () => {
    const p = await productoDePrueba();
    await aprobarUnidadDeExistencia(configurador, { productId: p.id, unidad: 'KG', confirmado: true });
    await guardarPresentacion(configurador, {
      productId: p.id,
      unidadDeCompra: 'UNIT',
      factor: '1',
      aprobar: true,
      confirmado: true,
    });
    await guardarPresentacion(configurador, {
      productId: p.id,
      proveedorId: escenario.proveedorId,
      codigoDelProveedor: 'CAJA12',
      unidadDeCompra: 'UNIT',
      factor: '12',
      aprobar: true,
      confirmado: true,
    });

    const r = await convertirAUnidadDeExistencia({
      productId: p.id,
      unidadFacturada: 'UNIT',
      cantidad: '2',
      proveedorId: escenario.proveedorId,
      codigoDelProveedor: 'CAJA12',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.factor).toBe('12');
  });

  it('una presentación PENDIENTE no sirve para convertir', async () => {
    const p = await productoDePrueba();
    await aprobarUnidadDeExistencia(configurador, { productId: p.id, unidad: 'KG', confirmado: true });
    await guardarPresentacion(configurador, {
      productId: p.id,
      unidadDeCompra: 'UNIT',
      factor: '12',
      aprobar: false,
      confirmado: true,
    });
    const r = await convertirAUnidadDeExistencia({
      productId: p.id,
      unidadFacturada: 'UNIT',
      cantidad: '1',
    });
    expect(r.ok, 'cargada no es lo mismo que aprobada').toBe(false);
  });
});

describe('los permisos no se reparten solos', () => {
  it('una base nueva no entrega los permisos sensibles automáticamente', () => {
    for (const sensible of PERMISOS_SENSIBLES_DE_STOCK_ERP) {
      expect(
        ADMIN_PERMISSIONS.includes(sensible),
        `«${sensible}» no puede venir en el rol administrador de fábrica`,
      ).toBe(false);
    }
    /* Y los de sólo lectura sí, que para eso son de sólo lectura. */
    expect(ADMIN_PERMISSIONS).toContain(PERMISSIONS.STOCKERP_VER);
    expect(ADMIN_PERMISSIONS).toContain(PERMISSIONS.STOCKERP_AUDITORIA_VER);
  });

  it('stock.sincronizar no cambia de significado ni de dueño', () => {
    /* Sigue existiendo, sigue diciendo lo mismo y sigue en el rol de siempre. */
    expect(PERMISSIONS.STOCK_SINCRONIZAR).toBe('stock.sincronizar');
    expect(ALL_PERMISSIONS).toContain('stock.sincronizar');
    expect(ADMIN_PERMISSIONS).toContain(PERMISSIONS.STOCK_SINCRONIZAR);
    expect(
      PERMISOS_SENSIBLES_DE_STOCK_ERP.includes(PERMISSIONS.STOCK_SINCRONIZAR),
      'no se reasigna a Stock ERP: pertenece al transporte externo retirado',
    ).toBe(false);
  });

  it('resembrar no le agrega permisos a un rol que ya existe', async () => {
    const antes = await prisma.role.findFirstOrThrow({ where: { code: 'OPERADOR' } });
    const permisosAntes = [...(antes.permissions as string[])];

    /* El seed productivo usa upsert con update: {}. Se reproduce acá. */
    await prisma.role.upsert({
      where: { code: 'OPERADOR' },
      update: {},
      create: {
        code: 'OPERADOR',
        name: 'Operador',
        permissions: ADMIN_PERMISSIONS,
        scopeAllBranches: true,
        isSystem: true,
      },
    });

    const despues = await prisma.role.findFirstOrThrow({ where: { code: 'OPERADOR' } });
    expect(despues.permissions).toEqual(permisosAntes);
    for (const sensible of PERMISOS_SENSIBLES_DE_STOCK_ERP) {
      expect(despues.permissions as string[]).not.toContain(sensible);
    }
  });
});

describe('Stock ERP sigue inactivo', () => {
  it('el libro, los saldos y las operaciones siguen sin filas', async () => {
    const p = await productoDePrueba();
    await aprobarUnidadDeExistencia(configurador, { productId: p.id, unidad: 'KG', confirmado: true });
    await guardarPresentacion(configurador, {
      productId: p.id,
      unidadDeCompra: 'UNIT',
      factor: '12',
      aprobar: true,
      confirmado: true,
    });

    expect(await prisma.stockLedger.count()).toBe(0);
    expect(await prisma.stockBalance.count()).toBe(0);
    expect(await prisma.stockOperation.count()).toBe(0);
  });

  it('StockOutbox sigue en cero: Control de Stock no recibe movimientos', async () => {
    const p = await productoDePrueba();
    await aprobarUnidadDeExistencia(configurador, { productId: p.id, unidad: 'KG', confirmado: true });
    expect(await prisma.stockOutbox.count()).toBe(0);
  });
});
