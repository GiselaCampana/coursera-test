import type { MarginBasis } from '@/lib/domain/pricing';

/**
 * De dónde sale el marcaje con el que se forma cada precio.
 *
 * Hay tres niveles y se resuelven siempre en el mismo orden: lo que dice el
 * artículo, lo que dice su familia, y lo que dice la regla general. El primero
 * que conteste gana.
 *
 * La regla general es una fila de la base, no un número escondido en el
 * código: se puede mirar y se puede cambiar. Es la única configuración global
 * que existe.
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
export type OrigenDelMarcaje =
  | 'PRODUCTO'
  | 'FAMILIA'
  | 'GENERAL'
  | 'BASE'
  | 'SIN_CONFIGURAR';

export const ORIGEN_LABEL: Record<OrigenDelMarcaje, string> = {
  PRODUCTO: 'propio del artículo',
  FAMILIA: 'heredado de la familia',
  GENERAL: 'de la regla general',
  BASE: 'toma el marcaje por kilo',
  SIN_CONFIGURAR: 'sin regla general cargada',
};

/**
 * Último recurso, para cuando no hay ninguna regla general cargada.
 *
 * No es una configuración paralela: es lo que se usa cuando la fila que **sí**
 * es la configuración no existe, y cuando eso pasa el origen lo dice
 * ("sin regla general cargada") en vez de hacerlo pasar por una decisión que
 * alguien tomó. La migración crea la regla general, así que en una base al día
 * esto no se ve nunca.
 *
 * Vale exactamente lo que valía antes el valor por omisión de la columna, para
 * que activar la regla general no mueva ningún precio.
 */
export const SIN_REGLA_GENERAL = '0.45';
export const SIN_REGLA_GENERAL_BASE: MarginBasis = 'SOBRE_COSTO';

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

/** Cómo se llama la columna de cada forma de venta, en los tres niveles. */
export const CAMPO_DEL_MARCAJE: Record<Marcaje, keyof FuenteDeMarcajes> = {
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
  general?: FuenteDeMarcajes | null,
): MarcajesEfectivos {
  const base: ValorConOrigen<string> = dice(producto.targetMarginPct)
    ? { valor: producto.targetMarginPct, origen: 'PRODUCTO' }
    : dice(familia?.targetMarginPct)
      ? { valor: familia!.targetMarginPct as string, origen: 'FAMILIA' }
      : dice(general?.targetMarginPct)
        ? { valor: general!.targetMarginPct as string, origen: 'GENERAL' }
        : { valor: SIN_REGLA_GENERAL, origen: 'SIN_CONFIGURAR' };

  const marginBasis: ValorConOrigen<MarginBasis> = producto.marginBasis
    ? { valor: producto.marginBasis, origen: 'PRODUCTO' }
    : familia?.marginBasis
      ? { valor: familia.marginBasis, origen: 'FAMILIA' }
      : general?.marginBasis
        ? { valor: general.marginBasis, origen: 'GENERAL' }
        : { valor: SIN_REGLA_GENERAL_BASE, origen: 'SIN_CONFIGURAR' };

  const especificos = {} as Record<Marcaje, ValorConOrigen<string>>;
  for (const marcaje of MARCAJES) {
    const campo = CAMPO_DEL_MARCAJE[marcaje];
    const delProducto = producto[campo];
    const deLaFamilia = familia?.[campo];
    const deLaGeneral = general?.[campo];
    especificos[marcaje] = dice(delProducto)
      ? { valor: delProducto, origen: 'PRODUCTO' }
      : dice(deLaFamilia)
        ? { valor: deLaFamilia, origen: 'FAMILIA' }
        : dice(deLaGeneral)
          ? { valor: deLaGeneral, origen: 'GENERAL' }
          : /*
             * Sin marcaje propio, ni de la familia, ni de la regla general, la
             * forma de venta se cobra con el marcaje por kilo. Es lo que ya
             * pasaba y lo que la gente espera: un artículo sin nada configurado
             * se vende con un solo margen.
             *
             * Cada forma de venta cae acá **por su cuenta**: que la horma tome
             * el kilo no tiene ningún efecto sobre el de 1/4 kg, ni al revés.
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
export function marcajesDeLaFamilia(
  familia: FuenteDeMarcajes,
  general?: FuenteDeMarcajes | null,
): MarcajesEfectivos {
  return marcajesEfectivos({}, familia, general);
}

/**
 * Qué formas de venta se configuran para cada modalidad.
 *
 * El marcaje por kilo es el base y aparece en las dos, porque en al corte **es**
 * el precio de venta por kilo y en feteables es el número del que salen los
 * demás cuando no tienen el suyo. Los otros no se cruzan: una modalidad no
 * muestra ni toca los campos de la otra.
 *
 * La unidad entera va aparte: no depende de la modalidad sino de que el
 * artículo se venda por unidad.
 */
export const MARCAJES_POR_MODALIDAD: Record<'AL_CORTE' | 'FETEABLE', Marcaje[]> = {
  AL_CORTE: ['alCorteHormaDigital', 'alCorteHormaCash', 'alCorteCajaCash'],
  FETEABLE: ['feteado100g', 'feteadoQuarter', 'feteadoPieceDigital', 'feteadoPieceCash'],
};

/**
 * Cómo se redondea cada forma de venta. No es configurable.
 *
 * Kilo, 100 g y 1/4 van al $100, que es como se marcan los precios de
 * mostrador. Horma, caja, pieza y unidad entera quedan exactos: son importes
 * que se cobran una sola vez y redondearlos arrastraría el error al kilo.
 */
export const REDONDEA_AL_100: Record<Marcaje | 'kilo', boolean> = {
  kilo: true,
  feteado100g: true,
  feteadoQuarter: true,
  alCorteHormaDigital: false,
  alCorteHormaCash: false,
  alCorteCajaCash: false,
  feteadoPieceDigital: false,
  feteadoPieceCash: false,
  wholeUnit: false,
};
