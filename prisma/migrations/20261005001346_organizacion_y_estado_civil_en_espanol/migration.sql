-- Dos cambios en uno:
--
-- 1. Los valores del estado civil pasan a español. Se usa RENAME VALUE en lugar
--    de recrear el tipo porque renombra el valor en su sitio: los registros
--    existentes quedan convertidos sin tocarlos y sin perder nada.
-- 2. Congregación, circuito y ciudad, para reportes y filtros. Opcionales, para
--    poder completarlos después de cargar el padrón.

ALTER TYPE "MaritalStatus" RENAME VALUE 'UNKNOWN' TO 'SIN_REGISTRAR';
ALTER TYPE "MaritalStatus" RENAME VALUE 'SINGLE' TO 'SOLTERO';
ALTER TYPE "MaritalStatus" RENAME VALUE 'MARRIED' TO 'CASADO';
ALTER TYPE "MaritalStatus" RENAME VALUE 'WIDOWED' TO 'VIUDO';
ALTER TYPE "MaritalStatus" RENAME VALUE 'SEPARATED' TO 'SEPARADO';

-- El valor por omisión guarda la expresión literal del nombre anterior, así que
-- se vuelve a declarar apuntando al nombre nuevo.
ALTER TABLE "participants" ALTER COLUMN "marital_status" SET DEFAULT 'SIN_REGISTRAR';

-- AlterTable
ALTER TABLE "participants" ADD COLUMN "congregation" TEXT,
ADD COLUMN "circuit" TEXT,
ADD COLUMN "city" TEXT;

ALTER TABLE "admin_users" ADD COLUMN "congregation" TEXT,
ADD COLUMN "circuit" TEXT,
ADD COLUMN "city" TEXT;

-- CreateIndex: los tres se filtran por separado.
CREATE INDEX "participants_congregation_idx" ON "participants"("congregation");
CREATE INDEX "participants_circuit_idx" ON "participants"("circuit");
CREATE INDEX "participants_city_idx" ON "participants"("city");
