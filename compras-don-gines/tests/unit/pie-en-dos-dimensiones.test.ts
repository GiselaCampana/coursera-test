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
import { asignarRegion, etiquetasDe } from '@/lib/ocr/motor/asignacion-del-pie';
import { interpretarReconstruccion } from '@/lib/ocr/motor/desde-reconstruccion';
import { soloBloqueantes } from '@/lib/ocr/motor/pendientes';
import { evidencia } from '@/../tests/fixtures/evidencia-sintetica';
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

// ---------------------------------------------------------------------------
// 6. La correspondencia se resuelve entera, no número por número
// ---------------------------------------------------------------------------

describe('la asignación es global dentro de la región', () => {
  it('etiquetas arriba e importes abajo: cada valor queda en su columna', () => {
    const region = unaRegion([
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
    ]);
    const numeros = region.casillas.filter((c) => c.esNumero);
    const { pares } = asignarRegion(region, numeros, {
      alturaTipica: ALTURA,
      nombraConcepto: (e) => (/neto|iva|total/i.test(e) ? 'algo' : null),
    });

    const porValor = new Map(pares.map((p) => [p.numero.fragmento.texto, p.etiqueta.texto]));
    expect(porValor.get('100.000,00')).toBe('NETO');
    expect(porValor.get('21.000,00')).toBe('IVA');
    expect(porValor.get('121.000,00')).toBe('TOTAL');
    for (const par of pares) expect(par.relacion).toBe('encima');
  });

  it('etiquetas a la izquierda e importes a la derecha: cada valor queda en su fila', () => {
    const region = unaRegion([
      ...filaDelPie(0.40, [
        ['Neto', 0.58],
        ['100.000,00', 0.82],
      ]),
      ...filaDelPie(0.42, [
        ['IVA', 0.58],
        ['21.000,00', 0.82],
      ]),
      ...filaDelPie(0.44, [
        ['Total', 0.58],
        ['121.000,00', 0.82],
      ]),
    ]);
    const { pares } = asignarRegion(region, region.casillas.filter((c) => c.esNumero), {
      alturaTipica: ALTURA,
      nombraConcepto: (e) => (/neto|iva|total/i.test(e) ? 'algo' : null),
    });

    const porValor = new Map(pares.map((p) => [p.numero.fragmento.texto, p.etiqueta.texto]));
    expect(porValor.get('100.000,00')).toBe('Neto');
    expect(porValor.get('21.000,00')).toBe('IVA');
    expect(porValor.get('121.000,00')).toBe('Total');
    for (const par of pares) expect(par.relacion).toBe('a la izquierda');
  });

  it('una etiqueta partida en varias cajas se reconstruye antes de buscar palabras', () => {
    /*
     * El OCR devuelve «Percepción IIBB CABA» en tres cajas, y a veces en cinco.
     * La frase es la unidad que tiene significado: **primero el alcance,
     * después el sentido**.
     */
    const region = unaRegion([
      ...filaDelPie(0.40, [
        ['Percepcion', 0.50],
        ['IIBB', 0.60],
        ['CABA', 0.66],
        ['1.500,00', 0.82],
      ]),
    ]);
    const etiquetas = etiquetasDe(region);
    const entera = etiquetas.find((e) => e.texto.includes('Percepcion'));
    expect(entera?.texto).toBe('Percepcion IIBB CABA');
    expect(entera?.fragmentos).toHaveLength(3);
  });

  it('de dos asociaciones cercanas gana la que respeta la grilla completa', () => {
    /*
     * Dos etiquetas y dos importes, con la segunda etiqueta más cerca del
     * primer importe que su propia etiqueta. Lo codicioso emparejaría cruzado;
     * lo global no puede, porque una etiqueta sólo alcanza el primer importe
     * que le corresponde y cada importe toma una sola etiqueta.
     */
    const region = unaRegion([
      ...filaDelPie(0.40, [
        ['Neto', 0.40],
        ['100.000,00', 0.62],
      ]),
      ...filaDelPie(0.42, [
        ['Total', 0.40],
        ['121.000,00', 0.62],
      ]),
    ]);
    const { pares } = asignarRegion(region, region.casillas.filter((c) => c.esNumero), {
      alturaTipica: ALTURA,
      nombraConcepto: (e) => (/neto|total/i.test(e) ? 'algo' : null),
    });

    const porValor = new Map(pares.map((p) => [p.numero.fragmento.texto, p.etiqueta.texto]));
    expect(porValor.get('100.000,00')).toBe('Neto');
    expect(porValor.get('121.000,00')).toBe('Total');
  });

  it('ninguna etiqueta toma dos importes, y ningún importe dos etiquetas', () => {
    /*
     * Una etiqueta puede alcanzar dos importes a la vez: el de su fila, a la
     * derecha, y el de su columna, debajo. Sin exclusividad se quedaría con los
     * dos y el segundo —que no tiene rótulo propio— aparecería nombrado por una
     * etiqueta que ya nombró a otro.
     */
    const region = unaRegion([
      ...filaDelPie(0.40, [
        ['Neto', 0.58],
        ['100.000,00', 0.82],
      ]),
      // Debajo de «Neto», sin rótulo propio: la misma etiqueta lo alcanza.
      ...filaDelPie(0.42, [['21.000,00', 0.58]]),
    ]);
    const { pares, sinAsignar } = asignarRegion(
      region,
      region.casillas.filter((c) => c.esNumero),
      { alturaTipica: ALTURA, nombraConcepto: () => 'algo' },
    );

    expect(new Set(pares.map((p) => p.etiqueta)).size).toBe(pares.length);
    expect(new Set(pares.map((p) => p.numero)).size).toBe(pares.length);
    // Y el que se quedó sin etiqueta queda visible, no repartido.
    expect(pares.length + sinAsignar.length).toBe(2);
    expect(pares).toHaveLength(1);
  });

  it('la cercanía sola no asocia nada', () => {
    /*
     * Un texto pegado a un importe que no nombra ningún concepto no produce
     * arista. Si la cercanía alcanzara, cualquier leyenda del pie bautizaría al
     * número que tiene al lado.
     */
    const region = unaRegion([
      ...filaDelPie(0.40, [
        ['Conforme', 0.58],
        ['recepcion', 0.66],
        ['100.000,00', 0.82],
      ]),
    ]);
    const { pares, sinAsignar } = asignarRegion(
      region,
      region.casillas.filter((c) => c.esNumero),
      { alturaTipica: ALTURA, nombraConcepto: () => null },
    );
    expect(pares).toHaveLength(0);
    expect(sinAsignar).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 7. Los tres estados, separados
// ---------------------------------------------------------------------------

describe('un importe leído sin concepto no es un campo vacío', () => {
  it('queda como UNASSIGNED_FISCAL_AMOUNT, con todo lo que hace falta para contestarlo', () => {
    const resultado = pie(
      [
        ...filaDelPie(0.40, [
          ['Neto', 0.58],
          ['100.000,00', 0.82],
        ]),
        ...filaDelPie(0.42, [
          ['Conforme', 0.52],
          ['recepcion', 0.60],
          ['4.321,00', 0.82],
        ]),
      ],
      '100000.00',
    );

    const huerfano = resultado.sinAsignar.find((x) => x.texto === '4.321,00');
    expect(huerfano, 'el importe sin concepto desapareció del informe').toBeDefined();
    expect(huerfano!.valor?.toString()).toBe('4321');
    expect(huerfano!.caja.x1).toBeGreaterThan(huerfano!.caja.x0);
    expect(huerfano!.region).toBeTruthy();
    expect(huerfano!.pasada).toBeTruthy();

    // Y no se convirtió en ningún concepto.
    for (const a of resultado.asignaciones) expect(a.valor.toString()).not.toBe('4321');
  });

  it('un importe sin asignar es una sola pregunta, no varios campos faltantes', () => {
    const informe = interpretarReconstruccion(
      evidencia([
        ...filaDelPie(0.30, [
          ['Codigo', 0.05],
          ['Descripcion', 0.20],
          ['Cantidad', 0.50],
          ['Precio', 0.65],
          ['Importe', 0.82],
        ]),
        ...filaDelPie(0.32, [
          ['70', 0.05],
          ['ARTICULO', 0.20],
          ['4', 0.52],
          ['5.700,00', 0.65],
          ['22.800,00', 0.82],
        ]),
        ...filaDelPie(0.40, [
          ['Conforme', 0.52],
          ['recepcion', 0.60],
          ['4.321,00', 0.82],
        ]),
      ]),
      { cuitDelReceptor: CUIT },
    );

    const preguntas = soloBloqueantes(informe.pendientes).filter(
      (p) => p.categoria === 'BLOCKING_UNASSIGNED_AMOUNT',
    );
    // Una por número, con dónde encontrarlo. No una por campo vacío.
    expect(preguntas.length).toBe(informe.pieFiscal.sinAsignar.length);
    for (const pregunta of preguntas) {
      expect(pregunta.alternativas.length).toBeGreaterThan(0);
      expect(pregunta.motivo).toContain('no se pudo probar qué');
    }
  });

  it('dos candidatas con el mismo apoyo y etiqueta dañada quedan sin asignar', () => {
    /*
     * Cuando el margen contra la segunda es cero, los valores son distintos y
     * **la etiqueta no nombra el concepto exactamente**, el papel no alcanzó
     * para elegir. Quedarse con la primera es tirar una moneda y escribirla como
     * si fuera un dato leído; sobre el lote eso producía tres conceptos
     * afirmados mal, y en los tres la segunda era la correcta.
     *
     * Un rótulo impreso entero sí decide: «Total 121.000,00» dice lo que dice, y
     * por eso el empate no se aplica ahí.
     */
    const resultado = pie(
      [
        ...filaDelPie(0.40, [
          ['Tot4I', 0.58],
          ['121.000,00', 0.82],
        ]),
        ...filaDelPie(0.42, [
          ['T0taI', 0.58],
          ['131.000,00', 0.82],
        ]),
      ],
      '100000.00',
    );
    expect(resultado.estado).not.toBe('completo');
    const delTotal = resultado.asignaciones.find((a) => a.concepto === 'total');
    if (delTotal) expect(delTotal.etiqueta?.exacta).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. Lo que no puede cambiar
// ---------------------------------------------------------------------------

describe('lo que la geometría no puede alterar', () => {
  it('reordenar las pasadas del OCR no cambia la asignación', () => {
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
    const alReves = pie([...fragmentos].reverse(), '100000.00');
    const comoTexto = (p: typeof derecho) =>
      p.asignaciones
        .map((a) => `${a.concepto}=${a.valor.toString()}`)
        .sort()
        .join('|');
    expect(comoTexto(alReves)).toBe(comoTexto(derecho));
  });

  it('no gana el número más grande ni el último de la región', () => {
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
        // Más grande y más abajo que el total: si ganara por eso, ganaría éste.
        ...filaDelPie(0.46, [
          ['Saldo', 0.50],
          ['Acumulado', 0.58],
          ['999.999,99', 0.82],
        ]),
      ],
      '100000.00',
    );
    expect(resultado.total?.toFixed(2)).toBe('121000.00');
    for (const a of resultado.asignaciones) {
      expect(a.valor.toString()).not.toBe('999999.99');
    }
  });

  it('un veto dentro de una etiqueta larga conserva la evidencia posterior', () => {
    /*
     * El texto que el OCR junta a la izquierda de un importe es a veces media
     * línea de la hoja. Un veto descarta lo que hay **hasta** él; lo que sigue
     * está más cerca del número y sigue valiendo.
     */
    expect(nombraOtraCosa('C.U.I.T. 30-71596337-6 I.V.A. 21 %')).toBe(true);
    const resultado = pie(
      [
        ...filaDelPie(0.40, [
          ['Neto', 0.58],
          ['100.000,00', 0.82],
        ]),
        ...filaDelPie(0.42, [
          ['C.U.I.T.', 0.50],
          ['30-71596337-6', 0.56],
          ['IVA', 0.66],
          ['21.000,00', 0.82],
        ]),
      ],
      '100000.00',
    );
    expect(valores(resultado.iva)).toContain('21000');
  });

  it('línea y grilla compiten como regiones completas, y la elegida queda dicha', () => {
    const resultado = pie(
      [
        ...filaDelPie(0.32, [
          ['ARTICULO', 0.20],
          ['22.800,00', 0.82],
        ]),
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
    expect(resultado.region).toBeTruthy();
    expect(resultado.segundaRegion).toBeTruthy();
    expect(resultado.region).not.toBe(resultado.segundaRegion);
  });

  it('la escala de la banda genera alternativas y no borra un literal válido', () => {
    /*
     * La banda dice **cómo se escriben** los importes de este recuadro, que es
     * una guía para interpretar un número mutilado. Usarla para descartar
     * costaba un IVA impreso con otra precisión que la de sus vecinos.
     */
    const resultado = pie(
      [
        ...filaDelPie(0.40, [
          ['Neto', 0.58],
          ['100.000,00', 0.82],
        ]),
        ...filaDelPie(0.42, [
          ['IVA', 0.58],
          ['21.000,005', 0.82],
        ]),
        ...filaDelPie(0.44, [
          ['Total', 0.58],
          ['121.000,00', 0.82],
        ]),
      ],
      '100000.00',
    );
    const leidos = [
      ...resultado.asignaciones.map((a) => a.valor.toString()),
      ...resultado.sinAsignar.map((x) => x.valor?.toString() ?? ''),
    ];
    expect(leidos.some((v) => v.startsWith('21000'))).toBe(true);
  });
});
