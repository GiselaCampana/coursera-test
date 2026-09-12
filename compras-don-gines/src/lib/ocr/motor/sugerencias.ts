import { Decimal } from '@/lib/money';
import {
  cantidadQueCuesta,
  type RenglonCandidato,
} from '@/lib/ocr/motor/candidatas';
import type { CampoDeColumna } from '@/lib/ocr/motor/columnas';

/**
 * Lo que la aritmética **sugiere**, sin convertirlo nunca en un dato leído.
 *
 * La aritmética es la mejor herramienta que tiene este motor: es lo que permite
 * elegir entre dos lecturas de la misma celda, ubicar un valor que se fue de
 * renglón y descartar una escala imposible. Todo eso es **seleccionar
 * evidencia**, y es legítimo.
 *
 * Lo que no puede hacer es la operación inversa: cuando no hay evidencia,
 * calcular el valor que falta. La cuenta siempre da: si un renglón tiene
 * cantidad e importe, el precio sale de dividir, y el renglón queda
 * «comprobado» contra un número que la propia cuenta produjo. Eso no es leer
 * una factura, es rellenarla, y el resultado no se distingue de un dato real ni
 * en la pantalla ni en el historial de costos —de donde sale el precio de
 * venta—.
 *
 * Así que el valor calculado existe, se muestra, y vive en un objeto aparte que
 * **no es parte del renglón**. Un renglón al que le falta el precio sigue
 * teniendo `precioUnitario` en `null` después de que esta capa corre. La
 * sugerencia:
 *
 *  - no valida el renglón: no aparece en sus controles;
 *  - no alimenta el costo: no está en el renglón que lo calcula;
 *  - no permite guardar la compra: la celda sigue siendo un bloqueo;
 *  - no se vuelve evidencia de OCR: no tiene caja, no tiene pasada, y dice de
 *    qué igualdad salió;
 *  - y no esconde que el valor no se leyó, porque va etiquetada.
 *
 * Es una ayuda para la persona que va a tipear el número: le dice cuánto
 * **debería** dar, para que confirme el que ve en el papel. No lo reemplaza.
 */

/** La etiqueta con la que se muestra: un valor calculado, no leído. */
export const DERIVED_SUGGESTION = 'DERIVED_SUGGESTION' as const;

export interface SugerenciaDerivada {
  clase: typeof DERIVED_SUGGESTION;
  /** El renglón, contando desde 1. */
  renglon: number;
  campo: CampoDeColumna;
  /** Cuánto daría el valor que falta. */
  valor: Decimal;
  /** De qué igualdad salió, en castellano. */
  deDondeSale: string;
  /** Qué valores leídos se usaron para calcularla. */
  insumos: { campo: CampoDeColumna; valor: string }[];
}

/**
 * Qué valor faltante se puede calcular, y con qué.
 *
 * Sólo cuando falta **uno** de los tres de la cuenta y los otros dos están
 * leídos. Con dos faltantes no hay una cuenta, hay infinitas soluciones, y
 * ofrecer una sería elegir al azar.
 *
 * El descuento no se sugiere: un renglón puede no tener descuento y no hay
 * manera de distinguir «no tiene» de «no se leyó» por aritmética.
 */
export function sugerenciasDerivadas(renglones: RenglonCandidato[]): SugerenciaDerivada[] {
  const salida: SugerenciaDerivada[] = [];

  renglones.forEach((renglon, indice) => {
    const cantidad = cantidadQueCuesta(renglon);
    const precio = renglon.precioConDescuento ?? renglon.precioUnitario;
    const importe = renglon.importe;
    const factor = renglon.precioConDescuento
      ? new Decimal(1)
      : new Decimal(1).minus(renglon.descuentoPct ?? 0);

    const falta = [cantidad, precio, importe].filter((v) => v === null).length;
    if (falta !== 1) return;

    const numero = indice + 1;
    const como = renglon.descuentoPct && !renglon.precioConDescuento
      ? 'cantidad × precio × (1 − descuento) = importe'
      : 'cantidad × precio = importe';

    if (importe === null && cantidad && precio) {
      salida.push({
        clase: DERIVED_SUGGESTION,
        renglon: numero,
        campo: 'importe',
        valor: cantidad.times(precio).times(factor).toDecimalPlaces(2),
        deDondeSale: como,
        insumos: [
          { campo: 'cantidad', valor: cantidad.toString() },
          { campo: 'precioUnitario', valor: precio.toString() },
        ],
      });
      return;
    }

    if (precio === null && cantidad && importe && cantidad.gt(0) && factor.gt(0)) {
      salida.push({
        clase: DERIVED_SUGGESTION,
        renglon: numero,
        campo: 'precioUnitario',
        valor: importe.div(factor).div(cantidad).toDecimalPlaces(4),
        deDondeSale: como,
        insumos: [
          { campo: 'cantidad', valor: cantidad.toString() },
          { campo: 'importe', valor: importe.toString() },
        ],
      });
      return;
    }

    if (cantidad === null && precio && importe && precio.gt(0) && factor.gt(0)) {
      salida.push({
        clase: DERIVED_SUGGESTION,
        renglon: numero,
        campo: 'cantidad',
        valor: importe.div(factor).div(precio).toDecimalPlaces(4),
        deDondeSale: como,
        insumos: [
          { campo: 'precioUnitario', valor: precio.toString() },
          { campo: 'importe', valor: importe.toString() },
        ],
      });
    }
  });

  return salida;
}

/**
 * ¿Se puede dar este renglón por confirmado sin que lo mire una persona?
 *
 * Tres condiciones, y las tres hacen falta:
 *
 *  1. **tiene una cuenta que hacer**: al menos un control. Un renglón sin
 *     controles no está bien, está sin comprobar;
 *  2. **la cuenta cierra**;
 *  3. y sus celdas se leyeron **de una manera que el resto de su columna
 *     sostiene**.
 *
 * La tercera es la que se aprendió midiendo, y sin ella las otras dos no
 * alcanzan. En una de las facturas del banco hay un renglón donde el OCR perdió
 * el separador decimal de la cantidad **y** del subtotal a la vez: las dos
 * lecturas son literales —el papel, tal como salió, no tiene ninguna coma ahí—
 * y la igualdad cierra perfecto, porque correr la coma de los dos lados
 * mantiene la proporción. Un renglón diez veces más caro, sin una sola
 * reparación y con su cuenta hecha. Lo único que lo desmiente son sus
 * veintidós vecinos de columna, que escriben los subtotales con coma y dos
 * decimales.
 *
 * Y el cierre del comprobante contra el pie no entra acá a propósito: eso
 * prueba que la columna de importes está completa, no que este renglón esté
 * bien. Son dos controles y el segundo no reemplaza al primero.
 */
export function renglonConfirmado(renglon: RenglonCandidato): boolean {
  return (
    renglon.controles.length > 0 &&
    renglon.controles.every((c) => c.paso) &&
    renglon.incoherentes === 0 &&
    renglon.severidad < 3
  );
}
