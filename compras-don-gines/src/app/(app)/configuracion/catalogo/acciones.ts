'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/session';
import { toUserMessage } from '@/lib/errors';
import {
  importarCatalogo,
  type InformeDeCatalogo,
  type OrigenDeFamilia,
} from '@/lib/services/catalogo';

export interface ResultadoImportacion {
  informe?: InformeDeCatalogo;
  /** El archivo leído, para poder aplicarlo después sin volver a subirlo. */
  texto?: string;
  /** De qué columna se propuso la familia, para aplicar lo mismo que se miró. */
  familiaDesde?: OrigenDeFamilia;
  error?: string;
}

const ORIGENES: OrigenDeFamilia[] = ['auto', 'tipo', 'subtipo', 'ninguna'];

const STOCK_CATALOG_URL =
  'https://control-stock-don-gines.gisela-campana.chatgpt.site/api/integrations/catalog';

async function leerCatalogoDeStock(): Promise<string> {
  const respuesta = await fetch(STOCK_CATALOG_URL, {
    cache: 'no-store',
    headers: { accept: 'application/json' },
  });
  if (!respuesta.ok) {
    throw new Error(
      `Control de Stock respondió ${respuesta.status}. Probá de nuevo en unos segundos.`,
    );
  }
  const texto = await respuesta.text();
  if (!texto.trim()) throw new Error('Control de Stock devolvió un catálogo vacío.');
  return texto;
}

function leerOrigen(valor: FormDataEntryValue | null): OrigenDeFamilia {
  const v = String(valor ?? 'auto') as OrigenDeFamilia;
  return ORIGENES.includes(v) ? v : 'auto';
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
  let texto = String(formData.get('texto') ?? '');
  const familiaDesde = leerOrigen(formData.get('familiaDesde'));
  const origen = String(formData.get('origen') ?? 'archivo');

  try {
    if (origen === 'stock') {
      texto = await leerCatalogoDeStock();
    } else if (texto.trim() === '') {
      return { error: 'Elegí el archivo del catálogo, pegá su contenido o traelo desde Control de Stock.' };
    }

    const user = await requireUser();
    const informe = await importarCatalogo(user, texto, { familiaDesde });
    return { informe, texto, familiaDesde };
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
  /*
   * Se aplica con el mismo origen de familia con el que se hizo la vista
   * previa. Si acá se recalculara con otro, lo que se escribe no sería lo que
   * la persona miró y confirmó.
   */
  const familiaDesde = leerOrigen(formData.get('familiaDesde'));
  let informe: InformeDeCatalogo;
  try {
    const user = await requireUser();
    informe = await importarCatalogo(user, texto, { aplicar: true, familiaDesde });
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
    fam: String(informe.familiasNuevas.length),
  });
  redirect(`/configuracion/catalogo?${params.toString()}`);
}
