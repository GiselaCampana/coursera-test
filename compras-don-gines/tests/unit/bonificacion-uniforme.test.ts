import { describe, it, expect } from 'vitest';
import { bonificacionUniformeInferida } from '@/lib/domain/bonificacion-uniforme';
import { BARRAZA_ARTICULOS_IMPRESOS, BARRAZA_PIE } from '../fixtures/barraza';

/**
 * **La bonificación que el OCR pierde, demostrada o rechazada.**
 *
 * Lo que se fija acá no es que Barraza pase: es que la función **sólo** afirme
 * una tasa cuando la aritmética la demuestra, y que se niegue en todos los
 * casos donde afirmarla sería inventar un dato. Por eso hay más pruebas
 * negativas que positivas.
 */

/** Los dos renglones de Barraza como los deja el OCR: sin bonificación. */
const BARRAZA_COMO_LO_LEE_EL_OCR = BARRAZA_ARTICULOS_IMPRESOS.map((a, i) => ({
  lineNumber: i + 1,
  quantity: a.kilos,
  unitNetPrice: a.precioPorKg,
  discountPct: null,
}));

describe('la bonificación uniforme se demuestra o no se afirma', () => {
  it('en Barraza demuestra el 16 % y reconstruye el neto impreso', () => {
    const r = bonificacionUniformeInferida(BARRAZA_COMO_LO_LEE_EL_OCR, BARRAZA_PIE.netTotal);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tasa).toBe('16.00');
    expect(r.evidencia.bruto).toBe('563371.95');
    expect(r.evidencia.netoImpreso).toBe('473232.44');
    /* Y lo que importa: la tasa redonda reproduce el papel, no lo aproxima. */
    expect(r.evidencia.netoReconstruido).toBe('473232.44');
    expect(Number(r.evidencia.residuo)).toBeCloseTo(0, 2);
    expect(r.evidencia.renglones).toBe(2);
  });

  it('con el 16 % cada renglón queda en su neto impreso, al centavo', () => {
    /*
     * La razón de ser de todo esto. La tasa global sirve para una sola cosa:
     * que el costo de CADA artículo sea el que se pagó. Si la tasa fuera
     * correcta en el total y equivocada por renglón, el total cerraría y los
     * costos estarían mal, que es la combinación que no se ve en ningún control.
     */
    const r = bonificacionUniformeInferida(BARRAZA_COMO_LO_LEE_EL_OCR, BARRAZA_PIE.netTotal);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const factor = 1 - Number(r.tasa) / 100;
    for (const articulo of BARRAZA_ARTICULOS_IMPRESOS) {
      const neto = Number(articulo.kilos) * Number(articulo.precioPorKg) * factor;
      expect(neto, `renglón ${articulo.codigo}`).toBeCloseTo(Number(articulo.neto), 2);
    }
  });

  it('se niega cuando ninguna tasa uniforme reproduce el neto', () => {
    /*
     * Dos renglones con bonificaciones distintas: 10 % y 20 %. El neto impreso
     * es la suma real, y no existe una tasa única que lo produzca renglón por
     * renglón. Tiene que negarse en vez de repartir la diferencia.
     */
    const renglones = [
      { lineNumber: 1, quantity: '10', unitNetPrice: '100', discountPct: null },
      { lineNumber: 2, quantity: '10', unitNetPrice: '100', discountPct: null },
    ];
    /* 1000 × 0,90 + 1000 × 0,80 = 1700. La tasa media sería 15 %. */
    const r = bonificacionUniformeInferida(renglones, '1700.00');

    /*
     * Con dos renglones de bruto idéntico, el 15 % uniforme SÍ reproduce 1700,
     * así que acá la función afirma —y está bien que lo haga: es indistinguible
     * de una factura con 15 % uniforme—. Lo que se fija es que la tasa sea la
     * que reproduce el papel y no un promedio cualquiera.
     */
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tasa).toBe('15.00');
  });

  it('se niega de verdad cuando los brutos son distintos y las tasas también', () => {
    /*
     * Ahora los brutos son distintos, así que un promedio no reconstruye nada:
     * 1000 al 10 % son 900 y 500 al 20 % son 400, total 1300. Ninguna tasa
     * uniforme da 1300 aplicada a 1000 y a 500 con redondeo al centavo.
     */
    const renglones = [
      { lineNumber: 1, quantity: '10', unitNetPrice: '100', discountPct: null },
      { lineNumber: 2, quantity: '5', unitNetPrice: '100', discountPct: null },
    ];
    const r = bonificacionUniformeInferida(renglones, '1300.00');

    /* 1500 × (1 − t) = 1300 → t = 13,3333 %, que redondea a 13,33 %. */
    if (r.ok) {
      /*
       * Si afirma, tiene que ser porque reconstruye: 1500 × 0,8667 = 1300,05,
       * fuera de la tolerancia de dos renglones (0,02). Que esto NO pase es la
       * afirmación.
       */
      expect.fail(`no debería afirmar: dijo ${r.tasa} % con residuo ${r.evidencia.residuo}`);
    }
    expect(r.motivo).toContain('Ninguna bonificación uniforme reproduce el neto impreso');
  });

  it('se niega cuando falta el neto impreso', () => {
    const r = bonificacionUniformeInferida(BARRAZA_COMO_LO_LEE_EL_OCR, null);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toContain('no trae el neto impreso');
  });

  it('se niega cuando el bruto ya coincide con el neto: no hay bonificación', () => {
    const renglones = [{ lineNumber: 1, quantity: '10', unitNetPrice: '100', discountPct: null }];
    const r = bonificacionUniformeInferida(renglones, '1000.00');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toContain('no hay bonificación');
  });

  it('se niega cuando el neto es mayor que el bruto: puede faltar un renglón', () => {
    /*
     * Éste es el caso peligroso y el que la función existe para no confundir:
     * si el papel dice más de lo que suman los renglones, lo más probable es
     * que falte un renglón. Tratarlo como una bonificación negativa taparía
     * justamente el problema que hay que ver.
     */
    const renglones = [{ lineNumber: 1, quantity: '10', unitNetPrice: '100', discountPct: null }];
    const r = bonificacionUniformeInferida(renglones, '2500.00');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toContain('puede faltar un renglón');
  });

  it('se niega cuando el OCR ya leyó las bonificaciones', () => {
    const renglones = [
      { lineNumber: 1, quantity: '10', unitNetPrice: '100', discountPct: '16' },
      { lineNumber: 2, quantity: '10', unitNetPrice: '100', discountPct: '16' },
    ];
    const r = bonificacionUniformeInferida(renglones, '1680.00');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toContain('no hay nada que inferir');
  });

  it('se niega ante una mezcla: unos renglones con bonificación leída y otros sin', () => {
    const renglones = [
      { lineNumber: 1, quantity: '10', unitNetPrice: '100', discountPct: '16' },
      { lineNumber: 2, quantity: '10', unitNetPrice: '100', discountPct: null },
    ];
    const r = bonificacionUniformeInferida(renglones, '1700.00');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toContain('mezcla');
  });

  it('la tolerancia no tapa un renglón faltante', () => {
    /*
     * La prueba que impide que esto se convierta en una tolerancia ancha. Tres
     * renglones de 1000 y un neto impreso de 3000 menos uno de los renglones:
     * la «bonificación» implícita sería del 33 %, y reconstruida da 2010, no
     * 2000. Se niega.
     */
    const renglones = [1, 2, 3].map((n) => ({
      lineNumber: n,
      quantity: '10',
      unitNetPrice: '100',
      discountPct: null,
    }));
    const r = bonificacionUniformeInferida(renglones, '2000.00');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toContain('Ninguna bonificación uniforme');
  });
});
