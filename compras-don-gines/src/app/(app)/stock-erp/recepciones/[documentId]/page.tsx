import type { Metadata } from 'next';
import Link from 'next/link';
import { requireUserOrRedirect, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import {
  vistaPreviaDeRecepcion,
  interruptorDeRecepcionesReales,
} from '@/lib/services/stock-erp-recepcion';
import { arTodayISO, horaArgentinaISO } from '@/lib/datetime';
import { EnPreparacion } from '../../EnPreparacion';
import { Recibir } from './Recibir';

export const metadata: Metadata = { title: 'Stock ERP · Recepción' };
export const dynamic = 'force-dynamic';

/**
 * La vista previa de una recepción, y su confirmación.
 *
 * **Abrir esta pantalla no escribe nada.** Ni una marca de visto, ni un
 * contador, ni una reserva. Dos personas pueden mirarla al mismo tiempo y ven
 * lo mismo, y ninguna de las dos cambió nada por haber mirado.
 *
 * La fecha de recepción no viene cargada con la del comprobante: se propone
 * «ahora», que es lo que suele ser verdad cuando alguien está descargando el
 * camión. La del papel se muestra al lado, como dato, y nunca se copia sola.
 */
export default async function Page({ params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const user = await requireUserOrRedirect();

  if (!hasPermission(user, PERMISSIONS.STOCKERP_VER)) {
    return (
      <main className="contenido">
        <p className="mensaje mensaje-error">
          Tu usuario no puede ver Stock ERP. El permiso «stockerp.ver» se pide desde Configuración →
          Roles.
        </p>
      </main>
    );
  }

  const previa = await vistaPreviaDeRecepcion(user, { documentId });
  const interruptor = await interruptorDeRecepcionesReales();

  return (
    <main className="contenido">
      <EnPreparacion>
        Recibir una compra suma mercadería al libro; todavía nada la descuenta.
      </EnPreparacion>

      <p className="chico">
        <Link href="/stock-erp/recepciones">← Recepciones</Link>
      </p>
      <h1 style={{ overflowWrap: 'anywhere' }}>
        {previa.proveedor} · {previa.numero}
      </h1>

      <Recibir
        previa={previa}
        puedePreparar={hasPermission(user, PERMISSIONS.STOCKERP_RECEPCION_PREPARAR)}
        puedeConfirmar={hasPermission(user, PERMISSIONS.STOCKERP_RECEPCION_CONFIRMAR)}
        puedeExcepcion={hasPermission(user, PERMISSIONS.STOCKERP_EXCEPCION_HISTORICA)}
        interruptorEncendido={interruptor.encendido}
        /*
         * Se PROPONE «ahora», calculado en el servidor. Nunca la fecha del
         * comprobante: una factura de agosto recibida en septiembre entraría en
         * el mes equivocado, y quien mira el campo ya cargado no lo revisa.
         */
        fechaPropuesta={arTodayISO()}
        horaPropuesta={horaArgentinaISO()}
      />
    </main>
  );
}
