import { describe, expect, it } from 'vitest';
import { mejorLectura, type Lectura, type Observacion } from '@/lib/ocr/reconstruccion/agrupar';
import { reconciliarPie } from '@/lib/ocr/motor/pie-fiscal';
import { palabra } from '@/../tests/fixtures/evidencia-sintetica';
import { Decimal } from '@/lib/money';
import type { Caja, Fragmento } from '@/lib/ocr/reconstruccion/evidencia';

/**
 * **A un número al que le falta un pedazo no se le inventa el pedazo, y tampoco
 * se lo deja ganar por haber aparecido dos veces.**
 *
 * Son las dos mitades del mismo problema, medidas sobre fotos distintas.
 *
 * La primera está en la celda. Cinco pasadas leen el mismo importe y dos de
 * ellas se comen los centavos: devuelven «3.362,». Sumar sus confianzas como si
 * fuera una lectura más hace que la mutilación se apoye a sí misma, y el número
 * entero —leído por otras dos pasadas— queda de alternativa. Después una
 * tolerancia aritmética de un centavo lo da por bueno igual, y así una lectura
 * mala se convierte en un valor confirmado. Una lectura truncada no dice otra
 * cosa que la entera: dice lo mismo, peor.
 *
 * La segunda está en el pie. Cuando **ninguna** pasada leyó el número completo,
 * no hay nada que elegir: el dígito que falta no está en la evidencia y ninguna
 * igualdad puede fabricarlo. Una igualdad confirma una lectura presente; no
 * completa la que no está. Ahí lo correcto es preguntar, y seguir preguntando
 * mientras dos lecturas sigan siendo posibles.
 *
 * Los casos están armados a mano: no hay valores de ninguna factura.
 */

const ALTO = 0.008;

function caja(x0: number, x1: number, y0 = 0.3): Caja {
  return { x0, x1, y0, y1: y0 + ALTO };
}

function lectura(texto: string, pasada: string, confianza: number, donde: Caja): Lectura {
  return { texto, pasada, confianza, caja: donde, cajaEnLaFoto: donde, alternativas: [] };
}

/** Una celda del papel leída por varias pasadas, cada una a su manera. */
function celda(dicen: [texto: string, pasada: string, confianza: number][]): Observacion {
  const donde = caja(0.8, 0.9);
  return { caja: donde, lecturas: dicen.map(([t, p, c]) => lectura(t, p, c, donde)) };
}

// ---------------------------------------------------------------------------
// 1. En la celda: una lectura truncada no compite
// ---------------------------------------------------------------------------

describe('una lectura truncada no le gana a la entera', () => {
  it('«3.362,» no le gana a «3.362,66» por haber salido dos veces', () => {
    /*
     * El caso medido, con sus confianzas: dos pasadas truncan y dos leen entero.
     * Por suma de confianzas ganaba el truncado —1,89 contra 1,86— y el importe
     * verdadero quedaba de alternativa.
     */
    const suya = celda([
      ['3.362,', 'encabezado:directo', 0.95],
      ['3.362,', 'encabezado:limpieza-fuerte', 0.94],
      ['3.362,66', 'completo:directo', 0.94],
      ['3.362,66', 'articulos:limpieza-fuerte', 0.92],
      ['3.362,65', 'articulos:directo', 0.85],
    ]);
    expect(mejorLectura(suya).texto).toBe('3.362,66');
  });

  it('y entre dos enteras sigue decidiendo el acuerdo entre pasadas', () => {
    // Sin truncadas de por medio, la regla de siempre: 0,92 + 0,90 le gana a 0,95.
    const suya = celda([
      ['3.362,66', 'completo:directo', 0.92],
      ['3.362,66', 'articulos:limpieza-fuerte', 0.9],
      ['3.362,65', 'articulos:directo', 0.95],
    ]);
    expect(mejorLectura(suya).texto).toBe('3.362,66');
  });

  it('entre dos lecturas a medias gana la más completa, no la más repetida', () => {
    /*
     * Cuando ninguna pasada alcanzó el número entero, la celda se queda con la
     * lectura que llegó más lejos, aunque una más corta la supere en apoyo: dos
     * pasadas que cortaron antes no son evidencia de que el número termine ahí.
     * Lo que falte lo resuelve quien mire el número y vea que está incompleto.
     */
    const suya = celda([
      ['3.36', 'encabezado:directo', 0.95],
      ['3.36', 'encabezado:limpieza-fuerte', 0.95],
      ['3.362,', 'completo:directo', 0.5],
    ]);
    expect(mejorLectura(suya).texto).toBe('3.362,');
  });

  it('en una descripción, la corta **no** está truncada: está limpia', () => {
    /*
     * Ésta es la mitad que hay que no romper. En un número, lo que sigue son más
     * dígitos y no puede ser otra cosa; en una descripción, lo que viene pegado
     * atrás suele ser la cola de la línea de abajo. Aplicar la misma regla al
     * texto metía «ALMA MORA RESERVA MALBEC (6) de.» en el renglón.
     */
    const suya = celda([
      ['ALMA MORA RESERVA MALBEC (6)', 'completo:directo', 0.93],
      ['ALMA MORA RESERVA MALBEC (6)', 'articulos:directo', 0.9],
      ['ALMA MORA RESERVA MALBEC (6) de.', 'articulos:limpieza-fuerte', 0.95],
    ]);
    expect(mejorLectura(suya).texto).toBe('ALMA MORA RESERVA MALBEC (6)');
  });

  it('tampoco compara un número contra un texto que empiece igual', () => {
    const suya = celda([
      ['12.522,35', 'completo:directo', 0.9],
      ['12.522,35 kg', 'articulos:directo', 0.95],
    ]);
    expect(mejorLectura(suya).texto).toBe('12.522,35 kg');
  });
});

// ---------------------------------------------------------------------------
// 2. En el pie: un importe mutilado no se afirma sin evidencia independiente
// ---------------------------------------------------------------------------

describe('un importe mutilado se pregunta, no se completa', () => {
  function filaDelPie(y: number, celdas: [texto: string, x: number][]): Fragmento[] {
    return celdas.map(([texto, x]) => palabra(texto, x, y));
  }

  /** Un pie con el neto mutilado —le falta el último dígito— y su IVA impreso. */
  function conElNeto(texto: string, detalle: string | null) {
    return reconciliarPie(
      [
        ...filaDelPie(0.4, [
          ['Neto:', 0.58],
          [texto, 0.86],
        ]),
        ...filaDelPie(0.42, [
          ['IVA', 0.58],
          ['21%', 0.64],
          ['12.522,35', 0.86],
        ]),
        ...filaDelPie(0.46, [
          ['Total:', 0.58],
          ['72.152,60', 0.86],
        ]),
      ],
      {
        sumaDelDetalle: detalle === null ? null : new Decimal(detalle),
        alturaTipica: ALTO,
        renglonesDelDetalle: 4,
        desdeY: 0,
        finDelDetalle: 0.3,
      },
    );
  }

  it('no lo afirma, aunque tenga su etiqueta pegada y bien impresa', () => {
    /*
     * «Neto:» resuelve **qué concepto es**, no **cuánto vale**. Con «59.630.2»
     * siguen siendo posibles tres lecturas —59.630,2, 596.302 y 5.963,02— y
     * ninguna evidencia las separa: elegir una sería tirar una moneda y
     * escribirla como si fuera un dato leído.
     */
    const resultado = conElNeto('59.630.2', null);
    expect(resultado.netoGravado).toBeNull();
    expect(resultado.sinAsignar.map((u) => u.texto)).toContain('59.630.2');
  });

  it('y la igualdad del IVA no le fabrica el dígito que falta', () => {
    /*
     * 12.522,35 ÷ 21 % da 59.630,24, que no es el número del papel: la relación
     * puede confirmar una lectura presente y no puede inventar la ausente. Que
     * el IVA esté impreso y leído no alcanza para completar el neto.
     */
    const resultado = conElNeto('59.630.2', null);
    expect(resultado.netoGravado).toBeNull();
    expect(resultado.iva.map((i) => i.valor.toFixed(2))).toEqual(['12522.35']);
    expect(resultado.estado).not.toBe('completo');
  });

  it('ni cuando el detalle cierra con el número entero que no se leyó', () => {
    // El detalle suma 59.630,25 y la lectura dice 59.630,2: no es la misma.
    const resultado = conElNeto('59.630.2', '59630.25');
    expect(resultado.netoGravado).toBeNull();
  });

  it('pero sí lo afirma cuando otra relación confirma exactamente esa lectura', () => {
    /*
     * Acá no hay nada mutilado que adivinar: el detalle suma exactamente lo que
     * la celda dice. La relación está confirmando una lectura presente, que es
     * para lo único que sirve.
     */
    const resultado = conElNeto('59.630.2', '59630.20');
    expect(resultado.netoGravado?.toFixed(2)).toBe('59630.20');
  });

  it('y el número entero se afirma sin necesidad de nada más', () => {
    const resultado = conElNeto('59.630,25', null);
    expect(resultado.netoGravado?.toFixed(2)).toBe('59630.25');
  });
});
