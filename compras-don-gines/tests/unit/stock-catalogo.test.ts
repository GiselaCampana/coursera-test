import { describe, it, expect } from 'vitest';
import {
  RespuestaDeStockInvalida,
  leerRespuestaDeStock,
} from '@/lib/domain/stock-catalogo';
import { esDireccionPrivada, pareceIpv4 } from '@/lib/domain/red';

/**
 * Lo que la sincronización se niega a leer.
 *
 * Estas pruebas son casi todas sobre respuestas que **no** se aceptan, y esa
 * proporción es el punto. El caso feliz lo cubre cualquier corrida real; lo que
 * no se ve nunca hasta el día que pasa es qué hace la aplicación cuando el otro
 * lado contesta cualquier otra cosa.
 */

/** Una respuesta válida, para ir rompiéndole una parte por vez. */
function respuesta(cambios: Record<string, unknown> = {}) {
  return JSON.stringify({
    ok: true,
    schemaVersion: '1.0',
    usage: { stableKey: 'plu' },
    branches: [{ id: 'b1', code: 'devoto', name: 'Devoto' }],
    suppliers: [{ id: 's1', name: 'Errecalde' }],
    products: [
      {
        id: 'p1',
        plu: '1211',
        name: 'Cremoso Punta del Agua',
        supplier: { id: 's1', name: 'Errecalde' },
        type: { id: 't1', name: 'Quesos' },
        subtype: { id: 'st1', name: 'Cremosos' },
        internalUnit: 'kg',
        active: true,
      },
    ],
    ...cambios,
  });
}

/** Los motivos del rechazo, para poder afirmar sobre lo que dice la pantalla. */
function motivosDe(contenido: string): string[] {
  try {
    leerRespuestaDeStock(contenido);
  } catch (error) {
    if (error instanceof RespuestaDeStockInvalida) return error.motivos;
    throw error;
  }
  throw new Error('Se esperaba que la respuesta fuera rechazada, y se aceptó.');
}

describe('la respuesta buena se lee entera', () => {
  it('toma nombre, proveedor, tipo, subtipo y unidad de sus objetos', () => {
    const { productos, schemaVersion } = leerRespuestaDeStock(respuesta());
    expect(schemaVersion).toBe('1.0');
    expect(productos).toHaveLength(1);
    expect(productos[0]).toMatchObject({
      plu: '1211',
      nombre: 'Cremoso Punta del Agua',
      proveedor: 'Errecalde',
      tipo: 'Quesos',
      subtipo: 'Cremosos',
      unidad: 'KG',
      activo: true,
    });
  });

  it('«piece» es unidad y «kg» es peso', () => {
    const porUnidad = leerRespuestaDeStock(
      respuesta({ products: [{ plu: '1', name: 'Tomate', internalUnit: 'piece' }] }),
    );
    expect(porUnidad.productos[0].unidad).toBe('UNIT');
    const porPeso = leerRespuestaDeStock(
      respuesta({ products: [{ plu: '1', name: 'Queso', internalUnit: 'kg' }] }),
    );
    expect(porPeso.productos[0].unidad).toBe('KG');
  });

  it('una unidad que no se entiende queda en nulo, y no en un valor por omisión', () => {
    /*
     * Un valor desconocido no puede convertirse en «se compra por kilo»: ese
     * campo decide cómo se calcula el costo, y equivocarlo cambia todos los
     * precios del artículo sin que nada lo delate.
     */
    const r = leerRespuestaDeStock(
      respuesta({ products: [{ plu: '1', name: 'Algo', internalUnit: 'caja' }] }),
    );
    expect(r.productos[0].unidad).toBeNull();
  });

  it('el PLU se conserva tal cual: no se rellena ni se pasa a número', () => {
    const r = leerRespuestaDeStock(
      respuesta({ products: [{ plu: ' 0125 ', name: 'Con ceros adelante' }] }),
    );
    expect(r.productos[0].plu).toBe('0125');
  });
});

describe('la respuesta que no se acepta', () => {
  it('sin «ok» en verdadero no se importa nada', () => {
    expect(motivosDe(respuesta({ ok: false }))[0]).toContain('no salió bien');
    expect(motivosDe(respuesta({ ok: undefined }))[0]).toContain('no trae «ok»');
  });

  it('una versión de esquema desconocida se rechaza, y dice cuál vino', () => {
    /*
     * Decir cuál vino es lo que hace que el rechazo sirva: si Control de Stock
     * publica una versión nueva, la pantalla la nombra y se puede decidir, en
     * vez de tener que salir a buscar por qué dejó de andar.
     */
    const motivos = motivosDe(respuesta({ schemaVersion: '9.9' }));
    expect(motivos[0]).toContain('«9.9»');
    expect(motivos[0]).toContain('No se aplicó ningún cambio');
  });

  it('sin versión de esquema tampoco', () => {
    expect(motivosDe(respuesta({ schemaVersion: undefined }))[0]).toContain('schemaVersion');
  });

  it('si la clave estable no es el PLU, lo que sigue no tiene sentido', () => {
    const motivos = motivosDe(respuesta({ usage: { stableKey: 'id' } }));
    expect(motivos[0]).toContain('«id»');
    expect(motivos[0]).toContain('PLU');
    expect(motivosDe(respuesta({ usage: undefined }))[0]).toContain('stableKey');
  });

  it('sin «products» no se busca ninguna otra lista', () => {
    /*
     * El defecto que esto impide, y que estaba en el código: si no encontraba
     * «products», tomaba el primer arreglo del objeto. En esta respuesta el
     * primero es «branches»: las tres sucursales importadas como si fueran
     * artículos, en silencio y con sus nombres como PLU.
     */
    const sinProducts = JSON.stringify({
      ok: true,
      schemaVersion: '1.0',
      usage: { stableKey: 'plu' },
      branches: [{ id: 'b1', name: 'Devoto' }],
    });
    const motivos = motivosDe(sinProducts);
    expect(motivos[0]).toContain('products');
    expect(motivos[0]).toContain('No se busca ninguna otra');
  });

  it('«products» que no es una lista se rechaza', () => {
    expect(motivosDe(respuesta({ products: { plu: '1' } }))[0]).toContain('no es una lista');
  });

  it('un catálogo vacío no borra el de Compras: se rechaza', () => {
    /*
     * Es la respuesta más peligrosa de todas. Si se aceptara, la sincronización
     * concluiría que ningún artículo existe ya y propondría desactivar el
     * catálogo entero.
     */
    expect(motivosDe(respuesta({ products: [] }))[0]).toContain('vacío');
  });

  it('lo que no es JSON, y lo que es un arreglo suelto', () => {
    expect(motivosDe('esto no es json')[0]).toContain('JSON válido');
    expect(motivosDe('[{"plu":"1"}]')[0]).toContain('forma esperada');
  });

  it('junta todos los motivos en vez de contar el primero', () => {
    // Para no arreglar un problema, volver a intentar y descubrir el siguiente.
    const motivos = motivosDe(
      respuesta({ ok: false, schemaVersion: '9.9', usage: { stableKey: 'id' } }),
    );
    expect(motivos.length).toBeGreaterThanOrEqual(3);
  });
});

describe('un PLU faltante o repetido frena la importación entera', () => {
  it('un artículo sin PLU bloquea todo, y dice cuál', () => {
    /*
     * No se salta la fila y se sigue. Un catálogo maestro al que le falta la
     * clave de un artículo no se puede aplicar a medias: lo que quedaría escrito
     * es un estado que nadie eligió.
     */
    const motivos = motivosDe(
      respuesta({
        products: [
          { plu: '1211', name: 'Cremoso' },
          { name: 'Sin PLU' },
        ],
      }),
    );
    expect(motivos).toHaveLength(1);
    expect(motivos[0]).toContain('Artículo 2');
    expect(motivos[0]).toContain('Sin PLU');
  });

  it('un PLU repetido bloquea todo, y dice en qué posiciones', () => {
    const motivos = motivosDe(
      respuesta({
        products: [
          { plu: '1211', name: 'Cremoso' },
          { plu: '1300', name: 'Otro' },
          { plu: '1211', name: 'Cremoso repetido' },
        ],
      }),
    );
    expect(motivos[0]).toContain('PLU 1211 repetido');
    expect(motivos[0]).toContain('1 y 3');
  });

  it('un artículo sin nombre también frena', () => {
    expect(motivosDe(respuesta({ products: [{ plu: '1211' }] }))[0]).toContain('sin nombre');
  });
});

describe('la imagen', () => {
  it('se toma si es una dirección http o https', () => {
    const r = leerRespuestaDeStock(
      respuesta({
        products: [{ plu: '1', name: 'Q', imageUrl: 'https://stock.example/queso.jpg' }],
      }),
    );
    expect(r.productos[0].imagen).toBe('https://stock.example/queso.jpg');
  });

  it('se descarta cualquier otro esquema', () => {
    /*
     * Esa dirección termina en el atributo `src` de una pantalla interna.
     * `javascript:` y `data:` ahí son una puerta que no hace falta abrir para
     * mostrar la foto de un queso.
     */
    for (const malo of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd']) {
      const r = leerRespuestaDeStock(
        respuesta({ products: [{ plu: '1', name: 'Q', imageUrl: malo }] }),
      );
      expect(r.productos[0].imagen, malo).toBeNull();
    }
  });
});

describe('el stock por sucursal no entra', () => {
  it('las cantidades de la respuesta no aparecen en lo que se lee', () => {
    /*
     * La misma respuesta trae existencias por sucursal. Compras no lleva stock:
     * un dato que no se necesita igual se persiste, igual viaja al navegador y
     * igual hay que explicarlo cuando queda viejo.
     */
    const { productos } = leerRespuestaDeStock(
      respuesta({
        products: [
          {
            plu: '1211',
            name: 'Cremoso',
            stock: [{ branchId: 'b1', quantity: 42 }],
            totalStock: 42,
          },
        ],
      }),
    );
    const serializado = JSON.stringify(productos);
    expect(serializado).not.toContain('42');
    expect(serializado).not.toContain('stock');
    expect(Object.keys(productos[0]).sort()).toEqual([
      'activo',
      'imagen',
      'nombre',
      'plu',
      'posicion',
      'proveedor',
      'subtipo',
      'tipo',
      'unidad',
    ]);
  });
});

describe('a qué direcciones no se conecta el respaldo de DNS', () => {
  /*
   * Resolver el nombre a mano saltea la protección que da resolverlo
   * normalmente, así que hay que reponerla. Sin esto, una respuesta de DNS
   * manipulada haría que el servidor de Compras abra una conexión hacia adentro
   * de la red de Render.
   */
  it('rechaza las redes privadas, el bucle local y el enlace local', () => {
    for (const ip of [
      '10.0.0.1',
      '127.0.0.1',
      '169.254.169.254', // los metadatos de la nube
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
    ]) {
      expect(esDireccionPrivada(ip), ip).toBe(true);
    }
  });

  it('acepta una dirección pública común', () => {
    for (const ip of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '191.168.1.1', '104.18.0.1']) {
      expect(esDireccionPrivada(ip), ip).toBe(false);
    }
  });

  it('tampoco se cuela una privada disfrazada de IPv6', () => {
    expect(esDireccionPrivada('::1')).toBe(true);
    expect(esDireccionPrivada('fe80::1')).toBe(true);
    expect(esDireccionPrivada('fd00::1')).toBe(true);
    expect(esDireccionPrivada('::ffff:10.0.0.1')).toBe(true);
  });

  it('lo que no tiene forma de IPv4 no se usa para conectarse', () => {
    expect(pareceIpv4('8.8.8.8')).toBe(true);
    expect(pareceIpv4('999.1.1.1')).toBe(false);
    expect(pareceIpv4('ejemplo.com')).toBe(false);
    expect(pareceIpv4('8.8.8')).toBe(false);
  });
});
