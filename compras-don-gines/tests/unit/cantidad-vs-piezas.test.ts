import { describe, expect, it } from 'vitest';
import { Decimal } from '@/lib/money';
import { interpretarReconstruccion } from '@/lib/ocr/motor/desde-reconstruccion';
import { soloRaices } from '@/lib/ocr/motor/pendientes';
import {
  asignarSemantica,
  type ContenidoDeColumna,
} from '@/lib/ocr/motor/semantica-de-columnas';
import {
  evidencia,
  fila,
  asociacionesDePrueba,
  palabra,
  RENGLONES,
  SALTO,
  Y_TITULOS,
} from '@/../tests/fixtures/evidencia-sintetica';

/**
 * «Unidades» nombra dos cosas distintas en comprobantes reales:
 *
 *  - la cantidad que se factura, cuando es la única magnitud del renglón;
 *  - el número de piezas o bultos, cuando otra columna trae los kilos o la
 *    cantidad que se multiplica por el precio.
 *
 * Resolverlo sólo por vocabulario convertía siempre «UNIDADES» en `piezas`.
 * Sobre una factura de trece artículos eso dejaba los trece importes bien
 * leídos y, aun así, cero renglones comprobados. Estas pruebas no contienen
 * nombres ni valores del lote ciego: fijan la distinción estructural.
 */

function columna(
  titulo: string | null,
  celdas: string[],
  desde: number,
  hasta: number,
): ContenidoDeColumna {
  return { titulo, celdas, desde, hasta };
}

function tablaConUnidades(): ContenidoDeColumna[] {
  return [
    columna('Codigo', ['47', '48', '10'], 0.05, 0.12),
    columna('Descripcion', ['Cremoso', 'Provolone', 'Jamon'], 0.20, 0.45),
    columna('UNIDADES', ['4', '2', '3'], 0.50, 0.58),
    columna('Precio', ['5.700,00', '9.600,00', '9.800,00'], 0.65, 0.76),
    columna('Importe', ['22.800,00', '19.200,00', '29.400,00'], 0.82, 0.95),
  ];
}

function comprobante(
  titulos: [string, number][],
  renglones: [string, number][][],
  neto: string,
) {
  return evidencia([
    palabra('PAMPATEX S.A.', 0.05, 0.05),
    palabra('CUIT 30-71406744-9', 0.05, 0.10),
    ...fila(Y_TITULOS, titulos),
    ...renglones.flatMap((celdas, i) => fila(Y_TITULOS + SALTO * (i + 1), celdas)),
    palabra(`Neto Gravado ${neto}`, 0.63, Y_TITULOS + SALTO * (renglones.length + 2)),
  ]);
}

const TITULOS_UNIDADES: [string, number][] = [
  ['Codigo', 0.05],
  ['Descripcion', 0.20],
  ['UNIDADES', 0.50],
  ['Precio', 0.65],
  ['Importe', 0.82],
];

describe('cantidad facturada frente a piezas físicas', () => {
  it('la única columna UNIDADES es cantidad cuando sus cuentas lo prueban', () => {
    const asignada = asignarSemantica(tablaConUnidades())[2];

    expect(asignada.campo).toBe('cantidad');
    expect(asignada.origen).toBe('EXACT_HEADER');
    expect(asignada.requiereConfirmacion).toBe(false);
    expect(
      asignada.evidencias.some(
        (e) => e.campo === 'cantidad' && e.familia === 'aritmetica',
      ),
    ).toBe(true);
  });

  it('UNIDADES sigue siendo piezas cuando otra columna es la cantidad que cuesta', () => {
    const tabla = tablaConUnidades();
    tabla.splice(2, 0, columna('Cantidad', ['20', '30', '15'], 0.46, 0.51));
    tabla[4] = columna('Precio', ['1.000,00', '2.000,00', '3.000,00'], 0.65, 0.76);
    tabla[5] = columna('Importe', ['20.000,00', '60.000,00', '45.000,00'], 0.82, 0.95);

    const asignadas = asignarSemantica(tabla);
    expect(asignadas[2].campo).toBe('cantidad');
    expect(asignadas[3].campo).toBe('piezas');
  });

  it.each(['Unidades', 'Unidad', 'Unid.', 'Uds.'])(
    '%s conserva los dos significados si ninguna cuenta los distingue',
    (titulo) => {
      const tabla = tablaConUnidades();
      tabla[2] = columna(titulo, ['4', '2', '3'], 0.50, 0.58);
      tabla.splice(3, 2);

      const asignada = asignarSemantica(tabla)[2];
      expect(asignada.campo).toBe('UNKNOWN_NUMERIC');
      expect(asignada.origen).toBe('UNRESOLVED');
      expect(asignada.requiereConfirmacion).toBe(true);
      expect(asignada.alternativas.map((a) => a.campo)).toEqual(
        expect.arrayContaining(['cantidad', 'piezas']),
      );
    },
  );

  it('el rótulo inequívoco PIEZAS no se convierte en cantidad por conveniencia', () => {
    const tabla = tablaConUnidades();
    tabla[2] = columna('Piezas', ['4', '2', '3'], 0.50, 0.58);

    expect(asignarSemantica(tabla)[2].campo).toBe('piezas');
  });

  it('un renglón dañado no vence a los que sostienen el uso de la columna', () => {
    const tabla = tablaConUnidades();
    tabla[4] = columna(
      'Importe',
      ['22.800,00', '19.200,00', '99.999,99'],
      0.82,
      0.95,
    );

    expect(asignarSemantica(tabla)[2].campo).toBe('cantidad');
  });

  it('el neto global no puede convertir piezas en la cantidad del renglón', () => {
    const tabla = tablaConUnidades();
    tabla.splice(2, 0, columna('Cantidad', ['20', '30', '15'], 0.46, 0.51));
    tabla[4] = columna('Precio', ['1.000,00', '2.000,00', '3.000,00'], 0.65, 0.76);
    tabla[5] = columna('Importe', ['20.000,00', '60.000,00', '45.000,00'], 0.82, 0.95);

    const asignadas = asignarSemantica(tabla, {
      // Coincide a propósito con la suma de las piezas y no con el detalle.
      netosPosibles: [new Decimal(9)],
    });
    expect(asignadas[2].campo).toBe('cantidad');
    expect(asignadas[3].campo).toBe('piezas');
  });

  it('funciona de punta a punta sobre las cajas de la tabla', () => {
    const informe = interpretarReconstruccion(
      comprobante(TITULOS_UNIDADES, RENGLONES, '71.400,00'),
      {
      cuitDelReceptor: '27-33342291-9',
      },
    );
    const campos = informe.tabla.columnas.map((c) => c.campo?.campo ?? null);
    const renglones = informe.veredicto.ganadora?.renglones ?? [];

    expect(campos).toContain('cantidad');
    expect(campos).not.toContain('piezas');
    expect(renglones).toHaveLength(3);
    expect(renglones.map((r) => r.cantidad?.toString())).toEqual(['4', '2', '3']);
    expect(
      renglones.every(
        (r) => r.controles.length > 0 && r.controles.every((control) => control.paso),
      ),
    ).toBe(true);
    expect(informe.veredicto.ganadora?.sumaDeRenglones.toString()).toBe('71400');
    expect(renglones.map((r) => r.cantidadFacturada?.toString())).toEqual(['4', '2', '3']);
    expect(renglones.map((r) => r.campoCantidadFacturada)).toEqual([
      'cantidad',
      'cantidad',
      'cantidad',
    ]);
    expect(renglones.map((r) => r.unidadFacturada)).toEqual(['UNIT', 'UNIT', 'UNIT']);
    expect(renglones.every((r) => r.unidadDeStock === null)).toBe(true);
  });

  it('UNIDADES no inventa la unidad de stock: pide asociar el producto una vez por renglón', () => {
    const informe = interpretarReconstruccion(
      comprobante(TITULOS_UNIDADES, RENGLONES, '71.400,00'),
      { cuitDelReceptor: '27-33342291-9' },
    );
    const raices = soloRaices(informe.pendientes);

    expect(informe.veredicto.decision).toBe('revision-de-estructura');
    expect(raices.filter((p) => p.categoria === 'BLOCKING_PRODUCT')).toHaveLength(3);
    expect(raices.filter((p) => p.categoria === 'BLOCKING_UNIT')).toHaveLength(0);
    expect(informe.resumen.desglose.asociacionesDeProductoPendientes).toBe(3);
    expect(informe.resumen.desglose.unidadesPendientes).toBe(0);
  });

  it('con productos y unidades inequívocos, los mismos renglones pueden aceptarse', () => {
    const informe = interpretarReconstruccion(
      comprobante(TITULOS_UNIDADES, RENGLONES, '71.400,00'),
      {
        cuitDelReceptor: '27-33342291-9',
        asociacionesDeProducto: asociacionesDePrueba(3, 'UNIT'),
      },
    );
    const renglones = informe.veredicto.ganadora?.renglones ?? [];

    expect(informe.veredicto.decision).toBe('automatica');
    expect(
      soloRaices(informe.pendientes).filter(
        (p) => p.categoria === 'BLOCKING_PRODUCT' || p.categoria === 'BLOCKING_UNIT',
      ),
    ).toHaveLength(0);
    expect(renglones.map((r) => r.productoId)).toEqual([
      'producto-1',
      'producto-2',
      'producto-3',
    ]);
    expect(renglones.map((r) => r.unidadDeStock)).toEqual(['UNIT', 'UNIT', 'UNIT']);
  });

  it('un producto asociado sin unidad produce BLOCKING_UNIT, no otro BLOCKING_PRODUCT', () => {
    const informe = interpretarReconstruccion(
      comprobante(TITULOS_UNIDADES, RENGLONES, '71.400,00'),
      {
        cuitDelReceptor: '27-33342291-9',
        asociacionesDeProducto: asociacionesDePrueba([null, null, null]),
      },
    );
    const raices = soloRaices(informe.pendientes);

    expect(raices.filter((p) => p.categoria === 'BLOCKING_PRODUCT')).toHaveLength(0);
    expect(raices.filter((p) => p.categoria === 'BLOCKING_UNIT')).toHaveLength(3);
    expect(informe.veredicto.decision).toBe('revision-de-estructura');
  });

  it('producto faltante y unidad faltante son acciones disjuntas, no dos preguntas por fila', () => {
    const informe = interpretarReconstruccion(
      comprobante(TITULOS_UNIDADES, RENGLONES, '71.400,00'),
      {
        cuitDelReceptor: '27-33342291-9',
        asociacionesDeProducto: [
          { renglon: 1, productoId: 'uno', unidadDeStock: 'UNIT' },
          { renglon: 2, productoId: 'dos', unidadDeStock: null },
        ],
      },
    );
    const porRenglon = soloRaices(informe.pendientes)
      .filter((p) => p.categoria === 'BLOCKING_PRODUCT' || p.categoria === 'BLOCKING_UNIT')
      .map((p) => [p.renglon, p.categoria]);

    expect(porRenglon).toEqual([
      [2, 'BLOCKING_UNIT'],
      [3, 'BLOCKING_PRODUCT'],
    ]);
  });

  it('kilos y piezas se conservan separados y sólo los kilos se facturan', () => {
    const titulos: [string, number][] = [
      ['Codigo', 0.04],
      ['Descripcion', 0.16],
      ['Kilos', 0.44],
      ['Piezas', 0.55],
      ['Precio', 0.68],
      ['Importe', 0.84],
    ];
    const datos: [string, number][][] = [
      [['1', 0.04], ['QUESO A', 0.16], ['4,5', 0.44], ['2', 0.55], ['1.000,00', 0.68], ['4.500,00', 0.84]],
      [['2', 0.04], ['QUESO B', 0.16], ['3', 0.44], ['1', 0.55], ['2.000,00', 0.68], ['6.000,00', 0.84]],
      [['3', 0.04], ['QUESO C', 0.16], ['2,5', 0.44], ['4', 0.55], ['3.000,00', 0.68], ['7.500,00', 0.84]],
    ];
    const informe = interpretarReconstruccion(comprobante(titulos, datos, '18.000,00'), {
      cuitDelReceptor: '27-33342291-9',
      asociacionesDeProducto: asociacionesDePrueba(3),
    });
    const renglones = informe.veredicto.ganadora?.renglones ?? [];

    expect(renglones.map((r) => r.cantidadFacturada?.toString())).toEqual(['4.5', '3', '2.5']);
    expect(renglones.map((r) => r.campoCantidadFacturada)).toEqual(['kilos', 'kilos', 'kilos']);
    expect(renglones.map((r) => r.unidadFacturada)).toEqual(['KG', 'KG', 'KG']);
    expect(renglones.map((r) => r.piezas)).toEqual([2, 1, 4]);
    expect(renglones.every((r) => r.controles.every((c) => c.paso))).toBe(true);
  });

  it('PIEZAS puede ser cantidad facturada si no existe otra cantidad', () => {
    const titulos = TITULOS_UNIDADES.map(([texto, x]) => [texto === 'UNIDADES' ? 'Piezas' : texto, x] as [string, number]);
    const informe = interpretarReconstruccion(comprobante(titulos, RENGLONES, '71.400,00'), {
      cuitDelReceptor: '27-33342291-9',
      asociacionesDeProducto: asociacionesDePrueba(3, 'UNIT'),
    });
    const renglones = informe.veredicto.ganadora?.renglones ?? [];

    expect(renglones.map((r) => r.campoCantidadFacturada)).toEqual(['piezas', 'piezas', 'piezas']);
    expect(renglones.map((r) => r.unidadFacturada)).toEqual(['UNIT', 'UNIT', 'UNIT']);
    expect(renglones.every((r) => r.controles.some((c) => c.nombre === 'cantidad-por-precio' && c.paso))).toBe(true);
  });

  it('si imprime kilos y cantidad, factura la que demuestra la cuenta y no la primera columna', () => {
    const titulos: [string, number][] = [
      ['Codigo', 0.04],
      ['Descripcion', 0.16],
      ['Kilos', 0.42],
      ['Cantidad', 0.54],
      ['Precio', 0.68],
      ['Importe', 0.84],
    ];
    const datos: [string, number][][] = [
      [['1', 0.04], ['ARTICULO A', 0.16], ['10', 0.42], ['2', 0.54], ['100,00', 0.68], ['200,00', 0.84]],
      [['2', 0.04], ['ARTICULO B', 0.16], ['20', 0.42], ['3', 0.54], ['100,00', 0.68], ['300,00', 0.84]],
      [['3', 0.04], ['ARTICULO C', 0.16], ['30', 0.42], ['4', 0.54], ['100,00', 0.68], ['400,00', 0.84]],
    ];
    const informe = interpretarReconstruccion(comprobante(titulos, datos, '900,00'), {
      cuitDelReceptor: '27-33342291-9',
      asociacionesDeProducto: asociacionesDePrueba(3, 'UNIT'),
    });
    const renglones = informe.veredicto.ganadora?.renglones ?? [];

    expect(renglones.map((r) => r.kilos?.toString())).toEqual(['10', '20', '30']);
    expect(renglones.map((r) => r.cantidadFacturada?.toString())).toEqual(['2', '3', '4']);
    expect(renglones.map((r) => r.campoCantidadFacturada)).toEqual([
      'cantidad',
      'cantidad',
      'cantidad',
    ]);
    expect(renglones.every((r) => r.controles.every((c) => c.paso))).toBe(true);
  });

  it('si dos magnitudes hacen la misma cuenta, no elige una por orden', () => {
    const titulos: [string, number][] = [
      ['Codigo', 0.04],
      ['Descripcion', 0.16],
      ['Kilos', 0.42],
      ['Cantidad', 0.54],
      ['Precio', 0.68],
      ['Importe', 0.84],
    ];
    const datos: [string, number][][] = [
      [['1', 0.04], ['ARTICULO A', 0.16], ['2', 0.42], ['2', 0.54], ['100,00', 0.68], ['200,00', 0.84]],
      [['2', 0.04], ['ARTICULO B', 0.16], ['3', 0.42], ['3', 0.54], ['100,00', 0.68], ['300,00', 0.84]],
      [['3', 0.04], ['ARTICULO C', 0.16], ['4', 0.42], ['4', 0.54], ['100,00', 0.68], ['400,00', 0.84]],
    ];
    const informe = interpretarReconstruccion(comprobante(titulos, datos, '900,00'), {
      cuitDelReceptor: '27-33342291-9',
      asociacionesDeProducto: asociacionesDePrueba(3, 'UNIT'),
    });

    expect(informe.veredicto.decision).toBe('revision-de-estructura');
    expect(informe.veredicto.margen).toBe(0);
    expect(informe.veredicto.ganadora?.renglones[0].campoCantidadFacturada).not.toBe(
      informe.veredicto.segunda?.renglones[0].campoCantidadFacturada,
    );
  });

  it('una descripción que menciona kilos no inventa la unidad de una CANTIDAD genérica', () => {
    const datos = RENGLONES.map((r, i) =>
      i === 0 ? r.map(([texto, x], j) => [j === 1 ? 'BOLSA KG GRANDE' : texto, x] as [string, number]) : r,
    );
    const informe = interpretarReconstruccion(
      comprobante(
        TITULOS_UNIDADES.map(([texto, x]) => [texto === 'UNIDADES' ? 'Cantidad' : texto, x]),
        datos,
        '71.400,00',
      ),
      {
        cuitDelReceptor: '27-33342291-9',
        asociacionesDeProducto: asociacionesDePrueba(3),
      },
    );

    expect(informe.veredicto.ganadora?.renglones[0].unidadFacturada).toBeNull();
    expect(informe.veredicto.ganadora?.renglones[0].unidadDeStock).toBe('KG');
  });

  it('asociar productos no cambia ningún valor leído del comprobante', () => {
    const entrada = comprobante(TITULOS_UNIDADES, RENGLONES, '71.400,00');
    const antes = interpretarReconstruccion(entrada, { cuitDelReceptor: '27-33342291-9' });
    const despues = interpretarReconstruccion(entrada, {
      cuitDelReceptor: '27-33342291-9',
      asociacionesDeProducto: asociacionesDePrueba(3, 'UNIT'),
    });
    const firma = (informe: ReturnType<typeof interpretarReconstruccion>) =>
      (informe.veredicto.ganadora?.renglones ?? []).map((r) => [
        r.codigo,
        r.descripcion,
        r.cantidadFacturada?.toString(),
        r.campoCantidadFacturada,
        r.unidadFacturada,
        r.piezas,
        r.precioUnitario?.toString(),
        r.importe?.toString(),
      ]);

    expect(firma(despues)).toEqual(firma(antes));
  });

  it('dos asociaciones contradictorias no se resuelven por orden de llegada', () => {
    const informe = interpretarReconstruccion(
      comprobante(TITULOS_UNIDADES, RENGLONES, '71.400,00'),
      {
        cuitDelReceptor: '27-33342291-9',
        asociacionesDeProducto: [
          { renglon: 1, productoId: 'producto-a', unidadDeStock: 'UNIT' },
          { renglon: 1, productoId: 'producto-b', unidadDeStock: 'UNIT' },
          ...asociacionesDePrueba(3, 'UNIT').slice(1),
        ],
      },
    );

    expect(informe.veredicto.ganadora?.renglones[0].productoId).toBeNull();
    expect(
      soloRaices(informe.pendientes).filter(
        (p) => p.renglon === 1 && p.categoria === 'BLOCKING_PRODUCT',
      ),
    ).toHaveLength(1);
  });
});
