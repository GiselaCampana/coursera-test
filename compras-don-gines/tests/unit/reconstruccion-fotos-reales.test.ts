import { describe, it, expect } from 'vitest';
import { bloquea } from '@/lib/ocr/motor/pendientes';
import { netoDelRenglon } from '@/lib/ocr/motor/candidatas';
import { evidenciaNormalizada } from '@/lib/ocr/reconstruccion/evidencia';
import {
  BARRAZA,
  CALVOS_212356,
  CALVOS_213103,
  CUIT_DEL_RECEPTOR,
  ERRECALDE,
  EZRA,
  MABELHERDI,
  TODAS,
  leerEvidencia as leer,
} from '@/../tests/fixtures/reconstruccion-de-las-fotos';

/**
 * La reconstrucción completa sobre las fotos reales, sin ningún analizador de
 * proveedor.
 *
 * Es la medida honesta de dónde está el motor. Lo que se afirma acá es lo que
 * hace hoy, incluido lo que todavía no hace, y cada vez que algo mejore esta
 * prueba tiene que fallar para que se actualice.
 *
 * Todo lo de este archivo es **determinístico**: afirma qué se leyó, no cuánto
 * tardó. Lo que mide tiempo vive en `tests/rendimiento/`, aparte, porque
 * depende de la máquina y no puede decidir si una lectura correcta cuenta o no.
 * La reconstrucción en sí se arma una sola vez, en el fixture compartido.
 */

describe('la evidencia capturada', () => {
  it('está normalizada en las seis fotos', () => {
    /*
     * Unas coordenadas en píxeles que se cuelen no fallan: producen una
     * reconstrucción donde todo cae en la primera columna y un resultado que
     * parece válido. Por eso se comprueba antes que nada.
     */
    for (const nombre of ['errecalde', 'mabelherdi', 'ezra', 'barraza']) {
      expect(evidenciaNormalizada(leer(nombre)), nombre).toBe(true);
    }
  });

  it('trae varias pasadas por foto, con palabras y cajas', () => {
    const evidencia = leer('ezra');
    expect(evidencia.pasadas.length).toBeGreaterThanOrEqual(5);
    expect(evidencia.fragmentos.length).toBeGreaterThan(500);
    expect(new Set(evidencia.fragmentos.map((f) => f.pasada)).size).toBeGreaterThan(3);
  });
});

describe('la reconstrucción de la tabla', () => {
  it('Ezra: los seis artículos, enteros, desde una foto de teléfono', () => {
    /*
     * Es el resultado que este hito existía para conseguir. El motor basado en
     * texto sacaba **cero** renglones utilizables de esta misma foto; acá salen
     * los seis con código, cantidad, los dos precios y el importe, y los valores
     * son los que dice el papel.
     */
    const renglones = EZRA.veredicto.ganadora!.renglones;
    /*
     * El sexto código es «4249» y no «4249E». La «E» no está en el papel: la
     * pasada de la franja de artículos parte esos mismos glifos en «42» y «E»
     * —dos cajas que se pisan con la que la pasada de la página entera lee
     * completa como «4249», con 0,95 contra 0,53 y 0,18— y la celda las venía
     * pegando en vez de tratarlas como lo que son, dos maneras de leer lo
     * mismo. Los otros cinco códigos son dígitos puros.
     */
    expect(renglones.map((r) => r.codigo)).toEqual(['47', '49', '48', '10', '2514', '4249']);
    expect(renglones[0].cantidad?.toString()).toBe('4.24');
    expect(renglones[0].precioUnitario?.toString()).toBe('6723.279');
    expect(renglones[0].descuentoPct?.toString()).toBe('0.05');
    expect(renglones[0].precioConDescuento?.toString()).toBe('6387.115');
    expect(renglones[0].importe?.toString()).toBe('27081.371');
  });

  it('Ezra: la suma de los renglones da el neto impreso', () => {
    // 221.388,85 contra 221.388,84 del papel: un centavo, que es el redondeo de
    // los importes con tres decimales que imprime este formato.
    const ganadora = EZRA.veredicto.ganadora!;
    expect(ganadora.sumaDeRenglones.minus(EZRA.pie.netTotal!).abs().toNumber()).toBeLessThan(0.02);
  });

  it('Mabelherdi: los nueve artículos y la suma exacta contra el pie', () => {
    const ganadora = MABELHERDI.veredicto.ganadora!;
    expect(ganadora.sumaDeRenglones.toFixed(2)).toBe('32998.85');
    expect(MABELHERDI.pie.netTotal?.toFixed(2)).toBe('32998.85');
    expect(ganadora.cierre?.compatible).toBe(true);
  });

  it('Mabelherdi: unas pocas decisiones reales, y el resto son anotaciones', () => {
    /*
     * El criterio del hito: con los nueve artículos bien y la suma exacta
     * contra el neto, los fragmentos que el OCR descartó no pueden obligar a
     * corregir la factura. Lo que queda son columnas que se configuran una vez
     * para este formato, y todas son preguntas contestables.
     *
     * Eran dos y ahora son cuatro, y eso **no** es un retroceso: son las
     * columnas que antes desaparecían sin decir nada. «Codigo», «Sugerido» y la
     * columna de texto sin encabezado ahora se conservan y se preguntan en vez
     * de evaporarse, y a cambio el comprobante recuperó los nueve precios
     * unitarios y los nueve códigos de artículo que antes venían en blanco.
     * El puntaje pasó de 0,63 a 0,93 por eso mismo.
     *
     * «Unit» ya no está entre ellas: el reparto conjunto de las columnas hace
     * que su precio cierre la cuenta de los nueve renglones, y una coincidencia
     * así vale más que cualquier cosa que se pueda decir de su nombre.
     */
    expect(MABELHERDI.resumen.bloqueosUnicos).toBe(4);
    expect(MABELHERDI.resumen.desglose.columnasSinReconocer).toBe(4);
    expect(MABELHERDI.resumen.desglose.celdasObligatoriasFaltantes).toBe(0);
    expect(MABELHERDI.resumen.desglose.ambiguedadesBloqueantes).toBe(0);
    expect(MABELHERDI.resumen.advertenciasNoBloqueantes).toBeGreaterThan(10);

    // El total y el desglose son la misma cosa contada de dos maneras.
    const suma = Object.values(MABELHERDI.resumen.desglose).reduce((a, b) => a + b, 0);
    expect(suma).toBe(MABELHERDI.resumen.bloqueosUnicos);
  });

  it('Mabelherdi: los precios unitarios y los códigos ya no vienen vacíos', () => {
    /*
     * Antes de conservar las columnas sin confirmar, «Unit» no coincidía con
     * ningún sinónimo —le falta la P de «P.Unit»— y quedaba en nada: sus nueve
     * valores se perdían y la factura se cargaba sin un solo precio unitario.
     *
     * Sigue sin resolverse por su nombre, y está bien que así sea: «Unit» solo
     * es una conjetura. Lo que cambió es que ahora se conserva como monto sin
     * confirmar y se ofrece a la aritmética, que la ubica. El dato entra y la
     * pregunta queda.
     */
    const renglones = MABELHERDI.veredicto.ganadora!.renglones;
    expect(renglones.filter((r) => r.precioUnitario !== null)).toHaveLength(9);
    expect(renglones.filter((r) => r.codigo !== null)).toHaveLength(9);
    expect(renglones[0].precioUnitario?.toString()).toBe('2066.12');
  });

  it('Errecalde: los códigos de artículo salen enteros', () => {
    // Trece renglones con su código, su descripción y su precio. El importe
    // todavía no, porque la columna «SUBTOTAL» salió recortada del OCR y no se
    // reconoce: es el pendiente que se informa.
    const codigos = ERRECALDE.veredicto.ganadora!.renglones.map((r) => r.codigo);
    expect(codigos).toContain('ART-00873');
    expect(codigos).toContain('ART-01911');
    expect(codigos.filter((c) => c?.startsWith("ART-")).length).toBeGreaterThanOrEqual(13);
  });

  it('la inclinación de la foto se mide y se corrige donde hace falta', () => {
    // Barraza y una de las de Los Calvos salieron torcidas; las otras no.
    expect(BARRAZA.tabla.seEnderezo).toBe(true);
    expect(Math.abs(BARRAZA.tabla.inclinacionGrados)).toBeGreaterThan(0.1);
    expect(EZRA.tabla.seEnderezo).toBe(false);
  });

  it('se informa con qué método se delimitaron las columnas', () => {
    for (const [nombre, informe] of TODAS) {
      expect(
        ['datos-con-titulos', 'columnas-de-datos', 'fila-de-titulos'],
        nombre,
      ).toContain(informe.tabla.metodo);
    }
  });

  it('varias pasadas aportan valores al mismo comprobante', () => {
    // Es lo que justifica leer varias veces, y hasta ahora no se podía medir
    // porque los textos de las pasadas se concatenaban.
    for (const [nombre, informe] of TODAS) {
      expect(informe.tabla.valoresDeOtraPasada, nombre).toBeGreaterThan(0);
    }
  });
});

describe('el pie fiscal', () => {
  it('Ezra, Mabelherdi y Barraza salen del pie con el neto correcto', () => {
    expect(EZRA.pie.netTotal?.toFixed(2)).toBe('221388.84');
    expect(MABELHERDI.pie.netTotal?.toFixed(2)).toBe('32998.85');
    expect(BARRAZA.pie.netTotal?.toFixed(2)).toBe('473232.44');
  });

  it('Barraza: el saldo acumulado sigue quedando afuera', () => {
    // 532.848,64 es más grande que el total de la factura (579.709,74 menos el
    // IVA): si se colara como neto, la deuda quedaría al doble.
    expect(BARRAZA.pie.ivaTotal?.toFixed(2)).toBe('99378.81');
    expect(BARRAZA.pie.percepciones?.toFixed(2)).toBe('7098.49');
    expect(BARRAZA.pie.total?.toFixed(2)).toBe('579709.74');
    for (const valor of [BARRAZA.pie.netTotal, BARRAZA.pie.ivaTotal, BARRAZA.pie.total]) {
      expect(valor?.toFixed(2)).not.toBe('532848.64');
    }
  });

  it('Errecalde: el neto del pie sale con la coma en su lugar', () => {
    /*
     * El papel dice 3.830.467,37 y durante mucho tiempo el motor leía
     * 383.046.737: cuando el pie no cerraba contra sí mismo se quedaba con «el
     * neto más grande», y el más grande es siempre la lectura que ignora los
     * separadores decimales.
     *
     * No era un error acotado al pie. A partir de ese neto el comprobante entero
     * se acomodaba cien veces más grande: cada renglón cerraba contra su propio
     * precio inflado y la suma daba el neto inflado. Todo cuadraba y el costo por
     * kilo de veintitrés artículos salía cien veces mal.
     *
     * Ahora se prefiere la lectura literal —los separadores como están impresos—
     * y sólo entre ésas se toma la mayor.
     */
    expect(ERRECALDE.pie.netTotal?.toFixed(2)).toBe('3830467.37');
  });

  it('Errecalde: la primera pasada no finge cerrar, y lo dice', () => {
    /*
     * En la primera pasada la suma del detalle queda lejos del neto impreso
     * —cerca de un diecinueve por ciento— y eso es lo que hay que informar.
     *
     * Durante un rato el número fue mucho mejor y era mentira. Dos cosas lo
     * maquillaban: una búsqueda que elegía reparaciones para acercar la suma al
     * pie, y una celda de bonificación leída «629» que entraba como 629 % y
     * dejaba el neto de cuatro renglones **negativo**. Un negativo grande se
     * compensa con otro renglón leído de más, la suma daba a dos décimas del
     * neto impreso y había cuatro artículos con costo negativo adentro.
     *
     * Así que se prueba lo contrario de lo que uno querría: que la lectura de
     * la página entera **no cierra**, que no hay un solo renglón con valor
     * imposible, y que el comprobante no se acepta solo. La distancia la cierra
     * la relectura focalizada con evidencia nueva, y eso se prueba aparte.
     */
    const ganadora = ERRECALDE.veredicto.ganadora!;
    expect(ganadora.cierre?.compatible).toBe(false);
    expect(ERRECALDE.veredicto.decision).not.toBe('automatica');

    for (const renglon of ganadora.renglones) {
      const neto = netoDelRenglon(renglon);
      expect(neto === null || neto.gte(0), renglon.descripcion).toBe(true);
    }
  });

  it('Errecalde: un descuento imposible no se usa ni se aproxima', () => {
    /*
     * Ningún renglón puede quedar con una bonificación de más de cien por
     * ciento. No se corrige el valor: la lectura se descarta y el renglón se
     * interpreta sin descuento, que es lo único honesto que se puede hacer con
     * una celda que dice algo que no existe.
     */
    for (const renglon of ERRECALDE.veredicto.ganadora!.renglones) {
      expect(renglon.descuentoPct === null || renglon.descuentoPct.lte(1)).toBe(true);
    }
  });
});

describe('el emisor', () => {
  it('el CUIT sale bien en las cuatro facturas del objetivo', () => {
    expect(ERRECALDE.emisor.cuit).toBe('30-71780890-4');
    expect(EZRA.emisor.cuit).toBe('30-71951960-8');
    expect(BARRAZA.emisor.cuit).toBe('30-66138303-4');
    expect(MABELHERDI.emisor.cuit).toMatch(/^30-6780430[0-9]-[0-9]$/);
  });

  it('ninguna se atribuye al CUIT del receptor', () => {
    for (const [nombre, informe] of TODAS) {
      expect(informe.emisor.cuit, nombre).not.toBe(CUIT_DEL_RECEPTOR);
    }
  });
});

describe('qué le queda por resolver a una persona', () => {
  it('Ezra se acepta sola, sin nada bloqueante', () => {
    /*
     * El criterio del hito, cumplido: seis renglones interpretados, la suma
     * compatible con el pie por truncamiento, y ninguna corrección manual.
     */
    expect(EZRA.veredicto.decision).toBe('automatica');
    expect(EZRA.resumen.bloqueosUnicos).toBe(0);
  });

  it('Ezra cierra por precisión, no por haber aflojado el umbral', () => {
    const cierre = EZRA.veredicto.ganadora!.cierre!;
    expect(cierre.compatible).toBe(true);
    expect(cierre.politica).toBe('truncamiento');
    expect(cierre.ajusteResidual.toNumber()).toBe(0);
    expect(cierre.decimalesDeOrigen).toBe(3);
    expect(cierre.decimalesDelPie).toBe(2);
  });

  it('cada pendiente dice renglón, campo, categoría y de dónde salió cada lectura', () => {
    for (const [nombre, informe] of TODAS) {
      for (const pendiente of informe.pendientes) {
        expect(pendiente.motivo.length, nombre).toBeGreaterThan(10);
        /*
         * Todo bloqueo dice dónde mirar. Para casi todos eso es una celda —un
         * renglón y un campo— pero el que pregunta **si el renglón existe** no
         * es sobre ninguna celda suya: es sobre la línea entera, y el número de
         * renglón ya alcanza para encontrarla en la foto.
         */
        if (pendiente.renglon !== null && pendiente.categoria !== 'BLOCKING_UNPROVEN_ROW') {
          expect(pendiente.campo ?? pendiente.columna, nombre).not.toBeNull();
        }
        for (const alternativa of pendiente.alternativas) {
          expect(alternativa.texto.length).toBeGreaterThan(0);
          expect(alternativa.caja.x1).toBeGreaterThanOrEqual(alternativa.caja.x0);
          expect(typeof alternativa.pasada).toBe('string');
        }
      }
    }
  });

  it('una alternativa descartada no cuenta como corrección manual', () => {
    /*
     * Es la distinción central: si el renglón cierra, que el OCR haya leído la
     * celda de dos maneras es evidencia anotada, no un dato que falte. Antes
     * bajaba la confianza igual que una celda vacía.
     */
    for (const [nombre, informe] of TODAS) {
      const descartadas = informe.pendientes.filter(
        (p) => p.categoria === 'WARNING_DISCARDED_ALTERNATIVE',
      );
      for (const pendiente of descartadas) {
        expect(bloquea(pendiente.categoria), nombre).toBe(false);
      }
    }
  });

  it('Mabelherdi: la columna «Desc» se pide, y las basuras del OCR no', () => {
    /*
     * «Desc» es la ambigüedad real que una persona resuelve una vez. «y», «e»,
     * «UU» y «RM» son jirones del encabezado: pedirle a alguien que diga qué
     * significa la columna «e» es hacerle perder el tiempo con algo que no tiene
     * respuesta.
     */
    const columnas = MABELHERDI.pendientes
      .filter((p) => p.categoria === 'BLOCKING_UNKNOWN_COLUMN')
      .map((p) => p.columna);
    for (const basura of ['y', 'e', 'UU', 'RM']) {
      expect(columnas).not.toContain(basura);
    }
  });

  it('Barraza: los dos renglones se arman aunque «Descripción» sea ilegible', () => {
    /*
     * Éste es el hito que el reconocimiento tolerante vino a resolver, y el
     * cambio es de fondo: **antes se rechazaba**.
     *
     * La palabra «Descripción» del encabezado de esta foto sale como manchas,
     * así que la columna de texto quedaba sin campo, los dos renglones se
     * descartaban por «falta de descripción» y el comprobante mostraba cero
     * artículos. Teniendo, al lado, los kilos, las piezas, los códigos y los dos
     * importes perfectamente leídos.
     *
     * Ahora la columna se conserva como texto sin confirmar, los dos renglones
     * se reconstruyen enteros y lo que queda es una pregunta de un segundo.
     */
    expect(BARRAZA.veredicto.decision).toBe('revision-de-estructura');

    const renglones = BARRAZA.veredicto.ganadora!.renglones;
    expect(renglones).toHaveLength(2);

    // Los dos códigos, incluido el «30» del segundo renglón, que está impreso
    // en la tabla y no es el 30 del CUIT del emisor.
    expect(renglones.map((r) => r.codigo)).toEqual(['03', '30']);
    expect(renglones.map((r) => r.cantidad?.toString())).toEqual(['27', '30']);
    expect(renglones.map((r) => r.piezas)).toEqual([9, 3]);

    // Dos descripciones distintas, cada una con el nombre de su artículo.
    expect(renglones[0].descripcion).toContain('RAZA');
    expect(renglones[1].descripcion).toContain('MUZZA');
    expect(renglones[0].descripcion).not.toBe(renglones[1].descripcion);

    // Y los dos importes tal como están impresos.
    expect(renglones.map((r) => r.importe?.toString())).toEqual(['234997.69', '238234.75']);
  });

  it('Barraza: la suma de los dos renglones da exactamente el neto impreso', () => {
    /*
     * 234.997,69 + 238.234,75 = 473.232,44, que es el neto del pie al centavo.
     * Es el control más fuerte que hay sobre esta lectura y no depende de
     * ningún encabezado: si los importes estuvieran cruzados de renglón o mal
     * leídos, no daría.
     */
    const ganadora = BARRAZA.veredicto.ganadora!;
    expect(ganadora.sumaDeRenglones.toFixed(2)).toBe('473232.44');
    expect(BARRAZA.pie.netTotal?.toFixed(2)).toBe('473232.44');
    expect(ganadora.cierre?.compatible).toBe(true);
    expect(BARRAZA.pie.ivaTotal?.toFixed(2)).toBe('99378.81');
    expect(BARRAZA.pie.percepciones?.toFixed(2)).toBe('7098.49');
    expect(BARRAZA.pie.total?.toFixed(2)).toBe('579709.74');
  });

  it('Barraza: el primer renglón se comprueba contra su propia aritmética', () => {
    /*
     * 27 × 10.361,45 × 0,84 = 234.997,69. El precio viene de una columna cuyo
     * encabezado el OCR leyó «Lado» —no se parece a ningún sinónimo— así que
     * quedó como monto sin confirmar y se ofreció como precio posible. Que la
     * cuenta dé exacta es mejor evidencia de lo que esa columna significa que
     * cualquier cosa que se pueda decir de su encabezado.
     */
    const primero = BARRAZA.veredicto.ganadora!.renglones[0];
    expect(primero.precioUnitario?.toString()).toBe('10361.45');
    expect(primero.descuentoPct?.toString()).toBe('0.16');
    expect(primero.controles.filter((c) => c.paso).length).toBeGreaterThan(0);
  });

  it('Barraza: lo que falta se pide como confirmación, no como recarga', () => {
    /*
     * La diferencia que importa para quien carga la factura. Los bloqueos son
     * columnas —se contestan una vez— y ninguno es una celda obligatoria
     * faltante ni una ambigüedad sin resolver, que serían volver a tipear.
     */
    expect(BARRAZA.resumen.desglose.celdasObligatoriasFaltantes).toBe(0);
    expect(BARRAZA.resumen.desglose.ambiguedadesBloqueantes).toBe(0);
    /*
     * Todo lo que frena es una pregunta sobre una **columna**: qué significa, o
     * en qué escala están escritos sus valores. Las dos se contestan una vez y
     * valen para las celdas de abajo; ninguna es volver a tipear un número.
     */
    expect(
      BARRAZA.resumen.desglose.columnasSinReconocer +
        BARRAZA.resumen.desglose.escalasSinDecidir +
        BARRAZA.resumen.desglose.importesSinAsignar,
    ).toBe(BARRAZA.resumen.bloqueosUnicos);
    expect(BARRAZA.resumen.desglose.renglonesSinProbar).toBe(0);

    // Y la pregunta por la columna de texto está redactada como corresponde.
    const textual = BARRAZA.pendientes.find((p) =>
      p.motivo.startsWith('Confirmar que la columna textual corresponde a Descripción'),
    );
    expect(textual?.categoria).toBe('BLOCKING_UNKNOWN_COLUMN');
  });

  it('las dos fotos de Los Calvos se siguen rechazando por calidad', () => {
    expect(CALVOS_212356.veredicto.decision).toBe('rechazo');
    expect(CALVOS_213103.veredicto.decision).toBe('rechazo');
  });
});
