import { describe, expect, it } from 'vitest';
import {
  cuitValido,
  leerEmisorDeEvidencia,
} from '@/lib/ocr/motor/emisor';
import { interpretarReconstruccion } from '@/lib/ocr/motor/desde-reconstruccion';
import { evidencia, fila, palabra, tablaBase } from '../fixtures/evidencia-sintetica';

const EMISOR = '30-71406744-9';
const OTRO = '30-71780890-4';
const OTRA_REPARACION = '30-71406775-9';
const RECEPTOR = '27-33342291-9';

function comprobante(fragmentos: ReturnType<typeof palabra>[] = []) {
  return evidencia([
    palabra('PAMPATEX S.A.', 0.05, 0.05),
    ...fragmentos,
    ...tablaBase(),
  ]);
}

describe('identificación general del emisor', () => {
  it('valida el dígito verificador del CUIT', () => {
    expect(cuitValido(EMISOR)).toBe(true);
    expect(cuitValido('30-71406744-8')).toBe(false);
  });

  it.each([EMISOR, EMISOR.replace(/\D/g, '')])(
    'acepta un CUIT exacto con o sin separadores: %s',
    (cuit) => {
      const leido = leerEmisorDeEvidencia(
        comprobante([palabra(`CUIT ${cuit}`, 0.05, 0.10)]),
        RECEPTOR,
      );
      expect(leido.cuit).toBe(EMISOR);
      expect(leido.estadoCuit).toBe('EXACT_VALID_TAX_ID');
    },
  );

  it('recompone un CUIT partido entre cajas vecinas de una misma pasada', () => {
    const leido = leerEmisorDeEvidencia(
      comprobante([
        ...fila(0.10, [
          ['CUIT', 0.05],
          ['30', 0.18],
          ['71406744', 0.22],
          ['9', 0.32],
        ]),
      ]),
      RECEPTOR,
    );
    expect(leido.cuit).toBe(EMISOR);
    expect(leido.estadoCuit).toBe('RECONSTRUCTED_VALID_TAX_ID');
    expect(leido.candidatosCuit?.[0].procedencias).toHaveLength(3);
  });

  it('corrige un dígito sólo cuando la alternativa real del OCR da un CUIT válido único', () => {
    const leido = leerEmisorDeEvidencia(
      comprobante([
        palabra('CUIT', 0.05, 0.10),
        palabra('30-71406745-9', 0.18, 0.10, { alternativas: [EMISOR] }),
      ]),
      RECEPTOR,
    );
    expect(leido.cuit).toBe(EMISOR);
    expect(leido.estadoCuit).toBe('OCR_ALTERNATIVE_VALID_TAX_ID');
    expect(leido.candidatosCuit?.[0].procedencias[0].alternativaDelOcr).toBe(true);
    expect(leido.candidatosCuit?.[0].procedencias[0].alternativas).toEqual([EMISOR]);
  });

  it('dos reparaciones válidas del OCR quedan ambiguas', () => {
    const leido = leerEmisorDeEvidencia(
      comprobante([
        palabra('CUIT', 0.05, 0.10),
        palabra('30-71406745-9', 0.18, 0.10, {
          alternativas: [EMISOR, OTRA_REPARACION],
        }),
      ]),
      RECEPTOR,
    );
    expect(leido.cuit).toBeNull();
    expect(leido.estadoCuit).toBe('AMBIGUOUS_TAX_ID');
    expect(leido.candidatosCuit?.map((c) => c.cuit)).toEqual(
      [EMISOR, OTRA_REPARACION].sort(),
    );
  });

  it('una alternativa válida pero ajena no reemplaza el CUIT leído', () => {
    const leido = leerEmisorDeEvidencia(
      comprobante([
        palabra('CUIT', 0.05, 0.10),
        palabra('30-71406745-9', 0.18, 0.10, { alternativas: [OTRO] }),
      ]),
      RECEPTOR,
    );
    expect(leido.cuit).toBeNull();
    expect(leido.estadoCuit).toBe('MISSING_TAX_ID');
  });

  it('un CUIT con dígito verificador inválido no identifica a nadie', () => {
    const leido = leerEmisorDeEvidencia(
      comprobante([palabra('CUIT 30-71406744-8', 0.05, 0.10)]),
      RECEPTOR,
    );
    expect(leido.cuit).toBeNull();
    expect(leido.estadoCuit).toBe('MISSING_TAX_ID');
  });

  it('excluye al receptor aunque esté en el encabezado', () => {
    const leido = leerEmisorDeEvidencia(
      comprobante([
        palabra(`CUIT ${EMISOR}`, 0.05, 0.10),
        palabra(`Cliente CUIT ${RECEPTOR}`, 0.55, 0.10),
      ]),
      RECEPTOR,
    );
    expect(leido.cuit).toBe(EMISOR);
    expect(leido.candidatosCuit?.map((c) => c.cuit)).not.toContain(RECEPTOR);
  });

  it('un CUIT situado debajo de los títulos no entra en la zona del emisor', () => {
    const sinEmisor = evidencia([
      palabra('PAMPATEX S.A.', 0.05, 0.05),
      ...tablaBase(),
      palabra(`Cliente CUIT ${RECEPTOR}`, 0.20, 0.38),
    ]);
    const leido = leerEmisorDeEvidencia(sinEmisor);
    expect(leido.cuit).toBeNull();
    expect(leido.estadoCuit).toBe('MISSING_TAX_ID');
  });

  it('una marca dentro de un artículo no cambia el emisor', () => {
    const leido = leerEmisorDeEvidencia(
      evidencia([
        palabra('PAMPATEX S.A.', 0.05, 0.05),
        palabra(`CUIT ${EMISOR}`, 0.05, 0.10),
        ...tablaBase(),
        palabra('LOS CALVOS S.R.L.', 0.20, 0.34),
        palabra(`CUIT ${OTRO}`, 0.20, 0.36),
      ]),
      RECEPTOR,
    );
    expect(leido.cuit).toBe(EMISOR);
    expect(leido.razonSocial).toBe('PAMPATEX S.A.');
  });

  it('razón social y CUIT se apoyan dentro de la misma zona del encabezado', () => {
    const leido = leerEmisorDeEvidencia(
      comprobante([palabra(`CUIT ${EMISOR}`, 0.05, 0.10)]),
      RECEPTOR,
    );
    expect(leido).toMatchObject({
      cuit: EMISOR,
      razonSocial: 'PAMPATEX S.A.',
      estadoCuit: 'EXACT_VALID_TAX_ID',
    });
  });

  it('una razón social sin CUIT no alcanza para resolver al proveedor', () => {
    const leido = leerEmisorDeEvidencia(comprobante(), RECEPTOR);
    expect(leido.razonSocial).toBe('PAMPATEX S.A.');
    expect(leido.cuit).toBeNull();
    expect(leido.estadoCuit).toBe('MISSING_TAX_ID');
  });

  it('un emisor no resuelto queda como bloqueo explícito del comprobante', () => {
    const informe = interpretarReconstruccion(comprobante(), { cuitDelReceptor: RECEPTOR });
    const bloqueo = informe.pendientes.find((p) => p.id === 'emisor:cuit');
    expect(bloqueo).toMatchObject({
      categoria: 'BLOCKING_MISSING_CELL',
      renglon: null,
      campo: 'cuitEmisor',
      elegido: null,
    });
    expect(informe.veredicto.decision).not.toBe('automatica');
  });

  it.each(['CAE', 'Ingresos Brutos', 'Teléfono', 'Factura Nro.'])(
    '%s no compite como CUIT aunque contenga once dígitos válidos',
    (etiqueta) => {
      const leido = leerEmisorDeEvidencia(
        comprobante([palabra(`${etiqueta} ${EMISOR.replace(/\D/g, '')}`, 0.05, 0.10)]),
        RECEPTOR,
      );
      expect(leido.cuit).toBeNull();
      expect(leido.estadoCuit).toBe('MISSING_TAX_ID');
    },
  );

  it('el orden de las pasadas no cambia el resultado', () => {
    const primera = palabra(`CUIT ${EMISOR}`, 0.05, 0.10, {
      pasada: 'completo:directo',
      confianza: 0.82,
    });
    const segunda = palabra(`CUIT ${EMISOR}`, 0.05, 0.10, {
      pasada: 'encabezado:ampliado',
      confianza: 0.96,
    });
    const resto = [palabra('PAMPATEX S.A.', 0.05, 0.05), ...tablaBase()];
    const a = leerEmisorDeEvidencia(evidencia([primera, segunda, ...resto]), RECEPTOR);
    const b = leerEmisorDeEvidencia(evidencia([segunda, primera, ...resto]), RECEPTOR);
    expect(a).toEqual(b);
  });

  it('sin nombre ni CUIT del emisor queda sin resolver aunque la tabla nombre otra empresa', () => {
    const leido = leerEmisorDeEvidencia(
      evidencia([
        palabra('FACTURA', 0.05, 0.05),
        ...tablaBase(),
        palabra('MABELHERDI S.A.', 0.20, 0.34),
        palabra(`CUIT ${OTRO}`, 0.20, 0.36),
      ]),
      RECEPTOR,
    );
    expect(leido).toMatchObject({
      cuit: null,
      razonSocial: null,
      estadoCuit: 'MISSING_TAX_ID',
    });
  });

  it('el inicio probado del detalle limita la zona aunque sus títulos sean ilegibles', () => {
    const prueba = evidencia([
      palabra('FACTURA', 0.05, 0.05),
      palabra('C0D', 0.05, 0.28),
      palabra('D3T4LL3', 0.20, 0.28),
      palabra('MABELHERDI S.A.', 0.20, 0.30),
      palabra(`CUIT ${OTRO}`, 0.20, 0.30),
    ]);
    const leido = leerEmisorDeEvidencia(prueba, RECEPTOR, undefined, 0.30);
    expect(leido.cuit).toBeNull();
    expect(leido.razonSocial).toBeNull();
  });

  it('resuelve un proveedor nuevo sin consultar un padrón de proveedores', () => {
    const nuevo = leerEmisorDeEvidencia(
      evidencia([
        palabra('EMPRESA NUEVA S.R.L.', 0.05, 0.05),
        palabra(`CUIT ${EMISOR}`, 0.05, 0.10),
        ...tablaBase(),
      ]),
      RECEPTOR,
    );
    expect(nuevo.cuit).toBe(EMISOR);
    expect(nuevo.razonSocial).toBe('EMPRESA NUEVA S.R.L.');
  });
});
