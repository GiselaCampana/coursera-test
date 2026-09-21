import { describe, it, expect, afterEach } from 'vitest';
import { computePaymentStatus } from '@/lib/domain/payments';
import { ahora, arTodayISO, dateOnlyFromISO, DIA_FIJADO } from '@/lib/datetime';

/**
 * **Qué día es, y de qué depende.**
 *
 * El estado de un pago no lo decide nadie: lo decide el calendario. Una factura
 * pasa de «agendada» a «vence hoy» y de ahí a «vencida» sin que se toque el
 * código, así que una prueba que afirme cualquiera de los tres sin controlar
 * «hoy» no está afirmando nada. Pasa, y un día cualquiera falla sola.
 *
 * Eso fue exactamente lo que pasó: dos pruebas end to end buscaban la factura
 * real de Errecalde —22/08/2026, a 30 días— en «Próximos». Vencía el 21/09/2026
 * y ese día dejó de estar ahí. La aplicación tenía razón; la prueba estaba
 * escrita contra el almanaque.
 *
 * Acá se fija la frontera en los dos lugares donde vive: el día de hoy, y la
 * comparación contra el vencimiento.
 */

const original = { ...process.env };

afterEach(() => {
  process.env = { ...original };
});

/** Un vencimiento cualquiera, y los tres días que lo rodean. */
const VENCE = '2026-09-21';
const VISPERA = new Date('2026-09-20T15:00:00Z');
const EL_DIA = new Date('2026-09-21T15:00:00Z');
const AL_DIA_SIGUIENTE = new Date('2026-09-22T15:00:00Z');

function estadoAl(now: Date) {
  return computePaymentStatus(
    { dueDate: dateOnlyFromISO(VENCE), plannedAmount: '1000.00', paidAmount: '0' },
    now,
  );
}

describe('los tres límites', () => {
  it('vencimiento posterior a hoy: agendado', () => {
    expect(estadoAl(VISPERA)).toBe('AGENDADO');
  });

  it('vencimiento igual a hoy: vence hoy, y no agendado', () => {
    /*
     * La frontera que se rompió. Un pago que vence hoy todavía se puede pagar,
     * así que es tentador contarlo entre los próximos; pero entonces el día del
     * vencimiento no aparece en ninguna pantalla como algo que hay que hacer
     * hoy, y se entera al día siguiente, cuando ya figura vencido.
     */
    expect(estadoAl(EL_DIA)).toBe('VENCE_HOY');
    expect(estadoAl(EL_DIA)).not.toBe('AGENDADO');
  });

  it('vencimiento anterior a hoy: vencido', () => {
    expect(estadoAl(AL_DIA_SIGUIENTE)).toBe('VENCIDO');
  });

  it('la hora del día no mueve la frontera', () => {
    /*
     * El día argentino va de medianoche a medianoche de Buenos Aires. A las
     * 23:30 del 21 todavía vence hoy, aunque en UTC ya sea el 22; a las 00:30
     * del 21 ya vence hoy, aunque en UTC sea todavía el 20. Si esto se midiera
     * en UTC, el estado cambiaría tres horas antes de tiempo todas las noches.
     */
    expect(estadoAl(new Date('2026-09-22T02:30:00Z'))).toBe('VENCE_HOY'); // 23:30 del 21
    expect(estadoAl(new Date('2026-09-21T03:30:00Z'))).toBe('VENCE_HOY'); // 00:30 del 21
    expect(estadoAl(new Date('2026-09-22T03:30:00Z'))).toBe('VENCIDO'); // 00:30 del 22
  });

  it('un pago cancelado o saldado no depende del día', () => {
    const vencido = { dueDate: dateOnlyFromISO(VENCE), plannedAmount: '1000.00' };
    expect(computePaymentStatus({ ...vencido, paidAmount: '1000.00' }, AL_DIA_SIGUIENTE)).toBe(
      'PAGADO',
    );
    expect(computePaymentStatus({ ...vencido, paidAmount: '0', cancelled: true }, VISPERA)).toBe(
      'CANCELADO',
    );
  });
});

describe('de dónde sale «hoy»', () => {
  it('sin fijar nada es el reloj de la máquina, leído en hora argentina', () => {
    delete process.env[DIA_FIJADO];
    const antes = Date.now();
    const leido = ahora().getTime();
    expect(leido).toBeGreaterThanOrEqual(antes);
    expect(leido).toBeLessThanOrEqual(Date.now());
  });

  it('fijado, es ese día y no el de la máquina', () => {
    process.env[DIA_FIJADO] = '2026-09-10';
    expect(arTodayISO()).toBe('2026-09-10');
  });

  it('el huso de la máquina no lo mueve', () => {
    /*
     * La razón por la que esto no depende de TZ: el día se saca con `Intl` en
     * el huso de Buenos Aires, no del reloj local. Se comprueba pidiendo el día
     * de un instante que en UTC ya es el siguiente.
     */
    expect(arTodayISO(new Date('2026-09-11T02:00:00Z'))).toBe('2026-09-10');
  });

  it('contra una base que no es de pruebas, corta', () => {
    /*
     * Lo que esta guarda evita no es una prueba frágil: es toda la agenda de
     * pagos clasificada contra un día que no existe, en silencio y durante
     * semanas. Por eso lanza en vez de ignorar la variable.
     */
    process.env[DIA_FIJADO] = '2026-09-10';
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/compras_don_gines?schema=public';
    expect(() => ahora()).toThrow(/sólo puede usarse contra una base de pruebas/);
    // Y el mensaje no arrastra la URL, que lleva la contraseña adentro.
    expect(() => ahora()).not.toThrow(/:p@/);
  });

  it('con un valor que no es una fecha, corta', () => {
    process.env[DIA_FIJADO] = 'ayer';
    expect(() => ahora()).toThrow(/YYYY-MM-DD/);
  });
});
