import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Decimal } from '@/lib/money';
import {
  interpretarReconstruccion,
  queFaltaResolver,
} from '@/lib/ocr/motor/desde-reconstruccion';
import { candidatasDeTabla } from '@/lib/ocr/reconstruccion/candidatas-de-tabla';
import {
  candidatasDeRenglon,
  controlarRenglon,
  leFalta,
  puntuarTabla,
  UMBRAL_AUTOMATICO,
  type RenglonCandidato,
  type Veredicto,
} from '@/lib/ocr/motor/candidatas';
import { mejoresAsignaciones } from '@/lib/ocr/reconstruccion/asignacion';
import { relacionesAritmeticas } from '@/lib/ocr/motor/semantica-de-columnas';
import { reconocerColumna, type ColumnaReconocida } from '@/lib/ocr/motor/columnas';
import { lugarDe, type Celda, type FilaDeDatos } from '@/lib/ocr/motor/tabla';
import type { EvidenciaDeLectura } from '@/lib/ocr/reconstruccion/evidencia';
import type { EvidenciaDeRelectura } from '@/lib/ocr/reconstruccion/relectura';
import type {
  CeldaReconstruida,
  RenglonReconstruido,
  TablaReconstruida,
} from '@/lib/ocr/reconstruccion/reconstruccion';

/**
 * Cerrar la factura de Lácteos Barraza, y no aparentar que cerró.
 *
 * Son dos cosas distintas y las dos se prueban acá. La primera es que los dos
 * renglones salgan completos y comprobados. La segunda —más importante— es que
 * el comprobante **no pueda darse por bueno** cuando una fila está mal: que la
 * suma de los importes dé el neto impreso demuestra que la columna de importes
 * está completa, y nada más que eso.
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

const BARRAZA = interpretarReconstruccion(leer('barraza'), {
  cuitDelReceptor: CUIT_DEL_RECEPTOR,
});
const RENGLONES = BARRAZA.veredicto.ganadora!.renglones;

// ---------------------------------------------------------------------------
// El resultado
// ---------------------------------------------------------------------------

describe('los dos renglones cierran contra su propia aritmética', () => {
  it('el segundo renglón trae los 30 kg, las 3 piezas, el precio, el 16 % y el importe', () => {
    /*
     * 30 × 9.453,76 × 0,84 = 238.234,752, contra los 238.234,75 impresos. Es la
     * identidad que decide: con 42 % no da nada parecido.
     */
    const segundo = RENGLONES[1];
    expect(segundo.cantidad?.toString()).toBe('30');
    expect(segundo.piezas).toBe(3);
    expect(segundo.precioUnitario?.toString()).toBe('9453.76');
    expect(segundo.descuentoPct?.toString()).toBe('0.16');
    expect(segundo.importe?.toString()).toBe('238234.75');
    expect(segundo.controles.filter((c) => c.paso).length).toBeGreaterThan(0);
    expect(segundo.controles.every((c) => c.paso)).toBe(true);
  });

  it('el primero también, y ninguno de los dos queda sin comprobar', () => {
    const primero = RENGLONES[0];
    expect(primero.cantidad?.toString()).toBe('27');
    expect(primero.piezas).toBe(9);
    expect(primero.precioUnitario?.toString()).toBe('10361.45');
    expect(primero.descuentoPct?.toString()).toBe('0.16');
    expect(primero.importe?.toString()).toBe('234997.69');

    for (const renglon of RENGLONES) {
      expect(renglon.controles.length, renglon.descripcion).toBeGreaterThan(0);
      expect(renglon.controles.every((c) => c.paso), renglon.descripcion).toBe(true);
      expect(leFalta(renglon), renglon.descripcion).toEqual([]);
    }
  });

  it('y el comprobante cierra contra el pie, con el pie entero', () => {
    const ganadora = BARRAZA.veredicto.ganadora!;
    expect(ganadora.sumaDeRenglones.toFixed(2)).toBe('473232.44');
    expect(ganadora.cierre?.compatible).toBe(true);
    expect(BARRAZA.pie.netTotal?.toFixed(2)).toBe('473232.44');
    expect(BARRAZA.pie.ivaTotal?.toFixed(2)).toBe('99378.81');
    expect(BARRAZA.pie.percepciones?.toFixed(2)).toBe('7098.49');
    expect(BARRAZA.pie.total?.toFixed(2)).toBe('579709.74');
  });

  it('lo único pendiente son columnas por confirmar, ninguna celda incorrecta', () => {
    expect(BARRAZA.veredicto.decision).toBe('revision-de-estructura');
    expect(BARRAZA.resumen.desglose.celdasObligatoriasFaltantes).toBe(0);
    expect(BARRAZA.resumen.desglose.ambiguedadesBloqueantes).toBe(0);
    /*
     * Todo lo que frena es una pregunta sobre una **columna**: qué significa, o
     * en qué escala están escritos sus valores. Las dos se contestan una vez y
     * valen para las celdas de abajo; ninguna es volver a tipear un número.
     */
    expect(
      BARRAZA.resumen.desglose.columnasSinReconocer +
        BARRAZA.resumen.desglose.escalasSinDecidir,
    ).toBe(BARRAZA.resumen.bloqueosUnicos);
    expect(BARRAZA.resumen.desglose.renglonesSinProbar).toBe(0);
    const textual = BARRAZA.pendientes.find((p) =>
      p.motivo.startsWith('Confirmar que la columna textual corresponde a Descripción'),
    );
    expect(textual?.categoria).toBe('BLOCKING_UNKNOWN_COLUMN');
  });
});

// ---------------------------------------------------------------------------
// El código 30, con su procedencia
// ---------------------------------------------------------------------------

describe('el código del segundo artículo sale de la tabla y de ningún otro lado', () => {
  const evidencia = leer('barraza');

  /** La columna de códigos de esta foto, medida sobre la propia evidencia. */
  const COLUMNA_DE_CODIGOS = { desde: 0.075, hasta: 0.105 };

  it('existe un fragmento «30» propio, en la columna de códigos y dentro de la tabla', () => {
    /*
     * No se acepta un código deducido del orden del renglón, de la cantidad ni
     * del papel transcripto: tiene que haber tinta. Acá está, leída por tres
     * pasadas independientes con 0,96 de confianza.
     */
    const enLaColumna = evidencia.fragmentos.filter(
      (f) =>
        f.texto.trim() === '30' &&
        f.caja.x0 >= COLUMNA_DE_CODIGOS.desde &&
        f.caja.x1 <= COLUMNA_DE_CODIGOS.hasta &&
        f.caja.y0 > 0.31,
    );

    expect(enLaColumna.length).toBeGreaterThanOrEqual(3);
    expect(new Set(enLaColumna.map((f) => f.pasada)).size).toBeGreaterThanOrEqual(2);
    for (const fragmento of enLaColumna) {
      expect(fragmento.confianza).toBeGreaterThan(0.9);
    }
    expect(RENGLONES[1].codigo).toBe('30');
  });

  it('el 30 del CUIT del emisor está en otro lado y no se usa', () => {
    /*
     * El CUIT 30-66138303-4 está arriba, en el encabezado, a dos tercios del
     * ancho de la página. No cae en la columna de códigos ni en el cuerpo de la
     * tabla, y su texto no es «30»: es el CUIT entero.
     */
    const delCuit = evidencia.fragmentos.filter((f) => /^30-\d/.test(f.texto.trim()));
    expect(delCuit.length).toBeGreaterThan(0);
    for (const fragmento of delCuit) {
      const enLaColumna =
        fragmento.caja.x0 >= COLUMNA_DE_CODIGOS.desde &&
        fragmento.caja.x1 <= COLUMNA_DE_CODIGOS.hasta;
      expect(enLaColumna, fragmento.texto).toBe(false);
      // Y está por encima de donde arranca el cuerpo de la tabla.
      expect(fragmento.caja.y1, fragmento.texto).toBeLessThan(0.3);
    }
    expect(BARRAZA.emisor.cuit?.replace(/\D/g, '')).toBe('30661383034');
  });

  it('el 30 de la cantidad es otro fragmento, y no se reutiliza como código', () => {
    /*
     * La prohibición vale para todo el comprobante y no sólo dentro de una
     * columna: el mismo pedazo de papel no puede ser el código y la cantidad
     * aunque las dos celdas digan 30.
     */
    const codigo = BARRAZA.tabla.renglones[1].celdas.find((c) => c?.texto === '30');
    const cantidad = BARRAZA.tabla.renglones[1].celdas.find((c) => c?.texto?.startsWith('30.'));
    expect(codigo?.procedencia).toBeTruthy();
    expect(cantidad?.procedencia).toBeTruthy();
    expect(lugarDe(codigo!.procedencia!.cajaEnLaFoto)).not.toBe(
      lugarDe(cantidad!.procedencia!.cajaEnLaFoto),
    );
    // Ni siquiera se tocan: están a media página de distancia.
    expect(
      cantidad!.procedencia!.cajaEnLaFoto.x0 - codigo!.procedencia!.cajaEnLaFoto.x1,
    ).toBeGreaterThan(0.05);
  });

  it('un fragmento usado como cantidad no puede ofrecerse además como código', () => {
    /*
     * La garantía, comprobada rompiéndola: una fila armada a mano donde el
     * código y la cantidad salen del **mismo** lugar no produce ningún renglón.
     */
    const mismoLugar = lugarDe({ x0: 0.19, y0: 0.34, x1: 0.23, y1: 0.35 });
    const columnas: (ColumnaReconocida | null)[] = [
      reconocerColumna('Cod'),
      reconocerColumna('Descripcion'),
      reconocerColumna('Cantidad'),
      reconocerColumna('Importe'),
    ];
    const celdas = (lugarDelCodigo: string): (Celda | null)[] => [
      { texto: '30', desde: 0, hasta: 2, lugar: lugarDelCodigo },
      { texto: 'MUZZARELLA BARRAZA', desde: 4, hasta: 22, lugar: 'desc' },
      { texto: '30', desde: 24, hasta: 26, lugar: mismoLugar },
      { texto: '238234.75', desde: 28, hasta: 37, lugar: 'imp' },
    ];
    const fila = (lugarDelCodigo: string): FilaDeDatos => ({
      linea: 0,
      cruda: '',
      celdas: celdas(lugarDelCodigo),
      sobrantes: [],
    });

    // Con el mismo fragmento en las dos celdas: no hay renglón.
    expect(candidatasDeRenglon(fila(mismoLugar), columnas, 'ar')).toEqual([]);

    // Con dos fragmentos distintos que dicen lo mismo: el renglón existe, y el
    // código es 30. Ésa es la diferencia que hay que sostener.
    const conDosFragmentos = candidatasDeRenglon(
      fila(lugarDe({ x0: 0.081, y0: 0.34, x1: 0.099, y1: 0.35 })),
      columnas,
      'ar',
    );
    expect(conDosFragmentos.length).toBeGreaterThan(0);
    expect(conDosFragmentos[0].codigo).toBe('30');
    expect(conDosFragmentos[0].cantidad?.toString()).toBe('30');
  });
});

// ---------------------------------------------------------------------------
// Los dos niveles de reconciliación
// ---------------------------------------------------------------------------

describe('el cierre contra el pie no tapa una fila incorrecta', () => {
  /** Una fila armada a mano, para poder romperla a propósito. */
  function renglon(campos: Partial<RenglonCandidato>): RenglonCandidato {
    const base: RenglonCandidato = {
      codigo: null,
      descripcion: 'ARTICULO',
      marca: null,
      cantidad: new Decimal(10),
      kilos: null,
      piezas: null,
      precioUnitario: new Decimal(100),
      descuentoPct: null,
      precioConDescuento: null,
      importe: new Decimal(1000),
      descuentoEnElImporte: null,
      reparaciones: 0,
      severidad: 0,
      incoherentes: 0,
      escalasAjenas: 0,
      controles: [],
      ...campos,
    };
    // Los controles se calculan, no se declaran: una fila a la que le falta el
    // precio no tiene ninguno, y eso es justamente lo que se está probando.
    base.controles = controlarRenglon(base);
    return base;
  }

  it('una tabla con una fila sin precio no llega al umbral automático, aunque el neto sea exacto', () => {
    const conPrecio = renglon({});
    const sinPrecio = renglon({ precioUnitario: null, importe: new Decimal(500) });

    const { puntaje, sumaDeRenglones } = puntuarTabla([conPrecio, sinPrecio], {
      netTotal: new Decimal(1500),
      filasVistas: 2,
    });

    // La suma da **exactamente** el neto impreso...
    expect(sumaDeRenglones.toString()).toBe('1500');
    // ...y aun así el comprobante no puede aceptarse solo.
    expect(puntaje).toBeLessThan(UMBRAL_AUTOMATICO);
  });

  it('la misma tabla con las dos filas completas sí puede aceptarse', () => {
    const { puntaje } = puntuarTabla([renglon({}), renglon({})], {
      netTotal: new Decimal(2000),
      filasVistas: 2,
    });
    expect(puntaje).toBeGreaterThanOrEqual(UMBRAL_AUTOMATICO);
  });

  it('lo que le falta a un renglón se dice campo por campo', () => {
    expect(leFalta(renglon({}))).toEqual([]);
    expect(leFalta(renglon({ precioUnitario: null }))).toEqual(['el precio']);
    expect(leFalta(renglon({ importe: null }))).toEqual(['el importe']);
    expect(leFalta(renglon({ cantidad: null }))).toEqual(['la cantidad']);
    expect(leFalta(renglon({ cantidad: null, kilos: null, piezas: 3 }))).toEqual([]);
  });

  it('una fila sin precio queda como bloqueo de celda, no sólo de columna', () => {
    /*
     * La distinción que le importa a quien carga la factura: una columna por
     * confirmar se contesta una vez para el formato; una celda que falta hay que
     * mirarla en ese renglón.
     *
     * El caso se mide sobre Errecalde. Estaba sobre la foto de Los Calvos, que
     * dejó de servir para esto: con la tabla cortada donde termina de verdad,
     * sus once renglones quedan completos y ya no hay ninguna celda faltante que
     * mostrar. La garantía es la misma; lo que cambió es dónde se ve.
     */
    const sinPrecio = interpretarReconstruccion(leer('errecalde'));
    const faltantes = sinPrecio.pendientes.filter(
      (p) => p.categoria === 'BLOCKING_MISSING_CELL' && p.renglon !== null,
    );
    expect(faltantes.length).toBeGreaterThan(0);
    expect(faltantes.some((p) => p.motivo.includes('no se puede comprobar'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// El reparto conjunto
// ---------------------------------------------------------------------------

describe('las columnas se resuelven juntas, no una por una', () => {
  it('el segundo 16,00 va al segundo renglón aunque se solape con el primero', () => {
    /*
     * Las dos bonificaciones están impresas casi a la misma altura, así que por
     * distancia las dos tiran del primer renglón. Lo que las ordena es que son
     * dos valores de una columna y hay dos renglones esperados.
     */
    const ALTO = 0.0095;
    const valor = (texto: string, y: number) => ({
      texto,
      caja: { x0: 0.76, y0: y, x1: 0.8, y1: y + ALTO },
      pasada: 'completo:directo',
      confianza: 0.96,
    });
    const filas = [{ y: 0.3331 }, { y: 0.3464 }];
    const asignaciones = mejoresAsignaciones(
      [valor('16.00', 0.3236), valor('16.00', 0.3335), valor('42', 0.3343)],
      filas,
      ALTO,
      2,
    );

    const textos = asignaciones.map((a) => a.porFila.map((v) => v?.texto ?? null));
    expect(textos).toContainEqual(['16.00', '16.00']);
  });

  it('el 42 % pierde contra el 16 % por la aritmética, no por la geometría', () => {
    const columnas = (bonif: string[]) => [
      { titulo: 'Cantidad', celdas: ['27.00', '30.00'], desde: 0.19, hasta: 0.23 },
      { titulo: null, celdas: ['10,361.45', '9,453.76'], desde: 0.66, hasta: 0.71 },
      { titulo: 'Bonif', celdas: bonif, desde: 0.76, hasta: 0.79 },
      { titulo: 'Importe', celdas: ['234.99769', '238,234.'], desde: 0.87, hasta: 0.93 },
    ];

    const conDieciseis = relacionesAritmeticas(columnas(['16.00', '16.00']));
    expect(conDieciseis.length).toBeGreaterThan(0);
    expect(conDieciseis[0].cierran).toBe(2);

    // Con el 42 en el segundo renglón, ninguna combinación de columnas cierra
    // las dos filas: es la evidencia que lo descarta.
    const conCuarentaYDos = relacionesAritmeticas(columnas(['16.00', '42']));
    const mejor = conCuarentaYDos.length > 0 ? conCuarentaYDos[0].cierran : 0;
    expect(mejor).toBeLessThan(2);
  });

  it('la combinación aritméticamente correcta le gana a la más cercana', () => {
    /*
     * Lo que decide entre candidatas es la aritmética del comprobante, no la
     * distancia entre las cajas: la más cercana existe, se ofrece y pierde.
     *
     * Sobre Barraza el haz ya no hace falta para llegar al resultado —desde que
     * la celda dejó de pegar lo que varias pasadas leyeron del mismo lugar, el
     * reparto base pone los dos importes donde van— así que acá se comprueba lo
     * que sigue siendo cierto: que la candidata elegida no es la de cercanía, que
     * cierra sus dos renglones, y que el haz de repartos se ofreció igual.
     */
    const candidatas = candidatasDeTabla(leer('barraza'));
    expect(candidatas.find((c) => c.origen === 'cercanía')).toBeDefined();
    expect(candidatas.some((c) => c.origen.includes('repartos'))).toBe(true);
    expect(BARRAZA.reconstruccionElegida).not.toBe('cercanía');
    expect(BARRAZA.veredicto.ganadora!.renglones).toHaveLength(2);
    expect(
      BARRAZA.veredicto.ganadora!.renglones.every(
        (r) => r.controles.length > 0 && r.controles.every((c) => c.paso),
      ),
    ).toBe(true);
  });

  it('y donde el haz todavía decide, gana el reparto que hace cerrar renglones', () => {
    /*
     * La otra mitad de la misma garantía, sobre el comprobante donde el haz
     * sigue siendo decisivo: con la banda de precios releída, la candidata que
     * gana en Errecalde usa repartos que **no** son los más baratos de su
     * columna, y gana porque hace cerrar renglones que si no no cerraban.
     */
    const errecalde = interpretarReconstruccion(leer('errecalde'), {
      cuitDelReceptor: CUIT_DEL_RECEPTOR,
      relectura: relecturaDe('errecalde'),
    });
    expect(errecalde.reconstruccionElegida).toContain('repartos');
    expect(errecalde.reconstruccionElegida).toContain('renglón/es cierran');
  });

  it('9.453,76 termina en el segundo renglón y lo deja cerrado', () => {
    const segundo = BARRAZA.tabla.renglones[1];
    const textos = segundo.celdas.map((c) => c?.texto ?? null);
    expect(textos).toContain('9,453.76');
    expect(RENGLONES[1].precioUnitario?.toString()).toBe('9453.76');
  });
});

// ---------------------------------------------------------------------------
// Que nada de esto haya movido lo que ya andaba
// ---------------------------------------------------------------------------

describe('Ezra y Mabelherdi no se movieron', () => {
  const EZRA = interpretarReconstruccion(leer('ezra'), { cuitDelReceptor: '27-33342291-9' });
  const MABELHERDI = interpretarReconstruccion(leer('mabelherdi'), {
    cuitDelReceptor: '27-33342291-9',
  });

  it('Ezra sigue siendo automática, con sus seis artículos y su cierre', () => {
    expect(EZRA.veredicto.decision).toBe('automatica');
    expect(EZRA.veredicto.ganadora!.puntaje).toBe(1);
    expect(EZRA.resumen.bloqueosUnicos).toBe(0);
    const renglones = EZRA.veredicto.ganadora!.renglones;
    expect(renglones).toHaveLength(6);
    /*
     * El sexto código es «4249» y no «4249E». La «E» no está en el papel: la
     * pasada de la franja de artículos parte esos mismos glifos en «42» y «E»
     * —dos cajas que se pisan con la que la pasada de la página entera lee
     * completa como «4249», con 0,95 contra 0,53 y 0,18— y la celda las venía
     * pegando en vez de tratarlas como lo que son, dos maneras de leer lo
     * mismo. Los otros cinco códigos son dígitos puros.
     */
    expect(renglones.map((r) => r.codigo)).toEqual(['47', '49', '48', '10', '2514', '4249']);
    expect(renglones[0].precioUnitario?.toString()).toBe('6723.279');
    expect(renglones[0].importe?.toString()).toBe('27081.371');
  });

  it('Mabelherdi sigue con sus nueve artículos, su suma exacta y sus nueve precios', () => {
    expect(MABELHERDI.veredicto.ganadora!.renglones).toHaveLength(9);
    expect(MABELHERDI.veredicto.ganadora!.sumaDeRenglones.toFixed(2)).toBe('32998.85');
    expect(MABELHERDI.veredicto.ganadora!.cierre?.compatible).toBe(true);
    expect(
      MABELHERDI.veredicto.ganadora!.renglones.filter((r) => r.precioUnitario !== null),
    ).toHaveLength(9);
  });
});

// ---------------------------------------------------------------------------
// La política, aislada de cualquier foto
// ---------------------------------------------------------------------------

describe('un renglón que no cierra solo no se da por bueno porque cierre el total', () => {
  /** Una tabla de dos renglones con una celda ambigua en la columna de importes. */
  function tablaDeDos(): TablaReconstruida {
    const celda = (texto: string): CeldaReconstruida => ({
      columna: 1,
      texto,
      alternativas: [
        { texto, caja: CAJA, cajaEnLaFoto: CAJA, pasada: 'completo:directo', confianza: 0.8 },
        {
          texto: `${texto}0`,
          caja: CAJA,
          cajaEnLaFoto: CAJA,
          pasada: 'articulos:directo',
          confianza: 0.7,
        },
      ],
      estado: 'ambigua',
      procedencia: { pasada: 'completo:directo', confianza: 0.8, cajaEnLaFoto: CAJA },
    });
    const renglon = (texto: string): RenglonReconstruido => ({
      y: 0.3,
      caja: CAJA,
      celdas: [null, celda(texto)],
      sobrantes: [],
      estado: 'incompleto',
      clase: 'aceptado',
      apoyos: ['identidad', 'numeros'],
      continuacionDe: null,
      motivo: 'armado a mano para la prueba',
    });
    return {
      columnas: [
        { desde: 0, hasta: 0.5, titulo: 'Descripcion', campo: reconocerColumna('Descripcion'), apoyos: 2 },
        { desde: 0.5, hasta: 1, titulo: 'Importe', campo: reconocerColumna('Importe'), apoyos: 2 },
      ],
      metodo: 'datos-con-titulos',
      encabezados: ['Descripcion', 'Importe'],
      renglones: [renglon('1000'), renglon('500')],
      hipotesis: [renglon('1000'), renglon('500')],
      banda: { hastaY: 1, origen: 'armada a mano para la prueba' },
      filasVisibles: 2,
      inclinacionGrados: 0,
      seEnderezo: false,
      alturaTipica: 0.01,
      notas: [],
      valoresDeOtraPasada: 0,
      ms: 0,
    };
  }

  const CAJA = { x0: 0.5, y0: 0.3, x1: 0.6, y1: 0.31 };

  /** El comprobante cierra contra el pie, pero sólo el primer renglón se comprueba. */
  function veredictoQueCierra(): Veredicto {
    const conControl: RenglonCandidato = {
      codigo: null,
      descripcion: 'UNO',
      marca: null,
      cantidad: new Decimal(10),
      kilos: null,
      piezas: null,
      precioUnitario: new Decimal(100),
      descuentoPct: null,
      precioConDescuento: null,
      importe: new Decimal(1000),
      descuentoEnElImporte: null,
      reparaciones: 0,
      severidad: 0,
      incoherentes: 0,
      escalasAjenas: 0,
      controles: [],
    };
    conControl.controles = controlarRenglon(conControl);

    // El segundo no tiene precio: no hay ninguna cuenta que pueda hacerse.
    const sinControl: RenglonCandidato = {
      ...conControl,
      descripcion: 'DOS',
      precioUnitario: null,
      importe: new Decimal(500),
      controles: [],
    };

    return {
      decision: 'automatica',
      ganadora: {
        convencion: 'ar',
        pie: { netTotal: new Decimal(1500), ivaTotal: null, percepciones: null, total: null, ignorados: [] },
        renglones: [conControl, sinControl],
        puntaje: 1,
        penalizaciones: [],
        sumaDeRenglones: new Decimal(1500),
        reparaciones: 0,
        cierre: {
          compatible: true,
          explicacion: 'la suma da el neto impreso',
          ajusteResidual: new Decimal(0),
        } as never,
      },
      segunda: null,
      margen: 1,
      motivo: '',
    };
  }

  it('la ambigüedad del renglón comprobado es una anotación, y la del otro frena', () => {
    /*
     * Los dos renglones tienen la **misma** celda ambigua y el comprobante cierra
     * contra el pie en los dos casos. Lo único que los distingue es que el
     * primero comprueba su propia cuenta y el segundo no puede.
     *
     * Si el cierre del total alcanzara, las dos ambigüedades saldrían como
     * anotaciones y la factura se cargaría con un importe elegido a dedo en una
     * fila que nadie verificó.
     */
    const pendientes = queFaltaResolver(tablaDeDos(), veredictoQueCierra(), []);

    const delPrimero = pendientes.filter((p) => p.renglon === 1 && p.campo === 'importe');
    const delSegundo = pendientes.filter((p) => p.renglon === 2 && p.campo === 'importe');

    expect(delPrimero.map((p) => p.categoria)).toEqual(['WARNING_DISCARDED_ALTERNATIVE']);
    expect(delSegundo.map((p) => p.categoria)).toEqual(['BLOCKING_AMBIGUOUS_CELL']);
  });

  it('y al renglón sin precio se le reclama el precio, por renglón', () => {
    const pendientes = queFaltaResolver(tablaDeDos(), veredictoQueCierra(), []);
    const falta = pendientes.filter(
      (p) => p.categoria === 'BLOCKING_MISSING_CELL' && p.renglon === 2,
    );
    expect(falta.map((p) => p.campo)).toContain('el precio');
    expect(falta[0].motivo).toContain('no lo reemplaza');
  });
});
