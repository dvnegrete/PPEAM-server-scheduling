import { AssignmentOrigin, AssignmentStatus, ParticipantRole, ShiftStatus } from '@prisma/client';
import { DateTime } from 'luxon';
import { PrismaService } from '../../src/prisma/prisma.service';

export const TZ = 'America/Mexico_City';

export async function createLocation(
  prisma: PrismaService,
  overrides: Partial<{
    name: string;
    address: string;
    minCapacity: number;
    defaultCapacity: number;
    maxCapacity: number;
    settings: object;
  }> = {},
) {
  return prisma.location.create({
    data: {
      name: overrides.name ?? 'Punto de prueba',
      address: overrides.address ?? null,
      timezone: TZ,
      defaultCapacity: overrides.defaultCapacity ?? 3,
      minCapacity: overrides.minCapacity ?? 2,
      maxCapacity: overrides.maxCapacity ?? 4,
      // Un punto real nace con la mensajería restringida, que es la postura segura
      // mientras se opera con una cuenta de prueba de Meta. Para las pruebas que no
      // tratan sobre la política de entrega, ese modo silenciaría todo lo que
      // quieren comprobar, así que aquí se nace en modo activo. Los ajustes propios
      // de cada prueba se fusionan encima y pueden sobrescribirlo.
      settings: {
        messagingMode: 'live',
        broadcastCoverageToParticipants: true,
        ...(overrides.settings ?? {}),
      },
    },
  });
}

let phoneCounter = 1000;

/**
 * Parte un nombre escrito de corrido en los tres campos del modelo.
 *
 * Es una concesión **solo para las pruebas**: deja los escenarios legibles
 * (`createParticipant(prisma, id, 'Ana López')`) en lugar de tres argumentos en
 * cada una de las cien llamadas. El código de producción nunca parte cadenas,
 * justamente porque adivinar dónde acaba el nombre y empieza el apellido es lo
 * que este cambio vino a eliminar.
 */
function partirNombre(completo: string): {
  firstName: string;
  paternalSurname: string;
  maternalSurname: string | null;
} {
  const partes = completo.trim().split(/\s+/);
  return {
    firstName: partes[0],
    // El apellido paterno es obligatorio en el modelo; con un solo nombre se
    // rellena para que el escenario pueda construirse.
    paternalSurname: partes[1] ?? 'DePrueba',
    maternalSurname: partes[2] ?? null,
  };
}

export async function createParticipant(
  prisma: PrismaService,
  locationId: string,
  fullName: string,
  role: ParticipantRole = ParticipantRole.PARTICIPANT,
) {
  phoneCounter += 1;
  const participant = await prisma.participant.create({
    data: {
      ...partirNombre(fullName),
      phoneE164: `+5255${String(phoneCounter).padStart(8, '0')}`,
      optInAt: new Date(),
    },
  });
  // El rol es del vínculo con el punto, no de la persona. La primera membresía
  // queda como principal, igual que hace MembershipsService.
  await prisma.locationMembership.create({
    data: { locationId, participantId: participant.id, role, isPrimary: true },
  });
  return participant;
}

/** Turno concreto listo para usar, con los ocupantes indicados. */
export async function createShift(
  prisma: PrismaService,
  locationId: string,
  params: {
    startsAt: Date;
    capacity?: number;
    date?: Date;
    startMinute?: number;
    endMinute?: number;
    participantIds?: string[];
  },
) {
  const startMinute = params.startMinute ?? 7 * 60;
  // La fecha local se deriva de `startsAt` para que la etiqueta que ve el
  // participante y el instante del turno nunca se contradigan.
  const local = DateTime.fromJSDate(params.startsAt, { zone: TZ });
  const shift = await prisma.shift.create({
    data: {
      locationId,
      date: params.date ?? new Date(Date.UTC(local.year, local.month - 1, local.day)),
      startMinute,
      endMinute: params.endMinute ?? startMinute + 120,
      startsAt: params.startsAt,
      endsAt: new Date(params.startsAt.getTime() + 2 * 3_600_000),
      capacity: params.capacity ?? 3,
      weekOfMonth: 4,
      status: ShiftStatus.OPEN,
    },
  });

  for (const participantId of params.participantIds ?? []) {
    await prisma.assignment.create({
      data: {
        shiftId: shift.id,
        participantId,
        origin: AssignmentOrigin.FIXED,
        status: AssignmentStatus.ASSIGNED,
      },
    });
  }

  const occupied = (params.participantIds ?? []).length;
  if (occupied >= shift.capacity) {
    await prisma.shift.update({ where: { id: shift.id }, data: { status: ShiftStatus.FULL } });
  }

  return prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
}
