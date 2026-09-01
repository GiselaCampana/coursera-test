import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { handle } from '@/lib/api';
import { toISODate } from '@/lib/datetime';
import { creditoAplicadoA } from '@/lib/services/notas-credito';

/**
 * Las facturas confirmadas del proveedor, para relacionarles una nota de
 * crédito.
 *
 * Trae también cuánto crédito tiene aplicada cada una: elegir la factura a la
 * que la nota corresponde es una decisión que se toma mejor viendo si ya tiene
 * otra nota encima, sobre todo cuando llegan de a varias a fin de mes.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    await requireUser();
    const { id } = await params;

    const facturas = await prisma.document.findMany({
      where: { supplierId: id, status: 'VALIDADO', docType: { in: ['FACTURA', 'REMITO'] } },
      orderBy: [{ issueDate: 'desc' }],
      take: 50,
      select: { id: true, fullNumber: true, issueDate: true, total: true, docType: true },
    });
    const creditos = await creditoAplicadoA(facturas.map((f) => f.id));

    return NextResponse.json({
      facturas: facturas.map((f) => ({
        id: f.id,
        numero: f.fullNumber || 'sin número',
        tipo: f.docType,
        fecha: f.issueDate ? toISODate(f.issueDate) : null,
        total: f.total?.toString() ?? '0',
        creditoAplicado: (creditos.get(f.id) ?? '0').toString(),
      })),
    });
  });
}
