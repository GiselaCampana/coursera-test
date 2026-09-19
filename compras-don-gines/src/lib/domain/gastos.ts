import { normalizarCodigo } from './matching';

/**
 * **Lo que la factura cobra y no es mercadería.**
 *
 * Ezra cobra tres bolsas grandes para transportar la compra. Eso se paga con
 * el resto de la factura —es plata que se le debe— pero no entra al stock: no
 * hay tres bolsas más en la heladera, no hay un artículo que vender, y cargarlo
 * como mercadería ensucia las existencias de algo que no existe.
 *
 * Hasta acá el modelo sólo sabía de mercadería, así que un renglón así
 * terminaba de una de dos formas, las dos malas: sin artículo, frenando una
 * compra que en realidad estaba completa; o con un artículo inventado, moviendo
 * existencias de «bolsa grande».
 *
 * **De dónde puede salir la clasificación, y de dónde no.**
 *
 * Sale del **código del proveedor**, configurado una vez, o de que **una
 * persona lo elija** en el renglón. Nada más.
 *
 * No sale de la descripción, y esa prohibición es la razón de ser de este
 * archivo. «BOLSA GRANDE» es texto que escribió un OCR: mañana puede decir
 * «BOLSA GRANOE», y pasado otro proveedor puede vender bolsas de verdad, para
 * revender, que sí son mercadería. Un texto que decide si algo entra al stock
 * convierte cada error de lectura en un error de inventario. El código es una
 * identificación y no cambia; la descripción es una grafía y cambia siempre.
 */

export type ClaseDeGasto = 'EMBALAJE' | 'FLETE' | 'OTRO';

/** Un código de este proveedor que está configurado como gasto. */
export interface CodigoDeGasto {
  supplierCode: string;
  kind: ClaseDeGasto;
  /** Cómo lo cobra el proveedor. El papel no lo dice. */
  unit: 'KG' | 'UNIT';
  label: string;
}

export interface RenglonAClasificar {
  /** Lo que ya quedó decidido en el renglón, si alguien lo decidió. */
  expenseKind?: ClaseDeGasto | null;
  supplierCode?: string | null;
  /** Se recibe para dejar dicho que NO se mira. Ver la nota de abajo. */
  description?: string;
}

export interface Clasificacion {
  /** null quiere decir mercadería. */
  kind: ClaseDeGasto | null;
  /** La unidad que corresponde, cuando la configuración la fija. */
  unit: 'KG' | 'UNIT' | null;
  /** Cómo llamarlo en pantalla, cuando la configuración lo nombra. */
  label: string | null;
  /** De dónde salió, para poder auditarlo. */
  origen: 'MERCADERIA' | 'ELEGIDO_A_MANO' | 'CODIGO_CONFIGURADO';
}

/** Los códigos configurados, listos para buscar por código normalizado. */
export function indicePorCodigo(codigos: CodigoDeGasto[]): Map<string, CodigoDeGasto> {
  const indice = new Map<string, CodigoDeGasto>();
  for (const codigo of codigos) {
    const normalizado = normalizarCodigo(codigo.supplierCode);
    if (normalizado !== '') indice.set(normalizado, codigo);
  }
  return indice;
}

/**
 * ¿Este renglón es mercadería o es un gasto?
 *
 * El orden importa: lo que una persona decidió gana sobre la configuración,
 * porque una factura puede traer una excepción y quien la mira la ve.
 *
 * `description` entra en la firma y no se usa **a propósito**. Es la cosa que
 * parece obvia y está prohibida: quien venga a «mejorar» esto agregando un
 * `incluye('BOLSA')` va a encontrar acá dicho por qué no, y la prueba negativa
 * que lo fija.
 */
export function clasificarRenglon(
  renglon: RenglonAClasificar,
  configurados: Map<string, CodigoDeGasto>,
): Clasificacion {
  if (renglon.expenseKind) {
    return {
      kind: renglon.expenseKind,
      unit: null,
      label: null,
      origen: 'ELEGIDO_A_MANO',
    };
  }

  const codigo = renglon.supplierCode ? normalizarCodigo(renglon.supplierCode) : '';
  const configurado = codigo === '' ? undefined : configurados.get(codigo);
  if (configurado) {
    return {
      kind: configurado.kind,
      unit: configurado.unit,
      label: configurado.label,
      origen: 'CODIGO_CONFIGURADO',
    };
  }

  return { kind: null, unit: null, label: null, origen: 'MERCADERIA' };
}

/** Cómo se lee cada clase en pantalla. */
export const CLASE_DE_GASTO_LABEL: Record<ClaseDeGasto, string> = {
  EMBALAJE: 'embalaje',
  FLETE: 'flete',
  OTRO: 'otro gasto',
};
