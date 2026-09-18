import type { Caja, Fragmento } from '@/lib/ocr/reconstruccion/evidencia';
import { bienEscrito } from '@/lib/ocr/motor/formato-de-columna';

/**
 * El pie fiscal leído como lo que es: **un recuadro con casillas**.
 *
 * Hasta acá el pie se leía como una lista de líneas: se agrupaban los
 * fragmentos por altura y la etiqueta de un número era el texto que tenía a su
 * izquierda dentro de una ventana. Funciona en los pies de una columna y falla
 * en todos los demás, que son la mayoría, por una razón geométrica: un
 * comprobante imprime el resumen en un recuadro con encabezados arriba e
 * importes debajo, o en dos columnas de etiquetas e importes que la foto de un
 * teléfono deja desalineadas. Ahí «lo que está a la izquierda» no es la
 * etiqueta de nada.
 *
 * Lo que se midió con el lector de líneas, sobre el lote nuevo: diecisiete
 * campos fiscales confundidos. Una alícuota del 21 % entrando como el IVA, un
 * 1,5 % entrando como la percepción, el total del comprobante asignado a una
 * percepción, y el neto gravado saliendo «122» de un número de página. Ninguno
 * es un error de lectura: los números estaban bien leídos y mal **asociados**.
 *
 * Así que acá se reconstruye la geometría en dos dimensiones:
 *
 *  - se proponen **regiones candidatas** donde puede estar el pie, y compiten
 *    enteras. La lectura por líneas es una de ellas y no se toca;
 *  - dentro de cada región se arma una **grilla**: filas por altura, columnas
 *    por posición horizontal, y cada fragmento físico ocupa **una** casilla;
 *  - la etiqueta de un número se busca en las dos direcciones que los papeles
 *    usan: a su izquierda en la misma fila, y encima en la misma columna. Las
 *    dos asociaciones se conservan como alternativas y decide la evidencia.
 *
 * Lo que este archivo **no** hace es decidir qué concepto es cada número. Eso
 * lo decide la reconciliación, con sus igualdades. Acá se produce la evidencia
 * geométrica que hasta ahora no existía.
 */

/**
 * Las familias de evidencia que pueden sostener una asociación etiqueta–valor.
 *
 * Son independientes a propósito, igual que en la clasificación de renglones:
 * que un número esté justo debajo de la palabra «TOTAL» y que además cumpla la
 * igualdad del total son dos cosas distintas, y una asociación sostenida por
 * las dos vale mucho más que una sostenida dos veces por la misma.
 */
export type FamiliaDeAsociacion =
  /** El texto de la etiqueta nombra un concepto fiscal. */
  | 'etiqueta'
  /** Está pegado y alineado con su etiqueta. */
  | 'geometria'
  /** Comparte columna de la grilla con el encabezado que lo nombra. */
  | 'casilla'
  /** Está escrito como se escribe un importe. */
  | 'formato';

/** Cómo está puesta la etiqueta respecto de su valor. */
export type RelacionEspacial = 'a la izquierda' | 'encima' | 'la fila entera';

export interface CasillaDelPie {
  fragmento: Fragmento;
  fila: number;
  columna: number;
  esNumero: boolean;
}

/**
 * ¿Es este texto una **alícuota impresa** y no un número del pie?
 *
 * El signo de porcentaje lo dice sin ambigüedad: «21 %» no es plata en ninguna
 * factura. Y la distinción hace falta para el alcance de las etiquetas, que se
 * cortan en cada número: «Base Imponible IVA 21 % 1.523.537,99» tiene la
 * alícuota **adentro del rótulo**, y tratarla como un número parte la frase en
 * dos y tira justamente el dato que dice contra qué se calculó el impuesto.
 *
 * Se pide el signo y no la magnitud a propósito. Un número entre cero y cien
 * podría ser un porcentaje o podrían ser noventa pesos; el «%» impreso es un
 * hecho del papel.
 */
export function esAlicuotaEscrita(texto: string): boolean {
  return texto.includes('%');
}

export interface AsociacionDelPie {
  /** El fragmento numérico. Cada uno aparece una sola vez por región. */
  numero: Fragmento;
  /** El texto que lo nombraría, ya armado. */
  etiqueta: string;
  relacion: RelacionEspacial;
  /** Qué sostiene esta asociación, sin repetir familias. */
  apoyos: FamiliaDeAsociacion[];
  /** Cuán lejos está la etiqueta, en fracción de página. Menos es mejor. */
  distancia: number;
  fila: number;
  columna: number;
}

export interface RegionDelPie {
  /** Cómo se propuso esta región, para poder explicarla. */
  origen: string;
  caja: Caja;
  filas: number;
  columnas: number;
  /**
   * Cuál de las columnas es la de los importes.
   *
   * Un recuadro de totales tiene una columna donde está la plata y, a veces,
   * otras con alícuotas, cantidades o códigos. Saber cuál es la de la plata es
   * lo que distingue el «1,50» de una percepción del IIBB —que es el porcentaje—
   * de los «22.853,07» que es lo que se paga. Los dos están en la misma fila y
   * comparten la misma etiqueta; lo único que los separa es en qué columna
   * están impresos.
   *
   * `null` cuando la región no tiene dos importes alineados con que armarla.
   */
  bandaDeImportes: { x0: number; x1: number } | null;
  /** ¿Cae este fragmento dentro de la banda de los importes? */
  esImporte: (fragmento: Fragmento) => boolean;
  casillas: CasillaDelPie[];
  /**
   * Todas las asociaciones posibles, la mejor de cada número primero.
   *
   * Un mismo número puede aparecer con dos etiquetas distintas —una a su
   * izquierda y otra encima— y las dos se conservan: elegir acá sería elegir
   * antes de haber hecho ninguna cuenta.
   */
  asociaciones: AsociacionDelPie[];
}

/**
 * Expresiones que **nunca** nombran un importe fiscal.
 *
 * No es una lista de palabras sospechosas: es una lista de frases que dicen
 * otra cosa, y que el motor confundía porque **contienen** la palabra que
 * buscaba. «PESO NETO» tiene la palabra «neto» y es cuántos kilos pesa la
 * mercadería; «DESCUENTO TOTAL» tiene la palabra «total» y es lo que se
 * descuenta, no lo que se paga; «SALDO ANTERIOR» es de la cuenta corriente y en
 * una de las facturas del banco es más grande que el total del comprobante.
 *
 * Se comparan por **palabras enteras y contiguas**, nunca por subcadena. Ésa es
 * la diferencia que las hace seguras: «no gravado» no puede vetar «gravado», y
 * «neto gravado» no puede ser vetado por «peso neto».
 */
const NUNCA_SON_IMPORTES: string[][] = [
  ['peso', 'neto'],
  ['peso', 'bruto'],
  ['pesos', 'netos'],
  ['descuento', 'total'],
  ['total', 'descuento'],
  ['total', 'descuentos'],
  ['bonificacion', 'total'],
  ['total', 'bonificacion'],
  ['saldo', 'anterior'],
  ['saldo', 'acumulado'],
  ['saldo', 'actual'],
  ['saldo', 'a', 'favor'],
  ['saldo', 'cuenta'],
  ['cuenta', 'corriente'],
  /*
   * Los identificadores del comprobante. Son números grandes, están cerca del
   * pie y no son plata: el CAE tiene catorce cifras y el CUIT once, así que
   * cualquier criterio que prefiera el número más grande los elige.
   */
  ['cae'],
  ['caea'],
  ['cai'],
  ['cuit'],
  ['cuil'],
  ['punto', 'de', 'venta'],
  ['pto', 'venta'],
  ['pto', 'vta'],
  ['comprobante', 'nro'],
  ['remito'],
  ['fecha'],
  ['vencimiento'],
  ['vto'],
  /* Datos de entrega y contacto: sus cifras son direcciones, CP o teléfonos. */
  ['lugar', 'de', 'entrega'],
  ['direccion'],
  ['domicilio'],
  ['telefono'],
  ['codigo', 'postal'],
  ['cp'],
  /*
   * Y los totales que cuentan cosas en vez de plata. Casi toda factura de
   * fiambrería trae un «Total Kgs.» al pie del detalle.
   */
  ['total', 'kgs'],
  ['total', 'kg'],
  ['total', 'kilos'],
  ['total', 'bultos'],
  ['total', 'unidades'],
  ['total', 'items'],
  ['total', 'articulos'],
  ['total', 'cantidad'],
  ['cantidad', 'total'],
];

/**
 * ¿Dice esta etiqueta algo que no es un importe fiscal?
 *
 * Se pregunta sobre la etiqueta entera y se contesta por palabras contiguas.
 * Una sola coincidencia alcanza para descartar: si el papel dice «Peso Neto»,
 * no hay ninguna lectura en la que ese número sea el neto gravado.
 */
export function nombraOtraCosa(etiqueta: string): boolean {
  return dondeTerminaElVeto(etiqueta) !== null;
}

/**
 * En qué palabra termina el veto que está **más cerca del número**, o `null`.
 *
 * Hace falta la posición y no un sí o un no, porque una etiqueta larga puede
 * traer las dos cosas. El texto que el OCR junta a la izquierda de un importe
 * es a veces media línea de la hoja: «C.U.I.T. 30-71596337-6  I.V.A. 21 %». Ahí
 * hay un veto —el CUIT— y un concepto, y vetar la etiqueta entera borraba el
 * IVA de un comprobante que lo tenía impreso.
 *
 * Lo que nombra a un número es lo que tiene **más cerca**, así que se devuelve
 * dónde termina el veto y quien pregunta mira si después de eso todavía hay un
 * concepto. No es una excepción: es la misma regla de siempre —la etiqueta de
 * un número es lo que está pegado a él— aplicada también a lo que lo descarta.
 */
export function dondeTerminaElVeto(etiqueta: string): number | null {
  const palabras = enPalabras(etiqueta);
  let ultimo: number | null = null;
  for (const frase of NUNCA_SON_IMPORTES) {
    for (let i = 0; i + frase.length <= palabras.length; i += 1) {
      if (frase.every((p, j) => palabras[i + j] === p)) {
        const fin = i + frase.length;
        if (ultimo === null || fin > ultimo) ultimo = fin;
      }
    }
  }
  return ultimo;
}

/** Las palabras de una etiqueta desde cierta posición, como texto. */
export function desdeLaPalabra(etiqueta: string, indice: number): string {
  return enPalabras(etiqueta).slice(indice).join(' ');
}

/** Las palabras de un texto, en minúscula y sin lo que no es letra. */
export function enPalabras(texto: string): string[] {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    /*
     * Los puntos de las abreviaturas se sacan **antes** de partir en palabras:
     * «C.U.I.T.» es «cuit» y «I.V.A.» es «iva». Partirlo primero deja cuatro
     * palabras de una letra, y la sigla más común del pie deja de parecerse a
     * sí misma justo cuando hace falta que se parezca.
     */
    .replace(/\.(?=\p{L})/gu, '')
    .replace(/[^a-z]+/g, ' ')
    .split(/\s+/)
    .filter((p) => p.length > 0);
}

/** ¿Aparecen estas palabras seguidas, enteras, dentro de la etiqueta? */
function contieneLaFrase(palabras: string[], frase: string[]): boolean {
  for (let i = 0; i + frase.length <= palabras.length; i += 1) {
    if (frase.every((p, j) => palabras[i + j] === p)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Las regiones candidatas
// ---------------------------------------------------------------------------

export interface OpcionesDeRegion {
  /** La altura típica de un renglón, en fracción de página. */
  alturaTipica: number;
  /** Desde dónde puede haber pie. Lo de arriba es el encabezado. */
  desdeY: number;
  /** Dónde termina el último artículo del detalle, si se sabe. */
  finDelDetalle?: number;
}

/**
 * Las regiones donde puede estar el pie, para que compitan.
 *
 * No se elige una: se proponen todas las que la geometría admite y decide la
 * evidencia, igual que con las reconstrucciones de la tabla. Las tres formas
 * que los papeles usan son la franja debajo del detalle, el recuadro denso de
 * números al final, y —cuando el detalle no se pudo ubicar— la mitad de abajo
 * de la hoja.
 */
export function regionesDelPie(
  fragmentos: Fragmento[],
  opciones: OpcionesDeRegion,
): RegionDelPie[] {
  const limpios = sinRepetidos(fragmentos);
  const centroY = (f: Fragmento) => (f.caja.y0 + f.caja.y1) / 2;

  const propuestas: { origen: string; desde?: number; fragmentos?: Fragmento[] }[] = [
    { origen: 'la franja debajo del encabezado', desde: opciones.desdeY },
  ];
  if (opciones.finDelDetalle !== undefined) {
    propuestas.push({
      origen: 'debajo del último artículo',
      desde: opciones.finDelDetalle - opciones.alturaTipica,
    });
  }

  /*
   * Y el **bloque denso de números del final**, que es como se imprime un
   * recuadro de totales: varias filas seguidas con pocos fragmentos cada una,
   * casi todos numéricos, separadas del detalle por un espacio.
   */
  const bloque = bloqueDeTotales(limpios, opciones);
  if (bloque !== null) propuestas.push({ origen: 'el recuadro de totales', desde: bloque });

  /*
   * Un pie puede estar partido en **islas fiscales**.
   *
   * Hay comprobantes que imprimen una percepción justo debajo del último
   * artículo y el resumen de neto/IVA/total en un recuadro al pie de la hoja.
   * Entre las dos cosas quedan la dirección de entrega, una marca de agua y
   * mucho blanco. Una región que toma todo ese intervalo deja que direcciones,
   * teléfonos y el CAE definan las columnas; una región que toma sólo el bloque
   * final pierde la percepción impresa.
   *
   * Se propone por eso una región **discontinua**, sostenida por la geometría:
   * filas con vocabulario fiscal y alguna cifra, o filas con dos importes
   * posibles en casillas distintas. Se agregan sus filas vecinas inmediatas
   * para conservar los encabezados que van encima de los importes. No se
   * asigna ningún concepto acá; la región completa compite después contra las
   * demás y la reconciliación decide qué significa cada número.
   */
  const islas = fragmentosDeIslasFiscales(limpios, opciones);
  if (islas.length > 0) {
    propuestas.push({ origen: 'las islas fiscales comprobables', fragmentos: islas });
  }

  const vistas = new Set<string>();
  const regiones: RegionDelPie[] = [];
  for (const propuesta of propuestas) {
    const dentro = propuesta.fragmentos ?? limpios.filter((f) => centroY(f) >= propuesta.desde!);
    if (dentro.length === 0) continue;

    // Dos propuestas que agarran los mismos fragmentos son una sola región.
    const firma = dentro
      .map((f) => `${f.texto}@${f.caja.x0.toFixed(3)},${f.caja.y0.toFixed(3)}`)
      .sort()
      .join('|');
    if (vistas.has(firma)) continue;
    vistas.add(firma);

    regiones.push(armarRegion(propuesta.origen, dentro, opciones));
  }
  return regiones;
}

/**
 * Los fragmentos que forman las islas fiscales de un comprobante.
 *
 * La condición deliberadamente admite cifras mutiladas —«59.630.2» o
 * «7218200»—: esta capa propone dónde mirar, no decide cómo se lee el número.
 * Fechas y los identificadores de AFIP quedan afuera por su forma. Si comparten
 * una fila con un total verdadero pueden entrar como contexto, pero los vetos
 * y las igualdades los descartan más adelante.
 */
function fragmentosDeIslasFiscales(
  fragmentos: Fragmento[],
  opciones: OpcionesDeRegion,
): Fragmento[] {
  const desde = opciones.finDelDetalle ?? opciones.desdeY;
  const filas = enFilas(
    fragmentos.filter((f) => (f.caja.y0 + f.caja.y1) / 2 >= desde),
    opciones.alturaTipica,
  );
  if (filas.length === 0) return [];

  const palabrasFiscales = new Set([
    'neto',
    'gravado',
    'subtotal',
    'iva',
    'total',
    'percepcion',
    'percepciones',
    'iibb',
    'exento',
    'imponible',
    'impuesto',
  ]);
  const pareceCifraFiscal = (fragmento: Fragmento) => {
    const texto = fragmento.texto.trim();
    if (!/\d/.test(texto) || texto.includes('%') || /\d\s*[/-]\s*\d/.test(texto)) return false;
    if (/\p{L}/u.test(texto.replace(/\s*(?:kgs?|un|u|lts?|grs?)\.?\s*$/iu, ''))) return false;
    const digitos = texto.replace(/\D/g, '');
    if (digitos.length < 3) return false;
    if (!/[.,:]/.test(texto) && (digitos.length === 11 || digitos.length === 14)) return false;
    return /[.,:]/.test(texto) || digitos.length >= 4;
  };

  const datos = filas.map((fila) => {
    const fisicos = sinSolapados(fila);
    const numeros = fisicos.filter(pareceCifraFiscal);
    const palabras = fisicos.flatMap((f) => enPalabras(f.texto));
    const textoDeLaFila = fisicos.map((f) => f.texto).join(' ');
    const nombraAlgoFiscal =
      palabras.some((p) => palabrasFiscales.has(p)) && !nombraOtraCosa(textoDeLaFila);
    return {
      fila: fisicos,
      y: mediana(fisicos.map((f) => (f.caja.y0 + f.caja.y1) / 2)),
      /*
       * Dos cifras solas también son una dirección y su teléfono. Tres casillas
       * monetarias en una misma línea ya describen un resumen horizontal; con
       * una sola alcanza únicamente cuando la propia fila trae vocabulario
       * fiscal.
       */
      ancla: numeros.length >= 3 || (numeros.length >= 1 && nombraAlgoFiscal),
      nombraAlgoFiscal,
    };
  });

  const indices = new Set<number>();
  datos.forEach((dato, i) => {
    if (!dato.ancla) return;
    indices.add(i);
    /*
     * Un encabezado de casillas suele quedar una línea arriba del valor. Sólo
     * entra una vecina que también trae vocabulario fiscal o cifras posibles;
     * el resto de la hoja no vuelve a colarse por expansión.
     */
    for (const vecino of [i - 1, i + 1]) {
      const otro = datos[vecino];
      if (!otro) continue;
      if (Math.abs(otro.y - dato.y) > Math.max(opciones.alturaTipica * 3, 0.02)) continue;
      if (otro.nombraAlgoFiscal) indices.add(vecino);
    }
  });

  return [...indices]
    .sort((a, b) => a - b)
    .flatMap((i) => datos[i].fila);
}

/**
 * Desde qué altura empieza el bloque denso de totales, o `null` si no hay uno.
 *
 * Se lo busca de abajo hacia arriba: mientras las filas sean cortas —pocas
 * casillas— y traigan números, el bloque sigue. Una fila larga es el detalle, y
 * ahí termina. No hay ningún corte por distancia fija: lo que define el bloque
 * es que sus filas no se parecen a las del detalle.
 */
function bloqueDeTotales(fragmentos: Fragmento[], opciones: OpcionesDeRegion): number | null {
  const filas = enFilas(fragmentos, opciones.alturaTipica);
  if (filas.length < 2) return null;

  const anchoTipico = mediana(filas.map((f) => f.length));
  let desde: number | null = null;
  for (let i = filas.length - 1; i >= 0; i -= 1) {
    const fila = filas[i];
    const corta = fila.length <= Math.max(2, anchoTipico - 1);
    const conNumero = fila.some((f) => /\d/.test(f.texto));
    if (!corta || !conNumero) break;
    desde = Math.min(...fila.map((f) => f.caja.y0));
  }
  return desde;
}

function mediana(valores: number[]): number {
  if (valores.length === 0) return 0;
  const orden = [...valores].sort((a, b) => a - b);
  return orden[Math.floor(orden.length / 2)];
}

/**
 * Quita los fragmentos repetidos entre pasadas.
 *
 * El mismo número lo leen hasta siete pasadas de OCR. Para la evidencia de la
 * tabla eso es apoyo; acá produciría siete casillas en el mismo lugar de la
 * grilla, y una casilla es un lugar del papel. Se conserva una vez cada texto
 * por lugar, con la de mayor confianza.
 */
function sinRepetidos(fragmentos: Fragmento[]): Fragmento[] {
  const porLugar = new Map<string, Fragmento>();
  for (const fragmento of fragmentos) {
    const clave = [
      fragmento.texto.trim(),
      fragmento.caja.x0.toFixed(2),
      fragmento.caja.y0.toFixed(2),
    ].join('|');
    const ya = porLugar.get(clave);
    if (!ya || fragmento.confianza > ya.confianza) porLugar.set(clave, fragmento);
  }
  return [...porLugar.values()];
}

/** Agrupa por altura, que es la primera dimensión de la grilla. */
function enFilas(fragmentos: Fragmento[], alturaTipica: number): Fragmento[][] {
  const tolerancia = Math.max(alturaTipica * 0.6, 0.004);
  const centro = (f: Fragmento) => (f.caja.y0 + f.caja.y1) / 2;
  const ordenados = [...fragmentos].sort((a, b) => centro(a) - centro(b));

  const filas: Fragmento[][] = [];
  let suma = 0;
  for (const fragmento of ordenados) {
    const abierta = filas[filas.length - 1];
    if (abierta && Math.abs(suma / abierta.length - centro(fragmento)) <= tolerancia) {
      abierta.push(fragmento);
      suma += centro(fragmento);
    } else {
      filas.push([fragmento]);
      suma = centro(fragmento);
    }
  }
  return filas.map((fila) => [...fila].sort((a, b) => a.caja.x0 - b.caja.x0));
}

/**
 * Las columnas de la región, por los huecos horizontales.
 *
 * Se proyectan todas las cajas sobre el eje horizontal y se corta donde hay un
 * hueco que ningún fragmento cruza. Es la misma idea que las columnas de la
 * tabla y funciona por la misma razón: un recuadro de totales está impreso en
 * columnas, y el blanco entre ellas es evidencia tan buena como la tinta.
 */
function columnasDe(fragmentos: Fragmento[], alturaTipica: number): number[] {
  const huecoMinimo = Math.max(alturaTipica * 0.8, 0.012);
  const tramos = [...fragmentos]
    .map((f) => ({ x0: f.caja.x0, x1: f.caja.x1 }))
    .sort((a, b) => a.x0 - b.x0);

  const cortes: number[] = [];
  let hasta = -Infinity;
  for (const tramo of tramos) {
    if (hasta > -Infinity && tramo.x0 - hasta > huecoMinimo) {
      cortes.push((hasta + tramo.x0) / 2);
    }
    hasta = Math.max(hasta, tramo.x1);
  }
  return cortes;
}

function columnaDe(fragmento: Fragmento, cortes: number[]): number {
  const centro = (fragmento.caja.x0 + fragmento.caja.x1) / 2;
  let indice = 0;
  for (const corte of cortes) {
    if (centro > corte) indice += 1;
  }
  return indice;
}

// ---------------------------------------------------------------------------
// La grilla y las asociaciones
// ---------------------------------------------------------------------------

function armarRegion(
  origen: string,
  fragmentos: Fragmento[],
  opciones: OpcionesDeRegion,
): RegionDelPie {
  const filas = enFilas(fragmentos, opciones.alturaTipica);
  const cortes = columnasDe(fragmentos, opciones.alturaTipica);

  const casillas: CasillaDelPie[] = [];
  filas.forEach((fila, indice) => {
    for (const fragmento of sinSolapados(fila)) {
      casillas.push({
        fragmento,
        fila: indice,
        columna: columnaDe(fragmento, cortes),
        esNumero: /\d/.test(fragmento.texto) && !esAlicuotaEscrita(fragmento.texto),
      });
    }
  });

  const banda = bandaDeImportes(casillas);
  const dentroDeLaBanda = (c: CasillaDelPie) =>
    banda !== null &&
    c.fragmento.caja.x1 >= banda.x0 &&
    c.fragmento.caja.x0 <= banda.x1;

  const caja = {
    x0: Math.min(...fragmentos.map((f) => f.caja.x0)),
    y0: Math.min(...fragmentos.map((f) => f.caja.y0)),
    x1: Math.max(...fragmentos.map((f) => f.caja.x1)),
    y1: Math.max(...fragmentos.map((f) => f.caja.y1)),
  };

  return {
    origen,
    caja,
    filas: filas.length,
    columnas: cortes.length + 1,
    bandaDeImportes: banda,
    esImporte: (fragmento: Fragmento) =>
      banda !== null && fragmento.caja.x1 >= banda.x0 && fragmento.caja.x0 <= banda.x1,
    casillas,
    asociaciones: asociacionesDe(casillas, opciones),
  };
}

/**
 * Qué etiqueta podría nombrar a cada número, en las dos direcciones.
 *
 * Las dos existen en los papeles y ninguna es más verdadera que la otra:
 *
 *  - **a la izquierda, en la misma fila**: «Neto Gravado    473.232,44». Es el
 *    pie de dos columnas, el más común;
 *  - **encima, en la misma columna**: un recuadro con «NETO / IVA / TOTAL» de
 *    encabezados y los tres importes en la fila de abajo. Acá lo que está a la
 *    izquierda del importe es **otro importe**, y el lector de líneas le ponía
 *    de etiqueta el número de al lado.
 *
 * Se devuelven las dos como alternativas del mismo número, con lo que las
 * sostiene. Elegir acá sería elegir antes de haber hecho ninguna cuenta.
 */
function asociacionesDe(
  casillas: CasillaDelPie[],
  opciones: OpcionesDeRegion,
): AsociacionDelPie[] {
  const salida: AsociacionDelPie[] = [];
  const numeros = casillas.filter((c) => c.esNumero);

  for (const numero of numeros) {
    const suyas: AsociacionDelPie[] = [];

    /*
     * A la izquierda: las palabras de su fila que están antes que él y después
     * del número anterior. Cortar en el número anterior es lo que permite leer
     * una fila con dos conceptos seguidos —«Saldo Ac. 532.848,64 Subtotal
     * 473.232,44»— sin que la etiqueta del segundo se lleve la del primero.
     */
    const suFila = casillas.filter((c) => c.fila === numero.fila);
    const anterior = suFila
      .filter((c) => c.esNumero && c.fragmento.caja.x1 <= numero.fragmento.caja.x0)
      .reduce<number>((x, c) => Math.max(x, c.fragmento.caja.x1), -Infinity);

    const aLaIzquierda = suFila.filter(
      (c) =>
        !c.esNumero &&
        c.fragmento.caja.x1 <= numero.fragmento.caja.x0 + 0.002 &&
        c.fragmento.caja.x0 >= anterior,
    );
    if (aLaIzquierda.length > 0) {
      const pegada = aLaIzquierda[aLaIzquierda.length - 1];
      suyas.push({
        numero: numero.fragmento,
        etiqueta: aLaIzquierda.map((c) => c.fragmento.texto).join(' '),
        relacion: 'a la izquierda',
        apoyos: [],
        distancia: numero.fragmento.caja.x0 - pegada.fragmento.caja.x1,
        fila: numero.fila,
        columna: numero.columna,
      });
    }

    /*
     * Encima: el texto más cercano de su misma columna, en una fila anterior.
     * Se pide que **comparta columna de la grilla**, no que esté vagamente
     * arriba: un valor situado debajo de la palabra «TOTAL» no pertenece a esa
     * etiqueta si la grilla lo ubica en otra casilla, y ésa es justamente la
     * confusión que la lectura por líneas no podía evitar.
     */
    const encima = casillas
      .filter((c) => !c.esNumero && c.columna === numero.columna && c.fila < numero.fila)
      .sort((a, b) => b.fila - a.fila)[0];
    if (encima) {
      const distancia = numero.fragmento.caja.y0 - encima.fragmento.caja.y1;
      const suFilaEntera = casillas
        .filter((c) => c.fila === encima.fila && c.columna === numero.columna && !c.esNumero)
        .map((c) => c.fragmento.texto)
        .join(' ');
      suyas.push({
        numero: numero.fragmento,
        etiqueta: suFilaEntera,
        relacion: 'encima',
        apoyos: [],
        // Una etiqueta a más de tres renglones de altura no encabeza nada.
        distancia: distancia / Math.max(opciones.alturaTipica, 0.001) > 3 ? Infinity : distancia,
        fila: numero.fila,
        columna: numero.columna,
      });
    }

    /*
     * Y la fila entera como último recurso, que es lo que hacía el lector de
     * líneas. Se conserva porque hay pies donde la etiqueta y el importe
     * quedaron en columnas de la grilla distintas por culpa de la inclinación
     * de la foto, y perderla sería cambiar un error por otro.
     */
    const texto = suFila
      .filter((c) => !c.esNumero)
      .map((c) => c.fragmento.texto)
      .join(' ');
    if (texto !== '') {
      suyas.push({
        numero: numero.fragmento,
        etiqueta: texto,
        relacion: 'la fila entera',
        apoyos: [],
        distancia: 1,
        fila: numero.fila,
        columna: numero.columna,
      });
    }

    for (const asociacion of suyas) {
      if (!Number.isFinite(asociacion.distancia)) continue;
      asociacion.apoyos = apoyosDe(asociacion, opciones);
      salida.push(asociacion);
    }
  }

  return salida.sort(
    (a, b) => b.apoyos.length - a.apoyos.length || a.distancia - b.distancia,
  );
}

/** Qué familias independientes sostienen una asociación. */
function apoyosDe(
  asociacion: AsociacionDelPie,
  opciones: OpcionesDeRegion,
): FamiliaDeAsociacion[] {
  const apoyos: FamiliaDeAsociacion[] = [];

  // Que el texto diga algo, y que no diga otra cosa.
  if (enPalabras(asociacion.etiqueta).length > 0 && !nombraOtraCosa(asociacion.etiqueta)) {
    apoyos.push('etiqueta');
  }

  // Que esté cerca: menos de dos renglones de separación.
  if (asociacion.distancia <= Math.max(opciones.alturaTipica * 2, 0.02)) {
    apoyos.push('geometria');
  }

  // Que la etiqueta encabece su columna.
  if (asociacion.relacion === 'encima') apoyos.push('casilla');

  // Que el número esté escrito como se escribe un importe.
  if (pareceImporte(asociacion.numero.texto)) apoyos.push('formato');

  return apoyos;
}

/**
 * ¿Está este número escrito como un importe?
 *
 * Un importe fiscal lleva separador decimal con dos cifras detrás, o es un
 * entero de varias cifras. Lo que **no** es un importe es un porcentaje con su
 * signo, ni un número de una o dos cifras suelto: «21» al lado de la palabra
 * IVA es la alícuota, y sobre el lote entraba como el importe del IVA.
 */
export function pareceImporte(texto: string): boolean {
  if (texto.includes('%')) return false;
  /*
   * Un importe no tiene letras, salvo la unidad al final.
   *
   * «B2B.AR.1002097479» y «50/S108-TOTAL» limpian a algo con forma de número y
   * son un identificador de sistema y un pedazo de leyenda: dejar que las
   * letras se caigan en la limpieza convierte cualquier código en plata. Lo
   * único que se admite pegado es la unidad —«18,38 kg»— porque eso sí es un
   * número con su unidad impresa al lado.
   */
  if (/\p{L}/u.test(texto.replace(/\s*(kgs?|un|u|lts?|grs?)\.?\s*$/iu, ''))) return false;
  const limpio = texto.replace(/[^\d.,]/g, '');
  if (limpio === '') return false;
  if (esIdentificadorDeAfip(limpio)) return false;
  /*
   * Y está **bien escrito**: grupos de hasta tres cifras y una cola decimal
   * corta, que es como se imprime la plata en las dos convenciones.
   *
   * El separador final se saca antes de preguntarlo. «$4.816.812,» es el total
   * de un comprobante al que el OCR le comió los centavos, y exigirle la cola
   * completa lo descartaba entero: perder el total impreso por dos dígitos que
   * el lector no alcanzó es peor que conservarlo con su coma colgando.
   */
  if (!bienEscrito(limpio.replace(/[.,]$/, '')).si) return false;
  if (/[.,]\d{2}$/.test(limpio)) return true;
  return limpio.replace(/[.,]/g, '').length >= 3;
}

/**
 * ¿Es este número un CAE o un CUIT, por su forma?
 *
 * Los dos tienen un largo fijo que define la AFIP: el CAE catorce dígitos y el
 * CUIT once, los dos corridos y sin separador. No es un rango comercial ni una
 * sospecha por tamaño —«un número muy grande no puede ser plata» sería
 * exactamente el criterio que hay que evitar—: es la forma de un identificador,
 * y ningún importe se imprime así.
 *
 * Hace falta además de la etiqueta porque la etiqueta no siempre llega. En una
 * de las fotos del lote el «CAE N°» quedó en otra línea que su número, y el
 * número entró como el total del comprobante.
 */
function esIdentificadorDeAfip(limpio: string): boolean {
  if (/[.,]/.test(limpio)) return false;
  return limpio.length === 14 || limpio.length === 11;
}

/**
 * Dónde está alineada la plata, en x.
 *
 * **No** sale de las columnas de la grilla, y eso costó una medición. Las
 * columnas se detectan proyectando todas las cajas sobre el eje horizontal y
 * cortando donde hay blanco; en un pie eso no funciona, porque a la izquierda
 * del recuadro de totales están la firma del transportista, la leyenda de la
 * imprenta y el conforme de recepción, y entre esa maraña y los importes no
 * queda un solo milímetro de blanco limpio. Todo el pie cae en una columna y la
 * grilla no distingue nada.
 *
 * Lo que sí es estable es que **los importes están alineados entre sí**: un
 * papel los imprime uno debajo del otro, contra el mismo margen. Así que la
 * banda se busca donde se juntan los números con forma de importe, y se ignora
 * el resto de la hoja. Es la misma idea que la columna de una tabla, aplicada a
 * los pocos fragmentos que pueden ser plata.
 *
 * Devuelve `null` cuando no hay con qué: menos de dos importes alineados no es
 * una banda, es un número suelto.
 */
function bandaDeImportes(casillas: CasillaDelPie[]): { x0: number; x1: number } | null {
  const importes = casillas.filter(
    (c) => c.esNumero && pareceImporte(c.fragmento.texto),
  );
  if (importes.length < 2) return null;

  /*
   * Se agrupan por el **borde derecho**, que es por donde los papeles alinean
   * los montos: un importe de seis cifras y uno de tres empiezan en lugares
   * distintos y terminan en el mismo.
   */
  const anchoTipico = mediana(
    importes.map((c) => c.fragmento.caja.x1 - c.fragmento.caja.x0),
  );
  const ordenados = [...importes].sort(
    (a, b) => a.fragmento.caja.x1 - b.fragmento.caja.x1,
  );

  const grupos: (typeof importes)[] = [];
  for (const casilla of ordenados) {
    const abierto = grupos[grupos.length - 1];
    const ultimo = abierto?.[abierto.length - 1];
    if (
      abierto &&
      ultimo &&
      casilla.fragmento.caja.x1 - ultimo.fragmento.caja.x1 <= anchoTipico
    ) {
      abierto.push(casilla);
    } else grupos.push([casilla]);
  }

  /*
   * Una banda es vertical: dos importes de la **misma fila** son dos casillas
   * de un recuadro horizontal, no una columna. Contarlos como apoyo hacía que
   * el neto y la alícuota de un resumen de seis casillas se convirtieran en la
   * supuesta columna monetaria.
   */
  const filasDistintas = (grupo: typeof importes) => new Set(grupo.map((c) => c.fila)).size;
  const mayor = grupos.reduce((a, b) =>
    filasDistintas(b) > filasDistintas(a) ||
    (filasDistintas(b) === filasDistintas(a) && b.length > a.length)
      ? b
      : a,
  );
  if (filasDistintas(mayor) < 2) return null;
  return {
    x0: Math.min(...mayor.map((c) => c.fragmento.caja.x0)),
    x1: Math.max(...mayor.map((c) => c.fragmento.caja.x1)),
  };
}

/**
 * Un lugar del papel, un fragmento.
 *
 * Distintas pasadas del OCR parten el mismo número de maneras distintas:
 * «22.853,07» llega también como «853,07» porque una pasada se comió el
 * principio. Los dos ocupan casi la misma caja, y dejarlos entrar a los dos
 * produce dos percepciones donde el papel imprimió una.
 *
 * Se conserva el que tiene **más dígitos**, que es el que leyó el número
 * entero, y a igualdad el de más confianza. No se elige por valor: eso sería
 * preferir el número más grande, que es exactamente lo que no hay que hacer.
 */
function sinSolapados(fila: Fragmento[]): Fragmento[] {
  const digitos = (f: Fragmento) => f.texto.replace(/\D/g, '').length;
  const ordenados = [...fila].sort(
    (a, b) => digitos(b) - digitos(a) || b.confianza - a.confianza,
  );

  const conservados: Fragmento[] = [];
  for (const fragmento of ordenados) {
    const pisa = conservados.some((otro) => {
      const ancho = Math.min(
        fragmento.caja.x1 - fragmento.caja.x0,
        otro.caja.x1 - otro.caja.x0,
      );
      const comun =
        Math.min(fragmento.caja.x1, otro.caja.x1) - Math.max(fragmento.caja.x0, otro.caja.x0);
      return ancho > 0 && comun > ancho * 0.5;
    });
    if (!pisa) conservados.push(fragmento);
  }
  return conservados.sort((a, b) => a.caja.x0 - b.caja.x0);
}

/**
 * Qué números de una región **no** pueden ser importes, por geometría.
 *
 * Son dos hechos del papel, no una preferencia de ningún lector, y por eso
 * valen para todas las lecturas por igual:
 *
 *  - **está fuera de la columna de los importes**, en una fila que sí tiene
 *    uno. «Perc IIBB CABA  1,50  22.853,07» pone el porcentaje y la plata en la
 *    misma fila y bajo la misma etiqueta; lo único que los distingue es la
 *    columna, y sin el signo de porcentaje impreso —que el OCR se come la mitad
 *    de las veces— el 1,50 entraba como una percepción de un peso cincuenta;
 *
 *  - **es otra lectura del mismo lugar**. Una pasada devuelve «22.853,07» y
 *    otra «853,07» porque se comió el principio; las dos cajas se pisan. Dos
 *    lecturas del mismo lugar del papel son un dato, no dos percepciones.
 */
export function noPuedenSerImportes(region: RegionDelPie): Set<Fragmento> {
  const fuera = new Set<Fragmento>();
  if (region.bandaDeImportes === null) return fuera;

  /*
   * Un número fuera de la banda que **comparte la etiqueta** con el importe de
   * su fila es una alícuota, no un segundo concepto.
   *
   * «Perc IIBB CABA  1,50  22.853,07» tiene los dos números bajo la misma
   * etiqueta y el de la izquierda es el porcentaje. Lo que lo distingue no es
   * que su fila tenga otro número —una fila puede llevar dos conceptos, cada
   * uno con su rótulo, y así imprime su pie más de un proveedor— sino que
   * **entre los dos no hay ninguna palabra**: nadie nombró al de la izquierda
   * aparte. Pedir sólo «la fila ya tiene un importe» borraba el IVA de un
   * comprobante del banco, que va en la misma línea que su subtotal y con su
   * propia etiqueta delante.
   */
  const porFila = new Map<number, CasillaDelPie[]>();
  for (const casilla of region.casillas) {
    porFila.set(casilla.fila, [...(porFila.get(casilla.fila) ?? []), casilla]);
  }

  for (const casilla of region.casillas) {
    if (!casilla.esNumero) continue;
    if (region.esImporte(casilla.fragmento)) continue;

    const hermanos = porFila.get(casilla.fila) ?? [];
    const anterior = hermanos
      .filter((c) => c.esNumero && c.fragmento.caja.x1 <= casilla.fragmento.caja.x0)
      .reduce((x, c) => Math.max(x, c.fragmento.caja.x1), -Infinity);
    const tieneRotuloPropio = hermanos.some(
      (c) =>
        !c.esNumero &&
        /\p{L}/u.test(c.fragmento.texto) &&
        c.fragmento.caja.x1 <= casilla.fragmento.caja.x0 + 0.002 &&
        c.fragmento.caja.x0 >= anterior,
    );
    const importeDeLaFila = hermanos.find(
      (c) => c.esNumero && region.esImporte(c.fragmento) && c.fragmento.caja.x0 >= casilla.fragmento.caja.x1,
    );
    if (importeDeLaFila) {
      /*
       * Un rótulo propio tiene **letras**. El signo de pesos, una barra de la
       * grilla o un signo de porcentaje están entre los dos números y no nombran
       * nada: contarlos como etiqueta devolvía la alícuota a la competencia,
       * porque entre «1,50» y «22.853,07» el papel imprime un «$».
       */
      const rotuloPropio = hermanos.some(
        (c) =>
          !c.esNumero &&
          /\p{L}/u.test(c.fragmento.texto) &&
          c.fragmento.caja.x0 >= casilla.fragmento.caja.x1 &&
          c.fragmento.caja.x1 <= importeDeLaFila.fragmento.caja.x0,
      );
      /*
       * Y además tiene que **poder ser un porcentaje**.
       *
       * Ésta es la única restricción semántica que se aplica, y es universal:
       * una alícuota está entre cero y cien en cualquier factura del mundo. Sin
       * ella la regla se llevaba puesto el neto gravado de un comprobante donde
       * la banda quedó mal ubicada —el pie tenía sus montos a la izquierda y el
       * grupo más numeroso de números con forma de plata estaba en otro lado—,
       * y un neto de treinta y tres mil no es la alícuota de nada.
       */
      const alicuotaPosible = comoPorcentaje(casilla.fragmento.texto);
      if (!rotuloPropio && alicuotaPosible) {
        fuera.add(casilla.fragmento);
        continue;
      }
    }
    /*
     * Fuera de la banda, sólo sobrevive lo que **está escrito como plata**.
     *
     * Un papel imprime sus importes de una manera: con su separador decimal y
     * sus dos cifras detrás, o con varias cifras seguidas. Un «4» suelto en el
     * medio del pie no es un total de cuatro pesos ni un neto de cuatro pesos:
     * es un resto de la grilla, un número de página o el pedazo de una fecha, y
     * entraba como concepto fiscal cada vez que le caía cerca una palabra
     * parecida a una etiqueta.
     *
     * Se pide el formato y no la magnitud a propósito: nada acá dice que un
     * importe chico sea sospechoso. Lo que se pide es que esté escrito como los
     * demás importes del mismo recuadro.
     */
    /*
     * Un número mutilado con rótulo propio sigue siendo candidato.
     *
     * «Neto: 59.630.2» no está bien escrito, pero el papel sí dice qué casilla
     * es y la lectura numérica puede repararse contra el IVA. La banda sirve
     * para interpretar una cifra dañada, no para borrar una casilla que su
     * propio rótulo identifica. Sin rótulo, en cambio, el formato sigue siendo
     * la única defensa contra restos de grilla y números de página.
     */
    if (!pareceImporte(casilla.fragmento.texto) && !tieneRotuloPropio) {
      fuera.add(casilla.fragmento);
    }
  }
  return fuera;
}

/**
 * Los importes que el OCR **partió en dos cajas** a la altura de la coma.
 *
 * Es un accidente frecuente y reconocible: el reconocedor devuelve
 * «1.523.537» en una caja y «99» en la de al lado, pegadas, en la misma fila y
 * de la misma pasada. No son dos números: es uno solo al que se le perdió el
 * separador decimal, y tratarlos por separado cuesta dos veces. El importe
 * queda sin centavos —con lo cual ninguna igualdad fiscal cierra— y los dos
 * dígitos sueltos entran al pie como un concepto de noventa y nueve pesos.
 *
 * Las condiciones son las del accidente, no las de ningún comprobante: la misma
 * pasada —cajas de dos lecturas distintas no se pegan—, la misma fila, sin
 * blanco entre las dos, la izquierda escrita como un importe **sin decimales** y
 * la derecha exactamente dos dígitos.
 *
 * Devuelve la pieza derecha indexada por la izquierda —quien lo use decide qué
 * hacer: acá no se afirma que el número sea el pegado, se ofrece esa lectura— y
 * además **todas las lecturas de ese lugar**: los mismos dos dígitos los
 * devuelven también las otras pasadas, y si sólo se descartara la pieza de la
 * pasada que los partió, las demás seguirían entrando al pie como un concepto
 * fiscal de noventa y nueve pesos.
 */
export function centavosPartidos(
  fragmentos: Fragmento[],
  alturaTipica: number,
): { pegados: Map<Fragmento, Fragmento>; piezas: Set<Fragmento> } {
  const salida = new Map<Fragmento, Fragmento>();

  const porPasada = new Map<string, Fragmento[]>();
  for (const fragmento of fragmentos) {
    porPasada.set(fragmento.pasada, [...(porPasada.get(fragmento.pasada) ?? []), fragmento]);
  }

  for (const suyos of porPasada.values()) {
    for (const fila of enFilas(suyos, alturaTipica)) {
      const enOrden = [...fila].sort((a, b) => a.caja.x0 - b.caja.x0);
      for (let i = 0; i + 1 < enOrden.length; i += 1) {
        const izquierda = enOrden[i];
        const derecha = enOrden[i + 1];
        if (!/^\d{2}$/.test(derecha.texto.trim())) continue;
        // Miles impresos y ningún decimal: «1.523.537», «12345678».
        if (!/^\$?\d{1,3}(?:[.,]\d{3})+$|^\$?\d{4,}$/.test(izquierda.texto.trim())) continue;
        const hueco = derecha.caja.x0 - izquierda.caja.x1;
        if (hueco < -0.003 || hueco > alturaTipica * 0.8) continue;
        salida.set(izquierda, derecha);
      }
    }
  }

  /*
   * Y el mismo lugar leído por otra pasada es el mismo lugar. Se piden las dos
   * cosas —dos dígitos y ocupar la caja de una pieza conocida— para no llevarse
   * puesto el importe entero que alguna pasada sí leyó completo.
   */
  const piezas = new Set<Fragmento>(salida.values());
  for (const fragmento of fragmentos) {
    if (piezas.has(fragmento)) continue;
    if (!/^\d{2}$/.test(fragmento.texto.trim())) continue;
    const suyo = fragmento.caja.x1 - fragmento.caja.x0;
    for (const pieza of salida.values()) {
      const comun =
        Math.min(fragmento.caja.x1, pieza.caja.x1) - Math.max(fragmento.caja.x0, pieza.caja.x0);
      const alto =
        Math.min(fragmento.caja.y1, pieza.caja.y1) - Math.max(fragmento.caja.y0, pieza.caja.y0);
      if (suyo > 0 && alto > 0 && comun > suyo * 0.5) {
        piezas.add(fragmento);
        break;
      }
    }
  }

  return { pegados: salida, piezas };
}

/**
 * Las lecturas que pisan a otra del mismo lugar y perdieron.
 *
 * Se conserva la que tiene más dígitos —la que leyó el número entero— y a
 * igualdad la de más confianza. No se elige por valor: eso sería preferir el
 * número más grande, que es justamente lo que no hay que hacer.
 */
export function lecturasPisadas(
  fragmentos: Fragmento[],
  alturaTipica: number,
): Set<Fragmento> {
  const perdidas = new Set<Fragmento>();
  for (const fila of enFilas(sinRepetidos(fragmentos), alturaTipica)) {
    const numeros = fila.filter((f) => /\d/.test(f.texto));
    const conservados = sinSolapados(numeros);
    for (const fragmento of numeros) {
      if (!conservados.includes(fragmento)) perdidas.add(fragmento);
    }
  }
  return perdidas;
}

/**
 * ¿Podría este número ser un porcentaje, por su valor?
 *
 * Entre cero y cien, que es lo que existe. No dice nada sobre rangos
 * comerciales: dice que un número de cinco cifras no es una alícuota.
 */
function comoPorcentaje(texto: string): boolean {
  const limpio = texto.replace(/[^\d.,]/g, '');
  if (limpio === '') return false;
  const entero = limpio.split(/[.,]/)[0].replace(/\D/g, '');
  return entero.length > 0 && entero.length <= 3 && Number(entero) <= 100;
}

/**
 * Los textos de los importes de una región, para poder sacarles la escala.
 *
 * Es la misma pregunta que se le hace a una columna de la tabla: cómo escribe
 * los números este pedazo de papel. La respuesta descarta el CAE, que son
 * catorce cifras seguidas donde todos los importes llevan su coma y sus dos
 * decimales. No lo descarta por grande: lo descarta por estar escrito de una
 * manera que ningún importe de este comprobante usa.
 */
export function textosDeLaBanda(region: RegionDelPie): string[] {
  return region.casillas
    .filter((c) => c.esNumero && region.esImporte(c.fragmento))
    .map((c) => c.fragmento.texto);
}
