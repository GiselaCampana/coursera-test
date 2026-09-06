import { describe, it, expect } from 'vitest';
import {
  MENSAJE_LECTURA_INSUFICIENTE,
  evaluarLecturaUtilizable,
} from '@/lib/domain/lectura-utilizable';

/**
 * Cuándo frenar y pedir otra foto.
 *
 * La pregunta que contesta este control no es «¿cierra el comprobante?» sino
 * «¿se leyó?». Son distintas: una factura con un renglón mal sumado se corrige
 * a mano en la revisión, y para eso está la revisión; una factura de la que se
 * entendieron dos renglones de once no se corrige a mano, se saca de nuevo.
 *
 * Los casos de acá salen de fotos reales. Los dos de Los Calvos son los que
 * obligaron a escribir el control, y quedan como casos de calidad insuficiente:
 * mientras esas fotos se lean así, esta lectura tiene que rechazarse.
 */
describe('¿la lectura sirve para revisar?', () => {
  it('una lectura completa pasa', () => {
    const veredicto = evaluarLecturaUtilizable({
      articulos: 23,
      filasEnLaImagen: 22,
      zonasPorProporcion: false,
      encabezadoReconocido: true,
      analizador: 'errecalde',
    });
    expect(veredicto.utilizable).toBe(true);
    expect(veredicto.motivos).toEqual([]);
  });

  it('sin analizador no hay con qué interpretar el comprobante', () => {
    // Los Calvos 0010-00212356: la página entera devolvió mil quinientos
    // caracteres y ningún analizador reconoció un comprobante.
    const veredicto = evaluarLecturaUtilizable({ articulos: 0, analizador: null });
    expect(veredicto.utilizable).toBe(false);
    expect(veredicto.motivos.join(' ')).toContain('con qué reglas');
  });

  it('cero artículos no se acepta ni con el encabezado reconocido', () => {
    /*
     * Es el caso que más engaña: se ve el nombre del proveedor y el número, la
     * pantalla parece haber entendido el comprobante, y la tabla está vacía. Sin
     * este control se ofrecería crear una compra sin un solo artículo.
     */
    const veredicto = evaluarLecturaUtilizable({
      articulos: 0,
      encabezadoReconocido: true,
      analizador: 'los-calvos',
    });
    expect(veredicto.utilizable).toBe(false);
    expect(veredicto.motivos.join(' ')).toContain('encabezado');
  });

  it('el reparto por proporciones significa que la tabla no se encontró', () => {
    /*
     * Cuando ninguna línea de la página parece una fila, el recorte de artículos
     * se ubica a ciegas y puede caer sobre el membrete. Que igual salgan
     * artículos no lo salva: salieron de mirar el lugar equivocado.
     */
    const veredicto = evaluarLecturaUtilizable({
      articulos: 3,
      filasEnLaImagen: null,
      zonasPorProporcion: true,
      encabezadoReconocido: true,
      analizador: 'generico',
    });
    expect(veredicto.utilizable).toBe(false);
    expect(veredicto.motivos.join(' ')).toContain('encontró la tabla de artículos');
  });

  it('dos renglones de once es una lectura que no ocurrió', () => {
    // Los Calvos 0010-00213103, la foto que llegó reescalada a 1441×1600.
    const veredicto = evaluarLecturaUtilizable({
      articulos: 2,
      filasEnLaImagen: 11,
      zonasPorProporcion: false,
      encabezadoReconocido: true,
      analizador: 'los-calvos',
    });
    expect(veredicto.utilizable).toBe(false);
    expect(veredicto.motivos.join(' ')).toContain('11');
    expect(veredicto.motivos.join(' ')).toContain('2');
  });

  it('un renglón perdido de veintitrés no frena nada', () => {
    /*
     * El límite existe para el salto grande. El control fino —falta uno, falta
     * dos— lo hace la validación, que deja el comprobante en revisión con el
     * detalle de qué no cierra. Si este control se disparara ahí, mandaría a
     * sacar la foto de nuevo cada vez que falta un renglón que se completa a
     * mano en diez segundos.
     */
    const veredicto = evaluarLecturaUtilizable({
      articulos: 22,
      filasEnLaImagen: 23,
      analizador: 'errecalde',
    });
    expect(veredicto.utilizable).toBe(true);
  });

  it('justo en la mitad todavía no alcanza, y uno más sí', () => {
    const mitad = evaluarLecturaUtilizable({
      articulos: 5,
      filasEnLaImagen: 10,
      analizador: 'x',
    });
    const unoMas = evaluarLecturaUtilizable({
      articulos: 6,
      filasEnLaImagen: 10,
      analizador: 'x',
    });
    // 5 de 10 no es "falta más de la mitad": es exactamente la mitad.
    expect(mitad.utilizable).toBe(true);
    expect(unoMas.utilizable).toBe(true);
    expect(
      evaluarLecturaUtilizable({ articulos: 4, filasEnLaImagen: 10, analizador: 'x' }).utilizable,
    ).toBe(false);
  });

  it('los renglones que no llegan ni a la mitad del pie delatan lo que falta', () => {
    /*
     * La medida que no necesita contar filas: el papel dice cuánto suma. De los
     * nueve renglones de Los Calvos salieron los dos primeros —306.666,10 de un
     * neto impreso de 1.792.751,44—, y eso alcanza para saber que faltan
     * renglones aunque el detector no haya contado ninguno.
     */
    const veredicto = evaluarLecturaUtilizable({
      articulos: 2,
      filasEnLaImagen: null,
      analizador: 'los-calvos',
      sumaDeRenglones: '306666.10',
      netoImpreso: '1792751.44',
    });
    expect(veredicto.utilizable).toBe(false);
    expect(veredicto.motivos.join(' ')).toContain('neto impreso');
  });

  it('un total leído de más no frena nada: eso se corrige a mano', () => {
    /*
     * Mabelherdi, hoy: nueve renglones de nueve, y la suma da 51.621,15 contra
     * 32.998,85 impresos porque algún precio unitario salió mal reconocido. Eso
     * es exactamente lo que la pantalla de revisión existe para arreglar. Si
     * este control se disparara acá, la factura que hoy se puede cargar
     * dejaría de poder cargarse: empeorar una para proteger otra.
     */
    const veredicto = evaluarLecturaUtilizable({
      articulos: 9,
      filasEnLaImagen: 10,
      analizador: 'mabelherdi',
      sumaDeRenglones: '51621.15',
      netoImpreso: '32998.85',
    });
    expect(veredicto.utilizable).toBe(true);
  });

  it('Errecalde, con su diferencia de 130.335,29, sigue entrando a revisión', () => {
    // 3.700.132,08 leídos contra 3.830.467,37 impresos: falta el 3,4 %, no la
    // mitad. Es una factura para revisar, no para volver a fotografiar.
    const veredicto = evaluarLecturaUtilizable({
      articulos: 23,
      filasEnLaImagen: 23,
      analizador: 'errecalde',
      sumaDeRenglones: '3700132.08',
      netoImpreso: '3830467.37',
    });
    expect(veredicto.utilizable).toBe(true);
  });

  it('sin pie impreso no hay contra qué comparar', () => {
    const veredicto = evaluarLecturaUtilizable({
      articulos: 2,
      analizador: 'x',
      sumaDeRenglones: '100.00',
      netoImpreso: null,
    });
    expect(veredicto.utilizable).toBe(true);
  });

  it('sin conteo de filas no se inventa un veredicto', () => {
    /*
     * Un intento guardado por una versión anterior no trae el conteo del
     * detector. Ausencia de dato no es evidencia de fallo: sin la medida
     * independiente, este control no tiene nada que decir sobre cuánto falta.
     */
    const veredicto = evaluarLecturaUtilizable({
      articulos: 4,
      filasEnLaImagen: null,
      analizador: 'x',
    });
    expect(veredicto.utilizable).toBe(true);
  });

  it('acumula los motivos en vez de quedarse con el primero', () => {
    // Quien lee el mensaje tiene que poder entender qué pasó, no una parte.
    const veredicto = evaluarLecturaUtilizable({
      articulos: 0,
      filasEnLaImagen: null,
      zonasPorProporcion: true,
      encabezadoReconocido: false,
      analizador: null,
    });
    expect(veredicto.utilizable).toBe(false);
    expect(veredicto.motivos.length).toBe(3);
  });

  it('el mensaje que ve la usuaria dice qué hacer, en castellano', () => {
    /*
     * No es decoración: el mensaje es la única instrucción que recibe quien
     * está parado frente al mostrador con el papel en la mano. Tiene que decir
     * las tres cosas que arreglan la foto.
     */
    expect(MENSAJE_LECTURA_INSUFICIENTE).toContain('foto original');
    expect(MENSAJE_LECTURA_INSUFICIENTE).toContain('papel completo');
    expect(MENSAJE_LECTURA_INSUFICIENTE).toContain('buena luz');
    expect(MENSAJE_LECTURA_INSUFICIENTE).toContain('sin movimiento');
  });
});
