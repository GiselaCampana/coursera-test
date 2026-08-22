/*
  Warnings:

  - You are about to drop the column `originalKey` on the `document_files` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "document_files" DROP COLUMN "originalKey",
ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "archivedById" TEXT;

-- AddForeignKey
ALTER TABLE "document_files" ADD CONSTRAINT "document_files_archivedById_fkey" FOREIGN KEY ("archivedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
