import {
  alto,
  ancho,
  centroX,
  centroY,
  solapeHorizontal,
  solapeVertical,
  unir,
  type Caja,
} from '@/lib/ocr/reconstruccion/evidencia';
import type { FragmentoEnderezado } from '@/lib/ocr/reconstruccion/inclinacion';

/**
 * Juntar lo que dicen varias pasadas del OCR sobre el mismo pedazo de papel.
 *
 * Cada pasada lee la página entera o una franja, con una preparación distinta,
 * y todas leen cosas que las otras no. La tentación es quedarse con la mejor
 * pasada; el problema es que **no hay una mejor**: sobre la misma factura, la
 * pasada sin limpiar trae las filas tenues y la limpiada trae las que tenían
 * ruido alrededor. Lo que hace falta es poder armar un renglón con una celda de
 * una y otra celda de otra.
 *
 * Entonces acá no se elige: se **agrupa por lugar**. Dos fragmentos que ocupan
 * el mismo pedazo de página son el mismo dato leído dos veces. Si dicen lo
 * mismo, se refuerzan; si dicen distinto, quedan los dos como alternativas y
 * decide después la aritmética.
 */

/**
 * Un dato del papel, con todas las lecturas que hizo el OCR de él.
 *
 * Es lo que reemplaza al fragmento suelto: una posición en la página y las
 * versiones que trajo cada pasada.
 */
export interface Observacion {
  /**
   * Dónde está, en el **espacio canónico**: normalizado a 0..1 de la página y
   * enderezado.
   *
   * Toda decisión geométrica del motor —qué renglón, qué columna, qué se pisa
   * con qué, dónde empieza y termina la tabla— se toma en este espacio y sólo
   * en éste. Tener dos sistemas conviviendo es lo que hacía que la corrección
   * de inclinación se perdiera justo en las celdas con más apoyo, que son las
   * que juntan varias pasadas.
   */
  caja: Caja;
  lecturas: Lectura[];
}

export interface Lectura {
  texto: string;
  confianza: number;
  pasada: string;
  /** Dónde está en el espacio canónico. Es la que se usa para decidir. */
  caja: Caja;
  /**
   * Dónde está en la foto tal como salió, sin enderezar.
   *
   * Es **sólo procedencia**: sirve para señalarle el dato a una persona sobre
   * su propia foto y para poder auditar la corrección de inclinación. No se
   * decide nada con ella.
   */
  cajaEnLaFoto: Caja;
  /** Las otras lecturas que el propio OCR consideró para esta palabra. */
  alternativas: string[];
}

/** El texto que gana por ahora: el de mayor confianza, reforzado por acuerdo. */
export function textoPreferido(observacion: Observacion): string {
  return mejorLectura(observacion).texto;
}

/**
 * Cuánto respaldo tiene una observación: cuántas pasadas la vieron y con cuánta
 * confianza.
 *
 * No es lo mismo que la confianza de su mejor lectura. Un dato que cinco
 * pasadas leyeron —aunque ninguna con mucha seguridad— es mejor evidencia que
 * uno que apareció una sola vez, y es esa diferencia la que decide, más abajo,
 * entre «el OCR partió este importe en dos» y «acá hay dos palabras».
 *
 * El piso importa: Tesseract devuelve confianza cero para palabras que están
 * perfectamente bien —«MANI» sale en cero en una pasada y en 0,96 en otras
 * tres— y sin piso una observación así valdría exactamente lo mismo que no
 * existir. Que una pasada la haya visto ya es evidencia.
 */
export function apoyo(observacion: Observacion): number {
  return observacion.lecturas.reduce((suma, l) => suma + Math.max(l.confianza, PISO_DE_APOYO), 0);
}

const PISO_DE_APOYO = 0.05;

/**
 * ¿Está este texto escrito como un número, y nada más que como un número?
 *
 * Dígitos y separadores, con al menos un dígito. Es lo que permite decir que a
 * una lectura «le falta la cola»: en un número, lo que sigue son más dígitos y
 * no puede ser otra cosa.
 */
function esUnNumeroEscrito(texto: string): boolean {
  const limpio = texto.trim();
  return /^[\d.,]+$/.test(limpio) && /\d/.test(limpio);
}

export function mejorLectura(observacion: Observacion): Lectura {
  /*
   * Gana la lectura con más apoyo, y el apoyo es confianza más acuerdo.
   *
   * Que dos pasadas distintas lean lo mismo vale más que una sola pasada muy
   * confiada: son dos preparaciones distintas de la imagen coincidiendo, y eso
   * es evidencia independiente. Un 0,90 apoyado por otra pasada le gana a un
   * 0,95 solo.
   */
  const puntajes = new Map<string, number>();
  for (const lectura of observacion.lecturas) {
    puntajes.set(lectura.texto, (puntajes.get(lectura.texto) ?? 0) + lectura.confianza);
  }

  /*
   * Y una lectura **truncada no compite**: le falta un pedazo, no dice otra cosa.
   *
   * «3.362,» es «3.362,66» con los centavos comidos, y sumar su confianza como
   * si fuera una lectura distinta cuenta la mutilación a favor de ella misma.
   * Sobre una factura del lote eso ganaba la celda con dos pasadas que habían
   * leído «3.362,» —0,94 y 0,95— contra las dos que leyeron el número entero, y
   * el importe verdadero quedaba de alternativa. Después una tolerancia
   * aritmética de un centavo lo daba por bueno igual, que es exactamente la
   * manera de convertir una lectura mala en un valor confirmado.
   *
   * Se pide **prefijo estricto**: no que se parezca, sino que el texto entero
   * esté al principio de otro de la misma celda. Y su apoyo no se le regala a
   * nadie: si dos lecturas la extienden, la truncada no dice cuál de las dos es.
   *
   * Y sólo entre **números**. En un número la cola que falta es una cola de
   * dígitos y no hay nada más que pueda ser; en una descripción, lo que viene
   * después puede ser basura pegada, y preferir la larga por larga metía en el
   * renglón un «ALMA MORA RESERVA MALBEC (6) de.» con la cola de la línea de
   * abajo. Ahí la lectura corta no está truncada: está limpia.
   */
  const textos = [...puntajes.keys()];
  const truncadas = new Set(
    textos.filter(
      (texto) =>
        esUnNumeroEscrito(texto) &&
        textos.some(
          (otro) => otro !== texto && esUnNumeroEscrito(otro) && otro.startsWith(texto),
        ),
    ),
  );

  /*
   * Nunca quedan todas afuera: el texto más largo de la celda no es prefijo de
   * ninguno, así que siempre sobrevive al menos uno. Una celda que el OCR leyó
   * a medias en todas sus pasadas se queda con la lectura **más completa** que
   * alguna haya alcanzado, y lo que falte lo resuelve quien mire el número.
   */
  let mejor = observacion.lecturas[0];
  let mejorPuntaje = -1;
  for (const lectura of observacion.lecturas) {
    if (truncadas.has(lectura.texto)) continue;
    const puntaje = puntajes.get(lectura.texto)!;
    if (puntaje > mejorPuntaje) {
      mejorPuntaje = puntaje;
      mejor = lectura;
    }
  }
  return mejor;
}

/**
 * Todas las lecturas distintas de una observación, la ganadora primero y **con
 * su procedencia**.
 *
 * Que cada alternativa traiga de qué pasada salió, con qué confianza y dónde
 * está en la foto es lo que permite después mostrarle a una persona las dos
 * opciones señalando cada una en la imagen, en vez de pedirle que elija entre
 * dos cadenas de texto sin contexto.
 */
export function lecturasAlternativas(observacion: Observacion): LecturaDeCelda[] {
  const ganadora = mejorLectura(observacion);
  const salida: LecturaDeCelda[] = [
    {
      texto: ganadora.texto,
      caja: ganadora.caja,
      cajaEnLaFoto: ganadora.cajaEnLaFoto,
      pasada: ganadora.pasada,
      confianza: ganadora.confianza,
    },
  ];
  const vistos = new Set([ganadora.texto]);

  for (const lectura of observacion.lecturas) {
    if (vistos.has(lectura.texto)) continue;
    vistos.add(lectura.texto);
    salida.push({
      texto: lectura.texto,
      caja: lectura.caja,
      cajaEnLaFoto: lectura.cajaEnLaFoto,
      pasada: lectura.pasada,
      confianza: lectura.confianza,
    });
  }

  // Las que ofreció el propio Tesseract para esa palabra: no son de otra
  // pasada, así que llevan la caja y la pasada de la lectura que las propuso.
  for (const lectura of observacion.lecturas) {
    for (const alternativa of lectura.alternativas) {
      if (vistos.has(alternativa)) continue;
      vistos.add(alternativa);
      salida.push({
        texto: alternativa,
        caja: lectura.caja,
        cajaEnLaFoto: lectura.cajaEnLaFoto,
        pasada: lectura.pasada,
        confianza: lectura.confianza,
        delPropioOcr: true,
      });
    }
  }

  return salida;
}

/** Una lectura posible de una celda, con todo lo que hace falta para auditarla. */
export interface LecturaDeCelda {
  texto: string;
  /** En el espacio canónico. */
  caja: Caja;
  /** En la foto, para señalarla. Sólo procedencia. */
  cajaEnLaFoto: Caja;
  pasada: string;
  confianza: number;
  /** La propuso el propio OCR como segunda opción de esa misma palabra. */
  delPropioOcr?: boolean;
}

/** Sólo los textos, para quien no necesita la procedencia. */
export function textosAlternativos(observacion: Observacion): string[] {
  return lecturasAlternativas(observacion).map((l) => l.texto);
}

/**
 * Agrupa fragmentos de distintas pasadas que ocupan el mismo lugar.
 *
 * Dos fragmentos son el mismo dato cuando sus cajas se solapan lo bastante en
 * las dos direcciones. El umbral es en fracción del tamaño del fragmento más
 * chico y no en unidades absolutas: un recorte ampliado da cajas apenas
 * distintas de las de la página entera, y pedir coincidencia exacta dejaría
 * todo duplicado.
 *
 * Lo que **no** hace es juntar dos fragmentos que sólo se rozan. Dos columnas
 * numéricas pegadas se tocan por unos píxeles, y fundirlas sería perder una de
 * las dos: por eso se pide que el solapamiento sea la mayor parte del fragmento
 * chico, no una esquina.
 */
export function agruparPorLugar(fragmentos: FragmentoEnderezado[]): Observacion[] {
  const ordenados = [...fragmentos].sort((a, b) => a.caja.y0 - b.caja.y0 || a.caja.x0 - b.caja.x0);
  const observaciones: Observacion[] = [];

  for (const fragmento of ordenados) {
    const lectura: Lectura = {
      texto: fragmento.texto,
      confianza: fragmento.confianza,
      pasada: fragmento.pasada,
      caja: fragmento.caja,
      cajaEnLaFoto: fragmento.cajaOriginal,
      alternativas: fragmento.alternativas ?? [],
    };

    const candidata = observaciones.find(
      (o) => esElMismoDato(o.caja, fragmento.caja) && !o.lecturas.some((l) => l.pasada === fragmento.pasada),
    );

    if (candidata) {
      candidata.lecturas.push(lectura);
      // La caja de consenso se queda con la de la lectura que manda.
      candidata.caja = mejorLectura(candidata).caja;
    } else {
      observaciones.push({ caja: fragmento.caja, lecturas: [lectura] });
    }
  }

  return observaciones;
}

/**
 * La caja de la observación **sin la pasada que se le fue de ancho**: la
 * mediana de las cajas de las lecturas cuyo texto ganó.
 *
 * No reemplaza a `caja` —esa es la que se señala en la foto y con la que se
 * arman los renglones y el pie, y moverla cambia la reconstrucción entera— sino
 * que se usa donde hace falta preguntar **qué lugar ocupa** un dato: al decidir
 * si dos observaciones son la misma cosa leída dos veces.
 *
 * Sin esto, una sola pasada con el recorte corrido decide por las otras cuatro:
 * en la factura de Errecalde las cinco leen «PUNTA», cuatro le dan su ancho real
 * y la quinta se lo estira hasta tapar «DE AGUA», con lo que «PUNTA» y «AGUA»
 * pasan a ocupar el mismo lugar, una de las dos sobra y la descripción sale
 * «BARRA DANBO DE AGUA». La mediana aguanta hasta la mitad de cajas mal puestas.
 *
 * Se toman sólo las lecturas cuyo texto ganó. Mezclar las cajas de lecturas que
 * dicen cosas distintas sería promediar dos hipótesis, y acá no se promedia
 * nada: se elige una y se conserva la otra.
 */
export function cajaRobusta(observacion: Observacion): Caja {
  const gana = mejorLectura(observacion).texto;
  const suyas = observacion.lecturas.filter((l) => l.texto === gana);
  const mediana = (valores: number[]) => {
    const orden = [...valores].sort((a, b) => a - b);
    return orden[Math.floor(orden.length / 2)];
  };
  const x0 = mediana(suyas.map((l) => l.caja.x0));
  const x1 = mediana(suyas.map((l) => l.caja.x1));
  const y0 = mediana(suyas.map((l) => l.caja.y0));
  const y1 = mediana(suyas.map((l) => l.caja.y1));
  return { x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: Math.min(y0, y1), y1: Math.max(y0, y1) };
}

/**
 * ¿Son dos lecturas del mismo dato?
 *
 * Se pide que se solapen en más de la mitad del más chico, en los dos ejes. La
 * condición «una sola lectura por pasada» que se aplica arriba es la otra mitad
 * de la regla: dos palabras vecinas de la **misma** pasada nunca son el mismo
 * dato, por mucho que se toquen, porque el OCR ya decidió que eran dos.
 */
function esElMismoDato(a: Caja, b: Caja): boolean {
  const anchoMinimo = Math.min(ancho(a), ancho(b));
  const altoMinimo = Math.min(alto(a), alto(b));
  if (anchoMinimo <= 0 || altoMinimo <= 0) return false;
  return (
    solapeHorizontal(a, b) > anchoMinimo * 0.5 && solapeVertical(a, b) > altoMinimo * 0.5
  );
}

// ---------------------------------------------------------------------------
// Renglones
// ---------------------------------------------------------------------------

/**
 * Una hipótesis de renglón: las observaciones que están a la misma altura.
 */
export interface RenglonVisual {
  observaciones: Observacion[];
  caja: Caja;
  /** El centro vertical, que es por lo que se ordenan. */
  y: number;
}

/**
 * Arma renglones por cercanía vertical.
 *
 * Se recorre de arriba hacia abajo y cada observación entra al renglón abierto
 * si comparte altura con él. «Compartir altura» se mide con el solapamiento
 * vertical y no con la distancia entre centros: en una misma línea conviven un
 * código en versalitas y una descripción en mayúsculas, y sus centros no
 * coinciden aunque las cajas se pisen casi enteras.
 *
 * El corte es por **fracción del alto típico de renglón**, que sale de la
 * propia evidencia. Con un umbral absoluto, la misma factura fotografiada más
 * de cerca partiría cada renglón en varios.
 */
export function armarRenglones(
  observaciones: Observacion[],
  alturaTipica: number,
): RenglonVisual[] {
  const ordenadas = [...observaciones].sort((a, b) => centroY(a.caja) - centroY(b.caja));
  const renglones: RenglonVisual[] = [];
  /*
   * La referencia de cada renglón es el **promedio de los centros** de lo que
   * ya entró, no el centro de la caja que los contiene a todos.
   *
   * Es una diferencia que parece de detalle y no lo es. La caja que contiene
   * crece con cada celda, y con ella se mueve su centro: sobre la foto de Ezra,
   * un renglón con ocho celdas terminaba con el centro medio renglón más abajo
   * del que tenía al empezar, alcanzaba la fila siguiente y se la comía. Los
   * seis artículos salían fundidos de a dos, con los textos concatenados y los
   * importes multiplicados por mil millones.
   *
   * El promedio, en cambio, no se corre: cada celda nueva lo mueve menos que la
   * anterior, porque son todas del mismo renglón y están a la misma altura.
   */
  const centros: number[][] = [];

  for (const observacion of ordenadas) {
    const y = centroY(observacion.caja);
    const ultimo = renglones.length - 1;
    if (ultimo >= 0 && comparteAltura(renglones[ultimo].y, observacion.caja, alturaTipica)) {
      renglones[ultimo].observaciones.push(observacion);
      renglones[ultimo].caja = unir(renglones[ultimo].caja, observacion.caja);
      centros[ultimo].push(y);
      renglones[ultimo].y = centros[ultimo].reduce((a, b) => a + b, 0) / centros[ultimo].length;
      continue;
    }
    renglones.push({ observaciones: [observacion], caja: observacion.caja, y });
    centros.push([y]);
  }

  for (const renglon of renglones) {
    renglon.observaciones.sort((a, b) => a.caja.x0 - b.caja.x0);
  }
  return renglones;
}

/**
 * ¿Está la observación a la altura del renglón que se viene armando?
 *
 * Se compara contra la altura de referencia del renglón —el promedio de los
 * centros de sus celdas— y no contra su caja, por lo dicho arriba.
 */
function comparteAltura(yDelRenglon: number, observacion: Caja, alturaTipica: number): boolean {
  return Math.abs(yDelRenglon - centroY(observacion)) <= alturaTipica * 0.6;
}

/**
 * Junta observaciones contiguas que son pedazos de una misma palabra.
 *
 * El OCR parte palabras: «22.800,00» sale «22.800» y «,00», y una descripción
 * larga sale en tres tramos. Se pegan cuando están pegadas de verdad —menos de
 * un cuarto de letra de separación— y no cuando hay un espacio de columna en el
 * medio.
 *
 * Sólo se pegan pedazos **compatibles**: dos tramos numéricos, o dos tramos de
 * texto. Pegar un número con una palabra es lo que produce «4,240 Cremoso» en
 * una sola celda y arranca el corrimiento de columnas.
 */
export function unirPartidas(renglon: RenglonVisual, alturaTipica: number): Observacion[] {
  const salida: Observacion[] = [];
  const separacionMaxima = alturaTipica * 0.25;

  for (const observacion of renglon.observaciones) {
    const previa = salida[salida.length - 1];
    if (
      previa &&
      observacion.caja.x0 - previa.caja.x1 >= 0 &&
      observacion.caja.x0 - previa.caja.x1 < separacionMaxima &&
      mismaClase(textoPreferido(previa), textoPreferido(observacion))
    ) {
      salida[salida.length - 1] = {
        caja: unir(previa.caja, observacion.caja),
        lecturas: [
          {
            texto: `${textoPreferido(previa)}${textoPreferido(observacion)}`,
            confianza: Math.min(
              mejorLectura(previa).confianza,
              mejorLectura(observacion).confianza,
            ),
            pasada: mejorLectura(previa).pasada,
            caja: unir(mejorLectura(previa).caja, mejorLectura(observacion).caja),
            cajaEnLaFoto: unir(
              mejorLectura(previa).cajaEnLaFoto,
              mejorLectura(observacion).cajaEnLaFoto,
            ),
            alternativas: [],
          },
        ],
      };
      continue;
    }
    salida.push(observacion);
  }

  return salida;
}

/** ¿Los dos tramos son de la misma naturaleza? */
function mismaClase(a: string, b: string): boolean {
  return esNumerico(a) === esNumerico(b);
}

/** ¿Es un pedazo de número, o de texto? */
export function esNumerico(texto: string): boolean {
  return /^[\d.,%$-]+$/.test(texto);
}

// ---------------------------------------------------------------------------
// Cómo se reparte una celda entre varias observaciones
// ---------------------------------------------------------------------------

/**
 * Cómo queda repartida una celda a la que llegaron varias observaciones.
 *
 * `partes` son las que se leen una al lado de la otra —las palabras de una
 * descripción, los dos pedazos de un importe que el OCR cortó por la coma— y
 * `alternativas` las que **ocupaban el mismo lugar** que alguna de ellas: no son
 * un pedazo más, son otra manera de leer lo mismo.
 */
export interface RepartoDeCelda {
  partes: Observacion[];
  alternativas: Observacion[];
}

/**
 * Separa lo que va uno al lado del otro de lo que es la misma cosa leída dos veces.
 *
 * Es la corrección del defecto más transversal que dejó la validación ciega. La
 * regla anterior era pegar todo lo que cayera en la misma columna del mismo
 * renglón, y eso produce texto que no existe en ningún papel:
 * «27.937,3527937,35» —una pasada leyó el importe entero y otra lo partió en
 * «27» y «937,35»—, «MANI SAL SAL PELADO», «300052820300052820».
 *
 * Lo que distingue un caso del otro es geométrico y no textual: **dos pedazos de
 * una descripción no se pisan**, están uno después del otro. Dos lecturas de la
 * misma cosa sí se pisan, y se pisan en los dos ejes: dos importes de renglones
 * distintos comparten la columna entera sin ser el mismo dato, así que el
 * solapamiento horizontal solo no alcanza para decidirlo.
 *
 * Entre las que se pisan gana la de más **apoyo** —cuántas pasadas la vieron y
 * con cuánta confianza—, y eso es lo que resuelve los dos casos simétricos, que
 * sin él serían indistinguibles: «MANI» y «SAL» los vieron cuatro pasadas cada
 * uno y «MANISAL» una sola, así que gana el par; «27.937,35» lo vieron tres y el
 * corte «27»+«937,35» una, así que gana el entero. Lo que pierde no se tira:
 * queda como alternativa de la celda, con su pasada y su caja.
 */
export function repartirCelda(competidoras: Observacion[]): RepartoDeCelda {
  if (competidoras.length <= 1) return { partes: [...competidoras], alternativas: [] };

  /*
   * La tolerancia sale del alto de las propias cajas, como todo lo demás acá:
   * la misma factura fotografiada más de cerca tiene que repartirse igual. Se
   * toma la mediana y no el promedio porque una mota de tinta o un borde leído
   * como letra son cajas de alto absurdo, y arrastrarían el umbral.
   */
  const cajas = new Map(competidoras.map((o) => [o, cajaRobusta(o)]));
  const altos = [...cajas.values()].map((c) => alto(c)).sort((a, b) => a - b);
  const tolerancia = altos[Math.floor(altos.length / 2)] * 0.3;

  const sePisan = (a: Observacion, b: Observacion) => {
    const ca = cajas.get(a)!;
    const cb = cajas.get(b)!;
    return (
      solapeHorizontal(ca, cb) > tolerancia &&
      solapeVertical(ca, cb) > Math.min(alto(ca), alto(cb)) * 0.5
    );
  };

  /*
   * Se recorren de mayor a menor apoyo y entra la que no se pisa con ninguna de
   * las ya elegidas. Los desempates son por posición y por texto para que el
   * reparto sea el mismo en cada corrida.
   */
  const porApoyo = [...competidoras].sort(
    (a, b) =>
      apoyo(b) - apoyo(a) ||
      a.caja.x0 - b.caja.x0 ||
      textoPreferido(a).localeCompare(textoPreferido(b)),
  );

  const partes: Observacion[] = [];
  const alternativas: Observacion[] = [];
  for (const candidata of porApoyo) {
    if (partes.some((elegida) => sePisan(elegida, candidata))) alternativas.push(candidata);
    else partes.push(candidata);
  }

  return { partes: partes.sort((a, b) => a.caja.x0 - b.caja.x0), alternativas };
}

export { centroX, centroY };
