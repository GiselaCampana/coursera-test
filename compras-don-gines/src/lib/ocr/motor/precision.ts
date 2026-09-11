import { Decimal } from '@/lib/money';

/**
 * Cerrar un comprobante teniendo en cuenta con cuántos decimales está impreso.
 *
 * El problema concreto: la factura de Distribuidora Ezra imprime los importes
 * de renglón con **tres** decimales y el subtotal con **dos**. Los seis
 * renglones suman 221.388,847 y el pie dice 221.388,84. No hay ningún error:
 * el papel truncó. Pero medido contra el pie con una tolerancia fija, ese
 * centavo es una diferencia, y el comprobante no cierra.
 *
 * La salida fácil sería bajar el umbral de confianza o ensanchar la tolerancia
 * hasta que Ezra pase. Las dos cosas son lo mismo y las dos están mal: aflojan
 * el control para **todos** los proveedores, incluido aquel en el que un
 * centavo de diferencia sí es un renglón mal leído.
 *
 * Lo que se hace acá es modelar lo que un número impreso realmente dice. Un
 * importe escrito «27.081,371» no afirma que el valor sea exactamente ése:
 * afirma que el valor real cae en un intervalo, y cuál intervalo depende de si
 * el sistema que lo imprimió redondeó o truncó. Si el intervalo de la suma y el
 * intervalo del pie se tocan, el comprobante cierra —y se puede decir con qué
 * regla—. Si no se tocan, no cierra, por poco que sea la diferencia.
 */

/** Cómo llevó a su precisión impresa el sistema que emitió el comprobante. */
export type PoliticaDeRedondeo = 'truncamiento' | 'redondeo';

export interface Intervalo {
  /** Incluido. */
  desde: Decimal;
  /** Excluido. */
  hasta: Decimal;
}

/**
 * El intervalo de valores reales que puede representar un número impreso.
 *
 * Con truncamiento, «27.081,371» puede venir de cualquier valor entre
 * 27.081,371 y 27.081,372: se tiraron los decimales de más. Con redondeo, de
 * cualquiera entre 27.081,3705 y 27.081,3715.
 */
export function intervaloDe(
  valor: Decimal,
  decimales: number,
  politica: PoliticaDeRedondeo,
): Intervalo {
  const paso = new Decimal(10).pow(-decimales);
  if (politica === 'truncamiento') {
    // El truncamiento de un negativo va hacia el cero, así que el intervalo se
    // da vuelta. Un importe negativo es una nota de crédito, no un imposible.
    return valor.isNegative()
      ? { desde: valor.minus(paso), hasta: valor }
      : { desde: valor, hasta: valor.plus(paso) };
  }
  const mitad = paso.div(2);
  return { desde: valor.minus(mitad), hasta: valor.plus(mitad) };
}

/** ¿Se tocan los dos intervalos? Los extremos de arriba están excluidos. */
export function seTocan(a: Intervalo, b: Intervalo): boolean {
  return a.desde.lt(b.hasta) && b.desde.lt(a.hasta);
}

/**
 * Con cuántos decimales está expresado un importe.
 *
 * **Un importe de dinero vale como mínimo dos.** Parece una arbitrariedad y es
 * lo contrario: `Decimal` normaliza y le come los ceros de la derecha, así que
 * un total impreso «71.400,00» queda guardado como `71400` y preguntarle
 * cuántos decimales tiene contesta **cero**. Con esa respuesta, el intervalo
 * compatible pasa a ser de un peso entero para arriba y para abajo, y el
 * control deja de controlar: cualquier diferencia de centavos —incluida la de
 * un renglón mal leído— entraría como redondeo legítimo.
 *
 * Se toma el máximo entre dos y lo que quede, así que un importe con tres
 * decimales sigue valiendo tres. La cuenta es conservadora en la dirección
 * correcta: si el papel tenía más precisión de la que sobrevivió al parseo, el
 * intervalo sale más chico y el control, más exigente.
 */
export function decimalesDe(valor: Decimal): number {
  return Math.max(2, valor.decimalPlaces());
}

export interface CierreCompatible {
  /** La suma de los renglones, tal como se calculó. */
  calculado: Decimal;
  /** El valor impreso en el pie. */
  impreso: Decimal;
  /** Cuántos decimales traen los renglones, del que más tiene. */
  decimalesDeOrigen: number;
  /** Cuántos decimales trae el pie. */
  decimalesDelPie: number;
  /** La regla con la que el pie se explica, o null si ninguna lo explica. */
  politica: PoliticaDeRedondeo | null;
  /**
   * Lo que queda sin explicar después de aplicar la regla.
   *
   * Cero cuando la regla lo explica entero. Cuando no hay regla compatible, es
   * cuánto habría que mover el cálculo para que el intervalo llegara al del
   * pie: es la diferencia que de verdad hay que justificar.
   */
  ajusteResidual: Decimal;
  /** La diferencia cruda entre lo calculado y lo impreso. */
  diferencia: Decimal;
  compatible: boolean;
  /** Para el informe, en castellano. */
  explicacion: string;
}

/**
 * ¿Puede el pie impreso provenir de esta suma de renglones?
 *
 * Cada renglón aporta su propia incertidumbre: si vino impreso con dos
 * decimales, el valor real está en un intervalo de un centésimo, y sumando
 * veinte renglones esa incertidumbre se acumula. Por eso el intervalo de la
 * suma se arma sumando los intervalos, y no aplicándole un margen al total: un
 * comprobante de veintitrés renglones tiene más margen legítimo que uno de dos,
 * y una tolerancia fija trata a los dos igual.
 *
 * Se prueban las dos políticas y gana la primera que explique el pie. El
 * truncamiento se prueba antes porque es lo que hacen casi todos los sistemas de
 * facturación argentinos, y porque es la que explica el caso que trajo esto.
 */
export function evaluarCierre(
  netosDeRenglon: Decimal[],
  impreso: Decimal,
): CierreCompatible {
  const calculado = netosDeRenglon.reduce((acc, v) => acc.plus(v), new Decimal(0));
  const diferencia = calculado.minus(impreso).abs();
  const decimalesDeOrigen = netosDeRenglon.length
    ? Math.max(...netosDeRenglon.map(decimalesDe))
    : 0;
  const decimalesDelPie = decimalesDe(impreso);

  const base = {
    calculado,
    impreso,
    decimalesDeOrigen,
    decimalesDelPie,
    diferencia,
  };

  for (const politica of ['truncamiento', 'redondeo'] as PoliticaDeRedondeo[]) {
    const deLaSuma = netosDeRenglon.reduce<Intervalo>(
      (acc, valor) => {
        const parte = intervaloDe(valor, decimalesDe(valor), politica);
        return { desde: acc.desde.plus(parte.desde), hasta: acc.hasta.plus(parte.hasta) };
      },
      { desde: new Decimal(0), hasta: new Decimal(0) },
    );
    const delPie = intervaloDe(impreso, decimalesDelPie, politica);

    if (seTocan(deLaSuma, delPie)) {
      return {
        ...base,
        politica,
        ajusteResidual: new Decimal(0),
        compatible: true,
        explicacion:
          `Los renglones suman ${calculado.toFixed(Math.max(decimalesDeOrigen, 2))} con ` +
          `${decimalesDeOrigen} decimales y el pie dice ${impreso.toFixed(decimalesDelPie)} con ` +
          `${decimalesDelPie}. La diferencia de ${diferencia.toFixed(decimalesDeOrigen || 2)} se ` +
          `explica entera por ${politica} a ${decimalesDelPie} decimales: ` +
          `el valor real cae en ${enTexto(deLaSuma)}, y el pie admite ${enTexto(delPie)}.`,
      };
    }
  }

  /*
   * Ninguna regla lo explica. El residuo es lo que falta para que los
   * intervalos se toquen, no la diferencia cruda: es la parte que la precisión
   * impresa **no** puede justificar, y la única que hay que explicar de otra
   * manera.
   */
  const conTruncamiento = netosDeRenglon.reduce<Intervalo>(
    (acc, valor) => {
      const parte = intervaloDe(valor, decimalesDe(valor), 'truncamiento');
      return { desde: acc.desde.plus(parte.desde), hasta: acc.hasta.plus(parte.hasta) };
    },
    { desde: new Decimal(0), hasta: new Decimal(0) },
  );
  const delPie = intervaloDe(impreso, decimalesDelPie, 'truncamiento');
  const residuo = conTruncamiento.desde.gte(delPie.hasta)
    ? conTruncamiento.desde.minus(delPie.hasta)
    : delPie.desde.minus(conTruncamiento.hasta);

  return {
    ...base,
    politica: null,
    ajusteResidual: residuo.abs(),
    compatible: false,
    explicacion:
      `Los renglones suman ${calculado.toFixed(Math.max(decimalesDeOrigen, 2))} y el pie dice ` +
      `${impreso.toFixed(decimalesDelPie)}. Con la precisión impresa el valor real caería en ` +
      `${enTexto(conTruncamiento)} y el pie admite ${enTexto(delPie)}: quedan ` +
      `${residuo.abs().toFixed(2)} que ni el redondeo ni el truncamiento explican.`,
  };
}

function enTexto(intervalo: Intervalo): string {
  return `[${intervalo.desde.toFixed(4)}, ${intervalo.hasta.toFixed(4)})`;
}
