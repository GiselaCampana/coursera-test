'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/session';
import { toUserMessage } from '@/lib/errors';
import {
  guardarMarcajesDeFamilia,
  guardarReglaGeneralDeMarcajes,
  importarCatalogo,
  type InformeDeCatalogo,
  type OrigenDeFamilia,
} from '@/lib/services/catalogo';
import {
  RespuestaDeStockInvalida,
  aplicarSincronizacionDeStock,
  vistaPreviaDeStock,
  type VistaPreviaDeSincronizacion,
} from '@/lib/services/stock-sync';

export interface ResultadoImportacion {
  informe?: InformeDeCatalogo;
  /** El archivo leído, para poder aplicarlo después sin volver a subirlo. */
  texto?: string;
  /** De qué columna se propuso la familia, para aplicar lo mismo que se miró. */
  familiaDesde?: OrigenDeFamilia;
  error?: string;
}

const ORIGENES: OrigenDeFamilia[] = ['auto', 'tipo', 'subtipo', 'ninguna'];

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
  const texto = String(formData.get('texto') ?? '');
  const familiaDesde = leerOrigen(formData.get('familiaDesde'));

  try {
    /*
     * Sólo archivos.
     *
     * Traer el catálogo desde Control de Stock ya no pasa por acá: tiene su
     * propia sincronización, que valida la respuesta antes de mirarla y aplica
     * en una transacción. Dejar los dos caminos entrando al mismo importador
     * era tener dos ideas distintas de qué significa "el catálogo cambió".
     */
    if (texto.trim() === '') {
      return { error: 'Elegí el archivo del catálogo o pegá su contenido.' };
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

export interface ResultadoDeSincronizacion {
  vista?: VistaPreviaDeSincronizacion;
  /** Motivos por los que la respuesta de Control de Stock no se pudo usar. */
  motivos?: string[];
  error?: string;
  /** True cuando lo que se muestra ya se aplicó. */
  aplicada?: boolean;
}

/** Traduce lo que salió mal a algo que se pueda leer en la pantalla. */
function comoResultado(error: unknown): ResultadoDeSincronizacion {
  if (error instanceof RespuestaDeStockInvalida) return { motivos: error.motivos };
  return { error: toUserMessage(error) };
}

/**
 * Paso 1: mirar sin escribir.
 *
 * La descarga y la validación ocurren del lado del servidor. En el navegador
 * eso no funcionaba: Safari bloquea el pedido entre dominios y en el iPhone la
 * sincronización no arrancaba nunca.
 */
export async function verSincronizacionDeStock(
  _prev: ResultadoDeSincronizacion,
  _formData: FormData,
): Promise<ResultadoDeSincronizacion> {
  try {
    const user = await requireUser();
    return { vista: await vistaPreviaDeStock(user) };
  } catch (error) {
    return comoResultado(error);
  }
}

/**
 * Paso 2: aplicar, con la confirmación ya dada.
 *
 * Se vuelve a descargar y a validar. Confirmar con lo que quedó guardado de la
 * vista previa sería aplicar una foto vieja del catálogo maestro; el resultado
 * que se devuelve es lo que de verdad se escribió.
 */
export async function aplicarSincronizacionDeStockAccion(
  _prev: ResultadoDeSincronizacion,
  _formData: FormData,
): Promise<ResultadoDeSincronizacion> {
  try {
    const user = await requireUser();
    const vista = await aplicarSincronizacionDeStock(user);
    revalidatePath('/configuracion/catalogo');
    revalidatePath('/configuracion/productos');
    revalidatePath('/compras');
    revalidatePath('/precios');
    return { vista, aplicada: true };
  } catch (error) {
    return comoResultado(error);
  }
}

export interface ResultadoMarcajesDeFamilia {
  ok?: boolean;
  error?: string;
  familyId?: string;
}

/**
 * Guarda los marcajes de una familia.
 *
 * Cada campo vacío se guarda vacío: quiere decir "esta familia no dice nada" y
 * deja que cada artículo resuelva por su cuenta. No es lo mismo que un cero.
 */
export async function guardarMarcajesFamilia(
  _prev: ResultadoMarcajesDeFamilia,
  formData: FormData,
): Promise<ResultadoMarcajesDeFamilia> {
  const familyId = String(formData.get('familyId') ?? '');
  try {
    const user = await requireUser();
    await guardarMarcajesDeFamilia(user, familyId, marcajesDelFormulario(formData));
    revalidatePath('/configuracion/catalogo');
    revalidatePath('/configuracion/productos');
    revalidatePath('/precios');
    return { ok: true, familyId };
  } catch (error) {
    return { error: toUserMessage(error), familyId };
  }
}

export interface ResultadoReglaGeneral {
  ok?: boolean;
  error?: string;
}

/**
 * Guarda la regla general: el tercer nivel de la cadena.
 *
 * Vale lo mismo que para la familia: vacío se guarda vacío. Un campo en blanco
 * acá quiere decir que ese marcaje no lo decide nadie, y el resolvedor lo dice
 * así en pantalla en vez de inventar un número.
 */
export async function guardarReglaGeneral(
  _prev: ResultadoReglaGeneral,
  formData: FormData,
): Promise<ResultadoReglaGeneral> {
  try {
    const user = await requireUser();
    await guardarReglaGeneralDeMarcajes(user, marcajesDelFormulario(formData));
    revalidatePath('/configuracion/catalogo');
    revalidatePath('/configuracion/productos');
    revalidatePath('/precios');
    return { ok: true };
  } catch (error) {
    return { error: toUserMessage(error) };
  }
}

/** Los nueve campos del formulario de marcajes. Vacío queda vacío. */
function marcajesDelFormulario(formData: FormData) {
  const campo = (n: string) => String(formData.get(n) ?? '').trim() || null;
  return {
    targetMarginPct: campo('targetMarginPct'),
    marginBasis: (campo('marginBasis') as 'SOBRE_COSTO' | 'SOBRE_VENTA' | null) ?? null,
    alCorteHormaDigitalMarginPct: campo('alCorteHormaDigitalMarginPct'),
    alCorteHormaCashMarginPct: campo('alCorteHormaCashMarginPct'),
    alCorteCajaCashMarginPct: campo('alCorteCajaCashMarginPct'),
    feteado100gMarginPct: campo('feteado100gMarginPct'),
    feteadoQuarterMarginPct: campo('feteadoQuarterMarginPct'),
    feteadoPieceDigitalMarginPct: campo('feteadoPieceDigitalMarginPct'),
    feteadoPieceCashMarginPct: campo('feteadoPieceCashMarginPct'),
    wholeUnitMarginPct: campo('wholeUnitMarginPct'),
  };
}
