-- La regla general pasa a ser el tercer nivel real de la cadena de marcajes.
--
-- Hasta ahora se consultaba y se descartaba: la pantalla mostraba su nombre y
-- ninguno de sus valores se aplicaba. Prometía regir algo sin regirlo, que es
-- peor que no existir.
--
-- Esta migración NO cambia ningún precio, y no depende de que el número
-- coincida: hasta la migración anterior la columna "targetMarginPct" de los
-- artículos era NOT NULL con valor por omisión, así que **todos** los artículos
-- que existen hoy tienen su propio marcaje base y le ganan a la regla general.
-- El tercer nivel sólo empieza a contestar en los artículos que de acá en más
-- se dejen vacíos a propósito.
--
-- Y por si acaso, la regla se crea con lo que el código usaba como último
-- recurso —45 % sobre el costo—, de modo que aun donde llegara a aplicar diga
-- lo mismo que antes.
--
-- Tampoco pisa nada: si ya hay una regla general activa se la deja como está,
-- con el valor que alguien haya configurado.
ALTER TABLE "pricing_rules" ADD COLUMN IF NOT EXISTS "alCorteHormaDigitalMarginPct" DECIMAL(9,6);
ALTER TABLE "pricing_rules" ADD COLUMN IF NOT EXISTS "alCorteHormaCashMarginPct" DECIMAL(9,6);
ALTER TABLE "pricing_rules" ADD COLUMN IF NOT EXISTS "alCorteCajaCashMarginPct" DECIMAL(9,6);
ALTER TABLE "pricing_rules" ADD COLUMN IF NOT EXISTS "feteado100gMarginPct" DECIMAL(9,6);
ALTER TABLE "pricing_rules" ADD COLUMN IF NOT EXISTS "feteadoQuarterMarginPct" DECIMAL(9,6);
ALTER TABLE "pricing_rules" ADD COLUMN IF NOT EXISTS "feteadoPieceDigitalMarginPct" DECIMAL(9,6);
ALTER TABLE "pricing_rules" ADD COLUMN IF NOT EXISTS "feteadoPieceCashMarginPct" DECIMAL(9,6);
ALTER TABLE "pricing_rules" ADD COLUMN IF NOT EXISTS "wholeUnitMarginPct" DECIMAL(9,6);

-- Una sola regla general, y que exista siempre.
--
-- Es la única configuración global de marcajes: sin ella, el código no tendría
-- de dónde sacar el último nivel. Se crea sólo si falta, así que reaplicar esta
-- migración no duplica nada ni pisa lo que alguien haya configurado.
INSERT INTO "pricing_rules"
  (id, "productId", name, "marginBasis", "targetMarginPct", "cashDiscountPct",
   "roundingRule", "validFrom", active, "createdAt", "updatedAt")
SELECT
  'regla-general-don-gines', NULL, 'Regla general', 'SOBRE_COSTO', 0.45, 0,
  'NEAREST_100', TIMESTAMP '2020-01-01 00:00:00', true, NOW(), NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM "pricing_rules" WHERE "productId" IS NULL AND active = true
);
