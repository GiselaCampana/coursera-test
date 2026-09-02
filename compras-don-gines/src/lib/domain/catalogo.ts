/**
 * Lectura del catálogo interno de Don Ginés, tal como lo exporta Control de Stock.
 *
 * Compras **no inventa PLU**. El catálogo de artículos ya existe y vive en la
 * aplicación de Control de Stock; acá se lo lee y se lo copia, conservando el
 * PLU exactamente como viene. Este archivo se ocupa sólo de entender el
 * archivo: no toca la base ni decide nada.
 *
 * Se aceptan CSV y JSON porque no está dicho de antemano de dónde va a salir la
 * exportación —una planilla, una consulta a la base, un endpoint—, y las tres
 * cosas terminan en uno de esos dos formatos. Los encabezados se reconocen por
 * varios nombres posibles por la misma razón: el archivo lo genera otro
 * sistema, y pedirle que use exactamente nuestras palabras es pedirle que se
 * adapte a nosotros para poder leerlo.
 */

import { normalizeText } from '@/lib/domain/matching';

export interface FilaDeCatalogo {
  /** El identificador interno de Don Ginés, tal cual vino. Nunca se renumera. */
  plu: string;
  nombre: string;
  familia: string | null;
  categoria: string | null;
  subtipo: string | null;
  proveedor: string | null;
  codigoProveedor: string | null;
  /** Nulo cuando el archivo no trae la columna: no es lo mismo que "inactivo". */
  activo: boolean | null;
  unidad: 'KG' | 'UNIT' | null;
  /** Número de línea en el archivo, para poder señalar cuál dio problema. */
  linea: number;
}

export interface LecturaDeCatalogo {
  filas: FilaDeCatalogo[];
  /** Filas que no se pudieron leer, con el motivo y su número de línea. */
  problemas: string[];
  /** Qué columnas se reconocieron, para poder mostrarlo antes de importar. */
  columnas: string[];
}

/**
 * Los nombres con que cada sistema puede llamar a la misma columna.
 *
 * El orden importa: se toma el primero que aparezca en el archivo. "codigo" a
 * secas se interpreta como el PLU, pero va último, porque cuando el archivo
 * distingue "codigo interno" de "codigo proveedor" el ambiguo no debe ganarle
 * al explícito.
 */
const COLUMNAS: Record<keyof Omit<FilaDeCatalogo, 'linea'>, string[]> = {
  plu: ['plu', 'codigo interno', 'codigointerno', 'internal code', 'internalcode', 'sku', 'codigo'],
  nombre: [
    // "Artículo" es como se llama la columna en la Hoja 1 de Control de Stock.
    'articulo',
    'nombre',
    'producto',
    'descripcion',
    'name',
    'nombre producto',
  ],
  familia: ['familia', 'family', 'rubro', 'grupo'],
  // "Tipo de Artículo" y "Subtipo de Artículo", los dos niveles de Hoja 1.
  categoria: ['tipo de articulo', 'tipo articulo', 'categoria', 'category', 'tipo', 'type'],
  subtipo: ['subtipo de articulo', 'subtipo articulo', 'subtipo', 'subtype'],
  proveedor: ['proveedor', 'supplier', 'proveedor habitual'],
  codigoProveedor: [
    'codigo proveedor',
    'codigoproveedor',
    'codigo de proveedor',
    'supplier code',
    'suppliercode',
    'codigo del proveedor',
  ],
  activo: ['activo', 'active', 'habilitado', 'vigente', 'estado'],
  unidad: ['unidad', 'unit', 'unidad de compra', 'purchase unit', 'purchaseunit'],
};

/** Encabezado listo para comparar: sin acentos, sin puntuación, en minúsculas. */
function normalizarEncabezado(valor: string): string {
  return normalizeText(valor.replace(/^﻿/, ''));
}

/**
 * Un CSV con comillas, saltos de línea adentro de un campo y separador variable.
 *
 * No alcanza con partir por comas: un nombre como «Queso Sardo, en horma» viene
 * entrecomillado y partirlo lo rompe en dos columnas, corriendo todo lo que
 * sigue. Se detecta el separador porque las planillas en español suelen
 * exportar con punto y coma.
 */
export function parsearCsv(texto: string): string[][] {
  const limpio = texto.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const separador = elegirSeparador(limpio);

  const filas: string[][] = [];
  let fila: string[] = [];
  let campo = '';
  let entreComillas = false;

  for (let i = 0; i < limpio.length; i++) {
    const c = limpio[i];

    if (entreComillas) {
      if (c === '"') {
        // Dos comillas seguidas adentro de un campo son una comilla literal.
        if (limpio[i + 1] === '"') {
          campo += '"';
          i++;
        } else {
          entreComillas = false;
        }
      } else {
        campo += c;
      }
      continue;
    }

    if (c === '"') {
      entreComillas = true;
    } else if (c === separador) {
      fila.push(campo);
      campo = '';
    } else if (c === '\n') {
      fila.push(campo);
      filas.push(fila);
      fila = [];
      campo = '';
    } else {
      campo += c;
    }
  }

  // Lo que quedó pendiente cuando el archivo no termina en salto de línea.
  if (campo !== '' || fila.length > 0) {
    fila.push(campo);
    filas.push(fila);
  }

  return filas.filter((f) => f.some((v) => v.trim() !== ''));
}

function elegirSeparador(texto: string): string {
  const primeraLinea = texto.split('\n')[0] ?? '';
  const puntoYComa = (primeraLinea.match(/;/g) ?? []).length;
  const comas = (primeraLinea.match(/,/g) ?? []).length;
  const tabs = (primeraLinea.match(/\t/g) ?? []).length;
  if (tabs > puntoYComa && tabs > comas) return '\t';
  return puntoYComa > comas ? ';' : ',';
}

/**
 * "Sí", "1", "true", "activo" son lo mismo; "no", "0", "false", "baja" también.
 *
 * Devuelve nulo cuando no se entiende, y eso no es "inactivo": un valor que no
 * se sabe leer no puede dar de baja un artículo del catálogo.
 */
function leerActivo(valor: string | undefined): boolean | null {
  if (valor === undefined) return null;
  const v = normalizeText(valor);
  if (v === '') return null;
  if (['si', 'sí', 's', '1', 'true', 'activo', 'activa', 'vigente', 'alta', 'y', 'yes'].includes(v)) {
    return true;
  }
  if (['no', 'n', '0', 'false', 'inactivo', 'inactiva', 'baja', 'discontinuo'].includes(v)) {
    return false;
  }
  return null;
}

function leerUnidad(valor: string | undefined): 'KG' | 'UNIT' | null {
  if (valor === undefined) return null;
  const v = normalizeText(valor);
  if (v === '') return null;
  if (['kg', 'kilo', 'kilos', 'kilogramo', 'kilogramos', 'peso', 'weight'].includes(v)) return 'KG';
  if (['un', 'u', 'unit', 'unidad', 'unidades', 'bulto', 'bultos', 'piece', 'pieza', 'piezas'].includes(v)) return 'UNIT';
  return null;
}

const vacioANulo = (valor: string | undefined): string | null => {
  const v = valor?.trim() ?? '';
  return v === '' ? null : v;
};

/**
 * El PLU, tal cual viene.
 *
 * Se le sacan los espacios de los costados y nada más. No se lo rellena con
 * ceros, no se lo pasa a número y no se lo reformatea: es el identificador que
 * usa Don Ginés, y "0125" y "125" pueden ser dos artículos distintos. Cualquier
 * normalización de más es una renumeración silenciosa.
 */
function leerPlu(valor: string | undefined): string {
  return (valor ?? '').trim();
}

export function leerCatalogo(texto: string): LecturaDeCatalogo {
  const contenido = texto.trim();
  if (contenido === '') {
    return { filas: [], problemas: ['El archivo está vacío.'], columnas: [] };
  }
  return contenido.startsWith('[') || contenido.startsWith('{')
    ? leerJson(contenido)
    : leerCsvComoCatalogo(contenido);
}

function leerJson(contenido: string): LecturaDeCatalogo {
  let datos: unknown;
  try {
    datos = JSON.parse(contenido);
  } catch {
    return { filas: [], problemas: ['El archivo no es un JSON válido.'], columnas: [] };
  }

  /*
   * Se acepta un arreglo suelto o un objeto que lo envuelva con una clave que
   * diga qué contiene: una exportación de una API suele venir como
   * {"productos": [...]} o {"data": [...]}.
   *
   * Lo que ya **no** se hace es tomar "el primer arreglo que aparezca" cuando
   * ninguna de esas claves está. La respuesta de Control de Stock trae también
   * `branches`, `suppliers`, `productTypes` y `productSubtypes`: adivinar
   * habría importado las sucursales como si fueran artículos, y en silencio.
   * Si no se sabe cuál es la lista de productos, no se importa nada.
   */
  const objeto = (datos ?? {}) as Record<string, unknown>;
  const lista = Array.isArray(datos)
    ? datos
    : Array.isArray(objeto.products)
      ? objeto.products
      : Array.isArray(objeto.productos)
        ? objeto.productos
        : Array.isArray(objeto.items)
          ? objeto.items
          : Array.isArray(objeto.data)
            ? objeto.data
            : undefined;

  if (!Array.isArray(lista)) {
    return {
      filas: [],
      problemas: [
        'El JSON no trae una lista de productos. Tiene que ser un arreglo, o un objeto con la ' +
          'lista en «products», «productos», «items» o «data». No se adivina cuál de las listas ' +
          'del archivo son los artículos.',
      ],
      columnas: [],
    };
  }

  const problemas: string[] = [];
  const filas: FilaDeCatalogo[] = [];
  const columnasVistas = new Set<string>();

  lista.forEach((cruda, indice) => {
    const linea = indice + 1;
    if (typeof cruda !== 'object' || cruda === null) {
      problemas.push(`Elemento ${linea}: no es un producto.`);
      return;
    }

    // Las claves se normalizan igual que los encabezados del CSV, así los dos
    // formatos toleran las mismas variantes de nombre.
    const porClave = new Map<string, string>();
    for (const [clave, valor] of Object.entries(cruda as Record<string, unknown>)) {
      if (valor === null || valor === undefined) continue;
      const normal = normalizarEncabezado(clave);
      columnasVistas.add(normal);

      // El endpoint oficial de Control de Stock entrega proveedor, tipo y
      // subtipo como objetos { id, name }. String(objeto) produciría
      // "[object Object]" y perderíamos justamente la clasificación.
      if (typeof valor === 'object' && !Array.isArray(valor)) {
        const nombre = (valor as Record<string, unknown>).name;
        if (typeof nombre === 'string') {
          porClave.set(normal, nombre);
        }
        continue;
      }

      porClave.set(normal, typeof valor === 'boolean' ? String(valor) : String(valor));
    }

    // internalUnit es el nombre del campo en /api/integrations/catalog.
    // Lo proyectamos a "unidad" para que la lectura existente siga siendo la
    // única responsable de convertir piece/kg a UNIT/KG.
    const unidadInterna = (cruda as Record<string, unknown>).internalUnit;
    if (typeof unidadInterna === 'string') {
      porClave.set('unidad', unidadInterna);
      columnasVistas.add('unidad');
    }

    const tomar = (campo: keyof typeof COLUMNAS): string | undefined => {
      for (const nombre of COLUMNAS[campo]) {
        const v = porClave.get(nombre);
        if (v !== undefined) return v;
      }
      return undefined;
    };

    agregar(filas, problemas, linea, {
      plu: leerPlu(tomar('plu')),
      nombre: (tomar('nombre') ?? '').trim(),
      familia: vacioANulo(tomar('familia')),
      categoria: vacioANulo(tomar('categoria')),
      subtipo: vacioANulo(tomar('subtipo')),
      proveedor: vacioANulo(tomar('proveedor')),
      codigoProveedor: vacioANulo(tomar('codigoProveedor')),
      activo: leerActivo(tomar('activo')),
      unidad: leerUnidad(tomar('unidad')),
    });
  });

  return { filas, problemas, columnas: [...columnasVistas] };
}

function leerCsvComoCatalogo(contenido: string): LecturaDeCatalogo {
  const filasCrudas = parsearCsv(contenido);
  if (filasCrudas.length === 0) {
    return { filas: [], problemas: ['El archivo está vacío.'], columnas: [] };
  }

  const encabezados = filasCrudas[0].map(normalizarEncabezado);
  const indiceDe = (campo: keyof typeof COLUMNAS): number => {
    for (const nombre of COLUMNAS[campo]) {
      const i = encabezados.indexOf(nombre);
      if (i !== -1) return i;
    }
    return -1;
  };

  const columnas: Record<string, number> = {};
  for (const campo of Object.keys(COLUMNAS) as (keyof typeof COLUMNAS)[]) {
    columnas[campo] = indiceDe(campo);
  }

  if (columnas.plu === -1 || columnas.nombre === -1) {
    return {
      filas: [],
      problemas: [
        'No encontramos las columnas del PLU y del nombre. La primera fila del archivo tiene que ' +
          'ser el encabezado, con una columna que se llame PLU (o código interno) y otra Nombre ' +
          `(o Producto). Lo que se leyó fue: ${encabezados.join(', ') || 'nada'}.`,
      ],
      columnas: encabezados,
    };
  }

  const problemas: string[] = [];
  const filas: FilaDeCatalogo[] = [];

  for (let i = 1; i < filasCrudas.length; i++) {
    const cruda = filasCrudas[i];
    // La línea del archivo, contando el encabezado: es lo que ve quien lo abre.
    const linea = i + 1;
    const en = (campo: string): string | undefined =>
      columnas[campo] === -1 ? undefined : cruda[columnas[campo]];

    agregar(filas, problemas, linea, {
      plu: leerPlu(en('plu')),
      nombre: (en('nombre') ?? '').trim(),
      familia: vacioANulo(en('familia')),
      categoria: vacioANulo(en('categoria')),
      subtipo: vacioANulo(en('subtipo')),
      proveedor: vacioANulo(en('proveedor')),
      codigoProveedor: vacioANulo(en('codigoProveedor')),
      activo: leerActivo(en('activo')),
      unidad: leerUnidad(en('unidad')),
    });
  }

  return {
    filas,
    problemas,
    columnas: encabezados.filter((e) => e !== ''),
  };
}

function agregar(
  filas: FilaDeCatalogo[],
  problemas: string[],
  linea: number,
  datos: Omit<FilaDeCatalogo, 'linea'>,
) {
  if (datos.plu === '' && datos.nombre === '') return; // fila en blanco
  if (datos.plu === '') {
    problemas.push(`Línea ${linea}: no tiene PLU («${datos.nombre}»), así que no se puede importar.`);
    return;
  }
  if (datos.nombre === '') {
    problemas.push(`Línea ${linea}: el PLU ${datos.plu} vino sin nombre.`);
    return;
  }
  filas.push({ ...datos, linea });
}
