import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import { handle } from '@/lib/api';
import { arTodayISO } from '@/lib/datetime';
import {
  getPriceExportRows,
  priceRowsToEmployeePdf,
  priceRowsToManagementPdf,
  priceRowsToXlsx,
} from '@/lib/services/price-exports';

export async function GET(request: Request) {
  return handle(async () => {
    const user = await requireUser();
    const params = new URL(request.url).searchParams;
    const format = params.get('formato') === 'xlsx' ? 'xlsx' : 'pdf';
    const view = params.get('vista') === 'empleados' ? 'empleados' : 'gestion';
    const category = params.get('tipo') || null;
    const supplier = params.get('proveedor') || null;

    const rows = await getPriceExportRows(user, { category, supplier });
    const base = `precios-costos-don-gines-${arTodayISO()}`;

    if (format === 'xlsx') {
      const file = await priceRowsToXlsx(rows);
      return new NextResponse(new Uint8Array(file), {
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${base}.xlsx"`,
          'Cache-Control': 'no-store',
        },
      }) as unknown as NextResponse<never>;
    }

    const file = view === 'empleados'
      ? priceRowsToEmployeePdf(rows, { category, supplier })
      : priceRowsToManagementPdf(rows, { category, supplier });
    const suffix = view === 'empleados' ? '-empleados' : '-gestion';
    return new NextResponse(new Uint8Array(file), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${base}${suffix}.pdf"`,
        'Cache-Control': 'no-store',
      },
    }) as unknown as NextResponse<never>;
  });
}
