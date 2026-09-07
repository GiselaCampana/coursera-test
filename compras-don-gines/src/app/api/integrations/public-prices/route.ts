import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import {
  CatalogoDemasiadoGrande,
  construirCatalogoPublico,
  dentroDelLimiteDeFrecuencia,
  esSucursalPublica,
  SUCURSALES_PUBLICAS,
  type ArticuloPublico,
} from '@/lib/services/precios-publicos';

/**
 * El catálogo de precios que consume el backend de Pedidos Don Ginés.
 *
 * Es la única puerta de Compras que da hacia afuera, así que las reglas son más
 * duras que en el resto de la aplicación:
 *
 *  - **La clave nunca aparece.** Ni en la respuesta, ni en un error, ni en un
 *    log, ni en la URL. Los tres errores de autenticación —sin encabezado, con
 *    un esquema que no es Bearer, y con la clave equivocada— contestan lo mismo
 *    y con el mismo código, para no darle a quien prueba una forma de descubrir
 *    en qué se está equivocando.
 *  - **Sin la variable configurada, el endpoint está cerrado.** No abierto ni
 *    con una clave por defecto: cerrado, con el mismo 401 que todo lo demás.
 *  - **Sólo lee.** No escribe un producto, ni un precio, ni una fecha de
 *    sincronización, ni una auditoría. Una consulta no puede cambiar nada.
 *  - **Nunca entrega el catálogo a medias.** Si algo no se puede cumplir se
 *    falla; recortar la lista en silencio le mostraría al cliente media
 *    fiambrería sin que nadie se entere.
 *
 * Corre en Node y no en el edge: necesita Prisma y la comparación de tiempo
 * constante de `node:crypto`.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** El nombre de la variable. El valor sólo vive en el panel de Render. */
const NOMBRE_CLAVE = 'PRICES_INTEGRATION_KEY';



/**
 * Una sola respuesta para todo lo que sea «no pasás».
 *
 * Distinguir «falta el encabezado» de «la clave es incorrecta» le dice a quien
 * prueba si va por buen camino. Y distinguir «no está configurada la variable»
 * le dice algo sobre el despliegue. Las tres cosas son la misma puerta cerrada.
 */
function noAutorizado(): NextResponse {
  return conEncabezados(
    NextResponse.json({ ok: false, error: 'No autorizado' }, { status: 401 }),
  );
}

/** Cache-Control y nosniff en toda respuesta, incluidas las de error. */
function conEncabezados(respuesta: NextResponse): NextResponse {
  respuesta.headers.set('Cache-Control', 'no-store');
  respuesta.headers.set('X-Content-Type-Options', 'nosniff');
  return respuesta;
}

/**
 * Compara la credencial sin filtrar información por el tiempo que tarda.
 *
 * Una comparación normal corta en el primer carácter distinto, y el tiempo que
 * tarda dice cuántos caracteres se acertaron. `timingSafeEqual` exige los dos
 * buffers del mismo largo, así que la diferencia de largo se resuelve antes; eso
 * revela el largo de la clave, que no es un secreto útil.
 */
function credencialValida(recibida: string, esperada: string): boolean {
  const a = Buffer.from(recibida, 'utf8');
  const b = Buffer.from(esperada, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Autoriza el pedido, o no.
 *
 * Se exige el esquema exacto: `Authorization: Bearer <clave>`. Un `Basic`, un
 * `bearer` sin espacio o la clave sola no alcanzan. Del lado de Render se
 * guarda solamente la clave, **sin** el «Bearer »: el esquema lo pone quien
 * llama, y la variable guarda una credencial, no un encabezado armado.
 */
function autorizado(request: Request): boolean {
  const esperada = process.env[NOMBRE_CLAVE];
  if (!esperada || esperada.trim() === '') return false;

  const encabezado = request.headers.get('authorization');
  if (!encabezado) return false;

  const partes = /^Bearer (\S.*)$/.exec(encabezado);
  if (!partes) return false;

  return credencialValida(partes[1], esperada.trim());
}

export async function GET(request: Request) {
  if (!autorizado(request)) return noAutorizado();

  /*
   * El tope de frecuencia va después de la clave, no antes.
   *
   * Contando también los pedidos sin credencial, cualquiera podría gastar la
   * cuota desde afuera y dejar a Pedidos sin catálogo: el límite protege al
   * servicio de un cliente descuidado, no lo convierte en algo que un extraño
   * pueda apagar.
   */
  if (!dentroDelLimiteDeFrecuencia()) {
    return conEncabezados(
      NextResponse.json({ ok: false, error: 'Demasiadas consultas' }, { status: 429 }),
    );
  }

  /*
   * La sucursal se exige y se valida contra la lista, incluida su ausencia.
   *
   * Hoy las tres cobran lo mismo y las tres reciben el mismo precio; lo que no
   * se hace es inventar una diferencia que no existe, ni dejar pasar un nombre
   * que no reconocemos como si fuera una de las tres.
   */
  const branch = new URL(request.url).searchParams.get('branch');
  if (!esSucursalPublica(branch)) {
    return conEncabezados(
      NextResponse.json(
        {
          ok: false,
          error: `La sucursal tiene que ser una de: ${SUCURSALES_PUBLICAS.join(', ')}.`,
        },
        { status: 400 },
      ),
    );
  }

  try {
    const { items } = await construirCatalogoPublico();

    /*
     * El contrato se revisa antes de contestar, no se confía en el tipo.
     *
     * El tipo lo revisa el compilador y el compilador no está corriendo acá: si
     * mañana alguien arma un artículo con un campo de más, TypeScript lo
     * atajaría en el editor pero un `as` o un `JSON.parse` en el medio no. Esta
     * verificación corre siempre, y ante la duda no publica.
     */
    for (const item of items) {
      if (!contratoValido(item)) {
        return conEncabezados(
          NextResponse.json(
            { ok: false, error: 'El catálogo no se pudo preparar' },
            { status: 500 },
          ),
        );
      }
    }

    return conEncabezados(
      NextResponse.json({
        ok: true,
        schemaVersion: '1.0',
        generatedAt: new Date().toISOString(),
        items,
      }),
    );
  } catch (error) {
    if (error instanceof CatalogoDemasiadoGrande) {
      // Se falla entero. Nunca se contesta con la lista recortada.
      console.error('[public-prices] el catálogo supera el límite publicable');
      return conEncabezados(
        NextResponse.json(
          { ok: false, error: 'El catálogo no se pudo preparar' },
          { status: 503 },
        ),
      );
    }
    /*
     * Nada de lo que traiga el error sale en la respuesta.
     *
     * Un error de Prisma trae la consulta, y la consulta nombra tablas y
     * columnas de Compras. Al registro va el error; al cliente, una frase.
     */
    console.error('[public-prices] error al preparar el catálogo', error);
    return conEncabezados(
      NextResponse.json({ ok: false, error: 'El catálogo no se pudo preparar' }, { status: 500 }),
    );
  }
}

/** Los diez campos del contrato, exactamente: ni uno menos ni uno más. */
const CAMPOS_DEL_CONTRATO = [
  'plu',
  'name',
  'description',
  'category',
  'unit',
  'unitPrice',
  'step',
  'defaultQuantity',
  'image',
  'featured',
] as const;

function contratoValido(item: ArticuloPublico): boolean {
  const claves = Object.keys(item);
  if (claves.length !== CAMPOS_DEL_CONTRATO.length) return false;
  for (const campo of CAMPOS_DEL_CONTRATO) {
    if (!claves.includes(campo)) return false;
  }
  return (
    typeof item.plu === 'string' &&
    item.plu !== '' &&
    typeof item.name === 'string' &&
    typeof item.description === 'string' &&
    (item.category === null || typeof item.category === 'string') &&
    (item.unit === 'kg' || item.unit === 'unidad') &&
    typeof item.unitPrice === 'number' &&
    Number.isFinite(item.unitPrice) &&
    item.unitPrice > 0 &&
    typeof item.step === 'number' &&
    item.step > 0 &&
    typeof item.defaultQuantity === 'number' &&
    item.defaultQuantity > 0 &&
    (item.image === null || typeof item.image === 'string') &&
    typeof item.featured === 'boolean'
  );
}
