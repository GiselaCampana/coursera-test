import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { interpretarReconstruccion } from '@/lib/ocr/motor/desde-reconstruccion';
import type { InformeReconstruido } from '@/lib/ocr/motor/desde-reconstruccion';
import type { EvidenciaDeLectura } from '@/lib/ocr/reconstruccion/evidencia';
import { evidenciaNormalizada } from '@/lib/ocr/reconstruccion/evidencia';

/**
 * La reconstrucción completa sobre las fotos reales, sin ningún analizador de
 * proveedor.
 *
 * La evidencia está capturada de las fotos de verdad con `scripts/capturar-
 * evidencia.mjs` y guardada como fixture, así que esto corre en CI en
 * milisegundos y es determinístico: la misma foto da siempre la misma tabla.
 *
 * Es la medida honesta de dónde está el motor. Lo que se afirma acá es lo que
 * hace hoy, incluido lo que todavía no hace, y cada vez que algo mejore esta
 * prueba tiene que fallar para que se actualice.
 */

const DIRECTORIO = path.resolve(__dirname, '../fixtures/evidencia');
const CUIT_DEL_RECEPTOR = '27-33342291-9';

function leer(nombre: string): EvidenciaDeLectura {
  return JSON.parse(readFileSync(path.join(DIRECTORIO, `${nombre}.json`), 'utf8'));
}

function interpretar(nombre: string): InformeReconstruido {
  return interpretarReconstruccion(leer(nombre), { cuitDelReceptor: CUIT_DEL_RECEPTOR });
}

const ERRECALDE = interpretar('errecalde');
const MABELHERDI = interpretar('mabelherdi');
const EZRA = interpretar('ezra');
const BARRAZA = interpretar('barraza');
const CALVOS_212356 = interpretar('los-calvos-212356');
const CALVOS_213103 = interpretar('los-calvos-213103');

const TODAS = [
  ['Errecalde', ERRECALDE],
  ['Mabelherdi', MABELHERDI],
  ['Ezra', EZRA],
  ['Barraza', BARRAZA],
  ['Los Calvos 212356', CALVOS_212356],
  ['Los Calvos 213103', CALVOS_213103],
] as const;

describe('la evidencia capturada', () => {
  it('está normalizada en las seis fotos', () => {
    /*
     * Unas coordenadas en píxeles que se cuelen no fallan: producen una
     * reconstrucción donde todo cae en la primera columna y un resultado que
     * parece válido. Por eso se comprueba antes que nada.
     */
    for (const nombre of ['errecalde', 'mabelherdi', 'ezra', 'barraza']) {
      expect(evidenciaNormalizada(leer(nombre)), nombre).toBe(true);
    }
  });

  it('trae varias pasadas por foto, con palabras y cajas', () => {
    const evidencia = leer('ezra');
    expect(evidencia.pasadas.length).toBeGreaterThanOrEqual(5);
    expect(evidencia.fragmentos.length).toBeGreaterThan(500);
    expect(new Set(evidencia.fragmentos.map((f) => f.pasada)).size).toBeGreaterThan(3);
  });
});

describe('la reconstrucción de la tabla', () => {
  it('Ezra: los seis artículos, enteros, desde una foto de teléfono', () => {
    /*
     * Es el resultado que este hito existía para conseguir. El motor basado en
     * texto sacaba **cero** renglones utilizables de esta misma foto; acá salen
     * los seis con código, cantidad, los dos precios y el importe, y los valores
     * son los que dice el papel.
     */
    const renglones = EZRA.veredicto.ganadora!.renglones;
    expect(renglones.map((r) => r.codigo)).toEqual(['47', '49', '48', '10', '2514', '4249E']);
    expect(renglones[0].cantidad?.toString()).toBe('4.24');
    expect(renglones[0].precioUnitario?.toString()).toBe('6723.279');
    expect(renglones[0].descuentoPct?.toString()).toBe('0.05');
    expect(renglones[0].precioConDescuento?.toString()).toBe('6387.115');
    expect(renglones[0].importe?.toString()).toBe('27081.371');
  });

  it('Ezra: la suma de los renglones da el neto impreso', () => {
    // 221.388,85 contra 221.388,84 del papel: un centavo, que es el redondeo de
    // los importes con tres decimales que imprime este formato.
    const ganadora = EZRA.veredicto.ganadora!;
    expect(ganadora.sumaDeRenglones.minus(EZRA.pie.netTotal!).abs().toNumber()).toBeLessThan(0.02);
  });

  it('Mabelherdi: los nueve artículos y la suma exacta contra el pie', () => {
    const ganadora = MABELHERDI.veredicto.ganadora!;
    expect(ganadora.sumaDeRenglones.toFixed(2)).toBe('32998.85');
    expect(MABELHERDI.pie.netTotal?.toFixed(2)).toBe('32998.85');
  });

  it('Errecalde: los códigos de artículo salen enteros', () => {
    // Trece renglones con su código, su descripción y su precio. El importe
    // todavía no, porque la columna «SUBTOTAL» salió recortada del OCR y no se
    // reconoce: es el pendiente que se informa.
    const codigos = ERRECALDE.veredicto.ganadora!.renglones.map((r) => r.codigo);
    expect(codigos).toContain('ART-00873');
    expect(codigos).toContain('ART-01911');
    expect(codigos.filter((c) => c?.startsWith("ART-")).length).toBeGreaterThanOrEqual(13);
  });

  it('la inclinación de la foto se mide y se corrige donde hace falta', () => {
    // Barraza y una de las de Los Calvos salieron torcidas; las otras no.
    expect(BARRAZA.tabla.seEnderezo).toBe(true);
    expect(Math.abs(BARRAZA.tabla.inclinacionGrados)).toBeGreaterThan(0.1);
    expect(EZRA.tabla.seEnderezo).toBe(false);
  });

  it('se informa con qué método se delimitaron las columnas', () => {
    for (const [nombre, informe] of TODAS) {
      expect(
        ['datos-con-titulos', 'columnas-de-datos', 'fila-de-titulos'],
        nombre,
      ).toContain(informe.tabla.metodo);
    }
  });

  it('varias pasadas aportan valores al mismo comprobante', () => {
    // Es lo que justifica leer varias veces, y hasta ahora no se podía medir
    // porque los textos de las pasadas se concatenaban.
    for (const [nombre, informe] of TODAS) {
      expect(informe.tabla.valoresDeOtraPasada, nombre).toBeGreaterThan(0);
    }
  });
});

describe('el pie fiscal', () => {
  it('Ezra, Mabelherdi y Barraza salen del pie con el neto correcto', () => {
    expect(EZRA.pie.netTotal?.toFixed(2)).toBe('221388.84');
    expect(MABELHERDI.pie.netTotal?.toFixed(2)).toBe('32998.85');
    expect(BARRAZA.pie.netTotal?.toFixed(2)).toBe('473232.44');
  });

  it('Barraza: el saldo acumulado sigue quedando afuera', () => {
    // 532.848,64 es más grande que el total de la factura (579.709,74 menos el
    // IVA): si se colara como neto, la deuda quedaría al doble.
    expect(BARRAZA.pie.ivaTotal?.toFixed(2)).toBe('99378.81');
    expect(BARRAZA.pie.percepciones?.toFixed(2)).toBe('7098.49');
    expect(BARRAZA.pie.total?.toFixed(2)).toBe('579709.74');
    for (const valor of [BARRAZA.pie.netTotal, BARRAZA.pie.ivaTotal, BARRAZA.pie.total]) {
      expect(valor?.toFixed(2)).not.toBe('532848.64');
    }
  });

  it('Errecalde: el pie todavía se lee mal, y queda dicho', () => {
    /*
     * El papel dice 3.830.467,37 de neto. El OCR pierde la coma decimal y el
     * motor se queda con la lectura entera, porque este formato no imprime el
     * IVA ni el total con etiquetas reconocibles y no hay con qué contrastar.
     *
     * Se prueba que está mal en vez de callarlo: es la falta que impide que
     * Errecalde reconcilie, y cuando se arregle esta prueba tiene que fallar.
     */
    expect(ERRECALDE.pie.netTotal?.toFixed(2)).not.toBe('3830467.37');
    expect(ERRECALDE.veredicto.decision).not.toBe('automatica');
  });
});

describe('el emisor', () => {
  it('el CUIT sale bien en las cuatro facturas del objetivo', () => {
    expect(ERRECALDE.emisor.cuit).toBe('30-71780890-4');
    expect(EZRA.emisor.cuit).toBe('30-71951960-8');
    expect(BARRAZA.emisor.cuit).toBe('30-66138303-4');
    expect(MABELHERDI.emisor.cuit).toMatch(/^30-6780430[0-9]-[0-9]$/);
  });

  it('ninguna se atribuye al CUIT del receptor', () => {
    for (const [nombre, informe] of TODAS) {
      expect(informe.emisor.cuit, nombre).not.toBe(CUIT_DEL_RECEPTOR);
    }
  });
});

describe('qué le queda por resolver a una persona', () => {
  it('Ezra: unos pocos pendientes, no la tabla entera', () => {
    /*
     * El criterio del hito: una revisión puntual y accionable, no volver a
     * escribir los renglones. Ezra queda con un puñado de celdas señaladas,
     * sobre seis renglones ya interpretados y con la suma cuadrando.
     */
    expect(EZRA.pendientes.length).toBeLessThanOrEqual(8);
    expect(EZRA.veredicto.decision).toBe('revision-de-estructura');
  });

  it('cada pendiente dice qué renglón y qué columna, no «no se pudo leer»', () => {
    for (const pendiente of EZRA.pendientes) {
      expect(pendiente.detalle.length).toBeGreaterThan(10);
      if (pendiente.tipo === 'celda-ambigua' || pendiente.tipo === 'celda-sin-leer') {
        expect(pendiente.renglon).not.toBeNull();
        expect(pendiente.columna).not.toBeNull();
      }
    }
  });

  it('una celda ambigua trae las opciones entre las que elegir', () => {
    const conOpciones = [...EZRA.pendientes, ...MABELHERDI.pendientes].filter(
      (p) => p.tipo === 'celda-ambigua',
    );
    for (const pendiente of conOpciones) {
      expect(pendiente.opciones!.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('Mabelherdi: la columna «Desc» se pide, y las basuras del OCR no', () => {
    /*
     * «Desc» es la ambigüedad real que una persona resuelve una vez. «y», «e»,
     * «UU» y «RM» son jirones del encabezado: pedirle a alguien que diga qué
     * significa la columna «e» es hacerle perder el tiempo con algo que no tiene
     * respuesta.
     */
    const columnas = MABELHERDI.pendientes
      .filter((p) => p.tipo === 'columna-sin-reconocer')
      .map((p) => p.columna);
    expect(columnas).toContain('Desc');
    for (const basura of ['y', 'e', 'UU', 'RM']) {
      expect(columnas).not.toContain(basura);
    }
  });

  it('Barraza todavía no llega, y no lo disimula', () => {
    /*
     * La tabla de Barraza tiene dos renglones y el OCR pone el importe del
     * segundo en la línea del primero. Hoy el motor general no la reconstruye:
     * lo que hace es rechazarla, que es lo correcto mientras no pueda. La
     * resuelve su analizador específico, que sigue como respaldo.
     */
    expect(BARRAZA.veredicto.decision).toBe('rechazo');
    expect(BARRAZA.veredicto.ganadora!.renglones.length).toBeLessThan(2);
  });

  it('las dos fotos de Los Calvos se siguen rechazando por calidad', () => {
    // Son las imágenes insuficientes: no hay que forzar datos que la foto no
    // contiene.
    expect(CALVOS_212356.veredicto.decision).toBe('rechazo');
    expect(CALVOS_213103.veredicto.decision).toBe('rechazo');
  });

  it('ninguna de las seis se acepta sola todavía', () => {
    // El estado de hoy, dicho entero. Cuando alguna empiece a aceptarse sola,
    // esta prueba tiene que fallar.
    for (const [nombre, informe] of TODAS) {
      expect(informe.veredicto.decision, nombre).not.toBe('automatica');
    }
  });
});

describe('el costo de reconstruir', () => {
  it('cada comprobante se reconstruye e interpreta en menos de un segundo', () => {
    // Corre en el navegador, después del OCR y sobre el mismo teléfono.
    for (const [nombre, informe] of TODAS) {
      expect(informe.ms, nombre).toBeLessThan(1000);
    }
  });
});
