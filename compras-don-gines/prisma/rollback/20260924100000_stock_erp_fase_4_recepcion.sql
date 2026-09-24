-- Rollback de la fase 4 de Stock ERP: la recepción de una compra.
--
-- ORDEN: fase 4 → fase 3 → fase 2 → fase 1. Al revés queda un estado
-- incoherente, por lo mismo que explican los rollbacks anteriores: cada fase
-- agrega columnas y disparadores sobre tablas que crea la anterior, y
-- desregistrar la de abajo primero deja las de arriba «aplicadas» sin nada que
-- las respalde.
--
-- SE NIEGA A BORRAR HISTORIA
--
-- Si hay una sola decisión de recepción, movimiento de compra, saldo u
-- operación de recepción, este script aborta y no toca nada. Una decisión de
-- recepción es irrepetible: dice que alguien miró un comprobante, cargó cuándo
-- llegó la mercadería y se hizo cargo. Borrarla deja el comprobante como
-- pendiente otra vez, y el próximo que lo mire lo va a recibir de nuevo. Para
-- volver atrás con historia escrita está el respaldo.
--
-- Cuenta también las decisiones SIN movimientos —INCLUIDA_EN_APERTURA y
-- EXCLUIDA— a propósito: son las que menos se ven y las que más caro salen,
-- porque su valor es justamente impedir una segunda recepción.
--
-- NO USA CASCADE. Un CASCADE escondería lo que hay que ver: qué depende de
-- qué. Si algo no se puede borrar, tiene que decirlo con nombre.
--
-- ESTE ARCHIVO **NO** revierte la migración del corte con zona horaria
-- (`20260924090000_stock_erp_corte_con_zona`). Esa tiene su propio archivo y se
-- corre después de éste, porque el interruptor de recepciones que agrega es
-- justo el que vigila la tabla que acá se borra.

BEGIN;

-- 1. Frená si hay historia que se perdería.
DO $$
DECLARE
  recepciones bigint;
  aplicadas bigint;
  ingresos bigint;
  operaciones bigint;
  saldos_de_compra bigint;
BEGIN
  SELECT count(*) INTO recepciones FROM "stock_receipt";
  SELECT count(*) INTO aplicadas   FROM "stock_receipt" WHERE "resolution" = 'APLICADA';
  SELECT count(*) INTO ingresos    FROM "stock_ledger"  WHERE "type" = 'PURCHASE_IN';
  SELECT count(*) INTO operaciones FROM "stock_operation" WHERE "kind" = 'RECEPCION_COMPRA';
  SELECT count(*) INTO saldos_de_compra
    FROM "stock_balance" WHERE "openingSource" = 'POSTERIOR_AL_CORTE';

  IF recepciones > 0 OR ingresos > 0 OR operaciones > 0 OR saldos_de_compra > 0 THEN
    RAISE EXCEPTION
      'No se revierte la fase 4: hay % decisión(es) de recepción (% aplicada/s), '
      '% ingreso(s) de compra en el libro, % operación(es) de recepción y % saldo(s) '
      'nacido(s) de una compra posterior al corte. Volver atrás borraría historia '
      'que nadie puede reconstruir: un comprobante ya recibido volvería a figurar '
      'como pendiente. Si de verdad hay que hacerlo, se restaura desde el respaldo.',
      recepciones, aplicadas, ingresos, operaciones, saldos_de_compra;
  END IF;
END $$;

-- 2. Los disparadores propios de esta fase.
DROP TRIGGER IF EXISTS "stock_ingreso_posterior_al_corte" ON "stock_ledger";
DROP FUNCTION IF EXISTS stock_ingreso_posterior_al_corte();
DROP TRIGGER IF EXISTS "stock_recepcion_permitida" ON "stock_receipt";
DROP FUNCTION IF EXISTS stock_recepcion_permitida();
DROP TRIGGER IF EXISTS "stock_recepcion_inmutable" ON "stock_receipt";
DROP FUNCTION IF EXISTS stock_recepcion_inmutable();

-- 3. La función de reinicio de las bases de prueba vuelve a su lista anterior.
--
-- Tiene que volver EXACTAMENTE a la versión de la fase 1: si quedara nombrando
-- `stock_receipt`, la siguiente corrida de pruebas fallaría al truncar una
-- tabla que ya no existe.
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

  TRUNCATE TABLE
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
END;
$$ LANGUAGE plpgsql;

-- 4. El vínculo del libro con el renglón del comprobante.
--
-- La COLUMNA `documentItemId` no se toca: existía desde la fase 1 como texto
-- suelto y no es de esta fase. Lo que se saca es la clave foránea y el índice
-- que agregó la fase 4.
DROP INDEX IF EXISTS "stock_ledger_documentItemId_idx";
ALTER TABLE "stock_ledger"
  DROP CONSTRAINT IF EXISTS "stock_ledger_documentItemId_fkey";

-- 5. La tabla de decisiones.
--
-- Se borra entera, y el DO de arriba ya garantizó que está vacía. Si tuviera
-- filas, el script nunca llegó hasta acá.
DROP TABLE IF EXISTS "stock_receipt";
DROP TYPE IF EXISTS "StockReceiptResolution";

-- 6. Desregistrar la migración.
DELETE FROM "_prisma_migrations"
 WHERE migration_name = '20260924100000_stock_erp_fase_4_recepcion';

COMMIT;
