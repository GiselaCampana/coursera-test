import type { MarginBasis } from '@/lib/domain/pricing';

/**
 * De dónde sale el marcaje con el que se forma cada precio.
 *
 * Hay tres niveles y se resuelven siempre en el mismo orden: lo que dice el
 * artículo, lo que dice su familia, y el general de la casa. El primero que
 * conteste gana.
 *
 * Que esto viva en un solo lugar no es prolijidad. Antes la herencia estaba
 * escrita dos veces —una en el cálculo del precio y otra en la exportación de
 * la lista—, y dos copias de la misma regla son dos reglas que tarde o
 * temprano dicen cosas distintas: el precio de la pantalla y el de la planilla
 * que se imprime para el mostrador.
 */

/** Los ocho marcajes específicos, por forma de venta. */
export const MARCAJES = [
  'alCorteHormaDigital',
  'alCorteHormaCash',
  'alCorteCajaCash',
  'feteado100g',
  'feteadoQuarter',
  'feteadoPieceDigital',
  'feteadoPieceCash',
  'wholeUnit',
] as const;

export type Marcaje = (typeof MARCAJES)[number];

export const MARCAJE_LABEL: Record<Marcaje, string> = {
  alCorteHormaDigital: 'Horma entera, digital',
  alCorteHormaCash: 'Horma entera, efectivo',
  alCorteCajaCash: 'Caja, efectivo',
  feteado100g: 'Venta por 100 g',
  feteadoQuarter: 'Venta por 1/4 kg',
  feteadoPieceDigital: 'Pieza entera, digital',
  feteadoPieceCash: 'Pieza entera, efectivo',
  wholeUnit: 'Unidad entera',
};

/**
 * Quién puso el número.
 *
 * Se informa junto con el valor, y no es decorativo: un 45 % puede ser el que
 * alguien eligió para ese artículo, el que rige para toda su familia, o el
 * general que nadie tocó nunca. Al cambiar el de la familia, los tres se
 * comportan distinto, y sin saber cuál es no hay forma de anticipar qué
 * precios se van a mover.
 */
export type OrigenDelMarcaje = 'PRODUCTO' | 'FAMILIA' | 'BASE' | 'GENERAL';

export const ORIGEN_LABEL: Record<OrigenDelMarcaje, string> = {
  PRODUCTO: 'propio del artículo',
  FAMILIA: 'heredado de la familia',
  BASE: 'toma el marcaje base',
  GENERAL: 'general de la casa',
};

/**
 * El marcaje de la casa, para cuando ni el artículo ni la familia dicen nada.
 *
 * Es el mismo 45 % que hasta ahora venía como valor por omisión de la columna.
 * Está acá y no en la base para que se pueda leer: un número por omisión
 * escondido en un `DEFAULT` de Postgres no aparece en ninguna pantalla.
 */
export const MARCAJE_GENERAL = '0.45';
export const BASE_GENERAL: MarginBasis = 'SOBRE_COSTO';

/** Lo que hace falta de un artículo o de una familia para resolver marcajes. */
export interface FuenteDeMarcajes {
  targetMarginPct?: string | null;
  marginBasis?: MarginBasis | null;
  alCorteHormaDigitalMarginPct?: string | null;
  alCorteHormaCashMarginPct?: string | null;
  alCorteCajaCashMarginPct?: string | null;
  feteado100gMarginPct?: string | null;
  feteadoQuarterMarginPct?: string | null;
  feteadoPieceDigitalMarginPct?: string | null;
  feteadoPieceCashMarginPct?: string | null;
  wholeUnitMarginPct?: string | null;
}

export interface ValorConOrigen<T> {
  valor: T;
  origen: OrigenDelMarcaje;
}

export interface MarcajesEfectivos {
  base: ValorConOrigen<string>;
  marginBasis: ValorConOrigen<MarginBasis>;
  /** Los ocho, ya resueltos: nunca vienen vacíos. */
  especificos: Record<Marcaje, ValorConOrigen<string>>;
}

const CAMPO: Record<Marcaje, keyof FuenteDeMarcajes> = {
  alCorteHormaDigital: 'alCorteHormaDigitalMarginPct',
  alCorteHormaCash: 'alCorteHormaCashMarginPct',
  alCorteCajaCash: 'alCorteCajaCashMarginPct',
  feteado100g: 'feteado100gMarginPct',
  feteadoQuarter: 'feteadoQuarterMarginPct',
  feteadoPieceDigital: 'feteadoPieceDigitalMarginPct',
  feteadoPieceCash: 'feteadoPieceCashMarginPct',
  wholeUnit: 'wholeUnitMarginPct',
};

/** Un valor cargado de verdad. La cadena vacía es "no dice nada", no un cero. */
function dice(valor: string | null | undefined): valor is string {
  return typeof valor === 'string' && valor.trim() !== '';
}

/**
 * Resuelve los marcajes de un artículo contra los de su familia.
 *
 * Nunca devuelve un hueco: los ocho específicos y el base salen siempre con un
 * número, porque un precio no se puede formar con "no sé". Lo que sí devuelve
 * es de dónde salió cada uno, para que la pantalla pueda decirlo.
 */
export function marcajesEfectivos(
  producto: FuenteDeMarcajes,
  familia?: FuenteDeMarcajes | null,
): MarcajesEfectivos {
  const base: ValorConOrigen<string> = dice(producto.targetMarginPct)
    ? { valor: producto.targetMarginPct, origen: 'PRODUCTO' }
    : dice(familia?.targetMarginPct)
      ? { valor: familia!.targetMarginPct as string, origen: 'FAMILIA' }
      : { valor: MARCAJE_GENERAL, origen: 'GENERAL' };

  const marginBasis: ValorConOrigen<MarginBasis> = producto.marginBasis
    ? { valor: producto.marginBasis, origen: 'PRODUCTO' }
    : familia?.marginBasis
      ? { valor: familia.marginBasis, origen: 'FAMILIA' }
      : { valor: BASE_GENERAL, origen: 'GENERAL' };

  const especificos = {} as Record<Marcaje, ValorConOrigen<string>>;
  for (const marcaje of MARCAJES) {
    const campo = CAMPO[marcaje];
    const delProducto = producto[campo];
    const deLaFamilia = familia?.[campo];
    especificos[marcaje] = dice(delProducto)
      ? { valor: delProducto, origen: 'PRODUCTO' }
      : dice(deLaFamilia)
        ? { valor: deLaFamilia, origen: 'FAMILIA' }
        : /*
           * Sin marcaje propio ni de la familia, la forma de venta se cobra con
           * el marcaje base. Es lo que ya pasaba y lo que la gente espera: un
           * artículo sin nada configurado se vende con un solo margen.
           */
          { valor: base.valor, origen: 'BASE' };
  }

  return { base, marginBasis, especificos };
}

/**
 * Los marcajes de una familia, tal como quedarían para un artículo que no
 * define ninguno.
 *
 * Sirve para mostrar en la ficha de la familia qué va a aplicar: si la familia
 * define el base pero no el de 1/4 kg, el de 1/4 kg va a ser el base de la
 * familia, y conviene verlo antes de guardar.
 */
export function marcajesDeLaFamilia(familia: FuenteDeMarcajes): MarcajesEfectivos {
  return marcajesEfectivos({}, familia);
}
