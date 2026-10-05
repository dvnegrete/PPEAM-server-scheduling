-- El rol y la preferencia de avisos dejan de ser de la persona y pasan a ser del
-- vínculo con cada punto: alguien puede ser encargado en un punto y solo
-- participante en otro, y querer avisos de uno y no del otro.
--
-- Los datos se trasladan, no se borran: primero se copian a la membresía y solo
-- después se quitan de `participants`.

-- 1. Columnas nuevas en la tabla de unión.
ALTER TABLE "location_memberships"
  ADD COLUMN "role" "ParticipantRole" NOT NULL DEFAULT 'PARTICIPANT',
  ADD COLUMN "coverage_alerts" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "is_primary" BOOLEAN NOT NULL DEFAULT false;

-- 2. Trasladar lo que hoy vive en la persona a cada una de sus membresías.
UPDATE "location_memberships" m
SET "role" = p."role",
    "coverage_alerts" = p."coverage_alerts"
FROM "participants" p
WHERE p."id" = m."participant_id";

-- 3. Marcar como principal la membresía más antigua de cada persona. Hoy cada
--    una tiene exactamente una, así que esto las cubre todas.
UPDATE "location_memberships" m
SET "is_primary" = true
WHERE m."id" = (
  SELECT m2."id"
  FROM "location_memberships" m2
  WHERE m2."participant_id" = m."participant_id" AND m2."active"
  ORDER BY m2."created_at" ASC
  LIMIT 1
);

-- 4. Ahora sí, quitarlas de la persona: dejarlas en los dos lugares crearía dos
--    fuentes de verdad.
ALTER TABLE "participants" DROP COLUMN "role", DROP COLUMN "coverage_alerts";

-- 5. Un solo punto principal por persona, garantizado por la base y no solo por
--    el código. Prisma no declara índices con condición, así que va a mano.
CREATE UNIQUE INDEX "location_memberships_one_primary_per_participant"
  ON "location_memberships" ("participant_id") WHERE "is_primary";

-- CreateIndex
CREATE INDEX "location_memberships_participant_id_is_primary_idx" ON "location_memberships"("participant_id", "is_primary");
CREATE INDEX "location_memberships_location_id_role_active_idx" ON "location_memberships"("location_id", "role", "active");

-- CreateTable
CREATE TABLE "admin_location_access" (
    "id" TEXT NOT NULL,
    "admin_user_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "admin_location_access_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_location_access_admin_user_id_location_id_key" ON "admin_location_access"("admin_user_id", "location_id");

ALTER TABLE "admin_location_access" ADD CONSTRAINT "admin_location_access_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admin_location_access" ADD CONSTRAINT "admin_location_access_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
