import type { Metadata } from 'next';
import Link from 'next/link';
import { requireUserOrRedirect, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { verApertura } from '@/lib/services/stock-erp-apertura';
import { Conteo } from './Conteo';

export const metadata: Metadata = { title: 'Stock ERP · Apertura' };
export const dynamic = 'force-dynamic';

/**
 * Preparación, conteo y confirmación de una apertura.
 *
 * El permiso no se comprueba acá sino en el servicio, que es lo que corre
 * aunque alguien llegue por otra puerta. Lo que la pantalla sí decide es qué
 * botones mostrar, para no ofrecer una acción que va a terminar en un error.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUserOrRedirect();
  const apertura = await verApertura(user, id);

  return (
    <main className="contenido">
      <p className="mensaje mensaje-aviso" data-prueba="stock-erp-en-preparacion">
        <strong>Stock ERP en preparación</strong> — todavía no incluye ventas ni representa
        existencias operativas fuera de esta apertura.
      </p>

      <p className="chico">
        <Link href="/stock-erp/aperturas">← Aperturas</Link>
      </p>
      <h1>Apertura de {apertura.sucursal}</h1>

      <Conteo
        apertura={apertura}
        puedeContar={hasPermission(user, PERMISSIONS.STOCKERP_APERTURA_PREPARAR)}
        puedeHabilitar={hasPermission(user, PERMISSIONS.STOCKERP_ACTIVACION_HABILITAR)}
        puedeConfirmar={hasPermission(user, PERMISSIONS.STOCKERP_APERTURA_CONFIRMAR)}
      />
    </main>
  );
}
