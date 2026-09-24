import type { ReactNode } from 'react';

/**
 * El aviso que encabeza **todas** las pantallas de Stock ERP.
 *
 * Vive en un componente y no copiado en cada página por una razón concreta: si
 * el texto estuviera escrito cuatro veces, alcanzaría con olvidarse de una para
 * que exista una pantalla que muestra saldos sin decir que están incompletos. Y
 * la pantalla que se olvida es siempre la que alguien mira.
 *
 * La frase es la misma en todas y dice lo que hay que decir: los saldos SUBEN
 * con las compras y todavía no BAJAN con las ventas. Un inventario que sólo
 * crece no es un inventario, y quien mire un número acá tiene que saberlo antes
 * de usarlo para pedir mercadería.
 */
export function EnPreparacion({ children }: { children?: ReactNode }) {
  return (
    <p className="mensaje mensaje-aviso" data-prueba="stock-erp-en-preparacion">
      <strong>Stock ERP en preparación</strong> — los saldos todavía no incluyen ventas y no
      representan existencias operativas completas.
      {children ? <> {children}</> : null}
    </p>
  );
}
