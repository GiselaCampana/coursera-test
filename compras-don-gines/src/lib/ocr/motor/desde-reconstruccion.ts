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
import type { Celda, FilaDeDatos } from '@/lib/ocr/motor/tabla';
import { leerEmisor, leerPie, type EmisorLeido } from '@/lib/ocr/motor/motor';
import type { EvidenciaDeLectura } from '@/lib/ocr/reconstruccion/evidencia';
import {
  reconstruirTabla,
  type RenglonReconstruido,
  type TablaReconstruida,
} from '@/lib/ocr/reconstruccion/reconstruccion';
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
  /** Qué tendría que resolver una persona, si algo. */
  pendientes: Pendiente[];
  ms: number;
}

/**
 * Algo concreto que le falta al comprobante, dicho de manera accionable.
 *
 * La diferencia entre esto y «no se pudo leer» es la que separa una revisión
 * asistida de volver a tipear la factura. Cada pendiente tiene que poder
 * resolverse con un clic o un dato corto.
 */
export interface Pendiente {
  tipo:
    | 'columna-sin-reconocer'
    | 'celda-ambigua'
    | 'celda-sin-leer'
    | 'renglon-contaminado'
    | 'pie-sin-leer';
  /** En qué renglón, contando desde 1. Null cuando es del comprobante. */
  renglon: number | null;
  /** Qué columna, por su título o su posición. */
  columna: string | null;
  detalle: string;
  /** Las opciones entre las que elegir, cuando las hay. */
  opciones?: string[];
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
    const { puntaje, penalizaciones, sumaDeRenglones } = puntuarTabla(renglones, {
      netTotal: pie.netTotal,
      filasVistas: tabla.filasVisibles,
    });
    candidatas.push({ convencion, pie, renglones, puntaje, penalizaciones, sumaDeRenglones });
  }

  const sinResolver = tabla.columnas
    .filter((c) => c.titulo !== null && c.campo === null && c.apoyos > 0)
    .map((c) => c.titulo!);

  const veredicto = decidir(candidatas, sinResolver);

  return {
    emisor,
    tabla,
    pie: veredicto.ganadora?.pie ?? candidatas[0].pie,
    candidatas,
    veredicto,
    pendientes: queFaltaResolver(tabla, veredicto, sinResolver),
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
      filas.push(base((j) => (j === i ? alternativa : renglon.celdas[j]?.texto ?? null)));
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

/**
 * Qué tendría que resolver una persona, dicho celda por celda.
 *
 * Es la parte que convierte «no se pudo» en una revisión de un minuto. Se
 * ordena por cuánto cuesta: una columna sin reconocer se resuelve una vez y vale
 * para todas las facturas de ese formato; una celda ambigua es un clic entre dos
 * opciones; una celda sin leer hay que mirarla en la foto.
 */
function queFaltaResolver(
  tabla: TablaReconstruida,
  veredicto: Veredicto,
  sinResolver: string[],
): Pendiente[] {
  const pendientes: Pendiente[] = [];

  for (const titulo of sinResolver) {
    pendientes.push({
      tipo: 'columna-sin-reconocer',
      renglon: null,
      columna: titulo,
      detalle: `Hay que decir qué es la columna «${titulo}». Se resuelve una vez y queda para este formato.`,
    });
  }

  if (!veredicto.ganadora?.pie.netTotal) {
    pendientes.push({
      tipo: 'pie-sin-leer',
      renglon: null,
      columna: null,
      detalle: 'No se pudo leer el neto del pie, así que no hay contra qué comparar la suma.',
    });
  }

  // Sólo se piden celdas cuando el comprobante no se aceptó solo: si cerró,
  // una celda ambigua que igual cuadra no es problema de nadie.
  if (veredicto.decision === 'automatica') return pendientes;

  /*
   * Se piden **sólo las celdas que impiden que el comprobante cierre**.
   *
   * Sin este filtro la lista es inservible, y no por poco: sobre la foto de
   * Errecalde salían ciento quince pedidos, la mayoría ambigüedades de la
   * descripción —«BARRA DANBO PUNTA DE AGUA» contra «BARRA»— que no entran en
   * ninguna cuenta y no cambian nada. Una lista así es lo mismo que volver a
   * tipear la factura.
   *
   * El criterio es la aritmética: si el renglón cierra con lo que se leyó, lo
   * que quedó ambiguo da igual. Si no cierra, se piden las celdas **numéricas**
   * de ese renglón, que son las únicas que pueden estar causándolo.
   */
  const renglonesQueCierran = new Set<number>();
  (veredicto.ganadora?.renglones ?? []).forEach((renglon, i) => {
    const controles = renglon.controles;
    if (controles.length > 0 && controles.every((c) => c.paso)) renglonesQueCierran.add(i);
  });

  tabla.renglones.forEach((renglon, i) => {
    if (renglonesQueCierran.has(i)) return;

    renglon.celdas.forEach((celda, j) => {
      const columna = tabla.columnas[j];
      const campo = columna?.campo?.campo;
      // La descripción y la marca no entran en ninguna igualdad: que estén
      // ambiguas no impide cerrar el comprobante y pedirlas es ruido.
      if (!campo || !CAMPOS_NUMERICOS.has(campo)) return;

      if (!celda) {
        pendientes.push({
          tipo: 'celda-sin-leer',
          renglon: i + 1,
          columna: columna!.titulo ?? `columna ${j + 1}`,
          detalle: `El renglón ${i + 1} no tiene ${campo}, y sin eso no cierra.`,
        });
        return;
      }
      if (celda.estado === 'ambigua') {
        pendientes.push({
          tipo: 'celda-ambigua',
          renglon: i + 1,
          columna: columna!.titulo ?? `columna ${j + 1}`,
          detalle: `El renglón ${i + 1} tiene más de una lectura para ${campo}.`,
          opciones: celda.alternativas.slice(0, 4),
        });
      }
    });

    if (renglon.sobrantes.length > 0) {
      pendientes.push({
        tipo: 'renglon-contaminado',
        renglon: i + 1,
        columna: null,
        detalle:
          `El renglón ${i + 1} tiene valores que no caen en ninguna columna ` +
          `(${renglon.sobrantes.map((s) => s.texto).join(', ')}).`,
      });
    }
  });

  return pendientes;
}
