/**
 * Las métricas del lote, separando generalización de reproducibilidad.
 *
 * Una foto nueva de un comprobante que **ya se usó para diseñar el motor** no
 * mide generalización: mide si el motor vuelve a leer el mismo papel ante otra
 * toma. Las dos cosas importan y no se promedian, porque mezclarlas infla o
 * desinfla el número según cuántas repeticiones tenga el lote.
 *
 * Qué comprobante es cuál se declara en `validacion/reproducibilidad.json`, con
 * el sha256 de la imagen y contra qué fixture del banco se repite.
 *
 *   npx tsx scripts/metricas-del-lote.ts
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { VERSION_DEL_COMPARADOR, type Comparacion } from '@/lib/ocr/validacion/comparar';
import type { ActaDePrimeraLectura } from '@/lib/ocr/validacion/lectura-ciega';

const RAIZ = process.cwd();
const ACTAS = path.join(RAIZ, 'validacion/ciega');
const COMPARACIONES = path.join(RAIZ, `validacion/comparacion-${VERSION_DEL_COMPARADOR}`);
const REPETIDOS = path.join(RAIZ, 'validacion/reproducibilidad.json');

/** Qué comprobantes del lote son otra foto de algo ya conocido. */
const repetidos: Record<string, string> = existsSync(REPETIDOS)
  ? JSON.parse(readFileSync(REPETIDOS, 'utf8'))
  : {};

interface Fila {
  nombre: string;
  acta: ActaDePrimeraLectura;
  comparacion: Comparacion;
  /** Contra qué fixture del banco se repite, si es una repetición. */
  repiteA: string | null;
}

const filas: Fila[] = [];
for (const archivo of readdirSync(COMPARACIONES).sort()) {
  if (!archivo.endsWith('.json')) continue;
  const nombre = archivo.replace(/\.json$/, '');
  filas.push({
    nombre,
    acta: JSON.parse(readFileSync(path.join(ACTAS, archivo), 'utf8')),
    comparacion: JSON.parse(readFileSync(path.join(COMPARACIONES, archivo), 'utf8')),
    repiteA: repetidos[nombre] ?? null,
  });
}

/** En qué grupo cae cada comprobante, que es lo que decide el hito siguiente. */
function grupoDe(fila: Fila): 'automatica' | 'solo-columnas' | 'asociar' | 'corregir' {
  const { acta, comparacion } = fila;
  if (comparacion.errores > 0) return 'corregir';
  if (acta.decision === 'automatica') return 'automatica';
  if (
    comparacion.celdasPorCorregir === 0 &&
    ((comparacion.productosPorAsociar ?? 0) > 0 || (comparacion.unidadesPorResolver ?? 0) > 0)
  ) {
    return 'asociar';
  }
  if (comparacion.celdasPorCorregir === 0) return 'solo-columnas';
  return 'corregir';
}

function informar(titulo: string, deEste: Fila[]) {
  if (deEste.length === 0) return;
  console.log(`\n########## ${titulo} (${deEste.length} comprobante(s))`);

  const causas: Record<string, number> = {};
  let afirmadosMal = 0;
  let omitidos = 0;
  let textoMal = 0;
  let inventadas = 0;
  let omitidasFilas = 0;

  for (const fila of deEste) {
    const { acta, comparacion: c } = fila;
    for (const [k, v] of Object.entries(c.porCausa)) causas[k] = (causas[k] ?? 0) + v;
    for (const campo of c.campos.filter((x) => x.acierto === false)) {
      if (campo.campo === 'descripcion' || campo.campo === 'codigo') textoMal += 1;
      else if (campo.leido === null) omitidos += 1;
      else afirmadosMal += 1;
    }
    const diferencia = acta.interpretados - c.renglonesEnElPapel;
    if (diferencia > 0) inventadas += diferencia;
    if (diferencia < 0) omitidasFilas += -diferencia;

    console.log(
      `  ${fila.nombre.padEnd(10)} ${grupoDe(fila).padEnd(14)}` +
        ` filas papel ${String(c.renglonesEnElPapel).padStart(2)}` +
        ` interp ${String(acta.interpretados).padStart(2)}` +
        ` | aciertos ${String(c.aciertos).padStart(2)}` +
        ` errores ${String(c.errores).padStart(2)}` +
        ` pedidos ${String(c.pedidos).padStart(3)}` +
        ` | acciones ${String(c.accionesHumanas).padStart(2)}` +
        ` (${c.columnasPorConfirmar} col + ${c.celdasPorCorregir} celdas + ` +
        `${c.productosPorAsociar ?? 0} prod + ${c.unidadesPorResolver ?? 0} unid)` +
        ` | ${acta.decision}`,
    );
  }

  const cuantos = (g: string) => deEste.filter((f) => grupoDe(f) === g).length;
  const pct = (n: number) => `${((n / deEste.length) * 100).toFixed(0)} %`;

  console.log(`\n  filas inventadas ${inventadas} | filas reales omitidas ${omitidasFilas}`);
  console.log(
    `  valores afirmados mal ${afirmadosMal} | omisiones ${omitidos} | texto mal ${textoMal}`,
  );

  /*
   * El pie, en las cinco cuentas que piden trabajos distintos.
   *
   * Un solo número mezcla un concepto asignado mal —que es lo único grave— con
   * un importe que el motor leyó y dijo no saber nombrar, con uno que no está
   * en la foto, con uno que dedujo de una igualdad y con una cuenta ofrecida
   * como ayuda. Sumarlas esconde justamente la diferencia que importa.
   */
  const balance = deEste.map((f) => f.comparacion.balanceFiscal).reduce(
    (acumulado, c) => ({
      asignacionesIncorrectas: acumulado.asignacionesIncorrectas + c.asignacionesIncorrectas,
      importesSinAsignar: acumulado.importesSinAsignar + c.importesSinAsignar,
      conceptosOmitidos: acumulado.conceptosOmitidos + c.conceptosOmitidos,
      conceptosInferidos: acumulado.conceptosInferidos + c.conceptosInferidos,
      sugerenciasDerivadas: acumulado.sugerenciasDerivadas + c.sugerenciasDerivadas,
    }),
    {
      asignacionesIncorrectas: 0,
      importesSinAsignar: 0,
      conceptosOmitidos: 0,
      conceptosInferidos: 0,
      sugerenciasDerivadas: 0,
    },
  );
  console.log(
    `  pie fiscal → asignaciones INCORRECTAS ${balance.asignacionesIncorrectas} | ` +
      `importes sin asignar ${balance.importesSinAsignar} | conceptos omitidos ` +
      `${balance.conceptosOmitidos} | inferidos ${balance.conceptosInferidos} | ` +
      `sugerencias derivadas ${balance.sugerenciasDerivadas}`,
  );
  console.log(`  causas: ${JSON.stringify(causas)}`);
  console.log(`  1. automáticas                        ${pct(cuantos('automatica'))} (${cuantos('automatica')}/${deEste.length})`);
  console.log(`  2. sólo configurar columnas una vez   ${pct(cuantos('solo-columnas'))} (${cuantos('solo-columnas')}/${deEste.length})`);
  console.log(`  3. corregir celdas o refotografiar    ${pct(cuantos('corregir'))} (${cuantos('corregir')}/${deEste.length})`);
}

console.log(`comparador ${VERSION_DEL_COMPARADOR} | motor ${filas[0]?.acta.motor.commit.slice(0, 8) ?? '?'}`);
informar('GENERALIZACIÓN — comprobantes que el motor nunca vio', filas.filter((f) => !f.repiteA));
informar('REPRODUCIBILIDAD — otra foto de un comprobante ya conocido', filas.filter((f) => f.repiteA));
for (const fila of filas.filter((f) => f.repiteA)) {
  console.log(`  ${fila.nombre} repite a «${fila.repiteA}» del banco de diseño`);
}
