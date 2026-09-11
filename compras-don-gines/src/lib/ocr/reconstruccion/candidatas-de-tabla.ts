import type { Decimal } from '@/lib/money';
import { llevaNumeros, type CampoDeColumna } from '@/lib/ocr/motor/columnas';
import { leerPie } from '@/lib/ocr/motor/motor';
import { textoDeLaEvidencia } from '@/lib/ocr/reconstruccion/texto';
import { alto, centroY, unir, type Caja, type EvidenciaDeLectura } from '@/lib/ocr/reconstruccion/evidencia';
import {
  mejorLectura,
  lecturasAlternativas,
  textoPreferido,
  type Observacion,
} from '@/lib/ocr/reconstruccion/agrupar';
import {
  ALEJAMIENTO_MAXIMO,
  agruparPedazos,
  asignarMonotonicamente,
  segundaMejorAsignacion,
  type ValorPosicionado,
} from '@/lib/ocr/reconstruccion/asignacion';
import {
  consensoDeFilas,
  hipotesisDeEsqueleto,
  referenciaRobusta,
  type Esqueleto,
} from '@/lib/ocr/reconstruccion/esqueleto';
import { aplicarSemantica } from '@/lib/ocr/reconstruccion/columnas-espaciales';
import type { ContenidoDeColumna } from '@/lib/ocr/motor/semantica-de-columnas';
import {
  armarCelda,
  reconstruirConContexto,
  type CeldaReconstruida,
  type LecturaDeCelda,
  type ContextoDeTabla,
  type RenglonReconstruido,
  type TablaReconstruida,
} from '@/lib/ocr/reconstruccion/reconstruccion';

/**
 * Varias maneras de armar la misma tabla, para que después elija la aritmética.
 *
 * La reconstrucción por cercanía resuelve la enorme mayoría de las celdas y hay
 * que conservarla tal cual: es la que acierta cuando la foto salió derecha.
 * Pero falla donde las decisiones no son independientes —los dos importes de
 * Lácteos Barraza se van los dos al primer renglón— y ahí hace falta repartir
 * la columna entera de una vez.
 *
 * La tentación es que el reparto global corrija la tabla base. **No.** Si el
 * reparto se equivoca en una celda que ya estaba bien, la corrompe y nadie se
 * entera. Lo que se hace en cambio es producir una **candidata más**,
 * completa e independiente, y dejar que compitan: si el reparto global mejora
 * el comprobante, gana con la suma contra el pie; si lo empeora, pierde y no
 * tocó nada.
 *
 * Ninguna etapa muta a la anterior. La base sale de acá igual que como entró.
 */

export interface CandidataDeReconstruccion {
  /** Cómo se armó, para poder explicar cuál ganó. */
  origen: string;
  tabla: TablaReconstruida;
  /** Qué se sabe de la cantidad de renglones, según evidencia independiente. */
  filasEsperadas: number;
  /** Por qué esta candidata puede ser buena o mala. */
  notas: string[];
}

/**
 * Las candidatas de tabla que la evidencia sostiene.
 *
 * La primera es siempre la base, sin tocar. Las demás salen de las hipótesis de
 * esqueleto con las columnas numéricas repartidas de una sola vez.
 */
export function candidatasDeTabla(
  evidencia: EvidenciaDeLectura,
): CandidataDeReconstruccion[] {
  /*
   * El pie se lee **antes** de delimitar las columnas, porque el neto impreso es
   * una evidencia sobre qué es cada columna: la de montos cuya suma da ese neto
   * es el importe del renglón, y eso lo dice el comprobante entero sin depender
   * de ningún encabezado.
   *
   * Se leen los dos netos posibles —uno por convención decimal— y se ofrecen los
   * dos. Cuál es el bueno lo decide después la interpretación completa; acá
   * alcanza con que alguno coincida, que es lo que ya sería demasiada casualidad.
   */
  const completo = textoDeLaEvidencia(evidencia).completo;
  const netosPosibles = (['ar', 'us'] as const)
    .map((convencion) => leerPie(completo, convencion).netTotal)
    .filter((neto): neto is Decimal => neto !== null && neto.gt(0));

  const { tabla, contexto } = reconstruirConContexto(evidencia, { netosPosibles });

  const esqueletos = hipotesisDeEsqueleto(
    contexto.cuerpo,
    contexto.columnas,
    contexto.alturaTipica,
  );
  const consenso = consensoDeFilas(esqueletos);

  const candidatas: CandidataDeReconstruccion[] = [
    {
      origen: 'cercanía',
      tabla: resemantizada(tabla, netosPosibles),
      filasEsperadas: consenso.esperadas,
      notas: [
        'Cada valor fue al renglón que tenía más cerca.',
        ...consenso.discrepancias,
      ],
    },
  ];

  /*
   * Una candidata por hipótesis de esqueleto, hasta tres.
   *
   * Tres porque cada una cuesta una interpretación completa del comprobante, y
   * porque las hipótesis vienen ordenadas por cuántas columnas las sostienen:
   * de la cuarta en adelante son las que ninguna otra columna acompaña.
   */
  for (const esqueleto of esqueletos.slice(0, 3)) {
    // No tiene sentido una hipótesis que dice lo mismo que la base.
    if (esqueleto.alturas.length === tabla.renglones.length && esqueleto.origen !== 'consenso') {
      continue;
    }
    const armada = armarConEsqueleto(contexto, esqueleto);
    if (!armada) continue;
    candidatas.push({
      origen: `esqueleto de ${esqueleto.origen}`,
      tabla: resemantizada(armada.tabla, netosPosibles),
      filasEsperadas: consenso.esperadas,
      notas: [esqueleto.nota, ...armada.notas, ...consenso.discrepancias],
    });

    /*
     * Y una candidata más por cada columna cuyo reparto quedó empatado, con el
     * otro reparto. Dos a lo sumo: cada una cuesta una interpretación entera del
     * comprobante, y una columna que admite tres repartos distintos no se
     * resuelve probando, se manda a revisión.
     */
    for (const columna of armada.dudosas.slice(0, 2)) {
      const otra = armarConEsqueleto(contexto, esqueleto, columna);
      if (!otra) continue;
      const nombre = contexto.columnas[columna]?.titulo ?? `columna ${columna + 1}`;
      candidatas.push({
        origen: `esqueleto de ${esqueleto.origen}, otro reparto de «${nombre}»`,
        tabla: resemantizada(otra.tabla, netosPosibles),
        filasEsperadas: consenso.esperadas,
        notas: [esqueleto.nota, ...otra.notas, ...consenso.discrepancias],
      });
    }
  }

  return candidatas;
}

/**
 * Arma una tabla entera colgando las columnas de un esqueleto dado.
 *
 * Las columnas de texto se reparten por cercanía, como siempre. Las numéricas
 * —que son las que entran en las cuentas y las que el OCR cruza entre filas— se
 * reparten **de una sola vez por columna**, conservando el orden vertical y sin
 * reutilizar ningún fragmento.
 */
function armarConEsqueleto(
  contexto: ContextoDeTabla,
  esqueleto: Esqueleto,
  /** Para qué columna usar el segundo mejor reparto en vez del primero. */
  columnaConSegundoReparto?: number,
): { tabla: TablaReconstruida; notas: string[]; dudosas: number[] } | null {
  if (esqueleto.alturas.length === 0) return null;
  const comienzo = Date.now();
  const notas: string[] = [];
  const dudosas: number[] = [];
  const { columnas, alturaTipica } = contexto;

  const filas = esqueleto.alturas.map((y) => ({ y }));
  const celdas: (CeldaReconstruida | null)[][] = filas.map(() => columnas.map(() => null));
  const sobrantes: { texto: string; caja: Caja }[][] = filas.map(() => []);

  // Todas las observaciones del cuerpo, agrupadas por la columna en la que caen.
  const porColumna: Observacion[][] = columnas.map(() => []);
  const fueraDeToda: Observacion[] = [];
  for (const renglon of contexto.cuerpo) {
    for (const observacion of renglon.observaciones) {
      const indice = columnaQueContiene(observacion, columnas);
      if (indice === null) fueraDeToda.push(observacion);
      else porColumna[indice].push(observacion);
    }
  }

  columnas.forEach((columna, indice) => {
    const observaciones = porColumna[indice];
    if (observaciones.length === 0) return;

    const campo = columna.campo?.campo;
    /*
     * Vale el reparto global para toda columna **de números**, tenga o no
     * semántica confirmada. Es lo que necesita Lácteos Barraza: sus dos importes
     * se cruzan de renglón, y si hubiera que esperar a saber que esa columna se
     * llama «Importe» para repartirlos bien, no se repartirían nunca.
     */
    const esNumerica = llevaNumeros(campo);

    /*
     * Una columna de texto **no** se reparte de a un valor por renglón.
     *
     * El reparto monótono existe porque una columna de números tiene un valor
     * por fila: eso es lo que permite decir que el segundo importe no puede ir
     * arriba del primero. Una descripción no cumple nada de eso —son cinco
     * palabras de un mismo renglón— y aplicarle la misma regla deja una palabra
     * por fila y las otras cuatro como sobrantes. Sobre la foto de Barraza, las
     * dos descripciones quedaban en «CIL» y «PLAN», con «MUZZA», «BARRAZA» y el
     * resto tirados afuera: la candidata del esqueleto reconstruía bien los
     * números y perdía los nombres de los artículos, así que no ganaba nunca.
     *
     * Para el texto vale lo de siempre: cada palabra al renglón que tiene más
     * cerca, y la celda se arma con todas las que le tocaron.
     */
    if (!esNumerica) {
      const porFila: Observacion[][] = filas.map(() => []);
      for (const observacion of observaciones) {
        const fila = filaMasCercana(centroY(observacion.caja), filas);
        const lejania = Math.abs(filas[fila].y - centroY(observacion.caja)) / (alturaTipica || 1);
        if (lejania > ALEJAMIENTO_MAXIMO) {
          sobrantes[fila].push({
            texto: textoPreferido(observacion),
            caja: observacion.caja,
          });
          continue;
        }
        porFila[fila].push(observacion);
      }
      porFila.forEach((grupo, fila) => {
        if (grupo.length > 0) celdas[fila][indice] = armarCelda(indice, grupo);
      });
      return;
    }

    /*
     * Los pedazos de un número se juntan **antes** de repartir.
     *
     * «234.997» y «69» son un solo importe; repartidos por separado, uno se va
     * a cada renglón. La unión se registra, y las partes quedan disponibles como
     * alternativas: si el número compuesto no cierra, puede cerrar una parte.
     */
    const valores: ValorConObservaciones[] = esNumerica
      ? agruparPedazos(
          observaciones.map((o) => aValor(o)),
          alturaTipica,
        ).map((grupo) => ({
          texto: grupo.texto,
          caja: grupo.caja,
          pasada: grupo.partes[0].pasada,
          confianza: Math.min(...grupo.partes.map((p) => p.confianza)),
          observaciones: grupo.partes.map((p) => p.observacion),
          compuesto: grupo.partes.length > 1,
        }))
      : observaciones.map((o) => ({ ...aValor(o), observaciones: [o], compuesto: false }));

    const compuestos = valores.filter((v) => v.compuesto).length;
    if (compuestos > 0) {
      notas.push(
        `En «${columna.titulo ?? campo ?? indice}» se compusieron ${compuestos} número/s ` +
          'a partir de pedazos que el OCR había separado.',
      );
    }

    const primera = asignarMonotonicamente(valores, filas, alturaTipica);
    const segunda = segundaMejorAsignacion(valores, filas, alturaTipica, primera);
    const noEsConcluyente = segunda !== null && segunda.costo - primera.costo < MARGEN_DE_REPARTO;

    if (noEsConcluyente) {
      dudosas.push(indice);
      notas.push(
        `El reparto de «${columna.titulo ?? campo ?? indice}» no es concluyente: ` +
          `${primera.costo.toFixed(2)} contra ${segunda!.costo.toFixed(2)}.`,
      );
    }

    /*
     * Cuando el reparto de una columna no es concluyente, **la geometría ya dio
     * todo lo que tenía**: los dos repartos están a la misma distancia y elegir
     * uno es tirar una moneda. Lo que falta decidirlo es la aritmética, y la
     * aritmética vive en el motor, no acá.
     *
     * Así que se arma una candidata con cada reparto y se dejan competir. Sobre
     * la foto de Lácteos Barraza eso importa: el importe correcto del primer
     * renglón está un renglón más arriba de donde debería, y un compuesto
     * espurio del encabezado le gana por cercanía. Por cercanía; no por la
     * cuenta.
     */
    const asignada = columnaConSegundoReparto === indice && segunda ? segunda : primera;

    asignada.porFila.forEach((valor, fila) => {
      if (!valor) return;
      celdas[fila][indice] = armarCeldaDeValor(indice, valor);
    });
    for (const sobra of asignada.sobrantes) {
      const fila = filaMasCercana(centroY(sobra.caja), filas);
      sobrantes[fila].push({ texto: sobra.texto, caja: sobra.caja });
    }
  });

  for (const observacion of fueraDeToda) {
    const fila = filaMasCercana(centroY(observacion.caja), filas);
    sobrantes[fila].push({ texto: textoPreferido(observacion), caja: observacion.caja });
  }

  /*
   * Una altura del esqueleto no es todavía un artículo.
   *
   * El esqueleto dice **dónde** puede haber un renglón; si ahí hay uno lo dicen
   * las celdas que quedaron colgadas. Sin este filtro, cada línea que el OCR vio
   * —el domicilio del emisor, la leyenda del pie, una mancha— se convierte en un
   * artículo con descripción y sin un solo número. Sobre una de las dos fotos de
   * Los Calvos eso producía dieciocho «artículos» llamados «Federal», «Aires,» y
   * «Monotributista», que es peor que no leer nada: una lista de basura larga
   * parece una lectura y hay que revisarla entera para descubrir que no lo es.
   *
   * El criterio es el mismo que usa la reconstrucción por cercanía, y por la
   * misma razón: dos celdas llenas y **un número en una columna de números**.
   * Un dígito en cualquier lado no alcanza, porque «956X30X1» está adentro de la
   * descripción de un artículo legítimo y no vuelve artículo a una línea.
   */
  const conDatos = filas
    .map((fila, i) => ({ fila, i }))
    .filter(({ i }) => esRenglonDeVerdad(celdas[i], columnas, contexto.hayColumnasNumericas));

  const descartadas = filas.length - conDatos.length;
  if (descartadas > 0) {
    notas.push(
      `${descartadas} de las ${filas.length} alturas del esqueleto no tienen datos de artículo ` +
        'y no se tomaron como renglones.',
    );
  }

  const renglones: RenglonReconstruido[] = conDatos.map(({ fila, i }) => {
    const delRenglon = celdas[i].filter((c): c is CeldaReconstruida => c !== null);
    const caja = delRenglon.length
      ? delRenglon.map((c) => c.procedencia!.caja).reduce(unir)
      : { x0: 0, y0: fila.y, x1: 1, y1: fila.y };
    return {
      y: fila.y,
      caja,
      celdas: celdas[i],
      sobrantes: sobrantes[i],
      estado:
        sobrantes[i].length > 0
          ? 'contaminado'
          : delRenglon.length === columnas.length
            ? 'completo'
            : 'incompleto',
    };
  });

  const valoresDeOtraPasada = renglones.reduce(
    (total, renglon) =>
      total +
      renglon.celdas.filter(
        (c) => c?.procedencia && c.procedencia.pasada !== 'completo:directo',
      ).length,
    0,
  );

  return {
    notas,
    dudosas,
    tabla: {
      columnas,
      metodo: contexto.metodo,
      encabezados: contexto.encabezados,
      renglones,
      filasVisibles: contexto.cuerpo.length,
      inclinacionGrados: contexto.inclinacionGrados,
      seEnderezo: contexto.seEnderezo,
      alturaTipica,
      notas: [...contexto.notas, ...notas],
      valoresDeOtraPasada,
      ms: Date.now() - comienzo,
    },
  };
}

/**
 * La misma tabla, con las columnas releídas sobre **sus propias celdas**.
 *
 * Cada candidata es una hipótesis completa e independiente, y eso incluye qué
 * significa cada columna. Con las celdas repartidas de otra manera, la columna
 * se ve distinta: sobre la foto de Lácteos Barraza los dos importes caen en la
 * misma línea visual, así que en la tabla base la columna «Importe» es una sola
 * celda que dice «234.997238,234.2346975» —ni monto ni nada— y en la del
 * esqueleto son dos montos limpios. La segunda merece que se le crea al
 * encabezado; la primera, no.
 *
 * Los límites no se tocan y la tabla original tampoco: sale una copia.
 */
function resemantizada(tabla: TablaReconstruida, netosPosibles: Decimal[]): TablaReconstruida {
  if (tabla.columnas.length === 0) return tabla;

  const contenidos: ContenidoDeColumna[] = tabla.columnas.map((columna, i) => ({
    titulo: columna.titulo,
    desde: columna.desde,
    hasta: columna.hasta,
    celdas: tabla.renglones.map((renglon) => renglon.celdas[i]?.texto ?? ''),
  }));

  const notas = [...tabla.notas];
  return {
    ...tabla,
    columnas: aplicarSemantica(tabla.columnas, contenidos, netosPosibles, notas),
    notas,
  };
}

/** ¿Estas celdas son un artículo, o una línea suelta que cayó a esa altura? */
function esRenglonDeVerdad(
  celdas: (CeldaReconstruida | null)[],
  columnas: { campo: { campo: CampoDeColumna } | null }[],
  hayColumnasNumericas: boolean,
): boolean {
  const llenas = celdas.filter((c) => c !== null && (c.texto ?? '').trim() !== '');
  if (llenas.length < 2) return false;

  return celdas.some((celda, i) => {
    if (celda === null || !/\d/.test(celda.texto ?? '')) return false;
    if (!hayColumnasNumericas) return true;
    return llevaNumeros(columnas[i]?.campo?.campo);
  });
}

/** Cuánta ventaja tiene que sacar un reparto para creerle, en alturas de renglón. */
const MARGEN_DE_REPARTO = 1;

interface ValorConObservaciones extends ValorPosicionado {
  observaciones: Observacion[];
  /** Se armó juntando pedazos que el OCR había separado. */
  compuesto: boolean;
}

function aValor(observacion: Observacion): ValorPosicionado & { observacion: Observacion } {
  const lectura = mejorLectura(observacion);
  return {
    texto: textoPreferido(observacion),
    caja: observacion.caja,
    pasada: lectura.pasada,
    confianza: lectura.confianza,
    observacion,
  };
}

/**
 * La celda que sale de un valor repartido.
 *
 * Cuando el valor se compuso de varios pedazos, las partes quedan como
 * alternativas: si el número entero no hace cerrar el renglón, una parte puede.
 * Nada se repara en silencio.
 */
function armarCeldaDeValor(columna: number, valor: ValorConObservaciones): CeldaReconstruida {
  const alternativas = valor.observaciones.flatMap((o) => lecturasAlternativas(o));
  const lectura = mejorLectura(valor.observaciones[0]);

  /*
   * Un número compuesto se ofrece **de todas las maneras en que puede unirse**.
   *
   * El OCR corta «234.997,69» en «234.997» y «69», y pegarlos a secas da
   * «23499769», que no es el número: falta el separador decimal que se perdió
   * justo en el corte. Cuál va —coma o punto— depende de la convención del
   * comprobante, que todavía no está decidida.
   *
   * Así que no se elige: se ofrecen las tres uniones posibles como alternativas
   * y decide la aritmética del renglón, igual que con cualquier otra ambigüedad.
   * El original de cada pedazo queda entre las alternativas, así que nada se
   * repara en silencio.
   */
  const uniones = valor.compuesto ? unionesPosibles(valor) : [];

  const todas = valor.compuesto ? [...uniones, ...alternativas] : alternativas;

  const unicas = todas.filter((a, i) => todas.findIndex((b) => b.texto === a.texto) === i);

  return {
    columna,
    texto: unicas[0]?.texto ?? valor.texto,
    alternativas: unicas,
    estado: unicas.length > 1 ? 'ambigua' : 'leida',
    procedencia: { pasada: lectura.pasada, confianza: valor.confianza, caja: valor.caja },
  };
}

/**
 * Las maneras de unir los pedazos de un número, la más simple primero.
 *
 * Sólo se ofrece la unión con separador cuando el último pedazo tiene dos
 * dígitos: son los centavos. Con tres, el corte fue en un separador de miles y
 * pegar a secas es lo correcto.
 */
function unionesPosibles(valor: ValorConObservaciones): LecturaDeCelda[] {
  const partes = [...valor.observaciones]
    .sort((a, b) => a.caja.x0 - b.caja.x0)
    .map((o) => textoPreferido(o));
  if (partes.length < 2) return [];

  const lectura = mejorLectura(valor.observaciones[0]);
  const base = { caja: valor.caja, pasada: lectura.pasada, confianza: valor.confianza };

  const pegado = partes.join('');
  const uniones = [pegado];

  const ultimo = partes[partes.length - 1];
  if (/^\d{2}$/.test(ultimo)) {
    const cabeza = partes.slice(0, -1).join('');
    uniones.push(`${cabeza},${ultimo}`, `${cabeza}.${ultimo}`);
  }

  return uniones.map((texto) => ({ texto, ...base }));
}

function columnaQueContiene(observacion: Observacion, columnas: { desde: number; hasta: number }[]) {
  let mejor: number | null = null;
  let mejorSolape = 0;
  columnas.forEach((columna, i) => {
    const solape =
      Math.min(observacion.caja.x1, columna.hasta) - Math.max(observacion.caja.x0, columna.desde);
    if (solape > mejorSolape) {
      mejorSolape = solape;
      mejor = i;
    }
  });
  const ancho = observacion.caja.x1 - observacion.caja.x0;
  return mejor !== null && mejorSolape >= ancho / 3 ? mejor : null;
}

function filaMasCercana(y: number, filas: { y: number }[]): number {
  let mejor = 0;
  let distancia = Infinity;
  filas.forEach((fila, i) => {
    const suya = Math.abs(fila.y - y);
    if (suya < distancia) {
      distancia = suya;
      mejor = i;
    }
  });
  return mejor;
}

export { referenciaRobusta, alto };
