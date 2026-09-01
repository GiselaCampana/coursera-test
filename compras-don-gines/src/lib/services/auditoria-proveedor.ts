import 'server-only';
import { prisma } from '@/lib/db';
import { ForbiddenError, NotFoundError } from '@/lib/errors';
import { PERMISSIONS } from '@/lib/auth/permissions';
import { hasPermission, type AuthUser } from '@/lib/auth/session';
import { normalizeText, similarity } from '@/lib/domain/matching';
import { parseHeaderFromText } from '@/lib/ocr/text-parser';
import { cuitDigits } from '@/lib/services/suppliers';

/**
 * ¿Los comprobantes atribuidos a un proveedor son de verdad suyos?
 *
 * Existe por un defecto concreto: el analizador de Los Calvos reconocía un
 * comprobante sólo por las cabeceras "Bonif" e "Importe" —que imprime cualquier
 * sistema de facturación— y después escribía "Los Calvos" como razón social,
 * porque era su formato. Cualquier factura de un proveedor no cargado terminaba
 * atribuida a Los Calvos, con su plazo de pago, sus tasas y su cuenta
 * corriente. El analizador ya está corregido; lo que queda es saber qué pasó
 * con lo que se cargó antes.
 *
 * **Esto no corrige nada.** Sólo lee y clasifica. Una reasignación de proveedor
 * arrastra la cuenta corriente, la agenda de pagos, los costos y las
 * asociaciones aprendidas: no es algo que pueda decidir un procedimiento
 * automático a partir de indicios. Acá se juntan los indicios y se los muestra;
 * la decisión es de una persona.
 *
 * La evidencia sale de seis lugares, y no todos pesan lo mismo. Tres hablan de
 * **quién emitió** el comprobante —el CUIT y la razón social que quedaron en el
 * texto del OCR, y de qué proveedor son los códigos de artículo— y son los
 * únicos que deciden. Los otros tres —las asociaciones al catálogo, el plazo
 * aplicado y las tasas— son una copia que el sistema hizo del proveedor que ya
 * tenía asignado: coinciden por construcción, así que dejarlos votar sería
 * preguntarle al acusado. Se informan igual, porque dicen qué aplicó el sistema
 * y son justamente lo que quedaría mal si el comprobante se reasignara.
 */

export type VeredictoDeAtribucion =
  /** El comprobante dice, en el papel, que es de este proveedor. */
  | 'CORRECTO'
  /** El papel nombra a otro proveedor que está cargado en el sistema. */
  | 'OTRO_PROVEEDOR'
  /** No hay confirmación y sí hay señales de que es de otro. */
  | 'SOSPECHOSO'
  /** No quedó con qué decidir: sin texto de OCR, o sin nada que contrastar. */
  | 'SIN_EVIDENCIA';

export const VEREDICTO_LABEL: Record<VeredictoDeAtribucion, string> = {
  CORRECTO: 'Correctamente asignados',
  SOSPECHOSO: 'Sospechosos',
  OTRO_PROVEEDOR: 'Confirmadamente de otro proveedor',
  SIN_EVIDENCIA: 'Sin evidencia suficiente',
};

/** De dónde salió cada indicio. */
export type FuenteDeEvidencia =
  | 'OCR_CUIT'
  | 'OCR_RAZON_SOCIAL'
  | 'CODIGOS_DE_ARTICULO'
  | 'ASOCIACIONES'
  | 'PLAZO_Y_AGENDA'
  | 'IMPUESTOS'
  | 'COSTOS_Y_MOVIMIENTOS';

export interface Indicio {
  fuente: FuenteDeEvidencia;
  /**
   * `true` cuando apoya que el proveedor asignado sea el correcto, `false`
   * cuando lo contradice, `null` cuando no se pudo mirar.
   */
  aFavor: boolean | null;
  /**
   * ¿Este indicio puede decidir el veredicto?
   *
   * Sólo pueden los que hablan de **quién emitió** el comprobante: lo que dice
   * el papel y de qué proveedor son los códigos de artículo. Los demás son
   * contexto.
   *
   * La distinción no es un matiz. El plazo de pago y las tasas que tiene
   * guardadas el comprobante son una **copia que hizo el sistema** del
   * proveedor que se le asignó, al confirmarlo. Coinciden por construcción:
   * dejarlas votar sería preguntarle al acusado si es culpable y contar su
   * respuesta como prueba. Lo mismo con las asociaciones al catálogo, que se
   * resolvieron contra los alias de ese mismo proveedor.
   *
   * Se informan igual, y por dos razones: dicen qué aplicó el sistema, y son
   * exactamente lo que quedaría mal si el comprobante se reasignara.
   */
  decide: boolean;
  detalle: string;
}

export interface ComprobanteAuditado {
  documentId: string;
  numero: string;
  fecha: Date | null;
  tipo: string;
  estado: string;
  total: string;
  sucursal: string;
  veredicto: VeredictoDeAtribucion;
  /** Si el papel nombra a otro proveedor cargado, cuál. */
  proveedorProbable: { id: string; nombre: string; porQue: string } | null;
  indicios: Indicio[];
  /** Qué quedaría que revisar si el comprobante se reasignara. */
  derivados: {
    movimientos: number;
    entradasDeCosto: number;
    tieneAgenda: boolean;
    pagado: string;
    asociacionesAprendidas: number;
  };
}

export interface AuditoriaDeAtribucion {
  proveedor: { id: string; nombre: string; cuit: string | null };
  total: number;
  porVeredicto: Record<VeredictoDeAtribucion, ComprobanteAuditado[]>;
  /** Comprobantes que no se pudieron leer porque no guardaron texto de OCR. */
  sinTextoDeOcr: number;
  generadaEl: Date;
}

/**
 * Audita, sin tocar nada, los comprobantes atribuidos a un proveedor.
 *
 * Es de sólo lectura por diseño y no por olvido: no abre ninguna transacción de
 * escritura, no llama a ningún servicio que escriba, y devuelve un informe.
 */
export async function auditarAtribucion(
  user: AuthUser,
  supplierId: string,
): Promise<AuditoriaDeAtribucion> {
  if (!hasPermission(user, PERMISSIONS.PROVEEDORES_GESTIONAR)) {
    throw new ForbiddenError('Tu usuario no puede auditar la atribución de comprobantes.');
  }

  const proveedor = await prisma.supplier.findUnique({
    where: { id: supplierId },
    include: { aliases: true },
  });
  if (!proveedor) throw new NotFoundError('No encontramos ese proveedor.');

  /*
   * Todos los proveedores cargados, con sus alias y sus CUIT.
   *
   * Hacen falta enteros para poder decir "el papel nombra a **este otro**", que
   * es la diferencia entre un sospechoso y un caso confirmado.
   */
  const todos = await prisma.supplier.findMany({ include: { aliases: true } });

  const documentos = await prisma.document.findMany({
    where: { supplierId, status: { in: ['VALIDADO', 'REQUIERE_REVISION', 'ANULADO'] } },
    orderBy: [{ issueDate: 'desc' }],
    include: {
      branch: { select: { name: true } },
      items: { select: { supplierCode: true, description: true, productId: true } },
      ocrAttempts: { orderBy: { attemptNumber: 'asc' }, select: { recognizedText: true } },
      paymentSchedule: { select: { paidAmount: true } },
      _count: { select: { purchaseMovements: true, costHistory: true } },
    },
  });

  const reglas = await prisma.supplierTaxRule.findMany({ where: { supplierId } });
  const plazos = await prisma.supplierPaymentTerm.findMany({ where: { supplierId } });

  /*
   * Qué código de artículo pertenece a qué proveedor, según lo aprendido.
   *
   * Un renglón cuyo código está aprendido para **otro** proveedor es un indicio
   * fuerte y no depende del OCR: son dos fuentes distintas diciendo lo mismo.
   */
  const alias = await prisma.productAlias.findMany({
    where: { supplierCode: { not: null } },
    select: { supplierId: true, supplierCode: true },
  });
  const duenoDelCodigo = new Map<string, string>();
  for (const a of alias) {
    if (a.supplierId && a.supplierCode) {
      duenoDelCodigo.set(normalizeText(a.supplierCode), a.supplierId);
    }
  }

  const porVeredicto: Record<VeredictoDeAtribucion, ComprobanteAuditado[]> = {
    CORRECTO: [],
    SOSPECHOSO: [],
    OTRO_PROVEEDOR: [],
    SIN_EVIDENCIA: [],
  };
  let sinTextoDeOcr = 0;

  for (const documento of documentos) {
    const texto = documento.ocrAttempts
      .map((a) => a.recognizedText ?? '')
      .filter((t) => t.trim() !== '')
      .join('\n');
    if (texto.trim() === '') sinTextoDeOcr++;

    const indicios: Indicio[] = [];

    // --- 1 y 2. Lo que dice el papel: CUIT y razón social ------------------
    const delPapel = analizarElPapel(texto, proveedor, todos);
    indicios.push(...delPapel.indicios);

    // --- 3. Códigos de artículo -------------------------------------------
    indicios.push(analizarCodigos(documento.items, supplierId, duenoDelCodigo, todos));

    // --- 4. Asociaciones al catálogo --------------------------------------
    indicios.push(analizarAsociaciones(documento.items));

    // --- 5. Plazo y agenda -------------------------------------------------
    indicios.push(
      analizarPlazo(
        { termType: documento.appliedTermType, days: documento.appliedTermDays },
        plazos,
      ),
    );

    // --- 6. Tasas e impuestos ---------------------------------------------
    indicios.push(
      analizarImpuestos(
        {
          iva: documento.appliedIvaRate?.toString() ?? null,
          iibb: documento.appliedIibbRate?.toString() ?? null,
          percepciones: documento.perceptionsTotal?.toString() ?? null,
        },
        reglas,
      ),
    );

    const veredicto = dictaminar(delPapel, indicios);

    porVeredicto[veredicto].push({
      documentId: documento.id,
      numero: documento.fullNumber || 'sin número',
      fecha: documento.issueDate,
      tipo: documento.docType,
      estado: documento.status,
      total: documento.total?.toString() ?? '0',
      sucursal: documento.branch.name,
      veredicto,
      proveedorProbable: delPapel.otro,
      indicios,
      derivados: {
        movimientos: documento._count.purchaseMovements,
        entradasDeCosto: documento._count.costHistory,
        tieneAgenda: documento.paymentSchedule !== null,
        pagado: documento.paymentSchedule?.paidAmount.toString() ?? '0',
        asociacionesAprendidas: documento.items.filter((i) => i.productId).length,
      },
    });
  }

  return {
    proveedor: { id: proveedor.id, nombre: proveedor.tradeName, cuit: proveedor.cuit },
    total: documentos.length,
    porVeredicto,
    sinTextoDeOcr,
    generadaEl: new Date(),
  };
}

type ProveedorConAlias = {
  id: string;
  tradeName: string;
  legalName: string | null;
  cuit: string | null;
  aliases: { normalized: string }[];
};

interface LecturaDelPapel {
  /** El CUIT del proveedor asignado aparece impreso. */
  cuitPropio: boolean;
  /** Su nombre o alguno de sus alias aparece impreso. */
  nombrePropio: boolean;
  /** Hay texto de OCR guardado con el que mirar. */
  hayTexto: boolean;
  /** Otro proveedor cargado al que el papel nombra. */
  otro: { id: string; nombre: string; porQue: string } | null;
  indicios: Indicio[];
}

/**
 * Qué dice el papel sobre quién emitió el comprobante.
 *
 * Se busca el CUIT y el nombre **en el texto crudo del OCR**, no en el
 * encabezado interpretado. Es deliberado: el encabezado lo produjo el mismo
 * analizador cuya elección se está auditando, así que creerle sería preguntarle
 * al acusado. El texto reconocido, en cambio, es lo que había en la foto.
 */
function analizarElPapel(
  texto: string,
  proveedor: ProveedorConAlias,
  todos: ProveedorConAlias[],
): LecturaDelPapel {
  const indicios: Indicio[] = [];
  if (texto.trim() === '') {
    indicios.push({
      fuente: 'OCR_CUIT',
      aFavor: null,
      decide: true,
      detalle: 'El comprobante no guardó el texto de la lectura: no hay papel que mirar.',
    });
    indicios.push({
      fuente: 'OCR_RAZON_SOCIAL',
      aFavor: null,
      decide: true,
      detalle: 'Sin texto de la lectura no se puede contrastar la razón social.',
    });
    return { cuitPropio: false, nombrePropio: false, hayTexto: false, otro: null, indicios };
  }

  const normalizado = normalizeText(texto);
  const soloDigitos = texto.replace(/\D/g, '');

  // --- CUIT ---------------------------------------------------------------
  const propio = cuitDigits(proveedor.cuit);
  const cuitPropio = propio !== null && soloDigitos.includes(propio);
  const otroPorCuit = todos.find((s) => {
    if (s.id === proveedor.id) return false;
    const d = cuitDigits(s.cuit);
    return d !== null && soloDigitos.includes(d);
  });

  indicios.push({
    fuente: 'OCR_CUIT',
    aFavor: cuitPropio ? true : otroPorCuit ? false : null,
    decide: true,
    detalle: cuitPropio
      ? `El CUIT ${proveedor.cuit} está impreso en el comprobante.`
      : otroPorCuit
        ? `El CUIT impreso es el de ${otroPorCuit.tradeName}, no el de ${proveedor.tradeName}.`
        : propio === null
          ? `${proveedor.tradeName} no tiene CUIT cargado: no hay con qué comparar.`
          : `El CUIT ${proveedor.cuit} no aparece en el texto leído.`,
  });

  // --- Razón social -------------------------------------------------------
  const nombresPropios = nombresDe(proveedor);
  const nombrePropio = nombresPropios.some((n) => normalizado.includes(n));

  const header = parseHeaderFromText(texto);
  const leido = normalizeText(header.legalName ?? header.supplierName ?? '');

  const otroPorNombre = todos.find((s) => {
    if (s.id === proveedor.id) return false;
    return nombresDe(s).some((n) => normalizado.includes(n));
  });

  indicios.push({
    fuente: 'OCR_RAZON_SOCIAL',
    aFavor: nombrePropio ? true : otroPorNombre || leido !== '' ? false : null,
    decide: true,
    detalle: nombrePropio
      ? `El nombre «${proveedor.tradeName}» está impreso en el comprobante.`
      : otroPorNombre
        ? `El nombre impreso es el de ${otroPorNombre.tradeName}.`
        : leido !== ''
          ? `La razón social leída es «${header.legalName ?? header.supplierName}», ` +
            `que no se parece a «${proveedor.tradeName}» ` +
            `(parecido ${(similarity(leido, normalizeText(proveedor.tradeName)) * 100).toFixed(0)} %).`
          : `El nombre «${proveedor.tradeName}» no aparece en el texto leído.`,
  });

  const otro = otroPorCuit
    ? {
        id: otroPorCuit.id,
        nombre: otroPorCuit.tradeName,
        porQue: 'Su CUIT está impreso en el comprobante.',
      }
    : otroPorNombre
      ? {
          id: otroPorNombre.id,
          nombre: otroPorNombre.tradeName,
          porQue: 'Su razón social está impresa en el comprobante.',
        }
      : null;

  return { cuitPropio, nombrePropio, hayTexto: true, otro, indicios };
}

/** El nombre del proveedor y todas las formas en que se lo reconoce. */
function nombresDe(s: ProveedorConAlias): string[] {
  return [
    normalizeText(s.tradeName),
    s.legalName ? normalizeText(s.legalName) : '',
    ...s.aliases.map((a) => a.normalized),
  ].filter((n) => n.length >= 4);
}

/** Los códigos de artículo, contrastados contra lo aprendido de cada proveedor. */
function analizarCodigos(
  items: { supplierCode: string | null }[],
  supplierId: string,
  duenoDelCodigo: Map<string, string>,
  todos: ProveedorConAlias[],
): Indicio {
  const codigos = items
    .map((i) => (i.supplierCode ?? '').trim())
    .filter((c) => c !== '')
    .map((c) => normalizeText(c));
  if (codigos.length === 0) {
    return {
      fuente: 'CODIGOS_DE_ARTICULO',
      aFavor: null,
      decide: true,
      detalle: 'Los renglones no traen código de proveedor.',
    };
  }

  const propios = codigos.filter((c) => duenoDelCodigo.get(c) === supplierId).length;
  const ajenos = codigos.filter((c) => {
    const dueno = duenoDelCodigo.get(c);
    return dueno !== undefined && dueno !== supplierId;
  });

  if (ajenos.length > 0) {
    const dueno = todos.find((s) => s.id === duenoDelCodigo.get(ajenos[0]));
    return {
      fuente: 'CODIGOS_DE_ARTICULO',
      aFavor: false,
      decide: true,
      detalle:
        `${ajenos.length} de ${codigos.length} códigos están aprendidos para ` +
        `${dueno?.tradeName ?? 'otro proveedor'} (por ejemplo ${ajenos[0].toUpperCase()}).`,
    };
  }
  if (propios > 0) {
    return {
      fuente: 'CODIGOS_DE_ARTICULO',
      aFavor: true,
      decide: true,
      detalle: `${propios} de ${codigos.length} códigos ya estaban aprendidos para este proveedor.`,
    };
  }
  return {
    fuente: 'CODIGOS_DE_ARTICULO',
    aFavor: null,
    decide: true,
    detalle: `Ninguno de los ${codigos.length} códigos está aprendido para ningún proveedor.`,
  };
}

/**
 * Cuántos renglones quedaron asociados a un artículo del catálogo.
 *
 * Informativo y no decisorio: la asociación se resolvió contra los alias del
 * proveedor que ya estaba asignado, así que apoyarlo con esto sería circular.
 * Vale como tamaño del problema —es lo que habría que rehacer si el
 * comprobante se reasignara— y no como prueba de quién lo emitió.
 */
function analizarAsociaciones(items: { productId: string | null }[]): Indicio {
  const asociados = items.filter((i) => i.productId).length;
  if (items.length === 0) {
    return {
      fuente: 'ASOCIACIONES',
      aFavor: null,
      decide: false,
      detalle: 'El comprobante no tiene renglones.',
    };
  }
  return {
    fuente: 'ASOCIACIONES',
    aFavor: null,
    decide: false,
    detalle: `${asociados} de ${items.length} renglones quedaron asociados al catálogo.`,
  };
}

/** El plazo copiado en el comprobante contra los del proveedor. */
function analizarPlazo(
  aplicado: { termType: string | null; days: number | null },
  plazos: { termType: string; days: number }[],
): Indicio {
  if (!aplicado.termType) {
    return {
      fuente: 'PLAZO_Y_AGENDA',
      aFavor: null,
      decide: false,
      detalle: 'El comprobante no guardó ninguna condición de pago aplicada.',
    };
  }
  if (plazos.length === 0) {
    return {
      fuente: 'PLAZO_Y_AGENDA',
      aFavor: null,
      decide: false,
      detalle: 'El proveedor no tiene condiciones de pago cargadas: no hay con qué comparar.',
    };
  }
  const coincide = plazos.some(
    (p) => p.termType === aplicado.termType && (aplicado.days ?? 0) === p.days,
  );
  return {
    fuente: 'PLAZO_Y_AGENDA',
    aFavor: coincide,
    decide: false,
    detalle: coincide
      ? `El plazo aplicado (${aplicado.termType}, ${aplicado.days ?? 0} días) es uno de los del proveedor.`
      : `El plazo aplicado (${aplicado.termType}, ${aplicado.days ?? 0} días) no coincide con ` +
        'ninguna condición cargada para este proveedor.',
  };
}

/** Las tasas copiadas en el comprobante contra las reglas del proveedor. */
function analizarImpuestos(
  aplicado: { iva: string | null; iibb: string | null; percepciones: string | null },
  reglas: { ivaRate: { toString(): string }; iibbRate: { toString(): string } }[],
): Indicio {
  if (reglas.length === 0) {
    return {
      fuente: 'IMPUESTOS',
      aFavor: null,
      decide: false,
      detalle: 'El proveedor no tiene reglas impositivas cargadas: no hay con qué comparar.',
    };
  }
  if (aplicado.iva === null && aplicado.iibb === null) {
    return {
      fuente: 'IMPUESTOS',
      aFavor: null,
      decide: false,
      detalle: 'El comprobante no guardó las tasas aplicadas.',
    };
  }
  const igual = (a: string | null, b: string) =>
    a !== null && Number(a).toFixed(6) === Number(b).toFixed(6);

  const coincide = reglas.some(
    (r) =>
      (aplicado.iva === null || igual(aplicado.iva, r.ivaRate.toString())) &&
      (aplicado.iibb === null || igual(aplicado.iibb, r.iibbRate.toString())),
  );
  return {
    fuente: 'IMPUESTOS',
    aFavor: coincide,
    decide: false,
    detalle: coincide
      ? 'Las tasas aplicadas coinciden con las reglas cargadas para el proveedor.'
      : `Las tasas aplicadas (IVA ${aplicado.iva ?? '—'}, IIBB ${aplicado.iibb ?? '—'}) no ` +
        'coinciden con ninguna regla cargada para este proveedor.',
  };
}

/**
 * El veredicto, con el papel por encima de todo lo demás.
 *
 * El orden no es arbitrario. El CUIT impreso es un identificador y decide solo:
 * si está el del proveedor asignado, el comprobante es suyo por más que
 * cualquier otro indicio diga lo contrario, y si está el de otro proveedor
 * cargado, es de aquél. Recién cuando el papel no alcanza entran los indicios
 * indirectos, y ésos no confirman: sólo levantan sospecha.
 *
 * Un comprobante sin texto de OCR no es sospechoso: es indecidible, y ponerlo
 * entre los sospechosos convertiría "no sé" en "probablemente mal", que es
 * exactamente el error que hace desconfiar de un informe entero.
 */
function dictaminar(papel: LecturaDelPapel, indicios: Indicio[]): VeredictoDeAtribucion {
  if (papel.cuitPropio || papel.nombrePropio) return 'CORRECTO';
  if (papel.otro) return 'OTRO_PROVEEDOR';
  if (!papel.hayTexto) return 'SIN_EVIDENCIA';

  /*
   * Hay papel y no nombra a nadie conocido. Deciden los indicios que hablan de
   * quién emitió el comprobante, y **sólo** ésos.
   *
   * Basta uno en contra para levantar la sospecha, sin contarlo contra los
   * demás. La razón es que los indicios a favor que quedan son débiles —"los
   * códigos no son de nadie"— mientras que los que están en contra son
   * concretos: la razón social que se leyó es otra, o los códigos son de otro
   * proveedor. Un empate entre esas dos cosas no es un empate.
   *
   * Y sospechoso no es culpable: es "esto hay que mirarlo". Sale de acá con
   * los indicios a la vista para que lo mire una persona.
   */
  const enContra = indicios.filter((i) => i.decide && i.aFavor === false);
  if (enContra.length > 0) return 'SOSPECHOSO';
  return 'SIN_EVIDENCIA';
}
