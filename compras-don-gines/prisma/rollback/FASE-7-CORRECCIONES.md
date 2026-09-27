# Rollback de la fase 7 de Stock ERP: mermas, recuentos correctivos y reversiones

Una sola migración, **aditiva**:

| Migración | Qué hace |
|---|---|
| `20260927100000_stock_erp_fase_7_correcciones` | tres enums nuevos, dos tablas nuevas, el discriminador de la sesión de conteo, el cuarto interruptor y cinco disparadores |

Va en una sola migración —a diferencia de la fase 6, que necesitó dos— porque
esta fase **crea** tipos enumerados y no agrega valores a uno existente. La
restricción de PostgreSQL es sobre `ALTER TYPE … ADD VALUE`, no sobre
`CREATE TYPE`: un tipo recién creado sí se puede usar en la misma transacción.

## Qué agregó, y por qué hacía falta

**Tipos nuevos**

| Tipo | Por qué |
|---|---|
| `StockWasteCategory` (8 valores) | una merma sin causa es indistinguible de un faltante no declarado. Ocho categorías, y `OTRO` exige detalle |
| `StockCountSessionKind` | `StockCountSession` se reutiliza para dos cosas distintas —la apertura y el recuento correctivo—, y reutilizar sin discriminador es invitar a que una consulta cuente aperturas creyendo contar recuentos |
| `StockCountLineResolution` | una línea contada termina de dos maneras: coincidía, o se ajustó. No hay tercera |

**`stock_count_session.kind`**, con `sesion_estado_segun_tipo`: una apertura usa
`BORRADOR`/`CONFIRMADA` y un recuento `ABIERTA`/`CERRADA`. Ahora que el tipo es
explícito, la base puede exigir que no se mezclen.

**`stock_waste`**: la merma. `operationId` único —una operación, una merma—,
`reversalOperationId` único, y las CHECK que sostienen la semántica:
`merma_cantidad` (positiva y con escala), `merma_motivo_escrito` (tres caracteres
después de recortar espacios), `merma_otro_exige_detalle` y
`merma_reversion_completa` (si hay reversión, están el autor y la fecha).

**`stock_count_line`**: la línea del recuento. **No se reutilizó
`ProductStockActivation`**: esa fila describe si una sucursal maneja un artículo,
y un recuento correctivo es un hecho fechado con cantidad esperada, cantidad
contada y diferencia. Meterlo ahí habría hecho que el segundo recuento pisara al
primero.

La CHECK que vale la fase entera:

```sql
CONSTRAINT "recuento_diferencia_derivada"
  CHECK ("difference" = "countedQuantity" - "expectedQuantity")
```

El navegador no puede mandar un delta inventado ni siquiera salteando el
servicio con una consulta directa: la resta la comprueba la base. Y
`recuento_operacion_solo_con_diferencia` cierra el otro lado: una línea que
coincidió **no** puede tener operación, así que el movimiento artificial de
cantidad cero es imposible de escribir.

**`stock_module_setting`**: `realCorrectionsEnabled` + autor, fecha y motivo, con
su CHECK. El cuarto interruptor, apagado de nacimiento.

## Los disparadores nuevos

| Disparador | Qué defiende |
|---|---|
| `stock_correccion_permitida` | la sucursal tiene apertura confirmada, la fecha efectiva es posterior al corte, y la corrección es sobre una apertura ficticia en una base de pruebas **o** el interruptor está encendido |
| `stock_reversion_elegible` | qué se puede revertir en esta fase, y nada más |
| `stock_merma_inmutable` | una merma registrada no se edita ni se borra |
| `stock_recuento_inmutable` | una línea confirmada no se reescribe |
| `traslado_reversado_completo` (CHECK) | un traslado `REVERSADO` tiene su despacho, su reversión y ninguna recepción |

## Los dos invariantes de la fase 6 que esta fase cambió

**`stock_traslado_completo`.** La fase 6 contaba las salidas y las entradas del
renglón sin distinguir originales de reversiones. Con la reversión del despacho,
el mismo renglón pasa a tener dos asientos del lado de la salida: el original y
su inverso. La versión de la fase 6 lo rechazaba con «no puede tener dos
salidas», que es la regla correcta aplicada a los datos equivocados.

La regla **no se aflojó: se precisó**. Ahora cuenta sólo los asientos con
`reversesId IS NULL` para validar el despacho, y reconoce la reversión exacta
por separado:

| Estado | Qué exige |
|---|---|
| `BORRADOR`, `CANCELADO` | ningún asiento |
| `DESPACHADO` | exactamente una salida original, ninguna entrada |
| `RECIBIDO`, `APLICADO` | exactamente una de cada, originales |
| `REVERSADO` | una salida original, su reversión, y **ninguna** entrada |

Y **una segunda salida ORIGINAL sigue prohibida**, exista o no una reversión
legítima. Eso tiene una prueba propia —la 28b de
`tests/integration/stock-erp-correcciones.test.ts`— que demuestra que quitar el
filtro entre originales y reversiones vuelve roja la suite.

**`stock_traslado_transicion`.** Permite `DESPACHADO → REVERSADO` además de
`DESPACHADO → RECIBIDO`. **Sólo desde `DESPACHADO`**: un traslado ya recibido no
se revierte como si sólo hubiera salido —habría que compensar las dos
sucursales— y eso no es de esta fase. Un traslado reversado no vuelve a ser
borrador editable.

## Cómo volver atrás

**Primero, la pregunta que decide todo: ¿hay historia real?**

```sql
SELECT count(*) FROM "stock_waste";
SELECT count(*) FROM "stock_count_line";
SELECT count(*) FROM "stock_ledger"
 WHERE "type" IN ('WASTE_OUT','INTERNAL_USE_OUT','ADJUSTMENT_IN',
                  'ADJUSTMENT_OUT','INVENTORY_CORRECTION')
    OR "reversesId" IS NOT NULL;
SELECT count(*) FROM "stock_transfer" WHERE "status" = 'REVERSADO';
```

**Si alguno da distinto de cero, el rollback de base NO se hace.** Hay
existencias que se corrigieron y asientos que dicen por qué. Borrar
`stock_waste` dejaría en el libro salidas sin causa, que es exactamente el estado
que esta fase vino a evitar. Revertir el CÓDIGO es seguro y suficiente: las
tablas quedan sin uso y el libro conserva su historia.

**Si todos dan cero** —nadie corrigió nada todavía— el rollback de esquema es
este, y va en este orden:

```sql
BEGIN;

-- 0. LA NEGATIVA, y no es un comentario: es el primer paso del script.
--
-- Dejar la comprobación «para hacer antes a mano» es dejarla sin hacer el día
-- que alguien corre esto apurado. Si hay historia real, esto aborta la
-- transacción entera y no se toca una sola tabla.
DO $$
DECLARE
  mermas     INT;
  recuentos  INT;
  asientos   INT;
  reversados INT;
BEGIN
  SELECT count(*) INTO mermas    FROM "stock_waste";
  SELECT count(*) INTO recuentos FROM "stock_count_line";
  SELECT count(*) INTO asientos  FROM "stock_ledger"
   WHERE "type" IN ('WASTE_OUT', 'INTERNAL_USE_OUT', 'ADJUSTMENT_IN',
                    'ADJUSTMENT_OUT', 'INVENTORY_CORRECTION')
      OR "reversesId" IS NOT NULL;
  SELECT count(*) INTO reversados FROM "stock_transfer" WHERE "status" = 'REVERSADO';

  IF mermas > 0 OR recuentos > 0 OR asientos > 0 OR reversados > 0 THEN
    RAISE EXCEPTION
      'Hay historia real de correcciones: % mermas, % líneas de recuento, % '
      'asientos de corrección o reversión y % traslados reversados. El rollback '
      'de esquema NO se hace: borrar estas tablas dejaría en el libro salidas '
      'sin causa. Revertí el CÓDIGO, que es seguro y suficiente.',
      mermas, recuentos, asientos, reversados;
  END IF;
END $$;

-- 1. Los disparadores nuevos: si quedaran, rechazarían los pasos siguientes.
DROP TRIGGER IF EXISTS "stock_correccion_permitida" ON "stock_ledger";
DROP TRIGGER IF EXISTS "stock_reversion_elegible" ON "stock_ledger";
DROP TRIGGER IF EXISTS "stock_merma_inmutable" ON "stock_waste";
DROP TRIGGER IF EXISTS "stock_recuento_inmutable" ON "stock_count_line";
DROP FUNCTION IF EXISTS stock_correccion_permitida();
DROP FUNCTION IF EXISTS stock_reversion_elegible();
DROP FUNCTION IF EXISTS stock_merma_inmutable();
DROP FUNCTION IF EXISTS stock_recuento_inmutable();

-- 2. La función de reinicio de pruebas, sin las dos tablas nuevas.
--
-- Va antes de borrarlas: una función que menciona una tabla inexistente no
-- falla al crearse, pero sí la primera vez que corre, y entonces el reinicio de
-- las bases de prueba queda roto sin que nadie se entere hasta la próxima
-- corrida de end to end.
CREATE OR REPLACE FUNCTION stock_erp_reset_para_pruebas() RETURNS void AS $$
BEGIN
  IF current_database() !~ '(^|[_-])(e2e|test|demo)([_-]|$)' THEN
    RAISE EXCEPTION
      'Esto borra el libro de stock y sólo corre contra una base de pruebas: '
      'el nombre tiene que contener "e2e", "test" o "demo". Base vista: %',
      current_database();
  END IF;

  ALTER TABLE "stock_ledger" DISABLE TRIGGER "stock_ledger_sin_truncate";
  ALTER TABLE "stock_ledger" DISABLE TRIGGER "stock_ledger_sin_delete";
  ALTER TABLE "stock_operation" DISABLE TRIGGER "stock_operation_inmutable";
  ALTER TABLE "stock_receipt" DISABLE TRIGGER "stock_recepcion_inmutable";
  ALTER TABLE "stock_transfer_line" DISABLE TRIGGER "stock_traslado_renglon_inmutable";
  ALTER TABLE "stock_transfer" DISABLE TRIGGER "stock_traslado_transicion";

  TRUNCATE TABLE
    "stock_receipt",
    "stock_balance",
    "stock_ledger",
    "stock_transfer_line",
    "stock_transfer",
    "stock_operation",
    "product_stock_activation",
    "stock_count_session",
    "product_stock_config_history",
    "product_stock_config",
    "product_purchase_presentation";

  ALTER TABLE "stock_ledger" ENABLE TRIGGER "stock_ledger_sin_truncate";
  ALTER TABLE "stock_ledger" ENABLE TRIGGER "stock_ledger_sin_delete";
  ALTER TABLE "stock_operation" ENABLE TRIGGER "stock_operation_inmutable";
  ALTER TABLE "stock_receipt" ENABLE TRIGGER "stock_recepcion_inmutable";
  ALTER TABLE "stock_transfer_line" ENABLE TRIGGER "stock_traslado_renglon_inmutable";
  ALTER TABLE "stock_transfer" ENABLE TRIGGER "stock_traslado_transicion";
END;
$$ LANGUAGE plpgsql;

-- 3. Las dos versiones de la fase 6, tal cual eran.
--
-- `stock_traslado_completo` vuelve a contar todos los asientos sin distinguir
-- originales de reversiones —que es correcto cuando no hay reversiones— y
-- `stock_traslado_transicion` vuelve a permitir sólo DESPACHADO → RECIBIDO.
CREATE OR REPLACE FUNCTION stock_traslado_completo() RETURNS trigger AS $$
DECLARE
  renglon  "stock_transfer_line"%ROWTYPE;
  cab      "stock_transfer"%ROWTYPE;
  salidas  INT;
  entradas INT;
BEGIN
  SELECT * INTO renglon FROM "stock_transfer_line" WHERE id = NEW."transferLineId";
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT * INTO cab FROM "stock_transfer" WHERE id = renglon."transferId";

  IF cab."fromBranchId" = cab."toBranchId" THEN
    RAISE EXCEPTION 'Un traslado necesita dos sucursales distintas.';
  END IF;

  SELECT
    count(*) FILTER (
      WHERE "type" = 'TRANSFER_OUT' AND "branchId" = cab."fromBranchId"
        AND "quantity" = coalesce(renglon."dispatchedQuantity", renglon."quantity")),
    count(*) FILTER (
      WHERE "type" = 'TRANSFER_IN' AND "branchId" = cab."toBranchId"
        AND "quantity" = coalesce(renglon."receivedQuantity", renglon."quantity"))
  INTO salidas, entradas
  FROM "stock_ledger"
  WHERE "transferLineId" = renglon.id
    AND "productId" = renglon."productId"
    AND "unit" = renglon."unit";

  IF salidas > 1 OR entradas > 1 THEN
    RAISE EXCEPTION
      'Un renglón de traslado no puede tener dos salidas ni dos entradas. '
      'Se encontraron % y %.', salidas, entradas;
  END IF;

  IF entradas = 1 AND salidas = 0 THEN
    RAISE EXCEPTION
      'Una entrada de traslado sin su salida no existe: la mercadería no puede '
      'llegar a % sin haber salido de %.', cab."toBranchId", cab."fromBranchId";
  END IF;

  IF cab."status"::text IN ('BORRADOR', 'CANCELADO') THEN
    IF salidas > 0 OR entradas > 0 THEN
      RAISE EXCEPTION
        'Un traslado en % no escribe en el libro. Se encontraron % salidas y % '
        'entradas.', cab."status", salidas, entradas;
    END IF;

  ELSIF cab."status"::text = 'DESPACHADO' THEN
    IF salidas <> 1 THEN
      RAISE EXCEPTION
        'Un traslado despachado necesita exactamente una salida en % por cada '
        'renglón, del mismo artículo, unidad y cantidad. Se encontraron %.',
        cab."fromBranchId", salidas;
    END IF;
    IF entradas <> 0 THEN
      RAISE EXCEPTION
        'Un traslado despachado todavía no llegó: no puede tener entradas en %. '
        'Se encontraron %.', cab."toBranchId", entradas;
    END IF;

  ELSIF cab."status"::text IN ('RECIBIDO', 'APLICADO') THEN
    IF salidas <> 1 OR entradas <> 1 THEN
      RAISE EXCEPTION
        'Un traslado % no se cierra con una mitad faltante: cada renglón '
        'necesita una salida en % y una entrada en %, del mismo artículo, '
        'unidad y cantidad. Se encontraron % y %.',
        cab."status", cab."fromBranchId", cab."toBranchId", salidas, entradas;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION stock_traslado_transicion() RETURNS trigger AS $$
BEGIN
  IF NEW."fromBranchId" <> OLD."fromBranchId" OR NEW."toBranchId" <> OLD."toBranchId" THEN
    RAISE EXCEPTION
      'El origen y el destino de un traslado no se reescriben. Si estaban mal, '
      'se cancela el borrador y se hace otro.';
  END IF;

  IF OLD."operationId" IS NOT NULL
     AND NEW."operationId" IS DISTINCT FROM OLD."operationId" THEN
    RAISE EXCEPTION 'La operación de despacho de un traslado no se cambia.';
  END IF;
  IF OLD."receiptOperationId" IS NOT NULL
     AND NEW."receiptOperationId" IS DISTINCT FROM OLD."receiptOperationId" THEN
    RAISE EXCEPTION 'La operación de recepción de un traslado no se cambia.';
  END IF;
  IF OLD."dispatchedAt" IS NOT NULL
     AND NEW."dispatchedAt" IS DISTINCT FROM OLD."dispatchedAt" THEN
    RAISE EXCEPTION 'El momento del despacho es historia: no se mueve.';
  END IF;
  IF OLD."receivedAt" IS NOT NULL
     AND NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt" THEN
    RAISE EXCEPTION 'El momento de la recepción es historia: no se mueve.';
  END IF;

  IF NEW."status"::text = OLD."status"::text THEN
    RETURN NEW;
  END IF;

  IF OLD."status"::text = 'BORRADOR' THEN
    IF NEW."status"::text NOT IN ('DESPACHADO', 'CANCELADO') THEN
      RAISE EXCEPTION 'Un borrador sólo se despacha o se cancela (se intentó %).',
        NEW."status";
    END IF;
  ELSIF OLD."status"::text = 'DESPACHADO' THEN
    IF NEW."status"::text <> 'RECIBIDO' THEN
      RAISE EXCEPTION
        'Un traslado despachado sólo se recibe (se intentó %). La mercadería ya '
        'salió de la sucursal de origen: no hay vuelta atrás sin un movimiento '
        'nuevo, y esta fase no los tiene.', NEW."status";
    END IF;
  ELSE
    RAISE EXCEPTION 'Un traslado % es definitivo: no cambia de estado.', OLD."status";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 4. Las restricciones y columnas que esta fase agregó a tablas que NO se
--    borran. SIN CASCADE: un CASCADE acá podría alcanzar objetos de otra fase.
ALTER TABLE "stock_transfer"
  DROP CONSTRAINT IF EXISTS "traslado_reversado_completo";

ALTER TABLE "stock_count_session"
  DROP CONSTRAINT IF EXISTS "sesion_estado_segun_tipo";
DROP INDEX IF EXISTS "stock_count_session_kind_status_idx";
ALTER TABLE "stock_count_session"
  DROP COLUMN IF EXISTS "kind";

ALTER TABLE "stock_module_setting"
  DROP CONSTRAINT IF EXISTS "stock_module_setting_correcciones_con_motivo",
  DROP CONSTRAINT IF EXISTS "stock_module_setting_correctionsChangedById_fkey";
ALTER TABLE "stock_module_setting"
  DROP COLUMN IF EXISTS "realCorrectionsEnabled",
  DROP COLUMN IF EXISTS "correctionsChangedById",
  DROP COLUMN IF EXISTS "correctionsChangedAt",
  DROP COLUMN IF EXISTS "correctionsReason";

-- 5. Las dos tablas nuevas. Están vacías: lo comprobó el paso 0.
--
-- Sin CASCADE también acá, y en este orden: `stock_count_line` referencia a
-- `stock_count_session`, que no se borra, y ninguna otra tabla las referencia,
-- así que un DROP simple alcanza. Si fallara por una dependencia, es una
-- dependencia que nadie previó y hay que mirarla antes de forzar nada.
DROP TABLE IF EXISTS "stock_count_line";
DROP TABLE IF EXISTS "stock_waste";

-- 6. Los tipos, que ahora no los usa ninguna columna.
DROP TYPE IF EXISTS "StockCountLineResolution";
DROP TYPE IF EXISTS "StockWasteCategory";
DROP TYPE IF EXISTS "StockCountSessionKind";

COMMIT;
```

**Lo que NO se puede deshacer, y hay que saberlo antes de empezar:** el valor
`REVERSADO` de `StockTransferStatus`, que agregó la fase 6 y esta fase empezó a
usar. PostgreSQL no quita valores de un enum sin recrear el tipo, y recrearlo
obliga a reescribir toda columna que lo use. Queda declarado y sin usar, que es
inofensivo: el paso 0 ya comprobó que ninguna fila lo lleva.

Los tres tipos que esta fase **creó** sí se borran, porque se crearon acá: el
paso 6 los quita después de que el paso 5 se llevó las columnas que los usaban.
Ésa es la diferencia con el enum de la fase 6, y es la razón por la que esa fase
necesitó dos migraciones y ésta una.

## Probado en las dos direcciones

El guión se corrió contra una base de pruebas con el esquema de la fase 7
aplicado y vacío de correcciones; después se reaplicó la migración con
`prisma migrate deploy` y se comprobó que `prisma migrate diff` no reporta
deriva. La negativa del paso 0 se comprobó con una merma registrada: aborta la
transacción entera y no toca una sola tabla.

## Rollback de código

Sin tocar la base, y **sin reescribir la historia**: `git revert` de los commits
de la fase del más nuevo al más viejo, o desplegar `2e55767` —cabeza aprobada y
congelada de la fase 6— sin mover la rama. `git reset --hard` no es un
procedimiento de rollback: descarta commits que otros clones ya tienen y no deja
rastro.
