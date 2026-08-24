import { describe, it, expect } from 'vitest';
import { Decimal, parseArNumber } from '@/lib/money';
import { elegirAnalizador } from '@/lib/ocr/parsers';
import { analizadorErrecalde } from '@/lib/ocr/parsers/errecalde';
import { validateDocument } from '@/lib/domain/validation';
import { costItems } from '@/lib/domain/costing';
import { toPrintedSummary, toRawItems } from '@/lib/ocr/normalize';
import {
  ERRECALDE_TEXTOS,
  ERRECALDE_ESPERADO,
  ERRECALDE_ARTICULOS_IMPRESOS,
} from '../fixtures/errecalde-ocr';

/**
 * Prueba de aceptación del formato de Distribución Errecalde.
 *
 * Corre sobre el texto que Tesseract sacó de la foto real —la misma que se sacó
 * con el iPhone, con la basura que trajo— y contrasta el resultado contra lo que
 * dice el papel. Si esta prueba pasa con un fixture "arreglado a mano", no
 * prueba nada: el fixture es la salida cruda del lector, a propósito.
 */

const analisis = analizadorErrecalde.analizar(ERRECALDE_TEXTOS);

describe('reconocimiento del formato', () => {
  it('elige el analizador de Errecalde y no el genérico', () => {
    const elegido = elegirAnalizador(ERRECALDE_TEXTOS);
    expect(elegido.analizador.codigo).toBe('errecalde');
    expect(elegido.puntaje).toBeGreaterThanOrEqual(0.5);
  });
});

describe('encabezado', () => {
  it('lee el número de comprobante y la fecha', () => {
    expect(analisis.header?.fullNumber).toBe(ERRECALDE_ESPERADO.fullNumber);
    expect(analisis.header?.issueDate).toBe(ERRECALDE_ESPERADO.issueDate);
    expect(analisis.header?.letter).toBe('A');
    expect(analisis.header?.docType).toBe('FACTURA');
  });
});

describe('tabla de artículos', () => {
  it('interpreta los 23 renglones, sin repetir ninguno', () => {
    expect(analisis.items).toHaveLength(ERRECALDE_ESPERADO.renglones);
  });

  it('los 23 subtotales suman exactamente el neto gravado impreso', () => {
    const suma = analisis.items.reduce(
      (acumulado, item) => acumulado.plus(parseArNumber(item.grossSubtotal ?? '0') ?? 0),
      new Decimal(0),
    );
    expect(suma.toFixed(2)).toBe('3830467.37');
  });

  it('distingue los artículos por kilo de los que van por unidad', () => {
    // Lo decide el sufijo "kg" impreso, no una suposición: siete de los
    // veintitrés se venden por unidad y su columna Cantidad repite las unidades.
    const porUnidad = analisis.items.filter((i) => i.unit === 'UNIT');
    const porKilo = analisis.items.filter((i) => i.unit === 'KG');
    expect(porUnidad).toHaveLength(7);
    expect(porKilo).toHaveLength(16);

    // Y a los que van por unidad no se les inventa un peso.
    for (const item of porUnidad) {
      expect(item.totalWeightKg).toBeNull();
    }
  });

  it('conserva cantidad, precio e importe de cada artículo impreso', () => {
    // Se ubica cada renglón por su descripción, que es lo que el OCR lee bien.
    // El código no sirve de llave: sobre esta foto tres de los veintitrés
    // salieron con un dígito cambiado (ART-60487 por ART-00487, por ejemplo),
    // que es un defecto real y está anotado como tal, pero no mueve ni un peso.
    const porDescripcion = (texto: string) =>
      texto
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');

    for (const impreso of ERRECALDE_ARTICULOS_IMPRESOS) {
      const buscado = porDescripcion(impreso.descripcion);
      const leido = analisis.items.find((i) => {
        const leida = porDescripcion(i.description);
        // Una tiene que contener a la otra. El OCR recorta el final de las
        // descripciones más largas ("...FRANCISCO X9" por "...X950GRS") y a
        // veces le agrega una letra adelante ("IMORTADELA" por "MORTADELA"),
        // así que ni el principio ni el final son confiables por sí solos. Lo
        // que sí alcanza: ningún par de artículos de esta factura se contiene
        // entre sí, así que la búsqueda sigue siendo inequívoca.
        return buscado.includes(leida) || leida.includes(buscado);
      });
      expect(leido, `no se encontró el renglón ${impreso.codigo} ${impreso.descripcion}`).toBeDefined();

      expect(
        new Decimal(leido!.quantity!).toString(),
        `cantidad de ${impreso.descripcion}`,
      ).toBe(new Decimal(impreso.cantidad).toString());

      expect(leido!.unit, `unidad de ${impreso.descripcion}`).toBe(impreso.kilos ? 'KG' : 'UNIT');

      expect(
        new Decimal(leido!.unitNetPrice!).toFixed(2),
        `precio de ${impreso.descripcion}`,
      ).toBe(new Decimal(impreso.precio).toFixed(2));

      expect(
        new Decimal(leido!.grossSubtotal!).toFixed(2),
        `subtotal de ${impreso.descripcion}`,
      ).toBe(new Decimal(impreso.subtotal).toFixed(2));
    }
  });

  it('no marca ningún renglón como que no cierra', () => {
    const noCierran = analisis.observaciones.filter((o) => /^Rengl[oó]n/.test(o));
    expect(noCierran).toEqual([]);
  });
});

describe('pie con los totales', () => {
  it('lee el neto, el IVA y las dos percepciones', () => {
    expect(analisis.summary?.netTotal).toBe(ERRECALDE_ESPERADO.netTotal);
    expect(analisis.summary?.ivaTotal).toBe(ERRECALDE_ESPERADO.ivaTotal);
    expect(analisis.summary?.total).toBe(ERRECALDE_ESPERADO.total);

    const percepciones = analisis.summary?.perceptionLines ?? [];
    expect(percepciones).toHaveLength(2);
    expect(percepciones.map((p) => p.amount)).toEqual([
      ERRECALDE_ESPERADO.percepcionIva,
      ERRECALDE_ESPERADO.percepcionIibb,
    ]);
  });

  it('neto + IVA + percepciones da el total impreso', () => {
    const neto = parseArNumber(analisis.summary!.netTotal!)!;
    const iva = parseArNumber(analisis.summary!.ivaTotal!)!;
    const percepciones = parseArNumber(analisis.summary!.perceptionsTotal!)!;
    expect(neto.plus(iva).plus(percepciones).toFixed(2)).toBe('4816812.73');
  });

  it('no avisa que el pie no cierra', () => {
    expect(analisis.observaciones.filter((o) => /pie/i.test(o))).toEqual([]);
  });
});

describe('el comprobante entero pasa los autocontroles', () => {
  it('queda en verde: los renglones cierran contra los totales impresos', () => {
    const printed = toPrintedSummary(analisis.summary);
    const costeados = costItems(toRawItems(analisis.items), {
      netTotal: printed.netTotal ?? '0',
      ivaTotal: printed.ivaTotal ?? '0',
      perceptionsTotal: printed.perceptionsTotal ?? '0',
    });
    const informe = validateDocument({
      items: costeados,
      printed,
      supplierRules: { ivaRate: '0.21' },
      attempts: 1,
      filasEnLaImagen: 23,
    });

    const errores = informe.checks.filter((c) => c.severity === 'ERROR');
    expect(errores.map((e) => `${e.code}: ${e.message}`)).toEqual([]);
    expect(informe.canSave).toBe(true);
  });
});

describe('el analizador no corrige importes', () => {
  /**
   * Arma una tabla de Errecalde con los subtotales que se le pasen.
   * El texto imita el que sale de la foto, con el ancla "0% 21%".
   */
  function tabla(filas: { desc: string; cant: string; precio: string; sub: string }[]): string {
    return filas
      .map(
        (f, i) =>
          `ART-0${1000 + i} ${f.desc}      3    ${f.cant} kg   $${f.precio} 0% 21%   $${f.sub}`,
      )
      .join('\n');
  }

  const texto = tabla([
    { desc: 'ARTICULO PRIMERO', cant: '10', precio: '1.000,00', sub: '10.000,00' },
    { desc: 'ARTICULO SEGUNDO', cant: '10', precio: '2.258,73', sub: '22.587,00' },
  ]);
  const leido = analizadorErrecalde.analizar({
    completo: texto,
    articulos: texto,
    resumen: 'Neto Gravado   $32.587,30\nIVA   $6.843,33\nTOTAL   $39.430,63',
  });

  it('deja el importe tal como lo leyó, sin arreglarlo', () => {
    // El analizador dice qué leyó y qué no cierra, nada más. Corregir centavos
    // mal leídos es tarea de la conciliación (ver conciliacion.test.ts), que
    // vale para cualquier proveedor y exige sus propias condiciones. Tener la
    // misma regla en los dos lados terminaría con dos criterios distintos.
    expect(new Decimal(leido.items[1].grossSubtotal!).toFixed(2)).toBe('22587.00');
  });

  it('avisa que ese renglón no cierra', () => {
    expect(leido.observaciones.join(' ')).toMatch(/Renglón 2 .*Hay que releerlo/);
  });
});

describe('una lectura rota no se acepta', () => {
  it('un solo renglón sobre una tabla de 23 filas es un error, aunque ese renglón cierre', () => {
    // Es exactamente lo que devolvía la aplicación con esta factura: un renglón,
    // que por ser el único cerraba perfecto consigo mismo. Sin este control el
    // comprobante quedaba "controlado" con el 4 % de la mercadería.
    const unSoloRenglon = costItems(
      toRawItems([
        {
          lineNumber: 1,
          supplierCode: 'ART-00873',
          description: 'BARRA DANBO PUNTA DE AGUA',
          quantity: '39.2',
          unit: 'KG',
          unitNetPrice: '8090.08',
          grossSubtotal: '317131.24',
          ivaRate: '0.21',
        },
      ]),
      { netTotal: '317131.24', ivaTotal: '0', perceptionsTotal: '0' },
    );

    const informe = validateDocument({
      items: unSoloRenglon,
      printed: { netTotal: '317131.24' },
      attempts: 1,
      filasEnLaImagen: 23,
    });

    const control = informe.checks.find((c) => c.code === 'ART_RENGLONES_COMPLETOS');
    expect(control?.severity).toBe('ERROR');
    expect(control?.message).toContain('23');
    expect(informe.canSave).toBe(false);
  });

  it('no molesta cuando la factura tiene pocos renglones de verdad', () => {
    const dos = costItems(
      toRawItems([
        { lineNumber: 1, description: 'UNO', quantity: '1', unit: 'KG', unitNetPrice: '100', grossSubtotal: '100' },
        { lineNumber: 2, description: 'DOS', quantity: '1', unit: 'KG', unitNetPrice: '100', grossSubtotal: '100' },
      ]),
      { netTotal: '200', ivaTotal: '0', perceptionsTotal: '0' },
    );
    const informe = validateDocument({
      items: dos,
      printed: { netTotal: '200' },
      attempts: 1,
      filasEnLaImagen: 2,
    });
    expect(informe.checks.find((c) => c.code === 'ART_RENGLONES_COMPLETOS')).toBeUndefined();
  });
});
