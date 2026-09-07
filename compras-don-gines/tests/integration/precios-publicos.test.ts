import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '@/lib/db';
import { limpiarBase, sembrarEscenario, type Escenario } from './ayudas';
import { normalizeText } from '@/lib/domain/matching';
import {
  CONSULTAS_POR_MINUTO,
  reiniciarLimiteDeFrecuencia,
} from '@/lib/services/precios-publicos';

/**
 * El catálogo de precios que Compras le entrega a Pedidos Don Ginés.
 *
 * Es la única puerta de esta aplicación que da hacia afuera, así que lo que se
 * prueba acá no es sólo que funcione: es sobre todo **qué no sale**. Compras
 * sabe lo que costó cada artículo, a quién se le compró, cuánto se le debe y
 * qué margen deja; nada de eso puede aparecer en la respuesta, ni adentro de un
 * objeto anidado, ni en un mensaje de error.
 *
 * Se recorre la ruta HTTP de verdad, con un `Request` real. Llamar por dentro a
 * la función que arma el catálogo no probaría la autenticación, ni los
 * encabezados, ni la forma de la respuesta, que es justamente la mitad que
 * importa de una integración.
 */

let escenario: Escenario;
const CLAVE = 'clave-de-prueba-que-no-es-un-secreto-real';

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();
  process.env.PRICES_INTEGRATION_KEY = CLAVE;
  // El tope de frecuencia vive en el módulo y sobrevive entre pruebas.
  reiniciarLimiteDeFrecuencia();
});

afterEach(() => {
  delete process.env.PRICES_INTEGRATION_KEY;
});

async function consultar(
  opciones: { branch?: string | null; authorization?: string | null } = {},
) {
  const { GET } = await import('@/app/api/integrations/public-prices/route');
  const url = new URL('http://localhost/api/integrations/public-prices');
  const branch = opciones.branch === undefined ? 'devoto' : opciones.branch;
  if (branch !== null) url.searchParams.set('branch', branch);

  const headers = new Headers({ Accept: 'application/json' });
  const auth = opciones.authorization === undefined ? `Bearer ${CLAVE}` : opciones.authorization;
  if (auth !== null) headers.set('Authorization', auth);

  const respuesta = await GET(new Request(url, { headers }));
  return {
    estado: respuesta.status,
    encabezados: respuesta.headers,
    cuerpo: await respuesta.json(),
  };
}

/**
 * Le aprueba un precio de venta a un producto ya sembrado.
 *
 * Se escribe directo en el historial y no por el servicio de aprobación a
 * propósito: lo que se prueba acá es la exportación, y hacerla depender de que
 * el producto tenga una compra previa metería en estas pruebas media aplicación.
 */
async function conPrecio(
  productId: string,
  precioPorKilo: string,
  overrides: { validFrom?: Date; pricePer100g?: string; pricePerQuarter?: string } = {},
) {
  const base = Number(precioPorKilo);
  await prisma.salePriceHistory.create({
    data: {
      productId,
      costBasis: '1000',
      marginBasis: 'SOBRE_COSTO',
      marginPct: '0.45',
      suggestedPricePerKg: precioPorKilo,
      approvedPricePerKg: precioPorKilo,
      pricePer100g: overrides.pricePer100g ?? (base / 10).toFixed(4),
      pricePerQuarter: overrides.pricePerQuarter ?? (base / 4).toFixed(4),
      cashDiscountPct: '0',
      validFrom: overrides.validFrom ?? new Date('2026-01-01T00:00:00Z'),
    },
  });
}

/** Un producto nuevo, con lo mínimo para poder publicarlo. */
async function nuevoProducto(
  datos: Partial<{
    internalCode: string;
    normalizedName: string;
    category: string | null;
    saleMode: 'FETEABLE' | 'AL_CORTE';
    usesPlu: boolean;
    active: boolean;
  }> = {},
) {
  const nombre = datos.normalizedName ?? 'Producto de prueba';
  return prisma.product.create({
    data: {
      internalCode: datos.internalCode ?? '9001',
      normalizedName: nombre,
      category: datos.category === undefined ? 'Quesos' : datos.category,
      purchaseUnit: 'KG',
      saleMode: datos.saleMode ?? 'FETEABLE',
      usesPlu: datos.usesPlu ?? true,
      active: datos.active ?? true,
      targetMarginPct: '0.45',
      marginBasis: 'SOBRE_COSTO',
      cashDiscountPct: '0',
      roundingRule: 'NEAREST_100',
      aliases: {
        create: { alias: nombre, normalized: normalizeText(nombre), origin: 'MANUAL' },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// 1 a 5: la puerta
// ---------------------------------------------------------------------------

describe('la puerta: quién puede leer el catálogo', () => {
  it('con la clave correcta, contesta el catálogo', async () => {
    const p = await nuevoProducto();
    await conPrecio(p.id, '10900');

    const r = await consultar();
    expect(r.estado).toBe(200);
    expect(r.cuerpo.ok).toBe(true);
    expect(r.cuerpo.schemaVersion).toBe('1.0');
    expect(typeof r.cuerpo.generatedAt).toBe('string');
    expect(Array.isArray(r.cuerpo.items)).toBe(true);
  });

  it('sin encabezado Authorization, 401', async () => {
    const r = await consultar({ authorization: null });
    expect(r.estado).toBe(401);
    expect(r.cuerpo.items).toBeUndefined();
  });

  it('con la clave equivocada, 401', async () => {
    const r = await consultar({ authorization: 'Bearer otra-clave-cualquiera' });
    expect(r.estado).toBe(401);
  });

  it('sin la variable configurada, el endpoint queda cerrado', async () => {
    /*
     * Cerrado, no abierto. Una integración que se abre sola cuando falta su
     * secreto es peor que una que no funciona: el día que alguien despliega sin
     * cargar la variable, el catálogo queda público y nadie se entera.
     */
    delete process.env.PRICES_INTEGRATION_KEY;
    const r = await consultar();
    expect(r.estado).toBe(401);
  });

  it('exige el esquema Bearer exacto', async () => {
    // La clave sola, otro esquema, y el esquema en minúscula: ninguno pasa.
    expect((await consultar({ authorization: CLAVE })).estado).toBe(401);
    expect((await consultar({ authorization: `Basic ${CLAVE}` })).estado).toBe(401);
    expect((await consultar({ authorization: `bearer ${CLAVE}` })).estado).toBe(401);
    expect((await consultar({ authorization: `Bearer${CLAVE}` })).estado).toBe(401);
    expect((await consultar({ authorization: 'Bearer ' })).estado).toBe(401);
  });

  it('las tres negativas contestan exactamente lo mismo', async () => {
    /*
     * Si «sin encabezado», «clave incorrecta» y «sin configurar» contestaran
     * distinto, quien prueba sabría en qué se está equivocando y podría deducir
     * cómo está configurado el servicio. Son la misma puerta cerrada.
     */
    const sinEncabezado = await consultar({ authorization: null });
    const claveMala = await consultar({ authorization: 'Bearer no-es-la-clave' });
    delete process.env.PRICES_INTEGRATION_KEY;
    const sinVariable = await consultar();

    expect(sinEncabezado.cuerpo).toEqual(claveMala.cuerpo);
    expect(sinEncabezado.cuerpo).toEqual(sinVariable.cuerpo);
    expect(sinEncabezado.estado).toBe(sinVariable.estado);
  });
});

// ---------------------------------------------------------------------------
// 6 y 7: la sucursal
// ---------------------------------------------------------------------------

describe('la sucursal', () => {
  it('acepta las tres, y les da el mismo precio', async () => {
    const p = await nuevoProducto();
    await conPrecio(p.id, '10900');

    const precios: number[] = [];
    for (const branch of ['devoto', 'pueyrredon', 'san_martin']) {
      const r = await consultar({ branch });
      expect(r.estado, branch).toBe(200);
      expect(r.cuerpo.items).toHaveLength(1);
      precios.push(r.cuerpo.items[0].unitPrice);
    }
    // Mientras los precios sean iguales, se devuelve el mismo sin inventar
    // diferencias entre sucursales.
    expect(new Set(precios).size).toBe(1);
  });

  it('cualquier otra sucursal es 400, y también su ausencia', async () => {
    expect((await consultar({ branch: 'caballito' })).estado).toBe(400);
    expect((await consultar({ branch: 'DEVOTO' })).estado).toBe(400);
    expect((await consultar({ branch: '' })).estado).toBe(400);
    // Ausente tampoco: «aceptar únicamente estas tres» incluye no adivinar.
    expect((await consultar({ branch: null })).estado).toBe(400);
  });

  it('la sucursal se valida después de la clave', async () => {
    // Una sucursal inválida sin clave contesta 401, no 400: sin credencial no
    // se contesta nada sobre cómo son los parámetros.
    const r = await consultar({ branch: 'caballito', authorization: null });
    expect(r.estado).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 8 a 13: qué entra y qué no
// ---------------------------------------------------------------------------

describe('qué artículos se publican', () => {
  it('sólo los activos', async () => {
    const activo = await nuevoProducto({ internalCode: '9001', normalizedName: 'Activo' });
    const inactivo = await nuevoProducto({
      internalCode: '9002',
      normalizedName: 'Dado de baja',
      active: false,
    });
    await conPrecio(activo.id, '10900');
    await conPrecio(inactivo.id, '9900');

    const r = await consultar();
    expect(r.cuerpo.items.map((i: { plu: string }) => i.plu)).toEqual(['9001']);
  });

  it('excluye el que no se identifica por PLU', async () => {
    const conPlu = await nuevoProducto({ internalCode: '9001', normalizedName: 'Con PLU' });
    const porCodigoDeBarras = await nuevoProducto({
      internalCode: '9002',
      normalizedName: 'Botella de tomate',
      usesPlu: false,
    });
    await conPrecio(conPlu.id, '10900');
    await conPrecio(porCodigoDeBarras.id, '2500');

    const r = await consultar();
    expect(r.cuerpo.items.map((i: { plu: string }) => i.plu)).toEqual(['9001']);
  });

  it('excluye el que no tiene precio aprobado', async () => {
    await nuevoProducto({ internalCode: '9001', normalizedName: 'Sin precio' });
    const conPrecioAprobado = await nuevoProducto({
      internalCode: '9002',
      normalizedName: 'Con precio',
    });
    await conPrecio(conPrecioAprobado.id, '10900');

    const r = await consultar();
    expect(r.cuerpo.items.map((i: { plu: string }) => i.plu)).toEqual(['9002']);
  });

  it('excluye los precios que no son mayores que cero', async () => {
    const enCero = await nuevoProducto({ internalCode: '9001', normalizedName: 'En cero' });
    const bueno = await nuevoProducto({ internalCode: '9002', normalizedName: 'Bueno' });
    await conPrecio(enCero.id, '0', { pricePer100g: '0', pricePerQuarter: '0' });
    await conPrecio(bueno.id, '10900');

    const r = await consultar();
    expect(r.cuerpo.items.map((i: { plu: string }) => i.plu)).toEqual(['9002']);
  });

  it('cada PLU aparece una sola vez', async () => {
    /*
     * Un artículo con dos precios aprobados —el de antes y el nuevo— tiene que
     * salir una vez, con el vigente. Si saliera dos veces, Pedidos mostraría el
     * mismo producto duplicado con dos precios distintos.
     */
    const p = await nuevoProducto({ internalCode: '9001' });
    await conPrecio(p.id, '9000', { validFrom: new Date('2026-01-01T00:00:00Z') });
    await conPrecio(p.id, '10900', { validFrom: new Date('2026-06-01T00:00:00Z') });

    const r = await consultar();
    expect(r.cuerpo.items).toHaveLength(1);
    expect(r.cuerpo.items[0].unitPrice).toBe(10900);
  });

  it('un precio que empieza a regir mañana todavía no se publica', async () => {
    const p = await nuevoProducto({ internalCode: '9001' });
    await conPrecio(p.id, '9000', { validFrom: new Date('2026-01-01T00:00:00Z') });
    await conPrecio(p.id, '99000', {
      validFrom: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    const r = await consultar();
    expect(r.cuerpo.items[0].unitPrice).toBe(9000);
  });

  it('excluye el artículo cuyo precio normal no es único', async () => {
    /*
     * El precio por 100 g y el del cuarto son otra escritura del mismo precio
     * por kilo. Si al llevarlos al kilo no coinciden, este artículo tiene más de
     * un precio normal, y elegir uno sería elegir al azar cuánto le cobramos al
     * cliente.
     */
    const incoherente = await nuevoProducto({ internalCode: '9001', normalizedName: 'Incoherente' });
    const coherente = await nuevoProducto({ internalCode: '9002', normalizedName: 'Coherente' });
    await conPrecio(incoherente.id, '10900', { pricePer100g: '1500', pricePerQuarter: '2725' });
    await conPrecio(coherente.id, '10900');

    const r = await consultar();
    expect(r.cuerpo.items.map((i: { plu: string }) => i.plu)).toEqual(['9002']);
  });

  it('publica los dos modos de venta que existen, los dos por kilo', async () => {
    const alCorte = await nuevoProducto({
      internalCode: '9001',
      normalizedName: 'Al corte',
      saleMode: 'AL_CORTE',
    });
    const feteable = await nuevoProducto({
      internalCode: '9002',
      normalizedName: 'Feteable',
      saleMode: 'FETEABLE',
    });
    await conPrecio(alCorte.id, '8900');
    await conPrecio(feteable.id, '10900');

    const r = await consultar();
    expect(r.cuerpo.items).toHaveLength(2);
    for (const item of r.cuerpo.items) {
      expect(item.unit).toBe('kg');
      expect(item.step).toBe(0.1);
      expect(item.defaultQuantity).toBe(0.5);
    }
  });

  it('el orden es estable entre dos consultas iguales', async () => {
    for (const codigo of ['9003', '9001', '9002']) {
      const p = await nuevoProducto({ internalCode: codigo, normalizedName: `Art ${codigo}` });
      await conPrecio(p.id, '10900');
    }
    const primera = await consultar();
    const segunda = await consultar();
    const plus = (r: { cuerpo: { items: { plu: string }[] } }) => r.cuerpo.items.map((i) => i.plu);
    expect(plus(primera)).toEqual(plus(segunda));
    expect(plus(primera)).toEqual(['9001', '9002', '9003']);
  });
});

// ---------------------------------------------------------------------------
// 14 y 15: el precio
// ---------------------------------------------------------------------------

describe('el precio que se publica', () => {
  it('es el precio normal aprobado, exacto y sin redondear de nuevo', async () => {
    const p = await nuevoProducto();
    // Un precio que no es múltiplo de 100 a propósito: si algo lo redondeara de
    // nuevo, se vería.
    await conPrecio(p.id, '10937.50');

    const r = await consultar();
    expect(r.cuerpo.items[0].unitPrice).toBe(10937.5);
  });

  it('no es el costo, ni el sugerido, ni ningún precio en efectivo', async () => {
    const p = await nuevoProducto();
    await prisma.salePriceHistory.create({
      data: {
        productId: p.id,
        costBasis: '7000',
        marginBasis: 'SOBRE_COSTO',
        marginPct: '0.45',
        suggestedPricePerKg: '10150',
        approvedPricePerKg: '10900',
        pricePer100g: '1090',
        pricePerQuarter: '2725',
        pricePerPieceDigital: '32700',
        pricePerPieceCash: '29430',
        cashDiscountPct: '0.1',
        validFrom: new Date('2026-01-01T00:00:00Z'),
      },
    });

    const r = await consultar();
    const item = r.cuerpo.items[0];
    // El aprobado, y ninguno de los otros cinco números que hay guardados.
    expect(item.unitPrice).toBe(10900);
    const texto = JSON.stringify(r.cuerpo);
    for (const prohibido of ['7000', '10150', '29430', '32700']) {
      expect(texto, `no puede aparecer ${prohibido}`).not.toContain(prohibido);
    }
  });
});

// ---------------------------------------------------------------------------
// 16 a 21: qué NO sale
// ---------------------------------------------------------------------------

describe('lo que no puede salir', () => {
  it('el contrato tiene exactamente los diez campos, y ninguno más', async () => {
    const p = await nuevoProducto();
    await conPrecio(p.id, '10900');

    const r = await consultar();
    expect(Object.keys(r.cuerpo).sort()).toEqual(
      ['generatedAt', 'items', 'ok', 'schemaVersion'].sort(),
    );
    expect(Object.keys(r.cuerpo.items[0]).sort()).toEqual(
      [
        'category',
        'defaultQuantity',
        'description',
        'featured',
        'image',
        'name',
        'plu',
        'step',
        'unit',
        'unitPrice',
      ].sort(),
    );
  });

  it('ni costos, ni marcajes, ni márgenes, ni rentabilidad', async () => {
    const p = await nuevoProducto();
    await conPrecio(p.id, '10900');

    const texto = JSON.stringify((await consultar()).cuerpo).toLowerCase();
    for (const palabra of [
      'cost',
      'margin',
      'marcaje',
      'margen',
      'rentab',
      'iva',
      'percep',
      'impuesto',
    ]) {
      expect(texto, `no puede aparecer «${palabra}»`).not.toContain(palabra);
    }
  });

  it('ni proveedores, ni facturas, ni notas de crédito, ni pagos, ni deuda', async () => {
    const p = await nuevoProducto();
    await conPrecio(p.id, '10900');

    const texto = JSON.stringify((await consultar()).cuerpo).toLowerCase();
    for (const palabra of [
      'proveedor',
      'supplier',
      'factura',
      'invoice',
      'credito',
      'pago',
      'payment',
      'deuda',
      'saldo',
      'errecalde',
      'los calvos',
    ]) {
      expect(texto, `no puede aparecer «${palabra}»`).not.toContain(palabra);
    }
  });

  it('ni stock, ni movimientos, ni cantidades compradas', async () => {
    const p = await nuevoProducto();
    await conPrecio(p.id, '10900');

    const texto = JSON.stringify((await consultar()).cuerpo).toLowerCase();
    for (const palabra of ['stock', 'movimiento', 'kilos', 'comprad', 'existencia']) {
      expect(texto, `no puede aparecer «${palabra}»`).not.toContain(palabra);
    }
  });

  it('ni usuarios, ni sesiones, ni variables de entorno', async () => {
    const p = await nuevoProducto();
    await conPrecio(p.id, '10900');

    const texto = JSON.stringify((await consultar()).cuerpo);
    for (const palabra of ['usuario', 'user', 'PIN', 'token', 'session', 'DATABASE_URL', 'env']) {
      expect(texto.toLowerCase(), `no puede aparecer «${palabra}»`).not.toContain(
        palabra.toLowerCase(),
      );
    }
    // Y por las dudas, la propia clave.
    expect(texto).not.toContain(CLAVE);
  });

  it('la clave no aparece en ninguna respuesta ni en ningún encabezado', async () => {
    const p = await nuevoProducto();
    await conPrecio(p.id, '10900');

    for (const r of [
      await consultar(),
      await consultar({ branch: 'caballito' }),
      await consultar({ authorization: 'Bearer no-es-la-clave' }),
      await consultar({ authorization: null }),
    ]) {
      expect(JSON.stringify(r.cuerpo)).not.toContain(CLAVE);
      for (const [, valor] of r.encabezados) {
        expect(valor).not.toContain(CLAVE);
      }
      // Ni siquiera el nombre de la variable, que ya dice cómo está configurado.
      expect(JSON.stringify(r.cuerpo)).not.toContain('PRICES_INTEGRATION_KEY');
    }
  });

  it('los encabezados de seguridad están en todas las respuestas', async () => {
    for (const r of [
      await consultar(),
      await consultar({ branch: 'caballito' }),
      await consultar({ authorization: null }),
    ]) {
      expect(r.encabezados.get('cache-control')).toBe('no-store');
      expect(r.encabezados.get('x-content-type-options')).toBe('nosniff');
      // Y ningún CORS abierto: esto lo consume un backend, no un navegador.
      expect(r.encabezados.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('un error interno no filtra el detalle técnico', async () => {
    /*
     * Un error de Prisma trae la consulta, y la consulta nombra las tablas y
     * las columnas de Compras. Al registro va el error; al cliente, una frase.
     */
    const p = await nuevoProducto();
    await conPrecio(p.id, '10900');

    const { GET } = await import('@/app/api/integrations/public-prices/route');
    const original = prisma.product.findMany;
    // @ts-expect-error se reemplaza a propósito para provocar el error
    prisma.product.findMany = async () => {
      throw new Error('relation "products" does not exist en la consulta SELECT cost FROM ...');
    };
    try {
      const respuesta = await GET(
        new Request('http://localhost/api/integrations/public-prices?branch=devoto', {
          headers: { Authorization: `Bearer ${CLAVE}` },
        }),
      );
      const cuerpo = await respuesta.json();
      expect(respuesta.status).toBe(500);
      expect(JSON.stringify(cuerpo)).not.toContain('products');
      expect(JSON.stringify(cuerpo)).not.toContain('SELECT');
      expect(JSON.stringify(cuerpo)).not.toContain('cost');
    } finally {
      prisma.product.findMany = original;
    }
  });
});

// ---------------------------------------------------------------------------
// 22: sólo lectura
// ---------------------------------------------------------------------------

describe('la consulta no cambia nada', () => {
  it('la base queda idéntica antes y después', async () => {
    const p = await nuevoProducto();
    await conPrecio(p.id, '10900');

    const foto = async () => ({
      productos: await prisma.product.findMany({ orderBy: { id: 'asc' } }),
      precios: await prisma.salePriceHistory.findMany({ orderBy: { id: 'asc' } }),
      alias: await prisma.productAlias.findMany({ orderBy: { id: 'asc' } }),
      costos: await prisma.costHistory.count(),
      auditoria: await prisma.auditLog.count(),
      comprobantes: await prisma.document.count(),
    });

    const antes = await foto();
    await consultar();
    await consultar({ branch: 'pueyrredon' });
    const despues = await foto();

    expect(JSON.stringify(despues)).toBe(JSON.stringify(antes));
  });
});

// ---------------------------------------------------------------------------
// 24: la consulta tal como la va a hacer Pedidos
// ---------------------------------------------------------------------------

describe('la consulta que va a hacer Pedidos', () => {
  it('GET ?branch=devoto con Bearer y Accept: application/json', async () => {
    /*
     * El PLU 1211 del escenario sembrado, que es un artículo real de Don Ginés
     * y el mismo que usa el ejemplo del contrato. Los demás artículos del
     * escenario no tienen precio aprobado, así que queda éste solo.
     */
    await conPrecio(escenario.productos['1211'], '10900');

    const { GET } = await import('@/app/api/integrations/public-prices/route');
    const respuesta = await GET(
      new Request('http://localhost/api/integrations/public-prices?branch=devoto', {
        headers: {
          Authorization: `Bearer ${CLAVE}`,
          Accept: 'application/json',
        },
      }),
    );

    expect(respuesta.status).toBe(200);
    expect(respuesta.headers.get('content-type')).toContain('application/json');

    const cuerpo = await respuesta.json();
    expect(cuerpo).toEqual({
      ok: true,
      schemaVersion: '1.0',
      generatedAt: expect.any(String),
      items: [
        {
          plu: '1211',
          name: 'Cremoso Punta del Agua',
          description: '',
          // La categoría que tiene guardada, sin normalizarla ni fusionarla.
          category: 'Fiambres',
          unit: 'kg',
          unitPrice: 10900,
          step: 0.1,
          defaultQuantity: 0.5,
          image: null,
          featured: false,
        },
      ],
    });
  });

  it('el PLU va como string y sin transformarlo', async () => {
    // Un PLU con ceros a la izquierda se rompería al pasarlo por un número.
    const p = await nuevoProducto({ internalCode: '00042', normalizedName: 'Con ceros' });
    await conPrecio(p.id, '10900');

    const r = await consultar();
    expect(r.cuerpo.items[0].plu).toBe('00042');
  });

  it('una categoría vacía se conserva vacía, sin inventarle una', async () => {
    const p = await nuevoProducto({ internalCode: '9001', category: null });
    await conPrecio(p.id, '10900');

    const r = await consultar();
    expect(r.cuerpo.items[0].category).toBeNull();
  });

  it('la categoría guardada no se normaliza ni se fusiona', async () => {
    const uno = await nuevoProducto({ internalCode: '9001', category: 'Quesos' });
    const otro = await nuevoProducto({ internalCode: '9002', category: 'quesos' });
    await conPrecio(uno.id, '10900');
    await conPrecio(otro.id, '9900');

    const r = await consultar();
    expect(r.cuerpo.items.map((i: { category: string }) => i.category)).toEqual([
      'Quesos',
      'quesos',
    ]);
  });
});

// ---------------------------------------------------------------------------
// El tope de frecuencia
// ---------------------------------------------------------------------------

describe('el tope de consultas por minuto', () => {
  it('atiende la cuota y después contesta 429, sin recortar nada', async () => {
    /*
     * El catálogo cambia unas pocas veces por día: Pedidos tiene que traerlo y
     * guardárselo, no pedirlo cada vez que un cliente abre la pantalla. El tope
     * ataja el bucle accidental que dejaría a Compras armando el catálogo sin
     * parar.
     */
    const p = await nuevoProducto();
    await conPrecio(p.id, '10900');

    for (let i = 0; i < CONSULTAS_POR_MINUTO; i++) {
      expect((await consultar()).estado, `consulta ${i + 1}`).toBe(200);
    }
    const pasada = await consultar();
    expect(pasada.estado).toBe(429);
    // Y la negativa tampoco cuenta nada del catálogo ni de la configuración.
    expect(pasada.cuerpo.items).toBeUndefined();
    expect(JSON.stringify(pasada.cuerpo)).not.toContain(CLAVE);
    expect(pasada.encabezados.get('cache-control')).toBe('no-store');
  });

  it('no se gasta desde afuera con pedidos sin credencial', async () => {
    /*
     * Si los pedidos sin clave contaran para el tope, cualquiera podría gastar
     * la cuota desde afuera y dejar a Pedidos sin catálogo. El límite protege
     * al servicio de un cliente descuidado; no es algo que un extraño pueda
     * apagar.
     */
    const p = await nuevoProducto();
    await conPrecio(p.id, '10900');

    for (let i = 0; i < CONSULTAS_POR_MINUTO * 2; i++) {
      expect((await consultar({ authorization: null })).estado).toBe(401);
    }
    expect((await consultar()).estado).toBe(200);
  });
});
