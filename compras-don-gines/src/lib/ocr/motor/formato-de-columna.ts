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

/**
 * Una manera posible de leer **toda** la columna, con lo que cuesta sostenerla.
 *
 * La escala es una propiedad de la columna, no de cada celda. Dejar que cada
 * celda eligiera la suya según cuál hiciera cerrar su renglón es exactamente el
 * mecanismo por el que una columna entera se va cien veces de escala sin que
 * nada la desmienta: si el precio y el importe se corren juntos, la cuenta del
 * renglón cierra igual, porque la proporción se mantiene.
 */
export interface EscalaDeColumna {
  separador: SeparadorDecimal;
  decimales: number;
  /**
   * Los valores de la columna que la sostienen **con sus separadores impresos**.
   *
   * Son la única evidencia directa de escala que existe. Un entero pelado no
   * ancla nada: «186249» es compatible con 186.249 y con 1.862,49 por igual, así
   * que no vota. Por eso una minoría bien puntuada le gana a una mayoría
   * mutilada, que es justo lo que hace falta cuando el OCR se comió casi todas
   * las comas de una columna.
   */
  anclas: string[];
  /**
   * Cuántas celdas de la columna **no pueden** estar escritas en esta escala.
   *
   * Es el contrapeso de las anclas y sin él la evidencia estaba contada a medias:
   * se sumaba lo que sostiene una hipótesis y no lo que la desmiente. Una celda
   * con un separador que la escala no explica, o una de una o dos cifras bajo una
   * escala de dos decimales —que obligaría a inventarle un cero adelante— vota en
   * contra. Un entero pelado de seis cifras no vota ni a favor ni en contra.
   */
  contradicen: number;
  /** Cuántas reparaciones de separador cuesta leer la columna entera así. */
  reparaciones: number;
  /** Cuántos separadores impresos conserva. */
  separadoresConservados: number;
  porQue: string;
}

export interface FormatoDeColumna {
  separador: SeparadorDecimal;
  /** Cuántos decimales imprime habitualmente. */
  decimales: number;
  /** La magnitud típica de sus valores: la mediana de los literales. */
  magnitudTipica: Decimal;
  /**
   * Hasta dónde llegan sus valores, de menor a mayor.
   *
   * Es lo que hay que mirar para preguntar «¿este número está en el orden de
   * magnitud de su columna?», y no la mediana. Una columna de precios que va de
   * seis mil a cincuenta mil tiene su mediana cerca de diez mil, así que
   * comparar contra ella condena por «cien veces afuera» a un valor de
   * quinientos mil que está a veintiséis veces del mayor que la columna imprime
   * —o sea, del mismo lado de la línea—. Contra el borde de lo que la columna
   * muestra, la pregunta se contesta bien: lo que queda adentro del rango no se
   * castiga, y lo que se va un orden de magnitud más allá, sí.
   */
  franja: { menor: Decimal; mayor: Decimal };
  /** Lo mismo, pero sólo con los valores que muestran su separador impreso. */
  franjaDeLasAnclas: { menor: Decimal; mayor: Decimal } | null;
  /** Cuántos valores bien escritos sostienen esta hipótesis. */
  apoyos: number;
  /** Cuántos valores tiene la columna en total. */
  valores: number;
  /** Por qué se llegó a esta hipótesis, para poder explicarla. */
  porQue: string;
  /** La escala elegida, con sus anclas y su costo. */
  escala: EscalaDeColumna;
  /**
   * La magnitud de los valores que **muestran su separador impreso**.
   *
   * Es distinta de `magnitudTipica`, que se calcula con lo que haya. Ésta sólo
   * existe cuando hay anclas, y es la única referencia de escala que no depende
   * de haber interpretado nada.
   */
  magnitudDeLasAnclas: Decimal | null;
  /** La que le sigue, cuando hay otra en pie. */
  segunda: EscalaDeColumna | null;
  /**
   * Cuánta ventaja le saca la elegida a la segunda.
   *
   * Es la diferencia de anclas literales; a igualdad de anclas, la diferencia de
   * reparaciones. Cero quiere decir empate, y un empate sin anclas no se rompe
   * con la aritmética: se informa.
   */
  margen: number;
  /**
   * No hay una sola escala posible: ninguna tiene anclas literales y hay más de
   * una en pie.
   *
   * Cuando pasa, el comprobante no puede aceptarse solo. Elegir la que hace
   * cerrar sería dejar que el faltante decida el número, que es el error que
   * toda esta capa existe para impedir.
   */
  indecidible: boolean;
}

/** Una manera de leer una celda, con lo que cuesta sostenerla. */
export interface LecturaNumerica {
  valor: Decimal;
  /** Se leyó con los separadores tal como están impresos. */
  literal: boolean;
  /** Cuántos decimales tiene **escrita** esta lectura. */
  decimalesEscritos: number;
  /**
   * Esta lectura contradice la escala que anclan los valores bien puntuados de
   * su columna.
   *
   * Es distinto de «incoherente»: incoherente es parecerse poco a la columna y
   * pesa poco; ajena a la escala es leer en otra escala que la que el papel
   * muestra impresa, y eso no lo puede comprar ninguna cuenta que cierre. Sin
   * anclas en la columna nunca es cierto: no hay nada que contradecir.
   */
  ajenaALaEscala: boolean;
  /** El texto tal como venía, para poder mostrar de dónde salió el número. */
  textoOriginal: string;
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
  if (!/^\d[\d.,]*$/.test(limpio)) return { si: false, separador: 'ninguno', decimales: 0 };

  const separadores = [...limpio.matchAll(/[.,]/g)].map((m) => m[0]);
  const grupos = limpio.split(/[.,]/);

  // Entero sin separadores: bien escrito, sin decimales.
  if (separadores.length === 0) {
    return /^\d+$/.test(limpio)
      ? { si: true, separador: 'ninguno', decimales: 0 }
      : { si: false, separador: 'ninguno', decimales: 0 };
  }
  if (grupos.some((g) => g === '')) return { si: false, separador: 'ninguno', decimales: 0 };

  const primero = grupos[0];
  const ultimo = grupos[grupos.length - 1];
  const delMedio = grupos.slice(1, -1);
  const ultimoSeparador = separadores[separadores.length - 1];
  const anteriores = separadores.slice(0, -1);

  /*
   * El último separador es el decimal cuando **es distinto** de los que vienen
   * antes, o cuando es el único y deja una cola de una o dos cifras.
   *
   * Lo primero parece obvio y no lo era: la lectura por expresión regular se
   * comía «,380» de «4.874,380» como si fuera otro grupo de miles —tres cifras
   * son tres cifras— y devolvía «cuatro millones ochocientos setenta y cuatro
   * mil trescientos ochenta» con cero decimales. Un papel que imprime precios
   * con tres decimales quedaba leído mil veces más grande, y la columna entera
   * perdía su ancla.
   *
   * Con un separador solo y una cola de tres cifras la ambigüedad es real
   * —«1.234» son mil doscientos treinta y cuatro o uno con doscientos treinta y
   * cuatro milésimos— y no se resuelve mirando el número: se lee como decimal y
   * lo resuelve la columna, que es la que sabe si este papel imprime tres
   * decimales. En la factura de Ezra los imprime, y tratar «4,240» como cuatro
   * mil doscientos cuarenta deja la columna de cantidades sin una sola ancla.
   */
  const colaDecimal =
    anteriores.length > 0
      ? ultimoSeparador !== anteriores[anteriores.length - 1]
      : ultimo.length <= 3;

  const milesBienFormados = (partes: string[]) => partes.every((g) => /^\d{3}$/.test(g));

  if (colaDecimal) {
    const enteros = grupos.slice(0, -1);
    const separadoresDeMiles = anteriores;
    const todosIguales = separadoresDeMiles.every((c) => c === separadoresDeMiles[0]);
    const enterosBien =
      /^\d{1,3}$/.test(primero) && milesBienFormados(enteros.slice(1)) && todosIguales;
    // Sin separadores de miles, la parte entera puede tener cualquier largo.
    const sinMiles = separadoresDeMiles.length === 0 && /^\d+$/.test(primero);
    if ((!enterosBien && !sinMiles) || !/^\d{1,3}$/.test(ultimo)) {
      return { si: false, separador: 'ninguno', decimales: 0 };
    }
    return {
      si: true,
      separador: ultimoSeparador === ',' ? 'coma' : 'punto',
      decimales: ultimo.length,
    };
  }

  // Todos los separadores son de miles: grupos de tres y el primero de uno a tres.
  const todosIguales = separadores.every((c) => c === separadores[0]);
  if (!todosIguales || !/^\d{1,3}$/.test(primero) || !milesBienFormados([...delMedio, ultimo])) {
    return { si: false, separador: 'ninguno', decimales: 0 };
  }
  return { si: true, separador: 'ninguno', decimales: 0 };
}

/**
 * El texto sin su unidad, para que una «g» no se convierta en un nueve.
 *
 * `repararDigitos` arregla los caracteres que el OCR pone donde había un dígito
 * —la O por el cero, la S por el cinco, la g por el nueve— y eso es necesario;
 * lo que no puede hacer es aplicarse a la unidad. «18,38 kg» pasaba a «18,38 k9»
 * y de ahí a «18.389», con lo que la columna de kilos de Errecalde quedaba
 * anclada en tres decimales que el papel no imprime y «392 kg» se leía 0,392.
 *
 * Se saca la cola alfabética sólo cuando trae alguna letra que **no** es de las
 * que el OCR confunde con dígitos: «kg», «Unidades» y «E» se van; «OO» y «lS»
 * se quedan, porque ahí sí puede haber un número escondido.
 */
const LETRAS_QUE_SON_DIGITOS = /^[OoQlI|SsBbZzgq]+$/;

export function sinUnidad(texto: string): string {
  let salida = texto.trim();
  for (let vuelta = 0; vuelta < 3; vuelta++) {
    const cola = salida.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{1,12}\.?$/);
    if (!cola) break;
    const letras = cola[0].replace(/\.$/, '');
    if (LETRAS_QUE_SON_DIGITOS.test(letras)) break;
    const recortado = salida.slice(0, salida.length - cola[0].length).trim();
    if (!/\d/.test(recortado)) break;
    salida = recortado;
  }
  return salida;
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

/** Cómo se lee una celda bajo una escala candidata, y lo que cuesta. */
interface CostoDeCelda {
  /** 0 si está impresa así, 1 si hay que poner un separador, 2 si hay que moverlo. */
  reparaciones: number;
  /** La sostiene con sus separadores impresos: vota **a favor**. */
  ancla: boolean;
  /**
   * Vota **en contra**: esta celda no puede estar escrita en esta escala.
   *
   * Es la distinción que faltaba, y sin ella una columna entera se decidía mal.
   * Había dos clases de celda metidas en la misma bolsa de «reparaciones»:
   *
   *  - la que **calla**: un entero pelado de seis cifras es compatible con leerse
   *    con coma y dos decimales o sin ninguno, y no es evidencia de nada. Cuesta
   *    una reparación y no vota;
   *  - la que **contradice**: una celda con un separador impreso que la escala no
   *    explica, o —y éste es el caso que se perdía— una de una o dos cifras bajo
   *    una escala de dos decimales, que obligaría a leer «6» como 0,06 con un
   *    cero adelante que el papel no imprime.
   *
   * Contarlas juntas dejaba que una sola celda puntuada fijara una columna de
   * veintitrés contra la que siete celdas votaban en contra.
   */
  contradice: boolean;
  separadoresConservados: number;
}

function costoBajoLaEscala(
  texto: string,
  forma: ReturnType<typeof bienEscrito>,
  escala: { separador: SeparadorDecimal; decimales: number },
): CostoDeCelda {
  const separadores = (texto.match(/[.,]/g) ?? []).length;
  const digitos = texto.replace(/[^\d]/g, '').length;

  /*
   * Una celda con tantos dígitos como decimales pide la escala —o menos— no cabe
   * en ella: leerla así le inventa la parte entera. Es universal, no comercial:
   * no dice nada sobre qué valores son razonables, dice que ese número no está
   * escrito de esa manera.
   */
  const noEntraEnLaEscala = escala.decimales > 0 && separadores === 0 && digitos <= escala.decimales;

  // Escrita exactamente como dice la escala: no hay nada que reparar.
  if (forma.si && forma.separador === escala.separador && forma.decimales === escala.decimales) {
    return {
      reparaciones: 0,
      // Sólo ancla lo que tiene un separador decimal impreso. Un entero pelado
      // es compatible con cualquier escala, así que no es evidencia de ninguna.
      ancla: escala.separador !== 'ninguno' && separadores > 0,
      contradice: false,
      separadoresConservados: separadores,
    };
  }

  // Un entero pelado: alcanza con suponer un separador que el OCR no escribió.
  if (forma.si && forma.separador === 'ninguno' && forma.decimales === 0 && separadores === 0) {
    return {
      reparaciones: 1,
      ancla: false,
      contradice: noEntraEnLaEscala,
      separadoresConservados: 0,
    };
  }

  // Cualquier otra cosa: hay separadores impresos que esta escala contradice.
  return { reparaciones: 2, ancla: false, contradice: true, separadoresConservados: 0 };
}

/** Cuántos dígitos seguidos trae la celda más larga, sin separadores. */
function digitosMasLargos(celdas: string[]): number {
  return celdas.reduce((mayor, c) => Math.max(mayor, c.replace(/[^\d]/g, '').length), 0);
}

/**
 * Las escalas que la columna admite, ordenadas de más a menos sostenida.
 *
 * Se proponen las formas que **algún valor puntuado de la columna muestra
 * impresas**, más la de enteros sin decimales, más —sólo cuando no hay un solo
 * valor puntuado— las dos convenciones monetarias, que son las que quedan en
 * pie cuando no hay nada que mirar.
 *
 * El orden es el que pide la regla: primero cuántos valores la anclan con sus
 * separadores impresos; después cuántas reparaciones cuesta la columna entera;
 * después cuántos caracteres impresos conserva. La aritmética no participa acá
 * a propósito: puede **confirmar** una escala que la evidencia literal sostiene,
 * no crearla.
 */
export function escalasDeColumna(celdas: string[]): EscalaDeColumna[] {
  const textos = celdas
    .map((c) => repararDigitos(sinUnidad(c)).replace(/[^\d.,]/g, '').trim())
    .filter((c) => c !== '' && /\d/.test(c));
  if (textos.length === 0) return [];

  const formas = textos.map((t) => bienEscrito(t));

  const candidatas = new Map<string, { separador: SeparadorDecimal; decimales: number }>();
  const agregar = (separador: SeparadorDecimal, decimales: number) =>
    candidatas.set(`${separador}:${decimales}`, { separador, decimales });

  let hayPuntuados = false;
  formas.forEach((forma, i) => {
    if (!forma.si || forma.separador === 'ninguno') return;
    if (!/[.,]/.test(textos[i])) return;
    hayPuntuados = true;
    agregar(forma.separador, forma.decimales);
  });
  agregar('ninguno', 0);
  if (!hayPuntuados) {
    // Sin un solo valor puntuado, las dos convenciones monetarias siguen en pie
    // y **ninguna** tiene con qué ganarle a la otra.
    agregar('coma', 2);
    agregar('punto', 2);
  }

  const evaluadas: EscalaDeColumna[] = [...candidatas.values()].map((candidata) => {
    let reparaciones = 0;
    let conservados = 0;
    let contradicen = 0;
    const anclas: string[] = [];
    textos.forEach((texto, i) => {
      const costo = costoBajoLaEscala(texto, formas[i], candidata);
      reparaciones += costo.reparaciones;
      conservados += costo.separadoresConservados;
      if (costo.contradice) contradicen += 1;
      /*
       * Cada ancla es **una celda física**, contada una sola vez.
       *
       * Va por posición y no por texto a propósito, en los dos sentidos. Dos
       * celdas distintas que dicen lo mismo son dos anclas —una columna de
       * porcentajes donde nueve renglones imprimen «16,00» tiene nueve valores
       * sosteniendo su formato, no uno—; y una misma celda leída por siete
       * pasadas del OCR llega acá como un solo texto, porque la reconstrucción
       * ya la resolvió a una celda por renglón. La evidencia de escala son
       * lugares del papel, no repeticiones de una lectura.
       */
      if (costo.ancla) anclas.push(texto);
    });
    return {
      separador: candidata.separador,
      decimales: candidata.decimales,
      anclas,
      contradicen,
      reparaciones,
      separadoresConservados: conservados,
      porQue:
        anclas.length > 0
          ? `${anclas.length} de ${textos.length} valores la muestran impresa ` +
            `(${anclas.slice(0, 3).join(', ')}${anclas.length > 3 ? '…' : ''}), ` +
            `${contradicen} la contradice/n, y leer la columna entera así cuesta ` +
            `${reparaciones} reparación/es.`
          : `Ningún valor la muestra impresa; ${contradicen} la contradice/n, leer la ` +
            `columna entera así cuesta ${reparaciones} reparación/es y conserva ` +
            `${conservados} separador/es.`,
    };
  });

  /*
   * El orden: primero cuántas celdas la muestran impresa, y **enseguida cuántas
   * la desmienten**. Las dos son evidencia literal y van juntas, antes que
   * cualquier medida de comodidad.
   */
  return evaluadas.sort(
    (a, b) =>
      b.anclas.length - a.anclas.length ||
      a.contradicen - b.contradicen ||
      a.reparaciones - b.reparaciones ||
      b.separadoresConservados - a.separadoresConservados ||
      a.decimales - b.decimales,
  );
}

/**
 * La escala de la columna, con su segunda hipótesis y su margen.
 *
 * Devuelve null cuando no hay ningún valor: no hay columna que describir.
 */
export function formatoDeColumna(celdas: string[]): FormatoDeColumna | null {
  const textos = celdas
    .map((c) => repararDigitos(sinUnidad(c)).replace(/[^\d.,]/g, '').trim())
    .filter((c) => c !== '' && /\d/.test(c));
  /*
   * Un solo valor no define el formato de una columna.
   *
   * Una columna con un valor no tiene «el resto de la columna»: lo que se
   * deduciría de ella es la casualidad de una tabla corta convertida en regla
   * para sus propias celdas dudosas. Es distinto de la minoría de anclas —una
   * columna de veinte valores donde sólo tres conservan sus separadores sí
   * define su formato con esos tres—: lo que hace falta es que haya columna.
   */
  if (textos.length < 2) return null;

  const escalas = escalasDeColumna(celdas);
  if (escalas.length === 0) return null;

  const escala = escalas[0];
  const segunda = escalas[1] ?? null;

  const margen = segunda
    ? escala.anclas.length !== segunda.anclas.length
      ? escala.anclas.length - segunda.anclas.length
      : segunda.reparaciones - escala.reparaciones
    : Infinity;

  /*
   * Cuándo la escala queda **resuelta**, y cuándo hay que preguntar.
   *
   * «Una minoría de literales bien puntuados puede fijar el formato» no es lo
   * mismo que «una ancla siempre manda», y la diferencia se midió: en una de las
   * facturas del banco, una única celda con un punto decidía una columna de
   * veintitrés contra la que siete celdas de una y dos cifras votaban en contra
   * —bajo esa escala habría que leerlas con un cero adelante que el papel no
   * imprime—. La columna quedaba «resuelta» por un solo valor que puede
   * perfectamente ser un punto que el OCR puso de más.
   *
   * Así que hacen falta las dos cosas y ninguna alcanza sola:
   *
   *  - **algo que la muestre impresa**: sin una sola ancla no hay evidencia
   *    literal de escala, y dos hipótesis sobre valores largos siguen en pie.
   *    Una columna de piezas que dice «1», «2», «3» tampoco tiene anclas y no
   *    tiene ninguna duda que resolver: la ambigüedad aparece recién cuando un
   *    valor de cuatro o más cifras puede ser él mismo o él mismo dividido por
   *    cien;
   *  - **más a favor que en contra**: una celda que no cabe en la escala vale
   *    tanto como una que la muestra impresa, así que se comparan. No es un
   *    umbral, es el balance de la misma evidencia contada de los dos lados:
   *    veintidós valores puntuados contra dos celdas dañadas deciden, y una
   *    ancla contra siete celdas que no caben, no. Pedir **cero** en contra
   *    sería demasiado: una sola celda que el OCR rompió mandaría a revisión una
   *    columna que el papel muestra veintidós veces.
   *
   * Y cuando no se resuelve no se elige la que cierre: se conservan las dos, se
   * informa el conflicto y se pide **una sola decisión de columna**.
   */
  const sinAnclasYConDosEscalas =
    escala.anclas.length === 0 && segunda !== null && digitosMasLargos(textos) >= 4;

  // Siempre con otra hipótesis en pie: un conflicto sin segunda opción no es una
  // pregunta que alguien pueda contestar, es la única lectura que hay.
  const anclaContradicha =
    escala.anclas.length > 0 && escala.contradicen >= escala.anclas.length && segunda !== null;

  const indecidible = sinAnclasYConDosEscalas || anclaContradicha;

  const valores = textos
    .map((texto) => {
      const forma = bienEscrito(texto);
      const costo = costoBajoLaEscala(texto, forma, escala);
      return costo.reparaciones === 0 ? valorLiteral(texto, escala.separador) : null;
    })
    .filter((v): v is Decimal => v !== null);

  const paraLaMediana = valores.length > 0 ? valores : textos.map((t) => leerConEscala(t, escala) ?? new Decimal(0));
  const ordenados = [...paraLaMediana].sort((a, b) => a.comparedTo(b));
  const medio = Math.floor(ordenados.length / 2);
  const magnitudTipica =
    ordenados.length === 0
      ? new Decimal(0)
      : ordenados.length % 2 === 1
        ? ordenados[medio]
        : ordenados[medio - 1].plus(ordenados[medio]).div(2);

  const deLasAnclas = escala.anclas
    .map((t) => valorLiteral(t, escala.separador))
    .filter((v): v is Decimal => v !== null && v.gt(0))
    .sort((a, b) => a.comparedTo(b));

  const positivos = ordenados.filter((v) => v.gt(0));

  return {
    separador: escala.separador,
    decimales: escala.decimales,
    magnitudTipica,
    franja: {
      menor: positivos[0] ?? new Decimal(0),
      mayor: positivos[positivos.length - 1] ?? new Decimal(0),
    },
    franjaDeLasAnclas:
      deLasAnclas.length > 0
        ? { menor: deLasAnclas[0], mayor: deLasAnclas[deLasAnclas.length - 1] }
        : null,
    magnitudDeLasAnclas: deLasAnclas.length > 0 ? deLasAnclas[Math.floor(deLasAnclas.length / 2)] : null,
    apoyos: escala.anclas.length,
    valores: textos.length,
    porQue: escala.porQue,
    escala,
    segunda,
    margen,
    indecidible,
  };
}

/** El valor de un texto leído bajo una escala, poniendo el separador donde ella dice. */
function leerConEscala(
  texto: string,
  escala: { separador: SeparadorDecimal; decimales: number },
): Decimal | null {
  const forma = bienEscrito(texto);
  if (forma.si && forma.separador === escala.separador && forma.decimales === escala.decimales) {
    return valorLiteral(texto, escala.separador);
  }
  const digitos = texto.replace(/[.,]/g, '');
  if (!/^\d+$/.test(digitos)) return null;
  if (escala.decimales === 0) return new Decimal(digitos);
  if (digitos.length <= escala.decimales) return null;
  const enteros = digitos.slice(0, digitos.length - escala.decimales);
  const cola = digitos.slice(digitos.length - escala.decimales);
  return new Decimal(`${enteros}.${cola}`);
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
  const soloNumero = repararDigitos(sinUnidad(texto)).replace(/[^\d.,]/g, '').trim();
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

  /*
   * La lectura literal existe siempre y se conserva siempre, con el texto del
   * que salió.
   *
   * No es una cortesía: es la única lectura que no supone nada. Todo lo demás
   * —poner una coma, correrla, sacarla— es una reparación que hay que poder
   * nombrar y cobrar.
   */
  const decimalesLiterales = forma.si ? forma.decimales : 0;
  const salida: LecturaNumerica[] = variantes.map((valor, indice) => {
    const literal = indice === 0 && forma.si;
    return {
      valor,
      literal,
      decimalesEscritos: literal ? decimalesLiterales : decimalesDeLaLectura(soloNumero, valor),
      ajenaALaEscala: false,
      textoOriginal: texto,
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
   * Cuando la columna no puede decidir su escala, se ofrecen **las dos**.
   *
   * Es lo que corresponde: sin un solo valor que muestre su separador impreso,
   * elegir una sería elegir por la cuenta que cierra. Se ofrecen las dos y el
   * comprobante queda frenado; lo que no puede pasar es que una desaparezca y
   * la factura salga con una escala que nadie sostuvo.
   */
  if (formato.indecidible && formato.segunda && formato.segunda.decimales > 0) {
    const digitos = soloNumero.replace(/[.,]/g, '');
    if (/^\d+$/.test(digitos) && digitos.length > formato.segunda.decimales) {
      const corte = digitos.length - formato.segunda.decimales;
      const valor = new Decimal(`${digitos.slice(0, corte)}.${digitos.slice(corte)}`);
      if (!salida.some((l) => l.valor.eq(valor))) {
        salida.push({
          valor,
          literal: false,
          decimalesEscritos: formato.segunda.decimales,
          ajenaALaEscala: false,
          textoOriginal: texto,
          reparaciones: 1,
          severidad: 1,
          coherente: false,
          comoSeLeyo:
            `con la otra escala que la columna admite (${formato.segunda.decimales} ` +
            'decimales), porque ningún valor impreso permite descartarla',
        });
      }
    }
  }

  /*
   * Con la escala de la columna se puede hacer algo que una celda sola no
   * puede: **poner los separadores donde la columna los pone**.
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
        yaEstaba.decimalesEscritos = formato.decimales;
      } else {
        salida.push({
          valor,
          literal: false,
          decimalesEscritos: formato.decimales,
          ajenaALaEscala: false,
          textoOriginal: texto,
          reparaciones: 1,
          severidad: 1,
          coherente: true,
          comoSeLeyo,
        });
      }
    }
  }

  /*
   * Y se castiga la lectura que se va de escala, salvo que el papel la muestre
   * impresa así.
   *
   * La excepción es la que impide dividir por cien una factura legítimamente
   * cara: si la celda dice «1.250.000,00» con todos sus separadores, es un
   * millón doscientos cincuenta mil y no hay nada que discutir, por lejos que
   * quede de sus vecinas. Lo que se castiga es lo otro: un entero pelado de
   * ocho cifras en una columna de precios de cinco, que es un separador perdido
   * y no un artículo caro.
   */
  const tieneSeparadorImpreso = forma.si && forma.separador !== 'ninguno';
  for (const lectura of salida) {
    if (lectura.literal && tieneSeparadorImpreso) continue;
    const veces = cuantoSeVaDeLaFranja(lectura.valor, formato.franja);
    if (veces === null) continue;
    if (veces.gt(APARTAMIENTO_DE_ESCALA)) {
      lectura.severidad = 3;
      lectura.reparaciones = Math.max(lectura.reparaciones, 1);
      lectura.comoSeLeyo +=
        `, y queda ${veces.toFixed(0)} veces fuera de la magnitud de su columna`;
    }
  }

  marcarLasQueContradicenLoImpreso(salida, forma);
  marcarLasQueSeVanDeLaEscalaDeLaColumna(salida, formato);

  /*
   * El orden en que se ofrecen las lecturas de una celda.
   *
   * Primero se descarta lo que el papel desmiente —la celda con su separador
   * impreso, o el rango que su columna imprime— y recién después se comparan
   * las que quedan por cuánta sospecha cargan y cuánto supusieron. El nivel de
   * arriba es el que decide: es la única pregunta que se contesta con lo que
   * está impreso, y las otras dos son medidas de qué tan cómoda resulta una
   * lectura, que no es lo mismo.
   */
  return salida.sort(
    (a, b) =>
      Number(a.ajenaALaEscala) - Number(b.ajenaALaEscala) ||
      a.severidad - b.severidad ||
      a.reparaciones - b.reparaciones ||
      (a.literal ? -1 : 1),
  );
}

/**
 * Y qué lecturas **se van de la escala que anclan los valores impresos de su
 * columna**, cuando otra lectura de la misma celda sí entra en ella.
 *
 * Es el caso que no se ve mirando la celda: «186249» no tiene separadores que
 * contradecir, así que localmente las dos lecturas son igual de honestas. Lo que
 * las distingue es la columna: si tres de sus valores están impresos como
 * «1.862,49», leerlo 186.249 lo pone cien veces afuera de sus vecinos, mientras
 * que 1.862,49 cae justo encima. Esa diferencia no la puede decidir la
 * aritmética del renglón, porque si el precio y el importe se corren juntos la
 * cuenta cierra igual.
 *
 * Las dos condiciones importan. Sin anclas no se marca nada: no hay evidencia
 * impresa de escala y la duda se informa. Y sólo se marca cuando **otra lectura
 * de la misma celda** entra en la banda: si ninguna entra, el valor será raro por
 * otra razón y no hay por qué preferir una.
 */
function marcarLasQueSeVanDeLaEscalaDeLaColumna(
  lecturas: LecturaNumerica[],
  formato: FormatoDeColumna,
): void {
  const franja = formato.franjaDeLasAnclas;
  if (!franja || franja.menor.lte(0)) return;

  /*
   * Acá no hay factor, y es a propósito.
   *
   * La pregunta se contesta sola cuando dos lecturas de la **misma** celda caen
   * una adentro y otra afuera del rango que la columna tiene impreso: la de
   * adentro está donde la columna vive y la de afuera no, y los mismos dígitos
   * no pueden valer las dos cosas. Elegir la de afuera sería decir que este
   * número está escrito en otra escala que sus vecinos, teniendo a mano una
   * lectura que no lo dice.
   *
   * Poner un «más de cincuenta veces» acá era arbitrario y además fallaba:
   * en una columna de precios que va de noventa a mil doscientos, un entero
   * pelado de cinco cifras queda a cuarenta y tres veces del mayor —debajo del
   * umbral— y es exactamente la misma celda con la coma comida.
   *
   * Las dos condiciones siguen siendo necesarias: sin anclas no hay rango
   * impreso contra el cual preguntar, y si **ninguna** lectura entra en el
   * rango, el valor será raro por otra razón y no hay por qué preferir una.
   */
  const dentro = (valor: Decimal) =>
    valor.gt(0) && valor.gte(franja.menor) && valor.lte(franja.mayor);

  if (!lecturas.some((l) => dentro(l.valor))) return;

  for (const lectura of lecturas) {
    if (dentro(lectura.valor)) continue;
    lectura.ajenaALaEscala = true;
    lectura.comoSeLeyo +=
      `, y queda afuera del rango que su columna tiene impreso ` +
      `(${formato.escala.anclas.slice(0, 2).join(' y ')})`;
  }
}

/**
 * Cuánto se va un valor del rango que su columna muestra, o `null` si entra.
 *
 * Se mide contra el **borde** del rango y no contra su centro: un valor que cae
 * entre el menor y el mayor de la columna no se va nada, por lejos que esté de
 * la mediana. Lo que se busca es el salto de escala —un orden de magnitud más
 * allá de donde la columna llega— y eso empieza afuera del rango, no adentro.
 */
function cuantoSeVaDeLaFranja(
  valor: Decimal,
  franja: { menor: Decimal; mayor: Decimal },
): Decimal | null {
  if (valor.lte(0) || franja.menor.lte(0) || franja.mayor.lte(0)) return null;
  if (valor.gt(franja.mayor)) return valor.div(franja.mayor);
  if (valor.lt(franja.menor)) return franja.menor.div(valor);
  return new Decimal(1);
}

/**
 * Qué lecturas **contradicen el separador que la celda tiene impreso**.
 *
 * Es la marca que decide, y es deliberadamente local: cuando el papel muestra
 * «1.862,49», leerlo 186.249 no es una interpretación, es ignorar una coma que
 * está ahí. Eso no lo puede comprar ninguna cuenta que cierre —si el precio y el
 * importe se corren juntos, el renglón cierra igual, porque la proporción se
 * mantiene— así que se marca y pierde antes de que se mire la aritmética.
 *
 * Sobre una celda **sin** separadores impresos no hay nada que contradecir, y
 * ahí sí decide el resto de la evidencia: qué formato tiene la columna, y
 * después la aritmética. Confundir las dos cosas costó una medición: leer
 * «392 kg» como 3,92 porque la columna suele imprimir dos decimales es
 * inventarle decimales a un número que no los tiene.
 */
function marcarLasQueContradicenLoImpreso(
  lecturas: LecturaNumerica[],
  forma: ReturnType<typeof bienEscrito>,
): void {
  if (!forma.si || forma.separador === 'ninguno') return;
  for (const lectura of lecturas) {
    if (lectura.decimalesEscritos === forma.decimales) continue;
    lectura.ajenaALaEscala = true;
    lectura.comoSeLeyo +=
      `, ignorando el separador decimal que la celda tiene impreso ` +
      `(${forma.decimales} decimal/es)`;
  }
}

/**
 * Cuántos decimales tiene escrita una lectura que no es la literal.
 *
 * No se puede preguntar al `Decimal`: 15,00 y 15 son el mismo número y el
 * segundo no tiene decimales. Lo que hay que saber es cuántas cifras quedaron
 * **detrás del separador** al leerla, así que se cuenta contra los dígitos
 * impresos.
 */
function decimalesDeLaLectura(soloNumero: string, valor: Decimal): number {
  const digitos = soloNumero.replace(/[.,]/g, '').replace(/^0+(?=\d)/, '');
  const enteros = valor.trunc().abs().toFixed(0);
  const sinCeros = enteros === '0' ? '' : enteros;
  return Math.max(0, digitos.length - sinCeros.length);
}

export { bienEscrito, valorLiteral };
