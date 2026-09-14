import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { bandasDe, reconstruirTabla } from '@/lib/ocr/reconstruccion/reconstruccion';
import { interpretarReconstruccion } from '@/lib/ocr/motor/desde-reconstruccion';
import { soloBloqueantes } from '@/lib/ocr/motor/pendientes';
import {
  ALTO,
  RENGLONES,
  SALTO,
  TITULOS,
  Y_TITULOS,
  evidencia,
  fila,
  palabra,
  tablaBase,
} from '@/../tests/fixtures/evidencia-sintetica';
import type { Fragmento, EvidenciaDeLectura } from '@/lib/ocr/reconstruccion/evidencia';
import type { TablaReconstruida } from '@/lib/ocr/reconstruccion/reconstruccion';
import type { EvidenciaDeRelectura } from '@/lib/ocr/reconstruccion/relectura';

/**
 * Qué entra a la tabla como artículo y qué no.
 *
 * La regla vieja —«dos celdas llenas y un número»— es una sola evidencia mirada
 * dos veces: si el OCR alucinó una línea, alucinó las dos celdas. El costo se
 * midió sobre fotos reales: una grilla impresa que sigue dibujada debajo del
 * último artículo producía dieciséis renglones que no existen, cada uno con sus
 * bloqueos, y el lote nuevo entero traía veintidós filas inventadas.
 *
 * Ahora hace falta apoyo de **familias distintas** de evidencia, y lo que no se
 * prueba no se tira: queda pendiente, visible, dentro de la banda de artículos.
 *
 * Las coordenadas de estas pruebas son verosímiles pero el contenido es
 * inventado: las facturas del lote nuevo y sus transcripciones no entran al
 * repositorio.
 */

function reconstruir(fragmentos: Fragmento[]): TablaReconstruida {
  return reconstruirTabla(evidencia(fragmentos));
}

/** Los renglones que quedaron, como texto plano. */
function comoTexto(tabla: TablaReconstruida): string[] {
  return tabla.renglones.map((r) => r.celdas.map((c) => c?.texto ?? '·').join('|'));
}

const DEL_BANCO = path.resolve(__dirname, '../fixtures/evidencia');
const CUIT_DEL_RECEPTOR = '27-33342291-9';

function delBanco(nombre: string): EvidenciaDeLectura {
  return JSON.parse(readFileSync(path.join(DEL_BANCO, `${nombre}.json`), 'utf8'));
}

function relecturaDe(nombre: string): EvidenciaDeRelectura | undefined {
  const archivo = path.join(DEL_BANCO, `${nombre}-relectura.json`);
  return existsSync(archivo) ? JSON.parse(readFileSync(archivo, 'utf8')) : undefined;
}

/** La altura de la primera línea después de los tres renglones de la tabla base. */
const Y_DESPUES = Y_TITULOS + SALTO * 4;

// ---------------------------------------------------------------------------
// Lo que no es un artículo
// ---------------------------------------------------------------------------

describe('lo que no puede ser un artículo no entra a la tabla', () => {
  it('una grilla impresa que sigue vacía no agrega renglones', () => {
    /*
     * Es el caso que originó la corrección. Debajo del último artículo, el
     * comprobante sigue teniendo la grilla dibujada: el OCR devuelve los bordes
     * de cada celda como caracteres sueltos —«|», «l», «.»— repartidos por las
     * mismas columnas que los artículos de arriba.
     */
    const grilla = [4, 5, 6, 7, 8, 9].flatMap((n) =>
      fila(Y_TITULOS + SALTO * n, [
        ['1', 0.05],
        ['I', 0.20],
        ['0', 0.52],
        ['l', 0.65],
        ['0', 0.82],
      ]),
    );

    const tabla = reconstruir([...tablaBase(), ...grilla]);

    expect(tabla.renglones).toHaveLength(3);
    expect(comoTexto(tabla)).toEqual([
      '47|Cremoso|4|5.700,00|22.800,00',
      '48|Provolone|2|9.600,00|19.200,00',
      '10|Jamon|3|9.800,00|29.400,00',
    ]);
  });

  it('una marca de agua con letras y números tampoco es un renglón', () => {
    /*
     * Tiene texto y tiene cifras, que es todo lo que pedía la regla vieja. Lo
     * que no tiene es una cuenta que cierre ni columnas que coincidan con las
     * de los artículos: está atravesada en la página, como se imprime una marca
     * de agua.
     */
    const marca = [
      palabra('ORIGINAL', 0.20, Y_TITULOS + SALTO * 5, { alto: ALTO * 3 }),
      palabra('2026', 0.82, Y_TITULOS + SALTO * 5, { alto: ALTO * 3 }),
    ];

    const tabla = reconstruir([...tablaBase(), ...marca]);

    expect(tabla.renglones).toHaveLength(3);
    expect(comoTexto(tabla).join('\n')).not.toContain('ORIGINAL');
    // Y si llegó a mirarse como línea, quedó clasificada como lo que es.
    const suya = tabla.hipotesis.find((h) =>
      h.celdas.some((c) => c?.texto?.includes('ORIGINAL')),
    );
    expect(suya?.clase ?? 'ruido').toBe('ruido');
  });

  it('una línea del pie, aunque caiga dentro del ancho de la tabla, no es un artículo', () => {
    /*
     * «Subtotal 71.400,00» ocupa las mismas columnas que los artículos y tiene
     * un número perfectamente legible. Lo que no tiene es identidad propia ni
     * una cuenta suya, y está separada del bloque de artículos.
     */
    const pie = fila(Y_TITULOS + SALTO * 4, [
      ['Recibido conforme', 0.20],
      ['71.400,00', 0.82],
    ]);

    const tabla = reconstruir([...tablaBase(), ...pie]);

    expect(tabla.renglones).toHaveLength(3);
    expect(comoTexto(tabla).join('\n')).not.toContain('Recibido');
    const suya = tabla.hipotesis.find((h) =>
      h.celdas.some((c) => c?.texto?.includes('Recibido')),
    );
    expect(suya?.clase).toBe('ruido');
    // Tiene un nombre y tiene un número; lo que no tiene es una segunda familia.
    expect(suya?.apoyos).toEqual(['identidad']);
  });

  it('una línea que repite el código del renglón de al lado es el mismo, no otro', () => {
    /*
     * Una pasada ampliada deja el código de un artículo un poco más abajo que el
     * resto de su línea, y esa línea suelta —el mismo código y poco más— se
     * colaba como un artículo nuevo. No es un renglón que el OCR leyó mal: es el
     * renglón de arriba, contado dos veces.
     */
    const repetida = fila(Y_TITULOS + SALTO * 3.5, [
      ['10', 0.05],
      ['Jamon', 0.20],
      ['9.800,00', 0.65],
    ]);

    const tabla = reconstruir([...tablaBase(), ...repetida]);

    expect(tabla.renglones).toHaveLength(3);
    const suya = tabla.hipotesis[tabla.hipotesis.length - 1];
    expect(suya.clase).toBe('ruido');
    expect(suya.motivo).toContain('el mismo, leído dos veces');
  });

  it('una línea sola, lejos de la lista y sin ninguna cuenta que cierre, no es un artículo', () => {
    /*
     * Un artículo es parte de una lista. Cuando ya hay una lista formada, una
     * línea suelta a varios renglones de distancia de todos sus renglones tiene
     * que traer algo más que un texto y dos números: tiene que traer una cuenta.
     * Es lo que separaba, sobre una de las facturas nuevas, los cinco artículos
     * de una línea de basura tirada a media página, debajo del pie.
     */
    const suelta = fila(Y_TITULOS + SALTO * 9, [
      ['Varios', 0.20],
      ['7.000,00', 0.65],
      ['3.100,00', 0.82],
    ]);

    const tabla = reconstruir([...tablaBase(), ...suelta]);
    const suya = tabla.hipotesis.find((h) => h.celdas.some((c) => c?.texto === 'Varios'));
    expect(suya?.clase).toBe('ruido');
    expect(suya?.motivo).toContain('Está sola');
    expect(tabla.renglones).toHaveLength(3);
  });

  it('pero si la cuenta de esa línea cierra, entra igual de lejos que esté', () => {
    // La otra cara: lo que se pide no es cercanía, es evidencia.
    const suelta = fila(Y_TITULOS + SALTO * 9, [
      ['Varios', 0.20],
      ['2', 0.52],
      ['3.100,00', 0.65],
      ['6.200,00', 0.82],
    ]);

    const tabla = reconstruir([...tablaBase(), ...suelta]);
    const suya = tabla.hipotesis.find((h) => h.celdas.some((c) => c?.texto === 'Varios'));
    expect(suya?.clase).toBe('aceptado');
    expect(suya?.apoyos).toContain('aritmetica');
  });

  it('dos cifras sueltas en dos columnas no son los números de un renglón', () => {
    /*
     * «AUD», «7» y «4» es lo que el OCR saca de una línea de ruido, y con la
     * regla de «dos columnas con números» entraba como artículo. Un valor de una
     * tabla de precios tiene tres cifras o tiene coma; un dígito suelto no es un
     * valor de nada.
     */
    const suelta = fila(Y_TITULOS + SALTO * 4, [
      ['AUD', 0.20],
      ['7', 0.52],
      ['4', 0.82],
    ]);

    const tabla = reconstruir([...tablaBase(), ...suelta]);

    expect(tabla.renglones).toHaveLength(3);
    const suya = tabla.hipotesis.find((h) => h.celdas.some((c) => c?.texto === 'AUD'));
    expect(suya?.clase).toBe('ruido');
    expect(suya?.apoyos).toEqual(['identidad']);
  });

  it('el mismo fragmento leído por varias pasadas cuenta una vez, no una por pasada', () => {
    /*
     * La trampa que hay que evitar: cinco pasadas leen la misma línea de basura
     * y, si cada lectura contara como una evidencia, cinco coincidencias
     * parecerían cinco confirmaciones. Son la misma cosa vista cinco veces.
     */
    const pasadas = [
      'completo:directo',
      'encabezado:directo',
      'encabezado:limpieza-fuerte',
      'articulos:directo',
      'articulos:limpieza-fuerte',
    ];
    const basura = pasadas.flatMap((p) =>
      fila(Y_DESPUES, [['AAA', 0.20]], { pasada: p, confianza: 0.9 }),
    );

    const tabla = reconstruir([...tablaBase(), ...basura]);

    expect(tabla.renglones).toHaveLength(3);
    const suya = tabla.hipotesis.find((h) => h.celdas.some((c) => c?.texto === 'AAA'));
    expect(suya?.clase).toBe('ruido');
    expect(suya?.apoyos).not.toContain('numeros');
  });
});

// ---------------------------------------------------------------------------
// Lo que sí es, aunque no lo parezca
// ---------------------------------------------------------------------------

describe('lo que sí es un artículo se conserva', () => {
  it('una descripción partida en dos líneas se pega a su artículo', () => {
    /*
     * «STRE CAV» debajo de un artículo es el final de su nombre. Antes entraba
     * como renglón propio: contaba como una fila sin importe —con lo que el
     * control de integridad concluía que faltaban renglones— y le pedía a una
     * persona que completara sus celdas.
     */
    const resto = fila(Y_TITULOS + SALTO * 3.6, [['DE CAMPO', 0.20]]);

    const tabla = reconstruir([...tablaBase(), ...resto]);

    expect(tabla.renglones).toHaveLength(3);
    expect(comoTexto(tabla)[2]).toContain('Jamon DE CAMPO');
    const continuacion = tabla.hipotesis.find((h) => h.clase === 'continuacion');
    expect(continuacion).toBeDefined();
    expect(continuacion!.continuacionDe).not.toBeNull();
  });

  it('un renglón real al que le falta una celda queda pendiente, no se elimina', () => {
    /*
     * El OCR le comió el importe. Solo no se prueba —le queda el código, la
     * descripción y una cantidad— pero está donde van los artículos, ocupa sus
     * mismas columnas y viene en el orden que le toca. Se conserva y se
     * muestra; no se afirma.
     */
    const incompleto = fila(Y_TITULOS + SALTO * 4, [
      ['52', 0.05],
      ['Muzzarella', 0.20],
      ['6', 0.52],
      ['3.100,00', 0.65],
    ]);

    const tabla = reconstruir([...tablaBase(), ...incompleto]);

    expect(tabla.renglones).toHaveLength(4);
    const suyo = tabla.hipotesis.find((h) => h.celdas.some((c) => c?.texto === 'Muzzarella'));
    expect(suyo?.clase).toBe('aceptado');
    expect(comoTexto(tabla)[3]).toContain('Muzzarella');
  });

  it('un renglón legítimo impreso un poco más separado no se pierde', () => {
    /*
     * El corte por distancia fija se equivoca en las dos direcciones: deja
     * entrar la grilla vacía y se come el último renglón cuando el comprobante
     * lo imprime más separado. Acá el cuarto artículo está al doble de
     * distancia que los otros y tiene que seguir estando.
     */
    const separado = fila(Y_TITULOS + SALTO * 5, [
      ['61', 0.05],
      ['Salame', 0.20],
      ['2', 0.52],
      ['8.150,00', 0.65],
      ['16.300,00', 0.82],
    ]);

    const tabla = reconstruir([...tablaBase(), ...separado]);

    expect(tabla.renglones).toHaveLength(4);
    expect(comoTexto(tabla)[3]).toBe('61|Salame|2|8.150,00|16.300,00');
  });

  it('un espacio grande propone terminar la tabla, y la propuesta compite', () => {
    /*
     * El final de la tabla no lo dice nadie: se propone y se decide con el
     * resto de la evidencia. Lo que se comprueba acá es que la propuesta
     * **existe** y cae donde corresponde; cuál gana lo resuelve la aritmética
     * del comprobante entero, un piso más arriba.
     */
    const lejos = fila(Y_TITULOS + SALTO * 8, [
      ['Manteca', 0.20],
      ['1', 0.52],
      ['900,00', 0.65],
      ['900,00', 0.82],
    ]);

    const tabla = reconstruir([...tablaBase(), ...lejos]);
    const bandas = bandasDe(tabla);

    // La primera candidata nunca corta: ninguna puede perder renglones sin que
    // exista, al lado, la que los conserva.
    expect(bandas[0].hastaY).toBe(1);
    const corte = bandas.find((b) => b.hastaY < 1);
    expect(corte).toBeDefined();
    expect(corte!.origen).toContain('espacio');
    expect(corte!.hastaY).toBeGreaterThan(Y_TITULOS + SALTO * 3);
    expect(corte!.hastaY).toBeLessThan(Y_TITULOS + SALTO * 8);
  });
});

// ---------------------------------------------------------------------------
// Un solo espacio de coordenadas
// ---------------------------------------------------------------------------

describe('todas las decisiones se toman en el mismo espacio', () => {
  it('la misma tabla inclinada y derecha da los mismos renglones', () => {
    /*
     * La garantía de fondo: la geometría se decide **siempre** en el espacio
     * canónico —normalizado y enderezado— y la caja de la foto queda sólo como
     * procedencia. Cuando convivían los dos espacios, la corrección de
     * inclinación se perdía justo en las celdas con más apoyo, que son las que
     * juntan varias pasadas.
     */
    const derecha = reconstruir(tablaBase());
    const inclinada = reconstruir(tablaBase({ pendiente: ALTO * 1.2 }));

    expect(inclinada.seEnderezo).toBe(true);
    expect(comoTexto(inclinada)).toEqual(comoTexto(derecha));
  });

  it('y la caja que se señala en la foto sigue siendo la torcida', () => {
    const inclinada = reconstruir(tablaBase({ pendiente: ALTO * 1.2 }));
    const izquierda = inclinada.renglones[0].celdas[0]!;
    const derecha = inclinada.renglones[0].celdas[4]!;

    // En la foto, la celda de la derecha está más abajo que la de la izquierda.
    expect(derecha.procedencia!.cajaEnLaFoto.y0).toBeGreaterThan(
      izquierda.procedencia!.cajaEnLaFoto.y0,
    );
    // En el espacio donde se decide, las dos están a la misma altura.
    expect(Math.abs(derecha.alternativas[0].caja.y0 - izquierda.alternativas[0].caja.y0)).toBeLessThan(
      ALTO * 0.5,
    );
  });

  it('corregir el espacio no le agrega renglones fantasma a Los Calvos', () => {
    /*
     * La medición que obligó a hacer las dos cosas juntas. Corregir sólo las
     * coordenadas convertía la foto ilegible de Los Calvos en dieciséis
     * renglones inventados y la mandaba a revisión; con el control de filas
     * puesto, la foto se rechaza, que es lo que corresponde decirle a alguien
     * que sacó una foto que no se lee.
     */
    const informe = interpretarReconstruccion(delBanco('los-calvos-212356'), {
      cuitDelReceptor: CUIT_DEL_RECEPTOR,
    });

    expect(informe.veredicto.decision).toBe('rechazo');
  });
});

// ---------------------------------------------------------------------------
// Sobre las fotos del banco
// ---------------------------------------------------------------------------

describe('sobre el banco de diseño no se pierde un solo artículo', () => {
  const ESPERADOS: [string, number][] = [
    ['ezra', 6],
    ['barraza', 2],
    ['mabelherdi', 9],
    ['errecalde', 23],
  ];

  for (const [nombre, cuantos] of ESPERADOS) {
    it(`${nombre}: los ${cuantos} artículos siguen estando`, () => {
      const informe = interpretarReconstruccion(delBanco(nombre), {
        cuitDelReceptor: CUIT_DEL_RECEPTOR,
        relectura: relecturaDe(nombre),
      });
      expect(informe.tabla.renglones).toHaveLength(cuantos);
    });
  }

  it('las continuaciones y el ruido descartado no le generan trabajo a nadie', () => {
    /*
     * La otra mitad de la garantía: una línea que no llegó a artículo no puede
     * convertirse en una pregunta. Si la basura descartada dejara bloqueos, la
     * corrección no habría servido de nada: la persona seguiría revisando filas
     * fantasma, sólo que con otro nombre.
     */
    let descartadasEnTotal = 0;
    for (const [nombre] of ESPERADOS) {
      const informe = interpretarReconstruccion(delBanco(nombre), {
        cuitDelReceptor: CUIT_DEL_RECEPTOR,
      });
      descartadasEnTotal += informe.tabla.hipotesis.filter(
        (h) => h.clase === 'ruido' || h.clase === 'continuacion',
      ).length;

      // Ningún bloqueo apunta a un renglón que no está en la tabla.
      const renglones = informe.tabla.renglones.length;
      for (const pendiente of soloBloqueantes(informe.pendientes)) {
        if (pendiente.renglon === null) continue;
        expect(pendiente.renglon, `${nombre}: ${pendiente.motivo}`).toBeLessThanOrEqual(renglones);
        expect(pendiente.renglon, `${nombre}: ${pendiente.motivo}`).toBeGreaterThan(0);
      }
    }
    // Y algo se descartó: si no, la prueba no estaría midiendo nada.
    expect(descartadasEnTotal).toBeGreaterThan(0);
  });
});
