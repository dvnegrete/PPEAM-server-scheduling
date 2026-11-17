import { Injectable } from '@nestjs/common';
import {
  AssignmentOrigin,
  AssignmentStatus,
  CoverageRequestStatus,
  ShiftStatus,
} from '@prisma/client';
import { displayName, formalName, PADRON_ORDER } from '../common/names/person-name';
import { formatNationalPhone } from '../common/phone/phone.service';
import { TimeService } from '../common/time/time.service';
import { PrismaService } from '../prisma/prisma.service';
import { captainFirst } from '../common/captain/captain-first';
import { captainOf } from '../common/captain/captain-of';
import { OCCUPYING_STATUSES } from '../scheduling/shifts.service';
import { DIAS_DEL_ROL, ORDINALES_DEL_ROL } from './schedule-labels';

export interface AttendanceRow {
  participantId: string;
  /** Nombre formal, como se lee en un padrón: «López Pérez, Ana María». */
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

/** Un turno fijo de una persona: «Lunes · cada semana» o «Primer sábado». */
export interface ParticipantFixedSlot {
  label: string;
  range: string;
  isCaptain: boolean;
}

/** Una fecha concreta que la persona tiene registrada, vigente o ya cancelada. */
export interface ParticipantUpcomingShift {
  assignmentId: string;
  shiftId: string;
  /** Fecha local del punto, `YYYY-MM-DD`. */
  date: string;
  /** «lunes 16 de noviembre». */
  label: string;
  range: string;
  origin: AssignmentOrigin;
  /** Ya avisó que no va: se muestra para que nadie lo capture dos veces. */
  cancelled: boolean;
  cancelReason: string | null;
  isCaptain: boolean;
  /** Con quién comparte el turno, sin contarla a ella. */
  companions: string[];
  /** Su cónyuge, si atiende este mismo turno; sirve para ofrecer la baja doble. */
  spouseName: string | null;
}

/** Respuesta a «¿qué turnos cubre tal persona?». */
export interface ParticipantShifts {
  participant: { id: string; name: string; phone: string };
  fixed: ParticipantFixedSlot[];
  upcoming: ParticipantUpcomingShift[];
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

  /** Participación de cada persona en un periodo. */
  async attendance(locationId: string, from: Date, to: Date): Promise<AttendanceRow[]> {
    const participants = await this.prisma.participant.findMany({
      where: { memberships: { some: { locationId, active: true } } },
      orderBy: [...PADRON_ORDER],
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
        fullName: formalName(participant),
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
          include: {
            participant: {
              select: {
                id: true,
                firstName: true,
                paternalSurname: true,
                maternalSurname: true,
                displayName: true,
                spouseId: true,
              },
            },
          },
        },
        // El capitán se resuelve al leer: si canceló, no está entre los
        // ocupantes y el turno queda sin capitán.
        template: {
          select: {
            recurringAssignments: {
              where: { active: true, isCaptain: true },
              select: { participantId: true },
            },
          },
        },
      },
      orderBy: [{ date: 'asc' }, { startMinute: 'asc' }],
    });

    return shifts.map((shift) => {
      const capitan = captainOf(shift);
      return {
        id: shift.id,
        date: shift.date.toISOString().slice(0, 10),
        range: this.time.formatRange(shift.startMinute, shift.endMinute),
        startMinute: shift.startMinute,
        endMinute: shift.endMinute,
        status: shift.status,
        capacity: shift.capacity,
        occupied: shift.assignments.length,
        weekOfMonth: shift.weekOfMonth,
        participants: captainFirst(
          shift.assignments,
          capitan,
          (assignment) => assignment.participantId,
          (assignment) => assignment.participant.spouseId,
        ).map((assignment) => ({
          id: assignment.participant.id,
          name: displayName(assignment.participant),
          isCaptain: assignment.participantId === capitan,
          origin: assignment.origin,
          confirmed: assignment.status === AssignmentStatus.CONFIRMED,
        })),
      };
    });
  }

  /**
   * Los turnos de una persona en un punto: los fijos, que dicen qué le toca
   * siempre, y las fechas que ya tiene registradas de ahora en adelante.
   *
   * Las fechas incluyen lo que no es fijo —una sustitución, una inscripción— y
   * también las bajas: cuando avisan que alguien está enfermo, ver que ya
   * canceló evita buscar un turno que ya se liberó.
   */
  async participantShifts(locationId: string, participantId: string): Promise<ParticipantShifts> {
    const [location, participant] = await Promise.all([
      this.prisma.location.findUniqueOrThrow({ where: { id: locationId } }),
      this.prisma.participant.findUniqueOrThrow({
        where: { id: participantId },
        select: {
          id: true,
          firstName: true,
          paternalSurname: true,
          maternalSurname: true,
          displayName: true,
          phoneE164: true,
          spouseId: true,
        },
      }),
    ]);

    const [recurring, assignments] = await Promise.all([
      this.prisma.recurringAssignment.findMany({
        where: {
          participantId,
          active: true,
          shiftTemplate: { locationId, active: true },
        },
        include: { shiftTemplate: true },
      }),
      this.prisma.assignment.findMany({
        where: {
          participantId,
          shift: {
            locationId,
            endsAt: { gte: this.time.now() },
            status: { not: ShiftStatus.CANCELLED },
          },
        },
        include: {
          shift: {
            include: {
              assignments: {
                where: { status: { in: OCCUPYING_STATUSES } },
                include: {
                  participant: {
                    select: {
                      id: true,
                      firstName: true,
                      paternalSurname: true,
                      maternalSurname: true,
                      displayName: true,
                    },
                  },
                },
              },
              template: {
                select: {
                  recurringAssignments: {
                    where: { active: true, isCaptain: true },
                    select: { participantId: true },
                  },
                },
              },
            },
          },
        },
        orderBy: [{ shift: { date: 'asc' } }, { shift: { startMinute: 'asc' } }],
      }),
    ]);

    // Lunes primero: el domingo (0) se lee al final de la semana, no al inicio.
    const ordenDeDia = (weekday: number) => (weekday + 6) % 7;
    const fixed = [...recurring]
      .sort(
        (a, b) =>
          ordenDeDia(a.shiftTemplate.weekday) - ordenDeDia(b.shiftTemplate.weekday) ||
          a.shiftTemplate.weekOfMonth - b.shiftTemplate.weekOfMonth ||
          a.shiftTemplate.startMinute - b.shiftTemplate.startMinute,
      )
      .map((item): ParticipantFixedSlot => {
        const { weekday, weekOfMonth, startMinute, endMinute } = item.shiftTemplate;
        const dia = DIAS_DEL_ROL[weekday];
        return {
          label:
            weekOfMonth === 0
              ? `${dia} · cada semana`
              : `${ORDINALES_DEL_ROL[weekOfMonth]} ${dia.toLowerCase()} del mes`,
          range: this.time.formatRangeShort(startMinute, endMinute),
          isCaptain: item.isCaptain,
        };
      });

    const upcoming = assignments.map((assignment): ParticipantUpcomingShift => {
      const { shift } = assignment;
      const cancelled = !OCCUPYING_STATUSES.includes(assignment.status);
      const otros = shift.assignments.filter((otro) => otro.participantId !== participantId);
      const conyuge = otros.find((otro) => otro.participantId === participant.spouseId);
      return {
        assignmentId: assignment.id,
        shiftId: shift.id,
        date: shift.date.toISOString().slice(0, 10),
        label: this.time.formatDate(shift.date, location.timezone),
        range: this.time.formatRangeShort(shift.startMinute, shift.endMinute),
        origin: assignment.origin,
        cancelled,
        cancelReason: cancelled ? assignment.cancelReason : null,
        isCaptain: !cancelled && captainOf(shift) === participantId,
        companions: otros.map((otro) => displayName(otro.participant)),
        // Solo si la persona sigue en el turno: a quien ya canceló no hay baja
        // doble que ofrecerle.
        spouseName: !cancelled && conyuge ? displayName(conyuge.participant) : null,
      };
    });

    return {
      participant: {
        id: participant.id,
        name: displayName(participant),
        phone: formatNationalPhone(participant.phoneE164),
      },
      fixed,
      upcoming,
    };
  }
}
