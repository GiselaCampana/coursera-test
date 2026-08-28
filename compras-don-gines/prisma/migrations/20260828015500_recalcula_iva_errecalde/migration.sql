-- Recalcula el IVA distribuido de la factura Errecalde 00008-00002647.
--
-- El comprobante tiene IVA 21 % uniforme. En la lectura histórica algunos
-- renglones perdieron el "21%" y quedaron con tasa 0; el costeo anterior los
-- trató como si fueran otra alícuota y cargó su IVA sobre los renglones que sí
-- conservaban la tasa. El total de IVA cerraba, pero el IVA por producto no.
--
-- Además se aplica la corrección manual confirmada para ART-00228:
-- neto $544.245,06. Las percepciones no se recalculan porque ya estaban bien.

WITH target_document AS (
  SELECT d."id", d."ivaTotal"
  FROM "documents" d
  WHERE d."fullNumber" = '00008-00002647'
    AND d."issueDate"::date = DATE '2026-08-22'
    AND d."ivaTotal" IS NOT NULL
),
base AS (
  SELECT
    di."id",
    di."documentId",
    di."lineNumber",
    di."quantity",
    di."perceptionAmount",
    CASE
      WHEN di."supplierCode" = 'ART-00228' THEN 544245.06::numeric
      ELSE di."netAmount"
    END AS net_new,
    td."ivaTotal",
    SUM(
      CASE
        WHEN di."supplierCode" = 'ART-00228' THEN 544245.06::numeric
        ELSE di."netAmount"
      END
    ) OVER (PARTITION BY di."documentId") AS net_sum
  FROM "document_items" di
  JOIN target_document td ON td."id" = di."documentId"
),
rounded AS (
  SELECT
    b.*,
    ROUND(b."ivaTotal" * b.net_new / NULLIF(b.net_sum, 0), 2) AS iva_rounded,
    MAX(b."lineNumber") OVER (PARTITION BY b."documentId") AS last_line
  FROM base b
),
fixed AS (
  SELECT
    r.*,
    CASE
      WHEN r."lineNumber" = r.last_line THEN
        r.iva_rounded +
        (
          r."ivaTotal" -
          SUM(r.iva_rounded) OVER (PARTITION BY r."documentId")
        )
      ELSE r.iva_rounded
    END AS iva_new
  FROM rounded r
)
UPDATE "document_items" di
SET
  "grossSubtotal" = CASE
    WHEN di."supplierCode" = 'ART-00228' THEN 544245.06
    ELSE di."grossSubtotal"
  END,
  "netAmount" = f.net_new,
  "ivaRate" = 0.21,
  "ivaAmount" = f.iva_new,
  "totalCost" = ROUND(f.net_new + f.iva_new + di."perceptionAmount", 2),
  "unitCost" = CASE
    WHEN di."quantity" = 0 THEN 0
    ELSE ROUND((f.net_new + f.iva_new + di."perceptionAmount") / di."quantity", 4)
  END
FROM fixed f
WHERE di."id" = f."id";

-- Compras lee purchase_movements: se lo deja idéntico al renglón corregido.
UPDATE "purchase_movements" pm
SET
  "netAmount" = di."netAmount",
  "ivaAmount" = di."ivaAmount",
  "perceptionAmount" = di."perceptionAmount",
  "totalCost" = di."totalCost",
  "unitCost" = di."unitCost"
FROM "document_items" di
JOIN "documents" d ON d."id" = di."documentId"
WHERE pm."documentItemId" = di."id"
  AND d."fullNumber" = '00008-00002647'
  AND d."issueDate"::date = DATE '2026-08-22';

-- Precios lee cost_history: actualiza el costo del mismo comprobante.
UPDATE "cost_history" ch
SET
  "unitCost" = di."unitCost",
  "deltaAmount" = CASE
    WHEN ch."previousUnitCost" IS NULL THEN NULL
    ELSE di."unitCost" - ch."previousUnitCost"
  END,
  "deltaPct" = CASE
    WHEN ch."previousUnitCost" IS NULL OR ch."previousUnitCost" = 0 THEN NULL
    ELSE ROUND((di."unitCost" - ch."previousUnitCost") / ch."previousUnitCost", 6)
  END
FROM "document_items" di
JOIN "documents" d ON d."id" = di."documentId"
WHERE ch."documentId" = di."documentId"
  AND ch."productId" = di."productId"
  AND d."fullNumber" = '00008-00002647'
  AND d."issueDate"::date = DATE '2026-08-22';
