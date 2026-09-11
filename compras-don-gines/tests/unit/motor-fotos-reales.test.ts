import { describe, it, expect } from 'vitest';
import { interpretar } from '@/lib/ocr/motor/motor';
import type { InformeDelMotor } from '@/lib/ocr/motor/motor';
import type { TextosComprobante } from '@/lib/ocr/parsers/tipos';
import {
  EZRA_FOTO_ARTICULOS,
  EZRA_FOTO_COMPLETA,
  EZRA_FOTO_ENCABEZADO,
  EZRA_FOTO_RESUMEN,
} from '@/../tests/fixtures/ezra-foto';
import {
  BARRAZA_FOTO_ARTICULOS,
  BARRAZA_FOTO_COMPLETA,
  BARRAZA_FOTO_ENCABEZADO,
  BARRAZA_FOTO_RESUMEN,
} from '@/../tests/fixtures/barraza-foto';
import { BARRAZA_PIE } from '@/../tests/fixtures/barraza';
import {
  MABELHERDI_FOTO_ARTICULOS,
  MABELHERDI_FOTO_COMPLETA,
  MABELHERDI_FOTO_ENCABEZADO,
  MABELHERDI_FOTO_RESUMEN,
} from '@/../tests/fixtures/mabelherdi-foto';
import {
  LOS_CALVOS_ARTICULOS_OCR,
  LOS_CALVOS_ENCABEZADO_OCR,
  LOS_CALVOS_PRINTED,
  LOS_CALVOS_RESUMEN_OCR,
  LOS_CALVOS_TEXT,
} from '@/../tests/fixtures/los-calvos';
import {
  ERRECALDE_ARTICULOS,
  ERRECALDE_COMPLETO,
  ERRECALDE_ENCABEZADO,
  ERRECALDE_RESUMEN,
} from '@/../tests/fixtures/errecalde-ocr';

/**
 * El motor general contra las cinco facturas reales del banco, **sin invocar
 * ningún analizador de proveedor**.
 *
 * Es el corte honesto de dónde está el motor hoy, y hay dos mitades bien
 * distintas:
 *
 *  - **el emisor y el pie fiscal ya están resueltos en general.** Sobre las
 *    cinco fotos, el CUIT del emisor sale bien; sobre cuatro de las cinco, el
 *    neto, el IVA, las percepciones y el total salen exactos, incluido el caso
 *    difícil de Lácteos Barraza, donde hay un saldo acumulado de cuenta
 *    corriente más grande que el total de la factura;
 *
 *  - **el cuerpo de la tabla no.** Sobre una foto de teléfono las líneas salen
 *    torcidas, con celdas fundidas y números en la fila de al lado, y ahí el
 *    motor general todavía no llega. Lo que sí hace —y es lo que se prueba
 *    acá— es **no aceptar ninguna de esas lecturas**: las manda a revisión o
 *    las rechaza, nunca las da por buenas.
 *
 * Esa segunda mitad es la razón por la que los analizadores específicos siguen
 * en el repositorio como respaldo. Estas pruebas se van a tener que actualizar
 * cuando el motor los alcance, y ese día lo que tiene que cambiar es el número
 * de renglones interpretados, nunca la garantía de que no acepta lo que leyó
 * mal.
 */

const CUIT_DEL_RECEPTOR = '27-33342291-9';

function leer(textos: TextosComprobante): InformeDelMotor {
  return interpretar(textos, { cuitDelReceptor: CUIT_DEL_RECEPTOR });
}

const EZRA = leer({
  completo: EZRA_FOTO_COMPLETA,
  encabezado: EZRA_FOTO_ENCABEZADO,
  articulos: EZRA_FOTO_ARTICULOS,
  resumen: EZRA_FOTO_RESUMEN,
});

const BARRAZA = leer({
  completo: BARRAZA_FOTO_COMPLETA,
  encabezado: BARRAZA_FOTO_ENCABEZADO,
  articulos: BARRAZA_FOTO_ARTICULOS,
  resumen: BARRAZA_FOTO_RESUMEN,
});

const MABELHERDI = leer({
  completo: MABELHERDI_FOTO_COMPLETA,
  encabezado: MABELHERDI_FOTO_ENCABEZADO,
  articulos: MABELHERDI_FOTO_ARTICULOS,
  resumen: MABELHERDI_FOTO_RESUMEN,
});

const LOS_CALVOS = leer({
  completo: LOS_CALVOS_TEXT,
  encabezado: LOS_CALVOS_ENCABEZADO_OCR,
  articulos: LOS_CALVOS_ARTICULOS_OCR,
  resumen: LOS_CALVOS_RESUMEN_OCR,
});

const ERRECALDE = leer({
  completo: ERRECALDE_COMPLETO,
  encabezado: ERRECALDE_ENCABEZADO,
  articulos: ERRECALDE_ARTICULOS,
  resumen: ERRECALDE_RESUMEN,
});

describe('el emisor, sobre las cinco facturas reales', () => {
  it('el CUIT del emisor sale bien en las cinco, sin ningún analizador', () => {
    /*
     * Es lo que hasta ahora hacía cada analizador por su cuenta buscando el
     * nombre del proveedor en el texto, y lo que hacía que la factura de
     * Distribuidora Ezra se la quedara el analizador de Los Calvos, porque
     * «LOS CALVOS» es la marca de uno de los artículos.
     */
    expect(EZRA.emisor.cuit).toBe('30-71951960-8');
    expect(BARRAZA.emisor.cuit).toBe('30-66138303-4');
    expect(MABELHERDI.emisor.cuit).toBe('30-87804306-7');
    expect(LOS_CALVOS.emisor.cuit).toBe('30-61234567-9');
    expect(ERRECALDE.emisor.cuit).toBe('30-71780890-4');
  });

  it('ninguna se atribuye al CUIT del receptor, que está en las cinco', () => {
    for (const informe of [EZRA, BARRAZA, MABELHERDI, LOS_CALVOS, ERRECALDE]) {
      expect(informe.emisor.cuit).not.toBe(CUIT_DEL_RECEPTOR);
    }
  });
});

describe('el pie fiscal, sobre las facturas reales', () => {
  it('Ezra: neto, IVA y total exactos', () => {
    expect(EZRA.pie.netTotal?.toFixed(2)).toBe('221388.84');
    expect(EZRA.pie.ivaTotal?.toFixed(2)).toBe('46491.66');
    expect(EZRA.pie.total?.toFixed(2)).toBe('267880.50');
  });

  it('Barraza: con percepción, y sin el saldo acumulado de la cuenta corriente', () => {
    /*
     * El saldo previo de esta factura es 532.848,64 y el total es 579.709,74:
     * el saldo es más grande que el neto, así que cualquier criterio que
     * eligiera «el número más grande del pie» lo cargaría como neto y la deuda
     * quedaría al doble.
     */
    expect(BARRAZA.pie.netTotal?.toFixed(2)).toBe(BARRAZA_PIE.netTotal);
    expect(BARRAZA.pie.ivaTotal?.toFixed(2)).toBe(BARRAZA_PIE.iva21);
    expect(BARRAZA.pie.percepciones?.toFixed(2)).toBe(BARRAZA_PIE.percepcionIibbCaba);
    expect(BARRAZA.pie.total?.toFixed(2)).toBe(BARRAZA_PIE.total);

    expect(BARRAZA.pie.ignorados.map((i) => i.valor)).toContain(
      BARRAZA_PIE.saldoAcumuladoPrevio,
    );
    for (const valor of [BARRAZA.pie.netTotal, BARRAZA.pie.ivaTotal, BARRAZA.pie.total]) {
      expect(valor?.toFixed(2)).not.toBe(BARRAZA_PIE.saldoAcumuladoPrevio);
    }
  });

  it('Mabelherdi: neto, IVA y el total que sale de sumarlos con la percepción', () => {
    expect(MABELHERDI.pie.netTotal?.toFixed(2)).toBe('32998.85');
    expect(MABELHERDI.pie.ivaTotal?.toFixed(2)).toBe('6929.76');
    // 32.998,85 + 6.929,76 + 577,48 = 40.506,09
    expect(MABELHERDI.pie.total?.toFixed(2)).toBe('40506.09');
  });

  it('Los Calvos: el pie entero', () => {
    expect(LOS_CALVOS.pie.netTotal?.toFixed(2)).toBe(LOS_CALVOS_PRINTED.netTotal);
    expect(LOS_CALVOS.pie.ivaTotal?.toFixed(2)).toBe(LOS_CALVOS_PRINTED.ivaTotal);
    expect(LOS_CALVOS.pie.total?.toFixed(2)).toBe(LOS_CALVOS_PRINTED.total);
  });

  it('Errecalde: el pie NO se encuentra, y ésa es una falta conocida', () => {
    /*
     * El papel dice 3.830.467,37 de neto y el motor general no lo encuentra:
     * este formato no usa ninguna de las etiquetas que el pie sabe buscar.
     * Hoy lo resuelve el analizador de Errecalde, que lo recupera por
     * consistencia aritmética entre pasadas.
     *
     * Se prueba que falta en vez de callarlo, por dos razones: sin neto impreso
     * no hay contra qué comparar la suma de los renglones —que es el control
     * más fuerte que tiene el motor—, y cuando se arregle, esta prueba tiene
     * que empezar a fallar para que se actualice.
     */
    expect(ERRECALDE.pie.netTotal).toBeNull();
    expect(ERRECALDE.veredicto.decision).not.toBe('automatica');
  });
});

describe('el cuerpo de la tabla, sobre las facturas reales', () => {
  it('con la impresión bien alineada, el motor general la lee entera y sola', () => {
    /*
     * Nueve renglones, y la suma da **exactamente** el neto gravado impreso.
     * Es la prueba de que el motor no necesita el analizador cuando el texto
     * llega en columnas: lo que le falta no es criterio, es una foto derecha.
     */
    expect(LOS_CALVOS.veredicto.decision).toBe('automatica');
    expect(LOS_CALVOS.veredicto.ganadora!.renglones).toHaveLength(9);
    expect(LOS_CALVOS.veredicto.ganadora!.sumaDeRenglones.toFixed(2)).toBe(
      LOS_CALVOS_PRINTED.netTotal,
    );
  });

  it('sobre la bonificación de Los Calvos, entiende que el importe es bruto', () => {
    // 16,10 × 16.037 = 258.195,70 es el importe impreso: el 14 % se descuenta
    // recién al pie. Es la convención contraria a la de Lácteos Barraza.
    const renglones = LOS_CALVOS.veredicto.ganadora!.renglones;
    expect(renglones.every((r) => r.descuentoEnElImporte === false)).toBe(true);
    expect(renglones[0].importe?.toFixed(2)).toBe('258195.70');
  });

  it('sobre las fotos de teléfono, NO acepta ninguna lectura', () => {
    /*
     * Ésta es la garantía que importa mientras el motor no llegue, y es la que
     * no se puede perder nunca. Las tres fotos salen del teléfono con las
     * líneas torcidas, celdas fundidas y números en la fila de al lado; el
     * motor general lee mal el cuerpo de las tres.
     *
     * Lo que hace es darse cuenta: la suma de los renglones no se parece al
     * neto impreso y la lectura no llega al umbral. Va a revisión o se
     * rechaza, y el comprobante lo termina de resolver el analizador
     * específico o una persona. Aceptar una de éstas cargaría costos
     * inventados en el historial, y de ahí sale el precio de venta.
     */
    for (const informe of [EZRA, BARRAZA, MABELHERDI]) {
      expect(informe.veredicto.decision).not.toBe('automatica');
    }
  });

  it('y dice en castellano por qué no le cree a cada una', () => {
    /*
     * Que frene no alcanza: tiene que quedar dicho qué fue lo que no cerró,
     * porque es lo único con lo que una persona puede seguir. Sobre la foto de
     * Ezra el motivo es que a los renglones les faltan importes —el recorte de
     * la tabla se comió columnas enteras—, así que la suma ni siquiera se puede
     * comparar contra el neto impreso.
     */
    for (const informe of [EZRA, BARRAZA, MABELHERDI]) {
      const motivos = informe.veredicto.ganadora!.penalizaciones.map((p) => p.motivo);
      expect(motivos.length).toBeGreaterThan(0);
      expect(motivos.join(' ')).toMatch(/renglon|renglón|suma|neto/i);
    }
    expect(EZRA.veredicto.ganadora!.penalizaciones.map((p) => p.motivo).join(' ')).toMatch(
      /renglones no tienen importe|no se pudieron comprobar/,
    );
  });

  it('el freno no es que no encuentre la tabla: la encuentra y no le cree', () => {
    // La distinción importa para saber qué hay que arreglar. En las tres fotos
    // la fila de títulos aparece y varias columnas se reconocen; lo que falla
    // es reconstruir los renglones sobre líneas torcidas.
    for (const informe of [EZRA, MABELHERDI]) {
      expect(informe.titulos).not.toBeNull();
      expect(informe.columnas.filter((c) => c !== null).length).toBeGreaterThanOrEqual(4);
    }
  });
});
