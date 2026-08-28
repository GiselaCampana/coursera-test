-- Segunda corrección idempotente de Errecalde 00008-00002647.
-- Cada renglón toma neto × 21%; sólo el último absorbe el residuo contra el IVA
-- impreso del pie. Esto evita que un producto quede a un centavo del 21% exacto.

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
    MAX(di."lineNumber") OVER (PARTITION BY di."documentId") AS last_line
  FROM "document_items" di
  JOIN target_document td ON td."id" = di."documentId"
),
direct AS (
  SELECT
    b.*,
    ROUND(b.net_new * 0.21, 2) AS iva_direct
  FROM base b
),
fixed AS (
  SELECT
    d.*,
    CASE
      WHEN d."lineNumber" = d.last_line THEN
        d.iva_direct +
        (
          d."ivaTotal" -
          SUM(d.iva_direct) OVER (PARTITION BY d."documentId")
        )
      ELSE d.iva_direct
    END AS iva_new
  FROM direct d
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
