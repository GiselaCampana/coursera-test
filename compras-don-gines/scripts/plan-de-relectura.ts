/**
 * Escribe el plan de relectura focalizada de cada comprobante.
 *
 * El plan lo decide el motor, no este archivo: se corre la primera
 * reconstrucción sobre la evidencia ya capturada y se le pregunta **qué celdas
 * frenan el comprobante, dónde deberían estar y qué tipo de dato esperan**.
 * Eso se guarda como `plan-de-relectura.json` para que
 * `scripts/capturar-relectura.mjs` —que sí toca imágenes— no tenga que
 * duplicar ninguna decisión.
 *
 * La separación existe porque la lógica de qué releer es la parte que se
 * prueba, y vive en `src/lib/ocr/reconstruccion/relectura.ts`.
 *
 *   npx tsx scripts/plan-de-relectura.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  interpretarReconstruccion,
  renglonesQueNoCierran,
} from '@/lib/ocr/motor/desde-reconstruccion';
import type { EvidenciaDeLectura } from '@/lib/ocr/reconstruccion/evidencia';
import {
  celdasParaReleer,
  convieneReleer,
  variantesDeRelectura,
  zonasDeRelectura,
} from '@/lib/ocr/reconstruccion/relectura';

const DIRECTORIO = path.resolve(process.cwd(), 'tests/fixtures/evidencia');
const CUIT_DEL_RECEPTOR = '27-33342291-9';

const COMPROBANTES = [
  'errecalde',
  'mabelherdi',
  'ezra',
  'barraza',
  'los-calvos-212356',
  'los-calvos-213103',
];

function leer(nombre: string): EvidenciaDeLectura {
  return JSON.parse(readFileSync(path.join(DIRECTORIO, `${nombre}.json`), 'utf8'));
}

const plan: Record<string, unknown[]> = {};

for (const nombre of COMPROBANTES) {
  const informe = interpretarReconstruccion(leer(nombre), { cuitDelReceptor: CUIT_DEL_RECEPTOR });
  const celdas = celdasParaReleer(
    informe.tabla,
    informe.pendientes,
    renglonesQueNoCierran(informe),
  );

  if (!convieneReleer(celdas)) {
    plan[nombre] = [];
    console.log(`${nombre}: nada que releer (${informe.veredicto.decision})`);
    continue;
  }

  const zonas = zonasDeRelectura(celdas);
  plan[nombre] = zonas.map((zona) => ({
    ...zona,
    variantes: variantesDeRelectura(zona.tipo),
  }));

  console.log(
    `${nombre}: ${celdas.length} celdas bloqueadas → ${zonas.length} bandas ` +
      `(${zonas.map((z) => `${z.columna}×${z.celdas}`).join(', ')})`,
  );
}

const destino = path.join(DIRECTORIO, 'plan-de-relectura.json');
writeFileSync(destino, `${JSON.stringify(plan, null, 1)}\n`);
console.log(`→ ${path.relative(process.cwd(), destino)}`);
