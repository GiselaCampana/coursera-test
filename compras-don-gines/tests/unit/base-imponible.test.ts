import { describe, it, expect } from 'vitest';
import { conceptoSegunEtiqueta, reconciliarPie } from '@/lib/ocr/motor/pie-fiscal';
import { Decimal } from '@/lib/money';
import type { Fragmento } from '@/lib/ocr/reconstruccion/evidencia';
import { palabra } from '@/../tests/fixtures/evidencia-sintetica';

/**
 * **La base imponible es un concepto propio, no un sinónimo del neto gravado.**
 *
 * Una base imponible dice sobre qué importe se calculó una alícuota de IVA. Un
 * comprobante con artículos al 21 % y al 10,5 % imprime **dos**, cada una con
 * su alícuota y su IVA, y el neto gravado es su suma. Modelarla como otra
 * manera de decir «neto» obliga a elegir una y tirar la otra.
 *
 * La distinción además resuelve una confusión medida. Un papel imprime
 * «Subtotal» y «Base Imponible IVA 21 %»: los dos números son legítimos y
 * distintos, y el subtotal se parece más a la suma del detalle, así que ganaba.
 * La base es la que cumple la relación que importa —base × alícuota da el IVA
 * impreso— y esa igualdad es **independiente del detalle**, así que vale más
 * que una cercanía.
 *
 * Los casos de acá están armados a mano: no hay valores de ninguna factura.
 */

const ALTURA = 0.008;

function filaDelPie(y: number, celdas: [texto: string, x: number][]): Fragmento[] {
  return celdas.map(([texto, x]) => palabra(texto, x, y));
}

function pie(fragmentos: Fragmento[], detalle: string | null = null) {
  return reconciliarPie(fragmentos, {
    sumaDelDetalle: detalle === null ? null : new Decimal(detalle),
    alturaTipica: ALTURA,
    renglonesDelDetalle: 3,
    desdeY: 0,
    finDelDetalle: 0.30,
  });
}

// ---------------------------------------------------------------------------
// 1. Qué se reconoce y qué no
// ---------------------------------------------------------------------------

describe('la frase completa, y sólo la frase completa', () => {
  it('reconoce BASE IMPONIBLE, con o sin su alícuota detrás', () => {
    expect(conceptoSegunEtiqueta('Base Imponible')?.concepto).toBe('baseImponible');
    expect(conceptoSegunEtiqueta('BASE IMPONIBLE IVA 21 %')?.concepto).toBe('baseImponible');
    expect(conceptoSegunEtiqueta('Base Imponible Iva 10,5%')?.concepto).toBe('baseImponible');
  });

  it('no reconoce BASE ni IMPONIBLE por separado', () => {
    /*
     * «Base» sola aparece en media docena de leyendas de una factura —base de
     * cálculo, base de datos del sistema— y reconocerla sería inventar un
     * concepto fiscal donde hay una palabra suelta.
     */
    expect(conceptoSegunEtiqueta('Base')?.concepto).not.toBe('baseImponible');
    expect(conceptoSegunEtiqueta('Imponible')?.concepto).not.toBe('baseImponible');
    expect(conceptoSegunEtiqueta('Base de calculo')?.concepto).not.toBe('baseImponible');
  });

  it('una etiqueta mutilada no se acepta por parecido aislado', () => {
    /*
     * El parecido de una frase de dos palabras es mucho más frágil que el de
     * una sola, y una base imponible decide contra qué se calculó un impuesto.
     * Lo que la recupera es la geometría y la igualdad fiscal, no el parecido.
     */
    expect(conceptoSegunEtiqueta('Bas Impon')?.concepto).not.toBe('baseImponible');
    expect(conceptoSegunEtiqueta('B45E 1MP0N1BLE')?.concepto).not.toBe('baseImponible');
  });

  it('una etiqueta comida se recupera cuando además cumple la relación', () => {
    /*
     * «ase imponible» es «base imponible» con la primera letra comida: las
     * letras están en orden dentro de la canónica. Y lo confirma la igualdad,
     * que es lo que la hace aceptable.
     */
    const resultado = pie(
      [
        ...filaDelPie(0.40, [
          ['ase', 0.52],
          ['imponible', 0.58],
          ['IVA', 0.68],
          ['21%', 0.72],
          ['100.000,00', 0.86],
        ]),
        ...filaDelPie(0.42, [
          ['IVA', 0.58],
          ['21%', 0.64],
          ['21.000,00', 0.86],
        ]),
      ],
      '100000.00',
    );
    expect(resultado.basesImponibles).toHaveLength(1);
    expect(resultado.basesImponibles[0].valor.toFixed(2)).toBe('100000.00');
  });
});

// ---------------------------------------------------------------------------
// 2. La base le gana al subtotal donde importa
// ---------------------------------------------------------------------------

describe('la base alimenta el IVA; el subtotal es otra cosa', () => {
  /** Un pie con las dos cosas impresas, que es el caso que lo motivó. */
  function conLasDos(baseTexto: string, subtotalTexto: string) {
    return pie(
      [
        ...filaDelPie(0.40, [
          ['Subtotal', 0.58],
          [subtotalTexto, 0.86],
        ]),
        ...filaDelPie(0.42, [
          ['Base', 0.52],
          ['Imponible', 0.58],
          ['IVA', 0.68],
          ['21%', 0.72],
          [baseTexto, 0.86],
        ]),
        ...filaDelPie(0.44, [
          ['IVA', 0.58],
          ['21%', 0.64],
          ['21.000,00', 0.86],
        ]),
      ],
      // El detalle se parece **más** al subtotal que a la base: si ganara la
      // cercanía, ganaría el subtotal.
      '117000.00',
    );
  }

  it('con Subtotal y Base Imponible, la base es la que alimenta el IVA', () => {
    const resultado = conLasDos('100.000,00', '117.000,00');
    expect(resultado.basesImponibles).toHaveLength(1);
    expect(resultado.basesImponibles[0].valor.toFixed(2)).toBe('100000.00');
    expect(resultado.basesImponibles[0].alicuota?.toString()).toBe('0.21');

    const delIva = resultado.asignaciones.find((a) => a.concepto === 'iva');
    expect(delIva?.valor.toFixed(2)).toBe('21000.00');
    expect(delIva?.igualdad).toContain('base imponible');
  });

  it('un subtotal más cercano al detalle no desplaza una base explícita', () => {
    const resultado = conLasDos('100.000,00', '117.000,00');
    // La base sigue siendo la base, y el subtotal no se convirtió en ella.
    expect(resultado.basesImponibles.map((b) => b.valor.toFixed(2))).toEqual(['100000.00']);
    for (const base of resultado.basesImponibles) {
      expect(base.valor.toFixed(2)).not.toBe('117000.00');
    }
  });

  it('una diferencia chica entre el detalle y la base no anula la relación', () => {
    /*
     * La igualdad base × alícuota = IVA se comprueba contra los dos importes
     * impresos y **no depende** de que el detalle cierre. Sesenta centavos de
     * desfase en la suma de los artículos no tienen por qué costar el IVA.
     */
    const resultado = pie(
      [
        ...filaDelPie(0.40, [
          ['Base', 0.52],
          ['Imponible', 0.58],
          ['IVA', 0.68],
          ['21%', 0.72],
          ['100.000,00', 0.86],
        ]),
        ...filaDelPie(0.42, [
          ['IVA', 0.58],
          ['21%', 0.64],
          ['21.000,00', 0.86],
        ]),
      ],
      // El detalle queda a sesenta centavos de la base.
      '99999.40',
    );
    expect(resultado.basesImponibles).toHaveLength(1);
    const delIva = resultado.asignaciones.find((a) => a.concepto === 'iva');
    expect(delIva?.valor.toFixed(2)).toBe('21000.00');
    expect(delIva?.igualdad).toContain('base imponible');
  });
});

// ---------------------------------------------------------------------------
// 3. Varias bases, y el neto que sale de ellas
// ---------------------------------------------------------------------------

describe('varias bases se conservan separadas', () => {
  const dosAlicuotas = [
    ...filaDelPie(0.40, [
      ['Base', 0.46],
      ['Imponible', 0.52],
      ['IVA', 0.62],
      ['21%', 0.66],
      ['100.000,00', 0.86],
    ]),
    ...filaDelPie(0.42, [
      ['IVA', 0.52],
      ['21%', 0.58],
      ['21.000,00', 0.86],
    ]),
    ...filaDelPie(0.44, [
      ['Base', 0.46],
      ['Imponible', 0.52],
      ['IVA', 0.62],
      ['10,5%', 0.66],
      ['40.000,00', 0.86],
    ]),
    ...filaDelPie(0.46, [
      ['IVA', 0.52],
      ['10,5%', 0.58],
      ['4.200,00', 0.86],
    ]),
  ];

  it('las de 21 % y 10,5 % se mantienen separadas, cada una con su alícuota', () => {
    const resultado = pie(dosAlicuotas, '140000.00');
    const bases = resultado.basesImponibles
      .map((b) => `${b.alicuota?.toString() ?? '—'}:${b.valor.toFixed(2)}`)
      .sort();
    expect(bases).toEqual(['0.105:40000.00', '0.21:100000.00']);
  });

  it('cada base se vincula con el IVA de su misma alícuota', () => {
    const resultado = pie(dosAlicuotas, '140000.00');
    const ivas = resultado.asignaciones.filter((a) => a.concepto === 'iva');
    expect(ivas.length).toBeGreaterThanOrEqual(1);
    for (const iva of ivas) {
      expect(iva.igualdad).toContain('base imponible');
    }
  });

  it('el neto agregado se deriva de la suma y no se hace pasar por impreso', () => {
    const resultado = pie(dosAlicuotas, '140000.00');
    expect(resultado.netoGravado?.toFixed(2)).toBe('140000.00');
    expect(resultado.netoDerivadoDeLasBases).toBe(true);

    const delNeto = resultado.asignaciones.find((a) => a.concepto === 'netoGravado');
    expect(delNeto?.procedencia).toBe('DERIVED_SUGGESTION');
    expect(delNeto?.igualdad).toContain('bases imponibles');

    // Y las bases originales siguen ahí: el agregado no las reemplaza.
    expect(resultado.basesImponibles).toHaveLength(2);
  });

  it('una base única se proyecta al neto conservando su procedencia', () => {
    const resultado = pie(
      [
        ...filaDelPie(0.40, [
          ['Base', 0.52],
          ['Imponible', 0.58],
          ['IVA', 0.68],
          ['21%', 0.72],
          ['100.000,00', 0.86],
        ]),
        ...filaDelPie(0.42, [
          ['IVA', 0.58],
          ['21%', 0.64],
          ['21.000,00', 0.86],
        ]),
      ],
      '100000.00',
    );
    expect(resultado.netoGravado?.toFixed(2)).toBe('100000.00');
    // Una sola base **es** el neto: el mismo número del papel, no una cuenta.
    expect(resultado.netoDerivadoDeLasBases).toBe(false);
    const delNeto = resultado.asignaciones.find((a) => a.concepto === 'netoGravado');
    expect(delNeto?.procedencia).toBe('READ_FROM_DOCUMENT');
    expect(resultado.basesImponibles).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3 bis. La base partida en dos cajas, y el lugar del neto
// ---------------------------------------------------------------------------

describe('una base que el OCR cortó en la coma', () => {
  /**
   * El accidente tal como llega: «1.523.537» en una caja y «99» en la de al
   * lado, pegadas, de la misma pasada. Son un solo número impreso.
   */
  function partida(pasada: string) {
    return [
      palabra('Base', 0.46, 0.4, { pasada }),
      palabra('Imponible', 0.52, 0.4, { pasada }),
      palabra('100.000', 0.86, 0.4, { pasada, ancho: 0.06 }),
      palabra('50', 0.921, 0.4, { pasada, ancho: 0.018 }),
      ...filaDelPie(0.42, [
        ['IVA', 0.58],
        ['21%', 0.64],
      ]),
      palabra('21.000,11', 0.86, 0.42, { pasada }),
    ];
  }

  it('se vuelve a pegar cuando la igualdad lo confirma', () => {
    /*
     * 100.000,50 × 21 % = 21.000,105, que es el 21.000,11 impreso. Sin los
     * centavos la cuenta da 21.000,00 y se aparta once centavos: la igualdad es
     * la que dice cuál de las dos lecturas tiene el papel.
     */
    const resultado = pie(partida('completo:directo'), null);
    expect(resultado.basesImponibles.map((b) => b.valor.toFixed(2))).toEqual(['100000.50']);
  });

  it('los centavos sueltos no entran como un concepto de cincuenta pesos', () => {
    const resultado = pie(partida('completo:directo'), null);
    const valores = resultado.asignaciones.map((a) => a.valor.toFixed(2));
    expect(valores).not.toContain('50.00');
    expect(resultado.sinAsignar.map((u) => u.texto)).not.toContain('50');
  });

  it('no se pegan dos cajas de pasadas distintas', () => {
    /*
     * Dos pasadas son dos lecturas del mismo papel, no dos pedazos de un
     * número: pegarlas sería inventar un importe cruzando lecturas.
     */
    const cruzada = [
      palabra('Base', 0.46, 0.4),
      palabra('Imponible', 0.52, 0.4),
      palabra('100.000', 0.86, 0.4, { ancho: 0.06 }),
      palabra('50', 0.921, 0.4, { pasada: 'articulos:directo', ancho: 0.018 }),
      ...filaDelPie(0.42, [
        ['IVA', 0.58],
        ['21%', 0.64],
      ]),
      palabra('21.000,11', 0.86, 0.42),
    ];
    const resultado = pie(cruzada, null);
    expect(resultado.basesImponibles.map((b) => b.valor.toFixed(2))).not.toContain('100000.50');
  });
});

describe('el lugar del neto gravado', () => {
  /** Un subtotal que no cierra contra nada, y una base con su IVA impreso. */
  const subtotalSinRelacion = [
    ...filaDelPie(0.4, [
      ['Subtotal', 0.58],
      ['117.000,00', 0.86],
    ]),
    ...filaDelPie(0.42, [
      ['Base', 0.52],
      ['Imponible', 0.58],
      ['IVA', 0.68],
      ['21%', 0.72],
      ['100.000,00', 0.86],
    ]),
    ...filaDelPie(0.44, [
      ['IVA', 0.58],
      ['21%', 0.64],
      ['21.000,00', 0.86],
    ]),
  ];

  it('una base probada se lo gana a un subtotal que no prueba nada', () => {
    // Sin suma del detalle, el subtotal no tiene ninguna relación que lo sostenga.
    const resultado = pie(subtotalSinRelacion, null);
    expect(resultado.netoGravado?.toFixed(2)).toBe('100000.00');
    // Y el subtotal no desaparece: queda leído y sin concepto probado.
    expect(resultado.sinAsignar.map((u) => u.valor?.toFixed(2))).toContain('117000.00');
  });

  it('pero no se lo gana a un neto que cierra con el detalle', () => {
    /*
     * Ahí el neto tiene su propia relación independiente, y dos evidencias
     * distintas no se resuelven pisando una con la otra.
     */
    const resultado = pie(subtotalSinRelacion, '117000.00');
    expect(resultado.netoGravado?.toFixed(2)).toBe('117000.00');
    expect(resultado.basesImponibles.map((b) => b.valor.toFixed(2))).toEqual(['100000.00']);
  });
});

// ---------------------------------------------------------------------------
// 4. Lo que una base nunca puede ser
// ---------------------------------------------------------------------------

describe('reconocer la base no arrastra a los otros conceptos', () => {
  it('un descuento, una percepción o un no gravado no se vuelven bases', () => {
    const resultado = pie(
      [
        ...filaDelPie(0.40, [
          ['Base', 0.46],
          ['Imponible', 0.52],
          ['IVA', 0.62],
          ['21%', 0.66],
          ['100.000,00', 0.86],
        ]),
        ...filaDelPie(0.42, [
          ['Importe', 0.46],
          ['Descuento', 0.54],
          ['Total', 0.62],
          ['5.000,00', 0.86],
        ]),
        ...filaDelPie(0.44, [
          ['Percepcion', 0.46],
          ['IIBB', 0.56],
          ['1.500,00', 0.86],
        ]),
        ...filaDelPie(0.46, [
          ['No', 0.46],
          ['Gravado', 0.50],
          ['2.000,00', 0.86],
        ]),
      ],
      '100000.00',
    );

    const valoresDeBase = resultado.basesImponibles.map((b) => b.valor.toFixed(2));
    expect(valoresDeBase).toEqual(['100000.00']);
    expect(valoresDeBase).not.toContain('5000.00');
    expect(valoresDeBase).not.toContain('1500.00');
    expect(valoresDeBase).not.toContain('2000.00');
  });

  it('dos bases posibles para el mismo IVA sin margen quedan sin asignar', () => {
    /*
     * Dos números rotulados igual, con la misma alícuota y valores distintos: no
     * hay una base, hay dos candidatas. Lo que no puede pasar es que se elija
     * una y se escriba como si fuera un dato leído.
     */
    const resultado = pie(
      [
        ...filaDelPie(0.40, [
          ['Bas3', 0.46],
          ['Imp0nible', 0.52],
          ['IVA', 0.62],
          ['21%', 0.66],
          ['100.000,00', 0.86],
        ]),
        ...filaDelPie(0.42, [
          ['Bas3', 0.46],
          ['Imp0nible', 0.52],
          ['IVA', 0.62],
          ['21%', 0.66],
          ['110.000,00', 0.86],
        ]),
      ],
      '100000.00',
    );
    // Ninguna de las dos se afirma como base: las etiquetas están dañadas y
    // ninguna gana.
    expect(resultado.basesImponibles).toHaveLength(0);
    expect(resultado.estado).not.toBe('completo');
  });
});
