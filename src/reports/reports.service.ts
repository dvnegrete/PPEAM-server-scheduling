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

/** Nivel de necesidad de un turno; define el color con que se pinta en el tablero. */
export type NeedLevel = 'ok' | 'bajoCupo' | 'bajoMinimo' | 'cancelado';

/** Acciones que cuentan como «movimiento» en la actividad reciente. */
export const MOVEMENT_ACTIONS = [
  'assignment.cancelled',
  'assignment.created',
  'assignment.confirmed',
  'coverage.approved',
  'coverage.auto_approved',
  'shift.cancelled',
  'shift.kept',
] as const;

export interface Movement {
  id: string;
  action: string;
  /** Frase lista para mostrarse, ya redactada en español. */
  description: string;
  participantName: string | null;
  shiftLabel: string | null;
  reason: string | null;
  reasonCode: string | null;
  /** Quién lo registró. */
  by: string;
  at: string;
}

export interface DashboardShift {
  id: string;
  date: string;
  range: string;
  startsAt: string;
  status: ShiftStatus;
  capacity: number;
  occupied: number;
  freeSlots: number;
  need: NeedLevel;
  participants: Array<{
    assignmentId: string;
    participantId: string;
    name: string;
    origin: AssignmentOrigin;
    confirmed: boolean;
    assignedAt: string | null;
    assignedByName: string | null;
  }>;
  cancellations: Array<{
    participantId: string;
    name: string;
    cancelledAt: string | null;
    reason: string | null;
    reasonCode: string | null;
    cancelledByName: string | null;
  }>;
}

export interface DashboardDay {
  date: string;
  weekday: number;
  label: string;
  shifts: DashboardShift[];
}

export interface DashboardResult {
  from: string;
  to: string;
  timezone: string;
  capacity: number;
  minCapacity: number;
  summary: {
    totalShifts: number;
    understaffed: number;
    critical: number;
    cancellations: number;
  };
  days: DashboardDay[];
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
        createdAt: filters.from || filters.to ? { gte: filters.from, lte: filters.to } : undefined,
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

  /**
   * Tablero operativo: qué turnos hay en el rango, cómo van de gente y qué se
   * movió en cada uno. Es la pantalla que el administrador abre a diario, así que
   * trae de una sola vez todo lo que necesita ver y no obliga a abrir detalles.
   */
  async dashboard(locationId: string, from: Date, to: Date): Promise<DashboardResult> {
    const location = await this.prisma.location.findUniqueOrThrow({ where: { id: locationId } });

    const shifts = await this.prisma.shift.findMany({
      where: { locationId, startsAt: { gte: from, lte: to } },
      include: {
        assignments: {
          include: { participant: { select: { id: true, fullName: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: [{ date: 'asc' }, { startMinute: 'asc' }],
    });

    const days = new Map<string, DashboardDay>();
    let understaffed = 0;
    let critical = 0;
    let cancellations = 0;

    for (const shift of shifts) {
      const ocupantes = shift.assignments.filter((assignment) =>
        OCCUPYING_STATUSES.includes(assignment.status),
      );
      const bajas = shift.assignments.filter(
        (assignment) => assignment.status === AssignmentStatus.CANCELLED,
      );
      cancellations += bajas.length;

      const need = this.needLevel(
        shift.status,
        ocupantes.length,
        shift.capacity,
        location.minCapacity,
      );
      if (need === 'bajoMinimo') critical += 1;
      else if (need === 'bajoCupo') understaffed += 1;

      const fecha = shift.date.toISOString().slice(0, 10);
      if (!days.has(fecha)) {
        days.set(fecha, {
          date: fecha,
          weekday: this.time.weekday(shift.date, 'utc'),
          label: this.time.formatDate(shift.date, location.timezone),
          shifts: [],
        });
      }

      days.get(fecha)!.shifts.push({
        id: shift.id,
        date: fecha,
        range: this.time.formatRange(shift.startMinute, shift.endMinute),
        startsAt: shift.startsAt.toISOString(),
        status: shift.status,
        capacity: shift.capacity,
        occupied: ocupantes.length,
        freeSlots: Math.max(0, shift.capacity - ocupantes.length),
        need,
        participants: ocupantes.map((assignment) => ({
          assignmentId: assignment.id,
          participantId: assignment.participant.id,
          name: assignment.participant.fullName,
          origin: assignment.origin,
          confirmed: assignment.status === AssignmentStatus.CONFIRMED,
          assignedAt: assignment.assignedAt?.toISOString() ?? null,
          assignedByName: assignment.assignedByName,
        })),
        cancellations: bajas.map((assignment) => ({
          participantId: assignment.participant.id,
          name: assignment.participant.fullName,
          cancelledAt: assignment.cancelledAt?.toISOString() ?? null,
          reason: assignment.cancelReason,
          reasonCode: assignment.cancelReasonCode,
          cancelledByName: assignment.cancelledByName,
        })),
      });
    }

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      timezone: location.timezone,
      capacity: location.defaultCapacity,
      minCapacity: location.minCapacity,
      summary: {
        totalShifts: shifts.length,
        understaffed,
        critical,
        cancellations,
      },
      days: [...days.values()],
    };
  }

  /** Clasificación que pinta el color del turno en el tablero. */
  private needLevel(
    status: ShiftStatus,
    occupied: number,
    capacity: number,
    minCapacity: number,
  ): NeedLevel {
    if (status === ShiftStatus.CANCELLED) return 'cancelado';
    if (occupied < minCapacity) return 'bajoMinimo';
    if (occupied < capacity) return 'bajoCupo';
    return 'ok';
  }

  /**
   * Movimientos de un turno en orden cronológico.
   *
   * Se lee de la bitácora, no de las asignaciones, porque el índice único obliga a
   * reutilizar la fila cuando alguien cancela y otro toma su lugar: la tabla solo
   * conserva el estado vigente, mientras que aquí queda el recorrido completo,
   * incluidas las personas que ya no figuran en el turno.
   */
  async shiftHistory(shiftId: string): Promise<Movement[]> {
    const logs = await this.prisma.auditLog.findMany({
      where: {
        OR: [
          { metadata: { path: ['shiftId'], equals: shiftId } },
          { entity: 'Shift', entityId: shiftId },
        ],
        // El trasiego interno de las solicitudes a encargados no le dice nada a
        // quien mira el historial de un turno; lo que importa es quién entró y
        // quién salió.
        action: { notIn: ['task.created', 'task.claimed', 'task.escalated'] },
      },
      orderBy: { createdAt: 'asc' },
    });

    return logs.map((log) => this.toMovement(log));
  }

  /** Últimos movimientos del punto, para la tira de actividad reciente del tablero. */
  async recentMovements(locationId: string, limit = 20): Promise<Movement[]> {
    const shiftIds = await this.prisma.shift.findMany({
      where: { locationId },
      select: { id: true },
    });
    const conocidos = new Set(shiftIds.map((shift) => shift.id));

    const logs = await this.prisma.auditLog.findMany({
      where: { action: { in: [...MOVEMENT_ACTIONS] } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit * 10, 400),
    });

    return logs
      .filter((log) => {
        const shiftId = (log.metadata as { shiftId?: string } | null)?.shiftId;
        return shiftId ? conocidos.has(shiftId) : false;
      })
      .slice(0, limit)
      .map((log) => this.toMovement(log));
  }

  /** Traduce un registro de bitácora a una frase que se pueda leer de corrido. */
  private toMovement(log: {
    id: string;
    action: string;
    actorType: string;
    actorName: string | null;
    createdAt: Date;
    metadata: unknown;
    after: unknown;
  }): Movement {
    const meta = (log.metadata ?? {}) as Record<string, unknown>;
    const after = (log.after ?? {}) as Record<string, unknown>;
    const quien = typeof meta.participantName === 'string' ? meta.participantName : null;
    const turno = typeof meta.shiftLabel === 'string' ? meta.shiftLabel : null;
    const motivo = typeof after.reason === 'string' ? after.reason : null;
    const codigo = typeof after.reasonCode === 'string' ? after.reasonCode : null;

    let description: string;
    switch (log.action) {
      case 'assignment.cancelled':
        description = `${quien ?? 'Alguien'} canceló${turno ? ` ${turno}` : ''}`;
        if (codigo) description += ` · ${codigo}`;
        break;
      case 'assignment.created':
        description = `${quien ?? 'Alguien'} entró a cubrir${turno ? ` ${turno}` : ''}`;
        break;
      case 'assignment.confirmed':
        description = `${quien ?? 'Alguien'} confirmó su asistencia`;
        break;
      case 'coverage.opened':
        description = 'Quedó un lugar libre por cubrir';
        break;
      case 'coverage.broadcast':
        description = 'Se avisó de la vacante a los participantes';
        break;
      case 'coverage.offered':
        description = `${quien ?? 'Alguien'} se ofreció a cubrirlo`;
        break;
      case 'coverage.expired':
        description = 'Venció el plazo para ofrecerse';
        break;
      case 'coverage.approved':
      case 'coverage.auto_approved':
        description = `Cobertura aprobada${turno ? ` para ${turno}` : ''}`;
        break;
      case 'shift.cancelled':
        description = `Se canceló el turno${turno ? ` ${turno}` : ''}`;
        break;
      case 'shift.kept':
        description = `Se decidió mantener el turno${turno ? ` ${turno}` : ''}`;
        break;
      default:
        description = log.action;
    }

    return {
      id: log.id,
      action: log.action,
      description,
      participantName: quien,
      shiftLabel: turno,
      reason: motivo,
      reasonCode: codigo,
      by: log.actorType === 'SYSTEM' ? 'el sistema' : (log.actorName ?? 'alguien'),
      at: log.createdAt.toISOString(),
    };
  }
}
