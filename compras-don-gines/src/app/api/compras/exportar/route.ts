import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import { getPurchaseReport, purchaseReportToCsv } from '@/lib/services/reports';
import { arTodayISO } from '@/lib/datetime';
import { handle } from '@/lib/api';

/** Exporta el historial de compras filtrado a CSV, listo para abrir en Excel. */
export async function GET(request: Request) {
  return handle(async () => {
    const user = await requireUser();
    const params = new URL(request.url).searchParams;

    const reporte = await getPurchaseReport(
      user,
      {
        productId: params.get('producto'),
        familyId: params.get('familia'),
        supplierId: params.get('proveedor'),
        branchId: params.get('sucursal'),
        from: params.get('desde'),
        to: params.get('hasta'),
        search: params.get('buscar'),
      },
      5000,
    );

    const csv = purchaseReportToCsv(reporte);
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="compras-don-gines-${arTodayISO()}.csv"`,
        'Cache-Control': 'no-store',
      },
    }) as NextResponse<never>;
  });
}
