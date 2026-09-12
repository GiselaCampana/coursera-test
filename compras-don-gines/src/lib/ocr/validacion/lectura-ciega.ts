import { Decimal } from '@/lib/money';
import type { EvidenciaDeLectura } from '@/lib/ocr/reconstruccion/evidencia';
import {
  interpretarReconstruccion,
  type InformeReconstruido,
} from '@/lib/ocr/motor/desde-reconstruccion';
import { soloBloqueantes, soloRaices, consecuenciasDe } from '@/lib/ocr/motor/pendientes';
import { renglonConfirmado } from '@/lib/ocr/motor/sugerencias';
import type { EvidenciaDeRelectura } from '@/lib/ocr/reconstruccion/relectura';
import type { ProcedenciaFiscal } from '@/lib/ocr/motor/pie-fiscal';

/**
 * La primera lectura de una factura que el motor nunca vio.
 *
 * Todo lo que hay en el banco de fotos —Ezra, Mabelherdi, Barraza, Errecalde y
 * las dos de Los Calvos— se usó para **diseñar** el motor: cada regla se
 * escribió mirando en qué fallaba alguna de esas seis. Eso está bien mientras
 * las reglas sean generales, y no hay manera de saber si lo son mirando las
 * mismas seis facturas otra vez. Un motor sobreajustado y un motor bueno dan el
 * mismo resultado sobre el corpus con el que se ajustaron.
 *
 * Así que esta capa existe para medir **una sola vez** y sin trampa: se corre
 * el motor sobre una foto nueva, se guarda todo lo que dijo —con el hash del
 * motor y de la imagen, para que el resultado sea atribuible a una versión
 * exacta— y **recién después** se transcribe el papel para comparar. Al revés
 * no sirve: si se mira el comprobante primero, cualquier ajuste posterior
 * queda contaminado por haber visto la respuesta.
 *
 * Lo que este archivo **no** hace es juzgar. No sabe qué dice el papel y no
 * tiene con qué acertar ni errar: arma el acta de lo que el motor leyó.
 */

/** Un archivo, identificado por su contenido. */
export interface HuellaDeArchivo {
  /** El nombre, sólo para poder encontrarlo. */
  nombre: string;
  /** sha256 del contenido. Es lo que identifica la imagen, no el nombre. */
  sha256: string;
  bytes: number;
}

/**
 * Qué versión del motor produjo esta lectura.
 *
 * Hacen falta las dos cosas. El commit dice de qué versión se partió, y el
 * `sha256` de los fuentes del motor dice si había cambios sin commitear: una
 * primera lectura ciega hecha sobre un árbol sucio no es reproducible, y
 * conviene que el acta lo diga en vez de que se descubra después.
 */
export interface HuellaDelMotor {
  commit: string;
  /** sha256 sobre el contenido de los fuentes del motor, en orden. */
  sha256: string;
  archivos: number;
  /** ¿Había cambios sin commitear cuando se corrió? */
  arbolSucio: boolean;
}

export interface CalidadDeLaImagen {
  anchoPx: number;
  altoPx: number;
  megapixeles: number;
  /** Cuántas palabras leyó el OCR en total, sumando todas las pasadas. */
  fragmentos: number;
  /** La confianza media que declaró el OCR por pasada. */
  confianzaPorPasada: { pasada: string; confianza: number; ms: number }[];
  /** La inclinación que se midió y si hizo falta enderezar. */
  inclinacionGrados: number;
  seEnderezo: boolean;
}

/** Una celda tal como el motor la leyó, con de dónde salió. */
export interface CeldaLeida {
  columna: string;
  campo: string | null;
  texto: string | null;
  estado: string;
  /** De qué pasada salió y con cuánta confianza. */
  pasada: string | null;
  confianza: number | null;
  /** Las otras lecturas que había para la misma celda. */
  alternativas: string[];
}

export interface RenglonLeido {
  numero: number;
  celdas: CeldaLeida[];
  /** Lo que no cayó en ninguna columna. */
  sobrantes: string[];
  /** Los valores que el motor eligió, después de interpretar. */
  interpretado: {
    codigo: string | null;
    descripcion: string;
    cantidad: string | null;
    piezas: number | null;
    precioUnitario: string | null;
    descuentoPct: string | null;
    importe: string | null;
  } | null;
  /** ¿Cierra su propia aritmética? ¿Está confirmado? */
  cierra: boolean;
  confirmado: boolean;
}

export interface BloqueoRaizLeido {
  id: string;
  categoria: string;
  renglon: number | null;
  campo: string | null;
  columna: string | null;
  motivo: string;
  elegido: string | null;
  alternativas: { texto: string; confianza: number; pasada: string }[];
  /** El valor que la aritmética sugiere, claramente separado. */
  sugerencia: { valor: string; deDondeSale: string } | null;
  /** Cuántos bloqueos se destraban al resolverlo, y cuáles. */
  destraba: string[];
}

export interface PieLeidoEnValidacion {
  estado: string;
  netoGravado: string | null;
  noGravado: string | null;
  iva: { alicuota: string | null; valor: string }[];
  percepciones: { etiqueta: string; valor: string }[];
  total: string | null;
  totalCalculado: boolean;
  residuo: string | null;
  faltantes: string[];
  asignaciones: {
    concepto: string;
    valor: string;
    procedencia: ProcedenciaFiscal;
    igualdad: string | null;
    etiqueta: string | null;
    costoDeReparacion: number;
    margen: number;
    segunda: string | null;
    origen: { texto: string; pasada: string; confianza: number };
  }[];
}

export interface ActaDePrimeraLectura {
  /** Cuándo se corrió, en ISO. */
  cuando: string;
  motor: HuellaDelMotor;
  imagen: HuellaDeArchivo;
  calidad: CalidadDeLaImagen;

  /**
   * Lo que el motor general dice del emisor.
   *
   * Son dos campos y no cinco a propósito: el punto de venta, el número y la
   * fecha del comprobante los lee otra capa, y meterlos acá sin que el motor
   * los produzca sería registrar nulos que parecen fallas de lectura.
   */
  emisor: {
    cuit: string | null;
    razonSocial: string | null;
  };
  encabezados: string[];
  columnas: { titulo: string | null; campo: string | null; origen: string | null; confianza: number }[];

  reconstruidos: number;
  interpretados: number;
  cierranSolos: number;
  confirmados: number;
  renglones: RenglonLeido[];

  /** El cierre del detalle contra el pie. */
  cierreDelDetalle: {
    sumaDeRenglones: string;
    netoImpreso: string | null;
    compatible: boolean;
    explicacion: string | null;
  };
  pie: PieLeidoEnValidacion;

  /** Las acciones humanas, y lo que se destraba con cada una. */
  bloqueosRaiz: BloqueoRaizLeido[];
  consecuencias: number;
  advertencias: number;
  /**
   * Qué celdas el motor **no afirmó**, raíces y consecuencias juntas.
   *
   * Hace falta para comparar honestamente. Un valor que el motor pidió no es un
   * error, y no alcanza con mirar las raíces: una celda frenada como
   * consecuencia de otra tampoco fue afirmada, y contarla como error haría que
   * un motor que avisa puntuara igual que uno que adivina.
   *
   * `campo` en null quiere decir el renglón entero.
   */
  celdasNoAfirmadas: { renglon: number; campo: string | null }[];

  decision: string;
  motivoDeLaDecision: string;
  confianza: number;
  margenContraLaSegunda: number;
  /** Qué decía la segunda candidata, para poder ver si eran dos respuestas. */
  segundaCandidata: { convencion: string; puntaje: number; sumaDeRenglones: string } | null;
  reconstruccionElegida: string;
  reconstruccionesProbadas: { origen: string; puntaje: number; renglones: number }[];

  /** El tiempo, separado: la primera pasada y la relectura focalizada. */
  tiempos: {
    ocrMs: number;
    motorMs: number;
    relecturaMs: number | null;
    relecturaGano: boolean | null;
  };

  /** Qué le pediría a una persona, en su propio idioma. */
  correccionesQuePediria: string[];
}

/**
 * Los campos del motor llevados al vocabulario del acta.
 *
 * `leFalta` dice «la cantidad» y la columna dice `kilos`: son el mismo dato
 * escrito de dos maneras, y comparar contra el papel necesita uno solo. Sin
 * esta traducción, un campo pedido como «la cantidad» no se emparejaba con la
 * cantidad transcripta y contaba como error teniendo el motor razón al pedirlo.
 */
const NOMBRE_NORMAL: Record<string, string> = {
  'la cantidad': 'cantidad',
  'el precio': 'precioUnitario',
  'el importe': 'importe',
  kilos: 'cantidad',
  piezas: 'cantidad',
  precioConDescuento: 'precioUnitario',
};

function comoTexto(valor: Decimal | null | undefined): string | null {
  return valor === null || valor === undefined ? null : valor.toString();
}

/**
 * Arma el acta de la primera lectura.
 *
 * Recibe todo lo medido de afuera —los hashes, la calidad, los tiempos de
 * OCR— porque nada de eso se puede calcular desde la evidencia, y recibe el
 * informe ya corrido para no volver a correrlo: el tiempo del motor es parte de
 * lo que se registra.
 */
export function actaDePrimeraLectura(entrada: {
  motor: HuellaDelMotor;
  imagen: HuellaDeArchivo;
  evidencia: EvidenciaDeLectura;
  informe: InformeReconstruido;
  ocrMs: number;
  relectura?: EvidenciaDeRelectura;
}): ActaDePrimeraLectura {
  const { informe, evidencia } = entrada;
  const ganadora = informe.veredicto.ganadora;
  const renglonesInterpretados = ganadora?.renglones ?? [];

  const columnas = informe.tabla.columnas.map((c) => ({
    titulo: c.titulo ?? null,
    campo: c.campo?.campo ?? null,
    origen: c.campo?.origen ?? null,
    confianza: c.campo?.confianza ?? 0,
  }));

  const renglones: RenglonLeido[] = informe.tabla.renglones.map((fila, i) => {
    const candidato = renglonesInterpretados[i] ?? null;
    return {
      numero: i + 1,
      celdas: fila.celdas.map((celda, j) => ({
        columna: informe.tabla.columnas[j]?.titulo ?? `columna ${j + 1}`,
        campo: informe.tabla.columnas[j]?.campo?.campo ?? null,
        texto: celda?.texto ?? null,
        estado: celda?.estado ?? 'no-leida',
        pasada: celda?.alternativas[0]?.pasada ?? null,
        confianza: celda?.alternativas[0]?.confianza ?? null,
        alternativas: (celda?.alternativas ?? []).slice(1).map((a) => a.texto),
      })),
      sobrantes: fila.sobrantes.map((s) => s.texto),
      interpretado: candidato
        ? {
            codigo: candidato.codigo,
            descripcion: candidato.descripcion,
            cantidad: comoTexto(candidato.kilos ?? candidato.cantidad),
            piezas: candidato.piezas,
            precioUnitario: comoTexto(candidato.precioConDescuento ?? candidato.precioUnitario),
            descuentoPct: comoTexto(candidato.descuentoPct),
            importe: comoTexto(candidato.importe),
          }
        : null,
      cierra: candidato
        ? candidato.controles.length > 0 && candidato.controles.every((c) => c.paso)
        : false,
      confirmado: candidato ? renglonConfirmado(candidato) : false,
    };
  });

  const raices: BloqueoRaizLeido[] = soloRaices(informe.pendientes).map((p) => ({
    id: p.id,
    categoria: p.categoria,
    renglon: p.renglon,
    campo: p.campo,
    columna: p.columna,
    motivo: p.motivo,
    elegido: p.elegido,
    alternativas: p.alternativas.map((a) => ({
      texto: a.texto,
      confianza: a.confianza,
      pasada: a.pasada,
    })),
    sugerencia: p.sugerencia
      ? { valor: p.sugerencia.valor.toString(), deDondeSale: p.sugerencia.deDondeSale }
      : null,
    destraba: consecuenciasDe(informe.pendientes, p.id).map((c) => c.id),
  }));

  const pf = informe.pieFiscal;
  const segunda = informe.veredicto.segunda;

  /*
   * Todas las celdas frenadas, no sólo las raíces: para la comparación con el
   * papel, una consecuencia es igual de «no afirmada» que su raíz.
   */
  const noAfirmadas: { renglon: number; campo: string | null }[] = [];
  for (const pendiente of soloBloqueantes(informe.pendientes)) {
    if (pendiente.renglon === null) continue;
    const campo = pendiente.campo === null ? null : NOMBRE_NORMAL[pendiente.campo] ?? pendiente.campo;
    if (
      noAfirmadas.some((c) => c.renglon === pendiente.renglon && c.campo === campo)
    ) {
      continue;
    }
    noAfirmadas.push({ renglon: pendiente.renglon, campo });
  }

  return {
    cuando: new Date().toISOString(),
    motor: entrada.motor,
    imagen: entrada.imagen,
    calidad: {
      anchoPx: evidencia.anchoPx,
      altoPx: evidencia.altoPx,
      megapixeles: Math.round(((evidencia.anchoPx * evidencia.altoPx) / 1e6) * 100) / 100,
      fragmentos: evidencia.fragmentos.length,
      confianzaPorPasada: evidencia.pasadas.map((p) => ({
        pasada: p.id,
        confianza: p.confianza,
        ms: p.ms,
      })),
      inclinacionGrados: informe.tabla.inclinacionGrados,
      seEnderezo: informe.tabla.seEnderezo,
    },

    emisor: {
      cuit: informe.emisor.cuit ?? null,
      razonSocial: informe.emisor.razonSocial ?? null,
    },
    encabezados: informe.tabla.encabezados,
    columnas,

    reconstruidos: informe.tabla.renglones.length,
    interpretados: renglonesInterpretados.length,
    cierranSolos: renglones.filter((r) => r.cierra).length,
    confirmados: renglones.filter((r) => r.confirmado).length,
    renglones,

    cierreDelDetalle: {
      sumaDeRenglones: ganadora?.sumaDeRenglones.toString() ?? '0',
      netoImpreso: comoTexto(ganadora?.pie.netTotal),
      compatible: ganadora?.cierre?.compatible ?? false,
      explicacion: ganadora?.cierre?.explicacion ?? null,
    },
    pie: {
      estado: pf.estado,
      netoGravado: comoTexto(pf.netoGravado),
      noGravado: comoTexto(pf.noGravado),
      iva: pf.iva.map((i) => ({ alicuota: comoTexto(i.alicuota), valor: i.valor.toString() })),
      percepciones: pf.percepciones.map((p) => ({
        etiqueta: p.etiqueta,
        valor: p.valor.toString(),
      })),
      total: comoTexto(pf.total),
      totalCalculado: pf.totalCalculado,
      residuo: comoTexto(pf.residuo),
      faltantes: pf.faltantes,
      asignaciones: pf.asignaciones.map((a) => ({
        concepto: a.concepto,
        valor: a.valor.toString(),
        procedencia: a.procedencia,
        igualdad: a.igualdad,
        etiqueta: a.etiqueta?.texto ?? null,
        costoDeReparacion: a.costoDeReparacion,
        margen: a.margen,
        segunda: a.segunda ? `${a.segunda.concepto} ${a.segunda.valor.toString()}` : null,
        origen: {
          texto: a.origen.texto,
          pasada: a.origen.pasada,
          confianza: a.origen.confianza,
        },
      })),
    },

    bloqueosRaiz: raices,
    consecuencias: informe.resumen.consecuencias,
    advertencias: informe.resumen.advertenciasNoBloqueantes,
    celdasNoAfirmadas: noAfirmadas,

    decision: informe.veredicto.decision,
    motivoDeLaDecision: informe.veredicto.motivo,
    confianza: ganadora?.puntaje ?? 0,
    margenContraLaSegunda: informe.veredicto.margen,
    segundaCandidata: segunda
      ? {
          convencion: segunda.convencion,
          puntaje: segunda.puntaje,
          sumaDeRenglones: segunda.sumaDeRenglones.toString(),
        }
      : null,
    reconstruccionElegida: informe.reconstruccionElegida,
    reconstruccionesProbadas: informe.reconstruccionesProbadas,

    tiempos: {
      ocrMs: entrada.ocrMs,
      motorMs: informe.ms,
      relecturaMs: informe.relectura?.ms ?? null,
      relecturaGano: informe.relectura?.gano ?? null,
    },

    correccionesQuePediria: raices.map((r) => r.motivo),
  };
}

/**
 * Corre el motor sobre una evidencia nueva y arma el acta.
 *
 * Una sola pasada y sin relectura focalizada: la relectura necesita volver a la
 * imagen, y quién la ejecuta es el arnés de afuera. Se acepta ya capturada para
 * que el acta pueda registrarla.
 */
export function primeraLectura(entrada: {
  motor: HuellaDelMotor;
  imagen: HuellaDeArchivo;
  evidencia: EvidenciaDeLectura;
  ocrMs: number;
  cuitDelReceptor?: string;
  relectura?: EvidenciaDeRelectura;
}): ActaDePrimeraLectura {
  const informe = interpretarReconstruccion(entrada.evidencia, {
    cuitDelReceptor: entrada.cuitDelReceptor,
    relectura: entrada.relectura,
  });
  return actaDePrimeraLectura({ ...entrada, informe });
}

/** Cuántos bloqueantes hay en total, para poder contrastar con las raíces. */
export function bloqueantesDe(informe: InformeReconstruido): number {
  return soloBloqueantes(informe.pendientes).length;
}
