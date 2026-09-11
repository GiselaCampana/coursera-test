import { Decimal } from '@/lib/money';
import {
  candidatasDeRenglon,
  decidir,
  netoDelRenglon,
  puntuarTabla,
  type CandidataDeTabla,
  type ConvencionDecimal,
  type PieLeido,
  type RenglonCandidato,
  type Veredicto,
} from '@/lib/ocr/motor/candidatas';
import { CAMPOS_NUMERICOS, type ColumnaReconocida } from '@/lib/ocr/motor/columnas';
import {
  bloquea,
  resumir,
  soloBloqueantes,
  type AlternativaDePendiente,
  type Pendiente,
  type ResumenDePendientes,
} from '@/lib/ocr/motor/pendientes';

export type { Pendiente, ResumenDePendientes } from '@/lib/ocr/motor/pendientes';
import type { Celda, FilaDeDatos } from '@/lib/ocr/motor/tabla';
import { leerEmisor, leerPie, type EmisorLeido } from '@/lib/ocr/motor/motor';
import type { EvidenciaDeLectura } from '@/lib/ocr/reconstruccion/evidencia';
import {
  reconstruirTabla,
  type LecturaDeCelda,
  type RenglonReconstruido,
  type TablaReconstruida,
} from '@/lib/ocr/reconstruccion/reconstruccion';
import type { ColumnaEspacial } from '@/lib/ocr/reconstruccion/columnas-espaciales';
import { textoDeLaEvidencia } from '@/lib/ocr/reconstruccion/texto';

/**
 * Interpretar un comprobante a partir de la evidencia con coordenadas.
 *
 * Es el mismo motor semántico de siempre —las mismas igualdades, el mismo
 * umbral, la misma decisión de tres valores— pero alimentado con la tabla
 * reconstruida en vez de con texto aplanado. Eso cambia dos cosas de fondo:
 *
 *  - **cada celda llega con sus alternativas**, las de las distintas pasadas y
 *    las que ofreció el propio OCR. Antes había una sola lectura posible por
 *    celda, así que un importe mal leído no tenía arreglo;
 *
 *  - **el puntaje es del comprobante entero**, no de cada fila por separado.
 *    Elegir la mejor lectura de cada renglón por su cuenta es lo que deja pasar
 *    el error de Lácteos Barraza: el importe del segundo renglón aparece en la
 *    línea del primero, las dos filas cierran solas con los valores cruzados, y
 *    sólo la suma contra el neto impreso lo delata.
 */

export interface InformeReconstruido {
  emisor: EmisorLeido;
  tabla: TablaReconstruida;
  pie: PieLeido;
  candidatas: CandidataDeTabla[];
  veredicto: Veredicto;
  /** Qué tendría que resolver una persona, y qué es sólo una anotación. */
  pendientes: Pendiente[];
  resumen: ResumenDePendientes;
  ms: number;
}

export interface OpcionesDelMotorReconstruido {
  cuitDelReceptor?: string;
}

export function interpretarReconstruccion(
  evidencia: EvidenciaDeLectura,
  opciones: OpcionesDelMotorReconstruido = {},
): InformeReconstruido {
  const comienzo = Date.now();

  const tabla = reconstruirTabla(evidencia);
  const textos = textoDeLaEvidencia(evidencia);
  const emisor = leerEmisor(textos, opciones.cuitDelReceptor);

  const columnas = tabla.columnas.map((c) => c.campo);

  const candidatas: CandidataDeTabla[] = [];
  for (const convencion of ['ar', 'us'] as ConvencionDecimal[]) {
    const pie = leerPie(textos.completo, convencion);
    const renglones = elegirParaElDocumento(tabla.renglones, columnas, convencion, pie.netTotal);
    const { puntaje, penalizaciones, sumaDeRenglones, cierre } = puntuarTabla(renglones, {
      netTotal: pie.netTotal,
      /*
       * Las filas que se vieron son las que la reconstrucción armó, no las
       * líneas de texto que hay en la banda de la tabla.
       *
       * Pasar las líneas castigaba a los comprobantes que tienen texto suelto
       * debajo de la tabla —una leyenda, un comentario, el borde— como si se
       * hubieran perdido artículos: la factura de Ezra tiene seis renglones y
       * trece líneas ahí, y perdía dos décimas de confianza por siete artículos
       * que no existen.
       */
      filasVistas: tabla.renglones.length,
    });
    candidatas.push({ convencion, pie, renglones, puntaje, penalizaciones, sumaDeRenglones, cierre });
  }

  const sinResolver = tabla.columnas
    .filter((c) => c.titulo !== null && c.campo === null && c.apoyos > 0)
    .map((c) => c.titulo!);

  /*
   * Se decide en dos tiempos: primero un veredicto provisorio para saber qué
   * renglones cierran, y con eso se arma la lista de pendientes; después el
   * veredicto definitivo, que sólo frena por las **bloqueantes**.
   *
   * Hace falta el ida y vuelta porque qué bloquea depende de si el renglón
   * cerró: una celda ambigua en un renglón que cuadra es una alternativa
   * descartada, no un dato que falta.
   */
  const provisorio = decidir(candidatas, sinResolver);
  const pendientes = queFaltaResolver(tabla, provisorio, sinResolver);
  const columnasQueFrenan = soloBloqueantes(pendientes)
    .filter((p) => p.categoria === 'BLOCKING_UNKNOWN_COLUMN')
    .map((p) => p.columna!);

  const veredicto = decidir(candidatas, columnasQueFrenan);

  return {
    emisor,
    tabla,
    pie: veredicto.ganadora?.pie ?? candidatas[0].pie,
    candidatas,
    veredicto,
    pendientes,
    resumen: resumir(pendientes),
    ms: Date.now() - comienzo,
  };
}

/**
 * Pasa un renglón reconstruido a la forma que espera el motor semántico.
 *
 * Se ofrece una fila por **combinación de alternativas de una celda**, y no
 * todas las combinaciones de todas: con cinco celdas ambiguas de dos lecturas
 * cada una salen treinta y dos filas, y con diez, mil. Cambiar una celda por vez
 * cubre el caso real —el OCR se equivoca en una celda, no en cinco a la vez— y
 * el costo queda lineal.
 */
function variantesDeFila(
  renglon: RenglonReconstruido,
  indice: number,
): FilaDeDatos[] {
  const base = (elegida: (columna: number) => string | null): FilaDeDatos => {
    let x = 0;
    const celdas: (Celda | null)[] = renglon.celdas.map((celda, i) => {
      const texto = celda ? elegida(i) : null;
      if (texto === null) return null;
      const desde = x;
      x += texto.length + 2;
      return { texto, desde, hasta: x - 2 };
    });
    return {
      linea: indice,
      cruda: celdas.map((c) => c?.texto ?? '').join('  '),
      celdas,
      sobrantes: renglon.sobrantes.map((s) => ({ texto: s.texto, desde: 0, hasta: 0 })),
    };
  };

  const filas: FilaDeDatos[] = [base((i) => renglon.celdas[i]?.texto ?? null)];

  renglon.celdas.forEach((celda, i) => {
    if (!celda || celda.alternativas.length < 2) return;
    for (const alternativa of celda.alternativas.slice(1)) {
      filas.push(base((j) => (j === i ? alternativa.texto : renglon.celdas[j]?.texto ?? null)));
    }
  });

  /*
   * Un valor que sobró también es una alternativa.
   *
   * Sobre la factura de Lácteos Barraza el importe del segundo renglón queda
   * fuera de toda columna en la línea del primero. Ofrecerlo como posible
   * importe del renglón permite que la aritmética lo ubique; no ofrecerlo
   * garantiza que ese renglón nunca cierre.
   */
  for (const sobrante of renglon.sobrantes) {
    renglon.celdas.forEach((celda, i) => {
      if (!celda) return;
      filas.push(base((j) => (j === i ? sobrante.texto : renglon.celdas[j]?.texto ?? null)));
    });
  }

  return filas;
}

/**
 * Elige la lectura de cada renglón mirando el comprobante entero.
 *
 * Primero se elige la mejor de cada fila por su propia aritmética, que es lo
 * barato y lo que acierta casi siempre. Después, **si la suma no da el neto
 * impreso**, se intenta arreglarla cambiando de a un renglón: para cada uno se
 * prueban sus otras lecturas y se acepta el cambio que más acerca la suma.
 *
 * Que la corrección sea de a un renglón por vez y contra el total impreso es lo
 * que la hace honesta: no se ajusta un número para que cierre, se elige entre
 * lecturas que el OCR ya había propuesto, y sólo se acepta la que además cumple
 * las igualdades del propio renglón.
 */
function elegirParaElDocumento(
  renglones: RenglonReconstruido[],
  columnas: (ColumnaReconocida | null)[],
  convencion: ConvencionDecimal,
  netoImpreso: Decimal | null,
): RenglonCandidato[] {
  const porFila = renglones.map((renglon, i) => {
    const candidatas = variantesDeFila(renglon, i).flatMap((fila) =>
      candidatasDeRenglon(fila, columnas, convencion),
    );
    return candidatas.sort((a, b) => puntosDeRenglon(b) - puntosDeRenglon(a));
  });

  const elegidas = porFila
    .map((candidatas) => candidatas[0])
    .filter((c): c is RenglonCandidato => c !== undefined);

  if (!netoImpreso || netoImpreso.lte(0)) return elegidas;

  const suma = (lista: RenglonCandidato[]) =>
    lista.reduce((acc, r) => acc.plus(netoDelRenglon(r) ?? 0), new Decimal(0));

  let mejor = elegidas;
  let mejorDistancia = suma(mejor).minus(netoImpreso).abs();
  const tolerancia = Decimal.max(netoImpreso.times('0.00005'), '0.02');

  // Una sola vuelta por renglón: alcanza para acomodar el valor que estaba en
  // la fila equivocada, y evita que esto se vuelva una búsqueda.
  for (let i = 0; i < porFila.length && mejorDistancia.gt(tolerancia); i++) {
    for (const alternativa of porFila[i].slice(1, 8)) {
      const probada = [...mejor];
      const posicion = probada.findIndex((r) => r === mejor[i]);
      if (posicion === -1) continue;
      probada[posicion] = alternativa;
      const distancia = suma(probada).minus(netoImpreso).abs();
      if (distancia.lt(mejorDistancia)) {
        mejor = probada;
        mejorDistancia = distancia;
      }
    }
  }

  return mejor;
}

/** Cuánto vale una lectura de renglón por sí sola. */
function puntosDeRenglon(renglon: RenglonCandidato): number {
  let puntos = 0;
  for (const control of renglon.controles) puntos += control.paso ? 10 : -10;
  puntos += [
    renglon.codigo,
    renglon.marca,
    renglon.precioUnitario,
    renglon.precioConDescuento,
    renglon.piezas,
    renglon.importe,
  ].filter(Boolean).length;
  return puntos;
}

/** Las lecturas de una celda, en la forma que va al informe. */
function alternativasDe(celda: { alternativas: LecturaDeCelda[] }): AlternativaDePendiente[] {
  return celda.alternativas.map((a) => ({
    texto: a.texto,
    caja: a.caja,
    pasada: a.pasada,
    confianza: a.confianza,
    ...(a.delPropioOcr ? { delPropioOcr: true } : {}),
  }));
}

/**
 * Qué le falta al comprobante, separado entre lo que frena y lo que no.
 *
 * El criterio es la aritmética del renglón, y por eso hace falta el veredicto
 * para armar la lista: **una celda ambigua en un renglón que cierra no bloquea
 * nada**. Los dos valores posibles llevan a la misma cuenta o uno de los dos la
 * rompe, y si el renglón cuadra es porque ganó el correcto. Queda anotada como
 * alternativa descartada, para poder revisarla, y no se le pide nada a nadie.
 *
 * Sin esta distinción la lista es inservible: sobre la foto de Errecalde salían
 * ciento quince pedidos, casi todos ambigüedades de la descripción que no entran
 * en ninguna igualdad. Una lista así es lo mismo que volver a tipear la factura.
 */
function queFaltaResolver(
  tabla: TablaReconstruida,
  veredicto: Veredicto,
  sinResolver: string[],
): Pendiente[] {
  const pendientes: Pendiente[] = [];

  /*
   * Una columna sin reconocer frena **sólo si hace falta para las cuentas**.
   *
   * Se mide por lo que hay debajo: una columna cuyos valores son casi todos
   * montos o cantidades es parte de la aritmética del comprobante y no se puede
   * adivinar. Una que tiene texto es una descripción, una marca o una leyenda, y
   * no saber qué es no impide cargar la compra.
   */
  for (const titulo of sinResolver) {
    const columna = tabla.columnas.find((c) => c.titulo === titulo);
    const numerica = columna ? columnaEsNumerica(tabla, columna) : false;
    pendientes.push({
      categoria: numerica ? 'BLOCKING_UNKNOWN_COLUMN' : 'WARNING_OPTIONAL_FIELD',
      renglon: null,
      campo: null,
      columna: titulo,
      alternativas: [],
      elegido: null,
      motivo: numerica
        ? `Debajo de «${titulo}» hay valores numéricos en casi todos los renglones, ` +
          'así que entra en las cuentas y no se puede adivinar qué es. ' +
          'Se resuelve una vez y queda para este formato.'
        : `No se reconoció «${titulo}», pero lo que tiene debajo es texto: ` +
          'no entra en ninguna cuenta y no impide cargar la compra.',
    });
  }

  if (!veredicto.ganadora?.pie.netTotal) {
    pendientes.push({
      categoria: 'BLOCKING_UNKNOWN_COLUMN',
      renglon: null,
      campo: 'netTotal',
      columna: 'pie fiscal',
      alternativas: [],
      elegido: null,
      motivo:
        'No se pudo identificar el neto del pie, así que no hay contra qué comparar ' +
        'la suma de los renglones. Hay que señalar cuál de los números del pie es el neto.',
    });
  }

  /*
   * Qué renglones están confirmados, y por lo tanto qué ambigüedades no importan.
   *
   * Hay dos maneras de estar confirmado, y la segunda es la que faltaba:
   *
   *  - **por la aritmética del propio renglón**: cantidad × precio da el
   *    importe impreso, así que las lecturas elegidas son las correctas;
   *
   *  - **porque cierra el comprobante entero**. Es el control más fuerte que
   *    hay y vale para todos los renglones a la vez: si la suma de los importes
   *    elegidos coincide con el neto impreso, esas elecciones son las correctas,
   *    por más que cada renglón por separado no tenga con qué comprobarse.
   *
   * Sin la segunda, la factura de Mabelherdi pedía veintinueve correcciones
   * teniendo los nueve artículos bien y la suma **exacta** contra el pie: sus
   * renglones no imprimen precio unitario, así que ninguno puede verificarse
   * solo, y todas sus ambigüedades quedaban marcadas como bloqueantes.
   */
  const documentoCierra = veredicto.ganadora?.cierre?.compatible === true;
  const cierran = new Set<number>();
  (veredicto.ganadora?.renglones ?? []).forEach((renglon, i) => {
    if (renglon.controles.length > 0 && renglon.controles.every((c) => c.paso)) cierran.add(i);
  });

  tabla.renglones.forEach((renglon, i) => {
    const cerro = documentoCierra || cierran.has(i);

    renglon.celdas.forEach((celda, j) => {
      const columna = tabla.columnas[j];
      const campo = columna?.campo?.campo;
      const nombreDeColumna = columna?.titulo ?? `columna ${j + 1}`;
      // La descripción y la marca no entran en ninguna igualdad.
      if (!campo || !CAMPOS_NUMERICOS.has(campo)) return;

      if (!celda) {
        pendientes.push({
          categoria: cerro ? 'WARNING_OPTIONAL_FIELD' : 'BLOCKING_MISSING_CELL',
          renglon: i + 1,
          campo,
          columna: nombreDeColumna,
          alternativas: [],
          elegido: null,
          motivo: cerro
            ? `El renglón ${i + 1} no trae ${campo}, pero cierra igual con lo que sí trae.`
            : `El renglón ${i + 1} no trae ${campo} y sin eso no cierra.`,
        });
        return;
      }

      if (celda.estado !== 'ambigua') return;

      pendientes.push({
        categoria: cerro ? 'WARNING_DISCARDED_ALTERNATIVE' : 'BLOCKING_AMBIGUOUS_CELL',
        renglon: i + 1,
        campo,
        columna: nombreDeColumna,
        alternativas: alternativasDe(celda),
        elegido: celda.texto,
        motivo: cerro
          ? `Se leyó ${campo} de más de una manera y ganó «${celda.texto}», ` +
            `con la que el renglón ${i + 1} cierra. Las otras quedan anotadas.`
          : `Hay más de una lectura posible de ${campo} en el renglón ${i + 1} ` +
            'y ninguna hace cerrar la cuenta.',
      });
    });

    for (const sobrante of renglon.sobrantes) {
      pendientes.push({
        categoria: cerro ? 'WARNING_OCR_NOISE' : 'BLOCKING_AMBIGUOUS_CELL',
        renglon: i + 1,
        campo: null,
        columna: 'fuera de toda columna',
        alternativas: [
          { texto: sobrante.texto, caja: sobrante.caja, pasada: '(fuera de columna)', confianza: 0 },
        ],
        elegido: null,
        motivo: cerro
          ? `«${sobrante.texto}» no cae en ninguna columna del renglón ${i + 1}, ` +
            'que cierra igual: es ruido de la foto.'
          : `«${sobrante.texto}» no cae en ninguna columna del renglón ${i + 1}, ` +
            'que además no cierra: puede ser un valor de otra fila.',
      });
    }
  });

  return pendientes;
}

/** ¿Lo que hay debajo de una columna son números? */
function columnaEsNumerica(tabla: TablaReconstruida, columna: ColumnaEspacial): boolean {
  const indice = tabla.columnas.indexOf(columna);
  let conValor = 0;
  let numericos = 0;
  for (const renglon of tabla.renglones) {
    const texto = renglon.celdas[indice]?.texto;
    if (!texto) continue;
    conValor += 1;
    if (/\d/.test(texto) && /^[^A-Za-zÁÉÍÓÚÑáéíóúñ]*$/.test(texto.replace(/[kg|%$]/gi, ''))) {
      numericos += 1;
    }
  }
  return conValor > 0 && numericos / conValor >= 0.6;
}
