import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { aCanonico, parseArNumber, parseCanonicalNumber, toDecimal } from '@/lib/money';
import { analizadorEzra, numerosDelTexto } from '@/lib/ocr/parsers/ezra';
import { EZRA_FOTO } from '../fixtures/ezra-foto';

/**
 * Las dos convenciones numéricas, y dónde está el límite entre ellas.
 *
 * En este sistema conviven dos formas de escribir el mismo número, y la misma
 * cadena significa cosas distintas en cada una:
 *
 *   canónico   «7.345»    → siete kilos con trescientos cuarenta y cinco gramos
 *   argentino  «7.345,00» → siete mil trescientos cuarenta y cinco
 *
 * El lector produce canónico —lo dice el contrato de `OcrItem`— y una persona
 * escribe en argentino. `toDecimal` pasaba todo por `parseArNumber`, así que
 * leía «7.345» como siete mil trescientos cuarenta y cinco: **toda cantidad de
 * uno a tres dígitos enteros con exactamente tres decimales se multiplicaba por
 * mil**. En la factura de Ezra son tres de los seis renglones.
 *
 * Lo que se fija acá es la regla completa: `toDecimal` lee canónico y nada más,
 * y lo que viene de la pantalla pasa antes por `aCanonico`, que es el único
 * lugar donde se decide entre las dos convenciones.
 */

describe('toDecimal lee canónico', () => {
  it('«7.345» son siete con trescientos cuarenta y cinco milésimas', () => {
    expect(toDecimal('7.345').toString()).toBe('7.345');
    expect(toDecimal('3.985').toString()).toBe('3.985');
    expect(toDecimal('4.24').toString()).toBe('4.24');
    // El caso que motivó todo: 7,345 kg de queso, no 7.345 kg.
    expect(toDecimal('7.345').lt(10)).toBe(true);
  });

  it('un decimal de la base llega intacto', () => {
    // Prisma devuelve canónico con `.toString()`, que es como lo consume media
    // aplicación. Es el uso más frecuente y no puede cambiar de significado.
    expect(toDecimal('221388.84').toFixed(2)).toBe('221388.84');
    expect(toDecimal('6387.115').toString()).toBe('6387.115');
    expect(toDecimal('0').toString()).toBe('0');
  });
});

describe('el formato argentino se normaliza antes, con su propio parser', () => {
  it('«7.345,00» son siete mil trescientos cuarenta y cinco', () => {
    // El parser argentino, que es el que sabe leer esta convención.
    expect(parseArNumber('7.345,00')?.toString()).toBe('7345');
    // Y el límite lo reconoce por la coma y lo pasa a canónico.
    expect(aCanonico('7.345,00')).toBe('7345');
    // Recién entonces toDecimal lo ve, y ya no hay ambigüedad.
    expect(toDecimal(aCanonico('7.345,00')!).toString()).toBe('7345');
  });

  it('los importes que escribe una persona sobreviven el viaje', () => {
    expect(aCanonico('2.084.594,70')).toBe('2084594.7');
    expect(aCanonico('221.388,84')).toBe('221388.84');
    expect(aCanonico('$ 46.491,66')).toBe('46491.66');
    expect(toDecimal(aCanonico('221.388,84')!).toFixed(2)).toBe('221388.84');
  });

  it('la coma es lo que decide, y decide en los dos sentidos', () => {
    /*
     * Ésta es la regla entera, en una prueba. Los mismos dígitos, con y sin
     * coma, son números distintos y tienen que seguir siéndolo.
     */
    expect(aCanonico('7.345')).toBe('7.345'); // canónico: siete con pico
    expect(aCanonico('7.345,00')).toBe('7345'); // argentino: siete mil
    expect(toDecimal(aCanonico('7.345')!).times(1000).toString()).toBe(
      toDecimal(aCanonico('7.345,00')!).toString(),
    );
  });

  it('lo que no es un número no se convierte en cero', () => {
    // Un campo vacío no es un cero: es un dato que falta, y el que llama tiene
    // que poder distinguirlos.
    expect(aCanonico('')).toBeNull();
    expect(aCanonico(null)).toBeNull();
    expect(aCanonico('   ')).toBeNull();
  });
});

describe('ningún valor crudo del OCR llega a toDecimal', () => {
  it('lo que produce el analizador ya es canónico', () => {
    /*
     * El contrato de `OcrItem` dice que todo lo numérico viaja en formato
     * canónico. Acá se comprueba sobre lo que de verdad sale del analizador de
     * Ezra leyendo la foto real: ni un solo campo trae coma, que es la marca de
     * que quedó en la otra convención.
     */
    const analisis = analizadorEzra.analizar(EZRA_FOTO);
    expect(analisis.items.length).toBeGreaterThan(0);

    for (const item of analisis.items) {
      for (const [campo, valor] of Object.entries({
        quantity: item.quantity,
        unitNetPrice: item.unitNetPrice,
        grossSubtotal: item.grossSubtotal,
        discountPct: item.discountPct,
      })) {
        if (valor === null || valor === undefined) continue;
        expect(valor, `${item.supplierCode}.${campo} = ${valor}`).not.toMatch(/,/);
        // Y se puede leer como canónico sin caer al parser argentino.
        expect(/^-?\d+(\.\d+)?$/.test(valor), `${campo} = ${valor}`).toBe(true);
      }
    }

    for (const valor of [
      analisis.summary?.netTotal,
      analisis.summary?.ivaTotal,
      analisis.summary?.total,
    ]) {
      if (!valor) continue;
      expect(valor).not.toMatch(/,/);
    }
  });

  it('el texto crudo de la foto nunca se le pasa directo', () => {
    /*
     * La red de contención estructural. Un analizador nuevo podría emitir el
     * texto tal cual salió de Tesseract —«8.267,69»— y el resto del circuito lo
     * tomaría por canónico. Se comprueba que ningún analizador entregue algo
     * con coma, sobre las cuatro zonas de la foto real, que es donde el OCR
     * escribe con la convención del papel.
     */
    expect(EZRA_FOTO.articulos).toMatch(/8\.267,69/); // el papel sí tiene comas
    const analisis = analizadorEzra.analizar(EZRA_FOTO);
    const todos = analisis.items.flatMap((i) => [i.quantity, i.unitNetPrice, i.grossSubtotal]);
    expect(todos.filter((v) => typeof v === 'string' && v.includes(','))).toEqual([]);
  });

  it('el costeo recibe los renglones ya normalizados', () => {
    /*
     * El límite está en `confirmDocument`, que es por donde entra lo que
     * escribió una persona. Se comprueba leyendo el código: `costItems` tiene
     * que recibir los renglones normalizados y no `input.items` crudos, porque
     * ésa era la vía por la que un «7.345» tipeado a mano llegaba sin pasar por
     * ninguna decisión.
     */
    const fuente = readFileSync(
      path.resolve(__dirname, '../../src/lib/services/documents.ts'),
      'utf8',
    );
    expect(fuente).toContain('const costed = costItems(renglonesNormalizados,');
    expect(fuente).not.toMatch(/costItems\(input\.items/);
    expect(fuente).toContain('aCanonico(');
  });
});

describe('una letra suelta no es un número', () => {
  it('la S de SUB-TOTAL no puede volverse un 5', () => {
    /*
     * Regresión. `CLASE_DIGITOS_OCR` incluye las letras con las que el OCR
     * confunde dígitos —S por 5, B por 8, O por 0— y eso está bien **adentro**
     * de un número, para reparar «1S3,7O». Aplicado a un texto cualquiera
     * convertía cada letra suelta en una cifra.
     *
     * No era inofensivo: ese 5 entraba como número del pie del comprobante, y
     * como los del pie se descartan de los candidatos de los renglones, el 5 %
     * de descuento de los dos primeros artículos de Ezra quedaba afuera y los
     * dos se cargaban sin descuento.
     */
    /*
     * Se fija sobre la función, y no sólo sobre la factura entera, a propósito:
     * cuando esta prueba se escribió mirando nada más el resultado final, otros
     * cambios del analizador tapaban el síntoma y quitar la guarda no hacía
     * fallar nada. Una garantía que no se puede romper no es una garantía.
     */
    expect(numerosDelTexto('SUB-TOTAL')).toEqual([]);
    expect(numerosDelTexto('DESCUENTOS:')).toEqual([]);
    expect(numerosDelTexto('IVA')).toEqual([]);
    expect(numerosDelTexto('PESOS : DOSCIENTOS SESENTA Y SIETE MIL')).toEqual([]);

    // Y con dígitos de verdad al lado, se lee el número y nada más que el número.
    expect(numerosDelTexto('SUB-TOTAL : 221.388,84').map(String)).toContain('221388.84');
    expect(numerosDelTexto('SUB-TOTAL : 221.388,84').some((n) => n.eq(5))).toBe(false);
    expect(numerosDelTexto('IVA 21,00 46.491,66').some((n) => n.eq(1))).toBe(false);

    const analisis = analizadorEzra.analizar(EZRA_FOTO);
    const cremoso = analisis.items.find((i) => i.supplierCode === '47');
    const pernil = analisis.items.find((i) => i.supplierCode === '49');

    // Los dos renglones existen y su importe es el del papel: si la S se
    // hubiera colado como un 5, el descuento del 5 % no se encontraba.
    expect(cremoso?.grossSubtotal).toBe('27081.371');
    expect(pernil?.grossSubtotal).toBe('15295.149');
  });

  it('ningún analizador saca números de palabras', () => {
    /*
     * La regla, escrita donde se pueda comprobar: un tramo sin ningún dígito de
     * verdad no es un número. Se prueba sobre las palabras que más aparecen en
     * un comprobante y que están hechas justamente de las letras confundibles.
     */
    for (const palabra of ['SUB', 'TOTAL', 'IVA', 'S', 'B', 'OS', 'SOS', 'BOB']) {
      expect(parseCanonicalNumber(palabra), palabra).toBeNull();
      expect(aCanonico(palabra), palabra).toBeNull();
    }
  });
});

describe('auditoría: quién le pasa qué a toDecimal', () => {
  it('ningún módulo le pasa un texto con coma', () => {
    /*
     * Barrido sobre el código: `toDecimal` recibiendo un literal con coma
     * sería, por definición, la convención equivocada. No prueba todos los
     * casos —la mayoría de los argumentos son variables— pero cierra la puerta
     * a que alguien escriba el literal directamente, que es el error fácil.
     */
    const raiz = path.resolve(__dirname, '../../src/lib');
    const archivos: string[] = [];
    const recorrer = (dir: string) => {
      for (const entrada of readdirSync(dir, { withFileTypes: true })) {
        const completo = path.join(dir, entrada.name);
        if (entrada.isDirectory()) recorrer(completo);
        else if (entrada.name.endsWith('.ts')) archivos.push(completo);
      }
    };
    recorrer(raiz);
    expect(archivos.length).toBeGreaterThan(10);

    const ofensores: string[] = [];
    for (const archivo of archivos) {
      for (const linea of readFileSync(archivo, 'utf8').split('\n')) {
        if (/toDecimal\(\s*['"][^'"]*,[^'"]*['"]\s*\)/.test(linea)) {
          ofensores.push(`${path.basename(archivo)}: ${linea.trim()}`);
        }
      }
    }
    expect(ofensores).toEqual([]);
  });
});
