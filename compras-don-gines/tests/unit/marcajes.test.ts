import { describe, it, expect } from 'vitest';
import {
  MARCAJES,
  MARCAJE_GENERAL,
  marcajesDeLaFamilia,
  marcajesEfectivos,
  type FuenteDeMarcajes,
} from '@/lib/domain/marcajes';

/**
 * La cadena de herencia de los marcajes.
 *
 * Tres niveles, siempre en el mismo orden: lo que dice el artículo, lo que dice
 * su familia, y el general de la casa. El primero que conteste gana.
 *
 * Lo que hace falta probar no es que la cadena funcione en el caso feliz, sino
 * que **vacío signifique heredar y no cero**. Un marcaje de cero es un artículo
 * que se vende al costo; si la aplicación confundiera las dos cosas, un campo
 * en blanco pondría a la venta toda una familia sin ganancia y el error sólo
 * aparecería mirando la caja a fin de mes.
 */

const VACIA: FuenteDeMarcajes = {};

describe('de dónde sale el marcaje base', () => {
  it('el del artículo gana sobre el de la familia', () => {
    const r = marcajesEfectivos({ targetMarginPct: '0.30' }, { targetMarginPct: '0.50' });
    expect(r.base.valor).toBe('0.30');
    expect(r.base.origen).toBe('PRODUCTO');
  });

  it('sin el del artículo, rige el de la familia', () => {
    const r = marcajesEfectivos(VACIA, { targetMarginPct: '0.50' });
    expect(r.base.valor).toBe('0.50');
    expect(r.base.origen).toBe('FAMILIA');
  });

  it('sin ninguno de los dos, el general de la casa', () => {
    const r = marcajesEfectivos(VACIA, VACIA);
    expect(r.base.valor).toBe(MARCAJE_GENERAL);
    expect(r.base.origen).toBe('GENERAL');
  });

  it('un artículo sin familia resuelve igual', () => {
    const r = marcajesEfectivos({ targetMarginPct: '0.30' }, null);
    expect(r.base.valor).toBe('0.30');
    expect(marcajesEfectivos(VACIA, null).base.origen).toBe('GENERAL');
  });
});

describe('vacío es heredar, y cero es cero', () => {
  it('un marcaje en cero es un marcaje, no un hueco', () => {
    /*
     * La distinción que sostiene todo. Cero por ciento es vender al costo: una
     * decisión rara pero posible. Si se tratara como "no dice nada", ese
     * artículo heredaría el marcaje de la familia y se vendería más caro de lo
     * que alguien decidió, sin que nada lo delate.
     */
    const r = marcajesEfectivos({ targetMarginPct: '0' }, { targetMarginPct: '0.50' });
    expect(r.base.valor).toBe('0');
    expect(r.base.origen).toBe('PRODUCTO');
  });

  it('la cadena vacía y el nulo sí son huecos', () => {
    expect(marcajesEfectivos({ targetMarginPct: '' }, { targetMarginPct: '0.50' }).base.valor).toBe(
      '0.50',
    );
    expect(
      marcajesEfectivos({ targetMarginPct: null }, { targetMarginPct: '0.50' }).base.valor,
    ).toBe('0.50');
    expect(
      marcajesEfectivos({ targetMarginPct: '   ' }, { targetMarginPct: '0.50' }).base.valor,
    ).toBe('0.50');
  });
});

describe('los ocho marcajes por forma de venta', () => {
  it('salen siempre con un número: nunca queda un hueco', () => {
    /*
     * Un precio no se puede formar con "no sé". El resolvedor es el que se
     * encarga de que ningún consumidor tenga que decidir qué hacer con un
     * null, que es de donde salían las dos copias de la regla.
     */
    const r = marcajesEfectivos(VACIA, VACIA);
    for (const m of MARCAJES) {
      expect(r.especificos[m].valor, m).toBe(MARCAJE_GENERAL);
    }
  });

  it('el propio del artículo gana sobre el de la familia y sobre el base', () => {
    const r = marcajesEfectivos(
      { targetMarginPct: '0.30', feteadoQuarterMarginPct: '0.80' },
      { feteadoQuarterMarginPct: '0.60' },
    );
    expect(r.especificos.feteadoQuarter.valor).toBe('0.80');
    expect(r.especificos.feteadoQuarter.origen).toBe('PRODUCTO');
  });

  it('sin el propio, el de la familia gana sobre el base del artículo', () => {
    /*
     * Es el caso que da sentido a la familia: el artículo tiene su marcaje
     * base, pero para la venta por 1/4 kg manda lo que se decidió para toda la
     * familia.
     */
    const r = marcajesEfectivos(
      { targetMarginPct: '0.30' },
      { feteadoQuarterMarginPct: '0.60' },
    );
    expect(r.especificos.feteadoQuarter.valor).toBe('0.60');
    expect(r.especificos.feteadoQuarter.origen).toBe('FAMILIA');
    // Y las formas de venta que nadie tocó siguen usando el base del artículo.
    expect(r.especificos.feteado100g.valor).toBe('0.30');
    expect(r.especificos.feteado100g.origen).toBe('BASE');
  });

  it('el base heredado de la familia alimenta a los específicos', () => {
    // La familia pone el base; ningún específico está definido en ninguna
    // parte. Los ocho tienen que salir con el base de la familia.
    const r = marcajesEfectivos(VACIA, { targetMarginPct: '0.55' });
    for (const m of MARCAJES) {
      expect(r.especificos[m].valor, m).toBe('0.55');
      expect(r.especificos[m].origen, m).toBe('BASE');
    }
  });
});

describe('la base del marcaje (sobre costo o sobre venta)', () => {
  it('sigue la misma cadena que los importes', () => {
    expect(marcajesEfectivos({ marginBasis: 'SOBRE_VENTA' }, { marginBasis: 'SOBRE_COSTO' }).marginBasis.valor).toBe(
      'SOBRE_VENTA',
    );
    expect(marcajesEfectivos(VACIA, { marginBasis: 'SOBRE_VENTA' }).marginBasis.valor).toBe(
      'SOBRE_VENTA',
    );
    expect(marcajesEfectivos(VACIA, VACIA).marginBasis.valor).toBe('SOBRE_COSTO');
  });
});

describe('la vista previa de una familia', () => {
  it('muestra lo que va a usar un artículo que no define nada', () => {
    /*
     * Sirve para poder mirar antes de guardar: si la familia define el base
     * pero no el de 1/4 kg, el de 1/4 kg va a terminar siendo el base de la
     * familia, y conviene verlo escrito y no deducirlo.
     */
    const previa = marcajesDeLaFamilia({
      targetMarginPct: '0.40',
      feteadoQuarterMarginPct: '0.70',
    });
    expect(previa.base.valor).toBe('0.40');
    expect(previa.especificos.feteadoQuarter.valor).toBe('0.70');
    expect(previa.especificos.feteado100g.valor).toBe('0.40');
  });
});
