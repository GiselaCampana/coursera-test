import { describe, it, expect } from 'vitest';
import { Decimal, parseArNumber } from '@/lib/money';
import {
  analizadorErrecalde,
  analizarArticulos,
  analizarFila,
  jironesSinResolver,
} from '@/lib/ocr/parsers/errecalde';
import {
  SAFARI2_ARTICULOS,
  SAFARI2_COMPLETO,
  SAFARI2_TEXTOS,
  SAFARI2_ESPERADO,
} from '../fixtures/errecalde-safari-2';

/**
 * Segunda corrida real en Safari sobre la misma foto de Errecalde.
 *
 * Dos fallas que la primera corrida no tenía, y que son los dos modos de fallar
 * que más caro salen:
 *
 *  1. **Un renglón imposible.** SARDO BLOQUE llegó una sola vez y degradado, y
 *     el analizador lo dio por bueno en $6.315.243 dentro de una factura de
 *     $3.830.467. Un renglón que no cabe en el comprobante no puede sobrevivir
 *     a ninguna selección, y da igual que sea la única lectura que hay.
 *
 *  2. **Una fila que se perdieron los dos mecanismos a la vez.** TOMATE EN
 *     BOTELLA no salió del recorte de la tabla, y el detector de filas tampoco
 *     lo contó: el comprobante quedaba en "22 interpretados / 22 filas vistas",
 *     en verde, con un artículo de menos. Hace falta una tercera señal que no
 *     dependa de ninguna de las dos.
 */

const NETO = new Decimal(SAFARI2_ESPERADO.netTotal);

describe('el renglón que no cabe en el comprobante', () => {
  const DEGRADADO =
    'ART-00758 SARDO BLOQUE MELINCUE                                L 3 A75kg  $13.29525 0% 21%  $6315243';

  it('deduce la escala de SARDO BLOQUE con el precio y el subtotal', () => {
    const fila = analizarFila(DEGRADADO, NETO);

    /*
     * De "A75kg $13.29525 ... $6315243" no cierra nada: 75 × 13,30 da $997 y el
     * subtotal leído es $6.315.243.
     *
     * Lo que sí se sostiene: de los subtotales posibles sólo $63.152,43 entra en
     * la factura, de los precios posibles sólo $13.295,25 lo divide en una
     * cantidad de dos decimales, y esa cantidad —4,75— termina en el "75" que el
     * OCR sí leyó, con una "A" delante donde estaba el 4.
     */
    expect(fila?.cantidad.toString()).toBe('4.75');
    expect(fila?.precio?.toFixed(2)).toBe('13295.25');
    expect(fila?.subtotal.toFixed(2)).toBe('63152.43');
    expect(fila?.subtotalImpreso).toBe(true);
  });

  it('sin el neto impreso no deduce nada: no hay contra qué', () => {
    /*
     * La deducción se apoya entera en la cota del pie. Sin ella no hay forma de
     * saber que $6.315.243 es imposible, y el analizador no tiene que inventar
     * una: devuelve lo que leyó y el control se encarga.
     *
     * Esta prueba existe para que la deducción no se vuelva un arreglo que
     * corre siempre: si algún día pasara sin cota, estaría adivinando.
     */
    const fila = analizarFila(DEGRADADO, null);
    expect(fila?.subtotal.toFixed(2)).toBe('6315243.00');
  });

  it('no acepta una cantidad sin rastro de los dígitos que faltan', () => {
    /*
     * La misma fila, pero sin la "A" delante del 75. Ahora los dígitos leídos
     * son "75" y no hay nada que respalde un cuarto dígito adelante, así que
     * deducir 4,75 sería inventarlo.
     */
    const sinRastro = DEGRADADO.replace('A75kg', ' 75kg');
    const fila = analizarFila(sinRastro, NETO);

    expect(fila?.cantidad.toString()).not.toBe('4.75');
    // Pero el importe imposible tampoco sobrevive.
    expect(fila!.subtotal.lte(NETO)).toBe(true);
  });

  it('ningún renglón supera el neto impreso, pase lo que pase', () => {
    /*
     * La invariante final, después de toda fusión y selección. No importa por
     * qué camino llegó el número: si no cabe en el comprobante, no sale de acá.
     */
    const { items } = analizarArticulos(SAFARI2_ARTICULOS, SAFARI2_COMPLETO, {
      netoImpreso: NETO,
    });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      if (!item.grossSubtotal) continue;
      const subtotal = parseArNumber(item.grossSubtotal)!;
      expect(
        subtotal.lte(NETO.times(1.02)),
        `${item.description} quedó en ${subtotal.toFixed(2)}, que no cabe en ${NETO.toFixed(2)}`,
      ).toBe(true);
    }
  });

  it('ROQUEFORT AZUL también se acomoda contra el neto', () => {
    // Mismo problema, otra fila: "é 8 1921kg  s1045208 ... $20078437".
    const { items } = analizarArticulos(SAFARI2_ARTICULOS, SAFARI2_COMPLETO, {
      netoImpreso: NETO,
    });
    const roquefort = items.find((i) => i.description?.includes('ROQUEFORT AZUL'));
    expect(roquefort?.quantity).toBe('19.21');
    expect(parseArNumber(roquefort!.unitNetPrice!)!.toFixed(2)).toBe('10452.08');
    expect(parseArNumber(roquefort!.grossSubtotal!)!.toFixed(2)).toBe('200784.37');
  });
});

describe('la fila que se perdieron el detector y el analizador a la vez', () => {
  it('detecta el jirón de TOMATE EN BOTELLA en la página completa', () => {
    const { items, filasSinResolver } = analizarArticulos(SAFARI2_ARTICULOS, SAFARI2_COMPLETO, {
      netoImpreso: NETO,
    });

    // Veintidós renglones interpretados y una fila más que se ve pero no se lee.
    expect(items).toHaveLength(22);
    expect(filasSinResolver).toBe(1);
    // Que es lo que hace que el total vuelva a ser 23.
    expect(items.length + filasSinResolver).toBe(SAFARI2_ESPERADO.renglones);
  });

  it('el jirón se nombra en las observaciones con su texto crudo', () => {
    const { avisos } = analizarArticulos(SAFARI2_ARTICULOS, SAFARI2_COMPLETO, {
      netoImpreso: NETO,
    });
    const aviso = avisos.find((a) => a.includes('forma de renglón'));
    expect(aviso).toBeDefined();
    // El texto tal cual, para que se pueda ir a buscar a la foto.
    expect(aviso).toContain('$3268324');
    expect(aviso).toContain('32683.24');
    expect(aviso).toContain('Falta un artículo');
  });

  it('no inventa jirones donde las filas ya están interpretadas', () => {
    /*
     * La página completa trae además media docena de pedazos de filas que **sí**
     * están leídas —"RRA MELIN", "T-024. BARRAZA X5KG", "A75kg — $13.29525"—.
     * Todos tienen la forma de una fila, y ninguno es una fila nueva: sus
     * importes son los de renglones que ya se interpretaron.
     *
     * Si el detector los contara, el control diría que faltan seis artículos que
     * no faltan, y el comprobante no se podría guardar nunca.
     */
    const filas = SAFARI2_ARTICULOS.split('\n')
      .map((l) => analizarFila(l.trim(), NETO))
      .filter((f) => f !== null);
    const jirones = jironesSinResolver([SAFARI2_ARTICULOS, SAFARI2_COMPLETO], filas, NETO);

    expect(jirones).toHaveLength(1);
    expect(jirones[0].linea).toContain('3268324');
  });

  it('los kilos de los veintidós que sí se leyeron dan los del papel', () => {
    /*
     * TOMATE se vende por unidad, así que los kilos no dependen de él: los 480,34
     * del papel tienen que salir enteros de los veintidós renglones leídos.
     *
     * Es la prueba de que la deducción de escala de SARDO y ROQUEFORT no movió
     * ninguna cantidad de las que ya estaban bien.
     */
    const { items } = analizarArticulos(SAFARI2_ARTICULOS, SAFARI2_COMPLETO, {
      netoImpreso: NETO,
    });
    const kilos = items
      .filter((i) => i.unit === 'KG')
      .reduce((suma, i) => suma.plus(i.quantity ?? '0'), new Decimal(0));

    expect(kilos.toFixed(2)).toBe(SAFARI2_ESPERADO.kilos);
    expect(items.filter((i) => i.unit === 'KG')).toHaveLength(SAFARI2_ESPERADO.articulosPorKilo);
  });

  it('lo leído más lo que falta da el neto impreso', () => {
    /*
     * Los veintidós renglones suman $3.797.783,80 y el jirón vale $32.683,24.
     * Juntos dan $3.830.467,04, contra los $3.830.467,37 que imprime el papel:
     * treinta y tres centavos, que son el redondeo del subtotal calculado de
     * PERNIL —el único renglón cuyo importe no entró en el recorte—.
     *
     * O sea que no falta ningún otro artículo: falta exactamente ése.
     */
    const { items } = analizarArticulos(SAFARI2_ARTICULOS, SAFARI2_COMPLETO, {
      netoImpreso: NETO,
    });
    const suma = items.reduce((total, i) => {
      const impreso = i.grossSubtotal ? parseArNumber(i.grossSubtotal) : null;
      const calculado = new Decimal(i.quantity ?? '0').times(i.unitNetPrice ?? '0');
      return total.plus(impreso ?? calculado);
    }, new Decimal(0));

    const conElJiron = suma.plus('32683.24');
    expect(conElJiron.minus(NETO).abs().lte(1)).toBe(true);
  });
});

describe('un pie que no puede ser el pie', () => {
  it('descarta un neto más chico que el renglón mediano', () => {
    /*
     * Sin el recorte del pie, de la página completa sola salía un neto de $4, un
     * IVA de $1 y un total de $5. Los tres cierran entre sí —4 + 1 = 5— así que
     * ninguna comprobación aritmética los descarta.
     *
     * Lo que los descarta es una cuenta que no falla nunca: el neto de un
     * comprobante es la suma de sus renglones, así que no puede ser menor que el
     * renglón del medio. Con veintidós renglones de seis cifras, un neto de $4
     * no es el neto.
     *
     * Importa que el pie se descarte **entero** y no que se use igual: ese neto
     * de $4 es la cota contra la que se miden todos los renglones, y con él
     * puesto los veintidós quedaban sin importe.
     */
    const analisis = analizadorErrecalde.analizar(SAFARI2_TEXTOS);

    expect(analisis.summary?.netTotal).toBeNull();
    expect(analisis.summary?.total).toBeNull();
    expect(analisis.observaciones.some((o) => o.includes('no puede ser menor que uno de sus'))).toBe(
      true,
    );
  });

  it('y al descartarlo no se lleva puestos los renglones', () => {
    // Sin cota los renglones se leen como salieron, que es lo honesto: lo que no
    // puede pasar es que una cota falsa los borre a todos.
    const analisis = analizadorErrecalde.analizar(SAFARI2_TEXTOS);
    expect(analisis.items).toHaveLength(22);
    expect(analisis.items.filter((i) => i.grossSubtotal !== null).length).toBeGreaterThan(18);
  });
});
