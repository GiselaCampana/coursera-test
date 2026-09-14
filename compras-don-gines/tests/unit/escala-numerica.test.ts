import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  formatoDeColumna,
  lecturasDeCelda,
  type FormatoDeColumna,
  type LecturaNumerica,
} from '@/lib/ocr/motor/formato-de-columna';
import {
  decidir,
  type CandidataDeTabla,
  type RenglonCandidato,
} from '@/lib/ocr/motor/candidatas';
import { evaluarCierre } from '@/lib/ocr/motor/precision';
import { interpretarReconstruccion } from '@/lib/ocr/motor/desde-reconstruccion';
import { soloBloqueantes } from '@/lib/ocr/motor/pendientes';
import {
  SALTO,
  TITULOS,
  Y_TITULOS,
  evidencia,
  fila,
} from '@/../tests/fixtures/evidencia-sintetica';
import type { Fragmento } from '@/lib/ocr/reconstruccion/evidencia';

/**
 * **Dónde va la coma.**
 *
 * Es la pregunta más cara del motor. Un separador decimal que se pierde
 * multiplica el costo de un artículo por cien, el renglón sigue cerrando
 * —cantidad × precio da el importe, cien veces más grande de los dos lados— y
 * la suma sigue dando el pie si el pie se leyó con el mismo error. Nada dentro
 * de la aritmética lo delata. Un precio de góndola calculado sobre eso es una
 * pérdida silenciosa.
 *
 * Lo que decide la escala es **lo que está impreso**: los separadores que la
 * celda muestra y los que muestran los otros valores de su columna. La
 * aritmética confirma una escala; no la crea. Y cuando el papel no alcanza para
 * decidir, el comprobante va a revisión con las dos hipótesis a la vista, que es
 * distinto de elegir la que cierre.
 *
 * Todos los casos de acá están escritos a mano. No hay nombres de proveedor, ni
 * valores de ninguna factura del lote, ni conteos de renglones de ningún papel:
 * cada prueba arma la columna mínima que provoca **un** problema.
 */

// ---------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------

/** El formato de una columna, fallando la prueba si no se pudo calcular. */
function formatoDe(celdas: string[]): FormatoDeColumna {
  const formato = formatoDeColumna(celdas);
  expect(formato, `la columna ${JSON.stringify(celdas)} no produjo formato`).not.toBeNull();
  return formato!;
}

/** La lectura preferida de una celda dentro del formato de su columna. */
function preferida(texto: string, formato: FormatoDeColumna | null): LecturaNumerica {
  const lecturas = lecturasDeCelda(texto, formato);
  expect(lecturas.length, `«${texto}» no produjo ninguna lectura`).toBeGreaterThan(0);
  return lecturas[0];
}

/** Todos los valores que una celda admite, como texto. */
function todosLosValores(texto: string, formato: FormatoDeColumna | null): string[] {
  return lecturasDeCelda(texto, formato).map((l) => l.valor.toString());
}

const CUIT_DEL_RECEPTOR = '27-33342291-9';

/**
 * Una tabla de tres artículos donde cantidad × precio da el importe.
 *
 * Los textos de los números se pasan por parámetro: es lo único que cambia entre
 * los casos que prueban qué escala elige el motor sobre un comprobante entero.
 */
function tablaConNumeros(
  filas: [cantidad: string, precio: string, importe: string][],
  extra: Fragmento[] = [],
): Fragmento[] {
  return [
    ...fila(Y_TITULOS, TITULOS),
    ...filas.flatMap(([cantidad, precio, importe], i) =>
      fila(Y_TITULOS + SALTO * (i + 1), [
        [`${70 + i}`, 0.05],
        [`ARTICULO${i}`, 0.20],
        [cantidad, 0.52],
        [precio, 0.65],
        [importe, 0.82],
      ]),
    ),
    ...extra,
  ];
}

/** Los importes que el motor terminó afirmando, en el orden de la tabla. */
function importesDe(fragmentos: Fragmento[]): string[] {
  const informe = interpretarReconstruccion(evidencia(fragmentos), {
    cuitDelReceptor: CUIT_DEL_RECEPTOR,
  });
  return (informe.veredicto.ganadora?.renglones ?? []).map((r) => r.importe?.toString() ?? '—');
}

// ---------------------------------------------------------------------------
// 1. La lectura literal es siempre candidata, y gana cuando está impresa
// ---------------------------------------------------------------------------

describe('un número bien escrito se lee como está escrito', () => {
  it('un valor con separadores de miles y de decimales no cambia de escala', () => {
    /*
     * El caso que da nombre a toda la corrección. «1.862,49» tiene el punto de
     * miles y la coma decimal impresos, uno de cada, en el orden en que se
     * escriben: no hay nada que interpretar. Leerlo 186.249 es suponer que el
     * OCR inventó una coma, y nadie pidió esa suposición.
     */
    const formato = formatoDe(['1.862,49', '1.492,03', '2.310,00']);
    expect(preferida('1.862,49', formato).valor.toString()).toBe('1862.49');
    expect(preferida('1.862,49', formato).literal).toBe(true);
    expect(preferida('1.862,49', formato).reparaciones).toBe(0);
  });

  it('la lectura literal queda como candidata aunque la columna prefiera otra', () => {
    /*
     * Conservar siempre la lectura literal es lo que permite auditar la
     * decisión: si la escala de la columna resulta equivocada, el valor impreso
     * sigue estando entre las lecturas y se puede volver a él. Lo que cambia es
     * el orden, no la lista.
     */
    const formato = formatoDe(['1.862,49', '1.492,03', '186249']);
    const valores = todosLosValores('186249', formato);
    expect(valores).toContain('186249');
    expect(valores).toContain('1862.49');
    expect(valores[0]).toBe('1862.49');
  });

  it('el texto original queda como procedencia de cada lectura', () => {
    const formato = formatoDe(['1.862,49', '1.492,03', '186249']);
    for (const lectura of lecturasDeCelda('186249', formato)) {
      expect(lectura.textoOriginal).toBe('186249');
    }
  });
});

// ---------------------------------------------------------------------------
// 2. La escala es de la columna, no de la celda
// ---------------------------------------------------------------------------

describe('la hipótesis de formato pertenece a la columna entera', () => {
  it('una minoría de valores bien puntuados fija la escala de toda la columna', () => {
    /*
     * Tres enteros pelados y **un** valor con sus separadores impresos. El
     * entero pelado no ancla nada —«186249» es compatible con las dos escalas—
     * así que no vota, y el único bien escrito decide. Una mayoría mutilada no
     * le gana a una minoría legible.
     */
    const formato = formatoDe(['186249', '186249', '1.862,49', '186249']);
    expect(formato.escala.separador).toBe('coma');
    expect(formato.escala.decimales).toBe(2);
    expect(formato.escala.anclas).toEqual(['1.862,49']);
    expect(preferida('186249', formato).valor.toString()).toBe('1862.49');
  });

  it('la escala no se elige celda por celda según cuál cierre', () => {
    /*
     * Las dos celdas mutiladas de esta columna se leen **igual**, aunque una de
     * ellas cerrara mejor con la otra escala. Si la escala se eligiera por celda
     * no habría escala: habría una excusa distinta para cada número.
     */
    const formato = formatoDe(['1.862,49', '186249', '231000']);
    expect(preferida('186249', formato).valor.toString()).toBe('1862.49');
    expect(preferida('231000', formato).valor.toString()).toBe('2310');
  });

  it('una columna de importes altos no se divide por cien', () => {
    /*
     * Lo simétrico del error famoso, y hay que probarlo aparte: una factura
     * grande es una factura grande. Con los separadores impresos en su lugar,
     * nada autoriza a correr la coma para achicarla.
     */
    const formato = formatoDe(['1.250.000,00', '980.400,50', '2.310.117,25']);
    expect(preferida('1.250.000,00', formato).valor.toString()).toBe('1250000');
    expect(preferida('980.400,50', formato).valor.toString()).toBe('980400.5');
    expect(preferida('980.400,50', formato).literal).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Cada reparación se cuenta y se explica
// ---------------------------------------------------------------------------

describe('mover un separador es una reparación explícita', () => {
  it('leer un entero pelado dentro de la escala de su columna cuesta una reparación', () => {
    const formato = formatoDe(['1.862,49', '1.492,03', '186249']);
    const lectura = preferida('186249', formato);
    expect(lectura.reparaciones).toBe(1);
    expect(lectura.literal).toBe(false);
    // Y dice qué se supuso: una reparación sin explicación no se puede auditar.
    expect(lectura.comoSeLeyo).toBeTruthy();
  });

  it('a igual coherencia gana la escala que conserva más separadores', () => {
    /*
     * Las dos hipótesis explican la columna. La que conserva impresos los
     * separadores que la columna muestra necesita reparar menos, y ésa gana. No
     * es una preferencia estética: cada reparación es una suposición sobre algo
     * que el papel no dice.
     */
    const formato = formatoDe(['1.862,49', '1.492,03', '2.310,00', '186249']);
    expect(formato.escala.separadoresConservados).toBeGreaterThan(
      formato.segunda?.separadoresConservados ?? 0,
    );
    expect(formato.escala.reparaciones).toBeLessThan(formato.segunda?.reparaciones ?? Infinity);
  });

  it('un importe entero no recibe decimales inventados', () => {
    /*
     * Una columna que imprime enteros se lee entera. Agregarle dos decimales
     * «porque los montos los llevan» es inventar centavos, y cien de esos
     * cambian el costo de la compra.
     */
    const formato = formatoDe(['1500', '2300', '3500', '4200']);
    expect(formato.escala.separador).toBe('ninguno');
    expect(todosLosValores('1500', formato)).toContain('1500');
  });
});

// ---------------------------------------------------------------------------
// 4. Sin anclas, no se elige: se informa
// ---------------------------------------------------------------------------

describe('una columna sin anclas con dos escalas posibles va a revisión', () => {
  it('«1500» conserva las dos lecturas y la columna queda indecidible', () => {
    /*
     * Sin un solo separador impreso en toda la columna, mil quinientos y quince
     * son las dos igual de posibles, y la aritmética no las separa: multiplican
     * proporcional. Las dos lecturas se conservan y la columna se marca.
     */
    const formato = formatoDe(['1500', '2300', '3500']);
    expect(formato.escala.anclas).toEqual([]);
    expect(formato.indecidible).toBe(true);
    expect(formato.segunda).not.toBeNull();

    const valores = todosLosValores('1500', formato);
    expect(valores).toContain('1500');
    expect(valores).toContain('15');
  });

  it('ninguna lectura queda marcada como ajena cuando no hay nada que contradecir', () => {
    /*
     * «Ajena a la escala» quiere decir que contradice lo que la columna muestra
     * impreso. Sin anclas no hay nada impreso que contradecir, y marcar una
     * lectura igual sería inventar la evidencia que falta.
     */
    const formato = formatoDe(['1500', '2300', '3500']);
    for (const lectura of lecturasDeCelda('1500', formato)) {
      expect(lectura.ajenaALaEscala).toBe(false);
    }
  });

  it('una escala indecidible impide aceptar el comprobante solo', () => {
    /*
     * Es una compuerta, no una penalización: no importa cuánto cierre lo demás.
     * `decidir` recibe los frenos aparte del puntaje justamente para que no se
     * puedan compensar.
     */
    const conFreno = decidir(
      [candidataQueCierra()],
      [],
      ['La columna «importe» admite dos escalas.'],
    );
    expect(conFreno.decision).toBe('revision-de-estructura');
    expect(conFreno.motivo).toContain('dos escalas');

    // Y sin el freno, la misma lectura se acepta: el freno es lo único que cambia.
    expect(decidir([candidataQueCierra()], [], []).decision).toBe('automatica');
  });
});

// ---------------------------------------------------------------------------
// 5. La aritmética y el pie confirman; no crean
// ---------------------------------------------------------------------------

describe('el cierre confirma una escala, nunca la inventa', () => {
  it('el precio y el importe cien veces más grandes pierden contra la evidencia literal', () => {
    /*
     * Los tres renglones cierran en las dos escalas: la proporción se mantiene.
     * Lo que las separa es que una necesita suponer que el OCR perdió el
     * separador de cada número y la otra no necesita suponer nada.
     */
    expect(
      importesDe(
        tablaConNumeros([
          ['4', '5.700,00', '22.800,00'],
          ['2', '9.600,00', '19.200,00'],
          ['3', '9.800,00', '29.400,00'],
        ]),
      ),
    ).toEqual(['22800', '19200', '29400']);
  });

  it('un pie leído sin su separador no arrastra los renglones a su escala', () => {
    /*
     * **El agujero por el que se colaba el error de escala entero**, y no estaba
     * en la lectura de la celda sino en la búsqueda contra el total. Acá el neto
     * del pie está impreso cien veces más grande que la suma verdadera. Para
     * cada renglón existe una lectura cien veces mayor que acerca la suma a ese
     * neto —la columna la ofrece, marcada como ajena— y tomarlas todas hace
     * cerrar el comprobante perfecto con **todos** los costos cien veces mal.
     *
     * La búsqueda no puede empeorar la posición de un renglón frente a la escala
     * de su columna. Si el pie está mal leído, el comprobante no cierra y va a
     * revisión, que es lo que corresponde.
     */
    const pieInflado = fila(Y_TITULOS + SALTO * 5, [
      ['NETO GRAVADO', 0.50],
      ['7140000', 0.82],
    ]);
    expect(
      importesDe(
        tablaConNumeros(
          [
            ['4', '5.700,00', '22.800,00'],
            ['2', '9.600,00', '19.200,00'],
            ['3', '9.800,00', '29.400,00'],
          ],
          pieInflado,
        ),
      ),
    ).toEqual(['22800', '19200', '29400']);
  });

  it('un porcentaje imposible descarta la lectura, no el renglón', () => {
    /*
     * La única restricción semántica que se aplica es universal: un porcentaje
     * está entre cero y cien en cualquier factura del mundo. Lo que se descarta
     * es **la lectura**, no la fila: el artículo sigue existiendo y se interpreta
     * sin descuento, con la celda pedida.
     */
    const formato = formatoDe(['629', '16,00', '16,00']);
    const posibles = lecturasDeCelda('629', formato).map((l) => l.valor);
    expect(posibles.some((v) => v.lte(100))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Las dos convenciones del mundo siguen compitiendo
// ---------------------------------------------------------------------------

describe('la convención decimal sale del documento, no de una preferencia', () => {
  it('una columna escrita a la argentina se lee a la argentina', () => {
    const formato = formatoDe(['1.862,49', '27.937,35', '22.380,45']);
    expect(formato.escala.separador).toBe('coma');
    expect(preferida('27.937,35', formato).valor.toString()).toBe('27937.35');
  });

  it('una columna escrita a la norteamericana se lee a la norteamericana', () => {
    /*
     * Los mismos dígitos, los separadores al revés. Imponer la coma decimal
     * globalmente «porque las facturas son argentinas» rompería todo comprobante
     * que imprima a la otra convención, y los hay.
     */
    const formato = formatoDe(['234,997.69', '238,234.75', '10,361.45']);
    expect(formato.escala.separador).toBe('punto');
    expect(preferida('234,997.69', formato).valor.toString()).toBe('234997.69');
  });

  it('un punto con dos decimales en una columna de cantidades es una cantidad', () => {
    /*
     * «30.00» en la columna de cantidades es treinta, no treinta mil: el punto
     * es decimal porque los dos dígitos que le siguen son decimales, y eso lo
     * dice la columna entera, no el nombre del encabezado.
     */
    const formato = formatoDe(['27.00', '30.00', '9.00']);
    expect(preferida('30.00', formato).valor.toString()).toBe('30');
    expect(preferida('27.00', formato).valor.toString()).toBe('27');
  });

  it('una columna con tres decimales impresos conserva los tres', () => {
    /*
     * La precisión la imprime el papel. Redondear a dos «porque la plata tiene
     * dos» pierde un dígito que el proveedor escribió, y en una columna de
     * precios por kilo ese dígito es plata.
     */
    const formato = formatoDe(['4.874,380', '1.036,145', '6.723,279']);
    expect(formato.escala.decimales).toBe(3);
    expect(preferida('4.874,380', formato).valor.toString()).toBe('4874.38');
    expect(preferida('1.036,145', formato).valor.toString()).toBe('1036.145');
  });
});

// ---------------------------------------------------------------------------
// 7. Lo que no es un número no se normaliza
// ---------------------------------------------------------------------------

describe('los códigos y los PLU quedan fuera de la normalización numérica', () => {
  it('un código con ceros a la izquierda conserva sus ceros', () => {
    /*
     * «0031» es un código de artículo, no el número treinta y uno. Pasarlo por
     * la escala de una columna numérica lo convertiría en «31» y el artículo
     * dejaría de encontrarse en el catálogo. La columna de códigos no es
     * numérica y no se toca.
     */
    const informe = interpretarReconstruccion(
      evidencia([
        ...fila(Y_TITULOS, TITULOS),
        ...fila(Y_TITULOS + SALTO, [
          ['0031', 0.05],
          ['ARTICULO', 0.20],
          ['4', 0.52],
          ['5.700,00', 0.65],
          ['22.800,00', 0.82],
        ]),
      ]),
      { cuitDelReceptor: CUIT_DEL_RECEPTOR },
    );
    expect(informe.veredicto.ganadora?.renglones[0]?.codigo).toBe('0031');
  });

  it('una unidad pegada al número no se convierte en un dígito', () => {
    /*
     * La reparación de dígitos confunde letras con números a propósito —«g» con
     * «9», «O» con «0»— porque el OCR las confunde. Si corriera sobre la unidad
     * impresa al lado, «18.38 kg» terminaría siendo 18.389.
     */
    const formato = formatoDe(['18.38 kg', '9.50 kg', '22.10 kg']);
    expect(preferida('18.38 kg', formato).valor.toString()).toBe('18.38');
  });
});

// ---------------------------------------------------------------------------
// 8. La compuerta de los renglones sin probar
// ---------------------------------------------------------------------------

describe('un renglón cuya identidad no está probada frena la aceptación automática', () => {
  it('el freno no se compensa con que el comprobante cierre', () => {
    /*
     * Es la deuda que quedó declarada de la corrección anterior: hay líneas que
     * se conservan porque sus vecinos las sostienen, pero de las que no se leyó
     * nada que las identifique. Borrarlas borra artículos verdaderos; darlas por
     * buenas mete en el historial de precios un artículo que nadie compró.
     *
     * Mientras exista una, el comprobante no se acepta solo **aunque los números
     * y el pie cierren**. Y no puede ser una penalización de puntaje: un pie que
     * cuadra devuelve los décimos que la fila restó y el comprobante termina
     * aceptado igual. Por eso es una compuerta.
     */
    const cierraPerfecto = candidataQueCierra();
    expect(decidir([cierraPerfecto], [], []).decision).toBe('automatica');
    expect(
      decidir([cierraPerfecto], [], ['Confirmar si el renglón 4 es un artículo impreso.'])
        .decision,
    ).toBe('revision-de-estructura');
  });

  it('el renglón sin probar queda visible como bloqueo, no descartado', () => {
    /*
     * Frenar sin decir qué frena es lo mismo que no leer la factura. El bloqueo
     * nombra el renglón y dice con qué se lo conservó, para que una persona
     * pueda mirar ese lugar de la foto y contestar en diez segundos.
     */
    const grillaQueSigue = [4, 5].flatMap((n) =>
      fila(Y_TITULOS + SALTO * n, [
        ['|', 0.05],
        ['l', 0.20],
        ['1', 0.52],
        ['0,00', 0.65],
        ['|', 0.82],
      ]),
    );
    const informe = interpretarReconstruccion(
      evidencia(
        tablaConNumeros(
          [
            ['4', '5.700,00', '22.800,00'],
            ['2', '9.600,00', '19.200,00'],
            ['3', '9.800,00', '29.400,00'],
          ],
          grillaQueSigue,
        ),
      ),
      { cuitDelReceptor: CUIT_DEL_RECEPTOR },
    );

    // Las dos líneas de grilla se conservan como hipótesis: tienen vecinos y un
    // número, pero nada que las nombre. Ni se tiran ni se dan por buenas.
    const sinProbar = soloBloqueantes(informe.pendientes).filter(
      (p) => p.categoria === 'BLOCKING_UNPROVEN_ROW',
    );
    expect(sinProbar.length).toBeGreaterThan(0);
    expect(sinProbar[0].motivo).toContain('artículo impreso');
    expect(sinProbar[0].renglon).not.toBeNull();

    // Y los tres artículos verdaderos siguen enteros: la compuerta frena, no borra.
    expect(informe.veredicto.decision).not.toBe('automatica');
    expect(informe.tabla.renglones.filter((r) => r.clase === 'aceptado')).toHaveLength(3);
  });
});

/**
 * Una lectura de un comprobante que cierra sin ninguna duda.
 *
 * Se arma a mano y no sale de ninguna foto: lo que se prueba con ella es que la
 * compuerta frena **eso**, lo mejor que el motor puede producir. Si frenara sólo
 * lecturas dudosas no probaría nada.
 */
function candidataQueCierra(): CandidataDeTabla {
  const renglon: RenglonCandidato = {
    codigo: '47',
    descripcion: 'ARTICULO',
    marca: null,
    cantidad: new Decimal(4),
    kilos: null,
    piezas: null,
    precioUnitario: new Decimal('5700'),
    descuentoPct: null,
    precioConDescuento: null,
    importe: new Decimal('22800'),
    descuentoEnElImporte: null,
    reparaciones: 0,
    severidad: 0,
    incoherentes: 0,
    escalasAjenas: 0,
    controles: [{ nombre: 'cantidad-por-precio', paso: true, detalle: '4 × 5700 = 22800' }],
  };
  return {
    convencion: 'ar',
    pie: {
      netTotal: new Decimal('22800'),
      ivaTotal: null,
      percepciones: null,
      total: null,
      ignorados: [],
    },
    renglones: [renglon],
    puntaje: 1,
    penalizaciones: [],
    sumaDeRenglones: new Decimal('22800'),
    cierre: evaluarCierre([new Decimal('22800')], new Decimal('22800')),
    reparaciones: 0,
  };
}
