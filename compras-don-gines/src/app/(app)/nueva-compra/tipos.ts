import type { CheckResult } from '@/lib/domain/validation';
import type { Conciliacion } from '@/lib/domain/conciliacion';

export interface Opcion {
  id: string;
  nombre: string;
}

export interface OpcionProducto extends Opcion {
  codigo: string;
}

export interface ArticuloRevision {
  id: string;
  renglon: number;
  codigo: string | null;
  descripcion: string;
  cantidad: string;
  unidad: 'KG' | 'UNIT';
  piezas: number | null;
  pesoTotal: string | null;
  pesoPorPieza: string | null;
  precioUnitario: string;
  bruto: string;
  /** false cuando el importe no se pudo leer y se calculó. */
  brutoImpreso: boolean;
  descuentoPct: string;
  descuento: string;
  neto: string;
  ivaTasa: string;
  iva: string;
  percepcion: string;
  costoTotal: string;
  costoUnitario: string;
  productoId: string | null;
  producto: string | null;
  asociacion: string;
}

export interface ResumenComprobante {
  grossSubtotal: string | null;
  discountTotal: string | null;
  netTotal: string | null;
  ivaTotal: string | null;
  perceptionsTotal: string | null;
  total: string | null;
  lineCount: number | null;
  netWeightKg: string | null;
  totalUnits: string | null;
}

export interface InformeControl {
  state: 'OK' | 'RECONCILIADO' | 'DIFERENCIA' | 'PENDIENTE';
  canSave: boolean;
  checks: CheckResult[];
  errorCount: number;
  warningCount: number;
  /** Centavos que el servidor concilió, para poder avisarlo en la pantalla. */
  reconciliation?: Conciliacion | null;
  computed: {
    itemCount: number;
    grossSubtotal: string;
    discountAmount: string;
    netAmount: string;
    ivaAmount: string;
    perceptionAmount: string;
    totalCost: string;
    totalQuantityKg: string;
    totalUnits: string;
  };
}

export interface PaginaComprobante {
  id: string;
  orden: number;
  url: string;
  tipo: string;
  esPdf: boolean;
  tamano: number;
}

export interface ComprobanteRevision {
  id: string;
  sucursal: Opcion;
  proveedor: Opcion | null;
  tipo: 'FACTURA' | 'REMITO';
  letra: string | null;
  puntoDeVenta: string;
  numero: string;
  fecha: string | null;
  estado: string;
  control: string;
  informe: InformeControl | null;
  resumen: ResumenComprobante;
  condiciones: {
    plazo: string | null;
    dias: number | null;
    formaDePago: string | null;
    ivaTasa: string | null;
    iibbTasa: string | null;
    vencimiento: string | null;
  };
  articulos: ArticuloRevision[];
  paginas: PaginaComprobante[];
  lecturas: {
    numero: number;
    etapa: string;
    estrategia: string | null;
    proveedor: string;
    modelo: string | null;
    exito: boolean;
    duracionMs: number | null;
    confianza: string | null;
    error: string | null;
  }[];
  pago: {
    id: string;
    vencimiento: string;
    importe: string;
    pagado: string;
    formaDePago: string;
    estado: string;
  } | null;
}
