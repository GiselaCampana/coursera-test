import { prisma } from '@/lib/db';
import { Decimal } from '@/lib/money';
import { assertBranchAccess, hasPermission, type AuthUser } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { acceptReadDocument, matchItemsToProducts } from '@/lib/services/documents';
import type { MatchMethod } from '@/lib/domain/matching';

/**
 * **Qué va a pasar si se confirma esta compra, dicho antes de que pase.**
 *
 * Una factura confirmada escribe en tres lugares a la vez: el comprobante, el
 * egreso que se va a pagar y los movimientos de mercadería de cada renglón. Lo
 * que faltaba era poder **verlo antes**, entero y sin que se escriba nada, y
 * poder distinguir de un vistazo lo que el papel dice de lo que el motor
 * dedujo.
 *
 * Esa distinción no es cosmética. Un neto leído del comprobante y un neto que
 * salió de una cuenta valen distinto para quien firma la compra: el primero se
 * puede verificar mirando el papel, el segundo es una ayuda del motor. Por eso
 * cada valor viaja con su **procedencia**, y por eso una sugerencia derivada no
 * puede pasar por dato impreso ni alcanzar para aplicar la compra.
 *
 * Lo que esta capa **no** hace, y es su definición:
 *
 *  - no escribe. Ni un campo, ni una asociación aprendida, ni un contador;
 *  - no decide asociaciones de producto por parecido de nombre. Un producto se
 *    asocia por el código del proveedor o porque una persona lo eligió, y nada
 *    más;
 *  - no completa importes que faltan. Los nombra.
 */

// ---------------------------------------------------------------------------
// Lo que se muestra
// ---------------------------------------------------------------------------

/**
 * De dónde salió cada cosa que se muestra.
 *
 * Son las cuatro que el motor distingue y las cuatro que cambian lo que una
 * persona tiene que hacer con el valor: mirarlo, verificarlo, decidirlo o
 * completarlo.
 */
export type Procedencia =
  /** Está impreso en el comprobante y se leyó de ahí. */
  | 'LEIDO'
  /**
   * Lo ubicó una relación del documento, no su etiqueta.
   *
   * El motor la distingue —un IVA que se reconoció porque cumple neto × 21 %
   * tiene esa procedencia— pero el comprobante guardado todavía no la conserva
   * campo por campo: guarda el valor impreso y el calculado, y nada entre medio.
   * Así que hoy esta pantalla no la produce, y decirlo es parte de lo que
   * informa: cuando la lectura empiece a guardar la procedencia de cada
   * concepto, entra por acá sin tocar nada más.
   */
  | 'INFERIDO'
  /** Es una cuenta que el motor ofrece como ayuda. No es un dato del papel. */
  | 'SUGERIDO'
  /** Falta, o hay más de una respuesta posible. */
  | 'PENDIENTE';

export interface ValorConProcedencia {
  etiqueta: string;
  valor: string | null;
  procedencia: Procedencia;
  /** De dónde salió, en palabras, para poder auditarlo. */
  detalle: string | null;
}

/** Cómo quedó asociado el renglón a un producto del catálogo. */
export type EstadoDeAsociacion =
  /** Por el código que este proveedor usa para ese producto, o elegido a mano. */
  | 'INEQUIVOCA'
  /** Hay un candidato por parecido de nombre, que no alcanza para aplicar. */
  | 'AMBIGUA'
  /** No hay ningún candidato. */
  | 'SIN_ASOCIAR';

export interface RenglonDeLaVistaPrevia {
  numero: number;
  codigoDelProveedor: string | null;
  descripcion: string;
  cantidad: string;
  unidad: string;
  importe: string;
  producto: {
    id: string | null;
    nombre: string | null;
    unidadDelCatalogo: string | null;
    estado: EstadoDeAsociacion;
    metodo: MatchMethod;
    porQue: string;
  };
}

export interface VistaPreviaDeCompra {
  documentId: string;
  estadoDelComprobante: string;
  emisor: {
    proveedorId: string | null;
    nombre: string | null;
    cuit: ValorConProcedencia;
    habitual: boolean;
  };
  encabezado: ValorConProcedencia[];
  renglones: RenglonDeLaVistaPrevia[];
  pieFiscal: ValorConProcedencia[];
  /** Lo que se va a pagar: un solo movimiento económico. */
  egreso: {
    total: ValorConProcedencia;
    vencimiento: string | null;
    condicion: string | null;
    yaAgendado: boolean;
  };
  /** Lo que va a mover de mercadería: un movimiento por renglón asociado. */
  stock: {
    movimientos: {
      renglon: number;
      productoId: string;
      producto: string;
      cantidad: string;
      unidad: string;
      costoTotal: string;
    }[];
    renglonesSinMovimiento: number;
  };
  /** Por qué no se puede aplicar todavía. Vacío quiere decir que se puede. */
  frenos: string[];
  sePuedeAplicar: boolean;
}

// ---------------------------------------------------------------------------
// El armado
// ---------------------------------------------------------------------------

const UNIDADES: Record<string, string> = { KG: 'kg', UNIT: 'unidades', PIEZA: 'piezas' };

function comoTexto(valor: Decimal | null | undefined): string | null {
  return valor === null || valor === undefined ? null : new Decimal(valor.toString()).toFixed(2);
}

/**
 * Un importe del pie, con la procedencia que le corresponde.
 *
 * El comprobante guarda el valor impreso y el calculado por separado, y esa
 * separación es justamente la que hay que mostrar: cuando el papel no lo trae y
 * el número sale de la suma de los renglones, es una sugerencia y se dice.
 */
function delPie(
  etiqueta: string,
  impreso: Decimal | null,
  calculado: Decimal | null,
): ValorConProcedencia {
  if (impreso !== null && impreso !== undefined) {
    return {
      etiqueta,
      valor: comoTexto(impreso),
      procedencia: 'LEIDO',
      detalle: 'Impreso en el comprobante.',
    };
  }
  if (calculado !== null && calculado !== undefined) {
    return {
      etiqueta,
      valor: comoTexto(calculado),
      procedencia: 'SUGERIDO',
      detalle: 'No está impreso: sale de la suma de los renglones. No es un dato del papel.',
    };
  }
  return { etiqueta, valor: null, procedencia: 'PENDIENTE', detalle: 'Falta en el comprobante.' };
}

/**
 * ¿Alcanza esta asociación para mover mercadería?
 *
 * Dos cosas, y nada más que dos: **el código que este proveedor usa para ese
 * producto**, que es una identificación y no un parecido, y **la elección de
 * una persona**, que es una decisión tomada mirando el papel.
 *
 * Todo lo que salga del nombre queda afuera, y eso incluye la coincidencia
 * exacta de la descripción con el nombre del catálogo. Parece inofensiva y no
 * lo es: dos artículos pueden llamarse casi igual —«jamón cocido mini» de dos
 * marcas distintas— y costar la mitad uno del otro, y una compra cargada al
 * producto equivocado ensucia el costo, el precio de venta y el stock a la vez.
 * El nombre alcanza para **proponer**; para cargar la compra hace falta que
 * alguien lo confirme una vez, y desde ahí queda el código aprendido.
 */
function estadoDeLaAsociacion(metodo: MatchMethod, hayProducto: boolean): EstadoDeAsociacion {
  if (!hayProducto) return 'SIN_ASOCIAR';
  if (metodo === 'SUPPLIER_CODE' || metodo === 'MANUAL') return 'INEQUIVOCA';
  return 'AMBIGUA';
}

/**
 * Arma la vista previa de una compra. **No escribe nada.**
 */
export async function vistaPreviaDeCompra(
  user: AuthUser,
  documentId: string,
): Promise<VistaPreviaDeCompra> {
  if (!hasPermission(user, PERMISSIONS.COMPROBANTES_VER)) {
    throw new NotFoundError('No encontramos ese comprobante.');
  }

  const documento = await prisma.document.findUnique({
    where: { id: documentId },
    include: {
      supplier: true,
      items: { orderBy: { lineNumber: 'asc' } },
      paymentSchedule: true,
      taxLines: true,
    },
  });
  if (!documento) throw new NotFoundError('No encontramos ese comprobante.');
  assertBranchAccess(user, documento.branchId);

  // --- El emisor ----------------------------------------------------------
  const emisor = {
    proveedorId: documento.supplierId,
    nombre: documento.supplier?.tradeName ?? null,
    cuit: documento.supplier?.cuit
      ? {
          etiqueta: 'CUIT',
          valor: documento.supplier.cuit,
          procedencia: 'LEIDO' as Procedencia,
          detalle: 'Del proveedor ya registrado.',
        }
      : {
          etiqueta: 'CUIT',
          valor: null,
          procedencia: 'PENDIENTE' as Procedencia,
          detalle: 'Todavía no hay un proveedor elegido para este comprobante.',
        },
    habitual: documento.supplierId !== null,
  };

  // --- El encabezado ------------------------------------------------------
  const encabezado: ValorConProcedencia[] = [
    {
      etiqueta: 'Número',
      valor: documento.number,
      procedencia: documento.number ? 'LEIDO' : 'PENDIENTE',
      detalle: documento.number ? 'Leído del comprobante.' : 'Falta el número.',
    },
    {
      etiqueta: 'Fecha de emisión',
      valor: documento.issueDate ? documento.issueDate.toISOString().slice(0, 10) : null,
      procedencia: documento.issueDate ? 'LEIDO' : 'PENDIENTE',
      detalle: documento.issueDate ? 'Leída del comprobante.' : 'Falta la fecha.',
    },
  ];

  // --- Los renglones y su producto ---------------------------------------
  const paraReconocer = documento.items.map((item) => ({
    description: item.description,
    supplierCode: item.supplierCode,
  }));
  const reconocidos = documento.supplierId
    ? await matchItemsToProducts(paraReconocer as never, documento.supplierId)
    : [];

  const idsDeProducto = [
    ...new Set(
      documento.items
        .map((i, indice) => i.productId ?? reconocidos[indice]?.productId ?? null)
        .filter((id): id is string => id !== null),
    ),
  ];
  const productos = idsDeProducto.length
    ? await prisma.product.findMany({
        where: { id: { in: idsDeProducto } },
        select: { id: true, normalizedName: true, purchaseUnit: true },
      })
    : [];
  const porId = new Map(productos.map((p) => [p.id, p]));

  const renglones: RenglonDeLaVistaPrevia[] = documento.items.map((item, indice) => {
    const reconocido = reconocidos[indice];
    const elegidoAMano = item.productId !== null;
    const productoId = item.productId ?? reconocido?.productId ?? null;
    const metodo: MatchMethod = elegidoAMano
      ? ((item.matchMethod as MatchMethod) || 'MANUAL')
      : (reconocido?.method ?? 'NONE');
    const estado = estadoDeLaAsociacion(metodo, productoId !== null);
    const producto = productoId ? porId.get(productoId) : undefined;

    return {
      numero: item.lineNumber,
      codigoDelProveedor: item.supplierCode,
      descripcion: item.description,
      cantidad: new Decimal(item.quantity.toString()).toFixed(3),
      unidad: UNIDADES[item.unit] ?? item.unit,
      importe: comoTexto(new Decimal(item.totalCost.toString())) ?? '0.00',
      producto: {
        id: productoId,
        nombre: producto?.normalizedName ?? null,
        unidadDelCatalogo: producto ? (UNIDADES[producto.purchaseUnit] ?? producto.purchaseUnit) : null,
        estado,
        metodo,
        porQue:
          estado === 'INEQUIVOCA'
            ? metodo === 'SUPPLIER_CODE'
              ? 'Por el código que este proveedor usa para el producto.'
              : 'Lo eligió una persona.'
            : estado === 'AMBIGUA'
              ? 'Coincide por el nombre, y eso alcanza para proponerlo pero no para cargarle la compra.'
              : (reconocido?.reason ?? 'Nadie asoció este renglón todavía.'),
      },
    };
  });

  /*
   * Lo que suman los renglones, que es lo único que el motor puede ofrecer
   * cuando el papel no trae el número impreso. Se calcula acá y se informa como
   * sugerencia: no es un dato del comprobante.
   */
  const sumaDeRenglones = documento.items.reduce(
    (acumulado, item) => ({
      neto: acumulado.neto.plus(item.netAmount.toString()),
      iva: acumulado.iva.plus(item.ivaAmount.toString()),
      percepciones: acumulado.percepciones.plus(item.perceptionAmount.toString()),
      total: acumulado.total.plus(item.totalCost.toString()),
    }),
    {
      neto: new Decimal(0),
      iva: new Decimal(0),
      percepciones: new Decimal(0),
      total: new Decimal(0),
    },
  );

  // --- El pie fiscal ------------------------------------------------------
  const pieFiscal: ValorConProcedencia[] = [
    delPie('Neto gravado', documento.netTotal, sumaDeRenglones.neto),
    delPie('IVA', documento.ivaTotal, sumaDeRenglones.iva),
    delPie('Percepciones', documento.perceptionsTotal, sumaDeRenglones.percepciones),
    delPie('Total', documento.total, sumaDeRenglones.total),
  ];

  // --- El egreso ----------------------------------------------------------
  const total = delPie('Total a pagar', documento.total, sumaDeRenglones.total);
  const egreso = {
    total,
    vencimiento: documento.paymentSchedule?.dueDate
      ? documento.paymentSchedule.dueDate.toISOString().slice(0, 10)
      : null,
    condicion: documento.appliedTermDays != null ? `${documento.appliedTermDays} días` : null,
    yaAgendado: documento.paymentSchedule !== null,
  };

  // --- El movimiento de mercadería ---------------------------------------
  const conProducto = renglones.filter((r) => r.producto.estado === 'INEQUIVOCA');
  const stock = {
    movimientos: conProducto.map((r) => ({
      renglon: r.numero,
      productoId: r.producto.id as string,
      producto: r.producto.nombre ?? '(sin nombre)',
      cantidad: r.cantidad,
      unidad: r.producto.unidadDelCatalogo ?? r.unidad,
      costoTotal: r.importe,
    })),
    renglonesSinMovimiento: renglones.length - conProducto.length,
  };

  // --- Lo que frena la aplicación -----------------------------------------
  const frenos = frenosDeLaCompra({ emisorElegido: emisor.proveedorId !== null, renglones, total });

  return {
    documentId: documento.id,
    estadoDelComprobante: documento.status,
    emisor,
    encabezado,
    renglones,
    pieFiscal,
    egreso,
    stock,
    frenos,
    sePuedeAplicar: frenos.length === 0 && documento.status !== 'VALIDADO',
  };
}

/**
 * Por qué no se puede aplicar todavía.
 *
 * Es la misma lista que mira la vista previa y la que mira la confirmación, a
 * propósito: si fueran dos, la pantalla podría decir que se puede y el backend
 * negarse, que es la peor manera de enterarse.
 */
export function frenosDeLaCompra(entrada: {
  emisorElegido: boolean;
  renglones: { numero: number; descripcion: string; producto: { estado: EstadoDeAsociacion } }[];
  total: ValorConProcedencia;
}): string[] {
  const frenos: string[] = [];

  if (!entrada.emisorElegido) {
    frenos.push('Falta elegir el proveedor del comprobante.');
  }

  const sinAsociar = entrada.renglones.filter((r) => r.producto.estado !== 'INEQUIVOCA');
  for (const renglon of sinAsociar) {
    frenos.push(
      `El renglón ${renglon.numero} («${renglon.descripcion}») no está asociado a un producto ` +
        'de forma inequívoca: hace falta el código del proveedor o elegirlo a mano.',
    );
  }

  /*
   * Y el total. Un total que falta frena por evidente; uno que salió de una
   * cuenta frena porque **no es un dato del papel**: aplicar la compra por ese
   * número es pagar lo que el motor supone, no lo que el proveedor facturó.
   */
  if (entrada.total.procedencia === 'PENDIENTE') {
    frenos.push('Falta el total del comprobante.');
  } else if (entrada.total.procedencia === 'SUGERIDO') {
    frenos.push(
      'El total no está impreso en el comprobante: el que se muestra es una suma del motor. ' +
        'Hay que confirmarlo contra el papel antes de aplicar la compra.',
    );
  }

  return frenos;
}

/**
 * Aplica la compra, y sólo si la vista previa dice que se puede.
 *
 * Es la única puerta del hito: se mira lo que va a pasar, se confirma
 * explícitamente, y recién ahí se escribe. La lista de frenos que revisa es la
 * **misma** que muestra la pantalla —no una copia— así que no puede pasar que
 * la vista previa diga que sí y el backend diga que no.
 *
 * Lo que escribe lo escribe `confirmDocument`, que ya lo hacía y lo hace en una
 * transacción: rehace renglones y movimientos, así que aplicar dos veces no
 * duplica nada, y el segundo intento sobre un comprobante ya validado se
 * rechaza con un conflicto en vez de volver a escribir.
 */
export async function aplicarCompra(user: AuthUser, documentId: string) {
  const previa = await vistaPreviaDeCompra(user, documentId);

  if (previa.frenos.length > 0) {
    throw new ValidationError(
      `Esta compra no se puede aplicar todavía. ${previa.frenos.join(' ')}`,
    );
  }

  return acceptReadDocument(user, documentId);
}
