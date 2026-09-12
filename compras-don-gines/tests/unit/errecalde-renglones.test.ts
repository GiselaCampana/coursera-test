import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { interpretarReconstruccion } from '@/lib/ocr/motor/desde-reconstruccion';
import { reconstruirConContexto } from '@/lib/ocr/reconstruccion/reconstruccion';
import { hipotesisDeEsqueleto, consensoDeFilas } from '@/lib/ocr/reconstruccion/esqueleto';
import { columnaDe } from '@/lib/ocr/reconstruccion/columnas-espaciales';
import { textoPreferido } from '@/lib/ocr/reconstruccion/agrupar';
import type { EvidenciaDeLectura } from '@/lib/ocr/reconstruccion/evidencia';

/**
 * Contar los artículos de una factura larga, y no contar lo que no es uno.
 *
 * El papel tiene veintitrés artículos. El motor proponía veintisiete, y el
 * problema no era el conteo sino **de dónde salían las filas**: trece líneas del
 * pie fiscal seguían adentro del cuerpo de la tabla, porque la etiqueta que las
 * identifica no está pegada al margen izquierdo sino a un tercio del ancho,
 * debajo de las columnas de unidad y cantidad.
 *
 * No eran inofensivas. Ensuciaban el perfil de todas las columnas, sostenían
 * esqueletos falsos y hacían que la cantidad esperada de renglones no se
 * pareciera a la del papel. Y como el pie quedaba adentro de la tabla, el neto
 * impreso tampoco se leía: quedaba mezclado con los números de los artículos.
 */

const DIRECTORIO = path.resolve(__dirname, '../fixtures/evidencia');
const CUIT_DEL_RECEPTOR = '27-33342291-9';

function leer(nombre: string): EvidenciaDeLectura {
  return JSON.parse(readFileSync(path.join(DIRECTORIO, `${nombre}.json`), 'utf8'));
}

const ERRECALDE = interpretarReconstruccion(leer('errecalde'), {
  cuitDelReceptor: CUIT_DEL_RECEPTOR,
});
const { contexto } = reconstruirConContexto(leer('errecalde'));

/** Qué columnas ocupa cada línea del cuerpo, para poder clasificarla. */
function ocupacion(indice: number): { columna: number; texto: string }[] {
  const renglon = contexto.cuerpo[indice];
  const salida: { columna: number; texto: string }[] = [];
  for (const observacion of renglon.observaciones) {
    const columna = columnaDe(observacion, contexto.columnas);
    if (columna === null) continue;
    const ya = salida.find((x) => x.columna === columna);
    if (ya) ya.texto += ` ${textoPreferido(observacion)}`;
    else salida.push({ columna, texto: textoPreferido(observacion) });
  }
  return salida.sort((a, b) => a.columna - b.columna);
}

describe('la cantidad de renglones sale del papel, no de la columna más poblada', () => {
  it('el cuerpo llega a veintitrés renglones reconstruidos', () => {
    expect(ERRECALDE.tabla.renglones).toHaveLength(23);
  });

  it('el consenso dice veintitrés, apoyado por más de una columna', () => {
    const esqueletos = hipotesisDeEsqueleto(
      contexto.cuerpo,
      contexto.columnas,
      contexto.alturaTipica,
    );
    const consenso = consensoDeFilas(esqueletos);
    expect(consenso.esperadas).toBe(23);

    // No es una columna sola diciéndolo: son dos independientes.
    const deAcuerdo = consenso.porFuente.filter((f) => f.filas === 23);
    expect(deAcuerdo.length).toBeGreaterThanOrEqual(2);
  });

  it('la columna más poblada no gana por estar más llena', () => {
    /*
     * «PRECIO» sostiene más filas que ninguna y no manda: su exceso son jirones
     * del OCR, no artículos. Una columna con más valores no es una columna más
     * confiable —puede estar llena de basura repetida— y por eso la cuenta se
     * apoya en varias a la vez.
     */
    const esqueletos = hipotesisDeEsqueleto(
      contexto.cuerpo,
      contexto.columnas,
      contexto.alturaTipica,
    );
    const masPoblada = esqueletos
      .filter((h) => h.origen !== 'consenso')
      .reduce((a, b) => (b.alturas.length > a.alturas.length ? b : a));

    expect(masPoblada.alturas.length).toBeGreaterThan(23);
    expect(consensoDeFilas(esqueletos).esperadas).toBe(23);
  });
});

describe('lo que no es un artículo no entra a la tabla', () => {
  it('las líneas del pie fiscal quedan fuera del cuerpo', () => {
    /*
     * Trece líneas —el neto gravado, el IVA, las dos percepciones, el total y
     * las leyendas— venían adentro. El corte ahora busca la etiqueta fiscal en
     * **cualquier posición** de la línea y no sólo al principio.
     */
    const textos = contexto.cuerpo.map((r) =>
      r.observaciones.map((o) => textoPreferido(o)).join(' '),
    );
    for (const etiqueta of ['Neto', 'Gravado', 'Percepcion', 'Percepción', 'TOTAL']) {
      expect(textos.filter((t) => t.includes(etiqueta)), etiqueta).toEqual([]);
    }
    expect(ERRECALDE.tabla.notas.some((n) => n.includes('que es del pie'))).toBe(true);
  });

  it('una continuación de descripción no se convierte en artículo', () => {
    /*
     * Hay una línea con texto en la columna de descripción y **nada más**: ni
     * código, ni cantidad, ni subtotal. Es la segunda mitad del nombre de un
     * artículo, no uno nuevo, y no puede sumar una fila.
     */
    const soloTexto = contexto.cuerpo
      .map((_, i) => ({ i, celdas: ocupacion(i) }))
      .filter(({ celdas }) => celdas.length === 1 && /[A-Z]{3}/.test(celdas[0].texto));

    expect(soloTexto.length).toBeGreaterThan(0);
    for (const { i } of soloTexto) {
      const y = contexto.cuerpo[i].y;
      // Ninguna de esas alturas quedó como un renglón de la tabla.
      const comoRenglon = ERRECALDE.tabla.renglones.find(
        (r) => Math.abs(r.y - y) < contexto.alturaTipica * 0.2,
      );
      expect(comoRenglon, `la línea ${i} no debería ser un artículo`).toBeUndefined();
    }
  });

  it('una línea suelta sin identidad de fila tampoco', () => {
    /*
     * El filtro es el mismo para todo: dos celdas llenas y un número en una
     * columna de números. Un carácter suelto en la columna de precios no alcanza
     * por más que caiga justo a la altura de un renglón.
     */
    const casiVacias = contexto.cuerpo
      .map((_, i) => ({ i, celdas: ocupacion(i) }))
      .filter(({ celdas }) => celdas.length <= 1);

    expect(casiVacias.length).toBeGreaterThan(0);
    for (const { i } of casiVacias) {
      const y = contexto.cuerpo[i].y;
      expect(
        ERRECALDE.tabla.renglones.find(
          (r) => Math.abs(r.y - y) < contexto.alturaTipica * 0.2,
        ),
        `la línea ${i} no debería ser un artículo`,
      ).toBeUndefined();
    }
  });

  it('ningún renglón repite la caja de otro', () => {
    /*
     * Un duplicado entre pasadas no crea una fila nueva: las pasadas se agrupan
     * por lugar antes de armar nada, así que dos lecturas del mismo pedazo de
     * papel son una sola observación.
     */
    const alturas = ERRECALDE.tabla.renglones.map((r) => r.y);
    for (let i = 1; i < alturas.length; i++) {
      expect(alturas[i] - alturas[i - 1]).toBeGreaterThan(contexto.alturaTipica * 0.5);
    }
  });
});

describe('el pie fiscal se lee con la coma en su lugar', () => {
  it('el neto es el impreso, no la lectura sin separadores', () => {
    /*
     * El papel dice 3.830.467,37. Cuando el pie no cierra contra sí mismo el
     * motor se quedaba con «el neto más grande», y el más grande es siempre la
     * lectura que ignora los separadores decimales: 383.046.737.
     *
     * A partir de ahí el comprobante entero se acomodaba cien veces más grande y
     * todo cuadraba, porque la proporción se mantiene. El costo por kilo de los
     * veintitrés artículos salía cien veces mal sin que ninguna cuenta lo
     * delatara.
     */
    expect(ERRECALDE.pie.netTotal?.toFixed(2)).toBe('3830467.37');
  });

  it('un valor cercano al neto no se elige si rompe la ecuación del pie', () => {
    /*
     * El saldo acumulado de otra factura del banco —532.848,64— convive con el
     * subtotal en la misma línea y es del mismo orden. No entra: lo que decide
     * es que el valor esté junto a **su** etiqueta y que la ecuación cierre.
     */
    const barraza = interpretarReconstruccion(leer('barraza'), {
      cuitDelReceptor: CUIT_DEL_RECEPTOR,
    });
    expect(barraza.pie.netTotal?.toFixed(2)).toBe('473232.44');
    for (const valor of [
      barraza.pie.netTotal,
      barraza.pie.ivaTotal,
      barraza.pie.percepciones,
      barraza.pie.total,
    ]) {
      expect(valor?.toFixed(2)).not.toBe('532848.64');
    }
  });
});

describe('los renglones recuperados', () => {
  it('los códigos y las descripciones que el OCR leyó están donde corresponde', () => {
    const renglones = ERRECALDE.veredicto.ganadora!.renglones;
    const porCodigo = new Map(renglones.map((r) => [r.codigo, r]));

    expect(porCodigo.get('ART-00873')?.descripcion).toContain('BARRA DANBO');
    expect(porCodigo.get('ART-00347')?.descripcion).toContain('LEBERWURST');
    expect(porCodigo.get('ART-01911')?.descripcion).toContain('PLANCHA BARRAZA X10KG');

    // Y sus cuentas, con el precio y el subtotal del papel.
    const leberwurst = porCodigo.get('ART-00347')!;
    expect(leberwurst.cantidad?.toString()).toBe('10');
    // Su cuenta cierra: la cantidad por el precio da el subtotal impreso, sea
    // cual sea la escala en que el OCR haya leído esos dos números.
    expect(leberwurst.controles.length).toBeGreaterThan(0);
    expect(leberwurst.controles.every((c) => c.paso)).toBe(true);
  });

  it('un renglón sin descripción legible sobrevive si prueba su propia cuenta', () => {
    /*
     * En la mitad de abajo de la foto las descripciones se borronean antes que
     * los números: son letra más chica y más apretada. Nueve artículos llegan sin
     * nombre y con la cantidad, el precio, el descuento, la alícuota y el
     * subtotal perfectos.
     *
     * Tirarlos es perder nueve compras por una palabra. Se reconstruyen y el
     * nombre queda como pedido puntual.
     */
    const sinNombre = ERRECALDE.veredicto.ganadora!.renglones.filter(
      (r) => r.descripcion.replace(/[^A-Za-zÁÉÍÓÚÑ]/g, '').length < 3,
    );
    expect(sinNombre.length).toBeGreaterThan(0);
    for (const renglon of sinNombre) {
      expect(renglon.importe, 'un renglón sin nombre tiene que traer su importe').toBeTruthy();
    }
  });

  it('lo que falta se informa renglón por renglón y no se deriva en silencio', () => {
    const faltantes = ERRECALDE.pendientes.filter(
      (p) => p.categoria === 'BLOCKING_MISSING_CELL' && p.renglon !== null,
    );
    expect(faltantes.length).toBeGreaterThan(0);
    /*
     * Cada uno dice **qué** renglón y **de qué** se trata: nada se deriva en
     * silencio. Un bloqueo de renglón entero —«esta fila se vio y no alcanzó
     * para ser un artículo»— no tiene campo y lo dice en la columna, porque un
     * ítem sin encabezado en la pantalla no se puede resolver.
     */
    for (const pendiente of faltantes) {
      expect(pendiente.renglon).toBeGreaterThan(0);
      expect(pendiente.campo ?? pendiente.columna).toBeTruthy();
    }
    // Y los que le faltan a la aritmética del renglón lo dicen explícitamente.
    expect(faltantes.some((p) => p.motivo.includes('no lo reemplaza'))).toBe(true);
  });

  it('la lectura sirve y no se acepta sola', () => {
    /*
     * La medida honesta de dónde está: el comprobante ya no se rechaza —los
     * veintitrés renglones están y más de la mitad se comprueban solos— pero
     * tampoco se acepta sin mirar, porque quedan celdas que el OCR mutiló.
     */
    expect(ERRECALDE.veredicto.decision).toBe('revision-de-estructura');
    const completos = ERRECALDE.veredicto.ganadora!.renglones.filter(
      (r) => r.controles.length > 0 && r.controles.every((c) => c.paso),
    );
    expect(completos.length).toBeGreaterThanOrEqual(13);
  });
});

describe('el resto del banco no se movió', () => {
  it('Ezra sigue automática y Mabelherdi y Barraza siguen cerrando', () => {
    const ezra = interpretarReconstruccion(leer('ezra'), { cuitDelReceptor: CUIT_DEL_RECEPTOR });
    const mabelherdi = interpretarReconstruccion(leer('mabelherdi'), {
      cuitDelReceptor: CUIT_DEL_RECEPTOR,
    });
    const barraza = interpretarReconstruccion(leer('barraza'), {
      cuitDelReceptor: CUIT_DEL_RECEPTOR,
    });

    expect(ezra.veredicto.decision).toBe('automatica');
    expect(ezra.veredicto.ganadora!.renglones).toHaveLength(6);

    expect(mabelherdi.veredicto.ganadora!.sumaDeRenglones.toFixed(2)).toBe('32998.85');
    expect(mabelherdi.veredicto.ganadora!.cierre?.compatible).toBe(true);

    expect(barraza.veredicto.ganadora!.sumaDeRenglones.toFixed(2)).toBe('473232.44');
    expect(barraza.veredicto.ganadora!.renglones.every((r) => r.controles.every((c) => c.paso))).toBe(
      true,
    );
  });

  it('las dos fotos insuficientes siguen rechazadas', () => {
    for (const nombre of ['los-calvos-212356', 'los-calvos-213103']) {
      const informe = interpretarReconstruccion(leer(nombre), {
        cuitDelReceptor: CUIT_DEL_RECEPTOR,
      });
      expect(informe.veredicto.decision, nombre).toBe('rechazo');
    }
  });

  it('el resultado no depende de quién firma la factura', () => {
    /*
     * El motor lee estructura, no proveedores. Cambiar el CUIT del receptor por
     * uno inventado no puede mover un solo renglón: si lo moviera, algo estaría
     * decidiendo por identidad y no por evidencia.
     */
    const conOtro = interpretarReconstruccion(leer('errecalde'), {
      cuitDelReceptor: '20-11111111-2',
    });
    expect(conOtro.tabla.renglones).toHaveLength(ERRECALDE.tabla.renglones.length);
    expect(conOtro.veredicto.ganadora!.sumaDeRenglones.toString()).toBe(
      ERRECALDE.veredicto.ganadora!.sumaDeRenglones.toString(),
    );
    expect(conOtro.pie.netTotal?.toString()).toBe(ERRECALDE.pie.netTotal?.toString());
  });
});
