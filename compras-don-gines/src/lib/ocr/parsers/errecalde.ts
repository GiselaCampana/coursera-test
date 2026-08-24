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
    const { summary, avisos: avisosPie } = analizarPie(
      textos.resumen || textos.completo,
      textos.completo,
    );
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

/** ¿Dos códigos que podrían ser el mismo, con un dígito mal leído? */
function codigosCompatibles(a: string | null, b: string | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let distintos = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] && ++distintos > 1) return false;
  }
  return true;
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

    const fila = analizarFila(linea);
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
export function analizarFila(linea: string): FilaErrecalde | null {
  const ancla = ANCLA_DTO_IVA.exec(linea);
  if (!ancla) return null;

  const izquierda = linea.slice(0, ancla.index);
  const derecha = linea.slice(ancla.index + ancla[0].length);

  const subtotalCrudo = primerImporteCrudo(derecha);
  if (subtotalCrudo === null) return null;

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

  const conciliado = conciliar(cantidadCruda.texto, precioCrudo.texto, subtotalCrudo);
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

/** Texto del primer importe de un tramo de línea, sin interpretar todavía. */
function primerImporteCrudo(texto: string): string | null {
  IMPORTE.lastIndex = 0;
  const encontrado = IMPORTE.exec(texto);
  if (!encontrado) return null;
  return /\d/.test(encontrado[1]) ? encontrado[1] : null;
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
  subtotalTexto: string,
): { cantidad: Decimal; precio: Decimal | null; subtotal: Decimal } | null {
  const cantidades = variantesDeCantidad(cantidadTexto);
  const precios = variantesDeImporte(precioTexto);
  const subtotales = variantesDeImporte(subtotalTexto);

  if (cantidades.length === 0 || subtotales.length === 0) return null;

  for (const cantidad of cantidades) {
    if (cantidad.lte(0)) continue;
    for (const precio of precios) {
      for (const subtotal of subtotales) {
        const tolerancia = cantidad.abs().times(0.005).plus(0.02);
        if (cantidad.times(precio).minus(subtotal).abs().lte(tolerancia)) {
          return { cantidad, precio, subtotal };
        }
      }
    }
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
  // El orden impreso es fijo —neto, IVA, percepción de IVA, percepción de IIBB,
  // total— así que se pueden asignar por posición. Pero asignarlos a ciegas
  // sería adivinar: sólo se aceptan si la suma de los cuatro primeros da el
  // quinto. Esa igualdad es la que vuelve verificable la asignación, y si no se
  // cumple no se completa nada y el comprobante queda para releer.
  const faltaTodo = !summary.netTotal && summary.ivaLines!.length === 0 && !summary.total;
  if (faltaTodo && sueltos.length >= 3) {
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
        'El pie se leyó sin etiquetas y los importes no cierran entre sí, así que no se ' +
          'asignaron: hay que releer los totales.',
      );
    }
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
 * Reparte los importes sueltos del pie por su orden impreso.
 *
 * Devuelve null si la cuenta no cierra: es la única prueba de que el orden que
 * se supuso es el que estaba en el papel.
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
  const ivaEsperado = neto.times('0.21');
  if (iva.minus(ivaEsperado).abs().gt(ivaEsperado.times('0.02').plus(1))) return null;

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
