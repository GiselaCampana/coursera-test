-- AlterEnum
ALTER TYPE "TermType" ADD VALUE 'NEXT_INVOICE';

-- AlterTable
ALTER TABLE "payment_schedules" ADD COLUMN     "dueDateProvisional" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "suppliers" ADD COLUMN     "nextInvoiceDate" TIMESTAMP(3);
