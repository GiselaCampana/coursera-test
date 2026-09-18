import { describe, it, expect } from 'vitest';
import { conceptoSegunEtiqueta, reconciliarPie } from '@/lib/ocr/motor/pie-fiscal';
import { Decimal } from '@/lib/money';
import type { Fragmento } from '@/lib/ocr/reconstruccion/evidencia';
import { palabra } from '@/../tests/fixtures/evidencia-sintetica';

/**
 * **Un concepto fiscal impreso en cero es un dato, no una falta de lectura.**
 *
 * Para una celda del detalle el cero no es una lectura, y está bien que no lo
 * sea: sale de separadores sueltos sin dígitos alrededor, suma cero, no rompe
 * ninguna igualdad, y así dos artículos quedaban cargados en cero sin que nada
 * se quejara. Un renglón sin importe tiene que quedar sin importe y pedirlo.
 *
 * En el pie es al revés. «No Gravado: 0,00» dice que no hay nada sin gravar, y
 * «I.V.A. 10,50: 0,00» dice que a esa alícuota no hay nada gravado. Perder esas
 * dos líneas no es prudencia: es tirar lo que el papel afirma, y además esconde
 * que el comprobante tiene dos alícuotas.
 *
 * La regla, entonces, pide las dos cosas y nada más que las dos: **etiqueta
 * exacta y casilla propia**. Un cero no cierra ninguna cuenta —sumar cero no
 * prueba nada— así que es el único importe del pie que no puede apoyarse en una
 * igualdad. O lo sostiene su rótulo impreso, o no está.
 *
 * Todo lo de acá está armado a mano: no hay valores de ninguna factura.
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
    finDelDetalle: 0.3,
  });
}

/** Un pie corriente, al que se le agrega la línea que cada caso quiere probar. */
function conLaLinea(...extra: Fragmento[]) {
  return pie(
    [
      ...filaDelPie(0.4, [
        ['Neto', 0.58],
        ['Gravado', 0.63],
        ['100.000,00', 0.86],
      ]),
      ...filaDelPie(0.42, [
        ['IVA', 0.58],
        ['21%', 0.64],
        ['21.000,00', 0.86],
      ]),
      ...extra,
      ...filaDelPie(0.48, [
        ['Total', 0.58],
        ['121.000,00', 0.86],
      ]),
    ],
    '100000.00',
  );
}

// ---------------------------------------------------------------------------
// 1. Qué cero se conserva y cuál no
// ---------------------------------------------------------------------------

describe('un cero se conserva sólo con etiqueta y casilla inequívocas', () => {
  it('conserva el no gravado impreso en cero', () => {
    const resultado = conLaLinea(
      ...filaDelPie(0.44, [
        ['No', 0.52],
        ['Gravado', 0.56],
        ['0,00', 0.86],
      ]),
    );
    expect(resultado.noGravado?.toFixed(2)).toBe('0.00');

    const suyo = resultado.asignaciones.find((a) => a.concepto === 'noGravado');
    expect(suyo?.procedencia).toBe('READ_FROM_DOCUMENT');
    // Lo sostiene el rótulo, no una cuenta: un cero no comprueba nada.
    expect(suyo?.igualdad).toBeNull();
  });

  it('no conserva un cero sin etiqueta, ni lo convierte en una pregunta', () => {
    /*
     * Un cero suelto no es «un importe que no supimos nombrar»: no cierra
     * ninguna cuenta, así que ninguna relación podría nombrarlo después, y
     * preguntarlo sería pedirle a una persona que le ponga nombre a algo que el
     * papel no nombró.
     */
    const resultado = conLaLinea(...filaDelPie(0.44, [['0,00', 0.86]]));
    expect(resultado.noGravado).toBeNull();
    expect(resultado.asignaciones.some((a) => a.valor.isZero())).toBe(false);
    expect(resultado.sinAsignar.map((u) => u.texto)).not.toContain('0,00');
  });

  it('no conserva un cero cuya etiqueta apenas se parece a un concepto', () => {
    /*
     * «Grava» no es «no gravado» ni «gravado»: es lo que quedó de una palabra.
     * Con un importe real, un parecido puede competir contra otras evidencias;
     * con un cero no hay otra evidencia, así que el parecido no alcanza nunca.
     */
    const resultado = conLaLinea(
      ...filaDelPie(0.44, [
        ['Grava', 0.52],
        ['0,00', 0.86],
      ]),
    );
    expect(resultado.noGravado).toBeNull();
    expect(resultado.asignaciones.some((a) => a.valor.isZero())).toBe(false);
  });

  it('«,00» no es un cero impreso: es el resto de un número ilegible', () => {
    /*
     * Ésta es exactamente la diferencia que la regla tiene que ver. Un cero
     * escrito como se escribe la plata es una afirmación; los decimales sueltos
     * de un importe que el OCR no pudo leer son una pérdida, y convertirlos en
     * un cero sería inventar que el papel dice que no hay nada.
     */
    for (const roto of [',00', '.00', '00,', ',,00']) {
      const resultado = conLaLinea(
        ...filaDelPie(0.44, [
          ['No', 0.52],
          ['Gravado', 0.56],
          [roto, 0.86],
        ]),
      );
      expect(resultado.noGravado, roto).toBeNull();
    }
  });

  it('un «0» pelado tampoco: no está escrito como la plata de este pie', () => {
    /*
     * Un cero sin coma ni decimales es cualquier cosa —un número de página, un
     * resto de la grilla, el uno de una lista— en un recuadro donde todos los
     * importes llevan su separador y sus dos cifras. Con etiqueta y todo, lo
     * honesto es pedirlo, no afirmarlo.
     */
    const resultado = conLaLinea(
      ...filaDelPie(0.44, [
        ['No', 0.52],
        ['Gravado', 0.56],
        ['0', 0.86],
      ]),
    );
    expect(resultado.noGravado).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Varias alícuotas, una de ellas en cero
// ---------------------------------------------------------------------------

describe('un IVA impreso en cero conserva su alícuota', () => {
  /** El papel imprime la alícuota en su propia columna, sin el signo. */
  const dosAlicuotas = [
    ...filaDelPie(0.4, [
      ['Neto', 0.52],
      ['Gravado', 0.57],
      ['100.000,00', 0.86],
    ]),
    ...filaDelPie(0.42, [
      ['IVA', 0.58],
      ['21,00', 0.66],
      ['21.000,00', 0.86],
    ]),
    ...filaDelPie(0.44, [
      ['IVA', 0.58],
      ['10,50', 0.66],
      ['0,00', 0.86],
    ]),
    ...filaDelPie(0.48, [
      ['Total', 0.58],
      ['121.000,00', 0.86],
    ]),
  ];

  it('las dos alícuotas quedan separadas, con la del cero leída de su columna', () => {
    const resultado = pie(dosAlicuotas, '100000.00');
    const ivas = resultado.iva
      .map((i) => `${i.alicuota?.toString() ?? '—'}:${i.valor.toFixed(2)}`)
      .sort();
    expect(ivas).toEqual(['0.105:0.00', '0.21:21000.00']);
  });

  it('cada uno conserva su procedencia: uno leído, el otro también', () => {
    const resultado = pie(dosAlicuotas, '100000.00');
    const suyos = resultado.asignaciones.filter((a) => a.concepto === 'iva');
    expect(suyos).toHaveLength(2);
    for (const iva of suyos) expect(iva.procedencia).toBe('READ_FROM_DOCUMENT');

    // Y el que vale cero no finge una igualdad que no cumple.
    const enCero = suyos.find((a) => a.valor.isZero());
    expect(enCero?.igualdad).toBeNull();
  });

  it('el cero no cambia ninguna cuenta: el total cierra igual', () => {
    const resultado = pie(dosAlicuotas, '100000.00');
    expect(resultado.total?.toFixed(2)).toBe('121000.00');
    expect(resultado.totalCalculado).toBe(false);
    expect(resultado.estado).toBe('completo');
  });
});

// ---------------------------------------------------------------------------
// 3. Lo que un cero nunca puede hacer
// ---------------------------------------------------------------------------

describe('un cero no desplaza ni completa nada', () => {
  it('no pisa un concepto que otra evidencia ya asignó', () => {
    /*
     * Si el IVA del 21 % está leído en veintiún mil, un «0,00» que quedó suelto
     * en otra parte de la hoja con un rótulo parecido no lo contradice: manda el
     * que tiene con qué comprobarse.
     */
    const resultado = conLaLinea(
      ...filaDelPie(0.44, [
        ['IVA', 0.52],
        ['21%', 0.58],
        ['0,00', 0.86],
      ]),
    );
    const ivas = resultado.iva.map((i) => i.valor.toFixed(2));
    expect(ivas).toEqual(['21000.00']);
  });

  it('no se convierte en el total ni en el neto gravado', () => {
    /*
     * Son los dos números con los que el resto de la aplicación paga, controla y
     * costea. Ahí un cero es indistinguible de no haber podido leer, así que no
     * entra ni con su etiqueta: lo que corresponde es que falte y se pida.
     */
    const soloCeros = pie(
      [
        ...filaDelPie(0.4, [
          ['Neto', 0.52],
          ['Gravado', 0.57],
          ['0,00', 0.86],
        ]),
        ...filaDelPie(0.44, [
          ['Total', 0.52],
          ['0,00', 0.86],
        ]),
      ],
      null,
    );
    expect(soloCeros.netoGravado).toBeNull();
    expect(soloCeros.total).toBeNull();
    expect(soloCeros.estado).not.toBe('completo');
  });

  it('no aparece por ausencia: sin la línea impresa, el concepto sigue faltando', () => {
    const resultado = conLaLinea();
    expect(resultado.noGravado).toBeNull();
    expect(resultado.iva.map((i) => i.valor.toFixed(2))).toEqual(['21000.00']);
  });
});

// ---------------------------------------------------------------------------
// 4. La frase que el OCR pegó
// ---------------------------------------------------------------------------

describe('una frase sin su espacio sigue nombrando lo mismo', () => {
  it('«NoGravado» es «no gravado»', () => {
    /*
     * El reconocedor pierde el blanco entre dos palabras igual que pierde una
     * coma. No es una lectura degradada —no falta ninguna letra— así que el
     * parecido por letras comidas no la encuentra, y el concepto quedaba sin
     * nombrar teniendo la frase entera impresa.
     */
    expect(conceptoSegunEtiqueta('NoGravado:')?.concepto).toBe('noGravado');
    expect(conceptoSegunEtiqueta('NoGravado:')?.exacta).toBe(true);
    expect(conceptoSegunEtiqueta('BaseImponible')?.concepto).toBe('baseImponible');
  });

  it('pero «Gravado» sola sigue siendo el neto, no lo contrario', () => {
    // Pegar palabras no puede convertir un concepto en su opuesto.
    expect(conceptoSegunEtiqueta('Gravado')?.concepto).toBe('netoGravado');
  });

  it('y se pide la frase entera, no un pedazo pegado', () => {
    // «nogra» no es «nogravado»: se exige la coincidencia exacta de las letras.
    expect(conceptoSegunEtiqueta('NoGra')?.concepto).not.toBe('noGravado');
  });
});
