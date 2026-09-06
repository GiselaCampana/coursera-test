/**
 * ¿La lectura sirve para revisar, o hay que sacar la foto de nuevo?
 *
 * Es una pregunta distinta de «¿cierra el comprobante?». Un comprobante puede
 * no cerrar por un renglón mal leído y aun así valer la pena revisarlo a mano;
 * lo que este control detecta es lo otro: que la foto no se pudo leer y que
 * seguir sería trabajar sobre nada.
 *
 * Hizo falta porque pasó. Sobre una foto real —papel arrugado, poca luz— el OCR
 * de la página entera devolvió mil quinientos caracteres, ninguna línea con
 * forma de fila de tabla, y el reparto de zonas cayó a proporciones fijas: el
 * recorte de «artículos» terminó sobre el membrete y el analizador recibió la
 * dirección del proveedor donde esperaba la tabla. Sobre otra, reescalada a
 * 1441×1600, de once renglones se entendieron dos.
 *
 * En los dos casos la aplicación tiene que frenar y pedir otra foto, no seguir
 * con lo que salió. Dos artículos de once no son una factura incompleta: son
 * una factura que no se leyó.
 *
 * Todas las señales vienen del proceso de lectura y ninguna del proveedor: esto
 * vale igual para un formato que todavía no existe.
 */

/** El código con el que viaja este control dentro del informe. */
export const CODIGO_LECTURA_UTILIZABLE = 'LECTURA_UTILIZABLE';

/** El mensaje que ve quien está cargando el comprobante. */
export const MENSAJE_LECTURA_INSUFICIENTE =
  'No pudimos leer correctamente los renglones de esta factura. Usá la foto original o ' +
  'volvé a sacarla con el papel completo, buena luz y sin movimiento.';

export interface SenalesDeLectura {
  /** Cuántos artículos entendió el analizador. */
  articulos: number;
  /**
   * Cuántas filas contó el detector sobre la imagen, antes de interpretar.
   *
   * Es la medida independiente: dice cuántas filas hay en el papel, no cuántas
   * se pudieron entender.
   */
  filasEnLaImagen?: number | null;
  /**
   * ¿Se ubicaron las zonas mirando el texto, o se cayó al reparto por
   * proporciones?
   *
   * El reparto por proporciones es el síntoma de que no se reconoció una sola
   * fila en la página completa. Ahí el recorte de la tabla cae donde caiga.
   */
  zonasPorProporcion?: boolean;
  /** ¿Se llegó a reconocer algo del encabezado —proveedor, tipo, número—? */
  encabezadoReconocido?: boolean;
  /** ¿Eligió el analizador de un proveedor, o ninguno? */
  analizador?: string | null;
  /**
   * La suma de los renglones interpretados, y el neto que trae impreso el pie.
   *
   * Es la tercera medida independiente, y la única que no depende de contar
   * nada: el papel dice cuánto suma, y lo interpretado dice cuánto suma. Sirve
   * para el caso que a las otras dos se les escapa —el detector no contó filas
   * y aun así faltan renglones—, porque un renglón que no se leyó se lleva su
   * importe con él.
   *
   * Los dos van en pesos, como texto decimal, tal como viajan por el resto del
   * cálculo.
   */
  sumaDeRenglones?: string | null;
  netoImpreso?: string | null;
}

export interface VeredictoDeLectura {
  utilizable: boolean;
  /** Por qué no sirve. Vacío cuando sirve. */
  motivos: string[];
}

/**
 * Cuánto de la tabla hay que haber entendido para seguir.
 *
 * Por debajo de la mitad no se trata de una factura con un renglón perdido: es
 * una lectura que no ocurrió. Y el control fino —«se ven 23 filas y se
 * interpretaron 22»— ya lo hace la validación aparte; éste está para el salto
 * grande, el que no tiene sentido mandar a revisión.
 */
const PROPORCION_MINIMA = 0.5;

export function evaluarLecturaUtilizable(senales: SenalesDeLectura): VeredictoDeLectura {
  const motivos: string[] = [];

  if (!senales.analizador) {
    motivos.push('No se pudo elegir con qué reglas interpretar el comprobante.');
  }

  if (senales.articulos === 0) {
    motivos.push(
      senales.encabezadoReconocido
        ? 'Se reconoció el encabezado pero no se entendió ningún renglón de la tabla.'
        : 'No se reconoció ningún renglón de la tabla.',
    );
  }

  if (senales.zonasPorProporcion) {
    /*
     * Ninguna línea de la página entera parecía una fila. Sin eso, el recorte de
     * la tabla se ubica por proporciones fijas y puede caer sobre el membrete.
     */
    motivos.push('No se encontró la tabla de artículos en la imagen.');
  }

  const filas = senales.filasEnLaImagen ?? null;
  if (filas !== null && filas > 0 && senales.articulos > 0) {
    if (senales.articulos < filas * PROPORCION_MINIMA) {
      motivos.push(
        `En la imagen se ven ${filas} filas y se entendieron ${senales.articulos}: ` +
          'falta más de la mitad de la tabla.',
      );
    }
  }

  /*
   * Lo interpretado no llega ni a la mitad de lo que dice el pie.
   *
   * Es el mismo criterio de recién dicho en pesos en vez de en filas, y está
   * por el caso en que el detector no contó nada: sin conteo, la regla de las
   * filas no tiene con qué compararse, pero el papel sigue diciendo cuánto
   * suma. Un renglón que no se leyó se lleva su importe.
   *
   * Sólo se mira cuando faltan pesos, nunca cuando sobran. Un total leído de
   * más es un precio unitario mal reconocido —pasa, y mucho—, y eso es
   * exactamente lo que se corrige a mano en la revisión: frenar ahí sería
   * sacarle a quien carga la herramienta con la que resuelve el caso más
   * común. Lo que no se puede corregir a mano son los renglones que no están.
   */
  const suma = aNumero(senales.sumaDeRenglones);
  const neto = aNumero(senales.netoImpreso);
  if (suma !== null && neto !== null && neto > 0 && suma >= 0) {
    if (suma < neto * PROPORCION_MINIMA) {
      motivos.push(
        'Los renglones interpretados no llegan ni a la mitad del neto impreso en el pie.',
      );
    }
  }

  return { utilizable: motivos.length === 0, motivos };
}

/** Un importe en texto, o nada si no se puede leer como número. */
function aNumero(valor: string | null | undefined): number | null {
  if (valor === null || valor === undefined || valor.trim() === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

/**
 * ¿El informe dice que la foto no se pudo leer?
 *
 * La pregunta la hacen dos lugares distintos —el circuito del navegador, para
 * no entrar a la revisión, y las pruebas— y ninguno de los dos tiene por qué
 * saber cómo se llama el control. Es la misma razón por la que el código es una
 * constante y no un texto suelto repartido por el árbol.
 */
export function lecturaFueInsuficiente(
  controles: readonly { code: string; severity: string }[] | null | undefined,
): boolean {
  return (controles ?? []).some(
    (c) => c.code === CODIGO_LECTURA_UTILIZABLE && c.severity === 'ERROR',
  );
}
