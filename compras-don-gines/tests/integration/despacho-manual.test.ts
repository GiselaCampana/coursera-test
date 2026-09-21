import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { prisma } from '@/lib/db';
import { limpiarBase, sembrarEscenario, type Escenario } from './ayudas';
import {
  sembrarLaCompraDeEzra,
  facturaDeEzra,
  CATALOGO_DE_EZRA,
} from '../fixtures/compra-de-ezra';
import { EZRA_PIE } from '../fixtures/ezra';
import { aplicarCompra, vistaPreviaDeCompra } from '@/lib/services/vista-previa-compra';
import { despacharComprobante, vistaDelDespacho } from '@/lib/services/stock-despacho-manual';
import { movimientosDe } from '@/lib/services/stock-ingreso';
import { AUDIT_ACTIONS } from '@/lib/services/audit';
import { ForbiddenError } from '@/lib/errors';
import { Decimal } from '@/lib/money';

/**
 * **El despacho a mano de un comprobante, contra un receptor HTTP de verdad.**
 *
 * Las otras pruebas de la integración usan un transporte de mentira, que sirve
 * para fijar las reglas de la bandeja sin abrir un socket. Ésta usa el
 * transporte HTTP real contra un servidor local que **registra el cuerpo que
 * recibe**, porque lo que hay que comprobar acá es otra cosa: que lo que sale
 * por el cable sea exactamente lo acordado, y que salga sólo cuando alguien con
 * permiso lo pide para un comprobante.
 *
 * El servidor escucha en 127.0.0.1 y no sabe hablar con nadie más. No hay
 * ninguna dirección publicada en este archivo, ni ninguna clave real: la que se
 * usa es inventada y vive sólo en `process.env` mientras corre la prueba.
 */

const PUERTO = 3133;
const DESTINO = `http://127.0.0.1:${PUERTO}/api/integrations/purchases`;
const CLAVE = 'clave-de-prueba-del-despacho-manual';

let escenario: Escenario;
let completa: string;
let otra: string;
let servidor: Server;

/** Lo que el receptor recibió, tal cual. */
interface PedidoRecibido {
  autorizacion: string | undefined;
  url: string;
  cuerpo: Record<string, unknown>;
}
let recibidos: PedidoRecibido[] = [];

/** Cómo contesta el receptor en la prueba que está corriendo. */
type Comportamiento =
  | { tipo: 'APLICA' }
  | { tipo: 'YA_APLICADO' }
  | { tipo: 'CODIGO'; codigo: number }
  | { tipo: 'CUERPO_RARO' }
  | { tipo: 'NO_CONTESTA' };
let comportamiento: Comportamiento = { tipo: 'APLICA' };

const PAGO = { forma: 'TRANSFERENCIA', condicion: { tipo: 'DIAS' as const, dias: 30 } };

/** Los cinco de mercadería de Ezra, con la cantidad del contrato. */
const ESPERADOS = [
  { codigo: '47', quantity: '4.240' },
  { codigo: '49', quantity: '3.985' },
  { codigo: '48', quantity: '7.345' },
  { codigo: '10', quantity: '4.040' },
  { codigo: '2514', quantity: '7.665' },
].map((r) => ({ ...r, plu: CATALOGO_DE_EZRA[r.codigo].plu }));

beforeAll(async () => {
  servidor = createServer((pedido, respuesta) => {
    let crudo = '';
    pedido.on('data', (trozo) => (crudo += trozo));
    pedido.on('end', () => {
      recibidos.push({
        autorizacion: pedido.headers.authorization,
        url: pedido.url ?? '',
        cuerpo: JSON.parse(crudo || '{}'),
      });

      if (comportamiento.tipo === 'NO_CONTESTA') return; // se cuelga a propósito

      if (comportamiento.tipo === 'CODIGO') {
        respuesta.writeHead(comportamiento.codigo, { 'content-type': 'application/json' });
        respuesta.end(JSON.stringify({ ok: false }));
        return;
      }

      if (comportamiento.tipo === 'CUERPO_RARO') {
        /* 200, pero no es este contrato. No puede leerse como un éxito. */
        respuesta.writeHead(200, { 'content-type': 'application/json' });
        respuesta.end(JSON.stringify({ ok: true, mensaje: 'listo' }));
        return;
      }

      const estado = comportamiento.tipo === 'YA_APLICADO' ? 'ALREADY_APPLIED' : 'APPLIED';
      const cuerpo = recibidos[recibidos.length - 1]!.cuerpo as {
        movements: { idempotencyKey: string }[];
      };
      respuesta.writeHead(estado === 'APPLIED' ? 201 : 200, {
        'content-type': 'application/json',
      });
      respuesta.end(
        JSON.stringify({
          contractVersion: 1,
          status: estado,
          movements: cuerpo.movements.map((m, i) => ({
            idempotencyKey: m.idempotencyKey,
            status: estado,
            movementId: `mov-${i + 1}`,
          })),
        }),
      );
    });
  });
  await new Promise<void>((listo) => servidor.listen(PUERTO, '127.0.0.1', listo));
});

afterAll(async () => {
  await new Promise<void>((listo) => servidor.close(() => listo()));
});

const original = { ...process.env };

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();
  const sembrada = await sembrarLaCompraDeEzra(prisma, {
    sucursalId: escenario.sucursales.devoto,
    autorId: escenario.admin.id,
  });
  completa = sembrada.completa;

  /* Una segunda compra, para comprobar que NO se va junto con la primera. */
  otra = await facturaDeEzra(prisma, {
    sucursalId: escenario.sucursales.pueyrredon,
    autorId: escenario.admin.id,
    proveedorId: sembrada.proveedorId,
    numero: '00000190',
    totalImpreso: EZRA_PIE.total,
    bolsaSinCodigo: false,
  });

  recibidos = [];
  comportamiento = { tipo: 'APLICA' };
  process.env.STOCK_INTEGRATION_WRITE_URL = DESTINO;
  process.env.STOCK_INTEGRATION_KEY = CLAVE;
});

afterEach(() => {
  process.env = { ...original };
});

async function aplicar(documentId: string) {
  return aplicarCompra(escenario.admin, documentId, PAGO);
}

/* ========================================================================== */

describe('sin configuración no se abre ningún socket', () => {
  it('sin la URL no sale ningún pedido, y lo dice por el nombre de la variable', async () => {
    delete process.env.STOCK_INTEGRATION_WRITE_URL;
    await aplicar(completa);

    const resultado = await despacharComprobante(escenario.admin, completa);

    expect(recibidos).toHaveLength(0);
    expect(resultado.faltaConfigurar).toEqual(['STOCK_INTEGRATION_WRITE_URL']);
    expect(resultado.mensaje).toContain('STOCK_INTEGRATION_WRITE_URL');
    /* El nombre sí; el valor no tiene por qué estar en ningún lado. */
    expect(resultado.mensaje).not.toContain(CLAVE);
    expect(resultado.estado).toBe('PENDIENTE');
  });

  it('sin la clave tampoco', async () => {
    delete process.env.STOCK_INTEGRATION_KEY;
    await aplicar(completa);

    const resultado = await despacharComprobante(escenario.admin, completa);

    expect(recibidos).toHaveLength(0);
    expect(resultado.faltaConfigurar).toEqual(['STOCK_INTEGRATION_KEY']);
    expect(resultado.estado).toBe('PENDIENTE');
    /*
     * Y el motivo que queda guardado dice que falta configurar, no otra cosa.
     * Sin esto la prueba pasaría igual con un transporte que intenta salir y
     * falla por cualquier motivo: «no se abrió un socket» y «se abrió y salió
     * mal» se ven igual desde afuera si sólo se mira que no llegó nada.
     */
    const despues = await movimientosDe(completa);
    expect(despues[0]!.lastError).toContain('STOCK_INTEGRATION_KEY');
  });

  it('sin ninguna de las dos, nombra las dos', async () => {
    delete process.env.STOCK_INTEGRATION_WRITE_URL;
    delete process.env.STOCK_INTEGRATION_KEY;
    await aplicar(completa);

    const resultado = await despacharComprobante(escenario.admin, completa);

    expect(recibidos).toHaveLength(0);
    expect(resultado.faltaConfigurar).toEqual([
      'STOCK_INTEGRATION_WRITE_URL',
      'STOCK_INTEGRATION_KEY',
    ]);
  });
});

describe('quién puede despachar', () => {
  it('un operador no puede, aunque llame directo al servicio', async () => {
    /*
     * Lo que se prueba no es que el botón esté escondido —eso es comodidad, no
     * defensa— sino que llamar directamente a la acción del servidor tampoco
     * alcance. Es el camino que usaría cualquiera que mire la red.
     */
    await aplicar(completa);

    await expect(despacharComprobante(escenario.operadorDevoto, completa)).rejects.toThrow(
      ForbiddenError,
    );
    expect(recibidos).toHaveLength(0);
  });

  it('y la pantalla tampoco se lo ofrece', async () => {
    await aplicar(completa);
    const vista = await vistaDelDespacho(escenario.operadorDevoto, completa);
    expect(vista.puedeDespachar).toBe(false);
  });

  it('el administrador sí', async () => {
    await aplicar(completa);
    const vista = await vistaDelDespacho(escenario.admin, completa);
    expect(vista.puedeDespachar).toBe(true);
  });
});

describe('se manda un comprobante, y sólo ése', () => {
  it('los cinco movimientos de Ezra, con la sucursal, los PLU y las cantidades del contrato', async () => {
    await aplicar(completa);

    const resultado = await despacharComprobante(escenario.admin, completa);

    expect(recibidos).toHaveLength(1);
    const lote = recibidos[0]!.cuerpo as {
      contractVersion: number;
      branchCode: string;
      purchaseId: string;
      movements: { plu: string; quantity: string; unit: string; direction: string; reason: string }[];
    };

    expect(lote.contractVersion).toBe(1);
    expect(lote.branchCode).toBe('devoto');
    expect(lote.purchaseId).toBe(completa);
    expect(lote.movements).toHaveLength(5);

    for (const esperado of ESPERADOS) {
      const suyo = lote.movements.filter((m) => m.plu === esperado.plu);
      expect(suyo, `PLU ${esperado.plu}`).toHaveLength(1);
      /* La cadena exacta, no el número: «4.24» y «4.240» no son lo mismo acá. */
      expect(suyo[0]!.quantity).toBe(esperado.quantity);
      expect(suyo[0]!.unit).toBe('KG');
      expect(suyo[0]!.direction).toBe('IN');
      expect(suyo[0]!.reason).toBe('PURCHASE');
    }

    expect(resultado.estado).toBe('COMPLETADA');
    expect(resultado.ok).toBe(true);
  });

  it('la bolsa no viaja', async () => {
    /*
     * Es un gasto, no mercadería: no hay existencias que mover. Queda afuera
     * por estar clasificada como gasto, no por cómo se llama.
     */
    await aplicar(completa);
    await despacharComprobante(escenario.admin, completa);

    const lote = recibidos[0]!.cuerpo as { movements: { plu: string }[] };
    const bolsa = CATALOGO_DE_EZRA['4249'];
    expect(lote.movements).toHaveLength(5);
    if (bolsa) {
      expect(lote.movements.some((m) => m.plu === bolsa.plu)).toBe(false);
    }
    const crudo = JSON.stringify(lote);
    expect(crudo).not.toContain('BOLSA');
  });

  it('el otro comprobante pendiente se queda donde está', async () => {
    await aplicar(completa);
    await aplicar(otra);

    await despacharComprobante(escenario.admin, completa);

    expect(recibidos).toHaveLength(1);
    expect((recibidos[0]!.cuerpo as { purchaseId: string }).purchaseId).toBe(completa);

    const delOtro = await movimientosDe(otra);
    expect(delOtro).toHaveLength(5);
    expect(delOtro.every((m) => m.status === 'PENDIENTE')).toBe(true);
  });

  it('el secreto viaja en el encabezado y en ningún otro lado', async () => {
    await aplicar(completa);
    await despacharComprobante(escenario.admin, completa);

    expect(recibidos[0]!.autorizacion).toBe(`Bearer ${CLAVE}`);
    expect(recibidos[0]!.url).not.toContain(CLAVE);
    expect(JSON.stringify(recibidos[0]!.cuerpo)).not.toContain(CLAVE);
  });
});

describe('reintentos: ni se pierde ni se duplica', () => {
  it('dos clics a la vez mandan un solo pedido, y ninguna duplicación', async () => {
    /*
     * El envío normal no toca los que ya están EN_PROCESO, así que el segundo
     * clic no encuentra nada que reclamar: el primero ya las pasó. Sale un solo
     * pedido, y los cinco movimientos quedan confirmados una vez cada uno.
     */
    await aplicar(completa);

    await Promise.all([
      despacharComprobante(escenario.admin, completa),
      despacharComprobante(escenario.admin, completa),
    ]);

    expect(recibidos).toHaveLength(1);
    const despues = await movimientosDe(completa);
    expect(despues).toHaveLength(5);
    expect(despues.filter((m) => m.status === 'COMPLETADO')).toHaveLength(5);
    /* Una fila por renglón: la unicidad de la base lo sostiene, no el código. */
    expect(new Set(despues.map((m) => m.eventKey)).size).toBe(5);
  });

  it('el reintento de los inciertos es una decisión aparte', async () => {
    /*
     * Un movimiento que salió y no volvió respuesta no se reenvía por el camino
     * normal: puede haber llegado, y volver a mandarlo es otra decisión. Sin
     * pedirlo, el botón de siempre no lo toca.
     */
    /*
     * El estado incierto lo produce una respuesta que no se entiende, no un
     * timeout: un timeout es recuperable y vuelve solo a PENDIENTE. Acá el
     * pedido llegó y contestó algo que no es este contrato, así que no se sabe
     * si aplicó.
     */
    comportamiento = { tipo: 'CUERPO_RARO' };
    await aplicar(completa);
    await despacharComprobante(escenario.admin, completa);
    expect(recibidos).toHaveLength(1);
    expect((await movimientosDe(completa)).every((m) => m.status === 'EN_PROCESO')).toBe(true);

    comportamiento = { tipo: 'YA_APLICADO' };
    /* El envío normal no los vuelve a mandar. */
    await despacharComprobante(escenario.admin, completa);
    expect(recibidos).toHaveLength(1);

    /* Pedirlo explícitamente sí, y con la misma clave. */
    const resultado = await despacharComprobante(escenario.admin, completa, {
      incluirInciertas: true,
    });
    expect(recibidos).toHaveLength(2);
    expect(resultado.estado).toBe('COMPLETADA');
  }, 30_000);

  it('volver a apretar después de APPLIED no manda nada de nuevo', async () => {
    await aplicar(completa);
    await despacharComprobante(escenario.admin, completa);
    expect(recibidos).toHaveLength(1);

    const segundo = await despacharComprobante(escenario.admin, completa);

    expect(recibidos).toHaveLength(1);
    expect(segundo.estado).toBe('COMPLETADA');
    expect(segundo.mensaje).toContain('ya confirmó');
  });

  it('ALREADY_APPLIED cuenta como conciliado', async () => {
    /*
     * Es el caso del reintento después de una respuesta perdida: del otro lado
     * ya está. Tratarlo como un fracaso dejaría la compra eternamente «a medio
     * camino» por algo que en realidad terminó bien.
     */
    comportamiento = { tipo: 'YA_APLICADO' };
    await aplicar(completa);

    const resultado = await despacharComprobante(escenario.admin, completa);

    expect(resultado.estado).toBe('COMPLETADA');
    expect(resultado.ok).toBe(true);
  });

  it('un timeout conserva el movimiento, con la misma clave y el mismo cuerpo', async () => {
    comportamiento = { tipo: 'NO_CONTESTA' };
    await aplicar(completa);
    const antes = await movimientosDe(completa);

    const resultado = await despacharComprobante(escenario.admin, completa);

    expect(resultado.estado).not.toBe('COMPLETADA');
    const despues = await movimientosDe(completa);
    expect(despues.every((m) => m.status !== 'COMPLETADO')).toBe(true);
    /* La clave no cambia: es lo único que impide que entre dos veces. */
    expect(despues.map((m) => m.eventKey).sort()).toEqual(antes.map((m) => m.eventKey).sort());

    /* Y el reintento manda exactamente lo mismo. */
    comportamiento = { tipo: 'APLICA' };
    await despacharComprobante(escenario.admin, completa, { incluirInciertas: true });
    expect(recibidos).toHaveLength(2);
    /*
     * Los mismos movimientos, comparados por clave y no por posición: el orden
     * dentro del lote no es parte del contrato ni es estable —las cinco filas
     * comparten el `createdAt` al milisegundo— y compararlo haría fallar un
     * reintento que manda exactamente lo mismo.
     */
    const porClave = (m: { idempotencyKey: string }[]) =>
      JSON.stringify([...m].sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey)));
    const primero = recibidos[0]!.cuerpo as { movements: { idempotencyKey: string }[] };
    const segundo = recibidos[1]!.cuerpo as { movements: { idempotencyKey: string }[] };
    expect(porClave(segundo.movements)).toBe(porClave(primero.movements));
  }, 30_000);

  for (const codigo of [429, 500, 503]) {
    it(`${codigo} deja el movimiento listo para reintentar`, async () => {
      comportamiento = { tipo: 'CODIGO', codigo };
      await aplicar(completa);

      const resultado = await despacharComprobante(escenario.admin, completa);

      expect(resultado.estado).toBe('PENDIENTE');
      const despues = await movimientosDe(completa);
      expect(despues.every((m) => m.status === 'PENDIENTE')).toBe(true);
      expect(despues.every((m) => m.reintentable)).toBe(true);
    });
  }
});

describe('los errores se ven con su nombre, y no como éxito', () => {
  for (const [codigo, esperado] of [
    [401, /credencial/i],
    [403, /credencial/i],
    [409, /idempotencia|conflicto/i],
    [422, /contenido/i],
  ] as const) {
    it(`${codigo} queda visible y clasificado`, async () => {
      comportamiento = { tipo: 'CODIGO', codigo };
      await aplicar(completa);

      const resultado = await despacharComprobante(escenario.admin, completa);

      expect(resultado.estado).toBe('FALLIDA');
      expect(resultado.ok).toBe(false);
      const despues = await movimientosDe(completa);
      expect(despues.every((m) => m.status === 'FALLIDO')).toBe(true);
      expect(despues[0]!.lastError).toMatch(esperado);
      /* Y nunca el secreto en el motivo que queda guardado. */
      expect(despues[0]!.lastError).not.toContain(CLAVE);
    });
  }

  it('una respuesta que no es este contrato nunca se toma por éxito', async () => {
    comportamiento = { tipo: 'CUERPO_RARO' };
    await aplicar(completa);

    const resultado = await despacharComprobante(escenario.admin, completa);

    expect(resultado.estado).not.toBe('COMPLETADA');
    const despues = await movimientosDe(completa);
    expect(despues.every((m) => m.status !== 'COMPLETADO')).toBe(true);
  });
});

describe('queda registrado', () => {
  it('con usuario, comprobante, momento y resultado', async () => {
    await aplicar(completa);
    await despacharComprobante(escenario.admin, completa);

    const registro = await prisma.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.STOCK_DESPACHADO, entityId: completa },
    });

    expect(registro).not.toBeNull();
    expect(registro!.userId).toBe(escenario.admin.id);
    expect(registro!.entity).toBe('Document');
    expect(registro!.createdAt).toBeInstanceOf(Date);

    const despues = registro!.after as { estado: string; movimientos: { status: string }[] };
    expect(despues.estado).toBe('COMPLETADA');
    expect(despues.movimientos).toHaveLength(5);
    /* Ni la clave ni el encabezado entran en la auditoría. */
    expect(JSON.stringify(registro)).not.toContain(CLAVE);
  });

  it('un intento rechazado por permisos no escribe nada', async () => {
    await aplicar(completa);
    await despacharComprobante(escenario.operadorDevoto, completa).catch(() => null);

    expect(
      await prisma.auditLog.count({ where: { action: AUDIT_ACTIONS.STOCK_DESPACHADO } }),
    ).toBe(0);
  });
});

describe('la vista previa sigue sin escribir ni despachar', () => {
  it('mirarla no anota, no manda y no mueve nada', async () => {
    const antes = await prisma.stockOutbox.count();

    await vistaPreviaDeCompra(escenario.admin, completa);
    await vistaPreviaDeCompra(escenario.admin, completa);

    expect(await prisma.stockOutbox.count()).toBe(antes);
    expect(recibidos).toHaveLength(0);
  });

  it('mirar el despacho tampoco manda nada', async () => {
    await aplicar(completa);

    await vistaDelDespacho(escenario.admin, completa);
    await vistaDelDespacho(escenario.admin, completa);

    expect(recibidos).toHaveLength(0);
    const movimientos = await movimientosDe(completa);
    expect(movimientos.every((m) => m.status === 'PENDIENTE')).toBe(true);
    expect(movimientos.every((m) => m.attempts === 0)).toBe(true);
  });
});

describe('lo que el despacho no toca', () => {
  it('ni el pago, ni el costo, ni el estado del comprobante', async () => {
    await aplicar(completa);

    const antes = await prisma.document.findUniqueOrThrow({
      where: { id: completa },
      include: { paymentSchedule: true },
    });
    const costosAntes = await prisma.costHistory.count({ where: { documentId: completa } });
    const movimientosDeCompra = await prisma.purchaseMovement.count({
      where: { documentId: completa },
    });

    await despacharComprobante(escenario.admin, completa);

    const despues = await prisma.document.findUniqueOrThrow({
      where: { id: completa },
      include: { paymentSchedule: true },
    });

    expect(despues.status).toBe(antes.status);
    expect(despues.total?.toString()).toBe(antes.total?.toString());
    expect(despues.paymentSchedule?.dueDate).toEqual(antes.paymentSchedule?.dueDate);
    expect(despues.paymentSchedule?.status).toBe(antes.paymentSchedule?.status);
    expect(
      new Decimal(despues.paymentSchedule!.plannedAmount.toString()).equals(
        new Decimal(antes.paymentSchedule!.plannedAmount.toString()),
      ),
    ).toBe(true);
    expect(await prisma.costHistory.count({ where: { documentId: completa } })).toBe(costosAntes);
    expect(await prisma.purchaseMovement.count({ where: { documentId: completa } })).toBe(
      movimientosDeCompra,
    );
  });
});
