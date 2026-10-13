-- AlterTable
ALTER TABLE "assignments" ADD COLUMN     "note" TEXT;

-- AlterTable
ALTER TABLE "participants" ADD COLUMN     "external" BOOLEAN NOT NULL DEFAULT false;
