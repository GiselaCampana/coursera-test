import type { Caja, EvidenciaDeLectura, Fragmento } from '@/lib/ocr/reconstruccion/evidencia';
import type { TablaReconstruida } from '@/lib/ocr/reconstruccion/reconstruccion';
import { CAMPOS_NUMERICOS, type CampoDeColumna } from '@/lib/ocr/motor/columnas';
import type { Pendiente } from '@/lib/ocr/motor/pendientes';

/**
 * Volver a leer sólo lo que quedó ilegible, desde los píxeles originales.
 *
 * Cuando la primera reconstrucción termina incompleta, el motor sabe muchísimo
 * más que al empezar: sabe **qué renglón** falla, **qué columna** le falta,
 * **dónde debería estar** esa celda, **qué tipo de dato** espera y **qué
 * igualdad** tiene que cumplir. Nada de eso se usaba: la celda quedaba como
 * bloqueo y la persona la tipeaba.
 *
 * Es un desperdicio doble. Primero porque el dato suele estar en la foto —lo que
 * falló fue la lectura de la página entera, no la tinta— y una relectura
 * ampliada de un rectángulo de dos centímetros lo recupera. Y segundo porque la
 * alternativa es pedirle a alguien que lea con los ojos exactamente el mismo
 * pedazo de papel que la máquina puede volver a mirar.
 *
 * ## Lo que esta capa hace y lo que no
 *
 * Acá se decide **qué releer y con qué variantes**: es lógica pura, sin tocar
 * imágenes ni OCR, para poder probarla. Quien ejecuta la relectura es el mismo
 * lector que ya corre en el navegador, y lo que devuelve entra al motor como
 * **evidencia nueva con procedencia propia**: no reemplaza nada, compite.
 *
 * Las reglas que no se negocian:
 *
 *  - se activa **después** de que la primera reconstrucción quedó incompleta,
 *    nunca antes;
 *  - produce candidatas, nunca una sustitución directa;
 *  - no sobreescribe la lectura original, que sigue compitiendo;
 *  - tiene un **presupuesto explícito**, para que no se vuelva un ciclo;
 *  - no sabe de proveedores ni del valor que se espera encontrar.
 */

/** Qué tipo de dato espera una celda, para restringir el reconocimiento. */
export type TipoEsperado = 'numero' | 'texto';

export interface CeldaParaReleer {
  /** El renglón de la tabla, empezando en 1 como en el informe. */
  renglon: number;
  campo: CampoDeColumna | null;
  /** Cómo se llama la columna en el informe. */
  columna: string;
  /** Dónde debería estar la celda, en fracción de la página. */
  caja: Caja;
  tipo: TipoEsperado;
  /** Por qué se pide releerla. */
  motivo: string;
}

/**
 * Un rectángulo de la página que se va a releer, con las celdas que contiene.
 *
 * Las celdas problemáticas se agrupan **por columna** en una sola banda
 * vertical en vez de pedir un recorte por celda. Sobre una factura de
 * veintitrés renglones la diferencia es de una relectura a diez, y el lector
 * tarda lo mismo en leer una banda angosta que una celda: lo que cuesta es
 * arrancar la pasada, no los píxeles.
 */
export interface ZonaDeRelectura {
  /** Un identificador estable, para que la evidencia diga de dónde salió. */
  id: string;
  caja: Caja;
  tipo: TipoEsperado;
  /** Cuántas celdas problemáticas cubre. */
  celdas: number;
  /** Qué columna es, para el informe. */
  columna: string;
  /**
   * ¿Es una columna que la igualdad del renglón necesita?
   *
   * Cantidad, precio e importe son los tres que hacen la cuenta; el descuento y
   * la alícuota de IVA la modulan. Con cuatro relecturas de presupuesto y seis
   * columnas pidiendo, releer primero las que modulan deja sin mirar las que
   * deciden: medido, la banda de precios se quedaba afuera y tres artículos
   * seguían con un valor de otra escala.
   */
  esencial: boolean;
}

/** Los campos que la igualdad de un renglón necesita para poder comprobarse. */
const CAMPOS_DE_LA_CUENTA = new Set<CampoDeColumna>([
  'cantidad',
  'kilos',
  'piezas',
  'precioUnitario',
  'precioConDescuento',
  'importe',
]);

/**
 * Cuántas relecturas se permiten por comprobante.
 *
 * Cuatro. Cada una es una pasada de OCR sobre un recorte ampliado, del orden de
 * medio segundo sobre un teléfono, y el presupuesto existe para que esto no se
 * convierta en un ciclo: si con cuatro bandas no se recuperó la celda, la celda
 * no está en la foto y lo que corresponde es decirlo, no seguir intentando.
 *
 * Se gastan en las columnas con más celdas problemáticas, que es donde una sola
 * relectura recupera más.
 */
export const PRESUPUESTO_DE_RELECTURA = 4;

/** Un margen alrededor de la caja esperada, en fracción de la página. */
const MARGEN = 0.004;

/**
 * Qué celdas conviene volver a leer.
 *
 * Dos motivos, y hacen falta los dos.
 *
 * El primero es la celda que **falta o es ambigua**: el motor sabe qué columna
 * es, dónde debería estar y qué tipo de dato espera, y sin eso no hay relectura
 * focalizada posible. Sólo las bloqueantes: una advertencia no justifica gastar
 * una pasada de OCR.
 *
 * El segundo es el renglón que **no cierra**, y es el que faltaba. Un precio
 * leído «52293041» no es una celda faltante: está ahí, tiene un valor, y lo que
 * falla es la igualdad del renglón. Pidiendo sólo las faltantes, la banda de
 * precios de una factura entera quedaba sin releer mientras tres artículos
 * arrastraban un valor de otra escala —medido: la suma quedaba a un veinticuatro
 * por ciento del neto impreso en vez de a un uno y medio—. Cuando un renglón no
 * cumple su propia aritmética, cualquiera de sus celdas numéricas puede ser la
 * culpable y todas se vuelven a mirar.
 */
export function celdasParaReleer(
  tabla: TablaReconstruida,
  pendientes: Pendiente[],
  /** Qué renglones no cumplen su propia aritmética, empezando en 1. */
  renglonesQueNoCierran: number[] = [],
): CeldaParaReleer[] {
  const salida: CeldaParaReleer[] = [];

  for (const pendiente of pendientes) {
    if (pendiente.categoria !== 'BLOCKING_MISSING_CELL' && pendiente.categoria !== 'BLOCKING_AMBIGUOUS_CELL') {
      continue;
    }
    if (pendiente.renglon === null) continue;

    const renglon = tabla.renglones[pendiente.renglon - 1];
    if (!renglon) continue;

    const indice = tabla.columnas.findIndex((c) => (c.titulo ?? '') === pendiente.columna);
    const columna = indice >= 0 ? tabla.columnas[indice] : buscarPorCampo(tabla, pendiente.campo);
    if (!columna) continue;

    salida.push({
      renglon: pendiente.renglon,
      campo: pendiente.campo as CampoDeColumna | null,
      columna: pendiente.columna ?? `columna ${indice + 1}`,
      caja: cajaDeCelda(tabla, renglon, columna),
      tipo:
        pendiente.campo && CAMPOS_NUMERICOS.has(pendiente.campo as CampoDeColumna)
          ? 'numero'
          : 'texto',
      motivo: pendiente.motivo,
    });
  }

  for (const numero of renglonesQueNoCierran) {
    const renglon = tabla.renglones[numero - 1];
    if (!renglon) continue;

    tabla.columnas.forEach((columna, indice) => {
      const campo = columna.campo?.campo ?? null;
      if (!campo || !CAMPOS_NUMERICOS.has(campo)) return;
      const nombre = columna.titulo ?? `columna ${indice + 1}`;
      // Si ya se pidió esa misma celda por faltante, no se pide dos veces.
      if (salida.some((c) => c.renglon === numero && c.columna === nombre)) return;
      salida.push({
        renglon: numero,
        campo,
        columna: nombre,
        caja: cajaDeCelda(tabla, renglon, columna),
        tipo: 'numero',
        motivo: 'El renglón no cumple su propia aritmética: alguna de sus celdas se leyó mal.',
      });
    });
  }

  return salida;
}

/**
 * Dónde debería estar una celda: el cruce de su columna con la altura de su
 * renglón.
 *
 * Es lo que permite releer una celda que **no se leyó nunca**: no hay caja que
 * copiar, hay que construirla.
 */
function cajaDeCelda(
  tabla: TablaReconstruida,
  renglon: TablaReconstruida['renglones'][number],
  columna: TablaReconstruida['columnas'][number],
): Caja {
  const mitad = tabla.alturaTipica * 0.6;
  return {
    x0: Math.max(0, columna.desde - MARGEN),
    y0: Math.max(0, renglon.y - mitad - MARGEN),
    x1: Math.min(1, columna.hasta + MARGEN),
    y1: Math.min(1, renglon.y + mitad + MARGEN),
  };
}

function buscarPorCampo(tabla: TablaReconstruida, campo: string | null) {
  if (!campo) return null;
  return tabla.columnas.find((c) => c.campo?.campo === campo) ?? null;
}

/**
 * Las bandas que hay que releer, dentro del presupuesto.
 *
 * Se agrupa por columna y se ordena por dos cosas, en este orden: primero las
 * columnas que la igualdad del renglón necesita —cantidad, precio, importe— y
 * después por cuántas celdas problemáticas cubre cada banda, que es donde una
 * sola relectura recupera más. Una banda abarca desde el renglón más alto con
 * problemas hasta el más bajo, así que una sola relectura puede recuperar diez
 * celdas de la misma columna.
 */
export function zonasDeRelectura(
  celdas: CeldaParaReleer[],
  presupuesto = PRESUPUESTO_DE_RELECTURA,
): ZonaDeRelectura[] {
  const porColumna = new Map<string, CeldaParaReleer[]>();
  for (const celda of celdas) {
    const clave = `${celda.columna}|${celda.tipo}`;
    if (!porColumna.has(clave)) porColumna.set(clave, []);
    porColumna.get(clave)!.push(celda);
  }

  const zonas: ZonaDeRelectura[] = [];
  for (const [clave, suyas] of porColumna) {
    const caja = suyas
      .map((c) => c.caja)
      .reduce((a, b) => ({
        x0: Math.min(a.x0, b.x0),
        y0: Math.min(a.y0, b.y0),
        x1: Math.max(a.x1, b.x1),
        y1: Math.max(a.y1, b.y1),
      }));
    zonas.push({
      id: `relectura:${clave.replace(/[^a-zA-Z0-9]/g, '-')}`,
      caja,
      tipo: suyas[0].tipo,
      celdas: suyas.length,
      columna: suyas[0].columna,
      esencial: suyas.some((c) => c.campo !== null && CAMPOS_DE_LA_CUENTA.has(c.campo)),
    });
  }

  /*
   * El presupuesto se gasta donde más se recupera, y **se gasta entero o
   * menos, nunca más**. Es lo que impide que esto se vuelva un ciclo: la
   * relectura no se llama otra vez con lo que quedó pendiente después de ella.
   */
  return zonas
    .sort((a, b) => Number(b.esencial) - Number(a.esencial) || b.celdas - a.celdas)
    .slice(0, presupuesto);
}

/**
 * Con qué variantes se lee cada banda.
 *
 * Las dos que sirven, y por razones distintas. La ampliación sin deformar
 * recupera el trazo fino que la página entera pierde al reducirse; el umbral
 * alternativo recupera lo que quedó tapado por una sombra o un doblez. Son las
 * mismas dos que ya usa la lectura de zonas, con una diferencia que importa
 * mucho: para una celda numérica se **restringe el alfabeto a dígitos y
 * separadores**.
 *
 * Esa restricción es la que convierte «52293041» en un número legible: sin ella
 * el reconocedor puede devolver una S por un 5 o una O por un 0, y con ella no
 * tiene esa opción. No se usa para el texto, donde las letras son el dato.
 */
export interface VarianteDeRelectura {
  /** Sufijo del identificador de la pasada. */
  nombre: string;
  /** Preparación de la imagen. */
  preparacion: 'directo' | 'limpieza-fuerte';
  /** Alfabeto al que se restringe el reconocimiento, o null para no restringir. */
  alfabeto: string | null;
  /** Cómo segmenta el reconocedor: una línea o un bloque. */
  segmentacion: 'linea' | 'bloque';
}

export const DIGITOS_Y_SEPARADORES = '0123456789.,$%- ';

export function variantesDeRelectura(tipo: TipoEsperado): VarianteDeRelectura[] {
  if (tipo === 'numero') {
    return [
      { nombre: 'numeros', preparacion: 'directo', alfabeto: DIGITOS_Y_SEPARADORES, segmentacion: 'bloque' },
      {
        nombre: 'numeros-limpio',
        preparacion: 'limpieza-fuerte',
        alfabeto: DIGITOS_Y_SEPARADORES,
        segmentacion: 'bloque',
      },
    ];
  }
  return [
    { nombre: 'texto', preparacion: 'directo', alfabeto: null, segmentacion: 'bloque' },
    { nombre: 'texto-limpio', preparacion: 'limpieza-fuerte', alfabeto: null, segmentacion: 'bloque' },
  ];
}

/**
 * ¿Vale la pena releer este comprobante?
 *
 * Sólo cuando la primera reconstrucción quedó incompleta **y** hay algo con una
 * posición conocida para volver a mirar. Un comprobante que se leyó entero no
 * se relee, y uno que no tiene ni tabla tampoco: ahí el problema no es una celda
 * sino la foto.
 */
export function convieneReleer(celdas: CeldaParaReleer[]): boolean {
  return celdas.length > 0;
}

// ---------------------------------------------------------------------------
// La evidencia que vuelve, y cómo entra
// ---------------------------------------------------------------------------

/**
 * Una banda con las variantes con que hay que leerla: el plan completo.
 *
 * Es lo que se le entrega a quien ejecuta la relectura —el lector del navegador
 * o el script que arma los fixtures—, para que no tenga que decidir nada.
 */
export interface BandaPlanificada extends ZonaDeRelectura {
  variantes: VarianteDeRelectura[];
}

export function planDeRelectura(
  tabla: TablaReconstruida,
  pendientes: Pendiente[],
  renglonesQueNoCierran: number[] = [],
  presupuesto = PRESUPUESTO_DE_RELECTURA,
): BandaPlanificada[] {
  const celdas = celdasParaReleer(tabla, pendientes, renglonesQueNoCierran);
  if (!convieneReleer(celdas)) return [];
  return zonasDeRelectura(celdas, presupuesto).map((zona) => ({
    ...zona,
    variantes: variantesDeRelectura(zona.tipo),
  }));
}

/** Una pasada de relectura: una pasada de OCR más de dónde salió. */
export interface PasadaDeRelectura {
  id: string;
  /** El identificador de la banda. */
  zona: string;
  variante: string;
  psm: string;
  /** El alfabeto al que se restringió, si se restringió. */
  alfabeto: string | null;
  region: Caja;
  /** Cuántas celdas problemáticas cubría la banda. */
  celdasQueCubre: number;
  columna: string;
  fragmentos: number;
  ms: number;
}

export interface EvidenciaDeRelectura {
  anchoPx: number;
  altoPx: number;
  pasadas: PasadaDeRelectura[];
  fragmentos: Fragmento[];
  msTotal: number;
}

/**
 * Suma la relectura a la evidencia original.
 *
 * **Suma**, con todo el peso de la palabra: la evidencia original entra entera
 * y sin tocar, y los fragmentos nuevos van al final. Es la regla que hace que
 * esto sea seguro: una relectura peor no puede empeorar el comprobante, porque
 * lo que leyó antes sigue estando y sigue compitiendo dentro del mismo motor de
 * candidatas.
 *
 * Cada fragmento nuevo conserva su `pasada` —«relectura:PRECIO-numero:numeros»—
 * así que en el informe se puede decir exactamente de dónde salió cada número,
 * y distinguir «esto lo leyó la primera pasada» de «esto lo recuperó la
 * relectura de la banda de precios con el alfabeto restringido».
 */
export function sumarRelectura(
  original: EvidenciaDeLectura,
  relectura: EvidenciaDeRelectura,
): EvidenciaDeLectura {
  return {
    anchoPx: original.anchoPx,
    altoPx: original.altoPx,
    pasadas: [
      ...original.pasadas,
      ...relectura.pasadas.map((p) => ({
        id: p.id,
        zona: 'franja' as const,
        variante: 'ampliado' as const,
        psm: p.psm,
        region: p.region,
        confianza: 0,
        ms: p.ms,
      })),
    ],
    fragmentos: [...original.fragmentos, ...relectura.fragmentos],
  };
}
