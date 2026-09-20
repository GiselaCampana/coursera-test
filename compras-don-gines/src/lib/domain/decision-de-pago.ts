import { addDays, parseArDate, toDateOnly, toISODate } from '@/lib/datetime';
import { PAYMENT_METHODS, type PaymentTerm } from '@/lib/domain/payments';

/**
 * **Cuándo y cómo se paga, cuando el proveedor no lo tiene acordado.**
 *
 * Una compra a un proveedor habitual trae su condición de la ficha: a treinta
 * días, contra entrega, factura contra factura. Una compra excepcional no trae
 * nada, y ahí aparece la pregunta que hasta ahora se contestaba sola: ¿cuándo
 * hay que pagar esto, y de qué forma?
 *
 * Se contestaba sola y mal. La confirmación tenía dos valores por omisión
 * encadenados —el vencimiento caía en la fecha de emisión y la forma de pago en
 * «Transferencia»— así que una factura de un proveedor nuevo quedaba agendada,
 * vencida el mismo día que se emitió, con una forma de pago que nadie eligió.
 * El resultado era plata con fecha inventada, que es de las peores cosas que
 * puede escribir un sistema de compras: nadie sabe si esa fecha es un acuerdo
 * o un relleno, y el que la mira de acá a un mes no tiene cómo distinguirlo.
 *
 * Por eso esto no tiene ningún valor por omisión. Se elige, o no se aplica.
 *
 * **No hay catálogo nuevo.** Las formas de pago son las que ya usa el sistema
 * y las condiciones son las que ya modela `PaymentTerm`: contado es SAME_DAY,
 * un plazo en días es DAYS, y una fecha puntual es MANUAL. Lo único que agrega
 * este archivo es la decisión explícita de una persona y sus límites.
 */

/** Las condiciones que una persona puede elegir para una factura suelta. */
export type CondicionElegida =
  /** Contado o pago inmediato: vence el día de emisión. */
  | { tipo: 'CONTADO' }
  /** A plazo: vence a tantos días de la emisión. */
  | { tipo: 'DIAS'; dias: number }
  /** Una fecha puntual, acordada con el proveedor. */
  | { tipo: 'FECHA'; fecha: string };

export interface DecisionDePago {
  /** Una de PAYMENT_METHODS. No hay omisión. */
  forma: string;
  condicion: CondicionElegida;
}

export interface PagoResuelto {
  dueDate: Date;
  term: PaymentTerm;
  paymentMethod: string;
  /** Si la fecha la puso una persona y no una regla. Se audita. */
  fechaElegidaAMano: boolean;
  /** Cómo se llegó a esa fecha, en palabras, para el asiento y la pantalla. */
  comoSeCalculo: string;
}

export type Resolucion =
  | { ok: true; pago: PagoResuelto }
  | { ok: false; motivo: string };

/** Hasta dónde llega un plazo razonable. Más que un año es un error de tipeo. */
const MAXIMO_DE_DIAS = 365;

/**
 * El freno que se levanta eligiendo, y el único que la pantalla puede levantar
 * sola.
 *
 * Vive acá —y no junto a los demás frenos, que se arman en el servidor— para
 * que la pantalla pueda reconocerlo sin comparar el texto a mano. Es lo que le
 * permite hacer desaparecer el aviso en cuanto la decisión queda completa, en
 * vez de dejarlo diciendo «todavía no se puede» con el botón ya habilitado.
 *
 * Los otros frenos no se levantan desde el navegador: un renglón sin asociar o
 * un total que no está impreso necesitan que alguien vuelva al comprobante.
 */
export const FRENO_DE_COMO_SE_PAGA =
  'Este proveedor no tiene condición de pago configurada: hay que elegir la forma de pago ' +
  'y el vencimiento. No hay ninguno por omisión.';

/**
 * Convierte la decisión de una persona en fecha, plazo y forma de pago.
 *
 * Es una función pura y devuelve el motivo en vez de lanzar: la usan el
 * servidor —que traduce el motivo a un error— y la pantalla, que lo muestra
 * antes de dejar apretar el botón. Que sea la misma en los dos lados es lo que
 * evita que la pantalla habilite algo que el servidor después rechaza.
 */
export function resolverDecisionDePago(
  decision: DecisionDePago | null | undefined,
  issueDate: Date,
): Resolucion {
  if (!decision) {
    return { ok: false, motivo: 'Falta elegir la forma de pago y el vencimiento.' };
  }

  const forma = (decision.forma ?? '').trim();
  if (forma === '') {
    return { ok: false, motivo: 'Falta elegir la forma de pago.' };
  }
  if (!(PAYMENT_METHODS as readonly string[]).includes(forma)) {
    return { ok: false, motivo: `«${forma}» no es una forma de pago del sistema.` };
  }

  const emision = toDateOnly(issueDate);

  switch (decision.condicion?.tipo) {
    case 'CONTADO':
      return {
        ok: true,
        pago: {
          dueDate: emision,
          term: { termType: 'SAME_DAY', days: 0, paymentMethod: forma },
          paymentMethod: forma,
          fechaElegidaAMano: false,
          comoSeCalculo: 'Contado: vence el día de emisión del comprobante.',
        },
      };

    case 'DIAS': {
      const dias = Number(decision.condicion.dias);
      if (!Number.isInteger(dias) || dias < 1 || dias > MAXIMO_DE_DIAS) {
        return {
          ok: false,
          motivo: `El plazo tiene que ser un número entero de días, entre 1 y ${MAXIMO_DE_DIAS}.`,
        };
      }
      return {
        ok: true,
        pago: {
          dueDate: addDays(emision, dias),
          term: { termType: 'DAYS', days: dias, paymentMethod: forma },
          paymentMethod: forma,
          fechaElegidaAMano: false,
          comoSeCalculo: `A ${dias} días de la emisión (${toISODate(emision)} + ${dias}).`,
        },
      };
    }

    case 'FECHA': {
      const elegida = parseArDate(decision.condicion.fecha);
      if (!elegida) {
        return { ok: false, motivo: 'La fecha de vencimiento que elegiste no se entiende.' };
      }
      const vencimiento = toDateOnly(elegida);
      /*
       * Nunca antes de la emisión.
       *
       * Una factura se puede cargar tarde y quedar vencida, y eso es legítimo:
       * pasó, hay que pagarla. Lo que no puede pasar es vencer **antes de
       * existir**. Por eso el límite se mide contra la emisión y no contra hoy:
       * comparar contra hoy rechazaría facturas viejas que son correctas.
       */
      if (vencimiento.getTime() < emision.getTime()) {
        return {
          ok: false,
          motivo:
            `El vencimiento (${toISODate(vencimiento)}) no puede ser anterior a la emisión ` +
            `(${toISODate(emision)}).`,
        };
      }
      return {
        ok: true,
        pago: {
          dueDate: vencimiento,
          term: { termType: 'MANUAL', days: 0, paymentMethod: forma },
          paymentMethod: forma,
          fechaElegidaAMano: true,
          comoSeCalculo: `Fecha elegida a mano: ${toISODate(vencimiento)}.`,
        },
      };
    }

    default:
      return { ok: false, motivo: 'Falta elegir la condición de pago.' };
  }
}

/**
 * La misma regla, aplicada a una fecha que ya viene resuelta.
 *
 * Sirve para el camino del proveedor con condición configurada, donde la fecha
 * no la eligió nadie ahora sino que la calculó la regla acordada. Igual se
 * comprueba: una condición mal cargada no puede producir un vencimiento
 * anterior a la emisión.
 */
export function vencimientoPosibleParaLaEmision(dueDate: Date, issueDate: Date): boolean {
  return toDateOnly(dueDate).getTime() >= toDateOnly(issueDate).getTime();
}
