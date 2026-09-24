-- Rollback de la corrección previa a la fase 4: el corte con zona horaria.
--
-- ORDEN: se corre DESPUÉS del rollback de la fase 4 y ANTES del de la fase 3.
-- Después de la 4 porque el interruptor de recepciones que esta migración
-- agrega es el que vigila la tabla `stock_receipt`; antes de la 3 porque la
-- fase 3 borra `stock_module_setting` entera y entonces no quedaría nada que
-- revertir acá.
--
-- SE NIEGA A BORRAR HISTORIA
--
-- Si hay una activación con corte, revertir el tipo de la columna la vuelve a
-- una fecha sin zona. Eso no pierde el instante —la conversión inversa es
-- exacta— pero sí pierde la garantía de que los dos cortes sean comparables,
-- que es todo el punto de la migración. Así que aborta si hay cortes fijados,
-- por la misma razón que los otros rollbacks: volver atrás con datos escritos
-- deja un estado que nadie puede explicar después.
--
-- SOBRE LA CONVERSIÓN INVERSA
--
-- `AT TIME ZONE 'UTC'` sobre un TIMESTAMPTZ devuelve la hora de pared UTC de
-- ese instante, que es exactamente el texto que Prisma había guardado antes de
-- la migración. Es la operación inversa de la de ida, no una aproximación.

BEGIN;

-- 1. Frená si hay cortes fijados.
DO $$
DECLARE
  activaciones bigint;
  sesiones bigint;
  interruptor_encendido boolean;
BEGIN
  SELECT count(*) INTO activaciones
    FROM "product_stock_activation" WHERE "cutoffAt" IS NOT NULL;
  SELECT count(*) INTO sesiones
    FROM "stock_count_session" WHERE "cutoffAt" IS NOT NULL;
  SELECT bool_or("realPurchaseReceiptsEnabled") INTO interruptor_encendido
    FROM "stock_module_setting";

  IF activaciones > 0 OR sesiones > 0 THEN
    RAISE EXCEPTION
      'No se revierte la unificación del corte: hay % activación(es) y % sesión(es) '
      'con corte fijado. Volver atrás dejaría los dos cortes en representaciones '
      'distintas del tiempo, que es justamente lo que esta migración vino a '
      'arreglar. Si de verdad hay que hacerlo, se restaura desde el respaldo.',
      activaciones, sesiones;
  END IF;

  IF interruptor_encendido THEN
    RAISE EXCEPTION
      'No se revierte: el interruptor de recepciones reales está ENCENDIDO. '
      'Borrar la columna borraría la constancia de quién lo encendió y por qué. '
      'Apagalo primero, con su motivo, y volvé a intentar.';
  END IF;
END $$;

-- 2. El interruptor de recepciones reales y su auditoría.
ALTER TABLE "stock_module_setting"
  DROP CONSTRAINT IF EXISTS "stock_module_setting_recepciones_con_motivo",
  DROP CONSTRAINT IF EXISTS "stock_module_setting_receiptsChangedById_fkey";

ALTER TABLE "stock_module_setting"
  DROP COLUMN IF EXISTS "realPurchaseReceiptsEnabled",
  DROP COLUMN IF EXISTS "receiptsChangedById",
  DROP COLUMN IF EXISTS "receiptsChangedAt",
  DROP COLUMN IF EXISTS "receiptsReason";

-- 3. La columna del corte vuelve a no tener zona.
ALTER TABLE "product_stock_activation"
  ALTER COLUMN "cutoffAt" TYPE TIMESTAMP(3)
  USING "cutoffAt" AT TIME ZONE 'UTC';

-- 4. Desregistrar la migración.
DELETE FROM "_prisma_migrations"
 WHERE migration_name = '20260924090000_stock_erp_corte_con_zona';

COMMIT;
