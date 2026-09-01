/**
 * Los motivos por los que un proveedor emite una nota de crédito, y cuáles de
 * ellos admiten además que haya vuelto mercadería.
 *
 * Vive acá —fuera del servicio y fuera de la pantalla— porque las dos puntas
 * necesitan la misma lista y la misma regla. Si la pantalla creyera que una
 * bonificación puede llevar mercadería devuelta, ofrecería una casilla que el
 * servidor rechaza, y el operador vería un error sobre algo que la aplicación
 * misma le ofreció marcar.
 */

export const MOTIVOS_DE_CREDITO = [
  'BONIFICACION',
  'DIFERENCIA_PRECIO',
  'DESCUENTO_COMERCIAL',
  'CORRECCION_FISCAL',
  'DEVOLUCION_PERCEPCION',
  'DEVOLUCION_MERCADERIA',
  'OTRO',
] as const;

export type MotivoDeCredito = (typeof MOTIVOS_DE_CREDITO)[number];

export const MOTIVO_DE_CREDITO_LABEL: Record<MotivoDeCredito, string> = {
  BONIFICACION: 'Bonificación',
  DIFERENCIA_PRECIO: 'Diferencia de precio',
  DESCUENTO_COMERCIAL: 'Descuento comercial',
  CORRECCION_FISCAL: 'Corrección fiscal',
  DEVOLUCION_PERCEPCION: 'Devolución de percepción',
  DEVOLUCION_MERCADERIA: 'Devolución de mercadería',
  OTRO: 'Otro',
};

/**
 * ¿Con este motivo puede haber vuelto mercadería?
 *
 * Los cinco motivos financieros no: una bonificación por volumen, una
 * diferencia de precio, un descuento comercial, una corrección fiscal o la
 * devolución de una percepción bajan lo que hay que pagar y no sacan un kilo
 * del negocio. Marcarlos como devolución dejaría el stock corto para siempre
 * por una nota que nunca movió mercadería.
 */
export function admiteDevolucion(motivo: string): boolean {
  return motivo === 'DEVOLUCION_MERCADERIA' || motivo === 'OTRO';
}

export function esMotivoDeCredito(valor: string): valor is MotivoDeCredito {
  return (MOTIVOS_DE_CREDITO as readonly string[]).includes(valor);
}
