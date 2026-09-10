import { esNotaDeCredito } from '@/lib/ocr/text-parser';
import { emisorNormalizado, hastaLaTabla } from '@/lib/ocr/zona-emisor';
import { Decimal, parseArNumber } from '@/lib/money';
import { parseArDate, toISODate } from '@/lib/datetime';
import type { OcrHeader, OcrItem, OcrSummary } from '@/lib/ocr/types';
import {
  CLASE_DIGITOS_OCR,
  repararDigitos,
  type AnalisisComprobante,
  type AnalizadorComprobante,
  type TextosComprobante,
} from '@/lib/ocr/parsers/tipos';

/**
 * Analizador de las facturas de Distribuidora Ezra.
 *
 * Formato:
 *
 *   Codigo Cantidad Descripción            Marca      P.Unit  Desc.% P.U.Desc.  Importe
 *   47       4,240  Cremoso LA PAULINA     La Paulina 6.723,279 5,000 6.387,115 27.081,371
 *   4249     3,000  BOLSA GRANDE                         74,380         74,380     223,140
 *
 * Dos cosas de este formato que ningún analizador genérico puede adivinar, y que
 * son exactamente las que rompieron la lectura:
 *
 *  1. **La cantidad va antes de la descripción.** Casi todos los proveedores la
 *     ponen después. El analizador genérico busca las columnas numéricas al
 *     final de la línea y toma las últimas cuatro como cantidad, precio,
 *     bonificación e importe; acá las últimas cuatro son P.Unit, Desc.%,
 *     P.U.Desc. e Importe. Eso corre todo un lugar —el precio unitario entra
 *     como kilaje, el descuento como precio, el precio con descuento como
 *     bonificación— y además deja la cantidad pegada al nombre, porque queda a
 *     la izquierda junto con la descripción.
 *
 *  2. **Hay dos columnas de precio.** P.Unit es el de lista y P.U.Desc. el que
 *     de verdad se pagó. El costo sale del segundo; el primero no entra en
 *     ninguna cuenta.
 *
 * El ancla **no es posicional**, y no puede serlo: sobre la foto real el OCR
 * pierde el código de un renglón, corta la cantidad de otro y mete basura entre
 * medio, así que contar columnas se desarma. Lo que ancla la fila son sus dos
 * identidades aritméticas, que se cumplen las dos a la vez sólo si cada número
 * cayó en su columna:
 *
 *     P.Unit × (1 − Desc.%/100) ≈ P.U.Desc.
 *     Cantidad × P.U.Desc.      ≈ Importe
 *
 * Son dos ecuaciones sobre cuatro columnas leídas por separado. Que se cumplan
 * por casualidad con los números equivocados no es algo que pase.
 *
 * Lo que no hace: inventar la unidad. Ver `unit` más abajo.
 */

/** El CUIT impreso, sin separadores. */
const CUIT = '30719519608';

export const analizadorEzra: AnalizadorComprobante = {
  codigo: 'ezra',
  nombre: 'Distribuidora Ezra',

  reconoce(textos: TextosComprobante): number {
    /*
     * El proveedor, y sólo desde la zona del emisor.
     *
     * Ver `@/lib/ocr/zona-emisor`: buscar el nombre en la página entera es lo
     * que hacía que esta misma factura se la quedara el analizador de Los
     * Calvos, porque «LOS CALVOS» es la marca de uno de sus artículos.
     */
    const emisor = emisorNormalizado(textos);
    const porCuit = new RegExp(CUIT).test(emisor.replace(/[\s.-]/g, ''));
    // «EZRA» es corto y el OCR le cambia letras; se acepta también el nombre
    // largo de la cooperativa, que es el que sale entero con más frecuencia.
    const porNombre = /\bE[Z2]R[A4]\b|C[O0][O0]PER[A4]T[I1]V[A4]\s+DE\s+TR[A4]B[A4]J[O0]\s+E[Z2]R[A4]/.test(
      emisor,
    );
    if (!porCuit && !porNombre) return 0;

    let puntaje = 0;
    if (porCuit) puntaje += 0.6;
    if (porNombre) puntaje += 0.3;
    // Y las señales del formato, que confirman. Éstas sí se buscan en todo el
    // texto: son títulos de columna, y viven adentro de la tabla.
    const todo = `${textos.completo}\n${textos.articulos ?? ''}`.toUpperCase();
    if (/P\.?\s?U\.?\s?DESC/.test(todo)) puntaje += 0.2;
    if (/DESC\.?\s?%/.test(todo)) puntaje += 0.1;
    if (/DISTRIBUIDORA/.test(emisor)) puntaje += 0.1;

    return Math.min(1, puntaje);
  },

  analizar(textos: TextosComprobante): AnalisisComprobante {
    const observaciones: string[] = [];
    const header = analizarEncabezado(textos);
    const summary = analizarPie(`${textos.resumen ?? ''}\n${textos.completo}`, observaciones);

    const { items, avisos } = analizarArticulosEzra(
      textos.articulos ?? '',
      textos.completo,
      parseArNumber(summary.netTotal ?? '') ?? null,
    );
    observaciones.push(...avisos);

    if (items.length === 0) {
      observaciones.push('No se reconoció ningún renglón en la tabla de artículos.');
    }

    /*
     * La suma de los renglones contra el neto impreso.
     *
     * En este formato los importes se imprimen con **tres** decimales y el pie
     * con dos, y el neto del pie es la suma *truncada*, no redondeada: los seis
     * renglones suman 221.388,847 y el papel dice 221.388,84. Comparar contra el
     * redondeo daría un centavo de diferencia en cada factura de este proveedor,
     * que es exactamente el ruido que hace que después nadie mire los avisos.
     */
    if (items.length > 0 && summary.netTotal) {
      const neto = parseArNumber(summary.netTotal);
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
      if (completos && neto) {
        const truncada = suma.toDecimalPlaces(2, Decimal.ROUND_DOWN);
        if (!truncada.eq(neto)) {
          observaciones.push(
            `Los ${items.length} importes suman ${suma.toFixed(3)}, que truncado a dos decimales ` +
              `da ${truncada.toFixed(2)}, y el neto impreso es ${neto.toFixed(2)}: faltan o sobran renglones.`,
          );
        }
      }
    }

    return { header, items, summary, observaciones };
  },
};

// ---------------------------------------------------------------------------
// Números
// ---------------------------------------------------------------------------

/**
 * Todas las lecturas posibles de un número, para que la aritmética elija.
 *
 * Sobre esta foto el OCR escribe los puntos de miles como comas: el papel dice
 * «15.295,149» y sale «15,295,149», que leído al pie de la letra es quince
 * millones. Los dígitos están todos y en orden; lo único que se perdió es cuál
 * de los separadores era la coma decimal.
 *
 * Esto **no** es ajustar un número para que la cuenta cierre. Es enumerar
 * lecturas de los mismos dígitos impresos, y la que se acepta tiene que
 * satisfacer una igualdad que no depende de ella: cantidad × precio con
 * descuento tiene que dar el importe, columnas leídas por separado. Si ninguna
 * cierra, no se toca nada y el renglón queda marcado.
 */
export function variantesDeNumero(texto: string): Decimal[] {
  const limpio = repararDigitos(texto.trim().replace(/[$%\s]/g, ''));
  const salida: Decimal[] = [];
  const agregar = (v: Decimal | null) => {
    if (v && v.isFinite() && !salida.some((x) => x.eq(v))) salida.push(v);
  };

  agregar(parseArNumber(limpio));

  const separadores = [...limpio.matchAll(/[.,]/g)].map((m) => m.index!);
  if (separadores.length >= 2) {
    // El último separador es la coma decimal y los otros son de miles.
    const ultimo = separadores[separadores.length - 1];
    const enteros = limpio.slice(0, ultimo).replace(/[.,]/g, '');
    const decimales = limpio.slice(ultimo + 1);
    if (/^\d+$/.test(enteros) && /^\d+$/.test(decimales)) {
      agregar(new Decimal(`${enteros}.${decimales}`));
    }
    // Y la lectura en la que todos son de miles: un entero.
    const todoEntero = limpio.replace(/[.,]/g, '');
    if (/^\d+$/.test(todoEntero)) agregar(new Decimal(todoEntero));
  }

  return salida;
}

/**
 * Los números sueltos que hay en un texto, con todas sus lecturas.
 *
 * Se exporta para poder fijarle la regla directamente: que una letra suelta no
 * se convierta en una cifra es una garantía de esta función, y probarla sólo a
 * través de la factura entera la deja sin red en cuanto otro cambio tape el
 * síntoma. Ver la regresión de SUB-TOTAL en `numeros-canonicos.test.ts`.
 */
export function numerosDelTexto(texto: string): Decimal[] {
  const encontrados = [
    ...texto.matchAll(new RegExp(`[${CLASE_DIGITOS_OCR}][${CLASE_DIGITOS_OCR}.,]*`, 'g')),
  ].map((m) => m[0]);
  const salida: Decimal[] = [];
  for (const crudo of encontrados) {
    /*
     * Un tramo sin ningún dígito de verdad no es un número.
     *
     * `CLASE_DIGITOS_OCR` incluye las letras con las que el OCR confunde
     * dígitos —S por 5, B por 8, O por 0— y eso está bien **adentro** de un
     * número, para reparar «1S3,7O». Pero aplicado a un texto cualquiera
     * convierte cada letra suelta en una cifra: la S de «SUB-TOTAL» salía como
     * un 5.
     *
     * No era inofensivo. Ese 5 entraba en los números del pie, y como los del
     * pie se descartan de los candidatos de los renglones, el 5 % de descuento
     * de los dos primeros artículos quedaba afuera y los dos se cargaban sin
     * descuento.
     */
    if (!/\d/.test(crudo)) continue;
    for (const valor of variantesDeNumero(crudo)) {
      if (valor.gt(0) && !salida.some((x) => x.eq(valor))) salida.push(valor);
    }
  }
  return salida;
}

/** ¿Dos importes que son el mismo, con la tolerancia del redondeo impreso? */
function casiIgual(a: Decimal, b: Decimal, tolerancia: Decimal): boolean {
  return a.minus(b).abs().lte(tolerancia);
}

// ---------------------------------------------------------------------------
// Filas
// ---------------------------------------------------------------------------

export interface FilaEzra {
  codigo: string | null;
  descripcion: string;
  cantidad: Decimal;
  precioLista: Decimal | null;
  descuentoPct: Decimal;
  precioConDescuento: Decimal;
  importe: Decimal;
  /** ¿El importe salió impreso del papel, o se dedujo? */
  importeImpreso: boolean;
}

/**
 * El esqueleto de una fila: código, cantidad y descripción.
 *
 * Es la parte izquierda, la que el OCR lee bien incluso cuando pierde los
 * números: sobre la foto real los seis códigos y las seis cantidades salen
 * enteros de la página completa, en orden, aunque en esa misma pasada Tesseract
 * haya desarmado la tabla y puesto cada columna numérica en un bloque aparte.
 */
export interface EsqueletoEzra {
  codigo: string | null;
  cantidad: Decimal;
  descripcion: string;
  /**
   * La línea de la que salió, tal cual.
   *
   * Cuando la fila trae sus propios importes —el recorte de la tabla los pone
   * en la misma línea— se usan ésos y no los del texto entero. Buscar en todo
   * el comprobante es la red para las filas que quedaron desarmadas, no el
   * método preferido: cuantos más números se miran, más chance hay de que dos
   * casuales satisfagan la aritmética de otra fila.
   */
  linea: string;
}

/** «47   4,240 Cremoso LA PAULINA   La Paulina» */
const ESQUELETO = new RegExp(
  `^[^${CLASE_DIGITOS_OCR}]*([${CLASE_DIGITOS_OCR}]{1,6})\\s+([${CLASE_DIGITOS_OCR}]{1,3}[.,][${CLASE_DIGITOS_OCR}]{3})\\s+(\\D.*)$`,
);

/**
 * Junta la descripción con la marca sin repetirla.
 *
 * La marca es una columna aparte del papel, y en varios renglones repite algo
 * que la descripción ya dice: «Cremoso LA PAULINA» con marca «La Paulina». Pegar
 * las dos a ciegas da «Cremoso LA PAULINA La Paulina».
 *
 * Pero borrar la marca siempre tampoco sirve, y es peor: en esta misma factura
 * conviven «JAMON COCIDO MINI TRADICIONAL» de Los Calvos y «JAMON COCIDO MINI»
 * de Il Molise. Sin la marca, dos artículos distintos de dos fabricantes
 * distintos quedan con nombres casi iguales, y el que los tiene que asociar a su
 * PLU no tiene con qué distinguirlos. Así que la marca se conserva salvo que
 * duplique lo que la descripción ya dice.
 */
export function unirDescripcionYMarca(partes: string[]): string {
  const limpias = partes.map((p) => p.replace(/\s{2,}/g, ' ').trim()).filter((p) => p !== '');
  const salida: string[] = [];
  const normalizar = (t: string) =>
    t
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');

  for (const parte of limpias) {
    const yaEsta = salida.some((otra) => {
      const a = normalizar(otra);
      const b = normalizar(parte);
      return b.length >= 4 && (a.includes(b) || b.includes(a));
    });
    if (!yaEsta) salida.push(parte);
  }
  return salida.join(' ').replace(/\s{2,}/g, ' ').trim();
}

/** Los esqueletos que hay en un texto, en el orden en que están impresos. */
export function esqueletosDeFila(texto: string): EsqueletoEzra[] {
  const salida: EsqueletoEzra[] = [];
  for (const cruda of texto.split('\n')) {
    const linea = cruda.trim();
    if (linea === '' || esTitulo(linea)) continue;

    const m = ESQUELETO.exec(linea);
    if (!m) continue;

    const cantidad = parseArNumber(repararDigitos(m[2]));
    if (!cantidad || cantidad.lte(0)) continue;

    /*
     * De la descripción se saca lo que a esta altura ya son números: en la
     * página completa la fila trae sólo el texto, pero en el recorte de la tabla
     * la misma fila viene con sus cuatro importes pegados atrás.
     */
    const resto = m[3].split(/\s{2,}/).map((p) => p.trim());
    const soloTexto = resto.filter((p) => p !== '' && /[A-Za-z]{2}/.test(p) && !esSoloNumero(p));
    const descripcion = unirDescripcionYMarca(soloTexto);
    if (descripcion.replace(/[^A-Za-z0-9]/g, '').length < 4) continue;

    const codigo = repararDigitos(m[1]);
    salida.push({
      codigo: /^\d{1,6}$/.test(codigo) ? codigo : null,
      cantidad,
      descripcion,
      linea,
    });
  }
  return salida;
}

/** ¿La columna es sólo un número, con la basura habitual del OCR? */
function esSoloNumero(texto: string): boolean {
  return /^[$%\s.,-]*[\dOoQlI|SsBbZzgq][\dOoQlI|SsBbZzgq$%\s.,-]*$/.test(texto.trim());
}

/** Líneas que nunca son un renglón: títulos de columna y renglones del pie. */
function esTitulo(linea: string): boolean {
  return /^(c[oó]digo|codigo|digo|cantidad|descripci|marca|p\.?\s?unit|desc|importe|sub\s?-?\s?total|total|i\.?\s?v\.?\s?a|pesos|descuentos?|neto|cae|comprobante|sistema|nota)\b/i.test(
    linea.trim(),
  );
}

/**
 * Los cuatro números de un renglón, buscados por sus dos identidades.
 *
 * Se le pasan la cantidad —que viene del esqueleto, y es de lo poco que el OCR
 * lee bien— y todos los números que aparecen en el texto. Se buscan un importe
 * y un precio con descuento tales que cantidad × precio = importe, y después un
 * precio de lista y un porcentaje que expliquen ese precio con descuento.
 *
 * La tolerancia del primer control no es cero y no puede serlo: el P.U.Desc.
 * impreso ya viene redondeado a tres decimales, así que cantidad × P.U.Desc. da
 * hasta medio centésimo de diferencia contra el importe impreso. Un centavo
 * cubre eso y no alcanza para confundir dos renglones distintos.
 */
export function numerosDelRenglon(
  cantidad: Decimal,
  candidatos: Decimal[],
  netoImpreso: Decimal | null,
): { precioLista: Decimal | null; descuentoPct: Decimal; precioConDescuento: Decimal; importe: Decimal } | null {
  const posibles = candidatos.filter(
    (c) => c.gt(0) && (!netoImpreso || netoImpreso.lte(0) || c.lte(netoImpreso.times(1.02))),
  );

  // Los importes grandes primero: el importe de un renglón es el número más
  // grande de su fila, y probarlo antes evita quedarse con una coincidencia
  // chica y casual.
  const porTamaño = [...posibles].sort((a, b) => b.comparedTo(a));

  for (const importe of porTamaño) {
    /*
     * El precio con descuento sale del cociente, corroborado por el impreso.
     *
     * Tomar directamente el número impreso no alcanza sobre esta foto: en el
     * renglón 48 el papel dice 8.267,696 y el OCR lo perdió en las dos pasadas
     * —«8.267,596» en una y «8.267,69», truncado, en la otra—. Ninguna de las
     * dos multiplicada por 7,345 da el importe impreso.
     *
     * El cociente importe ÷ cantidad, en cambio, sale de dos columnas que sí se
     * leyeron bien, y da el precio con toda la precisión que el papel imprime.
     * Esto **no** es inventar un número para que la cuenta cierre: la condición
     * para aceptarlo es que el precio impreso —el que se pudo leer, con los
     * errores que tenga— lo corrobore. Si el papel no dice algo parecido, el
     * cociente no se usa y el renglón queda sin resolver.
     */
    const esperado = importe.div(cantidad);
    // Un precio de menos de un peso no es un precio: es que el "importe" que se
    // está probando era en realidad otra cosa.
    if (esperado.lt(1)) continue;
    const margen = Decimal.max(esperado.times(0.0005), new Decimal('0.02'));
    const cerca = posibles
      .filter((c) => casiIgual(c, esperado, margen))
      .sort((a, b) => a.minus(esperado).abs().comparedTo(b.minus(esperado).abs()));
    const corrobora = cerca[0];
    if (!corrobora) continue;

    /*
     * Y entre el impreso y el cociente, gana el impreso **si reproduce el
     * importe**.
     *
     * El papel redondea el precio y el importe por separado, así que el precio
     * impreso multiplicado por la cantidad no da exactamente el importe
     * impreso: da unas milésimas de menos. Eso está bien y es lo que dice el
     * comprobante, así que se guarda ese número, que es el que la usuaria puede
     * ir a leer al papel.
     *
     * El cociente se usa sólo cuando el impreso no llega, que es cuando el OCR
     * lo rompió: en el renglón 48 las dos pasadas dieron un precio que
     * multiplicado por la cantidad se aleja cinco centavos del importe.
     */
    const precioConDescuento = casiIgual(
      cantidad.times(corrobora),
      importe,
      new Decimal('0.01'),
    )
      ? corrobora
      : esperado.toDecimalPlaces(3);

    /*
     * Y ahora el precio de lista con su porcentaje.
     *
     * Puede no haber: BOLSA GRANDE se factura sin descuento y el papel deja la
     * columna Desc.% en blanco, con P.Unit y P.U.Desc. iguales. Ahí el descuento
     * es cero y el precio de lista es el mismo.
     *
     * La condición para aceptar un descuento es estrecha a propósito, y sale de
     * haberla tenido floja: con una tolerancia de centésimos, a BOLSA GRANDE se
     * le encontraba un «7 %» entre números sueltos del comprobante que no eran
     * de su fila. Se le exige a la terna que el precio de lista, el porcentaje y
     * el precio con descuento cierren entre sí **como están impresos**, con la
     * precisión de los tres decimales del papel.
     */
    let precioLista: Decimal | null = null;
    let descuentoPct = new Decimal(0);
    // De mayor a menor: el P.Unit es el precio más alto de la fila.
    for (const lista of [...posibles].sort((a, b) => b.comparedTo(a))) {
      if (lista.lte(precioConDescuento)) continue;
      const pct = lista.minus(precioConDescuento).div(lista).times(100);
      // Un descuento comercial es de al menos un punto y no llega a la mitad.
      if (pct.lt(1) || pct.gt(50)) continue;
      // El porcentaje tiene que estar impreso en el comprobante, y la cuenta
      // tiene que cerrar con él a la milésima.
      const impreso = posibles.find(
        (c) =>
          casiIgual(c, pct, new Decimal('0.01')) &&
          casiIgual(
            lista.times(new Decimal(1).minus(c.div(100))),
            precioConDescuento,
            new Decimal('0.001'),
          ),
      );
      if (!impreso) continue;
      precioLista = lista;
      descuentoPct = impreso;
      break;
    }
    if (!precioLista) precioLista = precioConDescuento;

    return { precioLista, descuentoPct, precioConDescuento, importe };
  }

  return null;
}

/**
 * Reconstruye los renglones de la tabla de Ezra.
 *
 * Trabaja con las dos pasadas a la vez, y por la misma razón que Errecalde y
 * Mabelherdi: cada una tiene la mitad buena de la otra. Sobre la foto real, el
 * recorte de la tabla trae los cuatro importes de cada fila en su línea pero
 * corta la columna de códigos contra el borde izquierdo; la página completa trae
 * los seis códigos y las seis cantidades enteros, pero Tesseract le desarma la
 * tabla y pone cada columna numérica en un bloque aparte.
 *
 * El esqueleto —código, cantidad, descripción— sale de donde se lo pueda leer, y
 * los cuatro números se buscan **por aritmética** entre todos los del texto. No
 * hace falta saber en qué línea quedó cada uno, que es justamente lo que la
 * página completa perdió.
 */
export function analizarArticulosEzra(
  textoArticulos: string,
  textoCompleto: string,
  netoImpreso: Decimal | null,
): { items: OcrItem[]; avisos: string[] } {
  const avisos: string[] = [];

  /*
   * Los esqueletos, de las dos pasadas, sin repetir.
   *
   * Se prefiere el que traiga código: el recorte de la tabla lo pierde contra el
   * borde y la página completa lo tiene, y es el dato con el que después se
   * asocia el renglón al PLU del catálogo.
   */
  const crudos = [...esqueletosDeFila(textoCompleto), ...esqueletosDeFila(textoArticulos)];
  const esqueletos: EsqueletoEzra[] = [];
  for (const candidato of crudos) {
    const yaEsta = esqueletos.findIndex(
      (e) =>
        (candidato.codigo && e.codigo === candidato.codigo) ||
        (e.cantidad.eq(candidato.cantidad) && seParecen(e.descripcion, candidato.descripcion)),
    );
    if (yaEsta === -1) {
      esqueletos.push(candidato);
      continue;
    }
    // Se queda el más completo: con código y con la descripción más larga.
    const actual = esqueletos[yaEsta];
    esqueletos[yaEsta] = {
      codigo: actual.codigo ?? candidato.codigo,
      cantidad: actual.cantidad,
      descripcion:
        candidato.descripcion.length > actual.descripcion.length
          ? candidato.descripcion
          : actual.descripcion,
      /*
       * De las dos líneas se conserva la que traiga números.
       *
       * El esqueleto suele venir de la página completa, donde la fila tiene
       * sólo texto; el recorte de la tabla trae la misma fila con sus cuatro
       * importes al lado. Quedarse con la que los tiene evita caer en la
       * búsqueda global, que mira todo el comprobante y es más fácil de
       * confundir.
       */
      linea: /\d[.,]\d/.test(candidato.linea) ? candidato.linea : actual.linea,
    };
  }

  /*
   * Los números de todo el comprobante, menos los del pie.
   *
   * No se puede cortar el texto por posición: en la página completa Tesseract
   * mezcla el orden de los bloques, y el de importes queda **después** de la
   * línea «PESOS : …». Cortar ahí dejaba afuera los importes de los tres
   * primeros renglones, y a esos renglones se les terminaba encontrando un
   * precio de 1 y un importe igual a la cantidad. Así que en vez de cortar por
   * dónde está el número se descartan los valores que ya se sabe que son del
   * pie, que es lo que de verdad los identifica.
   */
  const delPie = numerosDelTexto(soloElPie(textoCompleto));
  const candidatos = numerosDelTexto(`${textoArticulos}\n${textoCompleto}`).filter(
    (c) => !delPie.some((p) => p.eq(c)),
  );

  const items: OcrItem[] = [];
  for (const esqueleto of esqueletos) {
    /*
     * Primero con los números de su propia línea, y sólo si no alcanzan, con
     * los de todo el comprobante. La búsqueda global es la red para las filas
     * que quedaron desarmadas, no el método preferido.
     */
    const propios = numerosDelTexto(esqueleto.linea).filter(
      (c) => !c.eq(esqueleto.cantidad) && !delPie.some((p) => p.eq(c)),
    );
    const numeros =
      numerosDelRenglon(esqueleto.cantidad, propios, netoImpreso) ??
      numerosDelRenglon(esqueleto.cantidad, candidatos, netoImpreso);
    if (!numeros) {
      avisos.push(
        `Renglón ${esqueleto.codigo ?? '(sin código)'} (${esqueleto.descripcion}): no se pudieron ` +
          'leer sus importes. Hay que releer la tabla.',
      );
      continue;
    }

    items.push({
      lineNumber: items.length + 1,
      supplierCode: esqueleto.codigo,
      description: esqueleto.descripcion,
      quantity: esqueleto.cantidad.toString(),
      /*
       * La unidad **no se deduce de este comprobante**, y por eso queda en null.
       *
       * La columna «Cantidad» imprime «3,000» para tres bolsas igual que imprime
       * «4,240» para cuatro kilos y pico de cremoso: no hay nada en el papel que
       * los distinga. Suponer kilos porque la mayoría de los renglones lo son
       * carga tres kilos de bolsas de nailon al costo por kilo de un artículo, y
       * suponer unidades rompe los otros cinco.
       *
       * Quien sabe si un artículo se compra por kilo o por unidad es el catálogo,
       * a través del producto asociado. Mientras el renglón no esté asociado, la
       * unidad queda sin resolver y el comprobante no se puede validar: es una
       * decisión de una persona, no del que lee la foto.
       */
      unit: null,
      pieceCount: null,
      totalWeightKg: null,
      // El costo sale del precio con descuento, que es el que se pagó. El de
      // lista no entra en ninguna cuenta.
      unitNetPrice: numeros.precioConDescuento.toString(),
      grossSubtotal: numeros.importe.toString(),
      /*
       * Cero, y no el descuento que se leyó.
       *
       * En este formato el descuento **ya está aplicado**: P.U.Desc. es P.Unit
       * menos el porcentaje, y el importe impreso es cantidad × P.U.Desc. El
       * campo `discountPct` que consume el costeo significa otra cosa —«restale
       * esto al importe»— así que cargarlo acá descuenta dos veces: los $221.388
       * de mercadería se convertían en $212.500 y el comprobante dejaba de
       * cerrar contra su propio pie.
       *
       * El descuento se lee igual, y sirve: es una de las dos identidades con
       * las que se comprueba que cada número cayó en su columna. Lo que no hace
       * es volver a aplicarse. El pie del papel lo confirma: imprime
       * «DESCUENTOS: 0,00», porque los de renglón ya están adentro de cada
       * importe.
       */
      discountPct: '0',
      discountAmount: null,
      netAmount: null,
      ivaRate: null,
    });
  }

  return { items, avisos };
}

/** ¿Dos descripciones que son la misma, con alguna letra distinta? */
function seParecen(a: string, b: string): boolean {
  const n = (t: string) =>
    t
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  const na = n(a);
  const nb = n(b);
  if (na === '' || nb === '') return false;
  const [corta, larga] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (corta.length < 4) return false;
  return larga.startsWith(corta) || larga.includes(corta);
}

/**
 * Las líneas del pie, que son las que llevan sus rótulos.
 *
 * Sirve para sacar del juego los totales: son importes grandes y creíbles, y si
 * entran entre los candidatos pueden hacerse pasar por el importe de un renglón.
 * Se las identifica por el rótulo y no por dónde están, porque en la página
 * completa el orden de los bloques no es el del papel.
 */
function soloElPie(texto: string): string {
  return texto
    .split('\n')
    .filter((l) => /(sub\s?-?\s?total|descuentos?\s*:|^\s*total\b|i\.?\s?v\.?\s?a\.?\s*\d)/i.test(l))
    .join('\n');
}

// ---------------------------------------------------------------------------
// Encabezado y pie
// ---------------------------------------------------------------------------

function analizarEncabezado(textos: TextosComprobante): OcrHeader {
  const texto = `${textos.encabezado ?? ''}\n${hastaLaTabla(textos.completo)}`;

  const header: OcrHeader = {
    docType: esNotaDeCredito(texto) ? 'NOTA_CREDITO' : 'FACTURA',
    letter: 'A',
    pointOfSale: null,
    number: null,
    fullNumber: null,
    issueDate: null,
    supplierName: 'Distribuidora Ezra',
    legalName: 'Cooperativa de Trabajo Ezra Alimentos',
    cuit: '30-71951960-8',
    currency: 'ARS',
  };

  /*
   * El número, prefiriendo la lectura de ocho dígitos.
   *
   * Sobre la foto real el recorte del encabezado da «00002-00000185» y la página
   * completa da «00002-000001435»: nueve dígitos, uno de más. Un comprobante
   * electrónico argentino numera con ocho, así que la lectura que no los tiene
   * está rota, y quedarse con ella haría que la próxima carga de esta misma
   * factura no se reconociera como duplicada.
   */
  const candidatos = [
    ...texto.matchAll(
      new RegExp(`\\b([${CLASE_DIGITOS_OCR}]{4,5})\\s*-\\s*([${CLASE_DIGITOS_OCR}]{7,10})\\b`, 'g'),
    ),
  ].map((m) => ({ pv: repararDigitos(m[1]), nro: repararDigitos(m[2]) }));
  const elegido = candidatos.find((c) => c.nro.length === 8) ?? candidatos[0];
  if (elegido) {
    header.pointOfSale = elegido.pv.padStart(4, '0').slice(-4);
    header.number = elegido.nro.padStart(8, '0').slice(-8);
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

/**
 * El pie, comprobado contra sí mismo.
 *
 * El OCR escribe «46.491.66» donde el papel dice «46.491,66», así que cada
 * número se lee en todas sus variantes y se acepta la combinación que cumple
 * neto + IVA = total. Son tres lecturas independientes del papel: que las tres
 * cierren entre sí es lo que permite creerles.
 */
export function analizarPie(texto: string, observaciones: string[]): OcrSummary {
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

  /*
   * Los números que hay **después** del rótulo, en cualquier parte de la línea.
   *
   * No se puede anclar el rótulo al principio: en la foto real el pie sale
   * mezclado con lo que tiene al lado —«AD Comprobante Autorizado
   * SUB-TOTAL: + 221.388,84»— y anclando no engancha ninguno de los tres
   * números del pie.
   */
  const trasElRotulo = (patron: RegExp): Decimal[] => {
    const salida: Decimal[] = [];
    for (const cruda of texto.split('\n')) {
      const linea = cruda.trim();
      const m = patron.exec(linea);
      if (!m) continue;
      for (const valor of numerosDelTexto(linea.slice(m.index + m[0].length))) {
        if (!salida.some((x) => x.eq(valor))) salida.push(valor);
      }
    }
    return salida;
  };

  const netos = trasElRotulo(/sub\s?-?\s?total\s*[:.]?/i);
  // «IVA 21,00  46.491,66»: el 21 es la tasa y el rótulo se la lleva.
  const ivas = trasElRotulo(/i\.?\s?v\.?\s?a\.?\s*2\s?1\s*[.,]\s?\d{2}/i);
  // «total», pero no el «TOTAL» de «SUB-TOTAL», que es otro número.
  const totales = trasElRotulo(/(?<![a-z-])total\s*[:.]?/i);

  /*
   * La combinación que cierra.
   *
   * Se prueban todas las lecturas de los tres números y se acepta la única que
   * satisface neto + IVA = total. Un peso de tolerancia por el redondeo.
   */
  let elegida: { neto: Decimal; iva: Decimal; total: Decimal } | null = null;
  for (const neto of netos) {
    for (const iva of ivas) {
      for (const total of totales) {
        if (!casiIgual(neto.plus(iva), total, new Decimal('1'))) continue;
        if (elegida) continue;
        elegida = { neto, iva, total };
      }
    }
  }

  if (elegida) {
    summary.grossSubtotal = elegida.neto.toString();
    summary.netTotal = elegida.neto.toString();
    summary.discountTotal = '0';
    summary.ivaLines = [{ label: 'IVA', rate: '0.21', amount: elegida.iva.toString() }];
    summary.ivaTotal = elegida.iva.toString();
    summary.perceptionsTotal = '0';
    summary.total = elegida.total.toString();
  } else {
    observaciones.push(
      'No se pudo leer el pie del comprobante de forma que el neto más el IVA den el total.',
    );
  }

  return summary;
}
