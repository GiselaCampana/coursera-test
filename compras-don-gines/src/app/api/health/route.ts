import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Chequeo de salud para la plataforma. Responde 200 y nada más.
 *
 * Deliberadamente **no toca nada**: ni cookies, ni sesión, ni permisos, ni la
 * base, ni el almacenamiento, ni ninguna pantalla. Contesta una sola pregunta,
 * que es la única que un health check tiene que hacer: ¿el proceso está vivo y
 * atendiendo pedidos?
 *
 * Antes el chequeo apuntaba a `/ingresar`, y aunque esa pantalla es pública
 * seguía siendo una pantalla: pasa por el renderizado de React, lee cookies y
 * puede redirigir. Cualquier cambio ahí —un redirect nuevo, una consulta
 * agregada— se convierte sin querer en un requisito para que el despliegue
 * termine, y un despliegue que no arranca por una pantalla es de las cosas más
 * difíciles de diagnosticar.
 *
 * Y tampoco consulta la base a propósito. Si lo hiciera, un rato de Supabase
 * caído no dejaría la aplicación "degradada" sino *reiniciándose en loop*,
 * porque la plataforma mata lo que no pasa el chequeo. Que la base esté sana es
 * otra pregunta, y no se contesta acá.
 */
export async function GET() {
  return NextResponse.json(
    { estado: 'ok' },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
