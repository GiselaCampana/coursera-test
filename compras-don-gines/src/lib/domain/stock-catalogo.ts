import { normalizeText } from '@/lib/domain/matching';

/**
 * La respuesta de Control de Stock, leída con desconfianza.
 *
 * Esto no es el lector de archivos: es el que mira lo que contesta el endpoint
 * `/api/integrations/catalog`, y la diferencia importa. Un archivo lo elige una
 * persona y lo mira antes de subirlo. Una respuesta HTTP la trae la aplicación
 * sola, y si un día devuelve otra cosa —una versión nueva, un error con forma
 * de éxito, media lista porque la consulta se cortó— nadie la va a estar
 * mirando. Por eso acá no se adivina nada.
 *
 * Cuatro reglas, y las cuatro son sobre cuándo **no** seguir:
 *
 *  - **Sólo `products`.** No se busca "el primer arreglo que aparezca". La
 *    respuesta trae también `branches`, `suppliers`, `productTypes` y
 *    `productSubtypes`; tomar el primero que sea una lista es una forma de
 *    importar sucursales como si fueran artículos y no enterarse.
 *  - **La respuesta tiene que decir que salió bien.** `ok` en falso, o
 *    ausente, es una respuesta que no sirve aunque traiga productos.
 *  - **La versión del esquema tiene que ser una que sepamos leer.** Si Control
 *    de Stock cambia la forma de los datos, lo que corresponde es frenar y
 *    avisar, no interpretar campos nuevos con reglas viejas.
 *  - **La clave estable tiene que ser el PLU.** Todo lo que hace Compras con
 *    este catálogo —comparar, actualizar, no renumerar— se apoya en que el PLU
 *    identifique al artículo. Si el origen dice que su clave estable es otra,
 *    lo que sigue no tiene sentido.
 *
 * Y un PLU faltante o repetido **frena la importación entera**, no sólo su
 * fila: un catálogo con dos artículos que dicen ser el mismo número no se
 * puede aplicar a medias sin dejar la base en un estado que nadie eligió.
 */

/**
 * Las versiones del esquema que este código sabe leer.
 *
 * Se puede ampliar desde el panel con STOCK_SCHEMA_VERSIONS —una lista separada
 * por comas— para no tener que desplegar cuando Control de Stock publique una
 * versión compatible. Cuando llega una que no está, la respuesta se rechaza
 * **diciendo cuál vino**, así ampliar la lista es mirar la pantalla y no
 * adivinar.
 */
export const SCHEMA_VERSIONS_SOPORTADAS: string[] = (
  process.env.STOCK_SCHEMA_VERSIONS ?? '1,1.0,1.0.0'
)
  .split(',')
  .map((v) => v.trim())
  .filter((v) => v !== '');

/** La clave con la que Compras identifica un artículo. No hay otra. */
export const CLAVE_ESTABLE = 'plu';

/**
 * Un artículo del catálogo maestro.
 *
 * Sólo los campos de los que Control de Stock es la fuente. Las cantidades por
 * sucursal que la misma respuesta trae **no entran acá**: Compras no lleva
 * stock, y un dato que no se necesita es un dato que igual se persiste, se
 * manda al navegador y hay que explicar cuando queda viejo.
 */
export interface ProductoDeStock {
  plu: string;
  nombre: string;
  proveedor: string | null;
  tipo: string | null;
  subtipo: string | null;
  unidad: 'KG' | 'UNIT' | null;
  imagen: string | null;
  /** Nulo cuando la respuesta no lo dice: no es lo mismo que "inactivo". */
  activo: boolean | null;
  /** Posición en la lista, para poder señalar cuál dio problema. */
  posicion: number;
}

export interface CatalogoDeStock {
  schemaVersion: string;
  productos: ProductoDeStock[];
}

export class RespuestaDeStockInvalida extends Error {
  /** Todos los motivos, para mostrarlos juntos en la vista previa. */
  readonly motivos: string[];
  /** Lo que dijo ser la respuesta, aunque no se la haya aceptado. */
  readonly schemaVersion: string | null;

  constructor(motivos: string[], schemaVersion: string | null = null) {
    super(motivos[0] ?? 'La respuesta de Control de Stock no se pudo leer.');
    this.name = 'RespuestaDeStockInvalida';
    this.motivos = motivos;
    this.schemaVersion = schemaVersion;
  }
}

function texto(valor: unknown): string | null {
  if (typeof valor === 'string') {
    const limpio = valor.trim();
    return limpio === '' ? null : limpio;
  }
  if (typeof valor === 'number' && Number.isFinite(valor)) return String(valor);
  return null;
}

/**
 * El nombre de un `{ id, name }`.
 *
 * El endpoint entrega proveedor, tipo y subtipo así. `String(objeto)` daría
 * "[object Object]" y perderíamos justamente la clasificación.
 */
function nombreDe(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === 'object' && !Array.isArray(valor)) {
    return texto((valor as Record<string, unknown>).name);
  }
  return texto(valor);
}

/** `piece`/`unit` es unidad; `kg`/`weight` es peso. Otra cosa es nulo, no un default. */
function leerUnidad(valor: unknown): 'KG' | 'UNIT' | null {
  const v = texto(valor);
  if (v === null) return null;
  const n = normalizeText(v);
  if (['kg', 'kilo', 'kilos', 'kilogramo', 'kilogramos', 'peso', 'weight'].includes(n)) return 'KG';
  if (['piece', 'pieza', 'unit', 'unidad', 'un', 'u', 'bulto'].includes(n)) return 'UNIT';
  return null;
}

/** Sólo un booleano de verdad decide. Un valor raro no da de baja a nadie. */
function leerActivo(valor: unknown): boolean | null {
  if (typeof valor === 'boolean') return valor;
  const v = texto(valor);
  if (v === null) return null;
  const n = normalizeText(v);
  if (['true', 'si', 'sí', '1', 'activo', 'activa'].includes(n)) return true;
  if (['false', 'no', '0', 'inactivo', 'inactiva', 'baja'].includes(n)) return false;
  return null;
}

/**
 * La imagen, sólo si es una URL que se pueda mostrar.
 *
 * http y https nada más: un `javascript:` o un `data:` en el atributo `src` de
 * una pantalla interna es una puerta que no hace falta abrir para mostrar la
 * foto de un queso.
 */
function leerImagen(valor: unknown): string | null {
  const v = texto(valor);
  if (v === null) return null;
  try {
    const url = new URL(v);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Lee y valida la respuesta del endpoint. O devuelve el catálogo, o explica
 * por qué no se puede usar. Nunca devuelve algo a medias.
 */
export function leerRespuestaDeStock(contenido: string): CatalogoDeStock {
  let datos: unknown;
  try {
    datos = JSON.parse(contenido);
  } catch {
    throw new RespuestaDeStockInvalida([
      'Control de Stock no devolvió un JSON válido. No se aplicó ningún cambio.',
    ]);
  }

  if (typeof datos !== 'object' || datos === null || Array.isArray(datos)) {
    throw new RespuestaDeStockInvalida([
      'La respuesta de Control de Stock no tiene la forma esperada: se esperaba un objeto con ' +
        '«ok», «schemaVersion» y «products». No se aplicó ningún cambio.',
    ]);
  }

  const raiz = datos as Record<string, unknown>;
  const schemaVersion = texto(raiz.schemaVersion);
  const motivos: string[] = [];

  if (raiz.ok !== true) {
    motivos.push(
      raiz.ok === undefined
        ? 'La respuesta de Control de Stock no trae «ok». No se aplicó ningún cambio.'
        : 'Control de Stock respondió que la consulta no salió bien («ok» en falso). ' +
          'No se aplicó ningún cambio.',
    );
  }

  if (schemaVersion === null) {
    motivos.push('La respuesta no dice qué versión de esquema usa («schemaVersion»).');
  } else if (!SCHEMA_VERSIONS_SOPORTADAS.includes(schemaVersion)) {
    motivos.push(
      `Control de Stock respondió con la versión de esquema «${schemaVersion}», que esta ` +
        `versión de Compras no sabe leer. Soportadas: ${SCHEMA_VERSIONS_SOPORTADAS.join(', ')}. ` +
        'No se aplicó ningún cambio.',
    );
  }

  /*
   * La clave estable.
   *
   * Compras compara y actualiza por PLU y por nada más. Si el origen declara
   * otra clave, seguir sería aplicar reglas nuestras a datos que se organizan
   * de otra manera.
   */
  const usage = raiz.usage;
  const claveEstable =
    typeof usage === 'object' && usage !== null
      ? texto((usage as Record<string, unknown>).stableKey)
      : null;
  if (claveEstable === null) {
    motivos.push('La respuesta no declara cuál es su clave estable («usage.stableKey»).');
  } else if (claveEstable !== CLAVE_ESTABLE) {
    motivos.push(
      `Control de Stock declara «${claveEstable}» como clave estable, y Compras identifica los ` +
        'artículos por PLU. No se aplicó ningún cambio.',
    );
  }

  /*
   * `products`, y sólo `products`.
   *
   * Antes, si no aparecía, se tomaba el primer arreglo del objeto. En esta
   * respuesta eso habría sido `branches`: las sucursales importadas como
   * artículos, en silencio.
   */
  const lista = raiz.products;
  if (lista === undefined) {
    motivos.push(
      'La respuesta no trae la lista «products». No se busca ninguna otra: sin ella no hay ' +
        'catálogo que importar.',
    );
  } else if (!Array.isArray(lista)) {
    motivos.push('«products» vino, pero no es una lista de artículos.');
  }

  if (motivos.length > 0) throw new RespuestaDeStockInvalida(motivos, schemaVersion);

  const crudos = lista as unknown[];
  const productos: ProductoDeStock[] = [];
  const errores: string[] = [];
  const vistos = new Map<string, number>();

  crudos.forEach((crudo, indice) => {
    const posicion = indice + 1;
    if (typeof crudo !== 'object' || crudo === null || Array.isArray(crudo)) {
      errores.push(`Artículo ${posicion}: no es un artículo.`);
      return;
    }
    const p = crudo as Record<string, unknown>;

    /*
     * El PLU, tal cual viene: sólo se le sacan los espacios de los costados.
     * No se rellena con ceros ni se pasa a número, porque «0125» y «125» pueden
     * ser dos artículos distintos y cualquier normalización de más es una
     * renumeración silenciosa.
     */
    const plu = texto(p.plu);
    const nombre = texto(p.name) ?? texto(p.nombre);

    if (plu === null) {
      errores.push(
        `Artículo ${posicion}${nombre ? ` («${nombre}»)` : ''}: vino sin PLU. ` +
          'El PLU es la clave con la que Compras identifica cada artículo.',
      );
      return;
    }
    if (nombre === null) {
      errores.push(`Artículo ${posicion}: el PLU ${plu} vino sin nombre.`);
      return;
    }

    const anterior = vistos.get(plu);
    if (anterior !== undefined) {
      errores.push(
        `PLU ${plu} repetido: aparece en las posiciones ${anterior} y ${posicion}. ` +
          'Un PLU identifica a un artículo y a uno solo.',
      );
      return;
    }
    vistos.set(plu, posicion);

    productos.push({
      plu,
      nombre,
      proveedor: nombreDe(p.supplier),
      tipo: nombreDe(p.type),
      subtipo: nombreDe(p.subtype),
      unidad: leerUnidad(p.internalUnit ?? p.unit),
      imagen: leerImagen(p.imageUrl ?? p.image),
      activo: leerActivo(p.active),
      posicion,
    });
  });

  /*
   * Un solo artículo mal frena todo.
   *
   * Es lo contrario de lo que hace el importador de archivos, que salta la
   * fila y sigue, y es a propósito: un archivo lo mira una persona y decide;
   * una sincronización automática que aplica "lo que se pudo" deja el catálogo
   * en un estado que nadie eligió y que nadie va a revisar.
   */
  if (errores.length > 0) throw new RespuestaDeStockInvalida(errores, schemaVersion);

  if (productos.length === 0) {
    throw new RespuestaDeStockInvalida(
      ['Control de Stock devolvió el catálogo vacío. No se aplicó ningún cambio.'],
      schemaVersion,
    );
  }

  return { schemaVersion: schemaVersion as string, productos };
}
