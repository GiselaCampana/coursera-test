import { Decimal } from '@/lib/money';
import { variantesDeNumero } from '@/lib/ocr/numeros';
import {
  CAMPOS_SIN_CONFIRMAR,
  PALABRAS_DE_CAMPO,
  normalizarEncabezado,
  reconocerColumna,
  type CampoDeColumna,
  type ColumnaReconocida,
  type OrigenDeAsignacion,
} from '@/lib/ocr/motor/columnas';

/**
 * Qué significa cada columna cuando el encabezado no alcanza.
 *
 * El reconocimiento por encabezado resuelve el caso fácil y se rompe en cuanto
 * la foto no es perfecta, que sobre un teléfono es casi siempre. Hay tres
 * situaciones distintas y hasta acá las tres terminaban igual —en nada—:
 *
 *  1. **el encabezado está y se lee**: «Importe» dice importe y no hay más que
 *     hablar;
 *  2. **el encabezado está degradado pero es reconocible**: Errecalde imprime
 *     SUBTOTAL y el OCR lee «UBTOTA». Ninguna expresión regular lo acepta, y sin
 *     embargo la columna está llena de montos, es la última, y su suma da el
 *     neto del pie;
 *  3. **el encabezado no está o es ilegible**: en Lácteos Barraza la palabra
 *     «Descripción» sale como manchas. La columna de texto existe igual, con dos
 *     descripciones de artículo perfectamente leídas debajo.
 *
 * El error de diseño que esto corrige es haber tratado el caso 3 como si la
 * columna no existiera. No existía **el nombre**; los datos estaban. Y la
 * diferencia para quien carga la factura es enorme: entre confirmar que una
 * columna es la descripción —un segundo— y reescribir la factura entera.
 *
 * ## Cómo se decide
 *
 * Por acumulación de evidencias de **familias distintas**, y ninguna familia
 * alcanza sola. Esa es la regla que sostiene todo lo demás: un encabezado que
 * dice «Importe» sobre una columna de texto no es un importe, y una columna de
 * montos a la derecha no es un importe sólo por estar a la derecha. Hace falta
 * que varias cosas independientes digan lo mismo.
 *
 * Las familias son las ocho de abajo: el encabezado, su parecido con un
 * sinónimo conocido, la posición relativa, la forma de lo que hay debajo,
 * cuántos valores válidos tiene, la relación con las columnas vecinas, las
 * igualdades aritméticas que hace cerrar, y la coherencia con el pie del
 * comprobante.
 *
 * ## Qué no hace
 *
 * No convierte nada en verdad permanente. Una columna inferida se usa para
 * reconstruir los renglones —que es lo que nadie puede rehacer a mano— y queda
 * marcada con `requiereConfirmacion`. El día que exista el perfil confirmado por
 * la administradora, ese perfil entra como una evidencia más, con origen
 * `USER_PROFILE`, y es el único que apaga la pregunta.
 */

export type FamiliaDeEvidencia =
  /** El texto del encabezado, o un pedazo suyo. */
  | 'encabezado'
  /** Parecido acotado con un sinónimo conocido. */
  | 'similitud'
  /** Dónde está la columna respecto de las demás. */
  | 'posicion'
  /** Qué forma tiene lo que hay debajo. */
  | 'contenido'
  /** Cuántos renglones tienen un valor válido acá. */
  | 'cobertura'
  /** Qué son las columnas de al lado. */
  | 'vecindad'
  /** Qué igualdades del renglón hace cerrar. */
  | 'aritmetica'
  /** Si encaja con el pie del comprobante entero. */
  | 'coherencia';

export interface Evidencia {
  familia: FamiliaDeEvidencia;
  campo: CampoDeColumna;
  /** Cuánto argumenta a favor de ese campo, de 0 a 1. */
  peso: number;
  detalle: string;
}

/**
 * Lo que hay debajo de una columna, que es la materia prima de casi toda la
 * inferencia.
 */
export interface ContenidoDeColumna {
  /** El encabezado leído, o null si no hay ninguno utilizable. */
  titulo: string | null;
  /** El texto de cada celda, en orden de renglón. Las vacías van como ''. */
  celdas: string[];
  /** Dónde empieza y termina, en fracción del ancho de página. */
  desde: number;
  hasta: number;
}

export interface AsignacionDeColumna {
  campo: CampoDeColumna | null;
  origen: OrigenDeAsignacion;
  confianza: number;
  /** Ventaja sobre el segundo campo posible. */
  margen: number;
  evidencias: Evidencia[];
  /** Los otros campos que la evidencia también sostenía. */
  alternativas: { campo: CampoDeColumna; puntaje: number }[];
  requiereConfirmacion: boolean;
}

/**
 * Cuánto tiene que sumar la evidencia para aceptar un campo sin preguntar, y
 * cuánta ventaja tiene que sacarle al segundo.
 *
 * Los dos hacen falta y hacen cosas distintas, igual que en la decisión del
 * comprobante entero: el umbral evita aceptar una columna sobre la que casi no
 * hay evidencia; el margen evita aceptar una sobre la que hay **dos respuestas
 * igual de sostenidas**, que es el caso de «Desc» en Mabelherdi —descripción o
 * descuento, y las dos existen—.
 */
export const UMBRAL_DE_COLUMNA = 0.7;
export const MARGEN_DE_COLUMNA = 0.15;

/**
 * Cuántas familias distintas tienen que coincidir para aceptar sin preguntar.
 *
 * Dos. Es la regla que el resto del módulo existe para hacer cumplir: **ninguna
 * señal sola alcanza**. Un encabezado que dice «Importe» sobre una columna de
 * texto no es un importe; una columna de montos en el borde derecho no es un
 * importe nada más que por estar ahí. Con una sola familia no se acepta ni
 * aunque el peso sea uno.
 */
const FAMILIAS_MINIMAS = 2;

// ---------------------------------------------------------------------------
// La forma de lo que hay en una celda
// ---------------------------------------------------------------------------

/**
 * Las formas que una celda puede tener a la vez.
 *
 * No son excluyentes a propósito: «16,10» es un número y puede ser un
 * porcentaje, y decidir cuál antes de mirar la columna entera es adivinar. Lo
 * que se hace es contar, para cada forma, en qué fracción de la columna aparece.
 */
export interface FormasDeCelda {
  monto: boolean;
  porcentaje: boolean;
  numero: boolean;
  entero: boolean;
  codigo: boolean;
  texto: boolean;
}

const SIN_FORMA: FormasDeCelda = {
  monto: false,
  porcentaje: false,
  numero: false,
  entero: false,
  codigo: false,
  texto: false,
};

/** Los valores que un texto puede representar, leído con las dos convenciones. */
function valoresPosibles(texto: string): Decimal[] {
  const limpio = texto.replace(/[^\d.,]/g, '');
  if (limpio === '' || !/\d/.test(limpio)) return [];
  const alReves = limpio.replace(/,/g, '\u0001').replace(/\./g, ',').replace(/\u0001/g, '.');
  const todos = [...variantesDeNumero(limpio), ...variantesDeNumero(alReves)];
  return todos.filter((v) => v.isFinite());
}

export function formasDe(texto: string): FormasDeCelda {
  const limpio = texto.trim();
  if (limpio === '') return SIN_FORMA;

  const letras = (limpio.match(/\p{L}/gu) ?? []).length;
  const digitos = (limpio.match(/\d/g) ?? []).length;

  if (digitos === 0) {
    return { ...SIN_FORMA, texto: letras >= 3 };
  }

  /*
   * Con letras y dígitos mezclados hay que decidir si es un código o un texto.
   *
   * Un código es corto, sin espacios y con más dígitos que letras: «03»,
   * «1001», «A-27». Una descripción con un número adentro —«CIL MUZZA X 3 KG»,
   * «956X30X1»— tiene espacios o muchas más letras que dígitos.
   */
  if (letras > 0) {
    /*
     * Un número con la unidad pegada sigue siendo un número.
     *
     * «785kg», «18.38 kg», «21%» son cantidades y porcentajes, no códigos ni
     * descripciones. Sin esta salida, la columna CANTIDAD de Errecalde —donde el
     * papel imprime los kilos con la unidad— se clasificaba como columna de
     * códigos, y con eso perdía la única evidencia de contenido que la sostenía.
     *
     * Se pide que la unidad sea **corta y esté al final**: tres letras a lo
     * sumo. «956X30X1» y «CIL MUZZA X 3 KG» no entran, que es lo que hay que
     * evitar.
     */
    const conUnidad = limpio.match(/^([\d.,]+)\s*\p{L}{1,3}\.?$/u);
    if (conUnidad) return { ...formasDe(conUnidad[1]), texto: false };

    /*
     * Un número con basura detrás **sigue siendo un número**, y además texto.
     *
     * La columna de al lado invade el territorio de ésta todo el tiempo: sobre
     * la foto de Barraza el precio sale «10,361.45 bas AA», con dos manchas del
     * papel pegadas. Es una de las dos únicas celdas de esa columna, así que
     * clasificarla como texto a secas dejaba la columna mitad monto y mitad
     * texto: ni una cosa ni la otra, sin marcador, y los dos precios se perdían.
     *
     * Las dos formas a la vez es lo honesto, y es lo mismo que ya hace el motor
     * cuando parte «4,240 Cremoso» en cantidad y descripción: la celda admite las
     * dos lecturas y decide el conjunto de la columna.
     */
    const conBasura = limpio.match(/^([\d.,]+)\s+\S/);
    if (conBasura) return { ...formasDe(conBasura[1]), texto: letras >= 3 };

    const compacto = !/\s/.test(limpio) && limpio.length <= 12;
    return {
      ...SIN_FORMA,
      texto: letras >= 3,
      codigo: compacto && letras <= digitos,
    };
  }

  const valores = valoresPosibles(limpio);
  if (valores.length === 0) return SIN_FORMA;

  const separadores = (limpio.match(/[.,]/g) ?? []).length;
  const conSeparadorDeMiles = /^\d{1,3}([.,]\d{3})+([.,]\d{1,2})?$/.test(limpio);
  const conCentavos = /[.,]\d{2}$/.test(limpio);
  const maximo = valores.reduce((a, b) => (b.gt(a) ? b : a));
  const minimo = valores.reduce((a, b) => (b.lt(a) ? b : a));

  return {
    monto: conSeparadorDeMiles || (conCentavos && maximo.gte(100)),
    /*
     * Un porcentaje es un número chico bajo **alguna** de las dos convenciones.
     *
     * Mirar una sola es lo que rompía la factura de Ezra: su columna de
     * descuento imprime «5,000», que con la coma decimal es 5 y con la coma de
     * miles es cinco mil. Descartarla por parecer un monto dejaba la columna
     * «Desc.%» sin evidencia de contenido, y con el encabezado como única señal
     * no llegaba a las dos familias que hacen falta. Un comprobante que se leía
     * entero y cerraba exacto terminaba pidiendo una confirmación inventada.
     *
     * Con más de un separador ya no hay ambigüedad —«10.361,45» es un monto y
     * nada más— así que ahí sí se descarta. El 0 entra: «0,00» de bonificación
     * es un porcentaje válido y aparece en casi todas las facturas.
     */
    porcentaje: separadores <= 1 && minimo.gte(0) && minimo.lte(100),
    numero: true,
    entero: valores.some((v) => v.isInteger() && v.abs().lt(10000)),
    codigo: /^\d{1,8}$/.test(limpio),
    texto: false,
  };
}

/** En qué fracción de las celdas con algo escrito aparece cada forma. */
export interface PerfilDeContenido {
  conValor: number;
  total: number;
  cobertura: number;
  fracciones: Record<keyof FormasDeCelda, number>;
}

export function perfilDeContenido(celdas: string[]): PerfilDeContenido {
  const formas = celdas.map(formasDe);
  const conValor = celdas.filter((c) => c.trim() !== '').length;
  const cuenta: Record<keyof FormasDeCelda, number> = {
    monto: 0,
    porcentaje: 0,
    numero: 0,
    entero: 0,
    codigo: 0,
    texto: 0,
  };
  for (const forma of formas) {
    for (const clave of Object.keys(cuenta) as (keyof FormasDeCelda)[]) {
      if (forma[clave]) cuenta[clave] += 1;
    }
  }
  const fracciones = { ...cuenta };
  for (const clave of Object.keys(fracciones) as (keyof FormasDeCelda)[]) {
    fracciones[clave] = conValor > 0 ? cuenta[clave] / conValor : 0;
  }
  return {
    conValor,
    total: celdas.length,
    cobertura: celdas.length > 0 ? conValor / celdas.length : 0,
    fracciones,
  };
}

/**
 * Qué forma tiene que tener lo que hay debajo de cada campo.
 *
 * El peso es más alto cuanto más discrimina la forma. Que una columna sean
 * montos dice mucho —descarta las descripciones, las cantidades y los
 * porcentajes de un saque— y que sean números dice poco, porque casi todo lo es.
 */
const FORMA_ESPERADA: [CampoDeColumna, keyof FormasDeCelda, number][] = [
  ['codigo', 'codigo', 0.45],
  ['descripcion', 'texto', 0.45],
  ['marca', 'texto', 0.3],
  ['cantidad', 'numero', 0.3],
  ['kilos', 'numero', 0.3],
  ['piezas', 'entero', 0.35],
  ['precioUnitario', 'monto', 0.4],
  ['precioConDescuento', 'monto', 0.4],
  ['importe', 'monto', 0.4],
  ['descuentoPct', 'porcentaje', 0.35],
  ['ivaPct', 'porcentaje', 0.35],
];

/**
 * La fracción de celdas que tiene que tener una forma para afirmar algo con ella.
 *
 * Se usa donde la forma sostiene una **afirmación estructural** —que una columna
 * es de montos, que la de al lado es un porcentaje, que las tres multiplican
 * entre sí—. Ahí conviene ser exigente: una afirmación así apoyada en la mitad
 * de la columna es una corazonada.
 */
const PREDOMINIO = 0.6;

/**
 * Y la fracción a partir de la cual la forma **aporta** algo, sin afirmar nada.
 *
 * Es más baja, y tiene que serlo. La fracción se mide sobre las celdas con algo
 * escrito, y sobre una foto de teléfono esas celdas incluyen todo lo que el OCR
 * inventó: una columna de kilos perfectamente impresa baja a 0,44 porque la
 * mitad de las líneas que el detector vio no son artículos.
 *
 * Exigir el predominio también acá era pedirle a la evidencia de contenido que
 * decidiera sola, que es justo lo contrario de lo que este módulo hace: acá cada
 * familia **aporta**, y el peso es proporcional a la fracción, así que una
 * columna sucia suma poco y una limpia suma todo. Lo que no puede es no sumar
 * nada y dejar al encabezado como única señal.
 */
const PISO_DE_FORMA = 0.35;

// ---------------------------------------------------------------------------
// Parecido entre un encabezado degradado y un sinónimo conocido
// ---------------------------------------------------------------------------

function distanciaDeEdicion(a: string, b: string): number {
  const fila = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = fila[0];
    fila[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const anterior = fila[j];
      fila[j] = Math.min(
        fila[j] + 1,
        fila[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = anterior;
    }
  }
  return fila[b.length];
}

/** El pedazo común más largo entre dos palabras, en caracteres. */
function pedazoComun(a: string, b: string): number {
  let mejor = 0;
  const largos = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const anterior = largos[j];
      largos[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : 0;
      if (largos[j] > mejor) mejor = largos[j];
      diagonal = anterior;
    }
  }
  return mejor;
}

/**
 * Cuánto se parece un encabezado leído a uno bien escrito, de 0 a 1.
 *
 * Se mira por los dos lados porque el OCR degrada de dos maneras distintas y
 * una sola medida no las cubre:
 *
 *  - **cambia letras**: «lmporte» por «Importe», «Cantldad» por «Cantidad». Eso
 *    lo mide la distancia de edición;
 *  - **come los bordes**: «UBTOTA» por «SUBTOTAL», «escripcio» por
 *    «Descripción». Ahí la distancia de edición castiga fuerte —dos de ocho
 *    caracteres— y lo que corresponde mirar es el pedazo que sí coincide.
 *
 * El parecido es el mejor de los dos, con un piso de largo: con menos de cuatro
 * caracteres cualquier cosa se parece a cualquier cosa. «Cod» no entra por acá
 * y no hace falta, porque el reconocimiento exacto ya lo tiene.
 */
export function parecido(leido: string, canonico: string): number {
  const a = leido.replace(/[^a-z0-9]/g, '');
  const b = canonico.replace(/[^a-z0-9]/g, '');
  if (a.length < 4 || b.length < 4) return 0;

  const porEdicion = 1 - distanciaDeEdicion(a, b) / Math.max(a.length, b.length);
  /*
   * El pedazo común se mide contra **la más larga** de las dos palabras, que es
   * lo que distingue una palabra comida de una palabra distinta que empieza o
   * termina igual:
   *
   *   «ubtota» dentro de «subtotal»  → seis de ocho, es la misma palabra;
   *   «desc»   dentro de «descuento» → cuatro de nueve, no lo es;
   *   «desc»   dentro de «pudesc»    → cuatro de seis, tampoco.
   *
   * Los dos últimos importan y son el mismo caso real: en Mabelherdi la columna
   * «Desc» puede ser descripción, descuento o el precio con descuento, y las
   * tres existen en el banco de facturas. Es la columna ambigua que una persona
   * resuelve una vez, y cualquier medida que la haga parecerse a una sola de
   * ellas la resuelve mal en silencio.
   *
   * El piso de cuatro caracteres queda igual: con menos, cualquier cosa se
   * parece a cualquier cosa.
   */
  const comun = pedazoComun(a, b);
  const porPedazo = comun >= 4 ? comun / Math.max(a.length, b.length) : 0;

  return Math.max(porEdicion, porPedazo);
}

/** Debajo de esto, dos palabras no se parecen: son distintas. */
const PARECIDO_MINIMO = 0.7;

/** Los campos a los que se parece un encabezado degradado, con cuánto. */
export function camposParecidos(titulo: string): { campo: CampoDeColumna; parecido: number }[] {
  const normalizado = normalizarEncabezado(titulo).replace(/\s+/g, '');
  if (normalizado.length < 4) return [];

  const salida: { campo: CampoDeColumna; parecido: number }[] = [];
  for (const [campo, palabras] of PALABRAS_DE_CAMPO) {
    let mejor = 0;
    for (const palabra of palabras) mejor = Math.max(mejor, parecido(normalizado, palabra));
    if (mejor >= PARECIDO_MINIMO) salida.push({ campo, parecido: mejor });
  }
  return salida.sort((a, b) => b.parecido - a.parecido);
}

// ---------------------------------------------------------------------------
// Las igualdades que la tabla hace cerrar
// ---------------------------------------------------------------------------

/**
 * Los valores que una celda puede tener bajo una convención.
 *
 * Se devuelven **todos**, no el primero. El OCR deja números que no se pueden
 * leer al pie de la letra —«234.99769» no es un número en ninguna convención— y
 * quedarse con la lectura literal descartaba justamente la que hace cerrar la
 * cuenta. Sobre la foto de Lácteos Barraza eso dejaba sin detectar que
 * 27 × 10.361,45 × 0,84 da el importe impreso, que es la evidencia más fuerte
 * que hay de qué significa cada una de esas tres columnas.
 *
 * Se acotan a cuatro por celda: más que eso no es ambigüedad, es una celda
 * ilegible, y multiplicarlas entre columnas sale caro.
 */
function valoresEn(texto: string, invertida: boolean): Decimal[] {
  const limpio = texto.replace(/[^\d.,]/g, '');
  if (limpio === '' || !/\d/.test(limpio)) return [];
  const usado = invertida
    ? limpio.replace(/,/g, '\u0001').replace(/\./g, ',').replace(/\u0001/g, '.')
    : limpio;
  return variantesDeNumero(usado).slice(0, 4);
}

function casiIgual(a: Decimal, b: Decimal): boolean {
  return a.minus(b).abs().lte(Decimal.max(b.abs().times('0.002'), '0.02'));
}

export interface RelacionAritmetica {
  /** La columna que hace de cantidad. */
  cantidad: number;
  /** La columna que hace de precio. */
  precio: number;
  /** La columna que hace de importe. */
  importe: number;
  /** La columna de porcentaje que interviene, si hace falta alguna. */
  descuento: number | null;
  /** En cuántos renglones cierra, sobre cuántos se pudo probar. */
  cierran: number;
  probados: number;
}

/**
 * Qué tripletas de columnas cumplen `cantidad × precio ≈ importe`.
 *
 * Es la evidencia más fuerte que hay para inferir una columna sin encabezado, y
 * es fuerte por una razón concreta: **una coincidencia aritmética sostenida en
 * varios renglones no pasa por casualidad**. Que 27 × 10.361,45 × 0,84 dé
 * 234.997,69 y que 30 × 9.453,76 × 0,84 dé 238.234,75 identifica las cuatro
 * columnas de golpe, sin leer una sola palabra del encabezado.
 *
 * Se prueba con y sin una columna de porcentaje en el medio porque las dos
 * formas existen en el banco de facturas: Barraza imprime el importe neto y Los
 * Calvos el bruto, con la bonificación descontada recién al pie.
 *
 * Se exige más de un renglón. Con uno solo, tres números cualesquiera se pueden
 * multiplicar y dar un cuarto por pura coincidencia; con dos ya no.
 */
export function relacionesAritmeticas(columnas: ContenidoDeColumna[]): RelacionAritmetica[] {
  /*
   * Se miran a lo sumo doce renglones.
   *
   * Una igualdad que vale para la tabla se ve en los primeros doce renglones
   * igual de bien que en los cuarenta, y esto se corre muchas veces: una por
   * cada combinación de repartos que se evalúa. Sin el tope, una factura larga
   * multiplicaba por tres el tiempo de lectura del comprobante entero para no
   * decir nada distinto.
   */
  const filas = Math.min(12, Math.max(0, ...columnas.map((c) => c.celdas.length)));
  if (filas < 2) return [];

  const perfiles = columnas.map((c) => perfilDeContenido(c.celdas));
  const numericas = perfiles
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.conValor >= 2 && p.fracciones.numero >= PREDOMINIO)
    .map(({ i }) => i);
  /*
   * Quién puede hacer de precio y de importe se decide por **magnitud**, no por
   * puntuación.
   *
   * Pedir que la columna tenga forma de monto parece lo natural y deja afuera
   * justo las que hay que rescatar: sobre la foto de Lácteos Barraza los dos
   * importes salen «234.99769» y «238,234.», que no tienen forma de monto en
   * ninguna convención. Con ese filtro la columna de importes no entraba en
   * ninguna tripleta y la igualdad que identifica las cuatro columnas no se
   * encontraba nunca.
   *
   * Lo que sí distingue un precio de un porcentaje o de una cantidad de bultos
   * es el tamaño, y eso sobrevive a que el OCR se coma un separador: alguna
   * lectura de la celda da cien o más. Las columnas chicas quedan afuera, que es
   * lo que mantiene acotada la cantidad de tripletas a probar.
   */
  const grandes = numericas.filter((i) => {
    const conGrande = columnas[i].celdas.filter((celda) =>
      valoresEn(celda, false).concat(valoresEn(celda, true)).some((v) => v.abs().gte(100)),
    ).length;
    return perfiles[i].conValor > 0 && conGrande / perfiles[i].conValor >= PREDOMINIO;
  });
  const porcentajes = numericas.filter(
    (i) => perfiles[i].fracciones.porcentaje >= PREDOMINIO && !grandes.includes(i),
  );

  const salida: RelacionAritmetica[] = [];

  for (const invertida of [false, true]) {
    const valores = (columna: number, fila: number): Decimal[] => {
      const texto = columnas[columna].celdas[fila];
      return texto === undefined ? [] : valoresEn(texto, invertida);
    };

    for (const cantidad of numericas) {
      for (const precio of grandes) {
        if (precio === cantidad) continue;
        for (const importe of grandes) {
          if (importe === cantidad || importe === precio) continue;
          for (const descuento of [null, ...porcentajes]) {
            if (descuento === cantidad || descuento === precio || descuento === importe) continue;

            let cierran = 0;
            let probados = 0;
            for (let fila = 0; fila < filas; fila++) {
              const cs = valores(cantidad, fila).filter((v) => v.gt(0));
              const ps = valores(precio, fila).filter((v) => v.gt(0));
              const is = valores(importe, fila).filter((v) => v.gt(0));
              if (cs.length === 0 || ps.length === 0 || is.length === 0) continue;

              const ds =
                descuento === null
                  ? [null]
                  : valores(descuento, fila).filter((v) => v.gte(0) && v.lte(100));
              if (ds.length === 0) continue;

              probados += 1;
              /*
               * Alcanza con que **alguna** lectura de los cuatro números cumpla
               * la igualdad. No es aflojar el control: las lecturas son las que
               * el OCR produjo de esos mismos dígitos, y que una combinación de
               * ellas dé exacto sobre varios renglones seguidos no pasa por
               * casualidad. Exigir la lectura literal, en cambio, descarta el
               * renglón por un separador que el OCR se comió.
               */
              const cierra = cs.some((c) =>
                ps.some((p) =>
                  ds.some((d) => {
                    const esperado =
                      d === null ? c.times(p) : c.times(p).times(new Decimal(1).minus(d.div(100)));
                    return is.some((i) => casiIgual(esperado, i));
                  }),
                ),
              );
              if (cierra) cierran += 1;
            }

            if (probados >= 2 && cierran >= 2 && cierran / probados >= PREDOMINIO) {
              salida.push({ cantidad, precio, importe, descuento, cierran, probados });
            }
          }
        }
      }
    }

    // Si la convención directa ya explicó la tabla, no hace falta la invertida.
    if (salida.length > 0) break;
  }

  return salida.sort((a, b) => b.cierran - a.cierran);
}

// ---------------------------------------------------------------------------
// La reunión de todas las evidencias
// ---------------------------------------------------------------------------

export interface OpcionesDeSemantica {
  /**
   * Los netos que se leyeron en el pie, con cualquier convención.
   *
   * Sirven para la última evidencia: la columna de montos cuya suma da el neto
   * impreso es el importe del renglón. Es opcional porque el pie se lee después
   * de reconstruir la tabla, y esta capa tiene que funcionar sin él.
   */
  netosPosibles?: Decimal[];
}

export function asignarSemantica(
  columnas: ContenidoDeColumna[],
  opciones: OpcionesDeSemantica = {},
): AsignacionDeColumna[] {
  const perfiles = columnas.map((c) => perfilDeContenido(c.celdas));
  const porColumna: Evidencia[][] = columnas.map(() => []);

  // --- 1. El encabezado, tal cual está impreso -----------------------------
  const exactos = columnas.map((c) => (c.titulo ? reconocerColumna(c.titulo) : null));
  exactos.forEach((reconocida, i) => {
    if (!reconocida || reconocida.campo === 'ignorada') return;
    porColumna[i].push({
      familia: 'encabezado',
      campo: reconocida.campo,
      peso: 0.5 + reconocida.confianza * 0.35,
      detalle: `El encabezado «${reconocida.encabezado}» es un sinónimo conocido de ${reconocida.campo}.`,
    });
  });

  // --- 2. El encabezado degradado -----------------------------------------
  columnas.forEach((columna, i) => {
    if (!columna.titulo) return;
    // Cuando el encabezado se reconoció exacto no hace falta parecerse a nada.
    if (exactos[i] && exactos[i]!.campo !== 'ignorada') return;
    for (const { campo, parecido: cuanto } of camposParecidos(columna.titulo).slice(0, 3)) {
      porColumna[i].push({
        familia: 'similitud',
        campo,
        peso: 0.3 + (cuanto - PARECIDO_MINIMO) * 1.2,
        detalle:
          `El encabezado «${columna.titulo}» se parece un ${(cuanto * 100).toFixed(0)} % ` +
          `a como se escribe ${campo}.`,
      });
    }
  });

  // --- 3. La forma de lo que hay debajo ------------------------------------
  columnas.forEach((columna, i) => {
    const perfil = perfiles[i];
    if (perfil.conValor === 0) return;
    for (const [campo, forma, peso] of FORMA_ESPERADA) {
      const fraccion = perfil.fracciones[forma];
      if (fraccion < PISO_DE_FORMA) continue;
      porColumna[i].push({
        familia: 'contenido',
        campo,
        peso: peso * fraccion,
        detalle:
          `El ${(fraccion * 100).toFixed(0)} % de lo que hay debajo tiene forma de ${forma}, ` +
          `que es la de ${campo}.`,
      });
    }
  });

  // --- 4. Cuántos renglones tienen un valor acá ----------------------------
  columnas.forEach((columna, i) => {
    const perfil = perfiles[i];
    if (perfil.total === 0 || perfil.cobertura < 0.8) return;
    /*
     * Una columna que está llena en casi todos los renglones es de las que un
     * comprobante imprime siempre: la descripción, la cantidad, el importe. Una
     * que está a medio llenar es una marca, un código opcional o una columna que
     * el OCR perdió.
     *
     * Apoya sólo los campos que el contenido ya sostenía: por sí sola no dice
     * **qué** es la columna, dice que es una columna de verdad.
     */
    const sostenidos = new Set(
      porColumna[i].filter((e) => e.familia === 'contenido').map((e) => e.campo),
    );
    for (const campo of ['descripcion', 'importe', 'cantidad', 'kilos', 'codigo'] as CampoDeColumna[]) {
      if (!sostenidos.has(campo)) continue;
      porColumna[i].push({
        familia: 'cobertura',
        campo,
        peso: 0.2,
        detalle: `Tiene un valor en ${perfil.conValor} de ${perfil.total} renglones, como ${campo}.`,
      });
    }
  });

  // --- 5. Dónde está respecto de las demás ---------------------------------
  const conDatos = columnas
    .map((c, i) => ({ i, perfil: perfiles[i] }))
    .filter(({ perfil }) => perfil.conValor > 0);
  if (conDatos.length >= 3) {
    const primera = conDatos[0].i;
    const ultima = conDatos[conDatos.length - 1].i;
    if (perfiles[primera].fracciones.codigo >= PREDOMINIO) {
      porColumna[primera].push({
        familia: 'posicion',
        campo: 'codigo',
        peso: 0.3,
        detalle: 'Es la primera columna con datos, que es donde va el código.',
      });
    }
    if (perfiles[ultima].fracciones.monto >= PREDOMINIO) {
      porColumna[ultima].push({
        familia: 'posicion',
        campo: 'importe',
        peso: 0.3,
        detalle: 'Es la última columna con datos y son montos, que es donde va el importe.',
      });
    }
    /*
     * La columna de texto más ancha es la descripción.
     *
     * Es lo único que distingue una descripción de una marca cuando el
     * encabezado no se lee, y distingue bien: la descripción de un artículo
     * ocupa varias palabras y la marca, una.
     */
    const textuales = conDatos.filter(({ i }) => perfiles[i].fracciones.texto >= PREDOMINIO);
    if (textuales.length > 0) {
      const masAncha = textuales.reduce((a, b) =>
        columnas[b.i].hasta - columnas[b.i].desde > columnas[a.i].hasta - columnas[a.i].desde ? b : a,
      );
      porColumna[masAncha.i].push({
        familia: 'posicion',
        campo: 'descripcion',
        peso: 0.3,
        detalle: 'Es la columna de texto más ancha, que es la de la descripción.',
      });
    }
  }

  // --- 6. Qué son las vecinas ---------------------------------------------
  columnas.forEach((columna, i) => {
    const derecha = perfiles[i + 1];
    const izquierda = perfiles[i - 1];
    const propio = perfiles[i];
    if (
      propio.fracciones.porcentaje >= PREDOMINIO &&
      propio.fracciones.monto < PREDOMINIO &&
      derecha &&
      derecha.fracciones.monto >= PREDOMINIO
    ) {
      porColumna[i].push({
        familia: 'vecindad',
        campo: 'descuentoPct',
        peso: 0.25,
        detalle: 'Es un porcentaje con una columna de montos inmediatamente a la derecha.',
      });
    }
    if (
      propio.fracciones.texto >= PREDOMINIO &&
      izquierda &&
      izquierda.fracciones.codigo >= PREDOMINIO
    ) {
      porColumna[i].push({
        familia: 'vecindad',
        campo: 'descripcion',
        peso: 0.25,
        detalle: 'Es texto con una columna de códigos inmediatamente a la izquierda.',
      });
    }
  });

  // --- 7. Las igualdades que la tabla hace cerrar --------------------------
  for (const relacion of relacionesAritmeticas(columnas).slice(0, 3)) {
    const cuanto = relacion.cierran / relacion.probados;
    const como = relacion.descuento === null ? '' : ' con el descuento aplicado';
    const detalle =
      `${relacion.cierran} de ${relacion.probados} renglones cumplen ` +
      `cantidad × precio = importe${como} con esta combinación de columnas.`;

    porColumna[relacion.importe].push({
      familia: 'aritmetica',
      campo: 'importe',
      peso: 0.55 * cuanto,
      detalle,
    });
    /*
     * La columna que multiplica es **la cantidad genérica**, no los kilos.
     *
     * La aritmética dice que ahí va lo que se multiplica por el precio; no dice
     * en qué unidad está medido, y no hay manera de saberlo sin el encabezado.
     * Poner «kilos» porque el importe da bien sería inventar la unidad, que es
     * justo lo que no se puede hacer.
     */
    porColumna[relacion.cantidad].push({
      familia: 'aritmetica',
      campo: 'cantidad',
      peso: 0.45 * cuanto,
      detalle,
    });
    porColumna[relacion.precio].push({
      familia: 'aritmetica',
      campo: relacion.descuento === null ? 'precioConDescuento' : 'precioUnitario',
      peso: 0.45 * cuanto,
      detalle,
    });
    if (relacion.descuento !== null) {
      porColumna[relacion.descuento].push({
        familia: 'aritmetica',
        campo: 'descuentoPct',
        peso: 0.5 * cuanto,
        detalle,
      });
    }
  }

  // --- 8. La coherencia con el pie ----------------------------------------
  const netos = opciones.netosPosibles ?? [];
  if (netos.length > 0) {
    columnas.forEach((columna, i) => {
      if (perfiles[i].fracciones.monto < PREDOMINIO) return;
      for (const invertida of [false, true]) {
        const valores = columna.celdas
          .map((celda) => valoresEn(celda, invertida)[0])
          .filter((v): v is Decimal => v !== undefined);
        if (valores.length < 2) continue;
        const suma = valores.reduce((a, b) => a.plus(b), new Decimal(0));
        const coincide = netos.some((neto) => neto.gt(0) && casiIgual(suma, neto));
        if (!coincide) continue;
        porColumna[i].push({
          familia: 'coherencia',
          campo: 'importe',
          peso: 0.5,
          detalle: `La suma de esta columna (${suma.toFixed(2)}) da el neto impreso en el pie.`,
        });
        break;
      }
    });
  }

  return resolver(columnas, perfiles, porColumna);
}

/**
 * De las evidencias al campo: puntuar, elegir y decidir si hay que preguntar.
 *
 * Las evidencias de familias distintas se combinan como probabilidades
 * independientes —1 − Π(1 − peso)— y las de la misma familia no se suman entre
 * sí: se queda la más fuerte. Eso es lo que impide que tres maneras de decir lo
 * mismo cuenten por tres.
 */
function resolver(
  columnas: ContenidoDeColumna[],
  perfiles: PerfilDeContenido[],
  porColumna: Evidencia[][],
): AsignacionDeColumna[] {
  const preliminares = columnas.map((columna, i) => {
    const evidencias = porColumna[i];
    const campos = new Set(evidencias.map((e) => e.campo));

    const puntuados = [...campos]
      .map((campo) => {
        const suyas = evidencias.filter((e) => e.campo === campo);
        const porFamilia = new Map<FamiliaDeEvidencia, number>();
        for (const evidencia of suyas) {
          const anterior = porFamilia.get(evidencia.familia) ?? 0;
          if (evidencia.peso > anterior) porFamilia.set(evidencia.familia, evidencia.peso);
        }
        let contrario = 1;
        for (const peso of porFamilia.values()) contrario *= 1 - Math.min(1, Math.max(0, peso));
        return { campo, puntaje: 1 - contrario, familias: porFamilia.size, evidencias: suyas };
      })
      .sort((a, b) => b.puntaje - a.puntaje);

    return { indice: i, columna, evidencias, puntuados };
  });

  /*
   * Un campo no puede quedar en dos columnas.
   *
   * Pasa de verdad: «Cantidad» y «Cantidad!» en Barraza, «Pr Unit» y «P.U.Desc.»
   * en Ezra. Se resuelve por la fuerza de la evidencia —la columna que mejor lo
   * sostiene se lo queda— y la otra se vuelve a puntuar sin ese campo, para que
   * pueda quedarse con el segundo que le correspondía en vez de quedar en nada.
   */
  const dueño = new Map<CampoDeColumna, number>();
  for (const campo of camposEnDisputa(preliminares)) {
    let mejor: { indice: number; puntaje: number } | null = null;
    for (const { indice, puntuados } of preliminares) {
      const suyo = puntuados.find((p) => p.campo === campo);
      if (!suyo) continue;
      if (!mejor || suyo.puntaje > mejor.puntaje) mejor = { indice, puntaje: suyo.puntaje };
    }
    if (mejor) dueño.set(campo, mejor.indice);
  }

  return preliminares.map(({ indice, evidencias, puntuados }) => {
    const disponibles = puntuados.filter(
      (p) => (dueño.get(p.campo) ?? indice) === indice,
    );

    const ganador = disponibles[0];
    const segundo = disponibles[1];
    const margen = ganador ? ganador.puntaje - (segundo?.puntaje ?? 0) : 0;
    const alternativas = disponibles.slice(1, 4).map((p) => ({ campo: p.campo, puntaje: p.puntaje }));

    if (!ganador) {
      return sinResolver(indice, perfiles[indice], evidencias, alternativas, 0);
    }

    const origen = origenDe(ganador.evidencias);

    /*
     * Una columna vacía se queda con lo que diga su encabezado, sin más.
     *
     * No hay contenido que pueda confirmarlo ni contradecirlo, pero tampoco hay
     * ninguna celda que pueda salir mal asignada: la columna no lleva datos.
     * Pedir dos familias acá sería pedir una evidencia que no puede existir.
     */
    if (perfiles[indice].conValor === 0) {
      if (origen !== 'EXACT_HEADER') {
        return sinResolver(indice, perfiles[indice], evidencias, alternativas, margen);
      }
      return {
        campo: ganador.campo,
        origen,
        confianza: ganador.puntaje,
        margen,
        evidencias,
        alternativas,
        requiereConfirmacion: false,
      };
    }

    const alcanza =
      ganador.familias >= FAMILIAS_MINIMAS &&
      ganador.puntaje >= UMBRAL_DE_COLUMNA &&
      margen >= MARGEN_DE_COLUMNA;

    if (!alcanza) {
      /*
       * Un encabezado impreso y legible **asigna la columna igual**, pero no la
       * da por buena: queda para confirmar.
       *
       * Éste es el caso que faltaba y el que más duele. En la factura de Lácteos
       * Barraza la palabra «Importe» se lee perfecta, y debajo el OCR devuelve
       * los dos importes pegados en un solo borrón: no hay contenido que
       * confirme el encabezado, pero tampoco hay nada que lo contradiga.
       * Tratarlo como columna desconocida deja la aritmética sin el único número
       * que el pie totaliza, y con eso el comprobante entero se cae. Por un
       * encabezado que **sí** se leyó.
       *
       * Así que se usa lo que dice el papel y se pregunta. La celda se
       * reconstruye, las cuentas se hacen, y la persona confirma en un segundo
       * algo que ya está bien casi siempre. Lo que no pasa nunca es que se
       * acepte sola: `requiereConfirmacion` la manda a revisión igual.
       *
       * No vale para un encabezado degradado: ahí la palabra misma es una
       * conjetura, y una conjetura sobre el nombre más una celda ilegible no son
       * dos evidencias, son ninguna.
       */
      const porElEncabezado = ganador.evidencias.some((e) => e.familia === 'encabezado');
      if (porElEncabezado && !contradice(ganador.campo, perfiles[indice])) {
        return {
          campo: ganador.campo,
          origen: 'EXACT_HEADER',
          confianza: ganador.puntaje,
          margen,
          evidencias,
          alternativas,
          requiereConfirmacion: true,
        };
      }
      return sinResolver(indice, perfiles[indice], evidencias, alternativas, margen, ganador.campo);
    }

    /*
     * Aceptada. Si llegó acá por el encabezado —exacto o degradado— queda firme;
     * si llegó por inferencia estructural, se usa y **se pregunta**.
     */
    const inferida = origen === 'INFERRED_FROM_CONTENT' || origen === 'INFERRED_FROM_ARITHMETIC';
    return {
      campo: ganador.campo,
      origen,
      confianza: ganador.puntaje,
      margen,
      evidencias,
      alternativas,
      requiereConfirmacion: inferida,
    };
  });
}

function camposEnDisputa(
  preliminares: { puntuados: { campo: CampoDeColumna }[] }[],
): CampoDeColumna[] {
  const cuenta = new Map<CampoDeColumna, number>();
  for (const { puntuados } of preliminares) {
    for (const { campo } of puntuados) cuenta.set(campo, (cuenta.get(campo) ?? 0) + 1);
  }
  return [...cuenta.entries()].filter(([, veces]) => veces > 1).map(([campo]) => campo);
}

/**
 * ¿Lo que hay debajo **desmiente** al encabezado?
 *
 * No es lo mismo que «no lo confirma». Una columna de importes que el OCR dejó
 * ilegible no confirma nada, pero tampoco dice que no sean importes; una columna
 * llena de palabras debajo de un encabezado que dice «Importe» sí lo dice, y ahí
 * hay que dejar de creerle al encabezado: casi siempre significa que la columna
 * de al lado se corrió encima.
 *
 * Por eso se compara sólo lo que es realmente incompatible —texto contra
 * número— y no la forma fina. El código queda afuera de la comparación porque es
 * legítimamente las dos cosas: «ART-00873» y «03» son códigos igual de válidos.
 */
function contradice(campo: CampoDeColumna, perfil: PerfilDeContenido): boolean {
  if (campo === 'codigo' || CAMPOS_SIN_CONFIRMAR.has(campo)) return false;
  const hayTexto = perfil.fracciones.texto >= PREDOMINIO;
  const hayNumero = perfil.fracciones.numero >= PREDOMINIO;

  const esperaTexto = campo === 'descripcion' || campo === 'marca';
  return esperaTexto ? hayNumero && !hayTexto : hayTexto && !hayNumero;
}

/** De qué familia salió la evidencia que manda, y qué origen le corresponde. */
function origenDe(evidencias: Evidencia[]): OrigenDeAsignacion {
  if (evidencias.some((e) => e.familia === 'encabezado')) return 'EXACT_HEADER';
  if (evidencias.some((e) => e.familia === 'similitud')) return 'FUZZY_HEADER';
  if (evidencias.some((e) => e.familia === 'aritmetica' || e.familia === 'coherencia')) {
    return 'INFERRED_FROM_ARITHMETIC';
  }
  return 'INFERRED_FROM_CONTENT';
}

/**
 * La columna que no se pudo resolver, con el marcador que le corresponde.
 *
 * Acá está la diferencia con lo que había antes. La columna **no desaparece**:
 * queda con un tipo que dice qué forma tiene lo que lleva, sus celdas se
 * reconstruyen igual, y lo único que falta es que alguien confirme qué es.
 */
function sinResolver(
  indice: number,
  perfil: PerfilDeContenido,
  evidencias: Evidencia[],
  alternativas: { campo: CampoDeColumna; puntaje: number }[],
  margen: number,
  favorito?: CampoDeColumna,
): AsignacionDeColumna {
  const campo = marcadorSegunContenido(perfil);
  return {
    campo,
    origen: 'UNRESOLVED',
    confianza: 0,
    margen,
    evidencias,
    alternativas: favorito
      ? [{ campo: favorito, puntaje: 0 }, ...alternativas].slice(0, 4)
      : alternativas,
    requiereConfirmacion: campo !== null,
  };
}

export function marcadorSegunContenido(perfil: PerfilDeContenido): CampoDeColumna | null {
  if (perfil.conValor === 0) return null;
  const { fracciones } = perfil;
  if (fracciones.texto >= PREDOMINIO) return 'UNKNOWN_TEXT';
  if (fracciones.monto >= PREDOMINIO) return 'UNKNOWN_MONEY';
  if (fracciones.porcentaje >= PREDOMINIO && fracciones.numero >= PREDOMINIO) {
    return 'UNKNOWN_PERCENT';
  }
  if (fracciones.numero >= PREDOMINIO || fracciones.codigo >= PREDOMINIO) return 'UNKNOWN_NUMERIC';
  return null;
}

/** La asignación en la forma que consume el resto del motor. */
export function aColumnaReconocida(
  titulo: string | null,
  asignacion: AsignacionDeColumna,
): ColumnaReconocida | null {
  if (!asignacion.campo) return null;
  return {
    campo: asignacion.campo,
    encabezado: titulo?.trim() ?? '',
    confianza: asignacion.confianza,
    origen: asignacion.origen,
    requiereConfirmacion: asignacion.requiereConfirmacion,
    margen: asignacion.margen,
    porQue: asignacion.evidencias
      .filter((e) => e.campo === asignacion.campo)
      .map((e) => e.detalle),
  };
}
