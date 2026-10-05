-- El nombre pasa de un campo único a tres: nombre, apellido paterno y apellido
-- materno. Los dos primeros son obligatorios, así que no se pueden agregar a
-- filas existentes sin un valor.
--
-- Se decidió recargar en lugar de adivinar cómo partir los nombres actuales:
-- «Ana López» se parte bien, pero «Ana María López Pérez» es ambiguo y una
-- heurística dejaría datos silenciosamente mal.
--
-- IMPORTANTE: esta migración BORRA el padrón y los usuarios del panel. Se
-- escribió cuando solo había datos de prueba. Después hay que ejecutar el seed
-- y volver a importar el padrón.

-- El borrado en cascada se lleva asignaciones, membresías, asignaciones fijas,
-- ofrecimientos, franjas de guardia, presencia y sesiones de conversación.
DELETE FROM "participants";
DELETE FROM "admin_users";

-- AlterTable
ALTER TABLE "admin_users" DROP COLUMN "name",
ADD COLUMN     "first_name" TEXT NOT NULL,
ADD COLUMN     "maternal_surname" TEXT,
ADD COLUMN     "paternal_surname" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "participants" DROP COLUMN "full_name",
ADD COLUMN     "first_name" TEXT NOT NULL,
ADD COLUMN     "maternal_surname" TEXT,
ADD COLUMN     "paternal_surname" TEXT NOT NULL;

-- CreateIndex: el orden natural de un padrón.
CREATE INDEX "participants_paternal_surname_maternal_surname_first_name_idx" ON "participants"("paternal_surname", "maternal_surname", "first_name");
