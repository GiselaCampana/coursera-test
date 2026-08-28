import 'server-only';
import { prisma } from '@/lib/db';
import { ForbiddenError } from '@/lib/errors';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { hasPermission, type AuthUser } from '@/lib/auth/session';
import { normalizarCodigo, normalizeText } from '@/lib/domain/matching';
import { leerCatalogo, type FilaDeCatalogo } from '@/lib/domain/catalogo';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/services/audit';
import { learnProductAlias } from '@/lib/services/documents';

/**
 * Importar el catálogo interno de Don Ginés desde Control de Stock.
 *
 * Compras no da de alta artículos: los toma. El catálogo con los PLU ya existe
 * en Control de Stock y esa es la fuente; acá se lo copia conservando el PLU
 * exactamente como viene.
 *
 * Cuatro reglas lo definen, y las cuatro son sobre lo que **no** hace:
 *
 *  - **Nunca renumera.** El PLU es la clave del upsert. Un producto que ya está
 *    se actualiza; uno que no está se crea. Que dos nombres coincidan no mueve
 *    ningún PLU: si el archivo trae el PLU 1300 con el nombre de un artículo
 *    que acá es el 1211, eso es un conflicto para que lo mire una persona, no
 *    una renumeración para hacer sola.
 *  - **Nunca duplica un PLU.** El índice único lo garantiza, y el informe lo
 *    detecta antes: un PLU repetido dentro del archivo con dos nombres
 *    distintos no se importa.
 *  - **Nunca borra.** Un producto del catálogo de Compras que no aparece en el
 *    archivo se informa y se deja como está. Puede que el archivo esté
 *    incompleto, y borrar compras históricas por eso no tiene vuelta atrás.
 *  - **Nunca pisa una asociación ya confirmada.** Si el archivo trae un código
 *    de proveedor que acá ya apunta a otro artículo, se informa el conflicto y
 *    no se toca nada.
 *
 * Y siempre en dos pasos: primero el informe, que no escribe nada, y después la
 * aplicación con una confirmación aparte.
 */

export interface CambioDeProducto {
  campo: string;
  antes: string;
  despues: string;
}

export interface ProductoDelInforme {
  plu: string;
  nombre: string;
  familia: string | null;
  /** Qué cambiaría respecto de lo que hay hoy. Vacío en los nuevos. */
  cambios: CambioDeProducto[];
}

export interface ConflictoDeCatalogo {
  plu: string;
  motivo: string;
}

/** De qué columna sale la familia con la que se agrupan los artículos. */
export type OrigenDeFamilia = 'auto' | 'tipo' | 'subtipo' | 'ninguna';

export interface InformeDeCatalogo {
  totalLeidas: number;
  nuevos: ProductoDelInforme[];
  actualizables: ProductoDelInforme[];
  sinCambios: ProductoDelInforme[];
  /**
   * Artículos que cambiarían de nombre y **ya tienen compras cargadas**.
   *
   * Van aparte porque son los únicos donde equivocarse tiene consecuencias
   * hacia atrás: el PLU ya está usado en facturas validadas, y renombrarlo
   * reetiqueta esas compras. Casi siempre significa que ese número está ocupado
   * por otro artículo del que Control de Stock no sabe nada.
   */
  renombresConCompras: ProductoDelInforme[];
  conflictos: ConflictoDeCatalogo[];
  /** Las familias que se crearían, para poder mirarlas antes de aplicar. */
  familiasNuevas: string[];
  /** Proveedores nombrados en el archivo que no están dados de alta en Compras. */
  proveedoresDesconocidos: string[];
  /** Artículos que están en Compras y no vinieron en el archivo. No se borran. */
  soloEnCompras: { plu: string; nombre: string; conMovimientos: boolean }[];
  /**
   * PLU de demostración sembrados por versiones viejas y ausentes del catálogo
   * real. Sólo entran acá si no tienen historial: al aplicar se desactivan, no
   * se borran.
   */
  demosDesactivables: { plu: string; nombre: string }[];
  /** Códigos de proveedor que el archivo trae y quedarían aprendidos. */
  codigosPorAprender: { plu: string; proveedor: string; codigo: string }[];
  problemas: string[];
  columnas: string[];
  /** Si la fuente trajo los dos niveles de clasificación del catálogo maestro. */
  traeTipo: boolean;
  traeSubtipo: boolean;
  /** Cuántos se escribieron. Cero mientras es sólo un informe. */
  aplicados: number;
}

const SIN_FAMILIA = '—';

/*
 * Catálogo de demostración de versiones anteriores.
 *
 * Estos PLU nunca fueron la fuente real: el propio seed los marca como datos
 * inventados. Se usa código + nombre exacto para no desactivar por accidente un
 * artículo legítimo que casualmente reutilice uno de esos números.
 */
const CATALOGO_DEMO_ANTIGUO = new Map<string, string>([
  ['1001', 'Longaniza corta'],
  ['1002', 'Salame Crespón'],
  ['1003', 'Salame Milán'],
  ['1004', 'Bondiola al papel'],
  ['1005', 'Jamón crudo Parma'],
  ['1006', 'Jamón cocido'],
  ['1007', 'Jamón cocido Mont-Blanc'],
  ['1008', 'Fiambre de pechuga de pollo ahumado y horneado'],
  ['1009', 'Fiambre cocido de pata Zur-Linde'],
  ['2001', 'Queso Sardo'],
  ['2002', 'Queso Reggianito'],
]);

/**
 * Analiza el archivo y, si se pide, lo aplica.
 *
 * Sin `aplicar` no escribe absolutamente nada: devuelve qué pasaría. Es el
 * mismo recorrido en los dos casos a propósito, para que lo que se muestra en
 * la vista previa sea lo que después se hace y no una estimación aparte.
 */
export async function importarCatalogo(
  user: AuthUser,
  texto: string,
  opciones: { aplicar?: boolean; familiaDesde?: OrigenDeFamilia } = {},
): Promise<InformeDeCatalogo> {
  if (!hasPermission(user, PERMISSIONS.PRODUCTOS_GESTIONAR)) {
    throw new ForbiddenError('Tu usuario no puede administrar el catálogo.');
  }

  const lectura = leerCatalogo(texto);
  const informe: InformeDeCatalogo = {
    totalLeidas: lectura.filas.length,
    nuevos: [],
    actualizables: [],
    sinCambios: [],
    renombresConCompras: [],
    conflictos: [],
    familiasNuevas: [],
    proveedoresDesconocidos: [],
    soloEnCompras: [],
    demosDesactivables: [],
    codigosPorAprender: [],
    problemas: [...lectura.problemas],
    columnas: lectura.columnas,
    traeTipo: lectura.filas.some((f) => Boolean(f.categoria?.trim())),
    traeSubtipo: lectura.filas.some((f) => Boolean(f.subtipo?.trim())),
    aplicados: 0,
  };
  if (lectura.filas.length === 0) return informe;

  // --- Un PLU repetido dentro del mismo archivo -----------------------------
  const porPlu = new Map<string, FilaDeCatalogo>();
  for (const fila of lectura.filas) {
    const previa = porPlu.get(fila.plu);
    if (!previa) {
      porPlu.set(fila.plu, fila);
      continue;
    }
    if (normalizeText(previa.nombre) !== normalizeText(fila.nombre)) {
      informe.conflictos.push({
        plu: fila.plu,
        motivo:
          `Aparece dos veces en el archivo con nombres distintos: «${previa.nombre}» ` +
          `(línea ${previa.linea}) y «${fila.nombre}» (línea ${fila.linea}).`,
      });
      porPlu.delete(fila.plu);
    }
    // Repetido con el mismo nombre: es la misma fila dos veces, no molesta.
  }
  const conflictivos = new Set(informe.conflictos.map((c) => c.plu));

  // --- Lo que hay hoy en Compras -------------------------------------------
  const existentes = await prisma.product.findMany({
    include: {
      family: { select: { name: true } },
      aliases: { select: { supplierId: true, supplierCode: true } },
    },
  });
  const existentePorPlu = new Map(existentes.map((p) => [p.internalCode, p]));
  const existentePorNombre = new Map(existentes.map((p) => [normalizeText(p.normalizedName), p]));

  const proveedores = await prisma.supplier.findMany({
    select: {
      id: true,
      tradeName: true,
      aliases: { select: { normalized: true } },
    },
  });
  /*
   * Control de Stock puede decir "Errecalde" y Compras tenerlo dado de alta
   * como "Distribución Errecalde". El proveedor habitual no tiene que fallar
   * por esa diferencia si el nombre corto está cargado como alias.
   */
  const proveedorPorNombre = new Map<string, (typeof proveedores)[number]>();
  for (const proveedor of proveedores) {
    proveedorPorNombre.set(normalizeText(proveedor.tradeName), proveedor);
    for (const alias of proveedor.aliases) {
      proveedorPorNombre.set(alias.normalized, proveedor);
    }
  }

  /*
   * A qué producto apunta hoy cada código de proveedor.
   *
   * Es lo que permite avisar antes de escribir que el archivo querría mudar un
   * código que ya está asignado a otro artículo, en vez de chocar contra el
   * índice único a mitad de la importación.
   */
  const duenoDelCodigo = new Map<string, string>();
  for (const p of existentes) {
    for (const a of p.aliases) {
      if (a.supplierId && a.supplierCode) {
        duenoDelCodigo.set(`${a.supplierId}|${normalizarCodigo(a.supplierCode)}`, p.id);
      }
    }
  }

  /*
   * --- De qué columna sale la familia --------------------------------------
   *
   * La Hoja 1 de Control de Stock trae dos niveles, «Tipo de Artículo» y
   * «Subtipo de Artículo», y cuál de los dos sirve como familia depende de cómo
   * estén cargados: si el Tipo es "Quesos" y el Subtipo "Queso Sardo", la
   * familia que agrupa al Sardo Bloque con el Sardo Don Alfonso es el Subtipo.
   * Al revés también puede pasar.
   *
   * No se adivina: se elige antes de importar y se ve el resultado en la vista
   * previa. Por omisión gana el nivel más fino que el archivo traiga, que es el
   * que agrupa sin mezclar.
   */
  const origen: OrigenDeFamilia = opciones.familiaDesde ?? 'auto';
  const nombreDeFamilia = (fila: FilaDeCatalogo): string | null => {
    const elegido =
      origen === 'ninguna'
        ? null
        : origen === 'subtipo'
          ? fila.subtipo
          : origen === 'tipo'
            ? (fila.familia ?? fila.categoria)
            : (fila.familia ?? fila.subtipo ?? fila.categoria);
    return elegido ? elegido.trim() : null;
  };

  const familiasDelArchivo = new Map<string, string>();
  for (const fila of porPlu.values()) {
    const nombre = nombreDeFamilia(fila);
    if (nombre) familiasDelArchivo.set(normalizeText(nombre), nombre);
  }

  const familiasExistentes = await prisma.productFamily.findMany();
  const familiaPorNombre = new Map(familiasExistentes.map((f) => [f.normalized, f]));

  informe.familiasNuevas = [...familiasDelArchivo.entries()]
    .filter(([normal]) => !familiaPorNombre.has(normal))
    .map(([, nombre]) => nombre)
    .sort();

  if (opciones.aplicar) {
    for (const [normal, nombre] of familiasDelArchivo) {
      if (familiaPorNombre.has(normal)) continue;
      const creada = await prisma.productFamily.create({
        data: { name: nombre, normalized: normal },
      });
      familiaPorNombre.set(normal, creada);
    }
  }

  const idDeFamilia = (fila: FilaDeCatalogo): string | null => {
    const nombre = nombreDeFamilia(fila);
    if (!nombre) return null;
    return familiaPorNombre.get(normalizeText(nombre))?.id ?? null;
  };

  /*
   * Qué artículos ya tienen compras cargadas.
   *
   * Se necesita para dos cosas: avisar cuál de los renombres es peligroso, y
   * decir cuáles de los que no vienen en el archivo no se podrían dar de baja
   * sin perder historial.
   */
  const [conCompras, conRenglones, conCostos, conPrecios, conVentas] = await Promise.all([
    prisma.purchaseMovement.groupBy({ by: ['productId'], _count: { _all: true } }),
    prisma.documentItem.groupBy({ by: ['productId'], _count: { _all: true } }),
    prisma.costHistory.groupBy({ by: ['productId'], _count: { _all: true } }),
    prisma.salePriceHistory.groupBy({ by: ['productId'], _count: { _all: true } }),
    prisma.salesMovement.groupBy({ by: ['productId'], _count: { _all: true } }),
  ]);
  const tienenCompras = new Set(conCompras.map((c) => c.productId).filter(Boolean) as string[]);
  const tienenHistorial = new Set<string>();
  for (const grupo of [conCompras, conRenglones, conCostos, conPrecios, conVentas]) {
    for (const fila of grupo) if (fila.productId) tienenHistorial.add(fila.productId);
  }

  // --- Fila por fila --------------------------------------------------------
  const esDemoAntiguoSinHistorial = (producto: (typeof existentes)[number]): boolean => {
    const nombreDemo = CATALOGO_DEMO_ANTIGUO.get(producto.internalCode);
    return Boolean(
      nombreDemo &&
        normalizeText(nombreDemo) === normalizeText(producto.normalizedName) &&
        !tienenHistorial.has(producto.id),
    );
  };

  const vistos = new Set<string>();

  for (const fila of porPlu.values()) {
    if (conflictivos.has(fila.plu)) continue;
    vistos.add(fila.plu);

    const existente = existentePorPlu.get(fila.plu);

    /*
     * El nombre del archivo ya es de otro PLU: posible renumeración.
     *
     * No se resuelve solo. Cambiar el PLU de un artículo mueve con él todo su
     * historial de compras y de precios, y hacerlo porque dos nombres se
     * escriben igual es exactamente la clase de decisión que tiene que tomar
     * una persona mirando los dos.
     */
    const mismoNombre = existentePorNombre.get(normalizeText(fila.nombre));
    if (!existente && mismoNombre && !esDemoAntiguoSinHistorial(mismoNombre)) {
      informe.conflictos.push({
        plu: fila.plu,
        motivo:
          `«${fila.nombre}» ya está en Compras con el PLU ${mismoNombre.internalCode}. ` +
          `El archivo lo trae como ${fila.plu}. No se renumera solo: revisá cuál de los dos ` +
          'es el correcto.',
      });
      continue;
    }

    const familiaNombre = nombreDeFamilia(fila);
    const resumen: ProductoDelInforme = {
      plu: fila.plu,
      nombre: fila.nombre,
      familia: familiaNombre,
      cambios: [],
    };

    if (!existente) {
      informe.nuevos.push(resumen);
    } else {
      if (normalizeText(existente.normalizedName) !== normalizeText(fila.nombre)) {
        resumen.cambios.push({
          campo: 'Nombre',
          antes: existente.normalizedName,
          despues: fila.nombre,
        });
      }
      if (familiaNombre && (existente.family?.name ?? null) !== familiaNombre) {
        resumen.cambios.push({
          campo: 'Familia',
          antes: existente.family?.name ?? SIN_FAMILIA,
          despues: familiaNombre,
        });
      }
      if (fila.categoria && existente.category !== fila.categoria) {
        resumen.cambios.push({
          campo: 'Categoría',
          antes: existente.category ?? SIN_FAMILIA,
          despues: fila.categoria,
        });
      }
      if (fila.subtipo && existente.subtype !== fila.subtipo) {
        resumen.cambios.push({
          campo: 'Subtipo',
          antes: existente.subtype ?? SIN_FAMILIA,
          despues: fila.subtipo,
        });
      }
      if (fila.unidad && existente.purchaseUnit !== fila.unidad) {
        resumen.cambios.push({
          campo: 'Unidad de compra',
          antes: existente.purchaseUnit,
          despues: fila.unidad,
        });
      }
      if (fila.activo !== null && existente.active !== fila.activo) {
        resumen.cambios.push({
          campo: 'Activo',
          antes: existente.active ? 'sí' : 'no',
          despues: fila.activo ? 'sí' : 'no',
        });
      }
      /*
       * Un cambio de nombre sobre un PLU que ya tiene compras va aparte.
       *
       * Renombrar un artículo reetiqueta hacia atrás todo lo que se le compró.
       * Cuando eso pasa, casi siempre es que ese número estaba ocupado por otro
       * artículo —uno de demostración, o cargado a mano— y Control de Stock lo
       * usa para otra cosa. No se bloquea, porque también puede ser una
       * corrección legítima de ortografía; se separa para que se mire.
       */
      const cambiaDeNombre = resumen.cambios.some((c) => c.campo === 'Nombre');
      if (cambiaDeNombre && tienenCompras.has(existente.id)) {
        informe.renombresConCompras.push(resumen);
      } else if (resumen.cambios.length > 0) {
        informe.actualizables.push(resumen);
      } else {
        informe.sinCambios.push(resumen);
      }
    }

    // --- El código del proveedor que venga en la fila ----------------------
    const proveedorNormal = fila.proveedor ? normalizeText(fila.proveedor) : '';
    let proveedor = proveedorNormal ? proveedorPorNombre.get(proveedorNormal) : undefined;
    if (!proveedor && proveedorNormal) {
      const candidatosProveedor = proveedores.filter((p) => {
        const nombre = normalizeText(p.tradeName);
        return nombre.includes(proveedorNormal) || proveedorNormal.includes(nombre);
      });
      if (candidatosProveedor.length === 1) proveedor = candidatosProveedor[0];
    }
    /*
     * El proveedor de la Hoja 1 es de quién se compra habitualmente el
     * artículo, no un código. Que no esté dado de alta en Compras no es un
     * conflicto —el catálogo entra igual— así que se anota una vez y no una
     * por fila: un archivo de quinientos artículos de treinta proveedores
     * llenaría el informe de ruido y taparía lo que sí hay que mirar.
     */
    if (fila.proveedor && !proveedor) {
      if (!informe.proveedoresDesconocidos.includes(fila.proveedor)) {
        informe.proveedoresDesconocidos.push(fila.proveedor);
      }
    }
    if (proveedor && fila.codigoProveedor) {
      const llave = `${proveedor.id}|${normalizarCodigo(fila.codigoProveedor)}`;
      const dueno = duenoDelCodigo.get(llave);
      if (dueno && dueno !== existente?.id) {
        const otro = existentes.find((p) => p.id === dueno);
        informe.conflictos.push({
          plu: fila.plu,
          motivo:
            `El código ${fila.codigoProveedor} de ${fila.proveedor} ya está asignado al PLU ` +
            `${otro?.internalCode ?? '?'}. No se cambia solo: un código de proveedor apunta a ` +
            'un artículo y a uno solo.',
        });
      } else if (!dueno) {
        informe.codigosPorAprender.push({
          plu: fila.plu,
          proveedor: proveedor.tradeName,
          codigo: fila.codigoProveedor,
        });
      }
    }

    if (!opciones.aplicar) continue;

    // --- Escritura ---------------------------------------------------------
    const datosComunes = {
      normalizedName: fila.nombre,
      familyId: idDeFamilia(fila) ?? existente?.familyId ?? null,
      catalogSyncedAt: new Date(),
      // El proveedor de la Hoja 1 queda como proveedor habitual del artículo,
      // que es el campo que ya existía para eso. Si no se lo reconoce, se
      // conserva el que hubiera.
      ...(proveedor ? { defaultSupplierId: proveedor.id } : {}),
      ...(fila.categoria ? { category: fila.categoria } : {}),
      ...(fila.subtipo ? { subtype: fila.subtipo } : {}),
      ...(fila.unidad ? { purchaseUnit: fila.unidad } : {}),
      ...(fila.activo !== null ? { active: fila.activo } : {}),
    };

    const producto = existente
      ? await prisma.product.update({ where: { id: existente.id }, data: datosComunes })
      : await prisma.product.create({
          data: {
            // El PLU se copia tal cual. Es lo único que no se recalcula nunca.
            internalCode: fila.plu,
            ...datosComunes,
            /*
             * Los parámetros de precio son de Compras, no de Stock.
             *
             * Se dejan en su valor por omisión al crear y no se tocan al
             * actualizar: el margen y el redondeo los ajusta quien pone
             * precios, y una importación del catálogo no puede volverlos atrás.
             */
          },
        });
    informe.aplicados += 1;

    if (proveedor && fila.codigoProveedor) {
      const llave = `${proveedor.id}|${normalizarCodigo(fila.codigoProveedor)}`;
      if (!duenoDelCodigo.has(llave)) {
        /*
         * Se aprende con la misma función que usa la confirmación de una
         * factura, y no con un `create` propio.
         *
         * La convención que sostiene el índice único —el código vive en una
         * sola fila de alias del producto, y las demás grafías lo dejan en
         * nulo— tiene que valer igual venga el código de una factura o de una
         * importación. Escribirlo dos veces es tenerlo mal en una de las dos.
         */
        await learnProductAlias(prisma, {
          productId: producto.id,
          supplierId: proveedor.id,
          supplierCode: fila.codigoProveedor,
          description: fila.nombre,
        });
        duenoDelCodigo.set(llave, producto.id);
      }
    }
  }

  // --- Lo que está en Compras y no vino en el archivo -----------------------
  informe.soloEnCompras = existentes
    .filter((p) => !vistos.has(p.internalCode))
    .map((p) => ({
      plu: p.internalCode,
      nombre: p.normalizedName,
      conMovimientos: tienenCompras.has(p.id),
    }));

  informe.demosDesactivables = existentes
    .filter((p) => {
      if (!p.active || vistos.has(p.internalCode) || tienenHistorial.has(p.id)) return false;
      const nombreDemo = CATALOGO_DEMO_ANTIGUO.get(p.internalCode);
      return Boolean(nombreDemo && normalizeText(nombreDemo) === normalizeText(p.normalizedName));
    })
    .map((p) => ({ plu: p.internalCode, nombre: p.normalizedName }));

  if (opciones.aplicar && informe.demosDesactivables.length > 0) {
    await prisma.product.updateMany({
      where: { internalCode: { in: informe.demosDesactivables.map((p) => p.plu) } },
      data: { active: false },
    });
  }

  if (opciones.aplicar) {
    await recordAudit({
      userId: user.id,
      action: AUDIT_ACTIONS.CATALOG_IMPORTED,
      entity: 'Product',
      entityId: 'catalogo',
      after: {
        leidas: informe.totalLeidas,
        creados: informe.nuevos.length,
        actualizados: informe.actualizables.length,
        sinCambios: informe.sinCambios.length,
        conflictos: informe.conflictos.length,
        renombresConCompras: informe.renombresConCompras.length,
        familiasCreadas: informe.familiasNuevas.length,
        familiaDesde: origen,
        codigosAprendidos: informe.codigosPorAprender.length,
        soloEnCompras: informe.soloEnCompras.length,
        demosDesactivados: informe.demosDesactivables.length,
      },
    });
  }

  return informe;
}

export interface ArticuloDelCatalogo {
  id: string;
  plu: string;
  nombre: string;
  familia: string | null;
  categoria: string | null;
  activo: boolean;
  sincronizado: Date | null;
  codigos: { proveedor: string; codigo: string }[];
}

/**
 * El catálogo, buscable por lo que uno tenga a mano.
 *
 * Quien está mirando una factura tiene el código del proveedor; quien conoce el
 * artículo tiene el nombre; quien lo carga en la balanza tiene el PLU. Los tres
 * tienen que servir para encontrarlo: obligar a saber el PLU es obligar a
 * buscarlo antes en otra pantalla.
 */
export async function buscarEnCatalogo(
  user: AuthUser,
  texto: string,
  opciones: { familyId?: string | null; limite?: number } = {},
): Promise<ArticuloDelCatalogo[]> {
  if (!hasPermission(user, PERMISSIONS.PRODUCTOS_GESTIONAR)) {
    throw new ForbiddenError('Tu usuario no puede administrar el catálogo.');
  }

  const busqueda = texto.trim();
  const productos = await prisma.product.findMany({
    where: {
      ...(opciones.familyId ? { familyId: opciones.familyId } : {}),
      ...(busqueda
        ? {
            OR: [
              { internalCode: { contains: busqueda, mode: 'insensitive' as const } },
              { normalizedName: { contains: busqueda, mode: 'insensitive' as const } },
              // Y por el código de cualquier proveedor, que es el dato que se
              // tiene cuando se está mirando el papel del proveedor.
              { aliases: { some: { supplierCode: { contains: busqueda, mode: 'insensitive' as const } } } },
            ],
          }
        : {}),
    },
    orderBy: { internalCode: 'asc' },
    take: opciones.limite ?? 200,
    include: {
      family: { select: { name: true } },
      aliases: {
        where: { supplierCode: { not: null } },
        select: { supplierCode: true, supplier: { select: { tradeName: true } } },
      },
    },
  });

  return productos.map((p) => ({
    id: p.id,
    plu: p.internalCode,
    nombre: p.normalizedName,
    familia: p.family?.name ?? null,
    categoria: p.category,
    activo: p.active,
    sincronizado: p.catalogSyncedAt,
    codigos: p.aliases
      .filter((a) => a.supplierCode)
      .map((a) => ({
        proveedor: a.supplier?.tradeName ?? 'Sin proveedor',
        codigo: a.supplierCode!,
      })),
  }));
}
