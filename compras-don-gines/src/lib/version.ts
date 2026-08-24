import 'server-only';
import { execFileSync } from 'node:child_process';

/**
 * Qué versión del código está corriendo.
 *
 * Existe por una razón concreta: cuando la aplicación en producción devuelve un
 * resultado que en las pruebas no se reproduce, la primera pregunta —y la más
 * difícil de contestar desde un teléfono— es si lo que está corriendo es la
 * versión que uno cree. El plan gratuito de Render no da consola, así que la
 * respuesta tiene que estar en la pantalla.
 *
 * Se arma de tres fuentes, en orden:
 *
 *  1. Las variables que Render define solo en cada despliegue
 *     (`RENDER_GIT_COMMIT`, `RENDER_GIT_BRANCH`). Son las que valen en
 *     producción: las pone la plataforma con el commit que efectivamente
 *     desplegó, no el código.
 *  2. `APP_COMMIT` / `APP_BRANCH`, por si se despliega en otro lado.
 *  3. `git` en la máquina, para el desarrollo local.
 *
 * Si ninguna contesta, dice "desconocido". Nunca inventa un número: un SHA
 * equivocado es peor que no tener ninguno, porque haría descartar la hipótesis
 * correcta.
 */
export interface VersionEnEjecucion {
  /** SHA completo, o null si no se pudo averiguar. */
  commit: string | null;
  /** Los primeros 7 caracteres, que es con lo que se habla. */
  commitCorto: string;
  rama: string | null;
  /** Cuándo arrancó este proceso, en ISO. */
  iniciado: string;
  /** Cómo se averiguó, para saber cuánto confiar en el dato. */
  origen: 'render' | 'entorno' | 'git' | 'desconocido';
}

const DESCONOCIDO = 'desconocido';

function desdeGit(): { commit: string; rama: string | null } | null {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) return null;
    let rama: string | null = null;
    try {
      rama =
        execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || null;
    } catch {
      rama = null;
    }
    return { commit, rama };
  } catch {
    // Sin git, o sin repositorio: es lo normal en un contenedor de producción.
    return null;
  }
}

/*
 * Se resuelve una sola vez por proceso.
 *
 * El commit no cambia mientras el proceso vive —un despliegue nuevo es un
 * proceso nuevo—, así que no hace falta volver a preguntar, y menos correr
 * `git` en cada pedido.
 */
let cacheada: VersionEnEjecucion | null = null;

export function versionEnEjecucion(): VersionEnEjecucion {
  if (cacheada) return cacheada;

  const iniciado = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();

  const render = process.env.RENDER_GIT_COMMIT?.trim();
  const propio = process.env.APP_COMMIT?.trim();
  const delGit = render || propio ? null : desdeGit();

  const commit = render || propio || delGit?.commit || null;
  const rama =
    (render ? process.env.RENDER_GIT_BRANCH?.trim() : undefined) ||
    process.env.APP_BRANCH?.trim() ||
    delGit?.rama ||
    null;

  const origen: VersionEnEjecucion['origen'] = render
    ? 'render'
    : propio
      ? 'entorno'
      : delGit
        ? 'git'
        : 'desconocido';

  cacheada = {
    commit,
    commitCorto: commit ? commit.slice(0, 7) : DESCONOCIDO,
    rama: rama || null,
    iniciado,
    origen,
  };
  return cacheada;
}

/** Sólo para las pruebas: obliga a volver a resolver la versión. */
export function olvidarVersion(): void {
  cacheada = null;
}
