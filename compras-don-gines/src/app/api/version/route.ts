import { NextResponse } from 'next/server';
import { versionEnEjecucion } from '@/lib/version';

export const dynamic = 'force-dynamic';

/**
 * Qué versión está corriendo. Sin sesión a propósito.
 *
 * Es el equivalente a mirar la chapa del motor: sirve para contestar "¿está
 * desplegado lo último?" desde el teléfono, desde un `curl` o desde un panel,
 * sin tener que entrar a la aplicación. No expone nada privado —un SHA de commit
 * de un repositorio propio no es un secreto— y el plan gratuito de Render, que
 * no da consola, hace que sea la única forma de averiguarlo desde afuera.
 */
export async function GET() {
  const version = versionEnEjecucion();
  return NextResponse.json(
    {
      commit: version.commit,
      commitCorto: version.commitCorto,
      rama: version.rama,
      iniciado: version.iniciado,
      origen: version.origen,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
