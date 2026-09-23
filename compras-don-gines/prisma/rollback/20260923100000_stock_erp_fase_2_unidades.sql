-- Rollback de la fase 2 de Stock ERP.
--
-- ORDEN, Y NO ES UN DETALLE
--
-- Si hay que volver atrás LAS DOS fases, este archivo va PRIMERO y el de la
-- fase 1 después. Al revés queda un estado incoherente, y conviene entender por
-- qué antes de necesitarlo un día de apuro:
--
-- La fase 2 modifica `product_purchase_presentation` —le fija la escala al
-- factor y le agrega la unicidad por proveedor y código— pero esa tabla la crea
-- la fase 1. Si se revierte la fase 1 primero, la tabla desaparece con los
-- cambios de la fase 2 adentro, y la fase 2 queda REGISTRADA en
-- `_prisma_migrations` sin nada que la respalde. El día que alguien vuelva a
-- aplicar la fase 1, Prisma no va a reaplicar la fase 2 —ya figura como
-- aplicada— y la tabla renacería sin la unicidad ni la escala. Nadie se
-- enteraría hasta que aparezcan dos factores distintos para el mismo código.
--
-- Revertir SÓLO la fase 2 (dejando la 1) es seguro y es lo que hace este
-- archivo si se lo corre solo.
--
-- QUÉ NO DESHACE
--
-- `products.catalogUnit` se BORRA, y con ella los valores que hubiera traído la
-- sincronización. No es una pérdida grave: son datos externos que la próxima
-- sincronización vuelve a escribir. Pero es una pérdida, y por eso está dicho.
--
-- Nada de esto toca `purchaseUnit`, que nunca fue de esta fase.

BEGIN;

-- 1. Frená si alguien ya decidió algo sobre las presentaciones.
--
-- No porque este script las borre —no las borra— sino porque quitar la
-- unicidad sobre una tabla con filas puede dejar entrar duplicados después, y
-- eso hay que decidirlo mirando los datos, no de corrido.
DO $$
DECLARE n bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'product_purchase_presentation') THEN
    SELECT count(*) INTO n FROM product_purchase_presentation;
    IF n > 0 THEN
      RAISE EXCEPTION
        'Hay % presentaciones de compra cargadas. Quitar la unicidad con filas adentro puede dejar entrar duplicados: revisalas antes.', n;
    END IF;
  END IF;
END $$;

-- 2. Deshacer lo que la fase 2 le agregó a la fase 1.
--
-- Se usa IF EXISTS en todo: este script tiene que poder correrse sobre una base
-- donde la fase 1 ya no está, sin romperse por eso.
DROP INDEX IF EXISTS "product_purchase_presentation_producto_proveedor_codigo_key";

ALTER TABLE IF EXISTS "product_stock_config"
  DROP CONSTRAINT IF EXISTS "product_stock_config_aprobada_con_unidad";

-- La escala del factor vuelve a DECIMAL sin precisión, que es como la dejó la
-- fase 1. El CHECK `presentacion_factor_positivo` es de la fase 1 y NO se toca.
ALTER TABLE IF EXISTS "product_purchase_presentation"
  ALTER COLUMN "conversionFactor" TYPE DECIMAL;

-- 3. La columna del catálogo.
ALTER TABLE "products" DROP COLUMN IF EXISTS "catalogUnit";

-- 4. Desregistrar la migración, para que `migrate deploy` la vuelva a aplicar.
DELETE FROM "_prisma_migrations" WHERE migration_name = '20260923100000_stock_erp_fase_2_unidades';

COMMIT;
