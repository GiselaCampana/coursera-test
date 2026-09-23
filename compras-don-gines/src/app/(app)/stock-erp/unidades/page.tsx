import type { Metadata } from 'next';
import { requireUserOrRedirect, hasPermission } from '@/lib/auth/session';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { prisma } from '@/lib/db';
import { listarUnidades } from '@/lib/services/stock-erp-unidades';
import { ListaDeUnidades } from './ListaDeUnidades';

export const metadata: Metadata = { title: 'Stock ERP · Unidades' };
export const dynamic = 'force-dynamic';

/**
 * La pantalla de configuración de unidades.
 *
 * Lo primero que se ve, antes que cualquier dato, es que **Stock ERP no está
 * activado**. No es una formalidad: la pantalla muestra artículos, unidades y
 * factores, y alguien que entre de costado puede creer perfectamente que está
 * mirando existencias. No hay ningún saldo acá, y el aviso lo dice antes de que
 * la duda aparezca.
 */
export default async function Page() {
  const user = await requireUserOrRedirect();
  /*
   * El permiso no se comprueba acá: lo exige `listarUnidades`, que es lo que
   * corre aunque alguien llegue por otra puerta. Duplicar la comprobación en la
   * pantalla daría dos lugares donde equivocarse y uno solo que protege.
   */
  const items = await listarUnidades(user, { limite: 300 });
  const proveedores = (
    await prisma.supplier.findMany({ select: { id: true, tradeName: true }, orderBy: { tradeName: 'asc' } })
  ).map((s) => ({ id: s.id, nombre: s.tradeName }));

  const pendientes = items.filter((i) => i.estado === 'PENDIENTE').length;
  const discrepancias = items.filter((i) => i.discrepancia).length;

  return (
    <main className="contenido">
      <p className="mensaje mensaje-aviso" data-prueba="stock-erp-en-preparacion">
        <strong>Stock ERP en preparación</strong> — todavía no incluye ventas ni representa
        existencias operativas. Acá sólo se decide en qué unidad se va a contar cada artículo el día
        que el módulo empiece a moverlas. No hay saldos.
      </p>

      <h1>Configuración de unidades</h1>
      <p className="chico">
        Control de Stock Don Ginés sigue siendo una aplicación aparte y la fuente del catálogo. Esta
        pantalla no le manda nada ni modifica sus existencias.
      </p>

      <p className="chico" data-prueba="resumen">
        {pendientes} pendientes · {discrepancias} con diferencia de unidad · {items.length} artículos
      </p>

      <ListaDeUnidades
        items={items}
        proveedores={proveedores}
        puedeConfigurar={hasPermission(user, PERMISSIONS.STOCKERP_UNIDADES_CONFIGURAR)}
      />
    </main>
  );
}
