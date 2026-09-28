import { describe, it, expect } from 'vitest';
// @ts-expect-error -- es un .mjs sin tipos: se importa por lo que hace, no por su forma.
import { leerResumen, verificar, formatear } from '../../scripts/resumen-de-pruebas.mjs';

/**
 * **La prueba del resumen que no puede ocultar salteadas.**
 *
 * Nace de una corrección: un informe dijo «Playwright: 352/352 en verde» cuando
 * la corrida había sido de 352 pasadas, 42 salteadas y 0 fallas sobre 394. Las
 * dos cifras eran ciertas, pero «352/352» se lee como «no se salteó nada».
 *
 * La lección no fue «redactar mejor». Fue que nadie EXTRAÍA el número: mientras
 * alguien lea el registro a ojo y escriba el total, puede volver a pasar. Así que
 * el resumen es un programa, y esto comprueba que su regla muerde.
 */

const REGISTRO_PLAYWRIGHT = `
Running 394 tests using 1 worker
[1/394] [iphone] › tests/e2e/acceso.spec.ts:12:7 › entra y sale
  42 skipped
  352 passed (12.9m)
`;

const REGISTRO_VITEST = `
 Test Files  99 passed | 1 skipped (100)
      Tests  2063 passed | 6 skipped (2069)
   Duration  625.43s
`;

const REGISTRO_CON_FALLAS = `
  2 failed
  350 passed (11.2m)
`;

describe('el resumen informa las tres cifras por separado', () => {
  it('lee una corrida de Playwright con salteadas', () => {
    const r = leerResumen(REGISTRO_PLAYWRIGHT);
    expect(r.herramienta).toBe('playwright');
    expect(r.pasadas).toBe(352);
    expect(r.salteadas, 'las salteadas se cuentan, no se descartan').toBe(42);
    expect(r.fallidas).toBe(0);
    expect(r.total, 'y el total es la suma, no las pasadas').toBe(394);
    expect(verificar(r)).toEqual([]);
  });

  it('lee una corrida de Vitest con salteadas', () => {
    const r = leerResumen(REGISTRO_VITEST);
    expect(r.herramienta).toBe('vitest');
    expect(r.pasadas).toBe(2063);
    expect(r.salteadas).toBe(6);
    expect(r.fallidas).toBe(0);
    expect(r.total).toBe(2069);
    expect(verificar(r)).toEqual([]);
  });

  it('el texto que imprime nombra las salteadas', () => {
    const linea = formatear('playwright.log', leerResumen(REGISTRO_PLAYWRIGHT));
    expect(linea).toContain('352 pasadas');
    expect(linea).toContain('42 salteadas');
    expect(linea).toContain('0 fallidas');
    expect(linea, 'y el total es el de la corrida entera').toContain('394 en total');
  });

  it('las fallas se informan como fallas', () => {
    const r = leerResumen(REGISTRO_CON_FALLAS);
    expect(r.fallidas).toBe(2);
    expect(verificar(r).join(' ')).toMatch(/2 prueba\(s\) fallada\(s\)/);
  });

  it('**un resumen que no cuenta las salteadas no pasa**', () => {
    /*
     * Ésta es la afirmación que le da sentido al archivo. Se le da un resumen
     * armado a mano donde el total es 394 pero sólo se contaron las 352 pasadas
     * —exactamente la forma del error que se quiere impedir— y se comprueba que
     * `verificar` lo rechaza diciendo qué falta.
     */
    const ocultando = {
      herramienta: 'playwright',
      pasadas: 352,
      salteadas: 0,
      fallidas: 0,
      total: 394,
    };
    const problemas = verificar(ocultando);
    expect(problemas.length, 'tiene que protestar').toBeGreaterThan(0);
    expect(problemas.join(' ')).toMatch(/no está contando/);
  });

  it('un registro sin cifras no se interpreta como «todo bien»', () => {
    /*
     * El silencio es el otro modo de ocultar: si el registro se truncó o la
     * herramienta cambió su formato, lo que corresponde es decir que no se pudo
     * leer, no devolver ceros que parecen una corrida limpia.
     */
    expect(leerResumen('la corrida se cortó por un timeout del contenedor')).toBeNull();
    expect(verificar(null).join(' ')).toMatch(/no se encontró ninguna cifra/);
  });
});
