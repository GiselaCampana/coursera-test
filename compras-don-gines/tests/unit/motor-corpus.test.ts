import { describe, it, expect } from 'vitest';
import { interpretar } from '@/lib/ocr/motor/motor';
import { informeEnTexto } from '@/lib/ocr/motor/informe';
import { cantidadQueCuesta } from '@/lib/ocr/motor/candidatas';
import type { InformeDelMotor } from '@/lib/ocr/motor/motor';
import {
  CAE_AJENO,
  CUIT_DEL_RECEPTOR,
  ESTRUCTURA_AMBIDIESTRA,
  ESTRUCTURA_AMBIGUA,
  ESTRUCTURA_CANTIDAD_ADELANTE,
  ESTRUCTURA_CON_MARCA_CONOCIDA,
  ESTRUCTURA_CON_RUIDO_EN_EL_PIE,
  ESTRUCTURA_IMPORTE_BRUTO,
  ESTRUCTURA_KILOS_Y_PIEZAS,
  ESTRUCTURA_OTRO_ORDEN,
  ESTRUCTURA_QUE_NO_CIERRA,
  ESTRUCTURA_SIN_CUIT_DEL_EMISOR,
  SALDO_ACUMULADO_AJENO,
} from '@/../tests/fixtures/motor-corpus';

/**
 * El motor general contra el banco de estructuras, **sin ningún analizador de
 * proveedor**.
 *
 * Ninguna de estas pruebas importa `ezra.ts` ni `barraza.ts`, y ninguno de los
 * emisores del banco existe: las razones sociales y los CUIT son inventados.
 * Ésa es la prueba de fondo del hito. Hasta hoy, cada formato nuevo necesitaba
 * un archivo nuevo en el repositorio; lo que se verifica acá es que las mismas
 * estructuras se resuelven **por cómo están armadas**, y que cambiarles el
 * nombre al emisor no cambia nada.
 *
 * Las tres decisiones que el motor puede tomar están todas probadas, y las tres
 * importan por igual: la que acepta sola, la que frena para que mire una
 * persona y la que rechaza. Un motor que sólo supiera aceptar sería peor que no
 * tener motor, porque cargaría lo que leyó mal en el historial de costos y de
 * ahí sale el precio de venta.
 */

function leer(textos: Parameters<typeof interpretar>[0]): InformeDelMotor {
  return interpretar(textos, { cuitDelReceptor: CUIT_DEL_RECEPTOR });
}

/** Los campos asignados a cada columna, con `—` en las que no se resolvieron. */
function campos(informe: InformeDelMotor): string[] {
  return informe.columnas.map((c) => c?.campo ?? '—');
}

describe('1. la estructura con la cantidad delante, con otro emisor', () => {
  const informe = leer(ESTRUCTURA_CANTIDAD_ADELANTE);

  it('se acepta sola, con las ocho columnas entendidas', () => {
    expect(informe.veredicto.decision).toBe('automatica');
    expect(campos(informe)).toEqual([
      'codigo',
      'cantidad',
      'descripcion',
      'marca',
      'precioUnitario',
      'descuentoPct',
      'precioConDescuento',
      'importe',
    ]);
  });

  it('el emisor sale de su zona y no del CUIT del receptor', () => {
    expect(informe.emisor.cuit).toBe('30-99887766-1');
    expect(informe.emisor.razonSocial).toBe('ALIMENTOS DEL SUR S.R.L.');
  });

  it('el costo sale del precio con descuento y no del de lista', () => {
    /*
     * Es la distinción que rompió la factura de Distribuidora Ezra. El papel
     * imprime los dos precios; cargar el de lista infla el costo de cada
     * artículo entre un 2 % y un 5 %, y el error entra en el historial de
     * costos sin que ninguna suma lo delate, porque el importe sí es correcto.
     */
    const renglones = informe.veredicto.ganadora!.renglones;
    expect(renglones.map((r) => r.precioUnitario?.toString())).toEqual(['6000', '8000', '10000']);
    expect(renglones.map((r) => r.precioConDescuento?.toString())).toEqual(['5700', '7680', '9800']);
    expect(renglones.map((r) => r.importe?.toString())).toEqual(['22800', '19200', '29400']);
  });

  it('los renglones suman el neto impreso y el pie cierra contra sí mismo', () => {
    expect(informe.veredicto.ganadora!.sumaDeRenglones.toString()).toBe('71400');
    expect(informe.pie.netTotal?.toString()).toBe('71400');
    expect(informe.pie.ivaTotal?.toString()).toBe('14994');
    expect(informe.pie.total?.toString()).toBe('86394');
  });
});

describe('2. la estructura con kilos y piezas separados, con otro emisor', () => {
  const informe = leer(ESTRUCTURA_KILOS_Y_PIEZAS);

  it('se acepta sola, con los kilos y las piezas en su lugar', () => {
    expect(informe.veredicto.decision).toBe('automatica');
    expect(campos(informe)).toEqual([
      'codigo',
      'cantidad',
      'piezas',
      'descripcion',
      'precioUnitario',
      'descuentoPct',
      'importe',
    ]);
  });

  it('el costo sale de los kilos y no de las piezas', () => {
    /*
     * Los dos números son cantidades y están uno al lado del otro. Leer el
     * costo de las piezas multiplicaría el precio del cilindro por tres, y la
     * cuenta cerraría igual de bien si no se comparara contra el pie.
     */
    const renglones = informe.veredicto.ganadora!.renglones;
    expect(renglones.map((r) => cantidadQueCuesta(r)?.toString())).toEqual(['20', '30']);
    expect(renglones.map((r) => r.piezas)).toEqual([5, 3]);
  });

  it('el importe impreso se reconoce como neto, no como bruto', () => {
    // 20 × 10.000 × 0,84 = 168.000: la bonificación ya está adentro.
    const renglones = informe.veredicto.ganadora!.renglones;
    expect(renglones.map((r) => r.descuentoEnElImporte)).toEqual([true, true]);
    expect(informe.veredicto.ganadora!.sumaDeRenglones.toString()).toBe('394800');
  });

  it('lee los números a la norteamericana sin que se lo digan', () => {
    expect(informe.pie.netTotal?.toString()).toBe('394800');
    expect(informe.pie.ivaTotal?.toString()).toBe('82908');
    expect(informe.pie.percepciones?.toString()).toBe('5922');
    expect(informe.pie.total?.toString()).toBe('483630');
  });
});

describe('3. una variante compatible: mismos campos, otro orden', () => {
  const informe = leer(ESTRUCTURA_OTRO_ORDEN);

  it('se resuelve igual, sin configurar nada', () => {
    expect(informe.veredicto.decision).toBe('automatica');
    expect(informe.veredicto.ganadora!.sumaDeRenglones.toString()).toBe('71400');
  });

  it('el orden de las columnas no importa: importa qué es cada una', () => {
    expect(campos(informe)).toEqual([
      'codigo',
      'descripcion',
      'cantidad',
      'ignorada',
      'precioUnitario',
      'descuentoPct',
      'precioConDescuento',
      'importe',
      'marca',
    ]);
  });

  it('la columna del precio sugerido se reconoce para descartarla', () => {
    /*
     * «Sugerido» es el precio de venta que sugiere el proveedor: no es el costo
     * ni el importe. Reconocerlo y no usarlo es distinto de ignorarlo: una
     * columna sin reconocer frena el comprobante, y ésta sí se entiende.
     */
    expect(campos(informe)).toContain('ignorada');
    expect(informe.ambiguas).toEqual([]);
  });

  it('es otro formato, así que tiene otra huella', () => {
    const primera = leer(ESTRUCTURA_CANTIDAD_ADELANTE);
    expect(informe.huella).not.toBe(primera.huella);
  });
});

describe('4. un encabezado ambiguo frena para configuración', () => {
  const informe = leer(ESTRUCTURA_AMBIGUA);

  it('no adivina qué es «Desc»', () => {
    expect(informe.ambiguas).toEqual(['Desc']);
    expect(campos(informe)).toContain('—');
  });

  it('no se acepta sola', () => {
    expect(informe.veredicto.decision).toBe('revision-de-estructura');
  });

  it('lo dice en el motivo, para que se sepa qué hay que resolver', () => {
    expect(informe.veredicto.motivo).toContain('Desc');
  });

  it('una columna sin resolver frena aunque la aritmética cierre', () => {
    /*
     * El freno tiene que valer por sí solo. Si dependiera de que además falle
     * alguna cuenta, un formato donde el porcentaje no entra en ninguna
     * igualdad —porque el importe ya viene neto— pasaría solo con una columna
     * cargada en el lugar equivocado.
     *
     * Se comprueba sobre la estructura que sí cierra por todos lados: se le
     * ensucia un solo encabezado y tiene que dejar de aceptarse sola.
     */
    const limpia = leer(ESTRUCTURA_CANTIDAD_ADELANTE);
    expect(limpia.veredicto.decision).toBe('automatica');
    expect(limpia.veredicto.ganadora!.puntaje).toBe(1);

    const conUnaColumnaRara = {
      ...ESTRUCTURA_CANTIDAD_ADELANTE,
      articulos: ESTRUCTURA_CANTIDAD_ADELANTE.articulos!.replace('Marca ', 'Zona  '),
      completo: ESTRUCTURA_CANTIDAD_ADELANTE.completo.replace('Marca ', 'Zona  '),
    };
    const ensuciada = leer(conUnaColumnaRara);
    expect(ensuciada.ambiguas).toEqual(['Zona']);
    expect(ensuciada.veredicto.ganadora!.puntaje).toBe(1);
    expect(ensuciada.veredicto.decision).toBe('revision-de-estructura');
  });
});

describe('5. una interpretación aritméticamente incorrecta se rechaza', () => {
  const informe = leer(ESTRUCTURA_QUE_NO_CIERRA);

  it('no devuelve «lo mejor que encontré»', () => {
    expect(informe.veredicto.decision).toBe('rechazo');
  });

  it('las dos lecturas quedan en cero y se dice por qué', () => {
    for (const candidata of informe.candidatas) {
      expect(candidata.puntaje).toBe(0);
    }
    const motivos = informe.candidatas[0].penalizaciones.map((p) => p.motivo).join(' ');
    expect(motivos).toContain('controles aritméticos de renglón no cierran');
    // La suma tampoco se explica por la precisión con que está impreso el pie.
    expect(motivos).toContain('ni el redondeo ni el truncamiento explican');
  });

  it('la tabla se entendió: lo que falla son los números', () => {
    // Es la distinción que importa. No es que no se encontró la tabla: se
    // encontró, se reconocieron las ocho columnas, y aun así no se puede usar.
    expect(informe.ambiguas).toEqual([]);
    expect(campos(informe)).not.toContain('—');
  });
});

describe('6. dos lecturas sin margen entre ellas quedan en revisión', () => {
  const informe = leer(ESTRUCTURA_AMBIDIESTRA);

  it('las dos cierran perfecto y son distintas', () => {
    /*
     * A la argentina la factura es de 71.400 pesos; a la norteamericana, de
     * 71,40. Las dos lecturas satisfacen todas las igualdades del comprobante,
     * porque las cantidades no llevan separador y el precio y el importe se
     * escalan por mil los dos juntos.
     */
    const [primera, segunda] = [informe.veredicto.ganadora!, informe.veredicto.segunda!];
    expect(primera.puntaje).toBe(1);
    expect(segunda.puntaje).toBe(1);
    expect(primera.sumaDeRenglones.toString()).not.toBe(segunda.sumaDeRenglones.toString());
    expect(
      [primera, segunda].map((c) => c.sumaDeRenglones.toString()).sort(),
    ).toEqual(['71.4', '71400']);
  });

  it('no se elige la primera: se frena', () => {
    expect(informe.veredicto.decision).toBe('revision-de-estructura');
    expect(informe.veredicto.margen).toBe(0);
    expect(informe.veredicto.motivo).toContain('No hay una respuesta: hay dos');
  });

  it('dos caminos que dan el mismo resultado no son dos respuestas', () => {
    /*
     * El contraejemplo, y hace falta: sobre un comprobante sin separadores de
     * miles las dos convenciones dan exactamente los mismos números. Contarlas
     * como dos candidatas dejaría el margen en cero y frenaría un comprobante
     * sobre el que no hay ninguna duda.
     */
    const sinAmbiguedad = leer(ESTRUCTURA_KILOS_Y_PIEZAS);
    const [ar, us] = sinAmbiguedad.candidatas;
    expect(ar.puntaje).toBe(us.puntaje);
    expect(ar.sumaDeRenglones.toString()).toBe(us.sumaDeRenglones.toString());
    expect(sinAmbiguedad.veredicto.segunda).toBeNull();
    expect(sinAmbiguedad.veredicto.decision).toBe('automatica');
  });
});

describe('7. los números del pie que no son del comprobante', () => {
  const informe = leer(ESTRUCTURA_CON_RUIDO_EN_EL_PIE);

  it('el saldo acumulado no entra en el pie fiscal, y es más grande que el total', () => {
    /*
     * Es el que más peligro tiene: si se cuela entre los candidatos a neto,
     * gana por tamaño y la factura queda cargada con la deuda entera de la
     * cuenta corriente.
     */
    expect(informe.pie.netTotal?.toString()).toBe('71400');
    expect(informe.pie.total?.toString()).toBe('86394');
    expect(Number(SALDO_ACUMULADO_AJENO)).toBeGreaterThan(Number(informe.pie.total!));
    for (const valor of [informe.pie.netTotal, informe.pie.ivaTotal, informe.pie.total]) {
      expect(valor?.toString()).not.toBe(SALDO_ACUMULADO_AJENO);
    }
  });

  it('el CAE, el CUIT, los ingresos brutos y los kilos tampoco', () => {
    const etiquetas = informe.pie.ignorados.map((i) => i.etiqueta);
    expect(etiquetas).toContain('saldo acumulado');
    expect(etiquetas).toContain('CAE');
    expect(etiquetas).toContain('CUIT');
    expect(etiquetas).toContain('ingresos brutos');
    expect(etiquetas).toContain('total de kilos');
  });

  it('lo descartado queda anotado, no desaparece', () => {
    // Poder revisar la decisión es la mitad del punto: un número que se tiró en
    // silencio no se puede recuperar cuando resulta que hacía falta.
    const valores = informe.pie.ignorados.map((i) => i.valor);
    expect(valores).toContain(SALDO_ACUMULADO_AJENO);
    expect(valores).toContain(CAE_AJENO);
  });

  it('con todo ese ruido, el comprobante se acepta igual', () => {
    expect(informe.veredicto.decision).toBe('automatica');
    expect(informe.veredicto.ganadora!.sumaDeRenglones.toString()).toBe('71400');
  });
});

describe('8. una marca conocida adentro de los artículos', () => {
  const informe = leer(ESTRUCTURA_CON_MARCA_CONOCIDA);
  const sinMarcaConocida = leer(ESTRUCTURA_CANTIDAD_ADELANTE);

  it('el emisor no cambia porque una marca sea proveedora de la casa', () => {
    /*
     * Es lo que hacía que la factura de Distribuidora Ezra se la quedara el
     * analizador de Los Calvos: «LOS CALVOS» aparecía en el texto de la página
     * y con eso alcanzaba para reclamarla. El comprobante entero se atribuía al
     * proveedor equivocado: la deuda, el pago y el historial de costos.
     */
    expect(informe.veredicto.ganadora!.renglones.map((r) => r.marca)).toEqual([
      'LOS CALVOS',
      'LOS CALVOS',
      'BARRAZA',
    ]);
    expect(informe.emisor.razonSocial).toBe('ALIMENTOS DEL SUR S.R.L.');
    expect(informe.emisor.cuit).toBe('30-99887766-1');
  });

  it('sin el CUIT del emisor, se queda sin CUIT: no toma el del receptor', () => {
    /*
     * El CUIT de Don Ginés está impreso en todas las facturas de todos los
     * proveedores, así que es el que agarra cualquier motor que busque «el
     * primer CUIT de la página». Con él, todos los comprobantes del archivo se
     * atribuirían al mismo emisor.
     *
     * Un dato que falta se completa en la revisión; uno que está mal no se
     * nota.
     */
    const sinCuit = leer(ESTRUCTURA_SIN_CUIT_DEL_EMISOR);
    expect(sinCuit.emisor.cuit).toBeNull();
    expect(sinCuit.emisor.razonSocial).toBe('ALIMENTOS DEL SUR S.R.L.');
  });

  it('el perfil tampoco: la huella no lleva nada del contenido', () => {
    expect(informe.huella).toBe(sinMarcaConocida.huella);
  });

  it('la huella no menciona ninguna marca ni ningún emisor', () => {
    for (const contenido of [
      'CALVOS',
      'BARRAZA',
      'ALIMENTOS',
      'Cremoso',
      '22.800',
      '99887766',
    ]) {
      expect(informe.huella, `la huella no puede contener «${contenido}»`).not.toContain(contenido);
    }
  });

  it('y el comprobante se lee igual de bien', () => {
    expect(informe.veredicto.decision).toBe('automatica');
    expect(informe.veredicto.ganadora!.sumaDeRenglones.toString()).toBe('71400');
  });
});

describe('el importe impreso en bruto, que es la otra forma de imprimir un descuento', () => {
  const informe = leer(ESTRUCTURA_IMPORTE_BRUTO);

  it('se da cuenta de que el descuento todavía no está aplicado', () => {
    /*
     * Las dos formas están en el banco de facturas y los dos papeles se ven
     * iguales: una columna de porcentaje y una de importe. Lácteos Barraza
     * imprime el importe neto; Los Calvos imprime el bruto y descuenta la
     * bonificación recién al pie.
     *
     * Tomar una de las dos por convención carga el costo con un 14 % o un 16 %
     * de error en la mitad de los proveedores. Lo decide la aritmética: acá
     * 10 × 4.000 = 40.000 es el importe impreso, así que es el bruto.
     */
    const renglones = informe.veredicto.ganadora!.renglones;
    expect(renglones.map((r) => r.descuentoEnElImporte)).toEqual([false, false]);
    expect(renglones.map((r) => r.importe?.toString())).toEqual(['40000', '60000']);
  });

  it('el neto del renglón descuenta la bonificación, y la suma da el neto impreso', () => {
    // 100.000 de bruto menos el 14 % son 86.000, que es el neto gravado.
    expect(informe.veredicto.ganadora!.sumaDeRenglones.toString()).toBe('86000');
    expect(informe.pie.netTotal?.toString()).toBe('86000');
    expect(informe.veredicto.decision).toBe('automatica');
  });

  it('la hipótesis contraria no cierra, y por eso se descarta', () => {
    // La prueba de que la elección es de la aritmética y no de una preferencia:
    // con el descuento adentro, 10 × 3.440 daría 34.400 contra 40.000 impresos.
    const detalle = informe.veredicto
      .ganadora!.renglones[0].controles.map((c) => c.detalle)
      .join(' ');
    expect(detalle).toContain('todavía sin aplicar');
  });
});

describe('el informe que el motor deja de cada comprobante', () => {
  it('explica la decisión con todo lo que hizo falta para tomarla', () => {
    /*
     * Un motor que decide solo tiene que poder explicarse. Sin esto, un error
     * de interpretación se descubre semanas después, en el costo de un artículo
     * que no cierra.
     */
    const texto = informeEnTexto(leer(ESTRUCTURA_CANTIDAD_ADELANTE));

    for (const parte of [
      'EMISOR',
      'ALIMENTOS DEL SUR S.R.L.',
      '30-99887766-1',
      'Huella del formato',
      'COLUMNAS',
      '«P.U.Desc.» → precioConDescuento',
      'PIE FISCAL',
      'RENGLONES',
      'Neto del renglón',
      'CIERRA · cantidad-por-precio',
      'LECTURAS',
      '← GANADORA',
      '← SEGUNDA',
      'DECISIÓN',
      'AUTOMATICA',
      'Margen sobre la segunda',
    ]) {
      expect(texto, `el informe tiene que decir «${parte}»`).toContain(parte);
    }
  });

  it('cuando frena, el informe dice qué columna hay que resolver', () => {
    const texto = informeEnTexto(leer(ESTRUCTURA_AMBIGUA));
    expect(texto).toContain('«Desc» → SIN RESOLVER');
    expect(texto).toContain('Ambiguas: «Desc»');
    expect(texto).toContain('REVISION-DE-ESTRUCTURA');
  });

  it('cuando rechaza, el informe dice qué cuenta no cerró', () => {
    const texto = informeEnTexto(leer(ESTRUCTURA_QUE_NO_CIERRA));
    expect(texto).toContain('RECHAZO');
    expect(texto).toContain('NO CIERRA · cantidad-por-precio');
    expect(texto).toContain('ni el redondeo ni el truncamiento explican');
  });

  it('con dos cantidades, el informe dice cuál es la que cuesta', () => {
    const texto = informeEnTexto(leer(ESTRUCTURA_KILOS_Y_PIEZAS));
    expect(texto).toContain('20 (unidad sin determinar) · 5 piezas');
    expect(texto).toContain('La que cuesta: 20 (las piezas son el movimiento físico, no el costo)');
    expect(texto).toContain('ya tiene el descuento');
  });

  it('no dice «kilos» cuando la columna sólo dice «Cantidad»', () => {
    /*
     * En este formato los 20 SON kilos —el artículo es «CIL MUZZA X 4 KG» y son
     * cinco cilindros—, pero el encabezado dice «Cantidad» a secas y nada en el
     * comprobante lo afirma. El motor no infiere la unidad por el nombre de la
     * columna ni por el del artículo.
     *
     * Es deliberado y cuesta algo: la unidad se resuelve en la revisión o en el
     * perfil del formato. Inventarla es peor, porque un costo por kilo y uno
     * por pieza se ven iguales en la pantalla y difieren por un factor de
     * cuatro.
     */
    const informe = leer(ESTRUCTURA_KILOS_Y_PIEZAS);
    expect(informe.veredicto.ganadora!.renglones.map((r) => r.kilos)).toEqual([null, null]);
    expect(informeEnTexto(informe)).not.toContain('20 kg');
  });
});
