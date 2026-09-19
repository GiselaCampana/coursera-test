import { describe, it, expect } from 'vitest';
import {
  asignarSemantica,
  camposParecidos,
  formasDe,
  marcadorSegunContenido,
  parecido,
  perfilDeContenido,
  relacionesAritmeticas,
  type ContenidoDeColumna,
} from '@/lib/ocr/motor/semantica-de-columnas';
import { candidatasDeRenglon, type ConvencionDecimal } from '@/lib/ocr/motor/candidatas';
import { reconocerColumna, type ColumnaReconocida } from '@/lib/ocr/motor/columnas';
import type { Celda, FilaDeDatos } from '@/lib/ocr/motor/tabla';

/**
 * Saber qué es cada columna cuando el encabezado no se deja leer.
 *
 * Acá se prueba la capa sola, con columnas escritas a mano, para poder saber
 * exactamente qué la rompe. La medición sobre las seis fotos reales está en
 * `reconstruccion-fotos-reales.test.ts`; ésta es la que dice **por qué**.
 *
 * Las tres situaciones que tiene que distinguir, y que son las tres reales del
 * banco de facturas:
 *
 *  1. el encabezado está y se lee —«Importe»—;
 *  2. el encabezado está degradado pero es reconocible —«UBTOTA» por SUBTOTAL—;
 *  3. el encabezado no está o es ilegible —la «Descripción» de Lácteos Barraza—.
 *
 * Y la regla que las atraviesa: **ninguna señal sola alcanza** para aceptar una
 * columna sin preguntar.
 */

function columna(
  titulo: string | null,
  celdas: string[],
  desde = 0.1,
  hasta = 0.2,
): ContenidoDeColumna {
  return { titulo, celdas, desde, hasta };
}

/** Una tabla verosímil a la que se le cambia una columna por vez. */
function tablaBase(): ContenidoDeColumna[] {
  return [
    columna('Codigo', ['1001', '1002', '1003'], 0.05, 0.12),
    columna('Descripcion', ['SALAMIN FINO', 'JAMON COCIDO', 'QUESO CREMOSO'], 0.15, 0.45),
    columna('Cantidad', ['10', '4', '6'], 0.5, 0.56),
    columna('Precio', ['16.999,00', '13.571,00', '9.148,00'], 0.6, 0.7),
    columna('Bonif', ['16,00', '16,00', '16,00'], 0.74, 0.8),
    columna('Importe', ['142.791,60', '45.598,56', '46.106,11'], 0.85, 0.95),
  ];
}

describe('nivel 1: el encabezado se lee y el contenido lo acompaña', () => {
  it('cada columna queda con su campo, por EXACT_HEADER y sin preguntar', () => {
    const asignadas = asignarSemantica(tablaBase());
    expect(asignadas.map((a) => a.campo)).toEqual([
      'codigo',
      'descripcion',
      'cantidad',
      'precioUnitario',
      'descuentoPct',
      'importe',
    ]);
    expect(asignadas.every((a) => a.origen === 'EXACT_HEADER')).toBe(true);
    expect(asignadas.some((a) => a.requiereConfirmacion)).toBe(false);
  });

  it('la evidencia que la sostiene viene de más de una familia', () => {
    /*
     * Es la garantía de fondo, y se comprueba mirando de dónde salió: un
     * encabezado que dice «Importe» sobre una columna de texto no puede aceptarse
     * sola por el encabezado, así que ninguna columna aceptada puede apoyarse en
     * una única clase de evidencia.
     */
    for (const asignada of asignarSemantica(tablaBase())) {
      const familias = new Set(
        asignada.evidencias.filter((e) => e.campo === asignada.campo).map((e) => e.familia),
      );
      expect(familias.size).toBeGreaterThanOrEqual(2);
    }
  });

  it('un encabezado desmentido por su contenido no se acepta', () => {
    /*
     * «Importe» sobre una columna de nombres de artículo. Pasa de verdad cuando
     * la columna de al lado se corre encima, y creerle al encabezado ahí carga
     * una descripción como monto.
     */
    const tabla = tablaBase();
    tabla[5] = columna('Importe', ['SALAMIN FINO', 'JAMON COCIDO', 'QUESO CREMOSO'], 0.85, 0.95);
    const asignada = asignarSemantica(tabla)[5];
    expect(asignada.campo).not.toBe('importe');
    expect(asignada.origen).toBe('UNRESOLVED');
    expect(asignada.requiereConfirmacion).toBe(true);
  });

  it('un encabezado legible sobre celdas ilegibles asigna igual, pero pregunta', () => {
    /*
     * El caso de Lácteos Barraza: la palabra «Importe» se lee perfecta y debajo
     * el OCR devuelve los dos importes pegados en un borrón. No hay contenido
     * que confirme el encabezado, pero tampoco nada que lo contradiga.
     *
     * Tratarlo como columna desconocida deja la aritmética sin el único número
     * que el pie totaliza. Se usa lo que dice el papel y se pregunta.
     */
    const tabla = tablaBase();
    tabla[5] = columna('Importe', ['234.997238,234.2346975', '', ''], 0.85, 0.95);
    const asignada = asignarSemantica(tabla)[5];
    expect(asignada.campo).toBe('importe');
    expect(asignada.origen).toBe('EXACT_HEADER');
    expect(asignada.requiereConfirmacion).toBe(true);
  });
});

describe('nivel 2: el encabezado está degradado', () => {
  it('«UBTOTA» es SUBTOTAL cuando el contenido y la posición lo acompañan', () => {
    const tabla = tablaBase();
    tabla[5] = columna('UBTOTA', ['142.791,60', '45.598,56', '46.106,11'], 0.85, 0.95);
    const asignada = asignarSemantica(tabla)[5];
    expect(asignada.campo).toBe('importe');
    expect(asignada.origen).toBe('FUZZY_HEADER');
    expect(asignada.requiereConfirmacion).toBe(false);
  });

  it('un parecido solo, sin nada que lo apoye, no alcanza', () => {
    /*
     * Sin contenido que lo sostenga, «UBTOTA» es una conjetura sobre una palabra
     * y nada más. Una conjetura sobre el nombre más una celda ilegible no son
     * dos evidencias: son ninguna.
     */
    const tabla = tablaBase();
    tabla[5] = columna('UBTOTA', ['@@', '//', '~~'], 0.85, 0.95);
    const asignada = asignarSemantica(tabla)[5];
    expect(asignada.origen).toBe('UNRESOLVED');
  });

  it('«Desc» admite dos significados y por eso no se resuelve', () => {
    /*
     * El caso real de Mabelherdi. «Desc» puede ser descripción o descuento, y
     * las dos existen en el papel. Aceptar una cargaría un porcentaje como
     * nombre de artículo, o al revés, sin que ningún número lo delate.
     */
    expect(camposParecidos('Desc')).toEqual([]);

    /*
     * Y sin aritmética que lo decida, la columna queda sin resolver: es el caso
     * de Mabelherdi, donde el importe ya viene neto y el porcentaje no entra en
     * ninguna igualdad, así que ningún número delata cuál de los dos es.
     *
     * Cuando sí hay una igualdad que lo prueba —como en la tabla de arriba, que
     * cierra— la columna se resuelve por aritmética y queda para confirmar. Las
     * dos cosas son correctas y la diferencia es justamente la evidencia.
     */
    const sinCuentas: ContenidoDeColumna[] = [
      columna('Codigo', ['1001', '1002', '1003'], 0.05, 0.12),
      columna('Descripcion', ['SALAMIN FINO', 'JAMON COCIDO', 'QUESO'], 0.15, 0.45),
      columna('Desc', ['16,00', '16,00', '16,00'], 0.5, 0.56),
      columna('Cantidad', ['10', '4', '6'], 0.6, 0.66),
      columna('Importe', ['142.791,60', '45.598,56', '46.106,11'], 0.85, 0.95),
    ];
    const asignada = asignarSemantica(sinCuentas)[2];
    expect(asignada.origen).toBe('UNRESOLVED');
    expect(asignada.campo).toBe('UNKNOWN_PERCENT');
    expect(asignada.requiereConfirmacion).toBe(true);
  });

  it('el parecido pide que el pedazo cubra la palabra, no sólo que sea largo', () => {
    // «ubtota» son seis de los ocho caracteres de «subtotal»: una palabra comida.
    expect(parecido('ubtota', 'subtotal')).toBeGreaterThan(0.7);
    // «desc» son cuatro de los nueve de «descuento»: una palabra distinta que
    // empieza igual. Si esto pasara, «Desc» dejaría de ser ambigua por error.
    expect(parecido('desc', 'descuento')).toBeLessThan(0.7);
    expect(parecido('desc', 'descripcion')).toBeLessThan(0.7);
    // Y una letra cambiada sigue siendo la misma palabra.
    expect(parecido('lmporte', 'importe')).toBeGreaterThan(0.7);
  });
});

describe('nivel 3: no hay encabezado utilizable', () => {
  it('la aritmética identifica las columnas sin leer una sola palabra', () => {
    /*
     * Que 10 × 16.999 × 0,84 dé 142.791,60 y que las otras dos filas también
     * cierren identifica cuatro columnas de golpe. Una coincidencia sostenida en
     * varias filas no pasa por casualidad.
     */
    const tabla = tablaBase().map((c) => ({ ...c, titulo: null }));
    const relaciones = relacionesAritmeticas(tabla);
    expect(relaciones.length).toBeGreaterThan(0);
    const mejor = relaciones[0];
    expect(mejor.importe).toBe(5);
    expect(mejor.precio).toBe(3);
    expect(mejor.descuento).toBe(4);
    expect(mejor.cierran).toBe(3);
  });

  it('una columna inferida se usa, pero queda para confirmar', () => {
    /*
     * «No hagas que una columna inferida se transforme en verdad permanente.»
     * Se reconstruye el renglón —que es lo que nadie puede rehacer a mano— y se
     * pregunta. Recién el perfil confirmado, cuando exista, apaga la pregunta.
     */
    const tabla = tablaBase().map((c) => ({ ...c, titulo: null }));
    const asignada = asignarSemantica(tabla)[5];
    expect(asignada.campo).toBe('importe');
    expect(asignada.origen).toBe('INFERRED_FROM_ARITHMETIC');
    expect(asignada.requiereConfirmacion).toBe(true);
  });

  it('una sola fila no alcanza para inferir por aritmética', () => {
    // Con una sola, tres números cualesquiera se multiplican y dan un cuarto.
    const unaSola = tablaBase().map((c) => ({ ...c, titulo: null, celdas: [c.celdas[0]] }));
    expect(relacionesAritmeticas(unaSola)).toEqual([]);
  });

  it('la posición sola no asigna nada', () => {
    /*
     * Una columna de montos en el borde derecho no es el importe nada más que
     * por estar ahí: si lo fuera, cualquier tabla con un número a la derecha se
     * cargaría con un importe inventado.
     */
    const sueltas: ContenidoDeColumna[] = [
      columna(null, ['aaa', 'bbb', 'ccc'], 0.05, 0.3),
      columna(null, ['xxx', 'yyy', 'zzz'], 0.4, 0.6),
      columna(null, ['1.234,00', '5.678,00', '9.012,00'], 0.85, 0.95),
    ];
    const asignada = asignarSemantica(sueltas)[2];
    expect(asignada.origen).toBe('UNRESOLVED');
    expect(asignada.campo).toBe('UNKNOWN_MONEY');
  });
});

describe('la columna que no se resuelve no desaparece', () => {
  it('cada forma de contenido deja su marcador', () => {
    const casos: [string[], string | null][] = [
      [['SALAMIN FINO', 'JAMON COCIDO', 'QUESO'], 'UNKNOWN_TEXT'],
      [['16.999,00', '13.571,00', '9.148,00'], 'UNKNOWN_MONEY'],
      [['16,00', '14,00', '21,00'], 'UNKNOWN_PERCENT'],
      [['1001', '1002', '1003'], 'UNKNOWN_NUMERIC'],
      [['', '', ''], null],
    ];
    for (const [celdas, esperado] of casos) {
      expect(marcadorSegunContenido(perfilDeContenido(celdas)), celdas.join('|')).toBe(esperado);
    }
  });

  it('un campo no queda en dos columnas a la vez', () => {
    /*
     * Pasa de verdad: «Cantidad» y «Cantidad!» en Barraza. La que mejor lo
     * sostiene se lo queda y la otra se resuelve sin ese campo, en vez de que
     * las dos carguen el mismo dato en el mismo lugar.
     */
    const tabla = tablaBase();
    tabla.splice(3, 0, columna('Precio', ['x', 'y', 'z'], 0.57, 0.59));
    const campos = asignarSemantica(tabla)
      .map((a) => a.campo)
      .filter((c) => c === 'precioUnitario');
    expect(campos).toHaveLength(1);
  });
});

describe('una columna desconocida no significa renglones inexistentes', () => {
  /** Una fila de Barraza: todo leído menos el nombre de la columna de texto. */
  function filaDeBarraza(): FilaDeDatos {
    const textos = ['03', 'CIL MUZZA BARRAZA X 2 KG', '27.00', '9.00', '10361.45', '16.00', '234997.69'];
    const celdas: (Celda | null)[] = textos.map((texto, i) => ({ texto, desde: i, hasta: i }));
    return { linea: 0, cruda: textos.join('  '), celdas, sobrantes: [] };
  }

  const columnas: (ColumnaReconocida | null)[] = [
    reconocerColumna('Cod'),
    // La de la descripción: el encabezado salió ilegible.
    {
      campo: 'UNKNOWN_TEXT',
      encabezado: '',
      confianza: 0,
      origen: 'UNRESOLVED',
      requiereConfirmacion: true,
    },
    reconocerColumna('Cantidad'),
    reconocerColumna('Unidades'),
    reconocerColumna('Pr Unit'),
    reconocerColumna('Bonif'),
    reconocerColumna('Importe'),
  ];

  it('el renglón se reconstruye completo y usa la columna de texto como descripción', () => {
    /*
     * Lo que no es aceptable es mostrar cero artículos y obligar a reescribirlos.
     * Con cantidades, piezas, precio, descuento e importe leídos, que falte el
     * **nombre de una columna** no puede borrar el renglón.
     */
    const candidatas = candidatasDeRenglon(filaDeBarraza(), columnas, 'ar' as ConvencionDecimal);
    expect(candidatas.length).toBeGreaterThan(0);

    const cierra = candidatas.find((c) => c.controles.some((x) => x.paso));
    expect(cierra).toBeDefined();
    expect(cierra!.descripcion).toContain('MUZZA');
    expect(cierra!.codigo).toBe('03');
    expect(cierra!.cantidad?.toString()).toBe('27');
    expect(cierra!.piezas).toBe(9);
    expect(cierra!.precioUnitario?.toString()).toBe('10361.45');
    expect(cierra!.descuentoPct?.toString()).toBe('0.16');
    expect(cierra!.importe?.toString()).toBe('234997.69');
  });

  it('recupera la continuación de la descripción dentro del corredor de texto', () => {
    /*
     * Un espacio grande dentro del nombre puede fabricar dos columnas sin
     * encabezado. Sólo el texto entre Descripción y la primera columna numérica
     * confirmada continúa el nombre; una unidad aislada sigue siendo una
     * unidad y no una palabra del artículo.
     */
    const textos = ['10', 'BARRA', 'UN', 'SABOR MIX X20U.KG', '1.000,00', '2.000,00'];
    const fila: FilaDeDatos = {
      linea: 0,
      cruda: textos.join('  '),
      celdas: textos.map((texto, i) => ({ texto, desde: i, hasta: i })),
      sobrantes: [],
    };
    const desconocida = (campo: 'UNKNOWN_TEXT' | 'UNKNOWN_NUMERIC'): ColumnaReconocida => ({
      campo,
      encabezado: '',
      confianza: 0,
      origen: 'UNRESOLVED',
      requiereConfirmacion: true,
    });
    const columnas: (ColumnaReconocida | null)[] = [
      reconocerColumna('Codigo'),
      reconocerColumna('Descripcion'),
      desconocida('UNKNOWN_TEXT'),
      desconocida('UNKNOWN_TEXT'),
      reconocerColumna('Precio'),
      reconocerColumna('Importe'),
    ];

    const candidatas = candidatasDeRenglon(fila, columnas, 'ar');
    expect(candidatas.length).toBeGreaterThan(0);
    for (const candidata of candidatas) {
      expect(candidata.descripcion).toBe('BARRA SABOR MIX X20U.KG');
      expect(candidata.descripcion).not.toMatch(/\bUN\b/);
    }
  });

  it('recupera una palabra del artículo que dos pasadas dejaron fuera de las columnas', () => {
    const textos = ['30', 'PLAN', 'BARRAZA', '2,00', '1.000,00', '2.000,00'];
    const fila: FilaDeDatos = {
      linea: 0,
      cruda: textos.join('  '),
      celdas: textos.map((texto, i) => ({ texto, desde: i, hasta: i })),
      sobrantes: [
        { texto: 'MUZZA', desde: 0, hasta: 0 },
        { texto: 'MUZZA', desde: 0, hasta: 0 },
        { texto: 'KG', desde: 0, hasta: 0 },
        { texto: 'RUIDO', desde: 0, hasta: 0 },
      ],
    };
    const anonima: ColumnaReconocida = {
      campo: 'UNKNOWN_TEXT',
      encabezado: '',
      confianza: 0,
      origen: 'UNRESOLVED',
      requiereConfirmacion: true,
    };
    const columnas: (ColumnaReconocida | null)[] = [
      reconocerColumna('Codigo'),
      reconocerColumna('Descripcion'),
      anonima,
      reconocerColumna('Cantidad'),
      reconocerColumna('Precio'),
      reconocerColumna('Importe'),
    ];

    const candidatas = candidatasDeRenglon(fila, columnas, 'ar');
    expect(candidatas.length).toBeGreaterThan(0);
    for (const candidata of candidatas) {
      expect(candidata.descripcion).toBe('PLAN BARRAZA MUZZA');
      expect(candidata.descripcion).not.toContain('RUIDO');
      expect(candidata.descripcion).not.toMatch(/\bKG\b/);
    }
  });

  it('una columna anónima con UN es cantidad, no dinero ni kilos por omisión', () => {
    const textos = ['10', 'BARRA', '2,00 UN', '1.000,00', '2.000,00'];
    const fila: FilaDeDatos = {
      linea: 0,
      cruda: textos.join('  '),
      celdas: textos.map((texto, i) => ({ texto, desde: i, hasta: i })),
      sobrantes: [],
    };
    const anonima: ColumnaReconocida = {
      campo: 'UNKNOWN_NUMERIC',
      encabezado: '',
      confianza: 0,
      origen: 'UNRESOLVED',
      requiereConfirmacion: true,
    };
    const columnas: (ColumnaReconocida | null)[] = [
      reconocerColumna('Codigo'),
      reconocerColumna('Descripcion'),
      anonima,
      reconocerColumna('Precio'),
      reconocerColumna('Importe'),
    ];

    const cierra = candidatasDeRenglon(fila, columnas, 'ar').find((c) =>
      c.controles.some((control) => control.paso),
    );
    expect(cierra?.cantidad?.toString()).toBe('2');
    expect(cierra?.cantidadFacturada?.toString()).toBe('2');
    expect(cierra?.unidadFacturada).toBe('UNIT');
    expect(cierra?.kilos).toBeNull();
  });

  it('sin la columna de texto, el renglón sobrevive por su aritmética', () => {
    /*
     * La descripción es lo que identifica el artículo para una persona, pero no
     * es lo que demuestra que el renglón existe: eso lo demuestra la cuenta. Una
     * fila donde cantidad × precio da el importe impreso es un artículo aunque
     * el OCR no haya leído su nombre, y tirarla es perder una compra entera por
     * una palabra.
     */
    const sinTexto = columnas.map((c, i) => (i === 1 ? null : c));
    const candidatas = candidatasDeRenglon(filaDeBarraza(), sinTexto, 'ar');
    const cierra = candidatas.find((c) => c.controles.some((x) => x.paso));
    expect(cierra).toBeDefined();
    expect(cierra!.descripcion).toBe('');
    expect(cierra!.importe?.toString()).toBe('234997.69');
  });

  it('pero sin texto ni cuenta propia no hay renglón', () => {
    /*
     * La otra mitad de la garantía: no es que ahora entre cualquier cosa. Sin
     * nombre **y** sin con qué comprobarse, una línea no es un artículo: es una
     * fila de números sueltos que nadie puede verificar ni asociar a un producto.
     */
    const textos = ['03', '', '27.00', '9.00', '', '16.00', ''];
    const celdas: (Celda | null)[] = textos.map((texto, i) =>
      texto === '' ? null : { texto, desde: i, hasta: i },
    );
    const sinNadaQueComprobar: FilaDeDatos = {
      linea: 0,
      cruda: '',
      celdas,
      sobrantes: [],
    };
    const sinTexto = columnas.map((c, i) => (i === 1 ? null : c));
    expect(candidatasDeRenglon(sinNadaQueComprobar, sinTexto, 'ar')).toEqual([]);
  });
});

describe('cómo se clasifica lo que hay en una celda', () => {
  it('un número con la unidad pegada sigue siendo un número', () => {
    // La columna CANTIDAD de Errecalde imprime los kilos con la unidad.
    expect(formasDe('785kg').numero).toBe(true);
    expect(formasDe('18.38 kg').numero).toBe(true);
    expect(formasDe('21%').porcentaje).toBe(true);
    // Pero una descripción con números adentro no.
    expect(formasDe('TWISTOS MINIT QUESO 956X30X1').numero).toBe(false);
    expect(formasDe('TWISTOS MINIT QUESO 956X30X1').texto).toBe(true);
  });

  it('un número chico es un porcentaje con cualquiera de las dos convenciones', () => {
    /*
     * «5,000» es cinco con la coma decimal y cinco mil con la de miles. Mirar
     * una sola convención dejaba la columna «Desc.%» de Ezra sin evidencia de
     * contenido, y un comprobante que cierra exacto terminaba pidiendo una
     * confirmación inventada.
     */
    expect(formasDe('5,000').porcentaje).toBe(true);
    // Con dos separadores ya no hay ambigüedad: es un monto y nada más.
    expect(formasDe('10.361,45').porcentaje).toBe(false);
    expect(formasDe('10.361,45').monto).toBe(true);
  });

  it('un número con basura detrás es las dos cosas', () => {
    // «10,361.45 bas AA»: el precio de Barraza con dos manchas del papel pegadas.
    const formas = formasDe('10,361.45 bas AA');
    expect(formas.monto).toBe(true);
    expect(formas.texto).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// La vecindad, en sus dos sentidos
// ---------------------------------------------------------------------------

describe('el código se apoya en la descripción de al lado, y no sólo al revés', () => {
  /**
   * Una tabla sin ningún encabezado legible: lo único que queda es la forma de
   * lo que hay debajo y dónde está cada columna respecto de las otras. Es el
   * caso real de una foto con el encabezado quemado por el flash.
   */
  function sinEncabezados(): ContenidoDeColumna[] {
    return [
      columna(null, ['113', '141', '121', '112'], 0.06, 0.09),
      columna(
        null,
        ['YOGUR NATURAL', 'BATIDO FRUTOS', 'BATIDO ENTERO', 'YOGUR FRAMBUESA'],
        0.18,
        0.38,
      ),
      columna(null, ['6,000', '2,000', '5,000', '4,000'], 0.62, 0.68),
      columna(null, ['1.681,33', '1.681,33', '1.681,33', '1.799,35'], 0.72, 0.78),
      columna(null, ['10.087,98', '3.362,66', '8.406,65', '7.197,40'], 0.88, 0.94),
    ];
  }

  it('reconoce la columna de códigos por su forma y su vecina', () => {
    /*
     * Sin esta evidencia la columna gana con «codigo» y se queda corta contra el
     * umbral: tiene su forma y su lugar, y ninguna tercera. Sobre una factura del
     * lote eso costaba los siete códigos del comprobante, con los números leídos,
     * en su columna y con confianza alta.
     */
    const asignadas = asignarSemantica(sinEncabezados());
    expect(asignadas[0].campo).toBe('codigo');
  });

  it('y la deja para confirmar, porque la dedujo del contenido', () => {
    const asignadas = asignarSemantica(sinEncabezados());
    expect(asignadas[0].origen).toBe('INFERRED_FROM_CONTENT');
    expect(asignadas[0].requiereConfirmacion).toBe(true);
  });

  it('la sostienen tres familias, ninguna sola alcanza', () => {
    const asignadas = asignarSemantica(sinEncabezados());
    const familias = new Set(
      asignadas[0].evidencias.filter((e) => e.campo === 'codigo').map((e) => e.familia),
    );
    expect(familias).toContain('contenido');
    expect(familias).toContain('posicion');
    expect(familias).toContain('vecindad');
  });

  it('no llama código a una columna con decimales aunque esté al lado del texto', () => {
    /*
     * Es la mitad que protege: una cantidad impresa «6,000» a la izquierda de la
     * descripción no es un código. La forma de código es un entero corto y sin
     * separadores, y eso se pide antes que la vecindad.
     */
    const conCantidadPrimero = [
      columna(null, ['6,000', '2,000', '5,000', '4,000'], 0.06, 0.12),
      columna(
        null,
        ['YOGUR NATURAL', 'BATIDO FRUTOS', 'BATIDO ENTERO', 'YOGUR FRAMBUESA'],
        0.18,
        0.38,
      ),
      columna(null, ['1.681,33', '1.681,33', '1.681,33', '1.799,35'], 0.72, 0.78),
      columna(null, ['10.087,98', '3.362,66', '8.406,65', '7.197,40'], 0.88, 0.94),
    ];
    const asignadas = asignarSemantica(conCantidadPrimero);
    expect(asignadas[0].campo).not.toBe('codigo');
    // Y no recibe siquiera la evidencia: estar al lado del texto no la hace código.
    const familias = new Set(
      asignadas[0].evidencias.filter((e) => e.campo === 'codigo').map((e) => e.familia),
    );
    expect(familias).not.toContain('vecindad');
  });

  it('ni a una columna de números que no tiene una descripción a la derecha', () => {
    // Dos columnas numéricas seguidas: la vecindad no dice nada y no se inventa.
    const sinDescripcionAlLado = [
      columna(null, ['113', '141', '121', '112'], 0.06, 0.09),
      columna(null, ['6', '2', '5', '4'], 0.12, 0.16),
      columna(null, ['10.087,98', '3.362,66', '8.406,65', '7.197,40'], 0.88, 0.94),
    ];
    const familias = new Set(
      asignarSemantica(sinDescripcionAlLado)[0]
        .evidencias.filter((e) => e.campo === 'codigo')
        .map((e) => e.familia),
    );
    expect(familias).not.toContain('vecindad');
  });
});
