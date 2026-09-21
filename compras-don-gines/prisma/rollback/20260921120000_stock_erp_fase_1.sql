-- Rollback de la etapa 1 del Stock ERP.
--
-- Vale MIENTRAS LAS TABLAS SIGUEN VACÍAS, que es el estado en el que quedan:
-- esta etapa no crea aperturas, saldos ni activaciones reales. Si alguna de
-- las tablas tuviera filas, este guion se niega antes de tocar nada: el libro
-- es inmutable y borrarlo con un DROP sería exactamente lo que los
-- disparadores existen para impedir.
--
-- No toca ninguna tabla comercial: products, branches, documents, stock_outbox
-- y el resto quedan como están. Es aditivo al revés.
--
-- El orden de los DROP TABLE sale de las claves foráneas reales y no del orden
-- en que la migración las creó, que no es el mismo: stock_ledger apunta a
-- stock_transfer_line y product_stock_activation apunta a stock_ledger y a
-- stock_count_session. Ninguno lleva CASCADE a propósito —si algo ajeno a esta
-- etapa dependiera de estas tablas, el DROP tiene que fallar y no arrastrarlo.
--
-- Se corre con:
--   psql -v ON_ERROR_STOP=1 -f prisma/rollback/20260921120000_stock_erp_fase_1.sql

BEGIN;

DO $$
DECLARE
  tabla text;
  filas bigint;
BEGIN
  FOREACH tabla IN ARRAY ARRAY[
    'stock_ledger', 'stock_balance', 'stock_operation',
    'stock_transfer_line', 'stock_transfer', 'stock_count_session',
    'product_stock_activation', 'product_stock_config_history',
    'product_stock_config', 'product_purchase_presentation'
  ] LOOP
    IF to_regclass(format('public.%I', tabla)) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('SELECT count(*) FROM public.%I', tabla) INTO filas;
    IF filas > 0 THEN
      RAISE EXCEPTION
        'La tabla % tiene % fila(s). Este rollback sólo corre mientras la etapa 1 sigue vacía.',
        tabla, filas;
    END IF;
  END LOOP;
END
$$;

-- Los disparadores y sus funciones. Los DROP TABLE se llevarían los
-- disparadores, pero no las funciones ni la de reinicio, que no cuelga de
-- ninguna tabla.
DROP TRIGGER IF EXISTS "stock_traslado_completo" ON "stock_ledger";
DROP TRIGGER IF EXISTS "stock_activacion_inicial_inmutable" ON "product_stock_activation";
DROP TRIGGER IF EXISTS "stock_operation_inmutable" ON "stock_operation";
DROP TRIGGER IF EXISTS "stock_balance_respaldado" ON "stock_balance";
DROP TRIGGER IF EXISTS "stock_ledger_reversion_coherente" ON "stock_ledger";
DROP TRIGGER IF EXISTS "stock_ledger_sin_truncate" ON "stock_ledger";
DROP TRIGGER IF EXISTS "stock_ledger_sin_delete" ON "stock_ledger";
DROP TRIGGER IF EXISTS "stock_ledger_sin_update" ON "stock_ledger";

DROP FUNCTION IF EXISTS stock_erp_reset_para_pruebas();
DROP FUNCTION IF EXISTS stock_traslado_completo();
DROP FUNCTION IF EXISTS stock_activacion_inicial_inmutable();
DROP FUNCTION IF EXISTS stock_operation_inmutable();
DROP FUNCTION IF EXISTS stock_balance_respaldado();
DROP FUNCTION IF EXISTS stock_ledger_reversion_coherente();
DROP FUNCTION IF EXISTS stock_ledger_inmutable();

-- Las tablas, en orden de dependencia. Sin CASCADE a propósito: si algo que
-- esta etapa no creó dependiera de ellas, el DROP tiene que fallar y no
-- arrastrarlo.
DROP TABLE IF EXISTS "stock_balance";
DROP TABLE IF EXISTS "product_stock_activation";
DROP TABLE IF EXISTS "stock_count_session";
DROP TABLE IF EXISTS "stock_ledger";
DROP TABLE IF EXISTS "stock_transfer_line";
DROP TABLE IF EXISTS "stock_transfer";
DROP TABLE IF EXISTS "stock_operation";
DROP TABLE IF EXISTS "product_stock_config_history";
DROP TABLE IF EXISTS "product_stock_config";
DROP TABLE IF EXISTS "product_purchase_presentation";

DROP TYPE IF EXISTS "StockOpeningSource";
DROP TYPE IF EXISTS "StockTransferStatus";
DROP TYPE IF EXISTS "StockCountSessionStatus";
DROP TYPE IF EXISTS "StockOperationKind";
DROP TYPE IF EXISTS "StockDirection";
DROP TYPE IF EXISTS "StockMovementType";
DROP TYPE IF EXISTS "StockActivationState";
DROP TYPE IF EXISTS "StockConfigStatus";
DROP TYPE IF EXISTS "StockUnit";

-- Que Prisma no crea que la migración sigue aplicada.
DELETE FROM "_prisma_migrations" WHERE migration_name = '20260921120000_stock_erp_fase_1';

COMMIT;
