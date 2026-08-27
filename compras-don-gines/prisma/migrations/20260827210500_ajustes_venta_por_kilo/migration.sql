-- Ajustes confirmados por operación de Don Ginés.
-- No cambian compras ni importes históricos: sólo cómo se interpreta el costo
-- para formar el precio de venta por kilo.

UPDATE "products"
SET "saleMode" = 'AL_CORTE'
WHERE "internalCode" = '1603'; -- Goya Melincué

UPDATE "products"
SET
  "purchaseUnit" = 'UNIT',
  "purchaseUnitWeightKg" = 5,
  "saleMode" = 'AL_CORTE'
WHERE "internalCode" IN ('3000', '3001', '3010', '3011'); -- dulces lata/cajón, 5 kg

UPDATE "products"
SET
  "purchaseUnit" = 'UNIT',
  "purchaseUnitWeightKg" = 3,
  "saleMode" = 'AL_CORTE'
WHERE "internalCode" IN ('3020', '3021'); -- postre de maní, 3 kg
