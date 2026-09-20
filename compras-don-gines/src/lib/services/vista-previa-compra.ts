import { prisma } from '@/lib/db';
import { Decimal } from '@/lib/money';
import { formatDateAr, parseArDate, toDateOnly, toISODate } from '@/lib/datetime';
import { assertBranchAccess, hasPermission, type AuthUser } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { acceptReadDocument, matchItemsToProducts } from '@/lib/services/documents';
import { getSupplierConditions } from '@/lib/services/suppliers';
import { computeDueDate, describeTerm, type TermType } from '@/lib/domain/payments';
import {
  resolverDecisionDePago,
  vencimientoPosibleParaLaEmision,
  type DecisionDePago,
} from '@/lib/domain/decision-de-pago';
import type { MatchMethod } from '@/lib/domain/matching';
import {
  clasificarRenglon,
  indicePorCodigo,
  CLASE_DE_GASTO_LABEL,
  type ClaseDeGasto,
  type CodigoDeGasto,
} from '@/lib/domain/gastos';

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
   * No está impreso, pero hay evidencia registrada que lo determina.
   *
   * Hoy la produce la condición de pago que está configurada **en la ficha de
   * este proveedor**: no se lee del papel, pero alguien la acordó y la cargó, y
   * eso es distinto de una cuenta del motor.
   *
   * El motor distingue además las relaciones del propio documento —un IVA que
   * se reconoció porque cumple neto × 21 %— pero el comprobante guardado
   * todavía no conserva esa procedencia campo por campo: guarda el valor
   * impreso y el calculado, y nada entre medio. Cuando la lectura empiece a
   * guardarla, entra por acá sin tocar nada más.
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
  /**
   * Cuando el renglón no es mercadería sino un gasto del comprobante.
   *
   * Null quiere decir mercadería. Con valor, el renglón se paga igual pero no
   * mueve existencias ni necesita artículo, y la pantalla lo muestra aparte
   * para que no se confunda con lo que entra a la heladera.
   */
  gasto: {
    clase: ClaseDeGasto;
    comoSeLlama: string;
    /** De dónde salió la clasificación. Nunca de la descripción. */
    porQue: string;
  } | null;
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
    /**
     * Cuándo se paga, con su procedencia.
     *
     * Era un texto suelto y ahí estaba el problema: decía «a definir al
     * aplicar» y al aplicar no se definía nada, se rellenaba con la fecha de
     * emisión. Ahora, o sale de una condición acordada y se puede reproducir
     * —emisión + 30 días—, o está pendiente de verdad y frena.
     */
    vencimiento: ValorConProcedencia;
    condicion: ValorConProcedencia;
    yaAgendado: boolean;
    /**
     * Si hace falta que una persona elija forma de pago y vencimiento.
     *
     * Es lo que enciende el formulario en la pantalla, y lo mismo que el
     * servidor vuelve a exigir al aplicar.
     */
    hayQueElegirComoSePaga: boolean;
    /**
     * La emisión en ISO, para que la pantalla pueda calcular la cuenta.
     *
     * Es el único dato que le falta al formulario para mostrar, antes de
     * aplicar, qué día cae lo que la persona acaba de elegir. Sin eso elegir
     * «a 30 días» es elegir a ciegas: se ve el plazo pero no la fecha, y la
     * fecha es lo que se firma.
     */
    emisionISO: string | null;
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
      /**
       * Por qué la unidad del movimiento no es la del renglón, cuando no lo es.
       *
       * Pasa de verdad: la factura de Ezra imprime «3,000» para tres bolsas
       * igual que imprime «4,240» para cuatro kilos y pico de queso, y el papel
       * no trae nada que las distinga. La unidad la pone el catálogo, que es
       * donde alguien ya decidió cómo se compra ese artículo, y el movimiento
       * dice que la puso de ahí en vez de cambiarla en silencio.
       */
      porQueEsaUnidad: string | null;
    }[];
    renglonesSinMovimiento: number;
  };
  /**
   * Lo que se paga y no entra al stock: bolsas, fletes.
   *
   * Va en su propia lista y no escondido entre los movimientos, porque son dos
   * cosas distintas: una aumenta existencias y la otra no. Su importe está
   * dentro del egreso, y no se reparte entre los artículos —eso sería una
   * decisión contable aparte, que nadie tomó—.
   */
  gastos: {
    renglon: number;
    descripcion: string;
    cantidad: string;
    unidad: string;
    importe: string;
    comoSeLlama: string;
    porQue: string;
  }[];
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
 * La condición de pago, y de dónde salió.
 *
 * Una condición de pago equivocada se paga: decide cuándo sale la plata. Por
 * eso acá no vale cualquier número que esté guardado en el comprobante, sino
 * uno que se pueda atribuir a **este** proveedor.
 *
 * Lo que se acepta es la condición cargada en la ficha del proveedor, vigente
 * a la fecha del comprobante. Lo que no se acepta —y es el caso que importa—
 * es un plazo que quedó escrito en el comprobante sin que este proveedor tenga
 * ninguno configurado: no se sabe de dónde salió, y lo más probable es que sea
 * el de otro. Mostrarlo sería prestarle a un proveedor nuevo las condiciones
 * del habitual, que es exactamente lo que una compra excepcional no puede
 * heredar. Se dice que falta y se define al aplicar.
 *
 * Todavía no entra el caso de la condición **impresa en la factura**: el
 * comprobante guardado no tiene dónde conservarla. Cuando la lectura la
 * guarde, entra como LEIDO y gana sobre la ficha, porque sería el papel.
 */
export function condicionDePago(entrada: {
  /** La de la ficha de este proveedor, vigente a la fecha del comprobante. */
  deLaFicha: { termType: TermType; days: number; paymentMethod: string } | null;
  /** La que quedó escrita en el comprobante, sea cual sea su origen. */
  enElComprobante: { termType: string | null; days: number | null };
}): ValorConProcedencia {
  if (entrada.deLaFicha) {
    return {
      etiqueta: 'Condición',
      valor: describeTerm(entrada.deLaFicha),
      procedencia: 'INFERIDO',
      detalle: 'Configurada en la ficha de este proveedor. No está impresa en el comprobante.',
    };
  }

  if (entrada.enElComprobante.days !== null || entrada.enElComprobante.termType !== null) {
    return {
      etiqueta: 'Condición',
      valor: null,
      procedencia: 'PENDIENTE',
      detalle:
        'El comprobante trae un plazo que este proveedor no tiene configurado. No se muestra, ' +
        'porque sería la condición de otro proveedor. Se define al aplicar.',
    };
  }

  return {
    etiqueta: 'Condición',
    valor: null,
    procedencia: 'PENDIENTE',
    detalle: 'Este proveedor no tiene condición de pago configurada. Se define al aplicar.',
  };
}

/**
 * Cuándo se paga, y de dónde sale esa fecha.
 *
 * Tres casos y ninguna omisión. Si el pago ya está agendado, la fecha es la
 * agendada. Si el proveedor tiene una condición acordada, la fecha se
 * **calcula** con ella y se dice la cuenta, para que cualquiera la reproduzca.
 * Si no hay ninguna de las dos, está pendiente: y pendiente quiere decir que
 * falta, no que se resuelve sola con la fecha de emisión.
 */
export function vencimientoDelEgreso(entrada: {
  yaAgendado: Date | null;
  deLaFicha: { termType: TermType; days: number; paymentMethod: string } | null;
  emision: Date | null;
  proximaFactura: Date | null;
}): ValorConProcedencia {
  if (entrada.yaAgendado) {
    return {
      etiqueta: 'Vencimiento',
      valor: formatDateAr(entrada.yaAgendado),
      procedencia: 'LEIDO',
      detalle: 'Ya está agendado.',
    };
  }

  if (entrada.deLaFicha && entrada.emision) {
    const calculado = computeDueDate(entrada.emision, entrada.deLaFicha, {
      proximaFactura: entrada.proximaFactura ?? undefined,
    });
    /*
     * Una condición puede no dar fecha: «fecha manual» no la da por
     * definición, y «factura contra factura» tampoco hasta que se sepa cuándo
     * llega la próxima. En esos casos falta, y se dice.
     */
    if (calculado && vencimientoPosibleParaLaEmision(calculado, entrada.emision)) {
      return {
        etiqueta: 'Vencimiento',
        valor: formatDateAr(calculado),
        procedencia: 'INFERIDO',
        detalle:
          `Calculado con la condición del proveedor: ${describeTerm(entrada.deLaFicha)}, ` +
          `desde la emisión del ${formatDateAr(entrada.emision)}.`,
      };
    }
  }

  /*
   * «Factura contra factura» sin saber cuándo llega la próxima.
   *
   * Hay condición acordada y falta un dato del vínculo con el proveedor, no
   * una decisión sobre esta factura. Se agenda provisoriamente para la fecha
   * de emisión y la agenda queda marcada como provisoria, que es como el
   * sistema ya lo modela.
   */
  if (entrada.deLaFicha?.termType === 'NEXT_INVOICE' && entrada.emision) {
    return {
      etiqueta: 'Vencimiento',
      valor: formatDateAr(entrada.emision),
      procedencia: 'SUGERIDO',
      detalle:
        'Factura contra factura: hasta que se sepa cuándo llega la próxima, queda agendada ' +
        'provisoriamente y se corrige después.',
    };
  }

  return {
    etiqueta: 'Vencimiento',
    valor: null,
    procedencia: 'PENDIENTE',
    detalle: 'Hay que elegir la forma de pago y el vencimiento antes de aplicar la compra.',
  };
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
      valor: documento.issueDate ? formatDateAr(documento.issueDate) : null,
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

  /*
   * Los códigos de este proveedor que no son mercadería.
   *
   * Se consultan acá y no se deducen de nada: un renglón es gasto porque su
   * código está configurado como gasto, o porque alguien lo eligió. La
   * descripción no participa.
   */
  const codigosDeGasto = indicePorCodigo(
    documento.supplierId
      ? ((await prisma.supplierExpenseCode.findMany({
          where: { supplierId: documento.supplierId },
          select: { supplierCode: true, kind: true, unit: true, label: true },
        })) as unknown as CodigoDeGasto[])
      : [],
  );

  const renglones: RenglonDeLaVistaPrevia[] = documento.items.map((item, indice) => {
    const clasificacion = clasificarRenglon(
      { expenseKind: item.expenseKind as ClaseDeGasto | null, supplierCode: item.supplierCode },
      codigosDeGasto,
    );
    const esGasto = clasificacion.kind !== null;

    const reconocido = reconocidos[indice];
    const elegidoAMano = item.productId !== null;
    // Un gasto no lleva artículo, ni siquiera el que el reconocimiento proponga.
    const productoId = esGasto ? null : (item.productId ?? reconocido?.productId ?? null);
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
      /*
       * La unidad de un gasto sale de su configuración; la del renglón viene
       * de la lectura, que en esta factura trae todo en kilos porque el papel
       * no distingue tres bolsas de tres kilos de queso.
       */
      unidad: UNIDADES[clasificacion.unit ?? item.unit] ?? item.unit,
      importe: comoTexto(new Decimal(item.totalCost.toString())) ?? '0.00',
      gasto: esGasto
        ? {
            clase: clasificacion.kind!,
            comoSeLlama: clasificacion.label ?? CLASE_DE_GASTO_LABEL[clasificacion.kind!],
            porQue:
              clasificacion.origen === 'ELEGIDO_A_MANO'
                ? 'Lo clasificó una persona en este comprobante.'
                : 'El código de este proveedor está configurado como gasto, no como mercadería.',
          }
        : null,
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
  /*
   * Las condiciones se buscan con la misma función que usa la carga, y a la
   * fecha del comprobante: un plazo que cambió el mes pasado no puede mover el
   * vencimiento de una factura vieja.
   */
  const condicionesDelProveedor = documento.supplierId
    ? await getSupplierConditions(documento.supplierId, documento.issueDate ?? new Date())
    : null;
  const deLaFicha = condicionesDelProveedor?.term ?? null;

  const condicion = condicionDePago({
    deLaFicha,
    enElComprobante: {
      termType: documento.appliedTermType,
      days: documento.appliedTermDays,
    },
  });
  const vencimiento = vencimientoDelEgreso({
    yaAgendado: documento.paymentSchedule?.dueDate ?? null,
    deLaFicha,
    emision: documento.issueDate,
    proximaFactura: condicionesDelProveedor?.proximaFactura ?? null,
  });

  const egreso = {
    total,
    vencimiento,
    condicion,
    yaAgendado: documento.paymentSchedule !== null,
    /*
     * Hay que elegir cuando no hay una condición acordada que dé la fecha.
     *
     * Con condición configurada la fecha se calcula y se puede reproducir; sin
     * ella no hay nada que calcular, y rellenarla fue exactamente el defecto.
     */
    hayQueElegirComoSePaga:
      documento.paymentSchedule === null && vencimiento.procedencia === 'PENDIENTE',
    emisionISO: documento.issueDate ? toISODate(toDateOnly(documento.issueDate)) : null,
  };

  // --- El movimiento de mercadería ---------------------------------------
  /*
   * Sólo la mercadería mueve existencias. Los gastos se listan aparte, más
   * abajo: se pagan igual, pero no hay tres bolsas más en la heladera.
   */
  const mercaderia = renglones.filter((r) => r.gasto === null);
  const conProducto = mercaderia.filter((r) => r.producto.estado === 'INEQUIVOCA');
  const stock = {
    movimientos: conProducto.map((r) => {
      const unidad = r.producto.unidadDelCatalogo ?? r.unidad;
      return {
        renglon: r.numero,
        productoId: r.producto.id as string,
        producto: r.producto.nombre ?? '(sin nombre)',
        cantidad: r.cantidad,
        unidad,
        costoTotal: r.importe,
        porQueEsaUnidad:
          unidad === r.unidad
            ? null
            : `El comprobante dice «${r.unidad}» en este renglón; la unidad sale del catálogo, ` +
              'donde ya está decidido cómo se compra este artículo.',
      };
    }),
    renglonesSinMovimiento: mercaderia.length - conProducto.length,
  };

  const gastos = renglones
    .filter((r) => r.gasto !== null)
    .map((r) => ({
      renglon: r.numero,
      descripcion: r.descripcion,
      cantidad: r.cantidad,
      unidad: r.unidad,
      importe: r.importe,
      comoSeLlama: r.gasto!.comoSeLlama,
      porQue: r.gasto!.porQue,
    }));

  // --- Lo que frena la aplicación -----------------------------------------
  const frenos = frenosDeLaCompra({
    emisorElegido: emisor.proveedorId !== null,
    renglones: renglones.map((r) => ({ ...r, esGasto: r.gasto !== null })),
    total,
    hayQueElegirComoSePaga: egreso.hayQueElegirComoSePaga,
  });

  return {
    documentId: documento.id,
    estadoDelComprobante: documento.status,
    emisor,
    encabezado,
    renglones,
    pieFiscal,
    egreso,
    stock,
    gastos,
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
  renglones: {
    numero: number;
    descripcion: string;
    /** Un gasto del comprobante no necesita artículo para poder aplicarse. */
    esGasto: boolean;
    producto: { estado: EstadoDeAsociacion };
  }[];
  total: ValorConProcedencia;
  /** Cuando el proveedor no tiene condición acordada, alguien tiene que elegir. */
  hayQueElegirComoSePaga: boolean;
}): string[] {
  const frenos: string[] = [];

  if (!entrada.emisorElegido) {
    frenos.push('Falta elegir el proveedor del comprobante.');
  }

  /*
   * Un gasto no exige artículo, y por eso no frena.
   *
   * Es el punto de todo esto: las tres bolsas de Ezra dejaban la compra
   * bloqueada pidiendo que alguien eligiera a qué producto del catálogo
   * pertenecían, y no pertenecen a ninguno. Clasificado como gasto, el renglón
   * está resuelto: se paga y no entra al stock.
   */
  const sinAsociar = entrada.renglones.filter(
    (r) => !r.esGasto && r.producto.estado !== 'INEQUIVOCA',
  );
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

  /*
   * Y cómo se paga.
   *
   * Este freno es el que faltaba. La pantalla decía «a definir al aplicar» y al
   * aplicar no se definía nada: el vencimiento caía en la fecha de emisión y la
   * forma de pago en «Transferencia», las dos sin que nadie las eligiera. Una
   * fecha de pago inventada es indistinguible de una acordada para quien la
   * mira después.
   */
  if (entrada.hayQueElegirComoSePaga) {
    frenos.push(
      'Este proveedor no tiene condición de pago configurada: hay que elegir la forma de pago ' +
        'y el vencimiento. No hay ninguno por omisión.',
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
export async function aplicarCompra(
  user: AuthUser,
  documentId: string,
  /** Forma de pago y vencimiento, cuando el proveedor no los tiene acordados. */
  decision?: DecisionDePago | null,
) {
  const previa = await vistaPreviaDeCompra(user, documentId);

  /*
   * Los frenos que la decisión resuelve se descuentan acá.
   *
   * El único que una elección puede levantar es el de cómo se paga: si vino
   * una decisión válida, ese freno ya no aplica. Los demás —el proveedor, las
   * asociaciones, el total sugerido— no se levantan con nada que venga en la
   * llamada, y por eso se miran igual.
   */
  const resuelto = decision
    ? resolverDecisionDePago(decision, obtenerEmision(previa))
    : null;
  if (decision && resuelto && !resuelto.ok) {
    throw new ValidationError(resuelto.motivo);
  }

  const frenos = previa.frenos.filter(
    (freno) => !(resuelto?.ok && freno.startsWith('Este proveedor no tiene condición de pago')),
  );

  if (frenos.length > 0) {
    throw new ValidationError(`Esta compra no se puede aplicar todavía. ${frenos.join(' ')}`);
  }

  return acceptReadDocument(user, documentId, decision ?? null);
}

/**
 * La fecha de emisión del comprobante, para poder validar la decisión.
 *
 * Sale de la misma vista previa que se acaba de armar, así que la fecha contra
 * la que se compara el vencimiento es exactamente la que la persona vio.
 */
function obtenerEmision(previa: VistaPreviaDeCompra): Date {
  const campo = previa.encabezado.find((c) => c.etiqueta === 'Fecha de emisión');
  const leida = campo?.valor ? parseArDate(campo.valor) : null;
  if (!leida) {
    throw new ValidationError('El comprobante no tiene fecha de emisión.');
  }
  return leida;
}
