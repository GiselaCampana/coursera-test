import { Decimal } from '@/lib/money';
import { numerosDelTexto } from '@/lib/ocr/numeros';
import { emisorNormalizado } from '@/lib/ocr/zona-emisor';
import type { TextosComprobante } from '@/lib/ocr/parsers/tipos';
import {
  aConvencionAr,
  candidatasDeRenglon,
  decidir,
  netoDelRenglon,
  puntuarTabla,
  type CandidataDeTabla,
  type ConvencionDecimal,
  type PieLeido,
  type RenglonCandidato,
  type Veredicto,
} from '@/lib/ocr/motor/candidatas';
import {
  encontrarFilaDeTitulos,
  filasDeDatos,
  huellaDeEstructura,
  type FilaDeTitulos,
} from '@/lib/ocr/motor/tabla';
import type { ColumnaReconocida } from '@/lib/ocr/motor/columnas';

export type { PieLeido, CandidataDeTabla, RenglonCandidato } from '@/lib/ocr/motor/candidatas';

/**
 * El motor general de interpretación.
 *
 * Ata las piezas: encuentra la tabla, reconoce sus columnas por lo que dicen,
 * reconstruye los renglones por posición, genera las lecturas posibles y deja
 * que la aritmética elija. **No sabe de proveedores.** No hay una sola
 * referencia a un nombre, un CUIT o un formato conocido en todo este archivo.
 *
 * Lo que devuelve no es «la interpretación» sino un informe: qué entendió, con
 * cuánta confianza, cuál fue la segunda lectura, por qué se penalizó cada cosa
 * y qué corresponde hacer. La decisión de usarlo sin preguntar, mandarlo a
 * configuración o rechazarlo es parte del resultado, no del que lo llama.
 */

export interface EmisorLeido {
  cuit: string | null;
  razonSocial: string | null;
}

export interface InformeDelMotor {
  emisor: EmisorLeido;
  /** La huella de la estructura, sin nada del contenido. */
  huella: string | null;
  titulos: FilaDeTitulos | null;
  /** Los encabezados tal como se detectaron. */
  encabezados: string[];
  /** Qué campo es cada columna, con null en las ambiguas. */
  columnas: (ColumnaReconocida | null)[];
  /** Los encabezados que no se pudieron asignar. */
  ambiguas: string[];
  /** Cuántas filas se vieron y cuántas se interpretaron. */
  filasVistas: number;
  pie: PieLeido;
  candidatas: CandidataDeTabla[];
  veredicto: Veredicto;
}

// ---------------------------------------------------------------------------
// El emisor
// ---------------------------------------------------------------------------

/**
 * Quién emitió el comprobante, buscado sólo en su zona.
 *
 * El CUIT del receptor —el de la propia empresa— está impreso en todas las
 * facturas de todos los proveedores. Se lo excluye explícitamente pasándolo
 * como parámetro: el motor no puede saberlo solo, y adivinar «el primero que
 * aparece» atribuiría medio archivo al mismo emisor.
 */
export function leerEmisor(textos: TextosComprobante, cuitDelReceptor?: string): EmisorLeido {
  const zona = emisorNormalizado(textos);
  const propio = (cuitDelReceptor ?? '').replace(/\D/g, '');

  const cuits = [...zona.matchAll(/\b(\d{2})\s*-?\s*(\d{8})\s*-?\s*(\d)\b/g)]
    .map((m) => `${m[1]}${m[2]}${m[3]}`)
    .filter((c) => c !== propio);

  const cuit = cuits[0]
    ? `${cuits[0].slice(0, 2)}-${cuits[0].slice(2, 10)}-${cuits[0].slice(10)}`
    : null;

  /*
   * La razón social es la primera línea con forma de nombre de empresa.
   *
   * Se pide una forma societaria —S.A., S.R.L., cooperativa— o al menos dos
   * palabras largas en mayúsculas. Sin eso, la primera línea de cualquier
   * comprobante sería la razón social, incluida «FACTURA».
   */
  const razonSocial =
    zona
      .split('\n')
      .map((l) => l.trim())
      .find(
        (l) =>
          l.length > 6 &&
          !/^(factura|remito|nota|comprobante|original|duplicado)\b/i.test(l) &&
          /\b(S\.?A\.?|S\.?R\.?L\.?|S\.?A\.?S\.?|COOPERATIVA|LTDA)\b/i.test(l),
      ) ?? null;

  return { cuit, razonSocial };
}

// ---------------------------------------------------------------------------
// El pie
// ---------------------------------------------------------------------------

/**
 * Lo que un comprobante imprime al pie y **no** es del pie fiscal.
 *
 * Son números grandes, creíbles y con etiqueta propia, y por eso son los más
 * peligrosos: un saldo de cuenta corriente puede ser mayor que el neto de la
 * factura, y un CAE tiene catorce dígitos. Se reconocen para dejarlos afuera,
 * no para ignorarlos: que quede constancia de qué se descartó es lo que permite
 * revisar la decisión.
 */
const AJENOS_AL_PIE: { etiqueta: string; patron: RegExp }[] = [
  { etiqueta: 'saldo acumulado', patron: /saldo\s+(ac\w*|ant\w*|anterior)/i },
  { etiqueta: 'CAE', patron: /\bc\.?a\.?e\.?\b/i },
  { etiqueta: 'CUIT', patron: /\bc\.?u\.?i\.?t\.?\b/i },
  { etiqueta: 'ingresos brutos', patron: /ingresos?\s+brutos|ing\.?\s*brutos|\bcm\s*\d/i },
  { etiqueta: 'código de barras', patron: /^\s*\d{20,}\s*$/ },
  { etiqueta: 'vencimiento', patron: /vencimiento|vto\.?\s*cae/i },
  { etiqueta: 'total de kilos', patron: /total\s+kgs?\b/i },
];

const ETIQUETAS_DEL_PIE: { campo: keyof Omit<PieLeido, 'ignorados'>; patron: RegExp }[] = [
  { campo: 'netTotal', patron: /(sub\s?-?\s?total|neto\s+gravado|importe\s+neto|\bneto\b)\s*[:.|]?/i },
  { campo: 'ivaTotal', patron: /i\.?\s?v\.?\s?a\.?\s*(21|10[.,]5)?\s*[.,]?\s*\d{0,2}\s*%?\s*[:.|]?/i },
  { campo: 'percepciones', patron: /(percep\w*|perc\b)[^\d]*[:.|]?/i },
  { campo: 'total', patron: /(?<![a-z-])total\s*[:.|]?/i },
];

/**
 * Lee el pie separándolo de lo que no es el pie.
 *
 * Cada línea se clasifica primero como ajena o no. Una línea ajena no aporta
 * ningún número, aunque tenga una etiqueta que se parezca: «Saldo Ac. $
 * 532.848,64 — Subtotal 473.232,44» tiene las dos cosas, y lo que decide es que
 * el valor del subtotal sea el que está junto a **su** etiqueta.
 */
export function leerPie(texto: string, convencion: ConvencionDecimal = 'ar'): PieLeido {
  const numeros = (tramo: string) => numerosDelTexto(aConvencionAr(tramo, convencion));

  const pie: PieLeido = {
    netTotal: null,
    ivaTotal: null,
    percepciones: null,
    total: null,
    ignorados: [],
  };

  const candidatos: Record<string, Decimal[]> = {
    netTotal: [],
    ivaTotal: [],
    percepciones: [],
    total: [],
  };

  for (const cruda of texto.split('\n')) {
    const linea = cruda.trim();
    if (linea === '') continue;

    for (const ajeno of AJENOS_AL_PIE) {
      const m = ajeno.patron.exec(linea);
      if (!m) continue;
      // Se anota el primer número que sigue a la etiqueta ajena, para dejar
      // constancia de qué se descartó.
      const despues = numeros(linea.slice(m.index + m[0].length));
      if (despues.length > 0) {
        const anotado = { etiqueta: ajeno.etiqueta, valor: despues[0].toString() };
        // El pie se lee sobre el resumen y sobre la página entera a la vez, así
        // que cada línea llega dos veces.
        if (!pie.ignorados.some((x) => x.etiqueta === anotado.etiqueta && x.valor === anotado.valor)) {
          pie.ignorados.push(anotado);
        }
      }
    }

    for (const { campo, patron } of ETIQUETAS_DEL_PIE) {
      const m = patron.exec(linea);
      if (!m) continue;
      const despues = linea.slice(m.index + m[0].length);
      /*
       * Se corta en la etiqueta siguiente.
       *
       * Un pie de una sola línea —«Saldo Ac. $532848.64 — Subtotal 473,232.44»—
       * tiene dos etiquetas y dos números, y sin cortar, la primera se llevaría
       * los dos.
       */
      const hastaLaProxima = despues.split(/(?=\b(?:sub\s?-?total|neto|i\.?v\.?a|perc|total)\b)/i)[0];
      for (const valor of numeros(hastaLaProxima)) {
        if (!candidatos[campo].some((x) => x.eq(valor))) candidatos[campo].push(valor);
      }
    }
  }

  /*
   * Se elige la combinación que cierra contra sí misma.
   *
   * neto + IVA + percepciones = total son cuatro lecturas independientes del
   * papel. Que las cuatro cuadren entre sí es lo que permite creerles, y es lo
   * que descarta que un saldo acumulado se haya colado en alguna.
   */
  for (const neto of candidatos.netTotal) {
    for (const iva of candidatos.ivaTotal.length ? candidatos.ivaTotal : [new Decimal(0)]) {
      for (const perc of candidatos.percepciones.length ? candidatos.percepciones : [new Decimal(0)]) {
        for (const total of candidatos.total) {
          if (neto.plus(iva).plus(perc).minus(total).abs().gt(1)) continue;
          if (pie.total) continue;
          pie.netTotal = neto;
          pie.ivaTotal = iva.gt(0) ? iva : null;
          pie.percepciones = perc.gt(0) ? perc : null;
          pie.total = total;
        }
      }
    }
  }

  // Si no cerró, se conserva al menos el neto más grande leído: sirve para
  // puntuar, con la penalización que corresponda.
  if (!pie.netTotal && candidatos.netTotal.length > 0) {
    pie.netTotal = candidatos.netTotal.reduce((a, b) => (a.gt(b) ? a : b));
  }

  return pie;
}

// ---------------------------------------------------------------------------
// El motor
// ---------------------------------------------------------------------------

export interface OpcionesDelMotor {
  /** El CUIT propio, para no confundirlo con el del emisor. */
  cuitDelReceptor?: string;
  /** Cuántas filas vio el detector sobre la imagen. */
  filasVistas?: number | null;
}

/**
 * Interpreta un comprobante sin saber de quién es.
 *
 * Prueba las dos convenciones decimales —la argentina y la norteamericana— como
 * candidatas del documento, no como configuración: cuál usa el proveedor lo
 * decide la aritmética, igual que todo lo demás.
 */
export function interpretar(
  textos: TextosComprobante,
  opciones: OpcionesDelMotor = {},
): InformeDelMotor {
  const emisor = leerEmisor(textos, opciones.cuitDelReceptor);
  const textoDelPie = `${textos.resumen ?? ''}\n${textos.completo}`;
  const pie = leerPie(textoDelPie);

  const cuerpo = textos.articulos && textos.articulos.trim() !== '' ? textos.articulos : textos.completo;
  const titulos = encontrarFilaDeTitulos(cuerpo) ?? encontrarFilaDeTitulos(textos.completo);

  if (!titulos) {
    return {
      emisor,
      huella: null,
      titulos: null,
      encabezados: [],
      columnas: [],
      ambiguas: [],
      filasVistas: opciones.filasVistas ?? 0,
      pie,
      candidatas: [],
      veredicto: {
        decision: 'rechazo',
        ganadora: null,
        segunda: null,
        margen: 0,
        motivo: 'No se encontró la fila de títulos de la tabla.',
      },
    };
  }

  const textoDeLaTabla = cuerpo.includes(titulos.celdas[0]?.texto ?? '') ? cuerpo : textos.completo;
  const filas = filasDeDatos(textoDeLaTabla, titulos);

  const ambiguas = titulos.celdas
    .filter((_, i) => titulos.columnas[i] === null)
    .map((c) => c.texto);

  /*
   * La convención decimal es del documento entero, pie incluido.
   *
   * Leer el pie de una manera y la tabla de otra dejaría a la mitad de las
   * lecturas comparándose contra un neto que nadie escribió así: sobre la
   * factura de Lácteos Barraza, «473,232.44» leído a la argentina es 473,23244 y
   * ninguna suma de renglones se le va a parecer. Cada candidata trae su propio
   * pie y se juzga contra él.
   */
  const candidatas: CandidataDeTabla[] = [];
  for (const convencion of ['ar', 'us'] as ConvencionDecimal[]) {
    const suPie = convencion === 'ar' ? pie : leerPie(textoDelPie, convencion);
    const renglones = elegirPorRenglon(filas, titulos.columnas, convencion, suPie.netTotal);
    const { puntaje, penalizaciones, sumaDeRenglones, cierre } = puntuarTabla(renglones, {
      netTotal: suPie.netTotal,
      filasVistas: opciones.filasVistas ?? null,
    });
    candidatas.push({
      convencion,
      pie: suPie,
      renglones,
      puntaje,
      penalizaciones,
      sumaDeRenglones,
      cierre,
      reparaciones: renglones.reduce((total, r) => total + r.reparaciones, 0),
    });
  }

  const veredicto = decidir(candidatas, ambiguas);

  return {
    emisor,
    huella: huellaDeEstructura(titulos),
    titulos,
    encabezados: titulos.celdas.map((c) => c.texto),
    columnas: titulos.columnas,
    ambiguas,
    filasVistas: opciones.filasVistas ?? filas.length,
    // El pie que se informa es el de la lectura que ganó: es el único que es
    // coherente con los renglones que se muestran al lado.
    pie: veredicto.ganadora?.pie ?? pie,
    candidatas,
    veredicto,
  };
}

/**
 * De todas las lecturas de cada fila, cuál se queda.
 *
 * Se elige por fila y no por documento porque el producto de todas las
 * combinaciones explota: diez filas con tres lecturas cada una son cincuenta y
 * nueve mil documentos. Lo que se hace es elegir la mejor de cada fila con sus
 * propios controles, y dejar que el puntaje del documento —la suma contra el
 * neto— juzgue el conjunto.
 */
function elegirPorRenglon(
  filas: ReturnType<typeof filasDeDatos>,
  columnas: (ColumnaReconocida | null)[],
  convencion: ConvencionDecimal,
  netoImpreso: Decimal | null,
): RenglonCandidato[] {
  const salida: RenglonCandidato[] = [];

  for (const fila of filas) {
    const candidatas = candidatasDeRenglon(fila, columnas, convencion);
    if (candidatas.length === 0) continue;

    let mejor = candidatas[0];
    let mejorPuntaje = -Infinity;
    for (const candidata of candidatas) {
      let puntos = 0;
      for (const control of candidata.controles) puntos += control.paso ? 10 : -10;
      // Un renglón que no cabe en la factura entera está mal leído, por más
      // que su propia aritmética cierre.
      const neto = netoDelRenglon(candidata);
      if (netoImpreso && netoImpreso.gt(0) && neto && neto.gt(netoImpreso.times(1.02))) {
        puntos -= 100;
      }
      // A igualdad, la lectura más completa.
      puntos += [
        candidata.codigo,
        candidata.marca,
        candidata.precioUnitario,
        candidata.precioConDescuento,
        candidata.piezas,
      ].filter(Boolean).length;

      if (puntos > mejorPuntaje) {
        mejorPuntaje = puntos;
        mejor = candidata;
      }
    }
    salida.push(mejor);
  }

  return salida;
}
