/**
 * Lectura del comprobante en el navegador.
 *
 * Mantiene abierta una sesión con las páginas ya decodificadas y preparadas,
 * para que la segunda lectura no tenga que volver a hacer todo el trabajo de
 * imagen: sólo cambia qué se recorta y con cuánta agresividad se limpia.
 *
 * Lo que sale de acá es texto. Interpretarlo, calcular y controlar es tarea del
 * servidor, que es el único que decide si un comprobante cierra.
 */
import { recortar, type Mapa } from '@/lib/cliente/ocr/imagen';
import { mapaDesdeBlob } from '@/lib/cliente/ocr/lienzo';
import { limpiarFuerte, prepararPagina, prepararRecorte } from '@/lib/cliente/ocr/preproceso';
import { esPdf, paginasDePdf } from '@/lib/cliente/ocr/pdf';
import {
  bordeInferiorDeLaTabla,
  detectarRegiones,
  ensanchar,
  type Region,
  type RegionesDetectadas,
} from '@/lib/cliente/ocr/regiones';
import type { ZonaAReleer } from '@/lib/ocr/types';
import { PSM, leerMapa, lectorPreparado, type ProgresoLector } from '@/lib/cliente/ocr/tesseract';

export type EtapaLectura =
  | 'PREPARANDO_LECTOR'
  | 'PREPARANDO_IMAGENES'
  | 'LEYENDO_ENCABEZADO'
  | 'LEYENDO_ARTICULOS'
  | 'LEYENDO_RESUMEN'
  | 'RELEYENDO';

export interface AvanceLectura {
  etapa: EtapaLectura;
  /** 0 a 1 dentro de la etapa, o null cuando no se puede estimar. */
  avance: number | null;
  pagina?: number;
  totalPaginas?: number;
}

export interface FuentePagina {
  archivo: Blob;
  nombre: string;
}

export interface LecturaPagina {
  numero: number;
  textoCompleto: string;
  textoEncabezado: string | null;
  textoArticulos: string | null;
  textoResumen: string | null;
  confianza: number;
  inclinacion: number;
  perspectivaCorregida: boolean;
  regiones: RegionesDetectadas;
  /** Cuánto tardó cada zona, para poder ver dónde se va el tiempo. */
  tiempos: { zona: string; ms: number }[];
}

export interface LecturaComprobante {
  intento: number;
  estrategia: string;
  proveedor: string;
  modelo: string;
  paginas: LecturaPagina[];
  duracionMs: number;
  confianza: number;
  observaciones: string[];
}

const PROVEEDOR = 'tesseract-local';
const MODELO = 'tesseract 5 · spa';

/**
 * Sesión de lectura de un comprobante.
 *
 * `preparar()` decodifica y limpia las páginas una sola vez. `leer(intento)` se
 * puede llamar varias veces: en cada vuelta cambia la estrategia de recorte y
 * de limpieza, pero se reutiliza el trabajo de imagen ya hecho.
 */
export class SesionLectura {
  private paginas: Mapa[] = [];
  private metadatos: { inclinacion: number; perspectivaCorregida: boolean }[] = [];
  private regionesPorPagina: RegionesDetectadas[] = [];
  private observaciones: string[] = [];
  /**
   * Lo que devolvió la vuelta anterior.
   *
   * La relectura del borde de la tabla lee **una franja sola** y no la página,
   * así que por sí misma devolvería dos o tres renglones. Lo que se manda al
   * servidor es el texto anterior más el de la franja: el analizador ya sabe
   * unificar lecturas repetidas del mismo renglón, y así la vuelta focalizada
   * agrega la fila que faltaba sin perder las que ya estaban.
   */
  private ultimaLectura: LecturaPagina[] = [];
  /**
   * Cuántas veces se releyó el borde de abajo.
   *
   * Se hace una sola vez, con dos segmentaciones distintas sobre la misma
   * franja. Si con eso no aparece la fila, insistir no la va a hacer aparecer:
   * el comprobante queda en rojo para que lo mire una persona, que es lo
   * correcto. Nunca se completa el renglón faltante haciendo la resta contra el
   * neto: eso sería inventar un precio que nadie leyó.
   */
  private bordesReleidos = 0;

  constructor(private readonly alAvanzar?: (avance: AvanceLectura) => void) {}

  private avisar(avance: AvanceLectura) {
    this.alAvanzar?.(avance);
  }

  private progresoDelLector = (p: ProgresoLector, etapa: EtapaLectura) => {
    this.avisar({
      etapa: p.etapa === 'preparando' && !lectorPreparado() ? 'PREPARANDO_LECTOR' : etapa,
      avance: p.avance,
    });
  };

  /** Decodifica los archivos, rasteriza los PDF y prepara cada página. */
  async preparar(fuentes: FuentePagina[]): Promise<void> {
    this.avisar({ etapa: 'PREPARANDO_IMAGENES', avance: 0 });
    this.paginas = [];
    this.metadatos = [];
    this.observaciones = [];

    const crudas: Mapa[] = [];
    for (const fuente of fuentes) {
      if (esPdf(fuente.archivo, fuente.nombre)) {
        const paginas = await paginasDePdf(fuente.archivo);
        if (paginas.length === 0) {
          this.observaciones.push(`No se pudo abrir el PDF "${fuente.nombre}".`);
        }
        crudas.push(...paginas);
      } else {
        crudas.push(await mapaDesdeBlob(fuente.archivo));
      }
    }

    for (let i = 0; i < crudas.length; i++) {
      this.avisar({
        etapa: 'PREPARANDO_IMAGENES',
        avance: (i + 1) / crudas.length,
        pagina: i + 1,
        totalPaginas: crudas.length,
      });
      const { mapa, inclinacion, perspectivaCorregida } = prepararPagina(crudas[i]);
      this.paginas.push(mapa);
      this.metadatos.push({ inclinacion, perspectivaCorregida });
    }
  }

  get cantidadDePaginas(): number {
    return this.paginas.length;
  }

  /**
   * Medidas de cada página ya preparada, para la pantalla de diagnóstico.
   *
   * Es la resolución con la que Tesseract va a leer, que no es la de la foto:
   * en el medio se corrigió la perspectiva y se escaló. Cuando algo no se lee,
   * este número es lo primero que hay que mirar.
   */
  get medidasDePaginas(): { ancho: number; alto: number; inclinacion: number; perspectivaCorregida: boolean }[] {
    return this.paginas.map((mapa, i) => ({
      ancho: mapa.width,
      alto: mapa.height,
      inclinacion: this.metadatos[i]?.inclinacion ?? 0,
      perspectivaCorregida: this.metadatos[i]?.perspectivaCorregida ?? false,
    }));
  }

  /**
   * Una vuelta de lectura.
   *
   * Intento 1: se lee la página entera para ubicar las zonas, y después se
   * releen la tabla y el pie recortados y ampliados.
   *
   * Intento 2 en adelante: se ensanchan las zonas —lo que más se pierde es el
   * primer o el último renglón, justo en el borde del recorte—, se limpia más
   * fuerte y se cambia la segmentación, para que Tesseract agrupe distinto.
   */
  async leer(
    intento: number,
    motivo?: string,
    zona?: ZonaAReleer | null,
  ): Promise<LecturaComprobante> {
    if (this.paginas.length === 0) {
      throw new Error('Hay que preparar las páginas antes de leer.');
    }

    /*
     * El atajo: cuando lo único que falta es el final de la tabla, se relee esa
     * franja y nada más.
     *
     * Vale la pena el desvío porque una vuelta normal cuesta la página entera
     * más la tabla por franjas más el pie —ocho o diez pasadas de OCR, que en un
     * teléfono son varios segundos cada una— para ir a buscar un renglón que se
     * sabe dónde está.
     */
    if (zona === 'BORDE_INFERIOR_TABLA' && this.puedeReleerElBorde()) {
      return this.releerBordeDeLaTabla(intento, motivo);
    }

    const comienzo = Date.now();
    const focalizada = intento > 1;
    const resultados: LecturaPagina[] = [];

    if (focalizada) {
      this.avisar({ etapa: 'RELEYENDO', avance: null });
    }

    for (let i = 0; i < this.paginas.length; i++) {
      // En la relectura se limpia fuerte: filtro de mediana y realce. En la
      // primera vuelta no, porque sobre un comprobante nítido esa limpieza
      // deforma los dígitos en vez de rescatarlos.
      const mapa = focalizada ? limpiarFuerte(this.paginas[i]) : this.paginas[i];
      const numero = i + 1;
      const total = this.paginas.length;
      const comienzoPagina = performance.now();

      // --- Página completa: ubica las zonas y sirve de red de contención ---
      this.avisar({ etapa: 'LEYENDO_ENCABEZADO', avance: null, pagina: numero, totalPaginas: total });
      const completa = await leerMapa(
        mapa,
        { psm: focalizada ? PSM.SINGLE_COLUMN : PSM.AUTO },
        (p) => this.progresoDelLector(p, 'LEYENDO_ENCABEZADO'),
      );

      const regiones =
        this.regionesPorPagina[i] && focalizada
          ? this.regionesPorPagina[i]
          : detectarRegiones(completa.lineas, mapa.width, mapa.height);
      this.regionesPorPagina[i] = regiones;

      const tiempos: { zona: string; ms: number }[] = [
        { zona: 'Página completa', ms: Math.round(performance.now() - comienzoPagina) },
      ];
      const cronometrar = async <T>(zona: string, tarea: () => Promise<T>): Promise<T> => {
        const desde = performance.now();
        const resultado = await tarea();
        tiempos.push({ zona, ms: Math.round(performance.now() - desde) });
        return resultado;
      };

      // --- Tabla de artículos, recortada y ampliada ---
      let textoArticulos: string | null = null;
      let filasEnLaTabla = 0;
      if (regiones.articulos) {
        this.avisar({ etapa: 'LEYENDO_ARTICULOS', avance: null, pagina: numero, totalPaginas: total });
        const region = focalizada ? ensanchar(regiones.articulos, 0.08) : regiones.articulos;
        const tabla = await cronometrar('Tabla de artículos', () =>
          this.leerTabla(mapa, region, focalizada, regiones.filasDetectadas),
        );
        textoArticulos = tabla.texto;
        filasEnLaTabla = tabla.filasLeidas;
      }

      // --- Pie con los totales ---
      let textoResumen: string | null = null;
      if (regiones.resumen) {
        this.avisar({ etapa: 'LEYENDO_RESUMEN', avance: null, pagina: numero, totalPaginas: total });
        const region = focalizada ? ensanchar(regiones.resumen, 0.05) : regiones.resumen;
        // El pie es un recuadro de etiquetas a la izquierda e importes a la
        // derecha: también son renglones apilados, no un párrafo.
        textoResumen = await cronometrar('Pie con los totales', () =>
          this.leerRegion(mapa, region, focalizada, 'LEYENDO_RESUMEN', PSM.SINGLE_COLUMN),
        );
      }

      // --- Encabezado, sólo en la primera página ---
      let textoEncabezado: string | null = null;
      if (numero === 1 && regiones.encabezado) {
        textoEncabezado = await cronometrar('Encabezado', () =>
          this.leerRegion(mapa, regiones.encabezado!, false, 'LEYENDO_ENCABEZADO'),
        );
      }

      resultados.push({
        numero,
        textoCompleto: completa.texto,
        textoEncabezado,
        textoArticulos,
        textoResumen,
        confianza: completa.confianza,
        inclinacion: this.metadatos[i]?.inclinacion ?? 0,
        perspectivaCorregida: this.metadatos[i]?.perspectivaCorregida ?? false,
        /*
         * Cuántas filas se llegaron a ver, contando las dos fuentes.
         *
         * El detector de disposición cuenta las filas sobre la imagen de la
         * página entera, y sobre esta factura ve 17 de 23: las de abajo pierden
         * la descripción y dejan de parecer una fila. La lectura por franjas
         * recupera las 23, así que quedarse con el número del detector deja el
         * control diciendo "vi 17, interpreté 23", que además de contradictorio
         * es inútil.
         *
         * Se toma el mayor de los dos, y no el de las franjas: el del detector
         * es el que no depende de haber leído bien, y es el que delata una
         * lectura que devolvió un renglón donde hay veintitrés.
         */
        regiones: {
          ...regiones,
          filasDetectadas: Math.max(regiones.filasDetectadas, filasEnLaTabla),
        },
        tiempos,
      });
    }

    this.ultimaLectura = resultados;

    const confianza =
      resultados.reduce((suma, p) => suma + p.confianza, 0) / Math.max(1, resultados.length);

    return {
      intento,
      estrategia: focalizada
        ? `Relectura focalizada de la tabla y del pie, con recortes ensanchados y limpieza reforzada${motivo ? `. Motivo: ${motivo}` : ''}`
        : 'Lectura completa de la página, más recortes de la tabla y del pie',
      proveedor: PROVEEDOR,
      modelo: MODELO,
      paginas: resultados,
      duracionMs: Date.now() - comienzo,
      confianza,
      observaciones: this.observaciones,
    };
  }

  /** ¿Hay con qué hacer la relectura del borde, y no se hizo ya? */
  private puedeReleerElBorde(): boolean {
    if (this.bordesReleidos >= 1) return false;
    if (this.ultimaLectura.length === 0) return false;
    return this.regionesPorPagina.some((r) => r && bordeInferiorDeLaTabla(r) !== null);
  }

  /**
   * Relee sólo la franja de abajo de la tabla y la agrega a lo ya leído.
   *
   * Dos pasadas sobre la misma franja, y se cambian **las dos cosas** entre una
   * y otra: la segmentación y la limpieza.
   *
   * La primera va sobre la página tal como se preparó, tratando la franja como
   * una columna de renglones apilados. La segunda sobre la página limpiada
   * fuerte —filtro de mediana y realce— y tratándola como un bloque.
   *
   * Cambiar sólo la segmentación desperdiciaría la segunda pasada, porque la
   * limpieza fuerte es sospechosa justamente acá: sobre una fila que ya salía
   * débil, el filtro de mediana termina de borrarle los trazos finos en vez de
   * rescatarlos. Si la fila que falta es de las tenues, la pasada sin limpiar es
   * la que la trae; si es de las que se ven bien pero con ruido alrededor, la
   * limpiada. Dos pasadas y dos hipótesis distintas.
   *
   * Dos y no más. Si la fila no aparece con ninguna de las dos segmentaciones,
   * es que en esa parte de la foto no se lee, y repetir la misma pasada no la va
   * a hacer legible. Ahí el comprobante tiene que quedar en rojo: la alternativa
   * —completar el renglón que falta restando contra el neto impreso— daría un
   * importe que cierra y un precio que nadie leyó, y ese precio terminaría en el
   * costo del artículo y en el precio de venta.
   */
  private async releerBordeDeLaTabla(
    intento: number,
    motivo?: string,
  ): Promise<LecturaComprobante> {
    const comienzo = Date.now();
    this.bordesReleidos += 1;
    this.avisar({ etapa: 'RELEYENDO', avance: null });

    const resultados: LecturaPagina[] = [];

    for (let i = 0; i < this.paginas.length; i++) {
      const previa = this.ultimaLectura[i];
      const regiones = this.regionesPorPagina[i];
      const banda = regiones ? bordeInferiorDeLaTabla(regiones) : null;

      // Una página sin tabla detectada, o sin lectura previa, se deja como está:
      // no hay nada que releer ni con qué empalmarlo.
      if (!previa || !banda) {
        if (previa) resultados.push(previa);
        continue;
      }

      const desde = performance.now();
      const pasadas: { mapa: Mapa; agresivo: boolean; psm: PSM }[] = [
        { mapa: this.paginas[i], agresivo: false, psm: PSM.SINGLE_COLUMN },
        { mapa: limpiarFuerte(this.paginas[i]), agresivo: true, psm: PSM.SINGLE_BLOCK },
      ];

      const partes: string[] = [];
      for (const pasada of pasadas) {
        this.avisar({
          etapa: 'LEYENDO_ARTICULOS',
          avance: null,
          pagina: i + 1,
          totalPaginas: this.paginas.length,
        });
        partes.push(
          await this.leerRegion(pasada.mapa, banda, pasada.agresivo, 'LEYENDO_ARTICULOS', pasada.psm),
        );
      }

      const textoArticulos = [previa.textoArticulos, ...partes]
        .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
        .join('\n');

      resultados.push({
        ...previa,
        textoArticulos,
        tiempos: [
          ...(previa.tiempos ?? []),
          { zona: 'Borde inferior de la tabla', ms: Math.round(performance.now() - desde) },
        ],
      });
    }

    this.ultimaLectura = resultados;

    return {
      intento,
      estrategia:
        'Relectura del borde inferior de la tabla, con dos segmentaciones sobre la misma franja' +
        (motivo ? `. Motivo: ${motivo}` : ''),
      proveedor: PROVEEDOR,
      modelo: MODELO,
      paginas: resultados,
      duracionMs: Date.now() - comienzo,
      confianza:
        resultados.reduce((suma, p) => suma + p.confianza, 0) / Math.max(1, resultados.length),
      observaciones: this.observaciones,
    };
  }

  /**
   * Lee la tabla de artículos por franjas horizontales.
   *
   * Dos decisiones, las dos medidas sobre una factura real de veintitrés
   * renglones fotografiada con un iPhone:
   *
   *  - **SINGLE_COLUMN y no SINGLE_BLOCK.** La tabla trae una línea horizontal
   *    entre fila y fila; tratada como un bloque único, Tesseract la segmenta
   *    mal y devuelve *un solo renglón*. Declarándola una columna de renglones
   *    apilados salen todos.
   *
   *  - **Por franjas y no de una.** Con la tabla entera en una sola pasada se
   *    leían 17 de 23, y las seis que faltaban perdían la descripción aunque en
   *    la imagen se leen perfectas: el análisis de disposición se le complica en
   *    una imagen muy alta con muchas filas regladas. Partida en tres franjas se
   *    recuperan los veintitrés códigos y sus descripciones. No es cuestión de
   *    resolución —probado hasta 4284 px de ancho, no cambia— sino de cuántas
   *    filas ve de una vez.
   *
   * Las franjas se solapan un poco para no cortar un renglón justo en el borde.
   * El renglón que cae en las dos sale repetido, y de eso se ocupa el analizador,
   * que descarta el duplicado: preferimos leerlo dos veces que perderlo.
   */
  private async leerTabla(
    mapa: Mapa,
    region: Region,
    agresivo: boolean,
    filasEsperadas: number,
  ): Promise<{ texto: string; filasLeidas: number }> {
    const franjas = this.cuantasFranjas(region);
    if (franjas === 1) {
      const texto = await this.leerRegion(
        mapa,
        region,
        agresivo,
        'LEYENDO_ARTICULOS',
        PSM.SINGLE_COLUMN,
      );
      return { texto, filasLeidas: contarFilasLegibles(texto) };
    }

    /*
     * Se lee dos veces con divisiones distintas, y se manda todo junto.
     *
     * Dónde cae el corte cambia el resultado más de lo que uno esperaría: la
     * fila que con una división sale partida en dos líneas —descripción por un
     * lado, importes por otro— con la otra sale entera. Como no hay forma de
     * saber de antemano cuál corte le va a caer bien a cada fila, se hacen las
     * dos y se concatenan.
     *
     * El texto sale con casi todos los renglones repetidos, y está bien: el
     * analizador los unifica por código de artículo y se queda con la lectura
     * que cierra contra su subtotal impreso. Repetir sale barato; perder un
     * renglón, no.
     *
     * Pero sólo cuando hace falta. La segunda división cuesta otras tres o
     * cuatro pasadas de OCR, que en un iPhone son minutos, y no aporta nada si
     * la primera ya recuperó todas las filas que el detector vio en la imagen.
     * Así que se corta ahí: no es aflojar un control —los controles corren
     * después, en el servidor, sobre el texto que salga— sino dejar de pagar
     * por una lectura que no va a agregar un renglón.
     */
    const partes: string[] = [];
    let filasLeidas = 0;

    for (const division of [franjas, franjas + 1]) {
      if (division > franjas && alcanzaConUnaDivision(filasLeidas, filasEsperadas)) break;
      for (const franja of this.franjasDe(region, division)) {
        partes.push(
          await this.leerRegion(mapa, franja, agresivo, 'LEYENDO_ARTICULOS', PSM.SINGLE_COLUMN),
        );
      }
      filasLeidas = contarFilasLegibles(partes.join('\n'));
    }

    return { texto: partes.join('\n'), filasLeidas };
  }

  /** Reparte la región en franjas que se solapan un poco. */
  private franjasDe(region: Region, cuantas: number): Region[] {
    const alto = region.height / cuantas;
    const solape = Math.min(alto * 0.08, 0.015);
    const franjas: Region[] = [];

    for (let i = 0; i < cuantas; i++) {
      const arriba = Math.max(0, region.top + alto * i - (i === 0 ? 0 : solape));
      franjas.push({
        left: region.left,
        top: arriba,
        width: region.width,
        height: Math.min(1 - arriba, alto + solape * 2),
      });
    }
    return franjas;
  }

  /**
   * En cuántas franjas conviene partir la tabla.
   *
   * Se apunta a unas ocho filas por franja. Con menos filas que eso no hay nada
   * que ganar partiendo, y cada franja cuesta una pasada de OCR.
   */
  private cuantasFranjas(region: Region): number {
    if (region.height < 0.2) return 1;
    return Math.min(4, Math.max(2, Math.round(region.height / 0.18)));
  }

  private async leerRegion(
    mapa: Mapa,
    region: Region,
    agresivo: boolean,
    etapa: EtapaLectura,
    psm: PSM = PSM.SINGLE_BLOCK,
  ): Promise<string> {
    const recorte = prepararRecorte(recortar(mapa, region), agresivo);
    const lectura = await leerMapa(recorte, { psm }, (p) => this.progresoDelLector(p, etapa));
    return lectura.texto;
  }
}

/**
 * ¿Vale la pena la segunda división de franjas, o alcanza con la primera?
 *
 * La segunda cuesta otras tres o cuatro pasadas de OCR, que en un iPhone son
 * minutos. Se saltea sólo cuando la primera ya recuperó **más** filas de las que
 * el detector de disposición vio en la página entera.
 *
 * "Más" y no "las mismas", y la diferencia importa. Si la lectura por franjas
 * devuelve exactamente tantas filas como vio el detector, puede ser que estén
 * todas... o que las franjas se estén perdiendo las mismas de abajo que se
 * perdió la página completa, que es el caso conocido de esta factura: el
 * detector ve 17 de 23 justamente porque a las últimas se les corta la
 * descripción. Empatar no prueba nada; superarlo sí prueba que las franjas están
 * recuperando lo que la página entera no vio.
 *
 * Ante la duda se paga la segunda división: perder un renglón cuesta mucho más
 * que un minuto de lectura.
 */
export function alcanzaConUnaDivision(filasLeidas: number, filasEsperadas: number): boolean {
  if (filasEsperadas <= 0) return false;
  return filasLeidas > filasEsperadas;
}

/**
 * Cuántas filas distintas de tabla se reconocen en un texto ya leído.
 *
 * Es a propósito tosca: una fila es una línea con al menos tres grupos de
 * dígitos —cantidad, precio e importe— y algo de texto delante. No intenta
 * interpretar nada, y no podría: quién es cada columna lo decide el analizador
 * del proveedor, en el servidor, y duplicar ese criterio acá sería tener la
 * misma regla escrita en dos lados.
 *
 * Sirve para dos cosas que no necesitan precisión. Una es decidir si vale la
 * pena pagar otra tanda de OCR: si ya se recuperaron todas las filas que el
 * detector vio en la imagen, no hay nada que ganar. La otra es informar cuántas
 * filas se llegaron a ver, que en el servidor se contrasta contra cuántas se
 * pudieron interpretar. Si se queda corta, se lee de más; nunca se guarda algo
 * de menos por su culpa.
 *
 * Las líneas repetidas entre franjas se cuentan una sola vez, comparándolas por
 * su parte alfabética, que es la que se mantiene estable entre pasadas.
 */
export function contarFilasLegibles(texto: string): number {
  const vistas = new Set<string>();
  for (const cruda of texto.split('\n')) {
    const linea = cruda.trim();
    if (linea.length < 12) continue;
    const numeros = linea.match(/\d[\d.,]*/g) ?? [];
    if (numeros.length < 3) continue;
    const letras = linea.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g, '').toUpperCase();
    if (letras.length < 6) continue;
    vistas.add(letras.slice(0, 14));
  }
  return vistas.size;
}

export const ETAPA_TEXTO: Record<EtapaLectura, string> = {
  PREPARANDO_LECTOR: 'Preparando el lector',
  PREPARANDO_IMAGENES: 'Preparando las imágenes',
  LEYENDO_ENCABEZADO: 'Leyendo el encabezado',
  LEYENDO_ARTICULOS: 'Leyendo los artículos',
  LEYENDO_RESUMEN: 'Verificando los totales',
  RELEYENDO: 'La lectura no cerró: releyendo el comprobante',
};
