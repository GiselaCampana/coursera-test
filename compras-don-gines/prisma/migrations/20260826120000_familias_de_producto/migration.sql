-- Familias de producto.
--
-- Una familia agrupa PLU para poder consultar por rubro; no los identifica ni
-- los reemplaza. "Queso Sardo" es una familia, y el Sardo Bloque Melincué y el
-- Sardo Don Alfonso son dos productos distintos que cuelgan de ella.
--
-- Nada se asigna solo: los productos que ya están quedan sin familia hasta que
-- alguien la cargue o la traiga el catálogo. Adivinar la familia a partir del
-- nombre pondría a "Queso Sardo" y a "Queso Sardo rallado" en el mismo grupo
-- sin que nadie lo haya decidido.
CREATE TABLE "product_families" (
    "id" TEXT NOT NULL,
    "code" TEXT,
    "name" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_families_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_families_code_key" ON "product_families"("code");
CREATE UNIQUE INDEX "product_families_name_key" ON "product_families"("name");
CREATE INDEX "product_families_normalized_idx" ON "product_families"("normalized");

-- El vínculo del producto con su familia, y los dos datos que el catálogo de
-- Control de Stock puede traer y que hoy no tenían dónde guardarse.
ALTER TABLE "products" ADD COLUMN "familyId" TEXT;
ALTER TABLE "products" ADD COLUMN "subtype" TEXT;
ALTER TABLE "products" ADD COLUMN "catalogSyncedAt" TIMESTAMP(3);

CREATE INDEX "products_familyId_idx" ON "products"("familyId");

-- Borrar una familia no puede borrar productos: el PLU es el identificador del
-- artículo y sobrevive a cualquier reagrupamiento.
ALTER TABLE "products" ADD CONSTRAINT "products_familyId_fkey"
    FOREIGN KEY ("familyId") REFERENCES "product_families"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
