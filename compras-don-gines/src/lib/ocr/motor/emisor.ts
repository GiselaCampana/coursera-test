import { esFilaDeEncabezados } from '@/lib/ocr/motor/columnas';
import {
  apoyo,
  cajaRobusta,
  textoPreferido,
  type LecturaDeCelda,
  type Observacion,
  type RenglonVisual,
} from '@/lib/ocr/reconstruccion/agrupar';
import {
  centroY,
  type Caja,
  type EvidenciaDeLectura,
} from '@/lib/ocr/reconstruccion/evidencia';
import {
  estructuraDeLaEvidencia,
  type EstructuraDeTexto,
} from '@/lib/ocr/reconstruccion/texto';

/** Qué pudo probar el motor sobre el CUIT del emisor. */
export type EstadoDelCuit =
  | 'EXACT_VALID_TAX_ID'
  | 'RECONSTRUCTED_VALID_TAX_ID'
  | 'OCR_ALTERNATIVE_VALID_TAX_ID'
  | 'AMBIGUOUS_TAX_ID'
  | 'MISSING_TAX_ID';

/** Una lectura que sostiene un CUIT, conservada para poder auditarla. */
export interface ProcedenciaDelCuit {
  texto: string;
  pasada: string;
  confianza: number;
  caja: Caja;
  cajaEnLaFoto: Caja;
  alternativaDelOcr: boolean;
  /** Todas las alternativas que Tesseract ofreció para esa misma caja. */
  alternativas: string[];
}

/** Una identidad fiscal que llegó a competir. */
export interface CandidatoDeCuit {
  cuit: string;
  estado: Exclude<EstadoDelCuit, 'AMBIGUOUS_TAX_ID' | 'MISSING_TAX_ID'>;
  apoyo: number;
  procedencias: ProcedenciaDelCuit[];
}

export interface EmisorLeido {
  cuit: string | null;
  razonSocial: string | null;
  estadoCuit?: EstadoDelCuit;
  candidatosCuit?: CandidatoDeCuit[];
}

const PESOS_CUIT = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

/** Valida los once dígitos, incluido el dígito verificador argentino. */
export function cuitValido(texto: string): boolean {
  const digitos = texto.replace(/\D/g, '');
  if (!/^\d{11}$/.test(digitos)) return false;
  const suma = PESOS_CUIT.reduce((total, peso, i) => total + Number(digitos[i]) * peso, 0);
  const resto = 11 - (suma % 11);
  const verificador = resto === 11 ? 0 : resto === 10 ? 9 : resto;
  return Number(digitos[10]) === verificador;
}

function presentarCuit(digitos: string): string {
  return `${digitos.slice(0, 2)}-${digitos.slice(2, 10)}-${digitos.slice(10)}`;
}

function cuitsEn(texto: string): string[] {
  const encontrados = new Set<string>();
  for (const coincidencia of texto.matchAll(/(?<!\d)(\d{2})[\s.\-]*(\d{8})[\s.\-]*(\d)(?!\d)/g)) {
    const digitos = `${coincidencia[1]}${coincidencia[2]}${coincidencia[3]}`;
    if (cuitValido(digitos)) encontrados.add(digitos);
  }
  return [...encontrados];
}

function esContextoAjeno(texto: string): boolean {
  if (/\bc\.?\s*u\.?\s*i\.?\s*t\.?\b/i.test(texto)) return false;
  return /\b(c\.?a\.?e\.?|ingresos?\s+brutos|iibb|tel[eé]fono|factura|comprobante|punto\s+de\s+venta|nro\.?|n[uú]mero)\b/i.test(
    texto,
  );
}

function textoDelRenglon(renglon: RenglonVisual): string {
  return renglon.observaciones.map(textoPreferido).join(' ');
}

function observacionesDelEncabezado(
  evidencia: EvidenciaDeLectura,
  estructura?: EstructuraDeTexto,
  inicioDelDetalle?: number,
): {
  renglones: RenglonVisual[];
  alturaTipica: number;
} {
  const armada = estructura ?? estructuraDeLaEvidencia(evidencia);
  const { renglones, alturaTipica } = armada;
  const filaDeTitulos = renglones.find(
    (r) => r.y < 0.38 && esFilaDeEncabezados(r.observaciones.map(textoPreferido)),
  );
  // Si no aparece una tabla, la zona sigue siendo una banda superior
  // conservadora. Nunca se amplía a la página entera.
  const limite = Math.min(filaDeTitulos?.y ?? 0.38, inicioDelDetalle ?? 0.38, 0.38);
  return {
    renglones: renglones.filter((r) => centroY(r.caja) < limite),
    alturaTipica,
  };
}

interface Hallazgo {
  cuit: string;
  estado: CandidatoDeCuit['estado'];
  apoyo: number;
  procedencias: ProcedenciaDelCuit[];
}

function procedencia(
  lectura: LecturaDeCelda,
  observacion: Observacion,
): ProcedenciaDelCuit {
  const original = observacion.lecturas.find((l) => l.pasada === lectura.pasada);
  return {
    texto: lectura.texto,
    pasada: lectura.pasada,
    confianza: lectura.confianza,
    caja: lectura.caja,
    cajaEnLaFoto: lectura.cajaEnLaFoto,
    alternativaDelOcr: lectura.delPropioOcr === true,
    alternativas: [...(original?.alternativas ?? [])],
  };
}

function huellaNumerica(texto: string): string {
  return texto
    .toUpperCase()
    .replace(/[OQ]/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/S/g, '5')
    .replace(/B/g, '8')
    .replace(/\D/g, '');
}

function distanciaDeEdicion(a: string, b: string): number {
  const anterior = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = anterior[0];
    anterior[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const arriba = anterior[j];
      anterior[j] = Math.min(
        anterior[j] + 1,
        anterior[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = arriba;
    }
  }
  return anterior[b.length];
}

function esCorreccionOcrMinima(original: string, alternativa: string): boolean {
  const a = huellaNumerica(original);
  const b = huellaNumerica(alternativa);
  return b.length === 11 && Math.abs(a.length - b.length) <= 1 && distanciaDeEdicion(a, b) <= 1;
}

/**
 * Acá hacen falta todas las pasadas, aunque digan lo mismo. La ayuda general
 * de celdas colapsa textos repetidos porque para interpretar un número alcanza;
 * para identificar a una persona fiscal, en cambio, dos pasadas coincidentes
 * son dos apoyos que deben quedar en el acta.
 */
function lecturasParaEmisor(observacion: Observacion): LecturaDeCelda[] {
  const directas: LecturaDeCelda[] = observacion.lecturas.map((lectura) => ({
    texto: lectura.texto,
    caja: lectura.caja,
    cajaEnLaFoto: lectura.cajaEnLaFoto,
    pasada: lectura.pasada,
    confianza: lectura.confianza,
  }));
  const alternativas = observacion.lecturas.flatMap((lectura) =>
    lectura.alternativas
      .filter((texto) => esCorreccionOcrMinima(lectura.texto, texto))
      .map((texto) => ({
        texto,
        caja: lectura.caja,
        cajaEnLaFoto: lectura.cajaEnLaFoto,
        pasada: lectura.pasada,
        confianza: lectura.confianza,
        delPropioOcr: true as const,
      })),
  );
  return [...directas, ...alternativas].sort(
    (a, b) =>
      a.pasada.localeCompare(b.pasada) ||
      Number(a.delPropioOcr === true) - Number(b.delPropioOcr === true) ||
      b.confianza - a.confianza ||
      a.texto.localeCompare(b.texto),
  );
}

function lecturasPorPasada(observacion: Observacion): Map<string, LecturaDeCelda[]> {
  const salida = new Map<string, LecturaDeCelda[]>();
  for (const lectura of lecturasParaEmisor(observacion)) {
    const actuales = salida.get(lectura.pasada) ?? [];
    if (!actuales.some((x) => x.texto === lectura.texto)) actuales.push(lectura);
    salida.set(lectura.pasada, actuales);
  }
  return salida;
}

function combinaciones<T>(listas: T[][], limite = 128): T[][] {
  let salida: T[][] = [[]];
  for (const lista of listas) {
    const siguiente: T[][] = [];
    for (const prefijo of salida) {
      for (const valor of lista.slice(0, 4)) {
        siguiente.push([...prefijo, valor]);
        if (siguiente.length >= limite) return siguiente;
      }
    }
    salida = siguiente;
  }
  return salida;
}

function hallazgosDelRenglon(renglon: RenglonVisual, alturaTipica: number): Hallazgo[] {
  const hallazgos: Hallazgo[] = [];
  const contexto = textoDelRenglon(renglon);
  if (esContextoAjeno(contexto)) return hallazgos;

  for (const observacion of renglon.observaciones) {
    for (const lectura of lecturasParaEmisor(observacion)) {
      for (const cuit of cuitsEn(lectura.texto)) {
        hallazgos.push({
          cuit,
          estado: lectura.delPropioOcr ? 'OCR_ALTERNATIVE_VALID_TAX_ID' : 'EXACT_VALID_TAX_ID',
          apoyo: apoyo(observacion),
          procedencias: [procedencia(lectura, observacion)],
        });
      }
    }
  }

  // Un CUIT puede venir partido en varias cajas. Sólo se recombinan lecturas
  // de una misma pasada, contiguas y en una línea que se presenta como CUIT.
  if (!/\bc\.?\s*u\.?\s*i\.?\s*t\.?\b/i.test(contexto)) return hallazgos;
  const observaciones = renglon.observaciones;
  for (let desde = 0; desde < observaciones.length; desde++) {
    for (let hasta = desde + 2; hasta <= Math.min(observaciones.length, desde + 4); hasta++) {
      const tramo = observaciones.slice(desde, hasta);
      let contiguas = true;
      for (let i = 1; i < tramo.length; i++) {
        const hueco = cajaRobusta(tramo[i]).x0 - cajaRobusta(tramo[i - 1]).x1;
        if (hueco < -alturaTipica || hueco > Math.max(0.025, alturaTipica * 4)) contiguas = false;
      }
      if (!contiguas) continue;

      const porPasada = tramo.map(lecturasPorPasada);
      const pasadas = [...porPasada[0].keys()].filter((p) => porPasada.every((m) => m.has(p)));
      for (const pasada of pasadas) {
        const opciones = porPasada.map((m) => m.get(pasada)!);
        for (const partes of combinaciones(opciones)) {
          const junto = partes.map((p) => p.texto).join('');
          for (const cuit of cuitsEn(junto)) {
            const usaAlternativa = partes.some((p) => p.delPropioOcr);
            hallazgos.push({
              cuit,
              estado: usaAlternativa
                ? 'OCR_ALTERNATIVE_VALID_TAX_ID'
                : 'RECONSTRUCTED_VALID_TAX_ID',
              apoyo: tramo.reduce((total, o) => total + apoyo(o), 0),
              procedencias: partes.map((parte, i) => procedencia(parte, tramo[i])),
            });
          }
        }
      }
    }
  }
  return hallazgos;
}

const JERARQUIA: Record<CandidatoDeCuit['estado'], number> = {
  EXACT_VALID_TAX_ID: 3,
  RECONSTRUCTED_VALID_TAX_ID: 2,
  OCR_ALTERNATIVE_VALID_TAX_ID: 1,
};

function consolidar(hallazgos: Hallazgo[]): CandidatoDeCuit[] {
  const porCuit = new Map<string, Hallazgo[]>();
  for (const hallazgo of hallazgos) {
    const suyos = porCuit.get(hallazgo.cuit) ?? [];
    suyos.push(hallazgo);
    porCuit.set(hallazgo.cuit, suyos);
  }
  return [...porCuit].map(([cuit, suyos]) => {
    const mejorNivel = Math.max(...suyos.map((h) => JERARQUIA[h.estado]));
    const mejores = suyos.filter((h) => JERARQUIA[h.estado] === mejorNivel);
    const procedencias = mejores
      .flatMap((h) => h.procedencias)
      .filter(
        (p, i, todas) =>
          todas.findIndex(
            (otra) =>
              otra.texto === p.texto &&
              otra.pasada === p.pasada &&
              otra.caja.x0 === p.caja.x0 &&
              otra.caja.y0 === p.caja.y0,
          ) === i,
      )
      .sort(
        (a, b) =>
          a.pasada.localeCompare(b.pasada) ||
          a.texto.localeCompare(b.texto) ||
          a.caja.x0 - b.caja.x0 ||
          a.caja.y0 - b.caja.y0,
      );
    return {
      cuit: presentarCuit(cuit),
      estado: mejores[0].estado,
      apoyo: mejores.reduce((total, h) => total + h.apoyo, 0),
      procedencias,
    };
  });
}

function razonSocialEn(renglones: RenglonVisual[], yDelCuit: number | null): string | null {
  const posibles = renglones
    .map((r) => ({ texto: limpiarRazonSocial(textoDelRenglon(r)), y: r.y }))
    .filter(
      ({ texto }) =>
        texto.length > 6 &&
        !/^(factura|remito|nota|comprobante|original|duplicado)\b/i.test(texto) &&
        /\b(S\.?\s*A\.?|S\.?\s*R\.?\s*L\.?|S\.?\s*A\.?\s*S\.?|COOPERATIVA|LTDA)\b/i.test(texto),
    );
  if (posibles.length === 0) return null;
  posibles.sort((a, b) => {
    if (yDelCuit !== null) {
      const distanciaA = Math.abs(a.y - yDelCuit);
      const distanciaB = Math.abs(b.y - yDelCuit);
      if (distanciaA !== distanciaB) return distanciaA - distanciaB;
    }
    return a.y - b.y || a.texto.localeCompare(b.texto);
  });
  return posibles[0].texto;
}

function limpiarRazonSocial(texto: string): string {
  let limpio = texto
    .replace(/\b([\p{L}]{2,})(?:\s+\1)\b/giu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const forma = /\b(S\.?\s*A\.?|S\.?\s*R\.?\s*L\.?|S\.?\s*A\.?\s*S\.?|LTDA)\b/i.exec(limpio);
  if (forma) {
    let fin = forma.index + forma[0].length;
    while (limpio[fin] === '.') fin++;
    limpio = limpio.slice(0, fin).trim();
  } else {
    limpio = limpio.split(/\b(?:CUIT|FACTURA|CLIENTE|FECHA|INICIO\s+ACTIVIDADES)\b/i)[0].trim();
  }
  return limpio;
}

/**
 * Identifica al emisor sólo con evidencia de la zona superior del documento.
 * No conoce proveedores, marcas ni datos cargados: si el papel no alcanza,
 * devuelve una pregunta en vez de completar por parecido.
 */
export function leerEmisorDeEvidencia(
  evidencia: EvidenciaDeLectura,
  cuitDelReceptor?: string,
  estructura?: EstructuraDeTexto,
  inicioDelDetalle?: number,
): EmisorLeido {
  const { renglones, alturaTipica } = observacionesDelEncabezado(
    evidencia,
    estructura,
    inicioDelDetalle,
  );
  const receptor = (cuitDelReceptor ?? '').replace(/\D/g, '');
  const hallazgos = renglones
    .flatMap((r) => hallazgosDelRenglon(r, alturaTipica))
    .filter((h) => h.cuit !== receptor);
  const candidatos = consolidar(hallazgos).sort(
    (a, b) =>
      JERARQUIA[b.estado] - JERARQUIA[a.estado] ||
      b.apoyo - a.apoyo ||
      a.cuit.localeCompare(b.cuit),
  );
  const nivelGanador = candidatos[0] ? JERARQUIA[candidatos[0].estado] : 0;
  const empatados = candidatos.filter((c) => JERARQUIA[c.estado] === nivelGanador);
  const resuelto = empatados.length === 1 ? candidatos[0] : null;
  const yDelCuit = resuelto?.procedencias[0]
    ? centroY(resuelto.procedencias[0].caja)
    : null;

  return {
    cuit: resuelto?.cuit ?? null,
    razonSocial: razonSocialEn(renglones, yDelCuit),
    estadoCuit:
      candidatos.length === 0
        ? 'MISSING_TAX_ID'
        : resuelto
          ? resuelto.estado
          : 'AMBIGUOUS_TAX_ID',
    candidatosCuit: candidatos,
  };
}
