-- AlterTable
ALTER TABLE "assignments" ADD COLUMN     "assigned_at" TIMESTAMP(3),
ADD COLUMN     "assigned_by_name" TEXT,
ADD COLUMN     "cancel_reason_code" TEXT,
ADD COLUMN     "cancelled_by_name" TEXT;
