import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Decimal } from '@/lib/money';
import {
  controlarRenglon,
  netoDelRenglon,
  type RenglonCandidato,
} from '@/lib/ocr/motor/candidatas';
import {
  DERIVED_SUGGESTION,
  renglonConfirmado,
  sugerenciasDerivadas,
} from '@/lib/ocr/motor/sugerencias';
import { interpretarReconstruccion } from '@/lib/ocr/motor/desde-reconstruccion';
import type { EvidenciaDeLectura } from '@/lib/ocr/reconstruccion/evidencia';

/**
 * La aritmética selecciona evidencia; no inventa datos.
 *
 * Es la distinción que sostiene todo el motor. Usar la cuenta del renglón para
 * elegir entre dos lecturas de la misma celda es leer la factura mejor; usarla
 * para calcular el valor de una celda que no se leyó es rellenarla. La cuenta
 * siempre da, así que el segundo camino produce comprobantes que cierran
 * perfecto y costos inventados.
 */

const DIRECTORIO = path.resolve(__dirname, '../fixtures/evidencia');

function renglon(parcial: Partial<RenglonCandidato>): RenglonCandidato {
  const base: RenglonCandidato = {
    codigo: null,
    descripcion: 'ARTICULO',
    marca: null,
    cantidad: null,
    kilos: null,
    piezas: null,
    cantidadFacturada: null,
    campoCantidadFacturada: null,
    unidadFacturada: null,
    productoId: null,
    unidadDeStock: null,
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
  if (!Object.prototype.hasOwnProperty.call(parcial, 'cantidadFacturada')) {
    base.cantidadFacturada = base.kilos ?? base.cantidad ??
      (base.piezas === null ? null : new Decimal(base.piezas));
    base.campoCantidadFacturada = base.kilos
      ? 'kilos'
      : base.cantidad
        ? 'cantidad'
        : base.piezas === null
          ? null
          : 'piezas';
  }
  base.controles = controlarRenglon(base);
  return base;
}

describe('el valor calculado es una sugerencia, no un dato', () => {
  it('se calcula cuando falta uno de los tres y los otros dos se leyeron', () => {
    const sinPrecio = renglon({
      cantidad: new Decimal('12'),
      importe: new Decimal('1440'),
    });
    const [sugerencia] = sugerenciasDerivadas([sinPrecio]);

    expect(sugerencia.clase).toBe(DERIVED_SUGGESTION);
    expect(sugerencia.campo).toBe('precioUnitario');
    expect(sugerencia.valor.toFixed(2)).toBe('120.00');
    expect(sugerencia.deDondeSale).toBe('cantidad × precio = importe');
    // Y dice con qué se calculó, para poder contrastarla contra el papel.
    expect(sugerencia.insumos.map((i) => i.campo)).toEqual(['cantidad', 'importe']);
  });

  it('no toca el renglón: la celda sigue vacía después de calcularla', () => {
    /*
     * Es la garantía estructural. La sugerencia vive en un objeto aparte, así
     * que no hay manera de que se filtre a un costo o a una compra guardada: el
     * renglón que la produjo sigue teniendo el agujero.
     */
    const sinPrecio = renglon({ cantidad: new Decimal('12'), importe: new Decimal('1440') });
    sugerenciasDerivadas([sinPrecio]);

    expect(sinPrecio.precioUnitario).toBeNull();
    expect(sinPrecio.precioConDescuento).toBeNull();
  });

  it('no valida el renglón: no aparece en sus controles ni lo da por confirmado', () => {
    const sinPrecio = renglon({ cantidad: new Decimal('12'), importe: new Decimal('1440') });
    expect(sugerenciasDerivadas([sinPrecio])).toHaveLength(1);

    // Sin precio leído no hay ninguna igualdad que comprobar, y el renglón no
    // queda confirmado por más que la cuenta dé.
    expect(sinPrecio.controles).toHaveLength(0);
    expect(renglonConfirmado(sinPrecio)).toBe(false);
  });

  it('con dos celdas faltantes no se sugiere nada', () => {
    /*
     * Con un solo dato leído la cuenta tiene infinitas soluciones, y ofrecer una
     * sería elegir al azar y presentarlo como aritmética.
     */
    expect(sugerenciasDerivadas([renglon({ importe: new Decimal('1440') })])).toHaveLength(0);
    expect(sugerenciasDerivadas([renglon({})])).toHaveLength(0);
  });

  it('con el renglón completo no se sugiere nada', () => {
    const completo = renglon({
      cantidad: new Decimal('12'),
      precioUnitario: new Decimal('120'),
      importe: new Decimal('1440'),
    });
    expect(sugerenciasDerivadas([completo])).toHaveLength(0);
  });

  it('tiene en cuenta el descuento, y lo dice', () => {
    const conDescuento = renglon({
      cantidad: new Decimal('10'),
      importe: new Decimal('840'),
      descuentoPct: new Decimal('0.16'),
    });
    const [sugerencia] = sugerenciasDerivadas([conDescuento]);
    // 840 / 0,84 / 10 = 100
    expect(sugerencia.valor.toFixed(2)).toBe('100.00');
    expect(sugerencia.deDondeSale).toContain('descuento');
  });
});

describe('el total no puede completar una celda', () => {
  it('un renglón sin importe no toma su valor del faltante contra el pie', () => {
    /*
     * El caso peor y el que da nombre a todo esto. Dos renglones, uno con
     * importe leído y otro sin nada más que su descripción, y un neto impreso
     * que deja un faltante exacto: 5.000 − 3.200 = 1.800.
     *
     * La resta da, da al centavo, y es el número correcto. Y no se puede usar:
     * no hay una sola evidencia de que ese renglón valga 1.800 —podría faltar
     * un tercer renglón, podría estar mal leído el primero, podría el pie no ser
     * el neto— y el comprobante quedaría cuadrado con un artículo inventado.
     */
    const conImporte = renglon({
      cantidad: new Decimal('2'),
      precioUnitario: new Decimal('1600'),
      importe: new Decimal('3200'),
    });
    const sinNada = renglon({ descripcion: 'EL QUE NO SE LEYO' });

    // Ni el motor de sugerencias lo ofrece —le faltan dos de los tres—…
    expect(sugerenciasDerivadas([conImporte, sinNada])).toHaveLength(0);

    // …ni el renglón adquiere un neto por estar en un comprobante que cierra.
    expect(netoDelRenglon(sinNada)).toBeNull();
    expect(sinNada.importe).toBeNull();
  });

  it('sobre la factura real, ningún bloqueo se resuelve con el valor sugerido', () => {
    /*
     * El circuito completo sobre una foto de verdad: los bloqueos que llevan
     * sugerencia siguen siendo bloqueos, la celda sigue vacía en el renglón, y
     * el motivo dice con todas las letras que el valor es calculado.
     */
    const evidencia: EvidenciaDeLectura = JSON.parse(
      readFileSync(path.join(DIRECTORIO, 'errecalde.json'), 'utf8'),
    );
    const informe = interpretarReconstruccion(evidencia, { cuitDelReceptor: '27-33342291-9' });

    const conSugerencia = informe.pendientes.filter((p) => p.sugerencia);
    expect(conSugerencia.length).toBeGreaterThan(0);

    for (const pendiente of conSugerencia) {
      expect(pendiente.categoria).toBe('BLOCKING_MISSING_CELL');
      expect(pendiente.elegido).toBeNull();
      expect(pendiente.motivo).toContain(DERIVED_SUGGESTION);
      expect(pendiente.motivo).toContain('no leído del papel');
      expect(pendiente.sugerencia!.clase).toBe(DERIVED_SUGGESTION);

      // Y el renglón que lo pide sigue sin el dato.
      const renglonReal = informe.veredicto.ganadora!.renglones[pendiente.renglon! - 1];
      const campo = pendiente.sugerencia!.campo;
      if (campo === 'importe') expect(renglonReal.importe).toBeNull();
      if (campo === 'precioUnitario') {
        expect(renglonReal.precioUnitario ?? renglonReal.precioConDescuento).toBeNull();
      }
    }
  });

  it('una sugerencia nunca se vuelve evidencia de OCR', () => {
    /*
     * No tiene caja, no tiene pasada y no tiene confianza: no hay forma de
     * confundirla con algo que estuviera impreso. Un valor calculado que
     * entrara a la lista de alternativas volvería a competir en la próxima
     * pasada como si lo hubiera leído el lector, y a la tercera vuelta nadie
     * podría decir de dónde salió.
     */
    const sinImporte = renglon({
      cantidad: new Decimal('3'),
      precioUnitario: new Decimal('500'),
    });
    const [sugerencia] = sugerenciasDerivadas([sinImporte]);
    expect(sugerencia).toBeDefined();
    expect(Object.keys(sugerencia).sort()).toEqual(
      ['campo', 'clase', 'deDondeSale', 'insumos', 'renglon', 'valor'].sort(),
    );
    expect('caja' in sugerencia).toBe(false);
    expect('pasada' in sugerencia).toBe(false);
    expect('confianza' in sugerencia).toBe(false);
  });
});

describe('cuándo una celda queda confirmada sola', () => {
  it('hace falta evidencia visual y que cierre con el renglón', () => {
    const cierra = renglon({
      cantidad: new Decimal('2'),
      precioUnitario: new Decimal('1600'),
      importe: new Decimal('3200'),
    });
    expect(renglonConfirmado(cierra)).toBe(true);

    const noCierra = renglon({
      cantidad: new Decimal('2'),
      precioUnitario: new Decimal('1600'),
      importe: new Decimal('9999'),
    });
    expect(renglonConfirmado(noCierra)).toBe(false);

    // Y un renglón sin ninguna cuenta que hacer no está confirmado: está sin
    // comprobar, que no es lo mismo.
    expect(renglonConfirmado(renglon({ importe: new Decimal('3200') }))).toBe(false);
  });

  it('no alcanza con cerrar si la lectura no se parece a su columna', () => {
    /*
     * El renglón que enseñó esto: el OCR perdió el separador decimal de la
     * cantidad **y** del importe a la vez, las dos lecturas son literales y la
     * igualdad cierra perfecto porque la proporción se mantiene. 392 × 8.090,08
     * y 3.171.124 cierran igual que 39,2 × 8.090,08 y 317.131,24.
     *
     * Sin la tercera condición ese renglón queda confirmado, diez veces más
     * caro, sin una sola reparación y con su cuenta hecha.
     */
    const enEscala = renglon({
      cantidad: new Decimal('39.2'),
      precioUnitario: new Decimal('8090.08'),
      importe: new Decimal('317131.14'),
      incoherentes: 0,
    });
    const fueraDeEscala = renglon({
      cantidad: new Decimal('392'),
      precioUnitario: new Decimal('8090.08'),
      importe: new Decimal('3171311.36'),
      incoherentes: 1,
    });

    expect(enEscala.controles.every((c) => c.paso)).toBe(true);
    expect(fueraDeEscala.controles.every((c) => c.paso)).toBe(true);

    expect(renglonConfirmado(enEscala)).toBe(true);
    expect(renglonConfirmado(fueraDeEscala)).toBe(false);
  });

  it('una lectura cien veces fuera de la magnitud de su columna no confirma', () => {
    const grave = renglon({
      cantidad: new Decimal('2'),
      precioUnitario: new Decimal('1600'),
      importe: new Decimal('3200'),
      severidad: 3,
    });
    expect(grave.controles.every((c) => c.paso)).toBe(true);
    expect(renglonConfirmado(grave)).toBe(false);
  });
});
