import type { Decimal } from '@/lib/money';
import { esFilaDeEncabezados, llevaNumeros } from '@/lib/ocr/motor/columnas';
import {
  alto,
  centroY,
  unir as unirCajas,
  type Caja,
  type EvidenciaDeLectura,
  type Fragmento,
} from '@/lib/ocr/reconstruccion/evidencia';
import {
  alturaDeRenglon,
  enderezar,
  enGrados,
  medirInclinacion,
  valeLaPenaEnderezar,
  type Inclinacion,
} from '@/lib/ocr/reconstruccion/inclinacion';
import {
  agruparPorLugar,
  armarRenglones,
  esNumerico,
  mejorLectura,
  repartirCelda,
  textoPreferido,
  lecturasAlternativas,
  unirPartidas,
  type LecturaDeCelda,
  type Observacion,
  type RenglonVisual,
} from '@/lib/ocr/reconstruccion/agrupar';

export type { LecturaDeCelda } from '@/lib/ocr/reconstruccion/agrupar';
import {
  columnaDe,
  detectarColumnas,
  type ColumnaEspacial,
  type MetodoDeLimites,
} from '@/lib/ocr/reconstruccion/columnas-espaciales';
import {
  bandasDeArticulos,
  clasificarRenglones,
  type CandidataDeBanda,
  type ClaseDeRenglon,
  type FamiliaDeApoyo,
} from '@/lib/ocr/reconstruccion/renglones';

/**
 * Reconstruir la tabla de un comprobante a partir de la evidencia del OCR.
 *
 * Es la capa que faltaba. El motor semántico sabe qué hacer con una tabla —qué
 * es cada columna, qué cuentas tienen que cerrar, cuándo no creerle a una
 * lectura— pero hasta ahora recibía **texto ya aplanado**, y sobre una foto de
 * teléfono ese texto llega con los renglones partidos y las columnas cruzadas.
 * Ningún perfil guardado arregla eso: una persona puede decir qué significa una
 * columna, no puede recuperar veinte renglones que se perdieron antes.
 *
 * Acá se trabaja con coordenadas, con todas las pasadas juntas, y el resultado
 * no es «la tabla» sino **la tabla con su procedencia**: de qué pasada salió
 * cada valor, qué alternativas tenía, qué celdas quedaron sin leer y cuáles
 * quedaron ambiguas. Eso es lo que después permite pedirle a una persona lo
 * único que hace falta, en vez de la tabla entera.
 */

export type EstadoDeCelda =
  /** Se leyó y hay una sola lectura con apoyo. */
  | 'leida'
  /** Hay más de una lectura posible y ninguna manda. */
  | 'ambigua'
  /** No hay nada en esa posición del renglón. */
  | 'no-leida'
  /**
   * Una persona la leyó del papel y la dio por buena.
   *
   * No vuelve a competir con lo que el OCR había leído: eso ya se decidió, y
   * mirando el original, que es más de lo que el motor puede hacer. Lo que sí
   * se recalcula es todo lo que **dependía** de ella.
   */
  | 'confirmada';

export interface Procedencia {
  pasada: string;
  confianza: number;
  /**
   * Dónde está en la foto tal como salió, sin enderezar: para poder señalarlo.
   *
   * Se llama así y no `caja` a propósito. Es **procedencia**, no geometría: si
   * se llamara `caja`, tarde o temprano alguien decide con ella, y decidir en
   * dos espacios a la vez es el defecto que esta corrección vino a cerrar.
   */
  cajaEnLaFoto: Caja;
}

export interface CeldaReconstruida {
  columna: number;
  texto: string | null;
  /** Todas las lecturas posibles, la elegida primero, cada una con su origen. */
  alternativas: LecturaDeCelda[];
  estado: EstadoDeCelda;
  procedencia: Procedencia | null;
}

export type EstadoDeRenglon =
  | 'completo'
  | 'incompleto'
  /** Tiene valores que no caen en ninguna columna: casi siempre son de otra fila. */
  | 'contaminado';

export interface RenglonReconstruido {
  /** Altura en la página, para poder ordenarlos y señalarlos. */
  y: number;
  caja: Caja;
  celdas: (CeldaReconstruida | null)[];
  /** Lo que no entró en ninguna columna. */
  sobrantes: { texto: string; caja: Caja }[];
  estado: EstadoDeRenglon;
  /**
   * Si es un artículo, si está pendiente de prueba, si es la continuación de la
   * descripción de arriba o si no es nada.
   *
   * Está acá y no en un filtro previo a propósito: una línea descartada tiene
   * que poder mirarse. Lo que se descartó en silencio no se puede auditar, y
   * las filas fantasma de Los Calvos aparecieron justamente porque nadie podía
   * ver qué estaba entrando a la tabla.
   */
  clase: ClaseDeRenglon;
  /** Qué familias de evidencia lo sostienen. */
  apoyos: FamiliaDeApoyo[];
  /** Índice del renglón al que se pega, cuando es continuación. */
  continuacionDe: number | null;
  /** Por qué quedó en esa clase. */
  motivo: string;
}

export interface TablaReconstruida {
  columnas: ColumnaEspacial[];
  metodo: MetodoDeLimites;
  /** Los títulos tal como se leyeron. */
  encabezados: string[];
  /**
   * Sólo los artículos: los aceptados y los pendientes, con las continuaciones
   * ya pegadas a su renglón.
   */
  renglones: RenglonReconstruido[];
  /**
   * Todas las líneas que se miraron, con su clase. Es lo que permite auditar
   * qué se descartó y por qué sin volver a correr nada.
   */
  hipotesis: RenglonReconstruido[];
  /** Hasta dónde se consideró que llega la tabla, y por qué.  */
  banda: { hastaY: number; origen: string };
  /** Cuántas líneas de texto se vieron entre la tabla, antes de interpretarlas. */
  filasVisibles: number;
  inclinacionGrados: number;
  seEnderezo: boolean;
  alturaTipica: number;
  notas: string[];
  /** Cuántos valores salieron de una pasada distinta de la principal. */
  valoresDeOtraPasada: number;
  ms: number;
}

export interface OpcionesDeReconstruccion {
  /** Sólo se reconstruye lo que esté entre estas alturas de la página. */
  desdeY?: number;
  hastaY?: number;
  /**
   * Qué candidata de banda de artículos usar, de las que propone la evidencia.
   *
   * Cero es la más generosa —conserva todo— y las siguientes van cortando. Que
   * se elija desde afuera es lo que permite que compitan entre sí en vez de que
   * una regla fija decida por todas.
   */
  banda?: number;
  /**
   * Los netos que se leyeron en el pie, con cualquiera de las dos convenciones.
   *
   * Es una evidencia más para saber qué es cada columna: la columna de montos
   * cuya suma da el neto impreso es el importe del renglón, y eso lo dice el
   * comprobante entero sin depender de ningún encabezado. Es opcional porque la
   * reconstrucción tiene que funcionar igual sin el pie.
   */
  netosPosibles?: Decimal[];
}

/**
 * La pasada que se considera principal, para poder contar de dónde vino cada valor.
 *
 * Es la de la página completa: la que existiría si no hubiera relectura. Contar
 * cuántos valores vinieron de otra es la medida de cuánto aporta leer varias
 * veces, y hasta ahora no se podía saber porque los textos se pegaban.
 */
const PASADA_PRINCIPAL = 'completo:directo';

/**
 * Lo que la reconstrucción tiene listo antes de decidir dónde va cada celda.
 *
 * Se expone para poder armar **varias** candidatas de tabla sobre la misma
 * evidencia sin volver a leer, enderezar y delimitar columnas tres veces.
 */
export interface ContextoDeTabla {
  cuerpo: RenglonVisual[];
  columnas: ColumnaEspacial[];
  metodo: MetodoDeLimites;
  encabezados: string[];
  alturaTipica: number;
  inclinacionGrados: number;
  seEnderezo: boolean;
  notas: string[];
  hayColumnasNumericas: boolean;
}

export function reconstruirTabla(
  evidencia: EvidenciaDeLectura,
  opciones: OpcionesDeReconstruccion = {},
): TablaReconstruida {
  const { tabla } = reconstruirConContexto(evidencia, opciones);
  return tabla;
}

export function reconstruirConContexto(
  evidencia: EvidenciaDeLectura,
  opciones: OpcionesDeReconstruccion = {},
): { tabla: TablaReconstruida; contexto: ContextoDeTabla } {
  const comienzo = Date.now();
  const notas: string[] = [];

  const desdeY = opciones.desdeY ?? 0;
  const hastaY = opciones.hastaY ?? 1;
  const enRango = evidencia.fragmentos.filter((f) => {
    const y = centroY(f.caja);
    return y >= desdeY && y <= hastaY && !esRuido(f.texto);
  });
  const descartados = evidencia.fragmentos.length - enRango.length;
  if (descartados > 0) notas.push(`${descartados} fragmentos descartados por no tener ningún carácter legible.`);

  // --- Enderezar -----------------------------------------------------------
  const alturaCruda = alturaDeRenglon(enRango);
  const inclinacion: Inclinacion = medirInclinacion(enRango);
  const corregir = valeLaPenaEnderezar(inclinacion, alturaCruda);
  const enderezados = enderezar(enRango, corregir ? inclinacion : { pendiente: 0, apoyos: 0 });
  if (corregir) {
    notas.push(
      `Se corrigió una inclinación de ${enGrados(inclinacion).toFixed(2)}° ` +
        `(${inclinacion.apoyos} apoyos).`,
    );
  }

  // --- Juntar lo que dijeron todas las pasadas -----------------------------
  const observaciones = agruparPorLugar(enderezados);
  const alturaTipica = alturaDeRenglon(enderezados) || alturaCruda;

  // --- Renglones visuales --------------------------------------------------
  const visuales = armarRenglones(observaciones, alturaTipica).map((renglon) => ({
    ...renglon,
    observaciones: unirPartidas(renglon, alturaTipica),
  }));

  // --- La fila de títulos --------------------------------------------------
  const titulos = encontrarTitulos(visuales);
  if (!titulos) notas.push('No se encontró una fila de títulos entre los renglones visibles.');

  const cuerpo = cortarEnElPie(
    titulos ? visuales.filter((r) => r.y > titulos.y) : visuales,
    notas,
  );

  // --- Columnas ------------------------------------------------------------
  const limites = detectarColumnas(cuerpo, titulos, alturaTipica, opciones.netosPosibles ?? []);
  notas.push(...limites.notas);

  // --- Celdas --------------------------------------------------------------
  const hayColumnasNumericas = limites.columnas.some((c) => llevaNumeros(c.campo?.campo));
  let valoresDeOtraPasada = 0;

  /*
   * Primero **hipótesis**, no renglones.
   *
   * Acá se arma una por cada línea que se vio, sin decidir todavía si es un
   * artículo: esa pregunta necesita ver las demás líneas —qué columnas ocupan
   * las vecinas, dónde termina la tabla— y contestarla línea por línea es lo
   * que dejaba entrar la grilla vacía.
   */
  const hipotesis: RenglonReconstruido[] = [];

  for (const visual of cuerpo) {
    const celdas: (CeldaReconstruida | null)[] = limites.columnas.map(() => null);
    const sobrantes: { texto: string; caja: Caja }[] = [];
    const enConflicto: Observacion[][] = limites.columnas.map(() => []);

    for (const observacion of visual.observaciones) {
      const indice = columnaDe(observacion, limites.columnas);
      if (indice === null) {
        sobrantes.push({ texto: textoPreferido(observacion), caja: observacion.caja });
        continue;
      }
      enConflicto[indice].push(observacion);
    }

    enConflicto.forEach((competidoras, i) => {
      if (competidoras.length === 0) return;
      celdas[i] = armarCelda(i, competidoras);
      const procedencia = celdas[i]!.procedencia;
      if (procedencia && procedencia.pasada !== PASADA_PRINCIPAL) valoresDeOtraPasada += 1;
    });

    const llenas = celdas.filter((c) => c !== null).length;
    // Con una sola celda no hay renglón posible: ni siquiera es una hipótesis.
    if (llenas < 1) continue;

    hipotesis.push({
      y: visual.y,
      caja: visual.caja,
      celdas,
      sobrantes,
      estado:
        sobrantes.length > 0
          ? 'contaminado'
          : llenas === limites.columnas.length
            ? 'completo'
            : 'incompleto',
      clase: 'pendiente',
      apoyos: [],
      continuacionDe: null,
      motivo: '',
    });
  }

  // --- Hasta dónde llega la tabla ------------------------------------------
  const bandas = bandasDeArticulos(hipotesis, limites.columnas, alturaTipica);
  const banda: CandidataDeBanda = bandas[Math.min(opciones.banda ?? 0, bandas.length - 1)];

  // --- Qué es cada línea ---------------------------------------------------
  const clases = clasificarRenglones(hipotesis, {
    columnas: limites.columnas,
    alturaTipica,
    hastaY: banda.hastaY,
  });
  clases.forEach((clasificacion, i) => {
    hipotesis[i].clase = clasificacion.clase;
    hipotesis[i].apoyos = clasificacion.apoyos;
    hipotesis[i].continuacionDe = clasificacion.continuacionDe;
    hipotesis[i].motivo = clasificacion.motivo;
  });

  const renglones = articulosConSusContinuaciones(hipotesis, limites.columnas);

  const descartadas = hipotesis.filter((h) => h.clase === 'ruido').length;
  const continuaciones = hipotesis.filter((h) => h.clase === 'continuacion').length;
  if (descartadas > 0) {
    notas.push(
      `${descartadas} línea/s no llegaron a artículo y quedaron como ruido; ` +
        `la tabla termina en ${banda.hastaY === 1 ? 'el final del cuerpo' : banda.origen}.`,
    );
  }
  if (continuaciones > 0) {
    notas.push(`${continuaciones} línea/s son la continuación de la descripción de arriba.`);
  }

  const contexto: ContextoDeTabla = {
    cuerpo,
    columnas: limites.columnas,
    metodo: limites.metodo,
    encabezados: titulos ? titulos.observaciones.map((o) => textoPreferido(o)) : [],
    alturaTipica,
    inclinacionGrados: enGrados(inclinacion),
    seEnderezo: corregir,
    notas,
    hayColumnasNumericas,
  };

  return {
    contexto,
    tabla: {
      columnas: limites.columnas,
      metodo: limites.metodo,
      encabezados: contexto.encabezados,
      renglones,
      hipotesis,
      banda,
      filasVisibles: cuerpo.length,
      inclinacionGrados: enGrados(inclinacion),
      seEnderezo: corregir,
      alturaTipica,
      notas,
      valoresDeOtraPasada,
      ms: Date.now() - comienzo,
    },
  };
}

/**
 * La misma tabla con otro final de la banda de artículos.
 *
 * Rehace sólo la clasificación, que es barata: las líneas ya están armadas y
 * las columnas ya están puestas. Es lo que permite que los finales posibles
 * **compitan** —cada uno es una candidata más, y gana el que hace cerrar el
 * comprobante— en vez de que una regla de distancia decida por todos.
 */
export function conOtraBanda(
  tabla: TablaReconstruida,
  banda: CandidataDeBanda,
): TablaReconstruida {
  // Copia superficial a propósito: la clasificación sólo escribe la clase y sus
  // motivos, y conservar el mismo arreglo de celdas es lo que permite reusar lo
  // ya calculado sobre esas mismas líneas en vez de rehacerlo por cada corte.
  const hipotesis = tabla.hipotesis.map((h) => ({ ...h }));
  clasificarRenglones(hipotesis, {
    columnas: tabla.columnas,
    alturaTipica: tabla.alturaTipica,
    hastaY: banda.hastaY,
  }).forEach((clasificacion, i) => {
    hipotesis[i].clase = clasificacion.clase;
    hipotesis[i].apoyos = clasificacion.apoyos;
    hipotesis[i].continuacionDe = clasificacion.continuacionDe;
    hipotesis[i].motivo = clasificacion.motivo;
  });

  return {
    ...tabla,
    hipotesis,
    banda,
    renglones: articulosConSusContinuaciones(hipotesis, tabla.columnas),
  };
}

/** Los finales de banda que propone la evidencia de una tabla ya armada. */
export function bandasDe(tabla: TablaReconstruida): CandidataDeBanda[] {
  return bandasDeArticulos(tabla.hipotesis, tabla.columnas, tabla.alturaTipica);
}

/**
 * Los artículos de la tabla, con las continuaciones pegadas a su renglón.
 *
 * «STRE CAV» debajo de un artículo es el final de su nombre, no otro artículo.
 * Antes entraba como renglón propio y llegaba hasta el informe: contaba como
 * una fila sin importe —con lo que el control de integridad concluía que
 * faltaban renglones— y le pedía a una persona que completara sus celdas. Ahora
 * se pega al de arriba, que es lo que dice el papel, y no genera ni una sola
 * acción.
 */
export function articulosConSusContinuaciones(
  hipotesis: RenglonReconstruido[],
  columnas: ColumnaEspacial[],
): RenglonReconstruido[] {
  const salida = hipotesis
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => h.clase === 'aceptado' || h.clase === 'pendiente')
    .map(({ h }) => ({ ...h, celdas: [...h.celdas] }));

  const dondeQuedo = new Map<number, (typeof salida)[number]>();
  let cual = 0;
  hipotesis.forEach((h, i) => {
    if (h.clase === 'aceptado' || h.clase === 'pendiente') dondeQuedo.set(i, salida[cual++]);
  });

  for (const h of hipotesis) {
    if (h.clase !== 'continuacion' || h.continuacionDe === null) continue;
    const suyo = dondeQuedo.get(h.continuacionDe);
    if (!suyo) continue;

    h.celdas.forEach((celda, i) => {
      // Sólo en las columnas donde van nombres: una continuación es el resto de
      // una descripción, nunca el resto de un código ni de un importe.
      const campo = columnas[i]?.campo?.campo;
      const deNombres = campo === 'descripcion' || campo === 'marca' || campo === 'UNKNOWN_TEXT';
      if (!celda?.texto || !deNombres) return;
      const actual = suyo.celdas[i];
      if (!actual?.texto) {
        suyo.celdas[i] = celda;
        return;
      }
      // El texto se suma al que ya estaba, en el orden en que está impreso.
      suyo.celdas[i] = {
        ...actual,
        texto: `${actual.texto} ${celda.texto}`,
        alternativas: [
          {
            ...actual.alternativas[0],
            texto: `${actual.texto} ${celda.texto}`,
            caja: unirCajas(actual.alternativas[0].caja, celda.alternativas[0].caja),
          },
          ...actual.alternativas,
        ],
      };
    });
    suyo.caja = unirCajas(suyo.caja, h.caja);
  }

  return salida;
}

/**
 * Arma una celda con las observaciones que compiten por ella.
 *
 * Cuando hay una sola, es la celda. Cuando hay varias, **no se elige**: se deja
 * la de más apoyo adelante y las otras como alternativas, y la celda queda
 * marcada como ambigua. Elegir acá sería elegir sin haber hecho ninguna cuenta,
 * y la cuenta es lo único que puede distinguir un importe real de uno que el
 * OCR partió al medio.
 */
export function armarCelda(columna: number, competidoras: Observacion[]): CeldaReconstruida {
  if (competidoras.length === 1) {
    const observacion = competidoras[0];
    const alternativas = lecturasAlternativas(observacion);
    const lectura = mejorLectura(observacion);
    return {
      columna,
      texto: alternativas[0].texto,
      alternativas,
      // Que el propio OCR haya dudado también es ambigüedad, no ruido.
      estado: alternativas.length > 1 ? 'ambigua' : 'leida',
      procedencia: {
        pasada: lectura.pasada,
        confianza: lectura.confianza,
        cajaEnLaFoto: lectura.cajaEnLaFoto,
      },
    };
  }

  /*
   * Varias observaciones en la misma columna del mismo renglón.
   *
   * Antes de juntar nada hay que decidir **qué es cada una**: los pedazos de una
   * descripción van uno al lado del otro y se juntan; las lecturas que ocupan el
   * mismo lugar son la misma cosa vista por pasadas distintas y no se juntan
   * nunca, compiten. Pegar las dos cosas es lo que producía celdas que no
   * existen en ningún papel, como «27.937,3527937,35».
   */
  const reparto = repartirCelda(competidoras);
  const partes = reparto.partes.map((o) => textoPreferido(o));

  /*
   * Los pedazos de un número se pegan sin espacio; las palabras, con.
   *
   * El OCR parte los importes por la coma —«22.800» y «,00»— y los dos pedazos
   * caen en la misma columna. Unirlos con un espacio da «22.800 ,00», que no es
   * un número y deja el renglón sin importe. Una descripción de dos palabras,
   * en cambio, necesita el espacio.
   */
  const juntas = partes.join(partes.every(esNumerico) ? '' : ' ');
  const lectura = mejorLectura(reparto.partes[0]);
  const cajaDeTodas = reparto.partes.map((o) => mejorLectura(o).caja).reduce(unirCajas);
  const cajaDeTodasEnLaFoto = reparto.partes
    .map((o) => mejorLectura(o).cajaEnLaFoto)
    .reduce(unirCajas);

  /*
   * Lo descartado no se pierde: queda como alternativa de la celda, con su
   * pasada y su caja. Si el reparto elegido no hace cerrar el renglón, la otra
   * manera de leerlo sigue estando, y una persona puede verla señalada en la
   * foto en vez de tener que volver al papel.
   */
  const deLasQueCompetian = reparto.alternativas.flatMap((o) => lecturasAlternativas(o));

  const alternativas: LecturaDeCelda[] =
    reparto.partes.length === 1
      ? [...lecturasAlternativas(reparto.partes[0]), ...deLasQueCompetian]
      : [
          {
            texto: juntas,
            caja: cajaDeTodas,
            cajaEnLaFoto: cajaDeTodasEnLaFoto,
            pasada: lectura.pasada,
            confianza: lectura.confianza,
          },
          ...reparto.partes.map((o) => {
            const suya = mejorLectura(o);
            return {
              texto: suya.texto,
              caja: suya.caja,
              cajaEnLaFoto: suya.cajaEnLaFoto,
              pasada: suya.pasada,
              confianza: suya.confianza,
            };
          }),
          ...deLasQueCompetian,
        ];

  const sinRepetidas = alternativas.filter(
    (a, i) => alternativas.findIndex((b) => b.texto === a.texto) === i,
  );

  return {
    columna,
    texto: juntas,
    alternativas: sinRepetidas,
    estado: sinRepetidas.length > 1 ? 'ambigua' : 'leida',
    procedencia: {
      pasada: lectura.pasada,
      confianza: lectura.confianza,
      cajaEnLaFoto: lectura.cajaEnLaFoto,
    },
  };
}

/**
 * Lo que nunca es un dato: un fragmento sin una sola letra ni un solo dígito.
 *
 * El borde de la tabla sale como «|», las líneas de separación como «—», y una
 * mancha del papel como «]». Son decenas por factura y no son inofensivos: al
 * proyectar los datos sobre el ancho de la página tapan los corredores entre
 * columnas, y una tabla de ocho columnas termina siendo una sola.
 *
 * Se descarta por **no tener contenido**, no por ser corto: «3» es un código de
 * artículo válido y «6» una cantidad, y las dos tienen un carácter.
 */
export function esRuido(texto: string): boolean {
  return !/[\p{L}\p{N}]/u.test(texto);
}

/**
 * Corta la tabla donde empieza el pie.
 *
 * El pie tiene números grandes y creíbles repartidos en columnas, así que sus
 * líneas pasan por renglones perfectamente: sobre la factura de Mabelherdi, la
 * línea «Neto $32998.85 IVA 21.00% $6929.76» entraba como un artículo más.
 *
 * Se corta en la primera línea que **empieza** con una etiqueta de pie. Que sea
 * al principio importa: «BONIFICACION ESPECIAL» es un nombre de artículo
 * legítimo en el medio de una descripción, y cortar ahí perdería la mitad de la
 * tabla.
 */
const EMPIEZA_EL_PIE =
  /^(sub\s?-?\s?total|total\b|neto\b|i\.?\s?v\.?\s?a\.?\b|percep|perc\b|descuentos?\b|saldo|son\s+pesos|pesos\b|comentario|transporte)/i;

/**
 * Las etiquetas del pie que **no pueden estar en el medio de una tabla**.
 *
 * La lista de arriba se prueba al principio de la línea, y ahí tiene que ser
 * generosa: «IVA», «Neto» o «Total» pegados al margen izquierdo son del pie.
 * Ésta se prueba en **cualquier posición**, así que tiene que ser mucho más
 * corta: «IVA» aparece en la columna de alícuotas de cada artículo, y cortar la
 * tabla ahí la dejaría vacía.
 *
 * Lo que queda son las que nombran un concepto fiscal completo. Ninguna puede
 * aparecer adentro del nombre de un artículo.
 */
const ETIQUETA_FISCAL =
  /^(neto\s*(gravado|no\s*gravado)?|no\s*gravado|totales?|percep\w*|sub\s?-?\s?totales?|son\s+pesos)$/i;

/**
 * Corta la tabla donde empieza el pie.
 *
 * El pie tiene números grandes y creíbles repartidos en columnas, así que sus
 * líneas pasan por renglones perfectamente: sobre la factura de Mabelherdi, la
 * línea «Neto $32998.85 IVA 21.00% $6929.76» entraba como un artículo más.
 *
 * Se busca de dos maneras, y las dos hacen falta:
 *
 *  - una etiqueta de pie **al principio** de la línea, con la lista larga. Que
 *    sea al principio importa: «BONIFICACION ESPECIAL» es un nombre de artículo
 *    legítimo en el medio de una descripción, y cortar ahí perdería media tabla;
 *
 *  - una etiqueta fiscal **en cualquier posición**, con la lista corta. Hace
 *    falta porque el pie no siempre arranca pegado al margen: sobre la factura
 *    de Errecalde el «Neto Gravado» cae a un tercio del ancho, debajo de las
 *    columnas de unidad y cantidad, y con la primera regla sola trece líneas de
 *    pie —el neto, el IVA, las dos percepciones, el total y la leyenda— seguían
 *    adentro del cuerpo. No eran inofensivas: ensuciaban el perfil de todas las
 *    columnas, inventaban renglones y dejaban el conteo de artículos en cualquier
 *    cosa menos en el que tiene el papel.
 */
function cortarEnElPie(renglones: RenglonVisual[], notas: string[]): RenglonVisual[] {
  for (let i = 0; i < renglones.length; i++) {
    const textos = renglones[i].observaciones.map((o) => textoPreferido(o).trim());
    const primeras = textos.slice(0, 2).join(' ').trim();

    const porElPrincipio = EMPIEZA_EL_PIE.test(primeras);
    const fiscal = textos.find((t) => ETIQUETA_FISCAL.test(t));
    if (!porElPrincipio && fiscal === undefined) continue;

    const donde = porElPrincipio ? primeras : fiscal!;
    notas.push(`La tabla se cortó en «${donde.slice(0, 40)}», que es del pie.`);
    return renglones.slice(0, i);
  }
  return renglones;
}

/**
 * La fila de títulos, buscada entre los renglones visuales.
 *
 * Se elige el renglón **más alto de la página** que reconozca al menos tres
 * campos distintos. Más alto y no el que más reconozca: en un comprobante con
 * la tabla repetida —una segunda página, o un total por sección— el que vale es
 * el primero, y el criterio de «el que más reconoce» elegiría cualquiera de los
 * dos según cómo salió la foto.
 */
function encontrarTitulos(renglones: RenglonVisual[]): RenglonVisual | null {
  for (const renglon of renglones) {
    const textos = renglon.observaciones.map((o) => textoPreferido(o));
    if (textos.length < 3) continue;
    if (esFilaDeEncabezados(textos)) return renglon;
  }
  return null;
}

export { alto, type Fragmento };
