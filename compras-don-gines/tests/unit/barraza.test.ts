import { describe, it, expect } from 'vitest';
import { elegirAnalizador, analizadorBarraza, analizadorErrecalde } from '@/lib/ocr/parsers';
import {
  analizarArticulosBarraza,
  asignarPreciosPorElNeto,
  esqueletosDeFila,
  kgPorPiezaDeLaDescripcion,
  soloElPie,
} from '@/lib/ocr/parsers/barraza';
import { BARRAZA_FOTO } from '../fixtures/barraza-foto';
import {
  BARRAZA_ARTICULOS_IMPRESOS,
  BARRAZA_ENCABEZADO,
  BARRAZA_PIE,
  BARRAZA_TOTALES,
} from '../fixtures/barraza';
import { Decimal } from '@/lib/money';

/**
 * La factura de Lácteos Barraza, sobre el texto real de la foto.
 *
 * El defecto que la trajo al proyecto **no es el de Ezra**. Ahí las columnas se
 * corrían dentro de la misma fila y una transcripción prolija lo reproducía.
 * Acá el problema es espacial y sólo existe en la foto: Tesseract pone el
 * precio del renglón 30 sobre la línea de texto del renglón 03.
 *
 *     03    27.00    9.00 | CIL MUZZA BARRAZA X 3 KG      9453.76
 *                                                         ↑ el precio del OTRO
 *
 * Por eso todo lo que se afirma acá se afirma contra `BARRAZA_FOTO`, que es lo
 * que salió de Tesseract sin retocar.
 */

/**
 * El neto de un renglón: el impreso, o el que el dominio va a calcular.
 *
 * En este formato la columna «Importe» del papel es el **neto**, y el bruto
 * —kilos × precio de lista— no está impreso. El analizador declara el precio de
 * lista y la bonificación, y deja que el dominio haga la cuenta; acá se hace la
 * misma para poder afirmar contra el papel.
 */
function netoDelRenglon(item: { quantity?: string | null; unitNetPrice?: string | null; discountPct?: string | null; netAmount?: string | null }): Decimal {
  if (item.netAmount) return new Decimal(item.netAmount);
  const bruto = new Decimal(item.quantity!).times(item.unitNetPrice!);
  return bruto.times(new Decimal(1).minus(item.discountPct ?? '0')).toDecimalPlaces(2);
}

const analisis = analizadorBarraza.analizar(BARRAZA_FOTO);

describe('a quién se le atribuye la factura de Barraza', () => {
  it('la toma el analizador de Barraza', () => {
    expect(elegirAnalizador(BARRAZA_FOTO).analizador.codigo).toBe('barraza');
  });

  it('el CUIT del receptor nunca identifica al proveedor', () => {
    /*
     * 27-33342291-9 es el de Don Ginés y está impreso en **todas** las
     * facturas. Un analizador que reconociera por él se quedaría con los
     * comprobantes de todos los proveedores.
     */
    expect(BARRAZA_FOTO.completo).toContain('27333422919');

    const ajena = {
      completo:
        'DISTRIBUCION ERRECALDE S.A.\nCUIT 30-71780890-4\nC.U.I.T.: 27333422919\n' +
        'Código Descripción Unid. Cantidad Precio Dto. IVA Subtotal\n' +
        'ART-00873 BARRA DANBO 8 39.2 kg $8.090,08 0% 21% $317.131,24\n',
      encabezado: 'DISTRIBUCION ERRECALDE S.A.\nCUIT 30-71780890-4\nC.U.I.T.: 27333422919',
      articulos: null,
      resumen: null,
    };
    expect(analizadorBarraza.reconoce(ajena)).toBe(0);
    // Y la ajena sigue siendo de quien es.
    expect(analizadorErrecalde.reconoce(ajena)).toBeGreaterThan(0);
  });

  it('no se queda con una factura que sólo nombra a Barraza en un artículo', () => {
    /*
     * «MOZZARELLA CILINDRO BARRAZA X3» es un artículo real del catálogo de
     * Errecalde. La marca dentro de la tabla no puede decidir el proveedor: es
     * el mismo defecto que tenía Los Calvos con la factura de Ezra.
     */
    const deErrecalde = {
      completo:
        'DISTRIBUCION ERRECALDE S.A.\nCUIT 30-71780890-4\n' +
        'Código Descripción Unid. Cantidad Precio Dto. IVA Subtotal\n' +
        'ART-00495 MOZZARELLA CILINDRO BARRAZA X3 9 9 kg $8.800,83 0% 21% $79.207,44\n',
      encabezado: 'DISTRIBUCION ERRECALDE S.A.\nCUIT 30-71780890-4',
      articulos: null,
      resumen: null,
    };
    expect(analizadorBarraza.reconoce(deErrecalde)).toBe(0);
  });
});

describe('el encabezado de la factura de Barraza', () => {
  it('recupera proveedor, CUIT del emisor, número y fecha', () => {
    expect(analisis.header?.supplierName).toBe(BARRAZA_ENCABEZADO.supplierName);
    expect(analisis.header?.legalName).toBe(BARRAZA_ENCABEZADO.legalName);
    expect(analisis.header?.cuit).toBe(BARRAZA_ENCABEZADO.cuit);
    expect(analisis.header?.cuit).not.toBe(BARRAZA_ENCABEZADO.cuitDelReceptor);
    expect(analisis.header?.letter).toBe('A');
    expect(analisis.header?.docType).toBe('FACTURA');
    expect(analisis.header?.fullNumber).toBe(BARRAZA_ENCABEZADO.fullNumber);
    expect(analisis.header?.issueDate).toBe(BARRAZA_ENCABEZADO.issueDate);
  });
});

describe('los dos renglones de la factura de Barraza', () => {
  it('son dos, no tres', () => {
    /*
     * La pantalla mostraba «3 renglones». El detector de filas todavía cuenta
     * tres —es una señal visual y se equivoca—, pero lo que se interpreta y se
     * carga son dos, que es lo que tiene el papel.
     */
    expect(analisis.items).toHaveLength(2);
  });

  it('ni los kilos ni las piezas quedan adentro del nombre', () => {
    /*
     * La marca del defecto: «27.00 9.00 | CIL MUZZA BARRAZA X 3 KG», con las
     * dos cantidades y el borde de la tabla metidos en el texto.
     */
    for (const item of analisis.items) {
      expect(item.description, `renglón ${item.lineNumber}`).not.toMatch(/\d+[.,]\d{2}\s/);
      expect(item.description).not.toContain('|');
    }
  });

  it('conserva el «X 3 KG» del nombre, que es parte del artículo', () => {
    /*
     * El tamaño de la pieza no es una cantidad de la fila: es lo que distingue
     * el cilindro de tres kilos de la plancha de diez. Sin él, los dos
     * artículos se llaman casi igual.
     */
    const descripciones = analisis.items.map((i) => i.description.toUpperCase());
    expect(descripciones).toContain('CIL MUZZA BARRAZA X 3 KG');
    expect(descripciones).toContain('PLAN MUZZA BARRAZA X 10 KG');
  });

  it.each(BARRAZA_ARTICULOS_IMPRESOS.map((a) => [a.descripcion, a] as const))(
    'el renglón «%s» separa kilos, piezas, precio e importe',
    (_descripcion, papel) => {
      const leido = analisis.items.find((i) =>
        i.description.toUpperCase().startsWith(papel.descripcion.slice(0, 12).toUpperCase()),
      );
      expect(leido, `falta el renglón ${papel.codigo}`).toBeDefined();

      // Los kilos, que son la cantidad que cuesta.
      expect(new Decimal(leido!.quantity!).toFixed(2)).toBe(new Decimal(papel.kilos).toFixed(2));
      expect(leido!.unit).toBe('KG');
      // Las piezas, en paralelo y sin confundirse con los kilos.
      expect(leido!.pieceCount).toBe(papel.piezas);
      expect(leido!.pieceCount).not.toBe(Number(papel.kilos));
      // El precio por kilo.
      expect(new Decimal(leido!.unitNetPrice!).toFixed(2)).toBe(
        new Decimal(papel.precioPorKg).toFixed(2),
      );
      // Y el peso total, que es lo que se mueve.
      expect(new Decimal(leido!.totalWeightKg!).toFixed(2)).toBe(
        new Decimal(papel.kilos).toFixed(2),
      );
    },
  );

  it('el precio de un renglón no se le carga al otro', () => {
    /*
     * **Éste es el defecto.** En la foto, la línea del renglón 03 termina en
     * «9453.76», que es el precio del renglón 30. La pantalla mostraba
     * justamente eso: Kilos 9.453,76 en el Renglón 1.
     */
    expect(BARRAZA_FOTO.articulos).toMatch(/CIL MUZZA BARRAZA X 3 KG\s+9453\.76/);

    const cil = analisis.items.find((i) => i.description.toUpperCase().startsWith('CIL'))!;
    const plan = analisis.items.find((i) => i.description.toUpperCase().startsWith('PLAN'))!;

    expect(new Decimal(cil.unitNetPrice!).toFixed(2)).toBe('10361.45');
    expect(new Decimal(plan.unitNetPrice!).toFixed(2)).toBe('9453.76');
    // Y en ningún caso el kilaje es un precio.
    expect(new Decimal(cil.quantity!).lt(100)).toBe(true);
    expect(new Decimal(plan.quantity!).lt(100)).toBe(true);
  });

  it('en cada renglón, kilos × precio × (1 − bonificación) da el importe', () => {
    for (const papel of BARRAZA_ARTICULOS_IMPRESOS) {
      const kilos = new Decimal(papel.kilos);
      const precio = new Decimal(papel.precioPorKg);
      const factor = new Decimal(1).minus(papel.bonificacion);
      expect(
        kilos.times(precio).times(factor).toDecimalPlaces(2).toFixed(2),
        `${papel.codigo}`,
      ).toBe(new Decimal(papel.neto).toFixed(2));
    }
  });

  it('el costo sale de los kilos y nunca de las piezas', () => {
    /*
     * Con las piezas, el cilindro costaría 234.997,69 ÷ 9 = 26.111 por unidad
     * en lugar de 8.703,62 por kilo. Es un factor de tres en un artículo y de
     * diez en el otro, y va derecho al precio de venta.
     */
    for (const papel of BARRAZA_ARTICULOS_IMPRESOS) {
      const leido = analisis.items.find((i) =>
        i.description.toUpperCase().startsWith(papel.descripcion.slice(0, 12).toUpperCase()),
      )!;
      const conKilos = new Decimal(papel.neto).div(papel.kilos);
      const conPiezas = new Decimal(papel.neto).div(papel.piezas);

      const costoReal = new Decimal(papel.neto).div(new Decimal(leido.quantity!));
      expect(costoReal.toFixed(2)).toBe(conKilos.toFixed(2));
      expect(costoReal.toFixed(2)).not.toBe(conPiezas.toFixed(2));
    }
  });

  it('los kilos por pieza coinciden con lo que dice el nombre', () => {
    // 27 ÷ 9 = 3 para «X 3 KG» y 30 ÷ 3 = 10 para «X 10 KG». Es una tercera
    // comprobación, independiente de los precios.
    for (const item of analisis.items) {
      const declarado = kgPorPiezaDeLaDescripcion(item.description);
      expect(declarado, item.description).not.toBeNull();
      const calculado = new Decimal(item.quantity!).div(item.pieceCount!);
      expect(calculado.toFixed(2)).toBe(declarado!.toFixed(2));
    }
  });

  it('los kilos suman el «Total Kgs.» impreso y las piezas su total', () => {
    const kilos = analisis.items.reduce((a, i) => a.plus(new Decimal(i.quantity!)), new Decimal(0));
    const piezas = analisis.items.reduce((a, i) => a + (i.pieceCount ?? 0), 0);
    expect(kilos.toFixed(2)).toBe(new Decimal(BARRAZA_TOTALES.kilos).toFixed(2));
    expect(piezas).toBe(BARRAZA_TOTALES.piezas);
  });

  it('el que tiene código legible lo conserva; el otro queda sin código y avisa', () => {
    /*
     * El código 03 se lee. El 30 **no está en ninguna parte del texto** —el
     * único «30» del comprobante es el del CUIT del emisor— así que queda nulo
     * y con aviso, en vez de deducirse del orden de las filas. Un código
     * inventado se aprende como alias y desvía todas las compras siguientes.
     */
    const cil = analisis.items.find((i) => i.description.toUpperCase().startsWith('CIL'))!;
    const plan = analisis.items.find((i) => i.description.toUpperCase().startsWith('PLAN'))!;

    expect(cil.supplierCode).toBe('03');
    expect(plan.supplierCode).toBeNull();
    expect(analisis.observaciones.join(' ')).toMatch(/no se pudo leer su código de proveedor/);
  });

  it('el importe que el OCR rompió se calcula y se declara como no impreso', () => {
    /*
     * El papel dice 234.997,69 y el OCR devuelve 23490760, con dígitos
     * cambiados. El importe se calcula, y `grossSubtotal` queda en null para
     * que el dominio sepa que ese número no se contrastó contra el papel.
     */
    expect(BARRAZA_FOTO.completo).toContain('23490760');
    expect(BARRAZA_FOTO.completo).not.toContain('234,997.69');

    const cil = analisis.items.find((i) => i.description.toUpperCase().startsWith('CIL'))!;
    expect(cil.netAmount).toBeNull();
    expect(analisis.observaciones.join(' ')).toMatch(/el importe no se pudo leer y se calculó/);
    // Y aun así el renglón vale lo que dice el papel, por la aritmética.
    expect(netoDelRenglon(cil).toFixed(2)).toBe('234997.69');

    // El del otro sí estaba, aunque sin separadores: «23823475».
    const plan = analisis.items.find((i) => i.description.toUpperCase().startsWith('PLAN'))!;
    expect(BARRAZA_FOTO.articulos).toContain('23823475');
    expect(new Decimal(plan.netAmount!).toFixed(2)).toBe('238234.75');
  });
});

describe('el pie de la factura de Barraza', () => {
  it('recupera neto, IVA, percepción y total', () => {
    expect(new Decimal(analisis.summary!.netTotal!).toFixed(2)).toBe(
      new Decimal(BARRAZA_PIE.netTotal).toFixed(2),
    );
    expect(new Decimal(analisis.summary!.ivaTotal!).toFixed(2)).toBe(
      new Decimal(BARRAZA_PIE.iva21).toFixed(2),
    );
    expect(new Decimal(analisis.summary!.perceptionsTotal!).toFixed(2)).toBe(
      new Decimal(BARRAZA_PIE.percepcionIibbCaba).toFixed(2),
    );
    expect(new Decimal(analisis.summary!.total!).toFixed(2)).toBe(
      new Decimal(BARRAZA_PIE.total).toFixed(2),
    );
  });

  it('el subtotal impreso dos veces cuenta una sola', () => {
    /*
     * El papel imprime «Subtotal 473,232.44» dos veces y es un único valor.
     * Sumarlo dos veces daría un neto de 946.464,88 y una deuda del doble.
     */
    const dosVeces = (BARRAZA_FOTO.resumen.match(/473,232\.44/g) ?? []).length;
    expect(dosVeces).toBeGreaterThanOrEqual(2);
    expect(new Decimal(analisis.summary!.netTotal!).toFixed(2)).toBe('473232.44');
  });

  it('el saldo acumulado previo no entra en ningún cálculo', () => {
    /*
     * «Saldo Ac. $ 532.848,64» es de la cuenta corriente, no de esta factura, y
     * además es **más grande que el neto**: suelto entre los candidatos podría
     * hacerse pasar por el importe de un renglón y ganar por tamaño.
     */
    expect(BARRAZA_FOTO.resumen).toContain('532848.64');
    const saldo = new Decimal(BARRAZA_PIE.saldoAcumuladoPrevio);

    for (const campo of [
      analisis.summary!.netTotal,
      analisis.summary!.total,
      analisis.summary!.ivaTotal,
      analisis.summary!.perceptionsTotal,
    ]) {
      expect(new Decimal(campo!).eq(saldo)).toBe(false);
    }
    for (const item of analisis.items) {
      expect(netoDelRenglon(item).eq(saldo)).toBe(false);
      expect(new Decimal(item.unitNetPrice!).eq(saldo)).toBe(false);
    }
    // Y el total sigue siendo el del papel, no el del papel más el saldo.
    expect(new Decimal(analisis.summary!.total!).toFixed(2)).toBe('579709.74');
  });

  it('el neto más el IVA y la percepción dan el total impreso', () => {
    const neto = new Decimal(analisis.summary!.netTotal!);
    const iva = new Decimal(analisis.summary!.ivaTotal!);
    const perc = new Decimal(analisis.summary!.perceptionsTotal!);
    expect(neto.plus(iva).plus(perc).toFixed(2)).toBe(new Decimal(BARRAZA_PIE.total).toFixed(2));
  });
});

describe('la factura cierra contra el papel', () => {
  it('los dos importes suman el neto impreso', () => {
    const suma = BARRAZA_ARTICULOS_IMPRESOS.reduce(
      (a, x) => a.plus(new Decimal(x.neto)),
      new Decimal(0),
    );
    expect(suma.toFixed(2)).toBe(new Decimal(BARRAZA_PIE.netTotal).toFixed(2));
  });

  it('no deja observaciones de renglones que falten o sobren', () => {
    expect(analisis.observaciones.filter((o) => /faltan o sobran renglones/.test(o))).toEqual([]);
  });
});

describe('la asignación de precios por el neto', () => {
  it('elige la única combinación que cierra', () => {
    /*
     * Es lo que resuelve el renglón cuyo importe el OCR destruyó. Con los
     * precios cruzados la suma no da:
     *
     *   27 × 10.361,45 × 0,84 + 30 × 9.453,76 × 0,84 = 473.232,44  ✔
     *   27 ×  9.453,76 × 0,84 + 30 × 10.361,45 × 0,84 = 475.519,82  ✘
     */
    const asignados = asignarPreciosPorElNeto(
      [new Decimal('27'), new Decimal('30')],
      [new Decimal('10361.45'), new Decimal('9453.76')],
      new Decimal('16'),
      new Decimal('473232.44'),
    );
    expect(asignados).not.toBeNull();
    expect(asignados!.map((d) => d.toFixed(2))).toEqual(['10361.45', '9453.76']);
  });

  it('no elige nada si ninguna combinación cierra', () => {
    // Un neto que no corresponde a ningún reparto de estos precios.
    expect(
      asignarPreciosPorElNeto(
        [new Decimal('27'), new Decimal('30')],
        [new Decimal('10361.45'), new Decimal('9453.76')],
        new Decimal('16'),
        new Decimal('500000'),
      ),
    ).toBeNull();
  });

  it('no elige nada si cierran dos combinaciones distintas', () => {
    /*
     * Con dos filas de los mismos kilos, cualquier permutación da el mismo
     * total: no hay forma de saber qué precio va con qué fila, y elegir sería
     * tirar una moneda con el costo de cada artículo.
     */
    expect(
      asignarPreciosPorElNeto(
        [new Decimal('10'), new Decimal('10')],
        [new Decimal('100'), new Decimal('200')],
        new Decimal('0'),
        new Decimal('3000'),
      ),
    ).toBeNull();
  });
});

describe('lo que se saca del juego antes de mirar los renglones', () => {
  it('la línea del saldo acumulado se clasifica como pie', () => {
    /*
     * Se fija sobre la función y no sobre el resultado final, porque escrito
     * mirando sólo el resultado no probaba nada: la aritmética ya rechazaba el
     * saldo por su cuenta, y quitar la exclusión no hacía fallar ningún caso.
     * Una garantía que no se puede romper no es una garantía.
     */
    /*
     * Se prueba con el saldo **solo en su línea**, que es cuando la exclusión
     * hace falta. En esta foto comparte línea con el Subtotal, así que lo
     * clasifica ese otro rótulo y quitar la regla no cambia nada; escrita
     * contra esa línea, la prueba no probaba la regla sino la coincidencia.
     */
    expect(soloElPie('— Saldo Ac. $ 532848.64 —')).toContain('Saldo Ac');

    // Y una fila de artículos no se clasifica como pie.
    expect(soloElPie('03   27.00   9.00 | CIL MUZZA BARRAZA X 3 KG')).toBe('');
  });

  it('un saldo en su propia línea no llega a los candidatos de los renglones', () => {
    /*
     * El caso que la exclusión existe para cubrir: si el saldo queda suelto y
     * no se lo saca, es el número más grande del comprobante y una búsqueda por
     * tamaño lo prueba antes que cualquier importe de renglón.
     */
    const conSaldoSuelto =
      '03    27.00    9.00 | CIL MUZZA BARRAZA X 3 KG      10,361.45   16.00   234,997.69\n' +
      '30    30.00    3.00 | PLAN MUZZA BARRAZA X 10 KG     9,453.76   16.00   238,234.75\n' +
      '— Saldo Ac. $ 532848.64 —\n' +
      'Subtotal 473,232.44';
    const { items } = analizarArticulosBarraza(conSaldoSuelto, new Decimal('473232.44'));
    expect(items).toHaveLength(2);
    expect(netoDelRenglon(items[0]).toFixed(2)).toBe('234997.69');
    expect(new Decimal(items[0].unitNetPrice!).toFixed(2)).toBe('10361.45');
    expect(netoDelRenglon(items[1]).toFixed(2)).toBe('238234.75');
    expect(new Decimal(items[1].unitNetPrice!).toFixed(2)).toBe('9453.76');
  });

  it('sin excluirlo, el saldo sería el número más grande en juego', () => {
    // Deja escrito por qué importa: es mayor que el neto, así que en una
    // búsqueda por tamaño ganaría antes que cualquier importe de renglón.
    expect(
      new Decimal(BARRAZA_PIE.saldoAcumuladoPrevio).gt(new Decimal(BARRAZA_PIE.netTotal)),
    ).toBe(true);
  });
});

describe('cuando kilos y piezas no coinciden con el nombre', () => {
  it('el renglón se rechaza en vez de cargarse con la cantidad equivocada', () => {
    /*
     * Kilos y piezas invertidos: 9 kg en 27 piezas dan 0,33 kg por pieza, y la
     * descripción dice «X 3 KG». Es la comprobación que no depende de los
     * precios, y la que impide cargar el costo con la cantidad de la otra
     * columna.
     */
    const { items, avisos } = analizarArticulosBarraza(
      '03    9.00    27.00 | CIL MUZZA BARRAZA X 3 KG\nSubtotal 234,997.69',
      new Decimal('234997.69'),
    );
    expect(items).toEqual([]);
    expect(avisos.join(' ')).toMatch(/kg por pieza, y la descripción dice/);
  });

  it('con kilos y piezas en su lugar, el mismo renglón entra', () => {
    // La otra mitad: sin esto, la prueba de arriba pasaría con un analizador
    // que no leyera ningún renglón nunca.
    const { items } = analizarArticulosBarraza(
      '03    27.00    9.00 | CIL MUZZA BARRAZA X 3 KG      10,361.45   16.00   234,997.69\n' +
        'Subtotal 234,997.69',
      new Decimal('234997.69'),
    );
    expect(items).toHaveLength(1);
    expect(items[0].pieceCount).toBe(9);
    expect(new Decimal(items[0].quantity!).toFixed(2)).toBe('27.00');
  });
});

describe('el esqueleto de la fila', () => {
  it('lee código, kilos, piezas y descripción, y descarta lo que sobra a la derecha', () => {
    const esq = esqueletosDeFila(
      '03                    27.00            9.00 | CIL MUZZA BARRAZA X 3 KG                    9453.76',
    );
    expect(esq).toHaveLength(1);
    expect(esq[0].codigo).toBe('03');
    expect(esq[0].kilos.toFixed(2)).toBe('27.00');
    expect(esq[0].piezas).toBe(9);
    expect(esq[0].descripcion).toBe('CIL MUZZA BARRAZA X 3 KG');
    expect(esq[0].kgPorPiezaImpreso!.toFixed(0)).toBe('3');
  });

  it('lee la fila aunque le falte el código', () => {
    const esq = esqueletosDeFila('30.00            3.00 | PLAN MUZZA BARRAZA X 10 KG');
    expect(esq).toHaveLength(1);
    expect(esq[0].codigo).toBeNull();
    expect(esq[0].kilos.toFixed(2)).toBe('30.00');
    expect(esq[0].piezas).toBe(3);
  });

  it('no toma por renglón las líneas del encabezado ni del pie', () => {
    const nada = esqueletosDeFila(
      [
        'Cod           Cantidad” Unidades Descripcion',
        'Total Kgs.       57.00',
        '— Saldo Ac. $ 532848.64 —                     Subtotal          473,232.44',
        'Telefono:                1168123503',
        'C.U.LT.: 27333422919',
        'IVA 21.00 %                99,378.81',
      ].join('\n'),
    );
    expect(nada).toEqual([]);
  });
});
