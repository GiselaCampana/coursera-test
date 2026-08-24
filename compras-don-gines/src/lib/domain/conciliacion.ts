import { Decimal, formatARS, money, toDecimal, type MoneyInput } from '@/lib/money';
import type { RawItem } from '@/lib/domain/costing';
import type { PrintedSummary } from '@/lib/domain/validation';

/**
 * Conciliación automática de centavos por OCR.
 *
 * El caso que resuelve es concreto y acotado. Sobre una foto, los dígitos de
 * los centavos son los más chicos de la tabla y están contra el borde derecho
 * de la columna: el OCR lee "$22.587,00" donde el papel dice "$22.587,34". Los
 * pesos están bien, la cantidad está bien, el precio está bien; lo único que se
 * perdió son dos dígitos que valen treinta y cuatro centavos.
 *
 * Frenar un comprobante de casi cuatro millones por eso obliga a corregir a
 * mano un renglón por foto. Aflojar el control de los renglones en general, en
 * cambio, es peor: dejaría pasar un dígito mal leído en los pesos, que sí
 * cambia la plata.
 *
 * Así que la tolerancia no se afloja: se reemplaza por una corrección que se
 * puede justificar renglón por renglón, con condiciones estrictas y dejando
 * constancia de lo que se cambió.
 *
 * ## Qué se corrige y con qué
 *
 * El importe corregido de un renglón sale de **su propia** cantidad × precio,
 * nunca del sobrante de otro renglón. Eso es lo que evita que la regla
 * compense errores entre sí: cada renglón se arregla con sus propios datos, y
 * si dos renglones tienen errores que se cancelan, ninguno de los dos se
 * corrige por eso.
 *
 * Lo que hace verificable la corrección es que el renglón **ya coincidía con el
 * papel hasta los pesos**: sólo se le refinan los centavos. Y por encima queda
 * el control de siempre, que la suma del detalle cierre contra el neto impreso.
 *
 * ## Cuándo NO se aplica
 *
 * Ante cualquier otra cosa rara, no se aplica nada y el comprobante frena como
 * antes. Está escrito así a propósito: la lista de condiciones es larga y todas
 * tienen que darse.
 */

/** Tope duro. Con un peso o más ya no es un problema de centavos. */
export const TOPE_CONCILIACION = new Decimal('1');

/**
 * Cuántos renglones se admite corregir.
 *
 * "Uno o pocos". Si media tabla necesita corrección, lo que falló no son los
 * centavos: es la lectura, y eso se arregla releyendo, no conciliando.
 */
export const MAX_RENGLONES_CONCILIABLES = 3;

/** Margen con el que el pie tiene que cerrar consigo mismo. */
const TOLERANCIA_PIE = new Decimal('0.05');

export interface RenglonConciliado {
  lineNumber: number;
  supplierCode: string | null;
  description: string;
  /** Lo que se leyó de la foto, antes de tocar nada. */
  leido: string;
  /** Lo que quedó, calculado como cantidad × precio de ese mismo renglón. */
  conciliado: string;
  /** conciliado − leído. */
  diferencia: string;
}

export interface Conciliacion {
  renglones: RenglonConciliado[];
  /** Suma de las diferencias en valor absoluto. */
  totalAbsoluto: string;
  /** Para la pantalla: "Se conciliaron automáticamente $0,51…". */
  mensaje: string;
}

export interface EntradaConciliacion {
  items: RawItem[];
  printed: PrintedSummary;
  /** Filas que el lector contó en la imagen, para exigir que no falte ninguna. */
  filasEnLaImagen?: number | null;
}

export interface ResultadoConciliacion {
  /** Los renglones ya corregidos, o los mismos de entrada si no se aplicó nada. */
  items: RawItem[];
  conciliacion: Conciliacion | null;
  /** Por qué no se aplicó, cuando había una diferencia y no se pudo conciliar. */
  motivoRechazo: string | null;
}

function leer(valor: MoneyInput | null | undefined): Decimal | null {
  if (valor === null || valor === undefined || valor === '') return null;
  try {
    const d = toDecimal(valor);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/**
 * Margen de redondeo de un renglón.
 *
 * El precio unitario viene redondeado a dos decimales, así que cantidad ×
 * precio puede alejarse del importe impreso hasta media centésima por unidad.
 * Es el mismo criterio que usa el control de los renglones.
 */
function margenDeRedondeo(cantidad: Decimal): Decimal {
  return cantidad.abs().times(0.005).plus(0.02);
}

/** ¿Los dos importes tienen la misma parte entera? */
function mismosPesos(a: Decimal, b: Decimal): boolean {
  return a.floor().eq(b.floor());
}

export function conciliarCentavos(entrada: EntradaConciliacion): ResultadoConciliacion {
  const { items, printed } = entrada;
  const sinCambios: ResultadoConciliacion = {
    items,
    conciliacion: null,
    motivoRechazo: null,
  };

  // --- 1. El pie tiene que estar completo y cerrar consigo mismo ----------
  //
  // Es la referencia contra la que se valida todo lo demás. Sin los cuatro
  // números impresos no hay nada con qué contrastar una corrección, y si no
  // cierran entre sí, el que está mal puede ser cualquiera de ellos.
  const neto = leer(printed.netTotal);
  const iva = leer(printed.ivaTotal);
  const percepciones = leer(printed.perceptionsTotal);
  const total = leer(printed.total);
  if (!neto || !iva || !percepciones || !total) {
    return { ...sinCambios, motivoRechazo: 'El pie del comprobante no se leyó completo.' };
  }
  if (neto.plus(iva).plus(percepciones).minus(total).abs().gt(TOLERANCIA_PIE)) {
    return {
      ...sinCambios,
      motivoRechazo: 'El neto, el IVA, las percepciones y el total impresos no cierran entre sí.',
    };
  }

  /*
   * Contra qué se compara la suma de los renglones.
   *
   * Los importes de los renglones son **brutos**, antes del descuento. Cuando
   * el comprobante trae un descuento por el total —Los Calvos descuenta 14 %—,
   * la suma del detalle tiene que dar el subtotal impreso, no el neto: contra
   * el neto daría de más por todo el descuento y la conciliación se rechazaría
   * siempre. Sin descuento, subtotal y neto son el mismo número.
   */
  const bruto = leer(printed.grossSubtotal);
  const descuento = leer(printed.discountTotal);
  const referencia = bruto ?? (descuento === null || descuento.isZero() ? neto : null);
  if (!referencia) {
    return {
      ...sinCambios,
      motivoRechazo:
        'El comprobante tiene un descuento por el total pero no se leyó el subtotal bruto: no ' +
        'hay contra qué contrastar la suma de los renglones.',
    };
  }
  if (bruto && descuento && bruto.minus(descuento).minus(neto).abs().gt(TOLERANCIA_PIE)) {
    return {
      ...sinCambios,
      motivoRechazo: 'El subtotal, el descuento y el neto impresos no cierran entre sí.',
    };
  }

  // --- 2. Los renglones tienen que estar todos --------------------------
  if (items.length === 0) return sinCambios;

  const declarados = printed.lineCount ?? null;
  if (declarados !== null && declarados !== items.length) {
    return {
      ...sinCambios,
      motivoRechazo: `El comprobante declara ${declarados} renglones y se interpretaron ${items.length}.`,
    };
  }

  const vistas = entrada.filasEnLaImagen ?? null;
  if (vistas !== null && vistas >= 8 && items.length < vistas) {
    return {
      ...sinCambios,
      motivoRechazo: `En la imagen se ven ${vistas} filas y se interpretaron ${items.length}.`,
    };
  }

  // --- 3. Renglón por renglón -------------------------------------------
  const sospechosos: { item: RawItem; leido: Decimal; conciliado: Decimal; diferencia: Decimal }[] =
    [];
  let sumaLeida = new Decimal(0);

  for (const item of items) {
    const cantidad = leer(item.quantity);
    const precio = leer(item.unitNetPrice);
    const leido = leer(item.grossSubtotal);

    // Sin los tres números no se puede afirmar nada de este renglón.
    if (!cantidad || !precio || leido === null) {
      return {
        ...sinCambios,
        motivoRechazo: `El renglón ${item.lineNumber} no tiene cantidad, precio o importe legibles.`,
      };
    }
    if (cantidad.lte(0)) {
      return {
        ...sinCambios,
        motivoRechazo: `El renglón ${item.lineNumber} tiene una cantidad que no se puede usar.`,
      };
    }

    sumaLeida = sumaLeida.plus(leido);

    const esperado = money(cantidad.times(precio));
    const diferencia = esperado.minus(leido);
    if (diferencia.abs().lte(margenDeRedondeo(cantidad))) continue; // cierra, no se toca

    // Pasa de un peso: no es un problema de centavos.
    if (diferencia.abs().gte(TOPE_CONCILIACION)) {
      return {
        ...sinCambios,
        motivoRechazo:
          `El renglón ${item.lineNumber} difiere en ${formatARS(diferencia.abs())}, que no es ` +
          'una diferencia de centavos.',
      };
    }

    // La parte entera tiene que coincidir. Si no, lo que se leyó mal no son
    // los centavos: es un dígito de los pesos, y eso sí cambia la plata.
    if (!mismosPesos(esperado, leido)) {
      return {
        ...sinCambios,
        motivoRechazo:
          `El renglón ${item.lineNumber} no coincide en los pesos: se leyó ${formatARS(leido)} y ` +
          `cantidad × precio da ${formatARS(esperado)}.`,
      };
    }

    // Y el renglón tiene que estar identificado. Uno al que no se le pudo leer
    // el código no está lo bastante bien leído como para corregirle un importe
    // sin que nadie lo mire.
    if (!item.supplierCode) {
      return {
        ...sinCambios,
        motivoRechazo:
          `El renglón ${item.lineNumber} no tiene código de artículo: no se corrige un importe ` +
          'de un renglón que no se pudo identificar.',
      };
    }

    sospechosos.push({ item, leido, conciliado: esperado, diferencia });
  }

  if (sospechosos.length === 0) return sinCambios;

  // --- 4. Que sean pocos y sumen poco -----------------------------------
  if (sospechosos.length > MAX_RENGLONES_CONCILIABLES) {
    return {
      ...sinCambios,
      motivoRechazo:
        `Hay ${sospechosos.length} renglones con diferencias de centavos: son demasiados para ` +
        'conciliar automáticamente.',
    };
  }

  const totalAbsoluto = sospechosos.reduce(
    (suma, s) => suma.plus(s.diferencia.abs()),
    new Decimal(0),
  );
  if (totalAbsoluto.gte(TOPE_CONCILIACION)) {
    return {
      ...sinCambios,
      motivoRechazo:
        `Las diferencias suman ${formatARS(totalAbsoluto)}, que llega al peso: no se concilia.`,
    };
  }

  /*
   * --- 5. Las correcciones tienen que ser exactamente lo que le falta al
   *        detalle para llegar al neto impreso, y todas en la misma dirección.
   *
   * Acá se juegan las dos cosas que hacen honesta a la regla.
   *
   * **Que haya algo que explicar.** El faltante `R` sale de restarle al neto
   * impreso la suma de lo que se leyó: es la única evidencia, externa al
   * renglón, de que un importe está mal. Si las correcciones no suman `R`, lo
   * que pasa no son centavos mal leídos y no se toca nada.
   *
   * **Que no se compensen entre sí.** Dos renglones que se desvían treinta
   * centavos en direcciones opuestas dan un detalle que suma exacto: visto de
   * afuera el comprobante parece perfecto, y corregir los dos los volvería
   * "correctos" por construcción sin haber verificado nada. Comparar la suma de
   * las diferencias con la suma de sus valores absolutos detecta justo eso: si
   * son iguales, todas empujan para el mismo lado; si no, se están cancelando y
   * la conciliación se rechaza entera.
   */
  const faltante = referencia.minus(sumaLeida);
  const sumaDeCorrecciones = sospechosos.reduce(
    (suma, s) => suma.plus(s.diferencia),
    new Decimal(0),
  );
  const sumaAbsoluta = sospechosos.reduce(
    (suma, s) => suma.plus(s.diferencia.abs()),
    new Decimal(0),
  );
  const margenDelDetalle = sospechosos.reduce(
    (suma, s) => suma.plus(margenDeRedondeo(leer(s.item.quantity)!)),
    new Decimal('0.02'),
  );

  if (sumaAbsoluta.minus(sumaDeCorrecciones.abs()).gt(margenDelDetalle)) {
    return {
      ...sinCambios,
      motivoRechazo:
        'Las diferencias de los renglones se compensan entre sí, así que el detalle cierra sin ' +
        'que eso pruebe que están bien leídos: no se concilia.',
    };
  }

  /*
   * Las correcciones tienen que ir hacia donde está el faltante, y no pasarse.
   *
   * No se les exige explicarlo *entero*, y eso no es una concesión: el precio
   * unitario viene redondeado a dos decimales, así que la suma de los importes
   * impresos se aparta unos centavos de la suma de cantidad × precio aunque el
   * OCR no se haya equivocado en nada. Exigir que las correcciones cubrieran
   * hasta el último centavo del faltante rechazaría justo los comprobantes que
   * están bien.
   *
   * Lo que sí se exige es la dirección: al detalle le falta plata y la
   * corrección la agrega, o le sobra y la saca. Y que no se pase del faltante,
   * porque corregir más de lo que el comprobante dice que falta ya no es leer
   * mejor: es empujar el número.
   */
  if (faltante.isZero() || sumaDeCorrecciones.isZero()) {
    return {
      ...sinCambios,
      motivoRechazo:
        'El detalle ya suma lo que dice el comprobante: no hay ningún faltante que estos ' +
        'centavos expliquen.',
    };
  }
  if (faltante.isNegative() !== sumaDeCorrecciones.isNegative()) {
    return {
      ...sinCambios,
      motivoRechazo:
        `Al detalle le ${faltante.isNegative() ? 'sobran' : 'faltan'} ` +
        `${formatARS(faltante.abs())} y los centavos corregidos van para el otro lado.`,
    };
  }
  if (sumaDeCorrecciones.abs().gt(faltante.abs().plus(margenDelDetalle))) {
    return {
      ...sinCambios,
      motivoRechazo:
        `Los centavos corregidos suman ${formatARS(sumaDeCorrecciones.abs())} y al detalle sólo ` +
        `le faltan ${formatARS(faltante.abs())} para el subtotal impreso.`,
    };
  }

  // --- 6. Se aplica, dejando constancia ---------------------------------
  const corregidos = items.map((item) => {
    const arreglo = sospechosos.find((s) => s.item === item);
    if (!arreglo) return item;
    return { ...item, grossSubtotal: arreglo.conciliado.toFixed(2) };
  });

  const renglones: RenglonConciliado[] = sospechosos.map((s) => ({
    lineNumber: s.item.lineNumber,
    supplierCode: s.item.supplierCode ?? null,
    description: s.item.description,
    leido: s.leido.toFixed(2),
    conciliado: s.conciliado.toFixed(2),
    diferencia: s.diferencia.toFixed(2),
  }));

  return {
    items: corregidos,
    conciliacion: {
      renglones,
      totalAbsoluto: totalAbsoluto.toFixed(2),
      mensaje:
        `Se conciliaron automáticamente ${formatARS(totalAbsoluto)} por diferencias de centavos ` +
        `de OCR en ${renglones.length === 1 ? 'un renglón' : `${renglones.length} renglones`}.`,
    },
    motivoRechazo: null,
  };
}
