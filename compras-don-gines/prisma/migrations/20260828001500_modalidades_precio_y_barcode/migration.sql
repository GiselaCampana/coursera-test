ALTER TABLE "products"
  ADD COLUMN "alCorteHormaDigitalMarginPct" DECIMAL(9,6),
  ADD COLUMN "alCorteHormaCashMarginPct" DECIMAL(9,6),
  ADD COLUMN "alCorteCajaCashMarginPct" DECIMAL(9,6),
  ADD COLUMN "feteado100gMarginPct" DECIMAL(9,6),
  ADD COLUMN "feteadoQuarterMarginPct" DECIMAL(9,6),
  ADD COLUMN "feteadoPieceDigitalMarginPct" DECIMAL(9,6),
  ADD COLUMN "feteadoPieceCashMarginPct" DECIMAL(9,6),
  ADD COLUMN "wholeUnitMarginPct" DECIMAL(9,6),
  ADD COLUMN "usesPlu" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "barcode" TEXT;

-- El descuento queda en cero hacia adelante: el efectivo se forma con su propio marcaje.
UPDATE "products" SET "cashDiscountPct" = 0;

CREATE UNIQUE INDEX "products_barcode_key" ON "products"("barcode");
