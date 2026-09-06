import { describe, it, expect } from 'vitest';
import { traeNumeroDeComprobante } from '@/lib/cliente/ocr/lector';

/**
 * El disparador de la lectura dirigida del encabezado.
 *
 * Cuando el encabezado se lee y no aparece el número de comprobante, se vuelve
 * a leer esa zona sacándola de la foto original, sin la reducción con la que se
 * trabaja la página. Lo que decide es la **forma del dato**, no el proveedor:
 * todo comprobante argentino lleva punto de venta y número, y si eso no está,
 * el encabezado no sirve para nada.
 *
 * Corre siempre: es una regla de texto y no necesita Tesseract.
 */
describe('reconocer un número de comprobante en el encabezado', () => {
  it('lo encuentra en los formatos de las tres facturas reales', () => {
    expect(traeNumeroDeComprobante('FACTURA Nº 0007-00348491 Fecha 20/08/2026')).toBe(true);
    expect(traeNumeroDeComprobante('FACTURA-REMITO A  FAR-A 00008-00002647')).toBe(true);
    expect(traeNumeroDeComprobante('Nº 0010  00212356')).toBe(false); // sin guion no alcanza
    expect(traeNumeroDeComprobante('Comprobante 0010-00212356 del 14/08/2026')).toBe(true);
  });

  it('acepta el guion largo y los espacios que mete el OCR', () => {
    expect(traeNumeroDeComprobante('0007 - 00348491')).toBe(true);
    expect(traeNumeroDeComprobante('0007–00348491')).toBe(true);
  });

  it('no confunde una fecha, un CUIT ni un importe con un número', () => {
    /*
     * El control tiene que ser específico: si diera positivo con cualquier cosa,
     * la lectura dirigida no se dispararía nunca y no serviría de nada.
     */
    expect(traeNumeroDeComprobante('Fecha 20/08/2026')).toBe(false);
    expect(traeNumeroDeComprobante('CUIT 30-67804306-7')).toBe(false);
    expect(traeNumeroDeComprobante('Total $ 40.506,09')).toBe(false);
    expect(traeNumeroDeComprobante('IVA 21,00 %')).toBe(false);
  });

  it('sin texto, no hay número', () => {
    expect(traeNumeroDeComprobante(null)).toBe(false);
    expect(traeNumeroDeComprobante('')).toBe(false);
    expect(traeNumeroDeComprobante('   ')).toBe(false);
  });
});
