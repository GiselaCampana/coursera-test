/**
 * Un Control de Stock de mentira, para las pruebas en el navegador.
 *
 * La sincronización descarga del lado del servidor, así que probarla de punta a
 * punta necesita algo que conteste. Apuntar las pruebas al Control de Stock real
 * las haría depender de que ese servicio esté levantado y de que su catálogo no
 * cambie, que son dos formas de que fallen por algo que no es lo que prueban.
 *
 * Contesta la misma forma que el endpoint real —`ok`, `schemaVersion`,
 * `usage.stableKey`, `products`, y también `branches` con existencias, que es
 * justamente lo que Compras no tiene que importar— y sabe cambiar de variante
 * cuando la prueba se lo pide, para poder mirar una modificación.
 */
import { createServer } from 'node:http';

const PUERTO = Number(process.env.STOCK_FALSO_PUERTO ?? 3111);

/** Los PLU del sembrado de pruebas, para que ninguno quede inactivo por error. */
const DEL_SEMBRADO = [
  { plu: '2001', name: 'Queso Sardo bloque Melincué', subtype: 'Duros' },
  { plu: '2002', name: 'Tomate en botella', subtype: 'Conservas' },
  { plu: '1211', name: 'Cremoso Punta del Agua', subtype: 'Cremosos' },
  { plu: '1001', name: 'Longaniza corta', subtype: 'Embutidos' },
];

/** Qué se está sirviendo. La prueba lo cambia con POST /variante. */
let variante = 1;

function catalogo() {
  const products = DEL_SEMBRADO.map((p) => ({
    id: `id-${p.plu}`,
    plu: p.plu,
    name: p.name,
    supplier: { id: 's1', name: 'Distribución Errecalde' },
    type: { id: 't1', name: 'Quesos' },
    subtype: { id: `st-${p.plu}`, name: p.subtype },
    internalUnit: 'kg',
    active: true,
    // Existencias por sucursal: viene en la respuesta real y no se importa.
    stock: [{ branchId: 'b1', quantity: 12.5 }],
  }));

  products.push({
    id: 'id-4001',
    plu: '4001',
    name: variante === 1 ? 'Provolone de prueba' : 'Provolone de prueba renombrado',
    supplier: { id: 's1', name: 'Distribución Errecalde' },
    type: { id: 't1', name: 'Quesos' },
    subtype: { id: 'st-4001', name: 'Duros' },
    internalUnit: variante === 1 ? 'kg' : 'piece',
    active: true,
    stock: [{ branchId: 'b1', quantity: 3 }],
  });

  return {
    ok: true,
    schemaVersion: '1.0',
    usage: { stableKey: 'plu' },
    branches: [{ id: 'b1', code: 'devoto', name: 'Devoto' }],
    suppliers: [{ id: 's1', name: 'Distribución Errecalde' }],
    products,
  };
}

const servidor = createServer((pedido, respuesta) => {
  const url = new URL(pedido.url ?? '/', `http://127.0.0.1:${PUERTO}`);

  if (pedido.method === 'POST' && url.pathname === '/variante') {
    variante = Number(url.searchParams.get('n') ?? '1');
    respuesta.writeHead(200, { 'content-type': 'application/json' });
    respuesta.end(JSON.stringify({ variante }));
    return;
  }

  if (url.pathname === '/api/integrations/catalog') {
    respuesta.writeHead(200, { 'content-type': 'application/json' });
    respuesta.end(JSON.stringify(catalogo()));
    return;
  }

  respuesta.writeHead(404, { 'content-type': 'application/json' });
  respuesta.end(JSON.stringify({ ok: false, error: 'no existe' }));
});

servidor.listen(PUERTO, '127.0.0.1', () => {
  console.log(`Control de Stock de prueba escuchando en http://127.0.0.1:${PUERTO}`);
});

for (const senal of ['SIGINT', 'SIGTERM']) {
  process.on(senal, () => servidor.close(() => process.exit(0)));
}
