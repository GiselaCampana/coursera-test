import { Decimal } from '@/lib/money';
import {
  cantidadQueCuesta,
  candidatasDeRenglon,
  decidir,
  leFalta,
  netoDelRenglon,
  puntuarTabla,
  type CandidataDeTabla,
  type ConvencionDecimal,
  type PieLeido,
  type RenglonCandidato,
  type UnidadComercial,
  type Veredicto,
} from '@/lib/ocr/motor/candidatas';
import { compararCandidatas } from '@/lib/ocr/motor/orden-lexicografico';
import { DERIVED_SUGGESTION, sugerenciasDerivadas } from '@/lib/ocr/motor/sugerencias';
import { reconciliarPie, type PieFiscal } from '@/lib/ocr/motor/pie-fiscal';
import {
  medicionVacia,
  type MedicionDeCandidatas,
} from '@/lib/ocr/reconstruccion/candidatas-de-tabla';
import {
  CAMPOS_NUMERICOS,
  CAMPOS_SIN_CONFIRMAR,
  llevaNumeros,
  type CampoDeColumna,
  type ColumnaReconocida,
} from '@/lib/ocr/motor/columnas';
import {
  formatoDeColumna,
  type FormatoDeColumna,
} from '@/lib/ocr/motor/formato-de-columna';
import {
  bloquea,
  resumir,
  soloBloqueantes,
  type AlternativaDePendiente,
  type Pendiente,
  type ResumenDePendientes,
} from '@/lib/ocr/motor/pendientes';

export type { Pendiente, ResumenDePendientes } from '@/lib/ocr/motor/pendientes';
import { lugarDe, type Celda, type FilaDeDatos } from '@/lib/ocr/motor/tabla';
import { leerPie, type EmisorLeido } from '@/lib/ocr/motor/motor';
import { leerEmisorDeEvidencia } from '@/lib/ocr/motor/emisor';
import type { EvidenciaDeLectura } from '@/lib/ocr/reconstruccion/evidencia';
import {
  type LecturaDeCelda,
  type RenglonReconstruido,
  type TablaReconstruida,
} from '@/lib/ocr/reconstruccion/reconstruccion';
import { candidatasDeTabla } from '@/lib/ocr/reconstruccion/candidatas-de-tabla';
import type { ColumnaEspacial } from '@/lib/ocr/reconstruccion/columnas-espaciales';
import { estructuraDeLaEvidencia } from '@/lib/ocr/reconstruccion/texto';
import {
  celdasParaReleer,
  convieneReleer,
  sumarRelectura,
  type EvidenciaDeRelectura,
} from '@/lib/ocr/reconstruccion/relectura';

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

/**
 * La escala que se eligió para una columna, con todo lo que la sostiene.
 *
 * Va en el informe porque una escala es una decisión, no un detalle de parseo:
 * decide el orden de magnitud de la factura entera. Quien la revise tiene que
 * poder ver qué valores la anclan, cuánto costó, qué otra quedó en pie y por
 * cuánto perdió.
 */
export interface EscalaInformada {
  columna: CampoDeColumna;
  separador: string;
  decimales: number;
  /** Los valores que la muestran impresa. Sin éstos no hay evidencia de escala. */
  anclas: string[];
  /** Cuántas celdas de la columna no pueden estar escritas en esta escala. */
  contradicen: number;
  reparaciones: number;
  segunda: { separador: string; decimales: number; reparaciones: number } | null;
  margen: number;
  /** Dos escalas siguen en pie y ninguna tiene anclas: no se elige, se informa. */
  indecidible: boolean;
}

/**
 * La escala de cada columna numérica de una tabla ya armada.
 *
 * Se recalcula sobre la tabla elegida para poder informarla; es la misma cuenta
 * que hace la interpretación, sobre los mismos textos.
 */
export function escalasDeLaTabla(tabla: TablaReconstruida): EscalaInformada[] {
  const salida: EscalaInformada[] = [];
  tabla.columnas.forEach((columna, i) => {
    const campo = columna?.campo?.campo;
    if (!campo || !CAMPOS_NUMERICOS.has(campo)) return;
    const textos = tabla.renglones.map((r) => r.celdas[i]?.texto ?? '');
    const formato = formatoDeColumna(textos);
    if (!formato) return;
    salida.push({
      columna: campo,
      separador: formato.escala.separador,
      decimales: formato.escala.decimales,
      anclas: formato.escala.anclas,
      contradicen: formato.escala.contradicen,
      reparaciones: formato.escala.reparaciones,
      segunda: formato.segunda
        ? {
            separador: formato.segunda.separador,
            decimales: formato.segunda.decimales,
            reparaciones: formato.segunda.reparaciones,
          }
        : null,
      margen: Number.isFinite(formato.margen) ? formato.margen : -1,
      indecidible: formato.indecidible,
    });
  });
  return salida;
}

/** Lo medido de una corrida entera, etapa por etapa. */
export interface Instrumentacion extends MedicionDeCandidatas {
  /** Cuántas filas del haz semántico salieron de cada candidata de tabla. */
  lecturasPorCandidata: number[];
  msInterpretacion: number;
  ms: number;
}

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
  /**
   * Cuánto trabajo hizo cada etapa y cuánto tardó.
   *
   * Va en el informe y no en un log porque es lo que permite contestar «¿por
   * qué este comprobante tardó siete segundos?» sin volver a correrlo: cuántas
   * líneas se miraron, cuántas llegaron a artículo, cuántos esqueletos y
   * cuántas combinaciones se probaron, y cuánto costó cada parte.
   */
  instrumentacion: Instrumentacion;
  /** Qué escala se eligió para cada columna numérica, y con qué evidencia. */
  escalas: EscalaInformada[];
  /**
   * El pie fiscal reconciliado, asignación por asignación.
   *
   * Es más que los cuatro totales de `pie`: dice de qué fragmento salió cada
   * número, qué igualdad cumple, cuánto costó leerlo, cuál era la segunda mejor
   * asignación y con cuánto margen ganó la elegida. Y admite cero, una o varias
   * percepciones, que es como son los papeles.
   */
  pieFiscal: PieFiscal;
  /** Qué hizo la relectura focalizada, cuando hubo una. */
  relectura?: InformeDeRelectura;
  ms: number;
}

/**
 * Qué pasó con la relectura, medido aparte.
 *
 * Se informa siempre que haya habido una, gane o pierda. Una relectura que no
 * recuperó nada es un dato tan útil como una que recuperó diez celdas: dice que
 * el número no está en la foto y que lo que corresponde es pedírselo a una
 * persona, no seguir intentando.
 */
export interface InformeDeRelectura {
  /** Cuántas celdas bloqueadas justificaron la relectura. */
  celdasPedidas: number;
  /** Cuántas bandas se releyeron, dentro del presupuesto. */
  bandas: number;
  /** Cuánto tardó la relectura en sí, sin el resto del motor. */
  ms: number;
  /** ¿Ganó la lectura con relectura, o siguió ganando la original? */
  gano: boolean;
  /** Cuántos renglones se comprueban solos antes y después. */
  comprobadosAntes: number;
  comprobadosDespues: number;
  /** Cuántos bloqueos había antes y quedaron después. */
  bloqueosAntes: number;
  bloqueosDespues: number;
}

export interface OpcionesDelMotorReconstruido {
  cuitDelReceptor?: string;
  /**
   * La evidencia de una relectura focalizada, si ya se capturó.
   *
   * Se usa **sólo si la primera reconstrucción quedó incompleta**, y se suma a
   * la original en vez de reemplazarla: la lectura de la página entera sigue
   * compitiendo dentro del mismo motor de candidatas, y si la relectura salió
   * peor, pierde.
   */
  relectura?: EvidenciaDeRelectura;
  /**
   * Celdas que una persona ya confirmó mirando el papel.
   *
   * Es la mitad que le faltaba a la lista de bloqueos: sirve de poco decir
   * «confirmá la cantidad del renglón cinco» si después no se puede volver a
   * interpretar el comprobante con esa cantidad puesta. Con la confirmación
   * aplicada, el renglón vuelve a entrar al **mismo** motor de candidatas —la
   * misma aritmética, el mismo orden de preferencias— y sus consecuencias se
   * recalculan: si el precio y el subtotal que estaban en duda ahora cierran
   * con la cantidad confirmada, dejan de ser bloqueos solos.
   *
   * El número de renglón es el del informe, empezando en 1.
   */
  confirmaciones?: CeldaConfirmada[];
  /**
   * Productos que el flujo de catálogo ya asoció de forma inequívoca.
   *
   * El motor no busca por parecido de nombre ni inventa una asociación. Recibe
   * el resultado del flujo existente —código/PLU, vínculo aprendido o selección
   * manual— y lo conserva por renglón. Si falta, el renglón queda con
   * `BLOCKING_PRODUCT`; si el producto existe pero no trae una unidad de stock,
   * queda con `BLOCKING_UNIT`.
   */
  asociacionesDeProducto?: AsociacionDeProductoConfirmada[];
}

/** Una celda que una persona leyó del papel y dio por buena. */
export interface CeldaConfirmada {
  /** El renglón del informe, empezando en 1. */
  renglon: number;
  campo: CampoDeColumna;
  /** El valor tal como lo tipeó, en el formato del papel. */
  texto: string;
}

/** Una asociación ya resuelta fuera del OCR. */
export interface AsociacionDeProductoConfirmada {
  /** El renglón del informe, empezando en 1. */
  renglon: number;
  productoId: string;
  /** La unidad viene del producto del catálogo, no del encabezado de la factura. */
  unidadDeStock: UnidadComercial | null;
}

export function interpretarReconstruccion(
  evidencia: EvidenciaDeLectura,
  opciones: OpcionesDelMotorReconstruido = {},
): InformeReconstruido {
  const primero = interpretarUnaVez(evidencia, opciones);
  if (!opciones.relectura) return primero;

  /*
   * La relectura se activa **después** de que la primera reconstrucción quedó
   * incompleta, nunca antes. Un comprobante que se leyó entero no se relee: no
   * hay nada que recuperar y sí hay medio segundo por cada banda que gastar.
   */
  const pedidas = celdasParaReleer(
    primero.tabla,
    primero.pendientes,
    renglonesQueNoCierran(primero),
  );
  if (!convieneReleer(pedidas)) return primero;

  /*
   * Las confirmaciones viajan a la segunda pasada igual que a la primera.
   *
   * Se olvidaban, y era un error silencioso de los peores: una persona
   * confirmaba una cantidad, la relectura ganaba —como gana en la factura larga
   * del banco— y el informe volvía con la confirmación descartada y el mismo
   * bloqueo pedido otra vez. Lo único que no se hereda es la relectura: la
   * segunda pasada **es** la relectura.
   */
  const segundo = interpretarUnaVez(sumarRelectura(evidencia, opciones.relectura), {
    cuitDelReceptor: opciones.cuitDelReceptor,
    confirmaciones: opciones.confirmaciones,
    asociacionesDeProducto: opciones.asociacionesDeProducto,
  });

  /*
   * Cuál de las dos vale lo decide el **mismo orden lexicográfico** que decide
   * todo lo demás. No hay ninguna preferencia por la relectura: si los
   * fragmentos nuevos no mejoran ni los renglones conservados, ni los
   * comprobados, ni las reparaciones, gana la original.
   */
  const a = primero.veredicto.ganadora;
  const b = segundo.veredicto.ganadora;

  /*
   * Y además **no puede verificar menos renglones que antes**.
   *
   * El orden lexicográfico compara dos interpretaciones de la misma evidencia, y
   * acá la evidencia no es la misma: la segunda tiene fragmentos que la primera
   * no tenía. Eso rompe el supuesto del primer nivel. «Conservar todos los
   * renglones reales» quiere decir no perder un artículo impreso; con fragmentos
   * nuevos pasa a premiar al que **le puso un número a una fila que no lo
   * tenía**, y un número inventado sirve igual que uno bueno para eso.
   *
   * Se midió con basura: seis fragmentos de ocho nueves tirados encima de la
   * columna de precios le daban importe a una fila que estaba sin él, subían el
   * primer nivel y ganaban, aunque tres renglones dejaran de cumplir su propia
   * cuenta.
   *
   * La aritmética del renglón es el único control que no depende de nada más, y
   * unos fragmentos que **agregan** información no pueden hacer que se verifique
   * menos que antes. Si eso pasa, lo que trajeron no es información.
   */
  const noVerificaMenos = comprobados(segundo) >= comprobados(primero);

  /*
   * Y tampoco puede **empeorar la peor suposición** del comprobante.
   *
   * Unos fragmentos que vienen a recuperar valores impresos no pueden dejar la
   * lectura apoyada en una suposición más grave que la que había. Cuando pasa,
   * lo que trajeron no es un valor que faltaba: es ruido que corrió las cosas de
   * lugar. La basura de la prueba no gana por ponerle plata a una fila —no le
   * pone ninguna— sino por mover el reparto hasta que la continuación de una
   * descripción queda con nombre propio y cuenta como artículo; lo que la
   * delata es que, con ella, un valor que estaba en la escala de su columna pasa
   * a estar cien veces afuera.
   */
  const peor = (informe: InformeReconstruido) =>
    (informe.veredicto.ganadora?.renglones ?? []).reduce((n, r) => Math.max(n, r.severidad), 0);
  const noSuponePeor = peor(segundo) <= peor(primero);

  const mejora = noVerificaMenos && noSuponePeor;
  const gano =
    a !== null && b !== null ? compararCandidatas(b, a) < 0 && mejora : b !== null && mejora;

  const informe: InformeDeRelectura = {
    celdasPedidas: pedidas.length,
    bandas: new Set(opciones.relectura.pasadas.map((p) => p.zona)).size,
    ms: opciones.relectura.msTotal,
    gano,
    comprobadosAntes: comprobados(primero),
    comprobadosDespues: comprobados(segundo),
    bloqueosAntes: soloBloqueantes(primero.pendientes).length,
    bloqueosDespues: soloBloqueantes(segundo.pendientes).length,
  };

  const elegido = gano ? segundo : primero;
  return { ...elegido, relectura: informe, ms: primero.ms + segundo.ms };
}

/**
 * Qué renglones no cumplen su propia aritmética, empezando en 1.
 *
 * Un renglón que tiene controles y falla alguno es un renglón donde **alguna**
 * de sus celdas numéricas se leyó mal, sin que se sepa cuál: la igualdad se
 * rompe entera. Los que no tienen ningún control no entran acá —a ésos les
 * falta una celda y eso ya lo pide la lista de pendientes.
 */
/**
 * Cómo nombra `leFalta` a cada campo de la cuenta.
 *
 * Existe para poder emparejar una sugerencia con el bloqueo al que corresponde
 * sin comparar textos a ojo: son los mismos tres campos escritos de dos
 * maneras, y que el emparejamiento se rompa en silencio dejaría el bloqueo sin
 * su sugerencia sin que nada lo diga.
 */
const COMO_LO_LLAMA_LE_FALTA: Partial<Record<CampoDeColumna, string>> = {
  cantidad: 'la cantidad',
  kilos: 'la cantidad',
  piezas: 'la cantidad',
  precioUnitario: 'el precio',
  precioConDescuento: 'el precio',
  importe: 'el importe',
};

export function renglonesQueNoCierran(informe: InformeReconstruido): number[] {
  const renglones = informe.veredicto.ganadora?.renglones ?? [];
  const numeros: number[] = [];
  renglones.forEach((renglon, indice) => {
    if (renglon.controles.length > 0 && renglon.controles.some((c) => !c.paso)) {
      numeros.push(indice + 1);
    }
  });
  return numeros;
}

function comprobados(informe: InformeReconstruido): number {
  const renglones = informe.veredicto.ganadora?.renglones ?? [];
  return renglones.filter((r) => r.controles.length > 0 && r.controles.every((c) => c.paso)).length;
}

function interpretarUnaVez(
  evidencia: EvidenciaDeLectura,
  opciones: OpcionesDelMotorReconstruido = {},
): InformeReconstruido {
  const comienzo = Date.now();

  const estructuraDeTexto = estructuraDeLaEvidencia(evidencia);
  const textos = estructuraDeTexto.textos;

  /*
   * Se interpretan **todas** las maneras de armar la tabla y gana la que mejor
   * cierra, no la que se armó primero.
   *
   * Es lo que permite probar un reparto global de las columnas sin arriesgar lo
   * que la reconstrucción por cercanía ya resolvía bien: si el reparto mejora el
   * comprobante, gana con la suma contra el pie; si lo empeora, pierde y no tocó
   * nada. Ninguna de las dos muta a la otra.
   */
  /** Interpreta una tabla con las dos convenciones decimales del documento. */
  const interpretarTabla = (
    tabla: TablaReconstruida,
    filasEsperadas: number,
  ): CandidataDeTabla[] => {
    const columnas = tabla.columnas.map((c) => c.campo);
    const lecturas: CandidataDeTabla[] = [];

    for (const convencion of ['ar', 'us'] as ConvencionDecimal[]) {
      const pie = leerPie(textos.completo, convencion);
      const lecturasDeRenglones = elegirParaElDocumento(
        tabla.renglones,
        columnas,
        convencion,
        pie.netTotal,
      );
      for (const renglones of lecturasDeRenglones) {
        const { puntaje, penalizaciones, sumaDeRenglones, cierre } = puntuarTabla(renglones, {
          netTotal: pie.netTotal,
          /*
           * Las filas esperadas salen del consenso entre columnas, no de una sola
           * fuente. Si tres columnas sostienen dos renglones y una sostiene uno
           * porque el OCR perdió un valor, hay dos.
           */
          filasVistas: Math.max(filasEsperadas, tabla.renglones.length),
        });
        lecturas.push({
          convencion,
          pie,
          renglones,
          puntaje,
          penalizaciones,
          sumaDeRenglones,
          cierre,
          reparaciones: renglones.reduce((total, r) => total + r.reparaciones, 0),
        });
      }
    }

    return lecturas;
  };

  const medicion = medicionVacia();
  const armados = candidatasDeTabla(evidencia, medicion).map((candidata) => ({
    candidata,
    lecturas: interpretarTabla(candidata.tabla, candidata.filasEsperadas),
  }));

  /*
   * Dentro de cada reconstrucción se elige con el **orden lexicográfico**: ahí
   * el conjunto de renglones está fijo y «conservar todos los renglones reales»
   * quiere decir lo que tiene que querer decir, que es no tirar ninguno para
   * que la cuenta cierre.
   *
   * Entre reconstrucciones distintas la pregunta es otra y el orden no sirve
   * para responderla. Son hipótesis de **estructura**: una parte la tabla en
   * veintitrés renglones y otra en veinticuatro porque cortó una descripción a
   * la mitad, y comparar «cuántos renglones reales conserva cada una» premia a
   * la que más corta. Cuántos artículos tiene el papel ya lo decidió el
   * consenso entre columnas —y `puntuarTabla` penaliza a la lectura que
   * interpreta menos filas de las que el detector vio—, así que acá se compara
   * el puntaje del comprobante, con la lectura que menos repara como desempate.
   *
   * Fue un error medido: con el orden lexicográfico aplicado también acá, la
   * relectura de la banda de precios hacía ganar una reconstrucción de
   * veinticuatro renglones —uno de ellos la continuación de una descripción— a
   * la de veintitrés, que es la correcta.
   */
  const mejorDeCada = armados.map((armado) => {
    const ordenadas = [...armado.lecturas].sort(compararCandidatas);
    return { ...armado, mejor: ordenadas[0].puntaje, reparaciones: ordenadas[0].reparaciones };
  });
  const elegido = mejorDeCada.reduce((a, b) =>
    b.mejor > a.mejor || (b.mejor === a.mejor && b.reparaciones < a.reparaciones) ? b : a,
  );

  /*
   * Y recién acá se aplican las confirmaciones de una persona.
   *
   * Después de elegir la estructura y antes de decidir los pendientes, que es
   * el único lugar donde tiene sentido: la confirmación se refiere al renglón
   * **tal como el informe lo numeró**, así que hace falta que la tabla ya esté
   * elegida. Lo que se hace con ella no es escribir el valor en el resultado:
   * se reemplaza el texto de la celda y el renglón vuelve a pasar por el mismo
   * motor de candidatas. Si con la cantidad confirmada el precio y el subtotal
   * que estaban en duda cierran, dejan de estar en duda solos; y si no cierran,
   * siguen pedidos. Confirmar una celda no confirma las demás.
   */
  let tabla = elegido.candidata.tabla;
  let candidatas = elegido.lecturas;
  if (opciones.confirmaciones?.length) {
    tabla = conCeldasConfirmadas(tabla, opciones.confirmaciones);
    candidatas = interpretarTabla(tabla, elegido.candidata.filasEsperadas);
  }

  /*
   * La asociación se aplica después de elegir la estructura.
   *
   * Un producto no puede hacer ganar una lectura del OCR: primero se decide qué
   * dice el papel y recién después adónde va en el catálogo. Aplicarlo antes
   * permitiría que un vínculo existente inclinara el reparto de columnas o la
   * escala numérica, que es exactamente la contaminación que se quiere evitar.
   */
  candidatas = conAsociacionesDeProducto(candidatas, opciones.asociacionesDeProducto ?? []);

  const inicioDelDetalle = tabla.renglones[0]?.caja.y0;
  const emisor = leerEmisorDeEvidencia(
    evidencia,
    opciones.cuitDelReceptor,
    estructuraDeTexto,
    inicioDelDetalle,
  );

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
  const escalas = escalasDeLaTabla(tabla);
  const provisorio = decidir(candidatas, sinResolver);
  const pendientes = queFaltaResolver(tabla, provisorio, sinResolver, escalas);

  if (emisor.cuit === null) {
    const ambiguo = emisor.estadoCuit === 'AMBIGUOUS_TAX_ID';
    pendientes.push({
      id: 'emisor:cuit',
      dependeDe: null,
      categoria: ambiguo ? 'BLOCKING_AMBIGUOUS_CELL' : 'BLOCKING_MISSING_CELL',
      renglon: null,
      campo: 'cuitEmisor',
      columna: 'zona del emisor',
      alternativas: (emisor.candidatosCuit ?? []).flatMap((candidato) => {
        const origen = candidato.procedencias[0];
        return origen
          ? [{
              texto: candidato.cuit,
              caja: origen.caja,
              pasada: origen.pasada,
              confianza: origen.confianza,
              delPropioOcr: origen.alternativaDelOcr,
            }]
          : [];
      }),
      elegido: null,
      motivo: ambiguo
        ? 'La zona del emisor contiene más de un CUIT válido con evidencia equivalente. Hay que confirmar cuál emitió el comprobante.'
        : 'La zona del emisor no contiene un CUIT válido comprobable. Hay que identificar al emisor antes de registrar la compra.',
    });
  }
  const columnasQueFrenan = soloBloqueantes(pendientes)
    .filter((p) => p.categoria === 'BLOCKING_UNKNOWN_COLUMN')
    .map((p) => p.columna!);

  /*
   * Las compuertas permanentes, que no dependen del puntaje.
   *
   * Se arman de la misma lista de pendientes que ve una persona, así que lo que
   * frena el comprobante y lo que se le muestra a quien tiene que resolverlo
   * son lo mismo. No hay forma de que el informe diga «revisar el renglón 5» y
   * el veredicto sea «automática», ni al revés.
   */
  const frenos = soloBloqueantes(pendientes)
    .filter(
      (p) =>
        p.categoria === 'BLOCKING_UNPROVEN_ROW' ||
        p.categoria === 'BLOCKING_UNDECIDED_SCALE' ||
        p.categoria === 'BLOCKING_PRODUCT' ||
        p.categoria === 'BLOCKING_UNIT' ||
        p.id === 'emisor:cuit',
    )
    .map((p) => p.motivo);

  const veredicto = decidir(candidatas, columnasQueFrenan, frenos);

  /*
   * Y al final el pie fiscal, reconciliado como un grafo de relaciones.
   *
   * Va después del veredicto y no antes porque necesita la suma del detalle:
   * el neto gravado es el único concepto del pie con una relación **externa**
   * —tiene que dar esa suma— y con el neto puesto se verifican los IVAs contra
   * su alícuota y el total contra la suma de todo. El pie basado en etiquetas
   * sigue corriendo antes, porque la búsqueda de la tabla necesita un neto para
   * apuntar; esto lo completa y lo explica, asignación por asignación.
   */
  const pieFiscal = reconciliarPie(evidencia.fragmentos, {
    sumaDelDetalle: veredicto.ganadora?.sumaDeRenglones ?? null,
    alturaTipica: tabla.alturaTipica,
    renglonesDelDetalle: tabla.renglones.length,
    desdeY: tabla.renglones[0]?.y ?? 0,
    /*
     * Dónde termina el detalle, para poder proponer el recuadro de totales como
     * una región propia. Es el borde de abajo del último artículo y no su
     * altura: un renglón ocupa alto, y cortar por el centro deja media línea
     * del detalle adentro del pie.
     */
    finDelDetalle: tabla.renglones.length
      ? Math.max(...tabla.renglones.map((r) => r.caja.y1))
      : undefined,
  });

  /*
   * **Un importe leído sin concepto es una pregunta, no cuatro campos vacíos.**
   *
   * El papel imprimió un número, el motor lo leyó y conserva su texto, su caja y
   * sus alternativas; lo único que falta es saber qué concepto es. Se pregunta
   * una vez por número, con dónde encontrarlo en la foto, en vez de dejar el
   * neto, el IVA y el total vacíos y que parezca que faltan tres datos.
   *
   * Va acá, después de reconciliar, porque el pie necesita la suma del detalle
   * y la suma necesita el veredicto: antes de este punto no se sabe todavía qué
   * importes quedaron sin asignar.
   */
  for (const importe of pieFiscal.sinAsignar) {
    pendientes.push({
      id: `pie:sinAsignar:${importe.texto}@${importe.caja.x0.toFixed(3)}`,
      dependeDe: null,
      categoria: 'BLOCKING_UNASSIGNED_AMOUNT',
      renglon: null,
      campo: null,
      columna: 'pie fiscal',
      alternativas: [
        {
          texto: importe.texto,
          caja: importe.caja,
          pasada: importe.pasada,
          confianza: importe.confianza,
        },
      ],
      elegido: importe.valor?.toString() ?? null,
      motivo:
        `El pie tiene un importe leído —«${importe.texto}»— del que no se pudo probar qué ` +
        `concepto es. Está en ${importe.region}. Hay que decir si es el neto, el IVA, una ` +
        `percepción, un concepto no gravado o el total: el número ya está leído.`,
    });
  }

  return {
    emisor,
    tabla,
    pie: veredicto.ganadora?.pie ?? candidatas[0].pie,
    pieFiscal,
    candidatas,
    veredicto,
    pendientes,
    resumen: resumir(pendientes),
    reconstruccionElegida: elegido.candidata.origen,
    escalas,
    instrumentacion: {
      ...medicion,
      lecturasPorCandidata: armados.map((a) => a.lecturas.length),
      msInterpretacion:
        Date.now() - comienzo - medicion.msReconstruccion - medicion.msCandidatas,
      ms: Date.now() - comienzo,
    },
    reconstruccionesProbadas: mejorDeCada.map((a) => ({
      origen: a.candidata.origen,
      puntaje: a.mejor,
      renglones: a.candidata.tabla.renglones.length,
    })),
    ms: Date.now() - comienzo,
  };
}

/**
 * Adjunta el destino de stock sin participar de la interpretación del papel.
 *
 * Dos confirmaciones distintas para el mismo renglón se tratan como ninguna:
 * no hay una asociación confirmada y elegir la primera sería otra forma de
 * completar por orden. Las repeticiones idénticas sí representan una sola.
 */
function conAsociacionesDeProducto(
  candidatas: CandidataDeTabla[],
  asociaciones: AsociacionDeProductoConfirmada[],
): CandidataDeTabla[] {
  const porRenglon = new Map<number, AsociacionDeProductoConfirmada | null>();

  for (const asociacion of asociaciones) {
    if (!Number.isInteger(asociacion.renglon) || asociacion.renglon < 1) continue;
    const productoId = asociacion.productoId.trim();
    if (productoId === '') continue;
    const normalizada = { ...asociacion, productoId };
    const anterior = porRenglon.get(asociacion.renglon);
    if (anterior === undefined) {
      porRenglon.set(asociacion.renglon, normalizada);
      continue;
    }
    if (
      anterior === null ||
      anterior.productoId !== normalizada.productoId ||
      anterior.unidadDeStock !== normalizada.unidadDeStock
    ) {
      porRenglon.set(asociacion.renglon, null);
    }
  }

  return candidatas.map((candidata) => ({
    ...candidata,
    renglones: candidata.renglones.map((renglon, i) => {
      const asociacion = porRenglon.get(i + 1) ?? null;
      return {
        ...renglon,
        productoId: asociacion?.productoId ?? null,
        unidadDeStock: asociacion?.unidadDeStock ?? null,
      };
    }),
  }));
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
  /** Qué columnas llevan números, para no ofrecer un sobrante donde no cabe. */
  esNumerica: (columna: number) => boolean,
  /** Lo que sobró en los renglones de arriba y de abajo. */
  deLosVecinos: { texto: string; caja?: { x0: number; y0: number; x1: number; y1: number } }[] = [],
): FilaDeDatos[] {
  const base = (
    elegida: (columna: number) => string | null,
    lugares: (columna: number) => string | undefined = (i) =>
      renglon.celdas[i]?.alternativas[0] ? lugarDe(renglon.celdas[i]!.alternativas[0].caja) : undefined,
  ): FilaDeDatos => {
    let x = 0;
    const celdas: (Celda | null)[] = renglon.celdas.map((celda, i) => {
      const texto = celda ? elegida(i) : null;
      if (texto === null) return null;
      const desde = x;
      x += texto.length + 2;
      return { texto, desde, hasta: x - 2, lugar: lugares(i) };
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
  /*
   * Sólo se ofrecen los sobrantes que **pueden ser un número corrido de fila**,
   * y sólo en las celdas donde cabría un número.
   *
   * Un sobrante sin un dígito no es un importe que se fue de renglón: es una
   * mancha del papel o una letra suelta, y ofrecerla en cada celda de cada
   * renglón multiplica el trabajo por diez sin agregar una sola lectura que
   * pueda cerrar una cuenta. Sobre la factura de Lácteos Barraza el segundo
   * renglón arrastra once sobrantes —«To», «AL», «P», «ECN»…— y tres tienen
   * dígitos.
   *
   * Lo que hace falta conservar es el caso real: el importe del primer renglón
   * queda fuera de toda columna, y tiene que poder volver a su celda.
   */
  const utiles = [...renglon.sobrantes, ...deLosVecinos].filter((s) => /\d/.test(s.texto));
  for (const sobrante of utiles) {
    const suLugar = sobrante.caja ? lugarDe(sobrante.caja) : undefined;
    renglon.celdas.forEach((celda, i) => {
      if (!celda || !esNumerica(i)) return;
      filas.push(
        base(
          (j) => (j === i ? sobrante.texto : renglon.celdas[j]?.texto ?? null),
          (j) =>
            j === i
              ? suLugar
              : renglon.celdas[j]?.alternativas[0]
                ? lugarDe(renglon.celdas[j]!.alternativas[0].caja)
                : undefined,
        ),
      );
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
): RenglonCandidato[][] {
  const esNumerica = (columna: number): boolean => llevaNumeros(columnas[columna]?.campo);

  /*
   * El formato de cada columna se calcula **una vez, sobre la columna entera**,
   * y después cada celda se lee adentro de él.
   *
   * Es el desacople que faltaba. Antes cada celda se leía sola: todas las
   * lecturas posibles de sus dígitos, sin nada que las ordenara, y quien elegía
   * era la búsqueda contra el total. Así, un precio que el OCR devolvió sin un
   * solo separador se leía como lo que más acercara la suma al neto impreso, que
   * es ajustar un número para que dé.
   *
   * Los otros veinte valores de esa misma columna dicen cómo escribe este papel:
   * cuántos decimales, con qué separador, en qué orden de magnitud. Bajo esa
   * hipótesis el mutilado tiene una lectura preferida y las absurdas quedan
   * marcadas como tales, antes de que el total opine.
   */
  const formatos = new Map<CampoDeColumna, FormatoDeColumna>();
  columnas.forEach((columna, i) => {
    const campo = columna?.campo;
    if (!campo || !CAMPOS_NUMERICOS.has(campo)) return;
    const textos = renglones.map((r) => r.celdas[i]?.texto ?? '');
    const formato = formatoDeColumna(textos);
    if (formato) formatos.set(campo, formato);
  });

  const porFila = renglones.map((renglon, i) => {
    const vecinos = [renglones[i - 1], renglones[i + 1]]
      .filter((v): v is RenglonReconstruido => v !== undefined)
      .flatMap((v) => v.sobrantes);
    const candidatas = variantesDeFila(renglon, i, esNumerica, vecinos).flatMap((fila) =>
      candidatasDeRenglon(fila, columnas, convencion, formatos),
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
        c.campoCantidadFacturada ?? '',
        c.unidadFacturada ?? '',
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

  if (!netoImpreso || netoImpreso.lte(0)) return conEmpatesDeCantidad(elegidas, porFila);

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

      /*
       * **El total impreso confirma una escala; no la crea.**
       *
       * Éste es el agujero por el que se colaba el error de escala entero, y no
       * estaba en la lectura de la celda —que elegía bien— sino acá. Sobre una
       * de las fotos del lote el neto del pie salió leído sin su separador
       * decimal, cien veces más grande. Con ese objetivo, esta búsqueda
       * encontraba para cada renglón una lectura cien veces más grande que se
       * le acercaba —existe siempre, porque la columna la ofrece marcada como
       * ajena— y la iba tomando renglón por renglón hasta que el comprobante
       * cerraba perfecto con **todos** los costos cien veces mal. Cada cambio
       * mejoraba la distancia al total, y el total era el equivocado.
       *
       * Así que la búsqueda no puede empeorar la posición de un renglón frente
       * a la escala de sus columnas: puede cambiar una lectura por otra que su
       * columna sostiene igual o mejor, y ninguna que su columna desmienta más.
       * Lo que está impreso en la celda y en el resto de la columna decide el
       * orden de magnitud antes que cualquier cuenta, y una cuenta que cierra
       * cien veces fuera de escala no es evidencia de nada.
       *
       * No hay umbral ni excepción: si el pie está mal leído, el comprobante no
       * cierra y va a revisión, que es exactamente lo que tiene que pasar.
       */
      if (alternativa.escalasAjenas > incumbente.escalasAjenas) continue;

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

  return conEmpatesDeCantidad(mejor, porFila);
}

/**
 * Conserva como comprobantes independientes los empates sobre qué magnitud se factura.
 *
 * La selección rápida de cada fila toma su primera lectura para no hacer un
 * producto cartesiano de todas las celdas. Eso no puede borrar un empate entre
 * kilos, cantidad y piezas: si las dos lecturas tienen exactamente los mismos
 * controles y costos, ninguna evidencia independiente permite elegir. Se arma
 * una candidata completa por cada origen empatado y el veredicto ve margen
 * cero, en vez de aceptar el orden accidental en que se generaron.
 */
function conEmpatesDeCantidad(
  elegidos: RenglonCandidato[],
  porFila: RenglonCandidato[][],
): RenglonCandidato[][] {
  const campos = new Set<NonNullable<RenglonCandidato['campoCantidadFacturada']>>();
  for (let i = 0; i < elegidos.length; i++) {
    const incumbente = elegidos[i];
    if (!incumbente) continue;
    for (const alternativa of porFila[i] ?? []) {
      if (mismaFuerzaSalvoCantidad(incumbente, alternativa)) {
        if (alternativa.campoCantidadFacturada) campos.add(alternativa.campoCantidadFacturada);
      }
    }
  }

  const salida = [elegidos];
  for (const campo of campos) {
    const variante = elegidos.map((incumbente, i) =>
      (porFila[i] ?? []).find(
        (alternativa) =>
          alternativa.campoCantidadFacturada === campo &&
          mismaFuerzaSalvoCantidad(incumbente, alternativa),
      ) ?? incumbente,
    );
    if (variante.some((renglon, i) => renglon !== elegidos[i])) salida.push(variante);
  }
  return salida;
}

function mismaFuerzaSalvoCantidad(
  izquierda: RenglonCandidato,
  derecha: RenglonCandidato,
): boolean {
  if (izquierda.campoCantidadFacturada === derecha.campoCantidadFacturada) return false;
  const controles = (renglon: RenglonCandidato): string =>
    renglon.controles.map((control) => `${control.nombre}:${control.paso}`).join('|');
  return (
    puntosDeRenglon(izquierda) === puntosDeRenglon(derecha) &&
    controles(izquierda) === controles(derecha) &&
    izquierda.reparaciones === derecha.reparaciones &&
    izquierda.severidad === derecha.severidad &&
    izquierda.incoherentes === derecha.incoherentes &&
    izquierda.escalasAjenas === derecha.escalasAjenas &&
    (netoDelRenglon(izquierda)?.eq(netoDelRenglon(derecha) ?? NaN) ?? false)
  );
}

/** Cuánto vale una lectura de renglón por sí sola. */
function puntosDeRenglon(renglon: RenglonCandidato): number {
  let puntos = 0;
  for (const control of renglon.controles) puntos += control.paso ? 10 : -10;
  /*
   * Una lectura que necesita suponer un salto de escala pierde contra
   * cualquiera que no lo necesite, **incluso si cierra la cuenta**.
   *
   * Cierra porque la proporción se mantiene: el mismo renglón cien veces más
   * grande multiplica igual. Nada dentro del renglón lo desmiente, y por eso el
   * desempate no puede vivir adentro del renglón: vive en la columna, que es la
   * que dice en qué orden de magnitud está escrita. La severidad viene de ahí.
   *
   * El peso es mayor que el de un control aprobado a propósito. No es que la
   * cuenta importe menos: es que una cuenta que cierra cien veces fuera de
   * escala no es evidencia de nada, y aceptarla ensucia el costo de cada
   * artículo sin que ninguna igualdad lo delate.
   */
  puntos -= renglon.severidad * 12;
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
export function queFaltaResolver(
  tabla: TablaReconstruida,
  veredicto: Veredicto,
  sinResolver: string[],
  /**
   * Qué escala se eligió para cada columna. Sólo se mira si alguna quedó
   * indecidible, que es el único caso que frena.
   */
  escalas: EscalaInformada[] = [],
): Pendiente[] {
  const pendientes: Pendiente[] = [];

  /*
   * **Una fila que no probó ser un artículo frena el comprobante.**
   *
   * Es una deuda del motor, escrita como tal. La clasificación de renglones
   * deja una línea como `pendiente` cuando tiene apoyo de sus vecinos pero no
   * llegó a las dos familias de evidencia independientes que hacen falta para
   * darla por buena. Sobre una de las fotos del lote quedó una así, y no se la
   * puede borrar: la misma evidencia que la sostiene sostiene a un artículo
   * verdadero, y el corte que la elimina elimina a los dos.
   *
   * Mientras esté, el comprobante no se acepta solo. Y no se acepta **aunque
   * después cierren los números y el pie**, que es justamente el riesgo: una
   * fila de más cuyo importe se lea de una manera que haga cuadrar la suma
   * pasaría inadvertida para siempre, con un artículo que nadie compró en el
   * historial de precios. Ninguna cuenta puede contestar si esa fila estaba
   * impresa; eso lo contesta una persona mirando la foto.
   */
  tabla.renglones.forEach((renglon, i) => {
    if (renglon.clase !== 'pendiente') return;
    if (renglon.apoyos.includes('identidad')) return;
    pendientes.push({
      id: `renglon:${i + 1}:existe`,
      dependeDe: null,
      categoria: 'BLOCKING_UNPROVEN_ROW',
      renglon: i + 1,
      campo: null,
      columna: null,
      alternativas: [],
      elegido: null,
      motivo:
        `Confirmar si el renglón ${i + 1} es un artículo impreso en el papel. ` +
        `Se conservó porque sus vecinos lo sostienen (${renglon.apoyos.join(', ') || 'sin apoyos propios'}), ` +
        `pero no se leyó nada que lo identifique, y la aritmética no puede decidir si existe. ` +
        `${renglon.motivo}`,
    });
  });

  /*
   * **Una columna con dos escalas posibles y ninguna ancla frena el comprobante.**
   *
   * Cuando ningún valor de la columna tiene un separador impreso, «1500» es mil
   * quinientos o quince con la misma legitimidad, y las dos lecturas son
   * coherentes con la columna entera. Lo que **no** se puede hacer es elegir la
   * que haga cerrar el total: el total leído con la misma convención cierra con
   * las dos, así que no desempata nada, y usarlo es dejar que la aritmética
   * invente un orden de magnitud que el papel no dice. Va a revisión con las
   * dos hipótesis a la vista y decide una persona.
   */
  for (const escala of escalas) {
    if (!escala.indecidible || !escala.segunda) continue;
    const como = (e: { separador: string; decimales: number }) =>
      e.separador === 'ninguno' ? 'sin decimales' : `con ${e.decimales} decimales`;
    pendientes.push({
      id: `escala:${escala.columna}`,
      dependeDe: null,
      categoria: 'BLOCKING_UNDECIDED_SCALE',
      renglon: null,
      campo: escala.columna,
      columna: escala.columna,
      alternativas: [],
      elegido: null,
      motivo:
        escala.anclas.length === 0
          ? `La columna «${escala.columna}» no tiene ningún valor con separadores impresos, ` +
            `así que se puede leer ${como(escala)} o ${como(escala.segunda)} y las dos son ` +
            `coherentes con toda la columna. Hay que mirar el papel: el total no sirve para ` +
            `decidirlo porque cierra con las dos.`
          : /*
             * El otro conflicto: hay evidencia impresa, pero no toda apunta al
             * mismo lado. Una ancla puede proponer un formato y no declararlo
             * resuelto contra las celdas que no caben en él.
             */
            `La columna «${escala.columna}» tiene ${escala.anclas.length} valor/es que la ` +
            `muestran ${como(escala)} (${escala.anclas.slice(0, 3).join(', ')}) y ` +
            `${escala.contradicen} celda/s que no pueden estar escritas así. La otra lectura ` +
            `posible es ${como(escala.segunda)}. Es una sola decisión de columna: cuál de las ` +
            `dos es, y todas sus celdas se releen con ésa.`,
    });
  }

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
      id: `columna:${nombre}`,
      dependeDe: null,
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
      id: 'pie:netTotal',
      dependeDe: null,
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
  const cierran = new Set<number>();
  (veredicto.ganadora?.renglones ?? []).forEach((renglon, i) => {
    if (renglon.controles.length > 0 && renglon.controles.every((c) => c.paso)) cierran.add(i);
  });

  /*
   * Y lo que le falta a cada renglón para poder comprobarse, que es lo que el
   * cierre del comprobante **no** demuestra.
   *
   * Va como falta de celda y no como columna por confirmar, porque no es lo
   * mismo ni para quien lo lee ni para lo que hay que hacer: una columna por
   * confirmar se contesta una vez y vale para el formato; un renglón sin precio
   * es un dato que falta en ese renglón y hay que mirarlo ahí.
   */
  /*
   * Y con ellos, cuánto **daría** el valor que falta.
   *
   * La sugerencia viaja dentro del bloqueo, no en el renglón: la celda sigue
   * faltando, el renglón sigue sin comprobarse y la compra sigue sin poder
   * guardarse. Lo único que agrega es que quien vaya a tipear el número sepa
   * contra qué contrastarlo.
   */
  const sugerencias = sugerenciasDerivadas(veredicto.ganadora?.renglones ?? []);

  /*
   * La raíz de cada renglón, decidida **antes** de emitir un solo bloqueo.
   *
   * Es la corrección que convierte un informe ilegible en uno accionable. En
   * una factura del banco, cuatro cantidades dañadas producían treinta y dos
   * ambigüedades: el precio de ese renglón, su descuento, su subtotal y su
   * cierre no se pueden decidir hasta resolver la cantidad. No son treinta y
   * dos problemas, son cuatro con sus consecuencias, y contarlos todos le dice
   * a una persona que tiene media hora de trabajo cuando tiene cuatro números
   * que mirar.
   */
  const raices = raicesPorRenglon(tabla, veredicto);

  (veredicto.ganadora?.renglones ?? []).forEach((renglon, i) => {
    for (const falta of leFalta(renglon)) {
      const sugerencia = sugerencias.find(
        (s) => s.renglon === i + 1 && COMO_LO_LLAMA_LE_FALTA[s.campo] === falta,
      );
      pendientes.push({
        id: `r${i + 1}:falta:${falta}`,
        dependeDe: null,
        categoria: 'BLOCKING_MISSING_CELL',
        renglon: i + 1,
        campo: falta,
        columna: null,
        alternativas: [],
        elegido: null,
        ...(sugerencia ? { sugerencia } : {}),
        motivo:
          `Al renglón ${i + 1} le falta ${falta}, así que no se puede comprobar contra su ` +
          'propia aritmética. Que la suma del comprobante dé el neto impreso no lo reemplaza.' +
          (sugerencia
            ? ` La aritmética del renglón da ${sugerencia.valor.toString()} ` +
              `(${DERIVED_SUGGESTION}: valor calculado, no leído del papel; ` +
              `sale de ${sugerencia.deDondeSale}). Hay que confirmarlo contra el comprobante.`
            : ''),
      });
    }
  });

  /*
   * El cierre contable no decide adónde se mueve el stock.
   *
   * Ésta es la separación central de la corrección: `cantidadFacturada` puede
   * estar perfectamente probada por cantidad × precio = importe, y aun así no
   * existir un producto al cual aplicarla. El motor no usa la descripción para
   * inventar ese vínculo. Se pide **una sola acción** por renglón: asociar el
   * producto. La unidad no se cuenta aparte porque normalmente la asociación la
   * resuelve sola.
   *
   * Sólo cuando ya hay producto y ese producto no tiene unidad de stock aparece
   * `BLOCKING_UNIT` como raíz propia. La unidad impresa de la factura se muestra
   * como evidencia de facturación, pero no reemplaza la configuración del
   * catálogo: facturar «UNIDADES» y mover stock por unidad son decisiones de
   * capas distintas.
   */
  (veredicto.ganadora?.renglones ?? []).forEach((renglon, i) => {
    if (renglon.productoId === null) {
      pendientes.push({
        id: `r${i + 1}:producto`,
        dependeDe: null,
        categoria: 'BLOCKING_PRODUCT',
        renglon: i + 1,
        campo: 'productoId',
        columna: 'producto del catálogo',
        alternativas: [],
        elegido: null,
        motivo:
          `El renglón ${i + 1}${renglon.codigo ? ` (código ${renglon.codigo})` : ''} ` +
          'todavía no está asociado de forma inequívoca a un producto del catálogo. ' +
          'La cantidad y los importes pueden cerrar, pero no se puede actualizar stock ni ' +
          'historial de costos hasta resolverlo por código/PLU, vínculo aprendido o selección ' +
          'manual; el parecido del nombre no alcanza.',
      });
      return;
    }

    if (renglon.unidadDeStock !== null) return;
    const impresa =
      renglon.unidadFacturada === 'KG'
        ? 'El comprobante factura kilos'
        : renglon.unidadFacturada === 'UNIT'
          ? 'El comprobante factura unidades'
          : 'El comprobante no declara la unidad de la cantidad facturada';
    pendientes.push({
      id: `r${i + 1}:unidad`,
      dependeDe: null,
      categoria: 'BLOCKING_UNIT',
      renglon: i + 1,
      campo: 'unidadDeStock',
      columna: 'unidad del producto',
      alternativas: [],
      elegido: null,
      motivo:
        `El producto asociado al renglón ${i + 1} (${renglon.productoId}) no tiene una ` +
        `unidad de stock resuelta. ${impresa}, pero ese dato no autoriza a cambiar la unidad ` +
        'comercial del catálogo. Hay que confirmar KG o UNIT antes de registrar el movimiento.',
    });
  });

  /*
   * Y un bloqueo por cada renglón reconstruido que no llegó a interpretarse.
   *
   * Es la raíz de la que dependen todas sus celdas: una sola pregunta, «¿esto
   * es un artículo del papel o es una línea de basura?», en vez de una por
   * columna.
   */
  const interpretados = veredicto.ganadora?.renglones.length ?? 0;

  /*
   * Y un bloqueo por cada renglón que no cierra sin que ninguna celda haya
   * quedado ambigua: la raíz existe aunque el motor no pueda señalar cuál de
   * las tres celdas está mal.
   */
  for (const [i, raiz] of raices) {
    if (!raiz.endsWith(':no-cierra')) continue;
    const candidato = veredicto.ganadora?.renglones[i];
    if (!candidato) continue;
    pendientes.push({
      id: raiz,
      dependeDe: null,
      categoria: 'BLOCKING_AMBIGUOUS_CELL',
      renglon: i + 1,
      campo: null,
      /*
       * Un bloqueo de renglón entero no tiene campo, y tiene que decir igual de
       * qué se trata: todo pendiente con renglón nombra un campo o una columna,
       * porque si no, en la pantalla queda un ítem sin encabezado.
       */
      columna: 'el renglón entero',
      alternativas: [],
      elegido: null,
      motivo:
        `El renglón ${i + 1} tiene sus tres valores y la cuenta no cierra: ` +
        `${(candidato.kilos ?? candidato.cantidad ?? candidato.piezas) ?? '?'} × ` +
        `${candidato.precioConDescuento ?? candidato.precioUnitario ?? '?'} no da ` +
        `${candidato.importe ?? '?'}. El OCR no dudó de ninguna de las tres, así que ` +
        'hay que mirar el papel y decir cuál está mal.',
    });
  }

  tabla.renglones.forEach((renglon, i) => {
    if (i < interpretados) return;
    const conTexto = renglon.celdas
      .filter((c) => c?.texto)
      .map((c) => c!.texto)
      .join(' ')
      .trim();
    pendientes.push({
      id: `r${i + 1}:sin-interpretar`,
      dependeDe: null,
      categoria: 'BLOCKING_MISSING_CELL',
      renglon: i + 1,
      campo: null,
      columna: 'el renglón entero',
      alternativas: [],
      elegido: conTexto || null,
      motivo:
        `El renglón ${i + 1} se vio en la foto pero no alcanzó para ser un artículo: ` +
        `no tiene descripción ni código ni una cuenta propia` +
        (conTexto ? ` (se leyó «${conTexto}»)` : '') +
        '. Hay que decir si es un artículo del comprobante o una línea de basura de la foto.',
    });
  });

  tabla.renglones.forEach((renglon, i) => {
    /*
     * Un renglón está confirmado cuando **su propia** aritmética cierra.
     *
     * Antes alcanzaba con que cerrara el comprobante entero, y eso era dar por
     * buena una fila con el argumento equivocado: la suma de los importes prueba
     * que la columna de importes está completa, no que las cantidades, los
     * precios y los descuentos de cada fila estén donde corresponde. Sobre la
     * foto de Lácteos Barraza los dos importes sumaban exacto mientras el
     * segundo renglón tenía un 42 % que no cierra con nada, y todas sus
     * ambigüedades salían como simples anotaciones.
     */
    const cerro = cierran.has(i);

    renglon.celdas.forEach((celda, j) => {
      const columna = tabla.columnas[j];
      const campo = columna?.campo?.campo;
      const nombreDeColumna = columna?.titulo ?? `columna ${j + 1}`;
      // La descripción y la marca no entran en ninguna igualdad.
      if (!campo || !CAMPOS_NUMERICOS.has(campo)) return;

      if (!celda) {
        pendientes.push({
          id: `r${i + 1}:${campo}:sin-celda`,
          dependeDe: cerro ? null : (raices.get(i) ?? null),
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

      const suId = `r${i + 1}:${campo}`;
      const raiz = raices.get(i) ?? null;
      pendientes.push({
        id: suId,
        dependeDe: cerro || raiz === suId ? null : raiz,
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

    renglon.sobrantes.forEach((sobrante, k) => {
      pendientes.push({
        id: `r${i + 1}:sobrante:${k}`,
        dependeDe: cerro ? null : (raices.get(i) ?? null),
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
    });
  });

  return pendientes;
}

/**
 * Cuál es el bloqueo **raíz** de cada renglón que no cierra.
 *
 * Devuelve, por índice de renglón, el `id` del pendiente del que dependen todos
 * los demás de esa fila. Dos casos:
 *
 *  - **le falta una celda**: la raíz es esa celda. No hay nada que decidir
 *    sobre el precio de un renglón cuya cantidad no existe;
 *  - **están las tres y la cuenta no cierra**: alguna de las tres se leyó mal y
 *    la igualdad no dice cuál. La raíz es la celda con la evidencia más débil:
 *    la que se apartó más de la escala de su columna, después la que necesitó
 *    más reparaciones, y a igualdad de todo, la que el OCR leyó con menos
 *    confianza. Es una conjetura y está dicho que lo es: se ofrece como el
 *    primer lugar donde mirar, no como un diagnóstico.
 *
 * Un renglón que cierra no tiene raíz: lo que le quede es una anotación.
 */
/**
 * Una copia de la tabla con las celdas confirmadas reemplazadas.
 *
 * **Copia**, no mutación: la tabla reconstruida es la evidencia de cómo se leyó
 * la foto y tiene que seguir diciendo lo mismo después de que alguien corrija
 * una celda. Lo que cambia es la interpretación, no la lectura.
 *
 * La celda confirmada queda en estado `confirmada`, con el texto de la persona
 * como única alternativa: no vuelve a competir con lo que el OCR había leído
 * —ya se decidió— y las demás celdas del renglón quedan intactas, con todas sus
 * alternativas, para que la aritmética las vuelva a elegir con el dato nuevo.
 */
function conCeldasConfirmadas(
  tabla: TablaReconstruida,
  confirmaciones: CeldaConfirmada[],
): TablaReconstruida {
  const renglones = tabla.renglones.map((renglon, i) => {
    const suyas = confirmaciones.filter((c) => c.renglon === i + 1);
    if (suyas.length === 0) return renglon;

    const celdas = renglon.celdas.map((celda, j) => {
      const campo = tabla.columnas[j]?.campo?.campo;
      const confirmada = suyas.find((c) => c.campo === campo);
      if (!confirmada) return celda;
      return {
        columna: j,
        texto: confirmada.texto,
        alternativas: [
          {
            texto: confirmada.texto,
            caja: celda?.alternativas[0]?.caja ?? renglon.caja,
            cajaEnLaFoto: celda?.alternativas[0]?.cajaEnLaFoto ?? renglon.caja,
            pasada: 'confirmada por una persona',
            confianza: 1,
          },
        ],
        estado: 'confirmada' as const,
        procedencia: celda?.procedencia ?? null,
      };
    });

    return { ...renglon, celdas };
  });

  return { ...tabla, renglones };
}

function raicesPorRenglon(tabla: TablaReconstruida, veredicto: Veredicto): Map<number, string> {
  const salida = new Map<number, string>();
  const renglones = veredicto.ganadora?.renglones ?? [];

  /*
   * Un renglón reconstruido que **no llegó a interpretarse** es un solo
   * problema, no uno por celda.
   *
   * Pasa cuando la fila se vio en la foto pero no alcanza para ser un artículo:
   * no tiene descripción, ni código, ni una cuenta propia. Sus cinco celdas
   * dudosas no son cinco preguntas: la pregunta es una, «¿esto es un artículo o
   * es basura de la foto?», y hasta contestarla no hay nada que decidir sobre
   * su precio.
   */
  tabla.renglones.forEach((_, i) => {
    if (i >= renglones.length) salida.set(i, `r${i + 1}:sin-interpretar`);
  });

  renglones.forEach((candidato, i) => {
    const cierra = candidato.controles.length > 0 && candidato.controles.every((c) => c.paso);
    if (cierra) return;

    const falta = leFalta(candidato);
    if (falta.length > 0) {
      salida.set(i, `r${i + 1}:falta:${falta[0]}`);
      return;
    }

    // Están las tres y la cuenta no cierra: la celda con la evidencia más débil.
    const fila = tabla.renglones[i];
    if (!fila) return;

    /*
     * Y la raíz tiene que ser un bloqueo que **exista**: sólo las celdas
     * ambiguas emiten pendiente propio, así que elegir la celda de menor
     * confianza entre todas dejaba consecuencias apuntando a una raíz que nunca
     * se informaba. Una dependencia colgada es peor que ninguna: el informe
     * dice que algo se destraba solo y no hay nada que resolver para
     * destrabarlo.
     */
    let peor: { campo: CampoDeColumna; puntos: number } | null = null;
    fila.celdas.forEach((celda, j) => {
      const campo = tabla.columnas[j]?.campo?.campo;
      if (!campo || !CAMPOS_NUMERICOS.has(campo) || !celda) return;
      if (celda.estado !== 'ambigua') return;
      const confianza = celda.alternativas[0]?.confianza ?? 0;
      const puntos = (celda.alternativas.length - 1) * 10 + (1 - confianza) * 5;
      if (!peor || puntos > peor.puntos) peor = { campo, puntos };
    });

    /*
     * Si ninguna celda quedó ambigua y la cuenta igual no cierra, la raíz es el
     * renglón entero: están las tres celdas, cada una con una sola lectura, y
     * alguna está mal sin que el OCR haya dudado. Es el caso en que el motor no
     * puede señalar la celda culpable, y decirlo es mejor que repartir la culpa
     * entre las tres.
     */
    salida.set(
      i,
      peor ? `r${i + 1}:${(peor as { campo: CampoDeColumna }).campo}` : `r${i + 1}:no-cierra`,
    );
  });

  return salida;
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

  /*
   * Y el caso intermedio: el encabezado se leyó, pero lo que hay debajo no
   * alcanzó para confirmarlo. Decirle a alguien «se dedujo sin encabezado
   * legible» cuando el encabezado está impreso y se lee es confundirlo sobre
   * qué tiene que mirar.
   */
  if (columna.campo?.origen === 'EXACT_HEADER') {
    return (
      `Confirmar que «${nombre}» es ${campo}. El encabezado se lee, pero lo que hay debajo ` +
      'salió demasiado borroneado para confirmarlo. Los renglones ya se reconstruyeron con ' +
      'esa lectura.'
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
