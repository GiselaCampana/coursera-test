import { Decimal } from '@/lib/money';
import { variantesDeNumero } from '@/lib/ocr/numeros';
import { repararDigitos } from '@/lib/ocr/parsers/tipos';

/**
 * Cómo escribe los números **una columna**, para poder leer los que salieron
 * mutilados.
 *
 * Hasta acá cada celda se leía sola: `variantesDeNumero` ofrecía todas las
 * maneras de interpretar sus dígitos y la aritmética elegía. Eso alcanza cuando
 * la celda está entera y falla justo donde más duele, porque **una celda sola no
 * tiene con qué desmentir una lectura absurda**.
 *
 * El caso que lo obliga: en una columna de precios donde veinte valores se leen
 * «8.090,08», «19.871,90», «15.073,00», aparece uno que el OCR devolvió
 * «52293041», sin un solo separador. Mirado solo, ese número admite media docena
 * de lecturas —522.930,41; 52.293.041; 5.229,3041— y la que se elige es la que
 * más acerca la suma al total impreso. Eso es exactamente ajustar un número para
 * que dé: la elección no la hace la evidencia, la hace el faltante.
 *
 * Mirado **dentro de su columna** el problema tiene otra forma. Los otros veinte
 * precios dicen cómo escribe este papel: coma decimal, dos decimales, valores
 * entre mil y veinte mil. Bajo esa hipótesis 522.930,41 está cien veces fuera de
 * rango y 5.229,30 encaja. Y quién decide entre las que encajan sigue siendo la
 * aritmética del renglón, no el total.
 *
 * Lo que esta capa aporta, entonces, es el **marco**: qué forma tienen los
 * números de esta columna según la mayoría de sus valores literales y
 * coherentes. Los mutilados se leen después, adentro de ese marco, y cada
 * lectura viene con el precio que hay que pagar para sostenerla.
 */

/** Qué carácter usa la columna para separar los decimales. */
export type SeparadorDecimal = 'coma' | 'punto' | 'ninguno';

export interface FormatoDeColumna {
  separador: SeparadorDecimal;
  /** Cuántos decimales imprime habitualmente. */
  decimales: number;
  /** La magnitud típica de sus valores: la mediana de los literales. */
  magnitudTipica: Decimal;
  /** Cuántos valores bien escritos sostienen esta hipótesis. */
  apoyos: number;
  /** Cuántos valores tiene la columna en total. */
  valores: number;
  /** Por qué se llegó a esta hipótesis, para poder explicarla. */
  porQue: string;
}

/** Una manera de leer una celda, con lo que cuesta sostenerla. */
export interface LecturaNumerica {
  valor: Decimal;
  /** Se leyó con los separadores tal como están impresos. */
  literal: boolean;
  /** Cuántos separadores hubo que suponer perdidos o corridos. */
  reparaciones: number;
  /**
   * Cuán grave es la suposición, de 0 a 3.
   *
   * No es lo mismo suponer que el OCR se comió una coma —y el número queda en
   * el orden de magnitud de su columna— que suponer que se comió todas y el
   * número sale cien veces más grande que sus vecinos. Lo primero pasa en cada
   * factura; lo segundo casi nunca, y cuando el motor lo aceptaba se llevaba el
   * comprobante entero a una escala equivocada.
   */
  severidad: number;
  /**
   * ¿Respeta esta lectura el formato que sostiene el resto de su columna?
   *
   * Es una pregunta **distinta** de si el número está bien escrito, y por eso
   * es un campo aparte. «1500» en una columna que imprime dos decimales está
   * perfectamente bien escrito y se lee al pie de la letra —mil quinientos—
   * pero no se parece a sus veinte vecinos, que llevan coma y dos cifras
   * detrás. Las dos lecturas existen y las dos se ofrecen; lo que este campo
   * permite es que, **a igualdad de todo lo demás**, gane la que se parece a su
   * columna.
   *
   * Sin formato de columna es siempre `true`: no hay nada que contradecir.
   */
  coherente: boolean;
  /** Qué se supuso, en castellano. */
  comoSeLeyo: string;
}

/**
 * ¿Está el número escrito de una manera que exista?
 *
 * Un número bien escrito tiene, a lo sumo, grupos de tres cifras separados por
 * el separador de miles y una cola decimal de una a tres cifras. Todo lo demás
 * —«234.99769», «238,234.», «52293041» con ocho cifras seguidas donde la columna
 * usa dos decimales— es una escritura que ninguna convención produce, y es la
 * señal de que el OCR perdió algo.
 */
function bienEscrito(texto: string): { si: boolean; separador: SeparadorDecimal; decimales: number } {
  const limpio = texto.trim();

  // Entero sin separadores: bien escrito, sin decimales.
  if (/^\d+$/.test(limpio)) return { si: true, separador: 'ninguno', decimales: 0 };

  // Un solo separador con una cola de una a tres cifras: es el decimal.
  const uno = limpio.match(/^\d+([.,])(\d{1,3})$/);
  if (uno) {
    /*
     * Con exactamente tres cifras detrás hay ambigüedad real —«1.234» puede ser
     * mil doscientos treinta y cuatro o uno con doscientos treinta y cuatro
     * milésimos— y no se resuelve acá: se resuelve mirando la columna entera.
     */
    return {
      si: true,
      separador: uno[1] === ',' ? 'coma' : 'punto',
      decimales: uno[2].length,
    };
  }

  // Grupos de miles, con o sin cola decimal.
  const grupos = limpio.match(/^\d{1,3}(([.,])\d{3})+(([.,])(\d{1,3}))?$/);
  if (grupos) {
    const conCola = grupos[3] !== undefined;
    const separadorDeMiles = grupos[2];
    const separadorDecimal = grupos[4];
    // Los dos separadores no pueden ser el mismo carácter.
    if (conCola && separadorDeMiles === separadorDecimal) {
      return { si: false, separador: 'ninguno', decimales: 0 };
    }
    return {
      si: true,
      separador: conCola ? (separadorDecimal === ',' ? 'coma' : 'punto') : 'ninguno',
      decimales: conCola ? grupos[5].length : 0,
    };
  }

  return { si: false, separador: 'ninguno', decimales: 0 };
}

/** El valor literal de un texto bien escrito, con el separador que diga la forma. */
function valorLiteral(texto: string, separador: SeparadorDecimal): Decimal | null {
  const limpio = texto.trim();
  if (separador === 'ninguno') {
    const digitos = limpio.replace(/[.,]/g, '');
    return /^\d+$/.test(digitos) ? new Decimal(digitos) : null;
  }
  const caracter = separador === 'coma' ? ',' : '.';
  const corte = limpio.lastIndexOf(caracter);
  if (corte === -1) {
    const digitos = limpio.replace(/[.,]/g, '');
    return /^\d+$/.test(digitos) ? new Decimal(digitos) : null;
  }
  const enteros = limpio.slice(0, corte).replace(/[.,]/g, '');
  const decimales = limpio.slice(corte + 1).replace(/[.,]/g, '');
  if (!/^\d+$/.test(enteros) || !/^\d*$/.test(decimales)) return null;
  return new Decimal(`${enteros}.${decimales || 0}`);
}

/**
 * La hipótesis de formato que sostiene la mayoría de los valores de la columna.
 *
 * Se cuenta, entre los valores **bien escritos**, cuál separador decimal y
 * cuántos decimales usan; gana el más repetido. Los mal escritos no votan: son
 * justamente los que hay que interpretar después.
 *
 * Devuelve null cuando no hay de dónde: menos de dos valores bien escritos no
 * son una convención, son dos casualidades, y en ese caso conviene seguir
 * ofreciendo todas las lecturas como hasta ahora.
 */
export function formatoDeColumna(celdas: string[]): FormatoDeColumna | null {
  const conValor = celdas.map((c) => c.trim()).filter((c) => c !== '' && /\d/.test(c));
  if (conValor.length === 0) return null;

  const votos = new Map<string, number>();
  const literales: Decimal[] = [];

  for (const celda of conValor) {
    const soloNumero = celda.replace(/[^\d.,]/g, '');
    const forma = bienEscrito(soloNumero);
    if (!forma.si) continue;
    const clave = `${forma.separador}:${forma.decimales}`;
    votos.set(clave, (votos.get(clave) ?? 0) + 1);
    const valor = valorLiteral(soloNumero, forma.separador);
    if (valor) literales.push(valor);
  }

  if (votos.size === 0 || literales.length < 2) return null;

  const [clave, apoyos] = [...votos.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0];
  const [separador, decimales] = clave.split(':');

  const ordenados = [...literales].sort((a, b) => a.comparedTo(b));
  const medio = Math.floor(ordenados.length / 2);
  const magnitudTipica =
    ordenados.length % 2 === 1
      ? ordenados[medio]
      : ordenados[medio - 1].plus(ordenados[medio]).div(2);

  return {
    separador: separador as SeparadorDecimal,
    decimales: Number(decimales),
    magnitudTipica,
    apoyos,
    valores: conValor.length,
    porQue:
      `${apoyos} de ${conValor.length} valores están escritos con ` +
      (separador === 'ninguno'
        ? 'enteros sin decimales'
        : `${decimales} decimal/es separados por ${separador}`) +
      `, y la magnitud típica es ${magnitudTipica.toFixed(2)}.`,
  };
}

/**
 * Hasta cuántas veces puede un valor apartarse de la magnitud de su columna
 * antes de que la lectura se considere de otra escala.
 *
 * Cincuenta. Una columna de precios de una fiambrería va de los cien pesos de
 * una bolsa a los treinta mil de un jamón crudo, que son dos órdenes y medio;
 * una lectura cien veces fuera de eso no es un artículo caro, es un separador
 * perdido. El número es holgado a propósito: lo que tiene que atrapar es el
 * salto de escala, no la variedad legítima de un catálogo.
 */
const APARTAMIENTO_DE_ESCALA = 50;

/**
 * Las lecturas posibles de una celda **dentro del formato de su columna**.
 *
 * Cada una viene con cuántas reparaciones necesitó y cuán grave es la
 * suposición, para que quien elija sepa lo que está pagando. La lista sale
 * ordenada de menos a más costosa, pero **no elige**: eso lo sigue haciendo la
 * aritmética del renglón.
 *
 * Sin formato de columna se comporta como antes —todas las lecturas de los
 * mismos dígitos, sin ranking— porque es lo que corresponde cuando no hay
 * mayoría que defina nada.
 */
/**
 * Las lecturas ya calculadas, por texto y por formato.
 *
 * El mismo texto se relee muchísimas veces: una celda participa de todas las
 * variantes de su renglón, de las dos convenciones decimales del documento y de
 * cada esqueleto que se prueba. Sobre una factura de veintitrés renglones eso
 * son miles de llamadas con un puñado de textos distintos, y la cuenta —hasta
 * seis lecturas, cada una con su Decimal— no es gratis.
 *
 * El resultado se comparte, así que **nadie puede modificarlo**: quien lea una
 * lectura la lee, no la ajusta. El mapa se cuelga del objeto de formato con un
 * `WeakMap`, así que se libera con él y no crece entre comprobantes.
 */
const CACHE = new WeakMap<FormatoDeColumna, Map<string, LecturaNumerica[]>>();
const SIN_FORMATO = new Map<string, LecturaNumerica[]>();
/** Tope por si un comprobante trae miles de textos distintos. */
const CACHE_MAXIMA = 4000;

export function lecturasDeCelda(texto: string, formato: FormatoDeColumna | null): LecturaNumerica[] {
  let suyas: Map<string, LecturaNumerica[]>;
  if (formato) {
    const yaEsta = CACHE.get(formato);
    suyas = yaEsta ?? new Map();
    if (!yaEsta) CACHE.set(formato, suyas);
  } else {
    suyas = SIN_FORMATO;
  }
  const guardada = suyas.get(texto);
  if (guardada) return guardada;

  const calculada = calcularLecturas(texto, formato);
  if (suyas.size < CACHE_MAXIMA) suyas.set(texto, calculada);
  return calculada;
}

function calcularLecturas(texto: string, formato: FormatoDeColumna | null): LecturaNumerica[] {
  /*
   * Primero se arreglan los caracteres que el OCR pone donde había un dígito, y
   * **recién después** se tira lo que sobra.
   *
   * El orden importa y hacerlo al revés fue un error medido: la factura de Los
   * Calvos llega con «16.O37,OO» —la letra O por el cero, que es la confusión
   * más común de todas—, y borrar lo que no es dígito antes de repararlo deja
   * «16.37,» y un precio de 1.637 en vez de 16.037. Los nueve renglones dejaban
   * de cerrar y el comprobante mejor leído del banco caía a revisión.
   *
   * Que un carácter se haya reparado no cuenta como reparación de separador:
   * son dos cosas distintas. `literal` quiere decir que **los separadores están
   * donde los imprimió el papel**, y una O confundida con un cero no mueve
   * ningún separador.
   */
  const soloNumero = repararDigitos(texto).replace(/[^\d.,]/g, '').trim();
  if (soloNumero === '' || !/\d/.test(soloNumero)) return [];

  const forma = bienEscrito(soloNumero);
  /*
   * El cero no es una lectura: es el resultado de no haber podido leer.
   *
   * Aparece cuando la celda trae separadores sueltos sin dígitos alrededor, y
   * pasa inadvertido porque un importe de cero suma cero y no rompe ninguna
   * igualdad. Sobre una factura larga eso dejaba dos artículos cargados en cero
   * y el resto de la suma acomodándose alrededor. Un renglón sin importe tiene
   * que quedar **sin importe** y pedirlo.
   */
  const variantes = variantesDeNumero(soloNumero).filter((v) => v.gt(0));
  if (variantes.length === 0) return [];

  const salida: LecturaNumerica[] = variantes.map((valor, indice) => {
    const literal = indice === 0 && forma.si;
    return {
      valor,
      literal,
      reparaciones: literal ? 0 : 1,
      severidad: literal ? 0 : 1,
      coherente: !formato || (literal && forma.decimales === formato.decimales),
      comoSeLeyo: literal
        ? 'tal como está impreso'
        : 'suponiendo que el OCR perdió o corrió un separador',
    };
  });

  if (!formato) return salida;

  /*
   * Con el formato de la columna se puede hacer algo que una celda sola no
   * puede: **poner los separadores donde la columna los pone**.
   *
   * Si la columna imprime dos decimales, los dígitos «52293041» se leen
   * 522.930,41 poniendo la coma dos lugares desde el final, que es la única
   * lectura que respeta el formato. Que además sea la correcta lo dirá la
   * aritmética del renglón; lo que aporta el formato es que sea **la primera
   * que se ofrece** en vez de una entre seis.
   */
  /*
   * La pregunta no es si el texto está bien escrito: es si **coincide con el
   * formato de su columna**.
   *
   * Son dos cosas distintas y confundirlas fue un error medido. «1500» está
   * perfectamente bien escrito —es un entero— pero en una columna que imprime
   * dos decimales puede ser 1.500 o 15,00, y las dos lecturas tienen que
   * existir para que la aritmética del renglón elija. Preguntando sólo si el
   * texto es escribible, la segunda nunca se ofrecía y la celda quedaba
   * resuelta por casualidad.
   */
  const coincideConLaColumna = forma.si && forma.decimales === formato.decimales;
  if (!coincideConLaColumna && formato.decimales > 0) {
    const digitos = soloNumero.replace(/[.,]/g, '');
    if (/^\d+$/.test(digitos) && digitos.length > formato.decimales) {
      const enteros = digitos.slice(0, digitos.length - formato.decimales);
      const cola = digitos.slice(digitos.length - formato.decimales);
      const valor = new Decimal(`${enteros}.${cola}`);
      const comoSeLeyo =
        `poniendo el separador decimal donde lo pone el resto de la columna ` +
        `(${formato.decimales} decimales)`;
      const yaEstaba = salida.find((l) => l.valor.eq(valor));
      if (yaEstaba) {
        /*
         * Si la lectura ya la ofrecía la celda sola, **no se descarta: se
         * reetiqueta**. Que además sea la que respeta el formato de la columna
         * es evidencia a su favor y es lo que hay que decir; dejarla con el
         * mensaje genérico de «el OCR perdió un separador» era esconder el
         * único apoyo que tiene.
         */
        yaEstaba.comoSeLeyo = comoSeLeyo;
        yaEstaba.coherente = true;
      } else {
        salida.push({
          valor,
          literal: false,
          reparaciones: 1,
          severidad: 1,
          coherente: true,
          comoSeLeyo,
        });
      }
    }
  }

  /*
   * Y se puede castigar la lectura que se va de escala.
   *
   * Es la que el motor elegía cuando le convenía al total: el mismo número cien
   * veces más grande cierra la cuenta del renglón igual de bien, porque la
   * proporción se mantiene, así que nada dentro del renglón lo desmiente. Lo
   * único que lo desmiente son sus veinte vecinos de columna.
   */
  const referencia = formato.magnitudTipica;
  for (const lectura of salida) {
    if (referencia.lte(0) || lectura.valor.lte(0)) continue;
    const veces = lectura.valor.gt(referencia)
      ? lectura.valor.div(referencia)
      : referencia.div(lectura.valor);
    if (veces.gt(APARTAMIENTO_DE_ESCALA)) {
      lectura.severidad = 3;
      lectura.reparaciones = Math.max(lectura.reparaciones, 1);
      lectura.comoSeLeyo +=
        `, y queda ${veces.toFixed(0)} veces fuera de la magnitud de su columna`;
    }
  }

  return salida.sort(
    (a, b) => a.severidad - b.severidad || a.reparaciones - b.reparaciones || (a.literal ? -1 : 1),
  );
}

export { bienEscrito, valorLiteral };
