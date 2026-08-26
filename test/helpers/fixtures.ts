import { AssignmentOrigin, AssignmentStatus, ParticipantRole, ShiftStatus } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';

export const TZ = 'America/Mexico_City';

export async function createLocation(
  prisma: PrismaService,
  overrides: Partial<{ minCapacity: number; defaultCapacity: number; settings: object }> = {},
) {
  return prisma.location.create({
    data: {
      name: 'Punto de prueba',
      timezone: TZ,
      defaultCapacity: overrides.defaultCapacity ?? 3,
      minCapacity: overrides.minCapacity ?? 2,
      maxCapacity: 4,
      settings: overrides.settings ?? {},
    },
  });
}

let phoneCounter = 1000;

export async function createParticipant(
  prisma: PrismaService,
  locationId: string,
  fullName: string,
  role: ParticipantRole = ParticipantRole.PARTICIPANT,
) {
  phoneCounter += 1;
  const participant = await prisma.participant.create({
    data: {
      fullName,
      phoneE164: `+5255${String(phoneCounter).padStart(8, '0')}`,
      role,
      optInAt: new Date(),
    },
  });
  await prisma.locationMembership.create({
    data: { locationId, participantId: participant.id },
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
  const shift = await prisma.shift.create({
    data: {
      locationId,
      date: params.date ?? new Date(Date.UTC(2026, 7, 27)),
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
