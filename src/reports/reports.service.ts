import { Injectable } from '@nestjs/common';
import {
  AssignmentOrigin,
  AssignmentStatus,
  CoverageRequestStatus,
  ShiftStatus,
} from '@prisma/client';
import { TimeService } from '../common/time/time.service';
import { PrismaService } from '../prisma/prisma.service';
import { OCCUPYING_STATUSES } from '../scheduling/shifts.service';

export interface AttendanceRow {
  participantId: string;
  fullName: string;
  /** Turnos que efectivamente atendió (ya ocurrieron y no los canceló). */
  served: number;
  /** Turnos que canceló. */
  cancelled: number;
  /** Veces que entró a cubrir a alguien más. */
  covered: number;
  /** Turnos futuros que tiene asignados. */
  upcoming: number;
}

export interface MonthlySummary {
  year: number;
  month: number;
  locationName: string;
  totalShifts: number;
  cancelledShifts: number;
  fullyStaffedShifts: number;
  understaffedShifts: number;
  totalAssignments: number;
  cancellations: number;
  coverages: number;
  coverageRequests: number;
  coverageRequestsFulfilled: number;
  coverageRequestsExpired: number;
}

export interface AuditFilters {
  entity?: string;
  entityId?: string;
  action?: string;
  actorId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

/**
 * Consultas para el panel y para los encargados.
 * Se apoyan en la bitácora y en el estado actual: la bitácora explica el cómo,
 * las asignaciones dicen el qué.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: TimeService,
  ) {}

  /** Bitácora filtrable: quién hizo qué y cuándo. */
  async auditTrail(filters: AuditFilters = {}) {
    return this.prisma.auditLog.findMany({
      where: {
        entity: filters.entity,
        entityId: filters.entityId,
        action: filters.action,
        actorId: filters.actorId,
        createdAt:
          filters.from || filters.to
            ? { gte: filters.from, lte: filters.to }
            : undefined,
      },
      orderBy: { createdAt: 'desc' },
      take: filters.limit ?? 100,
    });
  }

  /** Participación de cada persona en un periodo. */
  async attendance(locationId: string, from: Date, to: Date): Promise<AttendanceRow[]> {
    const participants = await this.prisma.participant.findMany({
      where: { memberships: { some: { locationId, active: true } } },
      orderBy: { fullName: 'asc' },
    });

    const assignments = await this.prisma.assignment.findMany({
      where: {
        shift: { locationId, startsAt: { gte: from, lte: to } },
      },
      include: { shift: { select: { startsAt: true, status: true } } },
    });

    const now = this.time.now();
    const byParticipant = new Map<string, AttendanceRow>();

    for (const participant of participants) {
      byParticipant.set(participant.id, {
        participantId: participant.id,
        fullName: participant.fullName,
        served: 0,
        cancelled: 0,
        covered: 0,
        upcoming: 0,
      });
    }

    for (const assignment of assignments) {
      const row = byParticipant.get(assignment.participantId);
      if (!row) continue;

      if (assignment.status === AssignmentStatus.CANCELLED) {
        row.cancelled += 1;
        continue;
      }
      if (assignment.shift.status === ShiftStatus.CANCELLED) continue;

      if (assignment.shift.startsAt < now) {
        row.served += 1;
        if (assignment.origin === AssignmentOrigin.COVERAGE) row.covered += 1;
      } else {
        row.upcoming += 1;
      }
    }

    return [...byParticipant.values()];
  }

  /** Resumen mensual del punto de exhibición. */
  async monthlySummary(locationId: string, year: number, month: number): Promise<MonthlySummary> {
    const location = await this.prisma.location.findUniqueOrThrow({ where: { id: locationId } });
    const from = this.time.toInstant(
      `${year}-${String(month).padStart(2, '0')}-01`,
      0,
      location.timezone,
    );
    const to = new Date(
      this.time
        .nowInZone(location.timezone)
        .set({ year, month, day: 1 })
        .startOf('month')
        .plus({ months: 1 })
        .toUTC()
        .toMillis(),
    );

    const shifts = await this.prisma.shift.findMany({
      where: { locationId, startsAt: { gte: from, lt: to } },
      include: { assignments: true },
    });

    let fullyStaffed = 0;
    let understaffed = 0;
    let cancelledShifts = 0;
    let totalAssignments = 0;
    let cancellations = 0;
    let coverages = 0;

    for (const shift of shifts) {
      if (shift.status === ShiftStatus.CANCELLED) {
        cancelledShifts += 1;
      }

      const occupying = shift.assignments.filter((assignment) =>
        OCCUPYING_STATUSES.includes(assignment.status),
      );
      totalAssignments += occupying.length;
      cancellations += shift.assignments.filter(
        (assignment) => assignment.status === AssignmentStatus.CANCELLED,
      ).length;
      coverages += occupying.filter(
        (assignment) => assignment.origin === AssignmentOrigin.COVERAGE,
      ).length;

      if (shift.status === ShiftStatus.CANCELLED) continue;
      if (occupying.length >= location.minCapacity) fullyStaffed += 1;
      else understaffed += 1;
    }

    const requests = await this.prisma.coverageRequest.groupBy({
      by: ['status'],
      where: { shift: { locationId, startsAt: { gte: from, lt: to } } },
      _count: true,
    });

    const countOf = (status: CoverageRequestStatus): number =>
      requests.find((item) => item.status === status)?._count ?? 0;

    return {
      year,
      month,
      locationName: location.name,
      totalShifts: shifts.length,
      cancelledShifts,
      fullyStaffedShifts: fullyStaffed,
      understaffedShifts: understaffed,
      totalAssignments,
      cancellations,
      coverages,
      coverageRequests: requests.reduce((sum, item) => sum + item._count, 0),
      coverageRequestsFulfilled: countOf(CoverageRequestStatus.FULFILLED),
      coverageRequestsExpired: countOf(CoverageRequestStatus.EXPIRED),
    };
  }

  /** Estado del calendario para la vista de mes del panel. */
  async monthCalendar(locationId: string, year: number, month: number) {
    const location = await this.prisma.location.findUniqueOrThrow({ where: { id: locationId } });
    const start = this.time
      .nowInZone(location.timezone)
      .set({ year, month, day: 1 })
      .startOf('month');

    const shifts = await this.prisma.shift.findMany({
      where: {
        locationId,
        date: {
          gte: this.time.toDateColumn(start),
          lte: this.time.toDateColumn(start.endOf('month')),
        },
      },
      include: {
        assignments: {
          where: { status: { in: OCCUPYING_STATUSES } },
          include: { participant: { select: { id: true, fullName: true } } },
        },
      },
      orderBy: [{ date: 'asc' }, { startMinute: 'asc' }],
    });

    return shifts.map((shift) => ({
      id: shift.id,
      date: shift.date.toISOString().slice(0, 10),
      range: this.time.formatRange(shift.startMinute, shift.endMinute),
      status: shift.status,
      capacity: shift.capacity,
      occupied: shift.assignments.length,
      weekOfMonth: shift.weekOfMonth,
      participants: shift.assignments.map((assignment) => ({
        id: assignment.participant.id,
        name: assignment.participant.fullName,
        origin: assignment.origin,
        confirmed: assignment.status === AssignmentStatus.CONFIRMED,
      })),
    }));
  }
}
