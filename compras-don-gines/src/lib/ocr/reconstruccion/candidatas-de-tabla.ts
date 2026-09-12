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
  mejoresAsignaciones,
  type Asignacion,
  type ValorPosicionado,
} from '@/lib/ocr/reconstruccion/asignacion';
import {
  consensoDeFilas,
  hipotesisDeEsqueleto,
  referenciaRobusta,
  type Esqueleto,
} from '@/lib/ocr/reconstruccion/esqueleto';
import { aplicarSemantica } from '@/lib/ocr/reconstruccion/columnas-espaciales';
import {
  relacionesAritmeticas,
  type ContenidoDeColumna,
} from '@/lib/ocr/motor/semantica-de-columnas';
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
   * Una candidata por hipótesis de esqueleto, hasta tres, y dentro de cada una
   * **las combinaciones de repartos que la aritmética sostiene**.
   *
   * Tres esqueletos porque cada uno cuesta una interpretación completa del
   * comprobante, y porque vienen ordenados por cuántas columnas los sostienen:
   * del cuarto en adelante son los que ninguna otra columna acompaña.
   */
  for (const esqueleto of esqueletos.slice(0, 3)) {
    // No tiene sentido una hipótesis que dice lo mismo que la base.
    if (esqueleto.alturas.length === tabla.renglones.length && esqueleto.origen !== 'consenso') {
      continue;
    }
    if (esqueleto.alturas.length === 0) continue;

    if (candidatas.length >= CANDIDATAS_MAXIMAS) break;

    const filas = esqueleto.alturas.map((y) => ({ y }));
    const preparado = prepararColumnas(contexto, filas);

    for (const combinacion of combinacionesDeReparto(contexto, preparado, filas, esqueleto)) {
      if (candidatas.length >= CANDIDATAS_MAXIMAS) break;
      const armada = armarConEsqueleto(contexto, esqueleto, preparado, filas, combinacion.eleccion);
      if (!armada) continue;
      candidatas.push({
        origen: `esqueleto de ${esqueleto.origen}${combinacion.nombre}`,
        tabla: resemantizada(armada.tabla, netosPosibles),
        filasEsperadas: consenso.esperadas,
        notas: [esqueleto.nota, ...armada.notas, ...consenso.discrepancias],
      });
    }
  }

  return candidatas;
}

/**
 * Cuántos repartos se conservan por columna, y cuántas combinaciones se prueban.
 *
 * Dos por columna: el mejor y el que le discute. Un tercero ya no es una duda
 * entre dos lecturas, es una columna ilegible, y eso se informa en vez de
 * probarse.
 *
 * Seis combinaciones en total. El número importa porque cada una cuesta una
 * interpretación entera del comprobante: con tres columnas en duda hay ocho
 * combinaciones posibles, y quedarse con las seis mejores según la aritmética
 * es lo que mantiene el costo acotado sin perder la que cierra.
 */
const REPARTOS_POR_COLUMNA = 2;
const COMBINACIONES_MAXIMAS = 6;

/**
 * Cuántas tablas candidatas se interpretan enteras, contando la base.
 *
 * Cada una cuesta una interpretación completa del comprobante con las dos
 * convenciones decimales, que sobre una factura de cuarenta renglones no es
 * gratis. Ocho alcanza para probar la base, las combinaciones que la aritmética
 * favorece del mejor esqueleto y alguna del segundo; más que eso es gastar
 * segundos en hipótesis que ya perdieron.
 */
const CANDIDATAS_MAXIMAS = 8;

/**
 * Las combinaciones de repartos que vale la pena interpretar enteras.
 *
 * Éste es el punto que el reparto columna por columna no puede resolver. Cada
 * columna, mirada sola, elige su mejor asignación geométrica; y la combinación
 * correcta a veces no está formada por las mejores de cada una. Sobre la foto de
 * Lácteos Barraza los dos «16,00» de bonificación están impresos casi a la misma
 * altura y una mala lectura del segundo —«42»— cae un poco más cerca del segundo
 * renglón: por distancia gana «42», y la columna de bonificaciones mirada sola no
 * tiene con qué saber que se equivoca.
 *
 * Con qué saberlo tienen las columnas **juntas**: 30 × 9.453,76 × 0,84 da
 * 238.234,75, que es el importe impreso, y con 42 % no da nada parecido. Así que
 * se combinan los repartos y se puntúa cada combinación por cuántos renglones
 * hace cerrar, antes de gastar una interpretación completa en ella.
 *
 * El descarte es temprano y barato: la unicidad y el orden ya los garantiza cada
 * reparto por construcción, y lo que se mide acá es sólo la aritmética. Después,
 * las que sobreviven compiten contra el pie como cualquier otra candidata.
 */
function combinacionesDeReparto(
  contexto: ContextoDeTabla,
  preparado: { preparadas: ColumnaPreparada[]; fueraDeToda: Observacion[] },
  filas: { y: number }[],
  esqueleto: Esqueleto,
): { eleccion: Map<number, number>; nombre: string }[] {
  /*
   * Sólo entran al producto las columnas cuyo mejor reparto **no le saca
   * ventaja** al segundo. Una columna donde la geometría decidió con holgura no
   * tiene nada que discutir, y meterla en la combinatoria duplica el trabajo
   * para volver siempre a la misma respuesta.
   */
  const enDuda = preparado.preparadas.filter((c) => c.esNumerica && c.dudosa);

  if (enDuda.length === 0) return [{ eleccion: new Map(), nombre: '' }];

  // El producto cartesiano de los repartos de las columnas en duda.
  let combinaciones: Map<number, number>[] = [new Map()];
  for (const columna of enDuda) {
    const siguiente: Map<number, number>[] = [];
    for (const parcial of combinaciones) {
      for (let cual = 0; cual < columna.asignaciones.length; cual++) {
        const copia = new Map(parcial);
        copia.set(columna.indice, cual);
        siguiente.push(copia);
      }
    }
    combinaciones = siguiente;
    // Tope duro contra la explosión: con seis columnas en duda serían sesenta y
    // cuatro combinaciones, y ninguna factura necesita eso para leerse.
    if (combinaciones.length > 64) {
      combinaciones = combinaciones.slice(0, 64);
      break;
    }
  }

  /*
   * Se puntúa cada combinación por **cuántos renglones hace cerrar**, sin armar
   * la tabla ni interpretar el comprobante: alcanza con los textos de las celdas
   * y las identidades de cantidad, precio, descuento e importe.
   */
  const puntuadas = combinaciones.map((eleccion) => {
    const contenidos = contenidosDe(contexto, preparado, filas, eleccion);
    const relaciones = relacionesAritmeticas(contenidos);
    const cierran = relaciones.length > 0 ? relaciones[0].cierran : 0;
    const costo = [...eleccion.entries()].reduce((total, [indice, cual]) => {
      const columna = preparado.preparadas.find((c) => c.indice === indice)!;
      return total + (columna.asignaciones[cual]?.costo ?? 0);
    }, 0);
    return { eleccion, cierran, costo };
  });

  /*
   * Gana la que más renglones hace cerrar; a igualdad, la geométricamente más
   * barata. Ese orden es el que expresa la regla: la aritmética manda, y la
   * distancia sólo desempata cuando la aritmética no distingue.
   */
  puntuadas.sort((a, b) => b.cierran - a.cierran || a.costo - b.costo);

  const elegidas = puntuadas.slice(0, COMBINACIONES_MAXIMAS);
  // La combinación de los mejores repartos de cada columna se prueba siempre,
  // aunque la aritmética no la favorezca: es la respuesta de la geometría y
  // tiene que poder ganar si el resto falla.
  if (!elegidas.some((c) => [...c.eleccion.values()].every((v) => v === 0))) {
    elegidas.push(puntuadas.find((c) => [...c.eleccion.values()].every((v) => v === 0))!);
  }

  void esqueleto;
  return elegidas.map(({ eleccion, cierran }) => ({
    eleccion,
    nombre:
      [...eleccion.entries()].every(([, v]) => v === 0)
        ? ''
        : `, repartos ${[...eleccion.entries()]
            .filter(([, v]) => v > 0)
            .map(([i]) => `«${preparado.preparadas.find((c) => c.indice === i)!.nombre}»`)
            .join(' y ')} (${cierran} renglón/es cierran)`,
  }));
}

/** Los textos de cada columna bajo un reparto dado, para puntuarlo barato. */
function contenidosDe(
  contexto: ContextoDeTabla,
  preparado: { preparadas: ColumnaPreparada[] },
  filas: { y: number }[],
  eleccion: ReadonlyMap<number, number>,
): ContenidoDeColumna[] {
  return contexto.columnas.map((columna, indice) => {
    const preparada = preparado.preparadas[indice];
    const celdas = filas.map(() => '');

    if (preparada.esNumerica) {
      const cual = eleccion.get(indice) ?? 0;
      const asignada = preparada.asignaciones[cual] ?? preparada.asignaciones[0];
      asignada?.porFila.forEach((valor, fila) => {
        if (valor) celdas[fila] = valor.texto;
      });
    } else {
      preparada.porFila.forEach((grupo, fila) => {
        celdas[fila] = grupo.map((o) => textoPreferido(o)).join(' ').trim();
      });
    }

    return { titulo: columna.titulo, desde: columna.desde, hasta: columna.hasta, celdas };
  });
}

/**
 * Lo que hace falta saber de cada columna antes de elegir un reparto.
 *
 * Se calcula **una vez por esqueleto** y se reutiliza para todas las
 * combinaciones. Agrupar los pedazos de cada número y resolver la programación
 * dinámica de cada columna es lo caro; combinar repartos ya calculados es
 * gratis. Sin esta separación, probar ocho combinaciones costaba ocho veces el
 * trabajo pesado.
 */
interface ColumnaPreparada {
  indice: number;
  nombre: string;
  esNumerica: boolean;
  /** Para las de texto: qué observaciones caen en cada fila. */
  porFila: Observacion[][];
  /** Lo que quedó demasiado lejos de toda fila. */
  lejanos: { fila: number; texto: string; caja: Caja }[];
  /** Para las numéricas: los repartos posibles, el mejor primero. */
  asignaciones: Asignacion<ValorConObservaciones>[];
  compuestos: number;
  /** El mejor reparto no le saca ventaja al segundo: hay que probar los dos. */
  dudosa: boolean;
}

/**
 * Reparte cada columna del cuerpo entre las alturas de un esqueleto.
 *
 * Las de texto se reparten por cercanía; las de números, con la programación
 * dinámica monótona, y de ésas se guardan **varias** alternativas en vez de
 * una. Cuál usar no se decide acá: se decide mirando las columnas juntas.
 */
function prepararColumnas(
  contexto: ContextoDeTabla,
  filas: { y: number }[],
): { preparadas: ColumnaPreparada[]; fueraDeToda: Observacion[] } {
  const { columnas, alturaTipica } = contexto;

  const porColumna: Observacion[][] = columnas.map(() => []);
  const fueraDeToda: Observacion[] = [];
  for (const renglon of contexto.cuerpo) {
    for (const observacion of renglon.observaciones) {
      const indice = columnaQueContiene(observacion, columnas);
      if (indice === null) fueraDeToda.push(observacion);
      else porColumna[indice].push(observacion);
    }
  }

  const preparadas = columnas.map((columna, indice): ColumnaPreparada => {
    const observaciones = porColumna[indice];
    const campo = columna.campo?.campo;
    const nombre = columna.titulo ?? campo ?? `columna ${indice + 1}`;
    /*
     * Vale el reparto global para toda columna **de números**, tenga o no
     * semántica confirmada. Es lo que necesita Lácteos Barraza: sus dos importes
     * se cruzan de renglón, y si hubiera que esperar a saber que esa columna se
     * llama «Importe» para repartirlos bien, no se repartirían nunca.
     */
    const esNumerica = llevaNumeros(campo);
    const vacia: ColumnaPreparada = {
      indice,
      nombre,
      esNumerica,
      porFila: filas.map(() => []),
      lejanos: [],
      asignaciones: [],
      compuestos: 0,
      dudosa: false,
    };
    if (observaciones.length === 0) return vacia;

    /*
     * Una columna de texto **no** se reparte de a un valor por renglón.
     *
     * El reparto monótono existe porque una columna de números tiene un valor
     * por fila: eso es lo que permite decir que el segundo importe no puede ir
     * arriba del primero. Una descripción no cumple nada de eso —son cinco
     * palabras de un mismo renglón— y aplicarle la misma regla deja una palabra
     * por fila y las otras cuatro como sobrantes. Sobre la foto de Barraza, las
     * dos descripciones quedaban en «CIL» y «PLAN», con «MUZZA», «BARRAZA» y el
     * resto tirados afuera.
     */
    if (!esNumerica) {
      const porFila: Observacion[][] = filas.map(() => []);
      const lejanos: { fila: number; texto: string; caja: Caja }[] = [];
      for (const observacion of observaciones) {
        const fila = filaMasCercana(centroY(observacion.caja), filas);
        const lejania = Math.abs(filas[fila].y - centroY(observacion.caja)) / (alturaTipica || 1);
        if (lejania > ALEJAMIENTO_MAXIMO) {
          lejanos.push({ fila, texto: textoPreferido(observacion), caja: observacion.caja });
          continue;
        }
        porFila[fila].push(observacion);
      }
      return { ...vacia, porFila, lejanos };
    }

    /*
     * Los pedazos de un número se juntan **antes** de repartir.
     *
     * «234.997» y «69» son un solo importe; repartidos por separado, uno se va
     * a cada renglón. La unión se registra, y las partes quedan disponibles como
     * alternativas: si el número compuesto no cierra, puede cerrar una parte.
     */
    const valores: ValorConObservaciones[] = agruparPedazos(
      observaciones.map((o) => aValor(o)),
      alturaTipica,
    ).map((grupo) => ({
      texto: grupo.texto,
      caja: grupo.caja,
      pasada: grupo.partes[0].pasada,
      confianza: Math.min(...grupo.partes.map((p) => p.confianza)),
      observaciones: grupo.partes.map((p) => p.observacion),
      compuesto: grupo.partes.length > 1,
    }));

    const asignaciones = mejoresAsignaciones(valores, filas, alturaTipica, REPARTOS_POR_COLUMNA);
    const dudosa =
      asignaciones.length > 1 && asignaciones[1].costo - asignaciones[0].costo < MARGEN_DE_REPARTO;

    return {
      ...vacia,
      asignaciones,
      dudosa,
      compuestos: valores.filter((v) => v.compuesto).length,
    };
  });

  return { preparadas, fueraDeToda };
}

/**
 * Arma una tabla entera con un reparto elegido para cada columna.
 *
 * `eleccion` dice, para cada columna numérica, cuál de sus repartos usar. Es lo
 * único que cambia entre las combinaciones que se prueban.
 */
function armarConEsqueleto(
  contexto: ContextoDeTabla,
  esqueleto: Esqueleto,
  preparado: { preparadas: ColumnaPreparada[]; fueraDeToda: Observacion[] },
  filas: { y: number }[],
  eleccion: ReadonlyMap<number, number>,
): { tabla: TablaReconstruida; notas: string[] } | null {
  if (filas.length === 0) return null;
  const comienzo = Date.now();
  const notas: string[] = [];
  const { columnas, alturaTipica } = contexto;

  const celdas: (CeldaReconstruida | null)[][] = filas.map(() => columnas.map(() => null));
  const sobrantes: { texto: string; caja: Caja }[][] = filas.map(() => []);

  for (const preparada of preparado.preparadas) {
    const { indice } = preparada;

    if (!preparada.esNumerica) {
      preparada.porFila.forEach((grupo, fila) => {
        if (grupo.length > 0) celdas[fila][indice] = armarCelda(indice, grupo);
      });
      for (const lejano of preparada.lejanos) {
        sobrantes[lejano.fila].push({ texto: lejano.texto, caja: lejano.caja });
      }
      continue;
    }

    if (preparada.compuestos > 0) {
      notas.push(
        `En «${preparada.nombre}» se compusieron ${preparada.compuestos} número/s ` +
          'a partir de pedazos que el OCR había separado.',
      );
    }
    if (preparada.dudosa) {
      notas.push(
        `El reparto de «${preparada.nombre}» no es concluyente: ` +
          `${preparada.asignaciones[0].costo.toFixed(2)} contra ` +
          `${preparada.asignaciones[1].costo.toFixed(2)}.`,
      );
    }

    const cual = eleccion.get(indice) ?? 0;
    const asignada = preparada.asignaciones[cual] ?? preparada.asignaciones[0];
    if (!asignada) continue;
    if (cual > 0) {
      notas.push(`En «${preparada.nombre}» se usó el reparto alternativo n.º ${cual + 1}.`);
    }

    asignada.porFila.forEach((valor, fila) => {
      if (!valor) return;
      celdas[fila][indice] = armarCeldaDeValor(indice, valor);
    });
    for (const sobra of asignada.sobrantes) {
      const fila = filaMasCercana(centroY(sobra.caja), filas);
      sobrantes[fila].push({ texto: sobra.texto, caja: sobra.caja });
    }
  }

  for (const observacion of preparado.fueraDeToda) {
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
    tabla: {
      columnas,
      metodo: contexto.metodo,
      encabezados: contexto.encabezados,
      renglones,
      filasVisibles: contexto.cuerpo.length,
      inclinacionGrados: contexto.inclinacionGrados,
      seEnderezo: contexto.seEnderezo,
      alturaTipica,
      notas: [...contexto.notas, ...notas, esqueleto.nota],
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
