# Rollback de la fase 6 de Stock ERP: traslados entre sucursales

Dos migraciones, las dos **aditivas**:

| Migración | Qué hace |
|---|---|
| `20260926100000_stock_erp_fase_6_estados` | agrega cuatro valores a `StockTransferStatus` |
| `20260926100500_stock_erp_fase_6_traslados` | columnas, restricciones y disparadores del traslado en dos pasos |

Van separadas porque PostgreSQL no permite usar un valor de enum recién agregado
en la misma transacción que lo agregó, y Prisma corre cada migración en una
transacción. Juntas fallan; separadas funcionan.

## Qué agregó, campo por campo, y por qué hacía falta

**`stock_transfer`**

| Campo | Por qué |
|---|---|
| `operationId` pasa a **opcional** | un borrador no escribió nada, así que no tiene operación. Antes era obligatoria porque el traslado nacía ya aplicado |
| `receiptOperationId` | la recepción es otro hecho físico: con una sola operación, reintentar la recepción se parecería a reintentar el despacho |
| `preparedById`, `dispatchedById`, `receivedById`, `cancelledById` | «quién entregó» y «quién recibió» son dos preguntas distintas, y ninguna se contesta con quien armó el papel |
| `dispatchedAt`, `receivedAt`, `cancelledAt` | instantes físicos, con zona horaria, decididos por el servidor |
| `version` | bloqueo optimista del borrador: dos personas editándolo no se pisan en silencio |
| `status` por omisión `BORRADOR` | un traslado nace en preparación |

**`stock_transfer_line`**

| Campo | Por qué |
|---|---|
| `dispatchedQuantity` | **lo que salió**. Sin esto, «¿cuánto se despachó?» sólo se puede deducir del libro, y es una pregunta del negocio |
| `receivedQuantity` | **lo que llegó**. En esta fase tiene que ser igual a lo despachado, y lo exige la base |

**`stock_module_setting`**: `realTransfersEnabled` + autor, fecha y motivo, con
su CHECK. El tercer interruptor, apagado de nacimiento.

## El invariante de la fase 1 que esta fase cambió

`stock_traslado_completo` exigía, al COMMIT de cada inserción en el libro, la
salida **y** la entrada de cada renglón. Con mercadería en tránsito eso es
imposible: el despacho escribe sólo la salida y la entrada llega al día
siguiente, en otra transacción.

La promesa «un traslado llega entero o no llega» **no se abandonó: se movió**.
Dejó de ser «dentro de una transacción» y pasó a ser «antes de poder cerrarse»:

| Estado | Qué exige el disparador |
|---|---|
| `BORRADOR`, `CANCELADO` | ninguna mitad: un borrador no escribe libro |
| `DESPACHADO` | exactamente la salida, y **ninguna** entrada. Eso es el tránsito |
| `RECIBIDO`, `APLICADO` | exactamente una de cada |

Y en cualquier estado: nunca dos mitades del mismo lado, y nunca una entrada sin
su salida. Se reescribió el bloque de pruebas de la fase 1 que afirmaba la regla
vieja, con autorización expresa, para que afirme la nueva.

## Cómo volver atrás

**Primero, la pregunta que decide todo: ¿hay historia real?**

```sql
SELECT count(*) FROM "stock_transfer"
 WHERE "status" IN ('DESPACHADO','RECIBIDO','APLICADO');
SELECT count(*) FROM "stock_ledger" WHERE "type" IN ('TRANSFER_OUT','TRANSFER_IN');
```

**Si alguno da distinto de cero, el rollback de base NO se hace.** Hay mercadería
que se movió entre sucursales y las columnas que se quitarían son las que dicen
cuánto salió, cuánto llegó, quién y cuándo. Revertir el CÓDIGO es seguro y
suficiente: las columnas quedan sin uso y el libro conserva su historia.

**Si los dos dan cero** —ninguna sucursal trasladó nada todavía— el rollback de
esquema es este, y va en este orden:

```sql
BEGIN;

-- 0. LA NEGATIVA, y no es un comentario: es el primer paso del script.
--
-- Dejar la comprobación «para hacer antes a mano» es dejarla sin hacer el día
-- que alguien corre esto apurado. Si hay historia real, esto aborta la
-- transacción entera y no se toca una sola columna.
DO $$
DECLARE
  movidos  INT;
  asientos INT;
BEGIN
  SELECT count(*) INTO movidos FROM "stock_transfer"
   WHERE "status" IN ('DESPACHADO', 'RECIBIDO', 'APLICADO');
  SELECT count(*) INTO asientos FROM "stock_ledger"
   WHERE "type" IN ('TRANSFER_OUT', 'TRANSFER_IN');

  IF movidos > 0 OR asientos > 0 THEN
    RAISE EXCEPTION
      'Hay historia real de traslados: % traslados despachados o recibidos y % '
      'asientos en el libro. El rollback de esquema NO se hace: las columnas que '
      'se quitarían son las que dicen cuánto salió, cuánto llegó, quién y '
      'cuándo. Revertí el CÓDIGO, que es seguro y suficiente.',
      movidos, asientos;
  END IF;
END $$;

-- 1. Los disparadores nuevos: si quedaran, rechazarían los pasos siguientes.
DROP TRIGGER IF EXISTS "stock_traslado_permitido" ON "stock_transfer";
DROP TRIGGER IF EXISTS "stock_traslado_transicion" ON "stock_transfer";
DROP TRIGGER IF EXISTS "stock_traslado_estado_coherente" ON "stock_transfer";
DROP TRIGGER IF EXISTS "stock_traslado_renglon_inmutable" ON "stock_transfer_line";
DROP TRIGGER IF EXISTS "stock_traslado_posterior_al_corte" ON "stock_ledger";
DROP FUNCTION IF EXISTS stock_traslado_permitido();
DROP FUNCTION IF EXISTS stock_traslado_transicion();
DROP FUNCTION IF EXISTS stock_traslado_estado_coherente();
DROP FUNCTION IF EXISTS stock_traslado_renglon_inmutable();
DROP FUNCTION IF EXISTS stock_traslado_posterior_al_corte();

-- 2. La versión de la fase 1 del disparador de traslado completo, tal cual era.
CREATE OR REPLACE FUNCTION stock_traslado_completo() RETURNS trigger AS $$
DECLARE
  renglon "stock_transfer_line"%ROWTYPE;
  cab     "stock_transfer"%ROWTYPE;
  salidas INT;
  entradas INT;
BEGIN
  SELECT * INTO renglon FROM "stock_transfer_line" WHERE id = NEW."transferLineId";
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT * INTO cab FROM "stock_transfer" WHERE id = renglon."transferId";

  IF cab."fromBranchId" = cab."toBranchId" THEN
    RAISE EXCEPTION 'Un traslado necesita dos sucursales distintas.';
  END IF;

  SELECT
    count(*) FILTER (WHERE "type" = 'TRANSFER_OUT' AND "branchId" = cab."fromBranchId"),
    count(*) FILTER (WHERE "type" = 'TRANSFER_IN'  AND "branchId" = cab."toBranchId")
  INTO salidas, entradas
  FROM "stock_ledger"
  WHERE "transferLineId" = renglon.id
    AND "productId" = renglon."productId"
    AND "unit" = renglon."unit"
    AND "quantity" = renglon."quantity";

  IF salidas <> 1 OR entradas <> 1 THEN
    RAISE EXCEPTION
      'Cada renglón de traslado necesita exactamente una salida en % y una '
      'entrada en %, del mismo artículo, unidad y cantidad. Se encontraron % y %.',
      cab."fromBranchId", cab."toBranchId", salidas, entradas;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Las restricciones nuevas.
ALTER TABLE "stock_transfer"
  DROP CONSTRAINT IF EXISTS "traslado_sucursales_distintas",
  DROP CONSTRAINT IF EXISTS "traslado_borrador_sin_efectos",
  DROP CONSTRAINT IF EXISTS "traslado_despachado_completo",
  DROP CONSTRAINT IF EXISTS "traslado_recibido_completo",
  DROP CONSTRAINT IF EXISTS "traslado_cancelado_sin_libro",
  DROP CONSTRAINT IF EXISTS "traslado_recibido_despues_del_despacho";

ALTER TABLE "stock_transfer_line"
  DROP CONSTRAINT IF EXISTS "traslado_renglon_despachada_escala",
  DROP CONSTRAINT IF EXISTS "traslado_renglon_recibida_escala",
  DROP CONSTRAINT IF EXISTS "traslado_renglon_despacha_lo_preparado",
  DROP CONSTRAINT IF EXISTS "traslado_renglon_recepcion_exacta",
  DROP CONSTRAINT IF EXISTS "traslado_renglon_recibida_con_despachada";

ALTER TABLE "stock_module_setting"
  DROP CONSTRAINT IF EXISTS "stock_module_setting_traslados_con_motivo";

-- 3 bis. Los índices que esta fase agregó sobre columnas que NO se quitan.
--
-- HALLAZGO de probar el rollback en las dos direcciones: sin este paso, volver
-- atrás dejaba el único de `operationId` en pie —la columna no se borra, sólo
-- vuelve a ser obligatoria—, y reaplicar la migración después fallaba con
-- «relation "stock_transfer_operationId_key" already exists». Antes de la fase 6
-- ese único no existía: un traslado podía compartir operación con otro.
--
-- Los índices de columnas que sí se borran se van con ellas y no hay que
-- nombrarlos.
DROP INDEX IF EXISTS "stock_transfer_operationId_key";
DROP INDEX IF EXISTS "stock_transfer_status_idx";

-- 4. Las columnas. SIN CASCADE, y de a una: un CASCADE acá podría alcanzar
--    objetos que no son de esta fase.
ALTER TABLE "stock_transfer"
  DROP COLUMN IF EXISTS "receiptOperationId",
  DROP COLUMN IF EXISTS "preparedById",
  DROP COLUMN IF EXISTS "dispatchedById",
  DROP COLUMN IF EXISTS "receivedById",
  DROP COLUMN IF EXISTS "cancelledById",
  DROP COLUMN IF EXISTS "dispatchedAt",
  DROP COLUMN IF EXISTS "receivedAt",
  DROP COLUMN IF EXISTS "cancelledAt",
  DROP COLUMN IF EXISTS "version";

ALTER TABLE "stock_transfer_line"
  DROP COLUMN IF EXISTS "dispatchedQuantity",
  DROP COLUMN IF EXISTS "receivedQuantity";

ALTER TABLE "stock_module_setting"
  DROP COLUMN IF EXISTS "realTransfersEnabled",
  DROP COLUMN IF EXISTS "transfersChangedById",
  DROP COLUMN IF EXISTS "transfersChangedAt",
  DROP COLUMN IF EXISTS "transfersReason";

-- 5. `operationId` vuelve a ser obligatoria, y el default del estado vuelve a
--    APLICADO. Sólo se puede si no quedó ningún borrador sin operación.
DELETE FROM "stock_transfer" WHERE "operationId" IS NULL;
ALTER TABLE "stock_transfer"
  ALTER COLUMN "operationId" SET NOT NULL,
  ALTER COLUMN "status" SET DEFAULT 'APLICADO';

COMMIT;
```

**Lo que NO se puede deshacer, y hay que saberlo antes de empezar:** los cuatro
valores del enum. PostgreSQL no quita valores de un enum sin recrear el tipo, y
recrearlo obliga a reescribir toda columna que lo use. Quedan declarados y sin
usar, que es inofensivo: ninguna fila los lleva si el paso 5 corrió.

El `DELETE` del paso 5 borra borradores y cancelados, que por definición **nunca
tocaron el libro**. Si hubiera alguno con operación, el paso 5 falla y hay que
volver a mirar la pregunta del principio.

## Rollback de código

Sin tocar la base, y **sin reescribir la historia**: `git revert` de los commits
de la fase del más nuevo al más viejo, o desplegar `70cd292` —cabeza aprobada de
la fase 5— sin mover la rama. `git reset --hard` no es un procedimiento de
rollback: descarta commits que otros clones ya tienen y no deja rastro.
