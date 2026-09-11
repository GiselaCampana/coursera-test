import { describe, it, expect } from 'vitest';
import { reconstruirTabla } from '@/lib/ocr/reconstruccion/reconstruccion';
import { evidenciaNormalizada } from '@/lib/ocr/reconstruccion/evidencia';
import { medirInclinacion } from '@/lib/ocr/reconstruccion/inclinacion';
import {
  ALTO,
  RENGLONES,
  SALTO,
  TITULOS,
  Y_TITULOS,
  evidencia,
  fila,
  palabra,
  tablaBase,
} from '@/../tests/fixtures/evidencia-sintetica';
import type { Fragmento } from '@/lib/ocr/reconstruccion/evidencia';
import type { TablaReconstruida } from '@/lib/ocr/reconstruccion/reconstruccion';

/**
 * La reconstrucción de la tabla, mecanismo por mecanismo.
 *
 * Sobre una foto real fallan seis cosas a la vez y no se puede saber cuál
 * arregló un cambio. Acá cada prueba escribe la evidencia con las coordenadas
 * exactas que provocan **un** problema, y verifica que la reconstrucción lo
 * resuelve sin romper el resto.
 *
 * La medición contra las fotos de verdad está en `motor-fotos-reales`. Las dos
 * hacen falta: sin ésta no se sabe por qué algo funciona, y sin aquélla no se
 * sabe si funciona.
 */

/** El texto de cada celda de un renglón, con `·` donde no hay nada. */
function textos(tabla: TablaReconstruida, indice = 0): string[] {
  return tabla.renglones[indice].celdas.map((c) => c?.texto ?? '·');
}

/** Los renglones que quedaron, como texto plano, para comparar de un vistazo. */
function comoTexto(tabla: TablaReconstruida): string[] {
  return tabla.renglones.map((r) => r.celdas.map((c) => c?.texto ?? '·').join('|'));
}

function reconstruir(fragmentos: Fragmento[]): TablaReconstruida {
  return reconstruirTabla(evidencia(fragmentos));
}

describe('la tabla base, para tener contra qué comparar', () => {
  const tabla = reconstruir(tablaBase());

  it('sale entera, con sus tres renglones y sus cinco columnas', () => {
    expect(tabla.renglones).toHaveLength(3);
    expect(tabla.columnas).toHaveLength(5);
    expect(comoTexto(tabla)).toEqual([
      '47|Cremoso|4|5.700,00|22.800,00',
      '48|Provolone|2|9.600,00|19.200,00',
      '10|Jamon|3|9.800,00|29.400,00',
    ]);
  });

  it('los límites salen de los datos, no del título, y queda dicho', () => {
    expect(tabla.metodo).toBe('datos-con-titulos');
  });

  it('la evidencia está normalizada', () => {
    expect(evidenciaNormalizada(evidencia(tablaBase()))).toBe(true);
  });
});

describe('una fila inclinada', () => {
  /*
   * Medio grado sobre una página apaisada mueve el borde derecho casi un uno por
   * ciento del alto: más que el alto de un renglón. Sin enderezar, el código de
   * una fila se junta con el importe de la de arriba.
   */
  const PENDIENTE = ALTO * 1.2;
  const inclinada = tablaBase({ pendiente: PENDIENTE });

  it('se mide la inclinación en vez de suponerla', () => {
    const medida = medirInclinacion(inclinada);
    expect(medida.pendiente).toBeGreaterThan(PENDIENTE * 0.6);
    expect(medida.apoyos).toBeGreaterThan(8);
  });

  it('los renglones salen enteros igual que sin inclinación', () => {
    const tabla = reconstruir(inclinada);
    expect(tabla.seEnderezo).toBe(true);
    expect(comoTexto(tabla)).toEqual(comoTexto(reconstruir(tablaBase())));
  });

  it('se informa cuánto se corrigió', () => {
    const tabla = reconstruir(inclinada);
    expect(Math.abs(tabla.inclinacionGrados)).toBeGreaterThan(0.2);
    expect(tabla.notas.join(' ')).toContain('inclinación');
  });

  it('una página derecha no se toca', () => {
    const tabla = reconstruir(tablaBase());
    expect(tabla.seEnderezo).toBe(false);
  });
});

describe('una palabra partida', () => {
  it('«22.800» y «,00» se juntan en un solo importe', () => {
    /*
     * El OCR parte los números por la coma todo el tiempo. Dos pedazos pegados
     * —sin espacio de columna en el medio— son una sola celda.
     */
    const partida = [
      ...fila(Y_TITULOS, TITULOS),
      ...fila(Y_TITULOS + SALTO, RENGLONES[0].slice(0, 4) as [string, number][]),
      palabra('22.800', 0.82, Y_TITULOS + SALTO),
      palabra(',00', 0.888, Y_TITULOS + SALTO),
      ...fila(Y_TITULOS + SALTO * 2, RENGLONES[1]),
      ...fila(Y_TITULOS + SALTO * 3, RENGLONES[2]),
    ];
    expect(textos(reconstruir(partida))[4]).toBe('22.800,00');
  });

  it('un número y una palabra NO se juntan, aunque estén pegados', () => {
    /*
     * «4» y «Cremoso» pegados son dos celdas, no una. Juntarlos es el origen
     * del corrimiento de columnas: la cantidad se va adentro del nombre y todo
     * lo que sigue se corre un lugar.
     */
    const pegados = [
      ...fila(Y_TITULOS, TITULOS),
      palabra('4', 0.185, Y_TITULOS + SALTO),
      palabra('Cremoso', 0.197, Y_TITULOS + SALTO),
      palabra('5.700,00', 0.65, Y_TITULOS + SALTO),
      palabra('22.800,00', 0.82, Y_TITULOS + SALTO),
      ...fila(Y_TITULOS + SALTO * 2, RENGLONES[1]),
      ...fila(Y_TITULOS + SALTO * 3, RENGLONES[2]),
    ];
    const tabla = reconstruir(pegados);
    const juntos = tabla.renglones[0].celdas.some((c) => c?.texto === '4Cremoso');
    expect(juntos, 'un número y una palabra no pueden fundirse en una celda').toBe(false);
  });
});

describe('dos filas cercanas que no deben mezclarse', () => {
  it('renglones apretados quedan separados', () => {
    /*
     * Es el error que trajo la factura de Lácteos Barraza: el precio del segundo
     * renglón aparecía en la línea del primero. Acá las filas están a un alto y
     * medio de distancia, que es lo apretado que imprime un comprobante de
     * verdad.
     */
    const apretadas = [
      ...fila(Y_TITULOS, TITULOS),
      ...fila(Y_TITULOS + 0.02, RENGLONES[0]),
      ...fila(Y_TITULOS + 0.02 + ALTO * 1.5, RENGLONES[1]),
      ...fila(Y_TITULOS + 0.02 + ALTO * 3, RENGLONES[2]),
    ];
    const tabla = reconstruir(apretadas);
    expect(tabla.renglones).toHaveLength(3);
    expect(comoTexto(tabla)[0]).toContain('22.800,00');
    expect(comoTexto(tabla)[1]).toContain('19.200,00');
    expect(comoTexto(tabla)[0]).not.toContain('19.200,00');
  });

  it('una celda alta no se traga el renglón de abajo', () => {
    // Tesseract estira la caja de un número con paréntesis o con una coma
    // baja. Esa caja toca el renglón siguiente sin ser parte de él.
    const conCeldaAlta = [
      ...fila(Y_TITULOS, TITULOS),
      ...fila(Y_TITULOS + 0.02, RENGLONES[0].slice(0, 4) as [string, number][]),
      palabra('22.800,00', 0.82, Y_TITULOS + 0.02, { alto: ALTO * 2.4 }),
      ...fila(Y_TITULOS + 0.02 + ALTO * 2, RENGLONES[1]),
    ];
    const tabla = reconstruir(conCeldaAlta);
    expect(tabla.renglones).toHaveLength(2);
    expect(comoTexto(tabla)[1]).not.toContain('22.800,00');
  });
});

describe('una columna leída como bloque vertical', () => {
  it('los importes apilados vuelven cada uno a su renglón', () => {
    /*
     * Tesseract desarma la tabla y entrega la columna de importes como un
     * bloque aparte: los tres números seguidos, separados de sus filas. Es lo
     * que pasa en la página completa de la factura de Ezra.
     *
     * Como la evidencia conserva las coordenadas, el bloque no es un problema:
     * cada número está a la altura de su renglón y ahí vuelve. Con texto
     * aplanado esto no tenía arreglo.
     */
    const enBloque = [
      ...fila(Y_TITULOS, TITULOS),
      ...RENGLONES.flatMap((celdas, i) =>
        fila(Y_TITULOS + SALTO * (i + 1), celdas.slice(0, 4) as [string, number][]),
      ),
      // La columna de importes, leída aparte y en otra pasada.
      palabra('22.800,00', 0.82, Y_TITULOS + SALTO, { pasada: 'articulos:directo' }),
      palabra('19.200,00', 0.82, Y_TITULOS + SALTO * 2, { pasada: 'articulos:directo' }),
      palabra('29.400,00', 0.82, Y_TITULOS + SALTO * 3, { pasada: 'articulos:directo' }),
    ];
    expect(comoTexto(reconstruir(enBloque))).toEqual([
      '47|Cremoso|4|5.700,00|22.800,00',
      '48|Provolone|2|9.600,00|19.200,00',
      '10|Jamon|3|9.800,00|29.400,00',
    ]);
  });
});

describe('un número que sólo trajo otra pasada', () => {
  const faltaEnLaPrincipal = [
    ...fila(Y_TITULOS, TITULOS),
    // La pasada principal perdió el precio del primer renglón.
    ...fila(Y_TITULOS + SALTO, [
      ...RENGLONES[0].slice(0, 3),
      RENGLONES[0][4],
    ] as [string, number][]),
    ...fila(Y_TITULOS + SALTO * 2, RENGLONES[1]),
    ...fila(Y_TITULOS + SALTO * 3, RENGLONES[2]),
    // La relectura ampliada sí lo trajo.
    palabra('5.700,00', 0.65, Y_TITULOS + SALTO, { pasada: 'articulos:limpieza-fuerte' }),
  ];

  it('el valor entra al renglón aunque venga de otra pasada', () => {
    const tabla = reconstruir(faltaEnLaPrincipal);
    expect(textos(tabla)[3]).toBe('5.700,00');
  });

  it('queda registrado de qué pasada salió', () => {
    const tabla = reconstruir(faltaEnLaPrincipal);
    const celda = tabla.renglones[0].celdas[3]!;
    expect(celda.procedencia?.pasada).toBe('articulos:limpieza-fuerte');
    expect(tabla.valoresDeOtraPasada).toBeGreaterThan(0);
  });

  it('una celda de una pasada convive con otra celda de otra en el mismo renglón', () => {
    // Es el punto entero de tener varias pasadas: no elegir la mejor, sino
    // poder armar un renglón con lo mejor de cada una.
    const tabla = reconstruir(faltaEnLaPrincipal);
    const pasadas = tabla.renglones[0].celdas.map((c) => c?.procedencia?.pasada);
    expect(new Set(pasadas.filter(Boolean)).size).toBeGreaterThan(1);
  });
});

describe('dos alternativas para la misma celda', () => {
  it('las dos lecturas se conservan y la celda queda marcada como ambigua', () => {
    /*
     * Dos pasadas leen el mismo importe distinto: una dice 22.800,00 y la otra
     * 22.8OO,OO. No se elige acá —no hay con qué— y las dos quedan para que
     * decida la aritmética.
     */
    const enDesacuerdo = [
      ...tablaBase(),
      palabra('22.8OO,OO', 0.82, Y_TITULOS + SALTO, {
        pasada: 'articulos:limpieza-fuerte',
        confianza: 0.6,
      }),
    ];
    const tabla = reconstruir(enDesacuerdo);
    const celda = tabla.renglones[0].celdas[4]!;
    const textos = celda.alternativas.map((a) => a.texto);
    expect(textos).toContain('22.800,00');
    expect(textos).toContain('22.8OO,OO');
    expect(celda.estado).toBe('ambigua');

    // Y cada alternativa trae de dónde salió, para poder señalarla en la foto.
    for (const alternativa of celda.alternativas) {
      expect(alternativa.pasada.length).toBeGreaterThan(0);
      expect(alternativa.caja.x1).toBeGreaterThan(alternativa.caja.x0);
    }
    expect(celda.alternativas.map((a) => a.pasada)).toContain('articulos:limpieza-fuerte');
  });

  it('gana la lectura con más apoyo, no la más confiada de una sola pasada', () => {
    /*
     * Dos pasadas que coinciden valen más que una sola muy segura: son dos
     * preparaciones distintas de la imagen diciendo lo mismo, y eso es
     * evidencia independiente.
     */
    const dosContraUna = [
      ...tablaBase(),
      palabra('22.800,00', 0.82, Y_TITULOS + SALTO, {
        pasada: 'articulos:directo',
        confianza: 0.7,
      }),
      palabra('22.8OO,OO', 0.82, Y_TITULOS + SALTO, {
        pasada: 'articulos:limpieza-fuerte',
        confianza: 0.99,
      }),
    ];
    expect(textos(reconstruir(dosContraUna))[4]).toBe('22.800,00');
  });

  it('las alternativas que ofrece el propio OCR también se conservan', () => {
    const conAlternativa = [
      ...fila(Y_TITULOS, TITULOS),
      ...fila(Y_TITULOS + SALTO, RENGLONES[0].slice(0, 4) as [string, number][]),
      palabra('22.8OO,OO', 0.82, Y_TITULOS + SALTO, { alternativas: ['22.800,00'] }),
      ...fila(Y_TITULOS + SALTO * 2, RENGLONES[1]),
      ...fila(Y_TITULOS + SALTO * 3, RENGLONES[2]),
    ];
    const celda = reconstruir(conAlternativa).renglones[0].celdas[4]!;
    const propuesta = celda.alternativas.find((a) => a.texto === '22.800,00');
    expect(propuesta).toBeDefined();
    // Viene del propio OCR, no de otra pasada: queda marcado como tal.
    expect(propuesta!.delPropioOcr).toBe(true);
    expect(celda.estado).toBe('ambigua');
  });
});

describe('un código que no se leyó', () => {
  it('la celda queda vacía y las demás columnas NO se corren', () => {
    /*
     * Es la diferencia entre un dato que falta y una tabla arruinada. En la
     * factura de Lácteos Barraza el código de un renglón no está en el texto
     * del OCR: lo correcto es dejarlo vacío y decirlo, no correr la cantidad al
     * lugar del código y todo lo demás detrás.
     */
    const sinCodigo = [
      ...fila(Y_TITULOS, TITULOS),
      ...fila(Y_TITULOS + SALTO, RENGLONES[0].slice(1) as [string, number][]),
      ...fila(Y_TITULOS + SALTO * 2, RENGLONES[1]),
      ...fila(Y_TITULOS + SALTO * 3, RENGLONES[2]),
    ];
    const tabla = reconstruir(sinCodigo);
    expect(comoTexto(tabla)[0]).toBe('·|Cremoso|4|5.700,00|22.800,00');
    expect(tabla.renglones[0].estado).toBe('incompleto');
  });
});

describe('un renglón contaminado con valores del siguiente', () => {
  it('el valor que no entra en ninguna columna se aparta, no se reparte', () => {
    /*
     * El caso de Lácteos Barraza: el precio del segundo renglón aparece al
     * final de la línea del primero, fuera de toda columna. Meterlo en la
     * columna más cercana lo esconde; apartarlo es lo que permite darse cuenta.
     */
    const contaminado = [
      ...tablaBase(),
      palabra('9.453,76', 0.955, Y_TITULOS + SALTO),
    ];
    const tabla = reconstruir(contaminado);
    expect(tabla.renglones[0].estado).toBe('contaminado');
    expect(tabla.renglones[0].sobrantes.map((s) => s.texto)).toContain('9.453,76');
    // Y no ensució ninguna celda buena.
    expect(comoTexto(tabla)[0]).toBe('47|Cremoso|4|5.700,00|22.800,00');
  });
});

describe('la resolución y la escala no cambian nada', () => {
  it('la misma factura en otra resolución da la misma tabla', () => {
    /*
     * Todo está normalizado a 0..1, así que una foto de 1080 y una de 4032
     * tienen que dar exactamente lo mismo. Es lo que permite que una pasada
     * sobre un recorte ampliado se compare con una sobre la página entera.
     */
    const chica = reconstruirTabla(evidencia(tablaBase(), { anchoPx: 1080, altoPx: 1440 }));
    const grande = reconstruirTabla(evidencia(tablaBase(), { anchoPx: 3024, altoPx: 4032 }));
    expect(comoTexto(chica)).toEqual(comoTexto(grande));
    expect(chica.columnas.length).toBe(grande.columnas.length);
  });

  it('una tabla más chica dentro de la página da los mismos renglones', () => {
    // La misma tabla impresa al 60 % y corrida: cambian las coordenadas, no la
    // estructura. El alto de renglón sale de la evidencia y no de una constante.
    const encogida = tablaBase().map((f) => ({
      ...f,
      caja: {
        x0: f.caja.x0 * 0.6 + 0.2,
        y0: f.caja.y0 * 0.6 + 0.1,
        x1: f.caja.x1 * 0.6 + 0.2,
        y1: f.caja.y1 * 0.6 + 0.1,
      },
    }));
    expect(comoTexto(reconstruir(encogida))).toEqual(comoTexto(reconstruir(tablaBase())));
  });
});

describe('las pasadas son un conjunto, no una secuencia', () => {
  const conDosPasadas = [
    ...tablaBase(),
    ...fila(Y_TITULOS + SALTO, RENGLONES[0], { pasada: 'articulos:limpieza-fuerte' }),
    ...fila(Y_TITULOS + SALTO * 2, RENGLONES[1], { pasada: 'articulos:limpieza-fuerte' }),
  ];

  it('el orden en que llegan no cambia el resultado', () => {
    const alReves = [...conDosPasadas].reverse();
    expect(comoTexto(reconstruir(alReves))).toEqual(comoTexto(reconstruir(conDosPasadas)));
  });

  it('mezcladas tampoco', () => {
    // Un orden estable pero distinto: por x en vez de por llegada.
    const mezcladas = [...conDosPasadas].sort((a, b) => a.caja.x0 - b.caja.x0);
    expect(comoTexto(reconstruir(mezcladas))).toEqual(comoTexto(reconstruir(conDosPasadas)));
  });

  it('si se pierde una pasada entera, se sigue con lo que hay', () => {
    /*
     * Una pasada puede no llegar: el teléfono se quedó sin memoria, el usuario
     * cerró la pantalla, la relectura del borde no encontró la franja. La
     * reconstrucción tiene que degradarse, no caerse.
     */
    const sinLaSegunda = conDosPasadas.filter((f) => f.pasada === 'completo:directo');
    const tabla = reconstruir(sinLaSegunda);
    expect(tabla.renglones).toHaveLength(3);
    expect(comoTexto(tabla)).toEqual(comoTexto(reconstruir(tablaBase())));
  });

  it('si se pierde la principal, las otras alcanzan', () => {
    const soloLaOtra = conDosPasadas.filter((f) => f.pasada !== 'completo:directo');
    const tabla = reconstruir(soloLaOtra);
    expect(tabla.renglones.length).toBeGreaterThanOrEqual(2);
    expect(comoTexto(tabla)[0]).toContain('22.800,00');
  });
});

describe('la procedencia de cada valor es auditable', () => {
  it('cada celda dice de qué pasada salió, con qué confianza y dónde está', () => {
    /*
     * Sin esto, una lectura equivocada no se puede investigar: hay un número en
     * la pantalla y nadie sabe de dónde vino. Con esto se puede señalar el
     * lugar de la foto y decir qué pasada lo leyó.
     */
    const tabla = reconstruir(tablaBase());
    for (const celda of tabla.renglones[0].celdas) {
      expect(celda?.procedencia).not.toBeNull();
      expect(celda!.procedencia!.pasada).toBe('completo:directo');
      expect(celda!.procedencia!.confianza).toBeGreaterThan(0);
      expect(celda!.procedencia!.caja.x1).toBeGreaterThan(celda!.procedencia!.caja.x0);
    }
  });

  it('la caja guardada es la de la foto, sin enderezar', () => {
    /*
     * La corrección de inclinación mueve las cajas para poder agrupar. Lo que
     * se guarda para señalar es la posición **original**: es donde el dato está
     * en la foto que mira la persona.
     */
    const PENDIENTE = ALTO * 1.2;
    const tabla = reconstruir(tablaBase({ pendiente: PENDIENTE }));
    expect(tabla.seEnderezo).toBe(true);

    const derecha = tabla.renglones[0].celdas[4]!.procedencia!.caja;
    const izquierda = tabla.renglones[0].celdas[0]!.procedencia!.caja;
    // En la foto original la celda de la derecha está más abajo que la de la
    // izquierda: si se hubiera guardado la caja corregida, estarían a la par.
    expect(derecha.y0).toBeGreaterThan(izquierda.y0);
  });
});

describe('lo que no es un dato', () => {
  it('los bordes y las rayas no forman columnas', () => {
    /*
     * El borde de la tabla sale como «|» y las líneas como «—». Son decenas por
     * factura, y al proyectar los datos sobre el ancho de la página tapan los
     * corredores entre columnas: una tabla de cinco columnas termina siendo una.
     */
    const conBordes = [
      ...tablaBase(),
      ...RENGLONES.map((_, i) => palabra('|', 0.45, Y_TITULOS + SALTO * (i + 1))),
      ...RENGLONES.map((_, i) => palabra('—', 0.60, Y_TITULOS + SALTO * (i + 1))),
    ];
    const tabla = reconstruir(conBordes);
    expect(comoTexto(tabla)).toEqual(comoTexto(reconstruir(tablaBase())));
    expect(tabla.notas.join(' ')).toContain('ningún carácter legible');
  });

  it('el pie no entra como un renglón más', () => {
    /*
     * «Neto 71.400,00 IVA 14.994,00» tiene números grandes repartidos en
     * columnas y pasa por un artículo perfectamente. Sobre la factura de
     * Mabelherdi entraba como una fila más de la tabla.
     */
    const conPie = [
      ...tablaBase(),
      ...fila(Y_TITULOS + SALTO * 4.5, [
        ['Neto', 0.05],
        ['71.400,00', 0.65],
        ['14.994,00', 0.82],
      ]),
    ];
    const tabla = reconstruir(conPie);
    expect(tabla.renglones).toHaveLength(3);
    expect(comoTexto(tabla).join(' ')).not.toContain('71.400,00');
    expect(tabla.notas.join(' ')).toContain('del pie');
  });
});
