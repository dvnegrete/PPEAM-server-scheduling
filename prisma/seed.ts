import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { BCRYPT_COST } from '../src/admin/auth.service';

const prisma = new PrismaClient();

/** Turnos de 2 horas de 7:00 a 17:00, en minutos desde medianoche. */
const SHIFT_SLOTS = [
  [7 * 60, 9 * 60],
  [9 * 60, 11 * 60],
  [11 * 60, 13 * 60],
  [13 * 60, 15 * 60],
  [15 * 60, 17 * 60],
] as const;

/** `weekOfMonth = 0` significa "todas las semanas del mes". */
const EVERY_WEEK = 0;

const WEEKDAYS = [1, 2, 3, 4, 5] as const; // lunes a viernes
const WEEKEND = [6, 0] as const; // sábado y domingo

async function main(): Promise<void> {
  const location = await prisma.location.upsert({
    where: { id: 'default-location' },
    update: {},
    create: {
      id: 'default-location',
      name: 'Punto de exhibición principal',
      timezone: 'America/Mexico_City',
      defaultCapacity: 3,
      minCapacity: 2,
      maxCapacity: 4,
      settings: {},
    },
  });
  console.log(`Punto de exhibición: ${location.name} (${location.id})`);

  let created = 0;
  for (const [startMinute, endMinute] of SHIFT_SLOTS) {
    // Lunes a viernes: la misma plantilla se repite todas las semanas.
    for (const weekday of WEEKDAYS) {
      await upsertTemplate(location.id, weekday, startMinute, endMinute, EVERY_WEEK, true);
      created += 1;
    }

    // Sábado y domingo: una plantilla por ordinal del mes. Las cuatro primeras
    // llevan titulares fijos; la quinta se abre a inscripción porque solo existe
    // en algunos meses.
    for (const weekday of WEEKEND) {
      for (const weekOfMonth of [1, 2, 3, 4, 5]) {
        await upsertTemplate(
          location.id,
          weekday,
          startMinute,
          endMinute,
          weekOfMonth,
          weekOfMonth !== 5,
        );
        created += 1;
      }
    }
  }
  console.log(`Plantillas de turno aseguradas: ${created}`);

  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@ppeam.local';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'cambiar-esta-contrasena';
  const adminFirstName = process.env.SEED_ADMIN_FIRST_NAME ?? 'Administrador';
  const adminPaternal = process.env.SEED_ADMIN_PATERNAL_SURNAME ?? 'Del Sistema';
  const adminMaternal = process.env.SEED_ADMIN_MATERNAL_SURNAME ?? null;
  await prisma.adminUser.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      firstName: adminFirstName,
      paternalSurname: adminPaternal,
      maternalSurname: adminMaternal,
      // Mismo coste que el alta de cuentas desde el panel.
      passwordHash: await bcrypt.hash(adminPassword, BCRYPT_COST),
    },
  });
  console.log(`Usuario del panel: ${adminEmail}`);
}

function upsertTemplate(
  locationId: string,
  weekday: number,
  startMinute: number,
  endMinute: number,
  weekOfMonth: number,
  autoFillOnly: boolean,
) {
  return prisma.shiftTemplate.upsert({
    where: {
      locationId_weekday_startMinute_weekOfMonth: {
        locationId,
        weekday,
        startMinute,
        weekOfMonth,
      },
    },
    update: {},
    create: { locationId, weekday, startMinute, endMinute, capacity: 3, weekOfMonth, autoFillOnly },
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
