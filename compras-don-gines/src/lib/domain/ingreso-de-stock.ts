import type { PurchaseUnit } from '@prisma/client';

/**
 * **Un renglón de compra convertido en un ingreso de mercadería.**
 *
 * Una compra tiene dos consecuencias que se auditan por separado y se equivocan
 * por separado: una deuda con el proveedor y mercadería que entra. Este archivo
 * es sobre la segunda, y su única razón de existir es que la segunda se escribe
 * en **otra aplicación**, con otra base, sin una transacción que abarque a las
 * dos.
 *
 * Todo lo de acá es puro: decide qué se manda y qué no se puede mandar, sin
 * tocar la red ni la base. Así la misma regla la usan la vista previa —que
 * muestra lo que va a pasar— y el envío —que lo hace— y no pueden discrepar.
 *
 * **La dirección no es un parámetro.** Una compra hace ENTRAR mercadería.
 * Dicho así es obvio, y por eso mismo conviene que sea imposible equivocarlo:
 * mandar una compra como egreso vacía el depósito de la otra aplicación con
 * números que parecen correctos, y nadie lo nota hasta que falta la mercadería.
 * No hay ninguna función acá que acepte una dirección.
 */

/**
 * La única dirección que produce una compra.
 *
 * Constante, exportada, y afirmada por una prueba: si alguien la cambiara a
 * EGRESO, la prueba falla antes de que salga un solo movimiento.
 */
export const DIRECCION_DE_COMPRA = 'INGRESO' as const;

export type DireccionDeMovimiento = typeof DIRECCION_DE_COMPRA;

/** De dónde sale la identidad de un movimiento. */
export interface OrigenDelMovimiento {
  /** El comprobante. Persistente: no cambia entre reintentos. */
  documentId: string;
  /** El renglón. Persistente por la misma razón. */
  documentItemId: string;
}

/**
 * La clave con la que Control de Stock reconoce un movimiento ya recibido.
 *
 * **Nunca lleva la hora.** Una clave con reloj adentro es una clave distinta en
 * cada reintento, y entonces no deduplica nada: el segundo intento parece un
 * movimiento nuevo y la mercadería entra dos veces. Se arma con el comprobante
 * y el renglón, que son los dos identificadores que ya existen cuando la compra
 * se aplica y que no cambian nunca más.
 *
 * Lleva el prefijo de la aplicación porque del otro lado van a llegar eventos
 * de más de un origen, y dos aplicaciones distintas pueden usar el mismo
 * identificador interno sin saberlo.
 */
export const APLICACION = 'compras-don-gines';

export function claveDelEvento(origen: OrigenDelMovimiento): string {
  return `${APLICACION}:compra:${origen.documentId}:${origen.documentItemId}`;
}

/** Un renglón, tal como lo ve esta parte del sistema. */
export interface RenglonParaStock {
  documentItemId: string;
  lineNumber: number;
  description: string;
  quantity: string;
  unit: PurchaseUnit;
  /** El artículo asociado, si lo hay. */
  producto: { id: string; plu: string; purchaseUnit: PurchaseUnit } | null;
  /** Si el renglón es un gasto del comprobante y no mercadería. */
  esGasto: boolean;
}

/** Lo que se va a mandar por un renglón. */
export interface IngresoPlaneado {
  documentItemId: string;
  lineNumber: number;
  productId: string;
  plu: string;
  quantity: string;
  unit: PurchaseUnit;
  direccion: DireccionDeMovimiento;
  descripcion: string;
}

/** Por qué un renglón no se puede mandar. Frena la compra entera. */
export interface ImpedimentoDeStock {
  lineNumber: number;
  motivo: string;
}

export interface PlanDeIngresos {
  ingresos: IngresoPlaneado[];
  /** Renglones que no mueven stock y está bien que no lo muevan. */
  sinImpacto: { lineNumber: number; descripcion: string; porQue: string }[];
  impedimentos: ImpedimentoDeStock[];
}

/**
 * Qué ingresos produce este comprobante, y qué lo impide.
 *
 * Un impedimento frena **la compra entera**, no sólo su renglón. Aplicar cinco
 * de seis renglones deja una compra a medias en dos aplicaciones distintas, que
 * es peor que no aplicarla: la diferencia no se ve en ninguna pantalla y
 * aparece semanas después como un faltante sin explicación.
 */
export function planDeIngresos(renglones: RenglonParaStock[]): PlanDeIngresos {
  const ingresos: IngresoPlaneado[] = [];
  const sinImpacto: PlanDeIngresos['sinImpacto'] = [];
  const impedimentos: ImpedimentoDeStock[] = [];

  for (const renglon of renglones) {
    /*
     * Los gastos salen primero y sin condiciones.
     *
     * Las tres bolsas que Ezra cobra para transportar la compra se pagan con la
     * factura y no son mercadería vendible. No tienen artículo, no tienen que
     * tenerlo, y pedirles uno mandaría a buscar algo que no existe. Su importe
     * ya está dentro del total económico; acá lo único que importa es que no
     * generen movimiento.
     */
    if (renglon.esGasto) {
      sinImpacto.push({
        lineNumber: renglon.lineNumber,
        descripcion: renglon.description,
        porQue: 'Es un gasto del comprobante: se paga y no entra al stock.',
      });
      continue;
    }

    /*
     * Un renglón de mercadería sin artículo no genera movimiento, y eso **no
     * es un impedimento acá**.
     *
     * Quien impide aplicar una compra así es la vista previa, con su freno: el
     * renglón está a la vista, en rojo, y el botón no deja. Esta función se usa
     * también en la confirmación general, que desde siempre acepta renglones
     * sin asociar —una factura histórica, un artículo que todavía no está en el
     * catálogo— y les escribe el movimiento de compra con el producto en nulo.
     * Frenar acá rompía ese camino entero por una regla que corresponde al otro.
     *
     * Lo que sí frena son los dos problemas que la vista previa **no puede
     * ver**, porque sólo existen cuando el artículo ya está asociado: un PLU
     * vacío y una unidad que no coincide.
     */
    if (!renglon.producto) {
      sinImpacto.push({
        lineNumber: renglon.lineNumber,
        descripcion: renglon.description,
        porQue:
          'No está asociado a ningún artículo, así que no se sabe a qué existencias entraría. ' +
          'La vista previa lo frena antes de aplicar.',
      });
      continue;
    }

    /*
     * El PLU tiene que existir de verdad.
     *
     * Es la identidad canónica del artículo, la que define Control de Stock, y
     * la única por la que se resuelve: nunca el nombre. Un artículo sin PLU no
     * se puede mandar y **no se crea uno nuevo** para salir del paso —eso
     * duplicaría el artículo del otro lado y repartiría las existencias del
     * mismo queso entre dos fichas.
     */
    const plu = renglon.producto.plu.trim();
    if (plu === '') {
      impedimentos.push({
        lineNumber: renglon.lineNumber,
        motivo:
          `El artículo del renglón ${renglon.lineNumber} no tiene PLU. Control de Stock ` +
          'identifica los artículos por PLU y no se crea uno nuevo para poder enviarlo.',
      });
      continue;
    }

    /*
     * Y la unidad tiene que ser la misma de los dos lados.
     *
     * Mandar 4,240 «unidades» de un artículo que se lleva en kilos —o al revés—
     * es un error que no se ve: entran números plausibles a la ficha
     * equivocada. Convertir por nuestra cuenta sería peor todavía, porque haría
     * falta un peso por unidad que este renglón puede no traer.
     */
    if (renglon.unit !== renglon.producto.purchaseUnit) {
      impedimentos.push({
        lineNumber: renglon.lineNumber,
        motivo:
          `El renglón ${renglon.lineNumber} viene en ${etiquetaDeUnidad(renglon.unit)} y el ` +
          `artículo se lleva en ${etiquetaDeUnidad(renglon.producto.purchaseUnit)}. No se ` +
          'convierte por cuenta propia: hay que corregir uno de los dos.',
      });
      continue;
    }

    ingresos.push({
      documentItemId: renglon.documentItemId,
      lineNumber: renglon.lineNumber,
      productId: renglon.producto.id,
      plu,
      quantity: renglon.quantity,
      unit: renglon.unit,
      direccion: DIRECCION_DE_COMPRA,
      descripcion: renglon.description,
    });
  }

  return { ingresos, sinImpacto, impedimentos };
}

export function etiquetaDeUnidad(unidad: PurchaseUnit): string {
  return unidad === 'KG' ? 'kilos' : 'unidades';
}

/**
 * La sucursal a la que entra la mercadería.
 *
 * Es la del comprobante y ninguna otra. No hay sucursal por omisión: elegir una
 * en silencio manda mercadería a un local donde nunca estuvo, y el faltante
 * aparece en otro. Si falta, frena.
 */
export interface SucursalDeDestino {
  id: string;
  code: string;
  name: string;
  /** Cómo la conoce Control de Stock. Nulo mientras no esté acordado. */
  stockKey: string | null;
}

export type DestinoResuelto =
  | { ok: true; sucursal: SucursalDeDestino }
  | { ok: false; motivo: string };

export function resolverDestino(sucursal: SucursalDeDestino | null): DestinoResuelto {
  if (!sucursal) {
    return {
      ok: false,
      motivo:
        'El comprobante no tiene sucursal de destino. Hay que elegir explícitamente a qué ' +
        'local entra la mercadería: no hay ninguna por omisión.',
    };
  }
  return { ok: true, sucursal };
}

/* -------------------------------------------------------------------------- */
/*  El contrato con Control de Stock, versión 1                                */
/* -------------------------------------------------------------------------- */

/**
 * **El lote que viaja, tal como lo acordamos con Control de Stock.**
 *
 * Es un lote por compra y no un pedido por renglón, a propósito: los cinco
 * movimientos de una factura se aplican en una transacción del otro lado o no
 * se aplica ninguno. Media compra ingresada es peor que ninguna, porque la
 * diferencia no se ve en ninguna pantalla.
 *
 * Los tipos son literales —`1`, `'IN'`, `'PURCHASE'`— para que el compilador
 * rechace cualquier otro valor antes de que salga un pedido. La dirección no
 * es configurable en ninguna capa.
 */
export const VERSION_DEL_CONTRATO = 1 as const;
export const DIRECCION_DEL_CONTRATO = 'IN' as const;
export const MOTIVO_DEL_CONTRATO = 'PURCHASE' as const;

export interface MovimientoDelLote {
  /** El renglón de Compras. Persistente: es la trazabilidad de vuelta. */
  sourceLineId: string;
  /** La misma clave en cada reintento. Nunca se genera una nueva. */
  idempotencyKey: string;
  plu: string;
  /** Cadena decimal: un número de coma flotante perdería los kilos exactos. */
  quantity: string;
  unit: PurchaseUnit;
  direction: typeof DIRECCION_DEL_CONTRATO;
  reason: typeof MOTIVO_DEL_CONTRATO;
}

export interface LoteDeIngreso {
  contractVersion: typeof VERSION_DEL_CONTRATO;
  source: typeof APLICACION;
  purchaseId: string;
  /** `branches.code` de Control de Stock: devoto, pueyrredon, san_martin. */
  branchCode: string;
  document: {
    documentId: string;
    type: string;
    pointOfSale: string;
    number: string;
    /** La emisión, en ISO. El hecho es del día que ocurrió, no del envío. */
    issuedAt: string;
    supplierTaxId: string | null;
    supplierName: string | null;
  };
  confirmedBy: { userId: string | null; name: string | null };
  movements: MovimientoDelLote[];
}
