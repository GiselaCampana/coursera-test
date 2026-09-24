import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/lib/db';
import { limpiarBase, sembrarEscenario, type Escenario } from './ayudas';
import { ADMIN_PERMISSIONS } from '@/lib/auth/permissions';

/**
 * **Las garantías del Stock ERP, comprobadas contra la base y no contra el
 * código.**
 *
 * Todo lo que se prueba acá se ejerce con SQL directo, salteando la aplicación
 * a propósito. Una restricción que sólo vive en TypeScript protege a quien usa
 * la aplicación; no protege del script de corrección que alguien corre a las
 * once de la noche, ni de la consola de la base, ni del servicio que todavía no
 * está escrito. Lo que se afirma acá es que **PostgreSQL se niega**.
 *
 * El caso que da sentido a todo esto es el decimal: `NUMERIC(14,3)` parece
 * suficiente y no lo es, porque PostgreSQL redondea `4.2401` a `4.240` **antes**
 * de correr el CHECK, así que la restricción nunca ve el valor que hay que
 * rechazar. Por eso las columnas no declaran escala.
 */

let escenario: Escenario;
let productoId: string;
let otroProductoId: string;
let sucursalId: string;
let otraSucursalId: string;

beforeEach(async () => {
  await limpiarBase();
  escenario = await sembrarEscenario();
  productoId = Object.values(escenario.productos)[0]!;
  otroProductoId = Object.values(escenario.productos)[1]!;
  sucursalId = escenario.sucursales.devoto;
  otraSucursalId = escenario.sucursales.pueyrredon;
  await aperturaDeLasDosSucursales();
});

/**
 * Las dos sucursales, con una apertura confirmada y un corte viejo.
 *
 * HALLAZGO de la fase 4. Este archivo inserta `PURCHASE_IN` a mano para
 * comprobar CHECK de la base —cantidad negativa, dirección equivocada,
 * reversión incoherente— y la fase 4 agregó un disparador que rechaza un
 * ingreso de compra en una sucursal sin apertura confirmada. Con eso, esos
 * insertos empezaron a fallar por el motivo nuevo y ya no podían llegar hasta
 * la restricción que estaban probando.
 *
 * No se tocó ninguna afirmación: se le da a las sucursales el estado que ahora
 * hace falta para que una compra sea admisible, que es exactamente el que van a
 * tener en la vida real. Una sucursal sin apertura no recibe mercadería, y eso
 * es una garantía nueva, no un obstáculo de las pruebas.
 *
 * El corte va muy antes de la fecha efectiva que usa `movimiento()`: lo que se
 * prueba acá no es el corte.
 */
async function aperturaDeLasDosSucursales() {
  for (const branchId of [escenario.sucursales.devoto, escenario.sucursales.pueyrredon]) {
    const opId = `apertura-${branchId}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "stock_operation" ("id","operationKey","kind","contentHash","branchId","requestedById")
       VALUES ($1,$2,'ACTIVACION'::"StockOperationKind",$3,$4,$5)`,
      opId,
      `clave-${opId}`,
      `huella-${opId}`,
      branchId,
      escenario.admin.id,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "stock_count_session"
         ("id","branchId","name","status","cutoffAt","ficticia","confirmedById","confirmedAt","operationId","createdAt")
       VALUES ($1,$2,'Apertura de prueba','CONFIRMADA'::"StockCountSessionStatus",
               '2026-01-01T03:00:00Z', true, $3, now(), $4, now())`,
      `sesion-${branchId}`,
      branchId,
      escenario.admin.id,
      opId,
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Ayudas: SQL crudo, sin pasar por ningún servicio                           */
/* -------------------------------------------------------------------------- */

let contador = 0;
const proximo = () => `f1-${Date.now()}-${(contador += 1)}`;

async function crearOperacion(kind = 'ACTIVACION'): Promise<string> {
  const id = proximo();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "stock_operation" ("id","operationKey","kind","contentHash","branchId","requestedById")
     VALUES ($1,$2,$3::"StockOperationKind",$4,$5,$6)`,
    id,
    `clave-${id}`,
    kind,
    `huella-${id}`,
    sucursalId,
    escenario.admin.id,
  );
  return id;
}

/** Inserta un movimiento con SQL directo. Devuelve su id. */
async function movimiento(datos: {
  operationId: string;
  tipo?: string;
  direccion?: string;
  cantidad: string;
  saldo?: string;
  productoId?: string;
  sucursalId?: string;
  unidad?: string;
  reversesId?: string | null;
  motivo?: string | null;
  transferLineId?: string | null;
}): Promise<string> {
  const id = proximo();
  await prisma.$executeRawUnsafe(
    `INSERT INTO "stock_ledger"
       ("id","txId","productId","pluHistorico","branchId","type","direction",
        "quantity","unit","effectiveAt","operationId","idempotencyKey",
        "balanceAfterSeq","reversesId","reason","transferLineId")
     VALUES ($1, txid_current(), $2, 'PLU-1', $3, $4::"StockMovementType",
             $5::"StockDirection", $6::numeric, $7::"StockUnit",
             '2026-09-21T12:00:00Z', $8, $9, $10::numeric, $11, $12, $13)`,
    id,
    datos.productoId ?? productoId,
    datos.sucursalId ?? sucursalId,
    datos.tipo ?? 'OPENING_BALANCE',
    datos.direccion ?? 'IN',
    datos.cantidad,
    datos.unidad ?? 'KG',
    datos.operationId,
    `idem-${id}`,
    datos.saldo ?? datos.cantidad,
    datos.reversesId ?? null,
    datos.motivo ?? null,
    datos.transferLineId ?? null,
  );
  return id;
}

/* -------------------------------------------------------------------------- */

describe('la precisión decimal la garantiza la base', () => {
  it('rechaza 4.2401 insertado por SQL directo', async () => {
    /*
     * El caso que motivó no declarar escala en la columna. Con
     * `NUMERIC(14,3)` esto pasaría: PostgreSQL lo redondearía a 4.240 y el
     * CHECK vería un valor que ya cumple.
     */
    const op = await crearOperacion();
    await expect(movimiento({ operationId: op, cantidad: '4.2401' })).rejects.toThrow(
      /stock_ledger_cantidad_escala/,
    );
  });

  it('acepta 4.240, 4.24 y 3, que son el mismo peso escrito distinto', async () => {
    for (const cantidad of ['4.240', '4.24', '3']) {
      const op = await crearOperacion();
      await expect(
        movimiento({ operationId: op, cantidad, productoId, sucursalId }),
        cantidad,
      ).resolves.toBeTruthy();
      /* Cada uno en su sucursal, para no chocar con la apertura única. */
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "stock_ledger" DISABLE TRIGGER "stock_ledger_sin_delete"`,
      );
      await prisma.$executeRawUnsafe(`DELETE FROM "stock_ledger"`);
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "stock_ledger" ENABLE TRIGGER "stock_ledger_sin_delete"`,
      );
    }
  });

  it('acepta 0 sólo como apertura: un cero contado es una afirmación', async () => {
    const op = await crearOperacion();
    await expect(
      movimiento({ operationId: op, tipo: 'OPENING_BALANCE', cantidad: '0', saldo: '0' }),
    ).resolves.toBeTruthy();
  });

  it('rechaza 0 en un movimiento que no es apertura', async () => {
    const op = await crearOperacion();
    await expect(
      movimiento({
        operationId: op,
        tipo: 'PURCHASE_IN',
        cantidad: '0',
        saldo: '0',
      }),
    ).rejects.toThrow(/stock_ledger_cantidad_positiva/);
  });

  it('rechaza cantidades negativas', async () => {
    const op = await crearOperacion();
    await expect(
      movimiento({ operationId: op, tipo: 'PURCHASE_IN', cantidad: '-1.000', saldo: '0' }),
    ).rejects.toThrow(/stock_ledger_cantidad_positiva/);
  });

  it('rechaza magnitudes absurdas', async () => {
    /* Un millón de kilos en una fiambrería es un error de tipeo. */
    const op = await crearOperacion();
    await expect(
      movimiento({ operationId: op, cantidad: '1000000.001', saldo: '1000000.001' }),
    ).rejects.toThrow(/stock_ledger_cantidad_(escala|maximo)/);
  });

  it('la misma regla alcanza al saldo', async () => {
    /*
     * Acá hay que bajar el disparador del saldo para poder ver la restricción,
     * y vale la pena decir por qué: el disparador exige que el saldo coincida
     * con el saldo posterior del movimiento, y ese movimiento ya no puede tener
     * una escala mala. O sea que la restricción del saldo es un respaldo que en
     * la práctica no se alcanza. Existe igual, y esto lo demuestra.
     */
    const op = await crearOperacion();
    const mov = await movimiento({ operationId: op, cantidad: '4.240' });
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "stock_balance" DISABLE TRIGGER "stock_balance_respaldado"`,
    );
    try {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "stock_balance"
             ("id","productId","branchId","quantity","unit","lastLedgerId",
              "lastOperationId","openingSource","updatedAt")
           VALUES ($1,$2,$3,4.2401,'KG',$4,$5,'APERTURA',now())`,
          proximo(),
          productoId,
          sucursalId,
          mov,
          op,
        ),
      ).rejects.toThrow(/stock_balance_escala/);
    } finally {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "stock_balance" ENABLE TRIGGER "stock_balance_respaldado"`,
      );
    }
  });
});

describe('el libro no se toca', () => {
  it('rechaza UPDATE', async () => {
    const op = await crearOperacion();
    const mov = await movimiento({ operationId: op, cantidad: '4.240' });
    await expect(
      prisma.$executeRawUnsafe(`UPDATE "stock_ledger" SET "quantity" = 9 WHERE id = $1`, mov),
    ).rejects.toThrow(/inmutable|UPDATE/);
  });

  it('rechaza DELETE', async () => {
    const op = await crearOperacion();
    const mov = await movimiento({ operationId: op, cantidad: '4.240' });
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM "stock_ledger" WHERE id = $1`, mov),
    ).rejects.toThrow(/inmutable|DELETE/);
  });

  it('rechaza TRUNCATE, que es la forma más rápida de perder un inventario', async () => {
    /*
     * Va con CASCADE a propósito. Sin él, PostgreSQL se queja antes por las
     * claves foráneas y nunca se llega al disparador: la prueba pasaría sin
     * haber comprobado nada de lo que dice comprobar.
     */
    await expect(
      prisma.$executeRawUnsafe(`TRUNCATE TABLE "stock_ledger" CASCADE`),
    ).rejects.toThrow(/El libro de stock es inmutable: TRUNCATE/);
  });
});

describe('el saldo no se mueve sin un movimiento', () => {
  it('rechaza un saldo escrito por afuera', async () => {
    /*
     * La corrupción más difícil de encontrar: alguien corrige el saldo a mano
     * y el libro deja de explicarlo. El disparador exige que el movimiento que
     * lo respalda sea de la MISMA transacción.
     */
    const op = await crearOperacion();
    const mov = await movimiento({ operationId: op, cantidad: '4.240' });

    /* Otra transacción: el txId del movimiento ya no es el actual. */
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "stock_balance"
           ("id","productId","branchId","quantity","unit","lastLedgerId",
            "lastOperationId","openingSource","updatedAt")
         VALUES ($1,$2,$3,4.240,'KG',$4,$5,'APERTURA',now())`,
        proximo(),
        productoId,
        sucursalId,
        mov,
        op,
      ),
    ).rejects.toThrow(/misma\s+transacción/);
  });

  it('rechaza un saldo que no coincide con el movimiento que dice respaldarlo', async () => {
    const op = await crearOperacion();
    await expect(
      prisma.$transaction(async (tx) => {
        const id = proximo();
        await tx.$executeRawUnsafe(
          `INSERT INTO "stock_ledger"
             ("id","txId","productId","pluHistorico","branchId","type","direction",
              "quantity","unit","effectiveAt","operationId","idempotencyKey","balanceAfterSeq")
           VALUES ($1, txid_current(), $2,'PLU-1',$3,'OPENING_BALANCE','IN',
                   4.240,'KG','2026-09-21T12:00:00Z',$4,$5,4.240)`,
          id,
          productoId,
          sucursalId,
          op,
          `idem-${id}`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "stock_balance"
             ("id","productId","branchId","quantity","unit","lastLedgerId",
              "lastOperationId","openingSource","updatedAt")
           VALUES ($1,$2,$3,99.000,'KG',$4,$5,'APERTURA',now())`,
          proximo(),
          productoId,
          sucursalId,
          id,
          op,
        );
      }),
    ).rejects.toThrow(/no coincide con el saldo posterior/);
  });

  it('rechaza un saldo negativo', async () => {
    /*
     * Mismo caso que la escala: el disparador se interpone antes, porque el
     * movimiento tampoco puede llevar un saldo posterior negativo. La
     * restricción del saldo es el respaldo, y se comprueba bajándolo.
     */
    const op = await crearOperacion();
    const mov = await movimiento({ operationId: op, cantidad: '1.000' });
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "stock_balance" DISABLE TRIGGER "stock_balance_respaldado"`,
    );
    try {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "stock_balance"
             ("id","productId","branchId","quantity","unit","lastLedgerId",
              "lastOperationId","openingSource","updatedAt")
           VALUES ($1,$2,$3,-1.000,'KG',$4,$5,'APERTURA',now())`,
          proximo(),
          productoId,
          sucursalId,
          mov,
          op,
        ),
      ).rejects.toThrow(/stock_balance_no_negativo/);
    } finally {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "stock_balance" ENABLE TRIGGER "stock_balance_respaldado"`,
      );
    }
  });
});

describe('la activación es de a un artículo y una sucursal', () => {
  it('rechaza una segunda apertura del mismo artículo en la misma sucursal', async () => {
    const op1 = await crearOperacion();
    await movimiento({ operationId: op1, cantidad: '4.240' });

    const op2 = await crearOperacion();
    await expect(movimiento({ operationId: op2, cantidad: '1.000' })).rejects.toThrow(
      /"productId", "branchId".*already exists/s,
    );
  });

  it('el mismo artículo sí se abre en otra sucursal: la activación es gradual', async () => {
    const op1 = await crearOperacion();
    await movimiento({ operationId: op1, cantidad: '4.240' });

    const op2 = await crearOperacion();
    await expect(
      movimiento({ operationId: op2, cantidad: '1.000', sucursalId: otraSucursalId }),
    ).resolves.toBeTruthy();
  });

  it('SIN_INICIAR no es cero: son filas distintas y se distinguen', async () => {
    /*
     * La diferencia que cuesta plata confundir. Un artículo sin iniciar no
     * tiene saldo —no hay fila— y no se puede presentar como 0.000. Un cero
     * confirmado sí tiene fila, con su apertura detrás.
     */
    await prisma.$executeRawUnsafe(
      `INSERT INTO "product_stock_activation" ("id","productId","branchId","state","updatedAt")
       VALUES ($1,$2,$3,'SIN_INICIAR',now())`,
      proximo(),
      productoId,
      sucursalId,
    );

    const op = await crearOperacion();
    const mov = await movimiento({
      operationId: op,
      cantidad: '0',
      saldo: '0',
      productoId: otroProductoId,
    });
    await prisma.$transaction(async (tx) => {
      const id = proximo();
      await tx.$executeRawUnsafe(
        `INSERT INTO "stock_ledger"
           ("id","txId","productId","pluHistorico","branchId","type","direction",
            "quantity","unit","effectiveAt","operationId","idempotencyKey","balanceAfterSeq")
         VALUES ($1, txid_current(), $2,'PLU-2',$3,'INVENTORY_CORRECTION','IN',
                 0.001,'KG','2026-09-21T12:00:00Z',$4,$5,0.000)`,
        id,
        otroProductoId,
        sucursalId,
        op,
        `idem-${id}`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "stock_balance"
           ("id","productId","branchId","quantity","unit","lastLedgerId",
            "lastOperationId","openingSource","updatedAt")
         VALUES ($1,$2,$3,0.000,'KG',$4,$5,'APERTURA',now())`,
        proximo(),
        otroProductoId,
        sucursalId,
        id,
        op,
      );
    });

    const sinIniciar = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM "stock_balance" WHERE "productId" = $1`,
      productoId,
    );
    const ceroConfirmado = await prisma.$queryRawUnsafe<{ q: string }[]>(
      `SELECT "quantity"::text AS q FROM "stock_balance" WHERE "productId" = $1`,
      otroProductoId,
    );

    expect(Number(sinIniciar[0]!.n), 'sin iniciar no tiene saldo').toBe(0);
    expect(Number(ceroConfirmado[0]!.q), 'cero confirmado sí').toBe(0);
    expect(mov).toBeTruthy();
  });

  it('un artículo nuevo no se activa solo: nace SIN_INICIAR', async () => {
    const nuevo = await prisma.product.create({
      data: { internalCode: 'PLU-NUEVO-F1', normalizedName: 'Artículo nuevo', purchaseUnit: 'KG' },
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO "product_stock_activation" ("id","productId","branchId","updatedAt")
       VALUES ($1,$2,$3,now())`,
      proximo(),
      nuevo.id,
      sucursalId,
    );
    const fila = await prisma.productStockActivation.findFirstOrThrow({
      where: { productId: nuevo.id },
    });
    expect(fila.state).toBe('SIN_INICIAR');
    expect(fila.cutoffAt).toBeNull();
    expect(fila.openingLedgerId).toBeNull();
  });

  it('ACTIVO exige corte, apertura y quién lo activó', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "product_stock_activation" ("id","productId","branchId","state","updatedAt")
         VALUES ($1,$2,$3,'ACTIVO',now())`,
        proximo(),
        productoId,
        sucursalId,
      ),
    ).rejects.toThrow(/activacion_activo_exige_apertura/);
  });

  it('NO_SE_MANEJA exige motivo', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "product_stock_activation" ("id","productId","branchId","state","updatedAt")
         VALUES ($1,$2,$3,'NO_SE_MANEJA',now())`,
        proximo(),
        productoId,
        sucursalId,
      ),
    ).rejects.toThrow(/activacion_no_se_maneja_exige_motivo/);
  });
});

describe('tipo, dirección y reversión', () => {
  it('rechaza una compra registrada como egreso', async () => {
    const op = await crearOperacion();
    await expect(
      movimiento({ operationId: op, tipo: 'PURCHASE_IN', direccion: 'OUT', cantidad: '1.000' }),
    ).rejects.toThrow(/stock_ledger_tipo_direccion/);
  });

  it('una reversión lleva la dirección opuesta y coincide con el original', async () => {
    const op = await crearOperacion();
    const original = await movimiento({
      operationId: op,
      tipo: 'PURCHASE_IN',
      direccion: 'IN',
      cantidad: '4.240',
      saldo: '4.240',
    });

    await expect(
      movimiento({
        operationId: op,
        tipo: 'PURCHASE_IN',
        direccion: 'OUT',
        cantidad: '4.240',
        saldo: '0.000',
        reversesId: original,
        motivo: 'Se recibió de menos',
      }),
    ).resolves.toBeTruthy();
  });

  it('rechaza una reversión con otra cantidad', async () => {
    const op = await crearOperacion();
    const original = await movimiento({
      operationId: op,
      tipo: 'PURCHASE_IN',
      cantidad: '4.240',
      saldo: '4.240',
    });
    await expect(
      movimiento({
        operationId: op,
        tipo: 'PURCHASE_IN',
        direccion: 'OUT',
        cantidad: '1.000',
        saldo: '3.240',
        reversesId: original,
        motivo: 'mal',
      }),
    ).rejects.toThrow(/tiene que coincidir con el original/);
  });

  it('rechaza una reversión sin motivo', async () => {
    const op = await crearOperacion();
    const original = await movimiento({
      operationId: op,
      tipo: 'PURCHASE_IN',
      cantidad: '4.240',
      saldo: '4.240',
    });
    await expect(
      movimiento({
        operationId: op,
        tipo: 'PURCHASE_IN',
        direccion: 'OUT',
        cantidad: '4.240',
        saldo: '0.000',
        reversesId: original,
        motivo: null,
      }),
    ).rejects.toThrow(/reversion_con_motivo/);
  });

  it('un movimiento se reversa una sola vez', async () => {
    const op = await crearOperacion();
    const original = await movimiento({
      operationId: op,
      tipo: 'PURCHASE_IN',
      cantidad: '4.240',
      saldo: '4.240',
    });
    await movimiento({
      operationId: op,
      tipo: 'PURCHASE_IN',
      direccion: 'OUT',
      cantidad: '4.240',
      saldo: '0.000',
      reversesId: original,
      motivo: 'primera',
    });
    await expect(
      movimiento({
        operationId: op,
        tipo: 'PURCHASE_IN',
        direccion: 'OUT',
        cantidad: '4.240',
        saldo: '0.000',
        reversesId: original,
        motivo: 'segunda',
      }),
    ).rejects.toThrow(/"reversesId".*already exists/s);
  });
});

describe('los traslados llegan enteros o no llegan', () => {
  async function traslado() {
    const op = await crearOperacion('TRASLADO');
    const id = proximo();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "stock_transfer" ("id","fromBranchId","toBranchId","operationId")
       VALUES ($1,$2,$3,$4)`,
      id,
      sucursalId,
      otraSucursalId,
      op,
    );
    const renglones: string[] = [];
    for (const prod of [productoId, otroProductoId]) {
      const linea = proximo();
      await prisma.$executeRawUnsafe(
        `INSERT INTO "stock_transfer_line" ("id","transferId","productId","quantity","unit")
         VALUES ($1,$2,$3,2.500,'KG')`,
        linea,
        id,
        prod,
      );
      renglones.push(linea);
    }
    return { op, id, renglones };
  }

  it('rechaza al commit un traslado de dos artículos con una mitad faltante', async () => {
    const t = await traslado();
    await expect(
      prisma.$transaction(async (tx) => {
        for (const [i, linea] of t.renglones.entries()) {
          const prod = i === 0 ? productoId : otroProductoId;
          for (const [tipo, suc] of [
            ['TRANSFER_OUT', sucursalId],
            ['TRANSFER_IN', otraSucursalId],
          ] as const) {
            /* Al segundo renglón le falta la entrada: eso es lo que se prueba. */
            if (i === 1 && tipo === 'TRANSFER_IN') continue;
            const id = proximo();
            await tx.$executeRawUnsafe(
              `INSERT INTO "stock_ledger"
                 ("id","txId","productId","pluHistorico","branchId","type","direction",
                  "quantity","unit","effectiveAt","operationId","idempotencyKey",
                  "balanceAfterSeq","transferLineId")
               VALUES ($1, txid_current(), $2,'PLU-T',$3,$4::"StockMovementType",
                       $5::"StockDirection",2.500,'KG','2026-09-21T12:00:00Z',$6,$7,0.000,$8)`,
              id,
              prod,
              suc,
              tipo,
              tipo === 'TRANSFER_OUT' ? 'OUT' : 'IN',
              t.op,
              `idem-${id}`,
              linea,
            );
          }
        }
      }),
    ).rejects.toThrow(/exactamente una salida/);
  });

  it('acepta el traslado completo de los dos artículos', async () => {
    const t = await traslado();
    await expect(
      prisma.$transaction(async (tx) => {
        for (const [i, linea] of t.renglones.entries()) {
          const prod = i === 0 ? productoId : otroProductoId;
          for (const [tipo, suc] of [
            ['TRANSFER_OUT', sucursalId],
            ['TRANSFER_IN', otraSucursalId],
          ] as const) {
            const id = proximo();
            await tx.$executeRawUnsafe(
              `INSERT INTO "stock_ledger"
                 ("id","txId","productId","pluHistorico","branchId","type","direction",
                  "quantity","unit","effectiveAt","operationId","idempotencyKey",
                  "balanceAfterSeq","transferLineId")
               VALUES ($1, txid_current(), $2,'PLU-T',$3,$4::"StockMovementType",
                       $5::"StockDirection",2.500,'KG','2026-09-21T12:00:00Z',$6,$7,0.000,$8)`,
              id,
              prod,
              suc,
              tipo,
              tipo === 'TRANSFER_OUT' ? 'OUT' : 'IN',
              t.op,
              `idem-${id}`,
              linea,
            );
          }
        }
      }),
    ).resolves.not.toThrow();
  });

  it('la reversión de un traslado usa renglones nuevos, sin ensuciar los originales', async () => {
    /*
     * Reutilizar el renglón original dejaría CUATRO movimientos bajo una regla
     * que exige exactamente dos, y el traslado original quedaría inválido. La
     * reversión es un traslado nuevo, al revés, vinculado al primero.
     */
    const t = await traslado();
    await prisma.$transaction(async (tx) => {
      for (const [i, linea] of t.renglones.entries()) {
        const prod = i === 0 ? productoId : otroProductoId;
        for (const [tipo, suc] of [
          ['TRANSFER_OUT', sucursalId],
          ['TRANSFER_IN', otraSucursalId],
        ] as const) {
          const id = proximo();
          await tx.$executeRawUnsafe(
            `INSERT INTO "stock_ledger"
               ("id","txId","productId","pluHistorico","branchId","type","direction",
                "quantity","unit","effectiveAt","operationId","idempotencyKey",
                "balanceAfterSeq","transferLineId")
             VALUES ($1, txid_current(), $2,'PLU-T',$3,$4::"StockMovementType",
                     $5::"StockDirection",2.500,'KG','2026-09-21T12:00:00Z',$6,$7,0.000,$8)`,
            id,
            prod,
            suc,
            tipo,
            tipo === 'TRANSFER_OUT' ? 'OUT' : 'IN',
            t.op,
            `idem-${id}`,
            linea,
          );
        }
      }
    });

    /* El traslado inverso: cabecera nueva, renglones nuevos. */
    const opRev = await crearOperacion('REVERSION');
    const idRev = proximo();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "stock_transfer"
         ("id","fromBranchId","toBranchId","operationId","reversesTransferId","reason")
       VALUES ($1,$2,$3,$4,$5,'Se trasladó de más')`,
      idRev,
      otraSucursalId,
      sucursalId,
      opRev,
      t.id,
    );

    const originales = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM "stock_ledger" WHERE "transferLineId" = ANY($1::text[])`,
      t.renglones,
    );
    expect(Number(originales[0]!.n), 'los renglones originales siguen con dos cada uno').toBe(4);

    const vinculo = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM "stock_transfer" WHERE "reversesTransferId" = $1`,
      t.id,
    );
    expect(Number(vinculo[0]!.n)).toBe(1);
  });
});

describe('una operación aplicada no se reescribe', () => {
  it('rechaza cambiar la huella', async () => {
    const op = await crearOperacion();
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "stock_operation" SET "contentHash" = 'otra' WHERE id = $1`,
        op,
      ),
    ).rejects.toThrow(/identidad y la huella/);
  });

  it('rechaza borrarla', async () => {
    const op = await crearOperacion();
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM "stock_operation" WHERE id = $1`, op),
    ).rejects.toThrow(/no se borra/);
  });

  it('la misma clave no se puede usar dos veces', async () => {
    const op = await crearOperacion();
    const clave = (
      await prisma.$queryRawUnsafe<{ operationKey: string }[]>(
        `SELECT "operationKey" FROM "stock_operation" WHERE id = $1`,
        op,
      )
    )[0]!.operationKey;

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "stock_operation" ("id","operationKey","kind","contentHash")
         VALUES ($1,$2,'ACTIVACION','otra')`,
        proximo(),
        clave,
      ),
    ).rejects.toThrow(/"operationKey".*already exists/s);
  });
});

describe('la configuración de unidades', () => {
  it('APROBADA exige unidad y aprobador; PENDIENTE admite unidad nula', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "product_stock_config" ("id","productId","status","updatedAt")
         VALUES ($1,$2,'PENDIENTE',now())`,
        proximo(),
        productoId,
      ),
    ).resolves.toBeTruthy();

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "product_stock_config" SET "status"='APROBADA' WHERE "productId" = $1`,
        productoId,
      ),
    ).rejects.toThrow(/config_aprobada_exige_unidad/);
  });

  it('las presentaciones no se duplican, ni con proveedor nulo', async () => {
    /*
     * Un UNIQUE común no alcanza: en PostgreSQL dos NULL no se consideran
     * iguales, así que dos presentaciones «generales» del mismo artículo
     * pasarían. Por eso son índices parciales.
     */
    const insertar = () =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "product_purchase_presentation"
           ("id","productId","purchaseUnit","conversionFactor","updatedAt")
         VALUES ($1,$2,'KG',1,now())`,
        proximo(),
        productoId,
      );
    await expect(insertar()).resolves.toBeTruthy();
    await expect(insertar()).rejects.toThrow(/"productId".*already exists/s);
  });
});

describe('el reinicio de pruebas', () => {
  it('vacía sólo las tablas de Stock ERP y no toca las comerciales', async () => {
    const op = await crearOperacion();
    await movimiento({ operationId: op, cantidad: '4.240' });

    const antesProductos = await prisma.product.count();
    const antesComprobantes = await prisma.document.count();
    const antesUsuarios = await prisma.user.count();
    expect(antesProductos).toBeGreaterThan(0);

    await prisma.$executeRawUnsafe(`SELECT stock_erp_reset_para_pruebas()`);

    expect(await prisma.stockLedger.count()).toBe(0);
    expect(await prisma.stockOperation.count()).toBe(0);
    /* Y nada comercial se movió. */
    expect(await prisma.product.count()).toBe(antesProductos);
    expect(await prisma.document.count()).toBe(antesComprobantes);
    expect(await prisma.user.count()).toBe(antesUsuarios);
  });

  it('la guarda mira el nombre de la base y no el de la aplicación', async () => {
    const [{ base, pasa }] = await prisma.$queryRawUnsafe<{ base: string; pasa: boolean }[]>(
      `SELECT current_database() AS base,
              current_database() ~ '(^|[_-])(e2e|test|demo)([_-]|$)' AS pasa`,
    );
    expect(base, 'las pruebas corren contra una base de pruebas').toMatch(/test|e2e/);
    expect(pasa).toBe(true);
    /* Y un nombre de producción no pasaría la misma comprobación. */
    const [{ produccion }] = await prisma.$queryRawUnsafe<{ produccion: boolean }[]>(
      `SELECT 'compras_don_gines' ~ '(^|[_-])(e2e|test|demo)([_-]|$)' AS produccion`,
    );
    expect(produccion).toBe(false);
  });
});

describe('los permisos de un rol existente no cambian al resembrar', () => {
  it('el upsert del seed no amplía un rol que ya está', async () => {
    /*
     * Producción corre `db:seed` en cada despliegue, así que la pregunta es
     * pertinente. La respuesta está en que el upsert lleva `update: {}`: un rol
     * que ya existe no se toca, por más permisos nuevos que tenga el `create`.
     */
    const rol = await prisma.role.create({
      data: { code: 'PRUEBA_F1', name: 'Prueba', permissions: ['comprobantes.ver'] },
    });

    await prisma.role.upsert({
      where: { code: 'PRUEBA_F1' },
      update: {},
      create: { code: 'PRUEBA_F1', name: 'Prueba', permissions: ADMIN_PERMISSIONS },
    });

    const despues = await prisma.role.findUniqueOrThrow({ where: { id: rol.id } });
    expect(despues.permissions).toEqual(['comprobantes.ver']);
    expect(despues.permissions.length).toBeLessThan(ADMIN_PERMISSIONS.length);
  });
});
