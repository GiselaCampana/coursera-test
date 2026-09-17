import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  interpretarReconstruccion,
  type CeldaConfirmada,
  type InformeReconstruido,
} from '@/lib/ocr/motor/desde-reconstruccion';
import type { EvidenciaDeLectura } from '@/lib/ocr/reconstruccion/evidencia';
import type { EvidenciaDeRelectura } from '@/lib/ocr/reconstruccion/relectura';
import {
  consecuenciasDe,
  soloBloqueantes,
  soloRaices,
} from '@/lib/ocr/motor/pendientes';
import {
  SALTO,
  TITULOS,
  Y_TITULOS,
  asociacionesDePrueba,
  evidencia,
  fila,
} from '@/../tests/fixtures/evidencia-sintetica';
import type { Fragmento } from '@/lib/ocr/reconstruccion/evidencia';

/**
 * Los bloqueos como **acciones humanas**, no como celdas rotas.
 *
 * Esto existe por una medición que dejó el informe inservible: cuatro cantidades
 * dañadas producían treinta y cinco bloqueos. No eran treinta y cinco
 * problemas. El precio de un renglón cuya cantidad está mal no se puede
 * decidir, su subtotal tampoco, y su cierre menos: son consecuencias de un
 * único número que hay que mirar. Contarlas todas le dice a una persona que
 * tiene media hora de trabajo cuando tiene cuatro celdas que confirmar.
 *
 * Así que cada bloqueo sabe de qué otro depende, el informe cuenta **sólo las
 * raíces** como acciones, y confirmar una raíz recalcula sus dependencias.
 */

const DIRECTORIO = path.resolve(__dirname, '../fixtures/evidencia');
const CUIT_DEL_RECEPTOR = '27-33342291-9';

function leer(nombre: string): EvidenciaDeLectura {
  return JSON.parse(readFileSync(path.join(DIRECTORIO, `${nombre}.json`), 'utf8'));
}

function relecturaDe(nombre: string): EvidenciaDeRelectura | undefined {
  const archivo = path.join(DIRECTORIO, `${nombre}-relectura.json`);
  return existsSync(archivo) ? JSON.parse(readFileSync(archivo, 'utf8')) : undefined;
}

function interpretar(nombre: string, confirmaciones: CeldaConfirmada[] = []): InformeReconstruido {
  const cantidad = nombre === 'ezra' ? 6 : nombre === 'errecalde' ? 23 : 0;
  return interpretarReconstruccion(leer(nombre), {
    cuitDelReceptor: CUIT_DEL_RECEPTOR,
    relectura: relecturaDe(nombre),
    confirmaciones,
    asociacionesDeProducto: asociacionesDePrueba(cantidad),
  });
}

const ERRECALDE = interpretar('errecalde');

/** Cómo queda cada renglón, para poder comparar antes y después. */
function retrato(informe: InformeReconstruido): string[] {
  return (informe.veredicto.ganadora?.renglones ?? []).map((r) =>
    [
      r.descripcion.trim(),
      r.codigo ?? '',
      (r.kilos ?? r.cantidad)?.toString() ?? '',
      r.piezas ?? '',
      r.precioUnitario?.toString() ?? '',
      r.importe?.toString() ?? '',
    ].join('~'),
  );
}

describe('un bloqueo sabe de qué otro depende', () => {
  it('las consecuencias no se cuentan como acciones humanas', () => {
    const bloqueantes = soloBloqueantes(ERRECALDE.pendientes);
    const raices = soloRaices(ERRECALDE.pendientes);

    /*
     * Hay bastantes más celdas frenadas que cosas que hacer, que es todo el
     * punto de separar raíces de consecuencias.
     *
     * La proporción bajó y bajó por buenas razones, así que la prueba mide lo
     * que la garantía dice y no el número de aquel día: el comprobante se lee
     * mejor —hay menos cuentas rotas— y una pregunta de columna reemplazó a
     * cuatro de celda. Lo que no puede pasar es que se cuenten las consecuencias
     * como trabajo.
     */
    expect(bloqueantes.length).toBeGreaterThan(raices.length);

    // El total que se informa son las raíces, y las consecuencias van aparte.
    expect(ERRECALDE.resumen.bloqueosUnicos).toBe(raices.length);
    expect(ERRECALDE.resumen.consecuencias).toBe(bloqueantes.length - raices.length);

    // Y las dos cuentas no se suman entre sí: juntas son los bloqueantes.
    expect(ERRECALDE.resumen.bloqueosUnicos + ERRECALDE.resumen.consecuencias).toBe(
      bloqueantes.length,
    );
  });

  it('cada consecuencia apunta a una raíz que existe, y ninguna raíz apunta a nada', () => {
    const ids = new Set(ERRECALDE.pendientes.map((p) => p.id));
    for (const pendiente of ERRECALDE.pendientes) {
      if (pendiente.dependeDe === null) continue;
      expect(ids.has(pendiente.dependeDe), pendiente.id).toBe(true);
      // Y no hay cadenas: una consecuencia depende de una raíz, no de otra
      // consecuencia. Si las hubiera, resolver la raíz no destrabaría el resto.
      const suRaiz = ERRECALDE.pendientes.find((p) => p.id === pendiente.dependeDe)!;
      expect(suRaiz.dependeDe, `${pendiente.id} → ${suRaiz.id}`).toBeNull();
    }
  });

  it('las consecuencias de un renglón son del mismo renglón', () => {
    for (const raiz of soloRaices(ERRECALDE.pendientes)) {
      for (const consecuencia of consecuenciasDe(ERRECALDE.pendientes, raiz.id)) {
        expect(consecuencia.renglon, `${raiz.id} → ${consecuencia.id}`).toBe(raiz.renglon);
      }
    }
  });

  it('un comprobante que cierra no tiene raíces, y sus anotaciones no dependen de nada', () => {
    const ezra = interpretar('ezra');
    expect(soloRaices(ezra.pendientes)).toHaveLength(0);
    expect(ezra.resumen.consecuencias).toBe(0);
    expect(ezra.pendientes.every((p) => p.dependeDe === null)).toBe(true);
  });

  it('un renglón que se vio pero no llegó a ser artículo es una pregunta, no cinco', () => {
    /*
     * La fila veintitrés de la factura larga: el OCR la vio, tiene números en
     * cuatro columnas y no tiene descripción, código ni una cuenta propia. Sus
     * celdas dudosas no son cinco preguntas. La pregunta es una —«¿esto es un
     * artículo del papel o una línea de basura de la foto?»— y hasta
     * contestarla no hay nada que decidir sobre su precio.
     */
    const sinInterpretar = soloRaices(ERRECALDE.pendientes).filter((p) =>
      p.id.endsWith(':sin-interpretar'),
    );
    expect(sinInterpretar).toHaveLength(1);
    expect(consecuenciasDe(ERRECALDE.pendientes, sinInterpretar[0].id).length).toBeGreaterThan(1);
    // Y el motivo dice qué se leyó ahí, para que se pueda contestar sin abrir la foto.
    expect(sinInterpretar[0].motivo).toContain('se leyó');
    expect(sinInterpretar[0].motivo).toContain('artículo del comprobante o una línea de basura');
  });
});

describe('confirmar una raíz recalcula sus dependencias', () => {
  /**
   * Qué valor de cantidad implica la propia aritmética de un renglón.
   *
   * Se calcula del importe y el precio del renglón —no se transcribe del
   * papel— para que la prueba mida la **propagación** y no la puntería del
   * OCR. Es lo mismo que la pantalla le va a mostrar a la persona como
   * sugerencia para que lo confirme contra el comprobante.
   */
  /*
   * El caso se arma a mano, y ése es el cambio.
   *
   * Antes se buscaba una raíz de cantidad en una factura del banco. Dejó de
   * haber: su columna de cantidades pasó a preguntarse **una sola vez, como
   * columna**, y las celdas que quedan pedidas ya no se destraban de a una. Eso
   * es una mejora del motor, pero deja la garantía sin sujeto, y una garantía
   * que depende de que cierta factura siga fallando cierto día no es una
   * garantía.
   *
   * Así que el comprobante es sintético y mínimo: tres artículos, y al del medio
   * el OCR no le leyó el importe. Falta un dato obligatorio, se pide, y al
   * confirmarlo el renglón cierra su propia cuenta. Sin nombres de proveedor y
   * sin valores de ningún papel.
   */
  const SIN_IMPORTE: Fragmento[] = [
    ...fila(Y_TITULOS, TITULOS),
    ...fila(Y_TITULOS + SALTO, [
      ['70', 0.05],
      ['ARTICULO A', 0.20],
      ['4', 0.52],
      ['5.700,00', 0.65],
      ['22.800,00', 0.82],
    ]),
    // Al segundo renglón le falta el importe: es lo único que se le pide.
    ...fila(Y_TITULOS + SALTO * 2, [
      ['71', 0.05],
      ['ARTICULO B', 0.20],
      ['2', 0.52],
      ['9.600,00', 0.65],
    ]),
    ...fila(Y_TITULOS + SALTO * 3, [
      ['72', 0.05],
      ['ARTICULO C', 0.20],
      ['3', 0.52],
      ['9.800,00', 0.65],
      ['29.400,00', 0.82],
    ]),
  ];

  const INCOMPLETO = interpretarReconstruccion(evidencia(SIN_IMPORTE), {
    cuitDelReceptor: CUIT_DEL_RECEPTOR,
    asociacionesDeProducto: asociacionesDePrueba(3),
  });

  /** La primera raíz **de celda** cuya confirmación destraba algo. */
  function primeraRaizDeCantidad() {
    for (const raiz of soloRaices(INCOMPLETO.pendientes)) {
      if (raiz.renglon === null) continue;
      const valor = '19.200,00';
      const despues = interpretarReconstruccion(evidencia(SIN_IMPORTE), {
        cuitDelReceptor: CUIT_DEL_RECEPTOR,
        confirmaciones: [{ renglon: raiz.renglon, campo: 'importe', texto: valor }],
        asociacionesDeProducto: asociacionesDePrueba(3),
      });
      if (despues.resumen.bloqueosUnicos < INCOMPLETO.resumen.bloqueosUnicos) {
        return { raiz, valor, despues };
      }
    }
    return null;
  }

  it('el bloqueo raíz y sus consecuencias desaparecen', () => {
    const caso = primeraRaizDeCantidad();
    expect(caso, 'ninguna raíz de cantidad destraba nada').not.toBeNull();
    const { raiz, despues } = caso!;

    // Una acción humana menos, y un renglón más que se comprueba solo.
    expect(despues.resumen.bloqueosUnicos).toBeLessThan(INCOMPLETO.resumen.bloqueosUnicos);

    const cierranAntes = (INCOMPLETO.veredicto.ganadora?.renglones ?? []).filter(
      (r) => r.controles.length > 0 && r.controles.every((c) => c.paso),
    ).length;
    const cierranDespues = (despues.veredicto.ganadora?.renglones ?? []).filter(
      (r) => r.controles.length > 0 && r.controles.every((c) => c.paso),
    ).length;
    expect(cierranDespues).toBeGreaterThan(cierranAntes);

    // Y del renglón confirmado no queda ni la raíz ni lo que dependía de ella.
    const suyos = soloBloqueantes(despues.pendientes).filter((p) => p.renglon === raiz.renglon);
    expect(suyos).toHaveLength(0);
  });

  it('no vuelve a leer ninguna otra celda de la foto', () => {
    /*
     * La garantía que hace que esto sea seguro, dicha donde corresponde.
     *
     * Confirmar una celda vuelve a pasar el comprobante por el mismo motor, y el
     * motor elige de nuevo. Lo que **no** puede pasar es que vuelva a leer la
     * foto: si confirmar una cantidad cambiara los textos reconstruidos de los
     * otros veintidós renglones, confirmar un número sería rehacer la factura
     * entera y nadie podría auditar qué cambió por qué.
     *
     * Los textos son lo que no se toca. Los **valores** sí pueden cambiar, y hay
     * una sola razón por la que pueden: el valor confirmado es un ancla de la
     * escala de su columna, y la escala es de la columna entera, no de la celda.
     * Un papel donde el OCR se comió casi todas las comas de una columna tiene
     * su escala sostenida por dos o tres valores legibles; agregar uno cierto
     * puede cambiarla, y entonces cada celda mutilada de esa columna se lee de
     * nuevo. Eso es precisamente para lo que sirve confirmar.
     */
    const caso = primeraRaizDeCantidad();
    const { raiz, despues } = caso!;

    expect(despues.tabla.renglones).toHaveLength(INCOMPLETO.tabla.renglones.length);

    // Ni un solo texto reconstruido distinto fuera de la celda confirmada.
    INCOMPLETO.tabla.renglones.forEach((fila, i) => {
      if (i + 1 === raiz.renglon) return;
      const ahora = despues.tabla.renglones[i];
      expect(fila.celdas.map((c) => c?.texto ?? ''), `renglón ${i + 1}`).toEqual(
        ahora.celdas.map((c) => c?.texto ?? ''),
      );
    });
  });

  it('los renglones que no se confirmaron no cambian de valor', () => {
    /*
     * Confirmar un dato que faltaba completa **ese** renglón y nada más. Los
     * otros no tienen por qué moverse, y si se movieran nadie podría auditar qué
     * cambió por qué.
     *
     * Hay un caso en que sí pueden, y está probado aparte: cuando el valor
     * confirmado es un ancla nueva de la escala de su columna, las celdas
     * mutiladas de esa misma columna se releen. Acá no lo es —el importe
     * confirmado se escribe igual que los otros dos de su columna— así que no
     * hay ninguna excusa para que nada más cambie.
     */
    const caso = primeraRaizDeCantidad();
    const { raiz, despues } = caso!;

    const antes = retrato(INCOMPLETO);
    const ahora = retrato(despues);
    expect(ahora).toHaveLength(antes.length);
    antes.forEach((fila, i) => {
      if (i + 1 === raiz.renglon) return;
      expect(ahora[i], `renglón ${i + 1}`).toBe(fila);
    });

    // Y el confirmado sí cambió, y cambió para cerrar su propia cuenta.
    const suyo = despues.veredicto.ganadora!.renglones[raiz.renglon! - 1];
    expect(ahora[raiz.renglon! - 1]).not.toBe(antes[raiz.renglon! - 1]);
    expect(suyo.controles.length).toBeGreaterThan(0);
    expect(suyo.controles.every((c) => c.paso)).toBe(true);
  });

  it('la celda confirmada no vuelve a competir con lo que había leído el OCR', () => {
    const caso = primeraRaizDeCantidad();
    const { raiz, valor, despues } = caso!;

    const fila = despues.tabla.renglones[raiz.renglon! - 1];
    const indice = despues.tabla.columnas.findIndex((c) => c.campo?.campo === 'importe');
    const celda = fila.celdas[indice]!;

    expect(celda.estado).toBe('confirmada');
    expect(celda.texto).toBe(valor);
    expect(celda.alternativas).toHaveLength(1);
    expect(celda.alternativas[0].pasada).toBe('confirmada por una persona');
  });

  it('confirmar una celda no confirma las demás del mismo renglón', () => {
    /*
     * El negativo. Si confirmar la cantidad diera por buenas también el precio
     * y el subtotal, una sola corrección aceptaría tres datos que nadie miró.
     * Lo que la confirmación destraba es la **decisión** sobre las otras
     * celdas: si con la cantidad puesta la cuenta cierra, las otras lecturas
     * quedan elegidas por la aritmética; si no cierra, siguen pedidas.
     */
    const caso = primeraRaizDeCantidad();
    const { raiz, despues } = caso!;

    const fila = despues.tabla.renglones[raiz.renglon! - 1];
    const confirmadas = fila.celdas.filter((c) => c?.estado === 'confirmada');
    expect(confirmadas).toHaveLength(1);
  });

  it('una confirmación sobre un renglón que no existe no rompe nada', () => {
    const inventado = interpretarReconstruccion(evidencia(SIN_IMPORTE), {
      cuitDelReceptor: CUIT_DEL_RECEPTOR,
      confirmaciones: [{ renglon: 999, campo: 'cantidad', texto: '1,00' }],
      asociacionesDeProducto: asociacionesDePrueba(3),
    });
    expect(retrato(inventado)).toEqual(retrato(INCOMPLETO));
    expect(inventado.resumen.bloqueosUnicos).toBe(INCOMPLETO.resumen.bloqueosUnicos);
  });
});
