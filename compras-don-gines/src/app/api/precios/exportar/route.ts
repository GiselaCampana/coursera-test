import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import { handle } from '@/lib/api';
import { arTodayISO } from '@/lib/datetime';
import {
  getPriceExportRows,
  priceRowsToPdf,
  priceRowsToXlsx,
} from '@/lib/services/price-exports';

export async function GET(request: Request) {
  return handle(async () => {
    const user = await requireUser();
    const params = new URL(request.url).searchParams;
    const format = params.get('formato') === 'xlsx' ? 'xlsx' : 'pdf';
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

    const file = priceRowsToPdf(rows, { category, supplier });
    return new NextResponse(new Uint8Array(file), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${base}.pdf"`,
        'Cache-Control': 'no-store',
      },
    }) as unknown as NextResponse<never>;
  });
}
