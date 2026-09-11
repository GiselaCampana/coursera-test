import { Decimal } from '@/lib/money';
import {
  cantidadQueCuesta,
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
import {
  CAMPOS_NUMERICOS,
  CAMPOS_SIN_CONFIRMAR,
  type ColumnaReconocida,
} from '@/lib/ocr/motor/columnas';
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
  type LecturaDeCelda,
  type RenglonReconstruido,
  type TablaReconstruida,
} from '@/lib/ocr/reconstruccion/reconstruccion';
import { candidatasDeTabla } from '@/lib/ocr/reconstruccion/candidatas-de-tabla';
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
  /** Cómo se armó la tabla que ganó, y con qué compitió. */
  reconstruccionElegida: string;
  reconstruccionesProbadas: { origen: string; puntaje: number; renglones: number }[];
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

  const textos = textoDeLaEvidencia(evidencia);
  const emisor = leerEmisor(textos, opciones.cuitDelReceptor);

  /*
   * Se interpretan **todas** las maneras de armar la tabla y gana la que mejor
   * cierra, no la que se armó primero.
   *
   * Es lo que permite probar un reparto global de las columnas sin arriesgar lo
   * que la reconstrucción por cercanía ya resolvía bien: si el reparto mejora el
   * comprobante, gana con la suma contra el pie; si lo empeora, pierde y no tocó
   * nada. Ninguna de las dos muta a la otra.
   */
  const armados = candidatasDeTabla(evidencia).map((candidata) => {
    const columnas = candidata.tabla.columnas.map((c) => c.campo);
    const lecturas: CandidataDeTabla[] = [];

    for (const convencion of ['ar', 'us'] as ConvencionDecimal[]) {
      const pie = leerPie(textos.completo, convencion);
      const renglones = elegirParaElDocumento(
        candidata.tabla.renglones,
        columnas,
        convencion,
        pie.netTotal,
      );
      const { puntaje, penalizaciones, sumaDeRenglones, cierre } = puntuarTabla(renglones, {
        netTotal: pie.netTotal,
        /*
         * Las filas esperadas salen del consenso entre columnas, no de una sola
         * fuente. Si tres columnas sostienen dos renglones y una sostiene uno
         * porque el OCR perdió un valor, hay dos.
         */
        filasVistas: Math.max(candidata.filasEsperadas, candidata.tabla.renglones.length),
      });
      lecturas.push({ convencion, pie, renglones, puntaje, penalizaciones, sumaDeRenglones, cierre });
    }

    return { candidata, lecturas };
  });

  const mejorDeCada = armados.map((armado) => ({
    ...armado,
    mejor: Math.max(...armado.lecturas.map((l) => l.puntaje)),
  }));
  const elegido = mejorDeCada.reduce((a, b) => (b.mejor > a.mejor ? b : a));

  const tabla = elegido.candidata.tabla;
  const candidatas = elegido.lecturas;

  /*
   * Qué columnas frenan el comprobante.
   *
   * Antes eran «las que tienen título y no se reconocieron». Eso dejaba afuera
   * justamente el caso peor: una columna **sin** título legible no aparecía en
   * la lista porque tampoco aparecía en la tabla —sus celdas se perdían— y la
   * factura salía con menos renglones sin decir por qué.
   *
   * Ahora la pregunta es otra y es la correcta: qué columnas se están usando sin
   * que nadie haya confirmado qué son. Sus celdas ya están reconstruidas y los
   * renglones están completos; lo único que falta es la confirmación.
   */
  const sinResolver = tabla.columnas
    .filter((c) => c.campo?.requiereConfirmacion && c.apoyos > 0)
    .map((c) => nombreDeColumna(c, tabla));

  /*
   * Se decide en dos tiempos: primero un veredicto provisorio para saber qué
   * renglones cierran, y con eso se arma la lista de pendientes; después el
   * veredicto definitivo, que sólo frena por las **bloqueantes**.
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
    reconstruccionElegida: elegido.candidata.origen,
    reconstruccionesProbadas: mejorDeCada.map((a) => ({
      origen: a.candidata.origen,
      puntaje: a.mejor,
      renglones: a.candidata.tabla.renglones.length,
    })),
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
  /** Lo que sobró en los renglones de arriba y de abajo. */
  deLosVecinos: { texto: string }[] = [],
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
   * Un valor que sobró también es una alternativa, y no sólo para su renglón.
   *
   * Sobre la factura de Lácteos Barraza el importe del segundo renglón queda
   * fuera de toda columna en la línea del primero. Ofrecerlo como posible
   * importe del renglón permite que la aritmética lo ubique; no ofrecerlo
   * garantiza que ese renglón nunca cierre.
   *
   * Y se ofrecen también los sobrantes de los renglones de al lado, que es lo
   * que el propio informe viene diciendo de ellos: «puede ser un valor de otra
   * fila». En esa misma factura los dos 16 % de bonificación están impresos casi
   * a la misma altura, así que los dos caen en la línea del primer renglón: uno
   * entra en su celda y el otro queda sobrando ahí, mientras el segundo renglón
   * se queda sin descuento. Sólo los vecinos inmediatos: un valor que aparece a
   * tres renglones del suyo no es un valor corrido, es otra cosa.
   */
  for (const sobrante of [...renglon.sobrantes, ...deLosVecinos]) {
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
    const vecinos = [renglones[i - 1], renglones[i + 1]]
      .filter((v): v is RenglonReconstruido => v !== undefined)
      .flatMap((v) => v.sobrantes);
    const candidatas = variantesDeFila(renglon, i, vecinos).flatMap((fila) =>
      candidatasDeRenglon(fila, columnas, convencion),
    );
    /*
     * Dos lecturas que dicen lo mismo son una sola.
     *
     * Sin esto, la lista de alternativas de un renglón se llena de repeticiones
     * —la misma combinación llegada por caminos distintos— y las pocas que se
     * llegan a probar más abajo son todas la misma. Contar lecturas **distintas**
     * es lo que hace que el tope de abajo signifique algo.
     */
    const vistas = new Set<string>();
    const distintas = candidatas.filter((c) => {
      const firma = [
        c.codigo ?? '',
        c.descripcion,
        cantidadQueCuesta(c)?.toString() ?? '',
        c.piezas ?? '',
        c.precioUnitario?.toString() ?? '',
        c.descuentoPct?.toString() ?? '',
        c.precioConDescuento?.toString() ?? '',
        c.importe?.toString() ?? '',
        c.descuentoEnElImporte ?? '',
      ].join('~');
      if (vistas.has(firma)) return false;
      vistas.add(firma);
      return true;
    });
    return distintas.sort((a, b) => puntosDeRenglon(b) - puntosDeRenglon(a));
  });

  const elegidas = porFila
    .map((candidatas) => candidatas[0])
    .filter((c): c is RenglonCandidato => c !== undefined);

  if (!netoImpreso || netoImpreso.lte(0)) return elegidas;

  const suma = (lista: RenglonCandidato[]) =>
    lista.reduce((acc, r) => acc.plus(netoDelRenglon(r) ?? 0), new Decimal(0));

  let mejor = elegidas;
  let mejorDistancia = suma(mejor).minus(netoImpreso).abs();

  /*
   * Cuándo dejar de buscar: cuando lo que falta ya lo explica el redondeo.
   *
   * Era cinco por cien mil del total, que sobre una factura de medio millón son
   * veinticuatro pesos. Con esa holgura la búsqueda se daba por satisfecha con
   * una diferencia de setenta y cinco centavos, y setenta y cinco centavos no
   * los explica ningún redondeo: sobre la factura de Lácteos Barraza eran
   * exactamente los del importe del segundo renglón, que el OCR había leído
   * «238,234.» sin los centavos y que estaba impreso completo entre las
   * alternativas de esa misma celda.
   *
   * Lo que corresponde es un centavo por renglón, que es el máximo que puede
   * aportar el truncamiento de cada línea, y es la misma cuenta con la que
   * después se juzga el cierre. Si la diferencia entra ahí, no hay nada que
   * buscar; si no entra, hay algo mal leído y vale la pena seguir.
   */
  const tolerancia = Decimal.max(new Decimal('0.01').times(renglones.length), '0.01');

  /*
   * Una sola vuelta por renglón, preguntándole a cada uno **cuánto le falta**.
   *
   * Antes se recorrían las primeras siete alternativas de cada renglón y se
   * aceptaba cualquiera que acercara la suma. Las dos cosas estaban mal. Siete
   * es poco donde más hace falta: sobre la foto de Lácteos Barraza el importe
   * del primer renglón no está en su celda sino entre los valores que quedaron
   * fuera de toda columna, y el motor lo ofrece recién después de ciento
   * cuarenta lecturas. Y recorrerlas en un orden que no sabe qué busca es
   * casualidad, no búsqueda.
   *
   * Lo que se hace ahora es calcular, para cada renglón, **cuánto tendría que
   * valer para que el comprobante cierre** —el neto impreso menos lo que suman
   * los demás— y quedarse con la lectura que más se acerca a esa cifra. Es una
   * pregunta que tiene una respuesta, y se contesta mirando la lista entera sin
   * ningún tope arbitrario.
   *
   * Que esto no sea «ajustar hasta que dé» lo sostienen tres cosas que no se
   * tocan: las lecturas son las que el OCR produjo en ese lugar y ninguna otra;
   * un renglón que ya cierra su propia cuenta no se cambia por uno que no
   * cierra ninguna; y el cierre final lo sigue juzgando la precisión impresa,
   * no esta búsqueda. Y por encima de todo eso, si dos maneras distintas de leer
   * la tabla cierran parecido, el comprobante va a revisión igual.
   */
  for (let i = 0; i < porFila.length && mejorDistancia.gt(tolerancia); i++) {
    const incumbente = mejor[i];
    if (!incumbente) continue;
    const incumbenteCierra = incumbente.controles.some((c) => c.paso);

    const deLosDemas = suma(mejor).minus(netoDelRenglon(incumbente) ?? 0);
    const objetivo = netoImpreso.minus(deLosDemas);

    let elegida: RenglonCandidato | null = null;
    let mejorDiferencia = mejorDistancia;

    for (const alternativa of porFila[i]) {
      if (alternativa === incumbente) continue;
      /*
       * Una lectura verificada contra su propia aritmética sólo se cambia por
       * otra que **también** lo esté.
       *
       * El control del renglón —cantidad × precio da el importe impreso— no
       * depende del total del comprobante, así que vale más que él. Dejar que
       * el total lo pise es exactamente cómo una búsqueda honesta se convierte
       * en ajustar números hasta que dé: alcanzaría con una lectura sin ninguna
       * cuenta comprobable que caiga cerca del faltante.
       */
      if (incumbenteCierra) {
        const alternativaCierra =
          alternativa.controles.length > 0 && alternativa.controles.every((c) => c.paso);
        if (!alternativaCierra) continue;
      }

      const neto = netoDelRenglon(alternativa);
      if (!neto) continue;
      const diferencia = neto.minus(objetivo).abs();
      if (diferencia.lt(mejorDiferencia)) {
        mejorDiferencia = diferencia;
        elegida = alternativa;
      }
    }

    if (elegida) {
      mejor = mejor.map((r, j) => (j === i ? elegida! : r));
      mejorDistancia = suma(mejor).minus(netoImpreso).abs();
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
  for (const columna of tabla.columnas) {
    if (!columna.campo?.requiereConfirmacion || columna.apoyos === 0) continue;
    const nombre = nombreDeColumna(columna, tabla);
    pendientes.push({
      categoria: 'BLOCKING_UNKNOWN_COLUMN',
      renglon: null,
      campo: null,
      columna: nombre,
      alternativas: [],
      elegido: null,
      motivo: queConfirmar(columna, nombre),
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

/** Cómo se llama una columna en el informe, tenga título legible o no. */
function nombreDeColumna(columna: ColumnaEspacial, tabla: TablaReconstruida): string {
  if (columna.titulo) return columna.titulo;
  return `columna ${tabla.columnas.indexOf(columna) + 1}`;
}

/**
 * Qué exactamente hay que confirmar de una columna, en una frase.
 *
 * El pedido cambia mucho según por qué quedó sin confirmar, y la diferencia es
 * la que decide si una persona puede contestar en un segundo o tiene que ponerse
 * a mirar la factura:
 *
 *  - la columna **de texto sin encabezado** ya está cargada como descripción y
 *    los renglones están completos: se confirma que es la descripción y listo;
 *  - una columna **inferida por la aritmética** tiene una respuesta concreta
 *    para mostrar —«esto es el importe, porque 27 × 10.361,45 × 0,84 da
 *    justo»— y se confirma o se corrige;
 *  - una que quedó **entre dos significados** no tiene respuesta: hay que
 *    elegir, y se muestran las dos.
 */
function queConfirmar(columna: ColumnaEspacial, nombre: string): string {
  const semantica = columna.semantica;
  const campo = columna.campo?.campo;

  if (campo === 'UNKNOWN_TEXT') {
    return (
      'Confirmar que la columna textual corresponde a Descripción. ' +
      `El encabezado de «${nombre}» no se pudo leer, pero los renglones se ` +
      'reconstruyeron completos usándola como descripción del artículo.'
    );
  }

  if (campo && CAMPOS_SIN_CONFIRMAR.has(campo)) {
    const posibles = (semantica?.alternativas ?? [])
      .filter((a) => a.campo !== campo)
      .slice(0, 2)
      .map((a) => a.campo);
    return (
      `No se pudo decidir qué es «${nombre}»` +
      (posibles.length > 0 ? `: puede ser ${posibles.join(' o ')}.` : '.') +
      ' Sus valores entran en las cuentas del comprobante, así que no se puede adivinar. ' +
      'Se resuelve una vez y queda para este formato.'
    );
  }

  const porQue = columna.campo?.porQue?.[0] ?? '';
  return (
    `Confirmar que «${nombre}» es ${campo}. Se dedujo sin encabezado legible` +
    (porQue ? `: ${porQue}` : '.') +
    ' Los renglones ya se reconstruyeron con esa lectura.'
  );
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
