#!/usr/bin/env node
/**
 * **El resumen de una corrida de pruebas, con las salteadas a la vista.**
 *
 * Existe por una corrección concreta: un informe dijo «Playwright: 352/352 en
 * verde» cuando la corrida había sido de 352 pasadas, 42 salteadas y 0 fallas
 * sobre 394. Ninguna de las dos cifras era falsa, pero «352/352» se lee como
 * «no se salteó nada», y eso sí era falso.
 *
 * El problema no es de redacción: es que **nadie extraía el número**. Cada vez
 * que alguien lee un registro a ojo y escribe el total, puede volver a pasar. Así
 * que acá está el mecanismo: lee el registro de Vitest o de Playwright, saca las
 * tres cifras por separado y **falla** si el registro declara salteadas y el
 * resumen no las pudo nombrar.
 *
 * Uso:
 *   node scripts/resumen-de-pruebas.mjs <archivo-de-registro> [...]
 *
 * Sale con código 1 si alguna corrida tuvo fallas, si no encontró cifras, o si
 * hay salteadas que no se pudieron contar. Un resumen que no puede afirmar
 * cuántas se saltearon no sirve para informar, y por eso no pasa en silencio.
 */
import { readFileSync } from 'node:fs';

/** Quita los códigos de color, que ensucian cualquier expresión regular. */
function limpiar(texto) {
  return texto.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * Vitest imprime «Tests  2063 passed | 6 skipped (2069)».
 * Playwright imprime «42 skipped» y «352 passed (12.9m)» en líneas separadas.
 */
export function leerResumen(textoCrudo) {
  const texto = limpiar(textoCrudo);

  const vitest = /Tests\s+(.+?)\((\d+)\)/g;
  const ultimoVitest = [...texto.matchAll(vitest)].pop();
  if (ultimoVitest) {
    const cuerpo = ultimoVitest[1];
    const total = Number(ultimoVitest[2]);
    const num = (etiqueta) => {
      const m = new RegExp(`(\\d+)\\s+${etiqueta}`).exec(cuerpo);
      return m ? Number(m[1]) : 0;
    };
    return {
      herramienta: 'vitest',
      pasadas: num('passed'),
      salteadas: num('skipped') + num('todo'),
      fallidas: num('failed'),
      total,
    };
  }

  /*
   * Playwright: las cifras están en líneas propias, cerca del final. Se buscan
   * por separado y NO se infiere ninguna: si no dijo «skipped», es 0 porque no
   * hubo, y eso se distingue de «no se pudo leer» —que es cuando no aparece
   * ninguna cifra y la función devuelve null—.
   */
  const buscar = (etiqueta) => {
    const m = new RegExp(`(\\d+)\\s+${etiqueta}\\b`).exec(texto);
    return m ? Number(m[1]) : null;
  };
  const pasadas = buscar('passed');
  const fallidas = buscar('failed');
  const salteadas = buscar('skipped');
  const noCorrieron = buscar('did not run');
  if (pasadas === null && fallidas === null) return null;

  return {
    herramienta: 'playwright',
    pasadas: pasadas ?? 0,
    salteadas: (salteadas ?? 0) + (noCorrieron ?? 0),
    fallidas: fallidas ?? 0,
    total:
      (pasadas ?? 0) + (salteadas ?? 0) + (fallidas ?? 0) + (noCorrieron ?? 0),
  };
}

/**
 * La regla que este archivo existe para hacer cumplir: un resumen tiene que
 * nombrar las tres cifras, y el total tiene que cerrar con su suma. Si no
 * cierra, es que algo quedó sin contar, y lo que queda sin contar suelen ser
 * justamente las salteadas.
 */
export function verificar(resumen) {
  const problemas = [];
  if (resumen === null) {
    problemas.push('no se encontró ninguna cifra de pruebas en el registro');
    return problemas;
  }
  const suma = resumen.pasadas + resumen.salteadas + resumen.fallidas;
  if (resumen.total !== suma) {
    problemas.push(
      `el total declarado (${resumen.total}) no coincide con pasadas + salteadas + fallidas ` +
        `(${resumen.pasadas} + ${resumen.salteadas} + ${resumen.fallidas} = ${suma}): ` +
        'hay pruebas que el resumen no está contando',
    );
  }
  if (resumen.fallidas > 0) {
    problemas.push(`${resumen.fallidas} prueba(s) fallada(s)`);
  }
  return problemas;
}

export function formatear(nombre, resumen) {
  if (resumen === null) return `${nombre.padEnd(34)} (sin cifras)`;
  return (
    `${nombre.padEnd(34)} ${String(resumen.pasadas).padStart(5)} pasadas · ` +
    `${String(resumen.salteadas).padStart(4)} salteadas · ` +
    `${String(resumen.fallidas).padStart(3)} fallidas · ` +
    `${String(resumen.total).padStart(5)} en total (${resumen.herramienta})`
  );
}

if (process.argv[1] && process.argv[1].endsWith('resumen-de-pruebas.mjs')) {
  const archivos = process.argv.slice(2);
  if (archivos.length === 0) {
    console.error('Uso: node scripts/resumen-de-pruebas.mjs <archivo-de-registro> [...]');
    process.exit(1);
  }
  let hubo = false;
  for (const archivo of archivos) {
    const resumen = leerResumen(readFileSync(archivo, 'utf8'));
    console.log(formatear(archivo.split('/').pop() ?? archivo, resumen));
    for (const p of verificar(resumen)) {
      hubo = true;
      console.error(`  ! ${p}`);
    }
  }
  process.exit(hubo ? 1 : 0);
}
