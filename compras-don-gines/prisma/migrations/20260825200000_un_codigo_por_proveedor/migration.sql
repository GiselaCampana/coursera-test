-- Un código de proveedor apunta a un solo producto interno.
--
-- El mismo PLU puede tener un código distinto en cada proveedor, y eso es lo
-- normal: ART-00228 en Errecalde, 4587 en otro, CREM-PDA en un tercero, todos
-- al mismo artículo de Don Ginés. Lo que no puede pasar es lo contrario: que
-- ART-00228 de Errecalde signifique dos productos, porque ahí no hay forma de
-- saber a cuál cargarle la compra.
--
-- La regla se apoya en un índice único sobre (supplierId, supplierCode), y para
-- eso hace falta una convención: **el código vive en una sola fila de alias**.
-- Un producto puede tener todas las grafías que haga falta —"JAMON COCIDO
-- MONT-BLANC" y "JAMON COCIDO MONTBLANC" son el mismo fiambre— pero sólo una
-- de ellas lleva el código; las demás lo dejan en nulo. Postgres trata los
-- nulos como distintos, así que conviven sin chocar.
--
-- Paso 1: quitarle el código repetido a las grafías extra del MISMO producto.
-- Se conserva en la fila más vieja, que es la que se cargó primero.
UPDATE product_aliases a
SET "supplierCode" = NULL
WHERE a."supplierId" IS NOT NULL
  AND a."supplierCode" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM product_aliases b
    WHERE b."supplierId" = a."supplierId"
      AND b."supplierCode" = a."supplierCode"
      AND b."productId" = a."productId"
      AND (b."createdAt" < a."createdAt" OR (b."createdAt" = a."createdAt" AND b.id < a.id))
  );

-- Paso 2: el índice.
--
-- Si esto falla, es porque queda un código apuntando a DOS PRODUCTOS distintos,
-- que es justamente lo que no puede existir y no se puede resolver solo: hay
-- que decidir a cuál pertenece. Esta consulta dice cuáles son:
--
--   SELECT a."supplierId", a."supplierCode", array_agg(DISTINCT a."productId")
--   FROM product_aliases a
--   WHERE a."supplierId" IS NOT NULL AND a."supplierCode" IS NOT NULL
--   GROUP BY 1, 2 HAVING count(DISTINCT a."productId") > 1;
CREATE UNIQUE INDEX "product_aliases_supplierId_supplierCode_key"
  ON "product_aliases"("supplierId", "supplierCode");
