import { Injectable, NotFoundException } from '@nestjs/common';
import { AssignmentStatus, Prisma, Shift, ShiftStatus } from '@prisma/client';
import { TimeService } from '../common/time/time.service';
import { PrismaService } from '../prisma/prisma.service';

/** Estados que ocupan un lugar del turno. Cancelado y falta no cuentan. */
export const OCCUPYING_STATUSES: AssignmentStatus[] = [
  AssignmentStatus.ASSIGNED,
  AssignmentStatus.CONFIRMED,
];

export interface ShiftWithOccupancy {
  shift: Shift;
  occupied: number;
  freeSlots: number;
}

@Injectable()
export class ShiftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: TimeService,
  ) {}

  async findById(shiftId: string): Promise<Shift> {
    const shift = await this.prisma.shift.findUnique({ where: { id: shiftId } });
    if (!shift) throw new NotFoundException(`No existe el turno ${shiftId}`);
    return shift;
  }

  /** Cuántos lugares están ocupados ahora mismo. */
  async countOccupied(shiftId: string, tx?: Prisma.TransactionClient): Promise<number> {
    const client = tx ?? this.prisma;
    return client.assignment.count({
      where: { shiftId, status: { in: OCCUPYING_STATUSES } },
    });
  }

  async withOccupancy(shiftId: string): Promise<ShiftWithOccupancy> {
    const shift = await this.findById(shiftId);
    const occupied = await this.countOccupied(shiftId);
    return { shift, occupied, freeSlots: Math.max(0, shift.capacity - occupied) };
  }

  /**
   * Recalcula OPEN/FULL según la ocupación. Un turno cancelado no cambia de
   * estado por este camino: solo se reabre explícitamente.
   */
  async recomputeStatus(shiftId: string, tx?: Prisma.TransactionClient): Promise<ShiftStatus> {
    const client = tx ?? this.prisma;
    const shift = await client.shift.findUnique({ where: { id: shiftId } });
    if (!shift) throw new NotFoundException(`No existe el turno ${shiftId}`);
    if (shift.status === ShiftStatus.CANCELLED) return ShiftStatus.CANCELLED;

    const occupied = await client.assignment.count({
      where: { shiftId, status: { in: OCCUPYING_STATUSES } },
    });
    const status = occupied >= shift.capacity ? ShiftStatus.FULL : ShiftStatus.OPEN;

    if (status !== shift.status) {
      await client.shift.update({ where: { id: shiftId }, data: { status } });
    }
    return status;
  }

  /** Etiqueta legible del turno, tal como la ve el participante. */
  label(shift: Pick<Shift, 'date' | 'startMinute' | 'endMinute'>, timezone: string): string {
    return this.time.formatShiftLabel(shift.date, shift.startMinute, shift.endMinute, timezone);
  }

  /** Próximos turnos de un participante, en orden cronológico. */
  async upcomingForParticipant(participantId: string, limit = 10) {
    return this.prisma.assignment.findMany({
      where: {
        participantId,
        status: { in: OCCUPYING_STATUSES },
        shift: { startsAt: { gte: this.time.now() }, status: { not: ShiftStatus.CANCELLED } },
      },
      include: { shift: { include: { location: true } } },
      orderBy: { shift: { startsAt: 'asc' } },
      take: limit,
    });
  }

  /** Turnos con lugares libres a futuro, para ofrecer coberturas. */
  async openShifts(locationId: string, limit = 20) {
    return this.prisma.shift.findMany({
      where: {
        locationId,
        status: ShiftStatus.OPEN,
        startsAt: { gte: this.time.now() },
      },
      orderBy: { startsAt: 'asc' },
      take: limit,
    });
  }
}
