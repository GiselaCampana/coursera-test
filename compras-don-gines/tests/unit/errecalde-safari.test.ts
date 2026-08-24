import { describe, it, expect } from 'vitest';
import { Decimal, parseArNumber } from '@/lib/money';
import { analizadorErrecalde } from '@/lib/ocr/parsers/errecalde';

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
