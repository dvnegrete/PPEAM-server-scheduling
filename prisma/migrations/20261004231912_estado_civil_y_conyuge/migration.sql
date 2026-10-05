-- CreateEnum
CREATE TYPE "MaritalStatus" AS ENUM ('UNKNOWN', 'SINGLE', 'MARRIED', 'WIDOWED', 'SEPARATED');

-- AlterTable
ALTER TABLE "participants" ADD COLUMN     "marital_status" "MaritalStatus" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "spouse_id" TEXT,
ADD COLUMN     "spouse_name" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "participants_spouse_id_key" ON "participants"("spouse_id");

-- AddForeignKey
ALTER TABLE "participants" ADD CONSTRAINT "participants_spouse_id_fkey" FOREIGN KEY ("spouse_id") REFERENCES "participants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

