-- Notas de crédito de proveedor.
--
-- Todo aditivo y con valores por omisión que dejan los comprobantes ya
-- cargados exactamente como estaban: siguen siendo FACTURA, sin motivo de
-- crédito, sin comprobante relacionado, con sus renglones sin devolución
-- física y su historial de costos marcado como COMPRA, que es lo que son.

-- El tipo nuevo de comprobante. Se agrega al enum que ya existe en vez de
-- crear otro: una nota de crédito es un comprobante del proveedor como la
-- factura, con su punto de venta, su número y su detalle.
ALTER TYPE "DocType" ADD VALUE IF NOT EXISTS 'NOTA_CREDITO';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CreditReason') THEN
    CREATE TYPE "CreditReason" AS ENUM (
      'BONIFICACION',
      'DIFERENCIA_PRECIO',
      'DESCUENTO_COMERCIAL',
      'CORRECCION_FISCAL',
      'DEVOLUCION_PERCEPCION',
      'DEVOLUCION_MERCADERIA',
      'OTRO'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CostEntryKind') THEN
    CREATE TYPE "CostEntryKind" AS ENUM ('COMPRA', 'AJUSTE_NC');
  END IF;
END
$$;

ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "creditReason" "CreditReason";
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "relatedDocumentId" TEXT;

-- ON DELETE SET NULL: si alguien borra la factura original, la nota de crédito
-- no se va con ella. Sigue siendo un comprobante del proveedor con su importe
-- y su efecto en la cuenta corriente; lo único que se pierde es el vínculo.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'documents_relatedDocumentId_fkey'
  ) THEN
    ALTER TABLE "documents"
      ADD CONSTRAINT "documents_relatedDocumentId_fkey"
      FOREIGN KEY ("relatedDocumentId") REFERENCES "documents"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "documents_relatedDocumentId_idx"
  ON "documents"("relatedDocumentId");

-- Por omisión falso: la existencia de una nota de crédito no implica que haya
-- vuelto mercadería, y los renglones de las facturas ya cargadas tampoco son
-- devoluciones.
ALTER TABLE "document_items"
  ADD COLUMN IF NOT EXISTS "stockReturn" BOOLEAN NOT NULL DEFAULT false;

-- Todo el historial de costos que ya está cargado salió de una compra.
ALTER TABLE "cost_history"
  ADD COLUMN IF NOT EXISTS "kind" "CostEntryKind" NOT NULL DEFAULT 'COMPRA';
