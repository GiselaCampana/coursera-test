import { describe, it, expect } from 'vitest';
import { Decimal, parseArNumber } from '@/lib/money';
import { analizadorErrecalde, analizarFila } from '@/lib/ocr/parsers/errecalde';

/**
 * Los defectos que sólo aparecieron en Safari, sobre un iPhone de verdad.
 *
 * Las pruebas de `errecalde.test.ts` corren sobre el texto que Tesseract sacó de
 * la misma foto **en Chromium**, y ahí la lectura sale bien. En el teléfono no:
 * el mismo motor, sobre la misma foto, devuelve un texto distinto. No es una
 * diferencia de calidad sino de contenido —el recorte del pie cae en otro lado,
 * el análisis de disposición parte las filas en otros puntos—, así que hay
 * modos de fallar que la corrida de Chromium no ejercita nunca.
 *
 * Por eso estos casos van aparte y con el texto de Safari, aunque sea del mismo
 * comprobante.
 */

describe('el pie sin etiquetas', () => {
  /*
   * Lo que devolvió el teléfono: el recorte del pie trajo los cuatro importes
   * de abajo, cada uno en su propia línea y sin una sola etiqueta al lado. El
   * neto gravado quedó afuera del recorte.
   */
  const PIE_SIN_ETIQUETAS = [
    '$804.398,16',
    '$114.914,02',
    '$67.033,18',
    '$4.816.812,73',
  ].join('\n');

  /*
   * Y en la página completa el neto sí aparece, pero deformado: "63,830.46737"
   * donde el papel dice $3.830.467,37. Sobra un 6 adelante y los separadores
   * están todos mal, así que ninguna regla de miles y decimales lo salva.
   */
  const PAGINA_COMPLETA = [
    'DISTRIBUCION ERRECALDE S.A.  CUIT 30-71780890-4',
    'Factura-Remito A 00008-00002647',
    'Neto Gravado 63,830.46737',
    'ART-00873 BARRA DANBO PUNTA DE AGUA 8 39.2 kg $8.090,08 0% 21% $317.131,24',
  ].join('\n');

  const analisis = analizadorErrecalde.analizar({
    completo: PAGINA_COMPLETA,
    resumen: PIE_SIN_ETIQUETAS,
    articulos: '',
  });

  it('recupera el neto gravado que el recorte no trajo', () => {
    expect(analisis.summary?.netTotal).toBe('3830467.37');
  });

  it('asigna el IVA y las dos percepciones en su orden impreso', () => {
    expect(analisis.summary?.ivaTotal).toBe('804398.16');
    expect(analisis.summary?.perceptionLines?.map((p) => [p.label, p.amount])).toEqual([
      ['Percepción IVA RG 5329', '114914.02'],
      ['Percepción IIBB Buenos Aires', '67033.18'],
    ]);
    expect(analisis.summary?.total).toBe('4816812.73');
  });

  it('el pie recuperado cierra: neto + IVA + percepciones da el total', () => {
    const neto = parseArNumber(analisis.summary!.netTotal!)!;
    const iva = parseArNumber(analisis.summary!.ivaTotal!)!;
    const percepciones = parseArNumber(analisis.summary!.perceptionsTotal!)!;
    expect(neto.plus(iva).plus(percepciones).toFixed(2)).toBe('4816812.73');
  });

  it('no avisa que el pie no cierra', () => {
    expect(analisis.observaciones.filter((o) => /pie/i.test(o))).toEqual([]);
  });

  it('sin rastro del neto en ninguna lectura, no lo inventa', () => {
    /*
     * Ésta es la que le da sentido a la anterior. El neto deducido cierra la
     * cuenta por construcción —sale de restarle al total el IVA y las
     * percepciones—, así que esa igualdad no prueba nada por sí sola. Lo que lo
     * vuelve un dato leído y no inventado es que sus dígitos aparezcan en
     * alguna cifra que el OCR haya visto. Sin ese rastro no se completa nada.
     */
    const sinRastro = analizadorErrecalde.analizar({
      completo: 'DISTRIBUCION ERRECALDE S.A.  CUIT 30-71780890-4\nFactura-Remito A 00008-00002647',
      resumen: PIE_SIN_ETIQUETAS,
      articulos: '',
    });
    expect(sinRastro.summary?.netTotal).toBeNull();
    expect(sinRastro.observaciones.some((o) => /releer los totales/i.test(o))).toBe(true);
  });

  it('con un IVA que no es el 21 % del neto deducido, tampoco lo completa', () => {
    // Si el orden supuesto fuera el equivocado, el IVA deducido no guardaría
    // relación con el neto. Es el control que impide acomodar cualquier
    // conjunto de cuatro números hasta que la resta dé.
    const desordenado = analizadorErrecalde.analizar({
      completo: 'DISTRIBUCION ERRECALDE S.A.  CUIT 30-71780890-4\n1.000.000,00',
      resumen: ['$67.033,18', '$114.914,02', '$804.398,16', '$4.816.812,73'].join('\n'),
      articulos: '',
    });
    expect(desordenado.summary?.netTotal).toBeNull();
  });
});

describe('elegir entre dos lecturas del mismo renglón', () => {
  /*
   * El caso de SARDO BLOQUE, tal como salió del teléfono.
   *
   * Una pasada perdió la coma decimal en los tres números a la vez: leyó 475 kg
   * en vez de 4,75, y un subtotal de $6.315.243 en vez de $63.152,43. Lo
   * incómodo es que esa lectura **cierra sola**: 475 × 13.295,25 da 6.315.243,75,
   * que contra su propio subtotal cuadra. Mirando nada más que el renglón, las
   * dos lecturas son igual de buenas.
   *
   * Lo único que las separa es el pie: un renglón de seis millones no entra en
   * una factura cuyo neto gravado son tres millones y medio.
   */
  const PIE = [
    'Neto Gravado $3.830.467,37',
    'IVA $804.398,16',
    'Percepción IVA RG 5329 $114.914,02',
    'Percepción IIBB Buenos Aires $67.033,18',
    'TOTAL $4.816.812,73',
  ].join('\n');

  const ROTA = 'ART-00758 SARDO BLOQUE MELINCUE  3   475 kg   $13.295,25 0% 21%   $6.315.243,00';
  const BUENA = 'ART-00758 SARDO BLOQUE MELINCUE  3   4.75 kg   $13.295,25 0% 21%   $63.152,43';

  const leer = (articulos: string) =>
    analizadorErrecalde.analizar({
      completo: `DISTRIBUCION ERRECALDE S.A. CUIT 30-71780890-4\n${articulos}\n${PIE}`,
      articulos,
      resumen: PIE,
    });

  it('gana la lectura que cabe en el comprobante, llegue en el orden que llegue', () => {
    for (const [primera, segunda] of [
      [ROTA, BUENA],
      [BUENA, ROTA],
    ]) {
      const analisis = leer(`${primera}\n${segunda}`);
      expect(analisis.items).toHaveLength(1);
      expect(new Decimal(analisis.items[0].grossSubtotal!).toFixed(2)).toBe('63152.43');
      expect(new Decimal(analisis.items[0].quantity!).toString()).toBe('4.75');
    }
  });

  it('gana aunque la lectura imposible sea la más completa de las dos', () => {
    /*
     * Éste es el caso que decide, y el que hace falta para saber que la cota del
     * pie está haciendo el trabajo y no un desempate afortunado.
     *
     * Las franjas no siempre pierden lo mismo: puede pasar —y pasó— que la
     * pasada que rompió los números conserve el código de artículo y la que los
     * leyó bien lo pierda. Ahí cualquier criterio basado en cuánta información
     * trae cada lectura elige la rota, porque objetivamente trae más.
     *
     * La cota del pie es lo único que no depende de eso: seis millones no entran
     * en una factura de tres millones y medio, traiga el renglón el código o no.
     */
    const buenaSinCodigo = 'SARDO BLOQUE MELINCUE  3   4.75 kg   $13.295,25 0% 21%   $63.152,43';
    const analisis = leer(`${ROTA}\n${buenaSinCodigo}`);
    expect(analisis.items).toHaveLength(1);
    expect(new Decimal(analisis.items[0].grossSubtotal!).toFixed(2)).toBe('63152.43');
  });

  it('las dos lecturas se reconocen como el mismo renglón, no como dos artículos', () => {
    // Antes no: al perder la coma cambian los tres números, así que la
    // coincidencia por subtotal desaparece y el renglón entraba dos veces.
    const analisis = leer(`${ROTA}\n${BUENA}`);
    expect(analisis.items).toHaveLength(1);
  });

  it('si la única lectura es la imposible, lo dice en vez de darla por buena', () => {
    const analisis = leer(ROTA);
    expect(analisis.items).toHaveLength(1);
    expect(
      analisis.observaciones.some((o) => /mayor que el neto gravado impreso/i.test(o)),
      `observaciones: ${analisis.observaciones.join(' | ')}`,
    ).toBe(true);
  });

  it('sin pie leído no se descarta nada por tamaño', () => {
    // La cota sale del neto impreso. Si el pie no se pudo leer, no hay contra
    // qué comparar y el renglón se conserva tal como se leyó: inventar un
    // límite sería peor que no tener ninguno.
    const analisis = analizadorErrecalde.analizar({
      completo: `DISTRIBUCION ERRECALDE S.A. CUIT 30-71780890-4\n${ROTA}`,
      articulos: ROTA,
      resumen: '',
    });
    expect(analisis.items).toHaveLength(1);
    expect(new Decimal(analisis.items[0].grossSubtotal!).toFixed(2)).toBe('6315243.00');
  });
});

describe('cuántas filas se llegaron a ver', () => {
  it('cuenta las filas de la tabla y no cuenta dos veces la que sale repetida', async () => {
    const { contarFilasLegibles } = await import('@/lib/cliente/ocr/lector');
    const { ERRECALDE_ARTICULOS } = await import('../fixtures/errecalde-ocr');

    /*
     * La lectura por franjas devuelve casi todos los renglones repetidos, porque
     * las franjas se solapan y además se lee con dos divisiones distintas. Si el
     * conteo no dedujera los repetidos, diría cuarenta y pico de filas sobre una
     * tabla de veintitrés y no serviría para decidir nada.
     */
    const unaVez = contarFilasLegibles(ERRECALDE_ARTICULOS);
    const dosVeces = contarFilasLegibles(`${ERRECALDE_ARTICULOS}\n${ERRECALDE_ARTICULOS}`);
    expect(unaVez).toBe(dosVeces);
    expect(unaVez).toBeGreaterThanOrEqual(20);
  });

  it('no confunde el pie con filas de artículos', async () => {
    const { contarFilasLegibles } = await import('@/lib/cliente/ocr/lector');
    const pie = [
      'Neto Gravado $3.830.467,37',
      'IVA $804.398,16',
      'Percepción IVA RG 5329 $114.914,02',
      'TOTAL $4.816.812,73',
    ].join('\n');
    // Un renglón del pie tiene una etiqueta y un solo importe; una fila de
    // artículo trae por lo menos tres números.
    expect(contarFilasLegibles(pie)).toBe(0);
  });
});

describe('cuándo se puede ahorrar una tanda de OCR', () => {
  it('se saltea la segunda división sólo si la primera superó al detector', async () => {
    const { alcanzaConUnaDivision } = await import('@/lib/cliente/ocr/lector');

    // El caso de esta factura: el detector vio 17 y las franjas recuperaron 23.
    // Ahí la segunda división no va a agregar nada y son minutos de teléfono.
    expect(alcanzaConUnaDivision(23, 17)).toBe(true);

    /*
     * Empatar no alcanza, y es la parte que importa. Que las franjas devuelvan
     * exactamente las 17 que vio el detector puede querer decir que están todas,
     * o que se están perdiendo las mismas seis de abajo. Como no hay forma de
     * distinguirlo, se paga la segunda división: perder un renglón cuesta mucho
     * más que un minuto de lectura.
     */
    expect(alcanzaConUnaDivision(17, 17)).toBe(false);
    expect(alcanzaConUnaDivision(10, 17)).toBe(false);

    // Y sin un conteo del detector no hay contra qué comparar: se lee todo.
    expect(alcanzaConUnaDivision(23, 0)).toBe(false);
  });
});

describe('cuándo NO se asigna el pie por posición', () => {
  /*
   * Suponer el orden impreso es una hipótesis, no una lectura, y sólo se acepta
   * si pasa las cinco condiciones. Cada caso de acá rompe una sola, para que se
   * vea qué está sosteniendo qué. En todos, lo correcto es dejar el pie sin leer
   * y mandar el comprobante a revisión: nunca acomodar los importes hasta que la
   * cuenta dé.
   */
  const CABECERA = 'DISTRIBUCION ERRECALDE S.A. CUIT 30-71780890-4\nFactura-Remito A 00008-00002647';

  const leerPie = (importes: string[], completo = CABECERA) =>
    analizadorErrecalde.analizar({
      completo: `${completo}\n${importes.join('\n')}`,
      resumen: importes.join('\n'),
      articulos: '',
    });

  const sinLeer = (analisis: ReturnType<typeof analizadorErrecalde.analizar>) => {
    expect(analisis.summary?.netTotal).toBeNull();
    expect(analisis.summary?.total).toBeNull();
    expect(
      analisis.observaciones.some((o) => /releer los totales/i.test(o)),
      `observaciones: ${analisis.observaciones.join(' | ')}`,
    ).toBe(true);
  };

  it('con menos importes de los que tiene el pie de este proveedor', () => {
    // Tres números sueltos pueden ser cualquier cosa del papel. El pie de
    // Errecalde tiene cinco renglones, y cuatro sólo si el recorte se comió el
    // neto, que es el de más arriba.
    sinLeer(leerPie(['$804.398,16', '$114.914,02', '$4.816.812,73']));
  });

  it('con un importe de más, encuentra igual los cinco que se verifican', () => {
    /*
     * Este caso cambió de significado, y vale dejarlo anotado.
     *
     * Mientras el pie se armaba suponiendo el orden impreso, un importe de más
     * corría todo y había que rechazar el bloque entero. Desde que los campos se
     * combinan entre pasadas, la cantidad de candidatos deja de ser una señal:
     * juntando el recorte y la página completa siempre hay más de cinco.
     *
     * Lo que sostiene la lectura ya no es cuántos números hay sino que los cinco
     * elegidos se verifiquen entre sí. Acá los cinco correctos están, cierran y
     * el IVA es el 21 % del neto, así que el $1.000 suelto es ruido y se ignora.
     */
    const analisis = leerPie([
      '$1.000,00',
      '$3.830.467,37',
      '$804.398,16',
      '$114.914,02',
      '$67.033,18',
      '$4.816.812,73',
    ]);
    expect(analisis.summary?.netTotal).toBe('3830467.37');
    expect(analisis.summary?.total).toBe('4816812.73');
  });

  it('con importes de más que no arman ningún pie válido, no lee nada', () => {
    // El reverso del anterior: si entre todos los candidatos no hay cinco que
    // cierren y respeten el 21 %, no se completa nada.
    sinLeer(leerPie(['$1.000,00', '$2.500,00', '$7.700,00', '$12.340,00', '$99.999,00']));
  });

  it('cuando el último importe no es el mayor: entonces no es el total', () => {
    // El total es la suma de los otros cuatro, así que tiene que ser el mayor.
    // Si no lo es, el bloque no está en el orden que se supuso.
    sinLeer(
      leerPie(['$3.830.467,37', '$804.398,16', '$114.914,02', '$67.033,18', '$100.000,00']),
    );
  });

  it('con los cinco importes correctos pero desordenados, los reacomoda', () => {
    /*
     * Otro que cambió de significado. El filtro de forma miraba el orden en que
     * venían: si la segunda cifra era más chica que la tercera, el bloque no
     * parecía este pie y se rechazaba.
     *
     * La combinación por campos no mira el orden, mira las relaciones. Estos son
     * los cinco importes correctos con las percepciones adelante del IVA, y como
     * hay una única asignación que cierra y respeta el 21 %, se encuentra.
     * Rechazarlos por venir en otro orden sería tirar una lectura correcta.
     */
    const analisis = leerPie([
      '$3.830.467,37',
      '$67.033,18',
      '$804.398,16',
      '$114.914,02',
      '$4.816.812,73',
    ]);
    expect(analisis.summary?.netTotal).toBe('3830467.37');
    expect(analisis.summary?.ivaTotal).toBe('804398.16');
    expect(analisis.summary?.total).toBe('4816812.73');
  });

  it('cuando los cinco no cierran entre sí', () => {
    sinLeer(
      leerPie(['$3.830.467,37', '$804.398,16', '$114.914,02', '$67.033,18', '$5.000.000,00']),
    );
  });

  it('cuando cierran pero el IVA no es el 21 % del neto', () => {
    /*
     * Éste es el que muestra por qué la igualdad sola no alcanza. Los cinco
     * números suman perfecto —2.000.000 + 400.000 + 100.000 + 50.000 =
     * 2.550.000— pero 400.000 no es el 21 % de 2.000.000, así que el segundo no
     * es el IVA y el orden supuesto es el equivocado. Sin este control, cualquier
     * lista que cierre se acepta con las etiquetas cambiadas de lugar.
     */
    sinLeer(
      leerPie(['$2.000.000,00', '$400.000,00', '$100.000,00', '$50.000,00', '$2.550.000,00']),
    );
  });
});

describe('la asignación por posición es sólo de Errecalde', () => {
  it('el analizador genérico no completa un pie sin etiquetas', async () => {
    /*
     * "El primero es el neto y el último el total" vale para el pie de este
     * proveedor porque sabemos cómo lo imprime. Aplicárselo a un comprobante
     * cuyo formato no conocemos sería inventar con cara de dato: los mismos
     * cinco números podrían estar en otro orden, o no ser un pie.
     */
    const { elegirAnalizador } = await import('@/lib/ocr/parsers');
    const importes = ['$3.830.467,37', '$804.398,16', '$114.914,02', '$67.033,18', '$4.816.812,73'];
    const textos = {
      completo: `PROVEEDOR DESCONOCIDO S.R.L.\n${importes.join('\n')}`,
      resumen: importes.join('\n'),
      articulos: '',
    };

    const { analizador } = elegirAnalizador(textos);
    expect(analizador.codigo).not.toBe('errecalde');

    const analisis = analizador.analizar(textos);
    expect(analisis.summary?.netTotal).toBeNull();
  });
});

describe('cuando el OCR pierde los separadores', () => {
  /*
   * Sobre esta corrida de Safari, tres renglones salieron con los separadores
   * comidos. Los dígitos están todos y en orden; lo que se perdió es dónde iba
   * la coma, y en un caso el importe salió partido en dos.
   *
   * Las lecturas posibles se generan y se prueban contra dos cosas que no
   * dependen de ellas: que cantidad × precio dé el subtotal, y que el subtotal
   * quepa en el neto gravado del comprobante.
   */
  const NETO = new Decimal('3830467.37');

  const casos: { nombre: string; linea: string; cantidad: string; precio: string; subtotal: string }[] = [
    {
      nombre: 'ROQUEFORT AZUL: la cantidad y los dos importes sin coma',
      linea: 'ART-00721 ROQUEFORT AZUL LA QUESERA 8 1921kg 1045208 0% 21% 20078437',
      cantidad: '19.21',
      precio: '10452.08',
      subtotal: '200784.37',
    },
    {
      nombre: 'RICOTA AL VACIO: el subtotal partido en dos tokens',
      linea: 'ART-00714 RICOTA AL VACIO SILVIA 4 14.4 kg $3.170,54 0% 21% $45 65574',
      cantidad: '14.4',
      precio: '3170.54',
      subtotal: '45655.74',
    },
    {
      nombre: 'SARDO BLOQUE: la coma perdida en los tres números a la vez',
      linea: 'ART-00758 SARDO BLOQUE MELINCUE 3 475 kg $13.295,25 0% 21% $6.315.243',
      cantidad: '4.75',
      precio: '13295.25',
      subtotal: '63152.43',
    },
  ];

  for (const caso of casos) {
    it(caso.nombre, () => {
      const fila = analizarFila(caso.linea, NETO);
      expect(fila, 'no se pudo interpretar la fila').not.toBeNull();
      expect(fila!.cantidad.toString()).toBe(caso.cantidad);
      expect(fila!.precio?.toFixed(2)).toBe(new Decimal(caso.precio).toFixed(2));
      expect(fila!.subtotal.toFixed(2)).toBe(new Decimal(caso.subtotal).toFixed(2));
    });
  }

  it('sin el neto del comprobante, la lectura mal escalada de ROQUEFORT gana sola', () => {
    /*
     * Ésta es la que muestra por qué la cota hace falta acá adentro y no sólo
     * al final. La tolerancia de cantidad × precio crece con la cantidad: para
     * 19,21 kg son doce centavos, para 1921 son casi diez pesos. La lectura que
     * multiplicó todo por cien se compra un margen cien veces más grande y
     * cierra sola dentro de él.
     *
     * Sin el neto no hay con qué descartarla; con el neto, un renglón de veinte
     * millones no entra en una factura de tres millones y medio.
     */
    const sinCota = analizarFila(casos[0].linea, null);
    expect(sinCota!.subtotal.toFixed(2)).not.toBe('200784.37');
  });
});

describe('el pie repartido entre dos pasadas', () => {
  /*
   * Lo que devolvió Safari, y que ninguna pasada resuelve sola:
   *
   *   recorte del pie   NetoGravado / $804.398,1 / $114.914,02 / $67.033,18 / $4.816.812,73
   *   página completa   63,830.46737 / $804.398,16 / $114.914,02 / $67.033,18
   *
   * El total bueno está sólo en el recorte. El IVA bueno está sólo en la página
   * completa: en el recorte salió cortado, sin el último dígito ($804.398,1).
   * Las percepciones están bien en las dos. Y el neto no está bien en ninguna:
   * en el recorte quedó la etiqueta sin número, y en la página completa el
   * número está deformado.
   *
   * Con una sola fuente no se llega. Con las dos, sí.
   */
  const RECORTE = [
    'NetoGravado',
    '$804.398,1',
    '$114.914,02',
    '$67.033,18',
    '$4.816.812,73',
  ].join('\n');

  const COMPLETA = [
    'DISTRIBUCION ERRECALDE S.A.  CUIT 30-71780890-4',
    'Factura-Remito A 00008-00002647',
    '63,830.46737',
    '$804.398,16',
    '$114.914,02',
    '$67.033,18',
  ].join('\n');

  const analisis = analizadorErrecalde.analizar({
    completo: COMPLETA,
    resumen: RECORTE,
    articulos: '',
  });

  it('arma los cinco campos combinando las dos lecturas', () => {
    expect(analisis.summary?.netTotal).toBe('3830467.37');
    expect(analisis.summary?.ivaTotal).toBe('804398.16');
    expect(analisis.summary?.total).toBe('4816812.73');
    expect(analisis.summary?.perceptionLines?.map((p) => p.amount)).toEqual([
      '114914.02',
      '67033.18',
    ]);
  });

  it('el resultado cierra exactamente', () => {
    const neto = parseArNumber(analisis.summary!.netTotal!)!;
    const iva = parseArNumber(analisis.summary!.ivaTotal!)!;
    const percepciones = parseArNumber(analisis.summary!.perceptionsTotal!)!;
    expect(neto.plus(iva).plus(percepciones).toFixed(2)).toBe('4816812.73');
  });

  it('el IVA cortado del recorte no gana sobre el entero de la página completa', () => {
    // $804.398,1 y $804.398,16 se parecen mucho, pero sólo uno hace cerrar el
    // pie. Que la diferencia sea de seis centavos no lo vuelve aceptable: el
    // criterio es cuál cierra, no cuál está más cerca.
    expect(analisis.summary?.ivaTotal).not.toBe('804398.1');
  });

  it('la evidencia del neto se busca en todo lo leído, no sólo en la fuente elegida', () => {
    /*
     * El rastro de "383046737" está en la página completa, dentro de
     * "63,830.46737", que como importe argentino es basura: tiene coma de miles
     * y cinco decimales. Sirve como evidencia y no como valor, que es
     * exactamente la distinción que hace falta. Si la búsqueda de evidencia se
     * limitara a la fuente con la que se armó el pie, este caso no cerraría.
     */
    expect(analisis.summary?.netTotal).toBe('3830467.37');
  });
});

describe('cuando hay más de una manera de armar el pie', () => {
  /*
   * La salvaguarda contra elegir cualquiera.
   *
   * Combinar campos entre pasadas mete en la misma bolsa importes del pie,
   * importes de los renglones y basura de otras partes de la página. Que exista
   * *una* combinación que cierre no alcanza para creerle: podría haber otra que
   * también cierre con números que no son el pie.
   *
   * Acá se arman dos a propósito. Las dos cumplen todo —cierran, el IVA es el
   * 21 % del neto, la jerarquía se respeta— y ninguna tiene por qué ganarle a la
   * otra. Lo correcto es no elegir.
   */
  const CABECERA = 'DISTRIBUCION ERRECALDE S.A. CUIT 30-71780890-4';

  // Dos pies completos y válidos, uno de $1.210.000 y otro de $2.420.000.
  //   1.000.000 + 210.000 =            1.210.000
  //   2.000.000 + 420.000 =            2.420.000
  const AMBIGUO = [
    '$1.000.000,00',
    '$210.000,00',
    '$1.210.000,00',
    '$2.000.000,00',
    '$420.000,00',
    '$2.420.000,00',
  ].join('\n');

  const analisis = analizadorErrecalde.analizar({
    completo: `${CABECERA}\n${AMBIGUO}`,
    resumen: AMBIGUO,
    articulos: '',
  });

  it('no elige ninguna de las dos', () => {
    expect(analisis.summary?.netTotal).toBeNull();
    expect(analisis.summary?.total).toBeNull();
  });

  it('dice que hay más de una y manda a releer', () => {
    expect(
      analisis.observaciones.some((o) => /maneras distintas de armar el pie/i.test(o)),
      `observaciones: ${analisis.observaciones.join(' | ')}`,
    ).toBe(true);
  });

  it('con una sola combinación válida sí elige', () => {
    // El mismo caso quitando el segundo pie: ahí no hay ambigüedad que valga.
    const unico = analizadorErrecalde.analizar({
      completo: `${CABECERA}\n$1.000.000,00\n$210.000,00\n$1.210.000,00`,
      resumen: '$1.000.000,00\n$210.000,00\n$1.210.000,00',
      articulos: '',
    });
    expect(unico.summary?.netTotal).toBe('1000000');
    expect(unico.summary?.total).toBe('1210000');
  });
});

describe('una sola lectura que trae el pie entero es la preferida', () => {
  it('no se cae al camino combinado cuando el recorte alcanza', () => {
    /*
     * El camino posicional de una sola fuente conserva sus condiciones fuertes
     * —los cinco importes, en el orden esperado— y sigue siendo el primero que
     * se prueba. Sólo cuando ninguna fuente sola da un pie que cierre se
     * combinan campos entre pasadas.
     *
     * Acá el recorte trae los cinco en orden y con etiquetas, y la página
     * completa trae además ruido que podría armar otro pie. El resultado tiene
     * que salir del recorte, sin ambigüedad.
     */
    const RECORTE = [
      'Neto Gravado $3.830.467,37',
      'IVA $804.398,16',
      'Percepción IVA RG 5329 $114.914,02',
      'Percepción IIBB Buenos Aires $67.033,18',
      'TOTAL $4.816.812,73',
    ].join('\n');

    const analisis = analizadorErrecalde.analizar({
      completo: `DISTRIBUCION ERRECALDE S.A. CUIT 30-71780890-4\n$1.000.000,00\n$210.000,00\n$1.210.000,00`,
      resumen: RECORTE,
      articulos: '',
    });

    expect(analisis.summary?.netTotal).toBe('3830467.37');
    expect(analisis.summary?.total).toBe('4816812.73');
    expect(analisis.observaciones.filter((o) => /maneras distintas/i.test(o))).toEqual([]);
  });
});
