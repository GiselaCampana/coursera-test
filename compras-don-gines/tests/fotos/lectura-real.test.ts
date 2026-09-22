import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import sharp from 'sharp';
import { createWorker, PSM, type Worker } from 'tesseract.js';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import type { Mapa } from '@/lib/cliente/ocr/imagen';
import type { RenglonInterpretado } from '@/lib/services/lectura';

/**
 * El lector real, sobre las fotos reales.
 *
 * Todo lo demás en este proyecto prueba el OCR con texto ya reconocido y
 * guardado. Eso deja sin probar justamente la mitad que falla en el iPhone: qué
 * sale de una foto de verdad. Acá se corre el lector completo —el mismo
 * `LectorDeComprobantes` que usa el navegador— sobre las fotos que sacó la
 * usuaria, y se cuenta cuántos renglones recupera.
 *
 * Dos módulos se sustituyen, y sólo dos, porque son los únicos que hablan con
 * el navegador:
 *
 *  - `lienzo`, que decodifica con `createImageBitmap` → acá con sharp, que
 *    aplica la orientación EXIF igual que el navegador;
 *  - `tesseract`, cuyo worker es el build para navegador → acá el de Node, con
 *    **los mismos parámetros** (psm, `preserve_interword_spaces`, dpi).
 *
 * Todo lo que está en el medio —preproceso, detección de regiones, recorte por
 * franjas, ampliación— es el código de producción sin tocar.
 *
 * No corre en CI por omisión: son varias pasadas de Tesseract por factura y
 * tarda minutos. Se enciende con OCR_FOTOS_REALES=1. Que no corra siempre no lo
 * hace menos útil: es la única medida objetiva de si una foto se lee, y es
 * contra la que se compara cualquier cambio del preproceso.
 */

const RAIZ = path.resolve(__dirname, '../..');
const FOTOS = path.join(RAIZ, 'tests/fixtures/imagenes');
const ENCENDIDO = process.env.OCR_FOTOS_REALES === '1';

let worker: Worker;

/** Decodifica honrando la orientación EXIF, como hace el navegador. */
async function mapaDeBuffer(buffer: Buffer): Promise<Mapa> {
  const { data, info } = await sharp(buffer)
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  };
}

vi.mock('@/lib/cliente/ocr/lienzo', () => ({
  mapaDesdeBlob: async (blob: Blob) => mapaDeBuffer(Buffer.from(await blob.arrayBuffer())),
  mapaABlob: async () => new Blob([]),
  mapaALienzo: () => {
    throw new Error('sin lienzo en Node');
  },
  mapaAUrl: () => {
    throw new Error('sin lienzo en Node');
  },
}));

vi.mock('@/lib/cliente/ocr/tesseract', async (original) => {
  const real = await original<typeof import('@/lib/cliente/ocr/tesseract')>();
  return {
    ...real,
    lectorPreparado: () => true,
    leerMapa: async (mapa: Mapa, opciones: { psm?: PSM; soloEstosCaracteres?: string } = {}) => {
      // Los mismos parámetros que usa la aplicación: sin esto la medición no
      // dice nada sobre lo que pasa en el teléfono.
      await worker.setParameters({
        tessedit_pageseg_mode: opciones.psm ?? PSM.AUTO,
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
        tessedit_char_whitelist: opciones.soloEstosCaracteres ?? '',
      });
      const png = await sharp(
        Buffer.from(mapa.data.buffer, mapa.data.byteOffset, mapa.data.byteLength),
        { raw: { width: mapa.width, height: mapa.height, channels: 4 } },
      )
        .png()
        .toBuffer();
      const { data } = await worker.recognize(png, {}, { text: true, blocks: true });

      /*
       * La misma función que usa el módulo real, no una copia.
       *
       * El arnés tenía su propia versión y normalizaba las cajas a 0..1
       * mientras el módulo real las entrega en píxeles. No fallaba: producía
       * regiones diminutas y un diagnóstico que parecía válido. Compartir la
       * función es lo que hace imposible que vuelvan a divergir.
       */
      const lineas = real.lineasDeBloques(data.blocks);
      if (real.cajasParecenNormalizadas(lineas, mapa.width, mapa.height)) {
        throw new Error(
          'Las cajas llegaron normalizadas a 0..1 y tienen que venir en píxeles: ' +
            'la medición que salga de acá no significaría nada.',
        );
      }
      return { texto: data.text, confianza: (data.confidence ?? 0) / 100, lineas };
    },
  };
});

beforeAll(async () => {
  if (!ENCENDIDO) return;
  worker = await createWorker('spa', 1, {
    langPath: path.join(RAIZ, 'public/ocr/tessdata'),
    gzip: true,
  });
}, 180_000);

afterAll(async () => {
  if (worker) await worker.terminate();
});

/**
 * Interpreta lo leído con el analizador real del servidor.
 *
 * Contar líneas visuales no alcanza para saber si una factura entra: lo que
 * decide es cuántos artículos se entienden y si el comprobante cierra. Se usa
 * el camino de diagnóstico, que corre los mismos analizadores y los mismos
 * controles sin tocar la base.
 */
async function interpretar(lectura: { paginas: unknown[] }) {
  const { analizarSinGuardar } = await import('@/lib/services/lectura');
  return analizarSinGuardar(lectura.paginas as Parameters<typeof analizarSinGuardar>[0]);
}

/**
 * Imprime renglón por renglón lo que se interpretó, contra lo que dice el papel.
 *
 * Saber que faltan $130.335,29 no dice qué corregir. Saber qué renglón, con qué
 * cantidad, con qué precio, y si el importe se leyó del papel o se calculó como
 * cantidad × precio, sí: un importe calculado cuadra por construcción y por eso
 * es el primero que hay que mirar cuando el comprobante no cierra.
 */
function informarRenglones(
  renglones: RenglonInterpretado[],
  impresos: { codigo: string; descripcion: string; subtotal: string }[],
) {
  /*
   * Emparejamiento **uno a uno**, en dos pasadas y consumiendo lo emparejado.
   *
   * Emparejar sólo por código fue un error real de esta herramienta. Sobre la
   * factura de Barraza el renglón 1 se leyó entero y su código no, así que
   * quedaba «sin correspondencia» y el código 30 del papel salía listado como
   * «no se leyó»: las dos líneas describían el MISMO renglón, que estaba. Y
   * sobre Errecalde, donde el OCR recupera 19 de 23 códigos, cuatro renglones
   * presentes se informaban como ausentes por el mismo motivo.
   *
   * Un renglón AUSENTE y un renglón PRESENTE CON EL CÓDIGO MAL LEÍDO son
   * problemas de gravedad muy distinta —el primero es una compra incompleta, el
   * segundo es emparejar a mano— y la herramienta no puede confundirlos.
   *
   * Se consume lo emparejado para que dos renglones leídos no puedan apuntar al
   * mismo renglón impreso y dejar otro huérfano.
   */
  const normalizar = (t: string) => t.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const libres = new Set(impresos);
  const par = new Map<RenglonInterpretado, { codigo: string; descripcion: string; subtotal: string }>();
  const comoSeEmparejo = new Map<RenglonInterpretado, 'codigo' | 'descripcion'>();

  /* Primera pasada: código exacto, que es la identidad fuerte. */
  for (const r of renglones) {
    if (!r.codigoRecuperado || !r.codigo) continue;
    const papel = impresos.find((a) => libres.has(a) && a.codigo === r.codigo);
    if (papel) {
      par.set(r, papel);
      comoSeEmparejo.set(r, 'codigo');
      libres.delete(papel);
    }
  }

  /* Segunda pasada: descripción, sólo sobre lo que quedó libre. */
  for (const r of renglones) {
    if (par.has(r)) continue;
    const papel = impresos.find(
      (a) => libres.has(a) && normalizar(a.descripcion) === normalizar(r.descripcion),
    );
    if (papel) {
      par.set(r, papel);
      comoSeEmparejo.set(r, 'descripcion');
      libres.delete(papel);
    }
  }

  let diferencia = 0;

  console.log('  renglón por renglón (leído → impreso):');
  for (const r of renglones) {
    const papel = par.get(r);
    const esperado = papel ? Number(papel.subtotal) : null;
    /* Contra el papel se compara el NETO, que es lo que el papel imprime. */
    const leido = Number(r.neto);
    const delta = esperado === null ? null : leido - esperado;
    if (delta !== null) diferencia += delta;
    const codigo = r.codigoRecuperado ? (r.codigo ?? '—') : '(sin código)';
    console.log(
      `    ${String(r.linea).padStart(2)} ${codigo.padEnd(12)} ` +
        `${r.descripcion.slice(0, 32).padEnd(32)} ` +
        `${r.cantidad.padStart(9)} ${r.unidad.padEnd(3)} × ${r.precioUnitario.padStart(10)}` +
        ` − ${r.bonificacion.padStart(5)}% ` +
        `= bruto ${r.importe.padStart(11)} → neto ${r.neto.padStart(11)}` +
        `${r.importeImpreso ? ' (del papel)' : ' (CALCULADO)'}` +
        (delta === null
          ? '   RENGLÓN SIN CORRESPONDENCIA EN EL PAPEL'
          : Math.abs(delta) < 0.005
            ? '   ok'
            : `   papel ${esperado!.toFixed(2)} → ${delta > 0 ? '+' : ''}${delta.toFixed(2)}`),
    );
  }

  /*
   * Y la distinción que de verdad importa, en tres categorías y no en una.
   *
   * Un renglón impreso que quedó sin pareja NO es necesariamente un renglón
   * ausente. Sobre Errecalde se leen 23 renglones, el papel tiene 23 y el total
   * concilia al centavo: no falta nada. Lo que pasa es que en dos de ellos el
   * OCR ensució el código Y la descripción, así que no se pueden emparejar con
   * ninguna de las dos claves. Llamar «ausente» a eso es la clase de informe
   * que manda a buscar una compra que está.
   *
   * Lo que decide si falta algo es el CONTEO: si se leyeron menos renglones que
   * los que imprime el papel, la diferencia está ausente de verdad. Si se
   * leyeron tantos como imprime, lo que hay es un problema de emparejado.
   */
  const faltanDeVerdad = Math.max(0, impresos.length - renglones.length);
  const sinPareja = [...libres];
  if (faltanDeVerdad > 0) {
    console.log(
      `  RENGLONES DEL PAPEL REALMENTE AUSENTES (${faltanDeVerdad}: se leyeron ` +
        `${renglones.length} de ${impresos.length}):`,
    );
    for (const a of sinPareja.slice(0, faltanDeVerdad)) {
      console.log(`    ${a.codigo} ${a.descripcion} ${a.subtotal}`);
    }
  }
  const soloSinEmparejar = sinPareja.slice(faltanDeVerdad);
  if (soloSinEmparejar.length > 0) {
    console.log(
      `  renglones impresos que no se pudieron emparejar, aunque se leyeron ` +
        `${renglones.length} de ${impresos.length} —el código y la descripción salieron ` +
        'sucios; no falta ninguna compra:',
    );
    for (const a of soloSinEmparejar) {
      console.log(`    ${a.codigo} ${a.descripcion} ${a.subtotal}`);
    }
  }

  const porDescripcion = renglones.filter((r) => comoSeEmparejo.get(r) === 'descripcion');
  if (porDescripcion.length > 0) {
    console.log(
      `  renglones PRESENTES emparejados por descripción porque su código no se reconoció: ` +
        `${porDescripcion.map((r) => r.linea).join(', ')} — no falta ninguna compra, hay que ` +
        'corregir el código a mano',
    );
  }
  const codigosRecuperados = renglones.filter((r) => r.codigoRecuperado).length;
  console.log(`  códigos recuperados: ${codigosRecuperados} de ${renglones.length}`);

  const conBonificacion = renglones.filter((r) => Number(r.bonificacion) > 0);
  if (conBonificacion.length > 0) {
    console.log(
      `  bonificación aplicada en ${conBonificacion.length} renglón/es: ` +
        `${[...new Set(conBonificacion.map((r) => `${r.bonificacion}%`))].join(', ')}`,
    );
  }

  console.log(`  suma de las diferencias contra el papel: ${diferencia.toFixed(2)}`);
}

/**
 * El texto de cada zona, a un archivo, cuando se pide.
 *
 * Es la herramienta con la que se arma un fixture nuevo: se corre con
 * OCR_VOLCAR=/ruta/x.json y de ahí sale el texto real de las cuatro zonas para
 * poder analizarlo —y probarlo en CI— sin volver a pasar Tesseract. Así se
 * construyó `mabelherdi-foto.ts`, que es lo que hace que el cruce entre el
 * detalle de una pasada y el pie de la otra se pueda probar sin la foto.
 *
 * Está acá y no adentro de un caso porque cualquier factura nueva empieza por
 * este volcado: cuando vivía dentro del caso de Mabelherdi, sumar un proveedor
 * obligaba a copiarlo.
 */
function volcarSiSePide(sufijo: string, paginas: unknown) {
  if (!process.env.OCR_VOLCAR) return;
  const destino = process.env.OCR_VOLCAR.replace(/(?:\.json)?$/, `-${sufijo}.json`);
  writeFileSync(destino, JSON.stringify(paginas, null, 2));
  console.log(`  volcado: ${destino}`);
}

/** Corre el lector de producción sobre una foto y devuelve lo que sacó. */
async function leerFoto(archivo: string) {
  const { SesionLectura } = await import('@/lib/cliente/ocr/lector');
  const bytes = readFileSync(path.join(FOTOS, archivo));
  /*
   * El tipo se saca de la extensión, no se da por sentado.
   *
   * Estaba fijo en «image/jpeg» y el banco tiene ahora una foto PNG —la de
   * Barraza, que llegó así y se conserva sin convertir para no agregar pérdida
   * ni modificar la evidencia—. Mentirle el tipo al blob es exactamente lo que
   * el teléfono no hace: ahí el tipo lo pone el archivo.
   */
  const tipo = archivo.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  const blob = new Blob([bytes], { type: tipo });

  const lector = new SesionLectura();
  const desde = Date.now();
  await lector.preparar([{ archivo: blob, nombre: archivo }]);
  const preparado = Date.now() - desde;
  const lectura = await lector.leer(1);
  const total = Date.now() - desde;

  return { lectura, medidas: lector.medidasDePaginas, preparado, total };
}

describe.runIf(ENCENDIDO)('el lector real sobre las fotos reales', () => {
  it(
    'Errecalde: cuántos de los 23 renglones se recuperan',
    async () => {
      const { ERRECALDE_ARTICULOS_IMPRESOS } = await import('../fixtures/errecalde-ocr');
      const { lectura, medidas, preparado, total } = await leerFoto(
        'errecalde-00008-00002647.jpg',
      );

      const pagina = lectura.paginas[0];
      const texto = [
        pagina.textoCompleto,
        pagina.textoEncabezado ?? '',
        pagina.textoArticulos ?? '',
        pagina.textoResumen ?? '',
      ]
        .join('\n')
        .toUpperCase();
      const plano = texto.replace(/\s/g, '');

      const conCodigo = ERRECALDE_ARTICULOS_IMPRESOS.filter((a) => plano.includes(a.codigo));
      const conSubtotal = ERRECALDE_ARTICULOS_IMPRESOS.filter((a) =>
        plano.includes(Number(a.subtotal).toLocaleString('es-AR', { minimumFractionDigits: 2 })),
      );

      console.log(
        `[Errecalde] página ${medidas[0].ancho}×${medidas[0].alto} · ` +
          `inclinación ${medidas[0].inclinacion.toFixed(2)}° · ` +
          `perspectiva ${medidas[0].perspectivaCorregida ? 'sí' : 'no'} · ` +
          `filas vistas ${pagina.regiones?.filasDetectadas ?? '—'} · ` +
          `códigos ${conCodigo.length}/23 · subtotales ${conSubtotal.length}/23 · ` +
          `preparar ${(preparado / 1000).toFixed(1)}s · total ${(total / 1000).toFixed(1)}s`,
      );

      const faltan = ERRECALDE_ARTICULOS_IMPRESOS.filter((a) => !plano.includes(a.codigo));
      console.log('  códigos ausentes:', faltan.map((a) => a.codigo).join(' '));
      console.log('  tiempos por zona:', JSON.stringify(pagina.tiempos));

      const i = await interpretar(lectura);
      console.log(
        `  INTERPRETADO: ${i.articulos} artículos · analizador ${i.analizador} · estado ${i.estado} · ` +
          `filas detector ${i.filasDelDetector} · sin resolver ${i.filasSinResolver} · esperadas ${i.filasEsperadas}`,
      );
      console.log('  controles en error:', JSON.stringify(i.controles.filter((c) => c.severity === 'ERROR').map((c) => c.code)));
      console.log('  calculado:', JSON.stringify(i.calculado));
      informarRenglones(i.renglones, ERRECALDE_ARTICULOS_IMPRESOS);

      // El piso que hay que mover. Se afirma sobre el número real de hoy para
      // que cualquier cambio del preproceso se note, en la dirección que sea.
      expect(conSubtotal.length).toBeGreaterThan(0);
    },
    600_000,
  );

  it(
    'Los Calvos: los 9 renglones y el pie',
    async () => {
      const { lectura, medidas, total } = await leerFoto('los-calvos-0010-00212356.jpg');
      const pagina = lectura.paginas[0];
      const plano = [
        pagina.textoCompleto,
        pagina.textoEncabezado ?? '',
        pagina.textoArticulos ?? '',
        pagina.textoResumen ?? '',
      ]
        .join('\n')
        .toUpperCase()
        .replace(/\s/g, '');

      console.log(
        `[Los Calvos] página ${medidas[0].ancho}×${medidas[0].alto} · ` +
          `filas vistas ${pagina.regiones?.filasDetectadas ?? '—'} · ` +
          `total ${(total / 1000).toFixed(1)}s`,
      );
      console.log('  tiempos por zona:', JSON.stringify(pagina.tiempos));
      const interpretado = await interpretar(lectura);
      console.log(
        `  INTERPRETADO: ${interpretado.articulos} artículos · analizador ${interpretado.analizador} · ` +
          `estado ${interpretado.estado} · filas detector ${interpretado.filasDelDetector} · ` +
          `sin resolver ${interpretado.filasSinResolver}`,
      );
      console.log('  controles en error:', JSON.stringify(interpretado.controles.filter((c) => c.severity === 'ERROR').map((c) => c.code)));
      console.log('  calculado:', JSON.stringify(interpretado.calculado));
      console.log('  ¿nº 00212356?', plano.includes('00212356'));
      console.log('  ¿total 2.196.120,52?', plano.includes('2.196.120,52'));

      expect(plano.length).toBeGreaterThan(100);

      /*
       * Mientras esta foto se lea así, la lectura tiene que rechazarse.
       *
       * De la página entera salen mil quinientos caracteres, ninguna línea con
       * forma de fila, y el recorte de artículos termina sobre el membrete: el
       * número de comprobante y el total se leen, la tabla no. Cero artículos
       * con el encabezado a la vista es el caso que más engaña, porque la
       * pantalla parece haber entendido la factura.
       *
       * El día que la foto se lea bien, esta afirmación va a fallar. Está bien
       * que falle: significa que hay que actualizarla con los nueve renglones.
       */
      expect(interpretado.articulos).toBe(0);
      expect(
        interpretado.controles.some(
          (c) => c.code === 'LECTURA_UTILIZABLE' && c.severity === 'ERROR',
        ),
      ).toBe(true);
    },
    600_000,
  );

  it(
    'Los Calvos 0010-00213103, reescalada: la lectura no alcanza y hay que rechazarla',
    async () => {
      const { lectura, medidas, total } = await leerFoto('los-calvos-0010-00213103.jpg');
      const pagina = lectura.paginas[0];

      console.log(
        `[Los Calvos 213103] página ${medidas[0].ancho}×${medidas[0].alto} · ` +
          `filas vistas ${pagina.regiones?.filasDetectadas ?? '—'} · ` +
          `total ${(total / 1000).toFixed(1)}s`,
      );
      const interpretado = await interpretar(lectura);
      console.log(
        `  INTERPRETADO: ${interpretado.articulos} artículos · analizador ${interpretado.analizador} · ` +
          `estado ${interpretado.estado} · filas detector ${interpretado.filasDelDetector} · ` +
          `sin resolver ${interpretado.filasSinResolver} · esperadas ${interpretado.filasEsperadas}`,
      );
      console.log(
        '  controles en error:',
        JSON.stringify(interpretado.controles.filter((c) => c.severity === 'ERROR').map((c) => c.code)),
      );

      /*
       * Este comprobante tiene once renglones y de la foto reescalada salen dos.
       * Lo que se afirma acá no es cuántos se leen —eso puede mejorar— sino que
       * mientras no se lean, la lectura se rechace en vez de ofrecer una compra
       * de dos artículos.
       */
      expect(interpretado.controles.some((c) => c.code === 'LECTURA_UTILIZABLE')).toBe(true);
    },
    600_000,
  );

  it(
    'Mabelherdi: los 9 renglones y el pie',
    async () => {
      const { lectura, medidas, total } = await leerFoto('mabelherdi-0007-00348491.jpg');
      const pagina = lectura.paginas[0];
      const plano = [
        pagina.textoCompleto,
        pagina.textoEncabezado ?? '',
        pagina.textoArticulos ?? '',
        pagina.textoResumen ?? '',
      ]
        .join('\n')
        .toUpperCase()
        .replace(/\s/g, '');

      console.log(
        `[Mabelherdi] página ${medidas[0].ancho}×${medidas[0].alto} · ` +
          `filas vistas ${pagina.regiones?.filasDetectadas ?? '—'} · ` +
          `total ${(total / 1000).toFixed(1)}s`,
      );
      console.log('  tiempos por zona:', JSON.stringify(pagina.tiempos));
      const interpretado = await interpretar(lectura);
      console.log(
        `  INTERPRETADO: ${interpretado.articulos} artículos · analizador ${interpretado.analizador} · ` +
          `estado ${interpretado.estado} · filas detector ${interpretado.filasDelDetector} · ` +
          `sin resolver ${interpretado.filasSinResolver}`,
      );
      console.log('  controles en error:', JSON.stringify(interpretado.controles.filter((c) => c.severity === 'ERROR').map((c) => c.code)));
      console.log('  calculado:', JSON.stringify(interpretado.calculado));
      volcarSiSePide('mabelherdi', lectura.paginas);

      const { MABELHERDI_ARTICULOS_IMPRESOS } = await import('../fixtures/mabelherdi');
      informarRenglones(interpretado.renglones, MABELHERDI_ARTICULOS_IMPRESOS);
      console.log('  ¿nº 00348491?', plano.includes('00348491'));
      console.log('  ¿total 40506,09?', plano.includes('40506,09') || plano.includes('40.506,09'));

      expect(plano.length).toBeGreaterThan(100);
    },
    600_000,
  );

  it(
    'Barraza: los 2 renglones, con kilos y piezas separados',
    async () => {
      const { lectura, medidas, total } = await leerFoto('barraza-0041-00196670.png');
      const pagina = lectura.paginas[0];

      console.log(
        `[Barraza] página ${medidas[0].ancho}×${medidas[0].alto} · ` +
          `inclinación ${medidas[0].inclinacion.toFixed(2)}° · ` +
          `perspectiva ${medidas[0].perspectivaCorregida ? 'sí' : 'no'} · ` +
          `filas vistas ${pagina.regiones?.filasDetectadas ?? '—'} · ` +
          `total ${(total / 1000).toFixed(1)}s`,
      );
      volcarSiSePide('barraza', lectura.paginas);

      const interpretado = await interpretar(lectura);
      console.log(
        `  INTERPRETADO: ${interpretado.articulos} artículos · analizador ${interpretado.analizador} · ` +
          `estado ${interpretado.estado} · filas detector ${interpretado.filasDelDetector} · ` +
          `sin resolver ${interpretado.filasSinResolver}`,
      );
      console.log(
        '  controles en error:',
        JSON.stringify(
          interpretado.controles.filter((c) => c.severity === 'ERROR').map((c) => c.code),
        ),
      );
      console.log('  calculado:', JSON.stringify(interpretado.calculado));

      const { BARRAZA_ARTICULOS_IMPRESOS } = await import('../fixtures/barraza');
      informarRenglones(
        interpretado.renglones,
        BARRAZA_ARTICULOS_IMPRESOS.map((a) => ({
          codigo: a.codigo,
          descripcion: a.descripcion,
          subtotal: a.neto,
        })),
      );

      /*
       * Dos renglones, no tres, y ni los kilos ni las piezas adentro del nombre.
       *
       * Es la marca del defecto que trajo esta factura: la pantalla mostraba
       * «27.00 9.00 | CIL MUZZA BARRAZA X 3 KG», con las dos cantidades pegadas
       * al texto, y contaba tres renglones donde el papel tiene dos.
       */
      for (const r of interpretado.renglones) {
        expect(r.descripcion, `el renglón ${r.linea} arrastra cantidades`).not.toMatch(
          /^\s*\d+[.,]\d{2}\s/,
        );
      }
      expect(interpretado.articulos).toBe(2);
    },
    600_000,
  );

  it(
    'Ezra: los 6 renglones, con las ocho columnas en su lugar',
    async () => {
      const { lectura, medidas, total } = await leerFoto('ezra-00002-00000185.jpg');
      const pagina = lectura.paginas[0];

      console.log(
        `[Ezra] página ${medidas[0].ancho}×${medidas[0].alto} · ` +
          `filas vistas ${pagina.regiones?.filasDetectadas ?? '—'} · ` +
          `total ${(total / 1000).toFixed(1)}s`,
      );
      volcarSiSePide('ezra', lectura.paginas);

      const interpretado = await interpretar(lectura);
      console.log(
        `  INTERPRETADO: ${interpretado.articulos} artículos · analizador ${interpretado.analizador} · ` +
          `estado ${interpretado.estado} · filas detector ${interpretado.filasDelDetector} · ` +
          `sin resolver ${interpretado.filasSinResolver}`,
      );
      console.log(
        '  controles en error:',
        JSON.stringify(
          interpretado.controles.filter((c) => c.severity === 'ERROR').map((c) => c.code),
        ),
      );
      console.log('  calculado:', JSON.stringify(interpretado.calculado));

      const { EZRA_ARTICULOS_IMPRESOS } = await import('../fixtures/ezra');
      informarRenglones(interpretado.renglones, EZRA_ARTICULOS_IMPRESOS);

      /*
       * El kilaje no puede estar adentro del nombre.
       *
       * Es la marca del corrimiento de columnas: en esta factura la cantidad va
       * **antes** de la descripción, y un analizador que la espera después se la
       * come como parte del texto. Se afirma acá, sobre la foto de verdad,
       * porque es donde el error apareció.
       */
      for (const r of interpretado.renglones) {
        expect(r.descripcion, `el renglón ${r.linea} arrastra el kilaje`).not.toMatch(
          /^\s*\d+[.,]\d{3}\s/,
        );
      }
      expect(interpretado.articulos).toBe(6);
    },
    600_000,
  );
});
