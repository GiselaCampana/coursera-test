import { describe, it, expect } from 'vitest';
import { Decimal } from '@/lib/money';
import {
  candidatasDeRenglon,
  controlarRenglon,
  decidir,
  netoDelRenglon,
  puntuarTabla,
  type CandidataDeTabla,
  type RenglonCandidato,
} from '@/lib/ocr/motor/candidatas';
import {
  compararCandidatas,
  escalaIndecidible,
  factorDeEscala,
  rasgosDe,
} from '@/lib/ocr/motor/orden-lexicografico';
import { formatoDeColumna, lecturasDeCelda } from '@/lib/ocr/motor/formato-de-columna';
import type { ColumnaReconocida } from '@/lib/ocr/motor/columnas';
import type { FilaDeDatos } from '@/lib/ocr/motor/tabla';

/**
 * El orden de preferencias, y por qué no puede ser una suma.
 *
 * Todo este archivo existe por un error concreto: una lectura de la factura de
 * Lácteos Barraza en la que se ignoran todos los separadores decimales cierra
 * consigo misma igual de bien que la verdadera, con todos los números cien
 * veces más grandes. Con una suma de puntajes empata; con un orden
 * lexicográfico pierde, porque necesita suponer que el OCR perdió el separador
 * de cada número del papel.
 *
 * Las pruebas de acá no usan nombres de proveedor ni valores esperados de
 * ningún fixture: arman las dos lecturas a mano y comprueban cuál gana.
 */

function columna(campo: string, encabezado: string): ColumnaReconocida {
  return {
    encabezado,
    campo: campo as ColumnaReconocida['campo'],
    confianza: 1,
    origen: 'EXACT_HEADER',
  };
}

function renglon(parcial: Partial<RenglonCandidato>): RenglonCandidato {
  const base: RenglonCandidato = {
    codigo: null,
    descripcion: 'ARTICULO',
    marca: null,
    cantidad: null,
    kilos: null,
    piezas: null,
    precioUnitario: null,
    descuentoPct: null,
    precioConDescuento: null,
    importe: null,
    descuentoEnElImporte: null,
    reparaciones: 0,
    severidad: 0,
    incoherentes: 0,
    escalasAjenas: 0,
    controles: [],
    ...parcial,
  };
  base.controles = controlarRenglon(base);
  return base;
}

function tabla(renglones: RenglonCandidato[], neto: Decimal | null): CandidataDeTabla {
  const { puntaje, penalizaciones, sumaDeRenglones, cierre } = puntuarTabla(renglones, {
    netTotal: neto,
    filasVistas: renglones.length,
  });
  return {
    convencion: 'ar',
    pie: { netTotal: neto, ivaTotal: null, percepciones: null, total: null, ignorados: [] },
    renglones,
    puntaje,
    penalizaciones,
    sumaDeRenglones,
    cierre,
    reparaciones: renglones.reduce((n, r) => n + r.reparaciones, 0),
  };
}

/**
 * Las dos lecturas del mismo papel: la literal y la que multiplica por cien.
 *
 * Las dos cumplen cantidad × precio = importe, porque la proporción se mantiene
 * al correr el separador de los dos factores del mismo lado. Es justo lo que
 * hace que la aritmética del renglón no pueda distinguirlas sola.
 */
function dosEscalas() {
  const literal = tabla(
    [
      renglon({
        cantidad: new Decimal('2'),
        precioUnitario: new Decimal('1036.45'),
        importe: new Decimal('2072.90'),
        reparaciones: 0,
        severidad: 0,
      }),
      renglon({
        cantidad: new Decimal('3'),
        precioUnitario: new Decimal('500.10'),
        importe: new Decimal('1500.30'),
        reparaciones: 0,
        severidad: 0,
      }),
    ],
    new Decimal('3573.20'),
  );

  const porCien = tabla(
    [
      renglon({
        cantidad: new Decimal('2'),
        precioUnitario: new Decimal('103645'),
        importe: new Decimal('207290'),
        // Necesita suponer que el OCR perdió el separador de los dos números.
        reparaciones: 2,
        severidad: 1,
      }),
      renglon({
        cantidad: new Decimal('3'),
        precioUnitario: new Decimal('50010'),
        importe: new Decimal('150030'),
        reparaciones: 2,
        severidad: 1,
      }),
    ],
    new Decimal('357320'),
  );

  return { literal, porCien };
}

describe('una interpretación cien veces mayor que cierra consigo misma', () => {
  it('pierde contra la literal, aunque las dos cierren igual de bien', () => {
    const { literal, porCien } = dosEscalas();

    // Las dos cierran contra su propio pie: ninguna de las dos se descarta por
    // aritmética, que es exactamente el problema.
    expect(literal.cierre?.compatible).toBe(true);
    expect(porCien.cierre?.compatible).toBe(true);
    expect(factorDeEscala(literal, porCien)).toBeCloseTo(100, 0);

    // Y con el orden lexicográfico gana la literal, por el nivel 3: menos
    // reparaciones.
    expect(compararCandidatas(literal, porCien)).toBeLessThan(0);
    const veredicto = decidir([porCien, literal]);
    expect(veredicto.ganadora).toBe(literal);
  });

  it('no gana ni cuando es la única que cierra contra el pie', () => {
    /*
     * El caso que obliga a que el cierre esté sexto y no primero: se le saca el
     * cierre a la literal —un pie impreso que no coincide con su suma, como
     * pasa cuando falta un renglón— y la de escala cien sigue cerrando consigo
     * misma. Con una suma de puntajes gana la que cierra. Con el orden, no:
     * cerrar no paga las reparaciones.
     */
    const { porCien } = dosEscalas();
    const literalSinCierre = tabla(
      [
        renglon({
          cantidad: new Decimal('2'),
          precioUnitario: new Decimal('1036.45'),
          importe: new Decimal('2072.90'),
        }),
        renglon({
          cantidad: new Decimal('3'),
          precioUnitario: new Decimal('500.10'),
          importe: new Decimal('1500.30'),
        }),
      ],
      // Un pie que no cierra con la suma.
      new Decimal('4000.00'),
    );

    expect(literalSinCierre.cierre?.compatible).toBe(false);
    expect(porCien.cierre?.compatible).toBe(true);
    expect(porCien.puntaje).toBeGreaterThan(literalSinCierre.puntaje);

    // Y pierde igual.
    expect(compararCandidatas(literalSinCierre, porCien)).toBeLessThan(0);
    expect(decidir([porCien, literalSinCierre]).ganadora).toBe(literalSinCierre);
  });

  it('si sólo existe la de escala cien y no hay evidencia para decidir, queda en revisión', () => {
    /*
     * Cuando las dos escalas están completas, cierran las dos y **ninguna tiene
     * más evidencia literal que la otra**, el papel no alcanza para elegir. Eso
     * tiene que ir a revisión: elegir por magnitud —la más grande, la más
     * chica, la que se parece al total— es tirar una moneda con el costo de
     * cada artículo.
     */
    const unaEscala = tabla(
      [
        renglon({
          cantidad: new Decimal('2'),
          precioUnitario: new Decimal('1036.45'),
          importe: new Decimal('2072.90'),
          reparaciones: 1,
          severidad: 1,
        }),
      ],
      new Decimal('2072.90'),
    );
    const laOtra = tabla(
      [
        renglon({
          cantidad: new Decimal('2'),
          precioUnitario: new Decimal('103645'),
          importe: new Decimal('207290'),
          reparaciones: 1,
          severidad: 1,
        }),
      ],
      new Decimal('207290'),
    );

    expect(escalaIndecidible(unaEscala, laOtra)).toBe(true);

    // Y cuando una **sí** se lee al pie de la letra, no hay nada que revisar:
    // el nivel 4 decide y pedirle a una persona que confirme lo que el papel
    // dice sería trabajo inventado.
    const { literal, porCien } = dosEscalas();
    expect(escalaIndecidible(literal, porCien)).toBe(false);
  });

  it('no se elige por magnitud: dar vuelta el orden de entrada no cambia quién gana', () => {
    const { literal, porCien } = dosEscalas();
    expect(decidir([literal, porCien]).ganadora).toBe(literal);
    expect(decidir([porCien, literal]).ganadora).toBe(literal);
  });
});

describe('el orden es lexicográfico, no una suma', () => {
  it('un renglón real perdido no se compensa con nada', () => {
    /*
     * Nivel 1. Una lectura que cierra perfecto pero se comió un artículo pierde
     * contra una que conserva los dos y no cierra: el artículo que no está es
     * un artículo que la persona no ve y no carga, y ninguna cuenta lo repone.
     */
    const conLosDos = tabla(
      [
        renglon({
          cantidad: new Decimal('2'),
          precioUnitario: new Decimal('100'),
          importe: new Decimal('200'),
        }),
        renglon({ descripcion: 'OTRO', importe: new Decimal('300') }),
      ],
      new Decimal('1000'),
    );
    const conUno = tabla(
      [
        renglon({
          cantidad: new Decimal('2'),
          precioUnitario: new Decimal('100'),
          importe: new Decimal('200'),
        }),
      ],
      new Decimal('200'),
    );

    expect(conUno.cierre?.compatible).toBe(true);
    expect(conLosDos.cierre?.compatible).toBe(false);
    expect(conUno.puntaje).toBeGreaterThan(conLosDos.puntaje);
    expect(compararCandidatas(conLosDos, conUno)).toBeLessThan(0);
  });

  it('a igual cantidad de renglones gana la que comprueba más contra su aritmética', () => {
    // Nivel 2, que va antes del cierre contra el pie.
    const comprobada = tabla(
      [
        renglon({
          cantidad: new Decimal('2'),
          precioUnitario: new Decimal('100'),
          importe: new Decimal('200'),
        }),
      ],
      new Decimal('500'),
    );
    const sinComprobar = tabla([renglon({ importe: new Decimal('500') })], new Decimal('500'));

    expect(rasgosDe(comprobada).comprobados).toBe(1);
    expect(rasgosDe(sinComprobar).comprobados).toBe(0);
    expect(sinComprobar.cierre?.compatible).toBe(true);
    expect(compararCandidatas(comprobada, sinComprobar)).toBeLessThan(0);
  });

  it('la severidad no se compensa: una celda fuera de escala pesa aunque las otras estén bien', () => {
    /*
     * Nivel 3, segunda mitad. Dos lecturas con la misma cantidad de
     * reparaciones, una con la peor de ellas dentro de la escala de su columna
     * y la otra con una celda cien veces afuera.
     */
    const suave = tabla(
      [
        renglon({
          cantidad: new Decimal('2'),
          precioUnitario: new Decimal('100'),
          importe: new Decimal('200'),
          reparaciones: 1,
          severidad: 1,
        }),
      ],
      null,
    );
    const grave = tabla(
      [
        renglon({
          cantidad: new Decimal('2'),
          precioUnitario: new Decimal('100'),
          importe: new Decimal('200'),
          reparaciones: 1,
          severidad: 3,
        }),
      ],
      null,
    );
    expect(compararCandidatas(suave, grave)).toBeLessThan(0);
  });

  it('con todo empatado hasta el nivel cinco, ahí sí decide el cierre', () => {
    /*
     * El cierre no es decorativo: cuando nada antes lo distingue, es lo que
     * elige. Lo que no puede es pagar reparaciones ni renglones perdidos.
     */
    const cierra = tabla([renglon({ importe: new Decimal('500') })], new Decimal('500'));
    const noCierra = tabla([renglon({ importe: new Decimal('500') })], new Decimal('900'));
    expect(rasgosDe(cierra).comprobados).toBe(rasgosDe(noCierra).comprobados);
    expect(rasgosDe(cierra).reparaciones).toBe(rasgosDe(noCierra).reparaciones);
    expect(compararCandidatas(cierra, noCierra)).toBeLessThan(0);
  });
});

describe('el formato de una columna lo definen sus propios valores', () => {
  const precios = ['8.090,08', '9.659,63', '19.871,90', '6.933,06', '12.689,14', '52293041'];

  it('una columna conserva una sola convención decimal en todos sus renglones', () => {
    const formato = formatoDeColumna(precios)!;
    expect(formato).not.toBeNull();
    expect(formato.separador).toBe('coma');
    expect(formato.decimales).toBe(2);
    // La mayoría de los valores literales y coherentes define el formato: el
    // mutilado no vota.
    expect(formato.apoyos).toBe(5);
  });

  it('un valor mutilado se recupera con el formato de la columna, no con el total', () => {
    /*
     * «52293041» sin separadores admite muchas lecturas. Lo que decide no es
     * cuál se acerca al pie: es que la columna pone dos decimales, así que la
     * lectura que respeta el formato es 522.930,41. Después la aritmética del
     * renglón elige entre ésa y las demás.
     */
    const formato = formatoDeColumna(precios)!;
    const lecturas = lecturasDeCelda('52293041', formato);
    const comoLaColumna = lecturas.find((l) => l.valor.toFixed(2) === '522930.41');
    expect(comoLaColumna).toBeDefined();
    expect(comoLaColumna!.comoSeLeyo).toContain('donde lo pone el resto de la columna');
    expect(comoLaColumna!.coherente).toBe(true);

    /*
     * La lectura literal —los ocho dígitos como un entero— **sigue existiendo**
     * y sigue diciendo que es literal, porque lo es: el papel no tiene ningún
     * separador ahí. Lo que la desmiente no es que sea imposible, es que
     * ninguno de sus vecinos de columna escribe así.
     */
    const cruda = lecturas.find((l) => l.valor.toFixed(2) === '52293041.00');
    expect(cruda!.literal).toBe(true);
    expect(cruda!.coherente).toBe(false);

    // Y la que respeta la columna se ofrece primero, aunque no sea la literal.
    expect(lecturas[0].valor.toFixed(2)).toBe('522930.41');
  });

  it('una lectura que se va cien veces de la magnitud de la columna queda marcada como grave', () => {
    const formato = formatoDeColumna(precios)!;
    const lecturas = lecturasDeCelda('52293041', formato);
    const enEscala = lecturas.find((l) => l.valor.lt(1000000));
    const fueraDeEscala = lecturas.find((l) => l.valor.gt(5000000));
    expect(enEscala!.severidad).toBeLessThan(3);
    expect(fueraDeEscala?.severidad).toBe(3);
    // Y la lista sale ordenada por severidad, así que la grave nunca es la
    // primera que se ofrece.
    expect(lecturas[0].severidad).toBeLessThan(3);
  });

  it('sin mayoría no hay formato, y no se inventa uno', () => {
    // Dos renglones no definen nada. Devolver un formato acá sería convertir la
    // casualidad de una tabla corta en una regla para sus celdas dudosas.
    expect(formatoDeColumna(['12.345,67'])).toBeNull();
    expect(formatoDeColumna(['123', '456'])).not.toBeNull();
  });

  it('un valor mutilado que admite dos lecturas equivalentes no se repara solo', () => {
    /*
     * Éste es el negativo que importa. La celda dice «1500» y la columna pone
     * dos decimales: 15,00 respeta el formato, pero 1.500,00 —un valor entero,
     * perfectamente posible en una columna de importes— también. El motor tiene
     * que **ofrecer las dos** y no elegir; quien elige es la aritmética del
     * renglón, y si el renglón no alcanza, queda como bloqueo.
     */
    const formato = formatoDeColumna(['15,00', '1.500,00', '150,00', '1.234,56'])!;
    const lecturas = lecturasDeCelda('1500', formato);
    const valores = lecturas.map((l) => l.valor.toFixed(2));
    expect(valores).toContain('15.00');
    expect(valores).toContain('1500.00');

    /*
     * Y cada una queda con lo que la sostiene, sin que ninguna se presente como
     * resuelta: «1500» es la lectura literal —cero reparaciones— y es la que no
     * se parece a su columna; «15,00» respeta la columna y para eso hay que
     * suponer un separador. Ninguna de las dos puede decir que es la correcta,
     * y eso es el punto: si el renglón no las distingue, la celda queda como
     * bloqueo en vez de resolverse por casualidad.
     */
    const mil = lecturas.find((l) => l.valor.toFixed(2) === '1500.00')!;
    const quince = lecturas.find((l) => l.valor.toFixed(2) === '15.00')!;
    expect([mil.literal, mil.coherente]).toEqual([true, false]);
    expect([quince.literal, quince.coherente]).toEqual([false, true]);
  });

  it('el cero no es una lectura', () => {
    // Una celda que quedó en separadores sueltos no vale cero: vale nada, y
    // tiene que pedirse. Un importe de cero suma cero y no rompe ninguna
    // igualdad, así que pasa inadvertido.
    expect(lecturasDeCelda(',', null)).toHaveLength(0);
    expect(lecturasDeCelda('0,00', null)).toHaveLength(0);
  });
});

describe('el formato de columna llega hasta el renglón', () => {
  it('la celda mutilada se lee dentro del formato y la aritmética del renglón elige', () => {
    /*
     * El circuito completo, sin proveedores ni fixtures: una columna de precios
     * que imprime dos decimales, una celda a la que el OCR le comió los
     * separadores, y un importe y una cantidad que sólo cierran con una de las
     * lecturas posibles.
     *
     * 2 × 522,93 = 1.045,86. La celda dice «52293».
     */
    const columnas = [
      columna('descripcion', 'Descripción'),
      columna('cantidad', 'Cant'),
      columna('precioUnitario', 'Precio'),
      columna('importe', 'Importe'),
    ];
    const fila: FilaDeDatos = {
      linea: 0,
      cruda: 'ARTICULO  2  52293  1.045,86',
      celdas: [
        { texto: 'ARTICULO', desde: 0, hasta: 8 },
        { texto: '2', desde: 10, hasta: 11 },
        { texto: '52293', desde: 13, hasta: 18 },
        { texto: '1.045,86', desde: 20, hasta: 28 },
      ],
      sobrantes: [],
    };

    const formatos = new Map([
      ['precioUnitario', formatoDeColumna(['522,93', '118,40', '96,15', '1.204,00'])!],
    ] as const);

    const candidatas = candidatasDeRenglon(fila, columnas, 'ar', formatos as never);
    const cierran = candidatas.filter(
      (c) => c.controles.length > 0 && c.controles.every((k) => k.paso),
    );
    expect(cierran.length).toBeGreaterThan(0);
    expect(cierran[0].precioUnitario?.toFixed(2)).toBe('522.93');
    // Y queda dicho que hubo que suponer algo: no se leyó tal como está impreso.
    expect(cierran[0].reparaciones).toBeGreaterThan(0);
  });
});

describe('un descuento imposible no es un descuento', () => {
  const columnas = [
    columna('descripcion', 'Descripción'),
    columna('cantidad', 'Cant'),
    columna('precioUnitario', 'Precio'),
    columna('descuentoPct', 'Bonif'),
    columna('importe', 'Importe'),
  ];

  function filaCon(descuento: string): FilaDeDatos {
    return {
      linea: 0,
      cruda: `ARTICULO 10 100,00 ${descuento} 1.000,00`,
      celdas: [
        { texto: 'ARTICULO', desde: 0, hasta: 8 },
        { texto: '10', desde: 10, hasta: 12 },
        { texto: '100,00', desde: 14, hasta: 20 },
        { texto: descuento, desde: 22, hasta: 22 + descuento.length },
        { texto: '1.000,00', desde: 30, hasta: 38 },
      ],
      sobrantes: [],
    };
  }

  it('una celda de bonificación leída «629» no genera un descuento de 629 %', () => {
    /*
     * El error que esto impide es silencioso, que es lo que lo hace grave. Con
     * 629 % de bonificación el neto del renglón sale **negativo** —importe ×
     * (1 − 6,29)— y un negativo grande se compensa en la suma con otro renglón
     * leído de más: el comprobante cierra contra el pie impreso con artículos
     * de costo negativo adentro. Sobre una factura del banco eso dejaba la suma
     * a dos décimas del neto y cuatro artículos con costo negativo.
     *
     * No se corrige el valor ni se lo aproxima: la lectura se descarta y el
     * renglón se interpreta sin descuento.
     */
    const candidatas = candidatasDeRenglon(filaCon('629'), columnas, 'ar');
    expect(candidatas.length).toBeGreaterThan(0);
    for (const candidata of candidatas) {
      expect(candidata.descuentoPct === null || candidata.descuentoPct.lte(1)).toBe(true);
      const neto = netoDelRenglon(candidata);
      expect(neto === null || neto.gte(0)).toBe(true);
    }
  });

  it('un descuento normal sí entra', () => {
    // El control de al lado: la regla no puede tirar los descuentos buenos.
    const candidatas = candidatasDeRenglon(filaCon('16,00'), columnas, 'ar');
    expect(candidatas.some((c) => c.descuentoPct?.toFixed(2) === '0.16')).toBe(true);
  });

  it('un renglón no puede valer menos que nada', () => {
    /*
     * La red de seguridad, probada por su cuenta. Con el descuento acotado esto
     * no debería dispararse nunca, y está igual porque el daño de un neto
     * negativo no rompe ninguna igualdad: se compensa y pasa inadvertido.
     */
    const imposible = renglon({
      importe: new Decimal('1000'),
      descuentoPct: new Decimal('6.29'),
      descuentoEnElImporte: false,
    });
    expect(netoDelRenglon(imposible)).toBeNull();
  });
});
