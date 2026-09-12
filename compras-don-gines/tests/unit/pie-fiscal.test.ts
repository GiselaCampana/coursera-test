import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Decimal } from '@/lib/money';
import type { EvidenciaDeLectura, Fragmento } from '@/lib/ocr/reconstruccion/evidencia';
import { interpretarReconstruccion } from '@/lib/ocr/motor/desde-reconstruccion';
import {
  conceptoSegunEtiqueta,
  esIdentificador,
  reconciliarPie,
  type PieFiscal,
} from '@/lib/ocr/motor/pie-fiscal';
import { DERIVED_SUGGESTION } from '@/lib/ocr/motor/sugerencias';

/**
 * El pie fiscal como sistema de igualdades.
 *
 * Un pie no es una lista de campos con etiquetas: es la suma del detalle, el
 * neto gravado, el IVA de cada alícuota, las percepciones y el total, atados
 * entre sí. Esas ataduras son lo que permite reconocer un número cuya etiqueta
 * el OCR destruyó, y lo que permite descartar un número que dice «Total» al
 * lado sin ser el total del comprobante.
 *
 * Las pruebas de acá arman pies a mano —sin nombres de proveedor ni valores de
 * ningún fixture— y después comprueban las cuatro facturas reales.
 */

const DIRECTORIO = path.resolve(__dirname, '../fixtures/evidencia');

let x = 0;
function frag(texto: string, fila: number, columna: number, confianza = 0.9): Fragmento {
  x += 1;
  return {
    texto,
    caja: {
      x0: columna,
      y0: 0.5 + fila * 0.02,
      x1: columna + 0.08,
      y1: 0.5 + fila * 0.02 + 0.008,
    },
    pasada: `prueba:${x}`,
    confianza,
  };
}

function pieDe(fragmentos: Fragmento[], suma: string | null, renglones = 1): PieFiscal {
  return reconciliarPie(fragmentos, {
    sumaDelDetalle: suma === null ? null : new Decimal(suma),
    alturaTipica: 0.008,
    renglonesDelDetalle: renglones,
  });
}

describe('las etiquetas, enteras y degradadas', () => {
  it('reconoce una etiqueta mutilada por parecido', () => {
    // Lo que el OCR devolvió de verdad sobre las fotos del banco.
    expect(conceptoSegunEtiqueta('UBTOTA')?.concepto).toBe('netoGravado');
    expect(conceptoSegunEtiqueta('SUBTOTAI')?.concepto).toBe('netoGravado');
    expect(conceptoSegunEtiqueta('Neto Gravado')?.concepto).toBe('netoGravado');
    expect(conceptoSegunEtiqueta('recia Perc lIBB IIBB CABA CA]')?.concepto).toBe('percepcion');
    expect(conceptoSegunEtiqueta('I.V.A')?.concepto).toBe('iva');
    expect(conceptoSegunEtiqueta('Total:')?.concepto).toBe('total');
  });

  it('distingue «no gravado» de «gravado», que son lo contrario', () => {
    expect(conceptoSegunEtiqueta('No Gravado')?.concepto).toBe('noGravado');
    expect(conceptoSegunEtiqueta('Neto Gravado')?.concepto).toBe('netoGravado');
  });

  it('no confunde el pie con el saldo de cuenta corriente ni con los kilos', () => {
    /*
     * Los dos casos reales. Una de las facturas trae un saldo acumulado más
     * grande que su propio total, con la palabra «Total» a la vista; y casi
     * todas traen un «Total Kgs.» al pie del detalle, que dice la misma palabra
     * y cuenta otra cosa.
     */
    expect(conceptoSegunEtiqueta('Saldo Ac.')).toBeNull();
    expect(conceptoSegunEtiqueta('Saldo Acumulado')).toBeNull();
    expect(conceptoSegunEtiqueta('Total Kgs.')).toBeNull();
    expect(conceptoSegunEtiqueta('Total Bultos')).toBeNull();
  });

  it('lo que viene detrás de «RG» es una norma, no un importe', () => {
    // «Percepción IVA RG 5329» trae el número de la resolución general que la
    // crea, y no es una percepción de cinco mil trescientos veintinueve pesos.
    expect(esIdentificador('Percepcion IVA RG')).toBe(true);
    expect(esIdentificador('Res.')).toBe(true);
    expect(esIdentificador('Percepcion IIBB')).toBe(false);
  });
});

describe('las igualdades reconocen lo que las etiquetas no', () => {
  it('un número que cumple neto × alícuota es el IVA aunque no tenga etiqueta', () => {
    /*
     * El caso que justifica todo el módulo. La etiqueta del IVA salió ilegible
     * y su valor está solo en la página; lo que lo identifica es que es
     * exactamente el 21 % del neto.
     */
    const pie = pieDe(
      [
        frag('Neto Gravado', 0, 0.4),
        frag('1.000,00', 0, 0.7),
        // Sin etiqueta: sólo el número.
        frag('210,00', 1, 0.7),
        frag('Total', 2, 0.4),
        frag('1.210,00', 2, 0.7),
      ],
      '1000.00',
    );

    expect(pie.netoGravado?.toFixed(2)).toBe('1000.00');
    expect(pie.iva).toHaveLength(1);
    expect(pie.iva[0].valor.toFixed(2)).toBe('210.00');
    expect(pie.iva[0].alicuota?.toString()).toBe('0.21');
    expect(pie.total?.toFixed(2)).toBe('1210.00');

    const delIva = pie.asignaciones.find((a) => a.concepto === 'iva')!;
    expect(delIva.etiqueta).toBeNull();
    expect(delIva.igualdad).toContain('21 % = IVA');
    // Y dice de qué fragmento salió, con su caja y su pasada.
    expect(delIva.origen.texto).toBe('210,00');
    expect(delIva.origen.pasada).toMatch(/^prueba:/);
  });

  it('una etiqueta mutilada del total se recupera con la relación', () => {
    /*
     * El otro lado: el número tiene etiqueta y la etiqueta es basura —«EATAL
     * EPATAL» es lo que una de las fotos devolvió por «TOTAL»— y lo que lo
     * identifica es que cierra el sistema.
     */
    const pie = pieDe(
      [
        frag('Subtotal', 0, 0.4),
        frag('1.000,00', 0, 0.7),
        frag('IVA 21%', 1, 0.4),
        frag('210,00', 1, 0.7),
        frag('EATAL EPATAL', 2, 0.4),
        frag('1.210,00', 2, 0.7),
      ],
      '1000.00',
    );

    expect(pie.total?.toFixed(2)).toBe('1210.00');
    const delTotal = pie.asignaciones.find((a) => a.concepto === 'total')!;
    expect(delTotal.igualdad).toContain('= total');
    expect(delTotal.etiqueta?.exacta).toBe(false);
  });

  it('una línea fiscal en el tercio central de la página sigue siendo del pie', () => {
    /*
     * La posición es evidencia, no un filtro. Hay formatos que imprimen el
     * detalle arriba y el resumen a media página, y hay fotos donde la mitad de
     * abajo sale en sombra y el OCR ubica las líneas más arriba de lo que están.
     * Un pie que sólo se busque en el último tercio se pierde los dos casos.
     */
    const alMedio: Fragmento[] = [
      { ...frag('Subtotal', 0, 0.4), caja: { x0: 0.4, y0: 0.36, x1: 0.48, y1: 0.368 } },
      { ...frag('1.000,00', 0, 0.7), caja: { x0: 0.7, y0: 0.36, x1: 0.78, y1: 0.368 } },
      { ...frag('IVA 21%', 1, 0.4), caja: { x0: 0.4, y0: 0.38, x1: 0.48, y1: 0.388 } },
      { ...frag('210,00', 1, 0.7), caja: { x0: 0.7, y0: 0.38, x1: 0.78, y1: 0.388 } },
      { ...frag('Total', 2, 0.4), caja: { x0: 0.4, y0: 0.4, x1: 0.48, y1: 0.408 } },
      { ...frag('1.210,00', 2, 0.7), caja: { x0: 0.7, y0: 0.4, x1: 0.78, y1: 0.408 } },
    ];

    const pie = reconciliarPie(alMedio, {
      sumaDelDetalle: new Decimal('1000.00'),
      alturaTipica: 0.008,
      desdeY: 0.3,
    });

    expect(pie.netoGravado?.toFixed(2)).toBe('1000.00');
    expect(pie.iva[0].valor.toFixed(2)).toBe('210.00');
    expect(pie.total?.toFixed(2)).toBe('1210.00');
  });

  it('el saldo de cuenta corriente no gana por parecerse al total', () => {
    /*
     * El negativo. El saldo acumulado es más grande que el total y está en la
     * misma franja; lo que lo descarta es que su etiqueta dice otra cosa y que
     * no cumple ninguna igualdad del pie.
     */
    const pie = pieDe(
      [
        frag('Subtotal', 0, 0.35),
        frag('1.000,00', 0, 0.7),
        frag('IVA 21%', 1, 0.35),
        frag('210,00', 1, 0.7),
        frag('Saldo Ac.', 2, 0.35),
        frag('98.765,43', 2, 0.7),
        frag('Total', 3, 0.35),
        frag('1.210,00', 3, 0.7),
      ],
      '1000.00',
    );

    expect(pie.total?.toFixed(2)).toBe('1210.00');
    expect(pie.asignaciones.some((a) => a.valor.toFixed(2) === '98765.43')).toBe(false);
  });
});

describe('las percepciones: cero, una o varias', () => {
  it('sin percepciones, el pie cierra igual', () => {
    const pie = pieDe(
      [
        frag('Subtotal', 0, 0.4),
        frag('1.000,00', 0, 0.7),
        frag('IVA 21%', 1, 0.4),
        frag('210,00', 1, 0.7),
        frag('Total', 2, 0.4),
        frag('1.210,00', 2, 0.7),
      ],
      '1000.00',
    );
    expect(pie.percepciones).toHaveLength(0);
    expect(pie.total?.toFixed(2)).toBe('1210.00');
  });

  it('una percepción más se incorpora sin estar prevista en el código', () => {
    /*
     * La cantidad de percepciones no está escrita en ninguna parte, y no puede
     * estarlo: cada jurisdicción agrega la suya y un papel puede traer una, tres
     * o ninguna. Acá van tres, con etiquetas distintas, y el total cierra
     * sumando las tres.
     */
    const pie = pieDe(
      [
        frag('Subtotal', 0, 0.4),
        frag('1.000,00', 0, 0.7),
        frag('IVA 21%', 1, 0.4),
        frag('210,00', 1, 0.7),
        frag('Percepcion IIBB CABA', 2, 0.4),
        frag('15,00', 2, 0.7),
        frag('Percepcion IIBB Buenos Aires', 3, 0.4),
        frag('25,00', 3, 0.7),
        frag('Percepcion Municipal', 4, 0.4),
        frag('10,00', 4, 0.7),
        frag('Total', 5, 0.4),
        frag('1.260,00', 5, 0.7),
      ],
      '1000.00',
    );

    expect(pie.percepciones).toHaveLength(3);
    expect(pie.percepciones.map((p) => p.valor.toFixed(2)).sort()).toEqual([
      '10.00',
      '15.00',
      '25.00',
    ]);
    expect(pie.total?.toFixed(2)).toBe('1260.00');
    expect(pie.totalCalculado).toBe(false);

    // Y cada una informa que no cumple ninguna igualdad, porque no la tiene: su
    // base y su alícuota las fija cada jurisdicción y no salen del neto.
    for (const asignacion of pie.asignaciones.filter((a) => a.concepto === 'percepcion')) {
      expect(asignacion.igualdad).toBeNull();
      expect(asignacion.etiqueta).not.toBeNull();
    }
  });

  it('una percepción mal leída no entra: sin igualdad propia, la lectura tiene que ser literal', () => {
    /*
     * Una percepción no tiene relación que la verifique, así que lo único que la
     * sostiene es el papel. Un valor que necesita suponer un separador perdido
     * no alcanza: sobre una de las fotos eso metía un «033,» recortado como una
     * percepción de treinta y tres pesos.
     */
    const pie = pieDe(
      [
        frag('Subtotal', 0, 0.4),
        frag('1.000,00', 0, 0.7),
        frag('Percepcion IIBB', 1, 0.4),
        frag('033,', 1, 0.7),
      ],
      '1000.00',
    );
    expect(pie.percepciones).toHaveLength(0);
  });

  it('el número de la resolución que crea la percepción no es la percepción', () => {
    /*
     * «Percepción IVA RG 5329» trae la palabra que importa y después el número
     * de la resolución general que la crea. Sin distinguirlos, ese 5329 entra
     * como una percepción de cinco mil trescientos veintinueve pesos y el total
     * del comprobante se va de cauce por ese monto. Es una distinción de
     * lenguaje y no de magnitud: lo que viene detrás de «RG» nombra una norma.
     */
    const pie = pieDe(
      [
        frag('Subtotal', 0, 0.4),
        frag('1.000,00', 0, 0.7),
        frag('Percepcion IVA RG', 1, 0.45),
        frag('5329', 1, 0.7),
        frag('Percepcion IIBB', 2, 0.45),
        frag('15,00', 2, 0.7),
      ],
      '1000.00',
    );

    expect(pie.percepciones.map((p) => p.valor.toFixed(2))).toEqual(['15.00']);
    expect(pie.asignaciones.some((a) => a.valor.toFixed(2) === '5329.00')).toBe(false);
  });

  it('un importe escrito de otra manera que el resto del pie no entra', () => {
    /*
     * La misma idea que la hipótesis de formato de una columna del detalle,
     * aplicada al pie: un número escrito de otra manera que sus vecinos es un
     * número mal leído. Hace falta justo donde la evidencia es más débil,
     * porque una percepción no tiene igualdad propia que la verifique: si
     * además se acepta con cualquier formato, cualquier cifra suelta que caiga
     * cerca de la palabra «percepción» entra al pie. Un pie que imprime
     * «1.000,00» no imprime «1».
     */
    const pie = pieDe(
      [
        frag('Subtotal', 0, 0.4),
        frag('1.000,00', 0, 0.7),
        frag('Percepcion IIBB', 1, 0.45),
        frag('1', 1, 0.7),
        frag('Percepcion CABA', 2, 0.45),
        frag('15,00', 2, 0.7),
      ],
      '1000.00',
    );
    expect(pie.percepciones.map((p) => p.valor.toFixed(2))).toEqual(['15.00']);
  });

  it('el importe de la percepción no se descarta por compartir línea con «RG»', () => {
    /*
     * El otro lado de la regla de los identificadores, y el error que costó
     * medirlo: «Percepción IVA RG» termina en «RG» y el importe de esa
     * percepción está a media pulgada a la derecha. Mirando la última palabra
     * de la etiqueta, el importe verdadero se descartaba junto con el número de
     * la resolución. Lo que hace a un número un identificador es estar
     * **pegado** al marcador, no compartir línea con él.
     */
    const pie = pieDe(
      [
        frag('Subtotal', 0, 0.4),
        frag('1.000,00', 0, 0.7),
        frag('Percepcion IVA RG', 1, 0.3),
        frag('15,00', 1, 0.7),
      ],
      '1000.00',
    );
    expect(pie.percepciones.map((p) => p.valor.toFixed(2))).toEqual(['15.00']);
  });

  it('el porcentaje impreso al lado de una percepción no es una percepción', () => {
    const pie = pieDe(
      [
        frag('Subtotal', 0, 0.4),
        frag('1.000,00', 0, 0.7),
        frag('Perc IIBB CABA', 1, 0.3),
        frag('1,50%', 1, 0.5),
        frag('15,00', 1, 0.7),
        frag('Total', 2, 0.4),
        frag('1.015,00', 2, 0.7),
      ],
      '1000.00',
    );
    expect(pie.percepciones).toHaveLength(1);
    expect(pie.percepciones[0].valor.toFixed(2)).toBe('15.00');
  });
});

describe('el estado del pie: leído, inferido, calculado o faltante', () => {
  it('un pie leído entero que cierra está completo', () => {
    /*
     * Las tres etiquetas enteras y sin dígitos pegados, que es el caso en que
     * las tres asignaciones son del papel: el número **y** el concepto.
     */
    const pie = pieDe(
      [
        frag('Subtotal', 0, 0.4),
        frag('1.000,00', 0, 0.7),
        frag('IVA', 1, 0.4),
        frag('210,00', 1, 0.7),
        frag('Total', 2, 0.4),
        frag('1.210,00', 2, 0.7),
      ],
      '1000.00',
    );
    expect(pie.estado).toBe('completo');
    expect(pie.faltantes).toEqual([]);
    expect(pie.residuo).toBeNull();
    expect(pie.asignaciones.every((a) => a.procedencia === 'READ_FROM_DOCUMENT')).toBe(true);
  });

  it('un total calculado NO completa el pie', () => {
    /*
     * La corrección que pidió medirse: un total que sale de una cuenta puede
     * ayudar a revisar y no convierte el pie en completo, y sobre todo no se
     * informa como importe impreso. Es el número contra el que se paga.
     */
    const pie = pieDe(
      [
        frag('Subtotal', 0, 0.4),
        frag('1.000,00', 0, 0.7),
        frag('IVA 21%', 1, 0.4),
        frag('210,00', 1, 0.7),
      ],
      '1000.00',
    );
    expect(pie.totalCalculado).toBe(true);
    expect(pie.estado).toBe('parcial');
    expect(pie.faltantes.join(' ')).toContain(DERIVED_SUGGESTION);
    // Y no hay ninguna asignación de total: no existe el fragmento.
    expect(pie.asignaciones.some((a) => a.concepto === 'total')).toBe(false);
  });

  it('un concepto que no se leyó deja el pie parcial y se informa el hueco, sin crearlo', () => {
    /*
     * El total impreso dice mil trescientos y la suma de lo leído da mil
     * doscientos diez: los noventa pesos de diferencia **permiten sospechar**
     * que hay una percepción que el OCR no pudo leer, y no autorizan a crearla.
     * Ni concepto, ni importe, ni etiqueta: sólo el hueco, medido.
     */
    const pie = pieDe(
      [
        frag('Subtotal', 0, 0.4),
        frag('1.000,00', 0, 0.7),
        frag('IVA 21%', 1, 0.4),
        frag('210,00', 1, 0.7),
        frag('Total', 3, 0.4),
        frag('1.300,00', 3, 0.7),
      ],
      '1000.00',
    );

    expect(pie.estado).toBe('parcial');
    expect(pie.residuo?.toFixed(2)).toBe('90.00');
    expect(pie.faltantes.join(' ')).toContain('90.00');
    expect(pie.faltantes.join(' ')).toContain('sospechar');

    // Y no apareció ninguna percepción de noventa pesos de la nada.
    expect(pie.percepciones).toHaveLength(0);
    expect(pie.asignaciones.some((a) => a.valor.toFixed(2) === '90.00')).toBe(false);
    expect(pie.total?.toFixed(2)).toBe('1300.00');
  });

  it('distingue el valor leído del concepto inferido por una igualdad', () => {
    /*
     * Las dos procedencias que se parecen y no son lo mismo. El IVA sin
     * etiqueta es del papel en su **valor** y del motor en su **concepto**: lo
     * que dice que ese número es el IVA es la igualdad, no una palabra impresa.
     * Si la igualdad se sostenía en un neto mal leído, el concepto está mal
     * asignado aunque el número sea correcto, y eso hay que poder verlo.
     */
    const pie = pieDe(
      [
        frag('Neto Gravado', 0, 0.4),
        frag('1.000,00', 0, 0.7),
        frag('210,00', 1, 0.7),
        frag('Total', 2, 0.4),
        frag('1.210,00', 2, 0.7),
      ],
      '1000.00',
    );

    const porEtiqueta = pie.asignaciones.filter((a) => a.procedencia === 'READ_FROM_DOCUMENT');
    const porIgualdad = pie.asignaciones.filter(
      (a) => a.procedencia === 'INFERRED_FROM_DOCUMENT_RELATIONS',
    );
    expect(porEtiqueta.map((a) => a.concepto)).toContain('netoGravado');
    expect(porIgualdad.map((a) => a.concepto)).toEqual(['iva']);
    // Y el inferido tiene el fragmento del papel igual: lo inferido es el
    // concepto, no el número.
    expect(porIgualdad[0].origen.texto).toBe('210,00');
  });

  it('sin ninguna asignación el pie está ausente, no completo', () => {
    const pie = pieDe([frag('Comprobante Autorizado', 0, 0.4)], null);
    expect(pie.estado).toBe('ausente');
  });
});

describe('lo que no se puede decidir, y lo que no se puede inventar', () => {
  it('dos asignaciones sin margen suficiente mandan a revisión', () => {
    /*
     * Dos números distintos con la palabra «Total» al lado, ninguno de los dos
     * cerrando el sistema, los dos leídos literalmente. No hay una respuesta:
     * hay dos, y elegir la primera es tirar una moneda con el número contra el
     * que se paga.
     */
    const pie = pieDe(
      [
        frag('Subtotal', 0, 0.4),
        frag('1.000,00', 0, 0.7),
        frag('Total', 1, 0.4),
        frag('9.999,00', 1, 0.7),
        frag('Total', 2, 0.4),
        frag('8.888,00', 2, 0.7),
      ],
      '1000.00',
    );

    expect(pie.enRevision.join(' ')).toContain('total');
    const delTotal = pie.asignaciones.find((a) => a.concepto === 'total')!;
    expect(delTotal.segunda).not.toBeNull();
    expect(delTotal.margen).toBe(0);
  });

  it('el total que no está en el papel se informa calculado, nunca como leído', () => {
    const pie = pieDe(
      [
        frag('Subtotal', 0, 0.4),
        frag('1.000,00', 0, 0.7),
        frag('IVA 21%', 1, 0.4),
        frag('210,00', 1, 0.7),
      ],
      '1000.00',
    );

    expect(pie.total?.toFixed(2)).toBe('1210.00');
    expect(pie.totalCalculado).toBe(true);
    expect(pie.enRevision.join(' ')).toContain('calculado y no leído');
    // Y no hay ninguna asignación de total: no hay fragmento del que salga.
    expect(pie.asignaciones.some((a) => a.concepto === 'total')).toBe(false);
  });

  it('cada asignación informa todo lo que hizo falta para sostenerla', () => {
    const pie = pieDe(
      [
        frag('Subtotal', 0, 0.4),
        frag('1.000,00', 0, 0.7),
        frag('IVA 21%', 1, 0.4),
        frag('210,00', 1, 0.7),
        frag('Total', 2, 0.4),
        frag('1.210,00', 2, 0.7),
      ],
      '1000.00',
    );

    for (const asignacion of pie.asignaciones) {
      // Fragmento de origen, con su caja, su pasada y su confianza.
      expect(asignacion.origen.texto).not.toBe('');
      expect(asignacion.origen.caja.x1).toBeGreaterThan(asignacion.origen.caja.x0);
      expect(asignacion.origen.pasada).not.toBe('');
      // Lectura literal, alternativas reparadas y costo.
      expect(asignacion.lecturaLiteral).not.toBeNull();
      expect(Array.isArray(asignacion.alternativas)).toBe(true);
      expect(asignacion.costoDeReparacion).toBe(0);
      // Concepto, alícuota cuando está impresa, igualdad y margen.
      expect(asignacion.concepto).not.toBe('');
      expect(asignacion.margen).toBeGreaterThanOrEqual(0);
      expect(asignacion.margen).toBeLessThanOrEqual(1);
    }

    const delIva = pie.asignaciones.find((a) => a.concepto === 'iva')!;
    expect(delIva.alicuota?.toString()).toBe('0.21');
  });
});

describe('sobre las cuatro facturas reales', () => {
  function informe(nombre: string) {
    const evidencia: EvidenciaDeLectura = JSON.parse(
      readFileSync(path.join(DIRECTORIO, `${nombre}.json`), 'utf8'),
    );
    return interpretarReconstruccion(evidencia, { cuitDelReceptor: '27-33342291-9' });
  }

  const BARRAZA = informe('barraza');
  const EZRA = informe('ezra');
  const MABELHERDI = informe('mabelherdi');
  const ERRECALDE = informe('errecalde');

  it('Barraza: neto, IVA, una percepción y el total con la etiqueta destruida', () => {
    const pie = BARRAZA.pieFiscal;
    expect(pie.netoGravado?.toFixed(2)).toBe('473232.44');
    expect(pie.iva).toHaveLength(1);
    expect(pie.iva[0].valor.toFixed(2)).toBe('99378.81');
    expect(pie.iva[0].alicuota?.toString()).toBe('0.21');
    expect(pie.percepciones).toHaveLength(1);
    expect(pie.percepciones[0].valor.toFixed(2)).toBe('7098.49');
    expect(pie.total?.toFixed(2)).toBe('579709.74');
    expect(pie.totalCalculado).toBe(false);

    /*
     * Y el total se identificó con la igualdad, no con la etiqueta: el OCR
     * devolvió «EATAL EPATAL» donde el papel dice «TOTAL».
     */
    const delTotal = pie.asignaciones.find((a) => a.concepto === 'total')!;
    expect(delTotal.etiqueta?.exacta).toBe(false);
    expect(delTotal.igualdad).toContain('= total');
  });

  it('Ezra: el pie entero, con el neto a tres decimales y el papel a dos', () => {
    const pie = EZRA.pieFiscal;
    expect(pie.netoGravado?.toFixed(2)).toBe('221388.84');
    expect(pie.iva[0].valor.toFixed(2)).toBe('46491.66');
    expect(pie.total?.toFixed(2)).toBe('267880.50');
    expect(pie.percepciones).toHaveLength(0);
  });

  it('Mabelherdi: neto, IVA, percepción y total, y el total cierra el sistema', () => {
    const pie = MABELHERDI.pieFiscal;
    expect(pie.netoGravado?.toFixed(2)).toBe('32998.85');
    expect(pie.iva[0].valor.toFixed(2)).toBe('6929.76');
    expect(pie.percepciones).toHaveLength(1);
    expect(pie.percepciones[0].valor.toFixed(2)).toBe('577.48');
    expect(pie.total?.toFixed(2)).toBe('40506.09');
    const delTotal = pie.asignaciones.find((a) => a.concepto === 'total')!;
    expect(delTotal.igualdad).toContain('= total');
  });

  it('Errecalde: el pie está PARCIAL, y se dice de cuánto es el hueco', () => {
    /*
     * El estado honesto de este comprobante. Están leídos el neto, una
     * percepción y el total; el IVA está inferido por la igualdad; y la
     * percepción de IIBB **no se recuperó**, así que la suma de los conceptos
     * queda por debajo del total impreso.
     *
     * Esa diferencia no se convierte en una percepción. Se informa de cuánto
     * es y queda pedida: si el motor la creara, el pie cerraría y el
     * comprobante se cargaría con un impuesto de importe inventado.
     */
    const pie = ERRECALDE.pieFiscal;
    expect(pie.estado).toBe('parcial');
    expect(pie.residuo).not.toBeNull();
    expect(pie.faltantes.join(' ')).toContain('sospechar');

    // El hueco tiene el tamaño de un concepto entero, no de un redondeo.
    expect(pie.residuo!.abs().gt(1000)).toBe(true);

    // Y no hay ninguna percepción cuyo importe sea justo el hueco.
    for (const percepcion of pie.percepciones) {
      expect(percepcion.valor.eq(pie.residuo!.abs())).toBe(false);
    }
  });

  it('Errecalde: el IVA sale de la igualdad, sin una etiqueta que lo diga', () => {
    /*
     * Es el pie que el lector por etiquetas no podía leer: «UBTOTA» por
     * subtotal, el importe del IVA sin ninguna palabra al lado, y el neto y su
     * etiqueta en dos columnas a dos alturas de renglón de distancia.
     *
     * Sale igual. El neto por su etiqueta degradada —«Neto Gravado», encontrada
     * una línea más arriba que su valor— y el IVA por la única cosa que lo
     * identifica: es el 21 % de ese neto.
     */
    const pie = ERRECALDE.pieFiscal;
    expect(pie.netoGravado?.toFixed(2)).toBe('3830467.37');

    expect(pie.iva).toHaveLength(1);
    expect(pie.iva[0].alicuota?.toString()).toBe('0.21');
    const delIva = pie.asignaciones.find((a) => a.concepto === 'iva')!;
    expect(delIva.etiqueta).toBeNull();
    expect(delIva.igualdad).toContain('21 % = IVA');

    // Y por lo menos una percepción, leída literalmente.
    expect(pie.percepciones.length).toBeGreaterThanOrEqual(1);
    for (const asignacion of pie.asignaciones.filter((a) => a.concepto === 'percepcion')) {
      expect(asignacion.costoDeReparacion).toBe(0);
    }
  });

  it('ninguna de las cuatro presenta como leído un total que no está en el papel', () => {
    for (const [nombre, informe] of [
      ['Barraza', BARRAZA],
      ['Ezra', EZRA],
      ['Mabelherdi', MABELHERDI],
      ['Errecalde', ERRECALDE],
    ] as const) {
      const pie = informe.pieFiscal;
      if (pie.totalCalculado) {
        // Si se calculó, tiene que estar dicho, no puede tener asignación, y el
        // pie **no** puede quedar completo.
        expect(pie.enRevision.join(' '), nombre).toContain('calculado y no leído');
        expect(pie.asignaciones.some((a) => a.concepto === 'total'), nombre).toBe(false);
        expect(pie.estado, nombre).not.toBe('completo');
      } else if (pie.total) {
        // Si no se calculó, tiene que venir de un fragmento del papel.
        const delTotal = pie.asignaciones.find((a) => a.concepto === 'total');
        expect(delTotal?.origen.texto, nombre).toBeDefined();
      }
    }
  });
});
