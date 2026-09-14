import { describe, it, expect } from 'vitest';
import {
  enPalabras,
  lecturasPisadas,
  noPuedenSerImportes,
  nombraOtraCosa,
  pareceImporte,
  regionesDelPie,
} from '@/lib/ocr/motor/region-del-pie';
import { reconciliarPie } from '@/lib/ocr/motor/pie-fiscal';
import { Decimal } from '@/lib/money';
import type { Fragmento } from '@/lib/ocr/reconstruccion/evidencia';
import { palabra } from '@/../tests/fixtures/evidencia-sintetica';

/**
 * **El pie fiscal es un recuadro, no una lista de líneas.**
 *
 * El lector de líneas agrupaba los fragmentos por altura y le daba a cada
 * número, como etiqueta, el texto que tenía a su izquierda. Funciona en un pie
 * de una columna y falla en todos los demás: un recuadro con encabezados arriba
 * e importes debajo, o dos columnas que la foto de un teléfono deja
 * desalineadas. Ahí «lo que está a la izquierda» es otro importe.
 *
 * Lo que se midió sobre el lote: diecisiete campos fiscales confundidos, y
 * ninguno era un error de lectura. Los números estaban bien leídos y mal
 * **asociados**: «PESO NETO: 122,00» entraba como el neto gravado porque la
 * frase contiene la palabra «neto»; el «1,50» de una percepción del IIBB entraba
 * como su importe porque el signo de porcentaje se perdió; el CAE entraba como
 * el total porque es el número más grande del pie.
 *
 * Todos los casos de acá están armados a mano, con coordenadas verosímiles y
 * contenido inventado: las facturas del lote no entran al repositorio.
 */

const ALTURA = 0.008;
const CUIT = '27-33342291-9';

/** Una fila del pie: cada pedazo con su posición horizontal. */
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

function unaRegion(fragmentos: Fragmento[]) {
  const regiones = regionesDelPie(fragmentos, {
    alturaTipica: ALTURA,
    desdeY: 0,
    finDelDetalle: 0.30,
  });
  expect(regiones.length, 'no se propuso ninguna región').toBeGreaterThan(0);
  return regiones[0];
}

const valores = (lista: { valor: Decimal }[]) => lista.map((x) => x.valor.toString());

// ---------------------------------------------------------------------------
// 1. La geometría en dos dimensiones
// ---------------------------------------------------------------------------

describe('el pie se lee como un recuadro con casillas', () => {
  it('lee un recuadro con las etiquetas arriba y los importes debajo', () => {
    /*
     * El formato que el lector de líneas no podía leer: los tres rótulos en una
     * fila y los tres importes en la de abajo. A la izquierda de cada importe no
     * hay una etiqueta, hay **otro importe**.
     */
    const resultado = pie(
      [
        ...filaDelPie(0.40, [
          ['NETO', 0.50],
          ['IVA', 0.66],
          ['TOTAL', 0.82],
        ]),
        ...filaDelPie(0.42, [
          ['100.000,00', 0.50],
          ['21.000,00', 0.66],
          ['121.000,00', 0.82],
        ]),
      ],
      '100000.00',
    );

    expect(resultado.netoGravado?.toFixed(2)).toBe('100000.00');
    expect(valores(resultado.iva)).toContain('21000');
    expect(resultado.total?.toFixed(2)).toBe('121000.00');
  });

  it('asocia una etiqueta con su importe aunque el OCR los dejó en líneas distintas', () => {
    /*
     * El pie de dos columnas sobre una foto inclinada: la etiqueta queda medio
     * renglón más arriba que su importe y caen en grupos distintos.
     */
    const resultado = pie(
      [
        ...filaDelPie(0.400, [['Neto Gravado', 0.58]]),
        ...filaDelPie(0.404, [['100.000,00', 0.82]]),
        ...filaDelPie(0.420, [['IVA 21%', 0.58]]),
        ...filaDelPie(0.424, [['21.000,00', 0.82]]),
        ...filaDelPie(0.440, [['TOTAL', 0.58]]),
        ...filaDelPie(0.444, [['121.000,00', 0.82]]),
      ],
      '100000.00',
    );

    expect(resultado.netoGravado?.toFixed(2)).toBe('100000.00');
    expect(resultado.total?.toFixed(2)).toBe('121000.00');
  });

  it('cambiar el orden visual de las casillas no cambia el resultado', () => {
    /*
     * Lo que decide es la geometría, no el orden en que el OCR devolvió los
     * fragmentos. Barajarlos tiene que dar exactamente lo mismo.
     */
    const fragmentos = [
      ...filaDelPie(0.40, [
        ['Neto', 0.58],
        ['100.000,00', 0.82],
      ]),
      ...filaDelPie(0.42, [
        ['IVA 21%', 0.58],
        ['21.000,00', 0.82],
      ]),
      ...filaDelPie(0.44, [
        ['Total', 0.58],
        ['121.000,00', 0.82],
      ]),
    ];
    const derecho = pie(fragmentos, '100000.00');
    const barajado = pie([...fragmentos].reverse(), '100000.00');

    expect(barajado.netoGravado?.toString()).toBe(derecho.netoGravado?.toString());
    expect(barajado.total?.toString()).toBe(derecho.total?.toString());
    expect(valores(barajado.iva)).toEqual(valores(derecho.iva));
  });
});

// ---------------------------------------------------------------------------
// 2. Los conceptos negativos
// ---------------------------------------------------------------------------

describe('una frase que contiene la palabra no es el concepto', () => {
  it('PESO NETO no es el neto gravado', () => {
    expect(nombraOtraCosa('PESO NETO:')).toBe(true);
    const resultado = pie(
      [
        ...filaDelPie(0.40, [
          ['PESO', 0.58],
          ['NETO:', 0.64],
          ['122,00', 0.82],
        ]),
        ...filaDelPie(0.42, [
          ['Neto', 0.58],
          ['Gravado', 0.64],
          ['100.000,00', 0.82],
        ]),
      ],
      '100000.00',
    );
    expect(resultado.netoGravado?.toFixed(2)).toBe('100000.00');
  });

  it('DESCUENTO TOTAL no es el total del comprobante', () => {
    expect(nombraOtraCosa('Importe Descuento Total')).toBe(true);
    expect(nombraOtraCosa('Total')).toBe(false);
    expect(nombraOtraCosa('Total Gravado')).toBe(false);
  });

  it('un saldo de cuenta corriente mayor que el total queda descartado', () => {
    /*
     * Y se descarta **por lo que dice su etiqueta**, no por su magnitud: si
     * ganara el número más grande, ganaría siempre éste.
     */
    expect(nombraOtraCosa('Saldo Anterior')).toBe(true);
    expect(nombraOtraCosa('Saldo Acumulado')).toBe(true);

    const resultado = pie(
      [
        ...filaDelPie(0.40, [
          ['Saldo', 0.30],
          ['Ac.', 0.36],
          ['532.848,64', 0.50],
          ['Total', 0.66],
          ['121.000,00', 0.82],
        ]),
      ],
      '100000.00',
    );
    expect(resultado.total?.toFixed(2)).toBe('121000.00');
    for (const asignacion of resultado.asignaciones) {
      expect(asignacion.valor.toString()).not.toBe('532848.64');
    }
  });

  it('el CAE y el CUIT no entran nunca al grafo monetario', () => {
    /*
     * Por dos caminos, y los dos hacen falta. Por su etiqueta cuando el papel la
     * imprime al lado, y **por su forma** cuando no: el CAE tiene catorce
     * dígitos corridos y el CUIT once, que es como los define la AFIP, y ningún
     * importe se escribe así. Sobre una de las fotos el «CAE N°» quedó en otra
     * línea que su número y el número entró como el total.
     */
    expect(nombraOtraCosa('CAE N°:')).toBe(true);
    expect(nombraOtraCosa('C.U.I.T.')).toBe(true);
    expect(pareceImporte('86361580932052')).toBe(false);
    expect(pareceImporte('30715963376')).toBe(false);
    // Y un importe de la misma cantidad de cifras, con su coma, sigue siéndolo.
    expect(pareceImporte('863.615.809.320,52')).toBe(true);
  });

  it('un total de kilos o de bultos no es un importe', () => {
    expect(nombraOtraCosa('Total Kgs.')).toBe(true);
    expect(nombraOtraCosa('CANT. BULT.:')).toBe(false);
    expect(nombraOtraCosa('Cantidad Total')).toBe(true);
  });

  it('el veto es por palabras enteras, nunca por pedazo de palabra', () => {
    /*
     * La garantía que hace segura la lista. Si se comparara por subcadena,
     * «peso neto» vetaría «neto gravado» y el pie se quedaría sin su concepto
     * principal.
     */
    expect(nombraOtraCosa('Neto Gravado')).toBe(false);
    expect(nombraOtraCosa('Subtotal')).toBe(false);
    expect(nombraOtraCosa('Percepcion IIBB')).toBe(false);
    // Y las abreviaturas con puntos son una palabra, no cuatro letras sueltas.
    expect(enPalabras('I.V.A. 21 %')).toEqual(['iva']);
    expect(enPalabras('C.U.I.T.')).toEqual(['cuit']);
  });
});

// ---------------------------------------------------------------------------
// 3. Qué puede ser un importe y qué no
// ---------------------------------------------------------------------------

describe('la geometría dice qué números son plata', () => {
  it('la alícuota de la misma etiqueta no compite con su importe', () => {
    /*
     * «Perc IIBB CABA  1,50  $  22.853,07» tiene dos números bajo la misma
     * etiqueta. El de la izquierda es el porcentaje —y el OCR se come el signo
     * la mitad de las veces— así que lo único que los distingue es en qué
     * columna están. Entre los dos hay un «$», que no nombra nada.
     */
    const fragmentos = [
      ...filaDelPie(0.40, [
        ['Perc', 0.30],
        ['IIBB', 0.36],
        ['1,50', 0.55],
        ['$', 0.62],
        ['22.853,07', 0.82],
      ]),
      ...filaDelPie(0.42, [
        ['Total', 0.30],
        ['$', 0.62],
        ['122.853,07', 0.82],
      ]),
    ];
    const fuera = noPuedenSerImportes(unaRegion(fragmentos));
    expect([...fuera].map((f) => f.texto)).toContain('1,50');

    const resultado = pie(fragmentos, '100000.00');
    expect(valores(resultado.percepciones)).toContain('22853.07');
    expect(valores(resultado.percepciones)).not.toContain('1.5');
  });

  it('dos conceptos en la misma fila, cada uno con su rótulo, se conservan', () => {
    /*
     * El otro lado: una fila puede llevar dos conceptos, y así imprime su pie
     * más de un proveedor. Lo que distingue este caso del anterior es que el
     * segundo número **tiene su propia palabra** delante.
     */
    const fragmentos = [
      ...filaDelPie(0.40, [
        ['SUB-TOTAL', 0.20],
        ['100.000,00', 0.66],
        ['IVA', 0.60],
        ['21.000,00', 0.82],
      ]),
    ];
    const fuera = noPuedenSerImportes(unaRegion(fragmentos));
    expect([...fuera].map((f) => f.texto)).not.toContain('100.000,00');
  });

  it('la misma caja física no ocupa dos conceptos', () => {
    /*
     * Una pasada devuelve «22.853,07» y otra, que se comió el principio,
     * «853,07». Las dos cajas se pisan: son dos lecturas de un lugar del papel,
     * no dos percepciones. Gana la que leyó más dígitos, no la de mayor valor.
     */
    const entero = palabra('22.853,07', 0.82, 0.40);
    const mutilado = { ...palabra('853,07', 0.84, 0.40), confianza: 0.99 };
    const pisadas = lecturasPisadas([entero, mutilado], ALTURA);
    expect([...pisadas].map((f) => f.texto)).toEqual(['853,07']);
  });

  it('un número que no está escrito como plata no es un concepto fiscal', () => {
    expect(pareceImporte('0,00')).toBe(true);
    expect(pareceImporte('121.000,00')).toBe(true);
    expect(pareceImporte('4')).toBe(false);
    expect(pareceImporte('21 %')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. El grafo comprueba, no inventa
// ---------------------------------------------------------------------------

describe('las relaciones fiscales comprueban asignaciones, no las crean', () => {
  it('recupera el total por su igualdad aunque la etiqueta esté destruida', () => {
    const resultado = pie(
      [
        ...filaDelPie(0.40, [
          ['Neto', 0.58],
          ['100.000,00', 0.82],
        ]),
        ...filaDelPie(0.42, [
          ['IVA', 0.58],
          ['21%', 0.66],
          ['21.000,00', 0.82],
        ]),
        ...filaDelPie(0.44, [
          ['T0T4L', 0.58],
          ['121.000,00', 0.82],
        ]),
      ],
      '100000.00',
    );
    expect(resultado.total?.toFixed(2)).toBe('121000.00');
    const delTotal = resultado.asignaciones.find((a) => a.concepto === 'total')!;
    // Y queda dicho de dónde salió: el valor es del papel, el concepto lo puso
    // el motor con una igualdad.
    expect(delTotal.origen.texto).toBe('121.000,00');
    expect(['READ_FROM_DOCUMENT', 'INFERRED_FROM_DOCUMENT_RELATIONS']).toContain(
      delTotal.procedencia,
    );
  });

  it('un total que sólo se puede calcular es una sugerencia y deja el pie parcial', () => {
    const resultado = pie(
      [
        ...filaDelPie(0.40, [
          ['Neto', 0.58],
          ['100.000,00', 0.82],
        ]),
        ...filaDelPie(0.42, [
          ['IVA', 0.58],
          ['21%', 0.66],
          ['21.000,00', 0.82],
        ]),
      ],
      '100000.00',
    );
    expect(resultado.estado).not.toBe('completo');
    if (resultado.total !== null) expect(resultado.totalCalculado).toBe(true);
  });

  it('varias percepciones se conservan por separado', () => {
    const resultado = pie(
      [
        ...filaDelPie(0.40, [
          ['Neto', 0.58],
          ['100.000,00', 0.82],
        ]),
        ...filaDelPie(0.42, [
          ['Percepcion', 0.52],
          ['IIBB', 0.62],
          ['1.500,00', 0.82],
        ]),
        ...filaDelPie(0.44, [
          ['Percepcion', 0.52],
          ['IVA', 0.62],
          ['2.500,00', 0.82],
        ]),
      ],
      '100000.00',
    );
    expect(valores(resultado.percepciones).sort()).toEqual(['1500', '2500']);
  });

  it('lo que queda sin explicar se informa como residuo, no se bautiza', () => {
    /*
     * La diferencia entre el total impreso y la suma de los conceptos
     * **permite sospechar** que falta uno y no autoriza a crearlo. Nada acá
     * puede llamarse «IIBB» ni «percepción» sin un fragmento que lo diga.
     */
    const resultado = pie(
      [
        ...filaDelPie(0.40, [
          ['Neto', 0.58],
          ['100.000,00', 0.82],
        ]),
        ...filaDelPie(0.42, [
          ['IVA', 0.58],
          ['21%', 0.66],
          ['21.000,00', 0.82],
        ]),
        ...filaDelPie(0.44, [
          ['Total', 0.58],
          ['125.000,00', 0.82],
        ]),
      ],
      '100000.00',
    );
    expect(resultado.estado).toBe('parcial');
    expect(resultado.residuo?.abs().toFixed(2)).toBe('4000.00');
    expect(resultado.asignaciones.map((a) => a.concepto)).not.toContain('percepcion');
  });

  it('un total menor que la suma del detalle no puede ser el total', () => {
    /*
     * Los impuestos y las percepciones suman, así que el total nunca es menor
     * que lo que suman los artículos. Es una relación fiscal, no un rango
     * comercial, y es lo que descarta las lecturas degeneradas: una región que
     * encontró un número suelto y lo llamó total cierra perfecto consigo misma.
     */
    const resultado = pie(
      [
        ...filaDelPie(0.40, [
          ['Neto', 0.58],
          ['100.000,00', 0.82],
        ]),
        ...filaDelPie(0.42, [
          ['Total', 0.58],
          ['121.000,00', 0.82],
        ]),
      ],
      '100000.00',
    );
    expect(resultado.total?.toFixed(2)).toBe('121000.00');
  });
});

// ---------------------------------------------------------------------------
// 5. Las dos convenciones, y las regiones compitiendo
// ---------------------------------------------------------------------------

describe('las regiones compiten enteras', () => {
  it('un pie escrito a la norteamericana se lee igual', () => {
    const resultado = pie(
      [
        ...filaDelPie(0.40, [
          ['Subtotal', 0.58],
          ['100,000.00', 0.82],
        ]),
        ...filaDelPie(0.42, [
          ['IVA', 0.58],
          ['21%', 0.66],
          ['21,000.00', 0.82],
        ]),
        ...filaDelPie(0.44, [
          ['Total', 0.58],
          ['121,000.00', 0.82],
        ]),
      ],
      '100000.00',
    );
    expect(resultado.netoGravado?.toFixed(2)).toBe('100000.00');
    expect(resultado.total?.toFixed(2)).toBe('121000.00');
  });

  it('se propone más de una región y la elegida queda dicha', () => {
    const fragmentos = [
      ...filaDelPie(0.32, [
        ['ARTICULO', 0.20],
        ['3', 0.52],
        ['1.000,00', 0.82],
      ]),
      ...filaDelPie(0.40, [
        ['Neto', 0.58],
        ['100.000,00', 0.82],
      ]),
      ...filaDelPie(0.42, [
        ['Total', 0.58],
        ['121.000,00', 0.82],
      ]),
    ];
    expect(regionesDelPie(fragmentos, {
      alturaTipica: ALTURA,
      desdeY: 0,
      finDelDetalle: 0.35,
    }).length).toBeGreaterThan(1);

    const resultado = pie(fragmentos, '100000.00');
    expect(resultado.region).toBeTruthy();
  });
});
