import { Decimal, type MoneyInput } from '@/lib/money';

/**
 * **Qué cambió una persona respecto de lo que había leído el OCR.**
 *
 * La calcula **el servidor**, comparando lo que está persistido contra lo que
 * llega al confirmar. No se le pregunta al navegador cuál era el valor
 * original: el navegador es exactamente quien acaba de cambiarlo, y una
 * auditoría que le cree al que hizo el cambio no audita nada. Si alguien
 * modifica la pantalla para mandar «el original era lo mismo que el final», la
 * auditoría sigue viendo la diferencia contra la base.
 *
 * **Qué se audita y qué no.** Un cambio ordinario —corregir un centavo, elegir
 * el artículo, escribir el número de comprobante— se registra y no pide motivo:
 * obligar a justificar cada campo haría impracticable cargar una factura de
 * veintitrés renglones, que es el caso que esta pantalla existe para resolver.
 * El motivo sigue siendo obligatorio donde ya lo era: forzar una validación,
 * aceptar una diferencia, tomar una decisión excepcional.
 */

/** Un renglón tal como está guardado o tal como llega. */
export interface RenglonComparable {
  lineNumber: number;
  supplierCode?: string | null;
  description?: string | null;
  quantity?: MoneyInput | null;
  unit?: string | null;
  unitNetPrice?: MoneyInput | null;
  discountPct?: MoneyInput | null;
  ivaRate?: MoneyInput | null;
  productId?: string | null;
  expenseKind?: string | null;
}

/** El encabezado y el pie, que también se corrigen. */
export interface EncabezadoComparable {
  supplierId?: string | null;
  docType?: string | null;
  letter?: string | null;
  pointOfSale?: string | null;
  number?: string | null;
  issueDate?: string | null;
  netTotal?: MoneyInput | null;
  ivaTotal?: MoneyInput | null;
  perceptionsTotal?: MoneyInput | null;
  total?: MoneyInput | null;
}

export interface CorreccionDeCampo {
  /** `encabezado` o el número de renglón. */
  donde: string;
  campo: string;
  /** Lo que había, o null cuando el campo no existía. */
  antes: string | null;
  despues: string | null;
}

export interface CorreccionesManuales {
  campos: CorreccionDeCampo[];
  /** Renglones que no estaban y los agregó una persona. */
  renglonesAgregados: number[];
  /** Renglones que estaban y se quitaron. */
  renglonesQuitados: number[];
  /** Renglones cuya asociación de producto cambió. */
  asociacionesCambiadas: { renglon: number; antes: string | null; despues: string | null }[];
  /** Renglones cuya clasificación cambió. */
  clasificacionesCambiadas: { renglon: number; antes: string | null; despues: string | null }[];
  /** ¿Hubo alguna corrección? */
  huboCorrecciones: boolean;
}

/** Texto comparable de un importe: sin esto «4.24» y «4.240» serían distintos. */
function comoNumero(v: MoneyInput | null | undefined): string | null {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  try {
    return new Decimal(String(v)).toString();
  } catch {
    return String(v);
  }
}

function comoTexto(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

function distinto(antes: string | null, despues: string | null): boolean {
  return antes !== despues;
}

/**
 * Compara lo guardado contra lo que llega, y devuelve sólo lo que cambió.
 *
 * Los importes se comparan como números y no como cadenas: «4.24» y «4.2400»
 * son el mismo precio escrito distinto, y auditarlos como una corrección
 * llenaría el registro de ruido que esconde las correcciones de verdad.
 */
export function correccionesManuales(entrada: {
  encabezadoGuardado: EncabezadoComparable;
  encabezadoEnviado: EncabezadoComparable;
  renglonesGuardados: RenglonComparable[];
  renglonesEnviados: RenglonComparable[];
}): CorreccionesManuales {
  const campos: CorreccionDeCampo[] = [];

  /* --- El encabezado y el pie --------------------------------------------- */
  const textos: (keyof EncabezadoComparable)[] = [
    'supplierId',
    'docType',
    'letter',
    'pointOfSale',
    'number',
    'issueDate',
  ];
  for (const campo of textos) {
    const antes = comoTexto(entrada.encabezadoGuardado[campo] as string | null | undefined);
    const despues = comoTexto(entrada.encabezadoEnviado[campo] as string | null | undefined);
    if (distinto(antes, despues)) campos.push({ donde: 'encabezado', campo, antes, despues });
  }

  const importes: (keyof EncabezadoComparable)[] = [
    'netTotal',
    'ivaTotal',
    'perceptionsTotal',
    'total',
  ];
  for (const campo of importes) {
    const antes = comoNumero(entrada.encabezadoGuardado[campo] as MoneyInput | null | undefined);
    const despues = comoNumero(entrada.encabezadoEnviado[campo] as MoneyInput | null | undefined);
    if (distinto(antes, despues)) campos.push({ donde: 'encabezado', campo, antes, despues });
  }

  /* --- Los renglones ------------------------------------------------------ */
  const guardadosPorRenglon = new Map(entrada.renglonesGuardados.map((r) => [r.lineNumber, r]));
  const enviadosPorRenglon = new Map(entrada.renglonesEnviados.map((r) => [r.lineNumber, r]));

  const renglonesAgregados = entrada.renglonesEnviados
    .filter((r) => !guardadosPorRenglon.has(r.lineNumber))
    .map((r) => r.lineNumber);
  const renglonesQuitados = entrada.renglonesGuardados
    .filter((r) => !enviadosPorRenglon.has(r.lineNumber))
    .map((r) => r.lineNumber);

  const asociacionesCambiadas: CorreccionesManuales['asociacionesCambiadas'] = [];
  const clasificacionesCambiadas: CorreccionesManuales['clasificacionesCambiadas'] = [];

  for (const enviado of entrada.renglonesEnviados) {
    const guardado = guardadosPorRenglon.get(enviado.lineNumber);
    if (!guardado) continue; /* Es un agregado: ya está informado arriba. */

    const donde = `renglón ${enviado.lineNumber}`;

    for (const campo of ['supplierCode', 'description', 'unit'] as const) {
      const antes = comoTexto(guardado[campo]);
      const despues = comoTexto(enviado[campo]);
      if (distinto(antes, despues)) campos.push({ donde, campo, antes, despues });
    }
    for (const campo of ['quantity', 'unitNetPrice', 'discountPct', 'ivaRate'] as const) {
      const antes = comoNumero(guardado[campo]);
      const despues = comoNumero(enviado[campo]);
      if (distinto(antes, despues)) campos.push({ donde, campo, antes, despues });
    }

    const productoAntes = comoTexto(guardado.productId);
    const productoDespues = comoTexto(enviado.productId);
    if (distinto(productoAntes, productoDespues)) {
      asociacionesCambiadas.push({
        renglon: enviado.lineNumber,
        antes: productoAntes,
        despues: productoDespues,
      });
    }

    const claseAntes = comoTexto(guardado.expenseKind);
    const claseDespues = comoTexto(enviado.expenseKind);
    if (distinto(claseAntes, claseDespues)) {
      clasificacionesCambiadas.push({
        renglon: enviado.lineNumber,
        antes: claseAntes,
        despues: claseDespues,
      });
    }
  }

  return {
    campos,
    renglonesAgregados,
    renglonesQuitados,
    asociacionesCambiadas,
    clasificacionesCambiadas,
    huboCorrecciones:
      campos.length > 0 ||
      renglonesAgregados.length > 0 ||
      renglonesQuitados.length > 0 ||
      asociacionesCambiadas.length > 0 ||
      clasificacionesCambiadas.length > 0,
  };
}
