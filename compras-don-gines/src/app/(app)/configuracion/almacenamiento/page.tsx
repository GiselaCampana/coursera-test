import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireUserOrRedirect, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { estadoAlmacenamiento, formatearBytes } from '@/lib/services/almacenamiento';
import { resumenParaArchivar } from '@/lib/services/archivado';
import { arTodayISO } from '@/lib/datetime';
import { PanelAlmacenamiento } from './PanelAlmacenamiento';

export const metadata: Metadata = { title: 'Almacenamiento' };
export const dynamic = 'force-dynamic';

/** Por defecto se ofrece archivar lo anterior a un año. */
function haceUnAnoISO(): string {
  const hoy = new Date(`${arTodayISO()}T00:00:00`);
  hoy.setFullYear(hoy.getFullYear() - 1);
  return hoy.toISOString().slice(0, 10);
}

export default async function PaginaAlmacenamiento() {
  const user = await requireUserOrRedirect();
  if (!hasPermission(user, PERMISSIONS.ALMACENAMIENTO_GESTIONAR)) redirect('/configuracion');

  const corte = haceUnAnoISO();
  const [estado, resumen] = await Promise.all([
    estadoAlmacenamiento(),
    resumenParaArchivar(user, new Date(`${corte}T00:00:00`)),
  ]);

  return (
    <PanelAlmacenamiento
      estado={{
        ...estado,
        usadoLegible: formatearBytes(estado.usadoBytes),
        limiteLegible: formatearBytes(estado.limiteBytes),
        liberableLegible: formatearBytes(estado.bytesLiberables),
      }}
      resumenInicial={resumen}
      corteInicial={corte}
      hoy={arTodayISO()}
    />
  );
}
