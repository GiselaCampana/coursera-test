import 'server-only';
import { prisma } from '@/lib/db';
import { Decimal, money, toDecimal } from '@/lib/money';

/**
 * El catálogo de precios que Compras le entrega a Pedidos Don Ginés.
 *
 * Pedidos es la aplicación con la que un cliente arma su pedido. Necesita tres
 * cosas de cada artículo: cómo se llama, cuánto sale y en qué unidad se pide.
 * Nada más. Todo lo que Compras sabe además de eso —lo que costó, a quién se le
 * compró, cuánto se le debe, qué margen deja— **no puede salir de acá**, ni
 * siquiera adentro de un objeto anidado o de un mensaje de error.
 *
 * Por eso este módulo arma el objeto de salida campo por campo, en vez de
 * mandar el producto y sacarle lo que sobra. Un producto tiene decenas de
 * campos y cada campo nuevo que alguien agregue al modelo se filtraría solo;
 * armándolo campo por campo, un campo nuevo no aparece hasta que alguien lo
 * escriba acá a propósito.
 *
 * ### De dónde sale el precio
 *
 * Del último precio **aprobado**, el que alguien miró y confirmó. No del
 * sugerido: el sugerido sale del último costo y cambia solo cada vez que llega
 * una factura, así que publicarlo haría que el precio de la pantalla del
 * cliente se moviera sin que nadie lo haya decidido.
 *
 * Esa es también la razón por la que este módulo no calcula ningún precio. La
 * formación de precios —marcajes, herencia por familia, redondeos— vive en
 * `services/pricing.ts` y ya está resuelta cuando el precio se aprueba: lo que
 * queda guardado en `SalePriceHistory` es su resultado. Recalcular acá sería
 * una segunda copia de esas reglas, y tarde o temprano las dos dirían cosas
 * distintas.
 *
 * ### Lo que se excluye
 *
 * Un artículo que no se puede publicar con certeza no se publica. Se lo deja
 * afuera y se dice por qué, en `exclusiones`, que **no** forma parte del
 * contrato: es para el informe de operación, no para Pedidos.
 */

/** Las sucursales que Pedidos puede pedir. */
export const SUCURSALES_PUBLICAS = ['devoto', 'pueyrredon', 'san_martin'] as const;
export type SucursalPublica = (typeof SUCURSALES_PUBLICAS)[number];

export function esSucursalPublica(valor: string | null): valor is SucursalPublica {
  return valor !== null && (SUCURSALES_PUBLICAS as readonly string[]).includes(valor);
}

/**
 * Un artículo del catálogo público, con los diez campos del contrato.
 *
 * Los diez y nada más. El tipo está cerrado a propósito: con `Record<string,
 * unknown>` un campo de más pasaría el compilador y saldría publicado.
 */
export interface ArticuloPublico {
  plu: string;
  name: string;
  description: string;
  category: string | null;
  unit: 'kg' | 'unidad';
  unitPrice: number;
  step: number;
  defaultQuantity: number;
  image: string | null;
  featured: boolean;
}

export interface ExclusionDeCatalogo {
  /** El código interno del artículo, para poder ir a buscarlo. */
  codigo: string;
  nombre: string;
  motivo: string;
}

export interface CatalogoPublico {
  items: ArticuloPublico[];
  /** Fuera del contrato: para el informe de operación, no para Pedidos. */
  exclusiones: ExclusionDeCatalogo[];
  /** Artículos publicados sin categoría, que también hay que poder ver. */
  sinCategoria: string[];
}

/**
 * Cuántos artículos se pueden publicar de una vez.
 *
 * El límite existe para que una respuesta enorme no tumbe el servicio, pero
 * pasarse **no puede** recortar el catálogo: un cliente vería la mitad de la
 * fiambrería sin que nada avise. Se falla, se avisa, y alguien decide.
 */
export const MAXIMO_ARTICULOS_PUBLICOS = 5000;

/** Se pasó el límite. Es una condición de operación, no un dato para Pedidos. */
export class CatalogoDemasiadoGrande extends Error {
  constructor(readonly cantidad: number) {
    super(`El catálogo tiene ${cantidad} artículos y el límite es ${MAXIMO_ARTICULOS_PUBLICOS}.`);
    this.name = 'CatalogoDemasiadoGrande';
  }
}

/**
 * Cuántas consultas por minuto se atienden.
 *
 * El catálogo entero cambia cuando alguien aprueba un precio, o sea unas pocas
 * veces por día: Pedidos tiene que traerlo y guardárselo, no pedirlo cada vez
 * que un cliente abre la pantalla. Sesenta por minuto deja lugar de sobra para
 * eso y para reintentar, y ataja el bucle accidental que dejaría a Compras
 * armando el catálogo sin parar.
 *
 * El conteo es por proceso, así que con varias instancias el límite efectivo es
 * más alto. Alcanza igual: esto no es una defensa contra un ataque distribuido
 * —para eso está la clave— sino un tope para que un cliente descuidado no tumbe
 * el servicio.
 */
export const CONSULTAS_POR_MINUTO = 60;
const VENTANA_MS = 60_000;

let ventanaDesde = 0;
let consultasEnLaVentana = 0;

export function dentroDelLimiteDeFrecuencia(ahora: number = Date.now()): boolean {
  if (ahora - ventanaDesde >= VENTANA_MS) {
    ventanaDesde = ahora;
    consultasEnLaVentana = 0;
  }
  consultasEnLaVentana += 1;
  return consultasEnLaVentana <= CONSULTAS_POR_MINUTO;
}

/** Deja el contador como recién arrancado. Lo usan las pruebas. */
export function reiniciarLimiteDeFrecuencia(): void {
  ventanaDesde = 0;
  consultasEnLaVentana = 0;
}

/**
 * Cómo se pide cada artículo, según cómo se vende.
 *
 * El paso y la cantidad inicial son de la unidad, no del artículo: cualquier
 * cosa que se venda por kilo se pide de a 100 gramos empezando por medio kilo,
 * y cualquier cosa que se venda por unidad se pide de a una empezando por una.
 */
const COMO_SE_PIDE = {
  kg: { unit: 'kg' as const, step: 0.1, defaultQuantity: 0.5 },
  unidad: { unit: 'unidad' as const, step: 1, defaultQuantity: 1 },
};

/**
 * Cuánto pueden diferir dos lecturas del mismo precio normal.
 *
 * El precio por 100 g y el del cuarto kilo se guardan aparte del precio por
 * kilo. Hoy salen de dividirlo, así que vuelven a dar exacto; el control existe
 * para el día en que dejen de salir de ahí. Un centavo es el redondeo.
 */
const TOLERANCIA_DE_CENTAVOS = new Decimal('0.01');

export async function construirCatalogoPublico(ahora: Date = new Date()): Promise<CatalogoPublico> {
  /*
   * Sólo lo que hace falta para armar el contrato.
   *
   * `select` explícito y no `findMany` a secas: así el costo, el proveedor
   * habitual y los marcajes no llegan siquiera a la memoria de este proceso. Lo
   * que no se trae no se puede filtrar mal.
   */
  const productos = await prisma.product.findMany({
    where: { active: true },
    select: {
      id: true,
      internalCode: true,
      normalizedName: true,
      category: true,
      saleMode: true,
      usesPlu: true,
      salePrices: {
        // El precio vigente es el último que empezó a regir, no el último
        // cargado: se puede aprobar hoy un precio que rige desde mañana.
        where: { validFrom: { lte: ahora } },
        orderBy: [{ validFrom: 'desc' }, { approvedAt: 'desc' }],
        take: 1,
        select: {
          approvedPricePerKg: true,
          pricePer100g: true,
          pricePerQuarter: true,
        },
      },
    },
    // Orden determinístico y estable: el mismo catálogo devuelve siempre la
    // misma lista en el mismo orden, que es lo que permite compararla.
    orderBy: [{ internalCode: 'asc' }],
  });

  const items: ArticuloPublico[] = [];
  const exclusiones: ExclusionDeCatalogo[] = [];
  const sinCategoria: string[] = [];
  const pluVistos = new Set<string>();

  for (const producto of productos) {
    const nombre = producto.normalizedName;
    const excluir = (motivo: string) =>
      exclusiones.push({ codigo: producto.internalCode, nombre, motivo });

    /*
     * El PLU es la llave con la que Pedidos identifica el artículo, y va como
     * está guardado: sin rellenar, sin recortar y sin pasarlo a número.
     */
    const plu = producto.internalCode?.trim() ?? '';
    if (plu === '') {
      excluir('No tiene PLU.');
      continue;
    }
    if (!producto.usesPlu) {
      /*
       * Se identifica por código de barras, no por PLU. Publicar su código
       * interno bajo la etiqueta «plu» sería decirle a Pedidos que es un PLU
       * cuando no lo es.
       */
      excluir('No se identifica por PLU sino por código de barras.');
      continue;
    }
    if (pluVistos.has(plu)) {
      excluir(`El PLU ${plu} ya lo tiene otro artículo.`);
      continue;
    }

    const vigente = producto.salePrices[0];
    if (!vigente) {
      excluir('Todavía no tiene un precio de venta aprobado.');
      continue;
    }

    /*
     * Los decimales de Prisma se pasan por su texto, no por el objeto.
     *
     * `Prisma.Decimal` y el `Decimal` de la aplicación son dos clases distintas
     * con el mismo nombre: pasar una donde va la otra no falla, devuelve cero, y
     * el artículo desaparece del catálogo con el motivo equivocado.
     */
    const precioPorKilo = toDecimal(vigente.approvedPricePerKg.toString());
    if (!precioPorKilo.isFinite() || precioPorKilo.lte(0)) {
      excluir('El precio aprobado no es mayor que cero.');
      continue;
    }

    /*
     * ¿Hay una sola referencia de precio normal, o hay varias que no coinciden?
     *
     * El precio por 100 g y el del cuarto son otra escritura del mismo precio
     * por kilo. Si al llevarlos al kilo no dan lo mismo, este artículo tiene
     * más de un precio normal y no hay forma de saber cuál publicar. Elegir uno
     * sería elegir al azar cuánto le cobramos al cliente.
     */
    const desdeCien = money(toDecimal(vigente.pricePer100g.toString()).times(10));
    const desdeCuarto = money(toDecimal(vigente.pricePerQuarter.toString()).times(4));
    const discrepa = (otro: Decimal) => otro.minus(precioPorKilo).abs().gt(TOLERANCIA_DE_CENTAVOS);
    if (discrepa(desdeCien) || discrepa(desdeCuarto)) {
      excluir(
        'Los precios por kilo, por 100 g y por cuarto no coinciden entre sí: ' +
          'no hay una única referencia de precio normal.',
      );
      continue;
    }

    /*
     * En qué unidad se pide.
     *
     * Los dos modos de venta que existen —al corte y feteable— se venden por
     * kilo, y ésa es la unidad. El maple, el pack, la horma, la caja y la tira
     * son otra cosa y no se deducen del nombre del artículo: mientras no haya
     * una unidad comercial configurada, un artículo que no se venda por kilo no
     * se publica.
     */
    const porKilo = producto.saleMode === 'AL_CORTE' || producto.saleMode === 'FETEABLE';
    if (!porKilo) {
      excluir(
        `No tiene una unidad comercial que se pueda publicar (modo de venta «${producto.saleMode}»).`,
      );
      continue;
    }
    const pedido = COMO_SE_PIDE.kg;

    if (producto.category === null || producto.category.trim() === '') {
      // Se publica igual, con la categoría vacía: inventarle una sería peor.
      sinCategoria.push(producto.internalCode);
    }

    pluVistos.add(plu);
    items.push({
      plu,
      name: nombre,
      category: producto.category,
      // Todavía no existen como datos administrables. Van con su valor vacío,
      // no ausentes: el contrato los declara siempre.
      description: '',
      featured: false,
      // No hay ninguna imagen pública y estable que publicar. Una URL firmada o
      // privada no sirve: se vence o expone una credencial.
      image: null,
      unit: pedido.unit,
      unitPrice: precioPorKilo.toNumber(),
      step: pedido.step,
      defaultQuantity: pedido.defaultQuantity,
    });
  }

  if (items.length > MAXIMO_ARTICULOS_PUBLICOS) {
    throw new CatalogoDemasiadoGrande(items.length);
  }

  return { items, exclusiones, sinCategoria };
}
