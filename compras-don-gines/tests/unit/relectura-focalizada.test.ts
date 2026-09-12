import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { interpretarReconstruccion } from '@/lib/ocr/motor/desde-reconstruccion';
import type { InformeReconstruido } from '@/lib/ocr/motor/desde-reconstruccion';
import type { EvidenciaDeLectura } from '@/lib/ocr/reconstruccion/evidencia';
import {
  DIGITOS_Y_SEPARADORES,
  PRESUPUESTO_DE_RELECTURA,
  celdasParaReleer,
  convieneReleer,
  planDeRelectura,
  sumarRelectura,
  variantesDeRelectura,
  zonasDeRelectura,
  type CeldaParaReleer,
  type EvidenciaDeRelectura,
} from '@/lib/ocr/reconstruccion/relectura';
import { soloBloqueantes } from '@/lib/ocr/motor/pendientes';

/**
 * La relectura focalizada, sobre las fotos reales.
 *
 * Cuando la primera reconstrucción termina incompleta, el motor sabe mucho más
 * que al empezar: sabe qué renglón falla, qué columna le falta, dónde debería
 * estar esa celda y qué igualdad tiene que cumplir. Nada de eso se usaba: la
 * celda quedaba como bloqueo y la persona la tipeaba, leyendo con los ojos
 * exactamente el mismo pedazo de papel que la máquina puede volver a mirar.
 *
 * La evidencia de la relectura está capturada de las fotos de verdad con
 * `scripts/capturar-relectura.mjs` —a partir del plan que genera
 * `scripts/plan-de-relectura.ts`— y guardada como fixture aparte, así que estas
 * pruebas corren en milisegundos y son determinísticas.
 */

const DIRECTORIO = path.resolve(__dirname, '../fixtures/evidencia');
const CUIT_DEL_RECEPTOR = '27-33342291-9';

function leer(nombre: string): EvidenciaDeLectura {
  return JSON.parse(readFileSync(path.join(DIRECTORIO, `${nombre}.json`), 'utf8'));
}

function relecturaDe(nombre: string): EvidenciaDeRelectura | undefined {
  const archivo = path.join(DIRECTORIO, `${nombre}-relectura.json`);
  return existsSync(archivo) ? JSON.parse(readFileSync(archivo, 'utf8')) : undefined;
}

function interpretar(nombre: string, conRelectura = false): InformeReconstruido {
  return interpretarReconstruccion(leer(nombre), {
    cuitDelReceptor: CUIT_DEL_RECEPTOR,
    relectura: conRelectura ? relecturaDe(nombre) : undefined,
  });
}

const ERRECALDE = interpretar('errecalde');
const ERRECALDE_RELEIDO = interpretar('errecalde', true);

describe('qué se pide releer, y con qué', () => {
  it('sólo las celdas que frenan el comprobante y tienen una posición esperada', () => {
    const celdas = celdasParaReleer(ERRECALDE.tabla, ERRECALDE.pendientes);
    expect(celdas.length).toBeGreaterThan(0);

    // Cada pedido sabe qué renglón, qué columna, qué tipo de dato y dónde.
    for (const celda of celdas) {
      expect(celda.renglon).toBeGreaterThan(0);
      expect(celda.columna).not.toBe('');
      expect(['numero', 'texto']).toContain(celda.tipo);
      expect(celda.caja.x1).toBeGreaterThan(celda.caja.x0);
      expect(celda.caja.y1).toBeGreaterThan(celda.caja.y0);
      // Y la caja está dentro de la página, porque de ahí salen los recortes.
      expect(celda.caja.x0).toBeGreaterThanOrEqual(0);
      expect(celda.caja.y1).toBeLessThanOrEqual(1);
    }

    /*
     * Sólo las bloqueantes. Una advertencia —«este valor podría ser de otra
     * fila»— no justifica gastar medio segundo de OCR: el comprobante avanza
     * igual sin resolverla.
     */
    const categorias = new Set(
      ERRECALDE.pendientes
        .filter((p) => celdas.some((c) => c.renglon === p.renglon && c.motivo === p.motivo))
        .map((p) => p.categoria),
    );
    for (const categoria of categorias) {
      expect(['BLOCKING_MISSING_CELL', 'BLOCKING_AMBIGUOUS_CELL']).toContain(categoria);
    }
  });

  it('un comprobante que se leyó entero no se relee', () => {
    /*
     * La compuerta: la relectura se activa **después** de que la primera
     * reconstrucción quedó incompleta, nunca antes. Ezra se lee sola y no tiene
     * un solo bloqueo, así que no hay nada que volver a mirar.
     */
    const ezra = interpretar('ezra');
    expect(soloBloqueantes(ezra.pendientes)).toHaveLength(0);
    expect(convieneReleer(celdasParaReleer(ezra.tabla, ezra.pendientes))).toBe(false);
    expect(planDeRelectura(ezra.tabla, ezra.pendientes)).toHaveLength(0);
  });

  it('las celdas se agrupan por columna en una sola banda', () => {
    /*
     * Diez celdas problemáticas de la misma columna son **una** relectura, no
     * diez: el lector tarda lo mismo en leer una banda angosta que una celda
     * sola, porque lo que cuesta es arrancar la pasada.
     */
    const celdas = celdasParaReleer(ERRECALDE.tabla, ERRECALDE.pendientes);
    const zonas = zonasDeRelectura(celdas, 99);
    expect(zonas.length).toBeLessThan(celdas.length);

    // Y la banda cubre de la celda más alta a la más baja de su columna.
    for (const zona of zonas) {
      const suyas = celdas.filter((c) => c.columna === zona.columna && c.tipo === zona.tipo);
      expect(zona.celdas).toBe(suyas.length);
      for (const celda of suyas) {
        expect(zona.caja.y0).toBeLessThanOrEqual(celda.caja.y0);
        expect(zona.caja.y1).toBeGreaterThanOrEqual(celda.caja.y1);
      }
    }
  });

  it('el presupuesto impide que esto se vuelva un ciclo o un trabajo ilimitado', () => {
    /*
     * Cuatro relecturas por comprobante y punto. Si con cuatro bandas no se
     * recuperó la celda, la celda no está en la foto y lo que corresponde es
     * decirlo, no seguir intentando.
     */
    const muchas: CeldaParaReleer[] = Array.from({ length: 40 }, (_, i) => ({
      renglon: i + 1,
      campo: 'importe',
      columna: `COL${i}`,
      caja: { x0: 0.1, y0: 0.1 + i * 0.01, x1: 0.2, y1: 0.11 + i * 0.01 },
      tipo: 'numero',
      motivo: 'falta el importe',
    }));

    expect(zonasDeRelectura(muchas)).toHaveLength(PRESUPUESTO_DE_RELECTURA);
    expect(planDeRelectura(ERRECALDE.tabla, ERRECALDE.pendientes).length).toBeLessThanOrEqual(
      PRESUPUESTO_DE_RELECTURA,
    );

    // Y el presupuesto se gasta donde más se recupera: la banda con más celdas
    // problemáticas va primero.
    const porColumna = zonasDeRelectura(
      [
        ...muchas.slice(0, 1).map((c) => ({ ...c, columna: 'POCAS' })),
        ...muchas.slice(1, 6).map((c) => ({ ...c, columna: 'MUCHAS' })),
      ],
      1,
    );
    expect(porColumna[0].columna).toBe('MUCHAS');
  });

  it('para una celda numérica el reconocimiento se restringe a dígitos y separadores', () => {
    /*
     * Es la variante que convierte un precio ilegible en un número: sin
     * restringir, el reconocedor puede devolver una S por un 5 o una O por un
     * 0; restringido no tiene esa opción. Para el texto no se usa, porque ahí
     * las letras son el dato.
     */
    const numero = variantesDeRelectura('numero');
    expect(numero.length).toBeGreaterThanOrEqual(2);
    expect(numero.every((v) => v.alfabeto === DIGITOS_Y_SEPARADORES)).toBe(true);
    expect(new Set(numero.map((v) => v.preparacion)).size).toBeGreaterThan(1);

    const texto = variantesDeRelectura('texto');
    expect(texto.every((v) => v.alfabeto === null)).toBe(true);
  });
});

describe('la evidencia de la relectura entra al mismo motor', () => {
  it('se suma a la original sin reemplazar nada', () => {
    const original = leer('errecalde');
    const extra = relecturaDe('errecalde')!;
    const junta = sumarRelectura(original, extra);

    // Todo lo que se había leído sigue estando, en el mismo orden.
    expect(junta.fragmentos.slice(0, original.fragmentos.length)).toEqual(original.fragmentos);
    expect(junta.fragmentos).toHaveLength(original.fragmentos.length + extra.fragmentos.length);
    expect(junta.anchoPx).toBe(original.anchoPx);

    // Y cada fragmento nuevo conserva de qué pasada de relectura salió, así que
    // en el informe se puede decir exactamente de dónde salió cada número.
    for (const fragmento of extra.fragmentos) {
      expect(fragmento.pasada).toMatch(/^relectura:/);
    }
  });

  it('recupera celdas sin alterar los renglones que ya estaban comprobados', () => {
    const informe = ERRECALDE_RELEIDO.relectura!;
    expect(informe.gano).toBe(true);
    expect(informe.comprobadosDespues).toBeGreaterThan(informe.comprobadosAntes);

    /*
     * Los bloqueos **pueden subir**, y que suban no es una regresión: son los
     * que se informan. Antes de releer había renglones con un valor de otra
     * escala que cumplían su propia igualdad y no aparecían en ninguna lista;
     * con la relectura el precio verdadero aparece, la igualdad deja de cerrar
     * con la cantidad mutilada y el renglón pasa a pedir lo que le falta. Lo que
     * no puede subir es el número de renglones sin comprobar.
     */
    expect(informe.bloqueosAntes).toBeGreaterThan(0);
    expect(informe.bloqueosDespues).toBeGreaterThan(0);

    /*
     * Lo que ya estaba **confirmado de verdad** sigue igual, y «confirmado de
     * verdad» son tres cosas a la vez: se leyó tal como está impreso, se parece
     * al resto de su columna, y cumple la aritmética de su renglón. Si un
     * fragmento nuevo contradice una celda así, lo que tiene que pasar es que
     * el fragmento pierda.
     *
     * Las tres condiciones hacen falta, y descubrirlo costó una medición. En
     * esta factura hay un renglón donde el OCR perdió el separador decimal de
     * **las dos** celdas de la cuenta a la vez: la cantidad y el subtotal. Las
     * dos lecturas son literales —el papel, tal como salió, no tiene ninguna
     * coma ahí— y la igualdad cierra perfecto, porque la proporción se mantiene.
     * Un renglón diez veces más caro, sin una sola reparación y con su cuenta
     * hecha. Lo único que lo delata es que ninguno de sus veintidós vecinos de
     * columna escribe los subtotales así, y lo único que lo arregla es volver a
     * mirar el papel: releída la banda, el subtotal aparece con su coma.
     */
    const literalesQueCerraban = ERRECALDE.veredicto.ganadora!.renglones.filter(
      (r) =>
        r.controles.length > 0 &&
        r.controles.every((c) => c.paso) &&
        r.reparaciones === 0 &&
        r.incoherentes === 0 &&
        r.descripcion.trim() !== '',
    );
    const despues = new Map(
      ERRECALDE_RELEIDO.veredicto.ganadora!.renglones.map((r) => [r.descripcion.trim(), r]),
    );

    let comparados = 0;
    for (const viejo of literalesQueCerraban) {
      const nuevo = despues.get(viejo.descripcion.trim());
      if (!nuevo) continue;
      comparados += 1;
      expect(nuevo.importe?.toFixed(2), viejo.descripcion).toBe(viejo.importe?.toFixed(2));
      expect(nuevo.precioUnitario?.toFixed(2), viejo.descripcion).toBe(
        viejo.precioUnitario?.toFixed(2),
      );
    }
    // Que efectivamente se compararon renglones, y no cero.
    expect(comparados).toBeGreaterThan(3);
  });

  it('corrige un renglón que cerraba consigo mismo cien veces fuera de escala', () => {
    /*
     * El caso que justifica la relectura entera. En la primera pasada hay un
     * artículo cuyo precio y cuyo subtotal salieron los dos sin separador
     * decimal: el renglón cumple cantidad × precio = importe perfectamente,
     * porque la proporción se mantiene, y ningún control interno lo desmiente.
     * Lo único que lo desmiente son sus veinte vecinos de columna, y lo único
     * que lo **arregla** es volver a mirar el papel.
     *
     * Releída la banda de precios con el alfabeto restringido a dígitos, el
     * mismo valor aparece con su coma. No se elige por magnitud ni por acercar
     * la suma al total: se elige porque ahora hay una lectura literal donde
     * antes sólo había una reparada.
     */
    const antes = ERRECALDE.veredicto.ganadora!.renglones;
    const fueraDeEscala = antes.filter((r) => r.severidad >= 3 || r.reparaciones > 0);
    expect(fueraDeEscala.length).toBeGreaterThan(0);

    // Y después de releer, la peor severidad del comprobante baja.
    const peorAntes = Math.max(...antes.map((r) => r.severidad));
    const peorDespues = Math.max(
      ...ERRECALDE_RELEIDO.veredicto.ganadora!.renglones.map((r) => r.severidad),
    );
    expect(peorDespues).toBeLessThanOrEqual(peorAntes);

    // Ningún renglón queda con un importe de más de un millón: en esta factura
    // el neto entero son menos de cuatro, así que un solo artículo no puede.
    for (const renglon of ERRECALDE_RELEIDO.veredicto.ganadora!.renglones) {
      expect(renglon.importe?.lt(1_000_000) ?? true, renglon.descripcion).toBe(true);
    }
  });

  it('los veintitrés artículos siguen siendo veintitrés después de releer celdas', () => {
    /*
     * Releer una banda de precios no puede inventar ni perder un renglón. La
     * separación de artículos ya está resuelta y la relectura sólo aporta
     * lecturas para celdas que ya tienen su lugar.
     */
    expect(ERRECALDE.tabla.renglones).toHaveLength(23);
    expect(ERRECALDE_RELEIDO.tabla.renglones).toHaveLength(23);
  });

  it('una relectura peor pierde contra la evidencia original', () => {
    /*
     * El negativo que hace que esto sea seguro. Se le da al motor una
     * «relectura» de fragmentos basura sobre la misma foto: números inventados
     * en el lugar de la tabla, con confianza alta.
     *
     * La lectura original sigue compitiendo dentro del mismo motor de
     * candidatas, así que la basura no puede ganar: no mejora ni los renglones
     * conservados, ni los comprobados, ni las reparaciones. El informe dice que
     * la relectura perdió, y el resultado es **idéntico** al de no haber
     * releído.
     */
    const basura: EvidenciaDeRelectura = {
      anchoPx: 1000,
      altoPx: 1000,
      msTotal: 10,
      pasadas: [
        {
          id: 'relectura:basura:numeros',
          zona: 'relectura:basura',
          variante: 'numeros',
          psm: 'bloque',
          alfabeto: DIGITOS_Y_SEPARADORES,
          region: { x0: 0.55, y0: 0.28, x1: 0.7, y1: 0.74 },
          celdasQueCubre: 3,
          columna: 'PRECIO',
          fragmentos: 6,
          ms: 10,
        },
      ],
      fragmentos: Array.from({ length: 6 }, (_, i) => ({
        texto: '99999999',
        caja: { x0: 0.59, y0: 0.3 + i * 0.02, x1: 0.64, y1: 0.31 + i * 0.02 },
        pasada: 'relectura:basura:numeros',
        confianza: 0.99,
      })),
    };

    const conBasura = interpretarReconstruccion(leer('errecalde'), {
      cuitDelReceptor: CUIT_DEL_RECEPTOR,
      relectura: basura,
    });

    expect(conBasura.relectura!.gano).toBe(false);
    expect(conBasura.veredicto.ganadora!.sumaDeRenglones.toFixed(2)).toBe(
      ERRECALDE.veredicto.ganadora!.sumaDeRenglones.toFixed(2),
    );
    expect(conBasura.tabla.renglones).toHaveLength(ERRECALDE.tabla.renglones.length);
  });

  it('Ezra, Mabelherdi y Barraza no cambian', () => {
    /*
     * Ninguno de los tres tiene celdas bloqueadas con posición conocida, así
     * que ninguno se relee y ninguno puede cambiar. Se comprueba con la
     * relectura pedida explícitamente: si algún día uno de ellos la active, lo
     * que no puede pasar es que empeore en silencio.
     */
    for (const nombre of ['ezra', 'mabelherdi', 'barraza']) {
      const solo = interpretar(nombre);
      const conRelectura = interpretar(nombre, true);
      expect(conRelectura.veredicto.decision, nombre).toBe(solo.veredicto.decision);
      expect(
        conRelectura.veredicto.ganadora!.sumaDeRenglones.toFixed(2),
        nombre,
      ).toBe(solo.veredicto.ganadora!.sumaDeRenglones.toFixed(2));
      expect(conRelectura.veredicto.ganadora!.renglones.length, nombre).toBe(
        solo.veredicto.ganadora!.renglones.length,
      );
      expect(soloBloqueantes(conRelectura.pendientes).length, nombre).toBe(
        soloBloqueantes(solo.pendientes).length,
      );
    }
  });
});

describe('cuánto cuesta y cuánto recupera', () => {
  it('el costo de la relectura se informa aparte del resto del motor', () => {
    /*
     * Son dos presupuestos distintos y mezclarlos escondería el que importa: la
     * primera reconstrucción corre en el navegador en menos de un segundo, y la
     * relectura son cuatro pasadas de OCR más, del orden de dos segundos sobre
     * un teléfono. Lo que no se puede es informar un solo número.
     */
    const informe = ERRECALDE_RELEIDO.relectura!;
    expect(informe.ms).toBeGreaterThan(0);
    expect(informe.bandas).toBeLessThanOrEqual(PRESUPUESTO_DE_RELECTURA);
    expect(informe.celdasPedidas).toBeGreaterThan(0);
  });

  it('con la relectura la suma del detalle llega al neto impreso', () => {
    /*
     * La medida de para qué sirve todo esto. Sin relectura la suma queda a unos
     * diecinueve puntos del neto, porque varios precios y varias cantidades
     * salieron mutilados de la foto de la página entera. Con cuatro bandas
     * releídas —las de las cuatro columnas que la igualdad del renglón
     * necesita— la distancia baja a un punto y medio, y baja con **evidencia
     * nueva**, no con una cuenta que complete el faltante.
     */
    const suma = ERRECALDE_RELEIDO.veredicto.ganadora!.sumaDeRenglones;
    const neto = ERRECALDE_RELEIDO.pie.netTotal!;
    const antes = ERRECALDE.veredicto.ganadora!.sumaDeRenglones;

    const distancia = suma.minus(neto).abs().div(neto).toNumber();
    const distanciaAntes = antes.minus(neto).abs().div(neto).toNumber();

    // Se acerca, y mucho: de un 19 % a un 1,5 %.
    expect(distancia).toBeLessThan(distanciaAntes / 5);
    expect(distancia).toBeLessThan(0.02);
  });
});
