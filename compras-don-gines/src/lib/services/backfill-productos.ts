import 'server-only';
import { prisma, type Prisma } from '@/lib/db';
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/errors';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { hasPermission, type AuthUser } from '@/lib/auth/session';
import { matchProduct, normalizarCodigo, normalizeText, type ProductCandidate } from '@/lib/domain/matching';
import { parsearCsv } from '@/lib/domain/catalogo';
import { AUDIT_ACTIONS, recordAudit } from '@/lib/services/audit';
import { learnProductAlias } from '@/lib/services/documents';
import { toDecimal } from '@/lib/money';

/**
 * Reasignación de productos a compras que quedaron sin clasificar.
 *
 * Las facturas confirmadas antes de que la asociación se resolviera del lado
 * del servidor guardaron sus renglones con `productId` en nulo, y para el
 * reporte por producto esas compras no existen: se validaron, se pagaron, están
 * en el total general, y al filtrar por el artículo dan cero.
 *
 * Esto las repara **sin tocar plata**. Lo único que escribe son dos columnas de
 * asociación —`DocumentItem.productId` y `PurchaseMovement.productId`, con su
 * método— y las entradas de historial de costos que no existían por no haber
 * producto al que colgarlas. Cantidades, kilos, precios, IVA, percepciones,
 * costos, totales e imágenes quedan exactamente como estaban.
 *
 * Y no adivina: usa el mismo reconocimiento que la carga —código del proveedor
 * primero, después alias y descripción— y sólo aplica lo inequívoco. Lo dudoso
 * queda pendiente y se informa, porque un producto mal asignado es peor que uno
 * sin asignar: el sin asignar se ve, el mal asignado ensucia el costo de un
 * artículo que nadie compró.
 *
 * El orden importa especialmente acá. Si ya se sabe que el ART-00228 de
 * Errecalde es el PLU 1211, **todas** las compras históricas con ese código se
 * pueden asociar sin dudar, por mal escrita que venga la descripción: el código
 * es una identificación y la descripción, un parecido. Por eso lo resuelto por
 * código se informa aparte, y es lo que en la práctica rescata a los renglones
 * cuya descripción salió del OCR hecha pedazos.
 */

export interface RenglonDelInforme {
  documentItemId: string;
  documentId: string;
  documentNumber: string;
  supplierId: string | null;
  supplierName: string | null;
  description: string;
  supplierCode: string | null;
  productId: string | null;
  /** El PLU interno, para poder mostrar "→ PLU 1211 · Cremoso Punta del Agua". */
  productCode: string | null;
  productName: string | null;
  method: string;
  score: number | null;
  reason?: string;
  /** Los candidatos cercanos, para ofrecerlos al resolver una ambigua a mano. */
  sugerencias?: { productId: string; productCode: string; productName: string; score: number }[];
}

export interface InformeDeBackfill {
  /**
   * Reconocidas por el código del proveedor: las de mayor confianza.
   *
   * Van separadas de las demás porque no dependen de cómo haya salido la
   * descripción del OCR. Si Errecalde ya dijo que su ART-00228 es el PLU 1211,
   * la compra es de ese artículo por ilegible que esté el renglón.
   */
  porCodigo: RenglonDelInforme[];
  /** Reconocidas por alias o descripción, sin empate y por encima del umbral. */
  porDescripcion: RenglonDelInforme[];
  /** Más de un producto se parece por igual: las resuelve una persona. */
  ambiguas: RenglonDelInforme[];
  /** No se parecen a nada del catálogo. */
  sinCoincidencia: RenglonDelInforme[];
  /** Cuántas se escribieron. Cero cuando se pide sólo el informe. */
  aplicadas: number;
}

/** Las dos juntas: es lo que se aplica. */
export function segurasDe(informe: InformeDeBackfill): RenglonDelInforme[] {
  return [...informe.porCodigo, ...informe.porDescripcion];
}


export interface FilaMapeoCodigo {
  codigoProveedor: string;
  plu: string;
  producto: string | null;
  motivo?: string;
}

export interface InformeMapeoCodigos {
  total: number;
  aplicables: FilaMapeoCodigo[];
  yaExistentes: FilaMapeoCodigo[];
  conflictos: FilaMapeoCodigo[];
  aplicadas: number;
}

/**
 * Importa relaciones proveedor + código -> PLU en lote, siempre con vista previa.
 *
 * Es el puente entre una factura ya interpretada y el catálogo real: el código
 * del proveedor es estable, el PLU es estable, y una vez aprendida la relación
 * el backfill histórico y las facturas futuras dejan de depender del parecido
 * de los nombres.
 */
export async function importarMapeoCodigosProveedor(
  user: AuthUser,
  supplierId: string,
  texto: string,
  opciones: { aplicar?: boolean } = {},
): Promise<InformeMapeoCodigos> {
  if (!hasPermission(user, PERMISSIONS.PRODUCTOS_GESTIONAR)) {
    throw new ForbiddenError('Tu usuario no puede administrar códigos de proveedor.');
  }
  const proveedor = await prisma.supplier.findUnique({ where: { id: supplierId } });
  if (!proveedor) throw new NotFoundError('No encontramos ese proveedor.');

  const filas = parsearCsv(texto.trim());
  if (filas.length === 0) {
    return { total: 0, aplicables: [], yaExistentes: [], conflictos: [], aplicadas: 0 };
  }

  const encabezados = filas[0].map((h) => normalizeText(h));
  const indice = (variantes: string[]) =>
    encabezados.findIndex((h) => variantes.includes(h));
  const iCodigo = indice([
    'codigo proveedor',
    'codigo de proveedor',
    'codigo del proveedor',
    'supplier code',
    'codigo',
  ]);
  const iPlu = indice(['plu', 'codigo interno', 'internal code']);

  if (iCodigo < 0 || iPlu < 0) {
    throw new ConflictError(
      'El archivo necesita dos columnas: Código proveedor y PLU.',
    );
  }

  const productos = await prisma.product.findMany({
    select: { id: true, internalCode: true, normalizedName: true },
  });
  const porPlu = new Map(productos.map((p) => [p.internalCode, p]));
  const aliases = await prisma.productAlias.findMany({
    where: { supplierId, supplierCode: { not: null } },
    select: { productId: true, supplierCode: true },
  });
  const dueno = new Map(
    aliases
      .filter((a) => a.supplierCode)
      .map((a) => [normalizarCodigo(a.supplierCode!), a.productId]),
  );

  const informe: InformeMapeoCodigos = {
    total: 0,
    aplicables: [],
    yaExistentes: [],
    conflictos: [],
    aplicadas: 0,
  };
  const vistos = new Map<string, string>();

  for (let n = 1; n < filas.length; n++) {
    const codigoProveedor = (filas[n][iCodigo] ?? '').trim();
    const plu = (filas[n][iPlu] ?? '').trim();
    if (!codigoProveedor && !plu) continue;
    informe.total += 1;

    if (!codigoProveedor || !plu) {
      informe.conflictos.push({
        codigoProveedor,
        plu,
        producto: null,
        motivo: 'Falta el código del proveedor o el PLU.',
      });
      continue;
    }

    const producto = porPlu.get(plu);
    if (!producto) {
      informe.conflictos.push({
        codigoProveedor,
        plu,
        producto: null,
        motivo: `El PLU ${plu} no existe en el catálogo Don Ginés.`,
      });
      continue;
    }

    const clave = normalizarCodigo(codigoProveedor);
    const repetido = vistos.get(clave);
    if (repetido && repetido !== plu) {
      informe.conflictos.push({
        codigoProveedor,
        plu,
        producto: producto.normalizedName,
        motivo: `El mismo código aparece también asociado al PLU ${repetido} en este archivo.`,
      });
      continue;
    }
    vistos.set(clave, plu);

    const actual = dueno.get(clave);
    if (actual === producto.id) {
      informe.yaExistentes.push({
        codigoProveedor,
        plu,
        producto: producto.normalizedName,
      });
      continue;
    }
    if (actual && actual !== producto.id) {
      const otro = productos.find((p) => p.id === actual);
      informe.conflictos.push({
        codigoProveedor,
        plu,
        producto: producto.normalizedName,
        motivo:
          `Ese código ya pertenece al PLU ${otro?.internalCode ?? '?'} · ` +
          `${otro?.normalizedName ?? 'otro producto'}.`,
      });
      continue;
    }

    informe.aplicables.push({
      codigoProveedor,
      plu,
      producto: producto.normalizedName,
    });
  }

  if (!opciones.aplicar || informe.aplicables.length === 0) return informe;

  await prisma.$transaction(async (tx) => {
    for (const fila of informe.aplicables) {
      const producto = porPlu.get(fila.plu)!;
      await learnProductAlias(tx, {
        productId: producto.id,
        supplierId,
        supplierCode: fila.codigoProveedor,
        description: producto.normalizedName,
      });
      informe.aplicadas += 1;
    }
  });

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.PRODUCT_UPDATED,
    entity: 'Supplier',
    entityId: supplierId,
    after: {
      proveedor: proveedor.tradeName,
      codigosImportados: informe.aplicadas,
      relaciones: informe.aplicables.map((f) => ({
        codigo: f.codigoProveedor,
        plu: f.plu,
      })),
    },
  });

  return informe;
}

/**
 * Completa CostHistory cuando se asocia una compra histórica.
 *
 * Compras lee PurchaseMovement, pero Precios lee CostHistory. Si el backfill
 * sólo completa productId, la compra aparece en Compras y sigue siendo
 * invisible para Precios.
 */
async function asegurarHistorialDeCosto(
  tx: Prisma.TransactionClient,
  renglon: {
    documentId: string;
    unitNetPrice: { toString(): string };
    unitCost: { toString(): string };
    document: {
      supplierId: string | null;
      branchId: string;
      issueDate: Date | null;
    };
  },
  productId: string,
): Promise<boolean> {
  const supplierId = renglon.document.supplierId;
  const fecha = renglon.document.issueDate;
  if (!supplierId || !fecha) return false;

  // Tiene que haber una entrada de costo por renglón asociado, incluso si dos
  // renglones de la misma factura terminan en el mismo PLU.
  const [asociados, costosExistentes] = await Promise.all([
    tx.documentItem.count({ where: { documentId: renglon.documentId, productId } }),
    tx.costHistory.count({ where: { documentId: renglon.documentId, productId } }),
  ]);
  if (costosExistentes >= asociados) return false;

  const previo = await tx.costHistory.findFirst({
    where: { productId, date: { lte: fecha } },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
  });
  const anterior = previo ? toDecimal(previo.unitCost.toString()) : null;
  const actual = toDecimal(renglon.unitCost.toString());
  const delta = anterior ? actual.minus(anterior) : null;

  await tx.costHistory.create({
    data: {
      productId,
      supplierId,
      branchId: renglon.document.branchId,
      documentId: renglon.documentId,
      date: fecha,
      unitNetPrice: renglon.unitNetPrice.toString(),
      unitCost: actual.toString(),
      previousUnitCost: anterior?.toString() ?? null,
      deltaAmount: delta?.toString() ?? null,
      deltaPct:
        anterior && !anterior.isZero()
          ? delta!.div(anterior).toDecimalPlaces(6).toString()
          : null,
    },
  });
  return true;
}

/**
 * @param aplicar `false` —el valor por omisión— sólo informa, no escribe nada.
 *   Es a propósito: el informe se mira antes de tocar la base, no después.
 */
export async function backfillProductLinks(
  user: AuthUser,
  opciones: { aplicar?: boolean; supplierId?: string } = {},
): Promise<InformeDeBackfill> {
  if (!hasPermission(user, PERMISSIONS.PRODUCTOS_GESTIONAR)) {
    throw new ForbiddenError('Tu usuario no puede reasignar productos.');
  }

  const productos = await prisma.product.findMany({
    where: { active: true },
    select: {
      id: true,
      internalCode: true,
      normalizedName: true,
      aliases: { select: { normalized: true, supplierId: true, supplierCode: true } },
    },
  });
  const candidatos: ProductCandidate[] = productos.map((p) => ({
    id: p.id,
    internalCode: p.internalCode,
    normalizedName: normalizeText(p.normalizedName),
    aliases: p.aliases,
  }));
  const porId = new Map(productos.map((p) => [p.id, p]));

  /*
   * Sólo comprobantes ya validados.
   *
   * Un borrador o algo que quedó a revisar todavía puede cambiar de renglones
   * cuando alguien lo confirme, y ahí la asociación se resuelve sola por el
   * camino normal. Reasignar ahora sería adelantarse a una decisión que no está
   * tomada.
   */
  const renglones = await prisma.documentItem.findMany({
    where: {
      productId: null,
      document: {
        status: 'VALIDADO',
        ...(opciones.supplierId ? { supplierId: opciones.supplierId } : {}),
      },
    },
    include: {
      document: {
        select: {
          id: true,
          fullNumber: true,
          supplierId: true,
          branchId: true,
          issueDate: true,
          supplier: { select: { tradeName: true } },
        },
      },
    },
    orderBy: { id: 'asc' },
  });

  const informe: InformeDeBackfill = {
    porCodigo: [],
    porDescripcion: [],
    ambiguas: [],
    sinCoincidencia: [],
    aplicadas: 0,
  };

  for (const renglon of renglones) {
    const resultado = matchProduct(
      {
        description: renglon.description,
        supplierCode: renglon.supplierCode,
        supplierId: renglon.document.supplierId,
      },
      candidatos,
    );

    const elegido = resultado.productId ? porId.get(resultado.productId) : null;

    const fila: RenglonDelInforme = {
      documentItemId: renglon.id,
      documentId: renglon.document.id,
      documentNumber: renglon.document.fullNumber ?? 'sin número',
      supplierId: renglon.document.supplierId,
      supplierName: renglon.document.supplier?.tradeName ?? null,
      description: renglon.description,
      supplierCode: renglon.supplierCode,
      productId: resultado.productId,
      productCode: elegido?.internalCode ?? null,
      productName: elegido?.normalizedName ?? null,
      method: resultado.method,
      score: resultado.score,
      reason: resultado.reason,
      sugerencias: (resultado.suggestions ?? [])
        .map((sug) => {
          const p = porId.get(sug.productId);
          return p
            ? {
                productId: p.id,
                productCode: p.internalCode,
                productName: p.normalizedName,
                score: sug.score,
              }
            : null;
        })
        .filter((s): s is NonNullable<typeof s> => s !== null),
    };

    if (resultado.productId) {
      if (resultado.method === 'SUPPLIER_CODE') informe.porCodigo.push(fila);
      else informe.porDescripcion.push(fila);
    } else if ((fila.sugerencias?.length ?? 0) > 0) {
      // Se parece a algo, pero no lo suficiente o no de forma única.
      informe.ambiguas.push(fila);
    } else {
      informe.sinCoincidencia.push(fila);
    }
  }

  const seguras = segurasDe(informe);
  if (!opciones.aplicar || seguras.length === 0) return informe;

  /* Qué se le puso a cada renglón: va al asiento de auditoría. */
  const aplicadas: { renglon: string; comprobante: string; plu: string; metodo: string }[] = [];
  let costosCreados = 0;

  for (const fila of seguras) {
    const renglon = renglones.find((r) => r.id === fila.documentItemId)!;
    const productId = fila.productId!;

    const costoCreado = await prisma.$transaction(async (tx) => {
      await tx.documentItem.update({
        where: { id: renglon.id },
        data: { productId, matchMethod: fila.method },
      });

      // El movimiento se actualiza, no se crea: ya existe uno por renglón.
      await tx.purchaseMovement.updateMany({
        where: { documentItemId: renglon.id },
        data: { productId },
      });

      // Precios no lee PurchaseMovement; necesita su CostHistory.
      return asegurarHistorialDeCosto(tx, renglon, productId);
    });
    if (costoCreado) costosCreados += 1;

    informe.aplicadas += 1;
    aplicadas.push({
      renglon: fila.documentItemId,
      comprobante: fila.documentNumber,
      plu: fila.productCode ?? fila.productId!,
      metodo: fila.method,
    });
  }

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.PRODUCT_BACKFILL,
    entity: 'Product',
    entityId: opciones.supplierId ?? 'todos',
    after: {
      aplicadas: informe.aplicadas,
      porCodigo: informe.porCodigo.length,
      porDescripcion: informe.porDescripcion.length,
      ambiguas: informe.ambiguas.length,
      sinCoincidencia: informe.sinCoincidencia.length,
      costosCreados,
      /*
       * Qué producto se le puso a cada renglón.
       *
       * Sin este detalle el asiento diría "se aplicaron 47" y no habría forma de
       * revisar ni de revertir una asignación concreta sin volver a correr el
       * análisis, que para entonces ya daría otra cosa.
       */
      renglones: aplicadas,
      /* Y cuáles quedaron para que las resuelva una persona. */
      pendientes: informe.ambiguas.map((a) => ({
        renglon: a.documentItemId,
        comprobante: a.documentNumber,
        descripcion: a.description,
        codigo: a.supplierCode,
      })),
    },
  });

  return informe;
}

export interface CrearProductoDesdeRenglonInput {
  documentItemId: string;
  internalCode?: string | null;
  normalizedName: string;
  usesPlu: boolean;
  barcode?: string | null;
  saleMode: 'FETEABLE' | 'AL_CORTE';
  purchaseUnit: 'KG' | 'UNIT';
  purchaseUnitWeightKg?: string | null;
}

/**
 * Da de alta un artículo que todavía no existe y asocia el renglón histórico
 * en el mismo flujo. Sirve para incorporaciones reales del surtido: no obliga
 * a inventar una asociación con un PLU viejo sólo para poder confirmar la compra.
 */
export async function crearProductoDesdeRenglon(
  user: AuthUser,
  input: CrearProductoDesdeRenglonInput,
) {
  if (!hasPermission(user, PERMISSIONS.PRODUCTOS_GESTIONAR)) {
    throw new ForbiddenError('Tu usuario no puede crear productos.');
  }

  const renglon = await prisma.documentItem.findUnique({
    where: { id: input.documentItemId },
    include: { document: { select: { supplierId: true, status: true } } },
  });
  if (!renglon) throw new NotFoundError('No encontramos ese renglón.');
  if (renglon.productId) throw new ConflictError('Ese renglón ya está asociado a un producto.');
  if (renglon.document.status !== 'VALIDADO') {
    throw new ConflictError('Sólo se pueden resolver compras ya validadas desde esta pantalla.');
  }

  const nombre = input.normalizedName.trim();
  const barcode = (input.barcode ?? '').trim() || null;
  let internalCode = (input.internalCode ?? '').trim();

  if (!nombre) throw new ConflictError('Escribí el nombre del producto nuevo.');
  if (input.usesPlu && !internalCode) {
    throw new ConflictError('Para un producto con PLU, escribí el PLU nuevo.');
  }
  if (!input.usesPlu && !barcode) {
    throw new ConflictError('Para un producto sin PLU, cargá el código de barras.');
  }
  if (!input.usesPlu && !internalCode) internalCode = `BC-${barcode}`;

  const [pluTomado, barcodeTomado] = await Promise.all([
    prisma.product.findUnique({ where: { internalCode } }),
    barcode ? prisma.product.findUnique({ where: { barcode } }) : Promise.resolve(null),
  ]);
  if (pluTomado) {
    throw new ConflictError(`El código interno ${internalCode} ya existe. Buscalo en el listado y asociá ese producto.`);
  }
  if (barcodeTomado) {
    throw new ConflictError(`El código de barras ${barcode} ya pertenece a ${barcodeTomado.normalizedName}.`);
  }

  const peso = (input.purchaseUnitWeightKg ?? '').trim();
  if (peso && toDecimal(peso).lte(0)) {
    throw new ConflictError('Los kilos por unidad tienen que ser mayores a cero.');
  }

  const producto = await prisma.product.create({
    data: {
      internalCode,
      normalizedName: nombre,
      usesPlu: input.usesPlu,
      barcode,
      saleMode: input.saleMode,
      purchaseUnit: input.purchaseUnit,
      purchaseUnitWeightKg:
        input.purchaseUnit === 'UNIT' && peso ? toDecimal(peso).toString() : null,
      cashDiscountPct: '0',
    },
  });

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.PRODUCT_UPDATED,
    entity: 'Product',
    entityId: producto.id,
    after: {
      creadoDesdeCompra: renglon.id,
      identificacion: input.usesPlu ? internalCode : barcode,
      nombre,
    },
  });

  await asociarRenglonHistorico(user, renglon.id, producto.id, { aprenderCodigo: true });
  return producto;
}

/**
 * Resuelve a mano un renglón histórico que el reconocimiento dejó dudoso.
 *
 * Es la salida de las ambiguas: el que mira la factura elige el PLU, y al
 * confirmarlo la asociación queda escrita en el renglón y en su movimiento.
 *
 * Y, si el renglón traía un código de proveedor, **queda aprendida la relación
 * proveedor + código → producto**. Es lo que hace que este trabajo se haga una
 * sola vez: la próxima factura que traiga ese mismo código se vincula sola, y
 * las compras históricas que lo compartan las levanta el análisis siguiente sin
 * volver a preguntar.
 */
export async function asociarRenglonHistorico(
  user: AuthUser,
  documentItemId: string,
  productId: string,
  opciones: { aprenderCodigo?: boolean } = {},
): Promise<void> {
  if (!hasPermission(user, PERMISSIONS.PRODUCTOS_GESTIONAR)) {
    throw new ForbiddenError('Tu usuario no puede reasignar productos.');
  }

  const renglon = await prisma.documentItem.findUnique({
    where: { id: documentItemId },
    include: {
      document: { select: { supplierId: true, fullNumber: true, status: true, branchId: true, issueDate: true } },
    },
  });
  if (!renglon) throw new NotFoundError('No encontramos ese renglón.');
  if (renglon.productId) {
    throw new ConflictError('Ese renglón ya está asociado a un producto.');
  }

  const producto = await prisma.product.findUnique({ where: { id: productId } });
  if (!producto) throw new NotFoundError('No encontramos ese producto.');

  const codigo = renglon.supplierCode?.trim() || null;
  const supplierId = renglon.document.supplierId;

  /*
   * Si el código ya está tomado por otro producto, no se aprende nada.
   *
   * El renglón se asocia igual —el que mira la factura sabe qué compró— pero el
   * código no se toca: dárselo a este producto se lo sacaría al otro, y eso
   * cambiaría en silencio la clasificación de todas las compras que dependen de
   * él. Ese conflicto se resuelve en la ficha del producto, a la vista.
   */
  let aprendido = false;
  if (opciones.aprenderCodigo && codigo && supplierId) {
    const tomado = await prisma.productAlias.findFirst({
      where: { supplierId, supplierCode: codigo },
    });
    if (!tomado) {
      const sinCodigo = await prisma.productAlias.findFirst({
        where: { productId, supplierId, supplierCode: null },
        orderBy: { createdAt: 'asc' },
      });
      if (sinCodigo) {
        await prisma.productAlias.update({
          where: { id: sinCodigo.id },
          data: { supplierCode: codigo, origin: 'MANUAL' },
        });
      } else {
        await prisma.productAlias.create({
          data: {
            productId,
            supplierId,
            supplierCode: codigo,
            alias: renglon.description,
            normalized: normalizeText(renglon.description),
            origin: 'MANUAL',
          },
        });
      }
      aprendido = true;
    }
  }

  const costoCreado = await prisma.$transaction(async (tx) => {
    await tx.documentItem.update({
      where: { id: documentItemId },
      data: { productId, matchMethod: 'MANUAL' },
    });
    await tx.purchaseMovement.updateMany({
      where: { documentItemId },
      data: { productId },
    });
    return asegurarHistorialDeCosto(tx, renglon, productId);
  });

  await recordAudit({
    userId: user.id,
    action: AUDIT_ACTIONS.PRODUCT_BACKFILL,
    entity: 'DocumentItem',
    entityId: documentItemId,
    after: {
      comprobante: renglon.document.fullNumber,
      descripcion: renglon.description,
      codigoDeProveedor: codigo,
      plu: producto.internalCode,
      producto: producto.normalizedName,
      codigoAprendido: aprendido,
      costoCreado,
      resueltoAMano: true,
    },
  });
}
