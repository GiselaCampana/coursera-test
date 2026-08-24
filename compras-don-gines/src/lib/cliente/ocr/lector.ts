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
import { detectarRegiones, ensanchar, type Region, type RegionesDetectadas } from '@/lib/cliente/ocr/regiones';
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
  async leer(intento: number, motivo?: string): Promise<LecturaComprobante> {
    if (this.paginas.length === 0) {
      throw new Error('Hay que preparar las páginas antes de leer.');
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

      // --- Tabla de artículos, recortada y ampliada ---
      let textoArticulos: string | null = null;
      if (regiones.articulos) {
        this.avisar({ etapa: 'LEYENDO_ARTICULOS', avance: null, pagina: numero, totalPaginas: total });
        const region = focalizada ? ensanchar(regiones.articulos, 0.08) : regiones.articulos;
        textoArticulos = await this.leerTabla(mapa, region, focalizada);
      }

      // --- Pie con los totales ---
      let textoResumen: string | null = null;
      if (regiones.resumen) {
        this.avisar({ etapa: 'LEYENDO_RESUMEN', avance: null, pagina: numero, totalPaginas: total });
        const region = focalizada ? ensanchar(regiones.resumen, 0.05) : regiones.resumen;
        // El pie es un recuadro de etiquetas a la izquierda e importes a la
        // derecha: también son renglones apilados, no un párrafo.
        textoResumen = await this.leerRegion(
          mapa,
          region,
          focalizada,
          'LEYENDO_RESUMEN',
          PSM.SINGLE_COLUMN,
        );
      }

      // --- Encabezado, sólo en la primera página ---
      let textoEncabezado: string | null = null;
      if (numero === 1 && regiones.encabezado) {
        textoEncabezado = await this.leerRegion(
          mapa,
          regiones.encabezado,
          false,
          'LEYENDO_ENCABEZADO',
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
        regiones,
      });
    }

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
  private async leerTabla(mapa: Mapa, region: Region, agresivo: boolean): Promise<string> {
    const franjas = this.cuantasFranjas(region);
    if (franjas === 1) {
      return this.leerRegion(mapa, region, agresivo, 'LEYENDO_ARTICULOS', PSM.SINGLE_COLUMN);
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
     */
    const partes: string[] = [];
    for (const division of [franjas, franjas + 1]) {
      for (const franja of this.franjasDe(region, division)) {
        partes.push(
          await this.leerRegion(mapa, franja, agresivo, 'LEYENDO_ARTICULOS', PSM.SINGLE_COLUMN),
        );
      }
    }

    return partes.join('\n');
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

export const ETAPA_TEXTO: Record<EtapaLectura, string> = {
  PREPARANDO_LECTOR: 'Preparando el lector',
  PREPARANDO_IMAGENES: 'Preparando las imágenes',
  LEYENDO_ENCABEZADO: 'Leyendo el encabezado',
  LEYENDO_ARTICULOS: 'Leyendo los artículos',
  LEYENDO_RESUMEN: 'Verificando los totales',
  RELEYENDO: 'La lectura no cerró: releyendo el comprobante',
};
