import { describe, it, expect } from 'vitest';
import { resolverDecisionDePago } from '@/lib/domain/decision-de-pago';
import { dateOnlyFromISO, toISODate } from '@/lib/datetime';

/**
 * **Cuándo y cómo se paga una factura de un proveedor sin condiciones.**
 *
 * La regla que fija este archivo es que no hay regla por omisión: se elige, o
 * no se aplica. Antes la confirmación rellenaba el vencimiento con la fecha de
 * emisión y la forma de pago con «Transferencia», y una fecha de pago
 * inventada es indistinguible después de una acordada.
 */

const EMISION = dateOnlyFromISO('2026-09-10');

describe('sin una decisión completa no hay fecha', () => {
  it('sin decisión, falta todo', () => {
    const resultado = resolverDecisionDePago(null, EMISION);
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.motivo).toContain('forma de pago');
  });

  it('sin forma de pago no alcanza con la condición', () => {
    const resultado = resolverDecisionDePago(
      { forma: '', condicion: { tipo: 'CONTADO' } },
      EMISION,
    );
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.motivo).toContain('forma de pago');
  });

  it('una forma que el sistema no conoce se rechaza', () => {
    /*
     * No hay catálogo paralelo: las formas son las que ya usa la aplicación.
     */
    const resultado = resolverDecisionDePago(
      { forma: 'CRIPTOMONEDAS', condicion: { tipo: 'CONTADO' } },
      EMISION,
    );
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.motivo).toContain('no es una forma de pago');
  });

  it('sin condición elegida tampoco', () => {
    const resultado = resolverDecisionDePago(
      { forma: 'EFECTIVO', condicion: undefined as never },
      EMISION,
    );
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.motivo).toContain('condición');
  });

  it('y nunca devuelve «Transferencia» por su cuenta', () => {
    /*
     * La prueba del relleno que había. Ninguna entrada incompleta puede
     * terminar en una forma de pago que nadie eligió.
     */
    for (const entrada of [
      null,
      { forma: '', condicion: { tipo: 'CONTADO' as const } },
      { forma: '   ', condicion: { tipo: 'CONTADO' as const } },
    ]) {
      const resultado = resolverDecisionDePago(entrada, EMISION);
      expect(resultado.ok).toBe(false);
      expect(JSON.stringify(resultado)).not.toContain('TRANSFERENCIA');
    }
  });
});

describe('las tres condiciones que se pueden elegir', () => {
  it('contado vence el día de emisión', () => {
    const resultado = resolverDecisionDePago(
      { forma: 'EFECTIVO', condicion: { tipo: 'CONTADO' } },
      EMISION,
    );

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(toISODate(resultado.pago.dueDate)).toBe('2026-09-10');
    expect(resultado.pago.term.termType).toBe('SAME_DAY');
    expect(resultado.pago.paymentMethod).toBe('EFECTIVO');
    expect(resultado.pago.fechaElegidaAMano).toBe(false);
  });

  it('a 30 días vence a 30 días de la emisión', () => {
    const resultado = resolverDecisionDePago(
      { forma: 'TRANSFERENCIA', condicion: { tipo: 'DIAS', dias: 30 } },
      EMISION,
    );

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(toISODate(resultado.pago.dueDate)).toBe('2026-10-10');
    expect(resultado.pago.term).toMatchObject({ termType: 'DAYS', days: 30 });
    expect(resultado.pago.comoSeCalculo).toContain('30');
  });

  it('un plazo que no es un número entero razonable se rechaza', () => {
    for (const dias of [0, -5, 1.5, 400, Number.NaN]) {
      const resultado = resolverDecisionDePago(
        { forma: 'CHEQUE', condicion: { tipo: 'DIAS', dias } },
        EMISION,
      );
      expect(resultado.ok, String(dias)).toBe(false);
    }
  });

  it('una fecha puntual queda marcada como decisión manual', () => {
    const resultado = resolverDecisionDePago(
      { forma: 'CHEQUE', condicion: { tipo: 'FECHA', fecha: '2026-11-15' } },
      EMISION,
    );

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(toISODate(resultado.pago.dueDate)).toBe('2026-11-15');
    expect(resultado.pago.term.termType).toBe('MANUAL');
    expect(resultado.pago.fechaElegidaAMano).toBe(true);
  });
});

describe('el vencimiento no puede ser anterior a la emisión', () => {
  it('un día antes ya se rechaza, y el motivo dice las dos fechas', () => {
    const resultado = resolverDecisionDePago(
      { forma: 'EFECTIVO', condicion: { tipo: 'FECHA', fecha: '2026-09-09' } },
      EMISION,
    );

    expect(resultado.ok).toBe(false);
    if (resultado.ok) return;
    expect(resultado.motivo).toContain('2026-09-09');
    expect(resultado.motivo).toContain('2026-09-10');
  });

  it('el mismo día de emisión sí se acepta', () => {
    const resultado = resolverDecisionDePago(
      { forma: 'EFECTIVO', condicion: { tipo: 'FECHA', fecha: '2026-09-10' } },
      EMISION,
    );
    expect(resultado.ok).toBe(true);
  });

  it('una factura vieja puede vencer en el pasado: el límite es la emisión, no hoy', () => {
    /*
     * Una factura se carga tarde y queda vencida. Eso pasa y es correcto:
     * medirlo contra hoy rechazaría justamente los casos legítimos.
     */
    const vieja = dateOnlyFromISO('2025-03-01');
    const resultado = resolverDecisionDePago(
      { forma: 'TRANSFERENCIA', condicion: { tipo: 'DIAS', dias: 30 } },
      vieja,
    );

    expect(resultado.ok).toBe(true);
    if (!resultado.ok) return;
    expect(toISODate(resultado.pago.dueDate)).toBe('2025-03-31');
  });
});
