-- Marcajes por familia de artículos.
--
-- El marcaje casi nunca es una decisión por artículo: los quesos duros se
-- marcan igual entre ellos y los fiambres cocidos también. Cargarlo una vez por
-- PLU son treinta oportunidades de que uno quede distinto sin que nadie se
-- entere hasta que sale mal un precio.
--
-- Todo aditivo. Las columnas nuevas de la familia nacen en NULL, que significa
-- "esta familia no dice nada" y deja a cada artículo resolviendo como hasta
-- ahora.
ALTER TABLE "product_families" ADD COLUMN IF NOT EXISTS "targetMarginPct" DECIMAL(9,6);
ALTER TABLE "product_families" ADD COLUMN IF NOT EXISTS "marginBasis" "MarginBasis";
ALTER TABLE "product_families" ADD COLUMN IF NOT EXISTS "alCorteHormaDigitalMarginPct" DECIMAL(9,6);
ALTER TABLE "product_families" ADD COLUMN IF NOT EXISTS "alCorteHormaCashMarginPct" DECIMAL(9,6);
ALTER TABLE "product_families" ADD COLUMN IF NOT EXISTS "alCorteCajaCashMarginPct" DECIMAL(9,6);
ALTER TABLE "product_families" ADD COLUMN IF NOT EXISTS "feteado100gMarginPct" DECIMAL(9,6);
ALTER TABLE "product_families" ADD COLUMN IF NOT EXISTS "feteadoQuarterMarginPct" DECIMAL(9,6);
ALTER TABLE "product_families" ADD COLUMN IF NOT EXISTS "feteadoPieceDigitalMarginPct" DECIMAL(9,6);
ALTER TABLE "product_families" ADD COLUMN IF NOT EXISTS "feteadoPieceCashMarginPct" DECIMAL(9,6);
ALTER TABLE "product_families" ADD COLUMN IF NOT EXISTS "wholeUnitMarginPct" DECIMAL(9,6);

-- El marcaje base del artículo pasa a poder estar vacío, que es lo que le
-- permite heredar el de su familia.
--
-- Nadie pierde su valor: los artículos ya cargados lo conservan tal cual, y
-- quedan exactamente como estaban. Vaciarlo es a partir de ahora una decisión
-- explícita de heredar, no un descuido: el formulario lo dice.
ALTER TABLE "products" ALTER COLUMN "targetMarginPct" DROP NOT NULL;
ALTER TABLE "products" ALTER COLUMN "targetMarginPct" DROP DEFAULT;
ALTER TABLE "products" ALTER COLUMN "marginBasis" DROP NOT NULL;
ALTER TABLE "products" ALTER COLUMN "marginBasis" DROP DEFAULT;
