import type { ActaDePrimeraLectura } from '@/lib/ocr/validacion/lectura-ciega';

/**
 * Comparar el acta ciega contra lo que dice el papel.
 *
 * Se corre **después** de la primera lectura y de transcribir el comprobante a
 * mano. La separación es la que le da valor a la medición: el acta ya está
 * guardada y firmada con el hash del motor, así que no hay manera de que la
 * transcripción influya en ella.
 *
 * Lo que sale de acá no es una nota: es un diagnóstico. Cuando una factura
 * falla, lo que importa no es cuántos valores erró sino **dónde se rompió la
 * cadena**, porque una sola carencia general puede producir veinte errores
 * aparentes. Arreglar el primero que se ve es lo que vuelve a sesgar el motor.
 */

/**
 * Dónde se rompió la cadena. Una por falla, la más temprana.
 *
 * El orden importa: son las etapas en el orden en que corren, y una falla
 * temprana produce síntomas en todas las siguientes. Si el emisor no se
 * reconoce, las cuentas del detalle no dicen nada; si las filas se agruparon
 * mal, el formato numérico de las columnas tampoco. Clasificar por el síntoma
 * más visible en vez de por la causa más temprana es cómo se terminan
 * escribiendo reglas para tapar consecuencias.
 */
export type CausaGeneral =
  /** La foto no da: fuera de foco, quemada, cortada, muy chica. */
  | 'calidad-insuficiente'
  /** No se identificó de quién es el comprobante. */
  | 'emisor'
  /** No se reconoció la fila de títulos o qué es cada columna. */
  | 'encabezado'
  /** Las columnas quedaron en el lugar equivocado, o se perdió una. */
  | 'geometria'
  /** Las filas se partieron, se fundieron o se inventaron. */
  | 'agrupacion-de-filas'
  /** Los números se leyeron con la escala o el separador equivocados. */
  | 'formato-numerico'
  /** Las igualdades del renglón no se resolvieron como corresponde. */
  | 'aritmetica'
  /** El neto, el IVA, las percepciones o el total salieron mal. */
  | 'pie-fiscal'
  /** El renglón no se pudo asociar a un artículo del catálogo. */
  | 'asociacion-de-producto'
  /** No se pudo decidir si la cantidad es de kilos, piezas u otra unidad. */
  | 'unidad'
  /**
   * El papel no alcanza para decidir, y el motor hizo lo correcto al pedirlo.
   *
   * No es una falla del motor y se clasifica igual, porque saber cuántas de
   * estas hay es lo que dice si la revisión asistida es viable.
   */
  | 'ambiguedad-genuina';

/** Un renglón del papel, transcripto a mano. */
export interface RenglonDelPapel {
  codigo?: string | null;
  descripcion: string;
  cantidad?: string | null;
  piezas?: number | null;
  precioUnitario?: string | null;
  descuentoPct?: string | null;
  importe?: string | null;
}

/** Lo que dice el comprobante, transcripto a mano después del acta. */
export interface VerdadDelPapel {
  /** El archivo al que corresponde, para no comparar contra otra factura. */
  imagenSha256: string;
  emisor: { cuit: string | null; razonSocial?: string | null };
  renglones: RenglonDelPapel[];
  pie: {
    netoGravado?: string | null;
    noGravado?: string | null;
    iva?: { alicuota?: string | null; valor: string }[];
    percepciones?: { etiqueta?: string; valor: string }[];
    total?: string | null;
  };
  /** Notas de quien transcribió: qué se ve mal en la foto, qué es ilegible. */
  notas?: string[];
}

export interface CampoComparado {
  renglon: number | null;
  campo: string;
  leido: string | null;
  papel: string | null;
  /** `true` si coinciden, `false` si difieren, `null` si el motor lo pidió. */
  acierto: boolean | null;
  /** Cuando difieren, dónde se rompió la cadena. */
  causa: CausaGeneral | null;
}

export interface Comparacion {
  imagen: string;
  motor: { commit: string; sha256: string; arbolSucio: boolean };
  /**
   * Qué versión del comparador produjo este resultado.
   *
   * Hace falta por la misma razón que el hash del motor, y se aprendió del
   * peor modo: la primera comparación de un lote le anotó un error al motor que
   * era de la herramienta —«4.874,380» leído como cuatro millones— y sin un
   * hash acá no habría manera de decir cuál de las dos mediciones es cuál. Una
   * comparación vieja y una nueva se ven idénticas.
   */
  comparador: { version: string; sha256: string };
  /** El acta y la verdad tienen que ser de la misma foto. */
  coinciden: boolean;

  renglonesEnElPapel: number;
  renglonesInterpretados: number;
  renglonesQueCoinciden: number;

  campos: CampoComparado[];
  aciertos: number;
  errores: number;
  /** Los que el motor no afirmó: los pidió. No cuentan como error. */
  pedidos: number;

  /** Cuántos errores por causa, la más temprana de cada uno. */
  porCausa: Record<string, number>;
  /** La causa dominante, si hay una. */
  causaPrincipal: CausaGeneral | null;

  /**
   * ¿Qué tuvo que hacer una persona?
   *
   * Es el número que decide si el motor está listo: unas pocas columnas que se
   * confirman una vez y quedan como perfil es una cosa; corregir valores factura
   * por factura es otra.
   */
  accionesHumanas: number;
  columnasPorConfirmar: number;
  celdasPorCorregir: number;
  /** Renglones leídos que todavía no tienen un producto inequívoco. */
  productosPorAsociar: number;
  /** Productos asociados cuya unidad de stock todavía no está resuelta. */
  unidadesPorResolver: number;
  /** El pie desglosado en las cinco cuentas que piden trabajos distintos. */
  balanceFiscal: {
    asignacionesIncorrectas: number;
    importesSinAsignar: number;
    conceptosOmitidos: number;
    conceptosInferidos: number;
    sugerenciasDerivadas: number;
  };
  veredicto: string;
}

/**
 * Lleva un número escrito a su valor, sin decidir mal la convención.
 *
 * Hace falta porque los dos lados se escriben distinto: el acta usa punto
 * decimal —es lo que produce `Decimal.toString()`, sin separador de miles— y
 * una transcripción a mano usa la convención del papel, punto de miles y coma
 * decimal.
 *
 * Las reglas, en orden, y cada una decide sola:
 *
 *  1. **si hay coma, la coma es el decimal** y los puntos son de miles. Vale
 *     para «4.874,380», «4.874,38» y «1.036.145,00»;
 *  2. sin coma, **más de un punto son separadores de miles**: «1.036.145» es un
 *     millón y pico, no puede ser otra cosa;
 *  3. sin coma y con **un solo punto, el punto es el decimal**: «10361.45» y
 *     «4874.380» son las dos formas en que sale un `Decimal.toString()`.
 *
 * La regla 3 deja fuera un caso genuinamente ambiguo: «1.234» escrito a mano
 * con punto de miles y sin decimales. Acá se lee 1,234 y no mil doscientos
 * treinta y cuatro, y es deliberado: el lado del acta **nunca** escribe miles
 * con punto, así que la ambigüedad sólo puede venir de la transcripción, donde
 * se resuelve escribiendo «1.234,00». Es preferible un criterio fijo y dicho a
 * uno que adivine.
 *
 * La primera versión de esta función tiraba todos los puntos como si fueran de
 * miles, y eso declaraba **iguales** «4874.38» y «4874.380» —el motor tenía
 * razón y la medición le anotaba un error— y, peor, habría declarado iguales
 * «10361.45» y «1.036.145», que difieren en un factor de cien: justo la clase
 * de falla que esta validación existe para detectar.
 */
export function comoNumero(texto: string): number {
  const limpio = texto.replace(/[$%\s]/g, '').trim();
  if (!/\d/.test(limpio)) return NaN;

  const signo = limpio.startsWith('-') ? -1 : 1;
  const cuerpo = limpio.replace(/^[+-]/, '');
  if (!/^[\d.,]+$/.test(cuerpo)) return NaN;

  // 1. Con coma, la coma manda: los puntos son de miles.
  if (cuerpo.includes(',')) {
    const ultima = cuerpo.lastIndexOf(',');
    const enteros = cuerpo.slice(0, ultima).replace(/[.,]/g, '');
    const decimales = cuerpo.slice(ultima + 1).replace(/[.,]/g, '');
    if (enteros === '' && decimales === '') return NaN;
    return signo * Number(`${enteros || '0'}.${decimales || '0'}`);
  }

  const puntos = (cuerpo.match(/\./g) ?? []).length;

  // 2. Sin coma y con varios puntos: todos de miles.
  if (puntos > 1) return signo * Number(cuerpo.replace(/\./g, ''));

  // 3. Sin coma y con un punto: el punto es el decimal.
  return signo * Number(cuerpo);
}

function igual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const na = comoNumero(a);
  const nb = comoNumero(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && /\d/.test(a) && /\d/.test(b)) {
    return Math.abs(na - nb) < 0.005;
  }
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
}

/**
 * Dónde se rompió la cadena para este campo.
 *
 * Se pregunta por la etapa **más temprana** que ya está mal, no por la que
 * produjo el síntoma. El orden de las preguntas es el orden de las etapas.
 */
function causaDe(
  acta: ActaDePrimeraLectura,
  verdad: VerdadDelPapel,
  campo: string,
): CausaGeneral {
  // 1. La foto: si el OCR leyó poquísimo, nada de lo demás se puede juzgar.
  const confianzaMedia =
    acta.calidad.confianzaPorPasada.reduce((s, p) => s + p.confianza, 0) /
    Math.max(acta.calidad.confianzaPorPasada.length, 1);
  if (confianzaMedia < 0.4 || acta.calidad.fragmentos < 80) return 'calidad-insuficiente';

  /*
   * 2. La escala, antes que todo lo demás, y es la única excepción al orden por
   *    etapas.
   *
   * Un valor leído exactamente cien veces más grande que el del papel es el
   * separador decimal y nada más: la aritmética del renglón cierra igual
   * —correr la coma de los dos lados mantiene la proporción— y la geometría, el
   * encabezado y la agrupación pueden estar perfectas. Es evidencia directa
   * sobre **este** campo, y por eso gana contra las observaciones sobre el
   * documento entero.
   */
  if (deEscala(acta, verdad, campo)) return 'formato-numerico';

  // 3. El emisor.
  if (campo === 'emisor.cuit' || !igual(acta.emisor.cuit, verdad.emisor.cuit)) {
    if (campo.startsWith('emisor')) return 'emisor';
  }

  // 4. Los encabezados: si alguna columna quedó sin reconocer, es de ahí.
  if (acta.columnas.some((c) => c.campo === null || c.origen === 'UNRESOLVED')) {
    return 'encabezado';
  }

  // 5. La geometría y la agrupación: se distinguen por el conteo de filas.
  if (acta.reconstruidos !== verdad.renglones.length) {
    return acta.reconstruidos > verdad.renglones.length || acta.reconstruidos === 0
      ? 'agrupacion-de-filas'
      : 'geometria';
  }

  // 6. El pie, cuando el campo es del pie.
  if (campo.startsWith('pie.')) return 'pie-fiscal';

  // 7. Lo que queda es la aritmética del renglón.
  return 'aritmetica';
}

/** ¿Es el valor leído el del papel corrido de escala? */
function deEscala(
  acta: ActaDePrimeraLectura,
  verdad: VerdadDelPapel,
  campo: string,
): boolean {
  const comparado = acta.renglones
    .flatMap((r) => (r.interpretado ? [{ numero: r.numero, ...r.interpretado }] : []))
    .find((r) => campo.startsWith(`renglon${r.numero}.`));
  if (!comparado) return false;

  const [, nombre] = campo.split('.');
  const crudoLeido = (comparado as unknown as Record<string, unknown>)[nombre];
  const fila = verdad.renglones[comparado.numero - 1] as unknown as
    | Record<string, unknown>
    | undefined;
  const crudoDelPapel = fila?.[nombre];
  if (typeof crudoLeido !== 'string' || typeof crudoDelPapel !== 'string') return false;
  const leido = comoNumero(crudoLeido);
  const delPapel = comoNumero(crudoDelPapel);
  if (!Number.isFinite(leido) || !Number.isFinite(delPapel) || delPapel === 0) return false;

  const veces = Math.abs(leido / delPapel);
  return [10, 100, 1000, 0.1, 0.01, 0.001].some((p) => Math.abs(veces - p) < 0.001);
}

/**
 * La versión del comparador, que va en cada resultado.
 *
 * `v1` tiraba todos los puntos como separadores de miles. `v2` distingue las
 * cinco escrituras que aparecen entre el acta y una transcripción a mano.
 */
export const VERSION_DEL_COMPARADOR = 'v3';

export function comparar(
  acta: ActaDePrimeraLectura,
  verdad: VerdadDelPapel,
  /** sha256 de este archivo, calculado por quien lo ejecuta. */
  sha256DelComparador = 'sin-calcular',
): Comparacion {
  const coinciden = acta.imagen.sha256 === verdad.imagenSha256;
  const campos: CampoComparado[] = [];

  /**
   * Un campo que el motor pidió en vez de afirmar no es un error.
   *
   * Se mira la lista completa de celdas frenadas y no sólo las raíces: una
   * celda bloqueada como consecuencia de otra tampoco fue afirmada. Contarla
   * como error haría que un motor que avisa puntuara igual que uno que adivina.
   */
  const pedido = (renglon: number | null, campo: string) =>
    renglon !== null &&
    acta.celdasNoAfirmadas.some(
      (c) => c.renglon === renglon && (c.campo === campo || c.campo === null),
    );

  campos.push({
    renglon: null,
    campo: 'emisor.cuit',
    leido: acta.emisor.cuit,
    papel: verdad.emisor.cuit,
    acierto: igual(acta.emisor.cuit, verdad.emisor.cuit),
    causa: igual(acta.emisor.cuit, verdad.emisor.cuit) ? null : 'emisor',
  });

  const deLaCuenta = [
    'codigo',
    'descripcion',
    'cantidad',
    'precioUnitario',
    'descuentoPct',
    'importe',
  ] as const;

  verdad.renglones.forEach((delPapel, i) => {
    const leido = acta.renglones[i]?.interpretado ?? null;
    for (const campo of deLaCuenta) {
      const valorLeido = leido ? ((leido as Record<string, unknown>)[campo] as string | null) : null;
      const valorDelPapel = (delPapel as unknown as Record<string, unknown>)[campo] as
        | string
        | undefined;
      if (valorDelPapel === undefined || valorDelPapel === null) continue;

      const acierto = igual(valorLeido, valorDelPapel);
      const nombre = `renglon${i + 1}.${campo}`;
      campos.push({
        renglon: i + 1,
        campo,
        leido: valorLeido,
        papel: valorDelPapel,
        acierto: acierto ? true : pedido(i + 1, campo) ? null : false,
        causa: acierto || pedido(i + 1, campo) ? null : causaDe(acta, verdad, nombre),
      });
    }
  });

  const delPie: [string, string | null | undefined, string | null][] = [
    ['pie.netoGravado', verdad.pie.netoGravado, acta.pie.netoGravado],
    ['pie.noGravado', verdad.pie.noGravado, acta.pie.noGravado],
    ['pie.total', verdad.pie.total, acta.pie.totalCalculado ? null : acta.pie.total],
  ];
  for (const [campo, papel, leido] of delPie) {
    if (papel === undefined || papel === null) continue;
    const acierto = igual(leido, papel);
    campos.push({
      renglon: null,
      campo,
      leido,
      papel,
      acierto,
      causa: acierto ? null : 'pie-fiscal',
    });
  }

  (verdad.pie.iva ?? []).forEach((iva, i) => {
    const leido = acta.pie.iva[i]?.valor ?? null;
    const acierto = igual(leido, iva.valor);
    campos.push({
      renglon: null,
      campo: `pie.iva[${i}]`,
      leido,
      papel: iva.valor,
      acierto,
      causa: acierto ? null : 'pie-fiscal',
    });
  });

  (verdad.pie.percepciones ?? []).forEach((percepcion, i) => {
    const leido = acta.pie.percepciones[i]?.valor ?? null;
    const acierto = igual(leido, percepcion.valor);
    campos.push({
      renglon: null,
      campo: `pie.percepcion[${i}]`,
      leido,
      papel: percepcion.valor,
      acierto,
      causa: acierto ? null : 'pie-fiscal',
    });
  });

  /*
   * **El pie se mide en cinco cuentas separadas, no en una.**
   *
   * «Doce incidencias» no dice nada: mezcla un concepto asignado mal —que es lo
   * único grave— con un número que el motor leyó y dijo no saber nombrar, con
   * uno que no está en la foto, con uno que dedujo de una igualdad y con una
   * cuenta que ofreció como ayuda. Las cinco cosas piden trabajos distintos y
   * sólo una es un error: afirmar un concepto equivocado.
   */
  const delPieMal = campos.filter((c) => c.causa === 'pie-fiscal' && c.leido !== null);
  const leidosSinAsignar = new Set((acta.pie.sinAsignar ?? []).map((x) => x.valor));
  const balanceFiscal = {
    /** Un concepto asignado a un valor que el papel desmiente. El único error. */
    asignacionesIncorrectas: delPieMal.filter((c) => !leidosSinAsignar.has(c.leido)).length,
    /** El número está leído y sin concepto: una pregunta, no un error. */
    importesSinAsignar: (acta.pie.sinAsignar ?? []).length,
    /** El papel lo imprime y el motor no lo tiene por ningún lado. */
    conceptosOmitidos: campos.filter((c) => c.causa === 'pie-fiscal' && c.leido === null).length,
    /** Lo ubicó una igualdad fiscal, no su etiqueta. */
    conceptosInferidos: acta.pie.asignaciones.filter(
      (a) => a.procedencia === 'INFERRED_FROM_DOCUMENT_RELATIONS',
    ).length,
    /** Una cuenta ofrecida como ayuda, que no cuenta como dato. */
    sugerenciasDerivadas: acta.pie.totalCalculado ? 1 : 0,
  };

  const porCausa: Record<string, number> = {};
  for (const campo of campos) {
    if (!campo.causa) continue;
    porCausa[campo.causa] = (porCausa[campo.causa] ?? 0) + 1;
  }
  const ordenadas = Object.entries(porCausa).sort((a, b) => b[1] - a[1]);

  const renglonesQueCoinciden = verdad.renglones.filter((_, i) => {
    const suyos = campos.filter((c) => c.renglon === i + 1);
    return suyos.length > 0 && suyos.every((c) => c.acierto === true);
  }).length;

  /*
   * Lo que se contesta una vez para toda la columna, contra lo que hay que
   * mirar celda por celda. La diferencia es la que decide si un comprobante se
   * resuelve con un perfil guardado o hay que volver a tipearlo.
   *
   * Se mide por el **alcance** del bloqueo y no por su categoría: un bloqueo
   * que no nombra ningún renglón es una pregunta sobre la columna —qué
   * significa, en qué escala está escrita— y se contesta una sola vez para las
   * veintidós celdas de abajo. Preguntar por la categoría dejaba afuera cada
   * pregunta de columna nueva, que aparecía contada como celdas por corregir y
   * hundía el veredicto de una factura sobre la que no hay nada mal afirmado.
   */
  const columnasPorConfirmar = acta.bloqueosRaiz.filter((b) => b.renglon === null).length;
  const productosPorAsociar = acta.bloqueosRaiz.filter(
    (b) => b.categoria === 'BLOCKING_PRODUCT',
  ).length;
  const unidadesPorResolver = acta.bloqueosRaiz.filter(
    (b) => b.categoria === 'BLOCKING_UNIT',
  ).length;
  const celdasPorCorregir = acta.bloqueosRaiz.filter(
    (b) =>
      b.renglon !== null &&
      b.categoria !== 'BLOCKING_PRODUCT' &&
      b.categoria !== 'BLOCKING_UNIT',
  ).length;

  return {
    imagen: acta.imagen.nombre,
    motor: {
      commit: acta.motor.commit,
      sha256: acta.motor.sha256,
      arbolSucio: acta.motor.arbolSucio,
    },
    comparador: { version: VERSION_DEL_COMPARADOR, sha256: sha256DelComparador },
    coinciden,

    renglonesEnElPapel: verdad.renglones.length,
    renglonesInterpretados: acta.interpretados,
    renglonesQueCoinciden,

    campos,
    aciertos: campos.filter((c) => c.acierto === true).length,
    errores: campos.filter((c) => c.acierto === false).length,
    pedidos: campos.filter((c) => c.acierto === null).length,

    porCausa,
    causaPrincipal: (ordenadas[0]?.[0] as CausaGeneral) ?? null,

    accionesHumanas: acta.bloqueosRaiz.length,
    columnasPorConfirmar,
    celdasPorCorregir,
    productosPorAsociar,
    unidadesPorResolver,
    balanceFiscal,
    veredicto: veredictoDe({
      coinciden,
      errores: campos.filter((c) => c.acierto === false).length,
      columnasPorConfirmar,
      celdasPorCorregir,
      productosPorAsociar,
      unidadesPorResolver,
      decision: acta.decision,
    }),
  };
}

/**
 * Qué significa este resultado para el hito siguiente.
 *
 * Traduce los números al único criterio que importa: ¿alcanza para pasar a un
 * perfil guardado y una pantalla, o el motor todavía no está?
 */
function veredictoDe(datos: {
  coinciden: boolean;
  errores: number;
  columnasPorConfirmar: number;
  celdasPorCorregir: number;
  productosPorAsociar: number;
  unidadesPorResolver: number;
  decision: string;
}): string {
  if (!datos.coinciden) {
    return 'El acta y la transcripción no son de la misma foto: la comparación no vale.';
  }
  if (datos.errores > 0) {
    return (
      `Hay ${datos.errores} valor(es) afirmado(s) que el papel desmiente. Eso no se arregla ` +
      'con un perfil: es una carencia del motor y hay que ver si otras facturas la comparten.'
    );
  }
  if (datos.decision === 'automatica') {
    return 'Se leyó sola y todo lo afirmado coincide con el papel.';
  }
  if (
    datos.celdasPorCorregir === 0 &&
    (datos.productosPorAsociar > 0 || datos.unidadesPorResolver > 0)
  ) {
    const columnas =
      datos.columnasPorConfirmar > 0
        ? ` También quedan ${datos.columnasPorConfirmar} columna(s) por confirmar una sola vez.`
        : '';
    return (
      'Nada afirmado está mal. La lectura contable está resuelta, pero antes de mover stock ' +
      `faltan ${datos.productosPorAsociar} asociación/es de producto y ` +
      `${datos.unidadesPorResolver} unidad/es de stock.${columnas}`
    );
  }
  if (datos.celdasPorCorregir === 0 && datos.columnasPorConfirmar > 0) {
    return (
      `Nada afirmado está mal. Quedan ${datos.columnasPorConfirmar} columna(s) por confirmar ` +
      'una vez: eso es exactamente lo que un perfil guardado resuelve para siempre.'
    );
  }
  return (
    `Nada afirmado está mal, y quedan ${datos.celdasPorCorregir} celda(s) por corregir en esta ` +
    'factura. Si son pocas, lo resuelve la revisión puntual; si son muchas por factura, el ' +
    'motor todavía no está listo.'
  );
}
