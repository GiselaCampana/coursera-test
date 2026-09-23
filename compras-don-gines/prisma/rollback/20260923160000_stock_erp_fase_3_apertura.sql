-- Rollback de la fase 3 de Stock ERP: la apertura.
--
-- ORDEN: fase 3 → fase 2 → fase 1. Al revés queda un estado incoherente, por
-- lo mismo que ya explica el rollback de la fase 2: cada fase agrega columnas
-- a tablas que crea la anterior, y desregistrar la de abajo primero deja las
-- de arriba «aplicadas» sin nada que las respalde.
--
-- SE NIEGA A BORRAR HISTORIA
--
-- Si hay una apertura confirmada, movimientos, saldos u operaciones, este
-- script aborta y no toca nada. No es prudencia de más: volver atrás la fase 3
-- con un libro escrito dejaría saldos cuyo origen nadie puede explicar, que es
-- peor que no poder volver atrás. Para eso está el respaldo.
--
-- NO USA CASCADE. Un CASCADE escondería justamente lo que hay que ver: qué
-- depende de qué. Si algo no se puede borrar, tiene que decirlo con nombre.

BEGIN;

-- 1. Frená si hay historia que se perdería.
DO $$
DECLARE
  aperturas bigint;
  movimientos bigint;
  saldos bigint;
  operaciones bigint;
BEGIN
  SELECT count(*) INTO aperturas
    FROM "stock_count_session" WHERE "status" = 'CONFIRMADA';
  SELECT count(*) INTO movimientos FROM "stock_ledger";
  SELECT count(*) INTO saldos      FROM "stock_balance";
  SELECT count(*) INTO operaciones FROM "stock_operation";

  IF aperturas > 0 OR movimientos > 0 OR saldos > 0 OR operaciones > 0 THEN
    RAISE EXCEPTION
      'No se revierte la fase 3: hay % apertura(s) confirmada(s), % movimiento(s), '
      '% saldo(s) y % operación(es). Volver atrás borraría historia del libro de '
      'existencias. Si de verdad hay que hacerlo, se restaura desde el respaldo.',
      aperturas, movimientos, saldos, operaciones;
  END IF;
END $$;

-- 2. Los disparadores propios de esta fase.
DROP TRIGGER IF EXISTS "stock_apertura_permitida" ON "stock_count_session";
DROP FUNCTION IF EXISTS stock_apertura_permitida();
DROP TRIGGER IF EXISTS "stock_count_session_corte_inmutable" ON "stock_count_session";
DROP FUNCTION IF EXISTS stock_count_session_corte_inmutable();

-- 3. Lo que la fase 3 le agregó a la sesión de conteo.
DROP INDEX IF EXISTS "una_apertura_confirmada_por_sucursal";

ALTER TABLE "stock_count_session"
  DROP CONSTRAINT IF EXISTS "sesion_confirmada_completa",
  DROP CONSTRAINT IF EXISTS "stock_count_session_operationId_fkey",
  DROP CONSTRAINT IF EXISTS "stock_count_session_confirmedById_fkey";

ALTER TABLE "stock_count_session"
  DROP COLUMN IF EXISTS "cutoffAt",
  DROP COLUMN IF EXISTS "catalogSnapshotAt",
  DROP COLUMN IF EXISTS "confirmedById",
  DROP COLUMN IF EXISTS "confirmedAt",
  DROP COLUMN IF EXISTS "operationId",
  DROP COLUMN IF EXISTS "ficticia";

-- 4. Lo que le agregó a la activación.
ALTER TABLE "product_stock_activation"
  DROP CONSTRAINT IF EXISTS "activacion_conteo_escala",
  DROP CONSTRAINT IF EXISTS "activacion_conteo_con_unidad",
  DROP CONSTRAINT IF EXISTS "activacion_no_se_maneja_sin_conteo",
  DROP CONSTRAINT IF EXISTS "product_stock_activation_countedById_fkey";

ALTER TABLE "product_stock_activation"
  DROP COLUMN IF EXISTS "countedQuantity",
  DROP COLUMN IF EXISTS "countedUnit",
  DROP COLUMN IF EXISTS "countedById",
  DROP COLUMN IF EXISTS "countedAt";

-- 5. El interruptor.
--
-- Se borra la tabla entera. Su única fila es el interruptor, que nace apagado
-- y se vuelve a crear apagado si la migración se reaplica: no hay nada que
-- conservar, y dejar la tabla sin la migración registrada sería peor.
DROP TABLE IF EXISTS "stock_module_setting";

-- 6. Desregistrar las dos migraciones de la fase.
--
-- Las DOS: la de los estados del enum también. Los valores BORRADOR y
-- CONFIRMADA quedan en el tipo —PostgreSQL no permite quitar un valor de un
-- enum— y eso es inofensivo: son dos nombres que nadie usa. Queda dicho para
-- que a nadie le sorprenda verlos después de revertir.
DELETE FROM "_prisma_migrations"
 WHERE migration_name IN (
   '20260923160000_stock_erp_fase_3_apertura',
   '20260923150000_stock_erp_fase_3_estados'
 );

COMMIT;
