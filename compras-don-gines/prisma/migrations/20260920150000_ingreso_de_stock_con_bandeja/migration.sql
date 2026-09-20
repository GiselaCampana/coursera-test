-- La bandeja de salida de los ingresos a Control de Stock, y la clave estable
-- de cada sucursal.
--
-- Entre Compras y Control de Stock no hay una transacción: son dos aplicaciones
-- con dos bases. Anotar el movimiento en la MISMA transacción que escribe la
-- compra es lo que impide que una caída deje la mercadería pagada acá y ausente
-- allá.

CREATE TYPE "StockSyncStatus" AS ENUM ('PENDIENTE', 'EN_PROCESO', 'COMPLETADO', 'FALLIDO');

-- Con qué identificador conoce Control de Stock a cada sucursal.
-- Nulo mientras no esté confirmado: sin esto el movimiento se anota y espera.
ALTER TABLE "branches" ADD COLUMN "stockKey" TEXT;
CREATE UNIQUE INDEX "branches_stockKey_key" ON "branches"("stockKey");

CREATE TABLE "stock_outbox" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "documentItemId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "supplierId" TEXT,
    "requestedById" TEXT,
    "plu" TEXT NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL,
    "unit" "PurchaseUnit" NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'INGRESO',
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "status" "StockSyncStatus" NOT NULL DEFAULT 'PENDIENTE',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "externalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastTriedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "stock_outbox_pkey" PRIMARY KEY ("id")
);

-- Las dos unicidades que hacen la idempotencia. No están en el código: están
-- acá, así que dos pedidos concurrentes tampoco pueden escribir dos filas.
CREATE UNIQUE INDEX "stock_outbox_eventKey_key" ON "stock_outbox"("eventKey");
CREATE UNIQUE INDEX "stock_outbox_documentItemId_key" ON "stock_outbox"("documentItemId");

CREATE INDEX "stock_outbox_status_createdAt_idx" ON "stock_outbox"("status", "createdAt");
CREATE INDEX "stock_outbox_documentId_idx" ON "stock_outbox"("documentId");

ALTER TABLE "stock_outbox" ADD CONSTRAINT "stock_outbox_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_outbox" ADD CONSTRAINT "stock_outbox_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_outbox" ADD CONSTRAINT "stock_outbox_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_outbox" ADD CONSTRAINT "stock_outbox_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "stock_outbox" ADD CONSTRAINT "stock_outbox_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
