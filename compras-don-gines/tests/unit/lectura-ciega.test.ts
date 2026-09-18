import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { interpretarReconstruccion } from '@/lib/ocr/motor/desde-reconstruccion';
import type { EvidenciaDeLectura } from '@/lib/ocr/reconstruccion/evidencia';
import {
  actaDePrimeraLectura,
  bloqueantesDe,
  type ActaDePrimeraLectura,
  type HuellaDelMotor,
} from '@/lib/ocr/validacion/lectura-ciega';
import { comparar, type VerdadDelPapel } from '@/lib/ocr/validacion/comparar';
import { asociacionesDePrueba } from '@/../tests/fixtures/evidencia-sintetica';

/**
 * El acta de la primera lectura ciega.
 *
 * Lo que se prueba acá no es que el motor acierte —eso lo dice el papel, y el
 * papel de las facturas nuevas todavía no está transcripto— sino que el **acta
 * registre todo lo que hace falta** para que la medición sea atribuible, y que
 * comparar después no pueda ensuciar lo que ya se registró.
 *
 * Se usa una factura del banco de diseño como conejillo: no mide
 * generalización, mide el arnés.
 */

const DIRECTORIO = path.resolve(__dirname, '../fixtures/evidencia');
const CUIT_DEL_RECEPTOR = '27-33342291-9';

const MOTOR: HuellaDelMotor = {
  commit: '0000000000000000000000000000000000000000',
  sha256: 'a'.repeat(64),
  archivos: 42,
  arbolSucio: false,
};

function actaDe(nombre: string, asociar = true): ActaDePrimeraLectura {
  const evidencia: EvidenciaDeLectura = JSON.parse(
    readFileSync(path.join(DIRECTORIO, `${nombre}.json`), 'utf8'),
  );
  const cantidad = nombre === 'barraza' ? 2 : nombre === 'errecalde' ? 23 : 0;
  const informe = interpretarReconstruccion(evidencia, {
    cuitDelReceptor: CUIT_DEL_RECEPTOR,
    asociacionesDeProducto: asociar ? asociacionesDePrueba(cantidad) : [],
  });
  return actaDePrimeraLectura({
    motor: MOTOR,
    imagen: { nombre: `${nombre}.jpg`, sha256: 'b'.repeat(64), bytes: 1234567 },
    evidencia,
    informe,
    ocrMs: 23000,
  });
}

const BARRAZA = actaDe('barraza');
const ERRECALDE = actaDe('errecalde');

describe('el acta registra lo que hace la medición atribuible', () => {
  it('dice de qué versión del motor salió y si el árbol estaba sucio', () => {
    /*
     * Las dos cosas hacen falta. El commit dice de qué versión se partió; el
     * hash de los fuentes dice si había cambios sin guardar. Una primera
     * lectura ciega sobre un árbol sucio no es reproducible, y conviene que el
     * acta lo diga en vez de que se descubra después.
     */
    expect(BARRAZA.motor.commit).toHaveLength(40);
    expect(BARRAZA.motor.sha256).toHaveLength(64);
    expect(BARRAZA.motor.archivos).toBeGreaterThan(0);
    expect(typeof BARRAZA.motor.arbolSucio).toBe('boolean');
  });

  it('identifica la imagen por su contenido y no por su nombre', () => {
    expect(BARRAZA.imagen.sha256).toHaveLength(64);
    expect(BARRAZA.imagen.bytes).toBeGreaterThan(0);
  });

  it('registra la calidad y la resolución con las que se leyó', () => {
    expect(BARRAZA.calidad.anchoPx).toBeGreaterThan(0);
    expect(BARRAZA.calidad.megapixeles).toBeGreaterThan(0);
    expect(BARRAZA.calidad.fragmentos).toBeGreaterThan(100);
    expect(BARRAZA.calidad.confianzaPorPasada.length).toBeGreaterThan(3);
    for (const pasada of BARRAZA.calidad.confianzaPorPasada) {
      expect(pasada.pasada).not.toBe('');
      expect(pasada.confianza).toBeGreaterThanOrEqual(0);
    }
  });

  it('registra cada celda con su procedencia y sus alternativas', () => {
    expect(BARRAZA.renglones.length).toBe(BARRAZA.reconstruidos);
    const conTexto = BARRAZA.renglones.flatMap((r) => r.celdas).filter((c) => c.texto !== null);
    expect(conTexto.length).toBeGreaterThan(5);
    for (const celda of conTexto) {
      expect(celda.columna).not.toBe('');
      expect(celda.pasada).not.toBeNull();
      expect(celda.confianza).not.toBeNull();
    }
  });

  it('separa la unidad impresa de la unidad del producto asociado', () => {
    const interpretados = BARRAZA.renglones.map((r) => r.interpretado).filter(Boolean);
    expect(interpretados.every((r) => r!.campoCantidadFacturada !== null)).toBe(true);
    expect(interpretados.every((r) => r!.productoId !== null)).toBe(true);
    expect(interpretados.every((r) => r!.unidadDeStock === 'KG')).toBe(true);
  });

  it('separa el pie en leído, inferido, calculado y faltante', () => {
    for (const asignacion of ERRECALDE.pie.asignaciones) {
      expect([
        'READ_FROM_DOCUMENT',
        'INFERRED_FROM_DOCUMENT_RELATIONS',
        'DERIVED_SUGGESTION',
        'MISSING',
      ]).toContain(asignacion.procedencia);
      // Y de qué fragmento salió: sin eso no se puede auditar la asignación.
      expect(asignacion.origen.texto).not.toBe('');
    }
    expect(['completo', 'parcial', 'ausente']).toContain(ERRECALDE.pie.estado);
    // La factura larga tiene un concepto sin leer, y el acta lo dice.
    expect(ERRECALDE.pie.estado).toBe('parcial');
    expect(ERRECALDE.pie.faltantes.length).toBeGreaterThan(0);
  });

  it('registra sólo los bloqueos raíz como acciones humanas, con lo que destraban', () => {
    const evidencia: EvidenciaDeLectura = JSON.parse(
      readFileSync(path.join(DIRECTORIO, 'errecalde.json'), 'utf8'),
    );
    const informe = interpretarReconstruccion(evidencia, {
      cuitDelReceptor: CUIT_DEL_RECEPTOR,
      asociacionesDeProducto: asociacionesDePrueba(23),
    });

    // Muchos menos que los bloqueantes, y la diferencia está informada aparte.
    expect(ERRECALDE.bloqueosRaiz.length).toBeLessThan(bloqueantesDe(informe));
    expect(ERRECALDE.bloqueosRaiz.length + ERRECALDE.consecuencias).toBe(bloqueantesDe(informe));

    for (const raiz of ERRECALDE.bloqueosRaiz) {
      expect(raiz.motivo.length).toBeGreaterThan(20);
      expect(Array.isArray(raiz.destraba)).toBe(true);
    }
    // Y las correcciones que pediría son exactamente esas raíces.
    expect(ERRECALDE.correccionesQuePediria).toHaveLength(ERRECALDE.bloqueosRaiz.length);
  });

  it('separa el tiempo de OCR del tiempo del motor', () => {
    /*
     * Son dos presupuestos distintos y mezclarlos esconde el que importa: el
     * OCR son veinte segundos sobre un teléfono y la interpretación tiene que
     * quedar debajo del segundo. Un solo número no dice nada.
     */
    expect(BARRAZA.tiempos.ocrMs).toBe(23000);
    expect(BARRAZA.tiempos.motorMs).toBeGreaterThan(0);
    expect(BARRAZA.tiempos.motorMs).toBeLessThan(BARRAZA.tiempos.ocrMs);
    // Sin relectura ejecutada, se informa que no hubo.
    expect(BARRAZA.tiempos.relecturaMs).toBeNull();
    expect(BARRAZA.tiempos.relecturaGano).toBeNull();
  });

  it('registra la decisión, la confianza y qué decía la segunda candidata', () => {
    expect(['automatica', 'revision-de-estructura', 'rechazo']).toContain(BARRAZA.decision);
    expect(BARRAZA.motivoDeLaDecision.length).toBeGreaterThan(20);
    expect(BARRAZA.confianza).toBeGreaterThan(0);
    expect(BARRAZA.reconstruccionesProbadas.length).toBeGreaterThan(1);
  });

  it('el acta es serializable: se guarda antes de mirar el papel', () => {
    /*
     * Tiene que poder escribirse a un archivo tal cual. Un `Decimal` suelto
     * adentro se serializa como un objeto con sus dígitos internos y el acta
     * deja de ser legible justo cuando hace falta leerla.
     */
    const texto = JSON.stringify(ERRECALDE);
    const devuelta = JSON.parse(texto) as ActaDePrimeraLectura;
    expect(devuelta.pie.netoGravado).toBe(ERRECALDE.pie.netoGravado);
    expect(devuelta.renglones[0].interpretado?.importe).toBe(
      ERRECALDE.renglones[0].interpretado?.importe,
    );
    // Ningún valor numérico quedó como objeto.
    expect(texto).not.toContain('"s":1');
    expect(texto).not.toContain('"e":');
  });
});

describe('comparar contra el papel es un diagnóstico, no una nota', () => {
  /** Una transcripción que coincide en todo con lo que el motor leyó. */
  function verdadIgualA(acta: ActaDePrimeraLectura): VerdadDelPapel {
    return {
      imagenSha256: acta.imagen.sha256,
      emisor: { cuit: acta.emisor.cuit },
      renglones: acta.renglones
        .filter((r) => r.interpretado)
        .map((r) => ({
          descripcion: r.interpretado!.descripcion,
          cantidad: r.interpretado!.cantidad,
          precioUnitario: r.interpretado!.precioUnitario,
          importe: r.interpretado!.importe,
        })),
      pie: { netoGravado: acta.pie.netoGravado, total: acta.pie.total },
    };
  }

  it('no compara dos facturas distintas', () => {
    const otra = { ...verdadIgualA(BARRAZA), imagenSha256: 'c'.repeat(64) };
    const resultado = comparar(BARRAZA, otra);
    expect(resultado.coinciden).toBe(false);
    expect(resultado.veredicto).toContain('no son de la misma foto');
  });

  it('con todo coincidiendo no hay errores ni causas', () => {
    const resultado = comparar(BARRAZA, verdadIgualA(BARRAZA));
    expect(resultado.errores).toBe(0);
    expect(resultado.aciertos).toBeGreaterThan(5);
    expect(resultado.porCausa).toEqual({});
    expect(resultado.causaPrincipal).toBeNull();
  });

  it('compara cada IVA por alícuota y no por la posición de la lista', () => {
    /*
     * El papel puede imprimir primero un IVA 21 % en cero y después el 10,5 %
     * efectivo, mientras el motor conserva sólo el segundo. Emparejar por
     * posición convertía el 10,5 % correcto en un 21 % incorrecto y, además,
     * declaraba omitido el propio 10,5 %.
     */
    const acta: ActaDePrimeraLectura = structuredClone(BARRAZA);
    acta.pie.iva = [{ alicuota: '0.105', valor: '105.00' }];
    const verdad = verdadIgualA(acta);
    verdad.pie.iva = [
      { alicuota: '0.21', valor: '0.00' },
      { alicuota: '0.105', valor: '105.00' },
    ];

    const resultado = comparar(acta, verdad);
    const alVeintiuno = resultado.campos.find((c) => c.campo === 'pie.iva[0]');
    const alDiezYMedio = resultado.campos.find((c) => c.campo === 'pie.iva[1]');

    expect(alVeintiuno?.leido).toBeNull();
    expect(alDiezYMedio?.leido).toBe('105.00');
    expect(alDiezYMedio?.acierto).toBe(true);
    expect(resultado.balanceFiscal.asignacionesIncorrectas).toBe(0);
    expect(resultado.balanceFiscal.conceptosOmitidos).toBe(1);
  });

  it('un valor cien veces más grande se clasifica como formato numérico', () => {
    /*
     * La clasificación es por **etapa**, no por síntoma. Un importe leído cien
     * veces más grande no es un error de aritmética: la aritmética del renglón
     * cierra igual, porque la proporción se mantiene. Es el separador decimal.
     */
    const verdad = verdadIgualA(BARRAZA);
    const primero = verdad.renglones[0];
    verdad.renglones[0] = {
      ...primero,
      precioUnitario: String(Number(primero.precioUnitario) / 100),
      importe: String(Number(primero.importe) / 100),
    };

    const resultado = comparar(BARRAZA, verdad);
    expect(resultado.errores).toBeGreaterThan(0);
    expect(resultado.porCausa['formato-numerico']).toBeGreaterThan(0);
  });

  it('un campo que el motor pidió no cuenta como error', () => {
    /*
     * La distinción central de todo el hito. Afirmar un valor equivocado es una
     * falla; pedirlo porque la foto no alcanza es lo correcto, y contarlo como
     * error haría que un motor honesto puntuara igual que uno que adivina.
     */
    const evidencia: EvidenciaDeLectura = JSON.parse(
      readFileSync(path.join(DIRECTORIO, 'errecalde.json'), 'utf8'),
    );
    const informe = interpretarReconstruccion(evidencia, { cuitDelReceptor: CUIT_DEL_RECEPTOR });
    const acta = actaDePrimeraLectura({
      motor: MOTOR,
      imagen: { nombre: 'errecalde.jpg', sha256: 'd'.repeat(64), bytes: 1 },
      evidencia,
      informe,
      ocrMs: 1,
    });

    // Se transcribe un valor distinto justo en un renglón que el motor pidió.
    const pedido = acta.bloqueosRaiz.find((b) => b.renglon !== null && b.campo !== null)!;
    const verdad = verdadIgualA(acta);
    const fila = verdad.renglones[pedido.renglon! - 1];
    if (fila) {
      verdad.renglones[pedido.renglon! - 1] = { ...fila, cantidad: '999999' };
    }

    const resultado = comparar(acta, verdad);
    const suyo = resultado.campos.find(
      (c) => c.renglon === pedido.renglon && c.campo === 'cantidad',
    );
    expect(suyo?.acierto).toBeNull();
    expect(suyo?.causa).toBeNull();
    expect(resultado.pedidos).toBeGreaterThan(0);
  });

  it('el veredicto distingue «esto lo resuelve un perfil» de «el motor no está»', () => {
    const igual = comparar(BARRAZA, verdadIgualA(BARRAZA));
    // Barraza no afirma nada mal y le quedan columnas por confirmar una vez.
    expect(igual.columnasPorConfirmar).toBeGreaterThan(0);
    expect(igual.celdasPorCorregir).toBe(0);
    expect(igual.veredicto).toContain('un perfil guardado resuelve');

    const conError = verdadIgualA(BARRAZA);
    conError.renglones[0] = { ...conError.renglones[0], importe: '1,00' };
    expect(comparar(BARRAZA, conError).veredicto).toContain('carencia del motor');
  });

  it('asociar productos no se cuenta como corregir celdas del OCR', () => {
    const sinAsociar = actaDe('barraza', false);
    const resultado = comparar(sinAsociar, verdadIgualA(sinAsociar));

    expect(resultado.errores).toBe(0);
    expect(resultado.productosPorAsociar).toBe(2);
    expect(resultado.unidadesPorResolver).toBe(0);
    expect(resultado.celdasPorCorregir).toBe(0);
    expect(resultado.veredicto).toContain('antes de mover stock');
  });

  it('comparar no modifica el acta', () => {
    /*
     * Es la garantía que sostiene el orden de los pasos. Si comparar tocara el
     * acta, el registro ciego dejaría de ser ciego en el momento en que se lo
     * mira contra el papel.
     */
    const antes = JSON.stringify(BARRAZA);
    comparar(BARRAZA, verdadIgualA(BARRAZA));
    expect(JSON.stringify(BARRAZA)).toBe(antes);
  });
});
