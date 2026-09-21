-- CreateEnum
CREATE TYPE "StockUnit" AS ENUM ('KG', 'UNIT');

-- CreateEnum
CREATE TYPE "StockConfigStatus" AS ENUM ('PENDIENTE', 'APROBADA');

-- CreateEnum
CREATE TYPE "StockActivationState" AS ENUM ('SIN_INICIAR', 'PENDIENTE_CONFIGURACION', 'LISTO_PARA_CONTAR', 'ACTIVO', 'NO_SE_MANEJA', 'INACTIVO');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('OPENING_BALANCE', 'PURCHASE_IN', 'SALE_OUT', 'CUSTOMER_RETURN_IN', 'SUPPLIER_RETURN_OUT', 'TRANSFER_OUT', 'TRANSFER_IN', 'WASTE_OUT', 'INTERNAL_USE_OUT', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'INVENTORY_CORRECTION');

-- CreateEnum
CREATE TYPE "StockDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "StockOperationKind" AS ENUM ('ACTIVACION', 'RECEPCION_COMPRA', 'TRASLADO', 'AJUSTE', 'REVERSION');

-- CreateEnum
CREATE TYPE "StockCountSessionStatus" AS ENUM ('ABIERTA', 'CERRADA');

-- CreateEnum
CREATE TYPE "StockTransferStatus" AS ENUM ('APLICADO', 'REVERSADO');

-- CreateEnum
CREATE TYPE "StockOpeningSource" AS ENUM ('APERTURA', 'POSTERIOR_AL_CORTE');

-- CreateTable
CREATE TABLE "product_stock_config" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "stockUnit" "StockUnit",
    "status" "StockConfigStatus" NOT NULL DEFAULT 'PENDIENTE',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_stock_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_stock_config_history" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "campo" TEXT NOT NULL,
    "antes" TEXT,
    "despues" TEXT,
    "reason" TEXT NOT NULL,
    "userId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_stock_config_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_purchase_presentation" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "supplierId" TEXT,
    "supplierCode" TEXT,
    "purchaseUnit" "StockUnit" NOT NULL,
    "conversionFactor" DECIMAL NOT NULL,
    "description" TEXT,
    "status" "StockConfigStatus" NOT NULL DEFAULT 'PENDIENTE',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_purchase_presentation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_count_session" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "StockCountSessionStatus" NOT NULL DEFAULT 'ABIERTA',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "stock_count_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_stock_activation" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "state" "StockActivationState" NOT NULL DEFAULT 'SIN_INICIAR',
    "cutoffAt" TIMESTAMP(3),
    "openingLedgerId" TEXT,
    "reason" TEXT,
    "activatedById" TEXT,
    "activatedAt" TIMESTAMP(3),
    "sessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_stock_activation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_operation" (
    "id" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "kind" "StockOperationKind" NOT NULL,
    "hashVersion" INTEGER NOT NULL DEFAULT 1,
    "contentHash" TEXT NOT NULL,
    "documentId" TEXT,
    "branchId" TEXT,
    "requestedById" TEXT,
    "receivedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "movementCount" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "reversesOperationId" TEXT,

    CONSTRAINT "stock_operation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_ledger" (
    "id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "txId" BIGINT NOT NULL,
    "productId" TEXT NOT NULL,
    "pluHistorico" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "direction" "StockDirection" NOT NULL,
    "quantity" DECIMAL NOT NULL,
    "unit" "StockUnit" NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "reason" TEXT,
    "notes" TEXT,
    "sourceSystem" TEXT NOT NULL DEFAULT 'compras-don-gines',
    "documentId" TEXT,
    "documentItemId" TEXT,
    "operationId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "reversesId" TEXT,
    "transferLineId" TEXT,
    "balanceAfterSeq" DECIMAL NOT NULL,
    "invoicedQuantity" DECIMAL,
    "invoicedUnit" "StockUnit",
    "pieceCount" INTEGER,
    "realWeightKg" DECIMAL,
    "conversionFactorUsed" DECIMAL,

    CONSTRAINT "stock_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balance" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "quantity" DECIMAL NOT NULL,
    "unit" "StockUnit" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "lastLedgerId" TEXT NOT NULL,
    "lastOperationId" TEXT NOT NULL,
    "openingSource" "StockOpeningSource" NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_balance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer" (
    "id" TEXT NOT NULL,
    "fromBranchId" TEXT NOT NULL,
    "toBranchId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "status" "StockTransferStatus" NOT NULL DEFAULT 'APLICADO',
    "userId" TEXT,
    "reason" TEXT,
    "reversesTransferId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_transfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer_line" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL NOT NULL,
    "unit" "StockUnit" NOT NULL,

    CONSTRAINT "stock_transfer_line_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_stock_config_productId_key" ON "product_stock_config"("productId");

-- CreateIndex
CREATE INDEX "product_stock_config_history_configId_at_idx" ON "product_stock_config_history"("configId", "at");

-- CreateIndex
CREATE INDEX "product_purchase_presentation_productId_idx" ON "product_purchase_presentation"("productId");

-- CreateIndex
CREATE INDEX "stock_count_session_branchId_status_idx" ON "stock_count_session"("branchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "product_stock_activation_openingLedgerId_key" ON "product_stock_activation"("openingLedgerId");

-- CreateIndex
CREATE INDEX "product_stock_activation_branchId_state_idx" ON "product_stock_activation"("branchId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "product_stock_activation_productId_branchId_key" ON "product_stock_activation"("productId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_operation_operationKey_key" ON "stock_operation"("operationKey");

-- CreateIndex
CREATE UNIQUE INDEX "stock_operation_reversesOperationId_key" ON "stock_operation"("reversesOperationId");

-- CreateIndex
CREATE INDEX "stock_operation_kind_appliedAt_idx" ON "stock_operation"("kind", "appliedAt");

-- CreateIndex
CREATE INDEX "stock_operation_documentId_idx" ON "stock_operation"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_ledger_seq_key" ON "stock_ledger"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "stock_ledger_idempotencyKey_key" ON "stock_ledger"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "stock_ledger_reversesId_key" ON "stock_ledger"("reversesId");

-- CreateIndex
CREATE INDEX "stock_ledger_productId_branchId_effectiveAt_idx" ON "stock_ledger"("productId", "branchId", "effectiveAt");

-- CreateIndex
CREATE INDEX "stock_ledger_branchId_effectiveAt_idx" ON "stock_ledger"("branchId", "effectiveAt");

-- CreateIndex
CREATE INDEX "stock_ledger_operationId_idx" ON "stock_ledger"("operationId");

-- CreateIndex
CREATE INDEX "stock_ledger_documentId_idx" ON "stock_ledger"("documentId");

-- CreateIndex
CREATE INDEX "stock_balance_branchId_idx" ON "stock_balance"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_balance_productId_branchId_key" ON "stock_balance"("productId", "branchId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfer_reversesTransferId_key" ON "stock_transfer"("reversesTransferId");

-- CreateIndex
CREATE INDEX "stock_transfer_fromBranchId_idx" ON "stock_transfer"("fromBranchId");

-- CreateIndex
CREATE INDEX "stock_transfer_toBranchId_idx" ON "stock_transfer"("toBranchId");

-- CreateIndex
CREATE INDEX "stock_transfer_line_transferId_idx" ON "stock_transfer_line"("transferId");

-- AddForeignKey
ALTER TABLE "product_stock_config" ADD CONSTRAINT "product_stock_config_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_stock_config" ADD CONSTRAINT "product_stock_config_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_stock_config_history" ADD CONSTRAINT "product_stock_config_history_configId_fkey" FOREIGN KEY ("configId") REFERENCES "product_stock_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_purchase_presentation" ADD CONSTRAINT "product_purchase_presentation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_purchase_presentation" ADD CONSTRAINT "product_purchase_presentation_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count_session" ADD CONSTRAINT "stock_count_session_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count_session" ADD CONSTRAINT "stock_count_session_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_stock_activation" ADD CONSTRAINT "product_stock_activation_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_stock_activation" ADD CONSTRAINT "product_stock_activation_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_stock_activation" ADD CONSTRAINT "product_stock_activation_openingLedgerId_fkey" FOREIGN KEY ("openingLedgerId") REFERENCES "stock_ledger"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_stock_activation" ADD CONSTRAINT "product_stock_activation_activatedById_fkey" FOREIGN KEY ("activatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_stock_activation" ADD CONSTRAINT "product_stock_activation_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "stock_count_session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_operation" ADD CONSTRAINT "stock_operation_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_operation" ADD CONSTRAINT "stock_operation_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_operation" ADD CONSTRAINT "stock_operation_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_operation" ADD CONSTRAINT "stock_operation_reversesOperationId_fkey" FOREIGN KEY ("reversesOperationId") REFERENCES "stock_operation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "stock_operation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "stock_ledger"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_transferLineId_fkey" FOREIGN KEY ("transferLineId") REFERENCES "stock_transfer_line"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer" ADD CONSTRAINT "stock_transfer_fromBranchId_fkey" FOREIGN KEY ("fromBranchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer" ADD CONSTRAINT "stock_transfer_toBranchId_fkey" FOREIGN KEY ("toBranchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer" ADD CONSTRAINT "stock_transfer_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "stock_operation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer" ADD CONSTRAINT "stock_transfer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer" ADD CONSTRAINT "stock_transfer_reversesTransferId_fkey" FOREIGN KEY ("reversesTransferId") REFERENCES "stock_transfer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_line" ADD CONSTRAINT "stock_transfer_line_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "stock_transfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_line" ADD CONSTRAINT "stock_transfer_line_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
--  Las garantías del Stock ERP, en la base y no en la aplicación.
--
--  Lo que sigue no es decoración defensiva: cada restricción existe porque su
--  ausencia produce un error que no se ve. Un saldo negativo silencioso, una
--  cantidad redondeada sin avisar o una apertura repetida no rompen nada en el
--  momento: rompen el inventario semanas después, cuando ya nadie sabe cuál de
--  los números era el bueno.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Cantidades: tres decimales de verdad, no por promesa
--
-- `NUMERIC(14,3)` NO sirve: PostgreSQL redondea 4.2401 a 4.240 ANTES de correr
-- el CHECK, así que la restricción nunca ve el valor original. Comprobado.
-- Por eso las columnas son `DECIMAL` **sin escala declarada**: así el valor
-- llega entero a la restricción y `= round(v,3)` lo rechaza.
--
-- El máximo existe por el mismo motivo por el que no hay escala: un NUMERIC sin
-- precisión acepta cantidades absurdas. Un millón de kilos de queso en una
-- sucursal es un error de tipeo, no una compra.
-- ---------------------------------------------------------------------------

ALTER TABLE "stock_ledger"
  ADD CONSTRAINT "stock_ledger_cantidad_escala"
    CHECK ("quantity" = round("quantity", 3)),
  ADD CONSTRAINT "stock_ledger_cantidad_maximo"
    CHECK ("quantity" <= 1000000),
  -- Positiva, salvo la apertura: un cero contado y confirmado es una
  -- afirmación que tiene que poder escribirse en el libro.
  ADD CONSTRAINT "stock_ledger_cantidad_positiva"
    CHECK ("quantity" > 0 OR ("type" = 'OPENING_BALANCE' AND "quantity" = 0)),
  ADD CONSTRAINT "stock_ledger_saldo_escala"
    CHECK ("balanceAfterSeq" = round("balanceAfterSeq", 3)),
  ADD CONSTRAINT "stock_ledger_saldo_no_negativo"
    CHECK ("balanceAfterSeq" >= 0),
  ADD CONSTRAINT "stock_ledger_saldo_maximo"
    CHECK ("balanceAfterSeq" <= 1000000),
  ADD CONSTRAINT "stock_ledger_facturado_escala"
    CHECK ("invoicedQuantity" IS NULL
           OR ("invoicedQuantity" > 0 AND "invoicedQuantity" = round("invoicedQuantity", 3)
               AND "invoicedQuantity" <= 1000000)),
  ADD CONSTRAINT "stock_ledger_peso_escala"
    CHECK ("realWeightKg" IS NULL
           OR ("realWeightKg" > 0 AND "realWeightKg" = round("realWeightKg", 3)
               AND "realWeightKg" <= 1000000)),
  ADD CONSTRAINT "stock_ledger_piezas_positivas"
    CHECK ("pieceCount" IS NULL OR "pieceCount" > 0),
  ADD CONSTRAINT "stock_ledger_factor_positivo"
    CHECK ("conversionFactorUsed" IS NULL OR "conversionFactorUsed" > 0);

ALTER TABLE "stock_balance"
  ADD CONSTRAINT "stock_balance_no_negativo"  CHECK ("quantity" >= 0),
  ADD CONSTRAINT "stock_balance_escala"       CHECK ("quantity" = round("quantity", 3)),
  ADD CONSTRAINT "stock_balance_maximo"       CHECK ("quantity" <= 1000000);

ALTER TABLE "stock_transfer_line"
  ADD CONSTRAINT "stock_transfer_line_cantidad"
    CHECK ("quantity" > 0 AND "quantity" = round("quantity", 3) AND "quantity" <= 1000000);

ALTER TABLE "product_purchase_presentation"
  ADD CONSTRAINT "presentacion_factor_positivo"
    CHECK ("conversionFactor" > 0 AND "conversionFactor" = round("conversionFactor", 6));

-- ---------------------------------------------------------------------------
-- 2. Tipo, dirección y reversión
--
-- Cada tipo tiene su dirección canónica. Una reversión conserva el tipo —así se
-- sabe QUÉ se reversó— y lleva la dirección opuesta. Sin esta distinción, o la
-- reversión es imposible o la dirección deja de significar algo.
-- ---------------------------------------------------------------------------

ALTER TABLE "stock_ledger"
  ADD CONSTRAINT "stock_ledger_tipo_direccion" CHECK (
    CASE
      WHEN "type" = 'INVENTORY_CORRECTION' THEN TRUE
      WHEN "reversesId" IS NULL THEN
        "direction" = CASE
          WHEN "type" IN ('OPENING_BALANCE','PURCHASE_IN','CUSTOMER_RETURN_IN',
                          'TRANSFER_IN','ADJUSTMENT_IN')
            THEN 'IN'::"StockDirection"
          ELSE 'OUT'::"StockDirection"
        END
      ELSE
        "direction" = CASE
          WHEN "type" IN ('OPENING_BALANCE','PURCHASE_IN','CUSTOMER_RETURN_IN',
                          'TRANSFER_IN','ADJUSTMENT_IN')
            THEN 'OUT'::"StockDirection"
          ELSE 'IN'::"StockDirection"
        END
    END
  ),
  -- Una reversión sin motivo es un número que aparece sin explicación.
  ADD CONSTRAINT "stock_ledger_reversion_con_motivo"
    CHECK ("reversesId" IS NULL OR "reason" IS NOT NULL),
  -- Los traslados llevan renglón, y sólo ellos.
  ADD CONSTRAINT "stock_ledger_traslado_con_renglon"
    CHECK (("type" IN ('TRANSFER_OUT','TRANSFER_IN')) = ("transferLineId" IS NOT NULL));

-- Una sola apertura por artículo y sucursal. Es la garantía central de la
-- activación gradual: reabrir sería reescribir el punto de partida.
CREATE UNIQUE INDEX "stock_ledger_una_apertura_por_producto_sucursal"
  ON "stock_ledger" ("productId", "branchId")
  WHERE "type" = 'OPENING_BALANCE';

-- ---------------------------------------------------------------------------
-- 3. Configuración y activación
-- ---------------------------------------------------------------------------

ALTER TABLE "product_stock_config"
  ADD CONSTRAINT "config_aprobada_exige_unidad" CHECK (
    "status" <> 'APROBADA'
    OR ("stockUnit" IS NOT NULL AND "approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL)
  );

ALTER TABLE "product_purchase_presentation"
  ADD CONSTRAINT "presentacion_aprobada_exige_aprobador" CHECK (
    "status" <> 'APROBADA' OR ("approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL)
  );

-- Un UNIQUE común con columnas nulas permite duplicados en PostgreSQL: dos
-- filas con supplierId NULL no se consideran iguales. Por eso van índices
-- parciales, uno por cada forma que puede tomar la presentación.
CREATE UNIQUE INDEX "presentacion_general_por_producto"
  ON "product_purchase_presentation" ("productId")
  WHERE "supplierId" IS NULL AND "supplierCode" IS NULL;

CREATE UNIQUE INDEX "presentacion_por_proveedor"
  ON "product_purchase_presentation" ("productId", "supplierId")
  WHERE "supplierId" IS NOT NULL AND "supplierCode" IS NULL;

CREATE UNIQUE INDEX "presentacion_por_codigo_de_proveedor"
  ON "product_purchase_presentation" ("productId", "supplierId", "supplierCode")
  WHERE "supplierCode" IS NOT NULL;

ALTER TABLE "product_stock_activation"
  ADD CONSTRAINT "activacion_activo_exige_apertura" CHECK (
    "state" <> 'ACTIVO'
    OR ("cutoffAt" IS NOT NULL AND "openingLedgerId" IS NOT NULL
        AND "activatedById" IS NOT NULL AND "activatedAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "activacion_no_se_maneja_exige_motivo" CHECK (
    "state" <> 'NO_SE_MANEJA' OR "reason" IS NOT NULL
  );

-- ---------------------------------------------------------------------------
-- 4. El libro no se toca
--
-- UPDATE, DELETE y TRUNCATE. Los tres, porque TRUNCATE no dispara los
-- disparadores de fila y sería la forma más rápida de perder el inventario.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION stock_ledger_inmutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'El libro de stock es inmutable: % sobre stock_ledger no está permitido. '
    'Los errores se corrigen con una reversión o un ajuste vinculado.',
    TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "stock_ledger_sin_update"
  BEFORE UPDATE ON "stock_ledger"
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_inmutable();

CREATE TRIGGER "stock_ledger_sin_delete"
  BEFORE DELETE ON "stock_ledger"
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_inmutable();

CREATE TRIGGER "stock_ledger_sin_truncate"
  BEFORE TRUNCATE ON "stock_ledger"
  FOR EACH STATEMENT EXECUTE FUNCTION stock_ledger_inmutable();

-- ---------------------------------------------------------------------------
-- 5. La reversión es coherente con lo que reversa
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION stock_ledger_reversion_coherente() RETURNS trigger AS $$
DECLARE original "stock_ledger"%ROWTYPE;
BEGIN
  IF NEW."reversesId" IS NULL THEN RETURN NEW; END IF;

  SELECT * INTO original FROM "stock_ledger" WHERE id = NEW."reversesId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La reversión apunta a un movimiento que no existe.';
  END IF;
  IF original."reversesId" IS NOT NULL THEN
    RAISE EXCEPTION 'Una reversión no se reversa: se corrige con un ajuste.';
  END IF;
  IF original."productId" <> NEW."productId"
     OR original."branchId" <> NEW."branchId"
     OR original."unit" <> NEW."unit"
     OR original."quantity" <> NEW."quantity"
     OR original."type" <> NEW."type" THEN
    RAISE EXCEPTION
      'La reversión tiene que coincidir con el original en artículo, sucursal, '
      'unidad, cantidad y tipo.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "stock_ledger_reversion_coherente"
  BEFORE INSERT ON "stock_ledger"
  FOR EACH ROW EXECUTE FUNCTION stock_ledger_reversion_coherente();

-- ---------------------------------------------------------------------------
-- 6. El saldo no se mueve sin un movimiento
--
-- Ésta es la que impide la corrupción más difícil de detectar: alguien
-- actualiza el saldo directamente y el libro deja de explicarlo. El saldo
-- tiene que apuntar a un movimiento de LA MISMA transacción, del mismo
-- artículo, sucursal, unidad y operación, y cuyo saldo posterior sea
-- exactamente el nuevo saldo.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION stock_balance_respaldado() RETURNS trigger AS $$
DECLARE mov "stock_ledger"%ROWTYPE;
BEGIN
  SELECT * INTO mov FROM "stock_ledger" WHERE id = NEW."lastLedgerId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El saldo apunta a un movimiento que no existe.';
  END IF;
  IF mov."txId" <> txid_current() THEN
    RAISE EXCEPTION
      'El saldo sólo se escribe junto con su movimiento, en la misma '
      'transacción. Nadie actualiza saldos por afuera.';
  END IF;
  IF mov."productId" <> NEW."productId" OR mov."branchId" <> NEW."branchId"
     OR mov."unit" <> NEW."unit" OR mov."operationId" <> NEW."lastOperationId" THEN
    RAISE EXCEPTION
      'El saldo y su movimiento tienen que ser del mismo artículo, sucursal, '
      'unidad y operación.';
  END IF;
  IF mov."balanceAfterSeq" <> NEW."quantity" THEN
    RAISE EXCEPTION
      'El saldo (%) no coincide con el saldo posterior del movimiento (%).',
      NEW."quantity", mov."balanceAfterSeq";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "stock_balance_respaldado"
  BEFORE INSERT OR UPDATE ON "stock_balance"
  FOR EACH ROW EXECUTE FUNCTION stock_balance_respaldado();

-- ---------------------------------------------------------------------------
-- 7. Una operación aplicada no se reescribe
--
-- Su resultado se completa una sola vez, dentro de la misma transacción que la
-- creó; su identidad y su huella no cambian nunca. Si pudieran cambiar, la
-- idempotencia no valdría nada: bastaría con reescribir la huella para que un
-- contenido distinto pasara por «ya aplicado».
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION stock_operation_inmutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Una operación aplicada no se borra.';
  END IF;
  IF OLD."operationKey" <> NEW."operationKey"
     OR OLD."contentHash" <> NEW."contentHash"
     OR OLD."hashVersion" <> NEW."hashVersion"
     OR OLD."kind" <> NEW."kind"
     OR OLD."appliedAt" <> NEW."appliedAt" THEN
    RAISE EXCEPTION 'La identidad y la huella de una operación no se modifican.';
  END IF;
  IF OLD."result" IS NOT NULL AND NEW."result" IS DISTINCT FROM OLD."result" THEN
    RAISE EXCEPTION 'El resultado de una operación se escribe una sola vez.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "stock_operation_inmutable"
  BEFORE UPDATE OR DELETE ON "stock_operation"
  FOR EACH ROW EXECUTE FUNCTION stock_operation_inmutable();

-- ---------------------------------------------------------------------------
-- 8. La activación inicial tampoco se reescribe
--
-- Un artículo se activa una vez. Después puede darse de baja, pero su punto de
-- partida —el corte y la apertura que lo fijó— queda donde está.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION stock_activacion_inicial_inmutable() RETURNS trigger AS $$
BEGIN
  IF OLD."openingLedgerId" IS NOT NULL
     AND NEW."openingLedgerId" IS DISTINCT FROM OLD."openingLedgerId" THEN
    RAISE EXCEPTION 'La apertura de un artículo no se reasigna.';
  END IF;
  IF OLD."cutoffAt" IS NOT NULL AND NEW."cutoffAt" IS DISTINCT FROM OLD."cutoffAt" THEN
    RAISE EXCEPTION 'El corte de un artículo ya activado no se mueve.';
  END IF;
  IF OLD."state" = 'ACTIVO'
     AND NEW."state" IN ('SIN_INICIAR','LISTO_PARA_CONTAR','PENDIENTE_CONFIGURACION') THEN
    RAISE EXCEPTION
      'Un artículo activo no vuelve a estar sin iniciar. Las diferencias se '
      'corrigen con INVENTORY_CORRECTION.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "stock_activacion_inicial_inmutable"
  BEFORE UPDATE ON "product_stock_activation"
  FOR EACH ROW EXECUTE FUNCTION stock_activacion_inicial_inmutable();

-- ---------------------------------------------------------------------------
-- 9. Un traslado llega entero o no llega
--
-- Se comprueba al COMMIT y no en cada fila, porque las dos mitades se escriben
-- una después de la otra: mirar demasiado temprano haría fallar un traslado
-- correcto.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION stock_traslado_completo() RETURNS trigger AS $$
DECLARE
  renglon "stock_transfer_line"%ROWTYPE;
  cab     "stock_transfer"%ROWTYPE;
  salidas INT;
  entradas INT;
BEGIN
  SELECT * INTO renglon FROM "stock_transfer_line" WHERE id = NEW."transferLineId";
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT * INTO cab FROM "stock_transfer" WHERE id = renglon."transferId";

  IF cab."fromBranchId" = cab."toBranchId" THEN
    RAISE EXCEPTION 'Un traslado necesita dos sucursales distintas.';
  END IF;

  SELECT
    count(*) FILTER (WHERE "type" = 'TRANSFER_OUT' AND "branchId" = cab."fromBranchId"),
    count(*) FILTER (WHERE "type" = 'TRANSFER_IN'  AND "branchId" = cab."toBranchId")
  INTO salidas, entradas
  FROM "stock_ledger"
  WHERE "transferLineId" = renglon.id
    AND "productId" = renglon."productId"
    AND "unit" = renglon."unit"
    AND "quantity" = renglon."quantity";

  IF salidas <> 1 OR entradas <> 1 THEN
    RAISE EXCEPTION
      'Cada renglón de traslado necesita exactamente una salida en % y una '
      'entrada en %, del mismo artículo, unidad y cantidad. Se encontraron % y %.',
      cab."fromBranchId", cab."toBranchId", salidas, entradas;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "stock_traslado_completo"
  AFTER INSERT ON "stock_ledger"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION stock_traslado_completo();

-- ---------------------------------------------------------------------------
-- 10. Reiniciar las bases de prueba sin debilitar producción
--
-- La guarda vive en la base y mira el nombre de la base, que es la misma regla
-- que ya usa el sembrador antes de borrar tablas. En producción esta función
-- existe y siempre falla.
--
-- La lista de tablas es explícita y NO usa CASCADE: un CASCADE podría alcanzar
-- tablas comerciales que no tienen nada que ver con el Stock ERP.
-- ---------------------------------------------------------------------------

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
