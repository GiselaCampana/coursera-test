-- La foto de conservación: conteos por tabla y hashes reproducibles.
--
-- El hash se calcula sobre el CONTENIDO de cada tabla, ordenado por clave, y no
-- sobre un `pg_dump`: un volcado incluye el esquema, así que cambiaría por el
-- solo hecho de haber migrado y no diría nada sobre los datos. Acá cambia si y
-- sólo si cambió una fila.
--
-- Se excluyen a propósito:
--  * `_prisma_migrations`, que SÍ tiene que cambiar: es el registro de lo aplicado;
--  * las tablas que la cadena crea, que antes no existen.
--
-- Y se nombran las columnas de a una por tabla en vez de usar `t.*`: con `t.*` el
-- hash cambiaría por agregar una columna nueva aunque ninguna fila se hubiera
-- tocado, que es exactamente lo que una migración aditiva hace. Así el hash
-- responde la pregunta que interesa —¿se movió algún dato?— y no otra.

\pset footer off
\pset tuples_only on

SELECT 'CONTEOS' AS seccion;

SELECT format('%-26s %s', tabla, conteo) FROM (
  SELECT 'suppliers' AS tabla, count(*)::text AS conteo FROM "suppliers"
  UNION ALL SELECT 'supplier_aliases', count(*)::text FROM "supplier_aliases"
  UNION ALL SELECT 'supplier_payment_terms', count(*)::text FROM "supplier_payment_terms"
  UNION ALL SELECT 'products', count(*)::text FROM "products"
  UNION ALL SELECT 'product_aliases', count(*)::text FROM "product_aliases"
  UNION ALL SELECT 'documents', count(*)::text FROM "documents"
  UNION ALL SELECT 'document_items', count(*)::text FROM "document_items"
  UNION ALL SELECT 'document_files', count(*)::text FROM "document_files"
  UNION ALL SELECT 'payment_schedules', count(*)::text FROM "payment_schedules"
  UNION ALL SELECT 'payment_events', count(*)::text FROM "payment_events"
  UNION ALL SELECT 'cost_history', count(*)::text FROM "cost_history"
  UNION ALL SELECT 'users', count(*)::text FROM "users"
  UNION ALL SELECT 'roles', count(*)::text FROM "roles"
  UNION ALL SELECT 'branches', count(*)::text FROM "branches"
  UNION ALL SELECT 'audit_logs', count(*)::text FROM "audit_logs"
  UNION ALL SELECT 'stock_outbox', count(*)::text FROM "stock_outbox"
  UNION ALL SELECT 'pricing_rules', count(*)::text FROM "pricing_rules"
) c ORDER BY tabla;

SELECT 'HASHES' AS seccion;

SELECT format('%-26s %s', 'suppliers', md5(string_agg(f, '|' ORDER BY f))) FROM (
  SELECT concat_ws(';', "id", "tradeName", "legalName", "cuit", "active") AS f FROM "suppliers") x;

SELECT format('%-26s %s', 'supplier_aliases', md5(coalesce(string_agg(f, '|' ORDER BY f), ''))) FROM (
  SELECT concat_ws(';', "id", "supplierId", "alias", "normalized") AS f FROM "supplier_aliases") x;

SELECT format('%-26s %s', 'supplier_payment_terms', md5(coalesce(string_agg(f, '|' ORDER BY f), ''))) FROM (
  SELECT concat_ws(';', "id", "supplierId", "termType"::text, "days", "validFrom") AS f
    FROM "supplier_payment_terms") x;

SELECT format('%-26s %s', 'products', md5(string_agg(f, '|' ORDER BY f))) FROM (
  SELECT concat_ws(';', "id", "internalCode", "normalizedName", "category",
                   "purchaseUnit"::text, "saleMode"::text, "targetMarginPct",
                   "marginBasis"::text, "cashDiscountPct", "roundingRule", "active") AS f
    FROM "products") x;

SELECT format('%-26s %s', 'product_aliases', md5(string_agg(f, '|' ORDER BY f))) FROM (
  SELECT concat_ws(';', "id", "productId", "supplierId", "supplierCode", "alias",
                   "normalized") AS f FROM "product_aliases") x;

SELECT format('%-26s %s', 'documents', md5(string_agg(f, '|' ORDER BY f))) FROM (
  SELECT concat_ws(';', "id", "branchId", "supplierId", "docType"::text, "fullNumber",
                   "issueDate", "netTotal", "ivaTotal", "total", "status"::text,
                   "dedupeKey", "createdById") AS f FROM "documents") x;

SELECT format('%-26s %s', 'document_items', md5(string_agg(f, '|' ORDER BY f))) FROM (
  SELECT concat_ws(';', "id", "documentId", "lineNumber", "description", "quantity",
                   "unit"::text, "unitNetPrice", "netAmount", "totalCost", "unitCost",
                   "productId") AS f FROM "document_items") x;

SELECT format('%-26s %s', 'document_files', md5(string_agg(f, '|' ORDER BY f))) FROM (
  SELECT concat_ws(';', "id", "documentId", "pageOrder", "storageKey", "mimeType",
                   "sizeBytes", "sha256") AS f FROM "document_files") x;

SELECT format('%-26s %s', 'payment_schedules', md5(string_agg(f, '|' ORDER BY f))) FROM (
  SELECT concat_ws(';', "id", "documentId", "dueDate", "plannedAmount",
                   "plannedPaymentMethod", "paidAmount", "status"::text) AS f
    FROM "payment_schedules") x;

SELECT format('%-26s %s', 'payment_events', md5(string_agg(f, '|' ORDER BY f))) FROM (
  SELECT concat_ws(';', "id", "scheduleId", "kind"::text, "amount", "effectiveDate",
                   "userId") AS f FROM "payment_events") x;

SELECT format('%-26s %s', 'cost_history', md5(string_agg(f, '|' ORDER BY f))) FROM (
  SELECT concat_ws(';', "id", "productId", "supplierId", "documentId", "date",
                   "unitNetPrice", "unitCost") AS f FROM "cost_history") x;

SELECT format('%-26s %s', 'users', md5(string_agg(f, '|' ORDER BY f))) FROM (
  SELECT concat_ws(';', "id", "email", "roleId", "branchId", "active") AS f FROM "users") x;

-- Los permisos de cada rol, que es lo que el punto 6 no quiere ver ampliado.
SELECT format('%-26s %s', 'roles+permisos', md5(string_agg(f, '|' ORDER BY f))) FROM (
  SELECT concat_ws(';', "id", "code", "name",
                   array_to_string(coalesce("permissions", '{}'), ','),
                   "scopeAllBranches") AS f FROM "roles") x;

SELECT format('%-26s %s', 'branches', md5(string_agg(f, '|' ORDER BY f))) FROM (
  SELECT concat_ws(';', "id", "code", "name", "stockKey") AS f FROM "branches") x;
