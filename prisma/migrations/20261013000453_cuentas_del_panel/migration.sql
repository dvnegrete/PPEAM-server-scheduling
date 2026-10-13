-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('ADMIN', 'SUPERVISOR');

-- CreateEnum
CREATE TYPE "AuthProvider" AS ENUM ('PASSWORD', 'GOOGLE');

-- AlterTable
ALTER TABLE "admin_users" ADD COLUMN     "auth_provider" "AuthProvider" NOT NULL DEFAULT 'PASSWORD',
ADD COLUMN     "must_change_password" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "participant_id" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "role" "AdminRole" NOT NULL DEFAULT 'ADMIN',
ADD COLUMN     "token_version" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "password_hash" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_participant_id_key" ON "admin_users"("participant_id");

-- CreateIndex
CREATE INDEX "admin_users_role_active_idx" ON "admin_users"("role", "active");

-- AddForeignKey
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

