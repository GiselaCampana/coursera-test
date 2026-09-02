import 'server-only';
import { prisma } from '@/lib/db';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { hasPermission, type AuthUser } from '@/lib/auth/session';
import { normalizarCodigo, normalizeText } from '@/lib/domain/matching';
import { leerCatalogo, type FilaDeCatalogo } from '@/lib/domain/catalogo';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/services/audit';
import { learnProductAlias } from '@/lib/services/documents';
import { reglaGeneralVigente } from '@/lib/services/pricing';
import { toDecimal } from '@/lib/money';
import type { MarginBasis } from '@/lib/domain/pricing';
import type { FuenteDeMarcajes } from '@/lib/domain/marcajes';

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
  /** Códigos adicionales del mismo PLU, traídos por filas repetidas. */
  const codigosExtra = new Map<string, { proveedor: string | null; codigo: string }[]>();
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
      continue;
    }

    /*
     * Mismo PLU, mismo nombre y **otro** código de proveedor: no es la fila
     * repetida, es un código más para el mismo artículo.
     *
     * Errecalde factura la muzzarella Barraza en plancha con dos códigos según
     * la presentación —ART-01611 de 10 kg y ART-82444 de 5 kg— y para Don Ginés
     * las dos son el PLU 1317. Descartar la segunda fila por "duplicada"
     * perdería ese código, y la próxima factura que lo traiga entraría sin
     * asociar sin que nadie entienda por qué.
     */
    if (
      fila.codigoProveedor &&
      normalizarCodigo(fila.codigoProveedor) !== normalizarCodigo(previa.codigoProveedor ?? '')
    ) {
      const extras = codigosExtra.get(fila.plu) ?? [];
      extras.push({ proveedor: fila.proveedor ?? previa.proveedor, codigo: fila.codigoProveedor });
      codigosExtra.set(fila.plu, extras);
    }
    // Repetido con el mismo nombre y el mismo código: es la misma fila dos veces.
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
    /*
     * Todos los códigos de este PLU: el de su fila más los que hayan traído
     * las filas repetidas. Un artículo puede tener más de un código del mismo
     * proveedor, y todos tienen que quedar aprendidos.
     */
    const codigosDeLaFila: { proveedor: string | null; codigo: string }[] = [
      ...(fila.codigoProveedor
        ? [{ proveedor: fila.proveedor, codigo: fila.codigoProveedor }]
        : []),
      ...(codigosExtra.get(fila.plu) ?? []),
    ];

    for (const entrada of codigosDeLaFila) {
      const suProveedor = entrada.proveedor
        ? (proveedorPorNombre.get(normalizeText(entrada.proveedor)) ?? proveedor)
        : proveedor;
      if (!suProveedor) continue;

      const llave = `${suProveedor.id}|${normalizarCodigo(entrada.codigo)}`;
      const dueno = duenoDelCodigo.get(llave);
      if (dueno && dueno !== existente?.id) {
        const otro = existentes.find((p) => p.id === dueno);
        informe.conflictos.push({
          plu: fila.plu,
          motivo:
            `El código ${entrada.codigo} de ${suProveedor.tradeName} ya está asignado al PLU ` +
            `${otro?.internalCode ?? '?'}. No se cambia solo: un código de proveedor apunta a ` +
            'un artículo y a uno solo.',
        });
      } else if (!dueno) {
        informe.codigosPorAprender.push({
          plu: fila.plu,
          proveedor: suProveedor.tradeName,
          codigo: entrada.codigo,
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
             * No se cargan al crear y no se tocan al actualizar: el margen y el
             * redondeo los ajusta quien pone precios, y una importación del
             * catálogo no puede volverlos atrás.
             *
             * Sin marcaje propio, el artículo importado hereda el de su
             * familia. Es lo que se quiere: configurar el rubro una vez y que
             * los ciento veinticinco PLU lo tomen, en vez de arrancar todos con
             * un 45 % grabado que después hay que corregir uno por uno.
             */
          },
        });
    informe.aplicados += 1;

    for (const entrada of codigosDeLaFila) {
      const suProveedor = entrada.proveedor
        ? (proveedorPorNombre.get(normalizeText(entrada.proveedor)) ?? proveedor)
        : proveedor;
      if (!suProveedor) continue;
      const llave = `${suProveedor.id}|${normalizarCodigo(entrada.codigo)}`;
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
          supplierId: suProveedor.id,
          supplierCode: entrada.codigo,
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

// ---------------------------------------------------------------------------
// Marcajes por familia
// ---------------------------------------------------------------------------

/**
 * Un porcentaje escrito a mano, listo para guardar. Vacío se guarda vacío.
 *
 * Vacío es "este nivel no dice nada" y deja que resuelva el de abajo. Un cero
 * es un cero: vender al costo. Confundirlos es lo único que puede romper la
 * cadena, así que la distinción se hace una sola vez, acá.
 */
function tasa(valor: string | null | undefined, etiqueta: string): string | null {
  const raw = (valor ?? '').trim();
  if (raw === '') return null;
  const d = toDecimal(raw);
  const fraccion = d.gt(1) ? d.div(100) : d;
  if (fraccion.isNegative() || fraccion.gte(1)) {
    throw new ValidationError(`El marcaje de ${etiqueta} tiene que estar entre 0 y menos de 100.`);
  }
  return fraccion.toString();
}

/** Los ocho marcajes específicos más el base, validados y listos para escribir. */
function marcajesParaGuardar(valores: FuenteDeMarcajes) {
  return {
    targetMarginPct: tasa(valores.targetMarginPct, 'base'),
    marginBasis: valores.marginBasis ?? null,
    alCorteHormaDigitalMarginPct: tasa(valores.alCorteHormaDigitalMarginPct, 'horma digital'),
    alCorteHormaCashMarginPct: tasa(valores.alCorteHormaCashMarginPct, 'horma efectivo'),
    alCorteCajaCashMarginPct: tasa(valores.alCorteCajaCashMarginPct, 'caja efectivo'),
    feteado100gMarginPct: tasa(valores.feteado100gMarginPct, '100 g'),
    feteadoQuarterMarginPct: tasa(valores.feteadoQuarterMarginPct, '1/4 kg'),
    feteadoPieceDigitalMarginPct: tasa(valores.feteadoPieceDigitalMarginPct, 'pieza digital'),
    feteadoPieceCashMarginPct: tasa(valores.feteadoPieceCashMarginPct, 'pieza efectivo'),
    wholeUnitMarginPct: tasa(valores.wholeUnitMarginPct, 'unidad entera'),
  };
}

/** Lo que una fila de la base (familia o regla general) le dice al resolvedor. */
function comoFuenteDeMarcajes(fila: {
  targetMarginPct: { toString(): string } | null;
  marginBasis: string | null;
  alCorteHormaDigitalMarginPct: { toString(): string } | null;
  alCorteHormaCashMarginPct: { toString(): string } | null;
  alCorteCajaCashMarginPct: { toString(): string } | null;
  feteado100gMarginPct: { toString(): string } | null;
  feteadoQuarterMarginPct: { toString(): string } | null;
  feteadoPieceDigitalMarginPct: { toString(): string } | null;
  feteadoPieceCashMarginPct: { toString(): string } | null;
  wholeUnitMarginPct: { toString(): string } | null;
}): FuenteDeMarcajes {
  return {
    targetMarginPct: fila.targetMarginPct?.toString() ?? null,
    marginBasis: (fila.marginBasis as MarginBasis | null) ?? null,
    alCorteHormaDigitalMarginPct: fila.alCorteHormaDigitalMarginPct?.toString() ?? null,
    alCorteHormaCashMarginPct: fila.alCorteHormaCashMarginPct?.toString() ?? null,
    alCorteCajaCashMarginPct: fila.alCorteCajaCashMarginPct?.toString() ?? null,
    feteado100gMarginPct: fila.feteado100gMarginPct?.toString() ?? null,
    feteadoQuarterMarginPct: fila.feteadoQuarterMarginPct?.toString() ?? null,
    feteadoPieceDigitalMarginPct: fila.feteadoPieceDigitalMarginPct?.toString() ?? null,
    feteadoPieceCashMarginPct: fila.feteadoPieceCashMarginPct?.toString() ?? null,
    wholeUnitMarginPct: fila.wholeUnitMarginPct?.toString() ?? null,
  };
}

export interface FamiliaConMarcajes {
  id: string;
  nombre: string;
  articulos: number;
  /** Cuántos de esos artículos no definen su propio marcaje base y heredan. */
  heredanElBase: number;
  marcajes: FuenteDeMarcajes;
}

/**
 * Las familias con sus marcajes y cuántos artículos dependen de ellos.
 *
 * El segundo número es el que hace falta antes de tocar nada: cambiar el
 * marcaje de una familia mueve el precio de todos los artículos que lo heredan
 * y de ninguno de los que tienen el suyo. Sin verlo, el cambio se hace a
 * ciegas.
 */
export async function familiasConMarcajes(user: AuthUser): Promise<FamiliaConMarcajes[]> {
  if (!hasPermission(user, PERMISSIONS.PRODUCTOS_GESTIONAR)) {
    throw new ForbiddenError('Tu usuario no puede configurar el catálogo.');
  }

  const familias = await prisma.productFamily.findMany({ orderBy: { name: 'asc' } });
  const conteos = await prisma.product.groupBy({
    by: ['familyId'],
    where: { active: true },
    _count: { _all: true },
  });
  const heredan = await prisma.product.groupBy({
    by: ['familyId'],
    where: { active: true, targetMarginPct: null },
    _count: { _all: true },
  });

  const total = new Map(conteos.map((c) => [c.familyId, c._count._all]));
  const sinBase = new Map(heredan.map((c) => [c.familyId, c._count._all]));

  return familias.map((f) => ({
    id: f.id,
    nombre: f.name,
    articulos: total.get(f.id) ?? 0,
    heredanElBase: sinBase.get(f.id) ?? 0,
    marcajes: comoFuenteDeMarcajes(f),
  }));
}

/**
 * Guarda los marcajes de una familia.
 *
 * No toca ningún artículo. Los que heredan van a empezar a usar el número
 * nuevo la próxima vez que se calcule su precio, y los que tienen el suyo no se
 * enteran. Escribirlo en cada artículo sería exactamente lo contrario de lo que
 * la familia viene a resolver, y además haría irreversible el cambio.
 */
export async function guardarMarcajesDeFamilia(
  user: AuthUser,
  familyId: string,
  valores: FuenteDeMarcajes,
) {
  if (!hasPermission(user, PERMISSIONS.PRODUCTOS_GESTIONAR)) {
    throw new ForbiddenError('Tu usuario no puede configurar el catálogo.');
  }
  const familia = await prisma.productFamily.findUnique({ where: { id: familyId } });
  if (!familia) throw new NotFoundError('No encontramos esa familia.');

  const data = marcajesParaGuardar(valores);

  const guardada = await prisma.productFamily.update({ where: { id: familyId }, data });

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.FAMILY_MARKUPS_UPDATED,
    entity: 'ProductFamily',
    entityId: familyId,
    before: {
      base: familia.targetMarginPct?.toString() ?? null,
      marginBasis: familia.marginBasis,
    },
    after: { base: data.targetMarginPct, marginBasis: data.marginBasis },
  });

  return guardada;
}

// ---------------------------------------------------------------------------
// La regla general
// ---------------------------------------------------------------------------

export interface ReglaGeneralDeMarcajes {
  /** Null mientras no exista ninguna: la primera vez que se guarda se crea. */
  id: string | null;
  nombre: string;
  marcajes: FuenteDeMarcajes;
  /** Cuántos artículos activos no definen su base ni lo hereda su familia. */
  dependenDeElla: number;
}

/**
 * La regla general, tal como la lee el cálculo de precios.
 *
 * Se busca con la misma consulta que usa `resolvePricingRule`, no con otra
 * parecida: lo que se edita acá es la fila que de verdad se aplica. Es lo que
 * convierte la regla general en el tercer nivel de la cadena en lugar de una
 * pantalla que muestra números que nadie usa.
 */
export async function reglaGeneralDeMarcajes(
  user: AuthUser,
): Promise<ReglaGeneralDeMarcajes> {
  if (!hasPermission(user, PERMISSIONS.PRODUCTOS_GESTIONAR)) {
    throw new ForbiddenError('Tu usuario no puede configurar el catálogo.');
  }

  const regla = await reglaGeneralVigente();

  /*
   * A cuántos artículos les llega de verdad.
   *
   * Sólo a los que no tienen base propio **y** cuya familia tampoco lo define
   * (o que no tienen familia). Los demás nunca ven la regla general, y decir
   * "afecta a 300 artículos" cuando afecta a 12 haría que nadie se anime a
   * tocarla.
   */
  const familiasConBase = await prisma.productFamily.findMany({
    where: { targetMarginPct: { not: null } },
    select: { id: true },
  });
  const dependenDeElla = await prisma.product.count({
    where: {
      active: true,
      targetMarginPct: null,
      /*
       * Los sin familia van explícitos: un `notIn` no los alcanza.
       *
       * En SQL, comparar NULL contra una lista da NULL y la fila queda afuera,
       * así que un artículo sin familia —que es el que más depende de la regla
       * general— desaparecía de la cuenta en cuanto alguna familia definía su
       * base.
       */
      OR: [{ familyId: null }, { familyId: { notIn: familiasConBase.map((f) => f.id) } }],
    },
  });

  return {
    id: regla?.id ?? null,
    nombre: regla?.name ?? 'Regla general',
    marcajes: regla
      ? comoFuenteDeMarcajes(regla)
      : {
          targetMarginPct: null,
          marginBasis: null,
          alCorteHormaDigitalMarginPct: null,
          alCorteHormaCashMarginPct: null,
          alCorteCajaCashMarginPct: null,
          feteado100gMarginPct: null,
          feteadoQuarterMarginPct: null,
          feteadoPieceDigitalMarginPct: null,
          feteadoPieceCashMarginPct: null,
          wholeUnitMarginPct: null,
        },
    dependenDeElla,
  };
}

/**
 * Guarda la regla general. No toca ningún artículo ni ninguna familia.
 *
 * Actualiza la fila vigente; si todavía no hay ninguna, la crea. Nunca crea una
 * segunda: dos reglas generales activas serían dos configuraciones globales
 * paralelas, que es justamente lo que no puede haber.
 */
export async function guardarReglaGeneralDeMarcajes(
  user: AuthUser,
  valores: FuenteDeMarcajes,
) {
  if (!hasPermission(user, PERMISSIONS.PRODUCTOS_GESTIONAR)) {
    throw new ForbiddenError('Tu usuario no puede configurar el catálogo.');
  }

  const { targetMarginPct, marginBasis, ...especificos } = marcajesParaGuardar(valores);

  /*
   * Acá el base sí es obligatorio, y es la única diferencia con los otros dos
   * niveles.
   *
   * Vacío significa heredar, pero abajo de la regla general no hay nada de
   * dónde heredar: es el piso. Un piso vacío dejaría a los artículos que
   * dependen de él sin ningún marcaje, y el precio saldría de un número
   * escondido en el código en vez de una decisión que alguien tomó.
   */
  if (targetMarginPct === null) {
    throw new ValidationError(
      'La regla general necesita un marcaje base: es el último nivel y no hereda de nadie.',
    );
  }

  const data = {
    ...especificos,
    targetMarginPct,
    marginBasis: marginBasis ?? 'SOBRE_COSTO',
  };
  const actual = await reglaGeneralVigente();

  const guardada = actual
    ? await prisma.pricingRule.update({ where: { id: actual.id }, data })
    : await prisma.pricingRule.create({
        data: {
          ...data,
          name: 'Regla general',
          productId: null,
          active: true,
          // Desde siempre: la regla general no tiene fecha de estreno, es el
          // piso de la cadena.
          validFrom: new Date('2020-01-01T00:00:00Z'),
        },
      });

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.GENERAL_MARKUPS_UPDATED,
    entity: 'PricingRule',
    entityId: guardada.id,
    before: actual
      ? { base: actual.targetMarginPct?.toString() ?? null, marginBasis: actual.marginBasis }
      : null,
    after: { base: data.targetMarginPct, marginBasis: data.marginBasis },
  });

  return guardada;
}
