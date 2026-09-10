import { esNotaDeCredito } from '@/lib/ocr/text-parser';
import { emisorNormalizado, hastaLaTabla } from '@/lib/ocr/zona-emisor';
import { casiIgual, numerosDelTexto } from '@/lib/ocr/numeros';
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
 * Analizador de las facturas de Lácteos Barraza.
 *
 * Formato:
 *
 *   Cod  Cantidad  Unidades  Descripcion                 Pr Unit    Bonifi   Importe
 *   03      27.00      9.00  CIL MUZZA BARRAZA X 3 KG   10,361.45   16.00  234,997.69
 *   30      30.00      3.00  PLAN MUZZA BARRAZA X 10 KG  9,453.76   16.00  238,234.75
 *
 * Tres cosas propias de este formato:
 *
 *  1. **Dos cantidades, y las dos son cantidades.** «Cantidad» son kilos y
 *     «Unidades» son piezas. El costo sale **de los kilos** —neto = kilos ×
 *     precio/kg × (1 − bonificación)— y las piezas se conservan en paralelo
 *     porque son el movimiento físico. Confundirlas cambia el costo por kilo
 *     por un factor de tres o de diez.
 *
 *  2. **Los números vienen en convención norteamericana**: «10,361.45» es diez
 *     mil trescientos sesenta y uno con cuarenta y cinco, al revés que el resto
 *     de los proveedores. Lo resuelve `variantesDeNumero`, que enumera las
 *     lecturas posibles y deja que la aritmética elija.
 *
 *  3. **La descripción dice el tamaño de la pieza**: «X 3 KG», «X 10 KG». Eso
 *     no es decorativo: es una tercera comprobación, independiente de los
 *     precios, de que kilos y piezas cayeron donde corresponde. 27 ÷ 9 = 3 y
 *     30 ÷ 3 = 10.
 *
 * Y una advertencia sobre la que está construido todo lo demás: **en esta
 * factura no se puede confiar en que los números de una línea sean de esa
 * fila**. Sobre la foto real, Tesseract arma la línea del renglón 03 así:
 *
 *     03    27.00    9.00 | CIL MUZZA BARRAZA X 3 KG      9453.76
 *
 * y ese 9.453,76 es el precio del renglón **30**. La columna de precios está
 * desplazada verticalmente respecto de la de descripciones, y el análisis de
 * disposición la reparte sobre la fila de arriba. Un analizador que tome «el
 * último número de la línea» carga el precio del segundo artículo en el
 * primero, que es exactamente lo que se veía en la pantalla.
 *
 * Por eso los números **no se atan a la fila por su posición sino por la
 * aritmética**: para cada fila se busca el precio y el importe que satisfacen
 * su propia igualdad, y después la suma de los renglones tiene que dar el neto
 * impreso. Si no cierra, no se inventa nada: el comprobante queda bloqueado.
 */

/** El CUIT del emisor, sin separadores. */
const CUIT_EMISOR = '30661383034';

export const analizadorBarraza: AnalizadorComprobante = {
  codigo: 'barraza',
  nombre: 'Lácteos Barraza',

  reconoce(textos: TextosComprobante): number {
    const emisor = emisorNormalizado(textos);
    const sinSeparadores = emisor.replace(/[\s.-]/g, '');

    /*
     * Se busca **el CUIT del emisor**, no «un CUIT».
     *
     * Ahí está la protección contra el 27-33342291-9 del receptor: no hace
     * falta excluirlo porque no se lo busca. Toda factura de todo proveedor
     * trae ese número —es el de Don Ginés—, y un reconocedor que aceptara
     * cualquier CUIT de la cabecera se quedaría con todos los comprobantes.
     *
     * Tuve una guarda que lo excluía explícitamente y era código muerto: el
     * CUIT del receptor no puede coincidir con el del emisor, así que quitarla
     * no cambiaba ningún resultado. Queda el comentario en vez de la guarda.
     */
    const porCuit = new RegExp(CUIT_EMISOR).test(sinSeparadores);
    const porNombre = /B[A4]RR[A4][Z2][A4]/.test(emisor);
    if (!porCuit && !porNombre) return 0;

    let puntaje = 0;
    if (porCuit) puntaje += 0.6;
    if (porNombre) puntaje += 0.3;
    if (/L[A4]CTE[O0]S/.test(emisor)) puntaje += 0.15;

    // Y las señales del formato, que viven dentro de la tabla y sólo confirman.
    const todo = `${textos.completo}\n${textos.articulos ?? ''}`.toUpperCase();
    if (/UNIDADES/.test(todo) && /BONIFI/.test(todo)) puntaje += 0.15;
    if (/TOTAL\s+KGS/.test(todo)) puntaje += 0.1;

    return Math.min(1, puntaje);
  },

  analizar(textos: TextosComprobante): AnalisisComprobante {
    const observaciones: string[] = [];
    const header = analizarEncabezado(textos);
    const summary = analizarPie(`${textos.resumen ?? ''}\n${textos.completo}`, observaciones);

    const { items, avisos } = analizarArticulosBarraza(
      `${textos.articulos ?? ''}\n${textos.completo}`,
      parseArNumber(summary.netTotal ?? '') ?? null,
    );
    observaciones.push(...avisos);

    if (items.length === 0) {
      observaciones.push('No se reconoció ningún renglón en la tabla de artículos.');
    }

    // La suma de los renglones contra el neto impreso, que es el control que de
    // verdad cierra el comprobante.
    if (items.length > 0 && summary.netTotal) {
      const neto = parseArNumber(summary.netTotal);
      let suma = new Decimal(0);
      let completos = true;
      for (const item of items) {
        /*
         * Se suma el **neto** de cada renglón, que es lo que el pie totaliza.
         * Cuando no vino impreso se lo reconstruye igual que el dominio:
         * kilos × precio × (1 − bonificación).
         */
        const neto = item.netAmount
          ? parseArNumber(item.netAmount)
          : parseArNumber(item.quantity ?? '')
              ?.times(parseArNumber(item.unitNetPrice ?? '') ?? 0)
              .times(new Decimal(1).minus(parseArNumber(item.discountPct ?? '0') ?? 0))
              .toDecimalPlaces(2) ?? null;
        if (!neto) {
          completos = false;
          break;
        }
        suma = suma.plus(neto);
      }
      if (completos && neto && !casiIgual(suma, neto, new Decimal('0.02'))) {
        observaciones.push(
          `Los ${items.length} importes suman ${suma.toFixed(2)} y el neto impreso es ` +
            `${neto.toFixed(2)}: faltan o sobran renglones.`,
        );
      }
    }

    return { header, items, summary, observaciones };
  },
};

// ---------------------------------------------------------------------------
// Filas
// ---------------------------------------------------------------------------

/**
 * El esqueleto de una fila: código, kilos, piezas y descripción.
 *
 * Es la parte que el OCR lee bien en esta factura, y es la que **no** está
 * contaminada por la fila de al lado: kilos, piezas y descripción salen juntos
 * y en orden. Lo que se pierde a veces es el código, y lo que nunca hay que
 * creerle a esta línea son los números que le queden a la derecha.
 */
export interface EsqueletoBarraza {
  codigo: string | null;
  kilos: Decimal;
  piezas: number;
  descripcion: string;
  /** Kg por pieza que declara la descripción («X 3 KG»), si la declara. */
  kgPorPiezaImpreso: Decimal | null;
}

/**
 * «03   27.00   9.00 | CIL MUZZA BARRAZA X 3 KG»
 *
 * El código puede faltar —en la foto real, el del renglón 30 se pierde— y entre
 * las piezas y la descripción el OCR transcribe el borde de la tabla como «|».
 * La descripción tiene que empezar con una letra: es lo que impide que un
 * número de más se cuele como nombre.
 */
const ESQUELETO = new RegExp(
  `^[^${CLASE_DIGITOS_OCR}A-Za-z]*` +
    `(?:([${CLASE_DIGITOS_OCR}]{1,4})\\s+)?` + // código, opcional
    `([${CLASE_DIGITOS_OCR}]{1,4}[.,][${CLASE_DIGITOS_OCR}]{2})\\s+` + // kilos
    `([${CLASE_DIGITOS_OCR}]{1,4}[.,][${CLASE_DIGITOS_OCR}]{2})\\s*` + // piezas
    `[|!ilI]?\\s*` + // el borde de la tabla, tal como lo transcribe el OCR
    `([A-Za-zÁÉÍÓÚÑ][^|]*?)\\s*$`, // descripción, hasta el final
);

/** Los kilos por pieza que declara la descripción: «X 3 KG» → 3. */
export function kgPorPiezaDeLaDescripcion(descripcion: string): Decimal | null {
  const m = descripcion.match(/\bX\s*(\d{1,3}(?:[.,]\d{1,3})?)\s*(?:KG|KGS|KILOS?)\b/i);
  if (!m) return null;
  const valor = parseArNumber(m[1].replace(',', '.'));
  return valor && valor.gt(0) ? valor : null;
}

/**
 * Los esqueletos que hay en un texto, sin repetir.
 *
 * La misma fila aparece más de una vez: el recorte de la tabla se lee con
 * cortes distintos y la página completa la trae otra vez. Se deduplica por
 * descripción, quedándose con la lectura que traiga código.
 */
export function esqueletosDeFila(texto: string): EsqueletoBarraza[] {
  const salida: EsqueletoBarraza[] = [];

  for (const cruda of texto.split('\n')) {
    const linea = cruda.trim();
    if (linea === '' || esTitulo(linea)) continue;

    /*
     * Lo que haya a la derecha de la descripción se descarta acá mismo.
     *
     * En la foto real la línea del renglón 03 termina en «9453.76», que es el
     * precio del renglón 30. La expresión corta la descripción en el final de
     * línea, así que ese número entra en el texto; se lo saca antes de
     * comparar, y sobre todo **no se lo usa como precio de esta fila**.
     */
    const m = ESQUELETO.exec(linea);
    if (!m) continue;

    const kilos = parseArNumber(repararDigitos(m[2]));
    const piezas = parseArNumber(repararDigitos(m[3]));
    if (!kilos || !piezas || kilos.lte(0) || piezas.lte(0)) continue;

    const descripcion = limpiarDescripcion(m[4]);
    if (descripcion.replace(/[^A-Za-z]/g, '').length < 4) continue;

    const codigoCrudo = m[1] ? repararDigitos(m[1]) : null;
    const candidato: EsqueletoBarraza = {
      codigo: codigoCrudo && /^\d{1,4}$/.test(codigoCrudo) ? codigoCrudo : null,
      kilos,
      piezas: piezas.toNumber(),
      descripcion,
      kgPorPiezaImpreso: kgPorPiezaDeLaDescripcion(descripcion),
    };

    const yaEsta = salida.findIndex((e) => mismaDescripcion(e.descripcion, candidato.descripcion));
    if (yaEsta === -1) {
      salida.push(candidato);
      continue;
    }
    // Se queda la lectura más completa: la que trae código.
    if (!salida[yaEsta].codigo && candidato.codigo) {
      salida[yaEsta] = { ...salida[yaEsta], codigo: candidato.codigo };
    }
  }

  return salida;
}

/**
 * Saca de la descripción lo que no es el nombre del artículo.
 *
 * Requisito explícito: ni los kilos ni las piezas pueden quedar pegados al
 * nombre. En la pantalla se veía «27.00 9.00 | CIL MUZZA BARRAZA X 3 KG», con
 * las dos cantidades y el borde de la tabla adentro del texto.
 *
 * Lo que **sí** se conserva es el «X 3 KG» del final: no es una cantidad de la
 * fila, es parte del nombre comercial del artículo y es lo que distingue el
 * cilindro de tres kilos de la plancha de diez.
 */
function limpiarDescripcion(texto: string): string {
  return texto
    // Lo que quedó a la derecha, que en esta factura es el precio de otra fila.
    .replace(/\s{2,}[\d.,]+\s*$/, '')
    .replace(/^[\s|!]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function mismaDescripcion(a: string, b: string): boolean {
  const na = normalizar(a);
  const nb = normalizar(b);
  if (na.length < 6 || nb.length < 6) return false;
  const [corta, larga] = na.length <= nb.length ? [na, nb] : [nb, na];
  return larga.startsWith(corta);
}

/** Líneas que nunca son un renglón de artículo en este formato. */
function esTitulo(linea: string): boolean {
  return /^(cod\b|c[oó]digo|cantidad|unidades|descripci|pr\.?\s?unit|bonifi|importe|total|sub\s?-?\s?total|iva\b|perc|saldo|nro\.?\s?guia|se[ñn]ores|domicilio|telefono|zona|cond\.?\s?de|dom\s*:|c\.?u\.?i\.?t|iva\s+responsable|comprobante|cae\b|vencimiento|original|arca)/i.test(
    linea.trim(),
  );
}

/**
 * El precio y el importe de una fila, buscados por su aritmética.
 *
 * La igualdad del formato es
 *
 *     kilos × precio/kg × (1 − bonificación) = importe
 *
 * y se resuelve buscando, entre todos los números del comprobante, el par
 * (precio, importe) que la satisface con la bonificación impresa. No se mira en
 * qué línea quedó cada uno, y ésa es la razón de ser de esta función: en esta
 * factura los números de una línea pueden ser de la fila de al lado.
 */
export function numerosDelRenglonBarraza(
  kilos: Decimal,
  candidatos: Decimal[],
  bonificaciones: Decimal[],
  netoImpreso: Decimal | null,
): { precioPorKg: Decimal; bonificacion: Decimal; importe: Decimal; importeImpreso: boolean } | null {
  const cabeEnLaFactura = (v: Decimal) =>
    !netoImpreso || netoImpreso.lte(0) || v.lte(netoImpreso.times(1.02));

  const posibles = candidatos.filter((c) => c.gt(0) && cabeEnLaFactura(c));
  // Un precio por kilo de fiambre o queso no baja de unos pocos cientos de
  // pesos; por debajo de eso el "precio" es en realidad otra columna.
  const precios = posibles.filter((c) => c.gte(100));

  for (const bonificacion of bonificaciones) {
    const factor = new Decimal(1).minus(bonificacion.div(100));
    if (factor.lte(0) || factor.gt(1)) continue;

    for (const precio of precios) {
      const esperado = kilos.times(precio).times(factor);
      if (!cabeEnLaFactura(esperado)) continue;

      /*
       * El importe impreso, si se lo puede encontrar.
       *
       * Se acepta con dos centavos de tolerancia: el papel redondea el importe
       * de cada renglón por separado.
       */
      const impreso = posibles.find((c) => casiIgual(c, esperado, new Decimal('0.02')));
      if (impreso) {
        return { precioPorKg: precio, bonificacion, importe: impreso, importeImpreso: true };
      }
    }
  }

  return null;
}

/**
 * Asigna los precios a las filas cuando ninguna fila puede resolverse sola.
 *
 * Hace falta porque en esta foto **el importe del renglón 03 no se puede
 * leer**: el papel dice 234.997,69 y el OCR devuelve 23490760, con dígitos
 * cambiados. Sin importe impreso no hay con qué comprobar que 10.361,45 es el
 * precio de esa fila y no de la otra, y ahí la posición tampoco sirve, porque
 * es justamente lo que esta factura mezcla.
 *
 * Lo que sí queda es una condición sobre **el conjunto**: la suma de todos los
 * renglones tiene que dar el neto impreso. Con los precios cruzados no da:
 *
 *   27 × 10.361,45 × 0,84  +  30 × 9.453,76 × 0,84 = 473.232,44  ✔ el del papel
 *   27 ×  9.453,76 × 0,84  +  30 × 10.361,45 × 0,84 = 475.519,82  ✘
 *
 * Así que se prueban las asignaciones posibles y se acepta la única que cierra.
 * Esto **no** es ajustar números para que la cuenta dé: los precios son los que
 * están impresos, las cantidades también, y lo que se elige es cuál va con
 * cuál. Si ninguna asignación cierra, no se devuelve ninguna y el comprobante
 * queda bloqueado.
 *
 * El costo es factorial, así que se limita a facturas cortas. Con más filas que
 * eso, una que no se pueda leer sola es una lectura para rehacer, no un
 * rompecabezas para resolver.
 */
const MAXIMO_PARA_ASIGNAR = 4;

export function asignarPreciosPorElNeto(
  kilosPorFila: Decimal[],
  candidatos: Decimal[],
  bonificacion: Decimal,
  netoImpreso: Decimal,
): Decimal[] | null {
  if (kilosPorFila.length === 0 || kilosPorFila.length > MAXIMO_PARA_ASIGNAR) return null;

  const factor = new Decimal(1).minus(bonificacion.div(100));
  if (factor.lte(0) || factor.gt(1)) return null;

  // Sólo precios plausibles, y ninguno puede por sí solo pasarse del neto.
  const precios = candidatos.filter(
    (c) => c.gte(100) && c.lte(netoImpreso) && kilosPorFila.some((k) => k.times(c).times(factor).lte(netoImpreso.times(1.02))),
  );
  if (precios.length === 0) return null;

  let elegida: Decimal[] | null = null;
  let cuantasCierran = 0;

  const buscar = (fila: number, usados: Decimal[], acumulado: Decimal) => {
    if (acumulado.gt(netoImpreso.plus('0.05'))) return;
    if (fila === kilosPorFila.length) {
      if (!casiIgual(acumulado, netoImpreso, new Decimal('0.05'))) return;
      cuantasCierran += 1;
      elegida ??= [...usados];
      return;
    }
    for (const precio of precios) {
      // Dos filas distintas pueden tener el mismo precio, así que no se
      // descarta por valor repetido; lo que no puede es usarse dos veces el
      // mismo número si sólo aparece una vez. Se admite repetir: el papel
      // podría traer dos artículos al mismo precio por kilo.
      buscar(fila + 1, [...usados, precio], acumulado.plus(kilosPorFila[fila].times(precio).times(factor)));
    }
  };
  buscar(0, [], new Decimal(0));

  /*
   * Si cierran dos asignaciones distintas, no hay una respuesta: elegir sería
   * tirar una moneda con el costo de cada artículo.
   */
  if (cuantasCierran !== 1) return null;
  return elegida;
}

/**
 * Reconstruye los renglones de la tabla de Barraza.
 *
 * El esqueleto —código, kilos, piezas, descripción— sale de las líneas; el
 * precio y el importe se buscan por aritmética entre todos los números del
 * comprobante, porque en esta factura la posición no es de fiar.
 */
export function analizarArticulosBarraza(
  texto: string,
  netoImpreso: Decimal | null,
): { items: OcrItem[]; avisos: string[] } {
  const avisos: string[] = [];
  const esqueletos = esqueletosDeFila(texto);

  const delPie = numerosDelTexto(soloElPie(texto));
  const candidatos = numerosDelTexto(texto).filter((c) => !delPie.some((p) => p.eq(c)));

  /*
   * Las bonificaciones que aparecen impresas, más el cero.
   *
   * El cero está porque una factura puede no tener bonificación, y entonces la
   * columna sale vacía y no hay ningún número que buscar.
   */
  const bonificaciones = [
    ...candidatos.filter((c) => c.gte(1) && c.lte(50)),
    new Decimal(0),
  ];

  /*
   * La red para las filas que no se pueden resolver solas.
   *
   * Se calcula una vez, antes del bucle, porque es una decisión sobre el
   * conjunto: qué precio va con qué fila se resuelve mirando si la suma de
   * todas da el neto impreso. Ver `asignarPreciosPorElNeto`.
   */
  const porAsignacion = new Map<
    EsqueletoBarraza,
    { precioPorKg: Decimal; bonificacion: Decimal; importe: Decimal; importeImpreso: boolean }
  >();
  const sinResolver = esqueletos.filter(
    (e) => !numerosDelRenglonBarraza(e.kilos, candidatos, bonificaciones, netoImpreso),
  );
  if (sinResolver.length > 0 && netoImpreso && netoImpreso.gt(0)) {
    for (const bonificacion of bonificaciones) {
      const asignados = asignarPreciosPorElNeto(
        esqueletos.map((e) => e.kilos),
        candidatos,
        bonificacion,
        netoImpreso,
      );
      if (!asignados) continue;
      const factor = new Decimal(1).minus(bonificacion.div(100));
      esqueletos.forEach((e, i) => {
        const importe = e.kilos.times(asignados[i]).times(factor).toDecimalPlaces(2);
        // Si el importe calculado coincide con uno impreso, se prefiere el del
        // papel: es una lectura y no una deducción.
        const impreso = candidatos.find((c) => casiIgual(c, importe, new Decimal('0.02')));
        porAsignacion.set(e, {
          precioPorKg: asignados[i],
          bonificacion,
          importe: impreso ?? importe,
          importeImpreso: Boolean(impreso),
        });
      });
      break;
    }
  }

  const items: OcrItem[] = [];
  for (const esqueleto of esqueletos) {
    /*
     * Antes de los precios, la comprobación que no depende de ellos.
     *
     * La descripción dice el tamaño de la pieza y los kilos divididos por las
     * piezas tienen que darlo: 27 ÷ 9 = 3 para «X 3 KG». Si no coincide, kilos
     * y piezas no cayeron donde se cree, y seguir sería cargar el costo con la
     * cantidad equivocada.
     */
    const kgPorPieza = esqueleto.kilos.div(esqueleto.piezas);
    if (
      esqueleto.kgPorPiezaImpreso &&
      !casiIgual(kgPorPieza, esqueleto.kgPorPiezaImpreso, new Decimal('0.05'))
    ) {
      avisos.push(
        `Renglón ${esqueleto.codigo ?? '(sin código)'} (${esqueleto.descripcion}): ` +
          `${esqueleto.kilos.toFixed(2)} kg entre ${esqueleto.piezas} piezas dan ` +
          `${kgPorPieza.toFixed(2)} kg por pieza, y la descripción dice ` +
          `${esqueleto.kgPorPiezaImpreso.toFixed(2)}. Hay que releer la fila.`,
      );
      continue;
    }

    const numeros =
      numerosDelRenglonBarraza(esqueleto.kilos, candidatos, bonificaciones, netoImpreso) ??
      porAsignacion.get(esqueleto);
    if (!numeros) {
      avisos.push(
        `Renglón ${esqueleto.codigo ?? '(sin código)'} (${esqueleto.descripcion}): no se pudo ` +
          'leer su precio ni su importe. Hay que releer la tabla.',
      );
      continue;
    }
    if (!numeros.importeImpreso) {
      // No es un error: es un renglón que no se pudo contrastar contra el
      // papel. Quien mire el comprobante tiene que saber que ese número no
      // salió impreso, aunque la cuenta cierre.
      avisos.push(
        `Renglón ${esqueleto.codigo ?? '(sin código)'} (${esqueleto.descripcion}): el importe no ` +
          `se pudo leer y se calculó como ${esqueleto.kilos.toFixed(2)} × ` +
          `${numeros.precioPorKg.toFixed(2)} × (1 − ${numeros.bonificacion.toFixed(2)} %) = ` +
          `${numeros.importe.toFixed(2)}. El precio se dedujo de que la suma de los renglones da ` +
          'el neto impreso.',
      );
    }

    if (!esqueleto.codigo) {
      /*
       * Sin código, y no se inventa.
       *
       * En la foto real el código del renglón 30 no está en ninguna parte del
       * texto: el único «30» del comprobante es el del CUIT del emisor.
       * Deducirlo del orden de las filas sería inventarlo, y un código de
       * proveedor equivocado se aprende como alias y desvía todas las compras
       * siguientes de ese artículo.
       *
       * El renglón entra igual —tiene su descripción, sus kilos y su importe— y
       * queda para que una persona lo asocie. Después de esa confirmación, la
       * asociación se recuerda.
       */
      avisos.push(
        `Renglón «${esqueleto.descripcion}»: no se pudo leer su código de proveedor. El renglón ` +
          'entra igual, pero hay que asociarlo a mano la primera vez.',
      );
    }

    items.push({
      lineNumber: items.length + 1,
      supplierCode: esqueleto.codigo,
      description: esqueleto.descripcion,
      // La cantidad que cuesta son los kilos. Nunca las piezas.
      quantity: esqueleto.kilos.toString(),
      unit: 'KG',
      // Y las piezas se conservan en paralelo: son el movimiento físico.
      pieceCount: esqueleto.piezas,
      totalWeightKg: esqueleto.kilos.toString(),
      unitNetPrice: numeros.precioPorKg.toString(),
      /*
       * El bruto no está impreso, y la bonificación sí se aplica.
       *
       * Éste es el punto donde Barraza se separa de Ezra, y modelarlo como
       * aquélla fue un error mío que el comprobante delató enseguida. En Ezra
       * la columna «Importe» ya viene neta de descuento, así que el descuento
       * no se reaplica. Acá la columna «Importe» **también** es neta, pero el
       * bruto —kilos × precio de lista— no está impreso en ninguna parte.
       *
       * Así que se declara lo que el papel de verdad dice: el precio es el de
       * lista, el bruto queda ausente para que el dominio lo calcule como
       * kilos × precio, y la bonificación se declara para que lo baje hasta el
       * neto. Con la bonificación en cero, el renglón del cilindro entraba con
       * 279.759,15 en lugar de 234.997,69: los $44.761,46 del 16 %.
       */
      grossSubtotal: null,
      discountPct: numeros.bonificacion.div(100).toString(),
      discountAmount: null,
      netAmount: numeros.importeImpreso ? numeros.importe.toString() : null,
      ivaRate: null,
    });
  }

  return { items, avisos };
}

/**
 * Las líneas del pie, para sacar sus importes del juego de los renglones.
 *
 * Acá hay dos trampas propias de esta factura:
 *
 *  - **«Saldo Ac. $ 532.848,64»** es el saldo acumulado previo de la cuenta
 *    corriente. No es de este comprobante, y además es **más grande que el
 *    neto**, así que suelto entre los candidatos podría hacerse pasar por el
 *    importe de un renglón y ganar por tamaño;
 *  - **el Subtotal está impreso dos veces** y es un solo valor.
 */
export function soloElPie(texto: string): string {
  return texto
    .split('\n')
    .filter((l) =>
      /(sub\s?-?\s?total|saldo\s+ac|total\s+kgs|^\s*total\b|i\.?\s?v\.?\s?a\.?\s*\d|perc)/i.test(l),
    )
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
    supplierName: 'Barraza',
    legalName: 'Lácteos Barraza S.A.',
    // El del emisor, escrito por el analizador: el que está impreso al lado del
    // nombre del cliente es el de Don Ginés.
    cuit: '30-66138303-4',
    currency: 'ARS',
  };

  // «Nro: 0041-00196670»
  const numero = texto.match(
    new RegExp(
      `(?:nro|n[°º])\\s*[:.]?\\s*([${CLASE_DIGITOS_OCR}]{4})\\s*-\\s*([${CLASE_DIGITOS_OCR}]{7,9})`,
      'i',
    ),
  );
  const suelto =
    numero ??
    texto.match(
      new RegExp(`\\b([${CLASE_DIGITOS_OCR}]{4})\\s*-\\s*([${CLASE_DIGITOS_OCR}]{8})\\b`),
    );
  if (suelto) {
    header.pointOfSale = repararDigitos(suelto[1]).padStart(4, '0').slice(-4);
    header.number = repararDigitos(suelto[2]).padStart(8, '0').slice(-8);
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
 * Se acepta la combinación que cumple neto + IVA + percepción = total. Son
 * cuatro lecturas independientes del papel; que cierren entre sí es lo que
 * permite creerles, y es lo que descarta que el «Saldo Ac.» se haya colado en
 * alguno de los campos.
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

  /*
   * El subtotal está impreso dos veces y es un solo valor.
   *
   * `trasElRotulo` deduplica por valor, así que las dos lecturas del mismo
   * número colapsan en uno. Lo que no puede pasar —y esto es lo que impide— es
   * que se sumen: un neto del doble genera una deuda del doble.
   */
  const netos = trasElRotulo(/sub\s?-?\s?total\s*[:.|]?/i);
  const ivas = trasElRotulo(/i\.?\s?v\.?\s?a\.?\s*2\s?1[.,]\s?\d{2}\s*%?/i);
  const percepciones = trasElRotulo(/perc\w*\s+l?i{1,2}bb[^\d]*\d[.,]\d{2}\s*%?/i);
  const totales = trasElRotulo(/(?<![a-z-])total\s*[:.|]?/i);

  let elegida: { neto: Decimal; iva: Decimal; perc: Decimal; total: Decimal } | null = null;
  for (const neto of netos) {
    for (const iva of ivas) {
      for (const perc of percepciones.length > 0 ? percepciones : [new Decimal(0)]) {
        for (const total of totales) {
          if (!casiIgual(neto.plus(iva).plus(perc), total, new Decimal('1'))) continue;
          if (elegida) continue;
          elegida = { neto, iva, perc, total };
        }
      }
    }
  }

  if (elegida) {
    /*
     * El «Subtotal» impreso es el **neto**, no el bruto.
     *
     * Es la suma de los importes de los renglones, que ya vienen con la
     * bonificación aplicada. El bruto —la suma de kilos × precio de lista— no
     * está impreso en ningún lado, y declararlo igual al neto hacía que el
     * control del subtotal bruto comparara dos cosas distintas y fallara.
     * Ausente es lo correcto: el control se saltea, que es lo que corresponde
     * cuando el comprobante no imprime ese número.
     */
    summary.grossSubtotal = null;
    summary.netTotal = elegida.neto.toString();
    summary.discountTotal = null;
    summary.ivaLines = [{ label: 'IVA', rate: '0.21', amount: elegida.iva.toString() }];
    summary.ivaTotal = elegida.iva.toString();
    summary.perceptionLines = elegida.perc.gt(0)
      ? [{ label: 'Percepción IIBB CABA', rate: '0.015', amount: elegida.perc.toString() }]
      : [];
    summary.perceptionsTotal = elegida.perc.toString();
    summary.total = elegida.total.toString();
  } else {
    observaciones.push(
      'No se pudo leer el pie de forma que el neto más el IVA y la percepción den el total.',
    );
  }

  // «Total Kgs. 57.00», que sirve de control de los kilos de los renglones.
  const kilos = trasElRotulo(/total\s+kgs?\.?\s*[:.]?/i);
  if (kilos.length > 0) summary.netWeightKg = kilos[0].toString();

  return summary;
}
