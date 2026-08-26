'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/session';
import { toUserMessage } from '@/lib/errors';
import { importarCatalogo, type InformeDeCatalogo } from '@/lib/services/catalogo';

export interface ResultadoImportacion {
  informe?: InformeDeCatalogo;
  /** El archivo leído, para poder aplicarlo después sin volver a subirlo. */
  texto?: string;
  error?: string;
}

/**
 * Paso 1: mirar el archivo sin escribir nada.
 *
 * Lo que devuelve es exactamente lo que el paso 2 va a hacer, calculado con el
 * mismo recorrido. Una vista previa que estima por su cuenta es una vista
 * previa que puede mentir.
 */
export async function analizarCatalogo(
  _prev: ResultadoImportacion,
  formData: FormData,
): Promise<ResultadoImportacion> {
  const texto = String(formData.get('texto') ?? '');
  if (texto.trim() === '') {
    return { error: 'Elegí el archivo del catálogo o pegá su contenido.' };
  }
  try {
    const user = await requireUser();
    const informe = await importarCatalogo(user, texto);
    return { informe, texto };
  } catch (error) {
    return { error: toUserMessage(error) };
  }
}

/** Paso 2: aplicarlo, con la confirmación ya dada. */
export async function aplicarCatalogo(
  _prev: ResultadoImportacion,
  formData: FormData,
): Promise<ResultadoImportacion> {
  const texto = String(formData.get('texto') ?? '');
  let informe: InformeDeCatalogo;
  try {
    const user = await requireUser();
    informe = await importarCatalogo(user, texto, { aplicar: true });
    revalidatePath('/configuracion/catalogo');
    revalidatePath('/configuracion/productos');
    // El catálogo cambia lo que se puede filtrar en Compras y lo que Precios
    // tiene para mostrar.
    revalidatePath('/compras');
    revalidatePath('/precios');
  } catch (error) {
    return { error: toUserMessage(error) };
  }

  // Fuera del try: `redirect` funciona lanzando.
  const params = new URLSearchParams({
    importado: '1',
    nuevos: String(informe.nuevos.length),
    act: String(informe.actualizables.length),
    cod: String(informe.codigosPorAprender.length),
    conf: String(informe.conflictos.length),
  });
  redirect(`/configuracion/catalogo?${params.toString()}`);
}
