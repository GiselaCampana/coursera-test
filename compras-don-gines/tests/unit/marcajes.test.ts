import { describe, it, expect } from 'vitest';
import {
  CAMPO_DEL_MARCAJE as CAMPO,
  MARCAJES,
  MARCAJES_POR_MODALIDAD,
  REDONDEA_AL_100,
  SIN_REGLA_GENERAL,
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

  it('sin el del artículo ni el de la familia, rige el de la regla general', () => {
    const r = marcajesEfectivos(VACIA, VACIA, { targetMarginPct: '0.45' });
    expect(r.base.valor).toBe('0.45');
    expect(r.base.origen).toBe('GENERAL');
  });

  it('sin ninguna regla general cargada lo dice, en vez de inventar una decisión', () => {
    /*
     * El último recurso existe, pero no se hace pasar por una configuración:
     * el origen dice que no hay regla general. La migración la crea, así que en
     * una base al día esto no se ve.
     */
    const r = marcajesEfectivos(VACIA, VACIA);
    expect(r.base.valor).toBe(SIN_REGLA_GENERAL);
    expect(r.base.origen).toBe('SIN_CONFIGURAR');
  });

  it('un artículo sin familia resuelve igual', () => {
    const r = marcajesEfectivos({ targetMarginPct: '0.30' }, null);
    expect(r.base.valor).toBe('0.30');
    expect(marcajesEfectivos(VACIA, null, { targetMarginPct: '0.45' }).base.origen).toBe(
      'GENERAL',
    );
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
      expect(r.especificos[m].valor, m).toBe(SIN_REGLA_GENERAL);
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

describe('cada forma de venta se configura sola', () => {
  /*
   * Lo que hace que "marcajes por modalidad" signifique algo.
   *
   * Ocho campos que se pisan entre sí no son ocho campos: son uno con ocho
   * nombres. Tocar el de la horma tiene que dejar el kilo donde estaba, y tocar
   * el de la pieza no puede mover el de 100 g ni el de 1/4, que son los dos que
   * se ven en la etiqueta del mostrador.
   */
  it('cambiar el marcaje de horma no modifica el de kilo', () => {
    const antes = marcajesEfectivos({ targetMarginPct: '0.40' });
    expect(antes.base.valor).toBe('0.40');
    expect(antes.especificos.alCorteHormaDigital.valor).toBe('0.40');

    const despues = marcajesEfectivos({
      targetMarginPct: '0.40',
      alCorteHormaDigitalMarginPct: '0.25',
      alCorteHormaCashMarginPct: '0.20',
    });
    // La horma cambió…
    expect(despues.especificos.alCorteHormaDigital.valor).toBe('0.25');
    expect(despues.especificos.alCorteHormaCash.valor).toBe('0.20');
    // …y el kilo no.
    expect(despues.base.valor).toBe('0.40');
    expect(despues.base.origen).toBe('PRODUCTO');
    // Tampoco la caja, que sigue tomando el kilo por su cuenta.
    expect(despues.especificos.alCorteCajaCash.valor).toBe('0.40');
    expect(despues.especificos.alCorteCajaCash.origen).toBe('BASE');
  });

  it('cambiar el marcaje de pieza no modifica el de 100 g ni el de 1/4', () => {
    const despues = marcajesEfectivos({
      targetMarginPct: '0.40',
      feteadoPieceDigitalMarginPct: '0.25',
      feteadoPieceCashMarginPct: '0.22',
    });
    expect(despues.especificos.feteadoPieceDigital.valor).toBe('0.25');
    expect(despues.especificos.feteadoPieceCash.valor).toBe('0.22');
    expect(despues.especificos.feteado100g.valor).toBe('0.40');
    expect(despues.especificos.feteado100g.origen).toBe('BASE');
    expect(despues.especificos.feteadoQuarter.valor).toBe('0.40');
    expect(despues.especificos.feteadoQuarter.origen).toBe('BASE');
  });

  it('cambiar uno de los ocho deja los otros siete donde estaban', () => {
    // La versión general de las dos de arriba, para que agregar una novena
    // forma de venta no pueda romper esto sin que una prueba lo diga.
    const base = marcajesEfectivos({ targetMarginPct: '0.40' });
    for (const tocado of MARCAJES) {
      const r = marcajesEfectivos({ targetMarginPct: '0.40', [CAMPO[tocado]]: '0.11' });
      expect(r.especificos[tocado].valor, tocado).toBe('0.11');
      expect(r.base.valor, tocado).toBe('0.40');
      for (const otro of MARCAJES) {
        if (otro === tocado) continue;
        expect(r.especificos[otro].valor, `${tocado} movió ${otro}`).toBe(
          base.especificos[otro].valor,
        );
      }
    }
  });
});

describe('el redondeo lo fija la forma de venta, no la configuración', () => {
  it('kilo, 100 g y 1/4 van al $100; horma, caja, pieza y unidad quedan exactos', () => {
    /*
     * Es lo acordado y no se configura: quien mira la pantalla tiene que poder
     * anticipar el número que va a salir. Redondear un importe que se cobra una
     * sola vez —una horma, una caja— arrastraría el error al precio por kilo.
     */
    expect(REDONDEA_AL_100.kilo).toBe(true);
    expect(REDONDEA_AL_100.feteado100g).toBe(true);
    expect(REDONDEA_AL_100.feteadoQuarter).toBe(true);
    expect(REDONDEA_AL_100.alCorteHormaDigital).toBe(false);
    expect(REDONDEA_AL_100.alCorteHormaCash).toBe(false);
    expect(REDONDEA_AL_100.alCorteCajaCash).toBe(false);
    expect(REDONDEA_AL_100.feteadoPieceDigital).toBe(false);
    expect(REDONDEA_AL_100.feteadoPieceCash).toBe(false);
    expect(REDONDEA_AL_100.wholeUnit).toBe(false);
  });

  it('cada modalidad ofrece sus formas de venta y ninguna de la otra', () => {
    expect(MARCAJES_POR_MODALIDAD.AL_CORTE).toEqual([
      'alCorteHormaDigital',
      'alCorteHormaCash',
      'alCorteCajaCash',
    ]);
    expect(MARCAJES_POR_MODALIDAD.FETEABLE).toEqual([
      'feteado100g',
      'feteadoQuarter',
      'feteadoPieceDigital',
      'feteadoPieceCash',
    ]);
    // La unidad entera no es de ninguna de las dos: depende de cómo se compra.
    for (const modalidad of ['AL_CORTE', 'FETEABLE'] as const) {
      expect(MARCAJES_POR_MODALIDAD[modalidad]).not.toContain('wholeUnit');
    }
  });
});

describe('la regla general es el tercer nivel, no una pantalla decorativa', () => {
  it('un específico de la regla general le gana al base del artículo', () => {
    /*
     * El caso que distingue "existe la regla general" de "se aplica la regla
     * general": el artículo tiene su marcaje por kilo, pero para la venta por
     * 1/4 kg nadie dijo nada ni en el artículo ni en la familia, y entonces
     * contesta el tercer nivel.
     */
    const r = marcajesEfectivos(
      { targetMarginPct: '0.30' },
      {},
      { feteadoQuarterMarginPct: '0.65' },
    );
    expect(r.especificos.feteadoQuarter.valor).toBe('0.65');
    expect(r.especificos.feteadoQuarter.origen).toBe('GENERAL');
    expect(r.base.valor).toBe('0.30');
  });

  it('pierde contra el artículo y contra la familia, en ese orden', () => {
    const conFamilia = marcajesEfectivos(
      {},
      { feteadoQuarterMarginPct: '0.60' },
      { feteadoQuarterMarginPct: '0.65' },
    );
    expect(conFamilia.especificos.feteadoQuarter.valor).toBe('0.60');
    expect(conFamilia.especificos.feteadoQuarter.origen).toBe('FAMILIA');

    const conArticulo = marcajesEfectivos(
      { feteadoQuarterMarginPct: '0.10' },
      { feteadoQuarterMarginPct: '0.60' },
      { feteadoQuarterMarginPct: '0.65' },
    );
    expect(conArticulo.especificos.feteadoQuarter.valor).toBe('0.10');
    expect(conArticulo.especificos.feteadoQuarter.origen).toBe('PRODUCTO');
  });

  it('una regla general con el valor que traía el sistema no mueve ningún precio', () => {
    /*
     * La condición de la migración: activar la regla general no puede cambiar
     * lo que hoy se cobra. Con el mismo número que era el valor por omisión, lo
     * único que cambia es que ahora se puede ver de dónde sale.
     */
    const sinRegla = marcajesEfectivos({}, {});
    const conRegla = marcajesEfectivos({}, {}, { targetMarginPct: SIN_REGLA_GENERAL });
    expect(conRegla.base.valor).toBe(sinRegla.base.valor);
    for (const m of MARCAJES) {
      expect(conRegla.especificos[m].valor, m).toBe(sinRegla.especificos[m].valor);
    }
    // Lo que sí cambia es que deja de decir que no hay nada cargado.
    expect(sinRegla.base.origen).toBe('SIN_CONFIGURAR');
    expect(conRegla.base.origen).toBe('GENERAL');
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
    expect(
      marcajesEfectivos(VACIA, VACIA, { marginBasis: 'SOBRE_COSTO' }).marginBasis.valor,
    ).toBe('SOBRE_COSTO');
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
