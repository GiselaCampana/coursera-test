-- Gastos del comprobante que no son mercadería.
--
-- Las bolsas que Ezra cobra para transportar la compra son tres bolsas, no tres
-- kilos de nada: se pagan con el resto de la factura y no mueven existencias.
-- Hasta hoy el modelo no tenía cómo decirlo, así que el renglón terminaba como
-- mercadería sin artículo o, peor, con un artículo inventado.
--
-- `document_items.expenseKind` es la clasificación efectiva del renglón. Null
-- sigue siendo mercadería, que es lo que ya son todas las filas existentes: la
-- columna entra sin default y sin backfill a propósito, porque ningún renglón
-- viejo puede volverse gasto sin que alguien lo decida.
--
-- `supplier_expense_codes` es la configuración que lo decide sola: el código de
-- un proveedor —una identificación, no una descripción— con la unidad en la que
-- lo cobra, porque el papel no la dice.
--
-- El `SET DEFAULT 0` de products.cashDiscountPct no es de este cambio: es un
-- desfasaje que ya existía entre el esquema y las migraciones, y va acá porque
-- si no Prisma lo vuelve a proponer en cada diff futuro.

-- CreateEnum
CREATE TYPE "ExpenseKind" AS ENUM ('EMBALAJE', 'FLETE', 'OTRO');

-- AlterTable
ALTER TABLE "document_items" ADD COLUMN     "expenseKind" "ExpenseKind";

-- AlterTable
ALTER TABLE "products" ALTER COLUMN "cashDiscountPct" SET DEFAULT 0;

-- CreateTable
CREATE TABLE "supplier_expense_codes" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "supplierCode" TEXT NOT NULL,
    "kind" "ExpenseKind" NOT NULL DEFAULT 'EMBALAJE',
    "unit" "PurchaseUnit" NOT NULL DEFAULT 'UNIT',
    "label" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "supplier_expense_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "supplier_expense_codes_supplierId_supplierCode_key" ON "supplier_expense_codes"("supplierId", "supplierCode");

-- AddForeignKey
ALTER TABLE "supplier_expense_codes" ADD CONSTRAINT "supplier_expense_codes_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_expense_codes" ADD CONSTRAINT "supplier_expense_codes_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

