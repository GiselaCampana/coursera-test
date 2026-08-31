import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/session';
import { handle, readJson } from '@/lib/api';
import { crearProveedorDesdeLectura } from '@/lib/services/suppliers';

interface AltaRapida {
  nombre: string;
  razonSocial?: string | null;
  cuit?: string | null;
}

/**
 * Alta mínima de proveedor desde la revisión de una factura suya.
 *
 * Deja la ficha con lo que se puede leer del papel: nombre, razón social y
 * CUIT. Las condiciones de pago y las tasas se cargan después en
 * Configuración → Proveedores; mientras no estén, el comprobante se revisa
 * igual y la fecha prevista de pago queda para completar a mano.
 *
 * Si el CUIT ya está cargado devuelve el proveedor que existe con `creado` en
 * falso, en vez de crear una segunda ficha del mismo negocio.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const user = await requireUser();
    const input = await readJson<AltaRapida>(request);
    const proveedor = await crearProveedorDesdeLectura(user, {
      nombre: String(input.nombre ?? ''),
      razonSocial: input.razonSocial ?? null,
      cuit: input.cuit ?? null,
    });
    return NextResponse.json(proveedor);
  });
}
