import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '@/lib/db';
import { limpiarBase, sembrarEscenario, type Escenario } from './ayudas';
import {
  LOS_CALVOS_TEXT,
  LOS_CALVOS_ENCABEZADO_OCR,
  LOS_CALVOS_ARTICULOS_OCR,
  LOS_CALVOS_RESUMEN_OCR,
} from '../fixtures/los-calvos';

/**
 * **El proveedor sale del emisor, nunca de un renglón.**
 *
 * Una marca adentro de un artículo —«queso marca Errecalde», «fiambre La
 * Serenísima»— no dice quién emitió la factura. Atribuirla por ahí manda la
 * deuda al proveedor equivocado, y la corrección es manual y tardía porque para
 * cuando se nota el pago ya salió.
 *
 * La regla está en la firma de `findSupplierByReading`: recibe emisor, razón
 * social y CUIT, y **no recibe los renglones**. Esta prueba la ejercita por la
 * ruta real, con la marca del otro proveedor sembrado metida en el texto de los
 * artículos, que es como llegaría desde una foto.
 *
 * Existe además una prueba de interfaz que cubre lo mismo desde el navegador.
 * Ésta vive acá porque corre en un segundo y permite romper la regla a
 * propósito sin esperar seis minutos de Playwright.
 */

let escenario: Escenario;
let usuarioActual: Escenario['admin'];

vi.mock('@/lib/auth/session', async (original) => {
  const real = await original<typeof import('@/lib/auth/session')>();
  return {
    ...real,
    /* Lo único sustituido es de dónde sale el usuario. */
    requireUser: vi.fn(async () => usuarioActual),
  };
});

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();
  usuarioActual = escenario.admin;
});

/** La marca del OTRO proveedor sembrado, tal como podría venir impresa. */
const RENGLON_CON_MARCA_AJENA = 'QUESO SARDO MARCA DISTRIBUCION ERRECALDE 1,000 10.000,00';

describe('el proveedor sale del emisor, nunca de un renglón', () => {
  it('una factura de Los Calvos que nombra a Errecalde en la tabla sigue siendo de Los Calvos', async () => {
    const { POST: abrir } = await import('@/app/api/comprobantes/route');
    const alta = await abrir(
      new Request('http://localhost/api/comprobantes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ branchId: escenario.sucursales.devoto }),
      }),
    );
    const datos = (await alta.json()) as { id: string };
    expect(alta.status, `alta: ${JSON.stringify(datos)}`).toBeLessThan(300);

    const { POST: leer } = await import('@/app/api/comprobantes/[id]/lectura/route');
    const lectura = await leer(
      new Request(`http://localhost/api/comprobantes/${datos.id}/lectura`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          intento: 1,
          estrategia: 'completo',
          proveedor: 'tesseract',
          modelo: 'spa',
          duracionMs: 1000,
          paginas: [
            {
              numero: 1,
              textoCompleto: `${LOS_CALVOS_TEXT}\n${RENGLON_CON_MARCA_AJENA}`,
              textoEncabezado: LOS_CALVOS_ENCABEZADO_OCR,
              textoArticulos: `${RENGLON_CON_MARCA_AJENA}\n${LOS_CALVOS_ARTICULOS_OCR}`,
              textoResumen: LOS_CALVOS_RESUMEN_OCR,
              confianza: 0.85,
            },
          ],
        }),
      }),
      { params: Promise.resolve({ id: datos.id }) },
    );
    expect(lectura.status).toBeLessThan(300);

    const documento = await prisma.document.findUniqueOrThrow({
      where: { id: datos.id },
      select: { readSupplierName: true, supplier: { select: { tradeName: true } } },
    });

    expect(documento.supplier?.tradeName).toBe('Los Calvos');
    expect(documento.supplier?.tradeName ?? '').not.toContain('Errecalde');
    /* Y lo que quedó guardado como emisor leído tampoco es la marca. */
    expect(documento.readSupplierName ?? '').not.toContain('ERRECALDE');
  });

  it('sin CUIT legible tampoco: la marca del renglón no alcanza para atribuir', async () => {
    /*
     * El caso de verdad. Con el CUIT leído, la atribución ni mira los nombres,
     * así que una marca en la tabla es inofensiva por una razón que no es la
     * que uno cree. Acá se borra el CUIT del encabezado —una foto movida, un
     * renglón tapado— y queda sólo el nombre: es cuando una marca del renglón
     * podría ganar, y es donde hay que comprobar que no gana.
     */
    const { POST: abrir } = await import('@/app/api/comprobantes/route');
    const alta = await abrir(
      new Request('http://localhost/api/comprobantes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ branchId: escenario.sucursales.devoto }),
      }),
    );
    const datos = (await alta.json()) as { id: string };

    const sinCuit = (texto: string) => texto.replace(/CUIT[^\n]*/g, 'CUIT:');

    const { POST: leer } = await import('@/app/api/comprobantes/[id]/lectura/route');
    await leer(
      new Request(`http://localhost/api/comprobantes/${datos.id}/lectura`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          intento: 1,
          estrategia: 'completo',
          proveedor: 'tesseract',
          modelo: 'spa',
          duracionMs: 1000,
          paginas: [
            {
              numero: 1,
              textoCompleto: `${sinCuit(LOS_CALVOS_TEXT)}\nDISTRIBUCION ERRECALDE`,
              textoEncabezado: sinCuit(LOS_CALVOS_ENCABEZADO_OCR),
              textoArticulos: `DISTRIBUCION ERRECALDE 1,000 10.000,00\n${LOS_CALVOS_ARTICULOS_OCR}`,
              textoResumen: LOS_CALVOS_RESUMEN_OCR,
              confianza: 0.85,
            },
          ],
        }),
      }),
      { params: Promise.resolve({ id: datos.id }) },
    );

    const documento = await prisma.document.findUniqueOrThrow({
      where: { id: datos.id },
      select: { supplier: { select: { tradeName: true } } },
    });

    /* O es Los Calvos, o no es nadie. Lo único inaceptable es que sea Errecalde. */
    expect(documento.supplier?.tradeName ?? '').not.toContain('Errecalde');
  });

  it('el proveedor sembrado que aporta la marca existe, así que el riesgo es real', async () => {
    /*
     * Sin esto, la prueba de arriba podría pasar porque «Errecalde» no está en
     * la base: no probaría nada. Acá se fija que sí está y que es otro.
     */
    const errecalde = await prisma.supplier.findFirst({
      where: { tradeName: { contains: 'Errecalde' } },
      select: { id: true, tradeName: true },
    });
    expect(errecalde).not.toBeNull();

    const losCalvos = await prisma.supplier.findFirstOrThrow({
      where: { tradeName: 'Los Calvos' },
      select: { id: true },
    });
    expect(errecalde!.id).not.toBe(losCalvos.id);
  });
});
