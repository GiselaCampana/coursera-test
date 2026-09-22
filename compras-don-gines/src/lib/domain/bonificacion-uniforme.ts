import { Decimal, type MoneyInput } from '@/lib/money';

/**
 * **La bonificación que el papel aplica a todos los renglones por igual.**
 *
 * Hay facturas donde el OCR recupera cantidad y precio de cada renglón pero
 * **pierde la columna de bonificación**. La de Barraza es una: sus dos renglones
 * salen con los kilos y el precio por kilo correctos, y con el importe
 * calculado como cantidad × precio —el bruto— en vez del neto impreso, que
 * lleva el 16 % descontado.
 *
 * Sin la bonificación el comprobante **igual cierra**, porque el neto del pie
 * es autoritativo y el motor deriva un descuento global. Pero cada renglón
 * queda costeado sobre su bruto, y de ahí salen el costo del artículo y el
 * movimiento de compra: el queso entraría a $10.361,45 el kilo cuando se pagó
 * $8.703,62. El total estaría bien y cada artículo estaría mal, que es la peor
 * combinación posible porque nada se ve en los controles.
 *
 * **Qué se puede demostrar y qué no.** Si existe **una sola** tasa uniforme que
 * aplicada a todos los renglones reproduce el neto impreso, esa tasa está
 * demostrada: no es una estimación ni un reparto proporcional elegido por
 * conveniencia, es la única solución de una ecuación con una incógnita. Se
 * registra como INFERIDO, con la cuenta a la vista.
 *
 * Si ninguna tasa uniforme lo reproduce —porque cada renglón tiene su propia
 * bonificación, o porque falta un renglón, o porque el neto del pie se leyó
 * mal— entonces **no hay nada que distribuir** y esta función se niega. El
 * comprobante queda en revisión y una persona carga las bonificaciones. Repartir
 * la diferencia proporcionalmente sería inventar un dato con forma de dato.
 *
 * **La tolerancia es de redondeo y de nada más.** Cada neto de renglón se
 * imprime redondeado al centavo, así que la suma de n renglones puede diferir
 * del total impreso hasta medio centavo por renglón. Eso es lo único que se
 * admite: `n × 0,005`, más un centavo de gracia. Una tolerancia más ancha
 * dejaría pasar un renglón faltante disfrazado de redondeo, que es exactamente
 * lo que esto no puede hacer.
 */

/** Un renglón visto por esta función: sólo cantidad y precio. */
export interface RenglonParaBonificar {
  lineNumber: number;
  /** Cantidad, como cadena decimal. */
  quantity: string;
  /** Precio unitario **antes** de la bonificación. */
  unitNetPrice: string;
  /**
   * La bonificación que el OCR **sí** leyó para este renglón, si la leyó.
   *
   * Un renglón con bonificación leída no participa de la inferencia: lo que se
   * busca es la tasa de los que no la traen, y mezclarlas daría una tasa que no
   * es la de nadie.
   */
  discountPct?: string | null;
}

/** Cómo se llama esta bonificación en la procedencia que ve la pantalla. */
export const PROCEDENCIA_DE_LA_BONIFICACION = 'INFERIDO' as const;

export type BonificacionUniforme =
  | {
      ok: true;
      /** La tasa, en porcentaje: `16` para el 16 %. */
      tasa: string;
      /** La cuenta que la demuestra, para poder mostrarla. */
      evidencia: {
        bruto: string;
        netoImpreso: string;
        /** El neto que se reconstruye aplicando la tasa renglón por renglón. */
        netoReconstruido: string;
        /** Lo que sobra o falta, que tiene que ser redondeo. */
        residuo: string;
        /** Cuántos renglones participaron. */
        renglones: number;
      };
    }
  | {
      ok: false;
      /** Por qué no se puede afirmar una tasa uniforme. */
      motivo: string;
    };

/**
 * El máximo desvío admitido: medio centavo por renglón, más un centavo.
 *
 * No es un número elegido para que Barraza pase. Es la cota de error del
 * redondeo a centavos de n sumandos, que es la única diferencia que puede haber
 * entre la suma de los netos impresos y el neto del pie cuando todo lo demás
 * está bien.
 */
function toleranciaDeRedondeo(renglones: number): Decimal {
  return new Decimal('0.005').times(renglones).plus('0.01');
}

/**
 * ¿Hay una bonificación uniforme que explique el neto impreso?
 *
 * Devuelve la tasa cuando existe y se puede demostrar, o el motivo por el que
 * no. Nunca devuelve una tasa aproximada: o reproduce el papel, o se niega.
 */
export function bonificacionUniformeInferida(
  renglones: RenglonParaBonificar[],
  netoImpreso: string | null | undefined,
): BonificacionUniforme {
  if (netoImpreso === null || netoImpreso === undefined || netoImpreso.trim() === '') {
    return { ok: false, motivo: 'El comprobante no trae el neto impreso, así que no hay contra qué comprobar la bonificación.' };
  }

  /*
   * Sólo los renglones SIN bonificación leída. Si el OCR leyó la de algunos, la
   * tasa que se busca es la de los otros, y meterlos en la cuenta daría una
   * mezcla que no es la bonificación de ningún renglón.
   */
  const sinBonificacion = renglones.filter((r) => {
    const leida = r.discountPct?.trim();
    return leida === undefined || leida === '' || new Decimal(leida).isZero();
  });

  if (sinBonificacion.length === 0) {
    return { ok: false, motivo: 'Todos los renglones ya traen su bonificación leída: no hay nada que inferir.' };
  }
  if (sinBonificacion.length !== renglones.length) {
    return {
      ok: false,
      motivo:
        'Algunos renglones traen bonificación leída y otros no. Una tasa uniforme no puede ' +
        'demostrarse sobre una mezcla: las bonificaciones que falten se cargan a mano.',
    };
  }

  const neto = new Decimal(netoImpreso);
  let bruto = new Decimal(0);
  for (const r of renglones) {
    const cantidad = new Decimal(r.quantity || '0');
    const precio = new Decimal(r.unitNetPrice || '0');
    bruto = bruto.plus(cantidad.times(precio));
  }

  if (bruto.lessThanOrEqualTo(0)) {
    return { ok: false, motivo: 'Los renglones no suman un bruto positivo: no hay base sobre la que calcular una bonificación.' };
  }

  const tolerancia = toleranciaDeRedondeo(renglones.length);

  /* Sin diferencia contra el bruto no hay bonificación que buscar. */
  if (bruto.minus(neto).abs().lessThanOrEqualTo(tolerancia)) {
    return { ok: false, motivo: 'El bruto de los renglones ya coincide con el neto impreso: no hay bonificación.' };
  }

  /* Un neto MAYOR que el bruto no es una bonificación: es otra cosa. */
  if (neto.greaterThan(bruto)) {
    return {
      ok: false,
      motivo:
        'El neto impreso es mayor que la suma de los renglones. Eso no es una bonificación: ' +
        'puede faltar un renglón o el neto se leyó mal.',
    };
  }

  /*
   * La tasa implícita, redondeada a dos decimales de porcentaje.
   *
   * Se redondea porque las facturas imprimen «16,00 %» y no «15,9997 %»: la
   * tasa que hay que reconstruir es la que está impresa, no el cociente exacto.
   * Y se redondea ANTES de reaplicarla, así que lo que se comprueba después es
   * que la tasa **redonda** reproduce el papel. Si no lo reproduce, no era esa.
   */
  const tasaExacta = new Decimal(1).minus(neto.div(bruto)).times(100);
  const tasa = new Decimal(tasaExacta.toFixed(2));

  if (tasa.lessThanOrEqualTo(0) || tasa.greaterThanOrEqualTo(100)) {
    return { ok: false, motivo: `La bonificación implícita (${tasaExacta.toFixed(4)} %) no es un porcentaje posible.` };
  }

  /*
   * Y la comprobación que decide: se reconstruye el neto de CADA renglón con la
   * tasa redonda, redondeando al centavo como lo imprime el papel, y se suma.
   */
  const factor = new Decimal(1).minus(tasa.div(100));
  let netoReconstruido = new Decimal(0);
  for (const r of renglones) {
    const brutoDelRenglon = new Decimal(r.quantity || '0').times(r.unitNetPrice || '0');
    netoReconstruido = netoReconstruido.plus(new Decimal(brutoDelRenglon.times(factor).toFixed(2)));
  }

  const residuo = netoReconstruido.minus(neto);
  if (residuo.abs().greaterThan(tolerancia)) {
    return {
      ok: false,
      motivo:
        `Ninguna bonificación uniforme reproduce el neto impreso: con ${tasa.toFixed(2)} % la ` +
        `suma de los renglones da ${netoReconstruido.toFixed(2)} y el papel dice ${neto.toFixed(2)} ` +
        `(${residuo.toFixed(2)} de diferencia). Las bonificaciones se cargan renglón por renglón.`,
    };
  }

  return {
    ok: true,
    tasa: tasa.toFixed(2),
    evidencia: {
      bruto: bruto.toFixed(2),
      netoImpreso: neto.toFixed(2),
      netoReconstruido: netoReconstruido.toFixed(2),
      residuo: residuo.toFixed(2),
      renglones: renglones.length,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Aplicarla a los renglones leídos                                          */
/* -------------------------------------------------------------------------- */

/** Lo mínimo de un renglón leído que esta parte necesita ver y escribir. */
export interface RenglonLeido {
  lineNumber: number;
  /*
   * Los importes llegan como `MoneyInput` —cadena o número— porque así los
   * declara `RawItem`, que es lo que trae la lectura. Se normalizan con
   * `String()` antes de entrar a la aritmética: `Decimal` lee las dos.
   */
  quantity?: MoneyInput | null;
  unitNetPrice?: MoneyInput | null;
  /** La bonificación como **fracción** (0,16), que es la convención interna. */
  discountPct?: MoneyInput | null;
  /** El importe neto, cuando el papel lo imprimió. */
  netAmount?: MoneyInput | null;
  grossSubtotal?: MoneyInput | null;
}

export interface BonificacionAplicada<T> {
  items: T[];
  /** La inferencia, para poder mostrarla y auditarla. Null si no se aplicó. */
  inferida:
    | (Extract<BonificacionUniforme, { ok: true }>['evidencia'] & {
        tasa: string;
        procedencia: typeof PROCEDENCIA_DE_LA_BONIFICACION;
      })
    | null;
  /** Por qué no se aplicó, cuando no se aplicó y había diferencia. */
  motivo: string | null;
}

/**
 * Completa la bonificación que el OCR perdió, **sólo si se puede demostrar**.
 *
 * Se llama en la lectura, junto con la conciliación de centavos y por la misma
 * razón: es una regla del negocio y no del formato de un proveedor, así que
 * vale igual para cualquier comprobante. Devuelve los renglones **sin tocar**
 * salvo que se den todas las condiciones, así que llamarla siempre no cambia
 * nada en los comprobantes que ya cerraban.
 *
 * Condición extra respecto de la inferencia pura: **ningún renglón puede traer
 * su neto impreso**. Si el papel imprimió el neto de un renglón, ese neto es
 * autoritativo y no hay nada que inferirle; mezclar los dos caminos daría un
 * renglón costeado dos veces.
 */
export function completarBonificacionUniforme<T extends RenglonLeido>(
  items: T[],
  netoImpreso: MoneyInput | null | undefined,
): BonificacionAplicada<T> {
  if (items.length === 0) return { items, inferida: null, motivo: null };

  /* Un neto impreso por renglón manda: no se infiere nada encima. */
  if (items.some((i) => i.netAmount !== null && i.netAmount !== undefined && String(i.netAmount) !== '')) {
    return { items, inferida: null, motivo: null };
  }

  const neto = netoImpreso === null || netoImpreso === undefined ? null : String(netoImpreso);
  const resultado = bonificacionUniformeInferida(
    items.map((i) => ({
      lineNumber: i.lineNumber,
      quantity: String(i.quantity ?? '0'),
      unitNetPrice: String(i.unitNetPrice ?? '0'),
      discountPct: i.discountPct === null || i.discountPct === undefined ? null : String(i.discountPct),
    })),
    neto,
  );

  if (!resultado.ok) {
    /*
     * «No hay bonificación» y «ya venían leídas» no son avisos: son el caso
     * normal de la enorme mayoría de los comprobantes. Sólo se informa el
     * motivo cuando había una diferencia que no se pudo explicar, que es lo
     * que tiene que llevar el comprobante a revisión.
     */
    const esNormal =
      resultado.motivo.includes('no hay bonificación') ||
      resultado.motivo.includes('no hay nada que inferir') ||
      resultado.motivo.includes('no trae el neto impreso');
    return { items, inferida: null, motivo: esNormal ? null : resultado.motivo };
  }

  /* La tasa viaja adentro como fracción: 16,00 % es 0,16. */
  const fraccion = new Decimal(resultado.tasa).div(100).toString();

  return {
    items: items.map((i) => ({ ...i, discountPct: fraccion })),
    inferida: {
      ...resultado.evidencia,
      tasa: resultado.tasa,
      procedencia: PROCEDENCIA_DE_LA_BONIFICACION,
    },
    motivo: null,
  };
}
