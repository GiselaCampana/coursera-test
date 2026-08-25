import { Decimal, parseArNumber, parseRate } from '@/lib/money';
import { parseArDate, toISODate } from '@/lib/datetime';
import type { OcrHeader, OcrItem, OcrSummary, OcrTaxLine } from '@/lib/ocr/types';
import {
  CLASE_DIGITOS_OCR,
  repararDigitos,
  type AnalisisComprobante,
  type AnalizadorComprobante,
  type TextosComprobante,
} from '@/lib/ocr/parsers/tipos';

/**
 * Analizador de las facturas-remito de Distribución Errecalde.
 *
 * Formato:
 *
 *   Código    Descripción              Unid.  Cantidad   Precio      Dto.  IVA   Subtotal
 *   ART-00873 BARRA DANBO PUNTA DE AGUA    8   39.2 kg   $8.090,08    0%   21%  $317.131,24
 *   ART-00177 CAYFAR LATA BATATA           6         6   $9.659,63    0%   21%   $57.957,76
 *
 * y un pie de cinco renglones: Neto Gravado, IVA, Percepción IVA RG 5329,
 * Percepción IIBB Buenos Aires y TOTAL.
 *
 * Tres cosas propias de este formato, que ningún analizador genérico puede
 * adivinar:
 *
 *  1. **Dos columnas de cantidad.** "Unid." es cuántos bultos entraron y
 *     "Cantidad" cuánto pesan. No toda cifra de Cantidad son kilos: cuando el
 *     artículo se vende por unidad, Cantidad repite el número de Unid. sin el
 *     sufijo. El sufijo "kg" impreso es el que manda, no una suposición.
 *
 *  2. **Dos formatos numéricos en la misma fila.** Cantidad viene con punto
 *     decimal ("39.2 kg", "18.38 kg") y Precio y Subtotal en formato argentino
 *     ("$8.090,08"). Leer los dos con la misma regla convierte 156.3 kg en 1563.
 *
 *  3. **Las columnas Dto. e IVA son un ancla.** Todas las filas traen "0% 21%"
 *     entre el precio y el subtotal. Sobre una foto de verdad eso vale más que
 *     contar columnas: entre la descripción y los números el OCR mete basura
 *     —tildes manuscritas que salen como "7", "»", "Za"— que corre cualquier
 *     conteo posicional, pero el par de porcentajes está siempre y parte la fila
 *     en dos mitades sin ambigüedad.
 *
 * Lo que no hace: corregir un importe para que la cuenta cierre.
 */

/** Un porcentaje de la fila: "0%", "21%", tolerando la basura del OCR. */
const PORCENTAJE = `[${CLASE_DIGITOS_OCR}]{1,3}(?:[.,][${CLASE_DIGITOS_OCR}]{1,2})?\\s*%`;
/** Dto. e IVA pegados, con la basura que el OCR mete entre medio. */
const ANCLA_DTO_IVA = new RegExp(`(${PORCENTAJE})\\s*[^${CLASE_DIGITOS_OCR}%]{0,4}?\\s*(${PORCENTAJE})`);

/** Un importe con o sin el signo pesos delante. */
const IMPORTE = new RegExp(`[$5]?\\s*([${CLASE_DIGITOS_OCR}][${CLASE_DIGITOS_OCR}.,]*)`, 'g');

export const analizadorErrecalde: AnalizadorComprobante = {
  codigo: 'errecalde',
  nombre: 'Distribución Errecalde',

  reconoce(textos: TextosComprobante): number {
    const texto = `${textos.encabezado ?? ''}\n${textos.completo}\n${textos.articulos ?? ''}`;
    const normalizado = texto
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase();

    // Primero hay que reconocer al proveedor. Un analizador hecho para un
    // formato no puede quedarse con el comprobante de otro sólo porque comparta
    // alguna forma: los códigos "ART-0000" y el rótulo "Factura-Remito" los usa
    // más de un sistema de facturación. Sin el nombre ni el CUIT, esto no es
    // una factura de Errecalde y la agarra el analizador general.
    const porNombre = /ERRE\s?CALDE/.test(normalizado);
    const porCuit = /30-?71780890-?4/.test(normalizado.replace(/\s/g, ''));
    if (!porNombre && !porCuit) return 0;

    let puntaje = 0;
    if (porNombre) puntaje += 0.6;
    if (porCuit) puntaje += 0.3;
    // Y después, las señales del formato, que suben la confianza.
    if (/ART-\s?\d{4,5}/.test(normalizado)) puntaje += 0.25;
    if (/FACTURA\s*-?\s*REMITO/.test(normalizado)) puntaje += 0.15;
    if (/RG\s*5329/.test(normalizado)) puntaje += 0.15;

    return Math.min(1, puntaje);
  },

  analizar(textos: TextosComprobante): AnalisisComprobante {
    const observaciones: string[] = [];
    const header = analizarEncabezado(
      `${textos.encabezado ?? ''}\n${textos.completo}`,
    );
    /*
     * El pie primero, y a propósito.
     *
     * El neto y el total impresos son la única cota que tenemos para descartar
     * una lectura imposible de un renglón. Sobre esta factura, una pasada leyó
     * SARDO BLOQUE como 475 kg a $13.295,25 —perdió la coma de "4,75"— y esa
     * lectura *cierra sola*: 475 × 13.295,25 da los $6.315.243 que también leyó
     * mal. Contra sus propios números es impecable; lo único que la delata es
     * que un renglón de seis millones no cabe en una factura de tres millones y
     * medio. Sin el pie, esa lectura es indistinguible de la buena.
     */
    /*
     * El pie se arma con **las dos** lecturas, no con la mejor de las dos.
     *
     * En la corrida de Safari ninguna pasada lo tenía entero. El recorte del pie
     * trajo el total bien ($4.816.812,73) pero el IVA cortado ($804.398,1, sin
     * el último dígito); la página completa trajo el IVA entero ($804.398,16)
     * pero no el total, y el neto deformado. Cada una sola falla; juntas están
     * los cinco campos.
     *
     * Así que se prueban las dos fuentes y se elige el resultado que pase las
     * cinco condiciones. No se mezclan campos de una y de otra a dedo: se
     * interpreta cada texto por separado y gana el que quede completo y cierre.
     */
    const { summary, avisos: avisosPie } = mejorPie(textos);
    observaciones.push(...avisosPie);

    const { items, avisos } = analizarArticulos(textos.articulos || textos.completo, {
      netoImpreso: parseArNumber(summary.netTotal ?? '') ?? null,
    });
    observaciones.push(...avisos);

    if (items.length === 0) {
      observaciones.push('No se reconoció ningún renglón en la tabla de artículos.');
    }

    /*
     * Acá no se corrige ningún importe.
     *
     * Los renglones cuyos centavos el OCR leyó mal los resuelve la conciliación
     * de centavos (`@/lib/domain/conciliacion`), que corre después y vale para
     * cualquier proveedor. Este analizador se limita a decir qué leyó y qué no
     * cierra: mezclar las dos cosas dejaría la misma regla escrita en dos
     * lugares, con dos criterios que se van separando.
     */

    // El control que de verdad cierra el comprobante: la suma de los subtotales
    // impresos contra el neto gravado impreso. Son dos lecturas independientes
    // del mismo número, así que si coinciden, la tabla se leyó entera.
    if (items.length > 0 && summary.netTotal) {
      let suma = new Decimal(0);
      let completos = true;
      for (const item of items) {
        const bruto = item.grossSubtotal ? parseArNumber(item.grossSubtotal) : null;
        if (!bruto) {
          completos = false;
          break;
        }
        suma = suma.plus(bruto);
      }
      const neto = parseArNumber(summary.netTotal);
      if (completos && neto) {
        const diferencia = suma.minus(neto).abs();
        // Un peso de tolerancia por el redondeo de cada renglón.
        if (diferencia.gt(Decimal.max(neto.abs().times(0.0005), 1))) {
          observaciones.push(
            `Los ${items.length} subtotales suman ${suma.toFixed(2)} y el neto gravado impreso ` +
              `es ${neto.toFixed(2)}: faltan o sobran renglones.`,
          );
        }
      }
    }

    return { header, items, summary, observaciones };
  },
};

function analizarEncabezado(texto: string): OcrHeader {
  const header: OcrHeader = {
    docType: 'FACTURA',
    letter: 'A',
    pointOfSale: null,
    number: null,
    fullNumber: null,
    issueDate: null,
    supplierName: 'Distribución Errecalde',
    legalName: 'Distribución Errecalde S.A.',
    cuit: '30-71780890-4',
    currency: 'ARS',
  };

  // "FAR-A 00008-00002647": la letra va pegada al tipo de comprobante.
  const far = texto.match(
    new RegExp(`FAR\\s*-?\\s*([ABCEM])\\s+([${CLASE_DIGITOS_OCR}]{4,5})\\s*-\\s*([${CLASE_DIGITOS_OCR}]{7,9})`, 'i'),
  );
  if (far) {
    header.letter = far[1].toUpperCase();
    header.pointOfSale = repararDigitos(far[2]).padStart(5, '0').slice(-5);
    header.number = repararDigitos(far[3]).padStart(8, '0');
  } else {
    const suelto = texto.match(
      new RegExp(`\\b([${CLASE_DIGITOS_OCR}]{4,5})\\s*-\\s*([${CLASE_DIGITOS_OCR}]{7,9})\\b`),
    );
    if (suelto) {
      header.pointOfSale = repararDigitos(suelto[1]).padStart(5, '0').slice(-5);
      header.number = repararDigitos(suelto[2]).padStart(8, '0');
    }
  }
  if (header.pointOfSale && header.number) {
    header.fullNumber = `${header.pointOfSale}-${header.number}`;
  }

  const fecha = texto.match(
    new RegExp(
      `fecha\\s*[:.]?\\s*([${CLASE_DIGITOS_OCR}]{1,2}[/\\-.][${CLASE_DIGITOS_OCR}]{1,2}[/\\-.][${CLASE_DIGITOS_OCR}]{2,4})`,
      'i',
    ),
  );
  const analizada = fecha ? parseArDate(repararDigitos(fecha[1])) : null;
  if (analizada) header.issueDate = toISODate(analizada);

  return header;
}

/** Líneas que nunca son un renglón de artículo en este formato. */
const NO_ES_ARTICULO =
  /^(c[oó]d|cob?igo|descripci|unid|cantidad|precio|dto|iva|subtotal|neto|gravado|percepci|total|cae|vencimiento|observaciones|generada)/i;

interface FilaErrecalde {
  codigo: string | null;
  descripcion: string;
  unidades: number | null;
  cantidad: Decimal;
  esKilos: boolean;
  precio: Decimal | null;
  subtotal: Decimal;
  ivaRate: string | null;
  descuento: string | null;
}

/** Descripción sin espacios ni signos, para poder compararlas. */
function normalizarDescripcion(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * ¿Dos códigos que podrían ser el mismo, con algún dígito mal leído?
 *
 * Safari cambia dígitos del código entre pasadas con bastante frecuencia:
 * ART-00487 / ART-60487, ART-02174 / ART-62174. Se admiten hasta dos
 * diferencias, no una, porque con una sola quedaban afuera casos así.
 *
 * Ampliarlo tiene un riesgo y conviene tenerlo presente: en esta misma factura
 * conviven ART-00177 (CAYFAR LATA BATATA) y ART-00178 (CAYFAR LATA CHOCOLATE),
 * dos artículos distintos con códigos casi iguales. Por eso el código nunca
 * decide solo: hace falta que además coincida la descripción, que es lo que de
 * verdad los distingue.
 */
function codigosCompatibles(a: string | null, b: string | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let distintos = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] && ++distintos > 2) return false;
  }
  return true;
}

/**
 * Cuán parecidas son dos descripciones, de 0 a 1.
 *
 * Cuenta las posiciones que coinciden sobre la parte común. Es tosco pero
 * alcanza para lo que hace falta: una descripción leída dos veces por el mismo
 * OCR se parece mucho a sí misma —cambia una letra, se corta el final— y dos
 * artículos distintos del mismo rubro no llegan ni cerca, porque las palabras
 * son otras desde el principio.
 */
function parecidoDeDescripcion(a: string, b: string): number {
  const na = normalizarDescripcion(a);
  const nb = normalizarDescripcion(b);
  if (na.length === 0 || nb.length === 0) return 0;
  const [corta, larga] = na.length <= nb.length ? [na, nb] : [nb, na];
  let iguales = 0;
  for (let i = 0; i < corta.length; i++) {
    if (corta[i] === larga[i]) iguales++;
  }
  // Se mide contra la más larga: que una sea el principio de la otra no la
  // vuelve idéntica, sólo compatible, y de eso se ocupa `descripcionesCompatibles`.
  return iguales / larga.length;
}

/** ¿Dos descripciones que podrían ser la misma, una más recortada que la otra? */
function descripcionesCompatibles(a: string, b: string): boolean {
  const na = normalizarDescripcion(a);
  const nb = normalizarDescripcion(b);
  if (na.length < 8 || nb.length < 8) return false;
  if (na === nb) return true;
  const [corta, larga] = na.length <= nb.length ? [na, nb] : [nb, na];
  return larga.startsWith(corta);
}

/**
 * ¿Son dos lecturas del mismo renglón del papel?
 *
 * Ninguna señal alcanza sola. El código se lee casi siempre bien pero no
 * siempre —"ART-02444" y "ART-82444" son la misma fila leída dos veces—, y
 * exigir que sea idéntico deja pasar el duplicado. Aflojarlo a "difieren en un
 * dígito" tampoco sirve por sí solo: en esta misma factura conviven ART-00177
 * (CAYFAR LATA BATATA) y ART-00178 (CAYFAR LATA CHOCOLATE), que son dos
 * artículos distintos con códigos consecutivos, y fundirlos sería peor que
 * duplicarlos.
 *
 * Así que se piden dos de tres coincidencias: código, descripción y subtotal.
 * Dos lecturas de la misma fila coinciden por lo menos en dos; dos artículos
 * distintos, en una como mucho.
 */
function sonElMismoRenglon(a: FilaErrecalde, b: FilaErrecalde): boolean {
  // La descripción exacta y larga alcanza sola. Ningún proveedor imprime dos
  // artículos distintos con el mismo nombre completo, y en cambio pasa seguido
  // que una de las dos lecturas pierda el código: exigiendo dos señales, ese
  // renglón entra dos veces. (Si una factura trajera de verdad el mismo
  // artículo en dos renglones, se fundirían en uno y la suma de los subtotales
  // contra el neto impreso lo delataría enseguida.)
  const na = normalizarDescripcion(a.descripcion);
  const nb = normalizarDescripcion(b.descripcion);
  if (na.length >= 12 && na === nb) return true;

  /*
   * La descripción casi idéntica alcanza sola, aunque el código difiera.
   *
   * Safari cambia dígitos del código entre pasadas —ART-00487 / ART-60487,
   * ART-02174 / ART-62174— así que exigirle al código que coincida parte en dos
   * renglones que son el mismo. La descripción, en cambio, se lee estable: puede
   * perder una letra o cortarse el final, pero no se convierte en otra palabra.
   *
   * El umbral es alto a propósito. CAYFAR LATA BATATA y CAYFAR LATA CHOCOLATE
   * comparten el 60 % de sus caracteres y son artículos distintos; dos lecturas
   * de la misma descripción pasan del 85 %. Cuál es el código correcto se decide
   * después, por consenso entre las lecturas del grupo.
   */
  if (parecidoDeDescripcion(a.descripcion, b.descripcion) >= 0.85) return true;

  let coincidencias = 0;
  if (codigosCompatibles(a.codigo, b.codigo)) coincidencias++;
  if (descripcionesCompatibles(a.descripcion, b.descripcion)) coincidencias++;
  if (a.subtotal.eq(b.subtotal)) coincidencias++;
  if (coincidencias >= 2) return true;

  /*
   * Una señal sola alcanza cuando la otra lectura está rota.
   *
   * Cuando una pasada pierde la coma decimal, los tres números del renglón
   * cambian a la vez —cantidad, precio y subtotal—, así que la coincidencia por
   * subtotal desaparece y quedan las dos lecturas como si fueran renglones
   * distintos. El resultado es peor que un duplicado: entran las dos, la suma
   * contra el neto se desarma y no hay forma de saber cuál sobra.
   *
   * Así que si las descripciones coinciden y exactamente una de las dos cierra
   * su propia aritmética, se las trata como el mismo renglón. Se pide la
   * descripción y no el código a propósito: en esta factura conviven ART-00177
   * (CAYFAR LATA BATATA) y ART-00178 (CAYFAR LATA CHOCOLATE), dos artículos
   * distintos con códigos consecutivos que un dígito mal leído confunde, pero
   * cuyas descripciones no se parecen en nada.
   */
  if (descripcionesCompatibles(a.descripcion, b.descripcion) && filaCierra(a) !== filaCierra(b)) {
    return true;
  }
  return false;
}

/** ¿Cierra el renglón contra su propio subtotal impreso? */
function filaCierra(fila: FilaErrecalde): boolean {
  if (!fila.precio) return false;
  const esperado = fila.cantidad.times(fila.precio);
  // El precio unitario viene redondeado a dos decimales, así que el error
  // admisible crece con la cantidad; más dos centavos de piso.
  const tolerancia = fila.cantidad.abs().times(0.005).plus(0.02);
  return esperado.minus(fila.subtotal).abs().lte(tolerancia);
}

/** Lo que el pie ya dio y sirve para acotar lo que un renglón puede valer. */
interface LimitesDelPie {
  netoImpreso: Decimal | null;
}

/**
 * ¿Este subtotal es posible en este comprobante?
 *
 * Ningún renglón puede valer más que el neto gravado de la factura entera. Es
 * una cota tosca y por eso mismo confiable: no depende de interpretar bien nada
 * del renglón, sólo de que el pie se haya leído. Se deja un 2 % de aire para no
 * castigar una factura de un solo artículo cuyo redondeo lo deje justo encima.
 */
function subtotalPosible(fila: FilaErrecalde, limites: LimitesDelPie): boolean {
  if (!limites.netoImpreso || limites.netoImpreso.lte(0)) return true;
  return fila.subtotal.abs().lte(limites.netoImpreso.abs().times(1.02));
}

/**
 * Entre todas las lecturas de un mismo renglón, cuál se guarda.
 *
 * El orden de las razones importa, y sale de un caso real: sobre esta factura
 * una pasada leyó SARDO BLOQUE como 475 kg a $13.295,25 con subtotal
 * $6.315.243, y otra como 4,75 kg a $13.295,25 con subtotal $63.152,43. Las dos
 * cierran contra sus propios números —la primera perdió la coma en los tres
 * lugares a la vez—, así que "cierra la aritmética" no alcanza para elegir. Lo
 * que las separa es que un renglón de seis millones no entra en una factura de
 * tres millones y medio.
 */
function elegirLectura(candidatas: FilaErrecalde[], limites: LimitesDelPie): FilaErrecalde {
  const puntuar = (fila: FilaErrecalde): number => {
    let puntos = 0;
    // 1. Que el importe quepa en el comprobante. Es lo primero porque una
    //    lectura imposible no se arregla con ninguna otra virtud.
    if (subtotalPosible(fila, limites)) puntos += 1000;
    // 2. Que cantidad × precio dé el subtotal impreso.
    if (filaCierra(fila)) puntos += 100;
    // 3. Cuántas pasadas coincidieron en el código y en la descripción. Un dato
    //    que se leyó igual tres veces es mejor que uno que se leyó una sola.
    puntos += 10 * candidatas.filter((otra) => codigosCompatibles(otra.codigo, fila.codigo)).length;
    puntos +=
      10 * candidatas.filter((otra) => descripcionesCompatibles(otra.descripcion, fila.descripcion)).length;
    // 4. Y a igualdad, la lectura más completa.
    puntos +=
      (fila.codigo ? 2 : 0) +
      (fila.precio ? 2 : 0) +
      (fila.unidades !== null ? 1 : 0) +
      Math.min(fila.descripcion.length, 40) / 40;
    return puntos;
  };

  let mejor = candidatas[0];
  let mejorPuntaje = puntuar(mejor);
  for (const candidata of candidatas.slice(1)) {
    const puntaje = puntuar(candidata);
    if (puntaje > mejorPuntaje) {
      mejor = candidata;
      mejorPuntaje = puntaje;
    }
  }
  return mejor;
}

function analizarArticulos(
  texto: string,
  limites: LimitesDelPie = { netoImpreso: null },
): { items: OcrItem[]; avisos: string[] } {
  const avisos: string[] = [];

  /*
   * El mismo renglón, leído más de una vez.
   *
   * La tabla se lee varias veces con cortes distintos —franjas que se solapan,
   * y dos divisiones diferentes— porque el análisis de disposición de Tesseract
   * es sensible a dónde cae el corte: la fila que sale partida con una división
   * sale entera con la otra. Eso hace que muchos renglones lleguen repetidos.
   *
   * Se guardan **todas** las lecturas de cada renglón y recién al final se
   * elige. Antes se decidía de a pares, a medida que llegaban, y eso perdía
   * información: para saber cuál de dos lecturas conviene hay que poder mirar
   * también las otras tres del mismo renglón y el pie del comprobante, y
   * ninguna de esas dos cosas está disponible en el momento en que llega la
   * segunda.
   */
  const grupos: FilaErrecalde[][] = [];

  for (const cruda of texto.split('\n')) {
    const linea = cruda.trim();
    if (linea.length < 8) continue;
    if (NO_ES_ARTICULO.test(linea)) continue;

    const fila = analizarFila(linea, limites.netoImpreso);
    if (!fila) continue;

    const grupo = grupos.find((g) => g.some((otra) => sonElMismoRenglon(otra, fila)));
    if (grupo) grupo.push(fila);
    else grupos.push([fila]);
  }

  const filas = grupos.map((grupo) => elegirLectura(grupo, limites));

  const items: OcrItem[] = filas.map((fila, indice) => {
    const numero = indice + 1;

    if (!subtotalPosible(fila, limites)) {
      // Se avisa aunque haya sido la mejor de su grupo: que fuera la mejor no la
      // vuelve posible, y este renglón solo desarma la suma contra el neto.
      avisos.push(
        `Renglón ${numero} (${fila.descripcion}): el subtotal ${fila.subtotal.toFixed(2)} es ` +
          `mayor que el neto gravado impreso del comprobante. Hay que releerlo.`,
      );
    } else if (!fila.precio) {
      avisos.push(`Renglón ${numero} (${fila.descripcion}): no se pudo leer el precio unitario.`);
    } else if (!filaCierra(fila)) {
      const esperado = fila.cantidad.times(fila.precio);
      avisos.push(
        `Renglón ${numero} (${fila.descripcion}): ${fila.cantidad.toString()} × ` +
          `${fila.precio.toFixed(2)} da ${esperado.toFixed(2)} y el subtotal impreso es ` +
          `${fila.subtotal.toFixed(2)}. Hay que releerlo.`,
      );
    }

    return {
      lineNumber: numero,
      supplierCode: fila.codigo,
      description: fila.descripcion,
      quantity: fila.cantidad.toString(),
      unit: fila.esKilos ? 'KG' : 'UNIT',
      // Unid. es cuántos bultos vinieron; sólo tiene sentido guardarlo cuando la
      // cantidad se mide en kilos, porque si no repite la misma cifra.
      pieceCount: fila.esKilos ? fila.unidades : null,
      totalWeightKg: fila.esKilos ? fila.cantidad.toString() : null,
      unitNetPrice: fila.precio ? fila.precio.toString() : null,
      grossSubtotal: fila.subtotal.toString(),
      discountPct: fila.descuento,
      discountAmount: null,
      netAmount: null,
      ivaRate: fila.ivaRate,
    };
  });

  return { items, avisos };
}

/**
 * Parte una fila usando el par de porcentajes como bisagra.
 *
 * A la derecha del ancla queda el subtotal y nada más. A la izquierda, la
 * descripción y las tres columnas numéricas, que se toman de atrás para
 * adelante: precio, cantidad y unidades.
 */
export function analizarFila(linea: string, netoImpreso: Decimal | null = null): FilaErrecalde | null {
  const ancla = ANCLA_DTO_IVA.exec(linea);
  if (!ancla) return null;

  const izquierda = linea.slice(0, ancla.index);
  const derecha = linea.slice(ancla.index + ancla[0].length);

  const subtotalesCrudos = importesCrudosDelSubtotal(derecha);
  if (subtotalesCrudos.length === 0) return null;

  const descuento = parseRate(repararDigitos(ancla[1].replace('%', '')));
  const iva = parseRate(repararDigitos(ancla[2].replace('%', '')));

  /*
   * El código de artículo sale de la línea antes de buscar los números.
   *
   * "ART-00714" termina en cinco dígitos, así que un barrido numérico lo cuenta
   * como una columna más y corre todas las demás un lugar: la cantidad pasa a
   * leerse como unidades y la descripción se pierde entera. En las filas donde
   * el OCR mete alguna basura entre la descripción y los números el error se
   * disimula, y en las que no, el renglón se cae. Sacándolo primero, lo que
   * queda son las columnas de verdad.
   */
  // Se admite cualquier basura delante del código: el OCR arrastra el borde de
  // la tabla y lo transcribe como "|", "-", "." o lo que le parezca.
  const conCodigo = izquierda.match(
    new RegExp(`^[^A-Za-z]*ART\\s*[-.:]?\\s*([${CLASE_DIGITOS_OCR}]{4,6})\\b`, 'i'),
  );
  const codigoDeLaFila = conCodigo ? `ART-${normalizarCodigo(conCodigo[1])}` : null;
  const resto = conCodigo ? izquierda.slice(conCodigo[0].length) : izquierda;

  // --- Columnas numéricas de la izquierda, de derecha a izquierda ----------
  const numeros = [...resto.matchAll(new RegExp(`(?<![${CLASE_DIGITOS_OCR}.,])([${CLASE_DIGITOS_OCR}][${CLASE_DIGITOS_OCR}.,]*)\\s*(kg\\b|kilos?\\b)?`, 'gi'))]
    .map((m) => ({ texto: m[1], kg: Boolean(m[2]), indice: m.index ?? 0 }))
    .filter((n) => /\d/.test(n.texto));

  if (numeros.length === 0) return null;

  // El precio es el último número de la izquierda.
  const precioCrudo = numeros[numeros.length - 1];

  // La cantidad es el anterior; si sólo hay un número, la fila no sirve.
  const cantidadCruda = numeros.length >= 2 ? numeros[numeros.length - 2] : null;
  if (!cantidadCruda) return null;

  const conciliado = conciliar(cantidadCruda.texto, precioCrudo.texto, subtotalesCrudos, netoImpreso);
  if (!conciliado) return null;
  const { cantidad, precio, subtotal } = conciliado;

  const unidadesCrudas = numeros.length >= 3 ? numeros[numeros.length - 3] : null;
  const unidades = unidadesCrudas
    ? elegirUnidades(unidadesCrudas.texto, cantidad, cantidadCruda.kg)
    : null;

  // --- Descripción ---------------------------------------------------------
  const cabeza = resto.slice(0, unidadesCrudas?.indice ?? cantidadCruda.indice);
  const separado = separarCodigo(cabeza);
  let codigo = codigoDeLaFila ?? separado.codigo;
  let descripcion = separado.descripcion;

  /*
   * Última red: el código que quedó adentro de la descripción.
   *
   * Si ni el prefijo de la línea ni separarCodigo lo agarraron —pasa cuando el
   * OCR mete algo raro entre el código y el nombre—, la descripción arranca con
   * "ART-00719 ROQUEFORT BAVARIA". Dejarlo ahí tiene una consecuencia concreta:
   * esa lectura no se parece a la otra del mismo renglón, no se reconocen como
   * el mismo artículo y el comprobante termina con un renglón repetido.
   */
  const codigoPegado = descripcion.match(
    new RegExp(`^ART\\s*[-.:]?\\s*([${CLASE_DIGITOS_OCR}]{4,6})\\b\\s*(.*)$`, 'i'),
  );
  if (codigoPegado) {
    codigo = codigo ?? `ART-${normalizarCodigo(codigoPegado[1])}`;
    descripcion = limpiarDescripcion(codigoPegado[2]);
  }

  /*
   * Sin descripción no hay renglón.
   *
   * Cuando la tabla se lee varias veces, la lectura que perdió la descripción
   * siempre tiene al lado otra que la conservó, así que descartarla no pierde
   * nada y evita que entre dos veces el mismo artículo. Y si fuera la única
   * lectura de esa fila, tampoco serviría: un renglón sin descripción no se
   * puede asociar a ningún producto, y su ausencia la detecta el control de la
   * suma de subtotales contra el neto impreso, que es el que corresponde.
   */
  if (normalizarDescripcion(descripcion).length < 6) return null;

  return {
    codigo,
    descripcion,
    unidades: unidades ? unidades.toNumber() : null,
    cantidad,
    // El sufijo "kg" impreso es lo único que decide. Sin sufijo, el artículo se
    // vende por unidad y Cantidad no son kilos.
    esKilos: cantidadCruda.kg,
    precio,
    subtotal,
    ivaRate: iva ? iva.toString() : null,
    descuento: descuento ? descuento.toString() : null,
  };
}

/**
 * Texto del subtotal, que es lo que hay a la derecha del ancla "0% 21%".
 *
 * Se devuelven dos lecturas del mismo tramo: el primer número suelto, y todos
 * los números del tramo pegados.
 *
 * La segunda existe porque el OCR parte el importe. Sobre RICOTA AL VACIO el
 * subtotal salió "$45 65574": tomando el primer número el renglón vale
 * cuarenta y cinco pesos, y pegando los dos vale $45.655,74, que es lo que dice
 * el papel y lo que confirma 14,4 × 3.170,54. Cuál de las dos es la buena no se
 * decide acá —se decide en `conciliar`, que prueba las dos contra cantidad ×
 * precio—; acá sólo se deja de perder la que estaba partida.
 */
function importesCrudosDelSubtotal(texto: string): string[] {
  const trozos = [...texto.matchAll(IMPORTE)]
    .map((m) => m[1])
    .filter((t) => /\d/.test(t));
  if (trozos.length === 0) return [];
  if (trozos.length === 1) return [trozos[0]];
  return [trozos[0], trozos.join('')];
}

/**
 * Elige, entre las lecturas posibles de los tres números, la que hace cerrar
 * el renglón.
 *
 * Sobre una foto el OCR pierde la coma decimal a cada rato: "$38.638,50" sale
 * "$3863850" y "$3.847,48" sale "$3.84748". Los dígitos están todos y en orden;
 * lo único que se perdió es dónde iba la coma.
 *
 * Esto **no** es ajustar un número para que la cuenta dé. Es elegir entre
 * lecturas de los mismos dígitos impresos, y la condición para aceptar una es
 * que satisfaga una igualdad que no depende de ella: cantidad × precio tiene
 * que dar el subtotal, tres columnas leídas por separado. Si ninguna
 * combinación cierra, no se toca nada: quedan los valores tal como salieron y
 * el renglón se marca para releer. Y por encima está el control de la suma de
 * los subtotales contra el neto gravado impreso, que es independiente de todo
 * esto.
 */
function conciliar(
  cantidadTexto: string,
  precioTexto: string,
  subtotalTextos: string[],
  netoImpreso: Decimal | null = null,
): { cantidad: Decimal; precio: Decimal | null; subtotal: Decimal } | null {
  const cantidades = variantesDeCantidad(cantidadTexto);
  const precios = variantesDeImporte(precioTexto);
  const subtotales: Decimal[] = [];
  for (const texto of subtotalTextos) {
    for (const valor of variantesDeImporte(texto)) {
      if (!subtotales.some((v) => v.eq(valor))) subtotales.push(valor);
    }
  }

  if (cantidades.length === 0 || subtotales.length === 0) return null;

  /*
   * Se juntan **todas** las combinaciones que cierran y recién después se
   * elige. Antes se devolvía la primera, y ahí estaba el error.
   *
   * La tolerancia crece con la cantidad, porque el precio unitario viene
   * redondeado a dos decimales y ese medio centavo se multiplica. Para 19,21 kg
   * el margen es de 12 centavos; para 1921 son casi diez pesos. Así que la
   * lectura mal escalada —la que multiplicó la cantidad por cien— se compra un
   * margen cien veces más grande, y con él cierra sola: sobre ROQUEFORT AZUL,
   * 1921 × 10.452,08 da 20.078.445,68 contra un subtotal leído de 20.078.437,
   * ocho pesos de diferencia dentro de un margen de nueve.
   *
   * Recorriendo de la más grande a la más chica, esa combinación aparecía
   * primero y ganaba. Ahora compiten todas y gana la de menor error relativo,
   * después de descartar las que no caben en el comprobante.
   */
  const combinaciones: { cantidad: Decimal; precio: Decimal; subtotal: Decimal; error: Decimal }[] = [];

  for (const cantidad of cantidades) {
    if (cantidad.lte(0)) continue;
    for (const precio of precios) {
      if (precio.lte(0)) continue;
      for (const subtotal of subtotales) {
        if (subtotal.lte(0)) continue;
        // Ningún renglón puede valer más que el neto gravado de la factura.
        if (netoImpreso && netoImpreso.gt(0) && subtotal.gt(netoImpreso.times(1.02))) continue;

        const tolerancia = cantidad.abs().times(0.005).plus(0.02);
        const diferencia = cantidad.times(precio).minus(subtotal).abs();
        if (diferencia.lte(tolerancia)) {
          // El error relativo, que no depende de la escala: es lo que permite
          // comparar una combinación de 19 kg con una de 1921.
          combinaciones.push({ cantidad, precio, subtotal, error: diferencia.div(subtotal) });
        }
      }
    }
  }

  if (combinaciones.length > 0) {
    combinaciones.sort((a, b) => a.error.comparedTo(b.error));
    const { cantidad, precio, subtotal } = combinaciones[0];
    return { cantidad, precio, subtotal };
  }

  // Nada cerró: se devuelve la lectura literal y el control se encarga.
  const cantidad = cantidades.find((c) => c.gt(0));
  if (!cantidad) return null;
  return { cantidad, precio: precios[0] ?? null, subtotal: subtotales[0] };
}

/**
 * Cuántos bultos entraron, cuando el OCR le pegó adelante la tilde manuscrita.
 *
 * Cada renglón lleva una tilde a mano en la columna Unid., y Tesseract la
 * transcribe como un dígito pegado al número: "720" por 20, "73" por 3. Los
 * candidatos son el número entero y el mismo sin sus primeros dígitos, que son
 * lecturas del mismo trazo.
 *
 * Para elegir se usa el peso por bulto que implica cada candidato: 78,5 kg en
 * 720 bultos daría piezas de 109 gramos, y en 20 bultos, de 3,9 kg. En una
 * fiambrería lo segundo es lo normal y lo primero no existe. Es una suposición
 * del rubro, y por eso vale acá y no en la plata: este número no entra en
 * ningún cálculo de costo, sólo describe cuántas piezas vinieron. Si ningún
 * candidato es razonable, se deja vacío en vez de guardar uno inventado.
 */
function elegirUnidades(crudo: string, cantidad: Decimal, esKilos: boolean): Decimal | null {
  const digitos = soloDigitos(crudo).replace(/^0+(?=\d)/, '');
  if (digitos === '') return null;

  // Sin kilos, Unid. y Cantidad son la misma cifra y no hay nada que elegir.
  if (!esKilos) {
    const valor = new Decimal(digitos);
    return valor.eq(cantidad) ? valor : null;
  }

  const PESO_TIPICO = 3; // kg por pieza, el orden de magnitud del rubro
  let mejor: { valor: Decimal; distancia: number } | null = null;

  for (let corte = 0; corte < digitos.length; corte++) {
    const trozo = digitos.slice(corte).replace(/^0+(?=\d)/, '');
    if (trozo === '') continue;
    const valor = new Decimal(trozo);
    if (valor.lte(0)) continue;

    const pesoPorBulto = cantidad.div(valor).toNumber();
    if (pesoPorBulto < 0.1 || pesoPorBulto > 60) continue;

    const distancia = Math.abs(Math.log(pesoPorBulto / PESO_TIPICO));
    if (!mejor || distancia < mejor.distancia) mejor = { valor, distancia };
  }

  return mejor ? mejor.valor : null;
}

/** Los dígitos de un número, sin separadores ni basura. */
function soloDigitos(crudo: string): string {
  return repararDigitos(crudo.replace(/[^0-9OoQlI|SsBbZzgq.,]/g, '')).replace(/[.,]/g, '');
}

/**
 * Lecturas posibles de un importe: la literal y la de dos decimales.
 *
 * Todo importe de esta factura viene con dos decimales, así que si la coma se
 * perdió, ponerla dos lugares desde la derecha reconstruye el número impreso.
 */
function variantesDeImporte(crudo: string): Decimal[] {
  const salida: Decimal[] = [];
  const literal = interpretarImporte(crudo);
  if (literal) salida.push(literal);

  const digitos = soloDigitos(crudo);
  if (digitos.length >= 3) {
    const conComa = new Decimal(`${digitos.slice(0, -2)}.${digitos.slice(-2)}`);
    if (!salida.some((v) => v.eq(conComa))) salida.push(conComa);
  }
  return salida;
}

/**
 * Lecturas posibles de una cantidad.
 *
 * La columna Cantidad trae uno o dos decimales ("39.2 kg", "18.38 kg"), así que
 * si se perdió el punto hay dos lugares donde pudo estar.
 */
function variantesDeCantidad(crudo: string): Decimal[] {
  const salida: Decimal[] = [];
  const literal = interpretarCantidad(crudo);
  if (literal) salida.push(literal);

  const digitos = soloDigitos(crudo);
  for (const decimales of [1, 2]) {
    if (digitos.length <= decimales) continue;
    const valor = new Decimal(`${digitos.slice(0, -decimales)}.${digitos.slice(-decimales)}`);
    if (!salida.some((v) => v.eq(valor))) salida.push(valor);
  }
  return salida;
}

/**
 * Un importe de la factura: siempre en formato argentino y con dos decimales.
 *
 * Cuando el OCR se come la coma —"$384748" por $3.847,48— no se inventa el
 * valor: se deja como salió. Quien decide si el renglón cierra es el control de
 * cantidad × precio, y un renglón que no cierra se marca para releer. Ajustar
 * el número acá para que la cuenta dé sería exactamente lo que no hay que
 * hacer: la cuenta daría siempre y el error viajaría hasta el costo del
 * producto.
 */
function interpretarImporte(crudo: string): Decimal | null {
  const limpio = repararDigitos(crudo.replace(/[^0-9OoQlI|SsBbZzgq.,]/g, ''));
  return parseArNumber(limpio);
}

/**
 * Una cantidad de la columna Cantidad, que viene con punto decimal.
 *
 * "39.2", "18.38", "156.3": acá el punto separa decimales, al revés que en los
 * importes. Es del formato de este proveedor, no una suposición.
 */
function interpretarCantidad(crudo: string): Decimal | null {
  const limpio = repararDigitos(crudo.replace(/[^0-9OoQlI|SsBbZzgq.,]/g, '')).replace(/,/g, '.');
  if (!/^\d+(?:\.\d+)?$/.test(limpio)) return parseArNumber(limpio);
  return new Decimal(limpio);
}

/** Deja el código de artículo en cinco dígitos, que es como los imprime. */
function normalizarCodigo(digitos: string): string {
  return repararDigitos(digitos).replace(/\D/g, '').padStart(5, '0').slice(-5);
}

/** Separa "ART-00873 BARRA DANBO..." en código y descripción. */
function separarCodigo(cabeza: string): { codigo: string | null; descripcion: string } {
  const limpia = cabeza.replace(/[|»·]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const conCodigo = limpia.match(new RegExp(`^ART\\s*-?\\s*([${CLASE_DIGITOS_OCR}]{4,6})\\s+(.*)$`, 'i'));
  if (conCodigo) {
    return {
      codigo: `ART-${normalizarCodigo(conCodigo[1])}`,
      descripcion: limpiarDescripcion(conCodigo[2]),
    };
  }
  return { codigo: null, descripcion: limpiarDescripcion(limpia) };
}

/**
 * Saca de la descripción la basura que el OCR arrastra del margen.
 *
 * Sobre esta factura, cada renglón lleva una tilde manuscrita en la columna
 * Unid. que Tesseract lee como "7", "»", "Za" o "fr:". Va pegada al final de la
 * descripción y no forma parte del nombre del artículo.
 */
function limpiarDescripcion(texto: string): string {
  let limpio = texto
    .replace(/[^0-9A-Za-zÁÉÍÓÚÑÜáéíóúñü.,\-/ ]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/[\s,.\-]+$/, '')
    .trim();

  /*
   * La tilde manuscrita de la columna Unid. sale pegada al final de la
   * descripción, y cada lectura la transcribe distinto: "CHOCOLATE e",
   * "SILVIA ía", "TERMOLI v", "TONADITA De", "AGUA 7/". No es parte del nombre
   * del artículo, y si se deja, dos lecturas del mismo renglón terminan con
   * descripciones distintas y no se reconocen como el mismo.
   *
   * Se saca cualquier pedacito final de uno o dos caracteres, salvo los que
   * tienen forma de medida —"X3" en MOZZARELLA CILINDRO BARRAZA X3—, que sí son
   * del nombre.
   */
  while (/\s\S{1,2}$/.test(limpio)) {
    const cola = limpio.match(/\s(\S{1,2})$/)![1];
    if (/^[A-Za-z]\d$/.test(cola)) break;
    limpio = limpio.replace(/\s\S{1,2}$/, '');
  }
  return limpio.trim();
}

// ---------------------------------------------------------------------------
// Pie
// ---------------------------------------------------------------------------

const ETIQUETAS_PIE: { campo: 'netTotal' | 'total'; patron: RegExp }[] = [
  { campo: 'netTotal', patron: /neto\s+gravado|^neto\b|^gravado\b/i },
  { campo: 'total', patron: /^total\b/i },
];

function analizarPie(
  texto: string,
  textoCompleto = '',
): { summary: OcrSummary; avisos: string[] } {
  const summary: OcrSummary = {
    grossSubtotal: null,
    discountTotal: null,
    netTotal: null,
    ivaLines: [],
    perceptionLines: [],
    ivaTotal: null,
    perceptionsTotal: null,
    total: null,
    lineCount: null,
    netWeightKg: null,
    totalUnits: null,
    packageCount: null,
  };
  const avisos: string[] = [];

  // --- 1. Con etiqueta, que es el caso fácil -------------------------------
  const sueltos: Decimal[] = [];
  for (const cruda of texto.split('\n')) {
    const linea = cruda.trim();
    if (linea === '') continue;

    // Una fila de artículo que quedó dentro del recorte del pie: se descarta.
    if (ANCLA_DTO_IVA.test(linea)) continue;

    const importe = ultimoImporte(linea);
    if (!importe) continue;

    const soloImporte = /^[$5]?\s*[\d.,]+\s*$/.test(linea);
    if (soloImporte) {
      sueltos.push(importe);
      continue;
    }

    if (/percepci/i.test(linea)) {
      const etiqueta = /iibb|ingresos\s+brutos/i.test(linea)
        ? 'Percepción IIBB Buenos Aires'
        : 'Percepción IVA RG 5329';
      summary.perceptionLines!.push({ label: etiqueta, rate: null, amount: importe.toString() });
      continue;
    }
    if (/^i\.?\s?v\.?\s?a\b/i.test(linea)) {
      summary.ivaLines!.push({ label: 'IVA', rate: '0.21', amount: importe.toString() });
      continue;
    }
    for (const { campo, patron } of ETIQUETAS_PIE) {
      if (summary[campo] != null) continue;
      if (!patron.test(linea)) continue;
      summary[campo] = importe.toString();
      break;
    }
  }

  // --- 2. Sin etiqueta: se ubican por posición y se comprueba la cuenta -----
  //
  // En una foto el recuadro de totales sale muchas veces partido en dos: las
  // etiquetas de un lado y los importes del otro, cada uno en su propio bloque,
  // y entonces ninguna línea tiene etiqueta e importe juntos.
  //
  // El orden impreso de este proveedor es fijo —neto, IVA, percepción de IVA,
  // percepción de IIBB, total—, así que los importes se pueden ubicar por su
  // posición. Es una regla que vale **para este formato y ningún otro**, y por
  // eso vive acá adentro: `asignarPorPosicion` y `reconstruirPie` no se exportan
  // y no las usa ni el analizador genérico ni ningún otro proveedor. Aplicar
  // "el primero es el neto" a un comprobante cuyo pie no conocemos sería
  // inventar con cara de dato.
  //
  // Y aun dentro de Errecalde, asignar por posición es una hipótesis, no una
  // lectura. Se acepta sólo si pasa las cinco condiciones de
  // `elPieEsDeErrecalde` + `asignarPorPosicion` + `reconstruirPie`. Si falla
  // cualquiera, no se completa nada y el comprobante queda para revisión.
  const faltaTodo = !summary.netTotal && summary.ivaLines!.length === 0 && !summary.total;
  if (faltaTodo && elPieEsDeErrecalde(sueltos)) {
    const cola = sueltos.slice(-5);
    const asignado = asignarPorPosicion(cola) ?? reconstruirPie(cola, textoCompleto);
    if (asignado) {
      summary.netTotal = asignado.neto.toString();
      summary.ivaLines!.push({ label: 'IVA', rate: '0.21', amount: asignado.iva.toString() });
      for (const [i, percepcion] of asignado.percepciones.entries()) {
        summary.perceptionLines!.push({
          label: i === 0 ? 'Percepción IVA RG 5329' : 'Percepción IIBB Buenos Aires',
          rate: null,
          amount: percepcion.toString(),
        });
      }
      summary.total = asignado.total.toString();
    } else {
      avisos.push(
        'El pie se leyó sin etiquetas y los importes no se pudieron verificar entre sí, así ' +
          'que no se asignaron: hay que releer los totales.',
      );
    }
  } else if (faltaTodo && sueltos.length > 0) {
    // Había importes sueltos pero el bloque no tiene la forma del pie de este
    // proveedor. Se dice, en vez de acomodarlos hasta que la cuenta dé.
    avisos.push(
      `Se leyeron ${sueltos.length} importes sueltos en el pie, pero no tienen la forma del ` +
        'recuadro de totales de este proveedor, así que no se asignaron: hay que releer los totales.',
    );
  }

  summary.ivaTotal = sumar(summary.ivaLines);
  summary.perceptionsTotal = sumar(summary.perceptionLines);

  // Control final: neto + IVA + percepciones tiene que dar el total impreso.
  if (summary.netTotal && summary.total) {
    const neto = parseArNumber(summary.netTotal)!;
    const iva = parseArNumber(summary.ivaTotal ?? '0') ?? new Decimal(0);
    const percepciones = parseArNumber(summary.perceptionsTotal ?? '0') ?? new Decimal(0);
    const total = parseArNumber(summary.total)!;
    const diferencia = neto.plus(iva).plus(percepciones).minus(total).abs();
    if (diferencia.gt(1)) {
      avisos.push(
        `El pie no cierra: ${neto.toFixed(2)} + ${iva.toFixed(2)} + ${percepciones.toFixed(2)} ` +
          `da ${neto.plus(iva).plus(percepciones).toFixed(2)} y el total impreso es ${total.toFixed(2)}.`,
      );
    }
  }

  return { summary, avisos };
}

/**
 * Interpreta el pie con cada lectura disponible y se queda con la mejor.
 *
 * Las fuentes son el recorte del pie y la página completa, y también las dos
 * concatenadas: cuando cada una tiene la mitad de los campos con etiqueta,
 * juntarlas deja que el paso de etiquetas encuentre los cinco sin tener que
 * suponer ningún orden.
 *
 * "Mejor" es un pie completo que cierre. Entre dos que cierren, el que tenga más
 * campos leídos con su etiqueta al lado, porque ésos no dependen de haber
 * supuesto nada.
 */
function mejorPie(textos: TextosComprobante): { summary: OcrSummary; avisos: string[] } {
  const recorte = textos.resumen ?? '';
  const completo = textos.completo ?? '';

  const fuentes: string[] = [];
  for (const fuente of [recorte, completo, `${recorte}\n${completo}`]) {
    if (fuente.trim() !== '' && !fuentes.includes(fuente)) fuentes.push(fuente);
  }
  if (fuentes.length === 0) return analizarPie('', '');

  const todoLoLeido = `${recorte}\n${completo}`;
  let mejor: { summary: OcrSummary; avisos: string[] } | null = null;
  let mejorPuntaje = -1;

  for (const fuente of fuentes) {
    // La evidencia de un valor deducido se busca siempre en todo lo leído, no
    // sólo en la fuente que se está probando: el rastro del neto deformado está
    // en la página completa aunque el pie se esté armando con el recorte.
    const resultado = analizarPie(fuente, todoLoLeido);
    const puntaje = puntuarPie(resultado.summary);
    if (puntaje > mejorPuntaje) {
      mejor = resultado;
      mejorPuntaje = puntaje;
    }
  }

  /*
   * Si ninguna fuente por sí sola dio un pie que cierre, se combinan los campos.
   *
   * Es el caso de Safari: el total bueno está sólo en el recorte, el IVA bueno
   * está sólo en la página completa —en el recorte salió cortado, $804.398,1 sin
   * el último dígito— y el neto no está bien en ninguna. Cada fuente falla, y
   * concatenarlas tampoco alcanza, porque entonces hay ocho importes sueltos y
   * ningún orden que suponer.
   *
   * Lo que sí se puede es tomar los importes de todas las lecturas como
   * candidatos de cada campo y buscar la combinación que cumpla las cinco
   * condiciones. No es aflojar nada: es buscar entre números que el OCR
   * efectivamente leyó, y aceptarlos sólo si entre ellos se verifican.
   */
  if (mejorPuntaje < 100) {
    const combinado = combinarCamposDelPie(fuentes, todoLoLeido);
    if (combinado && puntuarPie(combinado.summary) > mejorPuntaje) return combinado;
  }

  return mejor!;
}

/**
 * Arma el pie tomando cada campo de la lectura que lo tenga bien.
 *
 * Junta todos los importes que aparecieron en cualquier pasada y busca entre
 * ellos la combinación neto / IVA / percepciones / total que pase las cinco
 * condiciones. La búsqueda es chica —son unos pocos importes— y está acotada por
 * relaciones que no dependen de la combinación elegida, que es lo que la vuelve
 * una verificación y no un acomodo:
 *
 *  - el total tiene que ser el mayor de los cinco;
 *  - neto + IVA + percepciones tiene que dar el total;
 *  - el IVA tiene que ser el 21 % del neto;
 *  - el neto es mayor que el IVA, y el IVA mayor que cada percepción;
 *  - y el neto, si no se leyó y hubo que deducirlo, necesita que sus dígitos
 *    aparezcan en alguna cifra del texto.
 *
 * Entre las combinaciones que pasan, gana la que tenga más valores leídos y
 * menos deducidos: preferimos el número que estaba escrito al que salió de una
 * resta.
 */
function combinarCamposDelPie(
  fuentes: string[],
  todoLoLeido: string,
): { summary: OcrSummary; avisos: string[] } | null {
  // Todos los importes que apareció alguna pasada, sin repetir.
  const candidatos: Decimal[] = [];
  for (const fuente of fuentes) {
    for (const cruda of fuente.split('\n')) {
      const linea = cruda.trim();
      if (linea === '' || ANCLA_DTO_IVA.test(linea)) continue;
      const importe = ultimoImporte(linea);
      if (importe && importe.gt(0) && !candidatos.some((c) => c.eq(importe))) {
        candidatos.push(importe);
      }
    }
  }
  if (candidatos.length < 3) return null;

  let mejor: { neto: Decimal; iva: Decimal; percepciones: Decimal[]; total: Decimal; leidos: number } | null =
    null;

  for (const total of candidatos) {
    // El total es el mayor: ningún otro campo del pie puede superarlo.
    if (candidatos.some((c) => c.gt(total))) continue;

    for (const iva of candidatos) {
      if (iva.gte(total)) continue;

      // Las percepciones: ninguna, una o dos, siempre menores que el IVA.
      const posibles = candidatos.filter((c) => c.lt(iva));
      const combinacionesDePercepciones: Decimal[][] = [[]];
      for (const a of posibles) {
        combinacionesDePercepciones.push([a]);
        for (const b of posibles) {
          if (b.eq(a)) continue;
          combinacionesDePercepciones.push([a, b]);
        }
      }

      for (const percepciones of combinacionesDePercepciones) {
        const sumaPercepciones = percepciones.reduce((acc, v) => acc.plus(v), new Decimal(0));
        const netoDeducido = total.minus(iva).minus(sumaPercepciones);
        if (netoDeducido.lte(0) || netoDeducido.lte(iva)) continue;
        if (!ivaCoherente(netoDeducido, iva)) continue;

        // ¿El neto estaba leído, o hubo que deducirlo?
        const netoLeido = candidatos.find((c) => c.minus(netoDeducido).abs().lte('0.01'));
        const neto = netoLeido ?? netoDeducido;
        if (!netoLeido && !hayRastroDe(neto, todoLoLeido)) continue;

        const leidos = 2 + percepciones.length + (netoLeido ? 1 : 0);
        if (!mejor || leidos > mejor.leidos) {
          mejor = { neto, iva, percepciones, total, leidos };
        }
      }
    }
  }

  if (!mejor) return null;

  const summary = pieVacio();
  summary.netTotal = mejor.neto.toString();
  summary.ivaLines!.push({ label: 'IVA', rate: '0.21', amount: mejor.iva.toString() });
  for (const [i, percepcion] of mejor.percepciones.entries()) {
    summary.perceptionLines!.push({
      label: i === 0 ? 'Percepción IVA RG 5329' : 'Percepción IIBB Buenos Aires',
      rate: null,
      amount: percepcion.toString(),
    });
  }
  summary.total = mejor.total.toString();
  summary.ivaTotal = sumar(summary.ivaLines);
  summary.perceptionsTotal = sumar(summary.perceptionLines);

  return { summary, avisos: [] };
}

/**
 * ¿Los dígitos de este importe aparecen en alguna cifra que el OCR haya leído?
 *
 * Se busca sobre la sucesión de dígitos, sin separadores. "63,830.46737" no es
 * un importe argentino válido —coma de miles y cinco decimales— y como número no
 * se puede usar, pero contiene "383046737" en ese orden, que son los dígitos de
 * $3.830.467,37. Vale como evidencia de que ese número estaba en el papel, que
 * es para lo único que se lo usa.
 */
function hayRastroDe(valor: Decimal, texto: string): boolean {
  const buscados = digitosDe(valor.toFixed(2));
  return [...texto.matchAll(/[\d.,]{6,}/g)].some((c) => digitosDe(c[0]).includes(buscados));
}

/** Un resumen vacío, con las listas listas para llenar. */
function pieVacio(): OcrSummary {
  return {
    grossSubtotal: null,
    discountTotal: null,
    netTotal: null,
    ivaLines: [],
    perceptionLines: [],
    ivaTotal: null,
    perceptionsTotal: null,
    total: null,
    lineCount: null,
    netWeightKg: null,
    totalUnits: null,
    packageCount: null,
  };
}

/** Cuán bueno es un pie leído: completo y que cierre vale más que nada. */
function puntuarPie(summary: OcrSummary): number {
  const neto = parseArNumber(summary.netTotal ?? '');
  const total = parseArNumber(summary.total ?? '');
  const iva = parseArNumber(summary.ivaTotal ?? '');
  const percepciones = parseArNumber(summary.perceptionsTotal ?? '') ?? new Decimal(0);

  let puntos = 0;
  if (neto) puntos += 10;
  if (total) puntos += 10;
  if (iva) puntos += 10;
  puntos += (summary.perceptionLines?.length ?? 0) * 5;

  // Que cierre vale más que cualquier campo suelto.
  if (neto && total && iva) {
    const suma = neto.plus(iva).plus(percepciones);
    if (suma.minus(total).abs().lte(1)) puntos += 100;
    if (ivaCoherente(neto, iva)) puntos += 50;
  }

  return puntos;
}

/** La tasa de IVA de este proveedor, contra la que se contrasta el pie. */
const TASA_IVA = new Decimal('0.21');

/** ¿El IVA es coherente con el 21 % de ese neto? */
function ivaCoherente(neto: Decimal, iva: Decimal): boolean {
  const esperado = neto.times(TASA_IVA);
  // El IVA impreso sale de redondear renglón por renglón, así que nunca es
  // exactamente el 21 % del neto; un 2 % de holgura cubre esa diferencia sin
  // llegar a aceptar un número que no sea el IVA.
  return iva.minus(esperado).abs().lte(esperado.abs().times('0.02').plus(1));
}

/**
 * ¿Este bloque de importes sueltos puede ser el pie de una factura de Errecalde?
 *
 * Es el filtro previo a suponer cualquier orden, y mira la forma del bloque
 * antes que sus valores:
 *
 *  - **Cuántos son.** El pie de este proveedor tiene cinco renglones. Se admiten
 *    cuatro —cuando el recorte se comió el neto, que es el de más arriba— pero
 *    no menos: con tres no hay forma de distinguir un pie de tres importes
 *    sueltos de cualquier otra parte del papel.
 *  - **Cómo se ordenan.** El último es el total y tiene que ser el mayor de
 *    todos: es la suma de los otros. Y las percepciones son chicas al lado del
 *    neto y del IVA, nunca al revés.
 *
 * Un bloque que no tenga esta forma no se acomoda hasta que dé: se deja el pie
 * sin leer y el comprobante va a revisión.
 */
function elPieEsDeErrecalde(sueltos: Decimal[]): boolean {
  if (sueltos.length < 4 || sueltos.length > 5) return false;

  const cola = sueltos.slice(-5);
  const total = cola[cola.length - 1];
  const resto = cola.slice(0, -1);

  // El total manda: ningún renglón del pie puede ser mayor que él.
  if (!resto.every((v) => v.lt(total))) return false;
  // Y todos tienen que ser positivos; un pie con un importe en cero o negativo
  // es una lectura rota, no un pie.
  if (!cola.every((v) => v.gt(0))) return false;

  // Las percepciones son las dos últimas antes del total, y son las chicas.
  // Con cinco importes: neto, IVA, percepción, percepción, total.
  if (cola.length === 5) {
    const [neto, iva, percepcionUno, percepcionDos] = cola;
    if (!iva.lt(neto)) return false;
    if (!percepcionUno.lt(iva) || !percepcionDos.lt(iva)) return false;
  }

  return true;
}

/**
 * Reparte los importes sueltos del pie por su orden impreso.
 *
 * Devuelve null si la cuenta no cierra o si el IVA no se parece al 21 % del
 * neto: son las dos pruebas de que el orden que se supuso es el que estaba en el
 * papel. Sin ellas, cualquier lista de cinco números se acomoda.
 */
function asignarPorPosicion(valores: Decimal[]): {
  neto: Decimal;
  iva: Decimal;
  percepciones: Decimal[];
  total: Decimal;
} | null {
  if (valores.length < 3) return null;
  const total = valores[valores.length - 1];
  const neto = valores[0];
  const iva = valores[1];
  const percepciones = valores.slice(2, -1);

  const suma = percepciones.reduce((acumulado, v) => acumulado.plus(v), neto.plus(iva));
  if (suma.minus(total).abs().gt(1)) return null;
  // La igualdad sola no alcanza: con cinco números cualesquiera que sumen bien,
  // el orden podría ser otro. Que además el segundo sea el 21 % del primero es
  // lo que ata la asignación a este formato y no a cualquier lista que cierre.
  if (!ivaCoherente(neto, iva)) return null;
  return { neto, iva, percepciones, total };
}

/** Los dígitos de un número, sin separadores ni signos. */
function digitosDe(valor: string): string {
  return valor.replace(/\D/g, '');
}

/**
 * Recupera el pie cuando el recorte perdió el neto gravado.
 *
 * Es lo que pasa en el teléfono con esta factura: el recorte del pie trae los
 * cuatro importes de abajo —IVA, las dos percepciones y el TOTAL— pero el neto
 * queda justo arriba del corte, y en la página completa sale deformado
 * ("63,830.46737" donde el papel dice $3.830.467,37), tan roto que ninguna regla
 * de separadores lo puede interpretar.
 *
 * El neto se deduce de los otros cuatro: total − IVA − percepciones. Pero
 * deducirlo así y usarlo sería hacer trampa, porque entonces "neto + IVA +
 * percepciones = total" se cumple por construcción y no verifica nada.
 *
 * Por eso el valor deducido sólo se acepta si aparece **corroborado por otra
 * lectura independiente**: sus dígitos tienen que estar, en ese orden, dentro de
 * alguna cifra que el OCR haya leído en la página. Los separadores pueden estar
 * mal y puede sobrar basura alrededor —de ahí el "63" de más—, pero la sucesión
 * de dígitos del papel tiene que estar. Si no aparece en ningún lado, no se
 * completa nada y el comprobante queda para releer.
 */
function reconstruirPie(
  valores: Decimal[],
  textoCompleto: string,
): { neto: Decimal; iva: Decimal; percepciones: Decimal[]; total: Decimal } | null {
  // Hacen falta el total, el IVA y al menos una percepción para deducir el neto.
  if (valores.length < 3 || valores.length > 4) return null;

  const total = valores[valores.length - 1];
  const iva = valores[0];
  const percepciones = valores.slice(1, -1);
  const neto = percepciones.reduce((acumulado, v) => acumulado.minus(v), total.minus(iva));

  // Un neto deducido tiene que ser positivo y el mayor de los sumandos: si no,
  // los importes no estaban en el orden que se supuso.
  if (neto.lte(0) || neto.lte(iva)) return null;

  // El IVA de esta factura es del 21 %: sirve como segundo control barato.
  if (!ivaCoherente(neto, iva)) return null;

  // Y la corroboración: los dígitos del neto deducido, en alguna cifra leída.
  const buscados = digitosDe(neto.toFixed(2));
  const hayRastro = [...textoCompleto.matchAll(/[\d.,]{6,}/g)].some((coincidencia) =>
    digitosDe(coincidencia[0]).includes(buscados),
  );
  if (!hayRastro) return null;

  return { neto, iva, percepciones, total };
}

/** Último importe de la línea, ignorando la etiqueta. */
function ultimoImporte(linea: string): Decimal | null {
  const encontrados = [...linea.matchAll(new RegExp(`[$5]?\\s*([${CLASE_DIGITOS_OCR}][${CLASE_DIGITOS_OCR}.,]*)`, 'g'))];
  for (let i = encontrados.length - 1; i >= 0; i--) {
    const valor = interpretarImporte(encontrados[i][1]);
    if (valor !== null) return valor;
  }
  return null;
}

function sumar(lineas: OcrTaxLine[] | undefined): string | null {
  if (!lineas || lineas.length === 0) return null;
  let total = new Decimal(0);
  for (const linea of lineas) {
    const valor = parseArNumber(linea.amount);
    if (valor) total = total.plus(valor);
  }
  return total.toString();
}
