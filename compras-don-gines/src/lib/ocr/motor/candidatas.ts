import { Decimal } from '@/lib/money';
import { evaluarCierre, type CierreCompatible } from '@/lib/ocr/motor/precision';
import { variantesDeNumero } from '@/lib/ocr/numeros';
import {
  CAMPOS_NUMERICOS,
  CAMPOS_SIN_CONFIRMAR,
  type CampoDeColumna,
  type ColumnaReconocida,
} from '@/lib/ocr/motor/columnas';
import type { FilaDeDatos } from '@/lib/ocr/motor/tabla';

/**
 * Interpretar la tabla generando varias lecturas y dejando que la aritmética
 * elija.
 *
 * Ésta es la pieza que reemplaza el criterio «cada proveedor sabe dónde está
 * cada cosa». El motor no sabe: **produce las lecturas posibles y las puntúa
 * con controles que no dependen de ninguna de ellas**.
 *
 * Los controles son las igualdades que un comprobante cumple por construcción:
 *
 *     precio × (1 − descuento/100) ≈ precio con descuento     (por renglón)
 *     cantidad × precio con descuento ≈ importe               (por renglón)
 *     suma de los renglones ≈ neto impreso                    (del documento)
 *
 * Una lectura equivocada no las cumple. Dos lecturas que las cumplen las dos
 * son un empate, y un empate no se resuelve: va a revisión. Eso es lo que
 * impide que el motor «aparente éxito» eligiendo la primera.
 */

/** Cómo escribe los números un comprobante. */
export type ConvencionDecimal = 'ar' | 'us';

export interface RenglonCandidato {
  codigo: string | null;
  descripcion: string;
  marca: string | null;
  /** La cantidad genérica, cuando la columna no dice de qué es. */
  cantidad: Decimal | null;
  kilos: Decimal | null;
  piezas: number | null;
  precioUnitario: Decimal | null;
  /** Fracción: 0,16 = 16 %. */
  descuentoPct: Decimal | null;
  precioConDescuento: Decimal | null;
  importe: Decimal | null;
  /**
   * ¿El importe impreso ya tiene el descuento adentro?
   *
   * Las dos formas existen en el banco de facturas y no hay manera de saber
   * cuál es sin hacer la cuenta: **Lácteos Barraza imprime el importe neto**
   * —27 × 10.361,45 × 0,84 = 234.997,69— y **Los Calvos imprime el bruto**
   * —16,10 × 16.037 = 258.195,70— con la bonificación descontada recién al pie.
   * Los dos papeles tienen una columna de porcentaje y una de importe, y se ven
   * iguales.
   *
   * Tomar una de las dos por convención carga el costo con un 14 % o un 16 % de
   * error en la mitad de los proveedores, así que se generan las dos lecturas y
   * decide la igualdad del renglón. `null` es cuando no hay nada que decidir:
   * sin descuento, o con el precio con descuento impreso aparte.
   */
  descuentoEnElImporte: boolean | null;
  /**
   * Cuántos de sus números no se leyeron tal como están impresos.
   *
   * Cero significa que cada valor salió de tomar los separadores del papel al
   * pie de la letra. Más que cero significa que hizo falta suponer que el OCR
   * perdió o corrió alguno, que es una suposición legítima —y a veces la única
   * que explica el papel— pero que hay que preferir no hacer.
   */
  reparaciones: number;
  /** Qué controles pasó y cuáles no. */
  controles: ControlDeRenglon[];
}

export interface ControlDeRenglon {
  nombre: 'precio-con-descuento' | 'cantidad-por-precio';
  paso: boolean;
  detalle: string;
}

/** La cantidad que cuesta: los kilos si los hay, si no la genérica. */
export function cantidadQueCuesta(renglon: RenglonCandidato): Decimal | null {
  return renglon.kilos ?? renglon.cantidad ?? null;
}

/**
 * Lee una celda numérica, con todas sus lecturas posibles.
 *
 * La convención decimal es del documento y no de la celda: mezclarlas dentro de
 * un mismo comprobante no pasa, y probar celda por celda multiplicaría las
 * combinaciones sin ganar nada.
 */
function numerosDeCelda(texto: string, convencion: ConvencionDecimal): Decimal[] {
  const limpio = texto.replace(/[$%\s]/g, '').trim();
  if (limpio === '' || !/\d/.test(limpio)) return [];

  return variantesDeNumero(aConvencionAr(limpio, convencion));
}

/**
 * Pasa los números de un texto a la convención argentina, que es la que sabe
 * leer el resto de la cadena: en la norteamericana la coma es de miles y el
 * punto decimal, justo al revés.
 *
 * Se dan vuelta **sólo los separadores que están adentro de un número**.
 * Hacerlo sobre la línea entera convertiría «C.U.I.T.» en «C,U,I,T,» y el pie
 * dejaría de reconocer lo que tiene que descartar.
 */
export function aConvencionAr(texto: string, convencion: ConvencionDecimal): string {
  if (convencion === 'ar') return texto;
  return texto.replace(/\d[\d.,]*\d/g, (numero) =>
    numero.replace(/,/g, '\u0001').replace(/\./g, ',').replace(/\u0001/g, '.'),
  );
}

/**
 * Separa una celda que trae un número pegado a un texto.
 *
 * Pasa cuando la columna de al lado invade el territorio de ésta: sobre una de
 * las facturas del banco la celda de cantidad sale «4,240 Cremoso», con el
 * principio de la descripción adentro. Devolver las dos partes permite que la
 * aritmética decida si esa celda era la cantidad —y el texto sobra— o al revés.
 */
export function partirNumeroYTexto(texto: string): { numero: string; resto: string } | null {
  const m = texto.trim().match(/^([\d.,]+)\s+(\S.*)$/);
  if (!m || !/\d/.test(m[1])) return null;
  return { numero: m[1], resto: m[2].trim() };
}

/** Las celdas de una fila, indexadas por campo. */
function porCampo(fila: FilaDeDatos, columnas: (ColumnaReconocida | null)[]) {
  const mapa = new Map<CampoDeColumna, string>();
  const lugares = new Map<CampoDeColumna, string>();
  const textosSinConfirmar: string[] = [];
  const montosSinConfirmar: { texto: string; lugar?: string }[] = [];

  columnas.forEach((columna, i) => {
    if (!columna || columna.campo === 'ignorada') return;
    const celda = fila.celdas[i];
    if (!celda || celda.texto.trim() === '') return;
    if (columna.campo === 'UNKNOWN_TEXT') {
      textosSinConfirmar.push(celda.texto.trim());
      return;
    }
    if (columna.campo === 'UNKNOWN_MONEY') {
      montosSinConfirmar.push({ texto: celda.texto.trim(), lugar: celda.lugar });
      return;
    }
    if (CAMPOS_SIN_CONFIRMAR.has(columna.campo)) return;
    mapa.set(columna.campo, celda.texto.trim());
    if (celda.lugar) lugares.set(columna.campo, celda.lugar);
  });

  /*
   * Una columna de texto sin confirmar hace de descripción mientras no haya otra.
   *
   * Es el punto donde se decide si el comprobante se puede cargar o hay que
   * reescribirlo a mano. Sobre la foto de Lácteos Barraza la palabra
   * «Descripción» del encabezado sale ilegible, así que la columna quedaba sin
   * campo, el renglón quedaba sin descripción y el filtro de abajo lo tiraba: la
   * factura mostraba **cero artículos** teniendo los kilos, las piezas, los dos
   * precios, el descuento y los dos importes perfectamente leídos.
   *
   * Usarla como descripción no es adivinar: el renglón se arma completo y la
   * columna queda con un pedido de confirmación de una palabra. Lo que sí sería
   * adivinar es darla por confirmada, y eso no pasa acá —pasa en el perfil, que
   * todavía no existe—.
   *
   * Se juntan todas, en el orden de las columnas. Una descripción larga se
   * parte en dos columnas con facilidad —alcanza con que el OCR deje un hueco
   * en el medio de «CIL MUZZA BARRAZA X 2 KG»— y quedarse con el pedazo más
   * largo tira la otra mitad del nombre del artículo. Si además hubiera una
   * marca, entra en la misma celda; el pedido de confirmación es el mismo y la
   * persona ve el texto completo en vez de un pedazo.
   */
  if (!mapa.has('descripcion') && textosSinConfirmar.length > 0) {
    mapa.set('descripcion', textosSinConfirmar.join(' ').replace(/\s+/g, ' ').trim());
  }

  return { mapa, lugares, montosSinConfirmar };
}

/**
 * Las lecturas posibles de una fila.
 *
 * Se generan combinando las lecturas de cada celda numérica. La explosión se
 * contiene sola: sobre un comprobante bien impreso cada celda tiene una sola
 * lectura y sale una única candidata; las alternativas aparecen justamente
 * donde el OCR dejó una ambigüedad.
 */
export function candidatasDeRenglon(
  fila: FilaDeDatos,
  columnas: (ColumnaReconocida | null)[],
  convencion: ConvencionDecimal,
): RenglonCandidato[] {
  const { mapa: celdas, lugares, montosSinConfirmar } = porCampo(fila, columnas);

  /*
   * Una celda invadida por la de al lado se lee de las dos maneras.
   *
   * «4,240 Cremoso» en la columna de cantidad puede ser la cantidad con basura
   * detrás, o —si la tabla estuviera corrida— otra cosa. Se generan las dos
   * variantes de texto y después decide la aritmética.
   */
  const variantesDeCeldas: Map<CampoDeColumna, string>[] = [celdas];
  for (const [campo, texto] of celdas) {
    if (!CAMPOS_NUMERICOS.has(campo)) continue;
    const partido = partirNumeroYTexto(texto);
    if (!partido) continue;

    const alternativa = new Map(celdas);
    alternativa.set(campo, partido.numero);
    // El texto que sobraba se ofrece como descripción si no había otra.
    if (!alternativa.get('descripcion')) alternativa.set('descripcion', partido.resto);
    variantesDeCeldas.push(alternativa);
  }

  /*
   * Una columna de montos sin confirmar se ofrece como cada precio que falta.
   *
   * Es el mismo criterio que con los sobrantes, aplicado a una columna entera:
   * no se decide qué es, se ofrece y decide la cuenta. Sobre la foto de Lácteos
   * Barraza la columna de precios cae bajo un encabezado que el OCR leyó «Lado»
   * —no se parece a nada— así que queda como monto sin confirmar. Ofrecerla como
   * precio unitario hace que el renglón se compruebe solo: 27 × 10.361,45 × 0,84
   * da 234.997,69, que es el importe impreso. Una coincidencia así no es una
   * coincidencia, y es mucho mejor evidencia de lo que esa columna significa que
   * cualquier cosa que se pueda decir de su encabezado.
   *
   * Se ofrece únicamente donde **falta** el campo: una columna sin confirmar no
   * desplaza a una reconocida.
   */
  const lugaresPorVariante = new Map<Map<CampoDeColumna, string>, Map<CampoDeColumna, string>>();
  for (const variante of variantesDeCeldas) lugaresPorVariante.set(variante, lugares);

  for (const monto of montosSinConfirmar) {
    for (const destino of ['precioUnitario', 'precioConDescuento', 'importe'] as const) {
      if (celdas.has(destino)) continue;
      for (const base of [...variantesDeCeldas]) {
        const conMonto = new Map(base);
        conMonto.set(destino, monto.texto);
        const susLugares = new Map(lugaresPorVariante.get(base) ?? lugares);
        if (monto.lugar) susLugares.set(destino, monto.lugar);
        lugaresPorVariante.set(conMonto, susLugares);
        variantesDeCeldas.push(conMonto);
      }
    }
  }

  const salida: RenglonCandidato[] = [];
  for (const variante of variantesDeCeldas) {
    /*
     * **Un mismo fragmento del papel no puede ocupar dos campos del renglón.**
     *
     * La prohibición vale para todo el comprobante y no sólo dentro de una
     * columna, porque el daño es el mismo venga de donde venga: si el «30» que
     * dice la cantidad se usara además como código de artículo, la factura
     * quedaría con un código que nadie imprimió y el historial de precios se
     * ensuciaría con un producto inventado.
     *
     * Dos celdas que **dicen** lo mismo sí pueden convivir, y tienen que poder:
     * en el segundo renglón de Lácteos Barraza el código es 30 y la cantidad es
     * 30, y son dos impresiones distintas en dos lugares distintos de la hoja.
     * Lo que se compara es el lugar, no el texto.
     */
    const usados = new Set<string>();
    let repetido = false;
    for (const [, lugar] of lugaresPorVariante.get(variante) ?? lugares) {
      if (usados.has(lugar)) {
        repetido = true;
        break;
      }
      usados.add(lugar);
    }
    if (repetido) continue;

    for (const candidata of combinarNumeros(variante, convencion)) {
      // Sin descripción no hay renglón: no hay con qué asociar el artículo.
      if (candidata.descripcion.replace(/[^A-Za-zÁÉÍÓÚÑ]/g, '').length < 3) continue;
      salida.push(candidata);
    }
  }
  return salida;
}

/** Todas las combinaciones de lecturas numéricas de una fila. */
function combinarNumeros(
  celdas: Map<CampoDeColumna, string>,
  convencion: ConvencionDecimal,
): RenglonCandidato[] {
  const numericos: CampoDeColumna[] = [
    'cantidad',
    'kilos',
    'piezas',
    'precioUnitario',
    'descuentoPct',
    'precioConDescuento',
    'importe',
  ].filter((c) => celdas.has(c as CampoDeColumna)) as CampoDeColumna[];

  const lecturas = numericos.map((campo) => ({
    campo,
    valores: numerosDeCelda(celdas.get(campo)!, convencion),
  }));

  /*
   * Se lleva la cuenta de **cuántos números hubo que reparar**.
   *
   * `variantesDeNumero` devuelve primero la lectura literal —los separadores tal
   * como están impresos— y después las que suponen que el OCR perdió o corrió
   * alguno. Las dos son lecturas legítimas de los mismos dígitos, pero no valen
   * lo mismo, y sin esta cuenta no había manera de distinguirlas.
   *
   * El caso que lo obliga apareció en Lácteos Barraza apenas los dos renglones
   * empezaron a cerrar: existe una lectura del comprobante entero en la que
   * **todos** los separadores decimales se ignoran, y es internamente
   * consistente. 27 × 1.036.145 × 0,84 da 23.499.769, los dos renglones cierran,
   * y la suma da el pie leído de la misma manera. Todo cuadra cien veces más
   * grande, y el costo de cada artículo sale cien veces mal.
   *
   * Lo que la descarta no es un umbral: es que necesita reparar todos los
   * números del papel, y la otra no necesita reparar ninguno.
   */
  const combinaciones: { valores: Map<CampoDeColumna, Decimal>; reparaciones: number }[] = [
    { valores: new Map(), reparaciones: 0 },
  ];
  for (const { campo, valores } of lecturas) {
    if (valores.length === 0) continue;
    const siguiente: { valores: Map<CampoDeColumna, Decimal>; reparaciones: number }[] = [];
    for (const parcial of combinaciones) {
      valores.forEach((valor, indice) => {
        const copia = new Map(parcial.valores);
        copia.set(campo, valor);
        siguiente.push({
          valores: copia,
          reparaciones: parcial.reparaciones + (indice === 0 ? 0 : 1),
        });
      });
    }
    // Tope de seguridad: una fila con más de esto no es ambigua, es ilegible.
    combinaciones.length = 0;
    combinaciones.push(...siguiente.slice(0, 64));
  }

  const salida: RenglonCandidato[] = [];
  for (const { valores: numeros, reparaciones } of combinaciones) {
    const descuento = numeros.get('descuentoPct') ?? null;

    /*
     * Cuando hay descuento y un importe impreso, pero no hay una columna con el
     * precio ya descontado, no se sabe si ese importe es el bruto o el neto: las
     * dos formas están en el banco de facturas. Se generan las dos lecturas.
     *
     * Cuando el papel imprime el precio con descuento aparte, no hay nada que
     * decidir: el importe sale de ese precio y es el neto.
     */
    const hayQueDecidir =
      descuento !== null &&
      descuento.gt(0) &&
      numeros.has('importe') &&
      !numeros.has('precioConDescuento');

    for (const enElImporte of hayQueDecidir ? [true, false] : [null]) {
      const renglon: RenglonCandidato = {
        codigo: celdas.get('codigo')?.replace(/\s/g, '') || null,
        descripcion: celdas.get('descripcion') ?? '',
        marca: celdas.get('marca') ?? null,
        cantidad: numeros.get('cantidad') ?? null,
        kilos: numeros.get('kilos') ?? null,
        piezas: numeros.get('piezas')?.toNumber() ?? null,
        precioUnitario: numeros.get('precioUnitario') ?? null,
        // Se guarda como fracción, que es como lo consume el dominio.
        descuentoPct: descuento ? descuento.div(100) : null,
        precioConDescuento: numeros.get('precioConDescuento') ?? null,
        importe: numeros.get('importe') ?? null,
        descuentoEnElImporte: enElImporte,
        reparaciones,
        controles: [],
      };
      renglon.controles = controlarRenglon(renglon);
      salida.push(renglon);
    }
  }
  return salida;
}

/**
 * El precio por unidad con el que hay que multiplicar la cantidad para llegar
 * al importe impreso, según la lectura del renglón.
 */
function precioContraElImporte(renglon: RenglonCandidato): Decimal | null {
  const { precioConDescuento, precioUnitario, descuentoPct, descuentoEnElImporte } = renglon;
  if (precioConDescuento) return precioConDescuento;
  if (!precioUnitario) return null;
  return descuentoEnElImporte && descuentoPct
    ? precioUnitario.times(new Decimal(1).minus(descuentoPct))
    : precioUnitario;
}

/**
 * Los dos controles que un renglón puede comprobar contra sí mismo.
 *
 * Un control que no se puede hacer —porque el comprobante no imprime esa
 * columna— **no cuenta como aprobado ni como fallado**: no está. Contarlo como
 * aprobado premiaría a los comprobantes que imprimen menos.
 */
export function controlarRenglon(renglon: RenglonCandidato): ControlDeRenglon[] {
  const controles: ControlDeRenglon[] = [];

  const { precioUnitario, descuentoPct, precioConDescuento, importe } = renglon;
  if (precioUnitario && descuentoPct && precioConDescuento) {
    const esperado = precioUnitario.times(new Decimal(1).minus(descuentoPct));
    const diferencia = esperado.minus(precioConDescuento).abs();
    controles.push({
      nombre: 'precio-con-descuento',
      paso: diferencia.lte(Decimal.max(precioConDescuento.times('0.0005'), '0.01')),
      detalle: `${precioUnitario} − ${descuentoPct.times(100)} % = ${esperado.toFixed(3)} contra ${precioConDescuento}`,
    });
  }

  const cantidad = cantidadQueCuesta(renglon);
  const precio = precioContraElImporte(renglon);
  if (cantidad && precio && importe) {
    const esperado = cantidad.times(precio);
    const diferencia = esperado.minus(importe).abs();
    const hipotesis =
      renglon.descuentoEnElImporte === null
        ? ''
        : renglon.descuentoEnElImporte
          ? ' (con el descuento adentro del importe)'
          : ' (con el descuento todavía sin aplicar)';
    controles.push({
      nombre: 'cantidad-por-precio',
      // Un centavo de piso más medio por mil: el precio impreso viene
      // redondeado y el error crece con la cantidad.
      paso: diferencia.lte(Decimal.max(importe.times('0.0005'), '0.01')),
      detalle: `${cantidad} × ${precio} = ${esperado.toFixed(2)} contra ${importe}${hipotesis}`,
    });
  }

  return controles;
}

export interface Penalizacion {
  motivo: string;
  puntos: number;
}

/** Los totales del pie fiscal, leídos con una convención decimal dada. */
export interface PieLeido {
  netTotal: Decimal | null;
  ivaTotal: Decimal | null;
  percepciones: Decimal | null;
  total: Decimal | null;
  /** Lo que se reconoció como ajeno al pie fiscal y se dejó afuera. */
  ignorados: { etiqueta: string; valor: string }[];
}

export interface CandidataDeTabla {
  convencion: ConvencionDecimal;
  /** El pie leído con esta misma convención. */
  pie: PieLeido;
  renglones: RenglonCandidato[];
  /** De 0 a 1. */
  puntaje: number;
  penalizaciones: Penalizacion[];
  /** La suma de los importes de los renglones. */
  sumaDeRenglones: Decimal;
  /** Cuántos números de todo el comprobante no se leyeron tal como están impresos. */
  reparaciones: number;
  /**
   * Cómo se explica —o no— la diferencia entre la suma y el pie impreso.
   *
   * Va en la candidata y no en una constante global a propósito: la política de
   * redondeo es de **este** comprobante, y lo que se decida acá no puede
   * cambiarle el cierre a otro proveedor.
   */
  cierre?: CierreCompatible | null;
}

/**
 * Qué le falta a un renglón para poder comprobarse solo.
 *
 * Los tres que hacen falta y ninguno más: sin cantidad no hay con qué
 * multiplicar, sin precio no hay por cuánto, y sin importe no hay contra qué.
 * El descuento no entra porque un renglón sin descuento es perfectamente normal.
 */
export function leFalta(renglon: RenglonCandidato): string[] {
  const falta: string[] = [];
  if (!cantidadQueCuesta(renglon) && renglon.piezas === null) falta.push('la cantidad');
  if (!renglon.precioUnitario && !renglon.precioConDescuento) falta.push('el precio');
  if (!renglon.importe) falta.push('el importe');
  return falta;
}

/**
 * Hasta dónde puede llegar un comprobante con algún renglón sin comprobar.
 *
 * Por debajo del umbral automático a propósito: la lectura puede ser buena y
 * perfectamente utilizable —por eso no se rechaza— pero no se acepta sin que la
 * mire una persona.
 */
const TOPE_CON_RENGLON_INCOMPLETO = 0.8;

export interface PieParaControlar {
  netTotal: Decimal | null;
  /** Cuántas filas vio el detector sobre la imagen, si se sabe. */
  filasVistas: number | null;
}

/**
 * Puntúa una lectura completa de la tabla.
 *
 * El puntaje arranca en uno y baja con cada cosa que no cierra. Se penaliza y
 * no se descarta porque un comprobante puede tener un renglón ilegible y ser
 * perfectamente utilizable: lo que decide si se acepta sola es el umbral, más
 * abajo.
 */
export function puntuarTabla(
  renglones: RenglonCandidato[],
  pie: PieParaControlar,
): {
  puntaje: number;
  penalizaciones: Penalizacion[];
  sumaDeRenglones: Decimal;
  cierre: CierreCompatible | null;
} {
  const penalizaciones: Penalizacion[] = [];
  let puntaje = 1;
  let cierre: CierreCompatible | null = null;

  const penalizar = (motivo: string, puntos: number) => {
    penalizaciones.push({ motivo, puntos });
    puntaje -= puntos;
  };

  if (renglones.length === 0) {
    penalizar('No se interpretó ningún renglón.', 1);
    return { puntaje: 0, penalizaciones, sumaDeRenglones: new Decimal(0), cierre: null };
  }

  // --- Los controles de cada renglón ---------------------------------------
  let hechos = 0;
  let fallados = 0;
  for (const renglon of renglones) {
    for (const control of renglon.controles) {
      hechos += 1;
      if (!control.paso) fallados += 1;
    }
  }
  if (fallados > 0) {
    penalizar(
      `${fallados} de ${hechos} controles aritméticos de renglón no cierran.`,
      Math.min(0.6, (fallados / Math.max(hechos, 1)) * 0.6),
    );
  }

  /*
   * Un renglón sin ningún control es un renglón que nadie verificó.
   *
   * No está mal leído: está sin comprobar, y eso tiene que pesar. Si no, una
   * lectura que pierde todas las columnas de precio menos el importe puntuaría
   * igual que una que cierra.
   */
  const sinControlar = renglones.filter((r) => r.controles.length === 0).length;
  if (sinControlar > 0) {
    penalizar(
      `${sinControlar} renglón/es no se pudieron comprobar contra su propia aritmética.`,
      Math.min(0.3, (sinControlar / renglones.length) * 0.3),
    );
  }

  // --- La suma contra el neto impreso --------------------------------------
  const sumaDeRenglones = renglones.reduce(
    (acc, r) => acc.plus(netoDelRenglon(r) ?? 0),
    new Decimal(0),
  );

  if (pie.netTotal && pie.netTotal.gt(0)) {
    const netos = renglones
      .map((r) => netoDelRenglon(r))
      .filter((n): n is Decimal => n !== null);
    const completos = netos.length === renglones.length;
    if (!completos) {
      penalizar(
        `${renglones.length - netos.length} de ${renglones.length} renglones no tienen importe.`,
        0.15,
      );
    }
    /*
     * El cierre se evalúa con los renglones que **sí** tienen importe, aunque
     * falte alguno.
     *
     * Antes, con un solo renglón sin importe no se comparaba nada, y eso dejaba
     * sin usar el control más fuerte que hay. Sobre la factura de Mabelherdi
     * alcanzaba con que el OCR inventara dos líneas de basura al principio y al
     * final para que sus nueve artículos —que suman **exactamente** el neto
     * impreso— quedaran sin confirmar, y con ellos las veintidós ambigüedades
     * que ese cierre vuelve irrelevantes.
     *
     * Que falten importes se sigue penalizando aparte: son dos cosas distintas
     * y las dos importan.
     */
    if (netos.length > 0) {
      /*
       * El cierre se juzga contra la **precisión impresa**, no contra una
       * tolerancia fija.
       *
       * Una tolerancia es un número elegido a ojo que afloja el control para
       * todos los proveedores por igual. Lo que corresponde es preguntar si el
       * pie impreso puede provenir de esta suma dados los decimales con que
       * están escritos los dos: la factura de Ezra imprime los renglones con
       * tres decimales y el pie con dos, y el centavo de diferencia lo explica
       * el truncamiento entero. En otro comprobante, con los renglones y el pie
       * a dos decimales, el mismo centavo no se explica y tiene que fallar.
       */
      cierre = evaluarCierre(netos, pie.netTotal, {
        vistas: renglones.length,
        conImporte: netos.length,
      });
      if (!cierre.compatible) {
        penalizar(
          cierre.explicacion,
          Math.min(0.7, 0.3 + cierre.ajusteResidual.div(pie.netTotal).toNumber()),
        );
      }
    }
  } else {
    penalizar('No hay neto impreso contra el cual comparar la suma.', 0.2);
  }

  /*
   * La compuerta: **un renglón incompleto no se compensa con el total**.
   *
   * Que la suma de los importes dé el neto impreso demuestra que la columna de
   * importes está completa. No demuestra nada sobre las cantidades, los precios
   * ni los descuentos: sobre la foto de Lácteos Barraza los dos importes sumaban
   * exacto mientras el segundo renglón no tenía precio y arrastraba un 42 % que
   * no cierra con nada. El comprobante se veía cuadrado y el costo por kilo de
   * uno de los dos artículos habría salido inventado.
   *
   * Son dos controles y el segundo no reemplaza al primero: cada renglón cierra
   * contra su propia aritmética, y después la suma cierra contra el pie. Un
   * renglón al que le falta la cantidad, el precio o el importe no tiene con qué
   * comprobarse, así que el comprobante **no puede aceptarse solo** por más que
   * el total dé. Se topea el puntaje por debajo del umbral automático en vez de
   * restar puntos: no es una penalización graduable, es una condición.
   */
  const incompletos = renglones.filter((renglon) => leFalta(renglon).length > 0);
  if (incompletos.length > 0) {
    const cuales = incompletos
      .map((renglon) => leFalta(renglon).join(', '))
      .slice(0, 3)
      .join('; ');
    penalizaciones.push({
      motivo:
        `${incompletos.length} renglón/es no tienen con qué comprobarse contra su propia ` +
        `aritmética (falta ${cuales}). El cierre contra el pie no los reemplaza.`,
      puntos: 0,
    });
    puntaje = Math.min(puntaje, TOPE_CON_RENGLON_INCOMPLETO);
  }

  // --- Filas vistas contra filas interpretadas -----------------------------
  if (pie.filasVistas !== null && pie.filasVistas > renglones.length) {
    const faltan = pie.filasVistas - renglones.length;
    penalizar(
      `El detector vio ${pie.filasVistas} filas y se interpretaron ${renglones.length}.`,
      Math.min(0.4, (faltan / pie.filasVistas) * 0.4),
    );
  }

  return { puntaje: Math.max(0, puntaje), penalizaciones, sumaDeRenglones, cierre };
}

/**
 * El neto de un renglón, que es lo que el pie totaliza.
 *
 * Cuando el importe está impreso, es ése. Cuando no, se reconstruye con la
 * cantidad, el precio y el descuento. Devuelve null si no alcanza para ninguna
 * de las dos cosas: un renglón sin importe no se inventa.
 */
export function netoDelRenglon(renglon: RenglonCandidato): Decimal | null {
  if (renglon.importe) {
    /*
     * Un importe bruto todavía no es lo que el pie totaliza: la bonificación de
     * Los Calvos se descuenta recién abajo, y sumar los nueve importes impresos
     * da 2.084.594,70 contra un neto gravado de 1.792.751,44.
     */
    return renglon.descuentoEnElImporte === false && renglon.descuentoPct
      ? renglon.importe.times(new Decimal(1).minus(renglon.descuentoPct)).toDecimalPlaces(2)
      : renglon.importe;
  }

  const cantidad = cantidadQueCuesta(renglon);
  const precio = renglon.precioConDescuento ?? renglon.precioUnitario;
  if (!cantidad || !precio) return null;

  const bruto = cantidad.times(precio);
  // El descuento sólo se aplica cuando el precio es el de lista: si ya venía
  // con descuento, aplicarlo otra vez lo restaría dos veces.
  const neto = renglon.precioConDescuento
    ? bruto
    : bruto.times(new Decimal(1).minus(renglon.descuentoPct ?? 0));
  return neto.toDecimalPlaces(2);
}

// ---------------------------------------------------------------------------
// La decisión
// ---------------------------------------------------------------------------

/**
 * Qué hace el sistema con lo que interpretó.
 *
 * Son tres y no dos: entre «lo leí» y «no lo leí» está el caso que este motor
 * existe para atender, que es «lo leí de dos maneras y no puedo elegir». Ése
 * va a configuración, no a la basura.
 */
export type Decision =
  /** Confianza suficiente y ventaja clara: se usa sin preguntar. */
  | 'automatica'
  /** Se entendió la tabla pero no alcanza para confiar: la mira una persona. */
  | 'revision-de-estructura'
  /** No hay nada utilizable. */
  | 'rechazo';

/**
 * El umbral de confianza y el margen contra la segunda candidata.
 *
 * Los dos hacen falta, y por razones distintas. El umbral evita aceptar una
 * lectura que no cierra aunque sea la mejor que hay. El margen evita aceptar
 * una lectura que cierra **igual de bien que otra distinta**: ahí no hay una
 * respuesta, hay dos, y elegir la primera es tirar una moneda con el costo de
 * cada artículo.
 *
 * Los valores son conservadores a propósito. Una revisión de más cuesta un
 * minuto; una compra cargada con las columnas cruzadas ensucia el historial de
 * costos y de ahí sale el precio de venta.
 */
export const UMBRAL_AUTOMATICO = 0.85;
export const MARGEN_MINIMO = 0.1;
/** Por debajo de esto no hay nada que revisar: la lectura no sirve. */
export const PISO_UTILIZABLE = 0.25;

export interface Veredicto {
  decision: Decision;
  ganadora: CandidataDeTabla | null;
  segunda: CandidataDeTabla | null;
  margen: number;
  /** Por qué se decidió así, en castellano. */
  motivo: string;
}

/**
 * Elige entre las candidatas, o decide que no se puede elegir.
 *
 * No devuelve «la mejor»: devuelve qué hacer. Es la diferencia entre un motor
 * que aparenta éxito y uno que sabe cuándo pedir ayuda.
 */
/**
 * Qué dice una lectura, sin nada de cómo llegó a decirlo.
 *
 * Sirve para no tratar como «dos candidatas» a dos caminos que llegaron al
 * mismo resultado. Pasa todo el tiempo: sobre un comprobante sin separadores de
 * miles, leerlo con la convención argentina o con la norteamericana da los
 * mismos números. Contarlas como dos dejaría el margen en cero y mandaría a
 * revisión un comprobante sobre el que **no hay ninguna duda**.
 */
function firmaDeLectura(candidata: CandidataDeTabla): string {
  return candidata.renglones
    .map((r) =>
      [
        r.descripcion,
        r.codigo ?? '',
        cantidadQueCuesta(r)?.toString() ?? '',
        r.piezas ?? '',
        netoDelRenglon(r)?.toString() ?? '',
      ].join('~'),
    )
    .join('|');
}

export function decidir(
  candidatas: CandidataDeTabla[],
  encabezadosSinResolver: string[] = [],
): Veredicto {
  /*
   * A igual puntaje gana la lectura que **menos números tuvo que reparar**.
   *
   * No es un desempate cosmético. Sobre la factura de Lácteos Barraza existe una
   * lectura del comprobante entero en la que se ignoran todos los separadores
   * decimales, y es internamente consistente: los dos renglones cierran y la
   * suma da el pie leído de la misma manera, cien veces más grande. Puntúa igual
   * que la buena porque cumple las mismas igualdades.
   *
   * Lo que la distingue es que necesita suponer que el OCR perdió el separador
   * de cada número del papel, y la otra no necesita suponer nada. Entre dos
   * explicaciones que cuadran, la que no inventa nada es la que hay que mostrar.
   *
   * Sigue siendo un empate de puntaje, así que el margen las manda a revisión
   * igual: esto decide cuál se le muestra a la persona, no si se acepta sola.
   */
  const ordenadas = [...candidatas].sort(
    (a, b) => b.puntaje - a.puntaje || a.reparaciones - b.reparaciones,
  );

  // Dos caminos que llegan al mismo resultado son una sola respuesta.
  const vistas = new Set<string>();
  const distintas = ordenadas.filter((c) => {
    const firma = firmaDeLectura(c);
    if (vistas.has(firma)) return false;
    vistas.add(firma);
    return true;
  });

  const ganadora = distintas[0] ?? null;
  const segunda = distintas[1] ?? null;

  if (!ganadora || ganadora.puntaje < PISO_UTILIZABLE) {
    return {
      decision: 'rechazo',
      ganadora,
      segunda,
      margen: 0,
      motivo: ganadora
        ? `La mejor lectura tiene ${ganadora.puntaje.toFixed(2)} de confianza, por debajo del piso ` +
          `de ${PISO_UTILIZABLE}. No hay nada utilizable.`
        : 'No se pudo interpretar ninguna lectura de la tabla.',
    };
  }

  const margen = segunda ? ganadora.puntaje - segunda.puntaje : 1;

  /*
   * Una columna que no se supo qué era frena el comprobante, y lo frena
   * diciéndolo: es lo único de todo el informe sobre lo que una persona puede
   * hacer algo en un minuto.
   *
   * Va antes del umbral a propósito. Cuando las dos cosas pasan a la vez —y
   * pasan juntas seguido, porque una columna sin asignar deja cuentas sin
   * hacer— «0,40 de confianza» no le dice a nadie qué arreglar, y «no se supo
   * qué era la columna Desc» sí.
   *
   * Y vale por sí solo, sin ayuda del puntaje: en la factura de Mabelherdi la
   * columna se llama «Desc» —que puede ser descripción o descuento, y las dos
   * existen— y el resto del comprobante cuadra igual, porque el porcentaje no
   * entra en ninguna de las igualdades cuando el importe ya viene neto.
   * Aceptarla sola cargaría un descuento como nombre de artículo, o al revés,
   * **sin que ningún número lo delate**.
   */
  if (encabezadosSinResolver.length > 0) {
    const cuales = encabezadosSinResolver.map((e) => `«${e}»`).join(', ');
    return {
      decision: 'revision-de-estructura',
      ganadora,
      segunda,
      margen,
      motivo:
        (encabezadosSinResolver.length === 1
          ? `Hay una columna que no se supo qué era: ${cuales}. `
          : `Hay columnas que no se supo qué eran: ${cuales}. `) +
        `Hay que configurarlas antes de usar el comprobante ` +
        `(la lectura tiene ${ganadora.puntaje.toFixed(2)} de confianza).`,
    };
  }

  if (ganadora.puntaje < UMBRAL_AUTOMATICO) {
    return {
      decision: 'revision-de-estructura',
      ganadora,
      segunda,
      margen,
      motivo:
        `La mejor lectura tiene ${ganadora.puntaje.toFixed(2)} de confianza y hace falta ` +
        `${UMBRAL_AUTOMATICO}. Hay que revisar la estructura.`,
    };
  }

  if (segunda && margen < MARGEN_MINIMO) {
    return {
      decision: 'revision-de-estructura',
      ganadora,
      segunda,
      margen,
      motivo:
        `Dos lecturas distintas cierran casi igual (${ganadora.puntaje.toFixed(2)} contra ` +
        `${segunda.puntaje.toFixed(2)}, ${margen.toFixed(2)} de margen y hace falta ` +
        `${MARGEN_MINIMO}). No hay una respuesta: hay dos.`,
    };
  }

  return {
    decision: 'automatica',
    ganadora,
    segunda,
    margen,
    motivo: `Confianza ${ganadora.puntaje.toFixed(2)} con ${margen.toFixed(2)} de ventaja sobre la segunda.`,
  };
}
