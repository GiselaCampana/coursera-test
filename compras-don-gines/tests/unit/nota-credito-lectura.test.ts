import { describe, it, expect } from 'vitest';
import { esNotaDeCredito, parseHeaderFromText } from '@/lib/ocr/text-parser';
import { elegirAnalizador } from '@/lib/ocr/parsers';
import { MABELHERDI_COMPLETO } from '../fixtures/mabelherdi';
import { SAFARI_COMPLETO } from '../fixtures/errecalde-safari';
import { LOS_CALVOS_TEXT } from '../fixtures/los-calvos';

/**
 * Reconocer una nota de crédito en lo que se leyó del papel.
 *
 * Es lo primero que tiene que salir bien, porque de ahí para adelante todo
 * cambia de signo: una nota de crédito tomada por factura suma en la cuenta
 * corriente del proveedor en vez de restar, y el error se descubre pagando de
 * más.
 */

describe('distinguir una nota de crédito de una factura', () => {
  it('la reconoce aunque el comprobante nombre la factura que corrige', () => {
    /*
     * El caso normal, no el raro: casi todas las notas de crédito llevan
     * impresa la palabra "factura" en el cuerpo, porque dicen a cuál
     * corresponden. Buscar "factura" y quedarse con eso es exactamente lo que
     * hace que entren como facturas.
     */
    const texto = [
      'DISTRIBUCION ERRECALDE S. A.',
      'NOTA DE CREDITO A',
      'Punto de Venta: 0003  Comp. Nro: 00012345',
      'Fecha de Emision: 25/08/2026',
      'Por la factura 0003-00011111',
    ].join('\n');

    expect(esNotaDeCredito(texto)).toBe(true);
    expect(parseHeaderFromText(texto).docType).toBe('NOTA_CREDITO');
  });

  it('acepta la abreviatura, que es como suele venir impresa', () => {
    expect(esNotaDeCredito('NC A  0003-00012345')).toBe(true);
    expect(esNotaDeCredito('N/C B 0003-00012345')).toBe(true);
    expect(parseHeaderFromText('LOS CALVOS S.A.\nNC A\nComp. Nro: 00012345').letter).toBe('A');
  });

  it('lee la letra de la nota de crédito, no la de otra cosa', () => {
    const header = parseHeaderFromText('NOTA DE CREDITO B\nComp. Nro: 00012345');
    expect(header.docType).toBe('NOTA_CREDITO');
    expect(header.letter).toBe('B');
  });

  it('no ve notas de crédito donde no las hay', () => {
    expect(esNotaDeCredito('FACTURA A · Condicion de venta: Cuenta corriente')).toBe(false);
    // "Nota" a secas no alcanza: las facturas traen notas al pie.
    expect(esNotaDeCredito('Nota: la mercaderia viaja por cuenta del comprador')).toBe(false);
    // Y una "C" de letra de comprobante no es una N/C.
    expect(esNotaDeCredito('FACTURA C')).toBe(false);
  });
});

describe('las tres facturas reales siguen siendo facturas', () => {
  /*
   * La regresión que importa al agregar un tipo de comprobante: las lecturas
   * reales que ya funcionaban no pueden empezar a leerse como notas de
   * crédito. Se prueba sobre el texto que salió del OCR, con su ruido.
   */
  it.each([
    ['Mabelherdi', MABELHERDI_COMPLETO],
    ['Errecalde', SAFARI_COMPLETO],
    ['Los Calvos', LOS_CALVOS_TEXT],
  ])('%s', (_nombre, texto) => {
    expect(esNotaDeCredito(texto)).toBe(false);
    const { analizador } = elegirAnalizador({ completo: texto });
    expect(analizador.analizar({ completo: texto }).header?.docType).toBe('FACTURA');
  });
});

describe('la nota de crédito de un proveedor con analizador propio', () => {
  it('no se convierte en factura por venir de un proveedor que factura', () => {
    /*
     * El analizador de Errecalde daba por sentado que su proveedor sólo emite
     * facturas. Sobre una nota de crédito suya eso fijaba el tipo en FACTURA y
     * el comprobante entraba sumando en la cuenta corriente.
     */
    const texto = [
      'DISTRIBUCION ERRECALDE S. A.',
      'CUIT 30-71780890-4',
      'NOTA DE CREDITO A',
      'Punto de Venta: 0003  Comp. Nro: 00012345',
      'Fecha de Emision: 25/08/2026',
      'ART-00228 CREMOSO PUNTA DEL AGUA  1,00  10.000,00  10.000,00',
    ].join('\n');

    const { analizador } = elegirAnalizador({ completo: texto });
    expect(analizador.codigo).toBe('errecalde');
    expect(analizador.analizar({ completo: texto }).header?.docType).toBe('NOTA_CREDITO');
  });
});
