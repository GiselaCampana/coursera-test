import { llevaNumeros } from '@/lib/ocr/motor/columnas';
import { alto, centroY, type Caja } from '@/lib/ocr/reconstruccion/evidencia';
import type { CeldaReconstruida } from '@/lib/ocr/reconstruccion/reconstruccion';
import type { ColumnaEspacial } from '@/lib/ocr/reconstruccion/columnas-espaciales';

/**
 * Qué hace falta para decir que una línea de la foto es un renglón de la tabla.
 *
 * La regla vieja era «tiene dos celdas llenas y algún número en una columna
 * numérica». Sobre una factura limpia alcanza; sobre una foto de teléfono no,
 * y el costo se midió: la grilla impresa de Los Calvos, que sigue dibujada
 * después del último artículo, produce dieciséis renglones que no existen, cada
 * uno con sus bloqueos, y una persona termina revisando filas fantasma.
 *
 * El problema de fondo es que «dos celdas y un número» es **una sola evidencia
 * mirada dos veces**: si el OCR alucinó una línea, alucinó las dos celdas. Lo
 * que distingue un artículo de una alucinación es que tenga apoyo de **familias
 * distintas** de evidencia —identidad, números repartidos en columnas, una
 * cuenta que puede cerrar, coherencia con sus vecinos— porque para inventar un
 * renglón así habría que alucinar dos cosas independientes a la vez.
 *
 * Y lo que no se prueba no se tira: queda como renglón pendiente, visible,
 * dentro de la banda de artículos. Lo único que se descarta en silencio es lo
 * que no puede ser un artículo de ninguna manera.
 */

export type ClaseDeRenglon =
  /** Tiene apoyo de dos familias distintas: es un artículo. */
  | 'aceptado'
  /**
   * No se pudo probar, pero está donde van los artículos y sus vecinos lo
   * sostienen. Se conserva y se muestra; no se afirma.
   */
  | 'pendiente'
  /** Es el resto de la descripción del renglón de arriba, no un artículo aparte. */
  | 'continuacion'
  /** Marca de agua, texto suelto, grilla vacía. No es nada. */
  | 'ruido';

/**
 * De qué lado viene el apoyo. Dos del mismo lado no valen por dos.
 *
 * Que sean **independientes** es todo el punto: un código y una descripción
 * están los dos en el renglón por la misma razón —el OCR leyó texto ahí— así
 * que son una sola familia. Un texto y dos importes en columnas distintas, no.
 */
export type FamiliaDeApoyo =
  /** Hay algo que nombra al artículo: un código, o una descripción con letras. */
  | 'identidad'
  /** Hay valores en dos columnas numéricas **distintas**. */
  | 'numeros'
  /** Entre sus números hay una igualdad que puede cerrar. */
  | 'aritmetica'
  /** Ocupa las mismas columnas que sus vecinos y sigue el orden vertical. */
  | 'vecindad';

export interface ClasificacionDeRenglon {
  clase: ClaseDeRenglon;
  apoyos: FamiliaDeApoyo[];
  /** A qué renglón se pega, cuando es continuación de su descripción. */
  continuacionDe: number | null;
  /** Por qué quedó así, en una frase, para el informe y para depurar. */
  motivo: string;
}

/** Lo mínimo que hace falta saber de un renglón para clasificarlo. */
export interface RenglonParaClasificar {
  y: number;
  caja: Caja;
  celdas: (CeldaReconstruida | null)[];
}

const MINIMO_DE_FAMILIAS = 2;

// ---------------------------------------------------------------------------
// Las familias
// ---------------------------------------------------------------------------

/** ¿En esta columna van nombres? La descripción, la marca, o texto sin reconocer. */
function esDeNombres(columna: ColumnaEspacial | undefined): boolean {
  const campo = columna?.campo?.campo;
  return campo === 'descripcion' || campo === 'marca' || campo === 'UNKNOWN_TEXT';
}

/** ¿Esta celda nombra algo? Letras de sobra, o un código con forma de código. */
function nombra(texto: string | null | undefined): boolean {
  if (!texto) return false;
  const limpio = texto.trim();
  // Tres letras seguidas: «PEP», «MANI», «BARRA». Dos no alcanzan, porque el
  // ruido del OCR produce pares de letras a montones.
  if (/\p{L}{3}/u.test(limpio)) return true;
  // O un código: dígitos de sobra, con o sin guiones, y sin separador decimal.
  return /^[A-Z]{0,4}[-\s]?\d{3,}$/i.test(limpio) && !/[.,]\d{2}$/.test(limpio);
}

/**
 * El valor aproximado de una celda, sin comprometerse con la escala.
 *
 * Se usa para una sola pregunta: ¿esta línea tiene forma de renglón de una
 * tabla de precios? No para afirmar ningún número, así que alcanza con una
 * lectura razonable y **las dos convenciones tienen que funcionar**: el último
 * separador seguido de una o dos cifras es el decimal —da igual si es coma o
 * punto— y todo lo demás son separadores de miles.
 *
 * Que esto no contemplara la convención norteamericana costó un renglón real de
 * nueva-05: «$3.003,62» se leía bien y «$3,003.62» daba NaN, con lo que la fila
 * se quedaba sin números y terminaba clasificada como ruido.
 */
function comoNumero(texto: string | null | undefined): number | null {
  if (!texto) return null;
  const limpio = texto.replace(/[^\d.,-]/g, '');
  if (!/\d/.test(limpio)) return null;
  const signo = limpio.startsWith('-') ? -1 : 1;
  const cuerpo = limpio.replace(/^[+-]/, '');

  const decimal = cuerpo.match(/^([\d.,]*)[.,](\d{1,2})$/);
  const valor = decimal
    ? Number(`${decimal[1].replace(/[.,]/g, '') || '0'}.${decimal[2]}`)
    : Number(cuerpo.replace(/[.,]/g, ''));
  return Number.isFinite(valor) ? signo * valor : null;
}

/**
 * ¿Hay entre estos números una igualdad que **podría** cerrar?
 *
 * No se afirma nada: se pregunta si existe alguna terna a × b ≈ c. Es lo que
 * distingue una fila de una tabla de precios de tres números cualesquiera, y es
 * evidencia genuinamente distinta de «hay texto» y de «hay dos columnas
 * ocupadas», porque para que aparezca por casualidad tienen que coincidir tres
 * valores a la vez.
 */
function hayUnaCuentaPosible(numeros: number[]): boolean {
  const utiles = numeros.filter((n) => n > 0);
  for (let i = 0; i < utiles.length; i++) {
    for (let j = i + 1; j < utiles.length; j++) {
      for (let k = 0; k < utiles.length; k++) {
        if (k === i || k === j) continue;
        if (pareceProducto(utiles[i], utiles[j], utiles[k])) return true;
      }
    }
  }
  return false;
}

/**
 * ¿a × b es c, admitiendo que a alguno le falte el separador?
 *
 * Se comparan las **mantisas**: se acepta que el resultado esté corrido por una
 * potencia de diez. Es a propósito, y no es aflojar el umbral. Sobre la factura
 * de Errecalde el OCR devuelve «$13.29525» donde el papel dice 13.295,25, y con
 * esa lectura 4,75 × 13,29525 da 63,15 contra un importe de 63.152,43: la
 * cuenta **cierra**, lo que está mal es la escala. Acá la pregunta es si la
 * línea tiene forma de renglón de una tabla de precios; cuál es la escala
 * verdadera es otro problema, se resuelve en otro lado y no se afirma acá.
 *
 * Sigue siendo exigente: las cifras significativas tienen que coincidir, y que
 * tres números cualesquiera lo hagan por casualidad es raro.
 */
function pareceProducto(a: number, b: number, c: number): boolean {
  const producto = a * b;
  if (producto <= 0 || c <= 0) return false;
  for (let potencia = -3; potencia <= 3; potencia++) {
    const objetivo = c * 10 ** potencia;
    if (Math.abs(producto - objetivo) <= Math.max(1e-6, objetivo * 0.02)) return true;
  }
  return false;
}

/**
 * Con qué se llama a sí mismo este renglón: su código, o su nombre.
 *
 * Sirve para reconocer al mismo artículo leído dos veces. Una pasada ampliada
 * puede dejar el código de un renglón un poco más abajo que el resto de su
 * línea, y esa línea suelta —el mismo código, sin nada más— no es un artículo
 * nuevo: es el que ya está, contado dos veces.
 */
function identidadDe(
  renglon: RenglonParaClasificar,
  columnas: ColumnaEspacial[],
): string | null {
  const normal = (t: string) => t.toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');
  const codigo = renglon.celdas.find(
    (celda, i) => columnas[i]?.campo?.campo === 'codigo' && celda?.texto,
  );
  if (codigo?.texto) {
    const limpio = normal(codigo.texto);
    if (limpio.length >= 4) return limpio;
  }
  const nombres = renglon.celdas
    .map((celda, i) => (esDeNombres(columnas[i]) ? normal(celda?.texto ?? '') : ''))
    .filter((t) => t.length >= 4)
    .sort((a, b) => b.length - a.length);
  return nombres[0] ?? null;
}

/** ¿Dos renglones dicen llamarse igual? */
function mismaIdentidad(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const corto = a.length <= b.length ? a : b;
  const largo = a.length <= b.length ? b : a;
  return corto.length >= 6 && largo.startsWith(corto);
}

/** En qué columnas hay algo, contando cada lugar físico una sola vez. */
function ocupadas(renglon: RenglonParaClasificar): number[] {
  const vistos = new Set<string>();
  const indices: number[] = [];
  renglon.celdas.forEach((celda, i) => {
    if (!celda?.texto) return;
    /*
     * La misma zona física leída por varias pasadas ya vino junta desde el
     * reparto de la celda, pero por las dudas se cuenta por lugar y no por
     * celda: dos celdas cuyo contenido sale de la misma caja son **una**
     * evidencia, no dos, y contarlas dos veces es exactamente cómo una línea
     * inventada consigue «dos columnas ocupadas».
     */
    const donde = celda.alternativas[0]?.caja;
    const clave = donde
      ? `${donde.x0.toFixed(3)}:${donde.y0.toFixed(3)}:${donde.x1.toFixed(3)}`
      : `c${i}`;
    if (vistos.has(clave)) return;
    vistos.add(clave);
    indices.push(i);
  });
  return indices;
}

/**
 * Las familias de evidencia que sostienen a este renglón.
 *
 * `vecinos` son los renglones de arriba y abajo ya clasificados como artículos:
 * la coherencia con ellos es una familia más, y es la que rescata a un renglón
 * real al que el OCR le comió una celda.
 */
const APOYOS_PROPIOS = new WeakMap<
  object,
  { columnas: ColumnaEspacial[]; familias: FamiliaDeApoyo[] }
>();

export function familiasDeApoyo(
  renglon: RenglonParaClasificar,
  columnas: ColumnaEspacial[],
  vecinos: RenglonParaClasificar[] = [],
): FamiliaDeApoyo[] {
  /*
   * Lo que un renglón se sostiene **solo** no cambia, y se pregunta muchas
   * veces: una por cada final de tabla que se propone y otra por cada candidata
   * que se arma sobre las mismas líneas. Se cachea por el arreglo de celdas,
   * que es lo que identifica a la línea, y se valida contra las columnas porque
   * la respuesta depende de ellas.
   */
  if (vecinos.length === 0) {
    const guardado = APOYOS_PROPIOS.get(renglon.celdas);
    if (guardado && guardado.columnas === columnas) return guardado.familias;
  }

  const familias = new Set<FamiliaDeApoyo>();
  const llenas = ocupadas(renglon);

  // --- identidad -----------------------------------------------------------
  if (llenas.some((i) => nombra(renglon.celdas[i]?.texto))) familias.add('identidad');

  /*
   * --- números repartidos --------------------------------------------------
   *
   * Cuenta un número cuando está en una columna donde **pueden** ir números, y
   * eso es todas menos las de nombres y la de códigos. Pedir que la columna
   * estuviera reconocida como numérica era demasiado: sobre nueva-03 el
   * encabezado sale ilegible y las tres columnas de montos quedan sin nombre,
   * así que los cinco artículos de esa factura no tenían dónde apoyarse y
   * terminaban clasificados como ruido. Que una columna no tenga nombre no
   * quiere decir que no tenga montos.
   *
   * Lo que sí hay que excluir es la descripción: «956X30X1» está adentro de un
   * nombre de artículo y no es un valor de nada.
   */
  const conNumero = llenas.filter((i) => {
    if (comoNumero(renglon.celdas[i]?.texto) === null) return false;
    const campo = columnas[i]?.campo?.campo;
    // Sólo se excluyen las columnas **reconocidas** como nombres. Una columna
    // sin reconocer puede perfectamente tener montos: en nueva-05 el encabezado
    // sale ilegible y el precio de un artículo cae en una columna sin nombre,
    // y darla por texto costaba ese renglón.
    return campo !== 'descripcion' && campo !== 'marca' && campo !== 'codigo';
  });
  /*
   * Y alguno tiene que tener **forma de valor**.
   *
   * Dos dígitos sueltos en dos columnas sin nombre no son una fila de una tabla
   * de precios: son ruido con suerte. Sobre nueva-03 eso dejaba entrar una
   * línea que dice «er 7"», «AUD» y «4» como si fuera un artículo. Un valor de
   * verdad tiene tres cifras o tiene coma.
   */
  const hayUnValorDeVerdad = conNumero.some((i) => {
    const texto = renglon.celdas[i]?.texto ?? '';
    return /\d[.,]\d/.test(texto) || (texto.match(/\d/g) ?? []).length >= 3;
  });
  if (conNumero.length >= 2 && hayUnValorDeVerdad) familias.add('numeros');

  // --- una cuenta posible --------------------------------------------------
  const numeros = conNumero
    .map((i) => comoNumero(renglon.celdas[i]?.texto))
    .filter((n): n is number => n !== null);
  if (numeros.length >= 3 && hayUnaCuentaPosible(numeros)) familias.add('aritmetica');

  /*
   * --- coherencia con los vecinos ------------------------------------------
   *
   * Esta familia existe para rescatar un renglón real al que el OCR le comió
   * una celda: está donde van los artículos, ocupa sus mismas columnas y tiene
   * algún valor donde va un valor.
   *
   * El «algún valor» no es decoración. Sin él, una línea de basura con texto
   * repartido en siete columnas —«LENIN NAL | UR EE ERE | AE | LA | erido»,
   * que es lo que el OCR saca del filete impreso arriba de la tabla de
   * Mabelherdi— comparte columnas con los artículos de abajo y se cuela como
   * uno más. Un artículo tiene números; un filete, no.
   */
  /*
   * Y tiene que ser una línea con algo adentro: tres celdas por lo menos y
   * algún valor de verdad. Un fragmento suelto —el código de un artículo
   * releído por otra pasada, que cae un renglón más abajo— comparte columnas
   * con su vecino y se colaba como un artículo más, duplicando el que ya
   * estaba; y una línea de basura con un «7» y un «4» tampoco es un renglón por
   * estar al lado de uno.
   */
  if (conNumero.length >= 1 && hayUnValorDeVerdad && vecinos.length > 0 && llenas.length >= 3) {
    const suyas = new Set(llenas);
    const sostenido = vecinos.some((vecino) => {
      const delVecino = new Set(ocupadas(vecino));
      if (delVecino.size === 0) return false;
      let comunes = 0;
      for (const i of suyas) if (delVecino.has(i)) comunes += 1;
      // La mitad de sus columnas coinciden con las de un artículo probado.
      return comunes >= Math.max(2, Math.ceil(suyas.size / 2));
    });
    if (sostenido) familias.add('vecindad');
  }

  const salida = [...familias];
  if (vecinos.length === 0) APOYOS_PROPIOS.set(renglon.celdas, { columnas, familias: salida });
  return salida;
}

// ---------------------------------------------------------------------------
// Continuaciones de descripción
// ---------------------------------------------------------------------------

/**
 * ¿Es el resto de la descripción del renglón de arriba?
 *
 * «STRE CAV» debajo de un artículo no es un artículo: es el final de su nombre,
 * que no entró en la línea. Se reconoce por lo que **no** tiene —ningún número
 * en ninguna columna de números, ninguna identidad propia— y por dónde está:
 * pegado al renglón de arriba y dentro de sus mismas columnas de texto.
 */
export function esContinuacionDe(
  renglon: RenglonParaClasificar,
  anterior: RenglonParaClasificar | null,
  columnas: ColumnaEspacial[],
  alturaTipica: number,
): boolean {
  if (!anterior) return false;

  const llenas = ocupadas(renglon);
  if (llenas.length === 0) return false;

  // Un número en una columna de números lo convierte en un renglón propio.
  const hayColumnasNumericas = columnas.some((c) => llevaNumeros(c.campo?.campo));
  const tieneNumeroPropio = llenas.some(
    (i) =>
      comoNumero(renglon.celdas[i]?.texto) !== null &&
      (!hayColumnasNumericas || llevaNumeros(columnas[i]?.campo?.campo)),
  );
  if (tieneNumeroPropio) return false;

  /*
   * Tiene que estar **en la descripción** y tener algo escrito.
   *
   * Una continuación es el resto de un nombre, así que cae donde caen los
   * nombres. Sin esta condición, la letra suelta que el OCR deja debajo de un
   * código —«e», en la última fila de la factura de Ezra— se pegaba al código
   * del renglón de arriba y lo convertía en «4249e», que no está en el papel.
   */
  const enDescripcion = llenas.some((i) => esDeNombres(columnas[i]));
  if (!enDescripcion) return false;

  const letras = llenas
    .map((i) => renglon.celdas[i]?.texto ?? '')
    .join('')
    .replace(/[^\p{L}]/gu, '');
  if (letras.length < 3) return false;

  // Y tiene que estar pegado: a menos de un renglón y medio del de arriba.
  const distancia = centroY(renglon.caja) - centroY(anterior.caja);
  if (distancia <= 0 || distancia > alturaTipica * 2.2) return false;

  // En columnas de texto, y en las mismas que usa el de arriba.
  const delAnterior = new Set(ocupadas(anterior));
  return llenas.every((i) => !llevaNumeros(columnas[i]?.campo?.campo)) &&
    llenas.some((i) => delAnterior.has(i));
}

// ---------------------------------------------------------------------------
// La clasificación completa
// ---------------------------------------------------------------------------

export interface OpcionesDeClasificacion {
  columnas: ColumnaEspacial[];
  alturaTipica: number;
  /** Hasta dónde llega la banda de artículos, en fracción de página. */
  hastaY: number;
}

/**
 * El paso entre renglones de **este** comprobante, por la mediana.
 *
 * No es lo mismo que el alto de una letra: en la factura de Errecalde los
 * renglones van cada 0,020 de página y las letras miden 0,0065, o sea tres
 * veces menos. Medir la vecindad en altos de letra dejaba a cada renglón sin
 * vecinos justo donde hacía falta —tres artículos reales con la descripción
 * ilegible se caían por eso— y medirla en una constante rompería con la
 * distancia a la que se sacó la foto.
 */
export function pasoEntreRenglones(
  renglones: RenglonParaClasificar[],
  alturaTipica: number,
): number {
  const alturas = renglones.map((r) => centroY(r.caja)).sort((a, b) => a - b);
  const pasos = alturas
    .slice(1)
    .map((y, i) => y - alturas[i])
    .filter((d) => d > 0)
    .sort((a, b) => a - b);
  if (pasos.length === 0) return alturaTipica;
  return Math.max(pasos[Math.floor(pasos.length / 2)], alturaTipica);
}

/**
 * Clasifica los renglones de una tabla en una sola pasada ordenada.
 *
 * El orden importa: la familia «vecindad» necesita vecinos ya probados, así que
 * primero se resuelven los renglones que se sostienen solos y después se vuelve
 * sobre los débiles con los fuertes ya decididos. Sin eso, dos renglones débiles
 * seguidos se sostendrían mutuamente, que es justo lo que hace una grilla vacía.
 */
export function clasificarRenglones(
  renglones: RenglonParaClasificar[],
  opciones: OpcionesDeClasificacion,
): ClasificacionDeRenglon[] {
  const { columnas, alturaTipica, hastaY } = opciones;
  const paso = pasoEntreRenglones(renglones, alturaTipica);

  // --- Primera vuelta: los que se sostienen solos --------------------------
  const solos = renglones.map((renglon) => familiasDeApoyo(renglon, columnas));
  const probados = renglones.filter((_, i) => solos[i].length >= MINIMO_DE_FAMILIAS);
  const conEvidencia = probados;
  // Con dos renglones todavía no hay «lista»: hace falta un patrón para que
  // estar lejos de él signifique algo.
  const hayUnaLista = probados.length >= 3;

  const salida: ClasificacionDeRenglon[] = [];
  let ultimoAceptado: RenglonParaClasificar | null = null;

  renglones.forEach((renglon, i) => {
    const fueraDeLaBanda = centroY(renglon.caja) > hastaY;

    if (fueraDeLaBanda) {
      salida.push({
        clase: 'ruido',
        apoyos: [],
        continuacionDe: null,
        motivo: 'Está debajo de donde termina la tabla de artículos.',
      });
      return;
    }

    /*
     * Un artículo es parte de una lista. Una línea sola, lejos de todas, no.
     *
     * Cuando ya hay una lista formada —tres renglones o más que se prueban
     * solos— una línea suelta a varios renglones de distancia de todos ellos
     * tiene que traer algo más que un texto y dos números: tiene que traer una
     * cuenta que cierre. Sobre nueva-03 eso es lo que separa los cinco
     * artículos de una línea de basura que el OCR deja a media página de
     * distancia, abajo del pie, y que mirada sola tiene la misma pinta.
     */
    const lejosDeTodos =
      hayUnaLista &&
      conEvidencia.every(
        (otro) =>
          otro === renglon || Math.abs(centroY(otro.caja) - centroY(renglon.caja)) > paso * 4,
      );

    if (solos[i].length >= MINIMO_DE_FAMILIAS && !(lejosDeTodos && !solos[i].includes('aritmetica'))) {
      salida.push({
        clase: 'aceptado',
        apoyos: solos[i],
        continuacionDe: null,
        motivo: `Lo sostienen ${solos[i].length} familias de evidencia: ${solos[i].join(', ')}.`,
      });
      ultimoAceptado = renglon;
      return;
    }

    if (lejosDeTodos && solos[i].length >= MINIMO_DE_FAMILIAS) {
      salida.push({
        clase: 'ruido',
        apoyos: solos[i],
        continuacionDe: null,
        motivo:
          'Está sola, a varios renglones de distancia de la lista de artículos, y ninguna ' +
          'cuenta suya cierra.',
      });
      return;
    }

    // --- ¿Es la continuación del de arriba? --------------------------------
    if (esContinuacionDe(renglon, ultimoAceptado, columnas, alturaTipica)) {
      const cual = salida.findIndex((c, j) => c.clase === 'aceptado' && renglones[j] === ultimoAceptado);
      salida.push({
        clase: 'continuacion',
        apoyos: [],
        continuacionDe: cual >= 0 ? cual : null,
        motivo: 'Es el resto de la descripción del renglón de arriba: no tiene ningún número propio.',
      });
      return;
    }

    // --- Segunda vuelta: apoyo de los vecinos ya probados -------------------
    // Vecino es el de al lado: hasta un paso y medio de renglón, medido sobre
    // el paso de este comprobante.
    const vecinos = probados.filter(
      (otro) => Math.abs(centroY(otro.caja) - centroY(renglon.caja)) <= paso * 1.5,
    );
    const conVecinos = familiasDeApoyo(renglon, columnas, vecinos);

    /*
     * Para **conservar** una línea débil alcanza con la vecindad, y no se
     * afirma nada al hacerlo.
     *
     * La condición es la que pide la regla: está dentro de la banda de
     * artículos, viene en el orden vertical que le toca, ocupa las columnas que
     * ocupan los artículos probados de al lado y tiene algún valor donde va un
     * valor. Con eso queda como renglón **pendiente**: se ve, se puede
     * preguntar por él, y su duda es una sola —«¿esto es un artículo del papel
     * o una línea de basura?»— en vez de una por cada celda.
     *
     * Descartarlo sería peor que conservarlo: un renglón real perdido no se ve
     * por ningún lado, y uno de más se ve y se contesta en un segundo.
     */
    /*
     * Salvo que sea el de al lado otra vez.
     *
     * Si lo único que lo sostiene es la vecindad y encima dice llamarse igual
     * que su vecino, no es un renglón que el OCR leyó mal: es el mismo renglón
     * leído dos veces. Conservarlo agrega un artículo que no está en el papel y
     * una pregunta que no tiene respuesta buena.
     */
    const suIdentidad = identidadDe(renglon, columnas);
    const repiteAlVecino = vecinos.some((otro) =>
      mismaIdentidad(suIdentidad, identidadDe(otro, columnas)),
    );

    if (conVecinos.includes('vecindad') && !repiteAlVecino) {
      salida.push({
        clase: 'pendiente',
        apoyos: conVecinos,
        continuacionDe: null,
        motivo:
          'No se prueba solo, pero está en la banda de artículos y sus vecinos lo sostienen: ' +
          `${conVecinos.join(', ')}.`,
      });
      ultimoAceptado = renglon;
      return;
    }

    salida.push({
      clase: 'ruido',
      apoyos: conVecinos,
      continuacionDe: null,
      motivo: repiteAlVecino
        ? `Dice llamarse igual que el renglón de al lado («${suIdentidad}»): es el mismo, leído dos veces.`
        : conVecinos.length === 0
          ? 'No tiene ninguna evidencia de ser un artículo.'
          : `Sólo lo sostiene ${conVecinos.join(', ')}, y ningún artículo vecino lo acompaña.`,
    });
  });

  /*
   * Una sola pasada más, y una sola.
   *
   * Un renglón real puede tener de vecino a otro renglón real que tampoco se
   * probó solo: en la factura de Errecalde el último artículo tiene arriba a
   * otro al que el OCR le comió la descripción, así que ninguno de los dos ve
   * un vecino «probado» y el último se caía. Con una pasada más, apoyándose
   * también en los conservados, los dos quedan.
   *
   * No se itera hasta que no cambie nada: dos saltos son «el de al lado del de
   * al lado» y eso todavía es vecindad; con más, una cadena de líneas parecidas
   * se sostiene sola y vuelve la grilla fantasma. Y como la vecindad exige
   * algún valor en una columna de valores, una grilla vacía no puede empezar la
   * cadena ni propagarla.
   */
  const conservados = renglones.filter(
    (_, i) => salida[i].clase === 'aceptado' || salida[i].clase === 'pendiente',
  );
  renglones.forEach((renglon, i) => {
    if (salida[i].clase !== 'ruido') return;
    if (centroY(renglon.caja) > hastaY) return;
    const vecinos = conservados.filter(
      (otro) => Math.abs(centroY(otro.caja) - centroY(renglon.caja)) <= paso * 1.5,
    );
    const apoyos = familiasDeApoyo(renglon, columnas, vecinos);
    if (!apoyos.includes('vecindad')) return;
    const suIdentidad = identidadDe(renglon, columnas);
    if (vecinos.some((otro) => mismaIdentidad(suIdentidad, identidadDe(otro, columnas)))) return;
    salida[i] = {
      clase: 'pendiente',
      apoyos,
      continuacionDe: null,
      motivo:
        'No se prueba solo, pero está en la banda de artículos y lo sostienen los ' +
        `renglones de al lado: ${apoyos.join(', ')}.`,
    };
  });

  return salida;
}

// ---------------------------------------------------------------------------
// Hasta dónde llega la tabla
// ---------------------------------------------------------------------------

/**
 * ¿Este final de tabla deja afuera un artículo que se probaba solo?
 *
 * La banda decide dónde termina la tabla, no qué artículos entran. Y como
 * cortar mejora el puntaje —los renglones difíciles son los que no cierran—,
 * sin este freno el motor aprende a terminar la tabla un renglón antes: sobre
 * nueva-04 el corte ganaba por medio punto y se llevaba puesto el cuarto
 * artículo, que está en el papel.
 *
 * Se mira sólo el renglón siguiente al corte, y sólo cuando está **pegado** al
 * último que queda: un renglón con evidencia propia a media página de la tabla
 * puede ser cualquier cosa —la línea de la firma en el pie lo es— y ése sí se
 * puede cortar.
 */
export function cortePierdeUnArticulo(
  renglones: RenglonParaClasificar[],
  columnas: ColumnaEspacial[],
  alturaTipica: number,
  hastaY: number,
): boolean {
  const paso = pasoEntreRenglones(renglones, alturaTipica);
  const dentro = renglones.filter((r) => centroY(r.caja) <= hastaY);
  const afuera = renglones.filter((r) => centroY(r.caja) > hastaY);
  if (dentro.length === 0 || afuera.length === 0) return false;

  const ultimo = dentro[dentro.length - 1];
  const primeroAfuera = afuera[0];
  if (centroY(primeroAfuera.caja) - centroY(ultimo.caja) > paso * 2) return false;
  return familiasDeApoyo(primeroAfuera, columnas).length >= MINIMO_DE_FAMILIAS;
}

export interface CandidataDeBanda {
  /** Hasta qué altura de la página se consideran artículos. */
  hastaY: number;
  /** Cómo se llegó a ese corte, para poder informarlo. */
  origen: string;
}

/**
 * Dónde termina la banda de artículos, como **varias candidatas**.
 *
 * El encabezado dice dónde empieza; el final no lo dice nadie, y un corte fijo
 * por distancia se equivoca en las dos direcciones: deja entrar la grilla vacía
 * que sigue dibujada debajo del último artículo, y se come el último renglón
 * cuando el comprobante lo imprime un poco más separado.
 *
 * Así que no se corta: se proponen los finales plausibles y que compitan como
 * compiten las demás hipótesis, contra la aritmética del comprobante entero.
 * Una grilla que sigue vacía no prolonga la tabla porque no aporta ninguna
 * candidata; un renglón legítimo más separado sí aporta la suya.
 */
export function bandasDeArticulos(
  renglones: RenglonParaClasificar[],
  columnas: ColumnaEspacial[],
  alturaTipica: number,
): CandidataDeBanda[] {
  if (renglones.length === 0) return [{ hastaY: 1, origen: 'sin renglones' }];

  const alturas = renglones.map((r) => centroY(r.caja));
  const pasoTipico = pasoEntreRenglones(renglones, alturaTipica);

  // La primera siempre es la que no corta nada: ninguna candidata puede perder
  // renglones sin que exista, al lado, la que los conserva.
  const candidatas: CandidataDeBanda[] = [{ hastaY: 1, origen: 'toda la página' }];
  const entre = (i: number) =>
    i + 1 < alturas.length ? (alturas[i] + alturas[i + 1]) / 2 : 1;

  const conEvidencia = renglones.map(
    (renglon) => familiasDeApoyo(renglon, columnas).length >= MINIMO_DE_FAMILIAS,
  );

  /*
   * Un corte al final de cada **bloque** de renglones con evidencia propia.
   *
   * No alcanza con cortar después del último: sobre la foto de Los Calvos el
   * pie tiene una línea —«Firma | Responsable | Importe | 376.477,81»— que pasa
   * cualquier prueba de renglón mirada sola, así que «el último con evidencia»
   * cae debajo del pie y la grilla vacía entra igual. Lo que distingue a la
   * tabla del pie es que la tabla es un **bloque seguido** y el pie está
   * separado por líneas que no son nada.
   *
   * Cada bloque propone su final y compiten entre sí. Un renglón legítimo un
   * poco más separado no se pierde: sigue habiendo una candidata que lo incluye.
   */
  for (let i = 0; i < renglones.length - 1; i++) {
    if (!conEvidencia[i]) continue;
    let j = i + 1;
    while (j < renglones.length && !conEvidencia[j]) j += 1;
    if (j >= renglones.length) continue;
    const sinEvidencia = j - i - 1;
    if (sinEvidencia >= 2) {
      candidatas.push({
        hastaY: entre(i),
        origen: `el final de un bloque de artículos, con ${sinEvidencia} línea/s sin evidencia debajo`,
      });
    }
  }

  /*
   * Y un corte en cada espacio vertical grande, medido contra el paso de este
   * comprobante y no contra una constante: el paso depende de la impresión y de
   * cuán cerca se sacó la foto.
   */
  for (let i = 1; i < alturas.length; i++) {
    const hueco = alturas[i] - alturas[i - 1];
    if (hueco > Math.max(pasoTipico * 2.5, alturaTipica * 3)) {
      candidatas.push({
        hastaY: entre(i - 1),
        origen: `un espacio de ${(hueco / pasoTipico).toFixed(1)} renglones`,
      });
    }
  }

  // Sin repetir, de la más generosa a la más estricta, y unas pocas: cada una
  // cuesta una interpretación entera del comprobante.
  const vistas = new Set<string>();
  return candidatas
    .filter((c) => {
      const clave = c.hastaY.toFixed(4);
      if (vistas.has(clave) || c.hastaY < alturas[0]) return false;
      vistas.add(clave);
      return true;
    })
    .sort((a, b) => b.hastaY - a.hastaY)
    .slice(0, 4);
}

export { alto };
