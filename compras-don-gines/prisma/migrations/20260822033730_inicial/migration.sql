-- CreateEnum
CREATE TYPE "TermType" AS ENUM ('SAME_DAY', 'DAYS', 'MANUAL');

-- CreateEnum
CREATE TYPE "PurchaseUnit" AS ENUM ('KG', 'UNIT');

-- CreateEnum
CREATE TYPE "SaleMode" AS ENUM ('FETEABLE', 'AL_CORTE');

-- CreateEnum
CREATE TYPE "MarginBasis" AS ENUM ('SOBRE_COSTO', 'SOBRE_VENTA');

-- CreateEnum
CREATE TYPE "DocType" AS ENUM ('FACTURA', 'REMITO');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('BORRADOR', 'PROCESANDO', 'REQUIERE_REVISION', 'VALIDADO', 'RECHAZADO', 'ANULADO');

-- CreateEnum
CREATE TYPE "CheckState" AS ENUM ('OK', 'RECONCILIADO', 'DIFERENCIA', 'PENDIENTE');

-- CreateEnum
CREATE TYPE "TaxLineKind" AS ENUM ('IVA', 'PERCEPCION');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('AGENDADO', 'VENCE_HOY', 'VENCIDO', 'PAGADO', 'CANCELADO');

-- CreateEnum
CREATE TYPE "PaymentEventKind" AS ENUM ('CONFIRMACION', 'CANCELACION', 'REPROGRAMACION');

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" TEXT[],
    "scopeAllBranches" BOOLEAN NOT NULL DEFAULT false,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "branchId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branches" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "tradeName" TEXT NOT NULL,
    "legalName" TEXT,
    "cuit" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'ARS',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_aliases" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_payment_terms" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "termType" "TermType" NOT NULL,
    "days" INTEGER NOT NULL DEFAULT 0,
    "paymentMethod" TEXT NOT NULL DEFAULT 'TRANSFERENCIA',
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_payment_terms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_tax_rules" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "ivaRate" DECIMAL(9,6) NOT NULL,
    "iibbRate" DECIMAL(9,6) NOT NULL DEFAULT 0,
    "otherPerceptions" JSONB NOT NULL DEFAULT '[]',
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_tax_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "internalCode" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "category" TEXT,
    "purchaseUnit" "PurchaseUnit" NOT NULL DEFAULT 'KG',
    "saleMode" "SaleMode" NOT NULL DEFAULT 'FETEABLE',
    "avgPieceWeightKg" DECIMAL(14,4),
    "defaultSupplierId" TEXT,
    "targetMarginPct" DECIMAL(9,6) NOT NULL DEFAULT 0.45,
    "marginBasis" "MarginBasis" NOT NULL DEFAULT 'SOBRE_COSTO',
    "cashDiscountPct" DECIMAL(9,6) NOT NULL DEFAULT 0.10,
    "roundingRule" TEXT NOT NULL DEFAULT 'NEAREST_100',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_aliases" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "supplierId" TEXT,
    "supplierCode" TEXT,
    "alias" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "supplierId" TEXT,
    "docType" "DocType" NOT NULL DEFAULT 'FACTURA',
    "letter" TEXT,
    "pointOfSale" TEXT NOT NULL DEFAULT '',
    "number" TEXT NOT NULL DEFAULT '',
    "fullNumber" TEXT NOT NULL DEFAULT '',
    "issueDate" TIMESTAMP(3),
    "currency" TEXT NOT NULL DEFAULT 'ARS',
    "grossSubtotal" DECIMAL(18,4),
    "discountTotal" DECIMAL(18,4),
    "netTotal" DECIMAL(18,4),
    "ivaTotal" DECIMAL(18,4),
    "perceptionsTotal" DECIMAL(18,4),
    "total" DECIMAL(18,4),
    "printedLineCount" INTEGER,
    "printedNetWeightKg" DECIMAL(14,4),
    "printedTotalUnits" DECIMAL(14,4),
    "packageCount" INTEGER,
    "status" "DocumentStatus" NOT NULL DEFAULT 'BORRADOR',
    "checkState" "CheckState" NOT NULL DEFAULT 'PENDIENTE',
    "checkReport" JSONB,
    "appliedTermType" "TermType",
    "appliedTermDays" INTEGER,
    "appliedPaymentMethod" TEXT,
    "appliedIvaRate" DECIMAL(9,6),
    "appliedIibbRate" DECIMAL(9,6),
    "appliedDueDate" TIMESTAMP(3),
    "dedupeKey" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT NOT NULL,
    "validatedById" TEXT,
    "validatedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "voidedById" TEXT,
    "voidedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_files" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "pageOrder" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalKey" TEXT,
    "mimeType" TEXT NOT NULL,
    "originalMimeType" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "originalSizeBytes" INTEGER,
    "sha256" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ocr_attempts" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "stage" TEXT NOT NULL,
    "strategy" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "rawResponse" JSONB,
    "recognizedText" TEXT,
    "overallConfidence" DECIMAL(5,4),
    "fieldConfidences" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ocr_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_tax_lines" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "kind" "TaxLineKind" NOT NULL,
    "label" TEXT NOT NULL,
    "rate" DECIMAL(9,6) NOT NULL,
    "base" DECIMAL(18,4),
    "amount" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "document_tax_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_items" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "supplierCode" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL,
    "unit" "PurchaseUnit" NOT NULL DEFAULT 'KG',
    "pieceCount" INTEGER,
    "totalWeightKg" DECIMAL(14,4),
    "avgPieceWeightKg" DECIMAL(14,4),
    "unitNetPrice" DECIMAL(18,4) NOT NULL,
    "grossSubtotal" DECIMAL(18,4) NOT NULL,
    "discountPct" DECIMAL(9,6) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(18,4) NOT NULL,
    "ivaRate" DECIMAL(9,6) NOT NULL DEFAULT 0,
    "ivaAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "perceptionAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "totalCost" DECIMAL(18,4) NOT NULL,
    "unitCost" DECIMAL(18,4) NOT NULL,
    "productId" TEXT,
    "matchMethod" TEXT NOT NULL DEFAULT 'NONE',
    "matchScore" DECIMAL(5,4),
    "confidence" JSONB,

    CONSTRAINT "document_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_schedules" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "plannedAmount" DECIMAL(18,4) NOT NULL,
    "plannedPaymentMethod" TEXT NOT NULL,
    "paidAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "status" "PaymentStatus" NOT NULL DEFAULT 'AGENDADO',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_events" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "kind" "PaymentEventKind" NOT NULL,
    "amount" DECIMAL(18,4),
    "effectiveDate" TIMESTAMP(3),
    "paymentMethod" TEXT,
    "reference" TEXT,
    "notes" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_movements" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "documentItemId" TEXT NOT NULL,
    "productId" TEXT,
    "supplierId" TEXT,
    "branchId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL,
    "unit" "PurchaseUnit" NOT NULL,
    "pieceCount" INTEGER,
    "weightKg" DECIMAL(14,4),
    "avgPieceWeightKg" DECIMAL(14,4),
    "unitNetPrice" DECIMAL(18,4) NOT NULL,
    "discountAmount" DECIMAL(18,4) NOT NULL,
    "netAmount" DECIMAL(18,4) NOT NULL,
    "ivaAmount" DECIMAL(18,4) NOT NULL,
    "perceptionAmount" DECIMAL(18,4) NOT NULL,
    "totalCost" DECIMAL(18,4) NOT NULL,
    "unitCost" DECIMAL(18,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_history" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "supplierId" TEXT,
    "branchId" TEXT,
    "documentId" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "unitNetPrice" DECIMAL(18,4) NOT NULL,
    "unitCost" DECIMAL(18,4) NOT NULL,
    "previousUnitCost" DECIMAL(18,4),
    "deltaAmount" DECIMAL(18,4),
    "deltaPct" DECIMAL(12,6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pricing_rules" (
    "id" TEXT NOT NULL,
    "productId" TEXT,
    "name" TEXT NOT NULL,
    "marginBasis" "MarginBasis" NOT NULL DEFAULT 'SOBRE_COSTO',
    "targetMarginPct" DECIMAL(9,6) NOT NULL,
    "cashDiscountPct" DECIMAL(9,6) NOT NULL DEFAULT 0,
    "roundingRule" TEXT NOT NULL DEFAULT 'NEAREST_100',
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pricing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_price_history" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "costBasis" DECIMAL(18,4) NOT NULL,
    "marginBasis" "MarginBasis" NOT NULL,
    "marginPct" DECIMAL(9,6) NOT NULL,
    "suggestedPricePerKg" DECIMAL(18,4) NOT NULL,
    "approvedPricePerKg" DECIMAL(18,4) NOT NULL,
    "pricePer100g" DECIMAL(18,4) NOT NULL,
    "pricePerQuarter" DECIMAL(18,4) NOT NULL,
    "pricePerPieceDigital" DECIMAL(18,4),
    "pricePerPieceCash" DECIMAL(18,4),
    "pieceWeightKg" DECIMAL(14,4),
    "cashDiscountPct" DECIMAL(9,6) NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_price_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_movements" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL,
    "unit" "PurchaseUnit" NOT NULL,
    "netAmount" DECIMAL(18,4) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "externalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_roleId_idx" ON "users"("roleId");

-- CreateIndex
CREATE INDEX "users_branchId_idx" ON "users"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "branches_code_key" ON "branches"("code");

-- CreateIndex
CREATE INDEX "suppliers_tradeName_idx" ON "suppliers"("tradeName");

-- CreateIndex
CREATE INDEX "supplier_aliases_normalized_idx" ON "supplier_aliases"("normalized");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_aliases_supplierId_normalized_key" ON "supplier_aliases"("supplierId", "normalized");

-- CreateIndex
CREATE INDEX "supplier_payment_terms_supplierId_validFrom_idx" ON "supplier_payment_terms"("supplierId", "validFrom");

-- CreateIndex
CREATE INDEX "supplier_tax_rules_supplierId_validFrom_idx" ON "supplier_tax_rules"("supplierId", "validFrom");

-- CreateIndex
CREATE UNIQUE INDEX "products_internalCode_key" ON "products"("internalCode");

-- CreateIndex
CREATE INDEX "products_normalizedName_idx" ON "products"("normalizedName");

-- CreateIndex
CREATE INDEX "product_aliases_normalized_idx" ON "product_aliases"("normalized");

-- CreateIndex
CREATE INDEX "product_aliases_supplierId_supplierCode_idx" ON "product_aliases"("supplierId", "supplierCode");

-- CreateIndex
CREATE UNIQUE INDEX "product_aliases_productId_supplierId_normalized_key" ON "product_aliases"("productId", "supplierId", "normalized");

-- CreateIndex
CREATE INDEX "documents_branchId_issueDate_idx" ON "documents"("branchId", "issueDate");

-- CreateIndex
CREATE INDEX "documents_supplierId_issueDate_idx" ON "documents"("supplierId", "issueDate");

-- CreateIndex
CREATE INDEX "documents_status_idx" ON "documents"("status");

-- CreateIndex
CREATE UNIQUE INDEX "documents_supplierId_docType_pointOfSale_number_dedupeKey_key" ON "documents"("supplierId", "docType", "pointOfSale", "number", "dedupeKey");

-- CreateIndex
CREATE INDEX "document_files_documentId_pageOrder_idx" ON "document_files"("documentId", "pageOrder");

-- CreateIndex
CREATE UNIQUE INDEX "document_files_documentId_sha256_key" ON "document_files"("documentId", "sha256");

-- CreateIndex
CREATE INDEX "ocr_attempts_documentId_attemptNumber_idx" ON "ocr_attempts"("documentId", "attemptNumber");

-- CreateIndex
CREATE INDEX "document_tax_lines_documentId_idx" ON "document_tax_lines"("documentId");

-- CreateIndex
CREATE INDEX "document_items_productId_idx" ON "document_items"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "document_items_documentId_lineNumber_key" ON "document_items"("documentId", "lineNumber");

-- CreateIndex
CREATE UNIQUE INDEX "payment_schedules_documentId_key" ON "payment_schedules"("documentId");

-- CreateIndex
CREATE INDEX "payment_schedules_status_dueDate_idx" ON "payment_schedules"("status", "dueDate");

-- CreateIndex
CREATE INDEX "payment_schedules_dueDate_idx" ON "payment_schedules"("dueDate");

-- CreateIndex
CREATE INDEX "payment_events_scheduleId_createdAt_idx" ON "payment_events"("scheduleId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_movements_documentItemId_key" ON "purchase_movements"("documentItemId");

-- CreateIndex
CREATE INDEX "purchase_movements_productId_date_idx" ON "purchase_movements"("productId", "date");

-- CreateIndex
CREATE INDEX "purchase_movements_supplierId_date_idx" ON "purchase_movements"("supplierId", "date");

-- CreateIndex
CREATE INDEX "purchase_movements_branchId_date_idx" ON "purchase_movements"("branchId", "date");

-- CreateIndex
CREATE INDEX "purchase_movements_date_idx" ON "purchase_movements"("date");

-- CreateIndex
CREATE INDEX "cost_history_productId_date_idx" ON "cost_history"("productId", "date");

-- CreateIndex
CREATE INDEX "pricing_rules_productId_validFrom_idx" ON "pricing_rules"("productId", "validFrom");

-- CreateIndex
CREATE INDEX "sale_price_history_productId_validFrom_idx" ON "sale_price_history"("productId", "validFrom");

-- CreateIndex
CREATE INDEX "sales_movements_productId_date_idx" ON "sales_movements"("productId", "date");

-- CreateIndex
CREATE INDEX "sales_movements_branchId_date_idx" ON "sales_movements"("branchId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "sales_movements_source_externalId_key" ON "sales_movements"("source", "externalId");

-- CreateIndex
CREATE INDEX "audit_logs_entity_entityId_idx" ON "audit_logs"("entity", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_userId_createdAt_idx" ON "audit_logs"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_aliases" ADD CONSTRAINT "supplier_aliases_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_terms" ADD CONSTRAINT "supplier_payment_terms_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_tax_rules" ADD CONSTRAINT "supplier_tax_rules_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_defaultSupplierId_fkey" FOREIGN KEY ("defaultSupplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_aliases" ADD CONSTRAINT "product_aliases_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_aliases" ADD CONSTRAINT "product_aliases_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_validatedById_fkey" FOREIGN KEY ("validatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ocr_attempts" ADD CONSTRAINT "ocr_attempts_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_tax_lines" ADD CONSTRAINT "document_tax_lines_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_items" ADD CONSTRAINT "document_items_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_items" ADD CONSTRAINT "document_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_schedules" ADD CONSTRAINT "payment_schedules_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "payment_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_movements" ADD CONSTRAINT "purchase_movements_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_movements" ADD CONSTRAINT "purchase_movements_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_movements" ADD CONSTRAINT "purchase_movements_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_movements" ADD CONSTRAINT "purchase_movements_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_history" ADD CONSTRAINT "cost_history_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_history" ADD CONSTRAINT "cost_history_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_history" ADD CONSTRAINT "cost_history_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_history" ADD CONSTRAINT "cost_history_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_price_history" ADD CONSTRAINT "sale_price_history_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_price_history" ADD CONSTRAINT "sale_price_history_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_movements" ADD CONSTRAINT "sales_movements_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_movements" ADD CONSTRAINT "sales_movements_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
