import { describe, it, expect, afterEach } from 'vitest';
import { dateOnlyFromISO, formatDateAr, toDateOnly, toISODate, parseArDate } from '@/lib/datetime';
import { EZRA_ENCABEZADO } from '../fixtures/ezra';

/**
 * **Una fecha de calendario no se corre un día, en ningún huso.**
 *
 * Es el defecto clásico de las fechas sin hora: se guardan como un instante,
 * se leen en otro huso y el día cambia. En una factura eso no es un detalle de
 * presentación —un vencimiento que se corre al día anterior es plata que
 * aparece vencida, y una emisión que se corre al día siguiente rompe la
 * comparación contra el vencimiento— así que conviene tenerlo clavado.
 *
 * La defensa del proyecto es de construcción: las fechas de calendario se
 * guardan como medianoche UTC del día argentino y se leen siempre con los
 * accesores UTC. Esta prueba existe para demostrar que esa construcción se
 * sostiene, no para describirla: recorre husos a ambos lados del meridiano
 * —incluido +14, que es donde un desplazamiento suma un día— y exige el mismo
 * día en todos.
 */

const HUSOS = [
  'UTC',
  'America/Argentina/Buenos_Aires', // -3, el nuestro
  'Pacific/Kiritimati', // +14: acá un corrimiento suma un día
  'Pacific/Midway', // -11: acá resta uno
  'Europe/Madrid', // +1/+2 con horario de verano
  'Asia/Kolkata', // +5:30, desfasaje de media hora
];

const HUSO_ORIGINAL = process.env.TZ;
afterEach(() => {
  process.env.TZ = HUSO_ORIGINAL;
});

/** Las fechas que importan, más los bordes donde un corrimiento se nota. */
const FECHAS = [
  EZRA_ENCABEZADO.issueDate,
  '2026-01-01',
  '2026-12-31',
  '2026-03-01', // el día después de un febrero corto
  '2026-10-18', // dentro del horario de verano del norte
];

describe('el día no se mueve, mire desde donde se mire', () => {
  it('formatear una fecha de calendario da el mismo día en todos los husos', () => {
    for (const huso of HUSOS) {
      process.env.TZ = huso;
      for (const iso of FECHAS) {
        const fecha = dateOnlyFromISO(iso);
        const [anio, mes, dia] = iso.split('-');
        expect(formatDateAr(fecha), `${iso} en ${huso}`).toBe(`${dia}/${mes}/${anio}`);
        expect(toISODate(fecha), `${iso} en ${huso}`).toBe(iso);
      }
    }
  });

  it('normalizar una emisión guardada al mediodía UTC tampoco la mueve', () => {
    /*
     * El sembrado guarda la emisión como `...T12:00:00Z`, a propósito: el
     * mediodía UTC está lejos de los dos bordes del día en cualquier huso
     * habitado. Aun así, lo que decide el día es `toDateOnly`, que es UTC.
     */
    for (const huso of HUSOS) {
      process.env.TZ = huso;
      for (const iso of FECHAS) {
        expect(toISODate(toDateOnly(new Date(`${iso}T12:00:00Z`))), `${iso} en ${huso}`).toBe(iso);
      }
    }
  });

  it('ni siquiera en los dos bordes del día UTC', () => {
    // 00:00Z y 23:59Z del mismo día tienen que dar el mismo día.
    for (const huso of HUSOS) {
      process.env.TZ = huso;
      for (const iso of FECHAS) {
        const temprano = toDateOnly(new Date(`${iso}T00:00:00Z`));
        const tarde = toDateOnly(new Date(`${iso}T23:59:59Z`));
        expect(toISODate(temprano), `${iso} 00:00Z en ${huso}`).toBe(iso);
        expect(toISODate(tarde), `${iso} 23:59Z en ${huso}`).toBe(iso);
      }
    }
  });
});

describe('serializar y volver a leer devuelve el mismo día', () => {
  it('el viaje al navegador —JSON de ida y vuelta— no corre la fecha', () => {
    /*
     * Es el camino real: el servidor arma la pantalla, el valor viaja como
     * texto y el navegador lo vuelve a leer. Si en ese viaje el día se moviera,
     * la pantalla mostraría una fecha y la base tendría otra, que es la peor
     * de las combinaciones porque las dos parecen ciertas.
     */
    for (const huso of HUSOS) {
      process.env.TZ = huso;
      for (const iso of FECHAS) {
        const original = dateOnlyFromISO(iso);
        const ida = JSON.parse(JSON.stringify({ fecha: original })) as { fecha: string };
        const vuelta = new Date(ida.fecha);
        const [anio, mes, dia] = iso.split('-');
        expect(toISODate(toDateOnly(vuelta)), `${iso} en ${huso}`).toBe(iso);
        /*
         * Contra el día escrito a mano, no contra `formatDateAr(original)`:
         * comparar las dos puntas del mismo formateador pasa igual aunque el
         * formateador esté roto, porque se corren las dos juntas.
         */
        expect(formatDateAr(vuelta), `${iso} en ${huso}`).toBe(`${dia}/${mes}/${anio}`);
      }
    }
  });

  it('y el ISO que manda la pantalla vuelve a ser el mismo día al interpretarlo', () => {
    // El camino inverso: el `<input type="date">` manda "YYYY-MM-DD" y el
    // servidor lo interpreta con `parseArDate`.
    for (const huso of HUSOS) {
      process.env.TZ = huso;
      for (const iso of FECHAS) {
        const leida = parseArDate(iso);
        expect(leida, `${iso} en ${huso}`).not.toBeNull();
        expect(toISODate(leida!), `${iso} en ${huso}`).toBe(iso);
      }
    }
  });

  it('una fecha escrita a la argentina y su ISO son el mismo día', () => {
    for (const huso of HUSOS) {
      process.env.TZ = huso;
      for (const iso of FECHAS) {
        const [anio, mes, dia] = iso.split('-');
        expect(toISODate(parseArDate(`${dia}/${mes}/${anio}`)!), `${iso} en ${huso}`).toBe(iso);
      }
    }
  });
});
